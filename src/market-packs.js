import fs from 'node:fs/promises';
import path from 'node:path';
import { safeFetch, safeFetchBuffer } from './safe-fetch.js';

const PACK_ID = /^[1-9]\d{0,9}$/;
const FACE_ID = /^[a-f0-9]{32}$/;
const cdn = 'https://i.gtimg.cn/club/item/parcel';
const fold = value => value.normalize('NFKC').toLowerCase();

function packId(value) {
  if (!PACK_ID.test(String(value))) throw new Error('商城包 ID 无效');
  return String(value);
}

function readReference(query) {
  if (PACK_ID.test(query)) return query;
  if (!/^https?:\/\//i.test(query)) return null;
  const url = new URL(query);
  if (url.hostname !== 'zb.vip.qq.com' || url.pathname.replace(/\/$/, '') !== '/hybrid/emoticonmall/detail') throw new Error('请粘贴 QQ 商城的表情包详情链接');
  return packId(url.searchParams.get('id'));
}

async function directoryIds(dir, pattern, folders) {
  if (!dir) return [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.flatMap(entry => {
      const match = (folders ? entry.isDirectory() : entry.isFile()) && entry.name.match(pattern);
      return match ? [match[1]] : [];
    });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function localMarketPackIds(directory, archives) {
  return Promise.all([
    directoryIds(directory, /^([1-9]\d{0,9})$/, true),
    directoryIds(directory && path.join(directory, 'json'), /^([1-9]\d{0,9})(?:\D.*)?\.jtmp$/i, false),
    directoryIds(archives, /^([1-9]\d{0,9})\.zip$/i, false),
  ]).then(groups => groups.flat());
}

async function readManifest(id) {
  const res = await safeFetch(`${cdn}/${id.at(-1)}/${id}.json`, 1024 * 1024);
  if (res.statusCode === 404) throw new Error('腾讯商城没有这个包');
  if (res.statusCode !== 200 || res.truncated) throw new Error(`读取腾讯商城清单失败（HTTP ${res.statusCode}）`);
  return JSON.parse(res.body.replace(/^\uFEFF/, ''));
}

function normalizePack(id, data) {
  if (String(data.id) !== id || !data.name || !Array.isArray(data.imgs) || !data.imgs.length) throw new Error('商城清单缺少包名或表情');
  const items = new Map();
  for (const image of data.imgs) {
    const faceId = String(image.id).toLowerCase();
    if (!FACE_ID.test(faceId)) throw new Error('商城清单包含无效的表情编号');
    const name = String(image.name || '').trim();
    const originalTags = [...new Set((Array.isArray(image.keywords) ? image.keywords : []).filter(tag => typeof tag === 'string' && tag.trim()))];
    items.set(faceId, { faceId, name, desc: name || originalTags.join('、') || data.name, originalTags, tags: originalTags.slice(0, 5) });
  }
  return { id, name: String(data.name), items: [...items.values()] };
}

async function fetchImage(faceId, original) {
  const base = `${cdn}/item/${faceId.slice(0, 2)}/${faceId}`;
  const files = original ? ['raw300.gif', '300x300.png', '200x200.png'] : ['300x300.png', '200x200.png', 'raw300.gif'];
  for (const file of files) {
    try { return (await safeFetchBuffer(`${base}/${file}`)).buffer; }
    catch (error) { if (!error.message.includes('HTTP 404')) throw error; }
  }
  throw new Error('腾讯商城缺少这张表情的图片（' + faceId + '）');
}

export function createMarketPacks({ knownIds, store, assets, analyze, log = () => {}, manifest = readManifest, image = fetchImage }) {
  const pending = new Map(), catalog = new Map(), imports = new Map();
  let draining = null, current = null, closing = false;
  async function lookup(id) {
    packId(id);
    if (catalog.has(id)) return catalog.get(id);
    if (!pending.has(id)) {
      pending.set(id, manifest(id).then(data => {
        const pack = normalizePack(id, data);
        catalog.set(id, pack);
        return pack;
      }).finally(() => pending.delete(id)));
    }
    return pending.get(id);
  }
  function installed() {
    const packs = new Map();
    for (const item of store.marketStickers()) {
      if (!packs.has(item.packId)) packs.set(item.packId, { id: item.packId, name: item.packName, count: 0 });
      packs.get(item.packId).count++;
    }
    return packs;
  }
  async function detail(id) {
    id = packId(id);
    const entries = store.marketStickers(id);
    if (entries.length) {
      const { status, error } = store.marketAnalysis(id);
      return { id, name: entries[0].packName, installed: true, items: entries, analysis: { status, error } };
    }
    return { ...await lookup(id), installed: false };
  }
  async function search(query) {
    const added = installed();
    if (!query) return { packs: [...added.values()].map(p => ({ ...p, installed: true })) };
    const direct = readReference(query);
    if (direct) {
      const pack = await detail(direct);
      return { packs: [{ id: direct, name: pack.name, count: pack.items.length, installed: pack.installed }] };
    }
    const matches = new Map(added);
    const ids = [...new Set([...await knownIds(), ...catalog.keys()])].filter(id => !added.has(id));
    let unavailable = 0;
    const queue = ids.values();
    async function scan() {
      for (const id of queue) {
        try {
          const pack = await lookup(id);
          matches.set(id, { id, name: pack.name, count: pack.items.length });
        } catch { unavailable++; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, scan));
    const needle = fold(query);
    const packs = [...matches.values()].filter(p => fold(p.name).includes(needle))
      .sort((a,b) => Number(fold(b.name) === needle) - Number(fold(a.name) === needle) || a.name.localeCompare(b.name, 'zh-CN'))
      .map(p => ({ ...p, installed: added.has(p.id) }));
    return { packs, unavailable };
  }
  async function install(id) {
    id = packId(id);
    if (store.marketStickers(id).length) return detail(id);
    if (!imports.has(id)) {
      imports.set(id, (async () => {
        const pack = await lookup(id), entries = [];
        for (const item of pack.items) {
          const { hash } = assets.put(await image(item.faceId, true));
          entries.push({ ...item, hash });
        }
        store.addMarketPack(pack, entries);
        void resume();
        return detail(id);
      })().finally(() => imports.delete(id)));
    }
    return imports.get(id);
  }
  async function drain() {
    let job;
    while (!closing && (job = store.nextMarketAnalysis())) {
      const controller = new AbortController();
      current = { id: job.id, controller };
      store.updateMarketAnalysis(job, 'running');
      try {
        const items = store.marketStickers(job.id);
        if (items.some(item => !Array.isArray(item.originalTags))) {
          // Old imports kept editable tags. Recover the original words from the catalog.
          const original = new Map((await lookup(job.id)).items.map(item => [item.faceId, item.originalTags]));
          for (const item of items) item.originalTags ??= original.get(item.faceId) || [];
        }
        const notes = await analyze(items, controller.signal);
        controller.signal.throwIfAborted();
        store.updateMarketAnalysis(job, 'complete', { notes });
      } catch (error) {
        if (!controller.signal.aborted) {
          store.updateMarketAnalysis(job, 'failed', { error: error.message });
          log(`商城表情包 ${job.id} 分析失败：${error.message}`);
        }
      } finally { current = null; }
    }
  }
  function resume() {
    if (!analyze || closing || draining) return draining;
    draining = Promise.resolve().then(drain).catch(error => log('商城表情分析队列失败：' + error.message)).finally(() => { draining = null; });
    return draining;
  }
  return { search, detail, install, resume, get importing() { return imports.size > 0; },
    queueAnalysis(id) {
      id = packId(id);
      store.queueMarketAnalysis(id);
      void resume();
      return detail(id);
    },
    shutdown() {
      closing = true;
      current?.controller.abort();
      return draining;
    },
    async preview(id, faceId) {
      const pack = await detail(id), item = pack.items.find(e => e.faceId === faceId);
      if (!item) throw new Error('商城包中没有这张表情');
      return pack.installed ? assets.read(item.hash) : image(item.faceId, false);
    },
    remove(id) {
      id = packId(id);
      if (imports.has(id)) throw new Error('该包正在导入');
      store.removeMarketPack(id);
      if (current?.id === id) current.controller.abort();
    },
  };
}
