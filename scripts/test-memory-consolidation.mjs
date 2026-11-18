import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAMemorixGateway } from '../src/a-memorix-gateway.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function fixture(respond) {
  const calls = [];
  const gateway = createAMemorixGateway({ enabled: true, namespace: 'fixture', apiKey: 'fixture' }, {
    fetchImpl: async (url, init) => {
      const op = new URL(url).pathname.split(':').pop();
      const body = JSON.parse(init.body);
      calls.push({ op, body });
      return await respond(op, body);
    }
  });
  return { gateway, calls, ops: () => calls.map(call => call.op) };
}

test('search folds all supersedes formats before limiting and summarizes only visible hits', async () => {
  const hit = (memoryId, content, supersedes, origin = 'assistant') => ({ memoryId, content, metadata: { supersedes, origin } });
  const hits = [
    hit('a', 'obsolete'), hit('b', 'old'), hit('c', 'old'), hit('d', 'old'),
    hit('qq', 'new fact', undefined, 'qq'), hit('e', ' new\n fact ', 'a'),
    hit('f', 'new  fact', ['b', 'c', 'b']), hit('g', 'other', 'd,  ,d'), hit('h', 'extra')
  ];
  const { gateway, calls } = fixture((_op, { limit }) => Response.json({ summary: 'obsolete', hits: hits.slice(0, limit) }));
  const result = await gateway.search({ limit: 2, origin: 'assistant' });
  assert.deepEqual(result.hits.map(h => h.memoryId), ['e', 'g']);
  assert.ok(calls[0].body.limit > 2 && calls[0].body.limit <= 50);
  assert.equal(result.summary, '1. new fact\n2. other');
  const all = await gateway.search({ limit: 3 });
  assert.deepEqual(all.hits.map(h => h.memoryId), ['qq', 'g', 'h']);
});

const old = (memoryId, sourceContext, extra = {}) => ({
  memoryId, sourceType: 'qq', metadata: { sourceContext, ...extra }
});
const first = old('a', 'group:123 甲', { tags: ['topic'], participants: ['甲'], evidenceReferences: ['msg-a'], supersedes: 'older' });
const second = old('b', 'group:123 乙', { tags: ['topic', 'new'], participants: ['乙'], evidenceReferences: ['msg-a', 'msg-b'] });

function replacementFixture({ records = [first, second], ingest = { storedIds: ['new'] }, remove } = {}) {
  return fixture((op, body) => {
    if (op === 'get') {
      const memory = records.find(record => record.memoryId === body.memoryId);
      return memory ? Response.json({ memory }) : Response.json({ code: 'not_found', message: 'memory not found' }, { status: 404 });
    }
    if (op === 'ingest') return Response.json(ingest);
    assert.equal(op, 'delete');
    return remove ? remove(body.memoryId) : Response.json({ deletedCount: 1, deletedMemoryIds: [body.memoryId] });
  });
}

test('merge reads every unique target before ingest, preserves evidence and attribution, then deletes in order', async () => {
  const { gateway, calls, ops } = replacementFixture();
  const result = await gateway.replace({ memoryIds: ['a', ' b ', 'a'], content: '甲、乙的同题记录',
    externalId: 'batch-item', metadata: { sourceContext: 'group:123 本次核实', evidenceReferences: ['msg-b', 'msg-c'] }, reason: 'merged' });
  assert.deepEqual(ops(), ['get', 'get', 'ingest', 'delete', 'delete']);
  const body = calls[2].body;
  assert.equal(body.externalId, 'batch-item');
  assert.equal(body.sourceType, 'qq');
  assert.deepEqual(body.tags, ['topic', 'new']);
  assert.deepEqual(body.participants, ['甲', '乙']);
  assert.deepEqual(body.metadata.evidenceReferences, ['msg-a', 'msg-b', 'msg-c']);
  assert.deepEqual(body.metadata.supersedes, ['a', 'b']);
  assert.deepEqual(body.metadata.supersededIds, ['older']);
  assert.equal(body.metadata.sourceContext, 'group:123 甲\ngroup:123 乙\ngroup:123 本次核实');
  assert.deepEqual(calls.slice(3).map(({ body }) => [body.memoryId, body.reason]), [['a', 'merged'], ['b', 'merged']]);
  assert.deepEqual(result, { memoryId: 'new', replacedIds: ['a', 'b'], retainedIds: [], oldMemoryRetained: false, warning: '' });
  const { gateway: lookup } = fixture(() => Response.json({ hits: [
    { memoryId: 'older', content: 'obsolete' }, { memoryId: 'new', content: 'current', metadata: body.metadata }
  ] }));
  assert.deepEqual((await lookup.search()).hits.map(h => h.memoryId), ['new']);
});

