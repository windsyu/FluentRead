'use strict';
/** 生产扩展在受限子 frame 中的实际注入验证；所有页面响应由夹具提供。 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`缺少 --${name} 的值`);
    return value;
}

const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-shared-frame-fixture'));
const playwrightRoot = arg('playwright-root');
const focusHelper = arg('focus-safe-helper');
if (!playwrightRoot || !focusHelper) throw new Error('必须提供 --playwright-root 与 --focus-safe-helper');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(focusHelper);
fs.mkdirSync(artifacts, {recursive: true});
const temporaryRoot = fs.realpathSync(os.tmpdir());
const profileDir = fs.mkdtempSync(path.join(temporaryRoot, 'fluentread-shared-frame-'));
const profileToken = crypto.randomUUID();
const profileMarker = path.join(profileDir, '.fluentread-fixture-owner');
fs.writeFileSync(profileMarker, profileToken, {flag: 'wx'});
const profileIdentity = fs.lstatSync(profileDir);
const report = {scope: 'production Chrome restricted-frame injection with local responses', cases: [], cleanupErrors: []};
const fixtures = [
    {name: 'qq-mail', top: 'https://mail.qq.com/cgi-bin/frame_html?fixture=1', child: 'https://mail.qq.com/cgi-bin/readmail?fixture=1'},
    {name: 'disqus', top: 'https://disqus.com/fixture-top', child: 'https://disqus.com/embed/comments/fixture'},
    {name: 'kaggle', top: 'https://www.kaggleusercontent.com/kf/fixture-top', child: 'https://www.kaggleusercontent.com/kf/42/__results__.html'},
    {name: 'foresight-devsite', top: 'https://developers.google.com/edge/foresight',
        child: `https://developers.google.com/frame/edge/foresight/index_${'a'.repeat(64)}.frame`},
    {name: 'foresight-appspot', top: 'https://developers.google.com/edge/foresight',
        child: `https://developers-dot-devsite-v2-prod.appspot.com/edge/foresight/index_${'b'.repeat(64)}.frame`},
];
let launched;
let launchAttempted = false;
let cdp;

(async () => {
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({
        chromium, profileDir,
        browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        headless: false, background: true,
        browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
        viewport: {width: 1280, height: 900}, timeout: 30_000,
    });
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(launched.launchMode, 'macos-background-cdp');
    assert.equal(launched.windowPlacement.browserFrontmost, false);
    const page = await newPageWithoutForeground(launched.context, 30_000);
    const contexts = new Map();
    const parsed = [];
    cdp = await launched.context.newCDPSession(page);
    cdp.on('Runtime.executionContextCreated', ({context}) => contexts.set(context.id, context.auxData?.frameId));
    cdp.on('Debugger.scriptParsed', ({url, executionContextId}) => {
        if (url.includes('/content-scripts/supportedFrame.js')) parsed.push({url, executionContextId});
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Debugger.enable');
    let fixture;
    await page.route('https://**/*', route => {
        const url = route.request().url();
        if (url === fixture?.top) return route.fulfill({contentType: 'text/html', body: `<!doctype html><title>${fixture.name}</title><iframe id="fixture-frame" src="${fixture.child}"></iframe>`});
        if (url === fixture?.child) return route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Child</title><p id="frame-loaded">Frame loaded</p>'});
        return route.abort();
    });

    for (fixture of fixtures) {
        parsed.length = 0;
        await page.goto(fixture.top, {waitUntil: 'domcontentloaded'});
        await page.frameLocator('#fixture-frame').locator('#frame-loaded').waitFor({timeout: 10_000});
        let frameId;
        let injection;
        const started = Date.now();
        while (Date.now() - started < 5000) {
            const tree = (await cdp.send('Page.getFrameTree')).frameTree;
            frameId = tree.childFrames?.find(child => child.frame.url === fixture.child)?.frame.id;
            injection = parsed.find(script => contexts.get(script.executionContextId) === frameId);
            if (injection) break;
            await page.waitForTimeout(50);
        }
        assert.ok(frameId, `${fixture.name}: 子 frame 未出现在浏览器 frame tree`);
        assert.ok(injection, `${fixture.name}: 共用脚本未在子 frame 执行：${JSON.stringify(parsed)}`);
        report.cases.push({name: fixture.name, frameId, script: injection.url});
        await page.screenshot({path: path.join(artifacts, `${fixture.name}.png`)});
    }
    report.success = true;
})().catch(error => {
    report.success = false;
    report.failure = {message: error.message, stack: error.stack};
    process.exitCode = 1;
}).finally(async () => {
    if (cdp) await cdp.detach().catch(error => report.cleanupErrors.push(`CDP detach: ${error.message}`));
    let browserClosed = !launchAttempted;
    if (launched) {
        try {await launched.close(); browserClosed = true;}
        catch (error) {report.cleanupErrors.push(`browser close: ${error.message}`);}
    }
    if (browserClosed) {
        try {
            const current = fs.lstatSync(profileDir);
            assert.ok(!current.isSymbolicLink() && current.isDirectory());
            assert.equal(path.dirname(profileDir), temporaryRoot);
            assert.equal(current.dev, profileIdentity.dev);
            assert.equal(current.ino, profileIdentity.ino);
            assert.equal(fs.readFileSync(profileMarker, 'utf8'), profileToken);
            fs.rmSync(profileDir, {recursive: true});
            report.profileRemoved = true;
        } catch (error) {report.cleanupErrors.push(`temporary profile retained: ${error.message}`); report.retainedProfile = profileDir;}
    } else report.retainedProfile = profileDir;
    if (report.cleanupErrors.length) {report.success = false; process.exitCode = 1;}
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}).catch(error => {console.error(error); process.exitCode = 1;});
