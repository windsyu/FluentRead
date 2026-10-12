/**
 * @file src/features/full-page-translation/embeddedFrames.ts
 * 文件职责：限定 OMG! Ubuntu 评论、Kaggle 笔记本与 Google Foresight 跨域正文 frame 的来源配对和消息形状。
 * 主要内容：验证精确 HTTPS 来源、文章关联与会话请求；Foresight 仅接受所属页面的版本化 Devsite 正文，兼容重定向前后来源。
 * 模块边界：只处理纯 URL 和消息值；后台负责校验浏览器 sender，content 负责生命周期与翻译。
 */
import {parseQQMailFrameRequest} from './qqMailFrames';
import type {PageTranslationInvocation} from './public';

export const EMBEDDED_FRAME_REQUEST = 'embeddedFrameRequest' as const;
export const EMBEDDED_FRAME_COMMAND = 'embeddedFrameCommand' as const;
export const EMBEDDED_FRAME_CHANGED = 'embeddedFrameChanged' as const;
export const EMBEDDED_FRAME_REFRESH = 'embeddedFrameRefresh' as const;

export type EmbeddedFrameAction = 'state' | 'toggle';
export interface EmbeddedFrameRequest {
    type: typeof EMBEDDED_FRAME_REQUEST;
    action: EmbeddedFrameAction;
    invocation?: PageTranslationInvocation;
}

function httpsURL(value: unknown): URL | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
    } catch { return null; }
}

function isOmgArticle(url: URL): boolean {
    return (url.hostname === 'www.omgubuntu.co.uk' || url.hostname === 'omgubuntu.co.uk') &&
        /^\/\d{4}\/\d{2}\/[^/]+\/?$/u.test(url.pathname);
}

function isKaggleNotebook(url: URL): boolean {
    return url.hostname === 'www.kaggle.com' && /^\/code\/[^/]+\/[^/]+\/?$/u.test(url.pathname);
}

function isForesightPage(url: URL): boolean {
    return url.hostname === 'developers.google.com' && /^\/edge\/foresight\/?$/u.test(url.pathname);
}

function isForesightDocument(url: URL): boolean {
    const path = url.hostname === 'developers.google.com' ? /^\/frame\/edge\/foresight\/index_[a-f0-9]{64}\.frame$/u
        : url.hostname === 'developers-dot-devsite-v2-prod.appspot.com' ? /^\/edge\/foresight\/index_[a-f0-9]{64}\.frame$/u : null;
    return path !== null && path.test(url.pathname);
}

export function isSupportedEmbeddedTopUrl(value: unknown): value is string {
    const url = httpsURL(value);
    return Boolean(url && (isOmgArticle(url) || isKaggleNotebook(url) || isForesightPage(url)));
}

export function isSupportedEmbeddedFrameUrl(value: unknown): value is string {
    const url = httpsURL(value);
    return Boolean(url && (
        url.hostname === 'disqus.com' && url.pathname === '/embed/comments/' && url.searchParams.get('f') === 'omgubuntu' ||
        url.hostname === 'www.kaggleusercontent.com' && /^\/kf\/[^/]+\/[^/]+\/__results__\.html$/u.test(url.pathname) ||
        isForesightDocument(url)
    ));
}

export function isSupportedEmbeddedFramePair(topValue: unknown, frameValue: unknown): boolean {
    const top = httpsURL(topValue);
    const frame = httpsURL(frameValue);
    if (!top || !frame || !isSupportedEmbeddedTopUrl(top.href) || !isSupportedEmbeddedFrameUrl(frame.href)) return false;
    if (isForesightPage(top)) return isForesightDocument(frame);
    if (isOmgArticle(top)) {
        if (frame.hostname !== 'disqus.com') return false;
        const article = httpsURL(frame.searchParams.get('t_u'));
        if (!article) return false;
        article.hash = '';
        top.hash = '';
        return article.href === top.href;
    }
    return isKaggleNotebook(top) && frame.hostname === 'www.kaggleusercontent.com';
}

export function parseEmbeddedFrameRequest(value: unknown): EmbeddedFrameRequest | null {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (value as {type?: unknown}).type !== EMBEDDED_FRAME_REQUEST) return null;
    const parsed = parseQQMailFrameRequest({...value, type: 'qqMailFrameRequest'});
    return parsed ? {type: EMBEDDED_FRAME_REQUEST, action: parsed.action,
        ...(parsed.invocation ? {invocation: parsed.invocation} : {})} : null;
}
