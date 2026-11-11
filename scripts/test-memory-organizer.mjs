// Isolated regression fixtures: no production memories, model calls or QQ peers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAMemorixGateway } from '../src/a-memorix-gateway.js';
import { createMemoryOrganizerState, organizerTranscriptRecords } from '../src/memory-organizer.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const model = { provider: 'fixture', model: 'fixture' };
const missing = { code: 'not_found', message: 'memory not found' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-regression-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('qq-memory-regression-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('only a confirmed missing-memory response becomes null; infrastructure and write errors stay failures', async () => {
  let status = 404, payload = missing;
  const requests = [];
  const gateway = createAMemorixGateway({ enabled: true, namespace: 'fixture', apiKey: 'fixture-only' }, {
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return { ok: status >= 200 && status < 300, status, json: async () => payload };
    },
  });
  assert.equal(await gateway.read({ memoryId: 'PLACEHOLDER' }), null);
  assert.equal(await gateway.read({ externalId: 'fixture:missing' }), null);
  const before = requests.length;
  await assert.rejects(gateway.replace({ memoryId: 'missing', content: 'replacement' }), /未找到要替换/);
  assert.equal(requests.length, before + 1, 'no write is attempted after a missing replacement target');
  await assert.rejects(gateway.remove({ memoryId: 'missing' }), /HTTP 404/);
  await assert.rejects(gateway.save({ content: 'fixture' }), /HTTP 404/);
  for (const next of [
    [404, { code: 'namespace_not_found', message: 'namespace not found' }],
    [404, { message: 'route not found' }],
    [401, { message: 'authentication failed' }],
    [503, { message: 'service unavailable' }],
  ]) {
    [status, payload] = next;
    await assert.rejects(gateway.read({ memoryId: 'fixture' }), new RegExp(`HTTP ${status}`));
  }
  status = 200; payload = { memory: { memoryId: 'real-id', content: 'fixture content' } };
  assert.equal((await gateway.read({ memoryId: 'real-id' })).content, 'fixture content');
});

