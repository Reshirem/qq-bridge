import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDshMcpManagement } from '../src/dsh-mcp-management.js';
import { Config, apply } from '../plugins/qq-agent-presets/managed-mcp.mjs';

const connected = name => ({ name, configured: true, status: { state: 'connected', toolCount: 3, connectedAt: 123 } });
function fixture({ list = [connected('qq'), connected('qq-memory')], frame, rpc, auth, ...options } = {}) {
  const sockets = [], calls = [];
  class Socket extends EventTarget {
    constructor(url, init) {
      super(); this.url = String(url); this.init = init; this.closed = false; sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(text) {
      this.request = JSON.parse(text);
      assert.equal(this.request.endpoint, 'mcpManager/watch');
      assert.deepEqual(this.request.payload, { args: {} });
      queueMicrotask(() => this.emit(frame || { type: 'item', value: list }));
    }
    emit(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ streamId: this.request.streamId, ...frame }) })); }
    close() { this.closed = true; }
    disconnect() { this.dispatchEvent(new Event('close')); }
  }
  const api = {
    baseUrl: 'http://127.0.0.1:12345', cookie: 'fixture-cookie',
    ensureAuth: auth || (async () => {}),
    callUnary: async (...args) => { calls.push(args); return rpc ? rpc(...args) : { result: { ok: true, value: { ok: true, toolNames: ['qq_status'], closeConfirmed: true, durationMs: 10 } } }; },
  };
  const management = createDshMcpManagement({ api, WebSocketImpl: Socket, timeoutMs: 1000, ...options });
  return { management, api, sockets, calls };
}

test('one persistent passive watch is shared and reports only QQ registrations', async t => {
  const f = fixture({ list: [connected('qq'), connected('qq-memory'), connected('unrelated')] });
  t.after(() => f.management.close());
  const [a, b] = await Promise.all([f.management.status(), f.management.status()]);
  assert.equal(f.sockets.length, 1); assert.deepEqual(a, b);
  assert.deepEqual(a.servers.map(row => row.name), ['qq', 'qq-memory']);
  assert.equal(a.state, 'ready'); assert.equal(a.servers[0].status.toolCount, 3);
  a.servers[0].status.toolCount = 1000;
  assert.equal((await f.management.status()).servers[0].status.toolCount, 3);
  f.sockets[0].emit({ type: 'item', value: [{ ...connected('qq'), status: { state: 'reconnecting', attempt: 2, maxAttempts: 4, nextRetryAtMs: 99, lastError: 'secret=DO_NOT_RETURN', env: { secret: 'DO_NOT_RETURN' } } }] });
  const update = await f.management.status();
  assert.equal(update.servers[0].status.attempt, 2);
  assert.equal(update.servers[1].status.state, 'unmanaged');
  assert.ok(!JSON.stringify(update).includes('DO_NOT_RETURN'));
  assert.equal(f.calls.length, 0);
});

test('invalid server names fail before authentication or RPC and unmanaged servers cannot be acted on', async t => {
  let authCount = 0;
  const f = fixture({ list: [], auth: async () => { authCount++; } });
  t.after(() => f.management.close());
  for (const name of ['other', 'qq/../x', '', null, { name: 'qq' }]) {
    await assert.rejects(f.management.probe(name), error => error.code === 'invalid-server' && error.statusCode === 400);
  }
  assert.equal(authCount, 0); assert.equal(f.sockets.length, 0);
  await assert.rejects(f.management.restart('qq'), error => error.code === 'unmanaged' && error.statusCode === 409);
  assert.equal(f.calls.length, 0);
});

test('unsupported endpoint differs from connection failure and stale success is discarded', async t => {
  const old = fixture({ frame: { type: 'error', error: { code: 'gateway/invocation-unavailable', message: 'secret=PRIVATE' } } });
  t.after(() => old.management.close());
  const unsupported = await old.management.status();
  assert.equal(unsupported.state, 'unsupported'); assert.equal(unsupported.supported, false);
  assert.ok(!JSON.stringify(unsupported).includes('PRIVATE'));
  const f = fixture(); t.after(() => f.management.close());
  await f.management.status(); f.sockets[0].disconnect();
  const offline = await f.management.status();
  assert.equal(offline.state, 'unavailable'); assert.equal(offline.supported, true);
  assert.ok(offline.servers.every(row => row.status.state === 'unknown'));
  assert.equal(f.sockets.length, 1, 'disconnect retry is backoff-limited');
});

