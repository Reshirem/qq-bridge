import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import yaml from 'js-yaml';
import { createChatLearningStore, createChatLearningWorker, normalizeLearningConfig, MAX_SLANG_EVIDENCE, MAX_SLANG_ENTRIES, MAX_LEARNED_STICKERS } from '../src/chat-learning.js';
import { createStickerMemory } from '../src/sticker-memory.js';
import { createLearningAssets } from '../src/learning-assets.js';
import { createMarketPacks } from '../src/market-packs.js';
import { analyzeMarketPack } from '../src/market-analysis.js';
import { learningPatch, runLearningHeadless } from '../src/learning-runner.js';
import { apply as guard } from '../src/learning-tool-guard.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createTokenLedger } from '../src/token-ledger.js';
import { createLearningSessionCleanup } from '../src/learning-sessions.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
const config = normalizeLearningConfig({ minMessages: 2 });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-learning-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('qq-learning-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'learning.json');
  return { root, file, store: createChatLearningStore(file), assets: createLearningAssets(path.join(root, 'assets')) };
}
function enqueue(store, key = 'group:123', messageId = '1', text = '今天又开始摸鱼了', media = []) {
  return store.enqueue(key, { messageId, plain: text, media, userId: '456' }, config);
}

test('chat worker titles and records its grouped session before prompting and archives idle sessions after commit', async t => {
  const { store } = fixture(t);
  enqueue(store);
  store.rememberSessions(['legacy']);
  const ok = value => ({ result: { ok: true, value } });
  let title, groupTitle;
  const archived = [];
  const h = await bridgeHarness({
    config: { chatLearning: { enabled: true, slang: true, stickers: false } },
    files: { 'state/chat-learning.json': store.snapshot() },
    globals: { async runBackgroundTurn({ sessionId, preset, onEvent }) {
      assert.equal(sessionId, 'fixture-1');
      assert.equal(preset, 'chat-learning');
      assert.ok(snapshot().sessionIds.includes(sessionId));
      assert.match(title, /^后台学习 · group:123 · \d{4}-\d\d-\d\d \d\d:\d\d$/);
      onEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"slang":[],"stickers":[]}' }] } } });
    } },
  });
  t.after(() => h.close());
  const snapshot = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'state/chat-learning.json'), 'utf8'));
  h.setReady(true);
  h.api.workspace.create = async ({ path: dir }) => {
    assert.equal(dir, path.join(h.temp, 'state', 'chat-learning-workspace'));
    return ok({ created: true, workspace: { workspaceId: 'learning' } });
  };
  h.api.workspace.rename = async args => { groupTitle = args.title; return ok({}); };
  h.api.sessions.rename = async args => { title = args.title; return ok({}); };
  h.api.callUnary = async (method, { sessionId }) => {
    if (method === 'session/list') return ok({ items: ['fixture-1', 'legacy'].map(id => ({ sessionId: id, running: false, agentAvailable: true })) });
    assert.equal(method, 'workspace/archiveSession');
    assert.equal(snapshot().queue.length, 0);
    archived.push(sessionId);
    return ok({});
  };
  assert.equal((await h.learningWorker.tick(true))?.messages, 1);
  assert.equal(groupTitle, '后台黑话与表情学习');
  assert.equal(h.calls.created[0].workspaceId, 'learning');
  assert.equal(h.calls.created[0].agentPreset, 'chat-learning');
  assert.deepEqual(archived.sort(), ['fixture-1', 'legacy']);
});

const learningKey = 'group:123';
function seedSlang(t, entries, options) {
  const { file, store } = fixture(t);
  const slang = entries.map(e => ({
    id: e.content, scope: learningKey, source: 'ai', status: 'learned', meaning: '测试释义',
    confidence: 0.9, count: 2, evidence: [], ...e,
  }));
  fs.writeFileSync(file, JSON.stringify({ ...store.snapshot(), slang }));
  return { file, store: createChatLearningStore(file, options) };
}

test('single characters need two distinct occurrences and retain a confident interpretation', t => {
  const { store } = fixture(t);
  enqueue(store, learningKey, '1', '草，摸鱼，6，e');
  enqueue(store, learningKey, '2', '只是上下文');
  const batch = store.batch(config);
  const terms = ['草', '摸鱼', '6', 'e'];
  const slang = terms.map(content => ({ content, meaning: '最初释义', usage: '原用法', confidence: 0.9, evidenceIds: ['1', '2'] }));
  store.complete(batch, { slang: [...slang, slang[0]], stickers: [] }, [], config);
  assert.deepEqual(store.query(learningKey).map(e => e.content), ['摸鱼']);
  assert.equal(store.snapshot().slang[0].count, 1);
  assert.equal(store.snapshot().slang[0].status, 'candidate');
  enqueue(store, learningKey, '3', '草，摸鱼，6，e');
  const recurrence = slang.map(e => ({ ...e, confidence: 0.3, meaning: '', usage: '猜测用法', evidenceIds: ['3'] }));
  store.complete(store.batch(config, Date.now(), true), { slang: recurrence, stickers: [] }, [], config);
  const grass = store.snapshot().slang[0];
  assert.deepEqual([grass.status, grass.count, grass.meaning, grass.usage, grass.confidence], ['learned', 2, '最初释义', '原用法', 0.9]);
  assert.equal(store.query(learningKey, '草')[0].content, '草');
  const match = text => store.query(learningKey, text, { matchText: true }).map(e => e.content);
  assert.deepEqual(match('这波操作真６，Ｅ技能空了'), ['6', 'e']);
  assert.deepEqual(match('房间号16800，hello world'), []);
  assert.deepEqual(match('nice e 6'), ['6', 'e']);
});

test('duplicate proposals cannot count the same occurrence twice when the evidence window rolls', t => {
  const { store } = fixture(t);
  const evidenceIds = Array.from({ length: 10 }, (_, i) => String(i + 1));
  for (const id of evidenceIds) enqueue(store, learningKey, id, id === '1' ? '寄' : '补充上下文');
  const proposal = { content: '寄', meaning: '失败了', confidence: 0.9, evidenceIds };
  store.complete(store.batch(config), { slang: [proposal, proposal], stickers: [] }, [], config);
  const [entry] = store.snapshot().slang;
  assert.deepEqual([entry.status, entry.count], ['candidate', 1]);
  assert.deepEqual(entry.evidence.map(e => e.messageId), evidenceIds.slice(-8));
});

