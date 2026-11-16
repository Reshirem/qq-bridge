// Console-only adapter for DSH's MCP manager. It never registers servers, calls
// their tools, or changes MCP configuration. A single passive watch is shared by
// all console requests; only explicit operator actions probe/restart a server.
import { randomUUID } from 'node:crypto';

export const DSH_MANAGED_MCP_NAMES = Object.freeze(['qq', 'qq-memory']);
const STATES = new Set(['connected', 'connecting', 'reconnecting', 'waiting-credentials', 'failed', 'disabled', 'closed']);
const REASONS = new Set(['gave-up', 'reconnect-disabled', 'unclosed-generation', 'load', 'cleanup']);
const UNSUPPORTED_CODES = new Set(['gateway/invocation-unavailable', 'gateway/endpoint-not-found']);
const WATCH_CODES = new Set(['timeout', 'closed', 'endpoint-changed', 'invalid-response', 'unavailable', 'stream-ended', 'disconnected']);

class ManagementError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}
function failure(code, message, statusCode = 503) { return new ManagementError(code, message, statusCode); }

function assertName(name) {
  if (!DSH_MANAGED_MCP_NAMES.includes(name)) {
    throw failure('invalid-server', '只允许管理 qq 和 qq-memory。', 400);
  }
}

function copyNumber(from, to, key) {
  if (Number.isFinite(from?.[key]) && from[key] >= 0) to[key] = from[key];
}

/** @param {{api: object, sanitize?: Function, timeoutMs?: number,
 * actionTimeoutMs?: number, retryDelayMs?: number, WebSocketImpl?: Function}} options */
