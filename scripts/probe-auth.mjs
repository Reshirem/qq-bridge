// Shared DSH authentication and request helpers for local diagnostic probes.
// Probe workspaces go under the system temp directory so they do not write into state/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverDshSessionCookie } from '../src/dsh-client.js';

export const PROBE_BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

/**
 * 取得一个可用的会话 Cookie。
 *
 * Uses `DSH_PROBE_COOKIE` when supplied, otherwise mints a local session cookie.
 *
 * @param options.base - DSH 基址。
 * @returns Cookie 串。
 * @throws When a session cookie cannot be obtained.
 */
export function probeCookie({ base = PROBE_BASE } = {}) {
  const explicit = process.env.DSH_PROBE_COOKIE;
  if (explicit) return explicit;
  const minted = discoverDshSessionCookie(base);
  if (minted) return minted;
  throw new Error(
    `无法为 ${base} 取得会话 Cookie：读不到 ${path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml')} `
    + '里的 client-connection/browser-session 签名密钥（DSH 是否正在运行？DSH_HOME 是否指向真正的 .dsh？）。'
    + '也可以设 DSH_PROBE_COOKIE 直接给一个 Cookie。'
  );
}

/**
 * 造一个走 `/api/<endpoint>` 的 RPC 调用器（斜杠式 endpoint + { args } 包装）。
 *
 * @param cookie - {@link probeCookie} 的返回值。
 * @param options.base - DSH 基址。
 * @returns `async (endpoint, args) => result`，result 是 `{ ok, value }` / `{ ok:false, error }` 信封。
 */
export function probeRpc(cookie, { base = PROBE_BASE } = {}) {
  return async function rpc(endpoint, args) {
    const response = await fetch(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'probe-' + Math.random().toString(36).slice(2, 8),
        method: endpoint,
        payload: { args },
      }),
    });
    const body = await response.json();
    return body.result;
  };
}

/** 打开 `/api/remote.mux` 的 WebSocket（斜杠式流端点走这一条连接）。 */
export function probeMuxSocket(cookie, { base = PROBE_BASE } = {}) {
  const url = new URL('/api/remote.mux', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(url, { headers: { cookie } });
}

/**
 * 探针用的工作区目录：系统临时目录下的独立子目录，不碰仓库里的 `state/`。
 * @param name - 子目录名（探针名即可）。
 */
export function probeWorkspaceDir(name) {
  const dir = path.join(os.tmpdir(), `qq-bridge-probe-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
