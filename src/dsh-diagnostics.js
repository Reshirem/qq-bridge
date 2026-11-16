// Bounded diagnostics from DSH's durable events. Do not retain image blocks or
// successful tool text (which may contain private QQ messages or memories).
const safeCode = (value, redact) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:/-]{1,100}$/.test(value)) return null;
  return String(redact(value)) === value ? value : null;
};
const boundedText = (value, redact) => {
  if (typeof value !== 'string') return '';
  // Omit oversized upstream errors, rather than slicing through a credential
  // before the caller's exact-token redactor has seen it.
  if (value.length > 16000) return '[oversized diagnostic omitted]';
  return String(redact(value))
    .replace(/\bdata:image\/[A-Za-z0-9.+-]+(?:;[^,\s]*)?,[^\s"'<>)]*/gi, '[image data omitted]')
    .replace(/(?:iVBORw0KGgo|\/9j\/|R0lGOD(?:dh|lh)|UklGR)[A-Za-z0-9+/=]+/g, '[image data omitted]')
    .replace(/[A-Za-z0-9+/_-]{256,}={0,2}/g, '[encoded data omitted]')
    .slice(0,500);
};

// These are DSH MCP image-admission reasons, not arbitrary tool-result prose.
// Keep dynamic model names and attachment-store errors out of the activity log.
const imageAdmissionReasons = new Set([
  'the declared media type is not PNG, JPEG, WebP, or GIF',
  'the image data is not canonical base64',
  'another image in the same result was invalid',
  'no attachment store is mounted',
  'the current model route could not be resolved',
  'the current model route could not be verified',
  'the tool call was canceled before image storage',
  'durable image storage rejected the result',
]);
function imageAdmissionReason(value) {
  if (imageAdmissionReasons.has(value)) return value;
  if (/^model "[^\r\n]*" does not declare image input$/.test(value)) return 'the current model does not declare image input';
  if (value.startsWith('image admission rejected the result: ')) return 'image admission rejected the result';
  return 'unrecognized image admission reason';
}

export function toolResultDiagnostics(event, redact = text => text) {
  const data = event?.data ?? {};
  const message = data.message ?? {};
  const content = Array.isArray(message.content) ? message.content : [];
  const failed = message.isError === true || data.error != null || content.some(block => block?.isError === true);
  const errorCode = safeCode(data.error?.code,redact);
  const errorName = safeCode(data.error?.name,redact);
  const errors = failed ? content.filter(block => block?.type === 'text').slice(0,3).map(block => boundedText(block.text,redact)).filter(Boolean) : [];
  let accepted = 0;
  let rejected = 0;
  const reasons = new Set();
  // DSH does not admit images from failed tools, even if a malformed result
  // happens to contain an image-shaped block or the replacement marker.
  for (const block of failed ? [] : content) {
    if (block?.type === 'image') {
      // Current durable messages contain attachment references, never MCP's
      // raw { data, mimeType } image block.
      if (typeof block.attachment?.attachmentId === 'string' && block.attachment.attachmentId) accepted += 1;
      continue;
    }
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 4000) continue;
    // Match only DSH's complete replacement block, not quoted messages/JSON
    // containing these words. Partial result text is not proof of admission.
    const match = /^\[image unavailable: [^;\r\n]{1,100}; ([\s\S]{1,3000}); raw image data remains available to programmatic callers\]$/.exec(block.text);
    if (!match) continue;
    rejected += 1;
    if (reasons.size < 5) reasons.add(boundedText(imageAdmissionReason(match[1]),redact));
  }
  const imageAdmission = accepted || rejected ? {
    status: rejected ? (accepted ? 'partial' : 'rejected') : 'accepted',
    accepted, rejected, reasons: [...reasons],
  } : null;
  return {
    ok: !failed,
    error: failed ? errors.join('\n') || boundedText(message.error,redact) || errorCode || errorName || 'DSH 工具执行失败' : null,
    ...(errorCode ? { errorCode } : {}),
    ...(errorName ? { errorName } : {}),
    ...(imageAdmission ? { imageAdmission } : {}),
  };
}

export function nextLlmRetryState(previous, event, { now = Date.now(), redact = text => text, replay = false } = {}) {
  const data = event?.data ?? {};
  if (['turn/start','step/start','turn/end','assistant/message','llm/response'].includes(event?.type)) return null;
  if (event?.type === 'llm/retry-started') {
    return previous?.retryId === data.retryId && (data.retry === undefined || data.retry === previous.retry)
      ? { ...previous, waiting: false, retryAt: null } : previous;
  }
  if (event?.type !== 'llm/retry') return previous;
  const retryId = safeCode(data.retryId,redact);
  if (!retryId || !Number.isSafeInteger(data.retry) || data.retry < 1) return previous;
  const timestamp = Number.isSafeInteger(event.time) && event.time >= 0 ? event.time : null;
  const delay = Number.isFinite(data.delayMs) && data.delayMs >= 0 ? Math.min(data.delayMs,86400000) : null;
  const base = timestamp !== null ? timestamp : replay ? null : now;
  return {
    retryId, retry: data.retry,
    maxRetries: Number.isSafeInteger(data.maxRetries) && data.maxRetries >= 0 ? data.maxRetries : null,
    provider: boundedText(data.provider,redact),
    mode: data.mode === 'always' ? 'always' : 'normal', waiting: true,
    retryAt: base !== null && delay !== null ? base + delay : null,
    code: safeCode(data.failure?.code,redact),
    reason: boundedText(data.failure?.message,redact) || '模型请求暂未完成',
  };
}

export function llmRetryFromSnapshot(records, redact = text => text) {
  let retry = null;
  for (const record of Array.isArray(records) ? records : []) {
    retry = nextLlmRetryState(retry, record?.event, { redact, replay: true });
  }
  return retry;
}
