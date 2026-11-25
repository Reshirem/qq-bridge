import { truncateText } from './md-to-plain.js';

const QQ_CARD_MAX_RAW_CHARS = 32_768;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cleanCardText(value, max = 240) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value)
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? truncateText(text, max) : '';
}

function safeHttpUrl(value, max = 300) {
  const raw = cleanCardText(value, 1024);
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';
  return cleanCardText(parsed.toString(), max);
}

function parseGroupInviteUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'mqqapi:' || parsed.hostname !== 'group' || parsed.pathname !== '/invite_join') {
    return null;
  }
  const groupId = String(parsed.searchParams.get('groupcode') || '').trim();
  if (!/^[1-9]\d{0,18}$/.test(groupId)) return null;
  const groupName = cleanCardText(parsed.searchParams.get('groupname') || '', 100);
  const seq = String(parsed.searchParams.get('msgseq') || '').trim();
  const senderId = String(parsed.searchParams.get('senderuin') || '').trim();
  return {
    groupId,
    ...(groupName ? { groupName } : {}),
    ...(/^[1-9]\d{0,24}$/.test(seq) ? { seq } : {}),
    ...(/^[1-9]\d{0,18}$/.test(senderId) ? { senderId } : {}),
  };
}

function pickMetaEntry(meta) {
  if (!isPlainObject(meta)) return { key: '', obj: null };
  for (const preferred of ['news', 'detail_1', 'music', 'feed', 'activity', 'contact', 'detail']) {
    if (isPlainObject(meta[preferred])) return { key: preferred, obj: meta[preferred] };
  }
  for (const [k, v] of Object.entries(meta)) {
    if (isPlainObject(v)) return { key: k, obj: v };
  }
  return { key: '', obj: null };
}

/**
 * Parse a QQ Ark/JSON card payload into bounded, single-line sanitized fields.
 * Never throws and never exposes internal tokens or non-http(s) URLs.
 */
export function parseQQCard(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (isPlainObject(raw) && (typeof raw.data === 'string' || typeof raw.content === 'string' || isPlainObject(raw.data) || isPlainObject(raw.content))) {
    obj = raw.data ?? raw.content;
  }
  if (typeof obj === 'string') {
    const trimmed = obj.trim();
    if (!trimmed || trimmed.length > QQ_CARD_MAX_RAW_CHARS) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(obj)) return null;

  const app = cleanCardText(obj.app, 80);
  const bizsrc = cleanCardText(obj.bizsrc, 80);
  const prompt = cleanCardText(obj.prompt, 160);
  const { key: metaKey, obj: metaObj } = pickMetaEntry(obj.meta);

  let tag = cleanCardText(metaObj?.tag ?? '', 40);
  let title = cleanCardText(metaObj?.title ?? '', 160);
  if (metaKey === 'detail_1' && !tag && title) {
    tag = cleanCardText(title, 40);
    title = '';
  }
  const desc = cleanCardText(metaObj?.desc ?? metaObj?.summary ?? obj.desc ?? '', 240);

  let url = '';
  for (const candidate of [metaObj?.jumpUrl, metaObj?.qqdocurl, metaObj?.url, metaObj?.musicUrl, obj.sourceUrl]) {
    const valid = safeHttpUrl(candidate);
    if (valid) {
      url = valid;
      break;
    }
  }

  const invite = parseGroupInviteUrl(metaObj?.jumpUrl) || parseGroupInviteUrl(obj.meta?.news?.jumpUrl) || null;

  if (!tag && !title && !desc && !prompt && !url && !invite) return null;

  return {
    ...(app ? { app } : {}),
    ...(bizsrc ? { bizsrc } : {}),
    ...(tag ? { tag } : {}),
    ...(title ? { title } : {}),
    ...(desc ? { desc } : {}),
    ...(prompt ? { prompt } : {}),
    ...(url ? { url } : {}),
    ...(invite ? { invite } : {}),
  };
}

function normForDedup(text) {
  return String(text || '')
    .replace(/^\[(?:QQ小程序|链接|分享帖子)\]\s*/u, '')
    .replace(/\s+/g, '')
    .toLocaleLowerCase();
}

/**
 * Format a QQ Ark/JSON card payload into a concise, single-line summary string.
 */
export function formatQQCardText(rawOrCard) {
  const card = isPlainObject(rawOrCard) && (
    'tag' in rawOrCard || 'title' in rawOrCard || 'desc' in rawOrCard
    || 'prompt' in rawOrCard || 'url' in rawOrCard || 'invite' in rawOrCard
  )
    ? rawOrCard
    : parseQQCard(rawOrCard);
  if (!card) return '[卡片消息]';

  const parts = [];
  const headParts = [];
  if (card.tag) headParts.push(card.tag);
  if (card.title && normForDedup(card.title) !== normForDedup(card.tag)) {
    headParts.push(card.title);
  }
  const header = headParts.join('｜');
  if (header) parts.push(header);

  if (card.desc && normForDedup(card.desc) !== normForDedup(card.title) && normForDedup(card.desc) !== normForDedup(header)) {
    parts.push(card.desc);
  }

  if (card.prompt) {
    const promptNorm = normForDedup(card.prompt);
    const covered = parts.some((p) => {
      const pNorm = normForDedup(p);
      return pNorm && (pNorm === promptNorm || pNorm.includes(promptNorm) || promptNorm.includes(pNorm));
    });
    if (!covered) parts.push(card.prompt);
  }

  let body = '';
  if (parts.length >= 2 && header) {
    body = `${parts[0]} — ${parts.slice(1).join(' / ')}`;
  } else {
    body = parts.join(' — ');
  }

  if (card.invite?.groupId) {
    const groupSuffix = `（群号 ${card.invite.groupId}）`;
    body = body ? `${body}${groupSuffix}` : `群邀请${groupSuffix}`;
  }

  const tail = card.url ? (body ? ` ${card.url}` : card.url) : '';
  const summary = `${body}${tail}`.trim();
  if (!summary) return '[卡片消息]';
  return truncateText(`[卡片：${summary}]`, 420);
}