test('unverified targets, ambiguous QQ provenance and missing ingest receipts preserve all old records', async () => {
  const { gateway, ops } = replacementFixture();
  for (const memoryIds of [[], ['a', 'PLACEHOLDER'], ['see summary'], [17], [' '], Array.from({ length: 11 }, (_, i) => String(i))]) {
    await assert.rejects(gateway.replace({ memoryIds, content: 'fixture' }), /memoryId/);
  }
  assert.deepEqual(ops(), []);
  await assert.rejects(gateway.replace({ memoryIds: ['a', 'missing'], content: 'fixture' }), /未找到要合并\/替换的旧记忆：missing/);
  assert.deepEqual(ops(), ['get', 'get']);
  for (const context of ['group:456', 'private:123', '', 'group:123、private:123']) {
    const f = replacementFixture({ records: [first, old('b', context)] });
    await assert.rejects(f.gateway.replace({ memoryIds: ['a', 'b'], origin: 'assistant', metadata: { sourceContext: 'group:123' }, content: 'fixture' }), /相同来源/);
    assert.deepEqual(f.ops(), ['get', 'get']);
  }
  const cross = replacementFixture();
  await assert.rejects(cross.gateway.replace({ memoryIds: ['a', 'b'], content: 'fixture', metadata: { sourceContext: 'private:123' } }), /相同来源/);
  assert.deepEqual(cross.ops(), ['get', 'get']);
  for (const ingest of [{ storedIds: [], skippedIds: ['skipped'] }, { storedIds: [null] }, { storedIds: [' '] }, { ok: false }]) {
    const f = replacementFixture({ ingest });
    await assert.rejects(f.gateway.replace({ memoryIds: ['a', 'b'], content: 'fixture' }));
    assert.deepEqual(f.ops(), ['get', 'get', 'ingest']);
  }
});

test('assistant research fragments preserve source notes and cap merged lists at 20 unique entries', async () => {
  const notes = [0, 10].map(start => {
    const items = Array.from({ length: 16 }, (_, i) => String(start + i));
    return { memoryId: 'note-' + start, metadata: {
      origin: 'assistant', sourceContext: '研究笔记 ' + start, tags: items, participants: items, evidenceReferences: items
    } };
  });
  const f = replacementFixture({ records: notes });
  await f.gateway.replace({ memoryIds: notes.map(note => note.memoryId), content: '两次研究的结论' });
  const body = f.calls[2].body;
  assert.equal(body.sourceType, 'assistant');
  assert.equal(body.metadata.sourceContext, '研究笔记 0\n研究笔记 10');
  const expected = Array.from({ length: 20 }, (_, i) => String(i));
  for (const field of ['tags', 'participants', 'evidenceReferences']) assert.deepEqual(body.metadata[field], expected);
});

