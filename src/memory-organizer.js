const STATE_VERSION = 1;
const JOB_STATUSES = new Set(['queued', 'reading', 'organizing', 'writing', 'completed', 'failed']);
const MAX_RETAINED_JOBS = 300;

function safeSeq(value) {
  if (value === null || value === undefined || value === '') return null;
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq >= -1 ? seq : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyState() {
  return {
    version: STATE_VERSION,
    sources: Object.create(null),
    sessionsByDay: Object.create(null),
    restScheduledDays: [],
    jobs: []
  };
}

function retainJobs(jobs) {
  const completed = jobs.filter((job) => job.status === 'completed');
  const unfinished = jobs.filter((job) => job.status !== 'completed');
  return [...completed.slice(-MAX_RETAINED_JOBS), ...unfinished]
    .sort((a, b) => a.createdAt - b.createdAt);
}

function normalizeJob(value, { recoverInterrupted = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const jobId = String(value.jobId ?? '').trim();
  const sourceSessionId = String(value.sourceSessionId ?? '').trim();
  const fromSeq = safeSeq(value.fromSeq);
  const throughSeq = safeSeq(value.throughSeq);
  let status = String(value.status ?? 'queued');
  if (!jobId || !sourceSessionId || fromSeq === null || throughSeq === null
      || throughSeq < fromSeq || !JOB_STATUSES.has(status)) return null;
  const interrupted = recoverInterrupted && ['reading', 'organizing', 'writing'].includes(status);
  if (interrupted) status = 'queued';
  const progress = value.progress && typeof value.progress === 'object' && !Array.isArray(value.progress)
    ? value.progress : { stage: status, completed: 0, total: null };
  const organizerSessionId = typeof value.organizerSessionId === 'string' ? value.organizerSessionId.trim() : '';
  const organizerSessionIds = [...new Set([
    ...(Array.isArray(value.organizerSessionIds) ? value.organizerSessionIds : []),
    ...(organizerSessionId ? [organizerSessionId] : [])
  ].filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
  return {
    jobId,
    kind: value.kind === 'manual' ? 'manual' : 'rest',
    sourceSessionId,
    fromSeq,
    throughSeq,
    triggerSeq: safeSeq(value.triggerSeq),
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(value.day ?? '')) ? String(value.day) : '',
    status,
    progress: interrupted ? { ...progress, stage: '桥接重启后恢复', completed: Number(progress.completed) || 0 } : progress,
    modelSelection: value.modelSelection && typeof value.modelSelection === 'object'
      && typeof value.modelSelection.provider === 'string' && typeof value.modelSelection.model === 'string'
      ? {
        provider: value.modelSelection.provider,
        model: value.modelSelection.model,
        ...(typeof value.modelSelection.reasoningEffort === 'string' ? { reasoningEffort: value.modelSelection.reasoningEffort } : {})
      } : null,
    organizerSessionId,
    organizerSessionIds,
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
    error: typeof value.error === 'string' ? value.error.slice(0, 1000) : '',
    result: value.result && typeof value.result === 'object' && !Array.isArray(value.result) ? value.result : null
  };
}

export function normalizeMemoryOrganizerState(value) {
  if (value == null) return emptyState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('memory-organizer state must be a JSON object');
  }
  if (value.version !== undefined && value.version !== STATE_VERSION) {
    throw new Error(`unsupported memory-organizer state version: ${String(value.version)}`);
  }
  const state = emptyState();
  for (const [sessionId, source] of Object.entries(value.sources ?? {})) {
    if (!sessionId || !source || typeof source !== 'object' || Array.isArray(source)) continue;
    const lastProcessedSeq = safeSeq(source.lastProcessedSeq) ?? -1;
    const lastScheduledSeq = Math.max(lastProcessedSeq, safeSeq(source.lastScheduledSeq) ?? lastProcessedSeq);
    state.sources[sessionId] = { lastProcessedSeq, lastScheduledSeq };
  }
  for (const [day, sessionId] of Object.entries(value.sessionsByDay ?? {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof sessionId === 'string' && sessionId.trim()) {
      state.sessionsByDay[day] = sessionId.trim();
    }
  }
  state.jobs = retainJobs((Array.isArray(value.jobs) ? value.jobs : [])
    .map((job) => normalizeJob(job, { recoverInterrupted: true }))
    .filter(Boolean));
  state.restScheduledDays = [...new Set([
    ...(Array.isArray(value.restScheduledDays) ? value.restScheduledDays : []),
    ...state.jobs.filter((job) => job.kind === 'rest').map((job) => job.day)
  ].filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day))))].slice(-400);
  return state;
}

