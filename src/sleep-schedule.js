// Daily alarms only: lifecycle changes belong to bridge.js, never to this planner.
// Persist the returned state together with handling its one optional event.

const VERSION = 1;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_LIMIT = 8_640_000_000_000_000;

export const DEFAULT_SLEEP_SCHEDULE = Object.freeze({ enabled: false, sleepTime: '', wakeTime: '' });

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_SLEEP_SCHEDULE' });
}

function normalizeTime(value, label) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw invalid(`${label}必须是 HH:mm 格式`);
  const time = value.trim();
  if (time !== '' && !TIME_PATTERN.test(time)) throw invalid(`${label}必须是 HH:mm 格式（00:00 至 23:59）`);
  return time;
}

/** Validate configuration without inventing times or enabling an unconfigured alarm. */
export function normalizeSleepSchedule(value = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('睡眠闹钟配置必须是对象');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw invalid('睡眠闹钟开关必须是布尔值');
  }
  const config = {
    enabled: value.enabled ?? false,
    sleepTime: normalizeTime(value.sleepTime, '睡觉时间'),
    wakeTime: normalizeTime(value.wakeTime, '起床时间'),
  };
  if (config.sleepTime && config.wakeTime && config.sleepTime === config.wakeTime) {
    throw invalid('睡觉时间与起床时间不能相同');
  }
  if (config.enabled && (!config.sleepTime || !config.wakeTime)) {
    throw invalid('启用睡眠闹钟前请设置睡觉和起床时间');
  }
  return config;
}

/** Use the system zone identity, not its current UTC offset (which changes at DST). */
export function sleepScheduleTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= DATE_LIMIT;
}

function checkedTimestamp(value) {
  if (!validTimestamp(value)) throw invalid('睡眠闹钟当前时间必须是有效的毫秒时间戳');
  return value;
}

function timeParts(time) {
  const normalized = normalizeTime(time, '闹钟时间');
  if (!normalized) throw invalid('闹钟时间不能为空');
  return normalized.split(':').map(Number);
}

// Construct each occurrence from local calendar fields, never by adding 24 hours.
// Date's compatible DST resolution picks the earlier repeated time and moves a
// nonexistent time forward by the gap. Thus a repeated hour fires only once/day.
function occurrence(reference, dayOffset, [hour, minute]) {
  const date = new Date(reference);
  const year = date.getFullYear();
  const candidate = new Date(year, date.getMonth(), date.getDate() + dayOffset, hour, minute, 0, 0);
  if (year >= 0 && year < 100) candidate.setFullYear(year);
  return candidate.getTime();
}

function adjacentOccurrence(parts, reference, direction) {
  // Seven calendar dates also cover zones that historically skipped a whole day.
  for (let offset = 0; offset < 7; offset += 1) {
    const at = occurrence(reference, direction * offset, parts);
    if (validTimestamp(at) && (direction > 0 ? at > reference : at <= reference)) return at;
  }
  throw invalid('无法在当前本地时区计算下一次闹钟');
}

/** First occurrence strictly after `after`, using the machine's local calendar. */
export function nextSleepScheduleTime(time, after) {
  return adjacentOccurrence(timeParts(time), checkedTimestamp(after), 1);
}

function fingerprint(config, timeZone) {
  return JSON.stringify([VERSION, timeZone, config.enabled, config.sleepTime, config.wakeTime]);
}

function usableState(state, expectedFingerprint, timeZone) {
  return state !== null && typeof state === 'object' && !Array.isArray(state)
    && state.version === VERSION && state.fingerprint === expectedFingerprint && state.timeZone === timeZone
    && validTimestamp(state.nextSleepAt) && validTimestamp(state.nextWakeAt);
}

/**
 * Plan one pair of local daily alarms. All timestamps are epoch milliseconds.
 *
 * New/enabled/changed configurations start strictly in the future. Existing
 * state survives identical saves and clock rollback. A late tick or restart
 * returns only the latest missed occurrence and advances both alarms past now;
 * it never replays intermediate days or infers the desired lifecycle from a
 * time interval. Manual sleep/wake therefore need not touch this state.
 *
 * `event` is null or { type: 'sleep' | 'wake', scheduledAt }. In the rare case
 * a DST gap maps the two distinct wall times to the same instant, wake wins.
 * The caller serializes handling and persists `state`; no timers or I/O occur.
 */
export function planSleepSchedule({ config: input = {}, state = null, now = Date.now() } = {}) {
  const config = normalizeSleepSchedule(input);
  checkedTimestamp(now);
  const timeZone = sleepScheduleTimeZone();
  const configFingerprint = fingerprint(config, timeZone);
  const nextState = {
    version: VERSION,
    fingerprint: configFingerprint,
    timeZone,
    nextSleepAt: null,
    nextWakeAt: null,
  };
  if (!config.enabled) return { state: nextState, event: null, nextAt: null };

  const sleep = timeParts(config.sleepTime);
  const wake = timeParts(config.wakeTime);
  if (!usableState(state, configFingerprint, timeZone)) {
    nextState.nextSleepAt = adjacentOccurrence(sleep, now, 1);
    nextState.nextWakeAt = adjacentOccurrence(wake, now, 1);
    return { state: nextState, event: null, nextAt: Math.min(nextState.nextSleepAt, nextState.nextWakeAt) };
  }

  let event = null;
  for (const [type, key, parts] of [['sleep', 'nextSleepAt', sleep], ['wake', 'nextWakeAt', wake]]) {
    const pendingAt = state[key];
    nextState[key] = pendingAt;
    if (pendingAt > now) continue;
    // Recompute the most recent occurrence, not merely the old pending pair:
    // after days offline the latest action can be the opposite of that pair.
    const scheduledAt = Math.max(pendingAt, adjacentOccurrence(parts, now, -1));
    if (event === null || scheduledAt >= event.scheduledAt) event = { type, scheduledAt };
    nextState[key] = adjacentOccurrence(parts, now, 1);
  }
  return { state: nextState, event, nextAt: Math.min(nextState.nextSleepAt, nextState.nextWakeAt) };
}