test('delete failures identify retained targets and never delete the replacement itself', async () => {
  const f = replacementFixture({ records: [first, second, old('c', 'group:123')], ingest: { storedIds: ['a'] },
    remove: id => id === 'b' ? Response.json({}, { status: 503 }) : Response.json({ deletedCount: 1 }) });
  const result = await f.gateway.replace({ memoryIds: ['a', 'b', 'c'], content: 'fixture' });
  assert.deepEqual(f.calls.filter(c => c.op === 'delete').map(c => c.body.memoryId), ['b', 'c']);
  assert.deepEqual(result.replacedIds, ['c']);
  assert.deepEqual(result.retainedIds, ['b']);
  assert.ok(result.oldMemoryRetained);
  assert.match(result.warning, /b.*503/);
  const single = replacementFixture({ remove: () => Response.json({ deletedCount: 0 }) });
  const updated = await single.gateway.replace({ memoryId: 'a', content: 'fixture', participants: [], tags: ['edited'], origin: 'assistant' });
  assert.deepEqual(updated.retainedIds, ['a']);
  const body = single.calls[1].body;
  assert.equal(body.metadata.supersedes, 'a');
  assert.deepEqual(body.participants, []);
  assert.deepEqual(body.tags, ['edited']);
  assert.equal(body.sourceType, 'assistant');
});

test('overlapping replacements cannot create two successors of the same target', async () => {
  const f = replacementFixture();
  const firstWrite = f.gateway.replace({ memoryIds: ['a', 'b'], content: 'first' });
  await assert.rejects(f.gateway.replace({ memoryId: 'b', content: 'second' }), /正在被替换/);
  await firstWrite;
  assert.deepEqual(f.ops(), ['get', 'get', 'ingest', 'delete', 'delete']);
});

test('stdio memory_replace validates inputs and forwards single and multi-ID writes through the authenticated routes', async t => {
  const f = replacementFixture();
  const h = await bridgeHarness({ globals: { createAMemorixGateway: () => f.gateway } });
  const server = h.startConsoleServer();
  const client = new Client({ name: 'consolidation-fixture', version: '1' });
  t.after(async () => {
    await client.close();
    await new Promise(resolve => server.close(resolve));
    await h.close();
  });
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  h.setReady(true);
  await h.ensureDesktopAgentSession();
  const port = server.address().port;
  const consoleToken = 'fixture-console-token';
  fs.writeFileSync(path.join(h.temp, 'config.json'), JSON.stringify({ consolePort: port, consoleToken }));
  const source = fs.readFileSync(new URL('../src/mcp-memory-safe.js', import.meta.url), 'utf8')
    .replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');", `const ROOT = ${JSON.stringify(h.temp)};`);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '--eval', source],
    cwd: fileURLToPath(new URL('..', import.meta.url)), stderr: 'pipe' }));
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'memory_replace'));
  const replace = args => client.callTool({ name: 'memory_replace', arguments: { content: 'fixture', ...args } });
  for (const invalid of [{}, { memoryIds: [] }, { memoryIds: Array(11).fill('a') }, { memoryIds: ' ' },
    { memoryIds: 'a', content: '' }, { memoryIds: 'a', origin: 'group' }]) {
    assert.equal((await replace(invalid)).isError, true);
  }
  assert.deepEqual(f.ops(), []);
  const headers = { 'content-type': 'application/json', 'x-console-token': consoleToken };
  const post = (route, body) => fetch(`http://127.0.0.1:${port}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('desktop-agent/memory/replace', { memoryId: 'a', content: 'fixture' })).status, 403);
  for (const memoryIds of ['a', ['a', 'b']]) {
    const result = await replace({ memoryIds, externalId: 'fixture-id', evidenceReferences: ['msg-c'], confidence: 'reported' });
    assert.deepEqual(JSON.parse(result.content[0].text).replacedIds, [memoryIds].flat());
    const body = f.calls.findLast(c => c.op === 'ingest').body;
    assert.equal(body.externalId, 'fixture-id');
    assert.equal(body.sourceType, 'qq');
    assert.equal(body.metadata.confidence, 'reported');
    assert.ok(body.metadata.evidenceReferences.includes('msg-c'));
  }
  const response = await post('memory/replace', { memoryIds: ['a', 'b'], content: 'console edit' });
  assert.deepEqual((await response.json()).result.replacedIds, ['a', 'b']);
});