test('old slang normalizes in memory and persists the latest eight citations on the next commit', t => {
  assert.deepEqual([MAX_SLANG_ENTRIES, MAX_SLANG_EVIDENCE, MAX_LEARNED_STICKERS], [3000, 8, 300]);
  const evidence = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
  const { file, store } = seedSlang(t, [
    { content: '🦊', count: 1, evidence }, { content: '水', count: 0, source: 'manual' },
    { content: '站', count: 1, status: 'confirmed' }, { content: '摸鱼', count: 1 },
  ]);
  assert.equal(JSON.parse(fs.readFileSync(file)).slang[0].evidence.length, 20);
  const entries = store.snapshot().slang;
  assert.deepEqual(entries.map(e => e.status), ['candidate', 'learned', 'confirmed', 'learned']);
  assert.deepEqual(entries[0].evidence, evidence.slice(-8));
  enqueue(store, learningKey, '30', '🦊');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).slang, entries);
  const batch = store.batch(config, Date.now(), true);
  store.complete(batch, { slang: [{ content: '🦊', evidenceIds: ['30'] }], stickers: [] }, [], config);
  const [word] = createChatLearningStore(file).snapshot().slang;
  assert.equal(word.status, 'learned');
  assert.deepEqual(word.evidence.map(e => e.id), [...evidence.slice(-7).map(e => e.id), batch.messages[0].id]);
});

test('slang query ranks review, scope, term length, frequency and recency before truncation', t => {
  const { store } = seedSlang(t, [
    { content: '全球梗', scope: 'global', count: 99 }, { content: '草' }, { content: '寄', count: 9 },
    { content: '旧梗', updatedAt: '2025-01-01' }, { content: '新梗', updatedAt: '2026-01-01' },
    { content: '乐', scope: 'global', status: 'confirmed' },
  ]);
  const expected = ['乐', '新梗', '旧梗', '寄'];
  for (const [text, matchText] of [['全球梗草寄旧梗新梗乐', true], ['测试释义', false]]) {
    assert.deepEqual(store.query(learningKey, text, { matchText, limit: 4 }).map(e => e.content), expected);
  }
});

test('slang eviction rolls through tiers and protects manual entries on both insertion paths', t => {
  const { store } = seedSlang(t, [
    { content: '已确认', status: 'confirmed' }, { content: '常见梗', count: 3 },
    { content: '一次梗', count: 1 }, { content: '僵尸词', status: 'candidate', count: 1 },
  ], { maxSlang: 4 });
  const contents = () => store.snapshot().slang.map(e => e.content);
  enqueue(store, learningKey, '1', '候选词');
  enqueue(store, learningKey, '2', '候选词');
  store.complete(store.batch(config), { slang: [{ content: '候选词', evidenceIds: ['1', '2'] }], stickers: [] }, [], config);
  assert.deepEqual(contents(), ['已确认', '常见梗', '一次梗', '候选词']);
  const add = (content, status) => store.edit('slang', { content, status, scope: learningKey, meaning: '测试' });
  assert.throws(() => add('候选词', 'confirmed'), /已有该词条/);
  add('已拒绝', 'rejected');
  assert.deepEqual(contents(), ['已确认', '常见梗', '一次梗', '已拒绝']);
  add('手工候选', 'candidate');
  assert.deepEqual(contents(), ['已确认', '常见梗', '已拒绝', '手工候选']);
  add('手工新增', 'confirmed');
  assert.deepEqual(contents(), ['已确认', '已拒绝', '手工候选', '手工新增']);
  enqueue(store, learningKey, '3', '新词');
  const before = store.snapshot();
  assert.throws(() => store.complete(store.batch(config, Date.now(), true),
    { slang: [{ content: '新词', evidenceIds: ['3'] }], stickers: [] }, [], config), /黑话库已被人工确认\/拒绝词条占满/);
  assert.deepEqual(store.snapshot(), before);
});

test('slang eviction resolves ties by count, oldest activity and original array order', t => {
  const { store } = seedSlang(t, [
    { content: '高频', count: 8, updatedAt: '2020' }, { content: '活跃', updatedAt: '2026' },
    { content: '先入', createdAt: '2024' }, { content: '后入', updatedAt: '2024' },
  ], { maxSlang: 4 });
  store.edit('slang', { content: '新增', meaning: '测试', scope: learningKey });
  assert.deepEqual(store.snapshot().slang.map(e => e.content), ['高频', '活跃', '后入', '新增']);
});

test('local sticker eviction considers usage and age, excluding market, reviewed and global stickers', t => {
  const { file } = fixture(t);
  const store = createChatLearningStore(file, { maxStickers: 2 });
  function add(id) {
    const hash = String(id).padStart(64, '0'), image = { hash, id: 'learned:' + hash };
    enqueue(store, learningKey, String(id));
    store.complete(store.batch(config, Date.now(), true), { slang: [], stickers: [
      { id: image.id, isSticker: true, description: '表情' },
    ] }, [image], config);
    return image.id;
  }
  const marketId = 'a'.repeat(32);
  store.addMarketPack({ id: '123', name: '商城包' }, [{ faceId: marketId, hash: '0'.repeat(64), tags: [] }]);
  const first = add(1), second = add(2), third = add(3);
  const locals = () => store.snapshot().stickers.filter(e => e.source !== 'market').map(e => e.id);
  assert.deepEqual(locals(), [second, third]);
  assert.ok(!locals().includes(first));
  store.used(second, learningKey);
  const fourth = add(4);
  assert.deepEqual(locals(), [second, fourth]);
  store.proposeSticker(store.stickers(learningKey).find(e => e.id === fourth), { desc: '待确认' });
  const fifth = add(5);
  assert.deepEqual(locals(), [fourth, fifth]);
  store.edit('stickers', { id: fifth, originalScope: learningKey, scope: 'global' });
  assert.throws(() => add(6), /本地表情库已被人工确认条目占满/);
  assert.deepEqual(locals(), [fourth, fifth]);
  store.decideStickerReview(store.snapshot().stickerReviews[0].id, false);
  store.edit('stickers', { id: fourth, originalScope: learningKey, status: 'confirmed' });
  assert.throws(() => add(6), /本地表情库已被人工确认条目占满/);
  assert.equal(store.snapshot().queue.length, 1);
  assert.equal(store.marketStickers('123')[0].faceId, marketId);
});

