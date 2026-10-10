import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {runtimeConfig} = vi.hoisted(() => ({runtimeConfig: {} as Config}));
vi.mock('@/src/services/config/store', () => ({config: runtimeConfig}));
vi.mock('webextension-polyfill', () => ({default: {storage: {
    session: {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined)},
    onChanged: {addListener: vi.fn(), removeListener: vi.fn()},
}}}));

import {Config} from '@/src/core/config/model';
import {services, servicesType, resolveConfiguredModel, defaultOption} from '@/src/core/config/catalog';
import {resolveOpenAICompatibleEndpoint} from '@/src/providers/translation/ai-sdk/endpoints';
import {translateWithOpenAICompatibleAiSdk} from '@/src/providers/translation/ai-sdk/openai-compatible';
import {runTranslationServiceConnectionTest} from '@/src/providers/translation/connectionTest';
import {responsesMsgTemplate} from '@/src/services/translation/templates';
import {
    attachTranslationModelUsageObserver,
    attachTranslationProviderConfig,
    attachTranslationRequestScheduler,
    createTranslationProviderConfigSnapshot,
} from '@/src/services/translation/requestSnapshot';
import {createTranslationRequestScheduler} from '@/src/services/translation/requestScheduler';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import type {TranslationModelUsageObservation} from '@/src/services/translation/types';
import {setRuntimeFetch} from '@/src/platform/http/runtime';