/**
 * Durable, bridge-owned progress for independent memory organization.
 * The caller supplies qq-bridge's atomic JSON writer so this module stays focused
 * on cursor and task semantics rather than filesystem policy.
 */
export function createMemoryOrganizerState(initialState, persist) {
  if (typeof persist !== 'function') throw new TypeError('persist must be a function');
  let state = normalizeMemoryOrganizerState(initialState);

  function save() {
    state.version = STATE_VERSION;
    state.jobs = retainJobs(state.jobs);
    persist(clone(state));
  }

  function sourceState(sessionId) {
    const id = String(sessionId ?? '').trim();
    if (!id) throw new Error('source DSH sessionId is required');
    return state.sources[id] ?? { lastProcessedSeq: -1, lastScheduledSeq: -1 };
  }

  function enqueue({ jobId, kind = 'rest', sourceSessionId, throughSeq, triggerSeq = null, day = '' }) {
    const id = String(sourceSessionId ?? '').trim();
    const end = safeSeq(throughSeq);
    if (!id || end === null) throw new Error('sourceSessionId and valid throughSeq are required');
    const scheduledDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : '';
    if (kind === 'rest' && !scheduledDay) throw new Error('rest organizer jobs require a valid day');
    const trigger = safeSeq(triggerSeq);
    const stableId = String(jobId ?? (kind === 'rest' && trigger !== null
      ? `rest:${id}:${trigger}`
      : '')).trim();
    if (!stableId) throw new Error('jobId is required for non-rest organizer jobs');
    const existing = state.jobs.find((job) => job.jobId === stableId);
    if (existing) return clone(existing);
    if (kind === 'rest' && state.restScheduledDays.includes(scheduledDay)) return null;

    const source = sourceState(id);
    const pendingEnd = state.jobs
      .filter((job) => job.sourceSessionId === id && !['completed'].includes(job.status))
      .reduce((max, job) => Math.max(max, job.throughSeq), source.lastProcessedSeq);
    const fromSeq = Math.max(source.lastProcessedSeq, pendingEnd);
    if (end <= fromSeq) return null;
    const timestamp = Date.now();
    const job = {
      jobId: stableId,
      kind: kind === 'manual' ? 'manual' : 'rest',
      sourceSessionId: id,
      fromSeq,
      throughSeq: end,
      triggerSeq: trigger,
      day: scheduledDay,
      status: 'queued',
      progress: { stage: '排队中', completed: 0, total: null },
      modelSelection: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      error: '',
      result: null
    };
    state.jobs.push(job);
    if (kind === 'rest') {
      state.restScheduledDays = [...state.restScheduledDays, scheduledDay].slice(-400);
    }
    state.sources[id] = {
      lastProcessedSeq: source.lastProcessedSeq,
      lastScheduledSeq: Math.max(source.lastScheduledSeq, end)
    };
    save();
    return clone(job);
  }

  function updateJob(jobId, patch) {
    const index = state.jobs.findIndex((job) => job.jobId === String(jobId));
    if (index < 0) return null;
    const current = state.jobs[index];
    const next = normalizeJob({
      ...current,
      ...patch,
      updatedAt: Date.now(),
      progress: patch.progress ? { ...current.progress, ...patch.progress } : current.progress
    });
    if (!next) throw new Error(`invalid memory organizer job update: ${String(jobId)}`);
    state.jobs[index] = next;
    if (next.status === 'completed') {
      const source = sourceState(next.sourceSessionId);
      // A later range cannot skip an earlier unfinished range for the same source.
      const earlierPending = state.jobs.some((job) => job.sourceSessionId === next.sourceSessionId
        && job.throughSeq < next.throughSeq && job.status !== 'completed');
      if (!earlierPending) {
        state.sources[next.sourceSessionId] = {
          lastProcessedSeq: Math.max(source.lastProcessedSeq, next.throughSeq),
          lastScheduledSeq: Math.max(source.lastScheduledSeq, next.throughSeq)
        };
      }
    }
    save();
    return clone(next);
  }

  return {
    snapshot: () => clone(state),
    jobs: () => clone(state.jobs),
    source: (sessionId) => clone(sourceState(sessionId)),
    sessionForDay: (day) => state.sessionsByDay[String(day)] ?? null,
    setSessionForDay(day, sessionId) {
      const date = String(day ?? '');
      const id = String(sessionId ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !id) throw new Error('valid day and organizer sessionId are required');
      state.sessionsByDay[date] = id;
      save();
      return id;
    },
    clearSessionForDay(day, expectedSessionId = '') {
      const date = String(day ?? '');
      const expected = String(expectedSessionId ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
      const current = state.sessionsByDay[date];
      if (!current || (expected && current !== expected)) return false;
      delete state.sessionsByDay[date];
      save();
      return true;
    },
    enqueueRest(input) { return enqueue({ ...input, kind: 'rest' }); },
    enqueueManual(input) { return enqueue({ ...input, kind: 'manual' }); },
    updateJob,
    nextQueued() {
      const candidates = state.jobs.filter((job) => job.status === 'queued'
        && !state.jobs.some((earlier) => earlier.sourceSessionId === job.sourceSessionId
          && earlier.throughSeq < job.throughSeq && earlier.status !== 'completed'));
      candidates.sort((a, b) => a.createdAt - b.createdAt || a.fromSeq - b.fromSeq);
      return candidates.length ? clone(candidates[0]) : null;
    },
    retryJob(jobId) {
      const job = state.jobs.find((item) => item.jobId === String(jobId));
      if (!job || job.status !== 'failed') return null;
      return updateJob(jobId, { status: 'queued', error: '', progress: { stage: '等待重试', completed: job.progress?.completed ?? 0 } });
    }
  };
}

function normalizedToolName(value) {
  const name = String(value ?? '').trim().toLowerCase();
  const tail = name.split(/__|[./:]/).filter(Boolean).at(-1) ?? name;
  return tail.replace(/[^a-z0-9_-]/g, '');
}

export function organizerToolLeafName(value) {
  return normalizedToolName(value);
}

function recordEvent(record) {
  return record?.event && typeof record.event === 'object' ? record.event : record;
}

function isFailedToolResult(event) {
  const result = event?.data?.message;
  return result?.isError === true
    || event?.data?.error != null
    || (Array.isArray(result?.content) && result.content.some((block) => block?.isError === true));
}

/** Return successful agent_rest result records, paired by DSH tool call id. */
export function successfulAgentRestBoundaries(records) {
  const ordered = (Array.isArray(records) ? records : [])
    .filter((record) => record && typeof record === 'object')
    .slice()
    .sort((a, b) => (safeSeq(a?.seq ?? a?.event?.seq) ?? -1) - (safeSeq(b?.seq ?? b?.event?.seq) ?? -1));
  const calls = new Map();
  const boundaries = [];
  for (const record of ordered) {
    const event = recordEvent(record);
    const seq = safeSeq(record?.seq ?? event?.seq);
    if (event?.type === 'tool/call') {
      const callId = String(event.data?.callId ?? '').trim();
      if (!callId) continue;
      calls.set(callId, normalizedToolName(event.data?.name));
      continue;
    }
    if (event?.type !== 'tool/result') continue;
    const callId = String(event.data?.message?.source?.callId ?? '').trim();
    const toolName = calls.get(callId) ?? normalizedToolName(event.data?.message?.source?.toolName ?? event.data?.message?.name);
    if (callId) calls.delete(callId);
    if (toolName === 'agent_rest' && seq !== null && !isFailedToolResult(event)) boundaries.push({ seq, callId });
  }
  return boundaries;
}

function parseJsonText(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return '';
  try { return JSON.parse(text); } catch { return value; }
}

function visibleMessageContent(message) {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return message?.content ?? null;
  return message.content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'text') return String(block.text ?? '');
    if (block.type === 'image') return { type: 'image', description: block.alt ?? block.name ?? '' };
    return { type: String(block.type ?? 'content') };
  });
}

function compactQQMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const out = {};
  for (const key of [
    'seq', 'messageId', 'sender', 'userId', 'isSelf', 'isOwner', 'quoteTargetIsSelf',
    'time', 'at', 'ago', 'text', 'plain', 'tail', 'kind', 'textTruncated'
  ]) {
    if (message[key] !== undefined && message[key] !== null && message[key] !== '') out[key] = message[key];
  }
  if (out.textTruncated === true) {
    // Keep the message identity and sender metadata, but do not offer a clipped
    // body as complete evidence to the memory model.
    delete out.text;
    delete out.plain;
    delete out.tail;
  }
  if (Array.isArray(message.media) && message.media.length) {
    out.media = message.media.map((item) => ({
      ...(item?.kind ? { kind: String(item.kind) } : {}),
      ...(item?.summary ? { summary: String(item.summary) } : {})
    }));
  }
  if (Array.isArray(message.forwardIds) && message.forwardIds.length) out.hasForward = true;
  return out;
}

const QQ_MESSAGE_CONSISTENCY_FIELDS = Object.freeze([
  'userId', 'isSelf', 'isOwner', 'quoteTargetIsSelf', 'time', 'at',
  'text', 'plain', 'tail', 'kind', 'media', 'hasForward', 'textTruncated'
]);

