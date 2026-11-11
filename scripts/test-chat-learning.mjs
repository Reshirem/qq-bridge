import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import yaml from 'js-yaml';
import { createChatLearningStore, createChatLearningWorker, normalizeLearningConfig } from '../src/chat-learning.js';
import { createStickerMemory } from '../src/sticker-memory.js';
import { createLearningAssets } from '../src/learning-assets.js';
import { createMarketPacks } from '../src/market-packs.js';
import { analyzeMarketPack } from '../src/market-analysis.js';
import { learningPatch, runLearningHeadless } from '../src/learning-runner.js';
import { apply as guard } from '../src/learning-tool-guard.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

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
  assert.ok(patch.some(p => p.id === 'tool-plugin-manager' && p.disabled));
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
          assert.equal((await hh.sendStickerV2(key, active)).entry.id, active);
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
