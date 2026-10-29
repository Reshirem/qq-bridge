import crypto from 'node:crypto';

const ORIGINS = new Set(['qq', 'assistant']);
const SEARCH_MODES = new Set(['SEARCH_MODE_SEARCH', 'SEARCH_MODE_TIME', 'SEARCH_MODE_HYBRID']);
const DEFAULT_TIMEOUT_MS = 45_000;

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

export function createAMemorixGateway(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  const enabled = config.enabled === true;
  const timeoutMs = Math.max(1000, Math.min(120_000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS));
  let baseUrl = '';
  let namespace = '';
  let configError = '';
  try {
    baseUrl = normalizeBaseUrl(config.baseUrl);
    namespace = normalizeNamespace(config.namespace || 'qq-bridge');
  } catch (error) {
    configError = String(error?.message ?? error);
  }
  const apiKey = String(config.apiKey || '').trim();

  function status() {
    return {
      enabled,
      configured: enabled && !configError && !!apiKey,
      baseUrl: baseUrl || null,
      namespace: namespace || null,
      error: configError || (!apiKey && enabled ? 'config.json 尚未配置 memory.apiKey' : null)
    };
  }

  async function request(operation, body, { requestTimeoutMs } = {}) {
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

  async function search({ query = '', limit, origin, mode = 'SEARCH_MODE_SEARCH', timeStart, timeEnd, requestTimeoutMs } = {}) {
    const requestedLimit = normalizeLimit(limit, 8, 50);
    const filterOrigin = origin ? memoryOrigin(origin) : '';
    const searchMode = memorySearchMode(mode);
    if (searchMode !== 'SEARCH_MODE_SEARCH' && !timeStart && !timeEnd) {
      throw new Error('SEARCH_MODE_TIME 和 SEARCH_MODE_HYBRID 至少需要 timeStart 或 timeEnd；普通内容检索请使用 SEARCH_MODE_SEARCH');
    }
    const payload = await request('search', {
      context: context(),
      query: String(query || '').trim().slice(0, 2000),
      limit: filterOrigin ? Math.min(50, requestedLimit * 4) : requestedLimit,
      mode: searchMode,
      ...(timeStart ? { timeStart: new Date(timeStart).toISOString() } : {}),
      ...(timeEnd ? { timeEnd: new Date(timeEnd).toISOString() } : {}),
      respectFilter: true
    }, { requestTimeoutMs });
    const hits = Array.isArray(payload.hits) ? payload.hits : [];
    const filtered = filterOrigin
      ? hits.filter((hit) => String(hit?.metadata?.origin || '').toLowerCase() === filterOrigin)
      : hits;
    return {
      summary: String(payload.summary || ''),
      hits: filtered.slice(0, requestedLimit).map((hit) => ({
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

  async function save({ content, origin = 'assistant', metadata = {}, tags = [], participants = [], observedAt, externalId } = {}) {
    const text = String(content || '').trim();
    if (!text) throw new Error('记忆内容不能为空');
    if (text.length > 20_000) throw new Error('记忆内容不能超过 20000 个字符');
    const source = memoryOrigin(origin);
    const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const safeTags = Array.isArray(tags) ? tags.map((item) => String(item).slice(0, 80)).slice(0, 20) : [];
    const safeParticipants = Array.isArray(participants) ? participants.map((item) => String(item).slice(0, 120)).slice(0, 20) : [];
    const observed = observedAt ? new Date(observedAt).toISOString() : new Date().toISOString();
    const payload = await request('ingest', {
      context: context({ idempotencyKey: crypto.randomUUID() }),
      externalId: String(externalId || `qq-bridge:${source}:${crypto.randomUUID()}`),
      sourceType: source,
      text,
      participants: safeParticipants,
      observedAt: observed,
      tags: safeTags,
      metadata: { ...safeMetadata, origin: source, participants: safeParticipants, tags: safeTags, observedAt: observed },
      respectFilter: true
    });
    return {
      storedIds: Array.isArray(payload.storedIds) ? payload.storedIds.map(String) : [],
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
    });
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

  async function replace({ memoryId, content, origin, metadata = {}, tags, participants, observedAt, reason = 'Edited in qq-bridge WebUI' } = {}) {
    const previous = await read({ memoryId });
    if (!previous) throw new Error('未找到要替换的记忆');
    const nextOrigin = memoryOrigin(origin || previous.metadata?.origin || previous.sourceType || 'assistant');
    const saved = await save({
      content,
      origin: nextOrigin,
      metadata: { ...previous.metadata, ...metadata, supersedes: previous.memoryId },
      participants: Array.isArray(participants) ? participants : previous.participants,
      tags: Array.isArray(tags) ? tags : previous.tags,
      observedAt: observedAt || previous.observedAt || undefined
    });
    const newId = saved.storedIds[0];
    if (!newId) throw new Error('新记忆未被 A_Memorix 接收，旧记录仍保留');
    try {
      const removed = await remove({ memoryId, reason });
      if (removed.deletedCount < 1) {
        return { memoryId: newId, oldMemoryRetained: true, warning: '新记录已保存，但 Gateway 未确认旧记录已删除' };
      }
    } catch (error) {
      return { memoryId: newId, oldMemoryRetained: true, warning: `新记录已保存，但旧记录未删除：${error.message}` };
    }
    return { memoryId: newId, oldMemoryRetained: false, warning: '' };
  }

  return { status, search, save, read, remove, replace };
}

export { memoryOrigin, normalizeLimit };
