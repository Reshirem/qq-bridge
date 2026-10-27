// Pure policy for the single autonomous QQ-session runtime.
// Keep this small and deterministic so wake/read behavior is easy to audit.

/**
 * Classify an incoming event without exposing its body to the model.
 * Private messages are direct by definition. Group wake is reserved for a
 * real OneBot @ segment addressed to this account, or a verified reply to it.
 */
export function classifyIncomingWake({ kind, message, selfId, replyTargetIsSelf = false } = {}) {
  if (kind === 'private') return 'private';
  if (kind !== 'group') return null;
  const self = String(selfId ?? '').trim();
  const nativeAtSelf = !!self && Array.isArray(message)
    && message.some((segment) => segment?.type === 'at' && String(segment.data?.qq ?? '') === self);
  return nativeAtSelf || replyTargetIsSelf === true ? 'atMention' : null;
}

/** Whether this is the first-session prompt, optionally carrying its direct trigger. */
export function isBootstrapWakeReason(reason) {
  const value = String(reason ?? '');
  return value === 'bootstrap' || value.startsWith('bootstrap:');
}

/** Remove bootstrap metadata and the sequence suffix from a wake reason. */
export function wakeReasonBase(reason) {
  let value = String(reason ?? '');
  if (value.startsWith('bootstrap:')) value = value.slice('bootstrap:'.length);
  return value.split('@seq')[0].split(':')[0];
}

/**
 * Only an actual direct event wake receives an inline snapshot. A plain manual
 * bootstrap, timer, or admin wake leaves all other buffered messages to the
 * agent's on-demand read tools.
 */
export function shouldAttachWakeSnapshot(reason) {
  const base = wakeReasonBase(reason);
  return base === 'private' || base === 'atMention';
}
