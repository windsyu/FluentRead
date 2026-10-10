/**
 * @file scripts/testing/run-openai-responses-live-test.cjs
 * 文件职责：用隔离 Chrome 生产扩展验收用户明确指定的真实 Responses 服务。
 * 主要内容：凭据只从外部文件读取到内存和临时扩展配置，验证根/v1/完整地址、保存重开、公开网页翻译恢复重译、真实鉴权失败后重试和导航取消；旁路观察只保留布尔值、状态和字节数。
 * 模块边界：不替换供应商、请求构造或 SSE 解析器，不关闭 TLS 校验，不自动重定向凭据；只访问指定 HTTPS 服务、公开测试网页及无凭据 loopback 守卫探针。默认严格屏幕外放置，仅经用户明确授权后可使用正常尺寸后台窗口。报告和截图脱敏，只有 ownership helper 确认浏览器已退出后才移除本脚本创建的 profile，不修改原始凭据文件。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {guardBrowserClose, getGuardedBrowserPid} = require('./owned-browser-close.cjs');
const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const endpoint = new URL(argument('endpoint', ''));
assert(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
  'Live service must be an explicit HTTPS origin without credentials/query/fragment');
assert(endpoint.pathname === '/', 'Supply the root service address; aliases are tested automatically');
const model = argument('model', '');
const credentialFile = argument('credential-file', '');
const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-responses-live'));
const playwrightRoot = argument('playwright-root', '');
const placementOnly = process.argv.includes('--placement-only');
const allowBackgroundWindow = process.argv.includes('--allow-background-window');
const articleUrl = new URL(argument('article-url', 'https://example.com/'));
assert(articleUrl.protocol === 'https:' && !articleUrl.username && !articleUrl.password, 'Public HTTPS article required');
assert(model && credentialFile && playwrightRoot, 'Model, local credential file and Playwright root are required');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, queryMacFrontmostApplication} = require('./focus-safe-browser.cjs');
const execFileAsync = promisify(execFile);
let apiKey = '';
let launched, worker, page, article, profileDir, expectedExtensionId, launchAttempted = false;
let guardReady = false, liveGuardActive = false, guardFailure, probeUrl;
const report = {status: 'running', scope: placementOnly ? 'isolated-browser-placement-only-no-credentials-no-provider-requests'
  : 'real-self-hosted-responses-production-extension-public-webpage',
  service: 'openaiResponses', model, credentialSource: 'external-local-file', tlsVerification: true,
  redirectsAllowed: false, backgroundWindowException: allowBackgroundWindow,
  targetOrigin: '[redacted user-provided HTTPS origin]', articleOrigin: articleUrl.origin,
  cases: [], requests: [], consoleErrors: [], blockedNetwork: 0, providerRequestsIntercepted: 0, maxProviderRequests: 20};
const redact = value => {
  let text = String(value);
  if (apiKey) text = text.split(apiKey).join('[redacted key]');
  return text.replace(/\bBearer\s+[^\s"',;]+/giu, 'Bearer [redacted key]')
    .split(endpoint.origin).join('[redacted service origin]').split(credentialFile).join('[credential file]');
};
async function poll(predicate, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 75));
  }
}
async function placeOffscreen(context, ownedPage) {
  const before = await queryMacFrontmostApplication();
  const browserPid = await getGuardedBrowserPid(launched);
  assert(before?.pid && before.pid !== browserPid, 'Owned browser must remain in the background');
  const {stdout} = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', [
    "ObjC.import('AppKit');", 'const s = $.NSScreen.screens; const a = [];',
    'for(let i=0;i<Number(s.count);i++){const f=s.objectAtIndex(i).frame;a.push({x:Number(f.origin.x),y:Number(f.origin.y),width:Number(f.size.width),height:Number(f.size.height)});}',
    'JSON.stringify(a);',
  ].join('\n')], {timeout: 5000});
  const native = JSON.parse(stdout);
  assert(native.length && native.every(s => Object.values(s).every(Number.isFinite)), 'Screen layout unavailable');
  const top = native[0].y + native[0].height;
  const screens = native.map(s => ({left: s.x, top: top - s.y - s.height, width: s.width, height: s.height}));
  const left = Math.min(...screens.map(s => s.left)), right = Math.max(...screens.map(s => s.left + s.width));
  const above = Math.min(...screens.map(s => s.top)), below = Math.max(...screens.map(s => s.top + s.height));
  const candidates = allowBackgroundWindow ? [null] : [{left: right + 64, top: above}, {left: left - 1504, top: above},
    {left: left, top: below + 64}, {left: left, top: above - 1064}];
  const pageSession = await context.newCDPSession(ownedPage);
  let session;
  try {
    const {targetInfo} = await pageSession.send('Target.getTargetInfo');
    session = await context.browser().newBrowserCDPSession();
    const {windowId} = await session.send('Browser.getWindowForTarget', {targetId: targetInfo.targetId});
    for (const candidate of candidates) {
      const requested = candidate ? {...candidate, width: 1440, height: 1000, windowState: 'normal'} : null;
      if (requested) await session.send('Browser.setWindowBounds', {windowId, bounds: requested});
      await new Promise(resolve => setTimeout(resolve, 100));
      const {bounds: actual} = await session.send('Browser.getWindowBounds', {windowId});
      const after = await queryMacFrontmostApplication();
      const offscreen = screens.every(s => actual.left >= s.left + s.width || actual.left + actual.width <= s.left
        || actual.top >= s.top + s.height || actual.top + actual.height <= s.top);
      (report[allowBackgroundWindow ? 'backgroundWindowChecks' : 'offscreenPlacementAttempts'] ||= []).push({screens, requested, actual, offscreen,
        osClampedBack: Boolean(requested && !offscreen), foregroundBefore: before, foregroundAfter: after,
        foregroundUnchanged: before.pid === after?.pid, ownedBrowserFrontmost: after?.pid === browserPid});
      assert(actual.windowState === 'normal', 'Never minimize the isolated browser');
      assert(actual.width >= 1000 && actual.height >= 700, 'Use a normal-sized browser window');
      assert(after?.pid && after.pid !== browserPid, 'Owned browser must not take foreground focus');
      report.offscreen = offscreen;
      if (offscreen || allowBackgroundWindow) return;
    }
    assert(false, 'macOS/Chromium clamps normal windows onto a display; explicit background-window authorization is required');
  } finally {await session?.detach().catch(() => {}); await pageSession.detach().catch(() => {});}
}
async function main() {
  fs.mkdirSync(artifactsDir, {recursive: true, mode: 0o700});
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-responses-live-'));
  launchAttempted = true;
  launched = await launchFocusSafePersistentContext({chromium, profileDir,
    browserPath: argument('browser-path', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    headless: false, background: true, viewport: {width: 1440, height: 1000}, timeout: 30000,
    browserArgs: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--proxy-server=direct://']});
  guardBrowserClose(launched, profileDir);
  Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
  const context = launched.context;
  const ownedPage = async () => {const result = await newPageWithoutForeground(context); await placeOffscreen(context, result); return result;};
  const control = await ownedPage();
  if (placementOnly) {
    report.cases.push({name: allowBackgroundWindow ? 'authorized-background-window-placement'
      : 'strict-offscreen-background-window-placement', status: 'passed'});
    report.status = 'passed'; return;
  }
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (probeUrl && url.href === probeUrl) {
      report.workerNetworkProbeIntercepted = (report.workerNetworkProbeIntercepted || 0) + 1;
      return route.abort('blockedbyclient');
    }
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin === endpoint.origin) {
      if (!guardReady || guardFailure || request.serviceWorker() !== worker || request.method() !== 'POST'
        || url.pathname !== '/v1/responses' || url.search || report.providerRequestsIntercepted >= report.maxProviderRequests) {
        report.blockedNetwork++; guardFailure ||= new Error('Live request rejected by the Node-owned generation/scope/budget guard');
        return route.abort('blockedbyclient');
      }
      report.providerRequestsIntercepted++;
      return route.continue();
    }
    if (url.origin !== articleUrl.origin) {report.blockedNetwork++; return route.abort('blockedbyclient');}
    return route.continue();
  });
  const session = await context.browser().newBrowserCDPSession();
  try {expectedExtensionId = (await session.send('Extensions.loadUnpacked', {path: extensionDir})).id;}
  finally {await session.detach();}
  report.extensionLoad = {method: 'Extensions.loadUnpacked', id: expectedExtensionId};
  await control.goto(`chrome-extension://${expectedExtensionId}/${manifest.action.default_popup}`);
  const loaded = await control.evaluate(() => {const m = chrome.runtime.getManifest(); return {name: m.name, version: m.version};});
  assert(loaded.name === manifest.name && loaded.version === manifest.version, 'Verify the loaded production artifact');
  report.loadedManifest = loaded;
  const isWorker = candidate => candidate.url().startsWith(`chrome-extension://${expectedExtensionId}/`);
  worker = context.serviceWorkers().find(isWorker) || await context.waitForEvent('serviceworker', {predicate: isWorker, timeout: 30000});
  liveGuardActive = true;
  const stopOnRestart = () => {
    if (!liveGuardActive) return;
    guardReady = false;
    guardFailure ||= new Error('Extension Worker restarted; live validation stopped without authorizing another generation');
    report.workerRestartBlocked = true;
    void launched.close().catch(error => {report.cleanupError = redact(error.message);});
  };
  context.on('serviceworker', candidate => {if (isWorker(candidate) && candidate !== worker) stopOnRestart();});
  worker.on('close', stopOnRestart);
  // Prove this installed Playwright version intercepts Worker-owned fetch before reading the real credential.
  let probeReceived = 0;
  const probe = http.createServer((_request, response) => {probeReceived++; response.end('Unexpected unguarded probe');});
  try {
    await new Promise((resolve, reject) => {probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve);});
    probeUrl = `http://127.0.0.1:${probe.address().port}/responses-guard-probe`;
    const rejected = await worker.evaluate(async url => {try {await fetch(url); return false;} catch {return true;}}, probeUrl);
    assert(rejected && report.workerNetworkProbeIntercepted === 1 && probeReceived === 0,
      'Worker network interception must be fail-closed before credential loading');
    report.workerNetworkGuardVerified = true;
  } finally {
    probeUrl = undefined;
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  }
  const file = fs.lstatSync(credentialFile);
  assert(file.isFile() && file.size > 0 && file.size < 8192, 'Credential must be a small regular file');
  apiKey = fs.readFileSync(credentialFile, 'utf8').replace(/^\uFEFF/u, '').trim();
  assert(apiKey && !/\s/u.test(apiKey), 'Credential must contain one bare key without whitespace');
  // Observation does not alter payloads or parse/replace their contents. The production reader owns all protocol decisions.
  const installGuard = candidate => candidate.evaluate(({origin, model, key, budget}) => {
    if (globalThis.__frResponsesLive) return;
    const state = globalThis.__frResponsesLive = {requests: [], blocked: 0};
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return original(input, init);
      if (url.origin !== origin || url.pathname !== '/v1/responses' || url.search || state.requests.length >= budget) {
        state.blocked++; throw new Error('Outside the authorized live Responses validation scope');
      }
      const payload = JSON.parse(String(init?.body));
      const row = {path: url.pathname, model: payload.model, authorized: new Headers(init?.headers).get('authorization') === `Bearer ${key}`,
        nativeInput: Array.isArray(payload.input) && !Object.hasOwn(payload, 'messages'), instructions: typeof payload.instructions === 'string',
        stream: payload.stream === true, storeFalse: payload.store === false,
        forbiddenFieldsAbsent: ['temperature', 'max_output_tokens', 'max_tokens', 'max_completion_tokens'].every(field => !Object.hasOwn(payload, field)),
        startedAt: Date.now(), bytes: 0, chunks: 0, signalAborted: false, readerCancelled: false, settled: false};
      if (row.model !== model || !row.nativeInput || !row.instructions || !row.stream || !row.storeFalse || !row.forbiddenFieldsAbsent) {
        throw new Error('Live request violates the native protocol contract');
      }
      state.requests.push(row);
      const onAbort = () => {row.signalAborted = true;};
      init?.signal?.addEventListener('abort', onAbort, {once: true});
      const finish = () => {row.settled = true; row.durationMs = Date.now() - row.startedAt; init?.signal?.removeEventListener('abort', onAbort);};
      try {
        const response = await original(input, {...init, redirect: 'error'});
        row.status = response.status;
        row.sse = /text\/event-stream/iu.test(response.headers.get('content-type') || '');
        if (!response.ok || !response.body) {finish(); return response;}
        const reader = response.body.getReader();
        let released = false;
        const release = () => {if (!released) {released = true; reader.releaseLock(); finish();}};
        return new Response(new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {controller.close(); release();}
              else {row.bytes += next.value.byteLength; row.chunks++; controller.enqueue(next.value);}
            } catch (error) {controller.error(error); release();}
          },
          async cancel(reason) {row.readerCancelled = true; try {await reader.cancel(reason);} finally {release();}},
        }), {status: response.status, statusText: response.statusText, headers: response.headers});
      } catch (error) {row.networkFailed = true; finish(); throw error;}
    };
  }, {origin: endpoint.origin, model, key: apiKey, budget: report.maxProviderRequests});
  await installGuard(worker);
  assert(!guardFailure, 'Worker generation must remain stable while installing the observer');
  guardReady = true;
  const requests = async () => {if (guardFailure) throw guardFailure; return worker.evaluate(() => globalThis.__frResponsesLive.requests);};
  const optionsUrl = `chrome-extension://${expectedExtensionId}/options.html#settings-services`;
  async function open() {
    page = await ownedPage();
    page.on('pageerror', error => report.consoleErrors.push(redact(error.message)));
    await page.goto(optionsUrl);
    await page.locator('.service-catalog').waitFor();
    await page.locator('.catalog-search input').fill('openai responses');
    await page.locator('[data-service-value="openaiResponses"]').click();
    await page.locator('[data-service-configuration-service="openaiResponses"]').waitFor();
    await page.evaluate(() => {
      globalThis.__frLiveConfigChangedAt = Date.now();
      chrome.storage.onChanged.addListener(() => {globalThis.__frLiveConfigChangedAt = Date.now();});
      globalThis.__frLiveConnectionStates = [];
      new MutationObserver(() => {
        const row = document.querySelector('[data-api-key-list] .api-key-state');
        const state = row ? ['checking', 'success', 'error', 'idle'].find(value => row.classList.contains(`is-${value}`)) : 'absent';
        const previous = globalThis.__frLiveConnectionStates.at(-1);
        if (state !== previous?.state) globalThis.__frLiveConnectionStates.push({state, at: Date.now()});
      }).observe(document.body, {attributes: true, childList: true, subtree: true});
    });
  }
  const endpointInput = () => page.getByRole('textbox', {name: 'openai responses 接口地址', exact: true});
  const keyInput = () => page.locator('[data-api-key-list] .api-key-entry input').first();
  async function check(expectSuccess = true) {
    // Wait for the actual extension-storage save/broadcast to settle before a new user action.
    // Never treat HTTP 200 alone or a partial stream as a passed UI connection check.
    await page.waitForFunction(() => Date.now() - globalThis.__frLiveConfigChangedAt >= 1000
      && document.querySelector('[data-api-key-list]')?.getAttribute('data-api-key-busy') === 'false',
    undefined, {timeout: 15000});
    const before = (await requests()).length;
    await page.locator('.detail-hero [data-connection-test-button]').last().click();
    await poll(async () => (await requests()).length > before, 'Connection check did not start a native request');
    await page.locator(`[data-api-key-list] .api-key-state.is-${expectSuccess ? 'success' : 'error'}`).waitFor({timeout: 45000});
    await page.locator('[data-api-key-list][data-api-key-busy="false"]').waitFor({timeout: 45000});
    const after = await requests();
    assert(after.length === before + 1, 'A connection check must execute one request');
    const row = after.at(-1);
    assert(expectSuccess ? row.status === 200 && row.sse && row.bytes > 0 && row.authorized : [401, 403].includes(row.status),
      'Connection status and stream must match the expected live outcome');
  }
  await open();
  await page.getByTestId('model-picker-trigger').click();
  const picker = page.locator('.model-picker-popper:visible');
  await picker.getByTestId('add-custom-model').click();
  await picker.getByTestId('custom-model-input').fill(model);
  await picker.getByTestId('custom-model-submit').click();
  await page.waitForFunction(value => document.querySelector('[data-testid="model-picker-trigger"]')?.getAttribute('aria-label')?.includes(value), model);
  await endpointInput().fill(endpoint.origin);
  await page.waitForFunction(() => document.querySelector('[data-api-key-list] .api-key-entry input')?.value === '');
  await keyInput().fill(apiKey);
  await page.locator('[data-set-default-service-button]').click();
  await page.waitForFunction(() => document.querySelector('.service-catalog')?.getAttribute('data-default-service') === 'openaiResponses');
  article = await ownedPage();
  article.on('pageerror', error => report.consoleErrors.push(redact(error.message)));
  const toggle = async () => {
    await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(candidate => candidate.url === url);
      if (!tab?.id) throw new Error('Owned public article tab is missing');
      await chrome.tabs.update(tab.id, {active: true});
    }, article.url());
    await article.keyboard.down('Alt'); await article.keyboard.press('t'); await article.keyboard.up('Alt');
  };
  async function waitTranslated(requestStart, requireUncached = false) {
    // Loading is deferred by 180ms and other paragraphs may already be cached.
    // Require the new network work to settle and the exact modified source to own its translation.
    if (requestStart !== undefined) await poll(async () => {
      const rows = (await requests()).slice(requestStart);
      if (requireUncached && !rows.length) return false;
      assert(!rows.some(row => row.settled && (row.networkFailed || row.status !== 200)), 'A live webpage translation request failed');
      return rows.every(row => row.settled && row.sse && row.bytes > 0 && !row.signalAborted);
    }, 'Live webpage requests did not finish successfully');
    await article.waitForFunction(() => {
      const target = document.querySelector('[data-fluentread-live-source] .fluent-read-bilingual-content[data-fr-translation-owned="true"]');
      return /\p{Script=Han}/u.test(target?.textContent || '') && !document.querySelector('.fluent-read-loading')
        && !document.querySelector('[data-fr-translation-failed]');
    },
    undefined, {timeout: 45000});
    if (requestStart !== undefined) {
      const rows = (await requests()).slice(requestStart);
      assert(rows.every(row => row.settled && row.status === 200 && row.sse && row.bytes > 0 && !row.signalAborted),
        'Requests started while waiting for the target DOM must also finish successfully');
    }
  }
  async function restore() {
    await toggle();
    await article.waitForFunction(() => !document.querySelector('.fluent-read-bilingual-content') && !document.querySelector('.fluent-read-loading'), undefined, {timeout: 15000});
  }
  for (const suffix of ['', '/v1', '/v1/responses']) {
    await endpointInput().fill(`${endpoint.origin}${suffix}`);
    assert(await keyInput().inputValue() === apiKey, 'Equivalent endpoints must retain the existing key');
    await check();
    await article.goto(articleUrl.href);
    await article.waitForTimeout(1000);
    // Preserve the genuine page DOM; a distinct public test suffix prevents a prior cache result masking this alias's request.
    const first = article.locator('main p, body p').first();
    await first.evaluate((element, value) => {
      element.setAttribute('data-fluentread-live-source', 'true');
      element.textContent += ` FluentRead live validation variant ${value}.`;
    }, suffix || 'root');
    const before = (await requests()).length;
    await toggle(); await waitTranslated(before, true);
    assert((await requests()).length > before, 'Each alias must translate through the real service, not only a cache hit');
    await article.screenshot({path: path.join(artifactsDir, `article-${suffix === '' ? 'root' : suffix === '/v1' ? 'v1' : 'full'}.png`)});
    await restore();
    const beforeRepeat = (await requests()).length;
    await toggle(); await waitTranslated(beforeRepeat); await restore();
    assert((await requests()).slice(before).every(row => row.settled && row.status === 200 && row.sse && row.bytes > 0 && !row.signalAborted),
      'Restoring an alias must not prematurely cancel its translation requests');
    report.cases.push({name: `live-${suffix || 'root'}-connection-translation-restore-retranslate`, status: 'passed'});
  }
  await page.close(); await open();
  assert(await endpointInput().inputValue() === `${endpoint.origin}/v1/responses` && await keyInput().inputValue() === apiKey,
    'Configuration and credential must survive options reopen');
  assert((await page.getByTestId('model-picker-trigger').getAttribute('aria-label')).includes(model), 'Model must persist');
  report.cases.push({name: 'real-configuration-save-reopen', status: 'passed'});
  await page.screenshot({path: path.join(artifactsDir, 'configuration-redacted.png'), mask: [keyInput(), endpointInput()]});
  await keyInput().fill(`sk-invalid-fluentread-${crypto.randomBytes(12).toString('hex')}`);
  await check(false);
  await keyInput().fill(apiKey); await check();
  report.cases.push({name: 'real-401-failure-and-valid-key-retry', status: 'passed'});
  await article.goto(articleUrl.href); await article.waitForTimeout(1000);
  await article.locator('main p, body p').first().evaluate(element => {element.textContent += ' A separate uncached sentence checks cancellation during a live request.';});
  const beforeCancel = (await requests()).length;
  await toggle();
  await poll(async () => (await requests()).length > beforeCancel, 'Cancellation request did not start', 15000);
  await article.goto('about:blank');
  await poll(async () => (await requests()).slice(beforeCancel).every(row => row.settled), 'Cancellation left a live request pending');
  assert(await article.locator('.fluent-read-bilingual-content').count() === 0, 'Navigation must reject late DOM insertion');
  const cancelled = (await requests()).slice(beforeCancel);
  report.cases.push({name: 'live-navigation-cancellation-no-late-insertion', status: 'passed',
    underlyingAbortObserved: cancelled.some(row => row.signalAborted),
    limitation: cancelled.some(row => row.signalAborted) ? null : 'DOM cancellation verified; upstream early abort was not observed'});
  await check();
  report.cases.push({name: 'real-request-after-navigation-cancellation', status: 'passed'});
  report.requests = await requests();
  report.guardBlocked = await worker.evaluate(() => globalThis.__frResponsesLive.blocked);
  assert(report.providerRequestsIntercepted === report.requests.length && !guardFailure,
    'Every provider request must traverse the same Node-owned total-budget guard');
  assert(!report.guardBlocked && !report.blockedNetwork && !report.consoleErrors.length, 'No unapproved network or runtime errors');
  report.status = 'passed';
}
main().catch(async error => {
  report.status = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1;
  if (worker) report.requests = await worker.evaluate(() => globalThis.__frResponsesLive?.requests || []).catch(() => []);
  if (page) report.connectionUiStates = await page.evaluate(() => globalThis.__frLiveConnectionStates || []).catch(() => []);
  await page?.screenshot({path: path.join(artifactsDir, 'failure-redacted.png'),
    mask: [page.locator('input[type="password"]'), page.locator('[data-testid="responses-service-endpoint-row"]')]}).catch(() => {});
}).finally(async () => {
  liveGuardActive = false; guardReady = false;
  let closed = false;
  try {if (launched) {await launched.close(); closed = true;}} catch (error) {report.cleanupError = redact(error.message); process.exitCode = 1; report.status = 'failed';}
  try {
    if (closed && profileDir) {fs.rmSync(profileDir, {recursive: true, force: true}); report.isolatedProfileRemoved = true;}
    else if (!launchAttempted && profileDir) fs.rmdirSync(profileDir);
    else if (profileDir) report.retainedIsolatedProfile = profileDir;
  } catch (error) {report.cleanupError = redact(error.message); process.exitCode = 1; report.status = 'failed';}
  fs.mkdirSync(artifactsDir, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(artifactsDir, 'report.json'), redact(JSON.stringify(report, null, 2)), {mode: 0o600});
  apiKey = '';
  console.log(JSON.stringify({status: report.status, cases: report.cases, requests: report.requests.length, artifactsDir,
    error: report.error, cleanupError: report.cleanupError, retainedIsolatedProfile: report.retainedIsolatedProfile}, null, 2));
}).catch(() => {console.error('Live validation report/cleanup failed; inspect the protected artifact directory.'); process.exitCode = 1;});
