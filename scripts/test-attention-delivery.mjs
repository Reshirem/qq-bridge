import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    has(ms, tolerance = 0) { return [...timers].some((timer) => Math.abs(timer.ms - ms) <= tolerance); },
    run(ms, tolerance = 0) {
      const timer = [...timers].find((item) => Math.abs(item.ms - ms) <= tolerance);
      assert.ok(timer, `no timer scheduled for ${ms} ms`);
      timers.delete(timer);
      return timer.fn();
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
  return { h, clock, sessionId, setRunning(value) { running = value; } };
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

// Deliver one frame through the real event loop, then hold the fake stream open.
async function deliverFrame(h, frame) {
  const consumed = deferred();
  h.api.events.mux = async function* () {
    yield { payload: frame };
    consumed.resolve();
    await new Promise(() => {});
  };
  void h.pumpMux();
  await consumed.promise;
}

const turnEnd = (sessionId, kind = 'completed') => ({
  type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn: 1, reason: { kind } } },
});

test('normal completion without agent_rest immediately sends a specific reminder, not automatic rest', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    setRunning(false);
    await deliverFrame(h, turnEnd(sessionId));
    assert.equal(h.attentionSnapshot().lifecycle, 'active');
    assert.equal(h.attentionSnapshot().restUntil, 0);
    assert.equal(h.attentionSnapshot().pendingWakeReason, 'missing-rest');
    assert.equal(clock.has(0), true);
    assert.equal(clock.has(60_000), false);
    await deliverFrame(h, turnEnd(sessionId));
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1, 'duplicate completion coalesces before delivery');
    assert.equal(h.calls.prompts[0].sessionId, sessionId);
    assert.equal(h.calls.prompts[0].mode, 'queue');
    assert.match(h.calls.prompts[0].content[0].text, /回合收尾提醒.*agent_rest/);
    assert.equal(h.attentionSnapshot().lifecycle, 'active');
    assert.equal(h.attentionSnapshot().restUntil, 0, 'only the tool may enter rest');
    assert.equal(JSON.parse(fs.readFileSync(h.temp + '/state/desktop-agent.json', 'utf8')).restReminderSent, true);
    h.enterDesktopAgentRest(120_000);
    assert.equal(h.attentionSnapshot().lifecycle, 'resting');
    assert.equal(JSON.parse(fs.readFileSync(h.temp + '/state/desktop-agent.json', 'utf8')).restReminderSent, false);
  } finally { await h.close(); }
});

test('repeated missed rest backs off and retries the specific reminder', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    setRunning(false);
    await deliverFrame(h, turnEnd(sessionId));
    await h.flushAttentionNow();
    await deliverFrame(h, turnEnd(sessionId));
    assert.equal(h.attentionSnapshot().lifecycle, 'recovering');
    assert.equal(h.attentionSnapshot().pendingWakeReason, 'missing-rest');
    assert.equal(clock.has(0), false);
    await clock.run(60_000, 1000);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 2);
    assert.match(h.calls.prompts[1].content[0].text, /回合收尾提醒/);
    await deliverFrame(h, turnEnd(sessionId));
    await clock.run(120_000, 1000);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 3);
    assert.equal(h.attentionSnapshot().restUntil, 0);
  } finally { await h.close(); }
});