test('memory MCP returns an explicit not-found result and preserves actual read failures', async t => {
  const directory = fixture(t);
  let result = null, failure = false;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/api/desktop-agent/memory/read');
    assert.equal(req.headers['x-agent-token'], 'a'.repeat(64));
    for await (const chunk of req) { /* drain the synthetic request */ }
    res.writeHead(failure ? 502 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failure ? { ok: false, error: 'fixture Gateway HTTP 503' } : { ok: true, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.join(directory, 'state'));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ consolePort: server.address().port, consoleToken: 'fixture-console-token' }));
  fs.writeFileSync(path.join(directory, 'state/desktop-agent.json'), JSON.stringify({ agentToken: 'a'.repeat(64) }));
  const source = fs.readFileSync(path.join(root, 'src/mcp-memory-safe.js'), 'utf8')
    .replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');", `const ROOT = ${JSON.stringify(directory)};`);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '--eval', source], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'memory-regression-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    const miss = await client.callTool({ name: 'memory_read', arguments: { memoryId: 'see summary' } });
    assert.equal(miss.isError, undefined);
    assert.equal(JSON.parse(miss.content[0].text).found, false);
    result = { memoryId: 'real-id', content: 'fixture content' };
    const found = await client.callTool({ name: 'memory_read', arguments: { memoryId: 'real-id' } });
    assert.deepEqual(JSON.parse(found.content[0].text), result, 'successful record shape stays compatible');
    failure = true;
    const failed = await client.callTool({ name: 'memory_read', arguments: { memoryId: 'real-id' } });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /HTTP 503/);
  } finally {
    await client.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

function spawnFixture(events) {
  return (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let closed = false;
    child.kill = () => { if (!closed) { closed = true; child.emit('close', 1); } };
    if (args.includes('--help')) {
      setImmediate(() => { child.stdout.write('--approval-policy'); child.emit('close', 0); });
    } else child.stdin.on('finish', () => setImmediate(() => {
      for (const event of events) {
        if (closed) return;
        // Exercise Unicode characters crossing actual pipe data boundaries.
        for (const byte of Buffer.from(JSON.stringify(event) + '\n')) child.stdout.write(Buffer.from([byte]));
      }
      closed = true; child.emit('close', 0);
    }));
    return child;
  };
}

function cliEvents({ failure = false, reason = 'completed', finalReason, write = false } = {}) {
  const tool = `mcp__qq-memory-organizer__memory_${write ? 'save' : 'read'}`;
  return [
    { type: 'session', sessionId: 'fixture-session' },
    { type: 'status', phase: 'turn_start' },
    { type: 'tool_call', callId: 'fixture-call', tool },
    { type: 'tool_result', callId: 'fixture-call', status: failure ? 'failed' : 'completed',
      result: failure ? '长期记忆操作失败：网关不可用（HTTP 503）' : JSON.stringify(write ? { storedIds: ['real-id'], skippedIds: [] } : { found: false, memoryId: 'missing' }) },
    { type: 'status', phase: 'turn_end', reason: { kind: reason } },
    { type: 'final', text: `MEMORY_ORGANIZER_DONE${write ? '' : ' MEMORY_ORGANIZER_NO_CHANGE'}`, ...(finalReason === undefined ? {} : { reason: finalReason }) },
  ];
}

test('headless accepts normal lookup misses, requires completed turns, and reports Unicode tool errors', async () => {
  const events = cliEvents();
  const h = await bridgeHarness({ globals: { spawn: spawnFixture(events) } });
  const run = () => h.runMemoryOrganizerHeadless({}, 'fixture-only', model, 'fixture-session');
  try {
    assert.equal((await run()).noChange, true);
    events.splice(0, events.length, ...cliEvents({ failure: true }));
    await assert.rejects(run(), /memory_read 返回失败：长期记忆操作失败：网关不可用（HTTP 503）/);
    events.splice(0, events.length, ...cliEvents({ write: true }));
    assert.equal((await run()).newMemories, 1);
    events.splice(0, events.length, ...cliEvents({ write: true, failure: true }));
    await assert.rejects(run(), /memory_save 返回失败/);
    for (const scenario of [{ reason: 'interrupted' }, { finalReason: null }]) {
      events.splice(0, events.length, ...cliEvents(scenario));
      await assert.rejects(run(), /未正常完成/);
    }
    assert.equal(fs.readdirSync(path.join(h.temp, 'state')).some(name => name.endsWith('.patch.yml')), false);
    const patch = yaml.load(h.memoryOrganizerPatchText(model));
    assert.ok(patch.some(operation => operation.id === 'session-title-llm' && operation.disabled));
  } finally { await h.close(); }
});

test('restart receipts keep completed chunks with a normal missing lookup, but reject failed or interrupted work', async () => {
  const h = await bridgeHarness();
  const records = [];
  function turn(chunk, { failed = false, reason = 'completed' } = {}) {
    const push = (type, data) => records.push({ seq: records.length, type, data });
    push('turn/start', { turn: chunk });
    push('user/message', { content: `整理任务 fixture-job，当前是第 ${chunk}/3 段` });
    push('tool/call', { callId: `read-${chunk}`, name: 'mcp__qq-memory-organizer__memory_read', arguments: '{"memoryId":"missing"}' });
    push('tool/result', { message: { source: { callId: `read-${chunk}` }, isError: failed, content: [{ type: 'text', text: failed ? 'HTTP 503' : '{"found":false}' }] } });
    push('assistant/message', { content: 'MEMORY_ORGANIZER_DONE MEMORY_ORGANIZER_NO_CHANGE' });
    push('turn/end', { turn: chunk, reason: { kind: reason } });
  }
  turn(1); turn(2, { failed: true }); turn(3, { reason: 'interrupted' });
  h.api.callUnary = async method => ({ result: { ok: true, value: method === 'session/projections' ? { asOfSeq: records.length - 1 } : { records, hasMore: false } } });
  try {
    const recovered = await h.readMemoryOrganizerCompletedChunks(['fixture-session'], 'fixture-job', 3);
    assert.deepEqual([...recovered.receipts.keys()], [1]);
  } finally { await h.close(); }
});

test('live and replayed writes clear a save error only for a confirmed retry of the same item', async () => {
  const events = [];
  const h = await bridgeHarness({ globals: { spawn: spawnFixture(events) } });
  const job = { jobId: 'fixture' };
  const first = 'qq-bridge:organizer:fixture:chunk-1:item-1';
  try {
    for (const [retryId, storedIds, skippedIds, recovered] of [
      [first, ['saved'], [], true], [first, [], ['already-saved'], true],
      [first, [], [], false], [first + '0', ['other'], [], false]
    ]) {
      const records = [];
      const push = (type, data) => records.push({ seq: records.length, type, data });
      events.splice(0, events.length, ...cliEvents({ write: true }).slice(0, 2));
      push('turn/start', { turn: 1 });
      push('user/message', { content: '整理任务 fixture，当前是第 1/1 段' });
      for (const [callId, externalId, error] of [['bad', first, true], ['retry', retryId, false]]) {
        const result = error ? 'observedAt 无效' : JSON.stringify({ storedIds, skippedIds });
        events.push({ type: 'tool_call', callId, tool: 'memory_save', input: { externalId } },
          { type: 'tool_result', callId, status: error ? 'failed' : 'completed', result });
        push('tool/call', { callId, name: 'memory_save', arguments: JSON.stringify({ externalId }) });
        push('tool/result', { message: { source: { callId }, isError: error, content: [{ type: 'text', text: result }] } });
      }
      events.push(...cliEvents({ write: true }).slice(-2));
      push('assistant/message', { content: 'MEMORY_ORGANIZER_DONE' });
      push('turn/end', { turn: 1, reason: { kind: 'completed' } });
      const run = h.runMemoryOrganizerHeadless(job, 'fixture', model, 'fixture-session', undefined, 1);
      if (recovered) assert.equal((await run).newMemories, storedIds.length);
      else await assert.rejects(run, /observedAt 无效/);
      h.api.callUnary = async method => ({ result: { ok: true, value: method === 'session/projections'
        ? { asOfSeq: records.length - 1 } : { records } } });
      const { receipts } = await h.readMemoryOrganizerCompletedChunks('fixture-session', job.jobId, 1);
      assert.equal(receipts.has(1), recovered);
    }
  } finally { await h.close(); }
});

test('retry keeps the completed checkpoint and blocks later ranges only for the affected source', () => {
  let saved;
  const state = createMemoryOrganizerState(null, value => { saved = value; });
  state.enqueueManual({ jobId: 'first', sourceSessionId: 'source-a', throughSeq: 100 });
  state.updateJob('first', { status: 'failed', error: 'HTTP 503', progress: { completed: 3, total: 5 } });
  state.enqueueManual({ jobId: 'later', sourceSessionId: 'source-a', throughSeq: 200 });
  state.enqueueManual({ jobId: 'other', sourceSessionId: 'source-b', throughSeq: 50 });
  assert.equal(state.nextQueued().jobId, 'other');
  const recovered = createMemoryOrganizerState(saved, () => {});
  recovered.retryJob('first');
  assert.equal(recovered.nextQueued().jobId, 'first');
  assert.equal(recovered.nextQueued().progress.completed, 3);
  assert.equal(recovered.source('source-a').lastProcessedSeq, -1);
});

test('sticker lookups are excluded before checking result truncation, while sticker sends remain evidence', () => {
  const records = [
    { seq: 1, type: 'tool/call', data: { callId: 'lookup', name: 'mcp__snowluma__qq_list_stickers', arguments: { count: 100 } } },
    { seq: 2, type: 'tool/result', data: { message: { source: { callId: 'lookup' }, content: [{ type: 'text', text: '旧目录[truncated]' }] } } },
    { seq: 3, type: 'tool/result', data: { message: { source: { toolName: 'mcp__qq__qq_list_stickers' }, content: [{ type: 'text', text: '候选' }] } } },
    { seq: 4, type: 'tool/call', data: { callId: 'send', name: 'mcp__qq__qq_send_sticker', arguments: { stickerId: 'chosen' } } },
    { seq: 5, type: 'tool/result', data: { message: { source: { callId: 'send' }, content: [{ type: 'text', text: '{"messageId":"42"}' }] } } }
  ];
  const transcript = organizerTranscriptRecords(records);
  assert.equal(transcript.incomplete, false);
  assert.deepEqual(transcript.events.map(event => event.seq), [4, 5]);
  assert.equal(transcript.events[1].result.messageId, '42');
  assert.deepEqual(organizerTranscriptRecords(records, { legacyChunkLayout: true }).events.map(event => event.seq), [1, 2, 3, 4, 5]);
});

test('unread and history can swap text renderings and add a date across midnight', () => {
  const records = [];
  function read(tool, message) {
    const callId = String(records.length);
    records.push({ seq: records.length, type: 'tool/call', data: { name: tool, callId } });
    records.push({ seq: records.length, type: 'tool/result', data: { message: { source: { callId },
      content: [{ type: 'text', text: JSON.stringify({ key: 'group:1', readThroughSeq: 1,
        messages: [{ messageId: '1', ...message }] }) }] } } });
  }
  read('qq_get_unread_messages', { text: '[回复] 好', plain: '好', at: '21:41' });
  read('qq_get_conversation_history', { text: '好', plain: '[回复] 好', at: '11-02 21:41' });
  const transcript = organizerTranscriptRecords(records);
  assert.equal(transcript.incomplete, false);
  const messages = transcript.events.filter(e => e.kind === 'qq-message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.at, '11-02 21:41');
  read('qq_get_conversation_history', { text: '另一条', plain: '[回复] 好', at: '11-03 21:41' });
  assert.match(organizerTranscriptRecords(records).incompleteReasons[0], /at.*text/);
});

test('detail and history preserve both renderings of a quoted reply in either read order', () => {
  const body = '好的';
  const quoted = '[引用 甲：周六见]' + body;
  const detail = { messageId: '17', text: quoted, userId: '7' };
  const history = { ...detail, text: body, plain: quoted };
  function transcript(reads) {
    const records = reads.flatMap(([tool, message], index) => {
      const callId = String(index);
      const payload = tool === 'qq_get_message_detail' ? { info: message } : { messages: [message], readThroughSeq: 1 };
      return [
        { seq: 2 * index, type: 'tool/call', data: { name: tool, callId } },
        { seq: 2 * index + 1, type: 'tool/result', data: { message: { source: { callId },
          content: [{ type: 'text', text: JSON.stringify({ key: 'group:1', ...payload }) }] } } }
      ];
    });
    return organizerTranscriptRecords(records);
  }
  const d = ['qq_get_message_detail', detail];
  const h = ['qq_get_conversation_history', history];
  for (const reads of [[d, h, h], [h, d, h]]) {
    const result = transcript(reads);
    assert.deepEqual(result.incompleteReasons, []);
    const messages = result.events.filter(event => event.kind === 'qq-message');
    assert.equal(messages.length, 1);
    assert.deepEqual(new Set([messages[0].message.text, messages[0].message.plain]), new Set([body, quoted]));
  }
  for (const change of [{ text: '另一条' }, { plain: '[引用 乙：另一个约定]' + body }, { userId: '9' }]) {
    assert.equal(transcript([d, h, [h[0], { ...history, ...change }]]).incomplete, true);
  }
});

test('receipt uses the final visible answer and ignores tentative markers in reasoning or tool steps', async () => {
  const h = await bridgeHarness();
  const records = [];
  const push = (type, data) => records.push({ seq: records.length, type, data });
  for (const chunk of [1, 2]) {
    push('turn/start', { turn: chunk });
    push('user/message', { content: `整理任务 fixture，当前是第 ${chunk}/2 段` });
    push('assistant/message', { content: [{ type: 'text', text: 'MEMORY_ORGANIZER_NO_CHANGE' }] });
    push('tool/call', { name: 'memory_save', callId: 'save', input: { externalId: `qq-bridge:organizer:fixture:chunk-${chunk}:item-1` } });
    push('tool/result', { message: { toolCallId: 'save', content: [{ type: 'text', text: '{"storedIds":["id"],"skippedIds":[]}' }] } });
    push('step/start', {});
    push('assistant/message', { content: [{ type: 'reasoning', text: 'MEMORY_ORGANIZER_NO_CHANGE MEMORY_ORGANIZER_DONE' },
      { type: 'text', text: chunk === 1 ? 'MEMORY_ORGANIZER_DONE' : '未结束' }] });
    push('turn/end', { turn: chunk, reason: { kind: 'completed' } });
  }
  h.api.callUnary = async method => ({ result: { ok: true, value: method === 'session/projections' ? { asOfSeq: records.length - 1 } : { records } } });
  try {
    const { receipts } = await h.readMemoryOrganizerCompletedChunks('fixture-session', 'fixture', 2);
    assert.deepEqual([...receipts.keys()], [1]);
    assert.deepEqual({ ...receipts.get(1) }, { memoryWrites: 1, newMemories: 1 });
  } finally { await h.close(); }
});