test('learning cleanup migrates recorded sessions, isolates management and preserves knowledge and usage', async t => {
  const f = fixture(t);
  enqueue(f.store);
  f.store.edit('slang', { content: '摸鱼', meaning: '偷闲', scope: 'group:123', status: 'confirmed' });
  const oldState = { ...f.store.snapshot(), usage: { inputTokens: 10, outputTokens: 20 },
    lastResult: { sessionId: 'last-success' }, sessionIds: ['local-failure', 'running', 'unknown', 'missing', 'main', 'memory'] };
  let ledger;
  const h = await bridgeHarness({ files: {
    'state/chat-learning.json': oldState,
    'state/desktop-agent.json': { sessionId: 'main', agentToken: 'fixture-agent' },
    'state/memory-organizer.json': { version: 1, sources: {}, jobs: [], sessionsByDay: { '2026-11-18': 'memory' } },
  }, globals: { createTokenLedger(options) {
    ledger = createTokenLedger(options);
    for (const [sessionId, feature] of [['old-chat', 'learning'], ['old-market', 'learning'], ['archived', 'learning'], ['unrelated', 'other']]) {
      ledger.ingestSample({ sessionId, feature, turn: 1, step: 1, seq: -1, usage: { inputTokens: 1, outputTokens: 1 } });
    }
    return ledger;
  } } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, body, extra = {}) => {
      const response = await fetch(base + '/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', ...extra },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() };
    };
    const cleanup = extra => call('sessions/cleanup', { sessionIds: ['unrelated'] }, extra);
    assert.equal((await cleanup({ 'x-console-token': 'wrong' })).status, 401);
    assert.equal((await cleanup({ 'x-agent-token': 'fixture-agent', 'x-agent-session-id': 'main' })).status, 403);
    assert.equal((await cleanup({ origin: 'https://untrusted.invalid' })).status, 403);
    const before = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/chat-learning.json'), 'utf8'));
    assert.deepEqual(new Set(before.sessionIds), new Set([...oldState.sessionIds, 'last-success', 'old-chat', 'old-market', 'archived']));
    assert.equal((await call('status')).body.sessions.tracked, 10);
    const archives = new Set(['archived']);
    let failRead = true, failArchive = true;
    const attempts = [];
    h.api.readWorkspaceState = async () => {
      if (failRead) throw new Error('fixture disconnected');
      return { items: [], archivedSessionIds: [...archives] };
    };
    h.api.callUnary = async (method, request) => {
      if (method === 'session/list') return { result: { ok: true, value: { items: before.sessionIds.filter(id => id !== 'missing').map(sessionId => ({
        sessionId, running: sessionId === 'unknown' ? undefined : sessionId === 'running', agentAvailable: sessionId === 'old-chat',
      })) } } };
      assert.equal(method, 'workspace/archiveSession');
      assert.deepEqual(Object.keys(request), ['sessionId'], 'cleanup must not force-stop a session');
      attempts.push(request.sessionId);
      if (request.sessionId === 'old-market' && failArchive) return { result: { ok: false, error: { code: 'workspace/session-active', message: 'fixture active' } } };
      archives.add(request.sessionId);
      return { result: { ok: true, value: {} } };
    };
    h.setReady(false);
    assert.equal((await cleanup()).status, 503);
    h.setReady(true);
    assert.equal((await cleanup()).status, 502);
    assert.deepEqual(attempts, []);
    failRead = false;
    const first = await cleanup();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.archived.map(x => x.sessionId).sort(), ['last-success', 'local-failure', 'old-chat']);
    assert.deepEqual(first.body.alreadyArchived.map(x => x.sessionId), ['archived']);
    assert.deepEqual(first.body.skipped.map(x => x.sessionId).sort(), ['main', 'memory', 'missing', 'running', 'unknown']);
    assert.deepEqual(first.body.failed.map(x => x.sessionId), ['old-market']);
    failArchive = false;
    assert.deepEqual((await cleanup()).body.archived.map(x => x.sessionId), ['old-market']);
    assert.deepEqual((await cleanup()).body.archived, []);
    assert.equal(attempts.length, 5);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/chat-learning.json'), 'utf8')), before);
    assert.equal(ledger.recordedSessionIds('learning').length, 3);
    ledger.reset();
    assert.equal((await call('status')).body.sessions.tracked, 10, 'usage reset retains migrated session ownership');

    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    h.api.readWorkspaceState = () => new Promise(resolve => { release = resolve; started(); });
    const pending = cleanup();
    await waiting;
    try {
      assert.equal((await call('status')).body.sessions.cleanupBusy, true);
      assert.equal((await cleanup()).status, 409);
    } finally { release({ archivedSessionIds: [...archives] }); await pending; }
    assert.equal((await call('status')).body.sessions.cleanupBusy, false);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('learning cleanup rechecks active local processes before each archive and rejects invalid lists', async () => {
  const active = new Set(['active-chat', 'active-market']);
  const attempts = [];
  let invalid = true;
  const cleanup = createLearningSessionCleanup({ isReady: () => true, sanitize: String,
    getSessionIds: () => ['first', 'newly-active', 'active-chat', 'active-market'], getProtectedSessionIds: () => active,
    api: { readWorkspaceState: async () => ({ archivedSessionIds: [] }), callUnary: async (method, request) => {
      if (method === 'session/list') return { result: { ok: true, value: invalid ? {} : { items:
        ['first', 'newly-active', 'active-chat', 'active-market'].map(sessionId => ({ sessionId, running: false, agentAvailable: false })) } } };
      attempts.push(request.sessionId); active.add('newly-active');
      return { result: { ok: true, value: {} } };
    } },
  });
  await assert.rejects(cleanup.cleanup(), error => error.statusCode === 502);
  assert.deepEqual(attempts, []);
  invalid = false;
  assert.equal((await cleanup.cleanup()).skipped.length, 3);
  assert.deepEqual(attempts, ['first']);
});

test('headless registers chat and market sessions before usage, including failures and cancellation', async t => {
  const f = fixture(t);
  for (const mode of ['chat', 'market']) {
    const sessionId = `${mode}-failed`;
    const options = { cli: { command: 'fake', args: [], env: {}, shell: false }, root: f.root, stateDir: path.join(f.root, 'runs'),
      model: { provider: 'fixture', model: 'fixture' }, task: '{}', images: [], mode,
      onSession: id => f.store.rememberSessions([id]),
      onUsage: () => assert.fail('fixture has no usage'),
      spawnProcess: fakeSpawn([{ type: 'session', sessionId }, { type: 'final', reason: { kind: 'error' }, text: '{}' }]),
    };
    await assert.rejects(runLearningHeadless(options), /未正常完成/);
    const controller = new AbortController();
    await assert.rejects(runLearningHeadless({ ...options, signal: controller.signal,
      onSession: id => { f.store.rememberSessions([id]); controller.abort(); },
      spawnProcess: fakeSpawn([{ type: 'session', sessionId: `${mode}-cancelled` }]),
    }), /取消/);
  }
  assert.deepEqual(createChatLearningStore(f.file).sessionIds(), ['chat-failed', 'chat-cancelled', 'market-failed', 'market-cancelled']);
  const before = f.store.snapshot();
  const broken = createChatLearningStore(f.file, { persist: () => { throw Error('disk full'); } });
  assert.throws(() => broken.rememberSessions(['lost']), /disk full/);
  assert.deepEqual(broken.snapshot(), before);
});

test('manual market packs commit as a group, keep annotations on retry, and remain usable with learning off', async t => {
  const { store, file, assets } = fixture(t);
  const faces = ['a'.repeat(32), 'b'.repeat(32)];
  let fail = true;
  const packs = createMarketPacks({ store, assets, knownIds: async () => ['123'],
    manifest: async id => ({ id, name: '测试包', imgs: faces.map((id, i) => ({ id, name: ['害羞', '睡觉'][i], keywords: [] })) }),
    image: async id => { if (fail && id === faces[1]) throw Error('中断'); return png; },
  });
  const [match] = (await packs.search('测试')).packs;
  assert.equal(match.id, '123');
  assert.equal((await packs.search('https://zb.vip.qq.com/hybrid/emoticonmall/detail?id=123')).packs[0].installed, false);
  await assert.rejects(packs.install('123'), /中断/);
  assert.deepEqual(store.stickers('private:1'), []);
  fail = false;
  await Promise.all([packs.install('123'), packs.install('123')]);
  const [first, second] = store.marketStickers('123');
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await packs.preview('123', faces[0]), png);
  store.edit('stickers', { id: first.id, originalScope: 'global', desc: '不好意思地低头' });
  await packs.install('123');
  assert.equal(createChatLearningStore(file).stickers('group:2')[0].desc, '不好意思地低头');
  store.proposeSticker(first, { desc: '一条待确认建议' });
  packs.remove('123');
  assert.equal(store.snapshot().stickerReviews.length, 0);
  assert.deepEqual(store.stickers('group:2'), []);
});
function learned(batch, meaning = '工作时偷闲') {
  return { slang: [{ content: '摸鱼', meaning, confidence: 0.95, evidenceIds: [batch.messages[0].id] }], stickers: [] };
}

