/**
 * @file src/providers/translation/responses-api.ts
 *
 * 文件职责：集中处理 OpenAI Responses 协议的路由、完整输出和流式输出，让兼容供应商共享协议解析。
 * 主要内容：buildOpenAIApiEndpoint 改写协议路径，readResponsesApiText 提取完整助手文本；readResponsesApiStream 增量解码 SSE、按输出位置归并文本，并只在 completed 终态返回文本与原始元数据。
 * 模块边界：本文件只解释协议，不读取配置、发起请求或依赖 SDK；调用方负责错误脱敏、重试和用量统计。本模块负责流 reader 与取消监听的释放，缓存、去重和超时总预算由 translation broker 统一协调。
 */

export type OpenAIApiRoute = 'chat' | 'responses';

const ROUTE_PATHS: Readonly<Record<OpenAIApiRoute, string>> = Object.freeze({
    chat: 'chat/completions',
    responses: 'responses',
});

const ROUTE_SUFFIX_PATTERN = /\/(?:chat\/completions|responses)\/?$/u;

/** 把配置中的端点改写为目标协议路径，供用户只填写其中一种地址时自动补全。 */
export function buildOpenAIApiEndpoint(endpoint: string, route: OpenAIApiRoute): string {
    const targetPath = ROUTE_PATHS[route];

    try {
        const url = new URL(endpoint);
        const basePath = url.pathname.replace(ROUTE_SUFFIX_PATTERN, '').replace(/\/+$/u, '');
        url.pathname = `${basePath}/${targetPath}`;
        return url.toString();
    } catch {
        // 兼容部分代理接受的非标准地址，同时确保查询参数和 hash 不会被拼到路径中。
        const match = endpoint.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/u);
        const path = (match?.[1] || endpoint)
            .replace(ROUTE_SUFFIX_PATTERN, '')
            .replace(/\/+$/u, '');
        return `${path}/${targetPath}${match?.[2] || ''}${match?.[3] || ''}`;
    }
}

/**
 * 读取 Responses API 的助手文本。缺少输出时返回空串，由各 provider 给出自己的错误文案；
 * 推理片段不是 output_text，因此不会被拼进页面译文。
 */
export function readResponsesApiText(result: unknown): string {
    const payload = result as {output_text?: unknown; output?: unknown} | null | undefined;
    if (typeof payload?.output_text === 'string' && payload.output_text) return payload.output_text;

    if (!Array.isArray(payload?.output)) return '';
    return payload.output
        .filter((item: any) => item?.type === 'message' && Array.isArray(item.content))
        .flatMap((item: any) => item.content)
        .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('');
}

export interface ResponsesApiStreamResult {
    text: string;
    response: Record<string, unknown>;
}

/** 错误可能包含上游诊断原文，必须由 transport 脱敏后才能展示或记录。 */
export class ResponsesApiStreamError extends Error {
    readonly code?: string;
    readonly eventType?: string;

    constructor(message: string, options: {code?: string; eventType?: string} = {}) {
        super(message);
        this.name = 'ResponsesApiStreamError';
        this.code = options.code;
        this.eventType = options.eventType;
    }
}

const MAX_STREAM_CHARACTERS = 16 * 1024 * 1024;

function streamRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function streamError(message: string, eventType?: string): ResponsesApiStreamError {
    return new ResponsesApiStreamError(message, {eventType});
}