const service = services.openaiResponses;
const fixtureKey = 'responses-fixture-secret';
const event = (type: string, fields: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({type, ...fields})}\n\n`;
function completed(text = '你好', metadata: Record<string, unknown> = {}) {
    return event('response.completed', {response: {
        status: 'completed', model: 'actual-fixture-model',
        output: [{type: 'message', content: [{type: 'output_text', text}]}], ...metadata,
    }});
}
function stream(body = completed()) {
    return new Response(body, {headers: {'content-type': 'text/event-stream', 'x-request-id': 'fixture-request'}});
}
function httpError(status: number) {
    return new Response(JSON.stringify({error: {message: 'fixture HTTP error'}}), {
        status, headers: {'content-type': 'application/json', 'retry-after': '0'},
    });
}

beforeEach(() => {
    vi.useRealTimers();
    const source = new Config();
    source.service = service;
    source.to = 'zh-Hans';
    source.model[service] = 'fixture-model';
    source.token[service] = fixtureKey;
    source.proxy[service] = 'https://fixture.example/v1';
    source.system_role[service] = 'You are a translator.';
    source.user_role[service] = 'Translate {{origin}} into {{to}}.';
    Object.assign(runtimeConfig, source);
});
afterEach(() => {setRuntimeFetch(); vi.useRealTimers();});

describe('独立 openai responses 的真实 SDK 翻译链路', () => {
    it.each([
        ['https://fixture.example', 'https://fixture.example/v1/responses'],
        ['https://fixture.example/v1///', 'https://fixture.example/v1/responses'],
        ['https://fixture.example/v1/responses/', 'https://fixture.example/v1/responses'],
        ['https://fixture.example/responses', 'https://fixture.example/responses'],
        ['https://fixture.example/api/v2', 'https://fixture.example/api/v2/responses'],
        ['https://fixture.example/v1/chat/completions', 'https://fixture.example/v1/responses'],
        ['https://fixture.example/translate', 'https://fixture.example/translate'],
        ['https://fixture.example/v1?tenant=a&tenant=b&sig=a%2Fb#fragment', 'https://fixture.example/v1/responses?tenant=a&tenant=b&sig=a%2Fb'],
        ['', 'https://api.openai.com/v1/responses'],
    ])('规范化 %s 并仅发送原生 Responses 请求', async (input, expected) => {
        runtimeConfig.proxy[service] = input;
        runtimeConfig.token.openai = 'unrelated-openai-key';
        runtimeConfig.token.newapi = 'unrelated-newapi-key';
        const fetch = vi.fn(async () => stream(event('response.output_text.delta', {
            output_index: 0, content_index: 0, delta: '你',
        }) + completed()));
        setRuntimeFetch(fetch);
        await expect(translateWithOpenAICompatibleAiSdk({origin: 'hello'})).resolves.toBe('你好');
        expect(fetch).toHaveBeenCalledOnce();
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(String(url)).toBe(expected);
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${fixtureKey}`);
        expect(new Headers(init.headers).get('accept')).toBe('text/event-stream');
        expect(JSON.parse(String(init.body))).toEqual({
            model: 'fixture-model', instructions: 'You are a translator.',
            input: [{role: 'user', content: [{type: 'input_text', text: 'Translate hello into Simplified Chinese (zh-Hans).'}]}],
            stream: true, store: false,
        });
        expect(resolveOpenAICompatibleEndpoint(service, runtimeConfig).endpoint).toBe(expected);
    });

    it('原生高级参数可覆盖输入和模型，但不能关闭流或启用存储及 Codex 不支持字段', async () => {
        runtimeConfig.customBody[service] = JSON.stringify({
            model: 'native-override', instructions: 'Native instruction',
            input: [{role: 'user', content: [{type: 'input_text', text: 'native text'}]}],
            stream: false, store: true, temperature: 0.1, max_output_tokens: 100,
            max_tokens: 200, max_completion_tokens: 300, reasoning: {effort: 'low'},
        });
        let body: Record<string, unknown> = {};
        setRuntimeFetch(async (_url, init) => {body = JSON.parse(String(init?.body)); return stream();});
        await translateWithOpenAICompatibleAiSdk({origin: 'hello'});
        expect(body).toEqual({model: 'native-override', instructions: 'Native instruction',
            input: [{role: 'user', content: [{type: 'input_text', text: 'native text'}]}],
            stream: true, store: false, reasoning: {effort: 'low'}});
    });

    it.each([
        ['{"messages":[]}', '不接受 messages'],
        ['[]', '必须是 JSON 对象'],
        ['{"input":"hello"}', '非空数组 input'],
        ['{"input":[]}', '非空数组 input'],
        ['{"instructions":null}', '字符串 instructions'],
        ['{"model":" "}', '模型尚未配置'],
    ])('无效原生请求体 %s 在网络前失败', async (body, message) => {
        runtimeConfig.customBody[service] = body;
        const fetch = vi.fn(); setRuntimeFetch(fetch);
        await expect(translateWithOpenAICompatibleAiSdk({origin: 'hello'})).rejects.toThrow(message);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('复用上下文、摘要、目标语言和模型覆盖语义', () => {
        const current = createTranslationProviderConfigSnapshot(runtimeConfig);
        const body = JSON.parse(responsesMsgTemplate('source', 'reference', undefined, undefined,
            service, 'ja', 'override', current));
        expect(body.model).toBe('override');
        expect(body.input[0].content[0].text).toContain('<webpage_context>');
        expect(body.input[0].content[0].text).toContain('Translate source into ja.');
        const summary = JSON.parse(responsesMsgTemplate('source', '', 'summarize this', 'summary system',
            service, 'ja', undefined, current));
        expect(summary.instructions).toBe('summary system');
        expect(summary.input[0].content[0].text).toBe('summarize this');
    });

    it('直接模板调用沿用当前服务和默认系统提示词', () => {
        runtimeConfig.system_role[service] = '';
        const body = JSON.parse(responsesMsgTemplate('source'));
        expect(body.instructions).toBe(defaultOption.system_role);
        expect(body.model).toBe('fixture-model');
        expect(body.input[0].content[0].text).toContain('source');
    });

    it('原生模板复用受信图片保护边界，不允许自定义 body 替换冻结模型或输入', () => {
        const current = createTranslationProviderConfigSnapshot(runtimeConfig);
        const image = 'data:image/png;base64,iVBORw0KGgo=';
        const customized = {...current, customBody: {[service]: '{"model":"replacement","input":[]}'}};
        const body = JSON.parse(responsesMsgTemplate('read this', undefined, undefined, undefined,
            service, undefined, undefined, customized, undefined, image));
        expect(body.model).toBe('fixture-model');
        expect(body.input[0].content[1]).toEqual({type: 'input_image', image_url: image});
        expect(body).toMatchObject({stream: true, store: false});
        expect(() => responsesMsgTemplate('read this', undefined, undefined, undefined,
            service, undefined, undefined, customized, undefined, 'data:image/svg+xml;base64,PHN2Zz4='))
            .toThrow('图片输入格式无效');
    });

    it('读取前冻结服务专属地址、模型和凭据，不沿用被修改的全局配置', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(runtimeConfig);
        runtimeConfig.proxy[service] = 'https://changed.example';
        runtimeConfig.model[service] = 'changed-model';
        runtimeConfig.token[service] = 'changed-key';
        const fetch = vi.fn(async () => stream()); setRuntimeFetch(fetch);
        await translateWithOpenAICompatibleAiSdk(attachTranslationProviderConfig({origin: 'hello'}, snapshot));
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(String(url)).toBe('https://fixture.example/v1/responses');
        expect(JSON.parse(String(init.body)).model).toBe('fixture-model');
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${fixtureKey}`);
    });

    it.each([
        [{input_tokens: 10, output_tokens: 5, total_tokens: 15,
            input_tokens_details: {cached_tokens: 2}, output_tokens_details: {reasoning_tokens: 1}}, 'reported'],
        [{input_tokens: '10', output_tokens: 5}, 'malformed'],
        [undefined, 'unreported'],
    ])('最终事件原始用量 %j 正确统计且不影响译文', async (usage, availability) => {
        const observations: TranslationModelUsageObservation[] = [];
        setRuntimeFetch(async () => stream(completed('你好', {usage})));
        await expect(translateWithOpenAICompatibleAiSdk(attachTranslationModelUsageObserver({origin: 'hello'},
            value => observations.push(value)))).resolves.toBe('你好');
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({outcome: 'success', actualModel: 'actual-fixture-model',
            usageAvailability: availability, statusCode: 200});
        if (availability === 'reported') expect(observations[0]).toMatchObject({inputTokens: 10,
            outputTokens: 5, totalTokens: 15, cachedInputTokens: 2, reasoningTokens: 1});
    });

    it('HTTP 200 的流内失败不返回部分译文、不重试，并脱敏消息和诊断字段', async () => {
        const observations: TranslationModelUsageObservation[] = [];
        const fetch = vi.fn(async () => new Response(event('response.output_text.delta', {
            output_index: 0, content_index: 0, delta: '部分',
        }) + event('response.failed', {response: {status: 'failed', error: {
            message: `failed ${fixtureKey}`, code: fixtureKey,
        }}}), {headers: {'x-request-id': fixtureKey}}));
        setRuntimeFetch(fetch);
        const error = await translateWithOpenAICompatibleAiSdk(attachTranslationModelUsageObserver({origin: 'hello'},
            value => observations.push(value))).catch(error => error);
        expect(error.message).toContain('已隐藏');
        expect(JSON.stringify({message: error.message, code: error.code, requestId: error.requestId})).not.toContain(fixtureKey);
        expect(error.retryable).toBe(false);
        expect(fetch).toHaveBeenCalledOnce();
        expect(observations).toEqual([expect.objectContaining({outcome: 'error', statusCode: 200})]);
    });

    it('完成事件只有隐藏推理而无有效译文时，统计为失败且不重试', async () => {
        const observations: TranslationModelUsageObservation[] = [];
        const fetch = vi.fn(async () => stream(completed('<think>only reasoning</think>')));
        setRuntimeFetch(fetch);
        await expect(translateWithOpenAICompatibleAiSdk(attachTranslationModelUsageObserver({origin: 'hello'},
            value => observations.push(value)))).rejects.toThrow('没有返回有效译文');
        expect(fetch).toHaveBeenCalledOnce();
        expect(observations).toEqual([expect.objectContaining({outcome: 'error', statusCode: 200})]);
    });

    it.each([[401, 1], [500, 4]])('真实 SDK 对 HTTP %s 执行原有重试策略', async (status, calls) => {
        vi.useFakeTimers();
        const fetch = vi.fn(async () => httpError(status)); setRuntimeFetch(fetch);
        const assertion = expect(translateWithOpenAICompatibleAiSdk({origin: 'hello'})).rejects.toMatchObject({statusCode: status});
        await vi.runAllTimersAsync(); await assertion;
        expect(fetch).toHaveBeenCalledTimes(calls);
    });

    it('真实 SDK 可从 429 重试成功，每个 HTTP attempt 只统计一次', async () => {
        vi.useFakeTimers();
        const observations: TranslationModelUsageObservation[] = [];
        const fetch = vi.fn().mockImplementationOnce(async () => httpError(429)).mockImplementationOnce(async () => stream());
        setRuntimeFetch(fetch);
        const assertion = expect(translateWithOpenAICompatibleAiSdk(attachTranslationModelUsageObserver({origin: 'hello'},
            value => observations.push(value)))).resolves.toBe('你好');
        await vi.runAllTimersAsync(); await assertion;
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(observations.map(value => value.outcome)).toEqual(['error', 'success']);
    });

    it('真实 SDK 的 HTML 404 隐藏网页与凭据，不复用 Chat 协议纠错提示', async () => {
        const fetch = vi.fn(async () => new Response(`<html>${fixtureKey}</html>`, {
            status: 404, headers: {'content-type': 'text/html', 'x-request-id': fixtureKey},
        }));
        setRuntimeFetch(fetch);
        const error = await translateWithOpenAICompatibleAiSdk({origin: 'hello'}).catch(error => error);
        expect(error).toMatchObject({kind: 'bad-request', statusCode: 404, retryable: false});
        expect(error.message).toContain('无法识别的错误');
        expect(JSON.stringify(error)).not.toContain(fixtureKey);
        expect(error.message).not.toMatch(/Chat Completions|<html>/u);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('连接测试实际复用同一 Responses 适配器，包括流内失败', async () => {
        const snapshot = createTranslationProviderConfigSnapshot(runtimeConfig);
        const fetch = vi.fn().mockImplementationOnce(async () => stream())
            .mockImplementationOnce(async () => stream(event('response.incomplete', {
                response: {status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}},
            })));
        setRuntimeFetch(fetch);
        await expect(runTranslationServiceConnectionTest(service, {configSnapshot: snapshot})).resolves.toHaveProperty('durationMs');
        await expect(runTranslationServiceConnectionTest(service, {configSnapshot: snapshot})).rejects.toThrow('未能完成');
        expect(fetch).toHaveBeenCalledTimes(2);
        for (const [url, init] of fetch.mock.calls as unknown as Array<[string, RequestInit]>) {
            expect(String(url)).toBe('https://fixture.example/v1/responses');
            expect(JSON.parse(String(init.body))).toMatchObject({stream: true, store: false});
        }
    });

    it.each(['cancel', 'timeout'])('读流期间 %s 释放资源和调度槽位，不将部分文本成功返回', async mode => {
        vi.useFakeTimers();
        const observations: TranslationModelUsageObservation[] = [];
        const controller = new AbortController();
        const cancelled = vi.fn();
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
        }));
        setRuntimeFetch(async () => new Response(new ReadableStream({
            start(stream) {stream.enqueue(new TextEncoder().encode(event('response.output_text.delta', {
                output_index: 0, content_index: 0, delta: '部分',
            })));}, cancel: cancelled,
        })));
        const request = attachTranslationRequestScheduler(attachTranslationModelUsageObserver({origin: 'hello',
            abortSignal: controller.signal, requestTimeoutMs: 100}, value => observations.push(value)), scheduler, {service});
        const pending = scheduler.schedule(lease => {
            const operation = translateWithOpenAICompatibleAiSdk(request); lease.holdUntil(operation); return operation;
        });
        const assertion = expect(pending).rejects.toThrow(mode === 'cancel' ? '已取消' : '超时');
        await vi.advanceTimersByTimeAsync(10);
        if (mode === 'cancel') controller.abort();
        else await vi.advanceTimersByTimeAsync(100);
        await assertion;
        expect(cancelled).toHaveBeenCalledOnce();
        expect(observations.map(value => value.outcome)).toEqual([mode === 'cancel' ? 'cancelled' : 'timeout']);
        setRuntimeFetch(async () => stream());
        await expect(scheduler.schedule(() => translateWithOpenAICompatibleAiSdk({origin: 'again'}))).resolves.toBe('你好');
    });

    it('真实 broker 的规范地址命中同一缓存，目的地和 Chat 协议隔离且流失败不写入', async () => {
        const cache = new Map<string, string>();
        const cacheSet = vi.fn(async (key: string, text: string) => {cache.set(key, text); return true;});
        const provider = (request: Record<string, unknown>) => translateWithOpenAICompatibleAiSdk(
            request as unknown as Parameters<typeof translateWithOpenAICompatibleAiSdk>[0],
        );
        const broker = createTranslationBroker({
            ready: Promise.resolve(), getConfig: () => runtimeConfig,
            providers: {[service]: provider, [services.openai]: provider},
            cache: {get: async key => cache.get(key) ?? null, set: cacheSet,
                clear: async () => {cache.clear();}, cleanup: async () => undefined},
            serviceTypes: {machine: servicesType.machine,
                isAI: id => servicesType.AI.has(id), isAiSdk: id => servicesType.aiSdk.has(id),
                isUseAIContext: () => false},
            endpointResolver: {resolveOpenAICompatibleEndpoint, aiSdkTransportProfile: 'fixture-ai-sdk'},
            promptBuilder: {buildPageSummaryPrompt: () => '', buildPageSummarySystemPrompt: () => ''},
            getMissingCredentialMessage: () => null,
            getTranslationLanguages: override => resolveTranslationLanguages(override,
                {sourceLanguage: runtimeConfig.from, targetLanguage: runtimeConfig.to}),
            resolveConfiguredModel, buildTranslationCacheKey: identity => JSON.stringify(identity),
        });
        const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            return body.messages ? new Response(JSON.stringify({choices: [{message: {content: 'Chat 译文'}, finish_reason: 'stop'}]})) : stream();
        });
        setRuntimeFetch(fetch);
        runtimeConfig.useCache = true;
        for (const endpoint of ['https://fixture.example', 'https://fixture.example/v1',
            'https://fixture.example/v1/responses/', 'https://fixture.example/v1/chat/completions#discard']) {
            runtimeConfig.proxy[service] = endpoint;
            await expect(broker.translateWithCache({origin: 'hello'})).resolves.toBe('你好');
        }
        expect(fetch).toHaveBeenCalledOnce();
        expect(cacheSet).toHaveBeenCalledOnce();
        runtimeConfig.proxy[service] = 'https://changed.example/v1';
        await expect(broker.translateWithCache({origin: 'hello'})).resolves.toBe('你好');
        expect(fetch).toHaveBeenCalledTimes(2);
        runtimeConfig.service = services.openai;
        runtimeConfig.model.openai = runtimeConfig.model[service];
        runtimeConfig.proxy.openai = 'https://changed.example/v1/responses';
        runtimeConfig.system_role.openai = runtimeConfig.system_role[service];
        runtimeConfig.user_role.openai = runtimeConfig.user_role[service];
        await expect(broker.translateWithCache({origin: 'hello'})).resolves.toBe('Chat 译文');
        expect(fetch).toHaveBeenCalledTimes(3);
        runtimeConfig.service = service;
        const failedFetch = vi.fn(async () => stream(event('response.output_text.delta', {
            output_index: 0, content_index: 0, delta: '部分',
        }) + event('response.failed')));
        setRuntimeFetch(failedFetch);
        const writes = cacheSet.mock.calls.length;
        await expect(broker.translateWithCache({origin: 'new source'})).rejects.toThrow('未能完成');
        expect(cacheSet).toHaveBeenCalledTimes(writes);
        setRuntimeFetch(fetch);
        await expect(broker.translateWithCache({origin: 'new source'})).resolves.toBe('你好');
        expect(fetch).toHaveBeenCalledTimes(4);
    });
});
