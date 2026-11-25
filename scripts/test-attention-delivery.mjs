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
    list() { return [...timers].map((timer) => timer.ms); },
    run(ms, tolerance = 0) {
      const timer = [...timers].find((item) => Math.abs(item.ms - ms) <= tolerance);
      assert.ok(timer, `no timer scheduled for ${ms} ms (scheduled: ${[...timers].map((t) => t.ms).join(', ')})`);
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

test('unread signal is reminded only once after a 5-second post-rest settle check', async () => {
  const { h, clock, setRunning } = await fixture();
  try {
    h.queueDesktopAttentionSignal(signal());
    await h.flushAttentionNow();
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    setRunning(false);
    assert.equal(clock.has(5_000), true);
    clock.run(5_000);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.prompts[1].content[0].text, '【QQ 提醒】\n- group:456，发送者 QQ 123，消息 id:55');
    assert.equal(h.attentionSnapshot().unresolved[0].reminderSent, true);
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    assert.equal(h.attentionSnapshot().reminderScheduled, false);
  } finally { await h.close(); }
});

test('acceptance after entering rest is tracked for the 5-second reminder', async () => {
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
    assert.equal(clock.has(5_000), true);
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

test('normal completion without agent_rest automatically enters default 30-minute resting without missing-rest prompt', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    setRunning(false);
    await deliverFrame(h, turnEnd(sessionId));
    assert.equal(h.attentionSnapshot().lifecycle, 'resting');
    assert.equal(h.attentionSnapshot().pendingWakeReason, '');
    const remaining = h.attentionSnapshot().restUntil - Date.now();
    assert.ok(remaining <= 1_800_000 && remaining > 1_790_000, `expected 30m default implicit rest, got ${remaining}`);
    assert.equal(h.calls.prompts.length, 0, 'no missing-rest nag prompt should be sent');
    assert.equal(h.calls.cancelled.some((c) => c.method === 'session/cancel'), false, 'implicit rest must not send session/cancel after completed turn');
    assert.equal(clock.has(1_800_000, 1000), true);
    const saved = JSON.parse(fs.readFileSync(h.temp + '/state/desktop-agent.json', 'utf8'));
    assert.equal(saved.lifecycle, 'resting');
  } finally { await h.close(); }
});

test('completion before a QQ attention submission returns enters implicit rest without losing turn/end', async () => {
  const { h, sessionId, setRunning } = await fixture();
  try {
    setRunning(false);
    h.queueDesktopAttentionSignal(signal());
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      await deliverFrame(h, { type: 'session/event', sessionId, event: { type: 'turn/start' } });
      await deliverFrame(h, turnEnd(sessionId));
      return { result: { ok: true, value: {} } };
    };
    await h.flushAttentionNow();
    const state = h.attentionSnapshot();
    assert.equal(state.turnActive, false, 'the late RPC receipt cannot overwrite turn/end');
    assert.equal(state.lifecycle, 'resting');
    assert.ok(state.restUntil > Date.now());
    assert.equal(h.calls.prompts.length, 1);
  } finally { await h.close(); }
});

