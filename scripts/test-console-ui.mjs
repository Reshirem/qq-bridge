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
  assert.equal(await page.locator('[data-view="sessions"]').first().textContent().then(text => text.trim()), '会话控制');

  await page.locator('#desktopAgentStart').click();
  assert.ok(fixture.requests.some(request => request.path === '/api/console/desktop-agent'), 'start uses the global session endpoint');
  await page.locator('#desktopAgentStop').click();
  assert.ok(fixture.requests.some(request => request.path === '/api/console/desktop-agent/stop'), 'stop uses the global session endpoint');
  await page.locator('#desktopAgentMessage').fill('离线 UI 契约检查');
  await page.locator('#desktopAgentSubmit').click();
  assert.ok(fixture.requests.some(request => request.path === '/api/console/desktop-agent' && request.body.message === '离线 UI 契约检查'));

  await page.locator('[data-view="persona"]').click();
  await page.waitForFunction(() => document.getElementById('desktopPromptText')?.value.includes('共用一个全局会话'));
  assert.equal(await page.locator('#desktopPromptPreset').count(), 0, 'there is no obsolete multi-preset selector');
  assert.match(await page.locator('#desktopPromptStatus').textContent(), /桌面助手/);

  await page.locator('[data-view="social-v2"]').click();
  await page.locator('#v2StatesList').click();
  assert.match(await page.locator('#v2AllStatesOutput').textContent(), /group:123456789/);
  await page.locator('#v2ResetBtn').click();
  assert.ok(fixture.requests.some(request => request.path === '/api/socialV2/reset'), 'cache reset stays separate from the global session');

  assert.deepEqual(blockedRequests, [], 'the UI must not reach external endpoints');
  assert.deepEqual(errors, [], 'browser console and page should be free of errors');
  assert.deepEqual(fixture.unknownRequests, [], 'the offline fixture implements all current console API routes');
  console.log('PASS single desktop-agent controls, on-demand QQ panel and offline-only UI');
} finally {
  await browser?.close();
  await fixture.close();
}
