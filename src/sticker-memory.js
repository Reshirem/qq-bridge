import crypto from 'node:crypto';
import fs from 'node:fs';
import { formatStickerList } from './sticker-lib.js';
import { writeLearningJson } from './chat-learning.js';

// The catalog owns the image, permissions and current description. A_Memorix owns
// a rebuildable text index. Its paragraph hashes depend solely on paragraph text.
function document(entry) {
  const scope = entry.scope || 'global';
  const text = [entry.desc, ...(entry.tags || []), entry.usage].filter(Boolean).join(' · ');
  if (!text) return null;
  const identity = JSON.stringify([scope, entry.id, text]);
  const version = crypto.createHash('sha256').update(identity).digest('hex');
  return { version, scope, content: text + '\n表情资料 ' + version, id: entry.id };
}

export function createStickerMemory({ getGateway, file, catalog, enabled, log }) {
  let records = {};
  let healthy = true;
  try {
    if (fs.existsSync(file)) {
      records = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!records || Array.isArray(records) || typeof records !== 'object' || Object.entries(records).some(
        ([key, value]) => !/^[0-9a-f]{64}$/.test(key) || typeof value !== 'string')) throw new Error('索引清单格式无效');
    }
  } catch (error) {
    healthy = false;
    log('表情索引清单读取失败，已保留原文件：' + error.message);
  }
  let running = false;
  const commit = next => { writeLearningJson(file, next); records = next; };
  async function sync() {
    if (running || !healthy || !enabled()) return;
    const gateway = getGateway();
    if (!gateway?.status().configured) return;
    running = true;
    try {
      const desired = new Map();
      for (const entry of catalog()) {
        const doc = document(entry);
        if (doc) desired.set(doc.version, doc);
      }
      let budget = 16;
      for (const [version, memoryId] of Object.entries(records)) {
        if (desired.has(version)) continue;
        if (!enabled() || budget-- <= 0) return;
        // Empty means an ingest might have reached the gateway before an interruption.
        const id = memoryId || (await gateway.read({ externalId: version }))?.memoryId;
        if (id && (await gateway.read({ memoryId: id }))) {
          const removed = await gateway.remove({ memoryId: id, reason: '表情条目已更新或移除' });
          if (!removed.deletedCount && await gateway.read({ memoryId: id })) throw new Error('记忆网关未确认旧表情索引已删除');
        }
        const next = { ...records };
        delete next[version];
        commit(next);
      }
      for (const doc of desired.values()) {
        if (records[doc.version]) continue;
        if (!enabled() || budget-- <= 0) return;
        if (!Object.hasOwn(records, doc.version)) commit({ ...records, [doc.version]: '' });
        const saved = await gateway.save({ content: doc.content, externalId: doc.version, stickerScope: doc.scope,
          metadata: { stickerId: doc.id, scope: doc.scope, scope_type: doc.scope === 'global' ? 'global' : 'chat' } });
        const id = saved.storedIds[0] || (await gateway.read({ externalId: doc.version }))?.memoryId;
        if (!id) throw new Error('记忆网关未确认表情索引写入');
        commit({ ...records, [doc.version]: id });
      }
    } finally { running = false; }
  }

  async function search(key, query, count, visible) {
    const q = String(query || '').trim();
    let hits = [];
    const gateway = q && healthy && enabled() ? getGateway() : null;
    if (gateway?.status().configured) {
      try {
        const result = await gateway.search({ query: q, stickerScope: key, limit: 50, requestTimeoutMs: 3500 });
        hits = result.hits;
        // v2.0.0a4 can return an empty scoped search even for indexed paragraphs.
        // Only stable ids present in the live, scoped catalog may leave this process.
        if (!hits.length) {
          const broader = await gateway.search({ query: q, limit: 50, requestTimeoutMs: 3500 });
          hits = broader.hits;
        }
      } catch (error) { log('表情语义检索暂不可用：' + error.message); }
    }
    // Re-read after asynchronous retrieval. Never return remote descriptions, summaries
    // or hits from removed, edited or out-of-scope catalog entries.
    const entries = visible();
    const literal = formatStickerList(entries, q, 500);
    if (!hits.length) return formatStickerList(entries, q, count);
    const byMemoryId = new Map();
    for (const entry of entries) {
      const doc = document(entry);
      const id = doc && records[doc.version];
      if (id) byMemoryId.set(id, entry);
    }
    const ranked = new Map();
    for (const item of [...literal.stickers, ...hits.map(hit => byMemoryId.get(hit.memoryId)).filter(Boolean)]) {
      if (!ranked.has(item.id)) ranked.set(item.id, item);
    }
    const list = formatStickerList([...ranked.values()], '', count);
    return { ...list, total: entries.length };
  }
  return { sync, search };
}
