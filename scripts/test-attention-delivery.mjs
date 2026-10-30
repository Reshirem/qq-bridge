import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function fakeTimers() {
  const timers = new Set();
  return {
    setTimeout(fn, ms) {
      const timer = { fn, ms, unref() { return this; } };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
    has(ms) { return [...timers].some((timer) => timer.ms === ms); },
    run(ms) {
      const timer = [...timers].find((item) => item.ms === ms);
      assert.ok(timer, `no timer scheduled for ${ms} ms`);
      timers.delete(timer);
      timer.fn();
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function signal(key = 'group:456', seq = 1) {
  return { key, kind: 'group', id: '456', reason: 'atMention', sender: '群友', senderId: '123', messageId: '55', seq };
}

async function fixture() {
  const clock = fakeTimers();
  const h = await bridgeHarness({ globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } });
  const sessionId = await h.ensureDesktopAgentSession();
  let running = true;
  h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId, running, blank: false }] } } });
  h.setDesktopAgentLifecycle('active');
  h.setDesktopAgentTurnActive(true);
  return { h, clock, setRunning(value) { running = value; } };
}

test('active turn receives QQ metadata at its next step; read messages need no reminder', async () => {
  const { h, clock } = await fixture();
  try {
    h.queueDesktopAttentionSignal(signal());
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].mode, 'steer');
    assert.equal(h.calls.prompts[0].content[0].text, '【QQ 提醒】\n- group:456，发送者 QQ 123，消息 id:55');
    assert.equal(h.attentionSnapshot().unresolved[0].promptedSeq, 1);
    assert.equal(h.acknowledgeDesktopAttentionThrough('group:456', 1), true);
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    assert.equal(h.attentionSnapshot().reminderScheduled, false);
    assert.equal(clock.has(60_000), false);
  } finally { await h.close(); }
});

test('unread signal is reminded only once after a one-minute rest check', async () => {
  const { h, clock, setRunning } = await fixture();
  try {
    h.queueDesktopAttentionSignal(signal());
    await h.flushAttentionNow();
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    setRunning(false);
    assert.equal(clock.has(60_000), true);
    clock.run(60_000);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.prompts[1].content[0].text, '【QQ 提醒】\n- group:456，发送者 QQ 123，消息 id:55');
    assert.equal(h.attentionSnapshot().unresolved[0].reminderSent, true);
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    assert.equal(h.attentionSnapshot().reminderScheduled, false);
  } finally { await h.close(); }
});

test('acceptance after entering rest is tracked for the later reminder', async () => {
  const { h, clock } = await fixture();
  try {
    const entered = deferred();
    const response = deferred();
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      entered.resolve();
      return response.promise;
    };
    h.queueDesktopAttentionSignal(signal());
    const pending = h.flushAttentionNow();
    await entered.promise;
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    response.resolve({ result: { ok: true, value: {} } });
    await pending;
    const state = h.attentionSnapshot();
    assert.equal(state.lifecycle, 'resting');
    assert.equal(state.queue.length, 0);
    assert.equal(state.unresolved[0].promptedSeq, 1);
    assert.equal(clock.has(60_000), true);
  } finally { await h.close(); }
});

test('a failed signal does not place a still-running turn into recovery', async () => {
  const { h, clock } = await fixture();
  try {
    h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'test', message: 'unavailable' } } });
    h.queueDesktopAttentionSignal(signal());
    await h.flushAttentionNow();
    const state = h.attentionSnapshot();
    assert.equal(state.lifecycle, 'active');
    assert.equal(state.turnActive, true);
    assert.equal(state.queue.length, 1);
    assert.equal(clock.has(60_000), true);
  } finally { await h.close(); }
});

test('a signal arriving during a pending submission is scheduled after it settles', async () => {
  const { h, clock } = await fixture();
  try {
    const entered = deferred();
    const response = deferred();
    let count = 0;
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      if (++count === 1) { entered.resolve(); return response.promise; }
      return { result: { ok: true, value: {} } };
    };
    h.queueDesktopAttentionSignal(signal());
    const pending = h.flushAttentionNow();
    await entered.promise;
    h.queueDesktopAttentionSignal(signal('group:789', 2));
    clock.run(5_000);
    response.resolve({ result: { ok: true, value: {} } });
    await pending;
    assert.equal(h.attentionSnapshot().flushScheduled, true);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 2);
    assert.match(h.calls.prompts[1].content[0].text, /group:789/);
  } finally { await h.close(); }
});

