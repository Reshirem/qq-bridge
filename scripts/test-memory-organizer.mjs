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
import { createMemoryOrganizerState, organizerEvidenceVersion, organizerTranscriptRecords } from '../src/memory-organizer.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { apply as organizerGuard } from '../src/memory-organizer-tool-guard.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const model = { provider: 'fixture', model: 'fixture' };
const missing = { code: 'not_found', message: 'memory not found' };

test('cleanup uses workspace state, protects unfinished and active sessions, and retries failures', async () => {
  const organizerIds = ['completed', 'archived', 'retry', 'running', 'available', 'unknown', 'missing', 'unfinished', 'source', 'desktop'];
  const state = { version: 1, sources: { source: { lastProcessedSeq: 1, lastScheduledSeq: 1 } },
    sessionsByDay: { '2026-11-18': 'completed', '2026-11-19': 'unfinished-day' },
    jobs: organizerIds.map((id, index) => ({ jobId: `job-${index}`, sourceSessionId: 'source',
      fromSeq: index, throughSeq: index + 1, organizerSessionId: id, organizerSessionIds: [id],
      day: id === 'unfinished' ? '2026-11-19' : '2026-11-18', status: id === 'unfinished' ? 'failed' : 'completed' })) };
  const h = await bridgeHarness({ files: {
    'state/memory-organizer.json': state,
    'state/desktop-agent.json': { sessionId: 'desktop', agentToken: 'fixture-agent-token' },
  } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/memory/organizer`;
    const cleanup = async () => {
      const response = await fetch(url, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-console-token': 'fixture-console-token'
      }, body: JSON.stringify({ action: 'cleanup' }), signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() };
    };
    const archived = new Set(['archived']);
    let failRead = true;
    h.api.readWorkspaceState = async () => {
      if (failRead) throw new Error('fixture workspace unavailable');
      return { items: [], archivedSessionIds: [...archived] };
    };
    h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [...organizerIds, 'unfinished-day']
      .filter(id => id !== 'missing').map(sessionId => ({ sessionId, running: sessionId === 'unknown' ? undefined : sessionId === 'running', agentAvailable: sessionId === 'available' })) } } });
    const attempts = [];
    let failArchive = true;
    h.api.workspace.archiveSession = async ({ sessionId }) => {
      attempts.push(sessionId);
      if (sessionId === 'retry' && failArchive) return { result: { ok: false, error: { code: 'fixture', message: 'try again' } } };
      archived.add(sessionId);
      return { result: { ok: true, value: { archivedSessionIds: [...archived] } } };
    };
    const unavailable = await cleanup();
    assert.equal(unavailable.status, 502);
    assert.deepEqual(attempts, [], 'failed state reads must not archive anything');
    failRead = false;
    const first = await cleanup();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.archived.map(row => row.sessionId), ['completed', 'available']);
    assert.deepEqual(first.body.alreadyArchived.map(row => row.sessionId), ['archived']);
    assert.deepEqual(first.body.failed.map(row => row.sessionId), ['retry']);
    assert.deepEqual(first.body.skipped.map(row => row.sessionId).sort(),
      ['desktop', 'missing', 'running', 'source', 'unfinished', 'unfinished-day', 'unknown']);
    failArchive = false;
    const retry = await cleanup();
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body.archived.map(row => row.sessionId), ['retry']);
    assert.deepEqual(retry.body.failed, []);
    const repeated = await cleanup();
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body.archived, []);
    assert.deepEqual(attempts, ['completed', 'retry', 'available', 'retry']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/memory-organizer.json'), 'utf8')), state,
      'archival must preserve organizer jobs and source cursors');

    let release;
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    h.api.readWorkspaceState = () => new Promise(resolve => { release = resolve; started(); });
    const pending = cleanup();
    await waiting;
    try { assert.equal((await cleanup()).status, 409); }
    finally { release({ items: [], archivedSessionIds: [...archived] }); await pending; }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

test('organizer excludes managed and legacy QQ tools and guards its exact memory namespace', async () => {
  const h = await bridgeHarness();
  try {
    const patch = yaml.load(h.memoryOrganizerPatchText(model));
    for (const id of ['tool-plugin-manager', 'tool-agent-team', 'mcp-resources', 'mcp-manager', 'mcp-qq', 'mcp-qq-memory', 'mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
      assert.ok(patch.some(row => row.id === id && row.disabled), id + ' must remain disabled');
    }
    assert.ok(patch.some(row => row.insert?.some(entry => entry.id === 'qq-memory-organizer-tool-guard')));
    assert.ok(patch.some(row => row.insert?.some(entry => entry.id === 'qq-bridge-memory-organizer' && entry.name === '@deepseek-ai/dsh-mcp-client')));
    let check;
    organizerGuard({ tools: { guard: fn => { check = fn; } } });
    for (const name of ['memory_search', 'memory_save', 'memory_read', 'memory_replace', 'memory_forget']) {
      assert.equal(check({ name: 'mcp__qq-memory-organizer__' + name }), undefined);
    }
    for (const name of ['memory_save', 'mcp__qq-memory__memory_save', 'mcp__qq-memory__memory_replace', 'mcp__qq__qq_send_message', 'mcp__qq-memory-organizer__unknown', 'plugin_manager', 'unknown_future_tool', '', null]) {
      assert.ok(check({ name }), String(name) + ' must be denied');
    }
    assert.ok(check(null));
  } finally { await h.close(); }
});

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
  await assert.rejects(gateway.replace({ memoryId: 'missing', content: 'replacement' }), /未找到要合并\/替换的旧记忆：missing/);
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

test('memory MCP returns an explicit not-found result, validates empty queries locally, and preserves actual read failures', async t => {
  const directory = fixture(t);
  let result = null, failure = false, searchCalls = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers['x-agent-token'], 'a'.repeat(64));
    for await (const chunk of req) { /* drain the synthetic request */ }
    if (req.url === '/api/desktop-agent/memory/search') {
      searchCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { summary: 'ok', hits: [] } }));
      return;
    }
    assert.equal(req.url, '/api/desktop-agent/memory/read');
    res.writeHead(failure ? 502 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failure ? { ok: false, error: 'fixture Gateway HTTP 503' } : { ok: true, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.join(directory, 'state'));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ consolePort: server.address().port, consoleToken: 'fixture-console-token' }));
  fs.writeFileSync(path.join(directory, 'state/desktop-agent.json'), JSON.stringify({ agentToken: 'a'.repeat(64) }));
  const source = fs.readFileSync(path.join(root, 'src/mcp-memory-safe.js'), 'utf8')
    .replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');", `const ROOT = ${JSON.stringify(directory)};`);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '--eval', source + '\nawait startMemoryServer();'], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'memory-regression-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    for (const args of [{}, { mode: 'SEARCH_MODE_HYBRID', timeStart: '2026-11-20T00:00:00Z', query: '   ' }]) {
      const emptySearch = await client.callTool({ name: 'memory_search', arguments: args });
      assert.equal(emptySearch.isError, true);
      assert.match(emptySearch.content[0].text, /必须提供非空 query/);
    }
    assert.equal(searchCalls, 0, 'empty queries must be rejected locally without hitting the bridge');
    assert.notEqual((await client.callTool({ name: 'memory_search', arguments: { query: '关键词' } })).isError, true);
    assert.notEqual((await client.callTool({ name: 'memory_search', arguments: { mode: 'SEARCH_MODE_TIME', timeStart: '2026-11-20T00:00:00Z' } })).isError, true);
    assert.equal(searchCalls, 2);

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
  h.api.callUnary = async method => ({ result: { ok: true, value: method === 'session/projections' ? { asOfSeq: records.length - 1, values: {} } : { records, hasMore: false } } });
  try {
    const recovered = await h.readMemoryOrganizerCompletedChunks(['fixture-session'], 'fixture-job', 3);
    assert.deepEqual([...recovered.receipts.keys()], [1]);
  } finally { await h.close(); }
});

test('organizer rejects migration-only projections before reading history or cached model routes', async () => {
  const h = await bridgeHarness();
  const calls = [];
  h.api.callUnary = async (method) => {
    calls.push(method);
    return { result: { ok: true, value: { kind: 'migration-required', values: {
      modelSelection: { next: model }
    } } } };
  };
  try {
    for (const read of [
      () => h.readMemoryOrganizerCompletedChunks(['fixture-session'], 'fixture-job', 1),
      () => h.readMemoryOrganizerModel('fixture-session'),
    ]) {
      await assert.rejects(read(), (error) => error.code === 'session/migration-required' && /迁移/.test(error.message));
    }
    assert.deepEqual(calls, ['session/projections', 'session/projections']);
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
        ? { asOfSeq: records.length - 1, values: {} } : { records } } });
      const { receipts } = await h.readMemoryOrganizerCompletedChunks('fixture-session', job.jobId, 1);
      assert.equal(receipts.has(1), recovered);
    }
  } finally { await h.close(); }
});

test('live and recovered chunks require a matching replacement receipt, including when old IDs were retained', async () => {
  const events = [];
  const h = await bridgeHarness({ globals: { spawn: spawnFixture(events) } });
  const job = { jobId: 'fixture' };
  const externalId = 'qq-bridge:organizer:fixture:chunk-1:item-1';
  const tool = 'mcp__qq-memory-organizer__memory_replace';
  try {
    for (const [result, status, noChange, confirmed] of [
      [{ memoryId: 'new', oldMemoryRetained: true, retainedIds: ['a'] }, 'completed', false, true],
      [{ memoryId: '' }, 'completed', false, false],
      [{ memoryId: 'PLACEHOLDER' }, 'completed', false, false],
      [{ storedIds: ['a'], skippedIds: [] }, 'completed', false, false],
      [{ memoryId: 'new' }, 'failed', false, false],
      [{ memoryId: 'new' }, 'completed', true, false],
      [null, null, true, false]
    ]) {
      const text = JSON.stringify(result);
      const finalText = 'MEMORY_ORGANIZER_DONE' + (noChange ? ' MEMORY_ORGANIZER_NO_CHANGE' : '');
      const records = [];
      const push = (type, data) => records.push({ seq: records.length, type, data });
      events.splice(0, events.length, ...cliEvents({ write: true }).slice(0, 2));
      events.push({ type: 'tool_call', callId: 'merge', tool, input: { externalId } });
      push('turn/start', { turn: 1 });
      push('user/message', { content: '整理任务 fixture，当前是第 1/1 段' });
      push('tool/call', { name: tool, callId: 'merge', arguments: { externalId } });
      if (status) {
        events.push({ type: 'tool_result', callId: 'merge', status, result: text });
        push('tool/result', { message: { toolCallId: 'merge', isError: status === 'failed', content: [{ type: 'text', text }] } });
      }
      const reason = { kind: 'completed' };
      events.push({ type: 'final', text: finalText, reason });
      push('assistant/message', { content: finalText });
      push('turn/end', { turn: 1, reason });
      let started = 0;
      const run = h.runMemoryOrganizerHeadless(job, 'fixture', model, 'fixture-session', () => started++, 1);
      if (confirmed) {
        const receipt = await run;
        assert.equal(receipt.memoryWrites, 1);
        assert.equal(receipt.newMemories, 1);
      } else await assert.rejects(run);
      assert.equal(started, 1);
      h.api.callUnary = async method => ({ result: { ok: true, value: method === 'session/projections'
        ? { asOfSeq: records.length - 1, values: {} } : { records } } });
      const { receipts } = await h.readMemoryOrganizerCompletedChunks('fixture-session', job.jobId, 1);
      assert.equal(receipts.has(1), confirmed);
      if (confirmed) assert.deepEqual({ ...receipts.get(1) }, { memoryWrites: 1, newMemories: 1 });
    }
    // A failed memory_replace without externalId followed by a confirmed memory_save with externalId recovers the chunk.
    const savedText = JSON.stringify({ storedIds: ['saved-1'], skippedIds: [] });
    const records = [];
    const push = (type, data) => records.push({ seq: records.length, type, data });
    events.splice(0, events.length, ...cliEvents({ write: true }).slice(0, 2));
    events.push(
      { type: 'tool_call', callId: 'bad-replace', tool, input: { memoryIds: '["a"]' } },
      { type: 'tool_result', callId: 'bad-replace', status: 'failed', result: '未找到要合并/替换的旧记忆' },
      { type: 'tool_call', callId: 'good-save', tool: 'memory_save', input: { externalId } },
      { type: 'tool_result', callId: 'good-save', status: 'completed', result: savedText },
      { type: 'final', text: 'MEMORY_ORGANIZER_DONE', reason: { kind: 'completed' } }
    );
    push('turn/start', { turn: 1 });
    push('user/message', { content: '整理任务 fixture，当前是第 1/1 段' });
    push('tool/call', { name: tool, callId: 'bad-replace', arguments: { memoryIds: '["a"]' } });
    push('tool/result', { message: { toolCallId: 'bad-replace', isError: true, content: [{ type: 'text', text: '未找到要合并/替换的旧记忆' }] } });
    push('tool/call', { name: 'memory_save', callId: 'good-save', arguments: { externalId } });
    push('tool/result', { message: { toolCallId: 'good-save', isError: false, content: [{ type: 'text', text: savedText }] } });
    push('assistant/message', { content: 'MEMORY_ORGANIZER_DONE' });
    push('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const fallbackOutcome = await h.runMemoryOrganizerHeadless(job, 'fixture', model, 'fixture-session', undefined, 1);
    assert.equal(fallbackOutcome.memoryWrites, 1);
    assert.equal(fallbackOutcome.newMemories, 1);
    h.api.callUnary = async method => ({ result: { ok: true, value: method === 'session/projections'
      ? { asOfSeq: records.length - 1, values: {} } : { records } } });
    const { receipts: fallbackReceipts } = await h.readMemoryOrganizerCompletedChunks('fixture-session', job.jobId, 1);
    assert.equal(fallbackReceipts.has(1), true);
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

function qqReadRecords(reads) {
  return reads.flatMap(({ message, key = 'group:1', tool = 'qq_get_conversation_history' }, index) => {
    const callId = String(index);
    const entry = { messageId: '17', userId: '7', at: '04:56', ...message };
    const payload = tool === 'qq_get_message_detail' ? { info: entry } : { messages: [entry], readThroughSeq: index + 1 };
    return [
      { seq: 2 * index, type: 'tool/call', data: { name: tool, callId, arguments: { key } } },
      { seq: 2 * index + 1, type: 'tool/result', data: { message: { source: { callId },
        content: [{ type: 'text', text: JSON.stringify({ key, partial: false, ...payload }) }] } } }
    ];
  });
}

test('notice placeholders cannot replace a witnessed QQ body in either read order', () => {
  const body = { text: '@角色', plain: '@角色', tail: '@角色', sender: '甲' };
  for (const placeholder of [{ text: '[notice]' }, { text: '[notice]', plain: '[notice]', tail: '[notice]' }]) {
    for (const reads of [[body, placeholder, placeholder], [placeholder, body, placeholder]]) {
      const records = qqReadRecords(reads.map(message => ({ message })));
      const before = structuredClone(records);
      const result = organizerTranscriptRecords(records);
      assert.deepEqual(result.incompleteReasons, []);
      const messages = result.events.filter(event => event.kind === 'qq-message');
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0].message, { messageId: '17', sender: '甲', userId: '7', at: '04:56', ...body });
      assert.equal(messages[0].bodySourceSeq, reads[0] === body ? undefined : 3);
      assert.deepEqual(records, before, 'persisted source evidence must not be mutated');
    }
  }
});

test('a metadata-only notice contributes no fabricated body and cannot borrow another identity', () => {
  const records = qqReadRecords([
    { message: { text: '[notice]', plain: '[notice]', tail: '[notice]', sender: '甲' } },
    { message: { text: '其他群的正文' }, key: 'group:2' },
    { message: { messageId: '18', text: '另一条消息' } }
  ]);
  const result = organizerTranscriptRecords(records);
  assert.equal(result.incomplete, false);
  const messages = result.events.filter(event => event.kind === 'qq-message');
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0].message, { messageId: '17', sender: '甲', userId: '7', at: '04:56' });
  assert.equal(messages[0].bodySourceSeq, undefined);
});

test('notice placeholders do not hide real text, identity, time, media or truncation conflicts', () => {
  const original = { text: '原文', userId: '7', time: 100, at: '04:56', isSelf: false, media: [{ kind: 'image' }] };
  for (const change of [
    { text: '不同正文' }, { userId: '9' }, { time: 101 }, { at: '04:57' },
    { isSelf: true }, { media: [{ kind: 'video' }] }
  ]) {
    const result = organizerTranscriptRecords(qqReadRecords([
      { message: original }, { message: { text: '[notice]' } },
      { message: { ...original, text: '[notice]', ...change } }
    ]));
    assert.equal(result.incomplete, true, JSON.stringify(change));
    assert.match(result.incompleteReasons[0], new RegExp(Object.keys(change)[0]));
  }
  const clipped = organizerTranscriptRecords(qqReadRecords([{ message: { text: '不完整', textTruncated: true } }]));
  assert.equal(clipped.events.find(event => event.kind === 'qq-message').message.text, undefined);
  assert.equal(organizerTranscriptRecords(qqReadRecords([{ message: { text: '[notice][truncated]' } }])).incomplete, true);
});

test('only exact notice placeholders are omitted from individual text renderings', () => {
  for (const text of ['文字 [notice]', '[notice] 后续文字', ' [notice]', '[NOTICE]', '[图片]', '[其它]']) {
    const result = organizerTranscriptRecords(qqReadRecords([{ message: { text } }]));
    assert.equal(result.events.find(event => event.kind === 'qq-message').message.text, text);
    assert.equal(organizerTranscriptRecords(qqReadRecords([
      { message: { text } }, { message: { text: '不同正文' } }
    ])).incomplete, true);
  }
  const result = organizerTranscriptRecords(qqReadRecords([
    { message: { text: '[notice]', plain: '已见正文' } },
    { message: { plain: '另一份正文' } }
  ]));
  assert.match(result.incompleteReasons[0], /plain/);
});

test('quoted reply alignment uses the tool that first supplied a body after a notice', () => {
  const detail = { message: { text: '[引用 甲：周六见]好的' }, tool: 'qq_get_message_detail' };
  const history = { message: { text: '好的', plain: '[引用 甲：周六见]好的' } };
  for (const reads of [[detail, history, history], [history, detail, history]]) {
    const result = organizerTranscriptRecords(qqReadRecords([{ message: { text: '[notice]' } }, ...reads]));
    assert.deepEqual(result.incompleteReasons, []);
    const message = result.events.find(event => event.kind === 'qq-message');
    assert.equal(message.bodySourceSeq, 3);
    assert.deepEqual(new Set([message.message.text, message.message.plain]), new Set(['好的', '[引用 甲：周六见]好的']));
  }
});

function toolResult(seq, toolName, ...blocks) {
  return { seq, type: 'tool/result', data: { message: { source: { toolName },
    content: blocks.map(text => ({ type: 'text', text })) } } };
}

test('browser snapshots and clicks retain tab, action and visible labels within a bounded excerpt', () => {
  const tab = { title: '操作指南', url: 'https://example.invalid/help' };
  const tabSummary = 'tab tb8 · Google Chrome · 操作指南 · ' + tab.url;
  const nodes = Array.from({ length: 400 }, (_, i) => '  [tb8:' + i + '] button "继续阅读 ' + 'x'.repeat(32) + '"');
  for (const action of ['snapshot', 'click']) {
    const header = { channel: 'browser', ok: true, action, target: 'button', tab, screenshot: { data: 'image-data' } };
    const raw = [JSON.stringify(header), tabSummary, '[tb8:99] image', ...nodes].join('\r\n');
    const records = [toolResult(1, 'mcp__wincu__windows_computer_use_' + action, raw)];
    const { events: [event], incomplete } = organizerTranscriptRecords(records);
    assert.equal(incomplete, false);
    assert.ok(Buffer.byteLength(raw) > 20_000);
    assert.ok(Buffer.byteLength(JSON.stringify(event)) < 3000);
    assert.deepEqual(event.result.tab, tab);
    assert.equal(event.result.action, action);
    assert.equal(event.result.target, 'button');
    assert.equal(event.result.tabSummary, tabSummary);
    assert.equal(event.result.truncated, true);
    assert.equal(event.resultTruncated, true);
    assert.match(event.result.pageExcerpt, /^继续阅读/);
    assert.ok(event.result.pageExcerpt.length <= 1500);
    assert.doesNotMatch(JSON.stringify(event), /\[tb8:|image-data/);
    for (const options of [{ compactDesktopToolResults: false }, { legacyChunkLayout: true }]) {
      assert.equal(organizerTranscriptRecords(records, options).events[0].result, raw);
    }
  }
});

test('spilled accessibility trees and OCR evidence fit the organizer chunker', async () => {
  const name = '搜索 "资料"';
  const root = { boundingBox: { width: 640 }, name, controlType: 'Window', className: 'Fixture', children: [] };
  const tree = JSON.stringify({ ok: false, scope: 'window', nodeCount: 300, tree: root });
  const raw = tree.slice(0, tree.indexOf('[]')) + '[{"action":"nested-control"},' + '{"id":100},'.repeat(5300)
    + '\n\n[...]\n\n]}}\n(Omitted 39767 bytes. Full formatted result stored at: fixture-private-path)';
  const ocr = { text: '识别文字'.repeat(600), query: '资料', matched: true, lines: Array(1100).fill({ words: ['坐标'], bbox: [1, 2, 3, 4] }) };
  const records = [
    toolResult(3303, 'mcp__wincu__windows_computer_use_accessibility_tree', raw),
    toolResult(3304, 'windows_computer_use_ocr', JSON.stringify(ocr)),
    toolResult(3305, 'windows_computer_use_accessibility_tree', tree),
    toolResult(3306, 'windows_computer_use_list_windows', JSON.stringify({ windows: Array(35).fill('title'), boxes: [], words: [] }))
  ];
  assert.ok(Buffer.byteLength(raw) > 50_000);
  assert.ok(Buffer.byteLength(JSON.stringify(ocr)) > 38_000);
  const { events, incomplete } = organizerTranscriptRecords(records);
  assert.equal(incomplete, false);
  assert.ok(events.every(event => event.resultTruncated && event.result.truncated));
  const [spill, text, window, list] = events.map(event => event.result);
  assert.equal(spill.compactedFromSpill, true);
  assert.equal(spill.ok, false);
  assert.equal(spill.scope, 'window');
  assert.equal(spill.windowName, name);
  assert.equal(spill.nodeCount, 300);
  assert.equal(spill.action, undefined);
  assert.doesNotMatch(JSON.stringify(events), /fixture-private-path|"children"|"lines"|"boxes"|"words"/);
  assert.equal(text.text, ocr.text.slice(0, 2000));
  assert.deepEqual([text.query, text.matched, text.lineCount], ['资料', true, ocr.lines.length]);
  assert.deepEqual(window.tree, { name, controlType: 'Window', className: 'Fixture' });
  assert.equal(list.windows.length, 30);
  const h = await bridgeHarness();
  try {
    assert.equal(h.chunkMemoryOrganizerEvents(events).length, 1);
    const old = organizerTranscriptRecords(records, { compactDesktopToolResults: false });
    assert.throws(() => h.chunkMemoryOrganizerEvents(old.events), /超过 45000 字节/);
  } finally { await h.close(); }
});

test('external previews are sanitized and flagged while QQ, memory and replaced records stay strict', () => {
  const marker = '[truncated]';
  const spill = 'partial\n(Omitted 999 bytes. Full formatted result stored at: fixture)';
  for (const tool of ['mcp__qq__qq_get_conversation_history', 'mcp__qq-memory__memory_read', 'qq_agent_rest']) {
    for (const text of [marker, spill]) assert.equal(organizerTranscriptRecords([toolResult(1, tool, text)]).incomplete, true);
    const raw = '资料'.repeat(10_000);
    assert.equal(organizerTranscriptRecords([toolResult(1, tool, raw)]).events[0].result, raw);
  }
  const records = [toolResult(1, 'web_search', marker, spill), toolResult(2, 'web_fetch', JSON.stringify({
    token: 'fixture-secret', text: '字'.repeat(6000)
  }))];
  const sanitize = value => value?.token ? { ...value, token: '***' } : value;
  const { events, incomplete } = organizerTranscriptRecords(records, { sanitize });
  assert.equal(incomplete, false);
  assert.ok(events.every(event => event.resultTruncated));
  assert.equal(events[1].result.truncated, true);
  assert.equal(events[1].result.preview.length, 4000);
  assert.doesNotMatch(events[1].result.preview, /fixture-secret/);
  assert.equal(organizerTranscriptRecords(records, { compactDesktopToolResults: false }).incomplete, true);
  assert.equal(organizerTranscriptRecords([{ ...records[0], surfaceOp: 'replace' }]).incomplete, true);
});

test('existing chunk receipts retain evidence layout while unread jobs adopt version 5', () => {
  for (const job of [{}, { progress: { evidenceVersion: 2, total: null, completed: 0 } }]) {
    assert.equal(organizerEvidenceVersion(job), 5);
  }
  for (const evidenceVersion of [1, 2, 3, 4, 5]) {
    for (const checkpoint of [{ total: 5 }, { completed: 1 }]) {
      assert.equal(organizerEvidenceVersion({ progress: { evidenceVersion, ...checkpoint } }), evidenceVersion);
    }
    assert.equal(organizerEvidenceVersion({ progress: { evidenceVersion }, organizerSessionIds: ['session'] }), evidenceVersion);
  }
  assert.equal(organizerEvidenceVersion({ progress: { total: 5 } }), 1);
  assert.equal(organizerEvidenceVersion({ organizerSessionId: 'session' }), 1);
  const records = qqReadRecords([{ message: { text: '[notice]' } }]);
  for (const options of [{ legacyChunkLayout: true }, { omitNoticePlaceholders: false }]) {
    assert.equal(organizerTranscriptRecords(records, options).events.find(e => e.kind === 'qq-message').message.text, '[notice]');
    assert.equal(organizerTranscriptRecords(qqReadRecords([
      { message: { text: '原文' } }, { message: { text: '[notice]' } }
    ]), options).incomplete, true);
  }
});

test('version 5 recovers complete head and tail messages from DSH-spilled QQ history reads', async () => {
  const key = 'group:123';
  const makeMsg = (index, extra = {}) => ({
    kind: 'group',
    messageId: String(9000 + index),
    sender: `用户${index % 3}`,
    userId: String(101 + (index % 3)),
    text: `第 ${index} 条测试消息：${'内容'.repeat(25)}`,
    at: '01:40',
    ago: '1m',
    ...extra
  });
  const allMessages = Array.from({ length: 160 }, (_, idx) => makeMsg(idx));
  const payload = JSON.stringify({
    ok: true,
    key,
    source: 'ntqq-history',
    action: 'get_group_msg_history',
    messageId: null,
    unreadBeforeRead: 1,
    count: 160,
    messages: allMessages,
    now: 1789680000000,
    slang: [
      { id: 'slang-1', content: '梗词', meaning: '测试黑话', usage: '测试用法', scope: key, status: 'learned', confidence: 0.9 }
    ],
    bufferId: 'fixture-buffer',
    unreadCount: 0,
    readThroughSeq: 301
  });
  const headCut = payload.indexOf('"messageId":"9060"') + 12;
  const tailCut = payload.indexOf('"messageId":"9120"') + 12;
  const spilledText = `${payload.slice(0, headCut)}\n\n[...]\n\n${payload.slice(tailCut)}\n\n(Omitted 20000 bytes. Full formatted result stored at: fixture-spill-path. Use read with offset/limit, or grep this path to search within it.)`;

  const callRecord = (seq, name, args) => ({ seq, type: 'tool/call', data: { name, callId: `call-${seq}`, arguments: JSON.stringify(args) } });
  const resultRecord = (seq, name, callId, text, surfaceOp = 'append') => ({
    seq, type: 'tool/result', surfaceOp,
    data: { message: { source: { callId, toolName: name }, content: [{ type: 'text', text }] } }
  });

  const records = [
    callRecord(1, 'mcp__qq__qq_get_conversation_history', { key, count: 160 }),
    resultRecord(2, 'mcp__qq__qq_get_conversation_history', 'call-1', spilledText),
    // Subsequent partial unread reads continue using afterSeq without conflicting with spilled history's readThroughSeq=301.
    callRecord(3, 'mcp__qq__qq_get_unread_messages', { key }),
    resultRecord(4, 'mcp__qq__qq_get_unread_messages', 'call-3', JSON.stringify({
      ok: true, key, bufferId: 'fixture-buffer', readThroughSeq: 12, partial: true,
      messages: [{ seq: 12, messageId: '9000', sender: '用户0', userId: '101', text: allMessages[0].text, at: '01:40' }]
    })),
    callRecord(5, 'mcp__qq__qq_get_unread_messages', { key, afterSeq: 12 }),
    resultRecord(6, 'mcp__qq__qq_get_unread_messages', 'call-5', JSON.stringify({
      ok: true, key, bufferId: 'fixture-buffer', readThroughSeq: 13, partial: false,
      messages: [{ seq: 13, messageId: '9160', sender: '用户1', userId: '102', text: '新未读消息', at: '01:42' }]
    }))
  ];

  const transcript = organizerTranscriptRecords(records);
  assert.equal(transcript.incomplete, false, JSON.stringify(transcript.incompleteReasons));
  assert.deepEqual(transcript.incompleteReasons, []);
  const qqReads = transcript.events.filter(event => event.kind === 'qq-read');
  assert.equal(qqReads[0].partial, true);
  assert.equal(qqReads[0].resultTruncated, true);
  assert.equal(qqReads[0].readThroughSeq, 301);
  assert.equal(qqReads[0].messageCount, 60 + 39);
  const qqMessages = transcript.events.filter(event => event.kind === 'qq-message');
  assert.equal(qqMessages.length, 60 + 39 + 1); // msg 9000 deduplicated across read 2 and read 4
  assert.equal(qqMessages.some(event => event.message.messageId === '9060'), false);
  assert.equal(qqMessages.some(event => event.message.messageId === '9120'), false);
  assert.equal(qqMessages.some(event => event.message.messageId === '9000' && event.message.seq === 12), true);
  assert.doesNotMatch(JSON.stringify(transcript.events), /fixture-spill-path|"meaning":"测试黑话"/);

  const h = await bridgeHarness();
  try {
    assert.ok(h.chunkMemoryOrganizerEvents(transcript.events).length >= 1);
  } finally { await h.close(); }

  // Conflict against another read of the same recovered message still blocks.
  const conflicted = organizerTranscriptRecords([
    records[0], records[1],
    callRecord(7, 'mcp__qq__qq_get_message_detail', { key, messageId: 'id:9000' }),
    resultRecord(8, 'mcp__qq__qq_get_message_detail', 'call-7', JSON.stringify({
      ok: true, key, info: { messageId: '9000', sender: '用户0', userId: '101', text: '被篡改的正文', at: '01:40' }
    }))
  ]);
  assert.equal(conflicted.incomplete, true);
  assert.match(conflicted.incompleteReasons[0], /text/);

  // Legacy version 4 behavior keeps spilled QQ reads incomplete.
  assert.equal(organizerTranscriptRecords([records[0], records[1]], { recoverSpilledQQReads: false }).incomplete, true);
});

test('spilled QQ recovery handles closed head, slang-boundary cuts, clean tail boundary, and fails closed on tampering', () => {
  const key = 'group:456';
  const call = (name, args = { key }) => ({ seq: 1, type: 'tool/call', data: { name, callId: 'c1', arguments: JSON.stringify(args) } });
  const res = (name, text, surfaceOp = 'append') => ({
    seq: 2, type: 'tool/result', surfaceOp,
    data: { message: { source: { callId: 'c1', toolName: name }, content: [{ type: 'text', text }] } }
  });
  const footer = '\n\n(Omitted 100 bytes. Full formatted result stored at: fixture-spill-path)';
  const baseObj = {
    ok: true,
    key,
    messages: [
      { kind: 'group', messageId: '10', userId: '101', text: '第一条' },
      { kind: 'group', messageId: '11', userId: '102', text: '第二条' },
      { kind: 'group', messageId: '12', userId: '103', text: '第三条' }
    ],
    slang: [
      { id: 's1', content: '黑话1', meaning: '释义1', scope: key },
      { id: 's2', content: '黑话2', meaning: '释义2', scope: key }
    ],
    bufferId: 'buf-1',
    readThroughSeq: 77
  };
  const json = JSON.stringify(baseObj);

  // 1. Head closes messages completely, [...] cuts only inside slang.
  const slangMid = json.indexOf('"黑话2"');
  const closedHeadSpill = `${json.slice(0, json.indexOf('"slang":[') + 14)}\n\n[...]\n\n${json.slice(slangMid)}${footer}`;
  const closedHead = organizerTranscriptRecords([call('qq_get_conversation_history'), res('qq_get_conversation_history', closedHeadSpill)]);
  assert.equal(closedHead.incomplete, false);
  assert.deepEqual(closedHead.events.filter(e => e.kind === 'qq-message').map(e => e.message.messageId), ['10', '11', '12']);
  assert.equal(closedHead.events.find(e => e.kind === 'qq-read').readThroughSeq, 77);

  // 2. [...] crosses end of messages into slang: keeps complete head messages, never leaks slang as qq-message.
  const crossCutSpill = `${json.slice(0, json.indexOf('"第三条"'))}\n\n[...]\n\n${json.slice(slangMid)}${footer}`;
  const crossCut = organizerTranscriptRecords([call('qq_get_conversation_history'), res('qq_get_conversation_history', crossCutSpill)]);
  assert.equal(crossCut.incomplete, false);
  assert.deepEqual(crossCut.events.filter(e => e.kind === 'qq-message').map(e => e.message.messageId), ['10', '11']);
  assert.doesNotMatch(JSON.stringify(crossCut.events), /黑话|释义/);

  // 3. Tail starts cleanly on a complete message object: keeps that first tail message.
  const firstMsgEnd = json.indexOf(',{"kind":"group","messageId":"11"');
  const thirdMsgStart = json.indexOf('{"kind":"group","messageId":"12"');
  const cleanTailSpill = `${json.slice(0, firstMsgEnd)},\n\n[...]\n\n${json.slice(thirdMsgStart)}${footer}`;
  const cleanTail = organizerTranscriptRecords([call('qq_get_conversation_history'), res('qq_get_conversation_history', cleanTailSpill)]);
  assert.equal(cleanTail.incomplete, false);
  assert.deepEqual(cleanTail.events.filter(e => e.kind === 'qq-message').map(e => e.message.messageId), ['10', '12']);

  // 4. Fail-closed negative cases.
  const validSpill = `${json.slice(0, json.indexOf('"第二条"'))}\n\n[...]\n\n${json.slice(thirdMsgStart)}${footer}`;
  assert.equal(organizerTranscriptRecords([call('qq_get_conversation_history'), res('qq_get_conversation_history', validSpill, 'replace')]).incomplete, true);
  assert.equal(organizerTranscriptRecords([call('qq_get_conversation_history'), res('qq_get_conversation_history', validSpill.replace('第一条', '[truncated]'))]).incomplete, true);
  assert.equal(organizerTranscriptRecords([call('qq_get_conversation_history', { key: 'group:999' }), res('qq_get_conversation_history', validSpill)]).incomplete, true);
  assert.equal(organizerTranscriptRecords([call('qq_get_conversation_history'), res('qq_get_conversation_history', validSpill.replace('"ok":true', '"ok":false'))]).incomplete, true);
  assert.equal(organizerTranscriptRecords([call('qq_get_conversation_history'), res('qq_get_conversation_history', validSpill.replace('"readThroughSeq":77', '"other":1'))]).incomplete, true);
  const zeroCompleteSpill = `${json.slice(0, json.indexOf('"第一条"'))}\n\n[...]\n\n${json.slice(json.indexOf('],"slang"'))}${footer}`;
  assert.equal(organizerTranscriptRecords([call('qq_get_conversation_history'), res('qq_get_conversation_history', zeroCompleteSpill)]).incomplete, true);
  for (const blockedTool of ['mcp__qq__qq_get_message_detail', 'mcp__qq-memory__memory_read', 'qq_agent_rest']) {
    assert.equal(organizerTranscriptRecords([call(blockedTool), res(blockedTool, validSpill)]).incomplete, true);
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
  h.api.callUnary = async method => ({ result: { ok: true, value: method === 'session/projections' ? { asOfSeq: records.length - 1, values: {} } : { records } } });
  try {
    const { receipts } = await h.readMemoryOrganizerCompletedChunks('fixture-session', 'fixture', 2);
    assert.deepEqual([...receipts.keys()], [1]);
    assert.deepEqual({ ...receipts.get(1) }, { memoryWrites: 1, newMemories: 1 });
  } finally { await h.close(); }
});

test('read-only tool failures recover only on subsequent same-turn retries, never from parallel siblings or forget errors', async () => {
  const events = [];
  const h = await bridgeHarness({ globals: { spawn: spawnFixture(events) } });
  const job = { jobId: 'fixture' };
  const externalId = 'qq-bridge:organizer:fixture:chunk-1:item-1';
  const prefix = 'mcp__qq-memory-organizer__';
  const saveResult = JSON.stringify({ storedIds: ['saved-1'], skippedIds: [] });

  function buildScenario(steps) {
    const records = [];
    const push = (type, data) => records.push({ seq: records.length, type, data });
    events.splice(0, events.length, { type: 'session', sessionId: 'fixture-session' }, { type: 'status', phase: 'turn_start' });
    push('turn/start', { turn: 1 });
    push('user/message', { content: '整理任务 fixture，当前是第 1/1 段' });
    for (const step of steps) {
      if (step.kind === 'call') {
        events.push({ type: 'tool_call', callId: step.callId, tool: `${prefix}${step.tool}`, input: step.input });
        push('tool/call', { callId: step.callId, name: `${prefix}${step.tool}`, arguments: JSON.stringify(step.input) });
      } else {
        events.push({
          type: 'tool_result', callId: step.callId,
          status: step.error ? 'failed' : 'completed',
          result: step.result
        });
        push('tool/result', {
          message: { source: { callId: step.callId }, isError: !!step.error, content: [{ type: 'text', text: step.result }] }
        });
      }
    }
    const reason = { kind: 'completed' };
    events.push({ type: 'status', phase: 'turn_end', reason }, { type: 'final', text: 'MEMORY_ORGANIZER_DONE', reason });
    push('assistant/message', { content: 'MEMORY_ORGANIZER_DONE' });
    push('turn/end', { turn: 1, reason });
    return records;
  }

  async function evaluate(steps) {
    const records = buildScenario(steps);
    h.api.callUnary = async method => ({ result: { ok: true, value: method === 'session/projections'
      ? { asOfSeq: records.length - 1, values: {} } : { records } } });
    let headlessError = null;
    let headlessOutcome = null;
    try {
      headlessOutcome = await h.runMemoryOrganizerHeadless(job, 'fixture', model, 'fixture-session', undefined, 1);
    } catch (error) {
      headlessError = error;
    }
    const replay = await h.readMemoryOrganizerCompletedChunks(['fixture-session'], job.jobId, 1);
    return { headlessError, headlessOutcome, replay };
  }

  try {
    // 1. Sequential retry after failed memory_search recovers cleanly and saves.
    const seqRetry = await evaluate([
      { kind: 'call', callId: 's1', tool: 'memory_search', input: {} },
      { kind: 'result', callId: 's1', error: true, result: 'HTTP 503：必须提供 query' },
      { kind: 'call', callId: 's2', tool: 'memory_search', input: { query: '关键词' } },
      { kind: 'result', callId: 's2', error: false, result: '{"summary":"ok","hits":[]}' },
      { kind: 'call', callId: 'w1', tool: 'memory_save', input: { externalId } },
      { kind: 'result', callId: 'w1', error: false, result: saveResult }
    ]);
    assert.equal(seqRetry.headlessError, null);
    assert.equal(seqRetry.headlessOutcome.newMemories, 1);
    assert.equal(seqRetry.replay.receipts.has(1), true);
    assert.equal(seqRetry.replay.failures.has(1), false);

    // 2. Parallel sibling memory_search success must NOT clear a failure from the same batch.
    const parallelSearch = await evaluate([
      { kind: 'call', callId: 'p1', tool: 'memory_search', input: {} },
      { kind: 'call', callId: 'p2', tool: 'memory_search', input: { query: '并行查询' } },
      { kind: 'result', callId: 'p1', error: true, result: '必须提供 query' },
      { kind: 'result', callId: 'p2', error: false, result: '{"summary":"ok","hits":[]}' },
      { kind: 'call', callId: 'w1', tool: 'memory_save', input: { externalId } },
      { kind: 'result', callId: 'w1', error: false, result: saveResult }
    ]);
    assert.match(parallelSearch.headlessError?.message ?? '', /memory_search 返回失败/);
    assert.equal(parallelSearch.replay.receipts.has(1), false);
    assert.match(parallelSearch.replay.failures.get(1) ?? '', /memory_search 返回失败/);

    // 3. Unretried memory_search failure remains blocked with diagnostic reason.
    const unretriedSearch = await evaluate([
      { kind: 'call', callId: 's1', tool: 'memory_search', input: {} },
      { kind: 'result', callId: 's1', error: true, result: 'gateway down' },
      { kind: 'call', callId: 'w1', tool: 'memory_save', input: { externalId } },
      { kind: 'result', callId: 'w1', error: false, result: saveResult }
    ]);
    assert.match(unretriedSearch.headlessError?.message ?? '', /memory_search 返回失败/);
    assert.equal(unretriedSearch.replay.receipts.has(1), false);
    assert.match(unretriedSearch.replay.failures.get(1) ?? '', /gateway down/);

    // 4. memory_read failure recovers ONLY on a subsequent retry of the exact same memoryId.
    const readRecovered = await evaluate([
      { kind: 'call', callId: 'r1', tool: 'memory_read', input: { memoryId: 'mem-1' } },
      { kind: 'result', callId: 'r1', error: true, result: 'HTTP 503' },
      { kind: 'call', callId: 'r2', tool: 'memory_read', input: { memoryId: 'mem-1' } },
      { kind: 'result', callId: 'r2', error: false, result: '{"found":false}' },
      { kind: 'call', callId: 'w1', tool: 'memory_save', input: { externalId } },
      { kind: 'result', callId: 'w1', error: false, result: saveResult }
    ]);
    assert.equal(readRecovered.headlessError, null);
    assert.equal(readRecovered.replay.receipts.has(1), true);

    const readWrongId = await evaluate([
      { kind: 'call', callId: 'r1', tool: 'memory_read', input: { memoryId: 'mem-1' } },
      { kind: 'result', callId: 'r1', error: true, result: 'HTTP 503' },
      { kind: 'call', callId: 'r2', tool: 'memory_read', input: { memoryId: 'mem-2' } },
      { kind: 'result', callId: 'r2', error: false, result: '{"found":false}' },
      { kind: 'call', callId: 'w1', tool: 'memory_save', input: { externalId } },
      { kind: 'result', callId: 'w1', error: false, result: saveResult }
    ]);
    assert.match(readWrongId.headlessError?.message ?? '', /memory_read 返回失败/);
    assert.equal(readWrongId.replay.receipts.has(1), false);
    assert.match(readWrongId.replay.failures.get(1) ?? '', /memory_read 返回失败/);

    // 5. memory_forget failure is never cleared even if search/save later succeed.
    const forgetFailed = await evaluate([
      { kind: 'call', callId: 'f1', tool: 'memory_forget', input: { memoryId: 'mem-1' } },
      { kind: 'result', callId: 'f1', error: true, result: 'delete denied' },
      { kind: 'call', callId: 's1', tool: 'memory_search', input: { query: '关键词' } },
      { kind: 'result', callId: 's1', error: false, result: '{"summary":"ok","hits":[]}' },
      { kind: 'call', callId: 'w1', tool: 'memory_save', input: { externalId } },
      { kind: 'result', callId: 'w1', error: false, result: saveResult }
    ]);
    assert.match(forgetFailed.headlessError?.message ?? '', /memory_forget 返回失败/);
    assert.equal(forgetFailed.replay.receipts.has(1), false);
    assert.match(forgetFailed.replay.failures.get(1) ?? '', /memory_forget 返回失败/);
  } finally { await h.close(); }
});
