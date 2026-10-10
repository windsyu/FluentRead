import {APICallError, RetryError} from 'ai';
import {describe, expect, it, vi} from 'vitest';
import {services} from '@/src/core/config/catalog';
import {
    LlmTransportError,
    normalizeAiSdkError,
} from '@/src/providers/translation/ai-sdk/errors';

function apiError(overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {}): APICallError {
    return new APICallError({
        message: 'provider failed',
        url: 'https://provider.example/v1/chat/completions',
        requestBodyValues: {},
        ...overrides,
    });
}

describe('AI SDK provider error normalization', () => {
    it('Responses HTML 错误页不泄漏网页或误建议 Chat 协议，仍保留脱敏请求 ID', () => {
        const key = 'fixture-native-secret';
        const error = normalizeAiSdkError(services.openaiResponses, apiError({
            statusCode: 404, responseBody: `<html>${key}</html>`,
            responseHeaders: {'content-type': 'text/html', 'x-request-id': key},
            isRetryable: false,
        }), key);
        expect(error).toMatchObject({kind: 'bad-request', statusCode: 404, retryable: false});
        expect(error.message).toContain('无法识别的错误');
        expect(error.requestId).toBe('[已隐藏的密钥]');
        expect(error.message).not.toMatch(/Chat Completions|<html>|fixture-native-secret/u);
    });
    it.each([
        ['<!DOCTYPE html><html lang="zh-Hans"><head><script>private-page-data</script></head></html>', undefined],
        ['  <HTML><BODY>private-page-data</BODY></HTML>', {}],
        ['<!-- gateway --><html><body>private-page-data</body></html>', {}],
        ['private-page-data', {'Content-Type': 'text/html; charset=utf-8'}],
        ['private-page-data', {'content-type': 'application/xhtml+xml'}],
    ])('issue #626：HTML 404 提示检查接口且不展示网页源码 %#', (responseBody, responseHeaders) => {
        const error = normalizeAiSdkError(services.custom, apiError({statusCode: 404, responseBody, responseHeaders, isRetryable: false}));
        expect(error).toMatchObject({kind: 'bad-request', statusCode: 404, retryable: false});
        expect(error.message).toContain('HTML 网页');
        expect(error.message).toContain('Chat Completions');
        expect(error.message).not.toContain('private-page-data');
        expect(error.message).not.toContain('<');
    });

    it('issue #626：JSON 404 保留模型错误与已脱敏的请求 ID', () => {
        const error = normalizeAiSdkError(services.custom, apiError({
            statusCode: 404,
            responseBody: JSON.stringify({error: {message: 'model not found', code: 'model_not_found'}}),
            responseHeaders: {'content-type': 'application/json', 'x-request-id': 'req-fixture'},
        }));
        expect(error.message).toContain('model not found');
        expect(error.code).toBe('model_not_found');
        expect(error.requestId).toBe('req-fixture');
    });

    it.each([
        [JSON.stringify({error: {message: 'invalid <html> input'}}), 'invalid <html> input'],
        ['<error>invalid model</error>', '<error>invalid model</error>'],
    ])('issue #626：HTML 识别保留 JSON 和其他非网页诊断 %#', (responseBody, message) => {
        expect(normalizeAiSdkError(services.custom, apiError({statusCode: 400, responseBody})).message).toContain(message);
    });

    it('保留结构化 transport 错误的全部诊断字段', () => {
        const error = new LlmTransportError('失败', {
            kind: 'provider',
            retryable: true,
            statusCode: 503,
            code: 'upstream-down',
            retryAfterMs: 1500,
            requestId: 'req-1',
        });

        expect(error).toMatchObject({
            name: 'LlmTransportError',
            message: '失败',
            kind: 'provider',
            retryable: true,
            statusCode: 503,
            code: 'upstream-down',
            retryAfterMs: 1500,
            requestId: 'req-1',
        });
    });

    it.each([
        [401, 'authentication', false, 'API Key 无效'],
        [403, 'authentication', false, 'API Key 无效'],
        [408, 'timeout', true, '请求超时'],
        [429, 'rate-limit', true, '频率或配额'],
        [400, 'bad-request', false, '拒绝了请求'],
        [503, 'provider', true, '暂时不可用'],
        [undefined, 'response', false, 'provider failed'],
    ])('HTTP %s 映射为 %s', (statusCode, kind, retryable, message) => {
        const error = normalizeAiSdkError(services.custom, apiError({
            statusCode,
            isRetryable: retryable,
            data: statusCode === undefined ? undefined : {error: {message: 'detail'}},
        }));

        expect(error).toMatchObject({kind, retryable, statusCode});
        expect(error.message).toContain(message);
    });

    it('优先读取结构化 data 并清洗密钥、code 与请求 ID', () => {
        const apiKey = 'sk-direct-secret-123456';
        const error = normalizeAiSdkError(services.custom, apiError({
            statusCode: 400,
            responseHeaders: {'x-request-id': `req ${apiKey}`},
            responseBody: JSON.stringify({error: {message: 'body fallback', code: 'body-code'}}),
            data: {error: {message: `authorization: Bearer ${apiKey}`, code: `code-${apiKey}`}},
            isRetryable: false,
        }), apiKey);

        expect(error.code).toBe('code-[已隐藏的密钥]');
        expect(error.requestId).toBe('req [已隐藏的密钥]');
        expect(error.message).toContain('authorization: [已隐藏]');
        expect(error.message).not.toContain(apiKey);
    });

    it('清洗 provider 详情中的图片 data URL', () => {
        const image = 'data:image/png;base64,iVBORw0KGgoAAAAAAAA=';
        const error = normalizeAiSdkError(services.custom, apiError({
            statusCode: 400,
            data: {error: {message: `image payload ${image}`}},
        }));

        expect(error.message).toContain('[已隐藏的图片]');
        expect(error.message).not.toContain(image);
    });

    it('保留 MiniMax 专用凭据诊断', () => {
        const error = normalizeAiSdkError(services.minimax, apiError({
            statusCode: 401,
            data: {error: {message: 'invalid api key (code 2049)'}},
        }));

        expect(error.message).toContain('Token Plan Key');
    });

    it('空白 provider 详情不会生成多余后缀，并回退为可理解提示', () => {
        expect(normalizeAiSdkError(services.custom, apiError({
            message: '   ',
            statusCode: 400,
        })).message).toBe('当前翻译服务拒绝了请求（HTTP 400）');
        expect(normalizeAiSdkError(services.custom, apiError({
            message: '   ',
        })).message).toBe('翻译服务返回了无法识别的错误');
        expect(normalizeAiSdkError(services.custom, apiError({
            message: '',
        })).message).toContain('上游请求失败');
    });

    it.each([
        [{message: 'root message', code: 'root-code'}, 'root message', 'root-code'],
        [{error: 'flat error'}, 'flat error', undefined],
        [[], 'provider failed', undefined],
        [null, 'provider failed', undefined],
    ])('兼容不同 data 形状 %#', (data, message, code) => {
        const error = normalizeAiSdkError(services.custom, apiError({data}));

        expect(error.message).toContain(message);
        expect(error.code).toBe(code);
    });

    it.each([
        [JSON.stringify({message: 'json body', code: 'json-code'}), 'json body', 'json-code'],
        ['plain upstream body', 'plain upstream body', undefined],
        ['', 'provider failed', undefined],
        [undefined, 'provider failed', undefined],
    ])('在 data 缺失时解析 response body %#', (responseBody, message, code) => {
        const error = normalizeAiSdkError(services.custom, apiError({responseBody}));

        expect(error.message).toContain(message);
        expect(error.code).toBe(code);
    });

    it.each([
        [{'retry-after-ms': '250'}, 250],
        [{'retry-after-ms': '-1', 'retry-after': '2'}, 2000],
        [{'retry-after-ms': 'NaN', 'retry-after': '3'}, 3000],
        [{'retry-after': 'invalid'}, undefined],
        [{}, undefined],
        [undefined, undefined],
    ])('解析 Retry-After 元数据 %#', (responseHeaders, retryAfterMs) => {
        expect(normalizeAiSdkError(services.custom, apiError({responseHeaders})).retryAfterMs)
            .toBe(retryAfterMs);
    });

    it('支持 HTTP-date Retry-After 并把过去时间归零', () => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-25T00:00:00Z'));

        expect(normalizeAiSdkError(services.custom, apiError({
            responseHeaders: {'retry-after': 'Tue, 25 Aug 2026 00:00:02 GMT'},
        })).retryAfterMs).toBe(2000);
        expect(normalizeAiSdkError(services.custom, apiError({
            responseHeaders: {'retry-after': 'Mon, 24 Aug 2026 00:00:00 GMT'},
        })).retryAfterMs).toBe(0);

        vi.restoreAllMocks();
    });

    it.each([
        ['request-id'],
        ['x-ms-request-id'],
        ['x-amzn-requestid'],
    ])('识别 %s 请求追踪头', (header) => {
        const error = normalizeAiSdkError(services.custom, apiError({
            responseHeaders: {[header]: 'req-fallback'},
        }));

        expect(error.requestId).toBe('req-fallback');
        expect(error.message).toContain('请求 ID：req-fallback');
    });

    it('清洗 metadata 空值并限制 provider 详情长度', () => {
        const error = normalizeAiSdkError(services.custom, apiError({
            statusCode: 400,
            data: {error: {message: ` api_key=tp-secretvalue ${'x'.repeat(1000)}`, code: '   '}},
            responseHeaders: {'x-request-id': '   '},
        }));

        expect(error.code).toBeUndefined();
        expect(error.requestId).toBeUndefined();
        expect(error.message).not.toContain('tp-secretvalue');
        expect(error.message.length).toBeLessThan(900);
    });

    it('RetryError 使用最后一次 API 错误作为最终诊断', () => {
        const lastError = apiError({statusCode: 429, isRetryable: true});
        const retryError = new RetryError({
            message: 'retries exhausted',
            reason: 'maxRetriesExceeded',
            errors: [new Error('first'), lastError],
        });

        expect(normalizeAiSdkError(services.custom, retryError)).toMatchObject({
            kind: 'rate-limit',
            retryable: true,
        });
    });

    it.each([
        [Object.assign(new Error('request timeout'), {name: 'Error'}), false, 'timeout', true, '请求超时'],
        [Object.assign(new Error('deadline'), {name: 'TimeoutError'}), false, 'timeout', true, '请求超时'],
        [Object.assign(new Error('aborted'), {name: 'AbortError'}), false, 'timeout', true, '请求超时'],
        [Object.assign(new Error('aborted'), {name: 'AbortError'}), true, 'timeout', false, '已取消'],
        [new TypeError('Failed to fetch'), false, 'network', true, 'Failed to fetch'],
        [Object.assign(new Error('bad schema'), {name: 'AI_TypeValidationError'}), false, 'bad-request', false, '配置无效'],
        [new Error('messages must not be empty'), false, 'bad-request', false, '配置无效'],
        [new Error('unexpected response'), false, 'response', false, 'unexpected response'],
        ['', false, 'response', false, '网络请求失败'],
    ])('归一化非 HTTP 异常 %#', (input, callerAborted, kind, retryable, message) => {
        const error = normalizeAiSdkError(services.custom, input, undefined, callerAborted);

        expect(error).toMatchObject({kind, retryable});
        expect(error.message).toContain(message);
    });
});
