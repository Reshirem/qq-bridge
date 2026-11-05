import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { persistSnowLumaEndpoint } from '../src/snowluma-conn.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
test('SnowLuma client libraries meet the current minimum version', () => {
  // 只比较 minor.patch 数值，够用且不引入语义化版本库依赖。
  const num = (v) => {
    const m = /^[\^~]?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
    return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : null;
  };
  const min = num('1.14.20');
  for (const name of ['@snowluma/sdk', '@snowluma/mcp']) {
    const declared = num(pkg.dependencies?.[name]);
    assert.ok(declared !== null, `${name} 必须在 dependencies 里声明`);
    assert.ok(
      declared >= min,
      `${name} 声明为 ${pkg.dependencies[name]}，低于当前最低版本 1.14.20。`,
    );
  }
});

test('installed SnowLuma SDK can be imported by the bridge', async () => {
  const { SnowLumaWebSocketClient } = await import('@snowluma/sdk');
  assert.equal(typeof SnowLumaWebSocketClient, 'function');
});

test('status follows the gateway poll, heartbeats, account notices and silence', async () => {
  let now = Date.now();
  const h = await bridgeHarness({
    config: { snowluma: { silenceWarnMs: 60000 } },
    globals: { Date: class extends Date { static now() { return now; } } },
    onebot: { httpAction(action) {
      if (action === 'get_status') return {
        ok: true, json: async () => ({ status: 'ok', data: { good: false, online: true } }),
      };
    } },
  });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await once(server, 'listening');
    const status = async (extra = {}) => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/status', {
        headers: { 'x-console-token': 'fixture-console-token', ...extra },
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    h.bot.emit('open');
    const polled = (await status()).snowluma;
    assert.equal(polled.connected, true);
    assert.equal(polled.goodSource, 'get_status');
    assert.equal(polled.good, false);
    assert.equal(polled.degraded, true);
    assert.equal(polled.accountOnline, true);

    h.bot.emit('event', { post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true } });
    const healthy = (await status()).snowluma;
    assert.equal(healthy.goodSource, 'heartbeat');
    assert.equal(healthy.good, true);
    assert.equal(healthy.degraded, false);
    assert.equal(healthy.lastPacketKind, 'meta_event/heartbeat');

    h.bot.emit('bot_status', { sub_type: 'offline' });
    assert.equal((await status()).snowluma.accountOnline, false);
    now += 61000;
    const silent = (await status()).snowluma;
    assert.equal(silent.silent, true);
    assert.equal(silent.good, true);
    assert.equal(silent.degraded, true);
    h.bot.emit('event', { post_type: 'message', message_type: 'group' });
    assert.equal((await status()).snowluma.degraded, false);
    const probe = await status({ 'x-agent-call': '1' });
    assert.equal('snowluma' in probe, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

test('reconnection persists refreshed credentials and respects the configured endpoint policy', async () => {
  const discovered = {
    ok: true, token: 'fixture-http', wsToken: 'fixture-ws',
    wsUrl: 'ws://127.0.0.1:9001', baseUrl: 'http://127.0.0.1:9000',
  };
  for (const follow of [undefined, false]) {
    const initial = { wsUrl: 'ws://127.0.0.1:8001', httpUrl: 'http://127.0.0.1:8000', followDiscoveredEndpoint: follow };
    const h = await bridgeHarness({ config: { snowluma: initial }, globals: {
      discoverSnowLumaConnection: async () => discovered, persistSnowLumaEndpoint,
    } });
    try {
      h.bot.emit('close', { code: 1006 });
      await new Promise(resolve => setImmediate(resolve));
      const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).snowluma;
      assert.equal(saved.accessToken, discovered.token);
      assert.equal(h.bot.accessToken, discovered.wsToken);
      assert.equal(saved.wsUrl, follow === false ? initial.wsUrl : discovered.wsUrl);
      assert.equal(saved.httpUrl, follow === false ? initial.httpUrl : discovered.baseUrl);
      assert.equal(h.bot.url, saved.wsUrl);
      h.bot.emit('open');
      const poll = h.calls.http.find(call => call.url.endsWith('/get_status'));
      assert.equal(poll?.url, saved.httpUrl + '/get_status', 'the running bridge follows the same HTTP endpoint');
    } finally { await h.close(); }
  }
});