test('native market sends need no chat sample or local image and only fall back before submission', async t => {
  const {store, assets} = fixture(t);
  const faceId = 'b'.repeat(32), packId = '123';
  store.addMarketPack({id: packId, name: '测试包'}, [{faceId, ...assets.put(png), name: '点头', tags: []}]);
  const [sticker] = store.marketStickers(packId);
  const segments = [];
  let response = {stickerFormat: 'marketFace', message_id: '1'};
  const h = await bridgeHarness({config: {qqBackend: 'native'},
    files: {'state/chat-learning.json': {...store.snapshot(), marketAnalysis: {}}},
    onebot: {request(action, params) {
      if (action !== 'send_private_msg') return;
      const [segment] = params.message;
      segments.push(segment.type);
      if (segment.type === 'image') return {data: {message_id: '2'}};
      assert.equal(segment.data.emoji_id, faceId);
      assert.equal(segment.data.emoji_package_id, packId);
      if (response instanceof Error) throw response;
      return {data: response};
    }},
  });
  t.after(() => h.close());
  h.bot.account = '42'; h.bot.health = {connected: true}; h.bot.emit('open');
  const send = () => h.sendStickerV2('private:123', sticker.id);
  assert.equal((await send()).stickerFormat, 'marketFace');
  createLearningAssets(path.join(h.temp, 'state/learned-stickers')).put(png);
  response = {marketResourceMissing: true};
  assert.equal((await send()).stickerFormat, 'image');
  response = Error('QQ 发送回执超时');
  await assert.rejects(send(), /回执超时/);
  assert.deepEqual(segments, ['mface', 'mface', 'image', 'mface']);
});

test('pack analysis retries atomically, retains original wording and manual edits in the shared index', async t => {
  const { store, assets, root } = fixture(t);
  const ids = ['a'.repeat(32), 'b'.repeat(32)];
  let partial = true;
  const packs = createMarketPacks({ store, assets, knownIds: async () => [], image: async () => png,
    manifest: async id => ({ id, name: '光龙', imgs: ids.map((id, index) => ({ id, name: ['害羞', '思考'][index], keywords: ['原标签'] })) }),
    analyze: (items, signal) => analyzeMarketPack(items, { signal, prepare: async () => ({ ok: true, buffer: png, mimeType: 'image/png' }),
      run: async (task, images) => {
        assert.equal(JSON.parse(task).stickers[1].keywords[0], '原标签');
        assert.equal(images.length, 2);
        return { stickers: items.slice(0, partial ? 1 : 2).map((_, i) => ({ id: i + 1, description: '低下头', usage: '回应夸奖', tags: ['腼腆'] })) };
      },
    }),
  });
  await packs.install('123'); await packs.resume();
  assert.equal(store.marketAnalysis('123').status, 'failed');
  const [first] = store.marketStickers('123');
  assert.equal(first.desc, '害羞');
  store.edit('stickers', { id: first.id, originalScope: 'global', desc: '我写的解释', tags: ['我选的标签'] });
  partial = false;
  await packs.queueAnalysis('123'); await packs.resume();
  const [manual, automatic] = store.marketStickers('123');
  assert.equal(store.marketAnalysis('123').status, 'complete');
  assert.equal(manual.desc, '我写的解释');
  assert.equal(automatic.desc, '低下头');
  assert.deepEqual(automatic.tags, ['腼腆']);
  assert.deepEqual(automatic.originalTags, ['原标签']);
  const docs = [];
  const gateway = { status: () => ({ configured: true }), save: async doc => { docs.push(doc); return { storedIds: [doc.externalId] }; },
    search: async () => ({ hits: docs.map(d => ({ memoryId: d.externalId })) }) };
  const catalog = () => store.stickers('private:1');
  const memory = createStickerMemory({ enabled: () => true, getGateway: () => gateway, catalog, file: path.join(root, 'index.json'), log() {} });
  await memory.sync();
  assert.match(docs[1].content, /商城原释义：思考、原标签/);
  assert.match(docs[1].content, /低下头.*回应夸奖/);
  assert.equal((await memory.search('private:1', '表达腼腆', catalog)).stickers[1].id, automatic.id);
});