test('disabling a QQ reminder during preparation does not swallow a concurrent turn end', async () => {
  const { h, sessionId, setRunning } = await fixture();
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
    assert.equal(h.attentionSnapshot().lifecycle, 'resting', 'concurrent completed turn still transitions cleanly to implicit rest');
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
  test(`${lifecycle}: completion does not send an unexpected prompt`, async () => {
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

test('a completed snapshot resolves legacy recovery cleanly into implicit rest', async () => {
  const { h, sessionId, setRunning } = await fixture();
  try {
    setRunning(false);
    h.setDesktopAgentTurnActive(false);
    h.scheduleDesktopAgentRecovery();
    const snapshot = { type: 'session/snapshot', sessionId, snapshot: { records: [{ event: turnEnd(sessionId).event }] } };
    await deliverFrame(h, snapshot);
    assert.equal(h.attentionSnapshot().lifecycle, 'resting');
    assert.equal(h.attentionSnapshot().pendingWakeReason, '');
    assert.ok(h.attentionSnapshot().restUntil > Date.now());
    assert.equal(h.calls.prompts.length, 0);
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

test('lifecycle reconnect reads only the current session state and retains a cold existing session', async () => {
  const { h, sessionId } = await fixture();
  try {
    const reads = [];
    h.api.sessions.list = async () => { throw new Error('single-session reconciliation must not list history'); };
    h.api.readSessionState = async (id) => {
      reads.push(id);
      return { cursor: 12, active: false, running: false, queue: null, pendingInput: [] };
    };
    h.calls.follows.length = 0;
    await h.reconcileDesktopAgentLifecycle();
    assert.deepEqual(reads, [sessionId]);
    assert.deepEqual(h.calls.follows, [sessionId]);
    assert.equal(h.attentionSnapshot().turnActive, false);
    assert.equal(h.calls.created.length, 1);
  } finally { await h.close(); }
});

test('a reconnected session stream recovers a missed turn end while QQ is waiting to interrupt rest (5s settle)', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    h.enterDesktopAgentRest();
    h.queueDesktopAttentionSignal(signal());
    assert.equal(h.attentionSnapshot().flushScheduled, false);
    setRunning(false);
    const records = [{ type: 'event', event: { type: 'turn/end', seq: 10, data: { turn: 1 } } }];
    await deliverFrame(h, { type: 'session/snapshot', sessionId, snapshot: { records } });
    assert.equal(h.attentionSnapshot().lifecycle, 'active');
    assert.equal(clock.has(5_000), true);
    clock.run(5_000);
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

test('rest-expired wake includes compact unread summary with hot groups first', async () => {
  const { h, setRunning } = await fixture();
  try {
    h.setDesktopAgentTurnActive(false);
    setRunning(false);
    h.setDesktopAgentPendingWakeReason('rest-expired');
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.at(-1).content[0].text, '【自由活动时间｜QQ 暂无新未读】');

    h.queueDesktopAttentionSignal(signal('group:456', 1));
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.at(-1).content[0].text, '【QQ 提醒】\n- group:456，发送者 QQ 123，消息 id:55');
  } finally { await h.close(); }
});

test('active turn enforces 30s steer cooldown and coalesces bursts; turn end settles 5s before queueing', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    h.queueDesktopAttentionSignal(signal('group:456', 1));
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].mode, 'steer');

    // Subsequent incoming signals during the active turn hit the 30s steer cooldown instead of 5s
    h.queueDesktopAttentionSignal(signal('group:789', 2));
    assert.equal(clock.has(30_000, 1000), true);
    assert.equal(clock.has(5_000), false);
    h.queueDesktopAttentionSignal(signal('group:999', 3));
    assert.equal(h.calls.prompts.length, 1);

    // Turn completion replaces the 30s steer timer with a 5s post-turn settle before queueing
    setRunning(false);
    await deliverFrame(h, turnEnd(sessionId));
    assert.equal(clock.has(5_000), true);
    assert.equal(clock.has(30_000, 1000), false);
    clock.run(5_000);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.prompts[1].mode, 'queue');
    assert.match(h.calls.prompts[1].content[0].text, /group:789/);
    assert.match(h.calls.prompts[1].content[0].text, /group:999/);
  } finally { await h.close(); }
});

test('fresh QQ signal waking from resting coalesces over 5s and wakes idle session via queue', async () => {
  const { h, clock, setRunning } = await fixture();
  try {
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    setRunning(false);

    h.queueDesktopAttentionSignal(signal('group:456', 1));
    assert.equal(h.attentionSnapshot().lifecycle, 'active');
    assert.equal(clock.has(5_000), true);
    h.queueDesktopAttentionSignal(signal('group:789', 2));
    assert.equal(h.calls.prompts.length, 0);

    clock.run(5_000);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].mode, 'queue');
    assert.match(h.calls.prompts[0].content[0].text, /group:456/);
    assert.match(h.calls.prompts[0].content[0].text, /group:789/);
  } finally { await h.close(); }
});

test('agent_rest returns restSkipped when attention is queued or an active steer has not reached assistant output', async () => {
  const { h, clock, sessionId } = await fixture();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const token = JSON.parse(fs.readFileSync(h.temp + '/state/desktop-agent.json', 'utf8')).agentToken;
    const postRest = async () => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/desktop-agent/rest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-console-token': 'fixture-console-token',
          'x-agent-call': '1',
          'x-agent-session-id': sessionId,
          'x-agent-token': token,
        },
        body: '{}',
      });
      return { status: res.status, ...(await res.json()) };
    };

    // Case 1: queued signal keeps turn active and flushes immediately
    h.queueDesktopAttentionSignal(signal('group:456', 1));
    const skippedQueued = await postRest();
    assert.equal(skippedQueued.status, 200);
    assert.equal(skippedQueued.restSkipped, true);
    assert.equal(skippedQueued.lifecycle, 'active');
    assert.equal(skippedQueued.turnCancellationScheduled, false);
    assert.equal(clock.has(0), true);

    clock.run(0);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].mode, 'steer');

    // Case 2: steer submitted/delivered before assistant/message still skips rest
    const skippedUnseen = await postRest();
    assert.equal(skippedUnseen.restSkipped, true);
    assert.equal(skippedUnseen.lifecycle, 'active');

    await deliverFrame(h, {
      type: 'session/event', sessionId,
      event: { type: 'user/message', data: { source: { rpcId: h.calls.prompts[0].requestId } } },
    });
    const skippedDelivered = await postRest();
    assert.equal(skippedDelivered.restSkipped, true);

    // Once assistant/message is emitted, pending delivered steer is cleared and agent_rest succeeds
    await deliverFrame(h, { type: 'session/event', sessionId, event: { type: 'assistant/message', data: {} } });
    const acceptedRest = await postRest();
    assert.equal(acceptedRest.status, 200);
    assert.equal(Boolean(acceptedRest.restSkipped), false);
    assert.equal(acceptedRest.lifecycle, 'resting');
    assert.equal(acceptedRest.turnCancellationScheduled, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

test('aborted turn during rest requeues unseen pending steer and wakes DSH', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    h.queueDesktopAttentionSignal(signal('group:456', 1));
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts[0].mode, 'steer');

    h.enterDesktopAgentRest();
    clock.run(80);
    assert.equal(h.attentionSnapshot().lifecycle, 'resting');

    setRunning(false);
    await deliverFrame(h, turnEnd(sessionId, 'aborted'));
    assert.equal(h.attentionSnapshot().lifecycle, 'active');
    assert.equal(h.attentionSnapshot().queue.length, 1);
    assert.equal(clock.has(5_000), true);

    clock.run(5_000);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.prompts[1].mode, 'queue');
    assert.match(h.calls.prompts[1].content[0].text, /group:456/);
  } finally { await h.close(); }
});