function conflictingQQMessageFields(previous, current) {
  return QQ_MESSAGE_CONSISTENCY_FIELDS.filter((field) =>
    previous?.[field] !== undefined
    && current?.[field] !== undefined
    && JSON.stringify(previous[field]) !== JSON.stringify(current[field]));
}

function mergeQQMessageFields(previous, current) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(current ?? {})) {
    if (merged[key] === undefined || merged[key] === null || merged[key] === '') merged[key] = value;
  }
  return merged;
}

function containsTruncationMarker(value) {
  if (Array.isArray(value)) return value.some(containsTruncationMarker);
  if (value && typeof value === 'object') {
    return Object.values(value).some(containsTruncationMarker);
  }
  return typeof value === 'string' && /(?:…\(truncated\)|\[truncated\]|content was truncated)/i.test(value);
}

/**
 * Build a model-facing evidence list from persisted, user-visible session events.
 * Calls are retained for context, but only successful tool results carry returned data.
 */
export function organizerTranscriptRecords(records, { sanitize = (value) => value } = {}) {
  const ordered = (Array.isArray(records) ? records : [])
    .filter((record) => record && typeof record === 'object')
    .slice()
    .sort((a, b) => (safeSeq(a?.seq ?? a?.event?.seq) ?? -1) - (safeSeq(b?.seq ?? b?.event?.seq) ?? -1));
  const toolCalls = new Map();
  const seenQQMessages = new Map();
  const pendingPartialQQReads = new Map();
  const events = [];
  const incompleteReasons = new Set();
  let incomplete = false;
  const markIncomplete = (reason) => {
    incomplete = true;
    if (incompleteReasons.size < 20) incompleteReasons.add(reason);
  };
  for (const record of ordered) {
    const event = recordEvent(record);
    const seq = safeSeq(record?.seq ?? event?.seq);
    if (seq === null) { markIncomplete('事件缺少有效序号'); continue; }
    const type = String(event?.type ?? '');
    if (type === 'user/message' || type === 'assistant/message') {
      const message = event?.data?.message ?? event?.data;
      const content = sanitize(visibleMessageContent(message));
      if (content !== null && content !== undefined && content !== '') {
        events.push({ seq, time: Number(event?.time) || undefined, role: type.startsWith('assistant/') ? 'assistant' : 'user', content });
      }
      continue;
    }
    if (type === 'tool/call') {
      const callId = String(event.data?.callId ?? '');
      const name = String(event.data?.name ?? 'unknown-tool');
      const args = parseJsonText(event.data?.arguments ?? event.data?.input ?? null);
      if (callId) toolCalls.set(callId, { name, args });
      events.push({ seq, time: Number(event?.time) || undefined, kind: 'tool-call', name, arguments: sanitize(args) });
      continue;
    }
    if (type === 'tool/result') {
      const message = event?.data?.message ?? {};
      const callId = String(message?.source?.callId ?? '');
      const call = toolCalls.get(callId);
      const name = call?.name ?? String(message?.source?.toolName ?? message?.name ?? 'unknown-tool');
      if (callId) toolCalls.delete(callId);
      const content = (Array.isArray(message.content) ? message.content : []).map((block) => {
        if (!block || typeof block !== 'object') return block;
        return block.type === 'text'
          ? parseJsonText(block.text)
          : { type: String(block.type ?? 'content') };
      });
      const result = sanitize(content.length === 1 ? content[0] : content);
      const ok = !isFailedToolResult(event);
      if (containsTruncationMarker(result) || (event?.surfaceOp && event.surfaceOp !== 'append')) {
        markIncomplete(`DSH 事件 ${seq} 的工具结果含截断标记或被替换`);
      }
      const toolLeaf = normalizedToolName(name);
      const resultValue = content.length === 1 ? content[0] : content;
      const resultObject = resultValue && typeof resultValue === 'object' && !Array.isArray(resultValue)
        ? resultValue : null;
      if (ok && (toolLeaf.startsWith('qq_get_') || toolLeaf === 'qq_wait_for_messages') && resultObject) {
        const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
        const key = String(resultObject.key ?? args.key ?? '').trim();
        const bufferId = String(resultObject.bufferId ?? '').trim();
        const rawReadThroughSeq = resultObject.readThroughSeq;
        const numericReadThroughSeq = rawReadThroughSeq === null || rawReadThroughSeq === undefined || rawReadThroughSeq === ''
          ? NaN : Number(rawReadThroughSeq);
        const readThroughSeq = Number.isSafeInteger(numericReadThroughSeq) && numericReadThroughSeq >= 0
          ? numericReadThroughSeq : null;
        const rawAfterSeq = args.afterSeq;
        const numericAfterSeq = rawAfterSeq === null || rawAfterSeq === undefined || rawAfterSeq === ''
          ? NaN : Number(rawAfterSeq);
        const afterSeq = Number.isSafeInteger(numericAfterSeq) && numericAfterSeq >= 0 ? numericAfterSeq : null;
        const hasMessageList = Array.isArray(resultObject.messages) || Array.isArray(resultObject.newMessages);
        const messages = Array.isArray(resultObject.messages) ? resultObject.messages
          : Array.isArray(resultObject.newMessages) ? resultObject.newMessages
            : resultObject.info && typeof resultObject.info === 'object' ? [resultObject.info]
              : resultObject.message && typeof resultObject.message === 'object' ? [resultObject.message] : [];
        if (!hasMessageList && messages.length === 0) {
          events.push({ seq, time: Number(event?.time) || undefined, kind: 'tool-result', name, ok, result });
          continue;
        }
        events.push({
          seq, time: Number(event?.time) || undefined, kind: 'qq-read', tool: toolLeaf, key,
          bufferId, readThroughSeq, afterSeq, partial: resultObject.partial === true, messageCount: messages.length
        });
        if (hasMessageList && messages.length && readThroughSeq === null) {
          markIncomplete(`DSH 事件 ${seq} 的 QQ 消息列表缺少 readThroughSeq`);
        }
        if (hasMessageList && resultObject.partial === true) {
          if (!key || readThroughSeq === null) {
            markIncomplete(`DSH 事件 ${seq} 的 partial QQ 读取缺少来源 key 或 readThroughSeq`);
          }
          else {
            const pendingWatermark = pendingPartialQQReads.get(key);
            if (pendingWatermark !== undefined && afterSeq !== null && afterSeq !== pendingWatermark) {
              markIncomplete(`DSH 事件 ${seq} 的 partial QQ 读取没有从前页水位 ${pendingWatermark} 接续`);
            }
            pendingPartialQQReads.set(key, readThroughSeq);
          }
        } else if (hasMessageList && key && pendingPartialQQReads.has(key)
          && afterSeq === pendingPartialQQReads.get(key)) {
          pendingPartialQQReads.delete(key);
        }
        for (const qqMessage of messages) {
          if (containsTruncationMarker(qqMessage)) markIncomplete(`DSH 事件 ${seq} 的 QQ 消息正文含截断标记`);
          const compact = compactQQMessage(qqMessage);
          const messageId = String(compact?.messageId ?? '').trim();
          const messageSeq = Number(compact?.seq);
          const identity = key && messageId ? `${key}\u0000${messageId}`
            : key && bufferId && Number.isSafeInteger(messageSeq) && messageSeq > 0
              ? `${key}\u0000${bufferId}\u0000seq:${messageSeq}` : '';
          if (identity && seenQQMessages.has(identity)) {
            const previous = seenQQMessages.get(identity);
            const conflictingFields = conflictingQQMessageFields(previous.message, compact);
            if (conflictingFields.length) {
              markIncomplete(`DSH 事件 ${seq} 中重复 QQ 消息的正文或稳定字段不一致`);
            } else {
              // Detail and list tools expose different optional fields for the
              // same message. Keep the richer union while checking only fields
              // present in both results; sender is a display label, not identity.
              previous.message = mergeQQMessageFields(previous.message, compact);
              previous.event.message = sanitize(previous.message);
            }
            continue;
          }
          const qqEvent = {
            seq, time: Number(event?.time) || undefined, kind: 'qq-message', tool: toolLeaf, key,
            bufferId, readThroughSeq, message: sanitize(compact)
          };
          events.push(qqEvent);
          if (identity) seenQQMessages.set(identity, { message: compact, event: qqEvent });
        }
        continue;
      }
      events.push({ seq, time: Number(event?.time) || undefined, kind: 'tool-result', name, ok, result });
    }
  }
  return { events, incomplete, incompleteReasons: [...incompleteReasons] };
}
