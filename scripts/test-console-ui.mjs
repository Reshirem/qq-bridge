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
  page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
  page.on('dialog', dialog => dialog.accept());
  async function openPage(view) {
    const tab = page.locator('.section-tabs [data-view="' + view + '"]');
    const group = await tab.count() ? await tab.evaluate(el => el.closest('nav').dataset.group) : view;
    await page.locator('#mainNav [data-view="' + group + '"]').click();
    if (group !== view) await tab.click();
  }
  await page.goto(fixture.url + '/?view=overview');
  await page.locator('#modules[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('.module').count(), 4);
  await page.getByRole('button', { name: '待确认', exact: true }).click();
  assert.equal(await page.locator('#tasks .task').count(), 1);
  await page.locator('#tasks .task').click();
  await page.waitForFunction(() => document.activeElement?.id === 'stickerReviews');
  await page.goBack();
  await page.getByRole('button', { name: '异常', exact: true }).click();
  await page.locator('#tasks .task').filter({ hasText: '记忆整理失败' }).click();
  await page.locator('.memory-organizer-job[open] button', { hasText: '重试' }).waitFor();
  assert.match(await page.locator('.memory-organizer-job[open]').innerText(), /模型请求超时/);
  await page.goBack();
  await page.locator('#qq-list .qq-row').first().click();
  await page.waitForFunction(() => document.activeElement?.matches('#v2AllStatesOutput tbody tr'));
  await page.goBack();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile overview fits the viewport');
  await page.setViewportSize({ width: 1440, height: 1000 });
  fixture.state.snowluma = { connected: true, degraded: true, silent: true, good: true, hint: '测试网关心跳中断' };
  await page.goto(fixture.url);
  await page.waitForFunction(() => document.getElementById('desktopAgentStatus')?.textContent.length > 0);

  assert.equal(await page.locator('#section-desktop-agent').count(), 1, 'the global desktop-agent controls are present');
  assert.equal(await page.locator('#sessionList, #pendingList, #aiNotifyTarget, #dshSessionRefresh').count(), 0,
    'per-QQ session mapping and notification controls are absent');
  assert.match(await page.locator('[data-view="sessions"]').first().textContent(), /主会话/);

  await openPage('sessions');
  await page.getByText('我先看看桌面状态。', { exact: true }).waitFor();
  await page.locator('#desktopAgentHistoryOlder').click();
  await page.getByText('请按当前角色在这个长期会话里自然活动。', { exact: true }).waitFor();
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

  await openPage('usage');
  await page.locator('[data-usage-key="memory"]').click();
  await page.waitForFunction(() => document.getElementById('usageTurnScope').textContent.includes('记忆整理'));
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/tokens/prices/refresh') && response.request().method() === 'POST'),
    page.locator('#usagePricesRefresh').click(),
  ]);
  assert.ok(fixture.requests.some(r => r.path === '/api/tokens/prices/refresh' && r.method === 'POST'));
  assert.match(await page.locator('#usageConversations').innerText(), /后台学习/);
  assert.match(await page.locator('#metricUsagePerTurn').innerText(), /5,600/);

  await openPage('maintenance');
  await page.locator('#snowlumaWarn').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#metricSnowluma').textContent(), '心跳中断');
  assert.equal(await page.locator('#snowlumaWarnHint').textContent(), fixture.state.snowluma.hint);
  assert.doesNotMatch(await page.locator('#snowlumaWarn').innerText(), /\[Hook\]/);
  fixture.state.snowluma = { connected: true, degraded: true, good: false, hint: '测试网关接收异常' };
  await page.locator('#refreshConsole').click();
  await page.waitForFunction(() => document.getElementById('metricSnowluma').textContent === '接收异常');
  assert.equal(await page.locator('#snowlumaWarnHint').textContent(), fixture.state.snowluma.hint);
  fixture.state.snowluma = { connected: true, degraded: false, good: true };
  await page.locator('#refreshConsole').click();
  await page.locator('#snowlumaWarn').waitFor({ state: 'hidden' });
  await openPage('access');
  await page.waitForFunction(() => document.getElementById('ownerQQ').value === '100001');
  assert.equal(await page.locator('#secInterceptNotify, #secSave').count(), 0, 'the obsolete interception notification control is absent');
  assert.equal(await page.locator('#section-whitelist #wlGroups').count(), 0, 'test-send lists are not presented as agent access controls');
  await page.locator('#ownerQQ').fill('123456');
  await page.locator('#ownerQQSave').click();
  await page.waitForFunction(() => document.getElementById('ownerQQMsg').textContent.includes('已保存'));
  const ownerSave = fixture.requests.filter(request => request.path === '/api/whitelist').at(-1);
  assert.deepEqual(ownerSave.body, { ownerQQ: '123456' }, 'saving owner does not rewrite test-send lists');

  await openPage('operations');
  await page.locator('#qqFailuresOnly').check();
  await page.waitForFunction(() => document.getElementById('v2ToolLogMsg').textContent.includes('1 项'));
  assert.match(await page.locator('#v2ToolLogOutput').innerText(), /消息定位已失效/);
  assert.doesNotMatch(await page.locator('#v2ToolLogOutput').innerText(), /qq_get_unread_messages/);
  assert.match(await page.locator('#v2FeedbackOutput .err').innerText(), /错误/);
  await openPage('maintenance');
  await page.locator('#section-test-send summary').click();
  await page.locator('#wlGroups').fill('123456789, 555');
  await page.locator('#wlSave').click();
  await page.waitForFunction(() => document.getElementById('wlMsg').textContent.includes('已保存'));
  const listSave = fixture.requests.filter(request => request.path === '/api/whitelist').at(-1);
  assert.equal(Object.hasOwn(listSave.body, 'ownerQQ'), false, 'saving test-send lists does not change the owner');

  await openPage('access');
  await page.locator('#ownerQQ').fill('');
  await page.locator('#ownerQQSave').click();
  await page.waitForFunction(() => document.getElementById('ownerQQMsg').textContent.includes('已清除'));
  assert.deepEqual(fixture.requests.filter(request => request.path === '/api/whitelist').at(-1).body, { ownerQQ: '' });

  await openPage('persona');
  await page.waitForFunction(() => document.getElementById('desktopPromptPreview')?.value.includes('人格卡定义你的具体身份和形态'));
  assert.equal(await page.locator('#desktopPromptPreset').count(), 0, 'there is no obsolete multi-preset selector');
  assert.match(await page.locator('#desktopPromptStatus').textContent(), /数字角色/);
  await page.locator('#desktopPromptEdit').click();
  const promptToggles = page.locator('#desktopPromptModules .prompt-module-toggle input');
  assert.ok(await promptToggles.count() > 0);
  assert.equal(await promptToggles.evaluateAll((items) => items.some((item) => item.disabled)), false, 'all prompt modules can be switched off');
  await promptToggles.first().uncheck();
  await page.locator('#desktopPromptCancel').click();

  await openPage('social-v2');
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/socialV2/states?names=1')),
    page.locator('#v2StatesList').click(),
  ]);
  await page.waitForFunction(() => document.getElementById('v2AllStatesOutput').textContent.includes('group:123456789'));
  assert.match(await page.locator('#v2AllStatesOutput').textContent(), /group:123456789/);
  assert.match(await page.locator('#v2Summary').innerText(), /未读消息\s*2/);
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'buffer dashboard fits width ' + width);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openPage('qq-settings');
  await page.locator('#qqConversationForm [name=delayPerCharMs]').fill('25');
  await page.locator('#qqConversationForm button').click();
  await page.waitForFunction(() => document.querySelector('#qqConversationForm [role=status]').textContent === '已保存');
  assert.equal(fixture.state.v2.send.delayPerCharMs, 25);
  assert.equal(fixture.state.v2.wait, undefined);
  const imagePrefetch = page.locator('#qqMediaForm [name=prefetchOnReceive]');
  assert.equal(await imagePrefetch.isChecked(), true, 'image cache prefetch defaults to on');
  await imagePrefetch.uncheck();
  await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/socialV2/config') && r.request().method() === 'POST'),
    page.locator('#qqMediaForm button').click(),
  ]);
  await page.waitForFunction(() => document.querySelector('#qqMediaForm [role=status]').textContent === '已保存');
  assert.equal(fixture.state.v2.media.prefetchOnReceive, false);
  await imagePrefetch.check();
  await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/socialV2/config') && r.request().method() === 'POST'),
    page.locator('#qqMediaForm button').click(),
  ]);
  await page.waitForFunction(() => document.querySelector('#qqMediaForm [role=status]').textContent === '已保存');
  assert.equal(fixture.state.v2.media.prefetchOnReceive, true);
  const reminderNames = ['private','atMention','reply','roleCardName','keyword','poke','unreadFollowup'];
  const reminderButton = setting => page.locator(`#qqReminderControls [data-reminder-setting="${setting}"]`);
  const reminderStatus = setting => reminderButton(setting).locator('..').locator('[role=status]');
  const reminderValues = () => page.locator('#qqReminderControls [role=switch]').evaluateAll(buttons =>
    Object.fromEntries(buttons.map(button => [button.dataset.reminderSetting, button.getAttribute('aria-checked') === 'true'])));
  async function toggleReminder(setting, expected) {
    const before = await reminderValues();
    const patch = setting === 'enabled' ? { enabled: expected } : { reminders: { [setting.split('.')[1]]: expected } };
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/socialV2/config') && r.request().method() === 'POST'),
      reminderButton(setting).click(),
    ]);
    assert.deepEqual(response.request().postDataJSON(), patch, 'each button saves only its own setting');
    await reminderButton(setting).and(page.locator(`[aria-checked="${expected}"]:not([disabled])`)).waitFor();
    assert.deepEqual(await reminderValues(), { ...before, [setting]: expected }, 'other switches keep their states');
    assert.equal(await reminderStatus(setting).innerText(), '已保存，立即生效');
  }
  assert.equal(await page.locator('#qqReminderControls [role=switch]').count(), 8, 'one master and seven shared switches');
  for (const setting of ['enabled', ...reminderNames.map(name => 'reminders.' + name)]) {
    assert.equal(await reminderButton(setting).getAttribute('aria-checked'), 'true');
  }
  assert.equal(await page.locator('#qqReminderMasterHint').isVisible(), false);
  const keywordDraft = '待保存关键词\n第二个关键词';
  await page.locator('#v2AttentionKeywords').fill(keywordDraft);
  for (const name of ['poke', 'atMention', 'unreadFollowup']) await toggleReminder('reminders.' + name, false);
  assert.equal(await page.locator('#v2AttentionKeywords').inputValue(), keywordDraft, 'switch saves preserve keyword drafts');
  assert.deepEqual(fixture.state.v2.attentionKeywords, ['看看这个'], 'switch saves do not submit keyword drafts');
  const reminderSettings = structuredClone(fixture.state.v2.reminders);
  const [keywordResponse] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/socialV2/config') && r.request().method() === 'POST'),
    page.locator('#qqReminderForm button').click(),
  ]);
  await page.waitForFunction(() => document.querySelector('#qqReminderForm [role=status]').textContent === '已保存');
  assert.deepEqual(keywordResponse.request().postDataJSON(), { attentionKeywords: keywordDraft.split('\n') });
  assert.deepEqual(fixture.state.v2.reminders, reminderSettings, 'keyword saves preserve reminder switches');

  // A rejected save must keep the old state and allow the same button to retry.
  await page.route('**/api/socialV2/config', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '测试保存失败' }),
  }), { times: 1 });
  await reminderButton('reminders.poke').click();
  await reminderStatus('reminders.poke').filter({ hasText: '保存失败：测试保存失败' }).waitFor();
  assert.equal(await reminderButton('reminders.poke').getAttribute('aria-checked'), 'false');
  assert.equal(await reminderButton('reminders.poke').innerText(), '已关闭');
  assert.equal(await reminderButton('reminders.poke').isEnabled(), true);
  assert.equal(fixture.state.v2.reminders.poke, false);
  await toggleReminder('reminders.poke', true);

  await page.reload();
  await page.locator('#qqReminderControls [data-reminder-setting="enabled"]:not([disabled])').waitFor();
  for (const name of reminderNames) {
    assert.equal(await reminderButton('reminders.' + name).getAttribute('aria-checked'), String(fixture.state.v2.reminders[name]));
  }
  assert.equal(await page.locator('#v2AttentionKeywords').inputValue(), keywordDraft);
  await toggleReminder('enabled', false);
  await page.locator('#qqReminderMasterHint').waitFor({ state: 'visible' });
  const pausedSettings = structuredClone(fixture.state.v2.reminders);
  await toggleReminder('reminders.reply', false);
  assert.equal(fixture.state.v2.enabled, false);
  assert.deepEqual(fixture.state.v2.reminders, { ...pausedSettings, reply: false }, 'individual settings remain editable while paused');
  assert.equal(fixture.state.v2.sticker.enabled, true);
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'reminder controls fit width ' + width);
    assert.ok(await page.locator('#qqReminderControls [role=switch]').evaluateAll(buttons => buttons.every(button => {
      const rect = button.getBoundingClientRect();
      return rect.width >= 88 && rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth;
    })), 'each reminder button stays readable and within the viewport');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openPage('social-v2');
  await page.locator('details').filter({ has: page.locator('#v2ResetBtn') }).locator('summary').click();
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/socialV2/reset') && response.request().method() === 'POST'),
    page.locator('#v2ResetBtn').click(),
  ]);
  assert.ok(fixture.requests.some(request => request.path === '/api/socialV2/reset'), 'cache reset stays separate from the global session');

  await page.waitForFunction(() => document.querySelector('#v2AllStatesOutput').textContent.includes('暂无缓冲消息'));
  await openPage('qq-settings');
  await page.locator('#qqBackend').selectOption('native');
  await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/restart') && r.request().method() === 'POST'),
    page.locator('#qqBackendForm button').click(),
  ]);
  assert.equal(fixture.state.qqBackend, 'native');
  await openPage('social-v2');
  await page.waitForFunction(() => document.getElementById('v2ResetBtn').textContent === '清空 QQ 提醒缓存');
  assert.match(await page.locator('#v2Summary').innerText(), /未读提醒/);
  await openPage('learning');
  await page.waitForFunction(() => document.getElementById('learningStatus').textContent.includes('已启用'));
  await page.locator('#learningSources').fill('group:123456789');
  await page.locator('#learningSave').click();
  await page.waitForFunction(() => document.getElementById('learningActionStatus').textContent.includes('已保存'));
  assert.deepEqual(fixture.state.learning.sources, ['group:123456789']);
  await openPage('slang');
  await page.locator('#slangRecords [data-knowledge-index]').first().click();
  assert.equal(await page.locator('#slangContent').inputValue(), '摸鱼');
  await page.locator('#slangMeaning').fill('完成任务后休息一会');
  await page.locator('#slangStatus').selectOption('confirmed');
  await page.locator('#slangSave').click();
  await page.waitForFunction(() => document.getElementById('slangActionStatus').textContent.includes('已保存'));
  assert.equal(fixture.state.slang[0].meaning, '完成任务后休息一会');
  await openPage('stickers');
  await page.locator('#stickerReviews button[data-accept=yes]').click();
  await page.waitForFunction(() => document.getElementById('stickerReviewStatus').textContent === '已采纳');
  assert.equal(fixture.state.learnedStickers[0].desc, '猫咪点头');
  await page.getByLabel('允许角色使用普通表情').uncheck();
  await page.locator('#qqStickerForm button').click();
  await page.waitForFunction(() => document.querySelector('#qqStickerForm [role=status]').textContent === '已保存');
  assert.equal(fixture.state.v2.enabled, false);
  assert.equal(fixture.state.v2.sticker.regularEnabled, false);
  assert.equal(fixture.state.v2.sticker.marketEnabled, true);
  assert.equal(fixture.state.v2.sticker.syncEnabled, true);
  await page.locator('#stickerRecords [data-knowledge-index]').first().click();
  assert.equal(await page.locator('#stickerDescription').inputValue(), '猫咪点头');
  await page.locator('#stickerTags').fill('开心、期待');
  await page.locator('#stickerSave').click();
  await page.waitForFunction(() => document.getElementById('stickerActionStatus').textContent.includes('已保存'));
  assert.deepEqual(fixture.state.learnedStickers[0].tags, ['开心', '期待']);
  await openPage('market-stickers');
  await page.getByLabel('允许角色使用商城表情').uncheck();
  await page.getByRole('button', { name: '保存商城表情设置' }).click();
  await page.waitForFunction(() => document.querySelector('#qqMarketStickerForm [role=status]').textContent === '已保存');
  assert.equal(fixture.state.v2.sticker.marketEnabled, false);
  assert.equal(fixture.state.v2.sticker.regularEnabled, false);
  await page.locator('#marketQuery').fill('测试包');
  await page.locator('#marketQuery').press('Enter');
  await page.locator('#marketPackList button').click();
  await page.getByRole('button', { name: '收录整包' }).click();
  await page.getByRole('button', { name: '等待分析' }).waitFor();
  assert.equal(await page.locator('#marketAnalyze').isDisabled(), true);
  assert.equal(await page.locator('#marketAnalysisProgress').isVisible(), true);
  assert.equal(fixture.requests.some(r => r.path === '/api/learning/market-packs/analyze'), false);
  fixture.state.marketPack.analysis = { status: 'failed', error: '模型仅读取了 1/2 页表情图' };
  await page.getByRole('button', { name: '重试整包分析' }).waitFor();
  assert.equal(await page.locator('#marketAnalysisError').innerText(), fixture.state.marketPack.analysis.error);
  assert.equal(await page.locator('#marketAnalysisProgress').isVisible(), false);
  await page.getByRole('button', { name: '重试整包分析' }).click();
  await page.getByRole('button', { name: '正在分析' }).waitFor();
  assert.equal(await page.locator('#marketAnalysisError').isVisible(), false);
  await page.getByRole('button', { name: '编辑注解' }).click();
  await page.locator('.market-item textarea').fill('赞同对方的想法');
  await page.getByRole('button', { name: '重新分析整包' }).waitFor();
  assert.equal(await page.locator('.market-item textarea').inputValue(), '赞同对方的想法');
  await page.locator('.market-item button', { hasText: '保存' }).click();
  await page.waitForFunction(() => document.querySelector('.market-note').textContent === '赞同对方的想法');
  assert.match(await page.locator('.market-item').innerText(), /商城关键词.*赞同/);
  assert.match(await page.locator('.market-item').innerText(), /回应对方的意见/);
  await page.locator('#marketBack').click();
  await page.locator('#marketShowInstalled').click();
  await page.locator('#marketPackList button').click();
  assert.equal(await page.locator('.market-note').textContent(), '赞同对方的想法');
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `learning UI has no horizontal overflow at ${width}`);
  }
  await openPage('memory');
  await page.locator('#memoryQuery').fill('书架');
  await page.locator('#memorySearch').click();
  await page.locator('#memoryResults summary').first().click();
  await page.locator('#memoryResults [data-memory-index]').click();
  await page.waitForFunction(() => document.getElementById('memoryId').value === 'demo-first');
  await page.locator('#memoryContent').fill('书架已经整理。');
  await page.locator('#memoryReplace').click();
  await page.waitForFunction(() => document.getElementById('memoryEditorStatus').textContent === '已保存修改');
  assert.equal(await page.locator('#memoryId').inputValue(), fixture.state.memoryRecords[0].memoryId);
  await page.locator('#memoryDelete').click();
  await page.waitForFunction(() => document.getElementById('memoryEditorStatus').textContent === '已删除');
  assert.equal(fixture.state.memoryRecords.length, 0);

  fixture.state.memoryRecords = Array.from({ length: 21 }, (_, index) => ({
    memoryId: `shelf-${index + 1}`, content: `书架记录 ${index + 1}`, metadata: { origin: 'assistant' },
  }));
  for (const [button, expectedPage, firstId] of [
    ['memoryBrowseAll', 1, 'shelf-1'], ['memoryNextPage', 2, 'shelf-11'], ['memoryNextPage', 3, 'shelf-21'],
    ['memoryPreviousPage', 2, 'shelf-11'], ['memoryPreviousPage', 1, 'shelf-1'],
  ]) {
    await page.locator('#' + button).click();
    await page.locator('#memoryPageLabel').filter({ hasText: `第 ${expectedPage}/3 页` }).waitFor();
    assert.equal(await page.locator('#memoryResults summary code').first().textContent(), firstId);
  }
  assert.ok(await page.locator('#memoryPreviousPage').isDisabled());

  await openPage('memory-settings');
  await page.waitForFunction(() => document.getElementById('memoryNamespace').value === 'demo');
  await page.locator('#memoryNamespace').fill('保留草稿');
  await openPage('model');
  await openPage('memory-settings');
  assert.equal(await page.locator('#memoryNamespace').inputValue(), '保留草稿');

  await page.locator('#themeToggle').click();
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.locator('.section-tabs:not([hidden]) [aria-current=page]').getAttribute('data-view'), 'memory-settings');
  await page.locator('#consoleSearch').fill('黑话');
  await page.locator('#searchResults button').first().click();
  assert.equal(new URL(page.url()).hash, '#slang');
  await page.goBack();
  assert.equal(new URL(page.url()).hash, '#memory-settings');

  // All primary and secondary destinations also need to fit a narrow viewport.
  const routes = await page.locator('[data-page]').evaluateAll(els => [...new Set(els.map(el => el.dataset.page))]);
  for (const view of routes) {
    await openPage(view);
    assert.ok(await page.locator('[data-page="' + view + '"]').first().isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile layout fits: ' + view);
  }
  assert.deepEqual(blockedRequests, [], 'the UI must not reach external endpoints');
  assert.deepEqual(errors, [], 'browser console and page should be free of errors');
  assert.deepEqual(fixture.unknownRequests, [], 'the offline fixture implements all current console API routes');
  console.log('PASS console views, market pack management, overview deep links, memory edits, session and QQ controls, learning, navigation and mobile layout');
} finally {
  await browser?.close();
  await fixture.close();
}