for (const firstPrompt of ['rest reminder', 'QQ attention']) {
  test(`completion before the ${firstPrompt} submission returns still schedules the next reminder`, async () => {
    const { h, clock, sessionId, setRunning } = await fixture();
    try {
      setRunning(false);
      if (firstPrompt === 'rest reminder') await deliverFrame(h, turnEnd(sessionId));
      else h.queueDesktopAttentionSignal(signal());
      h.api.sessions.prompt = async (params) => {
        h.calls.prompts.push(params);
        await deliverFrame(h, { type: 'session/event', sessionId, event: { type: 'turn/start' } });
        await deliverFrame(h, turnEnd(sessionId));
        return { result: { ok: true, value: {} } };
      };
      await h.flushAttentionNow();
      const state = h.attentionSnapshot();
      assert.equal(state.turnActive, false, 'the late RPC receipt cannot overwrite turn/end');
      assert.equal(state.pendingWakeReason, 'missing-rest');
      assert.equal(state.restUntil, 0);
      assert.equal(state.lifecycle, firstPrompt === 'rest reminder' ? 'recovering' : 'active');
      assert.equal(clock.has(60_000, 1000), firstPrompt === 'rest reminder');
      assert.equal(clock.has(0), firstPrompt === 'QQ attention');
      assert.equal(h.calls.prompts.length, 1);
    } finally { await h.close(); }
  });
}

test('a failed reminder submission keeps its purpose for a later retry', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    setRunning(false);
    const prompt = h.api.sessions.prompt;
    h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'offline', message: 'unavailable' } } });
    await deliverFrame(h, turnEnd(sessionId));
    await h.flushAttentionNow();
    assert.equal(h.attentionSnapshot().lifecycle, 'recovering');
    assert.equal(h.attentionSnapshot().pendingWakeReason, 'missing-rest');
    assert.equal(h.attentionSnapshot().restUntil, 0);
    h.api.sessions.prompt = prompt;
    await clock.run(60_000, 1000);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.match(h.calls.prompts[0].content[0].text, /回合收尾提醒/);
  } finally { await h.close(); }
});