test('source-scoped learning persists evidence, deduplicates and protects reviewed meanings', t => {
  const f = fixture(t);
  assert.ok(enqueue(f.store)); assert.equal(enqueue(f.store), false);
  enqueue(f.store, 'group:123', '2');
  const batch = f.store.batch(config);
  const cited = learned(batch);
  cited.slang[0].evidenceIds = [batch.messages[0].messageId, batch.messages[0].id];
  f.store.complete(batch, cited, [], config);
  assert.equal(f.store.query('group:123', '摸鱼')[0].meaning, '工作时偷闲');
  assert.deepEqual(f.store.query('group:999', '摸鱼'), []);
  assert.equal(f.store.snapshot().slang[0].evidence[0].text, '今天又开始摸鱼了');
  const entry = f.store.snapshot().slang[0];
  assert.deepEqual(entry.evidence.map(e => e.id), [batch.messages[0].id]);
  f.store.edit('slang', { id: entry.id, status: 'confirmed', meaning: '人工确认的解释' });
  enqueue(f.store, 'group:123', '3');
  const next = f.store.batch(config, Date.now(), true);
  f.store.complete(next, learned(next, '错误的新解释'), [], config);
  assert.equal(f.store.query('group:123')[0].meaning, '人工确认的解释');
  const restored = createChatLearningStore(f.file);
  assert.equal(restored.snapshot().slang[0].count, 2);
  assert.equal(enqueue(restored, 'group:123', '3'), false);
  restored.edit('slang', { id: entry.id, status: 'rejected' });
  enqueue(restored, 'group:123', '4');
  const rejected = restored.batch(config, Date.now(), true);
  restored.complete(rejected, learned(rejected), [], config);
  assert.deepEqual(restored.query('group:123'), []);
  assert.equal(restored.snapshot().slang[0].status, 'rejected');
});

test('invalid evidence aborts the whole transaction without consuming messages', t => {
  const { store } = fixture(t); enqueue(store);
  const batch = store.batch(config, Date.now(), true), before = store.snapshot();
  const result = learned(batch);
  result.slang.push({ content: '胡编', meaning: '造词', evidenceIds: ['group:999:id:1'] });
  assert.throws(() => store.complete(batch, result, [], config), /证据/);
  assert.deepEqual(store.snapshot(), before);
  result.slang.pop(); result.slang[0].content = '没有出现的词';
  result.slang[0].evidenceIds = [batch.messages[0].messageId];
  assert.throws(() => store.complete(batch, result, [], config), /原文/);
  assert.deepEqual(store.snapshot(), before);
});

test('slang evidence and context matching tolerate spacing while preserving original evidence', t => {
  for (const [text, content] of [['又不是 k 头赛', 'k头'], ['又不是 Ｋ\u3000头赛', 'k头'], ['又不是k头赛', 'k 头']]) {
    const { store } = fixture(t);
    enqueue(store, 'group:123', '1', text);
    const batch = store.batch(config, Date.now(), true);
    const result = { slang: [{ content, meaning: '抢走击败目标的最后一击', confidence: 0.9, evidenceIds: [batch.messages[0].id] }], stickers: [] };
    store.complete(batch, result, [], config);
    assert.equal(store.snapshot().slang[0].evidence[0].text, text);
    assert.equal(store.query('group:123', '又不是 K 头赛', { matchText: true }).length, 1);
    assert.equal(store.query('group:999', '又不是 K 头赛', { matchText: true }).length, 0);
  }
});

test('spacing tolerance does not accept paraphrases, templates, punctuation changes or uncited text', t => {
  const { store } = fixture(t);
  enqueue(store, 'group:123', '1', '弟弟也干了，又不是 k-头赛');
  enqueue(store, 'group:123', '2', '全家桶');
  const batch = store.batch(config, Date.now(), true), before = store.snapshot();
  for (const content of ['XXX也干了', '兄弟也干了', 'k头', '全家桶']) {
    const result = { slang: [{ content, meaning: '测试', evidenceIds: [batch.messages[0].id] }], stickers: [] };
    assert.throws(() => store.complete(batch, result, [], config), /原文/);
    assert.deepEqual(store.snapshot(), before);
  }
  assert.throws(() => store.complete(batch, { slang: [{ content: '全家桶', evidenceIds: ['group:999:id:2'] }], stickers: [] }, [], config), /证据/);
  assert.deepEqual(store.snapshot(), before);
});

test('paused native slang batches can recover with sticker learning disabled without reading images', async t => {
  const { store } = fixture(t);
  const slangOnly = { ...config, stickers: false, nativeAccount: '42' };
  store.enqueue('group:123', { nativeAccount: '42', messageId: '1', plain: '又不是 k 头赛', media: [{ kind: 'sticker' }] }, slangOnly);
  const batch = store.batch(slangOnly, Date.now(), true);
  for (let i = 0; i < 3; i++) store.failed('黑话证据校验失败', slangOnly, batch);
  const worker = createChatLearningWorker({ store, getConfig: () => slangOnly,
    hydrateBatch: async batch => { batch.messages[0].text = '又不是 k 头赛'; },
    prepareImages: async () => { assert.fail('sticker learning is disabled'); },
    analyze: async (task, images) => {
      assert.deepEqual(images, []);
      const batch = JSON.parse(task);
      assert.deepEqual(batch.images, []);
      return { slang: [{ content: 'k头', meaning: '抢走击败目标的最后一击', confidence: 0.9, evidenceIds: [batch.messages[0].id] }], stickers: [] };
    },
  });
  assert.equal(await worker.tick(), null, 'automatic retries stay paused');
  assert.equal((await worker.tick(true))?.words, 1);
  assert.equal(store.snapshot().queue.length, 0);
  assert.equal(store.snapshot().lastError, '');
  assert.equal(store.snapshot().stickers.length, 0);
});

test('legacy import remains unassigned; corrupt stores and failed writes preserve bytes and in-memory state', t => {
  const f = fixture(t), legacy = path.join(f.root, 'slang.json');
  const original = JSON.stringify([{ content: '摸鱼', meaning: '旧解释', status: 'confirmed', evidence: [{ text: '旧证据' }] }]);
  fs.writeFileSync(legacy, original);
  const store = createChatLearningStore(f.file, { legacyFile: legacy });
  assert.equal(store.snapshot().slang[0].scope, 'unassigned');
  assert.deepEqual(store.query('group:123'), []);
  assert.equal(fs.readFileSync(legacy, 'utf8'), original);
  assert.equal(fs.existsSync(f.file), false, 'read/import does not write');
  for (const broken of ['null', '{}', '{']) {
    fs.writeFileSync(f.file, broken);
    assert.throws(() => createChatLearningStore(f.file));
    assert.equal(fs.readFileSync(f.file, 'utf8'), broken);
  }
  fs.unlinkSync(f.file);
  const failing = createChatLearningStore(f.file, { persist: () => { throw new Error('disk full'); } });
  assert.throws(() => enqueue(failing), /disk full/);
  assert.equal(failing.snapshot().queue.length, 0);
});

