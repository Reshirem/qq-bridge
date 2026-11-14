import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  DEFAULT_SLEEP_SCHEDULE, normalizeSleepSchedule, nextSleepScheduleTime,
  planSleepSchedule, sleepScheduleTimeZone,
} from '../src/sleep-schedule.js';

const configured = { enabled: true, sleepTime: '22:30', wakeTime: '07:00' };
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();

test('defaults remain disabled with empty times; normalization does not mutate input', () => {
  assert.deepEqual(normalizeSleepSchedule(), DEFAULT_SLEEP_SCHEDULE);
  const input = Object.freeze({ enabled: false, sleepTime: ' 22:30 ', wakeTime: '07:00' });
  assert.deepEqual(normalizeSleepSchedule(input), { ...configured, enabled: false });
  assert.equal(input.sleepTime, ' 22:30 ');
  assert.equal(typeof sleepScheduleTimeZone(), 'string');
});

test('rejects malformed times, identical alarms, non-boolean switches and incomplete enabled config', () => {
  for (const value of [
    null, [], '22:30', { enabled: 'true' }, { sleepTime: 2230 },
    { sleepTime: '24:00' }, { sleepTime: '2:30' }, { sleepTime: '22:60' },
    { sleepTime: '22:30:00' }, { sleepTime: '22:30x' },
    { sleepTime: '07:00', wakeTime: '07:00' }, { enabled: true },
    { enabled: true, sleepTime: '22:30' }, { enabled: true, wakeTime: '07:00' },
  ]) assert.throws(() => normalizeSleepSchedule(value), { code: 'INVALID_SLEEP_SCHEDULE' });
  assert.deepEqual(normalizeSleepSchedule({ sleepTime: '22:30' }), { enabled: false, sleepTime: '22:30', wakeTime: '' });
});

test('disabled alarms have no event or next timestamps even with old due state', () => {
  const initial = planSleepSchedule({ config: configured, now: at(14, 6) });
  const disabled = planSleepSchedule({ config: { ...configured, enabled: false }, state: initial.state, now: at(19, 23) });
  assert.equal(disabled.event, null);
  assert.equal(disabled.nextAt, null);
  assert.equal(disabled.state.nextSleepAt, null);
  assert.equal(disabled.state.nextWakeAt, null);
  assert.equal(planSleepSchedule({ now: at(14, 6) }).event, null);
});

test('new enable starts with strictly future events without correcting current sleep interval', () => {
  const initial = planSleepSchedule({ config: configured, now: at(14, 23) });
  assert.equal(initial.event, null);
  assert.equal(initial.state.nextSleepAt, at(15, 22, 30));
  assert.equal(initial.state.nextWakeAt, at(15, 7));
  assert.equal(initial.nextAt, at(15, 7));
  const exact = planSleepSchedule({ config: configured, now: at(14, 22, 30) });
  assert.equal(exact.event, null);
  assert.equal(exact.state.nextSleepAt, at(15, 22, 30));
});

test('same settings preserve state, including exact due times and immutable inputs', () => {
  const initial = planSleepSchedule({ config: configured, now: at(14, 20) });
  const state = Object.freeze(initial.state);
  const unchanged = planSleepSchedule({ config: { ...configured }, state, now: at(14, 21) });
  assert.deepEqual(unchanged.state, state);
  assert.equal(unchanged.event, null);
  const due = planSleepSchedule({ config: configured, state, now: at(14, 22, 30) });
  assert.deepEqual(due.event, { type: 'sleep', scheduledAt: at(14, 22, 30) });
  assert.equal(due.state.nextSleepAt, at(15, 22, 30));
  assert.equal(state.nextSleepAt, at(14, 22, 30));
  assert.equal(planSleepSchedule({ config: configured, state: due.state, now: at(14, 22, 30) }).event, null);
});

test('time edits and disable/re-enable re-arm in the future, never replaying pending alarms', () => {
  const initial = planSleepSchedule({ config: configured, now: at(14, 20) });
  const changed = { ...configured, sleepTime: '21:30' };
  const edited = planSleepSchedule({ config: changed, state: initial.state, now: at(14, 23) });
  assert.equal(edited.event, null);
  assert.equal(edited.state.nextSleepAt, at(15, 21, 30));
  const disabled = planSleepSchedule({ config: { ...configured, enabled: false }, state: initial.state, now: at(14, 21) });
  const enabled = planSleepSchedule({ config: configured, state: disabled.state, now: at(14, 23) });
  assert.equal(enabled.event, null);
  assert.equal(enabled.state.nextSleepAt, at(15, 22, 30));
});

