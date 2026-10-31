import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverDshBaseUrl, NodeApiClient } from '../src/dsh-client.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('discovery selects a verified desktop port and refuses ambiguous candidates', async () => {
  const runProcess = async () => ({ stdout: '40101\n40102\n' });
  let available = new Set([40101]);
  const fetchImpl = async (url) => ({
    status: available.has(Number(url.port)) ? 401 : 404,
    body: { cancel: async () => {} }
  });
  const options = { platform: 'win32', runProcess, fetchImpl };
  assert.equal((await discoverDshBaseUrl('http://127.0.0.1:3080', options)).baseUrl, 'http://127.0.0.1:40101');
  available = new Set([40101, 40102]);
  assert.equal((await discoverDshBaseUrl('http://127.0.0.1:3080', options)).source, 'ambiguous');
  assert.equal((await discoverDshBaseUrl('http://127.0.0.1:40102', options)).baseUrl, 'http://127.0.0.1:40102');
  available.clear();
  assert.equal((await discoverDshBaseUrl('http://127.0.0.1:3080', options)).source, 'fallback');
  assert.equal((await discoverDshBaseUrl('http://example.test:3080', options)).source, 'configured');
});

test('switching port refreshes the authority-bound cookie and preserves subscriptions', async () => {
  const client = new NodeApiClient('http://127.0.0.1:40101', 1000, {});
  client._secret = Buffer.alloc(32, 7);
  const oldCookie = await client.ensureAuth();
  client._desiredFollows.add('existing-session');
  assert.equal(client.setBaseUrl('http://127.0.0.1:40102'), true);
  assert.equal(client.cookie, null);
  client._secret = Buffer.alloc(32, 7);
  const newCookie = await client.ensureAuth();
  assert.notEqual(newCookie, oldCookie);
  assert.equal(JSON.parse(Buffer.from(newCookie.split('.')[1], 'base64url').toString()).authority, '127.0.0.1:40102');
  assert.ok(client._desiredFollows.has('existing-session'));
  assert.equal(client.setBaseUrl('http://127.0.0.1:40102'), false);
});

test('offline bridge rediscovers on startup and after port change without guessing', async () => {
  let endpoint = { baseUrl: 'http://127.0.0.1:3080', source: 'fallback', candidates: [] };
  let reachable = '';
  let checks = 0;
  const h = await bridgeHarness({ globals: { discoverDshBaseUrl: async () => endpoint } });
  try {
    h.setReady(false);
    h.api.settings.describe = async () => {
      checks += 1;
      if (h.api.baseUrl !== reachable) throw new Error('offline');
      return { result: { ok: true, value: { namespaces: [] } } };
    };
    assert.equal(await h.checkDsh(), false);
    reachable = 'http://127.0.0.1:40101';
    endpoint = { baseUrl: reachable, source: 'desktop', candidates: [reachable] };
    assert.equal(await h.checkDsh(), true);
    assert.equal(h.api.baseUrl, reachable);
    reachable = '';
    assert.equal(await h.checkDsh(), false);
    endpoint = { baseUrl: 'http://127.0.0.1:3080', source: 'ambiguous', candidates: ['http://127.0.0.1:40101', 'http://127.0.0.1:40102'] };
    const before = checks;
    assert.equal(await h.checkDsh(), false);
    assert.equal(checks, before, 'ambiguous discovery must not connect to an arbitrary instance');
    reachable = 'http://127.0.0.1:40102';
    endpoint = { baseUrl: reachable, source: 'desktop', candidates: [reachable] };
    assert.equal(await h.checkDsh(), true);
    assert.equal(h.api.baseUrl, reachable);
  } finally {
    await h.close();
  }
});
