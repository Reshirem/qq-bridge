// DSH authentication check. Requires a running local DSH instance.
import {
  NodeApiClient, discoverDshSessionCookie,
  readBrowserSessionSecret, resolveDshHome, mintBrowserSessionCookie, isLoopbackBase
} from '../src/dsh-client.js';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

let pass = 0;
let fail = 0;
const results = [];
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`OK   ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`FAIL ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}

// ── 纯函数层（不需要 DSH 在线）────────────────────────────────────────────
check('isLoopbackBase 认回环', isLoopbackBase('http://127.0.0.1:3080') === true);
check('isLoopbackBase 拒非回环', isLoopbackBase('http://10.0.0.5:3080') === false);

const secret = readBrowserSessionSecret();
check('读到 browser-session 签名密钥（32 字节）', secret?.byteLength === 32, secret ? `${secret.byteLength} bytes` : `未读到（${resolveDshHome()}）`);

if (secret) {
  // Cookie 的形状必须与服务端 decodeCookie/isAuthenticated 的校验一致：
  //   name = 'dsh-auth-' + base64url(sha256(authority))
  //   value = v1.<base64url(json payload)>.<base64url(hmac-sha256)>
  const cookie = mintBrowserSessionCookie(BASE, secret);
  const [name, value] = cookie.split('=');
  const parts = value.split('.');
  check('Cookie 名以 dsh-auth- 开头', name.startsWith('dsh-auth-'));
  check('Cookie 值形如 v1.<body>.<sig>', parts.length === 3 && parts[0] === 'v1');
  const payload = JSON.parse(Buffer.from(parts[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  check('payload.authority 等于 baseUrl 的 authority', payload.authority === new URL(BASE).host, payload.authority);
  check('payload 有效期为正且不超过 30 天上限', payload.expiresAt > payload.issuedAt && (payload.expiresAt - payload.issuedAt) <= 30 * 86400000);
}

// ── 端到端（需要 DSH 在线）────────────────────────────────────────────────
const rpc = async (cookie, method, args) => {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'ta' + Math.random().toString(36).slice(2, 8), method, payload: { args } })
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const cookie = discoverDshSessionCookie(BASE);
if (!check('铸造出会话 Cookie', Boolean(cookie))) {
  console.log(results.join('\n'));
  console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
  process.exit(1);
}

const st = await rpc(cookie, 'settings/describe', {});
check('铸造的 Cookie 能过鉴权（settings/describe）', st.status === 200 && st.body?.result?.ok === true, `HTTP ${st.status}`);

const ap = await rpc(cookie, 'agentPresets/list', {});
const presets = ap.body?.result?.value?.presets?.map((p) => p.id) ?? [];
check('agentPresets/list 可达', ap.status === 200 && presets.length > 0, presets.join(', '));

// NodeApiClient 走真实路径：不传 token、不显式配置 → 应当自动铸造。
const client = new NodeApiClient(BASE, 15000, { tokenExplicit: false });
const viaClient = await client.callUnary('settings/describe', {});
check('NodeApiClient 无 token 也能鉴权', viaClient.result?.ok === true);
check('NodeApiClient 走的是 minted 策略', client._strategy === 'minted', String(client._strategy));

// Repeated invalidation must preserve the current cookie authentication strategy.
for (let i = 0; i < 3; i += 1) {
  client.invalidateAuth();
  const again = await client.callUnary('settings/describe', {});
  if (!check(`invalidateAuth() 第 ${i + 1} 次后仍走铸造策略`, again.result?.ok === true && client._strategy === 'minted', String(client._strategy))) break;
}

// 铸造的 Cookie 必须能在「到期前主动重铸」——1 小时有效期，没有到期跟踪的话
// 每小时都会先撞一次 401 才恢复。
const firstCookie = client.cookie;
client._cookieExpiresAt = Date.now() - 1; // 假装已过期
const refreshed = await client.callUnary('settings/describe', {});
check('Cookie 过期后自动重铸并继续可用', refreshed.result?.ok === true && client.cookie !== firstCookie, `strategy=${client._strategy}`);

console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
