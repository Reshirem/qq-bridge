import crypto from 'node:crypto';

const ORIGINS = new Set(['qq', 'assistant']);
const SEARCH_MODES = new Set(['SEARCH_MODE_SEARCH', 'SEARCH_MODE_TIME', 'SEARCH_MODE_HYBRID']);
const DEFAULT_TIMEOUT_MS = 45_000;
export const STICKER_NAMESPACE = 'qq-bridge-stickers';

function normalizeBaseUrl(value) {
  const url = new URL(String(value || 'http://127.0.0.1:8080').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('A_Memorix 地址只允许 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('A_Memorix 地址不能包含用户名或密码');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('A_Memorix Gateway 必须监听本机回环地址');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeNamespace(value) {
  const namespace = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(namespace)) {
    throw new Error('A_Memorix namespace 必须是 1 至 128 位小写 ASCII 字母、数字、点、下划线或横线，且以字母或数字开头');
  }
  return namespace;
}

function normalizeLimit(value, fallback = 8, max = 50) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function extractSupersededIds(metadata) {
  const entries = [metadata?.supersedes, metadata?.supersededIds].flat();
  return uniqueItems(entries.filter(id => typeof id === 'string').flatMap(id => id.split(',')));
}

export function validMemoryId(id) {
  return typeof id === 'string' && id.trim().length > 0 && id.trim().length <= 300
    && !/placeholder|see\s+summary/i.test(id);
}

function replacementTargets(memoryId, memoryIds) {
  if (memoryId !== undefined && memoryIds !== undefined) throw new Error('请只填写 memoryId 或 memoryIds 之一');
  let raw = memoryIds ?? memoryId;
  if (typeof raw === 'string' && raw.trim().startsWith('[') && raw.trim().endsWith(']')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) raw = parsed;
    } catch {}
  }
  const ids = Array.isArray(raw) ? raw : [raw];
  if (!ids.every(validMemoryId)) throw new Error('请提供真实 memoryId，不能使用空值或占位符');
  const targets = [...new Set(ids.map(id => id.trim()))];
  if (!targets.length || targets.length > 10) throw new Error('一次只能合并或替换 1 至 10 个 memoryId');
  return targets;
}