test('a changed DSH address opens a new watch and ignores the old socket', async t => {
  const f = fixture(); t.after(() => f.management.close());
  await f.management.status();
  f.api.baseUrl = 'http://127.0.0.1:12346';
  assert.equal((await f.management.status()).state, 'ready');
  assert.equal(f.sockets.length, 2); assert.ok(f.sockets[0].closed);
  f.sockets[0].emit({ type: 'item', value: [] });
  assert.equal((await f.management.status()).servers[0].managed, true);
});

test('probe returns bounded safe data and restart touches exactly its selected server', async t => {
  const f = fixture({ rpc: async method => ({ result: { ok: true, value: method.endsWith('/probe')
    ? { ok: true, toolNames: ['qq_status'], closeConfirmed: true, durationMs: 9, serverInfo: { name: 'token=PRIVATE' }, command: 'PRIVATE' }
    : undefined } }) });
  t.after(() => f.management.close());
  const result = await f.management.probe('qq');
  assert.deepEqual(result.result, { ok: true, closeConfirmed: true, durationMs: 9, toolNames: ['qq_status'], toolCount: 1, truncated: false });
  assert.equal((await f.management.restart('qq-memory')).result, null);
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['mcpManager/probe', { name: 'qq' }], ['mcpManager/restart', { name: 'qq-memory' }]]);
});

test('management actions for the same server cannot overlap and cleanup failures do not retry', async t => {
  let finish;
  const f = fixture({ rpc: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => f.management.close());
  await f.management.status();
  const first = f.management.restart('qq');
  await assert.rejects(f.management.probe('qq'), error => error.code === 'busy');
  finish({ result: { ok: false, error: { message: 'cleanup for qq incomplete; restart the Host token=PRIVATE' } } });
  await assert.rejects(first, error => error.code === 'cleanup-incomplete' && !error.message.includes('PRIVATE'));
  assert.equal(f.calls.length, 1);
});

test('watch and action timeouts are bounded, errors redact, and close disposes watch', async t => {
  const stalled = fixture({ timeoutMs: 15, auth: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  t.after(() => stalled.management.close());
  assert.equal((await stalled.management.status()).error.code, 'timeout');
  const f = fixture({ actionTimeoutMs: 15, rpc: (_method, _payload, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  t.after(() => f.management.close());
  await assert.rejects(f.management.probe('qq'), error => error.code === 'timeout' && error.statusCode === 504);
  f.management.close();
  assert.ok(f.sockets[0].closed);
  await assert.rejects(f.management.restart('qq'), error => error.code === 'closed');
});

test('arbitrary RPC errors and remote error codes never bypass safe diagnostics', async t => {
  const f = fixture({ rpc: async () => { throw Object.assign(new Error('token=PRIVATE'), { statusCode: 400, code: 'PRIVATE' }); } });
  t.after(() => f.management.close());
  await assert.rejects(f.management.probe('qq'), error => error.code === 'action-failed' && !error.message.includes('PRIVATE'));
  const bad = fixture({ frame: { type: 'error', error: { code: 'PRIVATE', message: 'PRIVATE' } } });
  t.after(() => bad.management.close());
  assert.ok(!JSON.stringify(await bad.management.status()).includes('PRIVATE'));
});

test('owned registration keeps tool namespace and timeout and rejects unrelated names', () => {
  const registrations = [];
  const ctx = { mcpManager: { register: (...args) => registrations.push(args) } };
  const config = Config({ serverName: 'qq', command: 'node', args: ['fixture.mjs'], toolCallTimeoutMs: 725000 });
  apply(ctx, config);
  assert.deepEqual(registrations, [['qq', { transport: 'stdio', command: 'node', args: ['fixture.mjs'], toolCallTimeoutMs: 725000 }]]);
  assert.throws(() => Config({ serverName: 'other', command: 'node', toolCallTimeoutMs: 1 }));
  assert.throws(() => apply(ctx, { ...config, serverName: 'other' }));
});
