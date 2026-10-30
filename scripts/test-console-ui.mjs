#!/usr/bin/env node
/** Browser checks against an isolated fixture; no live DSH, QQ, or bridge process is used. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch {}
}
if (!playwright) throw new Error('Playwright is not installed. Set PLAYWRIGHT_MODULE to an existing package; this script does not install dependencies.');

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(existsSync);
const fixture = await startConsoleFixture();
const errors = [];
const blockedRequests = [];
let browser;

try {
  browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === fixture.url) return route.continue();
    blockedRequests.push(url.href);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.getElementById('desktopAgentStatus')?.textContent.length > 0);

  assert.equal(await page.locator('#section-desktop-agent').count(), 1, 'the global desktop-agent controls are present');
  assert.equal(await page.locator('#sessionList, #pendingList, #aiNotifyTarget, #dshSessionRefresh').count(), 0,
    'per-QQ session mapping and notification controls are absent');
  assert.match(await page.locator('[data-view="sessions"]').first().textContent(), /会话控制/);

  await page.locator('[data-view="sessions"]').first().click();
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/console/desktop-agent') && response.request().method() === 'POST'),
    page.locator('#desktopAgentStart').click(),
  ]);
  assert.ok(fixture.requests.some(request => request.path === '/api/console/desktop-agent'), 'start uses the global session endpoint');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/console/desktop-agent/stop') && response.request().method() === 'POST'),
    page.locator('#desktopAgentStop').click(),
  ]);
  assert.ok(fixture.requests.some(request => request.path === '/api/console/desktop-agent/stop'), 'stop uses the global session endpoint');
  await page.locator('#desktopAgentMessage').fill('离线 UI 契约检查');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/console/desktop-agent') && response.request().method() === 'POST'),
    page.locator('#desktopAgentSubmit').click(),
  ]);
  assert.ok(fixture.requests.some(request => request.path === '/api/console/desktop-agent' && request.body.message === '离线 UI 契约检查'));

  await page.locator('[data-view="access"]').first().click();
  await page.waitForFunction(() => document.getElementById('ownerQQ').value === '100001');
  assert.equal(await page.locator('#secInterceptNotify, #secSave').count(), 0, 'the obsolete interception notification control is absent');
  assert.equal(await page.locator('#section-whitelist #wlGroups').count(), 0, 'test-send lists are not presented as agent access controls');
  await page.locator('#ownerQQ').fill('123456');
  await page.locator('#ownerQQSave').click();
  await page.waitForFunction(() => document.getElementById('ownerQQMsg').textContent.includes('已保存'));
  const ownerSave = fixture.requests.filter(request => request.path === '/api/whitelist').at(-1);
  assert.deepEqual(ownerSave.body, { ownerQQ: '123456' }, 'saving owner does not rewrite test-send lists');

  await page.locator('[data-view="operations"]').first().click();
  await page.locator('#section-test-send summary').click();
  await page.locator('#wlGroups').fill('123456789, 555');
  await page.locator('#wlSave').click();
  await page.waitForFunction(() => document.getElementById('wlMsg').textContent.includes('已保存'));
  const listSave = fixture.requests.filter(request => request.path === '/api/whitelist').at(-1);
  assert.equal(Object.hasOwn(listSave.body, 'ownerQQ'), false, 'saving test-send lists does not change the owner');

  await page.locator('[data-view="access"]').first().click();
  await page.locator('#ownerQQ').fill('');
  await page.locator('#ownerQQSave').click();
  await page.waitForFunction(() => document.getElementById('ownerQQMsg').textContent.includes('已清除'));
  assert.deepEqual(fixture.requests.filter(request => request.path === '/api/whitelist').at(-1).body, { ownerQQ: '' });

  await page.locator('[data-view="persona"]').click();
  await page.waitForFunction(() => document.getElementById('desktopPromptPreview')?.value.includes('人格卡定义你的具体身份和形态'));
  assert.equal(await page.locator('#desktopPromptPreset').count(), 0, 'there is no obsolete multi-preset selector');
  assert.match(await page.locator('#desktopPromptStatus').textContent(), /数字角色/);
  await page.locator('#desktopPromptEdit').click();
  const promptToggles = page.locator('#desktopPromptModules .prompt-module-toggle input');
  assert.ok(await promptToggles.count() > 0);
  assert.equal(await promptToggles.evaluateAll((items) => items.some((item) => item.disabled)), false, 'all prompt modules can be switched off');
  await promptToggles.first().uncheck();
  await page.locator('#desktopPromptCancel').click();

  await page.locator('[data-view="social-v2"]').click();
  await page.locator('details').filter({ has: page.locator('#v2StatesList') }).locator('summary').click();
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/socialV2/states')),
    page.locator('#v2StatesList').click(),
  ]);
  await page.waitForFunction(() => document.getElementById('v2AllStatesOutput').textContent.includes('group:123456789'));
  assert.match(await page.locator('#v2AllStatesOutput').textContent(), /group:123456789/);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/socialV2/reset') && response.request().method() === 'POST'),
    page.locator('#v2ResetBtn').click(),
  ]);
  assert.ok(fixture.requests.some(request => request.path === '/api/socialV2/reset'), 'cache reset stays separate from the global session');

  assert.deepEqual(blockedRequests, [], 'the UI must not reach external endpoints');
  assert.deepEqual(errors, [], 'browser console and page should be free of errors');
  assert.deepEqual(fixture.unknownRequests, [], 'the offline fixture implements all current console API routes');
  console.log('PASS owner save/clear, independent test-send lists, desktop-agent controls and offline-only UI');
} finally {
  await browser?.close();
  await fixture.close();
}
