/**
 * @file tests/issue146EmbeddedFrames.test.ts
 * 文件职责：验证 issue #146 的跨域正文 iframe 只接受真实所属页面的全文会话。
 * 主要内容：覆盖 Disqus、Kaggle 与 Google Foresight URL 配对、消息白名单、浏览器 sender 身份和恢复通知。
 * 模块边界：测试纯路由与授权，不模拟翻译服务或将第三方网页输入当作可信后台命令。
 */
import {describe, expect, it, vi} from 'vitest';

import {
    EMBEDDED_FRAME_CHANGED, EMBEDDED_FRAME_REQUEST,
    isSupportedEmbeddedFramePair, isSupportedEmbeddedFrameUrl,
    isSupportedEmbeddedTopUrl, parseEmbeddedFrameRequest,
} from '@/src/features/full-page-translation/embeddedFrames';
import {createEmbeddedFrameBackgroundHandlers} from
    '@/src/features/full-page-translation/background/embeddedFrameHandlers';

const omgTop = 'https://www.omgubuntu.co.uk/2026/09/era-rust-calendar-gnome-beta';
const omgFrame = `https://disqus.com/embed/comments/?f=omgubuntu&t_u=${encodeURIComponent(omgTop)}`;
const kaggleTop = 'https://www.kaggle.com/code/colinmorris/booleans-and-conditionals';
const kaggleFrame = 'https://www.kaggleusercontent.com/kf/126670518/signed-token/__results__.html?sharingControls=true';
const foresightTop = 'https://developers.google.com/edge/foresight';
const foresightDocument = `index_${'a'.repeat(64)}.frame`;
const foresightFrame = `https://developers-dot-devsite-v2-prod.appspot.com/edge/foresight/${foresightDocument}`;
const foresightRedirect = `https://developers.google.com/frame/edge/foresight/${foresightDocument}`;

