import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { DEFAULT_SLEEP_SCHEDULE, sleepScheduleTimeZone } from '../src/sleep-schedule.js';

const ROUTE = '/api/console/desktop-agent/sleep-schedule';
const enabled = { enabled: true, sleepTime: '22:30', wakeTime: '07:00' };
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
let messageId = 200;
const command = body => ({ self_id: 42, user_id: 123, message_id: ++messageId,
  sender: { nickname: '测试' }, message: [{ type: 'text', data: { text: body } }] });

async function start({ now = at(14, 20), config = {}, files = {}, globals = {} } = {}) {
  const clock = { now };
  const timers = new Set();
  const RealDate = Date;
  class FixtureDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const h = await bridgeHarness({ config, files, globals: {
    Date: FixtureDate,
    setTimeout(fn, ms) { const timer = { fn, ms, dueAt: clock.now + Math.max(0, Number(ms) || 0), unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    ...globals,
  } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route = ROUTE, body, headers = {}) => {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const read = file => JSON.parse(fs.readFileSync(path.join(h.temp, file), 'utf8'));
  return {
    h, clock, timers, call,
    readConfig: () => read('config.json'),
    readState: () => read('state/desktop-agent.json'),
    async save(schedule) {
      const result = await call(ROUTE, schedule);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    },
    async tick(now) { clock.now = now; await h.checkDesktopAgentSleepSchedule(now); },
    async manual(text, now = clock.now) { clock.now = now; await h.handleIncomingForTest('private', 123, command(text)); },
    async close() { await new Promise(resolve => server.close(resolve)); await h.close(); },
  };
}

async function active(f) {
  await f.h.ensureDesktopAgentSession();
  f.h.setDesktopAgentLifecycle('active');
  f.h.setDesktopAgentTurnActive(false);
}

test('sleep schedule defaults to disabled empty times and is included in console status', async () => {
  const f = await start();
  try {
    const result = await f.call();
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.schedule, DEFAULT_SLEEP_SCHEDULE);
    assert.equal(result.body.timeZone, sleepScheduleTimeZone());
    assert.equal(result.body.nextSleepAt, null);
    assert.equal(result.body.nextWakeAt, null);
    const status = await f.call('/api/console/desktop-agent');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.sleepSchedule.schedule, DEFAULT_SLEEP_SCHEDULE);
    assert.equal(status.body.sleepSchedule.nextSleepAt, null);
    assert.equal(f.readState().sleepScheduleState.nextWakeAt, null);
    assert.equal(f.h.calls.prompts.length, 0);
    assert.equal(f.h.calls.cancelled.length, 0);
  } finally { await f.close(); }
});

test('schedule save preserves other config, persists next events, and identical saves do not re-arm', async () => {
  const f = await start({ config: { custom: { keep: 42 }, desktopAgent: { customKeep: { value: true } }, deny: { groups: ['789'], private: [] } } });
  try {
    const before = f.readConfig();
    const result = await f.save(enabled);
    assert.deepEqual(result.schedule, enabled);
    assert.equal(result.nextSleepAt, at(14, 22, 30));
    assert.equal(result.nextWakeAt, at(15, 7));
    const saved = f.readConfig();
    assert.deepEqual(saved.desktopAgent.sleepSchedule, enabled);
    assert.deepEqual(saved.desktopAgent.customKeep, before.desktopAgent.customKeep);
    for (const key of ['custom', 'allow', 'deny', 'dsh']) assert.deepEqual(saved[key], before[key], key);
    const planned = f.readState().sleepScheduleState;
    assert.equal(planned.nextSleepAt, result.nextSleepAt);
    assert.equal(planned.nextWakeAt, result.nextWakeAt);
    f.clock.now = at(14, 21);
    await f.save({ ...enabled });
    assert.deepEqual(f.readState().sleepScheduleState, planned);
    assert.equal(f.h.attentionSnapshot().lifecycle, 'idle');
    assert.equal(f.h.calls.prompts.length, 0);
  } finally { await f.close(); }
});

test('schedule endpoint strictly validates complete bodies without persisting rejected changes', async () => {
  const f = await start();
  try {
    await f.save(enabled);
    const beforeConfig = f.readConfig();
    const beforeInfo = plain(f.h.desktopAgentSleepScheduleInfo());
    for (const body of [{}, [], null, true,
      { enabled: true, sleepTime: '22:30' }, { sleepTime: '22:30', wakeTime: '07:00' },
      { ...enabled, enabled: 'true' }, { ...enabled, sleepTime: '24:00' },
      { ...enabled, sleepTime: '7:30' }, { ...enabled, wakeTime: '07:60' },
      { ...enabled, sleepTime: '' }, { ...enabled, wakeTime: 700 },
      { ...enabled, sleepTime: '07:00' },
      { enabled: false, sleepTime: '07:00', wakeTime: '07:00' },
    ]) {
      const result = await f.call(ROUTE, body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.ok, false);
      assert.deepEqual(f.readConfig(), beforeConfig);
      assert.deepEqual(plain(f.h.desktopAgentSleepScheduleInfo()), beforeInfo);
    }
  } finally { await f.close(); }
});

test('sleep schedule management requires console authentication and rejects agent callers', async () => {
  const f = await start();
  try {
    const before = f.readConfig();
    const sessionId = await f.h.ensureDesktopAgentSession();
    const agent = { 'x-agent-call': '1', 'x-agent-session-id': sessionId, 'x-agent-token': f.readState().agentToken };
    for (const body of [undefined, enabled]) {
      const unauthorized = await f.call(ROUTE, body, { 'x-console-token': '' });
      assert.ok([401, 403].includes(unauthorized.status), JSON.stringify(unauthorized));
      const wrong = await f.call(ROUTE, body, { 'x-console-token': 'wrong-token' });
      assert.ok([401, 403].includes(wrong.status), JSON.stringify(wrong));
      assert.equal((await f.call(ROUTE, body, agent)).status, 403);
    }
    assert.deepEqual(f.readConfig(), before);
    assert.deepEqual((await f.call()).body.schedule, DEFAULT_SLEEP_SCHEDULE);
  } finally { await f.close(); }
});

test('schedule write failure leaves runtime schedule and saved config unchanged', async () => {
  const f = await start({ globals: { hardenFile: () => ({ ok: false, detail: 'fixture failure' }) } });
  try {
    const before = f.readConfig();
    const result = await f.call(ROUTE, enabled);
    assert.equal(result.status, 500);
    assert.equal(result.body.ok, false);
    assert.deepEqual(f.readConfig(), before);
    assert.deepEqual((await f.call()).body.schedule, DEFAULT_SLEEP_SCHEDULE);
  } finally { await f.close(); }
});

test('daily sleep and wake cross midnight, persist progress, and deduplicate repeated ticks', async () => {
  const f = await start({ config: { desktopAgent: { sleepSchedule: enabled } } });
  try {
    await active(f);
    await f.tick(at(14, 22, 29));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'active');
    await Promise.all([f.tick(at(14, 22, 30)), f.tick(at(14, 22, 30))]);
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping');
    assert.equal(f.h.calls.cancelled.length, 1);
    assert.equal(f.readState().sleepScheduleState.nextSleepAt, at(15, 22, 30));
    await f.tick(at(15, 6, 59));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping');
    await Promise.all([f.tick(at(15, 7)), f.tick(at(15, 7))]);
    assert.equal(f.h.attentionSnapshot().lifecycle, 'active');
    assert.equal(f.h.attentionSnapshot().pendingWakeReason, 'scheduled-wake');
    await f.h.flushAttentionNow();
    assert.equal(f.h.calls.prompts.length, 1);
    const text = f.h.calls.prompts[0].content.map(part => part.text ?? '').join('\n');
    assert.match(text, /闹钟|定时|计划|每日起床时间/);
    assert.doesNotMatch(text, /ownerQQ 已发送起床命令/);
    await f.tick(at(15, 7));
    await f.h.flushAttentionNow();
    assert.equal(f.h.calls.prompts.length, 1);
    assert.equal(f.h.calls.cancelled.length, 1);
    assert.equal(f.readState().sleepScheduleState.nextWakeAt, at(16, 7));
  } finally { await f.close(); }
});

test('early manual sleep and wake remain in effect until the next real alarm', async () => {
  const f = await start({ config: { desktopAgent: { sleepSchedule: enabled } } });
  try {
    await active(f);
    await f.manual('/睡觉', at(14, 21));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping');
    await f.tick(at(14, 21, 30));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping');
    await f.tick(at(14, 22, 30));
    await f.manual('/起床', at(15, 5));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'active');
    await f.tick(at(15, 6));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'active');
    await f.h.flushAttentionNow();
    const count = f.h.calls.prompts.length;
    await f.tick(at(15, 7));
    await f.h.flushAttentionNow();
    assert.equal(f.h.attentionSnapshot().lifecycle, 'active');
    assert.equal(f.h.calls.prompts.length, count, 'an already awake agent should not get a second wake turn');
  } finally { await f.close(); }
});

