import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeLearningJson } from './chat-learning.js';

// The catalog owns the image, permissions and current description. A_Memorix owns
// a rebuildable text index. Its paragraph hashes depend solely on paragraph text.
function document(entry) {
  const scope = entry.scope || 'global';
  let text = [entry.desc, ...(entry.tags || []), entry.usage].filter(Boolean).join(' · ');
  if (entry.source === 'market') {
    const original = [...new Set([entry.name, ...(entry.originalTags || [])].filter(Boolean))].join('、');
    text = [entry.packName, original && '商城原释义：' + original, text].filter(Boolean).join('\n');
  }
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
      for (const entry of await catalog()) {
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

  async function search(key, query, visible) {
    const q = String(query || '').trim();
    if (!q) throw new Error('请用 query 描述想用表情表达的意思');
    const gateway = healthy && enabled() ? getGateway() : null;
    if (!gateway?.status().configured) throw new Error('表情记忆索引尚未就绪，请检查 A_Memorix 表情检索配置');
    const options = { query: q, limit: 50, requestTimeoutMs: 3500 };
    let { hits } = await gateway.search({ ...options, stickerScope: key });
    // v2.0.0a4 can miss indexed paragraphs in scoped search. The broader
    // search stays in the sticker namespace and uses the same visibility check.
    if (!hits.length) {
      ({ hits } = await gateway.search(options));
    }
    if (!hits.length) return { stickers: [] };
    const byMemoryId = new Map();
    for (const entry of await visible()) {
      const doc = document(entry);
      const id = doc && records[doc.version];
      if (id) byMemoryId.set(id, entry);
    }
    const candidates = new Map();
    for (const hit of hits) {
      const entry = byMemoryId.get(hit.memoryId);
      if (!entry || candidates.has(entry.id)) continue;
      const wording = [...new Set([entry.source === 'market' && entry.name, entry.desc, entry.usage].filter(Boolean))].join(' · ');
      candidates.set(entry.id, { id: entry.id, desc: wording || (entry.tags || []).join('、') });
      if (candidates.size === 5) break;
    }
    return { stickers: [...candidates.values()] };
  }
  return { sync, search };
}