test('an unaccepted signal requeued after entering rest wakes the session', async () => {
  const { h } = await fixture();
  try {
    const entered = deferred();
    const response = deferred();
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      entered.resolve();
      return response.promise;
    };
    h.queueDesktopAttentionSignal(signal());
    const pending = h.flushAttentionNow();
    await entered.promise;
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    response.resolve({ result: { ok: false, error: { code: 'test', message: 'unavailable' } } });
    await pending;
    const state = h.attentionSnapshot();
    assert.equal(state.lifecycle, 'active');
    assert.equal(state.queue.length, 1);
    assert.equal(state.flushScheduled, true);
  } finally { await h.close(); }
});

test('signals remain queued without reminders during recovery', async () => {
  const { h, clock } = await fixture();
  try {
    h.setDesktopAgentLifecycle('recovering');
    h.queueDesktopAttentionSignal(signal());
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.attentionSnapshot().queue.length, 1);
    assert.equal(h.attentionSnapshot().reminderScheduled, false);
    assert.equal(clock.has(60_000), false);
  } finally { await h.close(); }
});

test('merged signals show the latest message and the count', async () => {
  const { h } = await fixture();
  try {
    h.queueDesktopAttentionSignal(signal());
    h.queueDesktopAttentionSignal({ ...signal('group:456', 2), messageId: '99' });
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts[0].content[0].text, '【QQ 提醒】\n- group:456，发送者 QQ 123，消息 id:99，合并 2 条提醒');
  } finally { await h.close(); }
});

test('older signals cannot replace the latest message metadata', async () => {
  const { h } = await fixture();
  try {
    h.queueDesktopAttentionSignal({ ...signal('group:456', 20), messageId: '200' });
    h.queueDesktopAttentionSignal({ ...signal('group:456', 19), messageId: '100' });
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts[0].content[0].text, '【QQ 提醒】\n- group:456，发送者 QQ 123，消息 id:200，合并 2 条提醒');
    assert.equal(h.attentionSnapshot().unresolved[0].seq, 20);
  } finally { await h.close(); }
});

test('a requeued newer message retains its own ID when older data is already queued', async () => {
  const { h } = await fixture();
  try {
    const entered = deferred();
    const response = deferred();
    let count = 0;
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      if (++count === 1) { entered.resolve(); return response.promise; }
      return { result: { ok: true, value: {} } };
    };
    h.queueDesktopAttentionSignal({ ...signal('group:456', 20), messageId: '200' });
    const pending = h.flushAttentionNow();
    await entered.promise;
    h.queueDesktopAttentionSignal({ ...signal('group:456', 19), messageId: '100' });
    response.resolve({ result: { ok: false, error: { code: 'test', message: 'unavailable' } } });
    await pending;
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts[1].content[0].text, '【QQ 提醒】\n- group:456，发送者 QQ 123，消息 id:200，合并 2 条提醒');
  } finally { await h.close(); }
});

test('local sequence locates a message when QQ did not supply an ID', async () => {
  const { h } = await fixture();
  try {
    h.queueDesktopAttentionSignal({ ...signal('group:456', 7), messageId: null });
    await h.flushAttentionNow();
    assert.match(h.calls.prompts[0].content[0].text, /^【QQ 提醒】\n- group:456，发送者 QQ 123，消息 seq:7@[0-9a-f-]{36}$/);
  } finally { await h.close(); }
});

test('a persisted QQ wake without a surviving source batch still has a non-empty cue', async () => {
  const { h, setRunning } = await fixture();
  try {
    h.setDesktopAgentTurnActive(false);
    h.setDesktopAgentPendingWakeReason('qq-attention');
    setRunning(false);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts[0].content[0].text, '【QQ 提醒】\n- 来源未保留');
  } finally { await h.close(); }
});