/** 仅在明确完成事件后返回最终文本；EOF、[DONE] 和文本片段完成均不能证明整个请求成功。 */
export async function readResponsesApiStream(
    response: Response,
    signal?: AbortSignal,
): Promise<ResponsesApiStreamResult> {
    const abortError = () => new DOMException('The request was aborted.', 'AbortError');
    if (signal?.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw abortError();
    }
    if (!response.body) throw streamError('Responses 流式响应缺少正文。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    const parts = new Map<number, Map<number, string>>();
    let line = '';
    let skipLf = false;
    let data: string[] = [];
    let event = '';
    let receivedCharacters = 0;
    let result: ResponsesApiStreamResult | undefined;
    let cancelled = false;
    const cancelReader = () => {
        if (cancelled) return;
        cancelled = true;
        void reader.cancel().catch(() => undefined);
    };
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
        rejectAbort(abortError());
        cancelReader();
    };
    signal?.addEventListener('abort', onAbort, {once: true});

    const dispatch = () => {
        const raw = data.join('\n');
        const eventName = event;
        data = [];
        event = '';
        if (!raw) return;
        if (raw.trim() === '[DONE]') throw streamError('Responses 响应未收到 completed 完成事件。');
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch {
            throw streamError('Responses 流式事件不是有效 JSON。', eventName);
        }
        if (!streamRecord(payload) || (payload.type !== undefined && typeof payload.type !== 'string')) {
            throw streamError('Responses 流式事件格式无效。', eventName);
        }
        const type = typeof payload.type === 'string' ? payload.type : eventName;
        if (!type.trim()) throw streamError('Responses 流式事件缺少类型。');
        if (eventName && eventName !== type) {
            throw streamError('Responses 流式事件类型与正文不一致。', eventName);
        }
        if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
            const nested = streamRecord(payload.response) ? payload.response : payload;
            const error = streamRecord(nested.error) ? nested.error : nested;
            const incomplete = streamRecord(nested.incomplete_details) ? nested.incomplete_details : {};
            throw new ResponsesApiStreamError(
                typeof error.message === 'string' ? error.message : 'Responses 服务未能完成响应。',
                {eventType: type, code: typeof error.code === 'string' ? error.code
                    : typeof incomplete.reason === 'string' ? incomplete.reason : undefined},
            );
        }
        if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
            const value = type === 'response.output_text.delta' ? payload.delta : payload.text;
            const output = payload.output_index;
            const content = payload.content_index;
            if (typeof value !== 'string' || !Number.isSafeInteger(output) || (output as number) < 0
                || !Number.isSafeInteger(content) || (content as number) < 0) {
                throw streamError('Responses 文本事件格式无效。', type);
            }
            let outputParts = parts.get(output as number);
            if (!outputParts) { outputParts = new Map(); parts.set(output as number, outputParts); }
            outputParts.set(content as number, type === 'response.output_text.done'
                ? value : (outputParts.get(content as number) || '') + value);
        }
        if (type === 'response.completed') {
            const completed = payload.response;
            if (!streamRecord(completed)
                || (completed.status !== undefined && completed.status !== 'completed')
                || completed.error != null || completed.incomplete_details != null
                || (completed.output_text !== undefined && typeof completed.output_text !== 'string')
                || (completed.output !== undefined && !Array.isArray(completed.output))) {
                throw streamError('Responses 完成事件格式无效。', type);
            }
            for (const item of (completed.output ?? []) as unknown[]) {
                if (!streamRecord(item) || typeof item.type !== 'string') {
                    throw streamError('Responses 完成输出格式无效。', type);
                }
                if (item.type !== 'message') continue;
                if (!Array.isArray(item.content) || item.content.some(part => !streamRecord(part)
                    || typeof part.type !== 'string'
                    || (part.type === 'output_text' && typeof part.text !== 'string'))) {
                    throw streamError('Responses 完成文本格式无效。', type);
                }
            }
            // 完成事件的完整结果是权威值；兼容省略完整 output 的代理时才使用已接收的片段。
            const text = readResponsesApiText(completed) || [...parts.entries()]
                .sort(([a], [b]) => a - b)
                .flatMap(([, contentParts]) => [...contentParts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text))
                .join('');
            if (!text.trim()) throw streamError('Responses 服务未返回有效译文。', type);
            result = {text, response: completed};
        }
    };
    const consumeLine = () => {
        if (!line) dispatch();
        else if (!line.startsWith(':')) {
            const separator = line.indexOf(':');
            const field = separator < 0 ? line : line.slice(0, separator);
            let value = separator < 0 ? '' : line.slice(separator + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'data') data.push(value);
            else if (field === 'event') event = value;
        }
        line = '';
    };
    const consume = (chunk: string) => {
        receivedCharacters += chunk.length;
        if (receivedCharacters > MAX_STREAM_CHARACTERS) throw streamError('Responses 流式响应过大。');
        let start = 0;
        for (let index = 0; index < chunk.length; index += 1) {
            const character = chunk[index];
            if (skipLf) {
                skipLf = false;
                if (character === '\n') { start = index + 1; continue; }
            }
            if (character !== '\r' && character !== '\n') continue;
            line += chunk.slice(start, index);
            consumeLine();
            start = index + 1;
            skipLf = character === '\r';
            if (result) return;
        }
        line += chunk.slice(start);
    };

    try {
        // 获取 reader 的运行时实现可能同步触发取消；注册监听后再次检查，堵住初始化间隙。
        if (signal?.aborted) throw abortError();
        while (!result) {
            const next = await Promise.race([reader.read(), aborted]);
            if (signal?.aborted) throw abortError();
            let decoded: string;
            try { decoded = decoder.decode(next.value, {stream: !next.done}); } catch {
                throw streamError('Responses 流式响应不是有效 UTF-8。');
            }
            consume(decoded);
            if (next.done && !result) throw streamError('Responses 响应在 completed 完成事件前结束。');
        }
        return result;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        cancelReader();
        reader.releaseLock();
    }
}