test('disabling a QQ reminder during preparation does not swallow a concurrent turn end', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    setRunning(false);
    const list = h.api.sessions.list;
    h.api.sessions.list = async () => {
      h.api.sessions.list = list;
      await deliverFrame(h, turnEnd(sessionId));
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/config`, {
        method: 'POST', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' },
        body: JSON.stringify({ reminders: { atMention: false } }),
      });
      assert.equal(response.status, 200);
      return list();
    };
    h.queueDesktopAttentionSignal(signal());
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 0, 'the disabled QQ signal was not delivered');
    assert.equal(h.attentionSnapshot().turnActive, false);
    assert.equal(h.attentionSnapshot().pendingWakeReason, 'missing-rest');
    assert.equal(clock.has(0), true);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.match(h.calls.prompts[0].content[0].text, /回合收尾提醒/);
    assert.doesNotMatch(h.calls.prompts[0].content[0].text, /group:456/);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('an interrupted turn keeps the ordinary recovery path', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    setRunning(false);
    await deliverFrame(h, turnEnd(sessionId, 'error'));
    assert.equal(h.attentionSnapshot().lifecycle, 'recovering');
    assert.equal(h.attentionSnapshot().pendingWakeReason, 'recovery');
    assert.equal(clock.has(0), false);
    await clock.run(60_000, 1000);
    await h.flushAttentionNow();
    assert.match(h.calls.prompts[0].content[0].text, /状态恢复检查/);
  } finally { await h.close(); }
});

for (const lifecycle of ['resting', 'sleeping', 'stopped', 'idle']) {
  test(`${lifecycle}: completion does not send a missing-rest reminder`, async () => {
    const { h, sessionId, setRunning } = await fixture();
    try {
      setRunning(false);
      h.setDesktopAgentLifecycle(lifecycle);
      await deliverFrame(h, turnEnd(sessionId));
      await h.flushAttentionNow();
      assert.equal(h.calls.prompts.length, 0);
      assert.equal(h.attentionSnapshot().lifecycle, lifecycle);
    } finally { await h.close(); }
  });
}

test('a completed snapshot corrects legacy recovery once and preserves the reminder guard after restart', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  let restored;
  try {
    setRunning(false);
    h.setDesktopAgentTurnActive(false);
    h.scheduleDesktopAgentRecovery();
    const snapshot = { type: 'session/snapshot', sessionId, snapshot: { records: [{ event: turnEnd(sessionId).event }] } };
    await deliverFrame(h, snapshot);
    assert.equal(clock.has(60_000), false);
    assert.equal(h.attentionSnapshot().pendingWakeReason, 'missing-rest');
    await h.flushAttentionNow();
    await deliverFrame(h, turnEnd(sessionId));
    const persisted = fs.readFileSync(h.temp + '/state/desktop-agent.json', 'utf8');
    const restartClock = fakeTimers();
    restored = await bridgeHarness({ files: { 'state/desktop-agent.json': persisted },
      globals: { setTimeout: restartClock.setTimeout, clearTimeout: restartClock.clearTimeout } });
    restored.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId, running: false, blank: false }] } } });
    await deliverFrame(restored, snapshot);
    assert.equal(restored.attentionSnapshot().lifecycle, 'recovering');
    assert.equal(restored.attentionSnapshot().pendingWakeReason, 'missing-rest');
    assert.equal(restartClock.has(0), false, 'reconnecting must not repeat the immediate reminder');
    assert.equal(restored.calls.prompts.length, 0);
  } finally { if (restored) await restored.close(); await h.close(); }
});

test('a pending rest reminder waits for a new running turn to finish', async () => {
  const { h, sessionId, setRunning } = await fixture();
  try {
    setRunning(false);
    await deliverFrame(h, turnEnd(sessionId));
    setRunning(true);
    await deliverFrame(h, { type: 'session/event', sessionId, event: { type: 'turn/start' } });
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 0);
    setRunning(false);
    await deliverFrame(h, turnEnd(sessionId));
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.match(h.calls.prompts[0].content[0].text, /回合收尾提醒/);
  } finally { await h.close(); }
});

for (const resumedBy of ['turn/start', 'retry deadline', 'DSH reconnect']) {
  test(`a running session picks up QQ queued during recovery on ${resumedBy}`, async () => {
    const { h, clock, sessionId } = await fixture();
    try {
      h.setDesktopAgentTurnActive(false);
      h.scheduleDesktopAgentRecovery();
      h.queueDesktopAttentionSignal(signal());
      assert.equal(h.attentionSnapshot().flushScheduled, false);
      if (resumedBy === 'turn/start') {
        await deliverFrame(h, { type: 'session/event', sessionId, event: { type: 'turn/start' } });
      } else if (resumedBy === 'retry deadline') {
        // The deadline is derived from Date.now() before the timer is armed.
        await clock.run(60_000, 1000);
      } else {
        h.calls.follows.length = 0;
        await h.reconcileDesktopAgentLifecycle();
        assert.deepEqual(h.calls.follows, [sessionId]);
      }
      const state = h.attentionSnapshot();
      assert.equal(state.lifecycle, 'active');
      assert.equal(state.pendingWakeReason, '');
      assert.equal(state.flushScheduled, true);
      clock.run(0);
      await h.flushAttentionNow();
      assert.equal(h.calls.prompts.length, 1);
      assert.equal(h.calls.prompts[0].mode, 'steer');
      assert.equal(h.calls.prompts[0].content[0].text, '【QQ 提醒】\n- group:456，发送者 QQ 123，消息 id:55');
    } finally { await h.close(); }
  });
}

test('a reconnected session stream recovers a missed turn end while QQ is waiting to interrupt rest', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    h.enterDesktopAgentRest();
    h.queueDesktopAttentionSignal(signal());
    assert.equal(h.attentionSnapshot().flushScheduled, false);
    setRunning(false);
    const records = [{ type: 'event', event: { type: 'turn/end', seq: 10, data: { turn: 1 } } }];
    await deliverFrame(h, { type: 'session/snapshot', sessionId, snapshot: { records } });
    assert.equal(h.attentionSnapshot().lifecycle, 'active');
    clock.run(0);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.match(h.calls.prompts[0].content[0].text, /消息 id:55/);
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