test('threshold, wait, source selection, image budget and durable failure backoff', t => {
  const { store } = fixture(t);
  enqueue(store);
  assert.equal(store.batch(config), null);
  assert.ok(store.batch(config, Date.now() + config.maxWaitMs + 1));
  assert.equal(store.batch({ ...config, sources: ['group:999'] }, Date.now(), true), null);
  enqueue(store, 'group:123', '2', '表情', [{ kind: 'sticker', url: 'https://example.invalid/a' }]);
  enqueue(store, 'group:123', '3', '表情', [{ kind: 'sticker', url: 'https://example.invalid/b' }]);
  const batch = store.batch({ ...config, maxImages: 1 });
  assert.equal(batch.messages.length, 2);
  store.started(config); assert.equal(store.batch(config), null);
  for (let i = 0; i < 3; i++) store.failed('test failure', config, batch);
  const automatic = store.batch(config, Date.now() + 3600000);
  assert.deepEqual(automatic.messages.map(m => m.messageId), ['3']);
  assert.deepEqual(store.batch(config, Date.now(), true).messages.map(m => m.messageId), ['1', '2']);
});

test('worker runs once, retains new arrivals during analysis, and cancellation does not commit', async t => {
  const f = fixture(t); enqueue(f.store); enqueue(f.store, 'group:123', '2');
  let finish, calls = 0;
  const worker = createChatLearningWorker({ store: f.store, getConfig: () => config, prepareImages: async () => [], analyze: async task => {
    calls++; return new Promise(resolve => { finish = () => resolve(learned(JSON.parse(task))); });
  } });
  const first = worker.tick(); assert.equal(worker.tick(), first);
  await new Promise(resolve => setImmediate(resolve));
  enqueue(f.store, 'group:123', '3'); finish(); await first;
  assert.equal(calls, 1); assert.equal(f.store.snapshot().queue.length, 1);
  const second = worker.tick(true); await new Promise(resolve => setImmediate(resolve)); worker.cancel(); finish(); await second;
  assert.equal(f.store.snapshot().queue.length, 1);
  assert.equal(worker.running, false);
  assert.equal(f.store.snapshot().queue[0].attempts || 0, 0, 'operator cancellation does not exhaust retries');
});

test('shrinking image budget leaves remaining media queued and text-only input does not run sticker-only learning', async t => {
  const { store } = fixture(t);
  const media = [1, 2, 3].map(n => ({ kind: 'sticker', url: `https://example.invalid/${n}` }));
  enqueue(store, 'group:123', '1', '表情', media);
  const small = { ...config, maxImages: 1 };
  const batch = store.batch(small, Date.now(), true);
  assert.equal(batch.messages[0].media.length, 1);
  store.complete(batch, { slang: [], stickers: [] }, [], small);
  assert.equal(store.snapshot().queue[0].media.length, 2);
  assert.equal(store.enqueue('group:123', { messageId: '2', text: '纯文本' }, { ...config, slang: false }), false);
});

test('incoming ordinary chat enters only the background queue, with no main-agent model call', async () => {
  const h = await bridgeHarness({ config: { chatLearning: { enabled: true } } });
  try {
    await h.handleIncomingForTest('group', 456, { self_id: 999, user_id: 111, message_id: 88, sender: { nickname: 'fixture' }, message: [{ type: 'text', data: { text: '今天又开始摸鱼了' } }] });
    const state = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/chat-learning.json'), 'utf8'));
    assert.equal(state.queue[0].key, 'group:456');
    assert.equal(state.queue[0].text, '今天又开始摸鱼了');
    assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.sent.length, 0);
  } finally { await h.close(); }
});

test('incoming market and custom stickers are queued, while ordinary photos are excluded', async () => {
  const h = await bridgeHarness({ config: { chatLearning: { enabled: true, slang: false } } });
  try {
    const incoming = (id, segment) => h.handleIncomingForTest('group', 456, {
      self_id: 999, user_id: 111, message_id: id, sender: { nickname: 'fixture' }, message: [segment],
    });
    await incoming(1, { type: 'image', data: { url: 'https://example.invalid/photo.png', sub_type: 0 } });
    await incoming(2, { type: 'image', data: { url: 'https://example.invalid/market.gif', sub_type: 0, emoji_id: 'market-sticker' } });
    await incoming(3, { type: 'image', data: { url: 'https://example.invalid/custom.png', sub_type: 1 } });
    await incoming(4, { type: 'mface', data: { url: 'https://example.invalid/mface.gif', emoji_id: 'mface-sticker' } });
    const state = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/chat-learning.json'), 'utf8'));
    assert.deepEqual(state.queue.map(message => message.messageId), ['2', '3', '4']);
    assert.equal(state.queue[0].media[0].emojiId, 'market-sticker');
    assert.equal(state.queue[0].media[0].subType, '0');
    assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.sent.length, 0);
  } finally { await h.close(); }
});

test('local sticker content deduplication, tag search and explicit scope management', t => {
  const f = fixture(t), asset = f.assets.put(png);
  assert.deepEqual(f.assets.put(png), asset); assert.deepEqual(f.assets.read(asset.hash), png);
  assert.throws(() => f.assets.read('../secret'), /无效/);
  enqueue(f.store);
  const batch = f.store.batch(config, Date.now(), true), evidence = { key: batch.key, messageId: '1' };
  f.store.complete(batch, { slang: [], stickers: [{ id: asset.id, isSticker: true, description: '开心的小猫', tags: ['开心'], usage: '表示赞同' }] }, [{ ...asset, evidence }], config);
  assert.equal(f.store.stickers('group:123').length, 1); assert.equal(f.store.stickers('private:123').length, 0);
  f.store.edit('stickers', { id: asset.id, originalScope: 'group:123', scope: 'global', status: 'confirmed' });
  assert.equal(f.store.stickers('private:123')[0].scope, 'global');
  f.store.used(asset.id, 'global'); assert.equal(f.store.stickers('private:123')[0].usedCount, 1);
  fs.writeFileSync(path.join(f.root, 'assets', asset.hash + '.bin'), 'tampered');
  assert.throws(() => f.assets.read(asset.hash), /校验失败/);
});

