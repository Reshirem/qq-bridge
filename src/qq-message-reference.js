// QQ message IDs and bridge-local sequence numbers are separate namespaces.
// A bare number remains accepted when it cannot refer to two different things.

function invalidReference(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function parseQQMessageReference(reference) {
  const text = String(reference ?? '').trim();
  const match = /^(?:(id|seq):)?(-?[1-9]\d*)(?:@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/i.exec(text);
  if (!match) throw invalidReference('消息定位格式应为 id:<QQ消息ID> 或 seq:<本地序号>；QQ 消息 ID 可为负数');
  const kind = match[1]?.toLowerCase() ?? 'auto';
  const value = match[2];
  const bufferId = match[3]?.toLowerCase() ?? null;
  if (bufferId && kind !== 'seq') throw invalidReference('只有本地 seq 可以带缓存标识');
  if (kind === 'seq' && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
    throw invalidReference('本地 seq 必须是正的安全整数');
  }
  return { kind, value, bufferId };
}

/** Resolve only within one QQ source's own buffers; never conflate ID and seq. */
export function findQQMessageReference(state, reference) {
  const parsed = parseQQMessageReference(reference);
  if (parsed.bufferId && parsed.bufferId !== String(state?.bufferId ?? '').toLowerCase()) {
    throw invalidReference('本地消息缓存已清空或更换，请重新读取消息');
  }
  const messages = [
    ...(Array.isArray(state?.recentMessages) ? state.recentMessages : []),
    ...(Array.isArray(state?.unread) ? state.unread : []),
  ];
  const byId = parsed.kind === 'seq' ? null : messages.find((message) => (
    message?.messageId != null && String(message.messageId) === parsed.value
  )) ?? null;
  const bySeq = parsed.kind === 'id' ? null : messages.find((message) => (
    Number.isSafeInteger(message?.seq) && String(message.seq) === parsed.value
  )) ?? null;
  if (parsed.kind === 'auto' && bySeq && (!byId || byId.seq !== bySeq.seq)) {
    throw invalidReference(`数字 ${parsed.value} 可能是 QQ 消息 ID 或本地序号，请明确使用 id:${parsed.value} 或 seq:${parsed.value}`);
  }
  if (parsed.kind === 'seq') return { kind: 'seq', value: parsed.value, message: bySeq };
  return { kind: 'id', value: parsed.value, message: byId };
}
