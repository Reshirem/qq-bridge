// QQ 收藏表情字段归一化与列表格式化。
//
// 职责：
// - 把 QQ 收藏表情详情字段归一化为统一条目
// - 把 `fetch_custom_face_detail` 返回的 QQ 收藏表情合并进运行时列表
// - 支持按 emoji_id / md5 / url 查找、按备注搜索
//
// 设计原则：
// - QQ 账号的收藏表情是权威来源；本地只缓存当前运行时的描述字段。
// - 所有文本只做展示/提示，不执行任何本地操作。

import { truncateText } from './md-to-plain.js';

export function nowIso() {
  return new Date().toISOString();
}

/**
 * 单行化 QQ 表情备注，避免格式字符污染控制台和提示词。
 */
export function sanitizeStickerText(value, max = 200) {
  const limit = Math.max(1, Number(max) || 200);
  const cleaned = String(value ?? '')
    // 换行 / 制表 / 全角空格等一切空白压成单个半角空格
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    // 去掉其余控制字符与零宽字符（可能被用来伪装成不可见的分段符）
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .trim();
  // 按码点截断，不切开代理对（孤立高代理会渲染成 � 并污染每个会话的表情摘要）。
  return truncateText(cleaned, limit);
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: sanitizeStickerText(entry.desc, 200),
    source: ['manual', 'ai', 'learned'].includes(entry.source) ? entry.source : 'qq',
    ...(Array.isArray(entry.tags) ? { tags: entry.tags.map(tag => sanitizeStickerText(tag, 24)).slice(0, 5) } : {}),
    ...(entry.source === 'learned' ? {
      usage: sanitizeStickerText(entry.usage, 200), scope: String(entry.scope || ''),
      usedCount: Math.max(0, Number(entry.usedCount) || 0), lastUsedAt: String(entry.lastUsedAt || ''),
    } : {}),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

// 把桌面 QQ 返回的收藏表情详情合并进运行时列表。
// 只更新 QQ 侧字段（id/resId/url/md5/desc）。
export function mergeStickerLibrary(existing, fetched, { complete = true } = {}) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      source: old?.source || 'qq',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
      byId.set(id, merged);
    }
  }
  // 清理已被 QQ 端删除的收藏表情（保留手动/本地新增的非 qq 来源条目）。
  // count 限制导致的部分结果不能证明其他表情已被删除。
  return out.filter((e) => !complete || e.source !== 'qq' || fetchedIds.has(e.id));
}

function stickerUrlKey(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw) && !/^[^\s/]+\/[^\s]*$/.test(raw)) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

// id/md5 精确匹配优先；URL 只忽略协议、尾斜杠与查询参数，不做任意子串匹配。
export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const id = raw;
  const md5 = raw.toUpperCase();
  const list = Array.isArray(entries) ? entries : [];
  const exact = list.find((e) => {
    if (!e) return false;
    if (e.id === id || e.resId === id) return true;
    if (e.md5 && e.md5 === md5) return true;
    return false;
  });
  if (exact) return exact;
  const urlNormalized = stickerUrlKey(raw);
  return (urlNormalized && list.find((e) => e && stickerUrlKey(e.url) === urlNormalized)) || null;
}

// 格式化给 AI 看的表情列表；query 会匹配 QQ 备注和标识。
export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.id, e.resId, e.md5, e.usage, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    resId: e.resId,
    md5: e.md5,
    url: e.url,
    desc: e.desc || '',
    source: e.source || 'qq',
    ...(e.tags ? { tags: e.tags } : {}),
    ...(e.source === 'learned' ? { usage: e.usage, scope: e.scope, usedCount: e.usedCount, lastUsedAt: e.lastUsedAt } : {})
  }));
  return {
    total: list.length,
    matched: filtered.length,
    truncated: filtered.length > max,
    stickers: items
  };
}