test('sticker memory resolves semantic hits to current scoped ids and recovers an interrupted ingest', async t => {
  const f = fixture(t), file = path.join(f.root, 'index.json');
  let entries = [
    { id: 'a', scope: 'group:1', source: 'learned', desc: '猫捂脸', tags: ['尴尬'] },
    { id: 'b', scope: 'group:2', source: 'learned', desc: '猫捂脸', tags: ['尴尬'] },
    { id: 'c', source: 'qq', desc: '摆手' },
  ];
  const records = new Map();
  let interrupt = true, offline = false;
  const gateway = {
    status: () => ({ configured: true }),
    async save({ externalId, metadata }) {
      const existed = records.has(externalId);
      records.set(externalId, { memoryId: externalId, sticker: metadata.stickerId });
      if (interrupt) { interrupt = false; throw new Error('connection closed after ingest'); }
      return { storedIds: existed ? [] : [externalId] };
    },
    async read({ externalId, memoryId }) { return records.get(externalId || memoryId); },
    async remove({ memoryId }) { records.delete(memoryId); return { deletedCount: 1 }; },
    async search({ stickerScope }) {
      if (offline) throw new Error('unavailable');
      if (stickerScope) {
        assert.equal(stickerScope, 'group:1');
        return { hits: [] };
      }
      return { hits: [...records.values()].reverse() };
    },
  };
  const open = () => createStickerMemory({ file, getGateway: () => gateway, enabled: () => true, log() {}, catalog: () => entries });
  const visible = () => entries.filter(e => !e.scope || e.scope === 'global' || e.scope === 'group:1');
  await assert.rejects(open().sync(), /connection closed/);
  const index = open();
  await index.sync();
  assert.equal(records.size, 3);
  const search = () => index.search('group:1', '想缓和气氛', visible);
  const query = async () => (await search()).stickers.map(e => e.id);
  assert.deepEqual(await query(), ['c', 'a']);
  assert.deepEqual((await search()).stickers[0], { id: 'c', desc: '摆手' });
  entries[0].desc = '小猫跳舞';
  assert.deepEqual(await query(), ['c']);
  entries.splice(2, 1);
  assert.deepEqual(await query(), []);
  await index.sync();
  assert.equal(records.size, 2);
  assert.deepEqual(await query(), ['a']);
  entries.push(...Array.from({ length: 7 }, (_, i) => ({ id: 'x' + i, desc: '测试' + i, source: 'qq' })));
  await index.sync();
  assert.equal((await search()).stickers.length, 5);
  offline = true;
  await assert.rejects(index.search('group:1', '跳舞', visible), /unavailable/);
  await assert.rejects(index.search('group:1', '  ', visible), /query/);
});

test('QQ favorite suggestions remain separate until approval and never alter the synced remark', t => {
  const { store } = fixture(t);
  const favorites = [{ id: 'qq-a', desc: '', source: 'qq' }];
  const propose = () => store.proposeSticker(store.favorites(favorites)[0], { tags: ['无奈'], desc: '猫摊手' });
  propose();
  const first = store.snapshot().stickerReviews[0].id;
  assert.equal(store.favorites(favorites)[0].desc, '');
  store.decideStickerReview(first, false, favorites);
  propose();
  const second = store.snapshot().stickerReviews[0].id;
  assert.throws(() => store.decideStickerReview(second, true, [{ ...favorites[0], desc: '新备注' }]), /变化/);
  store.decideStickerReview(second, true, store.favorites(favorites));
  assert.deepEqual(store.favorites(favorites)[0].tags, ['无奈']);
  assert.equal(favorites[0].desc, '');
});
test('learning tool guard blocks everything except the prepared image tool', () => {
  let check;
  guard({ tools: { guard: fn => { check = fn; } } });
  for (const name of ['pwsh', 'plugin_manager', 'mcp__qq__qq_send_message', 'mcp__qq-memory__memory_save', '', 'unknown_future_tool']) assert.ok(check({ name }));
  assert.equal(check({ name: 'mcp__qq-learning-images__learning_images' }), undefined);
  const patch = yaml.load(learningPatch({ model: { provider: 'test', model: 'test' } }));
  for (const id of ['tool-plugin-manager', 'tool-agent-team', 'mcp-resources', 'mcp-manager', 'mcp-qq', 'mcp-qq-memory', 'mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
    assert.ok(patch.some(p => p.id === id && p.disabled), id + ' must remain disabled');
  }
  assert.ok(patch.some(p => p.insert?.some(i => i.id === 'qq-learning-tool-guard')));
});

function fakeSpawn(events) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let closed = false;
    child.kill = () => { if (!closed) { closed = true; child.emit('close', 1); } };
    child.stdin.on('finish', () => setImmediate(() => {
      for (const event of events) {
        if (closed) return;
        const bytes = Buffer.from(JSON.stringify(event) + '\n');
        for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
      }
      closed = true; child.emit('close', 0);
    }));
    return child;
  };
}
test('headless uses the requested session and rejects an unexpected identity before registration', async t => {
  const f = fixture(t);
  const events = [{ type: 'session', sessionId: 'reserved' },
    { type: 'final', reason: { kind: 'completed' }, text: '{"slang":[],"stickers":[]}' }];
  const registered = [];
  const run = () => runLearningHeadless({
    cli: { command: 'fixture', args: [], shell: false }, root: f.root, stateDir: f.root,
    model: { provider: 'test', model: 'test' }, task: '{}', images: [], requestedSessionId: 'reserved',
    onSession: id => registered.push(id),
    spawnProcess: (command, args, options) => {
      assert.deepEqual(args.slice(-4), ['--json', '--session-id', 'reserved', '-']);
      return fakeSpawn(events)(command, args, options);
    },
  });
  assert.equal((await run()).sessionId, 'reserved');
  events[0].sessionId = 'other';
  await assert.rejects(run(), /不同或无效/);
  assert.deepEqual(registered, ['reserved']);
});