test('manual lifecycle changes cannot cause interval corrections between actual alarms', () => {
  // The caller may manually sleep at 21:00 or wake at 05:00; neither is planner input.
  const initial = planSleepSchedule({ config: configured, now: at(14, 20) });
  assert.equal(planSleepSchedule({ config: configured, state: initial.state, now: at(14, 21) }).event, null);
  const slept = planSleepSchedule({ config: configured, state: initial.state, now: at(14, 22, 30) });
  assert.equal(planSleepSchedule({ config: configured, state: slept.state, now: at(15, 5) }).event, null);
  assert.deepEqual(planSleepSchedule({ config: configured, state: slept.state, now: at(15, 7) }).event,
    { type: 'wake', scheduledAt: at(15, 7) });
});

test('restart across midnight catches up only the latest missed event', () => {
  const initial = planSleepSchedule({ config: configured, now: at(14, 20) });
  const restored = JSON.parse(JSON.stringify(initial.state));
  const overnight = planSleepSchedule({ config: configured, state: restored, now: at(15, 3) });
  assert.deepEqual(overnight.event, { type: 'sleep', scheduledAt: at(14, 22, 30) });
  const morning = planSleepSchedule({ config: configured, state: restored, now: at(15, 9) });
  assert.deepEqual(morning.event, { type: 'wake', scheduledAt: at(15, 7) });
  assert.ok(morning.state.nextSleepAt > at(15, 9));
  assert.ok(morning.state.nextWakeAt > at(15, 9));
});

test('multi-day catch-up finds the actual latest event rather than sorting stale next timestamps', () => {
  const initial = planSleepSchedule({ config: configured, now: at(14, 20) });
  assert.ok(initial.state.nextWakeAt > initial.state.nextSleepAt);
  const lateNight = planSleepSchedule({ config: configured, state: initial.state, now: at(24, 23) });
  assert.deepEqual(lateNight.event, { type: 'sleep', scheduledAt: at(24, 22, 30) });
  assert.equal(lateNight.state.nextWakeAt, at(25, 7));
  assert.equal(lateNight.state.nextSleepAt, at(25, 22, 30));
  assert.equal(planSleepSchedule({ config: configured, state: lateNight.state, now: at(24, 23) }).event, null);
  const day = planSleepSchedule({ config: configured, state: initial.state, now: at(24, 13) });
  assert.deepEqual(day.event, { type: 'wake', scheduledAt: at(24, 7) });
});

test('clock rollback does not replay already-consumed wake or sleep events', () => {
  const initial = planSleepSchedule({ config: configured, now: at(14, 20) });
  const caughtUp = planSleepSchedule({ config: configured, state: initial.state, now: at(16, 9) });
  assert.equal(caughtUp.event.type, 'wake');
  for (const now of [at(14, 21), at(14, 23), at(15, 7), at(15, 23), at(16, 7), at(16, 9)]) {
    const tick = planSleepSchedule({ config: configured, state: caughtUp.state, now });
    assert.equal(tick.event, null);
    assert.deepEqual(tick.state, caughtUp.state);
  }
});

test('midnight and daytime sleep schedules use independent daily alarms', () => {
  const config = { enabled: true, sleepTime: '07:00', wakeTime: '00:00' };
  const initial = planSleepSchedule({ config, now: at(14, 23) });
  assert.equal(initial.nextAt, at(15, 0));
  const tick = planSleepSchedule({ config, state: initial.state, now: at(15, 0) });
  assert.deepEqual(tick.event, { type: 'wake', scheduledAt: at(15, 0) });
  assert.equal(tick.nextAt, at(15, 7));
  assert.equal(nextSleepScheduleTime('00:00', at(15, 0)), at(16, 0));
});

test('invalid persisted state or changed timezone reinitializes without firing', () => {
  const initial = planSleepSchedule({ config: configured, now: at(14, 20) });
  for (const state of [null, {}, { ...initial.state, version: 0 },
    { ...initial.state, nextSleepAt: null }, { ...initial.state, nextWakeAt: 'invalid' },
    { ...initial.state, fingerprint: 'old-config' }, { ...initial.state, timeZone: 'other-zone' }]) {
    const result = planSleepSchedule({ config: configured, state, now: at(15, 9) });
    assert.equal(result.event, null);
    assert.equal(result.nextAt, at(15, 22, 30));
  }
  for (const now of [NaN, Infinity, '123', 1.5]) {
    assert.throws(() => planSleepSchedule({ config: configured, now }), { code: 'INVALID_SLEEP_SCHEDULE' });
  }
});

