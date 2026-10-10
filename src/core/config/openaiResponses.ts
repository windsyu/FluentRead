/**
 * @file src/core/config/openaiResponses.ts
 * 文件职责：统一独立 openai responses 翻译服务的端点补全规则，确保请求与凭据归属使用相同地址。
 * 主要内容：校验 HTTP(S) 地址，补全根路径和版本路径，迁移完整 Chat 路径，保留精确自定义路径与原始查询串，并提示误写的单数 response。
 * 模块边界：只进行 URL 的纯转换，不读取配置或凭据，不执行网络请求；供应商、缓存与凭据边界共享此规则。
 */

export function normalizeOpenAIResponsesEndpoint(rawEndpoint: string): string {
    let endpoint: URL;
    try {
        endpoint = new URL(rawEndpoint.trim());
    } catch {
        throw new Error('openai responses 接口地址必须是有效的 HTTP(S) URL');
    }
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
        throw new Error('openai responses 接口地址只支持 HTTP(S)');
    }
    const path = endpoint.pathname.replace(/\/+$/u, '');
    if (/\/response$/u.test(path)) {
        throw new Error('接口路径应为 /responses（复数），请把 /response 改为 /responses');
    }
    if (!path) endpoint.pathname = '/v1/responses';
    else if (/\/v\d+$/u.test(path)) endpoint.pathname = `${path}/responses`;
    else if (/\/chat\/completions$/u.test(path)) endpoint.pathname = path.replace(/\/chat\/completions$/u, '/responses');
    else if (/\/responses$/u.test(path)) endpoint.pathname = path;
    endpoint.hash = '';
    return endpoint.toString();
}
