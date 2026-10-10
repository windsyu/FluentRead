/**
 * @file scripts/testing/run-openai-responses-ui-test.cjs
 * 文件职责：以真实扩展和隔离后台 Chromium 验证原生 Responses 服务的配置及流式全文翻译。
 * 主要内容：本地 HTTP/SSE 夹具覆盖端点归一化、保存重开、原生模型/密钥控件、错误与不完整终态、恢复重译、导航取消和既有 Chat 服务。
 * 模块边界：只访问 loopback，不读取日常 profile；保留路径、模型和布尔请求断言，不输出鉴权或用户文本；窗口与关闭由现有 focus-safe/owned-browser helper 管理。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const assert = require('node:assert/strict');
const {guardBrowserClose} = require('./owned-browser-close.cjs');
const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-responses-ui'));
const playwrightRoot = argument('playwright-root', '');
const helperPath = path.resolve(argument('focus-safe-helper', path.join(__dirname, 'focus-safe-browser.cjs')));
if (!playwrightRoot) throw new Error('必须提供 --playwright-root');
if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error('扩展产物不存在');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
let expectedExtensionId = manifest.key ? crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16))) : null;
const loadViaCdp = process.argv.includes('--load-via-cdp');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, queryMacFrontmostApplication} = require(helperPath);
const fixtureKey = 'responses-local-fixture-token';
const fixtureModel = 'responses-fixture-model';
const translated = '流式测试译文：你好世界。';
const report = {status: 'running', extensionDir, artifactsDir,
  scope: 'local-http-native-options-connection-full-page-restore-retranslate-navigation-chat-smoke',
  providerEvidence: 'real-extension-native-http-fragmented-utf8-sse', cases: [], requests: [], blockedNetwork: 0, consoleErrors: []};
let launched, page, article, profileDir, launchAttempted = false, mode = 'success';
const execFileAsync = promisify(execFile);
async function placeOwnedWindowOffscreen(context, ownedPage) {
  const focusBefore = await queryMacFrontmostApplication();
  const {stdout} = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', [
    "ObjC.import('AppKit');",
    'const screens = $.NSScreen.screens; const records = [];',
    'for (let i = 0; i < Number(screens.count); i++) { const f = screens.objectAtIndex(i).frame; records.push({x: Number(f.origin.x), y: Number(f.origin.y), width: Number(f.size.width), height: Number(f.size.height)}); }',
    'JSON.stringify(records);',
  ].join('\n')], {timeout: 5000});
  const nativeScreens = JSON.parse(stdout);
  assert(nativeScreens.length > 0 && nativeScreens.every(screen => Object.values(screen).every(Number.isFinite)), 'Screen layout unavailable; cannot safely derive offscreen placement');
  // Same NSScreen bottom-left -> CDP top-left conversion used by the helper.
  const mainMaxY = nativeScreens[0].y + nativeScreens[0].height;
  const screens = nativeScreens.map(screen => ({left: screen.x, top: mainMaxY - screen.y - screen.height, width: screen.width, height: screen.height}));
  const requested = {left: Math.ceil(Math.max(...screens.map(screen => screen.left + screen.width))) + 64,
    top: Math.floor(Math.min(...screens.map(screen => screen.top))), width: 1440, height: 1000, windowState: 'normal'};
  let pageSession, browserSession;
  try {
    pageSession = await context.newCDPSession(ownedPage);
    const {targetInfo} = await pageSession.send('Target.getTargetInfo');
    browserSession = await context.browser().newBrowserCDPSession();
    const {windowId} = await browserSession.send('Browser.getWindowForTarget', {targetId: targetInfo.targetId});
    await browserSession.send('Browser.setWindowBounds', {windowId, bounds: requested});
    await new Promise(resolve => setTimeout(resolve, 100));
    const {bounds: actual} = await browserSession.send('Browser.getWindowBounds', {windowId});
    const offscreen = screens.every(screen => actual.left + actual.width <= screen.left || actual.left >= screen.left + screen.width
      || actual.top + actual.height <= screen.top || actual.top >= screen.top + screen.height);
    const focusAfter = await queryMacFrontmostApplication();
    const evidence = {source: 'readonly-NSScreen-derived-owned-target-CDP', screens, requested, actual,
      offscreen, osClampedBack: !offscreen, focusBefore, focusAfter, foregroundUnchanged: focusBefore?.pid === focusAfter?.pid};
    (report.offscreenPlacementAttempts ||= []).push(evidence);
    report.offscreen = offscreen;
    report.offscreenLimitation = offscreen ? null : 'macOS/Chromium moved the requested offscreen normal window onto a screen; do not claim offscreen execution';
    assert.equal(actual.windowState, 'normal', 'Owned browser window must never be minimized');
  } finally {
    await browserSession?.detach().catch(() => {}); await pageSession?.detach().catch(() => {});
  }
}
const timers = new Set();
const pendingResponses = new Set();
const event = (type, data) => `event: ${type}\r\ndata: ${JSON.stringify({type, ...data})}\r\n\r\n`;
function stream(response, selectedMode) {
  response.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store'});
  const frames = [
    event('response.created', {response: {id: 'fixture-response', status: 'in_progress'}}),
    event('response.output_text.delta', {output_index: 0, content_index: 0, delta: '流式测试译文：'}),
    event('response.output_text.delta', {output_index: 0, content_index: 0, delta: '你好世界。'}),
    selectedMode === 'error' ? event('error', {code: 'fixture_error', message: 'Local fixture stream failed'})
      : selectedMode === 'incomplete' ? event('response.incomplete', {response: {id: 'fixture-response', status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}}})
        : event('response.completed', {response: {id: 'fixture-response', status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: translated}]}], usage: {input_tokens: 2, output_tokens: 3, total_tokens: 5}}}),
  ];
  // Separate writes split both SSE lines and a Chinese UTF-8 codepoint. Each request
  // still traverses the production fetch/parser path; no provider is mocked.
  const bytes = Buffer.from(frames.join(''));
  const chinese = bytes.indexOf(Buffer.from('流'));
  const cuts = [1, 13, chinese + 1, chinese + 2, chinese + 7, bytes.length - 9, bytes.length];
  let offset = 0, index = 0;
  pendingResponses.add(response);
  let timer;
  const finish = () => {clearTimeout(timer); timers.delete(timer); pendingResponses.delete(response);};
  response.once('close', finish);
  const write = () => {
    timers.delete(timer);
    if (response.destroyed) return finish();
    const end = cuts[index++];
    response.write(bytes.subarray(offset, end)); offset = end;
    if (index === cuts.length) {response.end(); finish(); return;}
    timer = setTimeout(write, selectedMode === 'delay' ? 350 : 15); timers.add(timer);
  };
  timer = setTimeout(write, selectedMode === 'delay' ? 1200 : 15); timers.add(timer);
}
const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') {response.writeHead(204, {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}); response.end(); return;}
  if (request.method === 'GET') {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head><body><main><p id="source">This isolated local article checks native streaming translation, restoration and cancellation without contacting a real translation provider.</p></main></body></html>'); return;
  }
  let raw = '';
  request.on('data', chunk => {raw += chunk;});
  request.on('end', () => {
    try {
      const body = JSON.parse(raw);
      const chat = request.url === '/v1/chat/completions';
      report.requests.push({path: request.url, model: body.model, authorized: request.headers.authorization === `Bearer ${fixtureKey}`,
        responsesPayload: !chat && Array.isArray(body.input) && !Object.hasOwn(body, 'messages'),
        chatPayload: chat && Array.isArray(body.messages), stream: body.stream === true, storeFalse: body.store === false,
        hasPrompt: !chat && (typeof body.instructions === 'string' || body.input.some?.(item => ['system', 'developer'].includes(item.role))), mode});
      if (chat) {
        response.writeHead(200, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
        response.end(JSON.stringify({id: 'chat-fixture', object: 'chat.completion', created: 1, model: fixtureModel, choices: [{index: 0, message: {role: 'assistant', content: translated}, finish_reason: 'stop'}], usage: {prompt_tokens: 2, completion_tokens: 3, total_tokens: 5}}));
      } else if (request.url === '/v1/responses') stream(response, mode);
      else {response.writeHead(404); response.end('fixture route not found');}
    } catch {response.writeHead(400); response.end('invalid fixture request');}
  });
});
async function poll(predicate, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 50));}
}
async function main() {
  fs.mkdirSync(artifactsDir, {recursive: true});
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const host = `http://127.0.0.1:${server.address().port}`;
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-responses-'));
  launchAttempted = true;
  launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    headless: false, background: true, viewport: {width: 1440, height: 1000}, timeout: 30000,
    browserArgs: [...(loadViaCdp ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]), '--no-first-run', '--no-default-browser-check']});
  guardBrowserClose(launched, profileDir);
  Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
  const context = launched.context;
  const newOwnedPage = async () => {
    const ownedPage = await newPageWithoutForeground(context);
    await placeOwnedWindowOffscreen(context, ownedPage);
    return ownedPage;
  };
  if (loadViaCdp) {
    const session = await context.browser().newBrowserCDPSession();
    try {expectedExtensionId = (await session.send('Extensions.loadUnpacked', {path: extensionDir})).id;}
    finally {await session.detach();}
    report.extensionLoad = {method: 'Extensions.loadUnpacked', id: expectedExtensionId};
    const control = await newOwnedPage();
    await control.goto(`chrome-extension://${expectedExtensionId}/${manifest.action.default_popup}`);
    const loadedManifest = await control.evaluate(() => {const m = chrome.runtime.getManifest(); return {name: m.name, version: m.version};});
    assert.deepEqual(loadedManifest, {name: manifest.name, version: manifest.version});
    report.loadedManifest = loadedManifest;
  }
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') {report.blockedNetwork++; await route.abort('blockedbyclient');}
    else await route.continue();
  });
  const installGuard = worker => worker.evaluate(() => {
    if (globalThis.__responsesFixtureGuard) return;
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') throw new Error('External provider blocked by local Responses fixture');
      return original(input, init);
    };
    globalThis.__responsesFixtureGuard = true;
  });
  const isExtensionWorker = worker => worker.url().startsWith('chrome-extension://')
    && (expectedExtensionId ? new URL(worker.url()).host === expectedExtensionId : worker.url().endsWith('/background.js'));
  context.on('serviceworker', worker => {if (isExtensionWorker(worker)) installGuard(worker).catch(() => {});});
  const worker = context.serviceWorkers().find(isExtensionWorker)
    || await context.waitForEvent('serviceworker', {predicate: isExtensionWorker, timeout: 30000});
  await installGuard(worker);
  const optionsUrl = `chrome-extension://${new URL(worker.url()).host}/options.html#settings-services`;
  async function open() {
    page = await newOwnedPage();
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    await page.goto(optionsUrl); await page.locator('.service-catalog').waitFor();
  }
  async function select(service) {
    await page.locator('.catalog-search input').fill(service === 'openaiResponses' ? 'openai responses' : 'OpenAI');
    await page.locator(`[data-service-value="${service}"]`).click();
    await page.locator(`[data-service-configuration-service="${service}"]`).waitFor();
  }
  async function model() {
    await page.getByTestId('model-picker-trigger').click();
    const panel = page.locator('.model-picker-popper:visible');
    await panel.getByTestId('add-custom-model').click();
    await panel.getByTestId('custom-model-input').fill(fixtureModel);
    await panel.getByTestId('custom-model-submit').click();
    await page.waitForFunction(model => document.querySelector('[data-testid="model-picker-trigger"]')?.getAttribute('aria-label')?.includes(model), fixtureModel);
  }
  async function check(success = true, chat = false) {
    const before = report.requests.length;
    await page.locator('.detail-hero [data-connection-test-button]').last().click();
    await poll(() => report.requests.length > before, 'Connection check never reached local fixture');
    const record = report.requests[before];
    assert.equal(record.path, chat ? '/v1/chat/completions' : '/v1/responses');
    assert.equal(record.model, fixtureModel); assert.equal(record.authorized, true);
    if (chat) assert.equal(record.chatPayload, true);
    else {assert.equal(record.responsesPayload, true); assert.equal(record.stream, true); assert.equal(record.storeFalse, true); assert.equal(record.hasPrompt, true);}
    await page.locator(`[data-api-key-list] .api-key-state.is-${success ? 'success' : 'error'}`).waitFor({timeout: 30000});
    await page.locator('[data-api-key-list][data-api-key-busy="false"]').waitFor();
    assert.equal(report.requests.length, before + 1, 'Connection check must not retry the failed stream');
  }
  await open(); await select('openaiResponses');
  assert.equal((await page.locator('.detail-hero h4').innerText()).trim(), 'openai responses');
  assert.equal(await page.getByTestId('model-thinking-control').count(), 0, 'Responses must hide unsupported Thinking');
  const endpoint = () => page.getByRole('textbox', {name: 'openai responses 接口地址', exact: true});
  const keyInput = () => page.locator('[data-api-key-list] .api-key-entry input').first();
  assert.equal(await endpoint().locator('xpath=ancestor::*[@data-configuration-group="connection"]').count(), 1);
  await model();
  for (const suffix of ['', '/v1', '/v1/responses']) {
    await endpoint().fill(`${host}${suffix}`);
    if (suffix === '') {
      await page.waitForFunction(() => document.querySelector('[data-api-key-list] .api-key-entry input')?.value === '');
      await keyInput().fill(fixtureKey);
    } else assert.equal(await keyInput().inputValue(), fixtureKey, 'Equivalent Responses endpoint aliases must preserve the key');
    await check();
  }
  report.cases.push('native-service-model-key-and-root-v1-full-normalization');
  await page.locator('[id$="tab-custom-request"]').click();
  assert.equal(await page.getByRole('textbox', {name: '代理地址', exact: true}).count(), 0);
  await page.locator('[id$="tab-prompts"]').click();
  assert.equal(await page.getByTestId('prompt-template-list').count(), 1);
  await page.close({runBeforeUnload: true}); await open(); await select('openaiResponses');
  assert.equal(await endpoint().inputValue(), `${host}/v1/responses`);
  assert.equal(await keyInput().inputValue(), fixtureKey);
  assert((await page.getByTestId('model-picker-trigger').getAttribute('aria-label')).includes(fixtureModel));
  await check();
  await page.screenshot({path: path.join(artifactsDir, 'responses-config-persisted.png')});
  report.cases.push('single-connection-endpoint-native-prompts-and-save-reopen');
  for (const failureMode of ['error', 'incomplete']) {
    mode = failureMode; await check(false);
    const errorToggle = page.locator('.api-key-error-toggle');
    if (await errorToggle.getAttribute('aria-expanded') !== 'true') await errorToggle.click();
    assert((await page.locator('.api-key-error').innerText()).trim().length > 0);
    await page.screenshot({path: path.join(artifactsDir, `responses-${failureMode}.png`)});
    report.cases.push(`${failureMode}-visible-no-success-no-retry`);
  }
  mode = 'success'; await check();
  await page.locator('[data-set-default-service-button]').click();
  await page.waitForFunction(() => document.querySelector('.service-catalog')?.getAttribute('data-default-service') === 'openaiResponses');
  article = await newOwnedPage(); article.on('pageerror', error => report.consoleErrors.push(error.message));
  await article.goto(`${host}/article`);
  // Default configuration hides the floating ball. Match the established
  // full-page harness initialization allowance rather than requiring that UI.
  await article.waitForTimeout(1000);
  const toggle = async () => {
    // The shared helper's worker fallback assumes the first extension worker.
    // CDP-loaded Chrome also has a built-in worker; use the verified FluentRead
    // worker for exactly the same focus-safe tabs.update operation.
    await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(candidate => candidate.url === url);
      if (!tab?.id) throw new Error('Native fixture article tab is missing');
      await chrome.tabs.update(tab.id, {active: true});
    }, article.url());
    await article.keyboard.down('Alt'); await article.keyboard.press('t'); await article.keyboard.up('Alt');
  };
  await toggle();
  await article.waitForFunction(expected => document.querySelector('#source')?.textContent.includes(expected) || document.querySelector('.fluent-read-bilingual-content')?.textContent.includes(expected), translated, {timeout: 30000});
  await article.screenshot({path: path.join(artifactsDir, 'responses-full-page.png')});
  await toggle();
  await article.waitForFunction(() => !document.querySelector('.fluent-read-bilingual-content') && !document.querySelector('.fluent-read-loading'));
  assert(!(await article.locator('#source').innerText()).includes(translated));
  await toggle();
  await article.waitForFunction(expected => document.body.textContent.includes(expected), translated, {timeout: 30000});
  report.cases.push('real-full-page-fragmented-utf8-stream-restore-and-retranslate');
  await toggle();
  mode = 'delay'; await article.goto(`${host}/article?cancel-uncached`);
  await article.waitForTimeout(1000);
  // Change source text so cached success cannot hide the cancellation path.
  await article.locator('#source').evaluate(element => {element.textContent += ' A distinct uncached cancellation sentence.';});
  const beforeCancel = report.requests.length;
  await toggle(); await poll(() => report.requests.length > beforeCancel, 'Cancellation did not start a native request');
  await article.goto('about:blank');
  await poll(() => pendingResponses.size === 0, 'Navigation left an active fixture stream', 15000);
  assert.equal(await article.locator('.fluent-read-bilingual-content').count(), 0);
  report.cases.push('navigation-cancellation-no-late-insertion');
  mode = 'success'; await select('openai'); await model();
  await page.locator('[id$="tab-translation"]').click();
  assert.equal(await page.getByTestId('model-thinking-control').count(), 1, 'Existing Chat must retain Thinking preferences');
  assert.equal(await page.getByTestId('model-thinking-control').isVisible(), true);
  await page.locator('[id$="tab-custom-request"]').click();
  await page.getByRole('textbox', {name: '代理地址', exact: true}).fill(`${host}/v1/chat/completions`);
  await page.waitForFunction(() => document.querySelector('[data-api-key-list] .api-key-entry input')?.value === '');
  await keyInput().fill(fixtureKey);
  await check(true, true);
  report.cases.push('existing-chat-completions-json-smoke');
  report.cases.push('responses-thinking-hidden-chat-thinking-retained');
  assert.equal(report.blockedNetwork, 0); assert.equal(report.consoleErrors.length, 0);
  report.status = 'passed';
}
main().catch(async error => {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
  await page?.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
}).finally(async () => {
  const errors = [];
  let closed = false;
  try {if (launched) {await launched.close(); closed = true;}} catch (error) {errors.push(error.message);}
  for (const timer of timers) clearTimeout(timer);
  for (const response of pendingResponses) response.destroy();
  try {if (server.listening) {server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));}} catch (error) {errors.push(error.message);}
  try {
    if (closed && profileDir) fs.rmSync(profileDir, {recursive: true, force: true});
    else if (!launchAttempted && profileDir) fs.rmdirSync(profileDir);
  } catch (error) {errors.push(error.message);}
  if (errors.length) {report.status = 'failed'; report.cleanupErrors = errors; process.exitCode = 1;}
  fs.mkdirSync(artifactsDir, {recursive: true});
  fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({status: report.status, cases: report.cases, artifactsDir, error: report.error}, null, 2));
}).catch(error => {console.error(error.stack); process.exitCode = 1;});
