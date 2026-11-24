// Only the model-facing view is compacted. Stored messages and console/API data
// retain the original fields for display, media retrieval and troubleshooting.
const DEFAULT_FALSE_FIELDS = new Set([
  'quoteTargetIsSelf', 'isOwner', 'isSelf', 'hasMedia', 'hasForward'
]);
const OPTIONAL_FIELDS = new Set([
  'seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind',
  'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds', 'replyTo'
]);

// ── 时间视图：裸 epoch 换成「本地时间 + 距现在多久」 ──────────────────────────
//
// 为什么必须换：模型看到的原来是 `"time":1792294529471`，它既算不出"这是 38 分钟前"，
// 也没法跟提示词里的【当前时间】对齐。于是**沉睡几十分钟后被唤醒，仍然把旧消息当成刚发的**
// 实时对话来回复（实测：唤醒原因 atMention@seq194 其实是 40 分钟前的话，它照样用"刚看到"的
// 语气接，甚至抢进一个早已散场的话题）。
//
// 换成 `"at":"11:31","ago":"38m"` 之后：模型不需要做任何换算，直接能判断"这条是旧账"。
// `at` 保留绝对时间（跨天时带日期），`ago` 用最省 token 的写法（3s / 5m / 2h / 3d）。
//
// 兼容：time 缺失/为 0/非法时**原样保留**（旧行为），避免把"没有时间"伪装成"刚刚"。
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

/** 本地时间戳：当天只给 HH:MM，跨天补 MM-DD。 */
function localStamp(ms, now) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = (() => {
    const a = new Date(now);
    return a.getFullYear() === d.getFullYear() && a.getMonth() === d.getMonth() && a.getDate() === d.getDate();
  })();
  return sameDay ? clock : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/** 距现在多久：3s / 18m / 2h / 3d。未来时间（时钟偏差）夹到 0s。 */
function ageText(ms, now) {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  return `${Math.floor(hour / 24)}d`;
}

/** 把 epoch 毫秒转成模型可读的 age 文本（供提示词/日志复用同一套口径）。 */
export function describeAge(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  return ageText(t, now);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compactMedia(media, canResolveByMessage) {
  return media.map((item, index) => {
    if (!isRecord(item)) return item;
    const result = { ...item };
    // A local seq is a bridge message handle accepted by qq_get_message_images.
    // Forwarded nodes only have messageSeq, and may not be locally resolvable:
    // keep their transport references, even when they happen to have messageId.
    if (canResolveByMessage) {
      delete result.file;
      delete result.url;
      // Match the image tool's one-based ordering; never filter/reorder items.
      if (result.index == null) result.index = index + 1;
    } else if (result.file === result.url) {
      delete result.file;
    }
    for (const key of ['file', 'url', 'faceId']) {
      if (isEmpty(result[key])) delete result[key];
    }
    return result;
  });
}

export function compactModelMessage(message, opts = {}) {
  if (!isRecord(message)) return message;
  const result = { ...message };
  // No trimming or truncation: differing plain text can contain resolved quote
  // context, and tail can carry the end of a long message absent from text.
  const seenText = new Set();
  for (const key of ['text', 'plain', 'tail']) {
    if (typeof result[key] !== 'string') continue;
    if (seenText.has(result[key])) delete result[key];
    else seenText.add(result[key]);
  }
  for (const key of OPTIONAL_FIELDS) {
    if (isEmpty(result[key])) delete result[key];
  }
  for (const key of DEFAULT_FALSE_FIELDS) {
    if (result[key] === false) delete result[key];
  }
  // 时间视图：有效的 epoch 换成 at/ago；缺失或 0（历史兼容/未知）保持原样。
  const stamp = Number(result.time);
  if (Number.isFinite(stamp) && stamp > 0) {
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    delete result.time;
    result.at = localStamp(stamp, now);
    result.ago = ageText(stamp, now);
  }
  if (Array.isArray(result.media)) {
    const canResolveByMessage = Number.isSafeInteger(message.seq) && message.seq > 0;
    result.media = compactMedia(result.media, canResolveByMessage);
  }
  if (isRecord(result.replyTo)) {
    result.replyTo = compactModelMessage(result.replyTo, opts);
    if (Object.keys(result.replyTo).length === 0) delete result.replyTo;
  }
  return result;
}

export function compactModelData(data, opts = {}) {
  if (Array.isArray(data)) return data.map((item) => compactModelData(item, opts));
  if (!isRecord(data)) return data;
  // 一次序列化只取一次 now：同一批消息的 ago 必须彼此可比（否则跨分钟边界会自相矛盾）。
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const inner = { now };
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    (key === 'messages' || key === 'newMessages') && Array.isArray(value)
      ? value.map((item) => compactModelMessage(item, inner))
      : compactModelData(value, inner)
  ]));
}

export function serializeModelData(data, opts = {}) {
  return JSON.stringify(compactModelData(data, opts));
}

export const QQ_READ_MAX_MODEL_BYTES = 40_000;

/**
 * Trim a QQ read response's message prefix (and trailing slang hints if needed)
 * so the serialized model view stays within maxBytes and avoids DSH spills.
 */
export function fitQQReadPayloadToByteBudget(buildPayload, messages, {
  maxBytes = QQ_READ_MAX_MODEL_BYTES,
  now = Date.now(),
  resolveSlang
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const querySlang = (subset) => {
    if (typeof resolveSlang !== 'function') return [];
    const found = resolveSlang(subset);
    return Array.isArray(found) ? found : [];
  };
  if (list.length === 0) {
    return { messages: [], slang: querySlang([]), truncated: false };
  }

  const allSlang = querySlang(list);
  if (Buffer.byteLength(serializeModelData(buildPayload(list, allSlang, false), { now })) <= maxBytes) {
    return { messages: list, slang: allSlang, truncated: false };
  }

  const envelopeBytes = Buffer.byteLength(serializeModelData(buildPayload([], [], true), { now }));
  const kept = [];
  let usedBytes = envelopeBytes;
  for (const item of list) {
    const itemBytes = Buffer.byteLength(JSON.stringify(compactModelMessage(item, { now }))) + 1;
    if (kept.length > 0 && usedBytes + itemBytes > maxBytes) break;
    kept.push(item);
    usedBytes += itemBytes;
  }

  let slang = querySlang(kept);
  const currentBytes = () => Buffer.byteLength(
    serializeModelData(buildPayload(kept, slang, kept.length < list.length), { now })
  );

  let bytes = currentBytes();
  while (kept.length > 1 && bytes > maxBytes) {
    const drop = bytes > maxBytes * 1.25
      ? Math.max(1, Math.min(kept.length - 1, Math.floor(kept.length * (bytes - maxBytes) / bytes)))
      : 1;
    kept.length -= drop;
    slang = querySlang(kept);
    bytes = currentBytes();
  }
  while (kept.length === 1 && slang.length > 0 && bytes > maxBytes) {
    slang = slang.slice(0, -1);
    bytes = currentBytes();
  }

  return {
    messages: kept,
    slang,
    truncated: kept.length < list.length
  };
}