test('startup watchdog removes stranded queue item and resubmits when DSH stays running=false', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    h.setDesktopAgentTurnActive(false);
    setRunning(false);
    let queueSnapshot = [];
    h.api.readSessionState = async () => ({ cursor: 1, active: false, running: false, queue: queueSnapshot, pendingInput: [] });

    h.queueDesktopAttentionSignal(signal('group:456', 1));
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].mode, 'queue');
    const reqId = h.calls.prompts[0].requestId;
    assert.equal(typeof reqId, 'string');
    queueSnapshot = [{ id: 'msg-stranded-1', source: { rpcId: reqId } }];

    assert.equal(clock.has(3_000), true);
    await clock.run(3_000);
    assert.ok(h.calls.cancelled.some(
      (c) => c.method === 'session/updateQueue' && c.params?.itemId === 'msg-stranded-1' && c.params?.action?.kind === 'remove'
    ));
    assert.equal(h.attentionSnapshot().turnActive, false);
    assert.equal(h.attentionSnapshot().queue.length, 1);
    assert.equal(clock.has(0), true);

    queueSnapshot = [];
    clock.run(0);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.prompts[1].mode, 'queue');

    // Two failed startup checks retry once more, then the 3rd timeout falls back to recovery backoff
    await clock.run(3_000);
    clock.run(0);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 3);
    await clock.run(3_000);
    assert.equal(h.attentionSnapshot().lifecycle, 'recovering');
  } finally { await h.close(); }
});

test('flush awaits in-flight agent_rest session/cancel before submitting next prompt', async () => {
  const { h, clock, sessionId, setRunning } = await fixture();
  try {
    const cancelDeferred = deferred();
    h.api.callUnary = async (method, params) => {
      h.calls.cancelled.push({ method, params });
      if (method === 'session/cancel') return cancelDeferred.promise;
      return { result: { ok: true, value: {} } };
    };

    h.enterDesktopAgentRest();
    clock.run(80);
    h.queueDesktopAttentionSignal(signal('group:456', 1));
    setRunning(false);
    await deliverFrame(h, turnEnd(sessionId, 'completed'));
    assert.equal(h.attentionSnapshot().lifecycle, 'active');
    assert.equal(clock.has(5_000), true);

    clock.run(5_000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.calls.prompts.length, 0, 'prompt submission must wait for in-flight session/cancel');

    cancelDeferred.resolve({ result: { ok: true, value: {} } });
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].mode, 'queue');
    assert.match(h.calls.prompts[0].content[0].text, /group:456/);
  } finally { await h.close(); }
});

function fakeClockFixture() {
  let offset = 0;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() { return RealDate.now() + offset; }
  }
  const clock = fakeTimers();
  return {
    clock,
    Date: FakeDate,
    advance(ms) { offset += ms; },
  };
}