describe('issue #146 受限跨域正文 iframe', () => {
    it('仅接收 HTTPS 文章与对应评论或笔记本正文，拒绝其他顶层、伪造文章和广告 frame', () => {
        for (const [top, frame] of [[omgTop, omgFrame], [kaggleTop, kaggleFrame]]) {
            expect(isSupportedEmbeddedTopUrl(top)).toBe(true);
            expect(isSupportedEmbeddedFrameUrl(frame)).toBe(true);
            expect(isSupportedEmbeddedFramePair(top, frame)).toBe(true);
        }
        for (const [top, frame] of [
            [omgTop, omgFrame.replace('f=omgubuntu', 'f=other')],
            [omgTop, omgFrame.replace(encodeURIComponent(omgTop), encodeURIComponent('https://www.omgubuntu.co.uk/2026/09/other'))],
            [omgTop, kaggleFrame], [kaggleTop, omgFrame],
            ['https://www.kaggle.com/datasets/other', kaggleFrame],
            [kaggleTop, 'https://www.kaggleusercontent.com/kf/126670518/signed-token/other.html'],
            [omgTop, 'https://googleads.g.doubleclick.net/pagead/ads'],
            [omgTop, omgFrame.replace('https://disqus.com', 'http://disqus.com')],
        ]) expect(isSupportedEmbeddedFramePair(top, frame), `${top} | ${frame}`).toBe(false);
        expect(isSupportedEmbeddedTopUrl(null)).toBe(false);
        expect(isSupportedEmbeddedFrameUrl('not a url')).toBe(false);
        expect(isSupportedEmbeddedFramePair(omgTop, 'https://disqus.com/embed/comments/?f=omgubuntu')).toBe(false);
    });

    it('Foresight 只接受所属页面的版本化正文，包括 Devsite 重定向前后地址与语言参数', () => {
        for (const top of [foresightTop, `${foresightTop}/`, `${foresightTop}?hl=ja#faq`]) {
            expect(isSupportedEmbeddedTopUrl(top)).toBe(true);
            for (const frame of [foresightFrame, foresightRedirect, `${foresightFrame}?hl=ja#hero`]) {
                expect(isSupportedEmbeddedFrameUrl(frame)).toBe(true);
                expect(isSupportedEmbeddedFramePair(top, frame)).toBe(true);
            }
        }
        for (const top of [
            'http://developers.google.com/edge/foresight',
            'https://developers.google.com:444/edge/foresight',
            'https://user@developers.google.com/edge/foresight',
            'https://developers.google.com.evil.test/edge/foresight',
            `${foresightTop}/other`, 'https://developers.google.com/edge/other',
            omgTop, kaggleTop,
        ]) expect(isSupportedEmbeddedFramePair(top, foresightFrame), top).toBe(false);
        for (const frame of [
            foresightFrame.replace('https:', 'http:'),
            foresightFrame.replace('.com/', '.com:444/'),
            foresightFrame.replace('https://', 'https://user@'),
            foresightFrame.replace('.com/', '.com.evil.test/'),
            foresightFrame.replace('/edge/foresight/', '/edge/other/'),
            foresightFrame.replace(foresightDocument, 'advertisement.frame'),
            foresightFrame.replace(foresightDocument, `index_${'a'.repeat(63)}.frame`),
            `${foresightFrame}/extra`,
            foresightRedirect.replace('/frame/edge/', '/edge/'),
            omgFrame, kaggleFrame,
        ]) expect(isSupportedEmbeddedFramePair(foresightTop, frame), frame).toBe(false);
    });

    it('Foresight 的后台授权使用浏览器 sender 真值，状态和恢复通知仍走原协议', async () => {
        const sendTabMessage = vi.fn(async () => ({enabled: true, revision: 1, sessionId: null}));
        const [request, changed] = createEmbeddedFrameBackgroundHandlers({sendTabMessage});
        const context = {sender: {frameId: 3, url: foresightFrame, tab: {id: 42, url: foresightTop}}};
        await expect(request.handle({type: EMBEDDED_FRAME_REQUEST, action: 'state'}, context))
            .resolves.toEqual({enabled: true, revision: 1, sessionId: null});
        expect(sendTabMessage).toHaveBeenLastCalledWith(42, {type: 'embeddedFrameCommand', action: 'state'}, {frameId: 0});
        await expect(changed.handle({type: EMBEDDED_FRAME_CHANGED},
            {sender: {frameId: 0, url: foresightTop, tab: {id: 42, url: foresightTop}}}))
            .resolves.toEqual({success: true});
        expect(sendTabMessage).toHaveBeenLastCalledWith(42, {type: 'embeddedFrameRefresh'});
        sendTabMessage.mockClear();
        await expect(request.handle({type: EMBEDDED_FRAME_REQUEST, action: 'state'},
            {sender: {...context.sender, tab: {id: 42, url: 'https://developers.google.com/edge/other'}}}))
            .resolves.toEqual({success: false});
        expect(sendTabMessage).not.toHaveBeenCalled();
    });

    it('只允许状态和有限的切换参数，拒绝凭据或未知字段', () => {
        expect(parseEmbeddedFrameRequest({type: EMBEDDED_FRAME_REQUEST, action: 'state'}))
            .toEqual({type: EMBEDDED_FRAME_REQUEST, action: 'state'});
        expect(parseEmbeddedFrameRequest({type: EMBEDDED_FRAME_REQUEST, action: 'toggle',
            invocation: {targetLanguage: 'zh-Hans', scope: 'content'}})?.invocation)
            .toEqual({targetLanguage: 'zh-Hans', scope: 'content'});
        for (const bad of [
            null,
            [],
            {type: 'wrong', action: 'state'},
            {type: EMBEDDED_FRAME_REQUEST, action: 'state', invocation: undefined},
            {type: EMBEDDED_FRAME_REQUEST, action: 'toggle', credentials: 'secret'},
            {type: EMBEDDED_FRAME_REQUEST, action: 'toggle', invocation: {sid: 'secret'}},
            {type: EMBEDDED_FRAME_REQUEST, action: 'unknown'},
        ]) expect(parseEmbeddedFrameRequest(bad)).toBeNull();
    });

    it('后台只转发经过 sender tab、URL 和 frameId 配对认证的请求', async () => {
        const sendTabMessage = vi.fn(async () => ({enabled: true, sessionId: 2}));
        const [request, changed] = createEmbeddedFrameBackgroundHandlers({sendTabMessage});
        const context = {sender: {frameId: 2, url: omgFrame, tab: {id: 42, url: omgTop}}};
        await expect(request.handle({type: EMBEDDED_FRAME_REQUEST, action: 'state'}, context))
            .resolves.toEqual({enabled: true, sessionId: 2});
        expect(sendTabMessage).toHaveBeenCalledWith(42, {type: 'embeddedFrameCommand', action: 'state'}, {frameId: 0});
        await expect(request.handle({type: EMBEDDED_FRAME_REQUEST, action: 'toggle',
            invocation: {targetLanguage: 'zh-Hans'}}, context)).resolves.toEqual({enabled: true, sessionId: 2});
        expect(sendTabMessage).toHaveBeenLastCalledWith(42, {type: 'embeddedFrameCommand', action: 'toggle',
            invocation: {targetLanguage: 'zh-Hans'}}, {frameId: 0});
        sendTabMessage.mockRejectedValueOnce(new Error('top frame gone'));
        await expect(request.handle({type: EMBEDDED_FRAME_REQUEST, action: 'state'}, context))
            .resolves.toEqual({success: false});
        for (const sender of [
            {...context.sender, frameId: 0},
            {...context.sender, tab: {id: 42, url: kaggleTop}},
            {...context.sender, url: omgFrame.replace('f=omgubuntu', 'f=other')},
            {...context.sender, tab: {id: -1, url: omgTop}},
        ]) await expect(request.handle({type: EMBEDDED_FRAME_REQUEST, action: 'state'}, {sender}))
            .resolves.toEqual({success: false});

        const topContext = {sender: {frameId: 0, url: omgTop, tab: {id: 42, url: omgTop}}};
        await expect(changed.handle({type: EMBEDDED_FRAME_CHANGED}, topContext))
            .resolves.toEqual({success: true});
        expect(sendTabMessage).toHaveBeenLastCalledWith(42, {type: 'embeddedFrameRefresh'});
        sendTabMessage.mockRejectedValueOnce(new Error('child frame gone'));
        await expect(changed.handle({type: EMBEDDED_FRAME_CHANGED}, topContext))
            .resolves.toEqual({success: true});
        await expect(changed.handle({type: EMBEDDED_FRAME_CHANGED}, context))
            .resolves.toEqual({success: false});
    });
});
