// DSH 全局自主陪伴运行时与 QQ 消息桥接。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import {
  composePresetPromptModules,
  extractPresetPrefix,
  migrateLegacyPresetPromptModules,
  normalizePresetPromptModules,
  presetPromptBlockers,
  presetPromptWarnings,
  renderPresetPromptYaml,
  serializePresetPromptModules,
} from './preset-prompt.js';
import {
  DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS,
  normalizeDesktopAgentPromptTemplates,
  renderDesktopAgentPromptTemplate,
} from './desktop-agent-prompt-templates.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, discoverDshLaunchToken, discoverDshBaseUrl } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { classifyIncomingWake } from './autonomy-policy.js';
import { compactModelMessage, describeAge } from './qq-model-view.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { normalizeImageForModel } from './media-normalize.js';
import { isFfmpegAvailable } from './ffmpeg-resolve.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, hardenFile, manualDirCommand } from './state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { resolvePriceTable } from './model-prices.js';
import { createTokenLedger } from './token-ledger.js';
import { createAMemorixGateway } from './a-memorix-gateway.js';
import { buildPatches, patchFileFor } from '../scripts/build-agent-preset-patches.mjs';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint
} from './sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const A_MEMORIX_STATE_DIR = path.join(STATE_DIR, 'a-memorix');
const A_MEMORIX_CONFIG_FILE = path.join(A_MEMORIX_STATE_DIR, 'config.toml');
const A_MEMORIX_CLI = path.join(A_MEMORIX_STATE_DIR, 'venv', 'Scripts', 'a-memorix.exe');
const A_MEMORIX_GATEWAY = path.join(A_MEMORIX_STATE_DIR, 'bin', 'a-memorix-gateway.exe');
const A_MEMORIX_PROVIDER_SETTINGS_FILE = path.join(A_MEMORIX_STATE_DIR, 'providers.json');
const A_MEMORIX_PROVIDER_KEYS = {
  embedding: path.join(A_MEMORIX_STATE_DIR, 'secrets', 'embedding-api-key'),
  llm: path.join(A_MEMORIX_STATE_DIR, 'secrets', 'llm-api-key')
};
const DESKTOP_AGENT_FILE = path.join(STATE_DIR, 'desktop-agent.json');
const DESKTOP_AGENT_RECOVERY_BASE_MS = 60_000;
const DESKTOP_AGENT_RECOVERY_MAX_MS = 30 * 60_000;
const DESKTOP_AGENT_REST_MAX_MS = 12 * 60 * 60_000;
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');


/**
 * 从 DSH settings 命名空间读取明确设置，user 层优先、value 回退。
 * DSH 0.2.0 写入 user 层，所以 ownerQQ 热更新时必须优先读取该层。
 */
function settingFromDshNamespace(ns, key) {
  if (!ns || typeof ns !== 'object') return undefined;
  for (const layer of [ns.user, ns.value]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    if (Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function atomicWriteConfigJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const acl = hardenFile(tmp);
    if (!acl.ok) throw new Error(`无法收紧临时配置文件权限：${acl.detail}`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8' });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function memoryProviderSettings() {
  const saved = readJsonSafe(A_MEMORIX_PROVIDER_SETTINGS_FILE, {}, false);
  const embedding = saved?.embedding && typeof saved.embedding === 'object' ? saved.embedding : {};
  const llm = saved?.llm && typeof saved.llm === 'object' ? saved.llm : {};
  const positiveInteger = (value, fallback, max) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 ? Math.min(number, max) : fallback;
  };
  const temperature = Number(llm.temperature);
  return {
    embedding: {
      endpoint: String(embedding.endpoint ?? ''),
      model: String(embedding.model ?? ''),
      dimension: positiveInteger(embedding.dimension, 1024, 8192),
      configured: Boolean(String(embedding.endpoint ?? '').trim() && String(embedding.model ?? '').trim()),
      apiKeyConfigured: fs.existsSync(A_MEMORIX_PROVIDER_KEYS.embedding)
    },
    llm: {
      endpoint: String(llm.endpoint ?? ''),
      model: String(llm.model ?? ''),
      maxTokens: positiveInteger(llm.maxTokens, 8192, 65536),
      temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : 0,
      configured: Boolean(String(llm.endpoint ?? '').trim() && String(llm.model ?? '').trim()),
      apiKeyConfigured: fs.existsSync(A_MEMORIX_PROVIDER_KEYS.llm)
    }
  };
}

function validateMemoryProvider(value, label, current, kind) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const endpoint = String(input.endpoint ?? current.endpoint ?? '').trim();
  const model = String(input.model ?? current.model ?? '').trim();
  if (endpoint.length > 2048 || /[\u0000-\u001f\u007f]/.test(endpoint)) throw new Error(`${label} Endpoint 格式或长度无效`);
  if (model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error(`${label} Model ID 格式或长度无效`);
  if (Boolean(endpoint) !== Boolean(model)) throw new Error(`${label} Endpoint 和 Model ID 必须同时填写或同时留空`);
  if (endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error(`${label} Endpoint 必须是有效的 HTTP(S) 地址`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${label} Endpoint 只允许不含凭据、查询参数或片段的 HTTP(S) 地址`);
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(`${label} 外部 Endpoint 必须使用 HTTPS；HTTP 仅允许本机回环地址`);
    }
  }
  const result = { endpoint, model };
  if (kind === 'embedding') {
    const dimension = Number(input.dimension ?? current.dimension ?? 1024);
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 8192) throw new Error('Embedding 维度必须是 1 至 8192 的整数');
    result.dimension = dimension;
  } else {
    const maxTokens = Number(input.maxTokens ?? current.maxTokens ?? 8192);
    const temperature = Number(input.temperature ?? current.temperature ?? 0);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 65536) throw new Error('LLM 最大输出 token 必须是 1 至 65536 的整数');
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('LLM temperature 必须在 0 至 2 之间');
    result.maxTokens = maxTokens;
    result.temperature = temperature;
  }
  const apiKey = String(input.apiKey ?? '');
  if (apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error(`${label} API Key 格式或长度无效`);
  if (input.clearApiKey === true && apiKey.trim()) throw new Error(`${label} API Key 不能同时输入新值并选择清除`);
  return { ...result, apiKey: apiKey.trim(), clearApiKey: input.clearApiKey === true };
}

function tomlString(value) { return JSON.stringify(String(value)); }

function renderAMemorixProviderConfig(toml, settings, keyConfigured) {
  const removedSections = new Set(['providers.embedding', 'providers.llm']);
  let skipSection = false;
  const kept = [];
  for (const line of String(toml).split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)?.[1]?.trim();
    if (section) skipSection = [...removedSections].some((name) => section === name || section.startsWith(`${name}.`));
    if (!skipSection) kept.push(line);
  }
  const lines = [kept.join('\n').trimEnd(), '', '[providers.embedding]', 'provider = "openai-compatible"',
    `endpoint = ${tomlString(settings.embedding.endpoint)}`, `model = ${tomlString(settings.embedding.model)}`];
  if (keyConfigured.embedding) lines.push('api_key_file = "./secrets/embedding-api-key"');
  lines.push(`dimension = ${settings.embedding.dimension}`, 'dimension_request_mode = "explicit"', '', '[providers.llm]',
    'provider = "openai-compatible"', `endpoint = ${tomlString(settings.llm.endpoint)}`, `model = ${tomlString(settings.llm.model)}`);
  if (keyConfigured.llm) lines.push('api_key_file = "./secrets/llm-api-key"');
  lines.push(`max_tokens = ${settings.llm.maxTokens}`, `temperature = ${settings.llm.temperature}`, '');
  return lines.join('\n');
}

function validateAMemorixConfigText(text) {
  if (!fs.existsSync(A_MEMORIX_CLI)) throw new Error('未找到本机 A_Memorix；请先运行 scripts/a-memorix.ps1 setup');
  const temporary = path.join(A_MEMORIX_STATE_DIR, `config.validate-${process.pid}-${crypto.randomBytes(5).toString('hex')}.toml`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    execFileSync(A_MEMORIX_CLI, ['--config', temporary, '--pretty', 'config'], {
      cwd: A_MEMORIX_STATE_DIR, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().slice(0, 500);
    throw new Error(`A_Memorix 配置校验失败：${detail}`);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function atomicWriteProviderSecret(file, secret) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteText(file, secret);
}

function restoreFile(file, content) {
  if (content === null) { try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
  else atomicWriteText(file, content);
}

function saveAMemorixProviderSettings(embeddingInput, llmInput) {
  if (!fs.existsSync(A_MEMORIX_CONFIG_FILE)) throw new Error('未找到本机 A_Memorix 配置；请先运行 scripts/a-memorix.ps1 setup');
  const current = memoryProviderSettings();
  const embedding = validateMemoryProvider(embeddingInput, 'Embedding', current.embedding, 'embedding');
  const llm = validateMemoryProvider(llmInput, 'LLM', current.llm, 'llm');
  const settings = {
    embedding: { endpoint: embedding.endpoint, model: embedding.model, dimension: embedding.dimension },
    llm: { endpoint: llm.endpoint, model: llm.model, maxTokens: llm.maxTokens, temperature: llm.temperature }
  };
  const credentialActions = { embedding, llm };
  const oldConfig = fs.readFileSync(A_MEMORIX_CONFIG_FILE, 'utf8');
  const oldSettings = fs.existsSync(A_MEMORIX_PROVIDER_SETTINGS_FILE) ? fs.readFileSync(A_MEMORIX_PROVIDER_SETTINGS_FILE, 'utf8') : null;
  const oldKeys = Object.fromEntries(Object.entries(A_MEMORIX_PROVIDER_KEYS).map(([kind, file]) => [kind, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null]));
  const keyConfigured = { embedding: fs.existsSync(A_MEMORIX_PROVIDER_KEYS.embedding), llm: fs.existsSync(A_MEMORIX_PROVIDER_KEYS.llm) };
  for (const kind of ['embedding', 'llm']) {
    if (credentialActions[kind].clearApiKey) keyConfigured[kind] = false;
    else if (credentialActions[kind].apiKey) keyConfigured[kind] = true;
  }
  const updatedConfig = renderAMemorixProviderConfig(oldConfig, settings, keyConfigured);
  try {
    validateAMemorixConfigText(updatedConfig);
    for (const kind of ['embedding', 'llm']) {
      const action = credentialActions[kind];
      const file = A_MEMORIX_PROVIDER_KEYS[kind];
      if (action.clearApiKey) restoreFile(file, null);
      else if (action.apiKey) atomicWriteProviderSecret(file, action.apiKey);
    }
    atomicWriteText(A_MEMORIX_CONFIG_FILE, updatedConfig);
    atomicWriteJson(A_MEMORIX_PROVIDER_SETTINGS_FILE, settings);
  } catch (error) {
    try { restoreFile(A_MEMORIX_CONFIG_FILE, oldConfig); } catch {}
    try { restoreFile(A_MEMORIX_PROVIDER_SETTINGS_FILE, oldSettings); } catch {}
    for (const kind of ['embedding', 'llm']) {
      try { restoreFile(A_MEMORIX_PROVIDER_KEYS[kind], oldKeys[kind]); } catch {}
    }
    throw error;
  }
  return memoryProviderSettings();
}

function runAMemorixControl(action) {
  if (!['start', 'restart'].includes(action)) return Promise.reject(new Error('A_Memorix 操作无效'));
  const script = path.join(ROOT, 'scripts', 'a-memorix.ps1');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, action], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 512 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '启动脚本失败').trim().slice(0, 500);
        reject(new Error(redactSensitiveText(detail)));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、全局陪伴者令牌和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在全局 DSH 会话首次收到提示时注入一次。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按历史标签筛完小节之后**再截断，避免不适用的旧内容占用开场上下文。
// 默认 8000（2026-10 起：小鲸鱼卡补了形象/圈层/白饭-token/开发事件梗，6000 会把
// 末尾「你的样子」整段截掉——截断点落在卡尾而不是卡中，比调大预算更危险），
// 限制首次注入的人格卡体积；可用 config.json 的 role.maxInjectChars 调整
// （1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 8000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, sectionView = 'v2') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = sectionView === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出首次注入上限：当前角色卡有 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入全局会话开场提示（可在配置里调 role.maxInjectChars）`);
  }
  // 只在未标记的通用小节上提示历史指令过滤，避免对已标注内容误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含历史 QQ persona 指令（[SILENT] / 空格分句 / 自动转发…），当前 desktop-agent 会兜底过滤这些行；可将其移到 〔v1〕 历史小节');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 旧标题标签的兼容统计；生产 runtime 固定使用 v2 内容。
        injectedV1: Math.min(stats.v1, roleInjectMaxChars),
        injectedV2: Math.min(stats.v2, roleInjectMaxChars),
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n');
  if (!content.trim()) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content);
}

// ── 全局陪伴者 preset 提示词 ───────────────────────────────────────────────
// 人格提示词仍单独保存在 roles/<名称>.md；修改 preset 后需重启 DSH 并重建全局会话。
const PRESET_NAMES = { desktop: 'desktop-agent' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

/**
 * 控制台的 preset 参数校验：只接受全局陪伴者 preset。
 *
 * 为什么必须在拼路径**之前**校验：main() 里的 resolvePresetName() 在「DSH preset 清单为空」
 * （DSH 还没连上 / 正在启动）时会把调用方给的字符串**原样返回**。那四个 preset 控制台路由
 * 都拿它去 path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml')，
 * 于是 `preset=..\..\..\x` 会读写/备份 <x>/agent.cordis.yml，越出仓库。
 * 返回 null 由调用方回 400。
 */
function knownPresetName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return PRESET_NAMES.desktop;
  return Object.values(PRESET_NAMES).includes(name) ? name : null;
}

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function presetPromptModulesFile(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'prompt-modules.json');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 未知名字必须拒绝，不能绕过全局陪伴者固定使用 desktop-agent 的策略。
// DSH preset 不可用时全局陪伴者拒绝建会话，不回退到默认 preset。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

function readPresetPromptModules(name) {
  const { prefix: sourcePrefix } = readPresetPromptText(name);
  const file = presetPromptModulesFile(name);
  const migrated = !fs.existsSync(file);
  const modules = migrated
    ? migrateLegacyPresetPromptModules(sourcePrefix)
    : normalizePresetPromptModules(readJsonSafe(file, null, true));
  const content = composePresetPromptModules(modules);
  if (!migrated && content !== sourcePrefix) {
    throw new Error('模块配置与 DSH 固定前缀不同步；请通过模块编辑器保存，或还原一份配套备份');
  }
  return { file, modules, content, sourcePrefix, migrated };
}

// 备份文件名带上预设名，便于辨认还原目标。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const modulesFile = presetPromptModulesFile(name);
  if (fs.existsSync(modulesFile)) fs.copyFileSync(modulesFile, `${dest}.modules.json`);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR)
    .filter((f) => f.startsWith(prefix) && !f.endsWith('.modules.json'))
    .sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, `${stale}.modules.json`)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix) && !f.endsWith('.modules.json'))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 0.1.7+ 从 bundle patch 加载 preset；source 是权威源，patch 是生成物。
  const patch = patchFileFor(name);
  let patchCurrent = false;
  let patchError = null;
  try {
    patchCurrent = buildPatches({ check: true }).find((item) => item.file === patch)?.changed === false;
  } catch (error) {
    patchError = String(error?.message ?? error);
  }
  return {
    preset: name,
    label: '全局陪伴者（desktop-agent）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    generatedPatch: fs.existsSync(patch),
    patchCurrent,
    patchError,
    requiresRestart: true,
  };
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。

// 已知的全局 agent token：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DSH 模型目录负责提供实际可用的思考档位；模型目录不可用时用此清单作为手动配置回退。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(v)) {
    throw new Error('思考强度必须是 DSH 提供的档位 ID');
  }
  return v;
}