test('independent hot group window debounces ordinary follow-ups, never steers mid-turn, and survives a private reply', async () => {
  const { clock, Date: FakeDate, advance } = fakeClockFixture();
  const h = await bridgeHarness({ globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date: FakeDate } });
  const sessionId = await h.ensureDesktopAgentSession();
  let running = true;
  h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId, running, blank: false }] } } });
  h.setDesktopAgentLifecycle('active');
  h.setDesktopAgentTurnActive(true);
  try {
    h.bot.account = '42';
    h.bot.health = { connected: true, accountOnline: true, reader: 'ready' };
    h.bot.emit('open');

    // Send a reply in group:456 to open its independent 4m hot window
    h.recordSentMessagesV2('group:456', ['测试回复']);
    assert.equal(h.isGroupHot('group:456'), true);

    // Replying to a private message must NOT evict group:456 from its hot window
    h.recordSentMessagesV2('private:123', ['吃啦']);
    assert.equal(h.isGroupHot('group:456'), true);

    // While turn is active, ordinary group message in hot group must NOT steer or schedule flush
    await h.handleIncomingForTest('group', 456, {
      self_id: '42', group_id: 456, user_id: 222, message_id: '7001',
      sender: { user_id: 222, nickname: '群友' },
      message: [{ type: 'text', data: { text: '顺着接一句' } }],
    });
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.attentionSnapshot().flushScheduled, false);
    assert.equal(h.attentionSnapshot().groupAttentionScheduled, false);

    // Turn ends -> implicit rest -> hot group debounce wakes cleanly after 5s without @
    running = false;
    await deliverFrame(h, turnEnd(sessionId, 'completed'));
    assert.equal(h.attentionSnapshot().lifecycle, 'resting');
    assert.equal(h.attentionSnapshot().groupAttentionScheduled, true);

    advance(6_000);
    clock.run(5_000, 100);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.calls.prompts[0].mode, 'queue');
    assert.match(h.calls.prompts[0].content[0].text, /group:456.*id:7001（热群新消息）/);
    assert.equal(h.attentionSnapshot().unresolved.length, 0, 'passive hot follow-up never enters unreadFollowup');
  } finally { await h.close(); }
});

test('cold group low-priority alert yields while a hot group is active, and wakes after 60s aggregate when idle', async () => {
  const { clock, Date: FakeDate, advance } = fakeClockFixture();
  const h = await bridgeHarness({ globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date: FakeDate } });
  const sessionId = await h.ensureDesktopAgentSession();
  h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId, running: false, blank: false }] } } });
  try {
    h.bot.account = '42';
    h.bot.health = { connected: true, accountOnline: true, reader: 'ready' };
    h.bot.emit('open');
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);

    // Make group:456 hot so cold group:789 must yield
    h.recordSentMessagesV2('group:456', ['正聊着呢']);
    assert.equal(h.isGroupHot('group:456'), true);

    await h.handleIncomingForTest('group', 789, {
      self_id: '42', group_id: 789, user_id: 333, message_id: '8001',
      sender: { user_id: 333, nickname: '路人' },
      message: [{ type: 'text', data: { text: '冷群有人冒泡' } }],
    });
    // Should NOT schedule 60s cold timer while group:456 is hot (4m hot window defers P3)
    assert.equal(clock.has(60_000, 1000), false);
    assert.equal(clock.has(240_000, 2000), true);

    // Once group:456 hot window naturally expires (advance > 4m), P3 wakes cleanly for group:789
    advance(245_000);
    clock.run(240_000, 2000);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length, 1);
    assert.match(h.calls.prompts[0].content[0].text, /group:789.*id:8001（冷群新未读）/);
    assert.equal(h.attentionSnapshot().unresolved.length, 0, 'cold group low-priority alert never enters unreadFollowup');
  } finally { await h.close(); }
});

test('non-private wake attaches otherUnread metadata sorted hot-first; pure private wake omits cold-group unread', async () => {
  const { h, setRunning } = await fixture();
  try {
    h.setDesktopAgentTurnActive(false);
    setRunning(false);
    const stHot = h.getSocialV2State('group:575');
    stHot.unreadMessageCount = 3;
    stHot.lastIncomingAt = Date.now() - 10_000;
    h.markConversationActiveAfterSend('group:575', Date.now());
    const stCold = h.getSocialV2State('group:906');
    stCold.unreadMessageCount = 9;
    stCold.lastIncomingAt = Date.now() - 5_000;

    // Pure private wake must NOT attach cold/other group unread noise
    h.queueDesktopAttentionSignal({ key: 'private:123', kind: 'private', id: '123', reason: 'private', sender: '哥哥', senderId: '123', messageId: '901', seq: 1 });
    await h.flushAttentionNow();
    assert.doesNotMatch(h.calls.prompts.at(-1).content[0].text, /其他未读/);

    // Group wake attaches 【其他未读：...】 with hot group prioritized before cold group
    h.setDesktopAgentTurnActive(false);
    h.queueDesktopAttentionSignal({ key: 'group:456', kind: 'group', id: '456', reason: 'atMention', sender: '群友', senderId: '222', messageId: '902', seq: 2 });
    await h.flushAttentionNow();
    assert.match(h.calls.prompts.at(-1).content[0].text, /【其他未读：group:575\(3条,热\)、group:906\(9条\)】/);
  } finally { await h.close(); }
});