test('a manual command drains delayed old alarms first so the latest user instruction wins', async () => {
  const f = await start({ config: { desktopAgent: { sleepSchedule: enabled } } });
  try {
    await active(f);
    await f.manual('/起床', at(14, 23));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'active');
    assert.equal(f.h.calls.cancelled.length, 1, 'the overdue sleep was handled before the manual wake');
    await f.tick(at(14, 23, 1));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'active');
    await f.manual('/睡觉', at(14, 23, 30));
    await f.manual('/睡觉', at(15, 8));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping');
    await f.tick(at(15, 8, 1));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping', 'overdue wake cannot overwrite newer manual sleep');
    assert.equal(f.readState().sleepScheduleState.nextWakeAt, at(16, 7));
  } finally { await f.close(); }
});

test('stopped lifecycle consumes both alarm types without sleeping, waking or sending turns', async () => {
  const f = await start({ config: { desktopAgent: { sleepSchedule: enabled } } });
  try {
    await active(f);
    f.h.stopDesktopAgentLifecycle();
    await f.tick(at(14, 22, 30));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'stopped');
    await f.tick(at(15, 7));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'stopped');
    assert.equal(f.h.calls.prompts.length, 0);
    assert.equal(f.h.calls.cancelled.length, 0);
    assert.equal(f.readState().sleepScheduleState.nextSleepAt, at(15, 22, 30));
    assert.equal(f.readState().sleepScheduleState.nextWakeAt, at(16, 7));
  } finally { await f.close(); }
});