function uniqueItems(items) {
  return [...new Set(items.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

function replacementMetadata(records, metadata, origin, targets) {
  const ancestors = uniqueItems(records.flatMap(r => extractSupersededIds(r.metadata))).filter(id => !targets.includes(id));
  const merged = {
    ...records[0].metadata, ...metadata,
    supersedes: targets.length === 1 ? targets[0] : targets,
    evidenceReferences: uniqueItems([...records.map(r => r.metadata.evidenceReferences), metadata?.evidenceReferences].flat()).slice(0, 20)
  };
  // Deleting an intermediate correction must not resurrect its predecessors.
  delete merged.supersededIds;
  if (ancestors.length) merged.supersededIds = ancestors;

  // sourceContext is free text and can include the session, event and speaker.
  // Validate each original independently before accepting any caller override.
  const contexts = records.map(record => record.metadata.sourceContext);
  if (metadata && Object.hasOwn(metadata, 'sourceContext')) contexts.push(metadata.sourceContext);
  const keys = contexts.map(ctx => typeof ctx === 'string' ? [...new Set(ctx.match(/\b(?:group|private):\d+\b/g))] : []);
  if (targets.length === 1) {
    // Legacy single records may still need their first explicit source key.
    if (keys[0].length === 1 && (keys.at(-1).length !== 1 || keys.at(-1)[0] !== keys[0][0])) {
      throw new Error('替换记忆时请保留原有的 QQ 来源');
    }
    return merged;
  }
  if (origin === 'qq' || records.some(r => String(r.metadata.origin || r.sourceType).trim().toLowerCase() === 'qq')
      || keys.some(list => list.length)) {
    if (keys.some(list => !list.length) || new Set(keys.flat()).size !== 1) {
      throw new Error('QQ 记忆只能合并相同来源的记录，请核实每条 sourceContext 中的 group:群号 或 private:QQ号');
    }
  }
  const sourceNotes = uniqueItems(contexts.filter(ctx => typeof ctx === 'string').flatMap(ctx => ctx.split('\n')));
  if (sourceNotes.length) merged.sourceContext = sourceNotes.join('\n');
  return merged;
}

function memoryOrigin(value, fallback = 'assistant') {
  const origin = String(value || fallback).trim().toLowerCase();
  if (!ORIGINS.has(origin)) throw new Error('记忆来源只能是 qq 或 assistant');
  return origin;
}

function memorySearchMode(value) {
  const mode = String(value || 'SEARCH_MODE_SEARCH').trim().toUpperCase();
  if (!SEARCH_MODES.has(mode)) throw new Error('记忆检索模式只能是 SEARCH_MODE_SEARCH、SEARCH_MODE_TIME 或 SEARCH_MODE_HYBRID');
  return mode;
}

function resultError(payload, fallback) {
  const message = payload?.message ?? payload?.error?.message ?? payload?.error ?? payload?.detail;
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : fallback;
}

export function createAMemorixGateway(config = {}, { fetchImpl = globalThis.fetch, stickerIndex = false } = {}) {
  const enabled = config.enabled === true;
  const timeoutMs = Math.max(1000, Math.min(120_000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS));
  let baseUrl = '';
  let namespace = '';
  let configError = '';
  try {
    baseUrl = normalizeBaseUrl(config.baseUrl);
    namespace = normalizeNamespace(config.namespace || 'qq-bridge');
    if ((namespace === STICKER_NAMESPACE) !== stickerIndex) throw new Error('表情检索与角色长期记忆必须使用各自的空间');
  } catch (error) {
    configError = String(error?.message ?? error);
  }
  const apiKey = String(config.apiKey || '').trim();
  const replacing = new Set();

  function status() {
    return {
      enabled,
      configured: enabled && !configError && !!apiKey,
      baseUrl: baseUrl || null,
      namespace: namespace || null,
      error: configError || (!apiKey && enabled ? 'config.json 尚未配置 memory.apiKey' : null)
    };
  }

  async function request(operation, body, { requestTimeoutMs, allowMissingMemory = false } = {}) {
    if (!enabled) throw new Error('长期记忆未启用；请在 config.json 中设置 memory.enabled=true');
    if (configError) throw new Error(configError);
    if (!apiKey) throw new Error('长期记忆尚未配置 A_Memorix namespace API key');
    const url = `${baseUrl}/v1/namespaces/${encodeURIComponent(namespace)}/memories:${operation}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, Number(requestTimeoutMs) || timeoutMs)))
      });
    } catch (error) {
      throw new Error(`连接 A_Memorix Gateway 失败：${String(error?.message ?? error).slice(0, 300)}`);
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    // A missing record is a normal lookup result. Do not confuse it with a
    // missing namespace/route, authentication failure, or unavailable service.
    if (allowMissingMemory && operation === 'get' && response.status === 404
        && payload?.code === 'not_found' && payload?.message === 'memory not found') {
      return { memory: null };
    }
    if (!response.ok) {
      throw new Error(`A_Memorix ${operation} 失败（HTTP ${response.status}）：${resultError(payload, 'Gateway 未返回详细原因')}`);
    }
    if (payload && typeof payload === 'object' && payload.ok === false) {
      throw new Error(`A_Memorix ${operation} 失败：${resultError(payload, 'Gateway 返回失败状态')}`);
    }
    return payload ?? {};
  }

  function context(extra = {}) {
    return {
      agentId: 'qq-bridge',
      requestId: crypto.randomUUID(),
      ...extra
    };
  }

  async function search({ query = '', limit, origin, mode = 'SEARCH_MODE_SEARCH', timeStart, timeEnd, requestTimeoutMs, stickerScope } = {}) {
    if (stickerScope && !stickerIndex) throw new Error('当前空间不支持表情检索');
    const requestedLimit = normalizeLimit(limit, 8, 50);
    const filterOrigin = origin ? memoryOrigin(origin) : '';
    const fetchLimit = stickerIndex ? requestedLimit : Math.max(requestedLimit + 10, requestedLimit * 2);
    const searchMode = memorySearchMode(mode);
    if (searchMode !== 'SEARCH_MODE_SEARCH' && !timeStart && !timeEnd) {
      throw new Error('SEARCH_MODE_TIME 和 SEARCH_MODE_HYBRID 至少需要 timeStart 或 timeEnd；普通内容检索请使用 SEARCH_MODE_SEARCH');
    }
    const payload = await request('search', {
      context: context(stickerScope ? { conversationId: stickerScope } : {}),
      ...(stickerScope ? { sharedConversationIds: ['global'] } : {}),
      query: String(query || '').trim().slice(0, 2000),
      limit: Math.min(50, Math.max(fetchLimit, filterOrigin ? requestedLimit * 4 : requestedLimit)),
      mode: searchMode,
      ...(timeStart ? { timeStart: new Date(timeStart).toISOString() } : {}),
      ...(timeEnd ? { timeEnd: new Date(timeEnd).toISOString() } : {}),
      respectFilter: true
    }, { requestTimeoutMs });
    const hits = Array.isArray(payload.hits) ? payload.hits : [];
    const supersededIds = new Set(stickerIndex ? [] : hits.flatMap(hit =>
      extractSupersededIds(hit?.metadata).filter(id => id !== hit?.memoryId)));
    const seenContent = new Set();
    const filtered = hits.filter(hit => {
      if (filterOrigin && String(hit?.metadata?.origin || '').toLowerCase() !== filterOrigin) return false;
      if (stickerIndex) return true;
      if (supersededIds.has(hit?.memoryId)) return false;
      const content = String(hit?.content || '').trim().replace(/\s+/g, ' ');
      if (seenContent.has(content)) return false;
      seenContent.add(content);
      return true;
    }).slice(0, requestedLimit);
    // The upstream summary quotes the first five raw hits, including any
    // that we just removed by origin, supersession, duplication or limit.
    const summary = filtered.length === hits.length ? String(payload.summary || '')
      : filtered.slice(0, 5).map((hit, index) => {
        const content = String(hit?.content || '').trim().replace(/\s+/g, ' ');
        return `${index + 1}. ${content.length > 120 ? content.slice(0, 120) + '...' : content}`;
      }).join('\n');
    return {
      summary,
      hits: filtered.map((hit) => ({
        memoryId: String(hit?.memoryId || ''),
        kind: String(hit?.kind || ''),
        title: String(hit?.title || ''),
        content: String(hit?.content || ''),
        score: Number(hit?.score || 0),
        source: String(hit?.source || ''),
        metadata: hit?.metadata && typeof hit.metadata === 'object' ? hit.metadata : {}
      })),
      degraded: payload.degraded === true,
      retrievalReady: payload.retrievalReady !== false,
      retrievalMode: String(payload.retrievalMode || '')
    };
  }

  async function save({ content, origin = 'assistant', metadata = {}, tags = [], participants = [], observedAt, externalId, stickerScope } = {}) {
    if (stickerScope && !stickerIndex) throw new Error('当前空间不支持表情索引');
    const text = String(content || '').trim();
    if (!text) throw new Error('记忆内容不能为空');
    if (text.length > 20_000) throw new Error('记忆内容不能超过 20000 个字符');
    const source = memoryOrigin(origin);
    const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const safeTags = Array.isArray(tags) ? tags.map((item) => String(item).slice(0, 80)).slice(0, 20) : [];
    const safeParticipants = Array.isArray(participants) ? participants.map((item) => String(item).slice(0, 120)).slice(0, 20) : [];
    const observationTime = observedAt ? new Date(observedAt) : new Date();
    if (!Number.isFinite(observationTime.getTime())) throw new Error('observedAt 需要有效的 ISO 日期或日期时间，无法确认时可省略。');
    const observed = observationTime.toISOString();
    const payload = await request('ingest', {
      context: context({ idempotencyKey: crypto.randomUUID(), ...(stickerScope ? { conversationId: stickerScope } : {}) }),
      externalId: String(externalId || `qq-bridge:${source}:${crypto.randomUUID()}`),
      sourceType: stickerScope ? 'sticker' : source,
      ...(stickerScope ? { relationExtraction: 'RELATION_EXTRACTION_MODE_DISABLED' } : {}),
      text,
      participants: safeParticipants,
      observedAt: observed,
      tags: safeTags,
      metadata: { ...safeMetadata, origin: source, participants: safeParticipants, tags: safeTags, observedAt: observed },
      respectFilter: true
    });
    const storedIds = Array.isArray(payload.storedIds) ? payload.storedIds : [];
    if (!storedIds.every(validMemoryId)) throw new Error('A_Memorix 返回了无效的 storedIds，无法确认写入');
    return {
      storedIds,
      skippedIds: Array.isArray(payload.skippedIds) ? payload.skippedIds.map(String) : [],
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
      relationExtractionJobId: String(payload.relationExtractionJobId || '')
    };
  }

  async function read({ memoryId, externalId } = {}) {
    if (!String(memoryId || externalId || '').trim()) throw new Error('必须提供 memoryId 或 externalId');
    const payload = await request('get', {
      context: context(),
      ...(memoryId ? { memoryId: String(memoryId).trim() } : { externalId: String(externalId).trim() })
    }, { allowMissingMemory: true });
    const record = payload.memory;
    if (!record || typeof record !== 'object') return null;
    return {
      memoryId: String(record.memoryId || ''),
      externalId: String(record.externalId || ''),
      sourceType: String(record.sourceType || ''),
      source: String(record.source || ''),
      content: String(record.content || ''),
      metadata: record.metadata && typeof record.metadata === 'object' ? record.metadata : {},
      tags: Array.isArray(record.tags) ? record.tags.map(String) : (Array.isArray(record.metadata?.tags) ? record.metadata.tags.map(String) : []),
      participants: Array.isArray(record.participants) ? record.participants.map(String) : (Array.isArray(record.metadata?.participants) ? record.metadata.participants.map(String) : []),
      createdAt: record.createdAt || null,
      updatedAt: record.updatedAt || null,
      observedAt: record.observedAt || null,
      validFrom: record.validFrom || null,
      validTo: record.validTo || null
    };
  }

  async function remove({ memoryId, reason = 'Removed by desktop agent' } = {}) {
    const id = String(memoryId || '').trim();
    if (!id) throw new Error('memoryId 不能为空');
    const payload = await request('delete', {
      context: context({ idempotencyKey: crypto.randomUUID() }),
      memoryId: id,
      reason: String(reason || '').slice(0, 500)
    });
    return {
      deletedCount: Number(payload.deletedCount || 0),
      deletedMemoryIds: Array.isArray(payload.deletedMemoryIds) ? payload.deletedMemoryIds.map(String) : [],
      operationId: String(payload.operationId || '')
    };
  }

  async function replace({ memoryId, memoryIds, content, origin, metadata, tags, participants, observedAt, externalId, reason = 'Edited in qq-bridge WebUI' } = {}) {
    const targets = replacementTargets(memoryId, memoryIds);
    if (targets.some(id => replacing.has(id))) throw new Error('目标记忆正在被替换，请重新检索后再试');
    for (const id of targets) replacing.add(id);
    try {
      const records = [];
      for (const id of targets) {
        const record = await read({ memoryId: id });
        if (!record || record.memoryId !== id) {
          throw new Error(`未找到要合并/替换的旧记忆：${id}（请先通过 memory_search / memory_read 确认真实 memoryId）`);
        }
        records.push(record);
      }
      const primary = records[0];
      const nextOrigin = memoryOrigin(origin || primary.metadata.origin || primary.sourceType);
      const saved = await save({
        content, origin: nextOrigin, externalId,
        metadata: replacementMetadata(records, metadata, nextOrigin, targets),
        participants: participants ?? uniqueItems(records.flatMap(r => r.participants)),
        tags: tags ?? uniqueItems(records.flatMap(r => r.tags)),
        observedAt: observedAt || primary.observedAt || undefined
      });
      const newId = saved.storedIds[0]?.trim();
      if (!newId) throw new Error('新记忆未被 A_Memorix 接收，旧记录仍保留');
      const replacedIds = [];
      const retainedIds = [];
      const warnings = [];
      for (const id of targets) {
        if (id === newId) continue;
        try {
          const removed = await remove({ memoryId: id, reason });
          if (!(removed.deletedCount > 0) || (removed.deletedMemoryIds.length && !removed.deletedMemoryIds.includes(id))) {
            throw new Error('Gateway 未确认删除');
          }
          replacedIds.push(id);
        } catch (error) {
          retainedIds.push(id);
          warnings.push(`新记录已保存，但旧记录 ${id} 未确认删除：${error.message}`);
        }
      }
      return { memoryId: newId, replacedIds, oldMemoryRetained: retainedIds.length > 0, retainedIds, warning: warnings.join('；') };
    } finally {
      for (const id of targets) replacing.delete(id);
    }
  }

  return { status, search, save, read, remove, replace };
}

export { memoryOrigin, normalizeLimit };
