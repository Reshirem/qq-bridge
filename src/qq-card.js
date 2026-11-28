import { truncateText } from './md-to-plain.js';

const QQ_CARD_MAX_RAW_CHARS = 32_768;
const QQ_CARD_MAX_PER_MESSAGE = 4;

// Pure analytics / share-sheet tracking query params that never carry content identity or auth.
const PURE_TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'spm_id_from', 'from_spmid',
  'share_source', 'share_medium', 'share_plat', 'share_session_id',
  'share_tag', 'share_from', 'share_times', 'share_id', 'share_copy_from',
  'bbid', 'buvid', 'vd_source', 'unique_k', 'is_story_h5', 'plat_id',
  'xsec_source', 'seid',
]);
const SHARE_TRACKING_PARAMS = new Set([
  'share_source', 'share_medium', 'share_plat', 'share_session_id',
  'share_tag', 'share_from', 'share_times', 'share_id', 'share_copy_from',
  'bbid', 'buvid', 'vd_source', 'unique_k',
]);

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

function safeHttpUrl(value, { max = 512, stripTracking = false } = {}) {
  let raw = cleanCardText(value, 2048);
  if (!raw) return '';
  if (raw.startsWith('//') && raw.length > 2 && !raw.startsWith('///')) {
    raw = `https:${raw}`;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';
  if (stripTracking && parsed.searchParams.size > 0) {
    let strippedShare = false;
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (PURE_TRACKING_PARAMS.has(lower)) {
        if (SHARE_TRACKING_PARAMS.has(lower)) strippedShare = true;
        parsed.searchParams.delete(key);
      }
    }
    if (strippedShare) {
      for (const key of [...parsed.searchParams.keys()]) {
        if (key.toLowerCase() === 'ts') parsed.searchParams.delete(key);
      }
    }
  }
  const normalized = parsed.toString();
  // Reject instead of emitting a broken half-truncated URL.
  return normalized.length <= max ? normalized : '';
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

  let tag = cleanCardText(metaObj?.tag ?? metaObj?.source_name ?? metaObj?.app_name ?? '', 40);
  let title = cleanCardText(metaObj?.title ?? '', 160);
  if (metaKey === 'detail_1' && !tag && title) {
    tag = cleanCardText(title, 40);
    title = '';
  }
  const desc = cleanCardText(metaObj?.desc ?? metaObj?.summary ?? metaObj?.brief ?? obj.desc ?? '', 240);
  // Only read explicit content-author fields; metaObj.host.nick is the QQ sharer.
  const author = cleanCardText(metaObj?.author ?? metaObj?.creator ?? metaObj?.authorName ?? '', 60);

  let url = '';
  for (const candidate of [
    metaObj?.jumpUrl, metaObj?.qqdocurl, metaObj?.url, metaObj?.musicUrl,
    metaObj?.targetUrl, metaObj?.webUrl, obj.sourceUrl,
  ]) {
    const valid = safeHttpUrl(candidate, { max: 512, stripTracking: true });
    if (valid) {
      url = valid;
      break;
    }
  }

  const invite = parseGroupInviteUrl(metaObj?.jumpUrl) || parseGroupInviteUrl(obj.meta?.news?.jumpUrl) || null;

  // Keep CDN signed query params intact; never read app icons or group invite avatars.
  let previewUrl = '';
  if (!invite) {
    for (const candidate of [
      metaObj?.preview, metaObj?.picUrl, metaObj?.cover, metaObj?.image, metaObj?.img,
    ]) {
      const valid = safeHttpUrl(candidate, { max: 1024, stripTracking: false });
      if (valid) {
        previewUrl = valid;
        break;
      }
    }
  }

  if (!tag && !title && !desc && !author && !prompt && !url && !previewUrl && !invite) return null;

  return {
    ...(app ? { app } : {}),
    ...(bizsrc ? { bizsrc } : {}),
    ...(tag ? { tag } : {}),
    ...(title ? { title } : {}),
    ...(desc ? { desc } : {}),
    ...(author ? { author } : {}),
    ...(prompt ? { prompt } : {}),
    ...(url ? { url } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(invite ? { invite } : {}),
  };
}

function normForDedup(text) {
  return String(text || '')
    .replace(/^\[(?:QQ小程序|链接|分享帖子)\]\s*/u, '')
    .replace(/\s+/g, '')
    .toLocaleLowerCase();
}

function isParsedCardObject(value) {
  return isPlainObject(value) && (
    'tag' in value || 'title' in value || 'desc' in value || 'author' in value
    || 'prompt' in value || 'url' in value || 'previewUrl' in value || 'invite' in value
  );
}

/**
 * Format a QQ Ark/JSON card payload into a concise, single-line summary string.
 * Preserves the full cleaned URL intact whenever a URL is present.
 */
export function formatQQCardText(rawOrCard) {
  const card = isParsedCardObject(rawOrCard) ? rawOrCard : parseQQCard(rawOrCard);
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

  if (card.author) {
    const authorNorm = normForDedup(card.author);
    const covered = parts.some((p) => normForDedup(p).includes(authorNorm));
    if (!covered) parts.push(`作者：${card.author}`);
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

  if (!body && !card.url) return '[卡片消息]';
  if (!card.url) {
    return truncateText(`[卡片：${body}]`, 420);
  }

  const wrapperOverhead = 5; // `[卡片：` + `]`
  const urlLead = body ? ' ' : '';
  const totalBudget = Math.max(420, card.url.length + 60);
  const bodyBudget = Math.max(40, totalBudget - wrapperOverhead - urlLead.length - card.url.length);
  const fittedBody = body ? truncateText(body, bodyBudget) : '';
  const summary = fittedBody ? `${fittedBody} ${card.url}` : card.url;
  return `[卡片：${summary}]`;
}

/**
 * Extract compact, structured card metadata from message segments for model/tool consumption.
 * Exposes clean untruncated URLs and hasCover flag without leaking raw CDN preview URLs or tokens.
 */
export function extractCardsFromSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const cards = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type !== 'card' && seg.type !== 'json') continue;
    const d = seg.data ?? {};
    const card = parseQQCard(d.data ?? d.content ?? d);
    if (!card) continue;
    const entry = {
      ...(card.tag ? { tag: card.tag } : {}),
      ...(card.title && normForDedup(card.title) !== normForDedup(card.tag) ? { title: card.title } : {}),
      ...(card.desc && normForDedup(card.desc) !== normForDedup(card.title) ? { desc: card.desc } : {}),
      ...(card.author ? { author: card.author } : {}),
      ...(!card.title && !card.desc && card.prompt ? { prompt: card.prompt } : {}),
      ...(card.url ? { url: card.url } : {}),
      ...(card.previewUrl ? { hasCover: true } : {}),
      ...(card.invite?.groupId ? { inviteGroupId: card.invite.groupId } : {}),
    };
    if (Object.keys(entry).length > 0) {
      cards.push(entry);
      if (cards.length >= QQ_CARD_MAX_PER_MESSAGE) break;
    }
  }
  return cards;
}