test('disabling does not wake a sleeping agent; re-enabling and time edits start in the future', async () => {
  const f = await start({ config: { desktopAgent: { sleepSchedule: enabled } } });
  try {
    await active(f);
    await f.tick(at(14, 22, 30));
    const disabled = await f.save({ ...enabled, enabled: false });
    assert.equal(disabled.nextSleepAt, null);
    assert.equal(disabled.nextWakeAt, null);
    await f.tick(at(15, 8));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping');
    assert.equal(f.h.calls.prompts.length, 0);
    const reenabled = await f.save(enabled);
    assert.equal(reenabled.nextWakeAt, at(16, 7));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping');
    const changed = await f.save({ ...enabled, sleepTime: '01:00', wakeTime: '06:00' });
    assert.equal(changed.nextSleepAt, at(16, 1));
    assert.equal(changed.nextWakeAt, at(16, 6));
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping');
  } finally { await f.close(); }
});

test('startup catches only the latest missed action across several days before QQ connects', async () => {
  const first = await start({ config: { desktopAgent: { sleepSchedule: enabled } } });
  let sleeping;
  let morning;
  try {
    await active(first);
    const config = first.readConfig();
    const state = first.readState();
    sleeping = await start({ now: at(24, 23), config, files: { 'state/desktop-agent.json': state } });
    assert.equal(sleeping.h.attentionSnapshot().lifecycle, 'sleeping');
    assert.equal(sleeping.readState().sleepScheduleState.nextSleepAt, at(25, 22, 30));
    assert.equal(sleeping.readState().sleepScheduleState.nextWakeAt, at(25, 7));
    assert.equal(sleeping.h.calls.prompts.length, 0);
    // Restore the same old pending pair with a sleeping lifecycle: the latest
    // missed event in the morning must be wake, without replaying each night.
    morning = await start({ now: at(24, 9), config, files: { 'state/desktop-agent.json': { ...state, lifecycle: 'sleeping' } } });
    assert.notEqual(morning.h.attentionSnapshot().lifecycle, 'sleeping');
    assert.equal(morning.h.attentionSnapshot().pendingWakeReason, 'scheduled-wake');
    assert.equal(morning.readState().sleepScheduleState.nextWakeAt, at(25, 7));
    assert.equal(morning.h.calls.prompts.length, 0, 'offline startup does not call a model');
  } finally {
    if (morning) await morning.close();
    if (sleeping) await sleeping.close();
    await first.close();
  }
});