test('headless parser rejects incomplete runs and unseen images, preserves UTF-8 and removes temporary files', async t => {
  const f = fixture(t), events = [{ type: 'session', sessionId: 'test-session' }, { type: 'final', reason: { kind: 'completed' }, text: JSON.stringify({ slang: [{ content: '摸鱼' }], stickers: [] }) }];
  const options = { cli: { command: 'fake', args: [], env: {}, shell: false }, root: f.root, stateDir: f.root, model: { provider: 'fixture', model: 'fixture' }, task: '{}', images: [] };
  assert.equal((await runLearningHeadless({ ...options, spawnProcess: fakeSpawn(events) })).slang[0].content, '摸鱼');
  assert.deepEqual(fs.readdirSync(f.root), []);
  events[1].reason = { kind: 'error' };
  await assert.rejects(runLearningHeadless({ ...options, spawnProcess: fakeSpawn(events) }), /未正常完成/);
  events[1].reason = { kind: 'completed' }; events[1].text = '{"slang":[],"stickers":[{"id":"fake"}]}';
  await assert.rejects(runLearningHeadless({ ...options, spawnProcess: fakeSpawn(events) }), /未成功看图/);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('HTTP management isolation, source query and safe local sticker send use the actual bridge', async () => {
  let sentBody;
  const h = await bridgeHarness({ config: { chatLearning: { enabled: false } }, globals: {
    fetch: async (_url, init) => { sentBody = JSON.parse(init.body); return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }; },
  } });
  let server;
  try {
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, body, extra = {}) => {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await call('/api/slang', { content: '摸鱼', meaning: '偷闲', scope: 'group:456', status: 'confirmed' })).status, 200);
    assert.equal((await call('/api/learning/settings', { sources: ['typo'] })).status, 400);
    const sessionId = await h.ensureDesktopAgentSession();
    const token = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/desktop-agent.json'), 'utf8')).agentToken;
    const headers = { 'x-agent-token': token, 'x-agent-session-id': sessionId };
    for (const route of ['/api/slang', '/api/learning/status', '/api/learning/stickers']) assert.equal((await call(route, undefined, headers)).status, 403);
    assert.equal((await call('/api/learning/settings', { enabled: true }, headers)).status, 403);
    assert.equal((await call('/api/socialV2/slang-query?key=group:456&query=摸鱼', undefined, headers)).body.entries.length, 1);
    assert.equal((await call('/api/socialV2/slang-query?key=group:999&query=摸鱼', undefined, headers)).body.entries.length, 0);
    assert.equal((await call('/api/socialV2/slang-query?key=group:456', undefined, { ...headers, 'x-agent-session-id': 'wrong' })).status, 403);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
  // Start another real bridge fixture with a durable learned image.
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-learning-test-'));
  try {
    const assets = createLearningAssets(path.join(storeRoot, 'assets')), asset = assets.put(png);
    const store = createChatLearningStore(path.join(storeRoot, 'learning.json'));
    enqueue(store, 'group:456'); const batch = store.batch(config, Date.now(), true);
    store.complete(batch, { slang: [], stickers: [{ id: asset.id, isSticker: true, description: '测试表情', tags: ['开心'] }] }, [{ ...asset, evidence: { key: batch.key } }], config);
    const faceId = 'a'.repeat(32), marketId = 'market:123:' + faceId;
    store.addMarketPack({ id: '123', name: '商城示例' }, [{ faceId, hash: asset.hash, name: '开心', desc: '开心', tags: [] }]);
    const hh = await bridgeHarness({ files: { 'state/chat-learning.json': store.snapshot() }, globals: {
      fetch: async (_url, init) => { sentBody = JSON.parse(init.body); return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 2 } }) }; },
    } });
    try {
      createLearningAssets(path.join(hh.temp, 'state/learned-stickers')).put(png);
      await hh.ensureDesktopAgentSession();
      const consoleServer = hh.startConsoleServer();
      if (!consoleServer.listening) await new Promise(resolve => consoleServer.once('listening', resolve));
      try {
        const state = JSON.parse(fs.readFileSync(path.join(hh.temp, 'state/desktop-agent.json'), 'utf8'));
        const agent = { 'x-agent-token': state.agentToken, 'x-agent-session-id': state.sessionId };
        const request = async (route, body, headers = {}) => {
          const response = await fetch('http://127.0.0.1:' + consoleServer.address().port + route, {
            method: body ? 'POST' : 'GET', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', ...headers },
            body: body && JSON.stringify(body),
          });
          return { status: response.status, data: await response.json() };
        };
        const route = '/api/socialV2/sticker-suggest', admin = '/api/learning/sticker-reviews';
        assert.equal((await request('/api/learning/stickers')).data.total, 1);
        assert.equal((await request('/api/learning/market-packs')).data.packs[0].count, 1);
        assert.equal((await request('/api/learning/market-packs/remove', { id: '123' }, agent)).status, 403);
        assert.equal((await request('/api/socialV2/sticker-image?' + new URLSearchParams({ key: 'group:456', stickerId: marketId }), undefined, agent)).status, 200);
        const suggestion = { key: 'group:456', stickerId: asset.id, desc: '笑到捂脸', tags: ['偷笑'] };
        assert.equal((await request(route, suggestion, agent)).status, 400);
        assert.equal((await request('/api/socialV2/sticker-image?' + new URLSearchParams({ key: suggestion.key, stickerId: asset.id }), undefined, agent)).status, 200);
        assert.equal((await request(route, suggestion, agent)).status, 200);
        assert.equal((await request(admin, undefined, agent)).status, 403);
        const review = (await request(admin)).data.reviews[0];
        assert.equal((await request(admin, { id: review.id, accept: true }, agent)).status, 403);
        assert.equal((await request(admin, { id: review.id, accept: true })).status, 200);
        const updated = JSON.parse(fs.readFileSync(path.join(hh.temp, 'state/chat-learning.json'), 'utf8')).stickers.find(item => item.id === asset.id);
        assert.equal(updated.desc, suggestion.desc);
        assert.deepEqual(updated.tags, suggestion.tags);
        const search = await request('/api/socialV2/sticker-list', { key: suggestion.key, query: '偷笑' }, agent);
        assert.equal(search.status, 503);
        assert.match(search.data.error, /表情记忆索引/);
        const configure = sticker => request('/api/socialV2/config', { sticker });
        for (const [active, inactive] of [[marketId, asset.id], [asset.id, marketId]]) {
          const key = suggestion.key;
          await configure({ regularEnabled: active === asset.id, marketEnabled: active === marketId, syncEnabled: false });
          assert.deepEqual(Array.from(await hh.visibleStickers(key), e => e.id), [active]);
          const image = id => request('/api/socialV2/sticker-image?' + new URLSearchParams({ key, stickerId: id }), undefined, agent);
          assert.equal((await image(inactive)).status, 403);
          assert.equal((await image(active)).status, 200);
          assert.equal((await request(route, { ...suggestion, stickerId: inactive }, agent)).status, 403);
          assert.equal((await request('/api/socialV2/send-sticker', { key, stickerId: inactive }, agent)).status, 403);
          const receipt = await request('/api/socialV2/send-sticker', { key, stickerId: active }, agent);
          assert.equal(receipt.status, 200);
          assert.equal(receipt.data.sticker.id, active);
          assert.equal(receipt.data.messageId, 2);
        }
        await configure({ marketEnabled: true });
      } finally { await new Promise(resolve => consoleServer.close(resolve)); }
      const sent = await hh.sendStickerV2('group:456', asset.id);
      assert.equal(sent.messageId, 2);
      assert.equal(sentBody.message[0].data.file, 'base64://' + png.toString('base64'));
      assert.equal((await hh.sendStickerV2('group:999', marketId)).entry.source, 'market');
      assert.equal(sentBody.message[0].type, 'image');
      await assert.rejects(hh.sendStickerV2('group:999', asset.id), /不属于当前来源/);
    } finally { await hh.close(); }
  } finally {
    assert.equal(path.dirname(path.resolve(storeRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(storeRoot).startsWith('qq-learning-test-'));
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});
