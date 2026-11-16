import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('MCP management routes are console-only and only dispatch explicit actions', async () => {
  const calls = [];
  const manager = {
    status: async () => { calls.push('status'); return { state: 'ready', supported: true, servers: [] }; },
    probe: async name => { calls.push(['probe', name]); return { ok: true, name, action: 'probe', result: { ok: true, toolCount: 28 } }; },
    restart: async name => { calls.push(['restart', name]); throw Object.assign(new Error('fixture unavailable'), { code: 'unavailable', statusCode: 503 }); },
    close() { calls.push('close'); },
  };
  const h = await bridgeHarness({ globals: { createDshMcpManagement: () => manager } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body, extra = {}) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const before = fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8');
    const sessionId = await h.ensureDesktopAgentSession();
    const token = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/desktop-agent.json'))).agentToken;
    const agent = { 'x-agent-call': '1', 'x-agent-token': token, 'x-agent-session-id': sessionId };
    for (const [route, body] of [['/api/console/mcp', undefined], ['/api/console/mcp/qq/probe', {}], ['/api/console/mcp/qq-memory/restart', {}]]) {
      assert.equal((await call(route, body, agent)).status, 403);
      assert.equal((await call(route, body, { 'x-console-token': '' })).status, 401);
    }
    assert.deepEqual(calls, []);
    assert.equal((await call('/api/console/mcp/qq/probe', {}, { origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await call('/api/console/mcp/qq/probe', { command: 'not allowed' })).status, 400);
    assert.deepEqual(calls, []);
    assert.equal((await call('/api/console/mcp')).body.state, 'ready');
    assert.deepEqual(calls, ['status']);
    assert.equal((await call('/api/console/mcp/qq/probe', {})).body.result.toolCount, 28);
    const failure = await call('/api/console/mcp/qq-memory/restart', {});
    assert.equal(failure.status, 503);
    assert.equal(failure.body.errorCode, 'unavailable');
    assert.deepEqual(calls, ['status', ['probe', 'qq'], ['restart', 'qq-memory']]);
    assert.equal(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'), before);
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
  assert.equal(calls.at(-1), 'close');
});