test('offline scheduled wake persists its reason and resumes one turn when DSH returns', async () => {
  const f = await start({ config: { desktopAgent: { sleepSchedule: enabled } } });
  try {
    await active(f);
    await f.tick(at(14, 22, 30));
    f.h.setReady(false);
    await f.tick(at(15, 7));
    assert.notEqual(f.h.attentionSnapshot().lifecycle, 'sleeping');
    assert.equal(f.readState().pendingWakeReason, 'scheduled-wake');
    assert.equal(f.h.calls.prompts.length, 0);
    f.h.setReady(true);
    await f.h.reconcileDesktopAgentLifecycle();
    const recoveryAt = f.readState().recoveryAt;
    const dueTimers = [...f.timers].filter(timer => timer.dueAt <= recoveryAt);
    assert.ok(dueTimers.some(timer => timer.dueAt === recoveryAt), 'offline wake resumes through the existing recovery timer');
    f.clock.now = recoveryAt;
    // The minute-long alarm check and the recovery timer can have the same
    // deadline. Run every pending timer, as Node would, rather than guessing
    // which closure is the recovery implementation.
    for (const timer of dueTimers) {
      if (!f.timers.delete(timer)) continue;
      await timer.fn();
      await settle();
    }
    await f.h.flushAttentionNow();
    assert.equal(f.h.calls.prompts.length, 1);
    await f.h.checkDesktopAgentSleepSchedule(f.clock.now);
    await f.h.flushAttentionNow();
    assert.equal(f.h.calls.prompts.length, 1);
  } finally { await f.close(); }
});

for (const change of ['time', 'disable', 'stop']) test(`${change} cancels a scheduled wake waiting for sleep cancellation`, async () => {
  const f = await start({ config: { desktopAgent: { sleepSchedule: enabled } } });
  let release;
  let sleeping;
  let waking;
  try {
    await active(f);
    const canceled = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.h.api.stopSessionWork = async () => { entered(); return canceled; };
    sleeping = f.manual('/睡觉', at(14, 21));
    await started;
    assert.equal(f.h.attentionSnapshot().lifecycle, 'sleeping');
    f.clock.now = at(15, 7);
    waking = f.h.checkDesktopAgentSleepSchedule(f.clock.now);
    await settle();
    assert.equal(f.h.desktopAgentSleepScheduleInfo().nextWakeAt, at(15, 7), 'the in-flight action is checkpointed only after it finishes');
    if (change === 'stop') f.h.stopDesktopAgentLifecycle();
    else {
      const saved = await f.save(change === 'time' ? { ...enabled, wakeTime: '08:00' } : { ...enabled, enabled: false });
      assert.equal(saved.nextWakeAt, change === 'time' ? at(15, 8) : null);
    }
    release({ removed: 0 });
    await Promise.all([sleeping, waking]);
    assert.equal(f.h.attentionSnapshot().lifecycle, change === 'stop' ? 'stopped' : 'sleeping');
    assert.equal(f.h.attentionSnapshot().pendingWakeReason, '');
    assert.equal(f.h.calls.prompts.length, 0);
  } finally {
    release?.({ removed: 0 });
    await Promise.allSettled([sleeping, waking].filter(Boolean));
    await f.close();
  }
});

test('invalid startup schedule is disabled without rewriting the user configuration', async () => {
  const invalid = { enabled: true, sleepTime: '24:00', wakeTime: '07:00' };
  const f = await start({ config: { desktopAgent: { sleepSchedule: invalid } } });
  try {
    assert.deepEqual((await f.call()).body.schedule, DEFAULT_SLEEP_SCHEDULE);
    assert.deepEqual(f.readConfig().desktopAgent.sleepSchedule, invalid);
    assert.equal(f.h.calls.prompts.length, 0);
  } finally { await f.close(); }
});
