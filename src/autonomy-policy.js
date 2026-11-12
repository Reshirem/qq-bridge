// Pure policy for the single autonomous QQ-session runtime.
// Keep this small and deterministic so wake/read behavior is easy to audit.

/**
 * Classify an incoming event without exposing its body to the model.
 * Private messages are direct by definition. Group wake signals include a real
 * @ or verified reply to this account, a persona-card name, or a configured keyword.
 */
export function classifyIncomingWake({ kind, message, selfId, replyTargetIsSelf = false, text = '', attentionKeywords = [], roleCardNames = [], reminders = {} } = {}) {
  if (kind === 'private') return reminders.private !== false ? 'private' : null;
  if (kind !== 'group') return null;
  const self = String(selfId ?? '').trim();
  const nativeAtSelf = !!self && Array.isArray(message)
    && message.some((segment) => segment?.type === 'at' && String(segment.data?.qq ?? '') === self);
  if (nativeAtSelf && reminders.atMention !== false) return 'atMention';
  if (replyTargetIsSelf === true && reminders.reply !== false) return 'reply';
  const normalizedText = String(text ?? '').normalize('NFKC').toLocaleLowerCase();
  for (const rawName of reminders.roleCardName !== false && Array.isArray(roleCardNames) ? roleCardNames : []) {
    const name = String(rawName ?? '').trim();
    const normalizedName = name.normalize('NFKC').toLocaleLowerCase();
    if (normalizedName && normalizedText.includes(normalizedName)) return `roleCardName:${name}`;
  }
  for (const rawKeyword of reminders.keyword !== false && Array.isArray(attentionKeywords) ? attentionKeywords : []) {
    const keyword = String(rawKeyword ?? '').trim().normalize('NFKC').toLocaleLowerCase();
    if (keyword.length >= 2 && normalizedText.includes(keyword)) return `keyword:${String(rawKeyword).trim()}`;
  }
  return null;
}

// The event type and structured recipient determine a poke, never its custom wording.
export function isPokeToSelf(event) {
  const self = String(event?.self_id ?? '');
  const sender = String(event?.sender_id ?? event?.user_id ?? '');
  return event?.notice_type === 'notify' && event?.sub_type === 'poke'
    && /^[1-9]\d*$/.test(self) && /^[1-9]\d*$/.test(sender)
    && sender !== self && String(event.target_id ?? '') === self;
}

export function reminderEnabled(reason, reminders = {}) {
  if (String(reason ?? '').startsWith('未处理提醒（再次提醒）：') && reminders.unreadFollowup === false) return false;
  const base = wakeReasonBase(String(reason ?? '').replace(/^未处理提醒（再次提醒）：/, ''));
  return reminders[base] !== false;
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
  return base === 'private' || base === 'atMention' || base === 'reply';
}