function normalizeDshModelValue(value, label) {
  const v = String(value ?? '').trim();
  if (!v || v.length > 160 || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new Error(`${label}不能为空，且不能超过 160 个字符或包含控制字符`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇角色", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  let promptTemplates;
  try {
    promptTemplates = normalizeDesktopAgentPromptTemplates(file.desktopAgent?.promptTemplates);
  } catch (error) {
    log(`⚠️ desktopAgent.promptTemplates 配置无效，运行时改用内置默认值：${error?.message ?? error}`);
    promptTemplates = normalizeDesktopAgentPromptTemplates(DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS);
  }
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      autoDetectPort: true,
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    desktopAgent: {
      promptTemplates,
      ...(file.desktopAgent && typeof file.desktopAgent === 'object' && !Array.isArray(file.desktopAgent)
        ? Object.fromEntries(Object.entries(file.desktopAgent).filter(([key]) => key !== 'promptTemplates'))
        : {}),
    },
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    sendDelayMs: file.sendDelayMs ?? 300,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    memory: {
      enabled: file.memory?.enabled === true,
      baseUrl: String(file.memory?.baseUrl ?? 'http://127.0.0.1:8080'),
      namespace: String(file.memory?.namespace ?? 'qq-bridge'),
      apiKey: String(file.memory?.apiKey ?? ''),
      timeoutMs: Math.max(1000, Math.min(120000, Number(file.memory?.timeoutMs) || 45000)),
      bootstrapLimit: Math.max(1, Math.min(12, Number(file.memory?.bootstrapLimit) || 6)),
      bootstrapMaxChars: Math.max(500, Math.min(5000, Number(file.memory?.bootstrapMaxChars) || 2500))
    },
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    socialV2: {
      enabled: true,
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；较长内容可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10           // 每小时最多收藏次数
        }
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20
      },
      // 图片/表情（含动图）的数量与体积上限。QQ 的动图表情常见 1~4MB，
      // 旧的 4MB 单条总上限会误伤；这里默认 8MB，仍受 DSH 的 20MB/64MP 限制约束。
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      ...(file.socialV2 ?? {})
    }
  };
  // 忽略旧版周期性开话题参数；主动休息与故障恢复由全局 desktop-agent 生命周期管理。
  delete cfg.socialV2.proactive;
  delete cfg.socialV2.provideRecommendations;
  delete cfg.socialV2.agentPreset;
  // Remove settings owned by the retired per-conversation DSH runtime.
  delete cfg.socialV2.wake;
  delete cfg.socialV2.initialPromptMaxChars;

  // The global agent always receives the registered SnowLuma tool surface; ignore
  // per-tool switches left behind by the retired mapped-session panel.
  delete cfg.socialV2.tools;
  delete cfg.socialV2.voice;
  delete cfg.slang;

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };
  delete cfg.socialV2.sticker.collect.maxRemarkChars;

  // socialV2.media：图片/表情的数量与体积上限。旧配置没有这一段，必须深度合并出默认值，
  // 否则 `{...defaults, ...file.socialV2}` 里缺失的 media 会取到 undefined（等于无上限判断）。
  cfg.socialV2.media = {
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 64_000_000,
    maxCount: 5,
    ...((cfg.socialV2?.media && typeof cfg.socialV2.media === 'object' && !Array.isArray(cfg.socialV2.media)) ? cfg.socialV2.media : {})
  };

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡首次注入上限（字符）。历史硬编码 6000，现在可配：限制全局会话的开场上下文体积。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格卡首次注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  return cfg;
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会争抢消息并覆盖同一组状态文件）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
// DSH 控制类调用（停任务/归档会话）的超时。这些 await 以前是裸的：DSH 接受了连接但
// 不返回响应时，HTTP handler 永不返回，控制台与群消息一起失去响应（issue #32）。
// 超时后走各自的 catch 记日志，最坏情况只是「这一次重置没做成」，而不是整体挂死。
const DSH_CONTROL_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
function sanitizeMediaSummary(value, max = 60) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? truncateText(s, max) : '';
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  let memoryGateway = createAMemorixGateway(cfg.memory);
  if (cfg.memory.enabled) {
    const memoryStatus = memoryGateway.status();
    log(memoryStatus.configured
      ? `长期记忆已配置：A_Memorix namespace=${memoryStatus.namespace}`
      : `⚠️ 长期记忆尚未就绪：${memoryStatus.error || '配置不完整'}`);
  }
  const ffmpegAvailable = isFfmpegAvailable({ ffmpegPath: process.env.FFMPEG_PATH || null });
  if (!ffmpegAvailable) {
    log('⚠️ 未检测到 FFmpeg：超过 1 MiB 的图片可能无法压缩；动图无法生成多帧预览，且超过上限时可能无法提供。请安装 FFmpeg、设置 FFMPEG_PATH 或将 ffmpeg 加入 PATH，然后重启桥接。');
  }
  if (cfg.dsh.autoDetectPort !== false) {
    const endpoint = await discoverDshBaseUrl(cfg.dsh.baseUrl);
    if (endpoint.source === 'ambiguous') {
      throw new Error(`发现多个 DSH Desktop API 端口：${endpoint.candidates.join(', ')}。请在 config.json 里明确 dsh.baseUrl，或设置 dsh.autoDetectPort=false。`);
    }
    if (endpoint.source === 'desktop' && endpoint.baseUrl !== cfg.dsh.baseUrl) {
      log(`自动发现 DSH Desktop API：${endpoint.baseUrl}（仅本次运行使用，不写回动态端口）`);
      cfg.dsh.baseUrl = endpoint.baseUrl;
    } else if (endpoint.source === 'fallback') {
      log(`未发现 DSH Desktop API，暂用配置地址：${endpoint.baseUrl}`);
    }
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();

  const feedbackTimes = new Map(); // key -> [timestamp]：AI 反馈限频（内存态）

  // ── QQ 会话表情包缓存 ───────────────────────────────────────────────────
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    // The desktop-agent receives the complete SnowLuma MCP surface by default;
    // sticker tools are part of that surface rather than a separate permission tier.
    return true;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // ── 读接口的 HTTP 兜底：WS 挂了不等于网关挂了 ──────────────────────────────
  //
  // 为什么要有：`fetch_custom_face_detail` 原来只走 SnowLuma 的 WS action，于是
  // 「WS 正在重连」这段时间里表情库同步必然失败。日志实测 33 次同步里 16 次失败（≈48%），
  // 全是 `SnowLuma WebSocket closed before opening`；表现就是操作者说的
  // 「有时读群友的表情包会失败」——库里没有新收藏 ⇒ qq_get_sticker_image 直接报「找不到表情」。
  //
  // 而**同一个网关的 HTTP 口一直是可用的**（onebotSend 发消息也直接用它）。
  // 读接口没有理由单点依赖 WS。这里只在 WS 失败时兜底，不改变正常路径的延迟。
  async function onebotHttpAction(action, params = {}, { timeoutMs = 15000 } = {}) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error(`OneBot HTTP ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body;
  }

  async function onebotReadAction(action, params = {}) {
    try {
      const response = await bot.request(action, params);
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`OneBot ${action} 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      return response.data;
    } catch (wsError) {
      log(`[history] WS 读取 ${action} 不可用（${wsError?.message ?? wsError}），改走 OneBot HTTP 兜底`);
      const response = await onebotHttpAction(action, params);
      return response.data;
    }
  }

  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      let response;
      let via = 'ws';
      try {
        response = await bot.request('fetch_custom_face_detail', { count });
        if (!response || response.status !== 'ok' || response.retcode !== 0) {
          throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
        }
      } catch (wsError) {
        // WS 失败 ⇒ 立刻用 HTTP 再问一次同一个 action（语义相同，token 可能不同但同一账号）。
        log(`[sticker] WS 同步不可用（${wsError?.message ?? wsError}），改走 OneBot HTTP 兜底`);
        response = await onebotHttpAction('fetch_custom_face_detail', { count });
        via = 'http';
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条，via ${via}）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false, via };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    return { entry, messageId: data?.message_id ?? null };
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    stickerEntries = stickerEntries.map((item) => item.id === entry.id
      ? { ...item, desc: cleanRemark, updatedAt: new Date().toISOString() }
      : item);
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face）。
  async function collectStickerV2(key, messageRef) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null };
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
      // 未配置管理员 QQ 时，管理命令会被拒绝；这里在启动日志里说明。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  async function readModelCatalog() {
    if (!modelCatalogInFlight) {
      modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
        .finally(() => { modelCatalogInFlight = null; });
    }
    return unwrap(await modelCatalogInFlight, 'session.modelCatalog');
  }
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 旧逐 QQ DSH 映射已移除；只把唯一全局陪伴者会话归到陪伴者。
    resolveKey: (sessionId) => sessionId === desktopAgentSessionId ? 'desktop-agent' : undefined
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  // DSH 可用性探活；QQ 消息正文独立缓冲，注意信号在 DSH 恢复后交给唯一全局陪伴者。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  // DSH 侧真实的 preset 清单，用于验证唯一全局陪伴者 preset，避免未知 preset 回退到默认工具面。
  let dshPresetIds = [];
  // The desktop companion is the sole destination for new QQ attention signals.
  // Signals contain source metadata only; the agent chooses whether to inspect QQ.
  const desktopAgentSavedState = readJsonSafe(DESKTOP_AGENT_FILE, {}) ?? {};
  let desktopAgentSessionId = String(desktopAgentSavedState.sessionId ?? '');
  let desktopAgentToken = String(desktopAgentSavedState.agentToken ?? crypto.randomBytes(32).toString('hex'));
  let desktopAgentInitialContextSessionId = String(desktopAgentSavedState.initialContextSessionId ?? '');
  let desktopAgentInitialContextPrompt = null;
  const savedLifecycle = String(desktopAgentSavedState.lifecycle ?? '');
  const legacyWakeAt = Number(desktopAgentSavedState.restUntil ?? desktopAgentSavedState.wakeAt) || 0;
  const validLifecycles = new Set(['idle', 'active', 'resting', 'recovering', 'stopped']);
  let desktopAgentLifecycle = validLifecycles.has(savedLifecycle)
    ? savedLifecycle
    : desktopAgentSavedState.stopped === true
      ? 'stopped'
      : legacyWakeAt > 0 || desktopAgentSavedState.restUntil === 0 && savedLifecycle === 'resting'
        ? 'resting'
        : desktopAgentSessionId ? 'active' : 'idle';
  let desktopAgentRestUntil = desktopAgentLifecycle === 'resting' ? legacyWakeAt : 0;
  const desktopAgentRestNeedsClamp = desktopAgentLifecycle === 'resting'
    && desktopAgentRestUntil > Date.now() + DESKTOP_AGENT_REST_MAX_MS;
  if (desktopAgentRestNeedsClamp) desktopAgentRestUntil = Date.now() + DESKTOP_AGENT_REST_MAX_MS;
  let desktopAgentRecoveryAttempt = Math.max(0, Math.floor(Number(desktopAgentSavedState.recoveryAttempt) || 0));
  let desktopAgentRecoveryAt = Number(desktopAgentSavedState.recoveryAt) || 0;
  let desktopAgentPendingWakeReason = String(desktopAgentSavedState.pendingWakeReason ?? '');
  let desktopAgentManualPromptPending = Math.max(0, Math.floor(Number(desktopAgentSavedState.manualPromptPending) || 0));
  let desktopAgentLifecycleEpoch = 0;
  KNOWN_AGENT_TOKENS.add(desktopAgentToken);
  let desktopAgentSessionPromise = null;
  let desktopAgentResetting = false;
  let desktopAgentTurnActive = false;
  let desktopAttentionFlushTimer = null;
  let desktopAttentionFlushPromise = null;
  const desktopAttentionQueue = new Map(); // conversation key -> aggregated metadata-only signal
  const desktopAttentionUnresolved = new Map(); // key -> last unread signal that may receive one rest-time reminder
  const DESKTOP_ATTENTION_BATCH_MS = 5000;
  const DESKTOP_ATTENTION_MAX_SOURCES = 50;
  const DESKTOP_ATTENTION_REMINDER_CHECK_MS = 60_000;
  let desktopAttentionReminderTimer = null;
  let desktopAgentRestTimer = null;
  let desktopAgentRecoveryTimer = null;
  async function refreshBridgeSettings() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      const rawOwnerValue = settingFromDshNamespace(ns, 'ownerQQ');
      if (rawOwnerValue === undefined) return;
      const rawOwner = String(rawOwnerValue ?? '').trim();
      if (!rawOwner) return;
      try {
        cfg.ownerQQ = normalizeOwnerQQ(rawOwner);
      } catch (error) {
        log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
      }
    } catch {}
  }

  /** 拉取 DSH 当前可用的 agent preset 清单；全局陪伴者只允许 desktop-agent。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
    } catch (error) {
      dshPresetIds = [];
      log(`获取 DSH preset 清单失败：${error?.message ?? error}；拒绝创建未验证 preset 的全局陪伴者会话`);
    }
  }

  /** The single desktop-agent credential spans all QQ conversation keys. */
  function desktopAgentTokenMatches(token) {
    if (typeof token !== 'string' || !token || !desktopAgentToken) return false;
    const supplied = Buffer.from(token, 'utf8');
    const expected = Buffer.from(desktopAgentToken, 'utf8');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  function isDesktopAgentToken(token) {
    return !!desktopAgentSessionId && desktopAgentTokenMatches(token);
  }

  function saveDesktopAgentState() {
    atomicWriteJson(DESKTOP_AGENT_FILE, {
      sessionId: desktopAgentSessionId,
      agentToken: desktopAgentToken,
      lifecycle: desktopAgentLifecycle,
      restUntil: desktopAgentRestUntil || 0,
      recoveryAttempt: desktopAgentRecoveryAttempt,
      recoveryAt: desktopAgentRecoveryAt || 0,
      pendingWakeReason: desktopAgentPendingWakeReason || '',
      manualPromptPending: desktopAgentManualPromptPending,
      initialContextSessionId: desktopAgentInitialContextSessionId || '',
      updatedAt: Date.now()
    });
  }

  /** QQ key 只用于消息来源/目标；全局 agent 令牌不绑定到单独群或私聊。 */
  function sessionAllowed(kind, id, token = '') {
    if (isDesktopAgentToken(token)) return canonicalV2Key(`${kind}:${id}`) !== null;
    return allowed(kind, id, cfg);
  }

  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshBridgeSettings();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      if (!dshReady) {
        dshReady = true;
        log('DSH 已就绪（autonomous 自主会话运行时）');
        log('全局陪伴者运行时已就绪；QQ 消息按需读取，不创建逐会话 DSH 映射');
        if (desktopAttentionQueue.size > 0) scheduleDesktopAttentionFlush(1000);
        void reconcileDesktopAgentLifecycle();
      }
    } else if (dshReady) {
      dshReady = false;
      desktopAgentTurnActive = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息继续本地缓冲，注意信号待 DSH 恢复后处理');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // MCP 工具使用唯一 desktop-agent token；控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    const consoleCookieName = 'qq_bridge_console';
    const consoleCookieHeader = () => `${consoleCookieName}=${encodeURIComponent(consoleToken)}; Path=/; HttpOnly; SameSite=Strict`;
    const consoleCookieToken = (req) => {
      for (const part of String(req.headers.cookie ?? '').split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0 || part.slice(0, separator).trim() !== consoleCookieName) continue;
        try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
      }
      return '';
    };
    const consoleTokenMatches = (req, url) => [
      url.searchParams.get('token'),
      req.headers['x-console-token'],
      consoleCookieToken(req)
    ].some((candidate) => tokenEq(candidate, consoleToken));
    const agentTokenOk = (_key, token) => isDesktopAgentToken(token);
    // The global credential can address any valid QQ key. Admin-only console requests
    // without an agent token continue to use the configured allow/deny lists.
    const v2SessionAllowed = (key, token = '') => {
      const canonical = canonicalV2Key(key);
      if (!canonical) return false;
      if (isDesktopAgentToken(token)) return true;
      const match = /^(group|private):(\d+)$/.exec(canonical);
      return !!match && allowed(match[1], Number(match[2]), cfg);
    };
    const activeV2Turn = (_key, token = '') => isDesktopAgentToken(token)
      && desktopAgentTurnActive && desktopAgentLifecycle === 'active';
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 登录页只在本机接受 JSON POST；令牌通过后设置仅当前浏览器会话有效的 HttpOnly Cookie。
      if (req.method === 'POST' && url.pathname === '/api/console/login') {
        const contentType = String(req.headers['content-type'] ?? '');
        if (!contentType.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '登录请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers.origin;
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (!allowedHosts.includes(originHost.toLowerCase())) {
            sendJson({ ok: false, error: '跨站登录请求被拒绝' }, 403);
            return;
          }
        }
        const body = await readBody();
        if (!tokenEq(String(body.token ?? '').trim(), consoleToken)) {
          sendJson({ ok: false, error: '访问令牌不正确' }, 401);
          return;
        }
        res.writeHead(204, { 'set-cookie': consoleCookieHeader(), ...SECURITY_HEADERS });
        res.end();
        return;
      }
      // 控制台鉴权：支持旧版请求头/查询参数，以及登录页设置的 HttpOnly Cookie。
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const tokenMatches = consoleTokenMatches(req, url);
      if (consoleToken && !tokenMatches) {
        if (req.method === 'GET' && url.pathname === '/') {
          // 兼容旧的 ?token= 链接，但无效令牌不留在地址栏或浏览器历史中。
          if (url.searchParams.has('token')) {
            res.writeHead(303, { location: '/?login=invalid', ...SECURITY_HEADERS });
            res.end();
            return;
          }
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf8'));
          } catch {
            res.end('<!doctype html><meta charset="utf-8"><title>控制台登录</title><p>登录页面缺失：qq-bridge/public/login.html</p>');
          }
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // MCP 请求必须显式声明 agent-call 并携带唯一全局陪伴者令牌；否则不能借用控制台权限。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1；带了令牌就必须命中某个活跃会话，
      // 端点自己漏写校验也不会退回管理端。
      //
      // 全局陪伴者调用都必须携带令牌；唯一无令牌例外是脱敏后的 /api/status 探活。
      //
      if (req.headers['x-agent-call'] !== undefined) {
        const agentToken = req.headers['x-agent-token'];
        const hasToken = typeof agentToken === 'string' && agentToken !== '';
        if (hasToken && !agentTokenOk('', agentToken)) {
          sendJson({ ok: false, error: '未授权：智能体调用携带的会话令牌无效' }, 403);
          return;
        }
        if (!hasToken) {
          // Only the redacted status probe is tokenless.
          const tokenlessAgentAllowed = url.pathname === '/api/status';
          if (!tokenlessAgentAllowed) {
            sendJson({ ok: false, error: '未授权：该接口的智能体调用必须携带有效的会话令牌' }, 403);
            return;
          }
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // Pausing QQ attention signals does not revoke the global agent's ability to use QQ tools.
        // These remain console-only administrative endpoints.
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname === '/api/desktop-agent/rest'
            || url.pathname.startsWith('/api/desktop-agent/memory/')
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
          if (isDesktopAgentToken(String(req.headers['x-agent-token'])) && desktopAgentLifecycle !== 'active') {
            sendJson({ ok: false, error: `全局陪伴者当前为 ${desktopAgentLifecycle} 状态，不能继续调用工具` }, 409);
            return;
          }
        }
        // 只读降级：表情库在启动时加载失败时，写接口必须明确失败。
        if (req.method !== 'GET') {
          const readonlyStore = (!stickerStoreWritable && (url.pathname === '/api/stickers/sync'
              || url.pathname === '/api/stickers/remark'
              || url.pathname === '/api/socialV2/sticker-remark'
              || url.pathname === '/api/socialV2/collect-sticker')) ? '表情库' : '';
          if (readonlyStore) {
            sendJson({ ok: false, error: `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接` }, 503);
            return;
          }
        }
        if (req.method === 'GET' && (url.pathname === '/console.css' || url.pathname === '/console.js')) {
          const isStyleSheet = url.pathname === '/console.css';
          const assetPath = path.join(ROOT, 'public', isStyleSheet ? 'console.css' : 'console.js');
          try {
            res.writeHead(200, {
              'content-type': isStyleSheet ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
              ...SECURITY_HEADERS
            });
            res.end(fs.readFileSync(assetPath));
          } catch {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
            res.end(isStyleSheet ? '控制台样式文件缺失' : '控制台脚本文件缺失');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/') {
          const headers = { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS };
          if (url.searchParams.has('token')) headers['set-cookie'] = consoleCookieHeader();
          res.writeHead(200, headers);
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              runtime: 'autonomous',
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady,
              socialV2Paused: socialV2.paused,
            });
            return;
          }
          sendJson({
            runtime: 'autonomous',
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot(),
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/memory/status') {
          const memory = memoryGateway.status();
          let gatewayReachable = false;
          let gatewayHealthError = '';
          if (memory.baseUrl) {
            try {
              const healthResponse = await fetch(`${memory.baseUrl}/healthz`, { signal: AbortSignal.timeout(2500) });
              gatewayReachable = healthResponse.ok;
              if (!healthResponse.ok) gatewayHealthError = `HTTP ${healthResponse.status}`;
            } catch (error) { gatewayHealthError = String(error?.message ?? error).slice(0, 200); }
          }
          const serviceInstalled = fs.existsSync(A_MEMORIX_CONFIG_FILE)
            && fs.existsSync(A_MEMORIX_CLI) && fs.existsSync(A_MEMORIX_GATEWAY);
          sendJson({ ok: true, memory: { ...memory, gatewayReachable, gatewayHealthError, serviceInstalled } });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/memory/settings') {
          sendJson({
            ok: true,
            settings: {
              enabled: cfg.memory.enabled,
              baseUrl: cfg.memory.baseUrl,
              namespace: cfg.memory.namespace,
              apiKeyConfigured: Boolean(cfg.memory.apiKey),
              timeoutMs: cfg.memory.timeoutMs,
              bootstrapLimit: cfg.memory.bootstrapLimit,
              bootstrapMaxChars: cfg.memory.bootstrapMaxChars
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/memory/settings') {
          const body = await readBody();
          const inputKey = String(body.apiKey ?? '');
          if (inputKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(inputKey)) {
            sendJson({ ok: false, error: 'A_Memorix namespace API Key 格式或长度无效' }, 400);
            return;
          }
          if (body.clearApiKey === true && inputKey.trim()) {
            sendJson({ ok: false, error: '不能同时输入新 API Key 并选择清除' }, 400);
            return;
          }
          const timeoutSeconds = Number(body.timeoutSeconds ?? Math.round(cfg.memory.timeoutMs / 1000));
          const bootstrapLimit = Number(body.bootstrapLimit ?? cfg.memory.bootstrapLimit);
          const bootstrapMaxChars = Number(body.bootstrapMaxChars ?? cfg.memory.bootstrapMaxChars);
          if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
            sendJson({ ok: false, error: '请求超时必须是 1 至 120 秒的整数' }, 400);
            return;
          }
          if (!Number.isInteger(bootstrapLimit) || bootstrapLimit < 1 || bootstrapLimit > 12) {
            sendJson({ ok: false, error: '启动摘要条数必须是 1 至 12 的整数' }, 400);
            return;
          }
          if (!Number.isInteger(bootstrapMaxChars) || bootstrapMaxChars < 500 || bootstrapMaxChars > 5000) {
            sendJson({ ok: false, error: '启动摘要字数上限必须是 500 至 5000 的整数' }, 400);
            return;
          }
          const apiKey = body.clearApiKey === true ? '' : inputKey.trim() || cfg.memory.apiKey;
          const nextMemory = {
            ...cfg.memory,
            enabled: body.enabled === true,
            baseUrl: String(body.baseUrl ?? cfg.memory.baseUrl).trim(),
            namespace: String(body.namespace ?? cfg.memory.namespace).trim(),
            apiKey,
            timeoutMs: timeoutSeconds * 1000,
            bootstrapLimit,
            bootstrapMaxChars
          };
          const nextStatus = createAMemorixGateway(nextMemory).status();
          if (body.enabled === true && !nextStatus.configured) {
            sendJson({ ok: false, error: nextStatus.error || 'A_Memorix 配置不完整' }, 400);
            return;
          }
          if (!nextStatus.baseUrl || !nextStatus.namespace) {
            sendJson({ ok: false, error: nextStatus.error || 'A_Memorix 地址或 namespace 无效' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.memory = {
            ...(file.memory && typeof file.memory === 'object' ? file.memory : {}),
            enabled: nextMemory.enabled,
            baseUrl: nextMemory.baseUrl,
            namespace: nextMemory.namespace,
            apiKey: nextMemory.apiKey,
            timeoutMs: nextMemory.timeoutMs,
            bootstrapLimit: nextMemory.bootstrapLimit,
            bootstrapMaxChars: nextMemory.bootstrapMaxChars
          };
          atomicWriteConfigJson(configFile, file);
          cfg.memory = nextMemory;
          memoryGateway = createAMemorixGateway(cfg.memory);
          appendActivity(`控制台${nextMemory.enabled ? '启用' : '停用'}长期记忆配置`);
          sendJson({ ok: true, settings: { ...nextMemory, apiKey: undefined, apiKeyConfigured: Boolean(nextMemory.apiKey) } });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/memory/providers') {
          sendJson({ ok: true, providers: memoryProviderSettings() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/memory/providers') {
          const body = await readBody();
          const previous = memoryProviderSettings();
          let providers;
          try { providers = saveAMemorixProviderSettings(body.embedding, body.llm); }
          catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 700) }, 400);
            return;
          }
          const stable = (value) => JSON.stringify({
            embedding: { endpoint: value.embedding.endpoint, model: value.embedding.model, dimension: value.embedding.dimension },
            llm: { endpoint: value.llm.endpoint, model: value.llm.model, maxTokens: value.llm.maxTokens, temperature: value.llm.temperature }
          });
          const credentialsChanged = [body.embedding, body.llm].some((value) => value && (String(value.apiKey ?? '').trim() || value.clearApiKey === true));
          const restartRequired = stable(previous) !== stable(providers) || credentialsChanged;
          if (restartRequired) {
            try { await runAMemorixControl('restart'); }
            catch (error) {
              sendJson({ ok: false, configSaved: true, error: `配置已保存，但 A_Memorix 重启失败：${String(error?.message ?? error).slice(0, 700)}` }, 503);
              return;
            }
          }
          appendActivity(`控制台更新了 A_Memorix Provider 配置${restartRequired ? '并重启服务' : ''}`);
          sendJson({ ok: true, providers, restarted: restartRequired });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/memory/service') {
          const body = await readBody();
          const action = String(body.action ?? '');
          if (action !== 'start') {
            sendJson({ ok: false, error: '仅支持启动 A_Memorix；应用 Provider 变更时会自动重启' }, 400);
            return;
          }
          try {
            await runAMemorixControl('start');
            sendJson({ ok: true, status: 'started' });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 700) }, 503);
          }
          return;
        }
        if (['/api/memory/search', '/api/memory/read', '/api/memory/save', '/api/memory/replace', '/api/memory/delete'].includes(url.pathname)) {
          if (req.method !== 'POST') {
            sendJson({ ok: false, error: '记忆管理操作仅支持 POST' }, 405);
            return;
          }
          if (!memoryGateway.status().configured) {
            sendJson({ ok: false, error: memoryGateway.status().error || '长期记忆尚未配置' }, 503);
            return;
          }
          const body = await readBody();
          try {
            let result;
            if (url.pathname === '/api/memory/search') {
              result = await memoryGateway.search({
                query: String(body.query ?? '').slice(0, 2000),
                limit: body.limit,
                origin: body.origin && body.origin !== 'all' ? body.origin : undefined,
                mode: body.mode,
                timeStart: body.timeStart || undefined,
                timeEnd: body.timeEnd || undefined
              });
            } else if (url.pathname === '/api/memory/read') {
              result = await memoryGateway.read({ memoryId: body.memoryId, externalId: body.externalId });
            } else if (url.pathname === '/api/memory/save') {
              result = await memoryGateway.save({
                content: String(body.content ?? '').slice(0, 20_000),
                origin: body.origin || 'assistant',
                tags: body.tags,
                participants: body.participants,
                observedAt: body.observedAt,
                metadata: body.metadata
              });
              appendActivity('控制台保存了一条长期记忆');
            } else if (url.pathname === '/api/memory/replace') {
              result = await memoryGateway.replace({
                memoryId: body.memoryId,
                content: String(body.content ?? '').slice(0, 20_000),
                origin: body.origin,
                metadata: body.metadata,
                tags: body.tags,
                participants: body.participants,
                observedAt: body.observedAt,
                reason: 'Replaced in qq-bridge WebUI'
              });
              appendActivity(`控制台更新了长期记忆 ${String(body.memoryId ?? '').slice(0, 100)}`);
            } else {
              result = await memoryGateway.remove({
                memoryId: body.memoryId,
                reason: 'Deleted in qq-bridge WebUI'
              });
              appendActivity(`控制台删除了长期记忆 ${String(body.memoryId ?? '').slice(0, 100)}`);
            }
            sendJson({ ok: true, result });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 700) }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: roleInjectMaxChars },
            stats: roleCharStats(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          atomicWriteJson(configFile, file);
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          roleInjectMaxChars = next;
          log(`控制台：人格卡首次注入上限已设为 ${next} 字符（新建或重建会话时生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/desktop-agent/prompt-templates') {
          sendJson({
            ok: true,
            templates: cfg.desktopAgent.promptTemplates,
            defaults: normalizeDesktopAgentPromptTemplates(DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS),
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/desktop-agent/prompt-templates') {
          const body = await readBody();
          if (!body.templates || typeof body.templates !== 'object' || Array.isArray(body.templates)) {
            sendJson({ ok: false, error: '请提交完整的运行时提示模板' }, 400);
            return;
          }
          let next;
          try { next = normalizeDesktopAgentPromptTemplates(body.templates); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '运行时提示模板无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          try {
            const file = readConfigObject(configFile);
            const desktopAgent = file.desktopAgent && typeof file.desktopAgent === 'object' && !Array.isArray(file.desktopAgent)
              ? file.desktopAgent
              : {};
            file.desktopAgent = { ...desktopAgent, promptTemplates: next };
            atomicWriteJson(configFile, file);
            cfg.desktopAgent.promptTemplates = next;
          } catch (error) {
            sendJson({ ok: false, error: `写入 config.json 失败：${error?.message ?? error}` }, 500);
            return;
          }
          log('控制台：全局陪伴者运行时提示模板已更新');
          sendJson({ ok: true, templates: next, message: '已保存；后续对应的会话提示会使用新模板' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          const rs = readRoleState();
          const switched = rs.role === from;
          if (switched) writeRoleState(to, rs.mode);
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) writeRoleState(null, rs.mode);
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 全局 desktop-agent 预设提示词 ────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/desktop-agent-prompt/modules') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const prompt = readPresetPromptModules(preset);
            sendJson({
              ok: true,
              modules: prompt.modules.modules,
              content: prompt.content,
              chars: prompt.content.length,
              bytes: Buffer.byteLength(prompt.content, 'utf8'),
              warnings: presetPromptWarnings(prompt.content),
              migrated: prompt.migrated,
              status: presetStatus(preset),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取提示词模块失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/desktop-agent-prompt/modules') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          let current;
          let nextModules;
          let nextContent;
          let nextYaml;
          try {
            current = readPresetPromptModules(preset);
            nextModules = normalizePresetPromptModules({ version: 1, modules: body.modules });
            nextContent = composePresetPromptModules(nextModules);
            const blockers = presetPromptBlockers(nextContent);
            if (blockers.length) throw new Error(blockers.join('；'));
            nextYaml = renderPresetPromptYaml(readPresetPromptText(preset).text, nextContent);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '模块校验失败' }, 400);
            return;
          }
          const nextModuleJson = `${JSON.stringify(serializePresetPromptModules(nextModules), null, 2)}\n`;
          const currentModuleJson = JSON.stringify(serializePresetPromptModules(current.modules), null, 2);
          const moduleChanged = nextModuleJson.trimEnd() !== currentModuleJson;
          const promptChanged = nextContent !== current.sourcePrefix;
          if (!moduleChanged && !promptChanged) {
            sendJson({ ok: true, unchanged: true, chars: nextContent.length, warnings: presetPromptWarnings(nextContent), requiresRestart: false, status: presetStatus(preset) });
            return;
          }

          const sourceBackup = backupPresetFile(preset);
          const modulesFile = presetPromptModulesFile(preset);
          const hadModulesFile = fs.existsSync(modulesFile);
          try {
            atomicWriteText(modulesFile, nextModuleJson);
            if (promptChanged) atomicWriteText(presetSourceYaml(preset), nextYaml);
            if (promptChanged) buildPatches();
          } catch (error) {
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
              const moduleBackup = `${sourceBackup}.modules.json`;
              if (fs.existsSync(moduleBackup)) {
                try { fs.copyFileSync(moduleBackup, modulesFile); } catch {}
              } else if (!hadModulesFile) {
                try { fs.rmSync(modulesFile); } catch {}
              }
            }
            try { buildPatches(); } catch {}
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：${preset} 固定前缀模块已更新${promptChanged ? '；需重启 DSH 生效' : '（启用模块正文未变化）'}`);
          const status = presetStatus(preset);
          sendJson({
            ok: true,
            chars: nextContent.length,
            warnings: presetPromptWarnings(nextContent),
            synced: status.patchCurrent,
            requiresRestart: promptChanged,
            modules: nextModules.modules,
            content: nextContent,
            status,
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/desktop-agent-prompt') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/desktop-agent-prompt') {
          sendJson({ ok: false, error: '固定前缀已改为分类模块编辑，请使用 /api/preset/desktop-agent-prompt/modules' }, 409);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/desktop-agent-prompt/backups') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            sendJson({ ok: true, backups: listPresetBackups(preset) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/desktop-agent-prompt/restore') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            const pairedModulesFile = `${backupPath}.modules.json`;
            let restoredModules;
            let restoredContent;
            let restoredYaml = restored;
            if (fs.existsSync(pairedModulesFile)) {
              restoredModules = normalizePresetPromptModules(readJsonSafe(pairedModulesFile, null, true));
              restoredContent = composePresetPromptModules(restoredModules);
              if (restoredContent !== restoredPrefix) {
                sendJson({ ok: false, error: '备份中的模块配置与固定前缀不一致，拒绝还原' }, 400);
                return;
              }
            } else {
              // 兼容模块化改造前生成的 11 段固定前缀备份。
              restoredModules = migrateLegacyPresetPromptModules(restoredPrefix);
              restoredContent = composePresetPromptModules(restoredModules);
              restoredYaml = renderPresetPromptYaml(restored, restoredContent);
            }
            // 还原路径必须与保存路径同样严格：备份必须保留对应 preset 的核心协议内容。
            const blockers = presetPromptBlockers(restoredContent);
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份缺少必要的 QQ 渠道说明，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            const sourceBackup = backupPresetFile(preset);
            const modulesFile = presetPromptModulesFile(preset);
            const hadModulesFile = fs.existsSync(modulesFile);
            try {
              atomicWriteText(modulesFile, `${JSON.stringify(serializePresetPromptModules(restoredModules), null, 2)}\n`);
              atomicWriteText(presetSourceYaml(preset), restoredYaml);
              buildPatches();
            } catch (error) {
              if (sourceBackup && fs.existsSync(sourceBackup)) {
                try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
                const moduleBackup = `${sourceBackup}.modules.json`;
                if (fs.existsSync(moduleBackup)) {
                  try { fs.copyFileSync(moduleBackup, modulesFile); } catch {}
                } else if (!hadModulesFile) {
                  try { fs.rmSync(modulesFile); } catch {}
                }
              }
              try { buildPatches(); } catch {}
              throw error;
            }
            log(`控制台：${preset} 全局陪伴者提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true, modules: restoredModules.modules, content: restoredContent });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // Per-conversation DSH session list/status routes were removed with the legacy mapping runtime.
        if (req.method === 'GET' && url.pathname === '/api/console/desktop-agent') {
          await refreshPresetList();
          let live = null;
          let sessionStatusError = '';
          if (dshReady && desktopAgentSessionId) {
            try {
              const result = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
              live = (Array.isArray(result.items) ? result.items : [])
                .find((item) => String(item?.sessionId ?? '') === desktopAgentSessionId) ?? null;
            } catch (error) {
              sessionStatusError = String(error?.message ?? error);
            }
          }
          sendJson({
            ok: true,
            dshReady,
            presetAvailable: dshPresetIds.includes('desktop-agent'),
            ffmpegAvailable,
            sessionId: desktopAgentSessionId || null,
            found: desktopAgentSessionId ? !!live : false,
            running: live?.running === true,
            blank: live?.blank === true,
            agentAvailable: live ? live.agentAvailable === true : false,
            lifecycle: desktopAgentLifecycle,
            restUntil: desktopAgentLifecycle === 'resting' && desktopAgentRestUntil > 0
              ? new Date(desktopAgentRestUntil).toISOString() : null,
            recoveryAt: desktopAgentLifecycle === 'recovering' && desktopAgentRecoveryAt > 0
              ? new Date(desktopAgentRecoveryAt).toISOString() : null,
            recoveryAttempt: desktopAgentRecoveryAttempt,
            pendingWakeReason: desktopAgentPendingWakeReason || null,
            pendingManualTasks: desktopAgentManualPromptPending,
            error: sessionStatusError || null
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/console/desktop-agent/history') {
          if (!dshReady) { sendJson({ ok: false, error: 'DSH 当前未连接' }, 503); return; }
          if (!desktopAgentSessionId) { sendJson({ ok: false, error: '全局 desktop-agent 会话尚未创建' }, 404); return; }

          const expectedSessionId = url.searchParams.get('sessionId');
          if (expectedSessionId && expectedSessionId !== desktopAgentSessionId) {
            sendJson({ ok: false, error: '当前全局会话已变化，请刷新记录后再加载更早内容' }, 409);
            return;
          }
          const rawLimit = url.searchParams.get('limit');
          const limit = rawLimit === null ? 8 : Number(rawLimit);
          const parseSequence = (name, minimum) => {
            const raw = url.searchParams.get(name);
            if (raw === null) return { value: null, error: '' };
            if (!/^-?\d+$/.test(raw)) return { value: null, error: `${name} 必须是整数` };
            const value = Number(raw);
            if (!Number.isSafeInteger(value) || value < minimum) return { value: null, error: `${name} 超出有效范围` };
            return { value, error: '' };
          };
          const requestedThrough = parseSequence('throughSeq', -1);
          const before = parseSequence('beforeSeq', 0);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
            sendJson({ ok: false, error: '每页消息数必须是 1 到 20 之间的整数' }, 400);
            return;
          }
          if (requestedThrough.error || before.error) {
            sendJson({ ok: false, error: requestedThrough.error || before.error }, 400);
            return;
          }

          try {
            const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
            const live = (Array.isArray(list.items) ? list.items : [])
              .find((item) => String(item?.sessionId ?? '') === desktopAgentSessionId) ?? null;
            if (!live) { sendJson({ ok: false, error: 'DSH 中已找不到当前全局会话；请先启动或重建会话' }, 409); return; }

            const asOfSeq = Number(live.projections?.asOfSeq);
            if (!Number.isSafeInteger(asOfSeq) || asOfSeq < -1) {
              sendJson({ ok: false, error: '当前 DSH 未提供可用的会话历史游标' }, 503);
              return;
            }
            const throughSeq = requestedThrough.value ?? asOfSeq;
            if (throughSeq > asOfSeq) {
              sendJson({ ok: false, error: '会话历史游标已失效，请刷新记录' }, 409);
              return;
            }

            const request = {
              address: { kind: 'session', sessionId: desktopAgentSessionId },
              throughSeq,
              maxMessages: limit,
              ...(before.value === null ? {} : { beforeSeq: before.value })
            };
            const page = unwrap(
              await withTimeout(api.callUnary('session/page', request), DSH_CONTROL_TIMEOUT_MS, 'session.page'),
              'session.page'
            );
            let hiddenInternalItems = 0;
            const hiddenKeys = new Set(['stream', 'reasoning', 'thought', 'thinking', 'analysis', 'chainofthought', 'scratchpad', 'internalreasoning']);
            const sensitiveKeys = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'credential', 'credentials', 'bearer', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']
              .map((key) => key.toLowerCase().replace(/[-_]/g, '')));
            const sanitize = (value) => {
              if (Array.isArray(value)) {
                const out = [];
                for (const item of value) {
                  if (item && typeof item === 'object'
                    && ['reasoning', 'thought', 'thinking', 'analysis'].includes(String(item.type ?? '').toLowerCase())) {
                    hiddenInternalItems++;
                    continue;
                  }
                  out.push(sanitize(item));
                }
                return out;
              }
              if (value && typeof value === 'object') {
                const out = Object.create(null);
                for (const [key, child] of Object.entries(value)) {
                  const normalized = key.toLowerCase().replace(/[-_]/g, '');
                  if (hiddenKeys.has(normalized)) { hiddenInternalItems++; continue; }
                  if (sensitiveKeys.has(normalized)) { out[key] = '***'; continue; }
                  out[key] = sanitize(child);
                }
                return out;
              }
              return typeof value === 'string' ? redactSensitiveText(value) : value;
            };
            const records = (Array.isArray(page.records) ? page.records : []).flatMap((record) => {
              if (!record || typeof record !== 'object') return [];
              const hiddenBeforeRecord = hiddenInternalItems;
              const sourceEvent = record.event && typeof record.event === 'object' ? record.event : record;
              const event = sanitize(sourceEvent);
              if (!event || typeof event !== 'object') return [];
              const type = String(event.type ?? '').toLowerCase();
              let internalDetailsOmitted = false;
              if (/^assistant\/(?:attempt|reasoning|thinking|thought|analysis|chunk|delta)$/.test(type)) {
                const metadata = Object.create(null);
                for (const key of ['turn', 'step']) {
                  if (event.data?.[key] !== undefined) metadata[key] = event.data[key];
                }
                metadata.internalDetailsOmitted = true;
                event.data = metadata;
                internalDetailsOmitted = true;
                hiddenInternalItems++;
              }
              const seqValue = Number(record.seq ?? event.seq);
              return [{
                seq: Number.isSafeInteger(seqValue) ? seqValue : null,
                event,
                hiddenInternalItems: hiddenInternalItems - hiddenBeforeRecord,
                internalDetailsOmitted
              }];
            });
            const hasMore = page.hasMore === true;
            const firstSeq = records.find((record) => Number.isSafeInteger(record.seq))?.seq ?? null;
            sendJson({
              ok: true,
              sessionId: desktopAgentSessionId,
              throughSeq,
              beforeSeq: before.value,
              nextBeforeSeq: hasMore ? firstSeq : null,
              hasMore,
              records
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取 DSH 会话记录失败：${error?.message ?? error}` }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/desktop-agent/ensure') {
          try {
            const previousSessionId = desktopAgentSessionId;
            const sessionId = await ensureDesktopAgentSession();
            sendJson({ ok: true, sessionId, created: sessionId !== previousSessionId, turnStarted: false });
          } catch (error) {
            const message = String(error?.message ?? error);
            const status = /不可用|请稍后/.test(message) ? 503 : 502;
            sendJson({ ok: false, error: message }, status);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/desktop-agent/stop') {
          stopDesktopAgentLifecycle();
          let cancelled = false;
          let cancelError = '';
          if (desktopAgentSessionId && dshReady) {
            void api.callUnary('session/cancel', { sessionId: desktopAgentSessionId })
              .then((result) => {
                if (!result?.result?.ok && result?.result?.error?.code !== 'session/not-found') {
                  throw new Error(result?.result?.error?.message ?? 'DSH 未确认当前回合取消');
                }
              })
              .catch((error) => log(`WebUI：立即取消陪伴者当前回合失败，仍将继续清理排队任务：${error?.message ?? error}`));
            try {
              await api.stopSessionWork(desktopAgentSessionId, { timeoutMs: DSH_CONTROL_TIMEOUT_MS });
              cancelled = true;
            } catch (error) {
              cancelError = String(error?.message ?? error);
              log(`WebUI：陪伴者已持久停止，但 DSH 会话取消失败：${cancelError}`);
            }
          }
          sendJson({ ok: true, lifecycle: 'stopped', dshReady, cancelled, error: cancelError || null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/desktop-agent/reset') {
          try {
            const result = await recreateDesktopAgentSession();
            sendJson({ ok: true, ...result, historyRetained: true });
          } catch (error) {
            const message = String(error?.message ?? error);
            const status = /正在运行|正在处理另一项操作|请稍后/.test(message) ? 409 : 502;
            sendJson({ ok: false, error: message }, status);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/desktop-agent') {
          const body = await readBody();
          const message = String(body.message ?? '').trim();
          if (!message) {
            sendJson({ ok: false, error: '任务内容不能为空' }, 400);
            return;
          }
          if (message.length > 20_000) {
            sendJson({ ok: false, error: '任务内容不能超过 20000 个字符' }, 413);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          resumeDesktopAgentLifecycle('manual WebUI task');
          let manualPromptRegistered = false;
          let hadActiveTurn = false;
          try {
            const sessionId = await ensureDesktopAgentSession();
            hadActiveTurn = desktopAgentTurnActive;
            if (desktopAgentTurnActive || desktopAgentManualPromptPending > 0) {
              desktopAgentManualPromptPending += 1;
              saveDesktopAgentState();
              manualPromptRegistered = true;
            }
            const accepted = await submitDesktopAgentPrompt(sessionId, message);
        if (!accepted?.result?.ok) {
              const error = accepted?.result?.error;
              desktopAgentManualPromptPending = Math.max(0, desktopAgentManualPromptPending - 1);
              saveDesktopAgentState();
              manualPromptRegistered = false;
              if (!hadActiveTurn) scheduleDesktopAgentRecovery('WebUI task prompt was rejected');
              sendJson({ ok: false, error: `${error?.code ?? 'prompt_rejected'}: ${error?.message ?? 'DSH 未接受任务'}` }, 502);
              return;
            }
            if (desktopAgentLifecycle === 'stopped') {
              try { await api.stopSessionWork(sessionId, { timeoutMs: DSH_CONTROL_TIMEOUT_MS }); } catch {}
              sendJson({ ok: false, error: '任务提交期间全局会话已被停止' }, 409);
              return;
            }
            desktopAgentTurnActive = true;
            log(`WebUI：已向全局陪伴者提交任务（${message.length} 字符，${sessionId}）`);
            appendActivity(`全局陪伴者收到 WebUI 任务（${message.length} 字符）`);
            sendJson({ ok: true, sessionId });
          } catch (error) {
            if (manualPromptRegistered && desktopAgentLifecycle !== 'stopped') {
              desktopAgentManualPromptPending = Math.max(0, desktopAgentManualPromptPending - 1);
              saveDesktopAgentState();
            }
            if (!hadActiveTurn) scheduleDesktopAgentRecovery('WebUI task submission failed');
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'deepseek-flash');
          // 模型与对应思考档位优先取 DSH 实际目录，目录不可用时允许 UI 手动输入。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          let modelCatalogSource = 'fallback';
          let catalogError = null;
          let modelOptions = [];
          try {
            const catalog = await readModelCatalog();
            modelOptions = (Array.isArray(catalog?.groups) ? catalog.groups : []).flatMap((group) => {
              const providerId = String(group?.id ?? '').trim();
              if (!providerId) return [];
              return (Array.isArray(group?.models) ? group.models : []).flatMap((entry) => {
                const modelId = String(entry?.id ?? '').trim();
                if (!modelId) return [];
                const efforts = (entry?.reasoning?.efforts ?? [])
                  .map((effort) => String(effort?.id ?? '').trim())
                  .filter((id) => /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(id));
                const effortLabels = Object.fromEntries((entry?.reasoning?.efforts ?? [])
                  .filter((effort) => efforts.includes(String(effort?.id ?? '').trim()))
                  .map((effort) => [String(effort.id).trim(), { name: effort.name ?? '', description: effort.description ?? '' }]));
                return [{
                  provider: providerId,
                  providerName: String(group?.name ?? providerId),
                  model: modelId,
                  modelName: String(entry?.name ?? modelId),
                  description: String(entry?.description ?? ''),
                  reasoningEfforts: efforts,
                  reasoningLabels: effortLabels,
                  effortSource: efforts.length > 0 ? 'dsh' : 'fallback',
                  defaultEffort: String(entry?.reasoning?.defaultEffort ?? '')
                }];
              });
            });
            modelCatalogSource = modelOptions.length > 0 ? 'dsh' : 'empty';
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '').trim()).filter((id) => /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(id));
            if (advertised.length) {
              options = [...new Set(advertised)];
              labels = Object.fromEntries(efforts
                .filter((effort) => options.includes(String(effort?.id ?? '').trim()))
                .map((effort) => [String(effort.id).trim(), { name: effort.name ?? '', description: effort.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            catalogError = String(error?.message ?? error);
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = catalogError;
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          const configuredEffort = normalizeReasoningEffort(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
          if (!options.includes(configuredEffort)) options.push(configuredEffort);
          sendJson({
            provider,
            model,
            reasoningEffort: configuredEffort,
            options,
            labels,
            modelOptions,
            modelCatalogSource,
            catalogError,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认，控制台需明确说明副作用。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/model') {
          const body = await readBody();
          let provider;
          let model;
          let effort;
          try {
            provider = normalizeDshModelValue(body.provider, 'Provider ID');
            model = normalizeDshModelValue(body.model, 'Model ID');
            effort = normalizeReasoningEffort(body.reasoningEffort ?? cfg.dsh?.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '模型设置无效' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), provider, model, reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), provider, model, reasoningEffort: effort };
          modelSelectionEpoch += 1;
          log(`控制台：DSH 模型已设为 ${provider}/${model}（${effort}，下一条消息生效）`);
          sendJson({ ok: true, provider, model, reasoningEffort: effort });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          res.setHeader('set-cookie', consoleCookieHeader());
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }

          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 固定全局 desktop-agent 的内部 Agent API ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark 静默打开**（它默认 false 是有意的风险操作）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
          const merged = { ...current, ...body };
          if (body.attentionKeywords !== undefined) {
            const seenKeywords = new Set();
            const inputKeywords = Array.isArray(body.attentionKeywords) ? body.attentionKeywords : [];
            merged.attentionKeywords = inputKeywords
              .map((value) => String(value ?? '').trim().normalize('NFKC'))
              .filter((value) => value.length >= 2 && value.length <= 64)
              .filter((value) => {
                const key = value.toLocaleLowerCase();
                if (seenKeywords.has(key)) return false;
                seenKeywords.add(key);
                return true;
              })
              .slice(0, 50);
          }
          // Remove stale settings owned by the retired mapped-session runtime.
          delete merged.proactive;
          delete merged.provideRecommendations;
          delete merged.agentPreset;
          delete merged.wake;
          delete merged.initialPromptMaxChars;
          delete merged.tools;
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致参数丢失，这里直接保留当前值。
          for (const sub of ['send', 'wait', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          delete merged.voice;
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          if (merged.sticker && typeof merged.sticker === 'object'
              && merged.sticker.collect && typeof merged.sticker.collect === 'object') {
            delete merged.sticker.collect.maxRemarkChars;
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          log('控制台：QQ 提醒与工具配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            log('控制台：QQ 提醒已暂停');
          } else {
            log('控制台：QQ 提醒已恢复');
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          socialV2.conversations.clear();
          seenForwardIds.clear();
          lastSendFailed.clear();
          feedbackTimes.clear();
          saveSocialV2State();
          log('控制台：已清空 QQ 消息缓冲和读取水位；全局陪伴者会话与运行状态保持不变');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastIncomingAt: st.lastIncomingAt,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const isAgentRead = !!req.headers['x-agent-token'];
          const readThroughSeq = isAgentRead ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          if (isAgentRead) acknowledgeDesktopAttentionThrough(key, readThroughSeq);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const isAgentRead = !!req.headers['x-agent-token'];
          const readThroughSeq = isAgentRead ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          if (isAgentRead) acknowledgeDesktopAttentionThrough(key, readThroughSeq);
          sendJson({ ok: true, key, messages, readThroughSeq });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/conversation-history') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const count = Math.min(100, Math.max(1, Number(url.searchParams.get('count')) || 20));
          const reverseOrder = url.searchParams.get('reverseOrder') === 'true';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
          const params = kind === 'group'
            ? { group_id: id, count, reverse_order: reverseOrder }
            : { user_id: id, count, reverse_order: reverseOrder };
          if (messageId) {
            if (!/^-?\d+$/.test(messageId) || messageId.length > 20) {
              sendJson({ ok: false, error: 'messageId 必须是安全的 QQ 消息整数' }, 400);
              return;
            }
            params.message_id = messageId;
          }
          try {
            const data = await onebotReadAction(action, params);
            const entries = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
            const now = Date.now();
            const messages = await Promise.all(entries.slice(0, count).map(async (entry) => {
              const segments = Array.isArray(entry?.message) || typeof entry?.message === 'string' ? entry.message : [];
              const senderObj = entry?.sender && typeof entry.sender === 'object' ? entry.sender : {};
              const userId = senderObj.user_id ?? senderObj.userId ?? entry?.user_id ?? entry?.userId ?? null;
              const sender = senderObj.card || senderObj.nickname || entry?.sender_name || (userId != null ? String(userId) : '未知');
              const resolveAtName = kind === 'group' ? (qq) => resolveGroupMemberName(id, qq) : null;
              const resolveReply = (replyId) => resolveReplyInfo(kind, id, replyId, selfUserId);
              const text = await segmentsToText(segments, { resolveAtName, resolveReply, includeReply: false });
              const plain = await segmentsToText(segments, { resolveAtName, resolveReply, includeReply: true });
              const media = extractMediaFromSegments(segments);
              const forwardIds = (Array.isArray(segments) ? segments : [])
                .filter((seg) => seg?.type === 'forward')
                .map((seg) => sanitizeForwardId(forwardIdFromData(seg?.data ?? {})))
                .filter(Boolean);
              const rawTime = Number(entry?.time);
              const time = Number.isFinite(rawTime) && rawTime > 0 ? (rawTime > 1e12 ? rawTime : rawTime * 1000) : 0;
              const self = selfUserId != null && userId != null && String(userId) === String(selfUserId);
              const owner = cfg.ownerQQ != null && userId != null && String(userId) === String(cfg.ownerQQ);
              return {
                kind,
                messageId: entry?.message_id ?? entry?.messageId ?? null,
                sender: String(sender),
                userId: userId != null ? String(userId) : null,
                text: truncateText(String(text ?? ''), 200),
                plain: truncateText(String(plain ?? text ?? ''), 200),
                tail: truncateTextTail(String(plain ?? text ?? ''), 200),
                quoteTargetIsSelf: await isQuoteTargetSelf(segments, kind, id, selfUserId),
                isOwner: owner,
                ownerLabel: owner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
                isSelf: self,
                media,
                hasMedia: media.length > 0,
                forwardIds,
                hasForward: forwardIds.length > 0,
                time
              };
            }));
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, source: 'snowluma-history', action, messageId: messageId || null, count: messages.length, messages, readThroughSeq: readThroughSeqV2(st), now });
          } catch (error) {
            sendJson({ ok: false, error: `读取会话历史失败：${error?.message ?? error}` }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/desktop-agent/rest') {
          const body = await readBody();
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          if (!isDesktopAgentToken(token)) {
            sendJson({ ok: false, error: '陪伴者会话令牌无效' }, 403);
            return;
          }
          if (!desktopAgentTurnActive || desktopAgentLifecycle !== 'active') {
            sendJson({ ok: false, error: 'agent_rest 只能在未停止的活动回合内调用' }, 409);
            return;
          }
          let durationMs = null;
          if (body.durationMs !== undefined && body.durationMs !== null) {
            durationMs = Number(body.durationMs);
            if (!Number.isFinite(durationMs) || Math.round(durationMs) < 1000) {
              sendJson({ ok: false, error: 'durationMs 必须至少为 1000；省略该参数表示无限期休息' }, 400);
              return;
            }
            durationMs = Math.min(Math.round(durationMs), DESKTOP_AGENT_REST_MAX_MS);
          }
          enterDesktopAgentRest(durationMs);
          sendJson({
            ok: true,
            lifecycle: 'resting',
            restUntil: desktopAgentRestUntil > 0 ? new Date(desktopAgentRestUntil).toISOString() : null,
            turnCancellationScheduled: true
          });
          return;
        }
        if (url.pathname.startsWith('/api/desktop-agent/memory/')) {
          if (req.method !== 'POST') {
            sendJson({ ok: false, error: '记忆工具仅支持 POST' }, 405);
            return;
          }
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          if (!isDesktopAgentToken(token)) {
            sendJson({ ok: false, error: '陪伴者会话令牌无效' }, 403);
            return;
          }
          if (!desktopAgentTurnActive || desktopAgentLifecycle !== 'active') {
            sendJson({ ok: false, error: '记忆工具只能在活动回合内调用' }, 409);
            return;
          }
          if (!memoryGateway.status().configured) {
            sendJson({ ok: false, error: memoryGateway.status().error || '长期记忆尚未配置' }, 503);
            return;
          }
          const body = await readBody();
          const operation = url.pathname.slice('/api/desktop-agent/memory/'.length);
          try {
            let result;
            if (operation === 'search') {
              result = await memoryGateway.search({
                query: String(body.query ?? '').slice(0, 2000),
                limit: body.limit,
                origin: body.origin || undefined,
                mode: body.mode,
                timeStart: body.timeStart,
                timeEnd: body.timeEnd
              });
            } else if (operation === 'save') {
              result = await memoryGateway.save({
                content: String(body.content ?? '').slice(0, 20_000),
                origin: body.origin || 'assistant',
                metadata: body.metadata,
                tags: body.tags,
                participants: body.participants,
                observedAt: body.observedAt,
                externalId: body.externalId
              });
            } else if (operation === 'read') {
              result = await memoryGateway.read({ memoryId: body.memoryId, externalId: body.externalId });
            } else if (operation === 'forget') {
              result = await memoryGateway.remove({ memoryId: body.memoryId, reason: body.reason });
            } else {
              sendJson({ ok: false, error: '未知记忆操作' }, 404);
              return;
            }
            sendJson({ ok: true, result });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 700) }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const st = getSocialV2State(key);
          // 不带 throughSeq 时清空当前全部未读；传入水位时只清理已读取到的位置。
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          const markedCount = acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          saveSocialV2State();
          log(`全局陪伴者/控制台标记 ${key} 未读已读：${markedCount} 条`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastIncomingAt: st.lastIncomingAt || 0,
              lastAiReplyAt: st.lastAiReplyAt || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '自主会话发送必须携带 agent token' }, 403); return; }
           if (!activeV2Turn(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '只有正在运行的 DSH 回合可以发送 QQ 消息' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !sessionAllowed(kind, id, req.headers["x-agent-token"])) {
            sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;

            saveSocialV2State();
            log(`[autonomous] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [autonomous] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[autonomous] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
                    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '自主会话发送必须携带 agent token' }, 403); return; }
           if (!activeV2Turn(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '只有正在运行的 DSH 回合可以发送 QQ 消息' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !sessionAllowed(kind, id, req.headers["x-agent-token"])) {
            sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;

            saveSocialV2State();
            log(`[autonomous] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [autonomous] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[autonomous] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
                    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '自主会话发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          if (!activeV2Turn(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '只有正在运行的 DSH 回合可以发送 QQ 消息' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !sessionAllowed(kind, id, req.headers["x-agent-token"])) {
            sendJson({ ok: false, error: '该会话未通过白名单/拒绝名单策略，不能操作' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
          // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
          const sendGuard = captureSendGuard(key);
          try {
            sendGuard();
            if (shouldBlockSilentReply(key)) {
              const blocked = new Error('静默模式已开启，当前不允许拍一拍');
              blocked.statusCode = 403;
              throw blocked;
            }
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;

            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);



            saveSocialV2State();
            log(`[autonomous] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [autonomous] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[autonomous] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
          }
          return;
        }
        // ── 表情包体系（autonomous） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            const prep = await toModelMedia(fetched.buffer, mimeType, `收藏表情 ${entry.id}`);
            if (!prep.ok) {
              sendJson({ ok: false, error: `表情图片无法提供给模型：${prep.error}` }, 413);
              return;
            }
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType: prep.mimeType, data: prep.buffer.toString('base64') },
              ...(prep.note ? { note: prep.note } : {})
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
                    if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: '自主会话发送必须携带 agent token' }, 403); return; }
           if (!activeV2Turn(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '只有正在运行的 DSH 回合可以发送 QQ 消息' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !sessionAllowed(kind, id, req.headers["x-agent-token"])) {
            sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;




            saveSocialV2State();
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false, writable: stickerStoreWritable });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约按**归一后的** key 记账：`group:0123` 与 `group:123` 是同一个会话，
          // 用原始 key 会给出两个租约槽（同一会话并发多个 5~10 分钟等待、互相踩水位）。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          const leaseKey = canonicalV2Key(key) ?? key;
          if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          const leaseStamp = Date.now();
          activeWaits.set(leaseKey, leaseStamp);
          // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
          const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
          req.on('close', finishWait);
          // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回一个 JSON，
          // 那条路径不会经过下面的 finishWait()，会留下 15 分钟的假 429。
          res.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait ? readThroughSeqV2(st) : requestSeq;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (!agentTokenOk(key, req.headers['x-agent-token'])
                || !v2SessionAllowed(key, req.headers["x-agent-token"])))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...st.unread, ...st.recentMessages]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          // ── 漏消息窗口（2026-10-18 修）──────────────────────────────────
          //
          // 旧实现按 `seq > baseline` 取"本次等待期间新到的"，而 baseline 对普通等待是
          // **请求开始时的 lastUnreadSeq**。于是「模型思考/发消息那几秒里到达的消息」
          // 永远落在窗口外：本次不返回、下次请求的 baseline 已经越过它们 ⇒ 既没展示给模型，
          // 也没进 readThroughSeq（连续游标）⇒ 水位从此卡死。
          // 实测：会话末段 readThroughSeq 钉在 185，可模型已经看过 205，
          // 之后每次等待都要多读一次 unread 才能收尾；期间有人 @ 也完全没进本回合。
          //
          // 现在按**已读过水位**取：凡是没有进入 readThroughSeq 的消息，一律补给它。
          // `arrived` 仍按 requestSeq 判（"有没有新动静"语义不变），所以等待不会变成忙轮询；
          // 只要这次确实返回了，返回的就是「从水位起连续的一段」，模型据此能正常推进水位。
          const watermarkAtRequest = readThroughSeqV2(st);
          const pendingFloor = Math.min(baseline, watermarkAtRequest);
          const fullPending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > pendingFloor)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // 有上限：一次倒 30 条旧账会把上下文挤爆。**必须从最老的开始取**（连续，
          // 水位才推得动）；被截断时 partial=true，提示模型用 unread 工具续读。
          const waitCap = Math.min(50, Math.max(12, Number(cfg.socialV2?.context?.unreadLimit) || 30));
          const pending = fullPending.length > waitCap ? fullPending.slice(0, waitCap) : fullPending;
          const pendingTruncated = fullPending.length > pending.length;
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const isAgentRead = !!req.headers['x-agent-token'];
          const readThroughSeq = isAgentRead ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          if (isAgentRead) acknowledgeDesktopAttentionThrough(key, readThroughSeq);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            // Truncation is explicit so the agent can choose whether to fetch more.
            ...(pendingTruncated ? { partial: true } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key, req.headers["x-agent-token"])) {
            sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403);
            return;
          }
          if (!['sendGroup', 'sendPrivate', 'reply'].includes(tool)) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[autonomous] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [autonomous] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[autonomous] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (!agentToken) {
            sendJson({ ok: false, error: '自主会话读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !sessionAllowed(kind, num, agentToken)) {
            sendJson({ ok: false, error: '该会话未通过白名单/拒绝名单策略，不能读取' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!isDesktopAgentToken(agentToken) && !seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
                    if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        // ── 群成员列表（autonomous 会话令牌只读工具）────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const groupMatch = /^group:(\d+)$/.exec(key);
          if (!groupMatch) { sendJson({ ok: false, error: '群成员只能按 group:群号 查询' }, 400); return; }
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          if (!token) { sendJson({ ok: false, error: '自主会话读取必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const groupMembersAllowed = v2SessionAllowed(key, req.headers["x-agent-token"]);
          if (!groupMembersAllowed) { sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403); return; }
          const groupId = Number(groupMatch[1]);
          try {
            let response;
            try {
              response = await bot.request('get_group_member_list', { group_id: groupId });
            } catch (wsError) {
              // 与表情库同步同一条原则：WS 挂了不代表网关挂了，读接口走 HTTP 兜底。
              response = await onebotHttpAction('get_group_member_list', { group_id: groupId });
            }
            const payload = response && typeof response === 'object' && response.data !== undefined ? response.data : response;
            const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : null);
            if (!raw) { sendJson({ ok: false, error: '网关返回的成员列表格式异常，已拒绝' }, 502); return; }
            const members = raw.slice(0, limit).map((m) => ({
              userId: m?.user_id != null ? String(m.user_id) : '',
              nickname: truncateText(String(m?.nickname ?? ''), 40),
              card: truncateText(String(m?.card ?? ''), 40),
              ...(m?.role ? { role: String(m.role) } : {})
            })).filter((m) => m.userId);
            sendJson({ ok: true, key, count: raw.length, returned: members.length, truncated: raw.length > members.length, members });
          } catch (error) {
            log(`群成员查询失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `获取群成员失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── QQ 会话目录（仅全局桌面 agent，可按需发现可读写来源）──────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/conversations') {
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          if (!token || !isDesktopAgentToken(token)) {
            sendJson({ ok: false, error: '读取 QQ 会话目录必须使用全局陪伴者令牌' }, 403);
            return;
          }
          const kind = String(url.searchParams.get('kind') || 'all').trim();
          if (!['all', 'group', 'private'].includes(kind)) {
            sendJson({ ok: false, error: 'kind 必须是 all、group 或 private' }, 400);
            return;
          }
          const offset = Math.min(100000, Math.max(0, Number(url.searchParams.get('offset')) || 0));
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          try {
            const [groups, friends] = await Promise.all([
              kind === 'private' ? Promise.resolve([]) : onebotReadAction('get_group_list').then((data) => Array.isArray(data) ? data : []),
              kind === 'group' ? Promise.resolve([]) : onebotReadAction('get_friend_list').then((data) => Array.isArray(data) ? data : [])
            ]);
            const conversations = [
              ...groups.map((item) => {
                const id = String(item?.group_id ?? item?.groupId ?? '').trim();
                if (!/^\d+$/.test(id)) return null;
                return { key: `group:${id}`, kind: 'group', id, name: truncateText(String(item?.group_name ?? item?.groupName ?? item?.name ?? ''), 100) };
              }),
              ...friends.map((item) => {
                const id = String(item?.user_id ?? item?.userId ?? '').trim();
                if (!/^\d+$/.test(id)) return null;
                const nickname = String(item?.nickname ?? item?.name ?? '');
                const remark = String(item?.remark ?? item?.remark_name ?? '');
                return { key: `private:${id}`, kind: 'private', id, name: truncateText(remark || nickname || id, 100), ...(remark ? { remark: truncateText(remark, 100) } : {}), ...(nickname ? { nickname: truncateText(nickname, 100) } : {}) };
              })
            ].filter(Boolean).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id, 'en', { numeric: true }));
            const page = conversations.slice(offset, offset + limit);
            const nextOffset = offset + page.length < conversations.length ? offset + page.length : null;
            sendJson({ ok: true, offset, limit, total: conversations.length, nextOffset, conversations: page });
          } catch (error) {
            log(`QQ 会话目录读取失败: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `读取 QQ 会话目录失败：${error?.message ?? error}` }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !sessionAllowed(kind, id, req.headers["x-agent-token"])) {
            sendJson({ ok: false, error: '该会话未通过白名单/拒绝名单策略，不能读取' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (!agentToken) {
            sendJson({ ok: false, error: '读取图片必须携带会话令牌' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !sessionAllowed(kind, id, req.headers["x-agent-token"])) {
            sendJson({ ok: false, error: '该会话未通过白名单/拒绝名单策略，不能读取' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(req.headers['x-agent-token'] ?? body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (!token) { sendJson({ ok: false, error: '发送必须携带会话令牌' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!activeV2Turn(key, req.headers["x-agent-token"])) { sendJson({ ok: false, error: '只有正在运行的 DSH 回合可以发送 QQ 消息' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !sessionAllowed(kind, id, req.headers["x-agent-token"])) {
            sendJson({ ok: false, error: '目标未通过白名单/拒绝名单策略' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          // st/now 必须声明在 try **之外**：下面的 catch 要用它们回滚预占的发送额度。
          // 写在 try 里时 catch 拿到的是块作用域外的名字 ⇒ ReferenceError（send-burst
          // 曾整段踩过同型问题，见体检报告 #1 / R2）。后果不是"少一行日志"，而是
          // 失败响应变成「st is not defined」、额度不回滚（接下来一分钟全是假 429），
          // 且部分成功的已发消息不会被记进 recentMessages。
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;

            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            try { saveSocialV2State(); } catch (error) { log('重启前保存 QQ 缓冲状态失败:', error?.message ?? error); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key, { requireActiveTurn: false });
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 autonomous 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  // 媒体上限（config.json 可调，但必须收敛到安全区间）：
  //   maxBytes  —— 单条消息里图片/表情的总字节上限。8MB 能覆盖绝大多数动图表情；
  //                太大会让 base64 常驻内存（×1.33）并拖慢 DSH 上传。
  //   maxPixels —— 单张图解码像素上限（防图片炸弹），与 DSH 的 64MP 默认一致。
  //   maxCount  —— 单条消息最多处理几张（防止一次 @ 带 20 张图把模型上下文撑爆）。
  const maxMediaBytesLimit = (() => {
    const n = Number(cfg.socialV2?.media?.maxBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(n))) : 8 * 1024 * 1024;
  })();
  const MAX_MEDIA_COUNT = (() => {
    const n = Number(cfg.socialV2?.media?.maxCount);
    return Number.isFinite(n) && n > 0 ? Math.min(8, Math.max(1, Math.round(n))) : 5;
  })();
  const MAX_MEDIA_BYTES = maxMediaBytesLimit; // 单条消息图片总字节上限
  const MAX_MEDIA_PIXELS = (() => {
    const n = Number(cfg.socialV2?.media?.maxPixels);
    return Number.isFinite(n) && n > 0 ? Math.min(64_000_000, Math.max(1_000_000, Math.round(n))) : 64_000_000;
  })(); // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH

  // ── 喂给模型的那一份：体积与动图形态归一化 ────────────────────────────────
  //
  // 为什么必须在这里动手（而不是"让 DSH 自己处理"）：
  //   ① DSH 的 MCP 图片入口用正则校验 base64，实测量级 ≥4,474,880 字符（原始字节 ≥3.20 MiB）
  //      必抛 RangeError: Maximum call stack size exceeded，工具结果被降级成
  //      `[image unavailable: image/gif; Maximum call stack size exceeded; …]` —— 模型只看到一行错误。
  //      而下面的 MAX_MEDIA_BYTES 是**抓取**上限（默认 8 MiB），故意留着不动：
  //      得先把大图抓下来，才有机会压小它。
  //   ② DSH 对 image/gif 一律归一化成单帧，模型永远只看第一帧，且不知道那是动图。
  //      动图在桥接侧抽帧拼图后，信息量反而更高（实测 4.83MB/200 帧 → 92KB/269ms）。
  //
  // 上限默认值见 media-normalize.js 的 MEDIA_DEFAULTS；config.json 的 socialV2.media 可覆盖。
  // ⚠️ 只用于**喂模型**的出口。collectStickerV2 走 fetchOneBotImage 的原始字节，不能经过这里，
  //    否则收藏下来的表情会变成拼图/降采样版本。
  const modelMediaLimits = (() => {
    const m = cfg.socialV2?.media ?? {};
    return {
      enabled: m.normalize !== false,
      maxModelBytes: m.maxModelBytes,
      maxLongEdge: m.maxLongEdge,
      gifFrames: m.gifFrames,
      gifTile: m.gifTile,
      timeoutMs: m.normalizeTimeoutMs,
      ffmpegPath: process.env.FFMPEG_PATH || null
    };
  })();

  /**
   * 把一张已抓到的图片整理成模型可安全消费的形态。
   * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string}>}
   *          ok=false 表示"压不到可用体积"——调用方必须把它变成一句可读的失败原因，
   *          绝不发注定被 DSH 丢掉的字节（那样模型只会看到看不懂的英文错误）。
   */
  async function toModelMedia(buffer, mimeType, label = '图片') {
    const out = await normalizeImageForModel(buffer, mimeType, { ...modelMediaLimits, label });
    if (!out.ok) {
      log(`[media] ${label} 不提供：${out.error}`);
      return out;
    }
    if (out.note) log(`[media] ${label}: ${out.note}`);
    return out;
  }

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  // QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
  // https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。
  // 市场表情不在网关缓存里（get_image 返回 image not found in cache），url 又可能缺失，
  // 这条兜底能救回这一类；只接受纯十六进制 id，绝不把任意字符串拼进 URL。
  function emojiCdnCandidates(emojiId) {
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }

  // 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。
  function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }

  /** 校验一张图片字节：格式、大小（调用方已限）、像素上限；不通过返回 null。 */
  function acceptImageBuffer(buf, label = '图片') {
    if (!buf || !buf.length) return null;
    if (!looksLikeImageBuffer(buf)) {
      log(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
      return null;
    }
    const dims = getImageDimensions(buf);
    if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
      log(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
      return null;
    }
    return { buffer: buf, mimeType: mimeFromBuffer(buf) };
  }

  async function fetchOneBotImage(media) {
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    const isSticker = media.kind === 'sticker' || !!emojiId || String(media.subType || '') === '1';
    const label = isSticker ? '表情' : '图片';
    const failures = [];
    const urls = [];
    const pushUrl = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    pushUrl(media.url);
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate);

    const tryUrls = async () => {
      for (const url of urls) {
        try {
          const fetched = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
          const accepted = acceptImageBuffer(fetched.buffer, `${label} URL `);
          if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(url) };
          failures.push(`${url} 不是有效图片`);
        } catch (error) {
          failures.push(`${url}: ${error?.message ?? error}`);
        }
      }
      return null;
    };
    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker')) return null;
      if (!media.file || !isProbablySafeImageFileRef(media.file)) return null;
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          try {
            const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
          } catch (error) {
            failures.push(`get_image url: ${error?.message ?? error}`);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const accepted = acceptImageBuffer(fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
          }
        }
      } catch (error) {
        failures.push(`get_image: ${error?.message ?? error}`);
      }
      return null;
    };

    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      log(`[media] ${label}获取失败（${failures.length} 次尝试）：${failures.slice(0, 3).join(' | ')}`);
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    // 系统小表情（face 段）：只有数字 id 才有对应实体；拿不到时至少保留 summary 文案。
    const fallbackText = media.summary ? `[表情:${media.summary}]` : `[表情#${media.faceId}]`;
    if (!Number.isInteger(faceId)) return { text: fallbackText };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, '表情图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : fallbackText };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: fallbackText };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += prep.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `face-${media.faceId}.${(prep.mimeType || 'png').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          // 压不到可用体积：明确说明原因，别让模型对着「（获取失败）」瞎猜。
          parts.push({ type: 'text', text: `[表情${index}（${prep.error}）]` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
        const label = sticker ? (summary ? `[表情${summary}]` : `[表情${index}]`) : `[图片${index}]`;
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, `${label}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `${label}（图片总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          parts.push({ type: 'text', text: label });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}.${(prep.mimeType || 'image/jpeg').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          parts.push({ type: 'text', text: `${label}（${prep.error}）` });
        } else {
          parts.push({ type: 'text', text: `${label}（获取失败）` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' ? 'sticker' : 'image'), text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: [face.text || '', prep.note ? `（${prep.note}）` : ''].filter(Boolean).join(' ')
          });
        } else if (prep && !prep.ok) {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: `（获取失败：${prep.error}）` });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const kind = media.kind === 'sticker' ? 'sticker' : 'image';
        const noun = kind === 'sticker' ? '表情' : '图片';
        const base = {
          index,
          kind,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, `${noun}${index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            ...base,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: prep.note ? `（${prep.note}）` : ''
          });
        } else if (prep && !prep.ok) {
          out.push({ ...base, text: `（${noun}获取失败：${prep.error}）` });
        } else {
          out.push({ ...base, text: `（${noun}获取失败）` });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    try {
      const st = getSocialV2State(key);
      for (const messages of [st.recentMessages, st.unread]) {
        const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
        if (found && Array.isArray(found.media) && found.media.length) return found.media;
      }
    } catch {}
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // Audit outgoing desktop-agent messages, including sends to the owner's conversation.
  function shouldAuditKey(_key) {
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key, { requireActiveTurn = true } = {}) {
    const canonical = canonicalV2Key(key);
    const sessionId = desktopAgentSessionId;
    const token = desktopAgentToken;
    const epoch = desktopAgentLifecycleEpoch;
    return () => {
      if (!canonical || sessionId !== desktopAgentSessionId || token !== desktopAgentToken) {
        throw new Error('发送已取消：QQ 目标或全局陪伴者会话已变化');
      }
      if (requireActiveTurn && (!isDesktopAgentToken(token) || !desktopAgentTurnActive
          || desktopAgentLifecycle !== 'active' || epoch !== desktopAgentLifecycleEpoch)) {
        throw new Error('发送已取消：全局陪伴者回合已结束或进入暂停状态');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台切换模型或思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 保存的全局会话 ID 已失效，调用方必须重建，否则每条消息都会对着不存在的会话重试。
  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === modelSelectionEpoch) return 'applied';
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    return 'failed';
  }

  async function ensureDesktopAgentSession() {
    if (!dshReady) throw new Error('DSH 当前不可用，请稍后再试');
    if (desktopAgentResetting) throw new Error('全局陪伴者会话正在重建，请稍后再试');
    if (desktopAgentSessionPromise) return desktopAgentSessionPromise;
    const promise = (async () => {
      await refreshPresetList();
      if (!dshPresetIds.includes('desktop-agent')) {
        throw new Error(`DSH 尚未加载 desktop-agent preset（${dshPresetIds.join(', ') || '未取得 preset 清单'}）。请先安装/启用 qq-agent-presets 并重启 DSH。`);
      }

      const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
      const liveSessions = Array.isArray(list.items) ? list.items : [];
      if (desktopAgentSessionId) {
        const existing = liveSessions.find((item) => String(item?.sessionId ?? '') === desktopAgentSessionId);
        if (existing) {
          // Existing non-blank sessions have already received prompts under the old
          // per-turn injection behavior. Treat their opening context as consumed so
          // the role card is not duplicated on the first post-upgrade QQ attention.
          if (existing.blank !== true && desktopAgentInitialContextSessionId !== desktopAgentSessionId) {
            desktopAgentInitialContextSessionId = desktopAgentSessionId;
            saveDesktopAgentState();
          }
          api.events.follow(desktopAgentSessionId);
          desktopAgentTurnActive = existing.running === true;
          saveDesktopAgentState();
          const modelState = await ensureChatModel(desktopAgentSessionId);
          if (modelState !== 'not-found') return desktopAgentSessionId;
        }
        log(`全局陪伴者在 DSH 中已不存在，清理失效的全局会话状态 ${desktopAgentSessionId}`);
        desktopAgentSessionId = '';
        desktopAgentTurnActive = false;
        KNOWN_AGENT_TOKENS.delete(desktopAgentToken);
        desktopAgentToken = crypto.randomBytes(32).toString('hex');
        KNOWN_AGENT_TOKENS.add(desktopAgentToken);
        saveDesktopAgentState();
      }

      const dir = path.join(STATE_DIR, 'desktop-agent-workspace');
      fs.mkdirSync(dir, { recursive: true });
      const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
      if (wsValue.created) {
        try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: '全局陪伴者' }); } catch {}
      }
      const value = unwrap(await api.sessions.create({
        workspaceId: wsValue.workspace.workspaceId,
        agentPreset: 'desktop-agent'
      }), 'session.create');
      const sessionId = String(value.sessionId ?? '').trim();
      if (!sessionId) throw new Error('DSH 创建 desktop-agent session 未返回 sessionId');

      desktopAgentSessionId = sessionId;
      saveDesktopAgentState();
      api.events.follow(sessionId);
      await ensureChatModel(sessionId);
      log(`全局陪伴者 DSH 会话已创建：${sessionId}`);
      return sessionId;
    })();
    desktopAgentSessionPromise = promise;
    try {
      return await promise;
    } finally {
      if (desktopAgentSessionPromise === promise) desktopAgentSessionPromise = null;
    }
  }

  async function recreateDesktopAgentSession() {
    if (!dshReady) throw new Error('DSH 当前不可用，请稍后再试');
    if (desktopAgentResetting || desktopAgentSessionPromise) throw new Error('全局陪伴者会话正在处理另一项操作，请稍后再试');
    desktopAgentResetting = true;
    const oldSessionId = desktopAgentSessionId;
    try {
      let existing = null;
      if (oldSessionId) {
        const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
        existing = (Array.isArray(list.items) ? list.items : [])
          .find((item) => String(item?.sessionId ?? '') === oldSessionId) ?? null;
        if (existing?.running === true || desktopAgentTurnActive) {
          throw new Error('全局陪伴者当前正在运行；请等当前回合结束后再重建');
        }
        if (existing) {
          await withTimeout(api.stopSessionWork(oldSessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork');
          await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession');
        }
        api.events.forget?.(oldSessionId);
        sessionModels.delete(oldSessionId);
        modelAppliedSessions.delete(oldSessionId);
        toolCallNames.delete(oldSessionId);
      }

      desktopAgentSessionId = '';
      desktopAgentTurnActive = false;
      desktopAgentManualPromptPending = 0;
      KNOWN_AGENT_TOKENS.delete(desktopAgentToken);
      desktopAgentToken = crypto.randomBytes(32).toString('hex');
      KNOWN_AGENT_TOKENS.add(desktopAgentToken);
      saveDesktopAgentState();
      desktopAgentResetting = false;
      const sessionId = await ensureDesktopAgentSession();
      log(`全局陪伴者已按当前 preset 重建：${oldSessionId || '无旧会话'} -> ${sessionId}`);
      appendActivity(`全局陪伴者已重建并加载当前 desktop-agent preset（${sessionId}）`);
      return { sessionId, archivedSessionId: existing ? oldSessionId : null };
    } finally {
      desktopAgentResetting = false;
      if (desktopAttentionQueue.size > 0) scheduleDesktopAttentionFlush(1000);
    }
  }

  function desktopAgentPromptText(text, { includeRoleCard = false, memoryContext = '' } = {}) {
    const roleState = readRoleState();
    const roleHint = includeRoleCard && roleState.role ? currentRoleHintV2() : '';
    const rolePrefix = roleHint
      ? `${renderDesktopAgentPromptTemplate(cfg.desktopAgent.promptTemplates.roleCard, {
        roleName: roleState.role,
        roleContent: roleHint,
      })}\n\n`
      : '';
    return `${rolePrefix}${memoryContext}${String(text ?? '')}`;
  }

  let memoryBootstrapWarningLogged = false;
  async function desktopAgentMemoryBootstrap() {
    if (!cfg.memory.enabled || !memoryGateway.status().configured) return '';
    try {
      const result = await memoryGateway.search({
        query: '你近期的经历、行动和发现；尚未完成的事项；稳定的用户偏好和项目背景',
        limit: cfg.memory.bootstrapLimit,
        origin: 'assistant',
        mode: 'SEARCH_MODE_HYBRID',
        requestTimeoutMs: 8000
      });
      const seen = new Set();
      const entries = [];
      for (const hit of result.hits ?? []) {
        const metadata = hit.metadata && typeof hit.metadata === 'object' ? hit.metadata : {};
        if (metadata.origin !== 'assistant') continue;
        const id = String(hit.memoryId ?? hit.externalId ?? `${hit.title ?? ''}:${hit.content ?? ''}`);
        if (seen.has(id)) continue;
        seen.add(id);
        const title = String(hit.title ?? '').trim();
        const content = String(hit.content ?? '').trim();
        if (!content) continue;
        entries.push(`${title ? `${title}：` : ''}${content}`);
      }
      if (entries.length === 0) return '';
      const template = cfg.desktopAgent.promptTemplates.memoryBootstrap;
      const selectedEntries = [];
      for (const entry of entries) {
        const candidate = renderDesktopAgentPromptTemplate(template, {
          entries: [...selectedEntries, `- ${entry}`].join('\n'),
        });
        if (candidate.length > cfg.memory.bootstrapMaxChars) break;
        selectedEntries.push(`- ${entry}`);
      }
      if (selectedEntries.length === 0) return '';
      return `${renderDesktopAgentPromptTemplate(template, { entries: selectedEntries.join('\n') })}\n\n`;
    } catch (error) {
      if (!memoryBootstrapWarningLogged) {
        memoryBootstrapWarningLogged = true;
        log('获取长期记忆开场摘要失败；本轮仍继续启动');
      }
      return '';
    }
  }

  async function submitDesktopAgentPrompt(sessionId, text) {
    // Serialize the first prompt so overlapping WebUI/QQ submissions cannot both
    // append the opening role card to the same persistent DSH session.
    if (desktopAgentInitialContextPrompt) {
      await desktopAgentInitialContextPrompt.catch(() => {});
    }
    const includeRoleCard = desktopAgentInitialContextSessionId !== sessionId;
    if (!includeRoleCard) {
      return api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: desktopAgentPromptText(text) }]
      });
    }

    const pending = (async () => {
      const memoryContext = await desktopAgentMemoryBootstrap();
      const accepted = await api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: desktopAgentPromptText(text, { includeRoleCard, memoryContext }) }]
      });
      if (accepted?.result?.ok) {
        desktopAgentInitialContextSessionId = sessionId;
        saveDesktopAgentState();
      }
      return accepted;
    })();
    desktopAgentInitialContextPrompt = pending;
    try {
      return await pending;
    } finally {
      if (desktopAgentInitialContextPrompt === pending) desktopAgentInitialContextPrompt = null;
    }
  }

  function clearDesktopAgentRestTimer() {
    if (desktopAgentRestTimer) clearTimeout(desktopAgentRestTimer);
    desktopAgentRestTimer = null;
  }

  function clearDesktopAgentRecoveryTimer() {
    if (desktopAgentRecoveryTimer) clearTimeout(desktopAgentRecoveryTimer);
    desktopAgentRecoveryTimer = null;
  }

  function clearDesktopAttentionReminderTimer() {
    if (desktopAttentionReminderTimer) clearTimeout(desktopAttentionReminderTimer);
    desktopAttentionReminderTimer = null;
  }

  function hasDesktopAttentionReminderCandidates() {
    return [...desktopAttentionUnresolved.values()].some((item) => (
      item.reminderSent !== true
      && item.reminderQueued !== true
      && Number.isSafeInteger(item.seq)
      && item.seq > 0
      && Number.isSafeInteger(item.promptedSeq)
      && item.promptedSeq >= item.seq
    ));
  }

  function armDesktopAttentionReminderCheck() {
    if (desktopAttentionReminderTimer
      || desktopAgentLifecycle !== 'resting'
      || !hasDesktopAttentionReminderCandidates()) return;
    desktopAttentionReminderTimer = setTimeout(() => {
      desktopAttentionReminderTimer = null;
      if (desktopAgentLifecycle !== 'resting') return;
      if (!dshReady || desktopAgentResetting || desktopAgentTurnActive) {
        armDesktopAttentionReminderCheck();
        return;
      }

      const candidates = [...desktopAttentionUnresolved.entries()]
        .filter(([, item]) => (
          item.reminderSent !== true
          && item.reminderQueued !== true
          && Number.isSafeInteger(item.seq)
          && item.seq > 0
          && Number.isSafeInteger(item.promptedSeq)
          && item.promptedSeq >= item.seq
          && !desktopAttentionQueue.has(item.key)
        ))
        .slice(0, 20);

      for (const [key, item] of candidates) {
        desktopAttentionQueue.set(key, {
          key: item.key,
          kind: item.kind,
          id: item.id,
          reason: `未处理提醒（再次提醒）：${item.reason}`,
          sender: item.sender,
          senderId: item.senderId,
          messageId: item.messageId,
          seq: item.seq,
          count: item.count,
          firstAt: item.firstAt,
          lastAt: item.lastAt,
          reminder: true
        });
        item.reminderQueued = true;
      }

      if (candidates.length > 0) {
        desktopAgentPendingWakeReason = 'qq-attention';
        saveDesktopAgentState();
        log(`全局陪伴者休息满一个检查间隔，补发 ${candidates.length} 个仍未读 QQ 提醒（每项最多一次）`);
        appendActivity(`全局陪伴者休息期间补发 ${candidates.length} 个仍未读 QQ 提醒`);
        resumeDesktopAgentRestForAttention();
      }
      // One global timer checks all sources together. Further eligible sources wait
      // for a later rest and a later one-minute check.
      armDesktopAttentionReminderCheck();
    }, DESKTOP_ATTENTION_REMINDER_CHECK_MS);
    desktopAttentionReminderTimer.unref?.();
  }

  function stopDesktopAgentLifecycle() {
    desktopAgentLifecycleEpoch += 1;
    clearDesktopAgentRestTimer();
    clearDesktopAgentRecoveryTimer();
    clearDesktopAttentionReminderTimer();
    if (desktopAttentionFlushTimer) clearTimeout(desktopAttentionFlushTimer);
    desktopAttentionFlushTimer = null;
    desktopAgentLifecycle = 'stopped';
    desktopAgentRestUntil = 0;
    desktopAgentRecoveryAt = 0;
    desktopAgentRecoveryAttempt = 0;
    desktopAgentPendingWakeReason = '';
    desktopAgentManualPromptPending = 0;
    saveDesktopAgentState();
    log('WebUI：全局陪伴者已进入持久停止态；不会自动唤醒');
    appendActivity('全局陪伴者已由 WebUI 停止');
  }

  function resumeDesktopAgentLifecycle(reason = 'manual WebUI task') {
    desktopAgentLifecycleEpoch += 1;
    clearDesktopAgentRestTimer();
    clearDesktopAgentRecoveryTimer();
    clearDesktopAttentionReminderTimer();
    desktopAgentLifecycle = 'active';
    desktopAgentRestUntil = 0;
    desktopAgentRecoveryAttempt = 0;
    desktopAgentRecoveryAt = 0;
    desktopAgentPendingWakeReason = '';
    saveDesktopAgentState();
    log(`全局陪伴者生命周期恢复为 active（${reason}）`);
  }

  function scheduleDesktopAgentRestCancellation(sessionId, epoch, delayMs = 80, attempt = 0) {
    const timer = setTimeout(async () => {
      if (epoch !== desktopAgentLifecycleEpoch || desktopAgentLifecycle !== 'resting' || sessionId !== desktopAgentSessionId) return;
      if (!desktopAgentTurnActive || !dshReady) return;
      try {
        const result = await withTimeout(api.callUnary('session/cancel', { sessionId }), DSH_CONTROL_TIMEOUT_MS, 'session/cancel');
        if (!result?.result?.ok && result?.result?.error?.code !== 'session/not-found') {
          throw new Error(result?.result?.error?.message ?? 'DSH 未确认 turn 取消');
        }
        log(`agent_rest：已请求 DSH 结束当前 turn（${sessionId}）`);
      } catch (error) {
        const nextDelay = Math.min(250 * (2 ** Math.min(attempt, 10)), 30_000);
        log(`agent_rest：第 ${attempt + 1} 次取消当前 DSH turn 失败，${nextDelay}ms 后继续重试：${error?.message ?? error}`);
        scheduleDesktopAgentRestCancellation(sessionId, epoch, nextDelay, attempt + 1);
      }
    }, Math.max(0, delayMs));
    timer.unref?.();
  }

  function enterDesktopAgentRest(durationMs = null) {
    desktopAgentLifecycleEpoch += 1;
    clearDesktopAgentRestTimer();
    clearDesktopAgentRecoveryTimer();
    if (desktopAttentionFlushTimer) clearTimeout(desktopAttentionFlushTimer);
    desktopAttentionFlushTimer = null;
    desktopAgentLifecycle = 'resting';
    desktopAgentRestUntil = durationMs == null ? 0 : Date.now() + Math.min(Math.max(1, Number(durationMs) || 1), DESKTOP_AGENT_REST_MAX_MS);
    desktopAgentRecoveryAt = 0;
    desktopAgentRecoveryAttempt = 0;
    desktopAgentPendingWakeReason = desktopAttentionQueue.size > 0 ? 'qq-attention' : '';
    saveDesktopAgentState();
    armDesktopAgentRestTimer();
    log(desktopAgentRestUntil
      ? `全局陪伴者进入休息，至 ${new Date(desktopAgentRestUntil).toISOString()}`
      : '全局陪伴者进入无限期休息；DSH 对话输入、有效 QQ 提醒或人工 WebUI 任务可恢复');
    appendActivity(desktopAgentRestUntil ? '全局陪伴者进入定时休息' : '全局陪伴者进入无限期休息');
    armDesktopAttentionReminderCheck();

    // Let the MCP result reach DSH before cancelling this turn. The lifecycle epoch
    // prevents a just-submitted manual task or a WebUI stop from being cancelled by
    // this deferred operation.
    const sessionId = desktopAgentSessionId;
    const epoch = desktopAgentLifecycleEpoch;
    if (sessionId && dshReady) scheduleDesktopAgentRestCancellation(sessionId, epoch);
    if (desktopAgentPendingWakeReason === 'qq-attention') resumeDesktopAgentRestForAttention();
  }

  function armDesktopAgentRestTimer() {
    clearDesktopAgentRestTimer();
    if (desktopAgentLifecycle !== 'resting' || desktopAgentRestUntil <= 0) return;
    const dueAt = desktopAgentRestUntil;
    const epoch = desktopAgentLifecycleEpoch;
    desktopAgentRestTimer = setTimeout(() => {
      desktopAgentRestTimer = null;
      if (epoch !== desktopAgentLifecycleEpoch || desktopAgentLifecycle !== 'resting' || desktopAgentRestUntil !== dueAt) return;
      void finishDesktopAgentRest();
    }, Math.max(0, dueAt - Date.now()));
    desktopAgentRestTimer.unref?.();
  }

  function resumeDesktopAgentRestForAttention() {
    if (desktopAgentLifecycle !== 'resting' || desktopAgentPendingWakeReason !== 'qq-attention') return false;
    // agent_rest cancels the ending DSH turn asynchronously. Keep the rest state
    // until that turn is over, then launch the queued QQ attention prompt.
    if (desktopAgentTurnActive) return false;
    desktopAgentLifecycleEpoch += 1;
    clearDesktopAgentRestTimer();
    clearDesktopAgentRecoveryTimer();
    clearDesktopAttentionReminderTimer();
    desktopAgentLifecycle = 'active';
    desktopAgentRestUntil = 0;
    desktopAgentRecoveryAt = 0;
    desktopAgentRecoveryAttempt = 0;
    saveDesktopAgentState();
    log('有效 QQ 提醒提前结束全局陪伴者休息');
    appendActivity('有效 QQ 提醒提前结束全局陪伴者休息');
    scheduleDesktopAttentionFlush(0);
    return true;
  }

  async function finishDesktopAgentRest() {
    if (desktopAgentLifecycle !== 'resting' || desktopAgentRestUntil <= 0) return;
    if (desktopAgentRestUntil > Date.now()) {
      armDesktopAgentRestTimer();
      return;
    }
    desktopAgentRestUntil = 0;
    desktopAgentPendingWakeReason = 'rest-expired';
    clearDesktopAttentionReminderTimer();
    if (!dshReady) {
      desktopAgentLifecycle = 'recovering';
      desktopAgentRecoveryAt = Date.now();
      saveDesktopAgentState();
      armDesktopAgentRecoveryTimer();
      return;
    }
    desktopAgentLifecycle = 'active';
    desktopAgentRecoveryAt = 0;
    saveDesktopAgentState();
    scheduleDesktopAttentionFlush(0);
    log('全局陪伴者休息结束，准备发起一轮恢复');
  }

  function scheduleDesktopAgentRecovery(reason = 'turn ended without agent_rest') {
    if (desktopAgentLifecycle === 'stopped' || desktopAgentLifecycle === 'resting' || desktopAgentLifecycle === 'idle') return;
    if (desktopAgentRecoveryTimer) return;
    clearDesktopAttentionReminderTimer();
    for (const [key, item] of desktopAttentionQueue) {
      if (item.reminder !== true) continue;
      desktopAttentionQueue.delete(key);
      const unresolved = desktopAttentionUnresolved.get(key);
      if (unresolved && unresolved.seq <= (item.seq || 0)) unresolved.reminderQueued = false;
    }
    desktopAgentLifecycle = 'recovering';
    if (desktopAgentPendingWakeReason === 'qq-attention' && desktopAttentionQueue.size === 0) {
      desktopAgentPendingWakeReason = 'recovery';
    } else {
      desktopAgentPendingWakeReason ||= 'recovery';
    }
    const exponent = Math.min(desktopAgentRecoveryAttempt, 30);
    const delayMs = Math.min(DESKTOP_AGENT_RECOVERY_BASE_MS * (2 ** exponent), DESKTOP_AGENT_RECOVERY_MAX_MS);
    desktopAgentRecoveryAttempt += 1;
    desktopAgentRecoveryAt = Date.now() + delayMs;
    saveDesktopAgentState();
    log(`全局陪伴者未进入休息态（${reason}）；${Math.round(delayMs / 1000)} 秒后重试`);
    armDesktopAgentRecoveryTimer();
  }

  function armDesktopAgentRecoveryTimer() {
    clearDesktopAgentRecoveryTimer();
    if (desktopAgentLifecycle !== 'recovering' || desktopAgentRecoveryAt <= 0) return;
    const dueAt = desktopAgentRecoveryAt;
    const epoch = desktopAgentLifecycleEpoch;
    desktopAgentRecoveryTimer = setTimeout(async () => {
      desktopAgentRecoveryTimer = null;
      if (epoch !== desktopAgentLifecycleEpoch || desktopAgentLifecycle !== 'recovering' || desktopAgentRecoveryAt !== dueAt) return;
      if (!dshReady) {
        scheduleDesktopAgentRecovery('DSH unavailable at retry time');
        return;
      }
      try {
        const sessionId = await ensureDesktopAgentSession();
        const result = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
        const live = (Array.isArray(result.items) ? result.items : [])
          .find((item) => String(item?.sessionId ?? '') === sessionId) ?? null;
        if (epoch !== desktopAgentLifecycleEpoch || desktopAgentLifecycle !== 'recovering') return;
        if (live?.running === true) {
          desktopAgentTurnActive = true;
          desktopAgentLifecycle = 'active';
          desktopAgentRecoveryAt = 0;
          saveDesktopAgentState();
          return;
        }
        desktopAgentTurnActive = false;
        desktopAgentLifecycle = 'active';
        desktopAgentRecoveryAt = 0;
        desktopAgentPendingWakeReason ||= 'recovery';
        saveDesktopAgentState();
        scheduleDesktopAttentionFlush(0);
      } catch (error) {
        if (epoch !== desktopAgentLifecycleEpoch || desktopAgentLifecycle !== 'recovering') return;
        log(`全局陪伴者恢复检查失败：${error?.message ?? error}`);
        desktopAgentRecoveryAt = 0;
        scheduleDesktopAgentRecovery('recovery check failed');
      }
    }, Math.max(0, dueAt - Date.now()));
    desktopAgentRecoveryTimer.unref?.();
  }

  async function reconcileDesktopAgentLifecycle() {
    armDesktopAgentRestTimer();
    armDesktopAgentRecoveryTimer();
    if (!dshReady || desktopAgentLifecycle === 'idle') return;
    if (!desktopAgentSessionId) {
      if (desktopAgentLifecycle === 'resting' && desktopAgentPendingWakeReason === 'qq-attention') {
        resumeDesktopAgentRestForAttention();
      } else if (desktopAgentLifecycle === 'recovering' && desktopAgentPendingWakeReason === 'rest-expired') {
        clearDesktopAgentRecoveryTimer();
        desktopAgentLifecycle = 'active';
        desktopAgentRecoveryAt = 0;
        saveDesktopAgentState();
        scheduleDesktopAttentionFlush(0);
      } else if (desktopAgentLifecycle === 'active' && (desktopAttentionQueue.size > 0 || desktopAgentPendingWakeReason)) {
        scheduleDesktopAttentionFlush(0);
      } else if (desktopAgentLifecycle === 'active') scheduleDesktopAgentRecovery('no persisted DSH session');
      return;
    }
    try {
      const result = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
      const live = (Array.isArray(result.items) ? result.items : [])
        .find((item) => String(item?.sessionId ?? '') === desktopAgentSessionId) ?? null;
      if (desktopAgentLifecycle === 'stopped') {
        if (live) {
          try { await api.stopSessionWork(desktopAgentSessionId, { timeoutMs: DSH_CONTROL_TIMEOUT_MS }); }
          catch (error) { log(`恢复 DSH 后重申停止态失败：${error?.message ?? error}`); }
        }
        return;
      }
      if (desktopAgentLifecycle === 'resting') {
        if (live?.running === true) {
          desktopAgentTurnActive = true;
          scheduleDesktopAgentRestCancellation(desktopAgentSessionId, desktopAgentLifecycleEpoch, 0);
        } else if (desktopAgentPendingWakeReason === 'qq-attention') {
          desktopAgentTurnActive = false;
          resumeDesktopAgentRestForAttention();
        }
        if (desktopAgentRestUntil > 0 && desktopAgentRestUntil <= Date.now()) await finishDesktopAgentRest();
        return;
      }
      if (live?.running === true) {
        desktopAgentTurnActive = true;
        if (desktopAgentLifecycle === 'recovering') {
          clearDesktopAgentRecoveryTimer();
          desktopAgentLifecycle = 'active';
          desktopAgentRecoveryAt = 0;
          saveDesktopAgentState();
        }
        return;
      }
      desktopAgentTurnActive = false;
      if (desktopAgentLifecycle === 'recovering' && desktopAgentPendingWakeReason === 'rest-expired') {
        clearDesktopAgentRecoveryTimer();
        desktopAgentLifecycle = 'active';
        desktopAgentRecoveryAt = 0;
        saveDesktopAgentState();
        scheduleDesktopAttentionFlush(0);
      } else if (desktopAgentLifecycle === 'recovering') {
        armDesktopAgentRecoveryTimer();
      } else if (desktopAgentPendingWakeReason || desktopAttentionQueue.size > 0) {
        desktopAgentLifecycle = 'active';
        desktopAgentRecoveryAt = 0;
        saveDesktopAgentState();
        scheduleDesktopAttentionFlush(0);
      } else if (desktopAgentLifecycle === 'active') {
        scheduleDesktopAgentRecovery('bridge or DSH restarted before agent_rest');
      }
    } catch (error) {
      log(`全局陪伴者生命周期恢复检查失败：${error?.message ?? error}`);
      if (desktopAgentLifecycle === 'active') scheduleDesktopAgentRecovery('lifecycle reconciliation failed');
    }
  }

  function scheduleDesktopAttentionFlush(delayMs = DESKTOP_ATTENTION_BATCH_MS) {
    if (desktopAttentionFlushTimer || desktopAgentLifecycle !== 'active' || desktopAgentTurnActive) return;
    if (desktopAttentionQueue.size === 0 && !desktopAgentPendingWakeReason) return;
    desktopAttentionFlushTimer = setTimeout(() => {
      desktopAttentionFlushTimer = null;
      void flushDesktopAttentionSignals();
    }, Math.max(0, Number(delayMs) || 0));
    desktopAttentionFlushTimer.unref?.();
  }

  function trackUnresolvedDesktopAttention({ key, kind, id, reason, sender, senderId, messageId, seq, now }) {
    if (!Number.isSafeInteger(seq) || seq <= 0) return;
    const existing = desktopAttentionUnresolved.get(key);
    if (!existing) {
      if (desktopAttentionUnresolved.size >= DESKTOP_ATTENTION_MAX_SOURCES) {
        const oldestKey = desktopAttentionUnresolved.keys().next().value;
        if (oldestKey) desktopAttentionUnresolved.delete(oldestKey);
        log(`[autonomy] 未读 QQ 提醒跟踪达到上限 ${DESKTOP_ATTENTION_MAX_SOURCES}，丢弃最早来源`);
      }
      desktopAttentionUnresolved.set(key, {
        key, kind, id, reason, sender, senderId, messageId, seq,
        count: 1,
        firstAt: now,
        lastAt: now,
        promptedSeq: 0,
        reminderQueued: false,
        reminderSent: false
      });
      return;
    }

    existing.count += 1;
    existing.lastAt = now;
    if (seq > existing.seq) {
      Object.assign(existing, { kind, id, reason, sender, senderId, messageId, seq });
      existing.reminderQueued = false;
      existing.reminderSent = false;
    }
  }

  function queueDesktopAttentionSignal({ key, kind, id, reason, sender, senderId, messageId, seq }) {
    const now = Date.now();
    trackUnresolvedDesktopAttention({ key, kind, id, reason, sender, senderId, messageId, seq, now });
    const existing = desktopAttentionQueue.get(key);
    if (existing) {
      existing.count += 1;
      existing.reason = reason;
      existing.sender = sender;
      existing.senderId = senderId;
      existing.messageId = messageId;
      if (Number.isSafeInteger(seq) && seq > 0) existing.seq = seq;
      existing.lastAt = now;
      existing.reminder = false;
    } else {
      if (desktopAttentionQueue.size >= DESKTOP_ATTENTION_MAX_SOURCES) {
        const oldestKey = desktopAttentionQueue.keys().next().value;
        if (oldestKey) desktopAttentionQueue.delete(oldestKey);
        log(`[autonomy] 全局 QQ 提醒队列达到上限 ${DESKTOP_ATTENTION_MAX_SOURCES}，丢弃最早来源`);
      }
      desktopAttentionQueue.set(key, {
        key, kind, id, reason, sender, senderId, messageId,
        seq: Number.isSafeInteger(seq) && seq > 0 ? seq : null,
        count: 1, firstAt: now, lastAt: now, reminder: false
      });
    }
    if (desktopAgentLifecycle === 'idle') {
      desktopAgentLifecycle = 'active';
      saveDesktopAgentState();
    } else if (desktopAgentLifecycle === 'resting') {
      desktopAgentPendingWakeReason = 'qq-attention';
      saveDesktopAgentState();
      resumeDesktopAgentRestForAttention();
    }
    scheduleDesktopAttentionFlush();
  }

  function acknowledgeDesktopAttentionThrough(key, throughSeq) {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) return false;
    let acknowledged = false;
    const pending = desktopAttentionQueue.get(key);
    if (pending && Number.isSafeInteger(pending.seq) && pending.seq <= throughSeq) {
      desktopAttentionQueue.delete(key);
      acknowledged = true;
    }
    const unresolved = desktopAttentionUnresolved.get(key);
    if (unresolved && Number.isSafeInteger(unresolved.seq) && unresolved.seq <= throughSeq) {
      desktopAttentionUnresolved.delete(key);
      acknowledged = true;
    }
    if (acknowledged && desktopAttentionQueue.size === 0 && desktopAgentPendingWakeReason === 'qq-attention') {
      desktopAgentPendingWakeReason = '';
      saveDesktopAgentState();
    }
    return acknowledged;
  }

  function recordDesktopAttentionBatchAccepted(batch) {
    for (const [key, item] of batch) {
      const unresolved = desktopAttentionUnresolved.get(key);
      if (!unresolved || !Number.isSafeInteger(item.seq) || item.seq <= 0) continue;
      if (item.reminder === true) {
        if (unresolved.seq <= item.seq) {
          unresolved.reminderQueued = false;
          unresolved.reminderSent = true;
        }
      } else if (item.seq <= unresolved.seq) {
        unresolved.promptedSeq = Math.max(unresolved.promptedSeq, item.seq);
      }
    }
    armDesktopAttentionReminderCheck();
  }

  function requeueDesktopAttentionBatch(batch, { accepted = false } = {}) {
    for (const [key, item] of batch) {
      // Once DSH accepted a follow-up reminder, do not submit it again if a
      // concurrent lifecycle change cancels the turn.
      if (accepted && item.reminder === true) continue;
      const newer = desktopAttentionQueue.get(key);
      if (newer) {
        newer.count += item.count;
        if (Number.isSafeInteger(item.seq) && item.seq > (newer.seq || 0)) newer.seq = item.seq;
        if (item.reminder === true && newer.seq === item.seq) newer.reminder = true;
      }
      else desktopAttentionQueue.set(key, item);
    }
  }

  async function flushDesktopAttentionSignals() {
    if (desktopAttentionFlushPromise) return desktopAttentionFlushPromise;
    if (!dshReady || desktopAgentResetting || desktopAgentLifecycle !== 'active' || desktopAgentTurnActive) return;
    const batch = [...desktopAttentionQueue.entries()]
      .sort((a, b) => a[1].lastAt - b[1].lastAt)
      .slice(-20);
    const wakeReason = desktopAgentPendingWakeReason;
    if (batch.length === 0 && !wakeReason) return;
    const epoch = desktopAgentLifecycleEpoch;
    for (const [key] of batch) desktopAttentionQueue.delete(key);
    const promise = (async () => {
      try {
        const sessionId = await ensureDesktopAgentSession();
        if (desktopAgentLifecycle !== 'active' || epoch !== desktopAgentLifecycleEpoch) {
          requeueDesktopAttentionBatch(batch);
          return;
        }
        if (desktopAgentTurnActive) {
          requeueDesktopAttentionBatch(batch);
          return;
        }
        const lines = batch.map(([, item]) => {
          const cue = truncateText(String(item.reason ?? 'attention'), 80).replace(/[\r\n]/g, ' ');
          const sender = truncateText(String(item.sender ?? '未知'), 64).replace(/[\r\n]/g, ' ');
          const senderId = item.senderId ? `，发送者 QQ ${String(item.senderId)}` : '';
          const messageId = item.messageId ? `，消息 ID ${String(item.messageId)}` : '';
          const count = item.count > 1 ? `，合并 ${item.count} 条提醒` : '';
          return renderDesktopAgentPromptTemplate(cfg.desktopAgent.promptTemplates.qqSource, {
            key: item.key,
            kind: item.kind,
            reason: cue,
            sender,
            senderId,
            messageId,
            count,
          });
        });
        const wakeInstructionByReason = {
          'rest-expired': cfg.desktopAgent.promptTemplates.restExpired,
          'qq-attention': cfg.desktopAgent.promptTemplates.qqWake,
          recovery: cfg.desktopAgent.promptTemplates.recovery,
        };
        const wakeInstruction = wakeInstructionByReason[wakeReason] ?? '';
        const prompt = [
          wakeInstruction,
          batch.length ? renderDesktopAgentPromptTemplate(cfg.desktopAgent.promptTemplates.qqAttention, { sources: lines.join('\n') }) : '',
        ].filter(Boolean).join('\n');
        const accepted = await submitDesktopAgentPrompt(sessionId, prompt);
        if (!accepted?.result?.ok) {
          const error = accepted?.result?.error;
          throw new Error(`${error?.code ?? 'prompt_rejected'}: ${error?.message ?? 'DSH 未接受提醒'}`);
        }
        recordDesktopAttentionBatchAccepted(batch);
        if (desktopAgentLifecycle !== 'active' || epoch !== desktopAgentLifecycleEpoch) {
          if (desktopAgentLifecycle === 'stopped' && dshReady) {
            try { await api.stopSessionWork(sessionId, { timeoutMs: DSH_CONTROL_TIMEOUT_MS }); } catch {}
          }
          requeueDesktopAttentionBatch(batch, { accepted: true });
          return;
        }
        desktopAgentTurnActive = true;
        if (wakeReason && desktopAgentPendingWakeReason === wakeReason) desktopAgentPendingWakeReason = '';
        saveDesktopAgentState();
        log(`全局陪伴者会话已接收唤醒提示（${batch.length} 个 QQ 来源，未包含消息正文，${sessionId}）`);
        if (batch.length) appendActivity(`QQ 注意信号已提交给全局陪伴者（${batch.length} 个来源，仅元数据）`);
      } catch (error) {
        requeueDesktopAttentionBatch(batch);
        log(`陪伴者唤醒提示提交失败，保留待处理提醒：${error?.message ?? error}`);
        if (desktopAgentLifecycle === 'active') scheduleDesktopAgentRecovery('wake prompt failed');
      }
    })();
    desktopAttentionFlushPromise = promise;
    try {
      await promise;
    } finally {
      if (desktopAttentionFlushPromise === promise) desktopAttentionFlushPromise = null;
    }
  }

  // ── SnowLuma QQ 消息来源状态 ─────────────────────────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（小写；启动时从网关获取，识别"被提到"用）
  // 给 agent 看的身份（保留原始大小写）与机器人自己的 QQ 号。
  // 为什么必须单独存：消息里只有 "@樰" 这一串文本，agent 没有任何途径知道"樰"就是它自己，
  // 于是会把 @自己 当成 @别人、已读不回（issue #29）。昵称与 QQ 号要显式写进 prompt。
  let selfDisplayName = '';
  let selfUserId = '';
  // ── QQ 消息缓冲与提醒控制 ────────────────────────────────────────────────
  const socialV2 = {
    conversations: new Map(), // QQ source key -> local message buffer and read watermark
    paused: false, // 控制台可暂停 QQ 提醒，不改变全局 DSH 会话的停止状态
  };

  // 会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        recentMessages: [],
        unread: [],
        lastAiReplyAt: 0,
        lastActionAt: 0,
        sendTimes: [],
        stickerCollectTimes: [],
        lastIncomingAt: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set()
      };
      socialV2.conversations.set(key, st);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次，但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        let migratedLegacyFields = 0;
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          if (['agentToken', 'wakeConfig', 'bootstrapSent', 'wakeTimes', 'pendingWakeReasons'].some((field) => Object.hasOwn(val, field))) {
            migratedLegacyFields += 1;
          }
          const lastUnreadSeq = Math.max(0, Number(val.lastUnreadSeq) || 0,
            ...[...(Array.isArray(val.unread) ? val.unread : []), ...(Array.isArray(val.recentMessages) ? val.recentMessages : [])]
              .map((message) => Number.isSafeInteger(message?.seq) && message.seq > 0 ? message.seq : 0));
          const st = {
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            lastUnreadSeq,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, lastUnreadSeq) : 0,
            modelSeenSeqs: new Set()
          };
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
        }
        // 加载阶段统一落盘，清除旧逐 QQ session 令牌和唤醒字段。只有文件仍是我们读到的版本才写；
        // 如果这期间另一个进程已经写过文件，回写会覆盖它的新状态。
        //
        // But if another process changed it while loading, don't overwrite newer state.
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
          if (migratedLegacyFields > 0) log(`已迁移 ${migratedLegacyFields} 份 QQ 缓冲状态，移除旧逐会话 agent token 与唤醒配置`);
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  loadSocialV2State();

  // 当前角色卡：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进新会话的开场上下文。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 新会话首次注入的还是旧人格；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"重建后还载入旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 角色卡保留 〔一代〕/〔二代〕历史小节标记以兼容旧卡；运行时固定选取自主会话内容，
  // **再**按上限截断，避免未使用的小节占掉本次的注入预算。
  function roleHintForAutonomousRuntime() {
    const selected = selectRoleText(roleRawContent(), 'v2');
    if (!selected) return '';
    return selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
  }
  // 自主会话角色提示：去掉历史一代角色卡中的 [SILENT] / 空格分句指令，避免与工具协议冲突。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 检测自主会话发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测自主会话发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    // 先按历史 〔二代〕/〔一代〕角色卡标记筛小节；下方逐行过滤给未标记的老卡片兜底。
    const raw = roleHintForAutonomousRuntime();
    if (!raw) return '';
    // 历史一代角色卡专用指令整行过滤，避免污染自主会话工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 保留了自主会话内容、
    // 这里却把一代指令漏进提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        kept.push(line);
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(line);
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 自主会话唤醒调度 ────────────────────────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：autonomous 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
     // 有新消息进来，之前的“沉睡前已等待/已观察”作废


    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();



    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      const isMemoryTool = /memory/i.test(String(safeEntry.tool ?? ''));
      if (isMemoryTool && Object.hasOwn(safeEntry, 'args')) {
        safeEntry.args = '[memory query/content omitted]';
      }
      if (isMemoryTool && typeof safeEntry.error === 'string') safeEntry.error = '[memory error omitted]';
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(_key, _st, event, kind, _textContent, plainContent, quoteTargetIsSelf) {
    return classifyIncomingWake({
      kind,
      message: event?.message,
      selfId: event?.self_id ?? selfUserId,
      replyTargetIsSelf: quoteTargetIsSelf,
      text: plainContent,
      attentionKeywords: cfg.socialV2?.attentionKeywords,
      roleCardNames: kind === 'group' ? listRoles() : []
    });
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    const wakeTrigger = evaluateWakeTriggerV2(key, null, event, kind, textContent, plainContent, quoteTargetIsSelf);
    if (!plainContent && !quoteTargetIsSelf && !wakeTrigger) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 静默模式只压住群消息提醒；消息仍进入本地缓冲，供全局陪伴者主动读取。
    const suppressGroupAttention = roleState.mode === 'silent' && !isOwner;

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `全局陪伴者：${desktopAgentLifecycle}；DSH ${dshReady ? '已连接' : '未连接'}；角色 ${rs.role ?? '无'}；角色状态 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色卡选择；已开始的全局会话保留原有上下文，新会话不再注入人格卡。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已选择角色卡：${name}。会话首次收到任务或提醒时载入；已开始的会话需重建后更新。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      if (plainContent.startsWith('/')) {
        await sendToQQ(key, '未知 QQ 管理命令。请在 WebUI 管理全局陪伴者；与全局会话对话请直接发送消息。');
        return;
      }
    }

    // Buffer every readable message locally. Only direct attention signals reach
    // the global DSH session, and the prompt contains metadata rather than body.
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      const bufferedMessage = appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // The old pause switch still suppresses QQ-derived activity. Ordinary group
      // messages remain buffered without creating a DSH session or model turn.
      if (socialV2.paused || cfg.socialV2?.enabled === false || suppressGroupAttention) {
        appendActivity(`${key} QQ 提醒已暂停，消息仅缓冲不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      if (wakeTrigger) {
        const senderName = kind === 'group'
          ? (event.sender?.card || event.sender?.nickname || String(event.user_id ?? '未知'))
          : (event.sender?.nickname || String(event.user_id ?? '私聊'));
        queueDesktopAttentionSignal({
          key,
          kind,
          id: String(id),
          reason: wakeTrigger,
          sender: senderName,
          senderId: event.user_id != null ? String(event.user_id) : '',
          messageId: event.message_id ?? event.msg_id ?? null,
          seq: bufferedMessage?.seq
        });
      }
      appendActivity(`${key} 消息已缓冲${wakeTrigger ? '；仅元数据提醒全局陪伴者' : ''}：${textContent.slice(0, 80)}`);
      return;
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    // A poke is buffered for a later explicit read, but it is not a model wake.
    appendActivity(`${key} [autonomy] 拍一拍已缓冲：${msg.text.slice(0, 80)}`);
  }

  async function pumpMux() {
    let retryMs = 3000;
    let failureStreak = 0;
    for (;;) {
      let framesThisStream = 0;
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          framesThisStream += 1;
          const frame = envelope.payload;
          if (frame.type === 'session/snapshot') {
            if (frame.sessionId === desktopAgentSessionId) recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            if (frame.sessionId !== desktopAgentSessionId) continue;
            const event = frame.event;
            recordSessionUsage(frame.sessionId, event);
            if (event?.type === 'turn/start') {
              const turnWasAlreadyActive = desktopAgentTurnActive;
              desktopAgentTurnActive = true;
              const manualQueued = !turnWasAlreadyActive && desktopAgentManualPromptPending > 0 && desktopAgentLifecycle !== 'stopped';
              const directDshWake = !turnWasAlreadyActive
                && desktopAgentManualPromptPending === 0
                && desktopAgentLifecycle === 'resting';
              if (manualQueued) {
                desktopAgentManualPromptPending = Math.max(0, desktopAgentManualPromptPending - 1);
                if (desktopAgentLifecycle === 'resting' || desktopAgentLifecycle === 'recovering') {
                  desktopAgentLifecycleEpoch += 1;
                  clearDesktopAgentRestTimer();
                  clearDesktopAgentRecoveryTimer();
                  clearDesktopAttentionReminderTimer();
                  desktopAgentLifecycle = 'active';
                  desktopAgentRestUntil = 0;
                  desktopAgentRecoveryAttempt = 0;
                  desktopAgentRecoveryAt = 0;
                  desktopAgentPendingWakeReason = '';
                }
                saveDesktopAgentState();
              } else if (directDshWake) {
                desktopAgentLifecycleEpoch += 1;
                clearDesktopAgentRestTimer();
                clearDesktopAgentRecoveryTimer();
                clearDesktopAttentionReminderTimer();
                desktopAgentLifecycle = 'active';
                desktopAgentRestUntil = 0;
                desktopAgentRecoveryAt = 0;
                desktopAgentRecoveryAttempt = 0;
                desktopAgentPendingWakeReason = '';
                saveDesktopAgentState();
                log('DSH 对话中的手动消息提前结束全局陪伴者休息');
                appendActivity('DSH 对话中的手动消息提前结束全局陪伴者休息');
              } else if (desktopAgentLifecycle === 'stopped' || desktopAgentLifecycle === 'resting') {
                const lifecycle = desktopAgentLifecycle;
                const sessionId = frame.sessionId;
                setTimeout(() => {
                  if (desktopAgentLifecycle !== lifecycle || desktopAgentSessionId !== sessionId) return;
                  void api.stopSessionWork(sessionId, { timeoutMs: DSH_CONTROL_TIMEOUT_MS })
                    .catch((error) => log('全局陪伴者处于 ' + lifecycle + ' 状态时 DSH 意外启动 turn，取消失败：' + (error?.message ?? error)));
                }, 0).unref?.();
              } else if (desktopAgentLifecycle === 'recovering') {
                clearDesktopAgentRecoveryTimer();
                desktopAgentLifecycle = 'active';
                desktopAgentRecoveryAt = 0;
                desktopAgentPendingWakeReason = '';
                saveDesktopAgentState();
              } else if (desktopAgentLifecycle === 'idle') {
                desktopAgentLifecycle = 'active';
                saveDesktopAgentState();
              }
            }

            if (event?.type === 'tool/call') {
              const toolName = String(event.data?.name ?? '');
              const callId = event.data?.callId;
              const args = sanitizeToolArgs(event.data?.arguments ?? event.data?.input ?? event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key: 'desktop-agent', sessionId: frame.sessionId, tool: toolName, args });
              appendActivity('全局陪伴者调用 SnowLuma/桌面工具：' + toolName);
              if (callId != null) {
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            } else if (event?.type === 'tool/result') {
              const callId = event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = event.data?.message?.content?.[0];
              const failed = event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = failed ? String(resultBlock?.text ?? resultBlock?.error ?? event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key: 'desktop-agent',
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !failed,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) toolCallNames.get(frame.sessionId)?.delete(String(callId));
            }

            if (event?.type === 'turn/end') {
              desktopAgentTurnActive = false;
              toolCallNames.delete(frame.sessionId);
              if (desktopAgentLifecycle === 'resting' && desktopAgentPendingWakeReason === 'qq-attention') {
                resumeDesktopAgentRestForAttention();
              } else if (desktopAgentLifecycle === 'active' && desktopAgentManualPromptPending === 0) {
                if (desktopAgentPendingWakeReason === 'rest-expired'
                  || desktopAgentPendingWakeReason === 'qq-attention'
                  || desktopAttentionQueue.size > 0) scheduleDesktopAttentionFlush(0);
                else scheduleDesktopAgentRecovery('turn ended without agent_rest');
              }
            }
            continue;
          }
          if (frame.type === 'stream/error') log('事件流错误:', frame.error);
        }
        log('DSH 事件流已结束（本次收到 ' + framesThisStream + ' 帧）');
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        toolCallNames.clear();
      }
      if (framesThisStream > 0) {
        failureStreak = 0;
        retryMs = 3000;
      } else {
        failureStreak += 1;
        retryMs = Math.min(30000, retryMs * 2);
        if (failureStreak === 3) {
          log('⚠️ 连续多次连上 DSH 事件流后一帧都没收到就断开：多半是 DSH 侧事件流协议/版本不匹配'
            + '（可在 DSH 里核对版本，或查看 issue #34）。已改为指数退避重连，不再每 3 秒刷屏。');
        }
      }
      await sleep(retryMs);
    }
  }
  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
    // 用 `===` 漏掉自己发的消息会进入正常处理（autonomous 下 AI 会回答自己 / chat 下可能回复循环）。
    if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
      || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        selfDisplayName = String(login.nickname).trim();
        log(`机器人昵称: ${login.nickname}`);
      }
      if (login?.user_id != null) selfUserId = String(login.user_id);
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → OneBot HTTP 调用与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => {
    // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
    // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
    // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
    const detail = error && typeof error === 'object'
      ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ') || JSON.stringify(error)
      : String(error ?? '');
    log(`SnowLuma 错误：${detail || '(无详情)'}`);
    void healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
  });

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  if (desktopAgentRestNeedsClamp) {
    saveDesktopAgentState();
    log('旧的有限休息时间超过 12 小时上限，已将截止时间缩短并保存');
  }
  armDesktopAgentRestTimer();
  armDesktopAgentRecoveryTimer();
  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
