import {describe, expect, it, vi} from 'vitest';
import {
    readResponsesApiStream,
    ResponsesApiStreamError,
} from '@/src/providers/translation/responses-api';

const encoder = new TextEncoder();
const event = (payload: unknown, name?: string) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(payload)}\n\n`;
const completed = (response: Record<string, unknown> = {output_text: '译文'}) => event({type: 'response.completed', response});
const delta = (text: string, output = 0, content = 0) => event({
    type: 'response.output_text.delta', delta: text, output_index: output, content_index: content,
});
const done = (text: string, output = 0, content = 0) => event({
    type: 'response.output_text.done', text, output_index: output, content_index: content,
});

function streamResponse(text: string, bytewise = false, close = true) {
    const bytes = encoder.encode(text);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            else controller.enqueue(bytes);
            if (close) controller.close();
        },
        cancel,
    });
    return {response: new Response(body), body, cancel};
}

describe('Responses SSE parser', () => {
    it.each(['\n', '\r\n', '\r'])('decodes byte-split UTF-8 and %j frame separators', async separator => {
        const source = (': heartbeat\n\nevent: response.created\ndata: {"type":"response.created"}\n\n'
            + delta('你好🌍') + completed({status: 'completed', model: 'actual', usage: {input_tokens: 3}}))
            .replaceAll('\n', separator);
        await expect(readResponsesApiStream(streamResponse(source, true).response)).resolves.toEqual({
            text: '你好🌍', response: {status: 'completed', model: 'actual', usage: {input_tokens: 3}},
        });
    });

    it('accepts multiline data, event-name fallback, comments and unrelated SSE fields', async () => {
        const source = 'id: 12\nretry: 500\n: comment\nignored\ndata\n\n'
            + 'event: response.completed\ndata: {\ndata: "response": {"output_text":"完整"}\ndata: }\n\n';
        await expect(readResponsesApiStream(streamResponse(source).response)).resolves.toEqual({
            text: '完整', response: {output_text: '完整'},
        });
    });

    it('orders multiple output/content parts and replaces deltas with text.done', async () => {
        const source = delta('尾', 2, 0) + delta('二', 0, 1) + delta('旧', 0, 0)
            + delta('片段', 0, 0) + done('一', 0, 0)
            + event({type: 'response.reasoning_text.delta', delta: '隐藏推理'})
            + event({type: 'response.output_item.added', item: {type: 'function_call'}})
            + event({unrelated: true}, 'vendor.extension') + completed({});
        await expect(readResponsesApiStream(streamResponse(source).response)).resolves.toEqual({text: '一二尾', response: {}});
    });

    it('uses completed full text without appending previous deltas or done text', async () => {
        const response = {output_text: '权威完整文本', output: [{type: 'reasoning'}]};
        await expect(readResponsesApiStream(streamResponse(delta('部分') + done('另一版') + completed(response)).response))
            .resolves.toEqual({text: '权威完整文本', response});
    });

    it('reads completed message output and ignores non-text content', async () => {
        const response = {output: [
            {type: 'reasoning'},
            {type: 'message', content: [{type: 'output_text', text: '甲'}, {type: 'refusal', refusal: '拒绝'}]},
            {type: 'message', content: [{type: 'output_text', text: '乙'}]},
        ]};
        await expect(readResponsesApiStream(streamResponse(completed(response)).response))
            .resolves.toEqual({text: '甲乙', response});
    });

    it.each([
        ['response.failed', 'response.completed'],
        ['response.completed', 'response.failed'],
        ['response.completed', 'vendor.event'],
    ])('rejects conflicting SSE event %s and payload type %s', async (name, type) => {
        const source = event({type, response: {output_text: '不能接受的终态'}}, name);
        await expect(readResponsesApiStream(streamResponse(source).response)).rejects.toMatchObject({
            name: 'ResponsesApiStreamError', eventType: name, message: 'Responses 流式事件类型与正文不一致。',
        });
    });

    it('returns at completion without waiting for EOF and cancels/releases the reader', async () => {
        const stream = streamResponse(completed() + 'data: malformed\n\n', false, false);
        await expect(readResponsesApiStream(stream.response)).resolves.toMatchObject({text: '译文'});
        expect(stream.cancel).toHaveBeenCalledOnce();
        expect(stream.body.locked).toBe(false);
    });

    it.each([
        ['error', {message: 'upstream error', code: 'bad_request'}, 'upstream error', 'bad_request'],
        ['error', {error: {message: 'nested error', code: 'nested_code'}}, 'nested error', 'nested_code'],
        ['response.failed', {response: {error: {message: 'failed', code: 'server_error'}}}, 'failed', 'server_error'],
        ['response.incomplete', {response: {incomplete_details: {reason: 'max_output_tokens'}}}, 'Responses 服务未能完成响应。', 'max_output_tokens'],
        ['response.failed', {}, 'Responses 服务未能完成响应。', undefined],
    ])('rejects %s with upstream error metadata', async (type, payload, message, code) => {
        const stream = streamResponse(delta('部分') + event({type, ...payload}), false, false);
        await expect(readResponsesApiStream(stream.response)).rejects.toMatchObject({
            name: 'ResponsesApiStreamError', eventType: type, message, code,
        });
        expect(stream.cancel).toHaveBeenCalledOnce();
        expect(stream.body.locked).toBe(false);
    });

    it.each([
        null, [], 'text', {type: 42}, {}, {type: ''},
        {type: 'response.output_text.delta', delta: 4, output_index: 0, content_index: 0},
        {type: 'response.output_text.delta', delta: 'x', content_index: 0},
        {type: 'response.output_text.delta', delta: 'x', output_index: -1, content_index: 0},
        {type: 'response.output_text.delta', delta: 'x', output_index: 0, content_index: -1},
        {type: 'response.output_text.delta', delta: 'x', output_index: 0, content_index: 0.5},
        {type: 'response.output_text.done', text: null, output_index: 0, content_index: 0},
        {type: 'response.completed'},
        {type: 'response.completed', response: []},
        {type: 'response.completed', response: {status: 'in_progress', output_text: '部分'}},
        {type: 'response.completed', response: {error: {}, output_text: '部分'}},
        {type: 'response.completed', response: {incomplete_details: {}, output_text: '部分'}},
        {type: 'response.completed', response: {output_text: 1}},
        {type: 'response.completed', response: {output: {}}},
        {type: 'response.completed', response: {output: [null]}},
        {type: 'response.completed', response: {output: [{}]}},
        {type: 'response.completed', response: {output: [{type: 'message'}]}},
        {type: 'response.completed', response: {output: [{type: 'message', content: [null]}]}},
        {type: 'response.completed', response: {output: [{type: 'message', content: [{}]}]}},
        {type: 'response.completed', response: {output: [{type: 'message', content: [{type: 'output_text', text: 1}]}]}},
    ].map(payload => ({payload})))('rejects malformed known event shape %j', async ({payload}) => {
        await expect(readResponsesApiStream(streamResponse(event(payload)).response)).rejects.toBeInstanceOf(ResponsesApiStreamError);
    });

    it.each([
        '', ': heartbeat\n\n', delta('部分'), done('片段完成'),
        'data: [DONE]\n\n', delta('部分') + 'data: [DONE]\n\n',
        'data: not-json\n\n', 'data: {"type":"response.completed","response":{"output_text":"未分帧"}}',
        completed({}), completed({output_text: '   '}),
    ])('rejects missing terminal, invalid frame or empty output %j', async source => {
        await expect(readResponsesApiStream(streamResponse(source).response)).rejects.toBeInstanceOf(ResponsesApiStreamError);
    });

    it('rejects a missing body and bounds unframed input buffering', async () => {
        await expect(readResponsesApiStream(new Response(null))).rejects.toThrow('缺少正文');
        await expect(readResponsesApiStream(streamResponse('x'.repeat(16 * 1024 * 1024 + 1)).response))
            .rejects.toThrow('响应过大');
    });

    it.each([{bytes: [0xff]}, {bytes: [0xf0, 0x9f]}])('rejects malformed or truncated UTF-8 %j', async ({bytes}) => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('event: response.completed\r'));
                controller.enqueue(Uint8Array.of(10));
                controller.enqueue(Uint8Array.from(bytes));
                controller.close();
            },
        });
        await expect(readResponsesApiStream(new Response(body))).rejects.toThrow('不是有效 UTF-8');
        expect(body.locked).toBe(false);
    });

    it('aborts a pending read, cancels once, and removes listener/releases lock', async () => {
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const stream = streamResponse(delta('部分'), false, false);
        const operation = readResponsesApiStream(stream.response, controller.signal);
        for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
        controller.abort();
        await expect(operation).rejects.toMatchObject({name: 'AbortError'});
        expect(stream.cancel).toHaveBeenCalledOnce();
        expect(stream.body.locked).toBe(false);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('rejects an already aborted signal even when completion is buffered', async () => {
        const controller = new AbortController();
        controller.abort();
        const stream = streamResponse(completed(), false, false);
        await expect(readResponsesApiStream(stream.response, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(stream.cancel).toHaveBeenCalledOnce();
        expect(stream.body.locked).toBe(false);
    });

    it('lets cancellation win a buffered completion before the read settles', async () => {
        const controller = new AbortController();
        const stream = streamResponse(completed(), false, false);
        const operation = readResponsesApiStream(stream.response, controller.signal);
        controller.abort();
        await expect(operation).rejects.toMatchObject({name: 'AbortError'});
        expect(stream.cancel).toHaveBeenCalledOnce();
        expect(stream.body.locked).toBe(false);
    });

    it('prioritizes an already aborted signal with absent or failed bodies', async () => {
        const controller = new AbortController();
        controller.abort();
        const failed = new ReadableStream<Uint8Array>({start: target => target.error(new Error('failed body'))});
        for (const response of [new Response(null), new Response(failed)]) {
            await expect(readResponsesApiStream(response, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        }
        expect(failed.locked).toBe(false);
    });

    it('closes the cancellation gap while acquiring a reader', async () => {
        const controller = new AbortController();
        const stream = streamResponse('', false, false);
        const getReader = stream.body.getReader.bind(stream.body);
        vi.spyOn(stream.body, 'getReader').mockImplementation(() => {
            controller.abort();
            return getReader();
        });
        await expect(readResponsesApiStream(stream.response, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(stream.cancel).toHaveBeenCalledOnce();
        expect(stream.body.locked).toBe(false);
    });

    it('removes the success listener and tolerates an upstream cancel rejection', async () => {
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const cancel = vi.fn(() => Promise.reject(new Error('upstream cancel failed')));
        const body = new ReadableStream<Uint8Array>({
            start: target => target.enqueue(encoder.encode(completed())), cancel,
        });
        await expect(readResponsesApiStream(new Response(body), controller.signal)).resolves.toMatchObject({text: '译文'});
        controller.abort();
        expect(cancel).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(body.locked).toBe(false);
    });

    it('retains the read failure while releasing its reader', async () => {
        const failure = new TypeError('network read failed');
        const body = new ReadableStream<Uint8Array>({start: controller => controller.error(failure)});
        await expect(readResponsesApiStream(new Response(body))).rejects.toBe(failure);
        expect(body.locked).toBe(false);
    });

    it('supports constructing controlled errors without metadata', () => {
        expect(new ResponsesApiStreamError('controlled')).toMatchObject({name: 'ResponsesApiStreamError', message: 'controlled'});
    });
});
