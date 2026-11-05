import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function message(userId, body) {
  return { self_id: 42, user_id: userId, message_id: 99, sender: { nickname: '测试' },
    message: [{ type: 'text', data: { text: body } }] };
}

test('owner 私聊睡眠会丢弃提醒、持久保存并可恢复', async () => {
  const h = await bridgeHarness();
  let restored;
  try {
    await h.ensureDesktopAgentSession();
    h.setDesktopAgentLifecycle('active');
    h.setDesktopAgentTurnActive(true);
    await h.handleIncomingForTest('private', 789, message(789, '之前的消息'));
    assert.equal(h.attentionSnapshot().queue.length, 1);
    await h.handleIncomingForTest('private', 123, message(123, '/睡觉'));
    assert.equal(h.attentionSnapshot().lifecycle, 'sleeping');
    assert.equal(h.attentionSnapshot().queue.length, 0);
    assert.equal(h.attentionSnapshot().unresolved.length, 0);
    assert.ok(h.calls.cancelled.length > 0);
    await h.handleIncomingForTest('private', 789, message(789, '睡眠中的消息'));
    assert.equal(h.attentionSnapshot().queue.length, 0);
    assert.equal(h.getSocialV2State('private:789').unread.length, 2);
    const persisted = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/desktop-agent.json'), 'utf8'));
    assert.equal(persisted.lifecycle, 'sleeping');
    restored = await bridgeHarness({ files: { 'state/desktop-agent.json': persisted } });
    assert.equal(restored.attentionSnapshot().lifecycle, 'sleeping');
    await restored.handleIncomingForTest('private', 123, message(123, '/起床'));
    assert.equal(restored.attentionSnapshot().lifecycle, 'active');
    await restored.flushAttentionNow();
    assert.equal(restored.calls.prompts.length, 1);
    assert.equal(restored.attentionSnapshot().queue.length, 0);
  } finally { if (restored) await restored.close(); await h.close(); }
});

test('只有 owner 的纯文本私聊命令能改变睡眠状态', async () => {
  const h = await bridgeHarness();
  try {
    h.setDesktopAgentLifecycle('active');
    await h.handleIncomingForTest('private', 789, message(789, '/睡觉'));
    await h.handleIncomingForTest('group', 456, message(123, '/睡觉'));
    const quoted = message(123, '/睡觉');
    quoted.message.unshift({ type: 'reply', data: { id: '55' } });
    await h.handleIncomingForTest('private', 123, quoted);
    assert.equal(h.attentionSnapshot().lifecycle, 'active');
    await h.handleIncomingForTest('private', 123, message(123, '/睡觉'));
    await h.handleIncomingForTest('private', 789, message(789, '/起床'));
    assert.equal(h.attentionSnapshot().lifecycle, 'sleeping');
    assert.equal(h.calls.sent.length, 1);
  } finally { await h.close(); }
});

test('睡眠等待正在提交的提醒后取消回合，起床不会被旧取消覆盖', async () => {
  const h = await bridgeHarness();
  try {
    await h.ensureDesktopAgentSession();
    h.setDesktopAgentLifecycle('active');
    let release;
    let submitted;
    const inFlight = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { submitted = resolve; });
    h.api.sessions.prompt = async () => { submitted(); return inFlight; };
    await h.handleIncomingForTest('private', 789, message(789, '测试消息'));
    const flush = h.flushAttentionNow();
    await started;
    const sleeping = h.handleIncomingForTest('private', 123, message(123, '/睡觉'));
    assert.equal(h.attentionSnapshot().lifecycle, 'sleeping');
    const waking = h.handleIncomingForTest('private', 123, message(123, '/起床'));
    release({ result: { ok: true, value: {} } });
    await Promise.all([flush, sleeping, waking]);
    assert.equal(h.attentionSnapshot().lifecycle, 'active');
    assert.equal(h.calls.cancelled.length, 2);
    assert.equal(h.attentionSnapshot().queue.length, 0);
  } finally { await h.close(); }
});

test('睡眠期间 WebUI 任务和 agent_rest 不能解除睡眠', async () => {
  const h = await bridgeHarness();
  let server;
  try {
    const sessionId = await h.ensureDesktopAgentSession();
    await h.handleIncomingForTest('private', 123, message(123, '/睡觉'));
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const token = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/desktop-agent.json'), 'utf8')).agentToken;
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, headers, body) => fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await post('/api/console/desktop-agent', { 'x-console-token': 'fixture-console-token' }, { message: '任务' })).status, 409);
    assert.equal((await post('/api/console/desktop-agent/reset', { 'x-console-token': 'fixture-console-token' }, {})).status, 409);
    assert.equal((await post('/api/desktop-agent/rest', { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'x-agent-session-id': sessionId, 'x-agent-call': '1' }, {})).status, 409);
    assert.equal(h.attentionSnapshot().lifecycle, 'sleeping');
  } finally { if (server) await new Promise((resolve) => server.close(resolve)); await h.close(); }
});