const moduleUrl = new URL('../src/sleep-schedule.js', import.meta.url).href;
function inTimeZone(timeZone, source) {
  const code = `import assert from 'node:assert/strict';
    import {planSleepSchedule, nextSleepScheduleTime, sleepScheduleTimeZone} from ${JSON.stringify(moduleUrl)};
    ${source}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TZ: timeZone }, windowsHide: true, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('DST spring gap moves the absent wall time forward and the following day returns to normal', () => {
  inTimeZone('America/New_York', `
    assert.equal(sleepScheduleTimeZone(), 'America/New_York');
    const config = {enabled:true,sleepTime:'02:30',wakeTime:'07:00'};
    const initial = planSleepSchedule({config,now:Date.parse('2026-03-08T00:00:00-05:00')});
    assert.equal(initial.state.nextSleepAt, Date.parse('2026-03-08T03:30:00-04:00'));
    const due = planSleepSchedule({config,state:initial.state,now:Date.parse('2026-03-08T03:30:00-04:00')});
    assert.equal(due.event.type, 'sleep');
    assert.equal(due.state.nextSleepAt, Date.parse('2026-03-09T02:30:00-04:00'));
    assert.equal(due.state.timeZone, initial.state.timeZone);
  `);
});

test('DST repeated hour fires at its first occurrence only, including cold restarts', () => {
  inTimeZone('America/New_York', `
    const config = {enabled:true,sleepTime:'01:30',wakeTime:'07:00'};
    const initial = planSleepSchedule({config,now:Date.parse('2026-11-01T00:00:00-04:00')});
    assert.equal(initial.state.nextSleepAt, Date.parse('2026-11-01T01:30:00-04:00'));
    const due = planSleepSchedule({config,state:initial.state,now:initial.state.nextSleepAt});
    assert.equal(due.state.nextSleepAt, Date.parse('2026-11-02T01:30:00-05:00'));
    const repeated = planSleepSchedule({config,state:JSON.parse(JSON.stringify(due.state)),now:Date.parse('2026-11-01T01:30:00-05:00')});
    assert.equal(repeated.event,null);
    const cold = planSleepSchedule({config,state:initial.state,now:Date.parse('2026-11-01T01:45:00-05:00')});
    assert.equal(cold.event.scheduledAt,Date.parse('2026-11-01T01:30:00-04:00'));
    const enabledLate = planSleepSchedule({config,now:Date.parse('2026-11-01T01:15:00-05:00')});
    assert.equal(enabledLate.state.nextSleepAt,Date.parse('2026-11-02T01:30:00-05:00'));
  `);
});

test('DST-coincident distinct alarms select wake deterministically and consume both', () => {
  inTimeZone('America/New_York', `
    const config={enabled:true,sleepTime:'02:30',wakeTime:'03:30'};
    const initial=planSleepSchedule({config,now:Date.parse('2026-03-08T00:00:00-05:00')});
    assert.equal(initial.state.nextSleepAt, initial.state.nextWakeAt);
    const due=planSleepSchedule({config,state:initial.state,now:initial.nextAt});
    assert.equal(due.event.type,'wake');
    assert.ok(due.state.nextSleepAt>initial.nextAt);
    assert.ok(due.state.nextWakeAt>initial.nextAt);
  `);
});

test('half-hour DST gaps and skipped calendar dates keep future alarms monotonic', () => {
  inTimeZone('Australia/Lord_Howe', `
    assert.equal(nextSleepScheduleTime('02:15',Date.parse('2026-10-04T00:00:00+10:30')),
      Date.parse('2026-10-04T02:45:00+11:00'));
    assert.equal(nextSleepScheduleTime('02:15',Date.parse('2026-10-04T02:45:00+11:00')),
      Date.parse('2026-10-05T02:15:00+11:00'));
  `);
  inTimeZone('Pacific/Apia', `
    assert.equal(nextSleepScheduleTime('07:00',Date.parse('2011-12-29T08:00:00-10:00')),
      Date.parse('2011-12-31T07:00:00+14:00'));
    assert.equal(nextSleepScheduleTime('07:00',Date.parse('2011-12-31T07:00:00+14:00')),
      Date.parse('2012-01-01T07:00:00+14:00'));
  `);
});