export function createDshMcpManagement({ api, sanitize, timeoutMs = 5000,
  actionTimeoutMs = 20000, retryDelayMs = 5000, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!api || typeof api.ensureAuth !== 'function' || typeof api.callUnary !== 'function') {
    throw new TypeError('DSH MCP management requires an authenticated API client');
  }
  // Without the bridge's credential-aware redactor, never expose remote error
  // text: a process launch failure can contain command arguments or credentials.
  const safeText = value => {
    if (typeof value !== 'string' || !value) return undefined;
    if (typeof sanitize !== 'function') return 'DSH 返回了诊断信息，请查看本机 DSH 日志。';
    try { return String(sanitize(value)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 500); }
    catch { return 'DSH 返回了诊断信息，请查看本机 DSH 日志。'; }
  };
  const safeClosure = value => ({
    closeConfirmed: value?.closeConfirmed === true,
    ...(value?.cleanupError ? { cleanupError: safeText(value.cleanupError) } : {}),
  });
  const safeStatus = raw => {
    if (!raw || !STATES.has(raw.state)) throw failure('invalid-response', 'DSH 返回了无法识别的 MCP 状态。');
    const status = { state: raw.state };
    for (const key of ['toolCount', 'connectedAt', 'attempt', 'maxAttempts', 'nextRetryAtMs']) copyNumber(raw, status, key);
    if (REASONS.has(raw.reason)) status.reason = raw.reason;
    if (raw.lastError) status.lastError = safeText(raw.lastError);
    if (raw.result && typeof raw.result === 'object') status.result = safeClosure(raw.result);
    return status;
  };
  const unknownServers = () => DSH_MANAGED_MCP_NAMES.map(name => ({
    name, managed: false, configured: false, status: { state: 'unknown' },
  }));
  let view = { state: 'unavailable', supported: null, checkedAt: null, servers: unknownServers() };
  let watch = null;
  let pending = null;
  let nextRetryAt = 0;
  let stopped = false;
  const lifetime = new AbortController();
  const actions = new Map();

  function snapshot() { return structuredClone(view); }

  function endWatch(record, error) {
    if (record.ended) return;
    record.ended = true;
    clearTimeout(record.timer);
    record.controller.abort();
    if (record.socket) {
      for (const [event, handler] of Object.entries(record.listeners ?? {})) record.socket.removeEventListener(event, handler);
      try { record.socket.close(); } catch {}
    }
    if (watch === record) {
      watch = null;
      const unsupported = UNSUPPORTED_CODES.has(error?.code);
      view = {
        state: unsupported ? 'unsupported' : 'unavailable',
        supported: unsupported ? false : (view.supported === true ? true : null),
        checkedAt: view.checkedAt, servers: unknownServers(),
        error: {
          code: unsupported ? 'unsupported' : (WATCH_CODES.has(error?.code) ? error.code : 'unavailable'),
          message: unsupported ? '当前 DSH 未提供 MCP 管理接口；可能是旧版本或管理插件未启用。'
            : (error?.code === 'closed' ? 'MCP 状态订阅已关闭。' : '暂时无法读取 DSH 的 MCP 状态，请确认 DSH 正在运行。'),
        },
      };
      nextRetryAt = Date.now() + retryDelayMs;
    }
    record.resolve?.();
  }

  function startWatch() {
    const controller = new AbortController();
    const record = { controller, ended: false, socket: null, baseUrl: String(api.baseUrl) };
    watch = record;
    const first = new Promise(resolve => { record.resolve = resolve; });
    record.timer = setTimeout(() => endWatch(record, { code: 'timeout' }), timeoutMs);
    (async () => {
      await api.ensureAuth(AbortSignal.any([controller.signal, lifetime.signal]));
      if (record.ended || stopped) return;
      if (record.baseUrl !== String(api.baseUrl)) return endWatch(record, { code: 'endpoint-changed' });
      const url = new URL('/api/remote.mux', record.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = record.socket = new WebSocketImpl(url, { headers: { cookie: api.cookie } });
      const streamId = randomUUID();
      const listeners = record.listeners = {
        open: () => {
          if (record.ended) return;
          try { socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'mcpManager/watch', payload: { args: {} } })); }
          catch { endWatch(record, { code: 'unavailable' }); }
        },
        message: event => {
          if (record.ended) return;
          if (record.baseUrl !== String(api.baseUrl)) return endWatch(record, { code: 'endpoint-changed' });
          let frame;
          try {
            if (typeof event.data !== 'string' || event.data.length > 262144) throw new Error('invalid frame');
            frame = JSON.parse(event.data);
          } catch { return endWatch(record, { code: 'invalid-response' }); }
          if (frame.streamId !== streamId) return;
          if (frame.type === 'error') return endWatch(record, frame.error);
          if (frame.type === 'end') return endWatch(record, { code: 'stream-ended' });
          if (frame.type !== 'item') return;
          try {
            if (!Array.isArray(frame.value)) throw new Error('invalid server list');
            const servers = DSH_MANAGED_MCP_NAMES.map(name => {
              const rows = frame.value.filter(row => row?.name === name);
              if (rows.length > 1) throw new Error('duplicate server');
              const row = rows[0];
              return row ? { name, managed: true, configured: row.configured === true, status: safeStatus(row.status) }
                : { name, managed: false, configured: false, status: { state: 'unmanaged' } };
            });
            view = { state: 'ready', supported: true, checkedAt: new Date().toISOString(), servers };
            clearTimeout(record.timer);
            record.resolve();
          } catch { endWatch(record, { code: 'invalid-response' }); }
        },
        error: () => endWatch(record, { code: 'unavailable' }),
        close: () => endWatch(record, { code: 'disconnected' }),
      };
      for (const [event, handler] of Object.entries(listeners)) socket.addEventListener(event, handler);
    })().catch(() => endWatch(record, { code: 'unavailable' }));
    return first;
  }

  async function status() {
    if (stopped) return snapshot();
    if (watch && watch.baseUrl !== String(api.baseUrl)) {
      endWatch(watch, { code: 'endpoint-changed' });
      nextRetryAt = 0;
    }
    if (pending) await pending;
    else if (!watch && Date.now() >= nextRetryAt) {
      const current = startWatch();
      pending = current;
      try { await current; } finally { if (pending === current) pending = null; }
    }
    return snapshot();
  }

  async function action(kind, name) {
    assertName(name); // No authentication, sockets or RPC before allowlist validation.
    if (stopped) throw failure('closed', 'MCP 管理服务已关闭。');
    if (actions.has(name)) throw failure('busy', '此 MCP 正在探测或重启，请等待当前操作结束。', 409);
    const controller = new AbortController();
    actions.set(name, controller);
    const timer = setTimeout(() => controller.abort(), actionTimeoutMs);
    try {
      const current = await status();
      if (current.state !== 'ready') throw failure(current.state, current.error?.message || 'DSH MCP 管理接口暂不可用。');
      const server = current.servers.find(row => row.name === name);
      if (!server?.managed || !server.configured) throw failure('unmanaged', '此 MCP 尚未纳管；请更新桥接插件配置后重启 DSH。', 409);
      const baseUrl = String(api.baseUrl);
      const signal = AbortSignal.any([controller.signal, lifetime.signal]);
      signal.throwIfAborted();
      const response = await api.callUnary(`mcpManager/${kind}`, { name }, signal);
      if (baseUrl !== String(api.baseUrl)) throw failure('endpoint-changed', '操作期间 DSH 地址变化；请检查当前状态，不要自动重试。');
      if (!response?.result?.ok) {
        const error = response?.result?.error;
        if (/cleanup|unclosed|restart the Host/i.test(String(error?.message))) {
          throw failure('cleanup-incomplete', 'DSH 未确认旧 MCP 进程已清理，拒绝重建；需检查 DSH 后手动重启宿主。', 409);
        }
        if (UNSUPPORTED_CODES.has(error?.code)) throw failure('unsupported', '当前 DSH 未提供此 MCP 管理操作。', 501);
        throw failure('action-failed', 'DSH 未能完成 MCP 管理操作，请检查状态与本机 DSH 日志。');
      }
      const raw = response.result.value;
      let result = null;
      if (kind === 'probe') {
        if (!raw || typeof raw.ok !== 'boolean' || typeof raw.closeConfirmed !== 'boolean') {
          throw failure('invalid-response', 'DSH 返回了无法识别的 MCP 探测结果。');
        }
        result = { ok: raw.ok, ...safeClosure(raw) };
        copyNumber(raw, result, 'durationMs');
        if (raw.ok) {
          if (!Array.isArray(raw.toolNames)) throw failure('invalid-response', 'DSH 未返回 MCP 工具清单。');
          result.toolNames = raw.toolNames.filter(name => typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(name)).slice(0, 512);
          result.toolCount = result.toolNames.length;
          result.truncated = raw.truncated === true || raw.toolNames.length !== result.toolNames.length;
        } else {
          result.stage = ['connect', 'list'].includes(raw.stage) ? raw.stage : 'unknown';
          result.message = safeText(raw.message) || 'MCP 探测失败，请查看本机 DSH 日志。';
        }
      }
      return { ok: true, name, action: kind, result };
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      if (controller.signal.aborted || lifetime.signal.aborted) {
        throw failure('timeout', 'MCP 管理操作超时或已取消；结果可能尚未确认，请检查状态，不要自动重试。', 504);
      }
      throw failure('action-failed', '无法完成 DSH MCP 管理操作，请检查连接与本机 DSH 日志。');
    } finally {
      clearTimeout(timer);
      actions.delete(name);
    }
  }

  function close() {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    for (const controller of actions.values()) controller.abort();
    if (watch) endWatch(watch, { code: 'closed' });
  }
  return { status, probe: name => action('probe', name), restart: name => action('restart', name), close };
}
