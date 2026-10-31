import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function start(options = {}) {
  const h = await bridgeHarness(options);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body, headers = {}) => {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
  const close = async () => { await new Promise((resolve) => server.close(resolve)); await h.close(); };
  return { h, call, readConfig, close };
}

const settings = (ownerQQ) => ({ result: { ok: true, value: { namespaces: [
  { ns: 'qq-agent-presets', user: { ownerQQ } },
] } } });

test('owner saves and clears independently, rejects invalid values, and keeps other config', async () => {
  const f = await start({ config: { deny: { groups: ['789'], private: [] }, custom: { keep: true }, sendDelayMs: 1000, security: { interceptNotify: true, keep: true } } });
  try {
    const before = f.readConfig();
    let result = await f.call('/api/whitelist', { ownerQQ: ' 987654 ' });
    assert.equal(result.status, 200);
    assert.equal(result.body.ownerQQ, 987654);
    assert.deepEqual(f.readConfig().allow, before.allow);
    assert.deepEqual(f.readConfig().deny, before.deny);
    assert.deepEqual(f.readConfig().custom, before.custom);
    assert.equal(Object.hasOwn(f.readConfig(), 'sendDelayMs'), false);
    assert.deepEqual(f.readConfig().security, { keep: true });
    assert.equal(f.readConfig().ownerQQSource, 'config');
    assert.equal((await f.call('/api/whitelist')).body.ownerQQ, 987654);
    const sessionId = await f.h.ensureDesktopAgentSession();
    const token = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state', 'desktop-agent.json'), 'utf8')).agentToken;
    const agent = { 'x-agent-token': token, 'x-agent-session-id': sessionId, 'x-agent-call': '1' };
    assert.deepEqual((await f.call('/api/desktop-agent/owner-identity', undefined, agent)).body,
      { ok: true, configured: true, ownerQQ: '987654' });
    assert.equal((await f.call('/api/desktop-agent/owner-identity')).status, 403);

    const saved = fs.readFileSync(path.join(f.h.temp, 'config.json'), 'utf8');
    for (const invalid of ['abc', '0', '-1', '9007199254740992']) {
      result = await f.call('/api/whitelist', { ownerQQ: invalid });
      assert.equal(result.status, 400, invalid);
      assert.equal(fs.readFileSync(path.join(f.h.temp, 'config.json'), 'utf8'), saved);
      assert.equal((await f.call('/api/whitelist')).body.ownerQQ, 987654);
    }
    result = await f.call('/api/whitelist', { ownerQQ: '' });
    assert.equal(result.status, 200);
    assert.equal(result.body.ownerQQ, null);
    assert.equal(f.readConfig().ownerQQ, null);
    assert.deepEqual((await f.call('/api/desktop-agent/owner-identity', undefined, agent)).body,
      { ok: true, configured: false, ownerQQ: null });
    f.h.api.settings.describe = async () => settings('456');
    await f.h.refreshBridgeSettings();
    assert.equal((await f.call('/api/whitelist')).body.ownerQQ, null);
  } finally { await f.close(); }
});

test('DSH fallback remains compatible, but local saves win over pending and future refreshes and restarts', async () => {
  const f = await start();
  let restarted;
  try {
    f.h.api.settings.describe = async () => settings('456');
    await f.h.refreshBridgeSettings();
    assert.equal((await f.call('/api/whitelist')).body.ownerQQ, 456);

    let finish;
    f.h.api.settings.describe = () => new Promise((resolve) => { finish = resolve; });
    const pending = f.h.refreshBridgeSettings();
    assert.equal((await f.call('/api/whitelist', { ownerQQ: '789' })).status, 200);
    finish(settings('456'));
    await pending;
    assert.equal((await f.call('/api/whitelist')).body.ownerQQ, 789);
    const saved = f.readConfig();
    restarted = await start({ config: saved });
    restarted.h.api.settings.describe = async () => settings('456');
    await restarted.h.refreshBridgeSettings();
    assert.equal((await restarted.call('/api/whitelist')).body.ownerQQ, 789);
    assert.equal((await restarted.call('/api/whitelist', { ownerQQ: '' })).status, 200);
    const cleared = restarted.readConfig();
    const afterClearRestart = await start({ config: cleared });
    try {
      afterClearRestart.h.api.settings.describe = async () => settings('456');
      await afterClearRestart.h.refreshBridgeSettings();
      assert.equal((await afterClearRestart.call('/api/whitelist')).body.ownerQQ, null);
    } finally { await afterClearRestart.close(); }
  } finally { if (restarted) await restarted.close(); await f.close(); }
});

