// Verify the current DSH integration against repository files and an optional live DSH API.
// Live checks create temporary workspaces/sessions, then archive them. SnowLuma is not required.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dshProfileDir } from './dsh-modules.mjs';
import { PRESETS } from './build-agent-preset-patches.mjs';
import { discoverDshSessionCookie, NodeApiClient, unwrap } from '../src/dsh-client.js';

const ROOT = process.cwd();
const PROFILE = process.argv[2] || process.env.DSH_PROFILE || 'web';
const PROFILE_DIR = dshProfileDir(PROFILE);
const DSH_MODULES = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES || path.join(PROFILE_DIR, 'node_modules');
const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

const PERSONA_MODULE = path.join(DSH_MODULES, '@deepseek-ai', 'dsh-persona', 'lib', 'index.js');
if (!fs.existsSync(PERSONA_MODULE)) {
  throw new Error(`DSH profile「${PROFILE}」中找不到 @deepseek-ai/dsh-persona：${PERSONA_MODULE}`);
}

let pass = 0, fail = 0;
const results = [];
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}
/** 环境不允许断言时显式记为跳过，而不是假装通过。 */
function skip(label, why) {
  results.push(`⏭ ${label} — ${why}`);
  return false;
}

// ── 1. 仓库侧：preset persona schema ────────────────────────────────────────
const persona = await import(pathToFileURL(PERSONA_MODULE).href);
const YAML = await import(pathToFileURL(path.join(DSH_MODULES, 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;

/** Current agent loop prompt variables. */
const DSH_PROMPT_VARIABLES = new Set(['provider', 'model']);

for (const p of ['desktop-agent']) {
  const f = path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml');
  const row = yaml.load(fs.readFileSync(f, 'utf8')).find((r) => r.id === 'persona');
  let schemaOk = false;
  try { persona.Config(row.config); schemaOk = true; } catch {}
  check(`preset ${p}: persona.config 通过 DSH schema`, schemaOk);
  // 未知变量不是"渲染成空"而是 fail loud：回合直接 error、模型一次都不跑。
  // 所以这里必须钉住「只用 DSH 真注册过的变量」，而不只是「有 {{model}}」。
  const usedVars = [...new Set([...JSON.stringify(row.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]))];
  const unknownVars = usedVars.filter((v) => !DSH_PROMPT_VARIABLES.has(v));
  check(`preset ${p}: 只引用 DSH 已注册的提示词变量`,
    unknownVars.length === 0 && /\{\{model\}\}/.test(row.config.prefix),
    unknownVars.length ? `未知变量: ${unknownVars.join(', ')}` : usedVars.join(', '));
}

// ── 2. Deployment bundle and tool guard ────────────────────────────────────
const norm = (s) => s.replace(/\r\n/g, '\n');
const presetPatches = await import(pathToFileURL(path.join(ROOT, 'scripts/build-agent-preset-patches.mjs')).href);
for (const { file, changed } of presetPatches.buildPatches({ check: true, log: () => {} })) {
  check(`${path.relative(ROOT, file)} 与仓库源一致（未漂移）`, !changed);
}
for (const p of ['desktop-agent']) {
  const doc = yaml.load(fs.readFileSync(presetPatches.patchFileFor(p), 'utf8'));
  const row = doc?.[0]?.insert?.[0];
  check(`patch ${p}: 是 @deepseek-ai/dsh-agent-preset 行`, row?.name === '@deepseek-ai/dsh-agent-preset');
  check(`patch ${p}: config.id = ${p}`, row?.config?.id === p);
  const source = yaml.load(fs.readFileSync(path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml'), 'utf8'));
  const srcPersona = source.find((r) => r.id === 'persona');
  const patchPersona = (row?.config?.plugins ?? []).find((r) => r.id === 'persona');
  check(`patch ${p}: persona.prefix 与源逐字一致`, norm(srcPersona?.config?.prefix ?? '') === norm(patchPersona?.config?.prefix ?? ''));
  const guardRow = (row?.config?.plugins ?? []).find((r) => r.id === 'qq-tool-restrict');
  check(`patch ${p}: 守卫行用 Profile 目录可解析的裸说明符`, guardRow?.name === presetPatches.GUARD_SPECIFIER);
}

// 守卫脚本必须是 fail-closed 的：非法工具名要被拒绝，而不是放行（权威实现只有一份）。
const canonicalGuardPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const guard = fs.readFileSync(canonicalGuardPath, 'utf8');
// Check executable guard code without treating comments as policy rules.
const guardCode = guard
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('守卫：非法工具名 fail-closed（不接受裸 return 放行）', !/typeof name !== 'string'[^\n]*\)\s*return\s*$/m.test(guardCode));
check('守卫：允许由 DSH tool-web 配置控制注册的 web_search/web_fetch',
  /SAFE_EXACT\s*=\s*new Set\(\[['"]web_search['"],\s*['"]web_fetch['"]\]\)/.test(guardCode)
  && /SAFE_EXACT\.has\(name\)/.test(guardCode));
// Tool families that must stay blocked:
//   ① 全局层默认启用、desktop-agent 会继承的 MCP 资源工具
//   ② 派生 agent / 执行外部代码
//   ③ 插件装载权（= 任意代码执行）与无人值守的自我调度
const REQUIRED_RESTRICTED_TOOL_NAMES = [
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
];
const MORE_RESTRICTED_TOOL_NAMES = [
  // dsh-base tools inherited at the global layer
  'working_directory',
  // dsh-tool-terminal：终端 = shell
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  // dsh-tool-session-query：跨会话读事件正文
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  // 装载权 / 写盘起进程 / team 家族
  'plugin_market', 'create_worktree', 'wait_agent',
];
const guardMod = await import(pathToFileURL(canonicalGuardPath).href);
const guardNames = new Set(guardMod.RESTRICTED_TOOL_NAMES ?? []);
const optionalNames = new Set(guardMod.OPTIONAL_BUNDLE_TOOL_NAMES ?? []);
const missingFromGuard = [...REQUIRED_RESTRICTED_TOOL_NAMES, ...MORE_RESTRICTED_TOOL_NAMES]
  .filter((name) => !guardNames.has(name));
check('守卫覆盖必须限制的工具', missingFromGuard.length === 0, missingFromGuard.join(', ') || `${guardNames.size} 个名字`);

// 守卫名单里的每个名字都必须是 DSH 真实注册的工具：`tools.restrict()` 对未知名字会抛错，
// 而守卫逐个 try/catch 只打日志 ⇒ 拼错的名字 = 静默 no-op。
// 扫描器（scripts/scan-dsh-tool-names.mjs）与 test-preset-local-tools.mjs 共用
// scripts/dsh-tool-names.mjs 这一份抽取实现，所以这里直接复用，不会出现两套口径。
const { collectDshToolNames } = await import(pathToFileURL(path.join(ROOT, 'scripts/dsh-tool-names.mjs')).href);
const scanned = collectDshToolNames();
if (scanned.names.size === 0) {
  skip('守卫名单与 DSH 真实工具名对账', '未扫到任何 DSH 包（DSH 未安装？）');
} else {
  const fabricated = [...guardNames]
    .filter((n) => !n.startsWith('dev_') && !optionalNames.has(n) && !scanned.names.has(n));
  check('守卫名单无拼错的假名（restrict 不会静默失效）', fabricated.length === 0, fabricated.join(', ') || `扫过 ${scanned.packages.length} 个包`);
}

const patch = fs.readFileSync(path.join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8');
const patchDoc = yaml.load(patch);
const mcpIds = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert.map((x) => x.id));
check('profile patch 含 3 个 MCP 且无重复', mcpIds.length === 3 && new Set(mcpIds).size === 3, mcpIds.join(', '));
const snowlumaEntry = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert).find((x) => x.id === 'mcp-snowluma');
check('mcp-snowluma 带 toolCallTimeoutMs=725000', snowlumaEntry?.config?.toolCallTimeoutMs === 725000);
check('mcp 路径指向本仓库', mcpIds.every((id) => {
  const e = patchDoc.filter((x) => x?.insert).flatMap((x) => x.insert).find((y) => y.id === id);
  return String(e.config.args[0]).includes('qq-bridge');
}));

const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'));
check('profile bundles 含 qq-agent-presets', pkg.dsh.profile.bundles.includes('qq-agent-presets'));
check('qq-agent-presets link 依赖已注册', String(pkg.dependencies['qq-agent-presets'] ?? '').startsWith('link:'));
check('qq-agent-presets 已 link 进 node_modules', fs.existsSync(path.join(PROFILE_DIR, 'node_modules/qq-agent-presets')));

// ── 3. 仓库配置：模型 ───────────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
check('config.json dsh.model = deepseek-flash', cfg.dsh?.model === 'deepseek-flash', `当前 ${cfg.dsh?.model}`);
check('preset bundle 只构建 desktop-agent', PRESETS.length === 1 && PRESETS[0] === 'desktop-agent', PRESETS.join(', '));
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
// Inspect executable code without treating comments as requirements.
// Split on CRLF or LF so trailing carriage returns do not affect comment stripping.
const stripComments = (src) => src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const bridgeCode = stripComments(bridgeSrc);
check('bridge.js 可执行代码无 deepseek-v4-flash-vision-exp 残留', !bridgeCode.includes('deepseek-v4-flash-vision-exp'));
check('bridge.js 可执行代码无 router-standard 残留', !bridgeCode.includes('router-standard'));
const setupCode = stripComments(fs.readFileSync(path.join(ROOT, 'scripts/setup-dsh.mjs'), 'utf8'));
check('setup-dsh.mjs 可执行代码无 router-standard 残留', !setupCode.includes('router-standard'));
check('setup-dsh.mjs 安装 desktop-agent preset bundle', setupCode.includes('buildPatches') && setupCode.includes('PRESETS'));
check('bridge.js 默认模型为 deepseek-flash', /model:\s*'deepseek-flash'/.test(bridgeCode));
check('bridge.js 不再有「无参创建会话」兜底', !/sessions\.create\(\{\}\)/.test(bridgeCode));
check('bridge.js 会刷新 DSH preset 清单', bridgeCode.includes('refreshPresetList'));

// 全局会话只允许 desktop-agent；缺少时直接拒绝，不能回退到 DSH 默认 preset。
check('全局会话创建要求 desktop-agent preset', /dshPresetIds\.includes\('desktop-agent'\)/.test(bridgeCode));
check('bridge.js 不回退到 standard preset', !/agentPreset:\s*['"]standard['"]/.test(bridgeCode));

// ── 3b. Package version consistency ─────────────────────────────────────────
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pluginPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/qq-agent-presets/package.json'), 'utf8'));
check('package-lock.json 顶层 version 与 package.json 一致', lockJson.version === pkgJson.version, `lock=${lockJson.version} pkg=${pkgJson.version}`);
check('package-lock.json packages[""] version 与 package.json 一致', lockJson.packages?.['']?.version === pkgJson.version, `lock=${lockJson.packages?.['']?.version}`);
check('qq-agent-presets 插件版本与主包一致', pluginPkg.version === pkgJson.version, `plugin=${pluginPkg.version}`);
for (const f of ['src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js']) {
  const m = /new McpServer\(\{[^}]*version:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  check(`${f} 的 MCP serverInfo.version 与主包一致`, m?.[1] === pkgJson.version, `声明=${m?.[1]} 主包=${pkgJson.version}`);
}

// ── 4. 语法检查 ─────────────────────────────────────────────────────────────
// 注意 spawnSync 在受限环境（DSH 沙箱的 workspace-write）会以 EPERM 失败——
// 那是**环境**不允许起子进程，不是文件有语法错。这种情况显式记为跳过，
// 否则会输出一串假失败，把真正的失败淹掉（实测踩过）。
const SYNTAX_FILES = ['src/bridge.js', 'src/dsh-client.js', 'src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js', 'src/self-test.js', 'scripts/setup-dsh.mjs'];
{
  const probe = spawnSync(process.execPath, ['--check', path.join(ROOT, 'src/dsh-client.js')], { encoding: 'utf8' });
  if (probe.error?.code === 'EPERM') {
    skip(`${SYNTAX_FILES.length} 个文件的语法检查`, '本环境不允许 spawn 子进程（EPERM）；请在普通终端重跑');
  } else {
    for (const f of SYNTAX_FILES) {
      const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
      check(`${f} 语法正确`, r.status === 0, (r.stderr || '').split('\n')[0]);
    }
  }
}

// ── 5. Live DSH contract ─────────────────────────────────────────────────────
// Authenticate through the same persisted signing key used by the bridge.
const cookie = discoverDshSessionCookie(BASE);
check('本机签名密钥 → 铸造会话 Cookie 成功', Boolean(cookie), cookie ? `${cookie.length} 字节` : '读不到 browser-session 密钥');
async function rpc(e, a) {
  const r = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'v' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  return (await r.json()).result;
}
const st = await rpc('settings/describe', {});
check('settings/describe 可用', st.ok === true);
const dm = st.value?.namespaces?.find((n) => n.ns === 'agent-default-model');
check('DSH 全局默认模型 = deepseek-flash', dm?.value?.model === 'deepseek-flash', `当前 ${dm?.value?.model}`);
const ap = await rpc('agentPresets/list', {});
const presetIds = ap.value?.presets?.map((p) => p.id) ?? [];
check('agentPresets/list 含固定 preset desktop-agent', presetIds.includes('desktop-agent'), presetIds.join(', '));
// The bridge requires its fixed desktop-agent preset and does not depend on a DSH default.
const registryNs = st.value?.namespaces?.find((n) => n.ns === 'agent-preset-registry');
check('preset 注册表命名空间已装载', registryNs !== undefined, st.value?.namespaces?.map((n) => n.ns).filter((n) => n.includes('preset')).join(', '));
check('DSH 提供唯一 desktop-agent preset', presetIds.includes('desktop-agent'), presetIds.join(', '));

// ── 5a. qq-agent-presets 管理员 QQ 设置 ─────────────────────────────────────
// 命名空间由 profile entry + 插件导出的 Config 推导；DSH 运行模式字段不参与当前运行时。
const ownerSettings = st.value?.namespaces?.find((n) => n.ns === 'qq-agent-presets');
check('settings/describe 列出 qq-agent-presets 命名空间', ownerSettings !== undefined, st.value?.namespaces?.map((n) => n.ns).length + ' 个命名空间');
if (ownerSettings) {
  const ownerQQ = ownerSettings.value?.ownerQQ;
  check('qq-agent-presets ownerQQ 配置为空或为字符串', ownerQQ === undefined || typeof ownerQQ === 'string', JSON.stringify(ownerSettings.value));
  check('qq-agent-presets 带 revision', Number.isInteger(ownerSettings.revision), String(ownerSettings.revision));
}

// ── 5b. session/projections：读会话队列的主路径 ──────────────────────────────
const probeDir = path.join(os.tmpdir(), 'qq-bridge-verify-current');
fs.rmSync(probeDir, { recursive: true, force: true });
fs.mkdirSync(probeDir, { recursive: true });
const api = new NodeApiClient(BASE, undefined, {});
await api.ensureAuth();

let probeSessionId = null;
try {
  const created = unwrap(await api.sessions.create({ cwd: probeDir, agentPreset: 'desktop-agent' }), 'session.create');
  probeSessionId = created.sessionId;
  check('session/create 挂 desktop-agent preset 成功', typeof probeSessionId === 'string' && probeSessionId.length > 0, probeSessionId);
  unwrap(await api.sessions.selectModel({
    sessionId: probeSessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max'
  }), 'session.selectModel');
  check('session/selectModel(deepseek-flash) 被接受', true);

  const projections = await api.callUnary('session/projections', { sessionId: probeSessionId });
  check('session/projections 一元 RPC 可用', projections.result?.ok === true,
    projections.result?.ok ? '' : `${projections.result?.error?.code}: ${projections.result?.error?.message}`);
  const values = projections.result?.value?.values;
  check('session/projections 返回 values.inbox（next-turn / next-step）',
    values?.inbox !== undefined && Array.isArray(values.inbox['next-turn']) && Array.isArray(values.inbox['next-step']),
    Object.keys(values ?? {}).slice(0, 6).join(','));

  const url = new URL('/api/remote.mux', BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // ── 5c. Retire work in the current DSH session ───────────────────────────
  let retireError = null;
  let retired = null;
  try { retired = await api.stopSessionWork(probeSessionId); }
  catch (error) { retireError = error; }
  check('stopSessionWork 在真实会话上成功返回',
    retireError === null, retireError?.message ?? `removed=${retired?.removed}`);

  // ── 5e. $events ready 帧 ─────────────────────────────────────────────────
  const readyFrame = await new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { cookie: api.cookie } });
    const streamId = randomUUID();
    const timer = setTimeout(() => { try { socket.close(); } catch {} resolve(null); }, 10_000);
    const finish = (value) => { clearTimeout(timer); try { socket.close(); } catch {} resolve(value); };
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } })));
    socket.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.streamId !== streamId || m.type !== 'item') return;
      if (m.value?.type === 'ready') finish(m.value);
    });
    socket.addEventListener('error', () => finish(null));
  });
  check('$events 下发 ready 帧并带 clientId',
    typeof readyFrame?.clientId === 'string' && readyFrame.clientId.length > 0,
    readyFrame ? `${String(readyFrame.clientId).slice(0, 8)}…` : '未收到 ready 帧');

  // ── 5f. session/modelCatalog 形状 ────────────────────────────────────────
  const catalog = await api.callUnary('session/modelCatalog', {});
  check('session/modelCatalog 可用且给出模型分组', catalog.result?.ok === true && Array.isArray(catalog.result?.value?.groups),
    catalog.result?.ok ? `${catalog.result.value.groups.length} 组` : `${catalog.result?.error?.code}`);

  // ── 5e. Run a prompt turn to confirm current prompt variables resolve ─────
  let turnSessionId = null;
  try {
    const turnSession = unwrap(await api.sessions.create({ cwd: probeDir, agentPreset: 'desktop-agent' }), 'session.create(turn)');
    turnSessionId = turnSession.sessionId;
    await api.sessions.selectModel({ sessionId: turnSessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
    const turn = await new Promise((resolve) => {
      const socket = new WebSocket(url, { headers: { cookie: api.cookie } });
      const streamId = randomUUID();
      let text = '';
      const timer = setTimeout(() => { try { socket.close(); } catch {} resolve({ reason: null, text, timeout: true }); }, 90_000);
      const finish = (value) => { clearTimeout(timer); try { socket.close(); } catch {} resolve(value); };
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: turnSessionId } } } } }));
        setTimeout(() => {
          api.sessions.prompt({ sessionId: turnSessionId, mode: 'queue', content: [{ type: 'text', text: '只回复两个字：收到' }] }).catch(() => {});
        }, 800);
      });
      socket.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.streamId !== streamId || m.type !== 'item') return;
        const e = m.value?.type === 'event' ? m.value.event : null;
        if (!e) return;
        if (e.type === 'assistant/message') {
          for (const block of e.data?.message?.content ?? []) if (block?.type === 'text') text += block.text;
        }
        if (e.type === 'turn/end') finish({ reason: e.data?.reason, text });
      });
      socket.addEventListener('error', () => finish({ reason: null, text, error: true }));
    });
    const kind = typeof turn.reason === 'string' ? turn.reason : turn.reason?.kind;
    const why = turn.reason?.error?.message;
    check('preset 真跑一回合：提示词变量可解析且正常结束',
      kind === 'completed' && turn.text.length > 0,
      kind === 'completed' ? `text=${JSON.stringify(turn.text.slice(0, 24))}` : `${kind ?? 'no turn/end'}${why ? `: ${why}` : ''}`);
  } catch (error) {
    check('preset 真跑一回合：提示词变量可解析且正常结束', false, error?.message ?? String(error));
  } finally {
    if (turnSessionId) { try { await api.callUnary('workspace/archiveSession', { sessionId: turnSessionId }); } catch {} }
  }
} catch (error) {
  check('DSH 实测段无未捕获异常', false, error?.message ?? String(error));
} finally {
  if (probeSessionId) {
    try { await api.callUnary('session/cancel', { sessionId: probeSessionId }); } catch {}
    try { await api.callUnary('workspace/archiveSession', { sessionId: probeSessionId }); } catch {}
  }
  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
// 用 process.exitCode 而不是 process.exit()：后者会在 undici 的 keep-alive socket
// 仍在关闭途中强行拆掉事件循环，在 Windows 上触发 libuv 断言
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c）。
// 结果是「断言全过但退出码非 0」，CI 会误判失败。设 exitCode 让循环自然排空即可。
process.exitCode = fail === 0 ? 0 : 1;