test('test-send lists remain enforced, and invalid entries do not silently weaken them', async () => {
  const f = await start({ config: { deny: { groups: [], private: [] } } });
  try {
    let result = await f.call('/api/whitelist', { allow: { groups: ['456', '456'], private: ['123'] }, deny: { groups: ['789'], private: [] } });
    assert.equal(result.status, 200);
    assert.deepEqual(f.readConfig().allow.groups, [456]);
    assert.equal(f.readConfig().ownerQQ, 123);
    const saved = fs.readFileSync(path.join(f.h.temp, 'config.json'), 'utf8');
    result = await f.call('/api/whitelist', { allow: { groups: ['456', 'not-a-qq'] } });
    assert.equal(result.status, 400);
    assert.equal(fs.readFileSync(path.join(f.h.temp, 'config.json'), 'utf8'), saved);
    assert.equal((await f.call('/api/test-send', { kind: 'group', id: '456', message: 'test' })).status, 200);
    assert.equal((await f.call('/api/test-send', { kind: 'group', id: '789', message: 'test' })).status, 403);
    assert.equal((await f.call('/api/test-send', { kind: 'group', id: '999', message: 'test' })).status, 403);
    assert.equal(f.h.calls.sent.length, 1);
  } finally { await f.close(); }
});

test('configuration write failure and malformed configuration do not report success or change the owner', async () => {
  const f = await start({ globals: { hardenFile: () => ({ ok: false, detail: 'fixture failure' }) } });
  try {
    const file = path.join(f.h.temp, 'config.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal((await f.call('/api/whitelist', { ownerQQ: '456' })).status, 500);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal((await f.call('/api/whitelist')).body.ownerQQ, 123);
    fs.writeFileSync(file, '{ invalid');
    assert.equal((await f.call('/api/whitelist', { ownerQQ: '456' })).status, 500);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ invalid');
    assert.equal((await f.call('/api/whitelist')).body.ownerQQ, 123);
  } finally { await f.close(); }
});

test('all console configuration saves fail closed if file permissions cannot be hardened', async () => {
  const f = await start({ globals: { hardenFile: () => ({ ok: false, detail: 'fixture failure' }) } });
  try {
    const file = path.join(f.h.temp, 'config.json');
    const before = fs.readFileSync(file, 'utf8');
    const templates = (await f.call('/api/desktop-agent/prompt-templates')).body.templates;
    for (const [route, body] of [
      ['/api/desktop-agent/prompt-templates', { templates }],
      ['/api/dsh/model', { provider: 'example', model: 'example', reasoningEffort: 'max' }],
      ['/api/dsh/effort', { reasoningEffort: 'max' }],
      ['/api/socialV2/config', { enabled: true }],
      ['/api/console/token', { token: 'a-valid-console-token-for-test' }],
    ]) {
      const result = await f.call(route, body);
      assert.equal(result.status, 500, `${route}: ${JSON.stringify(result.body)}`);
      assert.equal(fs.readFileSync(file, 'utf8'), before, route);
    }
  } finally { await f.close(); }
});

test('cached messages and active members use the current owner, including after clearing', async () => {
  const f = await start();
  try {
    const st = f.h.getSocialV2State('group:456');
    st.recentMessages = [
      { seq: 1, userId: '123', sender: 'old', isOwner: true, ownerLabel: 'old label', isSelf: false },
      { seq: 2, userId: '999', sender: 'new', isOwner: false, ownerLabel: '', isSelf: false },
      { seq: 3, userId: null, sender: 'unknown', isOwner: true, ownerLabel: 'stale', isSelf: false },
      { seq: 4, sender: 'self', isOwner: true, ownerLabel: '我', isSelf: true },
    ];
    st.unread = st.recentMessages.slice(0, 3);
    const owners = async (route) => (await f.call(route)).body.messages.map((message) => [message.isOwner, message.ownerLabel]);
    assert.deepEqual(await owners('/api/socialV2/recent?key=group:456'), [
      [true, '配置关系对象（ownerQQ 123）'], [false, ''], [false, ''], [true, '我'],
    ]);
    assert.equal((await f.call('/api/whitelist', { ownerQQ: '999' })).status, 200);
    assert.deepEqual(await owners('/api/socialV2/unread?key=group:456'), [
      [false, ''], [true, '配置关系对象（ownerQQ 999）'], [false, ''],
    ]);
    const members = (await f.call('/api/socialV2/active-members?key=group:456')).body.members;
    assert.equal(members.find((member) => member.userId === '123').isOwner, false);
    assert.equal(members.find((member) => member.userId === '999').isOwner, true);
    assert.equal(members.find((member) => member.sender === 'unknown').isOwner, false);
    assert.equal((await f.call('/api/whitelist', { ownerQQ: '' })).status, 200);
    assert.deepEqual(await owners('/api/socialV2/unread?key=group:456'), [[false, ''], [false, ''], [false, '']]);
  } finally { await f.close(); }
});

test('QQ tools remain available across simultaneous sources with valid session credentials', async () => {
  const f = await start();
  try {
    const sessionId = await f.h.ensureDesktopAgentSession();
    f.h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId, running: false }] } } });
    f.h.setDesktopAgentLifecycle('active');
    f.h.setDesktopAgentTurnActive(false);
    f.h.queueDesktopAttentionSignal({ key: 'group:456', kind: 'group', id: '456', reason: 'atMention', sender: 'user', senderId: '321', messageId: '55', seq: 1, isOwner: false });
    await f.h.flushAttentionNow();
    const token = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state', 'desktop-agent.json'), 'utf8')).agentToken;
    const agent = { 'x-agent-token': token, 'x-agent-session-id': sessionId, 'x-agent-call': '1' };
    f.h.queueDesktopAttentionSignal({ key: 'private:789', kind: 'private', id: '789', reason: 'privateMessage', sender: 'user', senderId: '789', messageId: '56', seq: 2, isOwner: false });
    for (const key of ['group:456', 'private:789', 'group:999']) {
      assert.equal((await f.call(`/api/socialV2/state?key=${key}`, undefined, agent)).status, 200, key);
    }
    assert.equal((await f.call('/api/whitelist', { ownerQQ: '' })).status, 200);
    assert.equal((await f.call('/api/socialV2/state?key=private:789', undefined, agent)).status, 200);
    f.h.getSocialV2State('private:789').lastIncomingAt = Date.now() - 30000;
    assert.equal((await f.call('/api/socialV2/wait', { key: 'private:789', purpose: 'reply', timeoutMs: 5000, quietMs: 10000 }, agent)).status, 200);
    assert.equal((await f.call('/api/socialV2/state?key=group:456', undefined, { ...agent, 'x-agent-token': 'invalid' })).status, 403);
    assert.equal((await f.call('/api/socialV2/conversations', undefined, { 'x-agent-token': 'invalid', 'x-agent-session-id': sessionId })).status, 403);
    assert.equal((await f.call('/api/socialV2/state?key=group:456', undefined, { ...agent, 'x-agent-session-id': 'other-session' })).status, 403);
    assert.equal((await f.call('/api/whitelist', { ownerQQ: '999' }, agent)).status, 403);
  } finally { await f.close(); }
});

test('changing owner does not revoke a local console task authorization', async () => {
  const f = await start();
  try {
    const sessionId = await f.h.ensureDesktopAgentSession();
    f.h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId, running: false }] } } });
    assert.equal((await f.call('/api/console/desktop-agent', { message: 'local task' })).status, 200);
    const token = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state', 'desktop-agent.json'), 'utf8')).agentToken;
    const agent = { 'x-agent-token': token, 'x-agent-session-id': sessionId, 'x-agent-call': '1' };
    assert.equal((await f.call('/api/socialV2/state?key=group:789', undefined, agent)).status, 200);
    assert.equal((await f.call('/api/whitelist', { ownerQQ: '999' })).status, 200);
    assert.equal((await f.call('/api/socialV2/state?key=group:789', undefined, agent)).status, 200);
  } finally { await f.close(); }
});
