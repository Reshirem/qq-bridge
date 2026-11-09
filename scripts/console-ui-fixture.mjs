#!/usr/bin/env node
/** Offline console preview. No production modules, credentials, state, or network clients are loaded. */
import { qqChannelConfig } from '../src/qq-channel-config.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTokenLedger } from '../src/token-ledger.js';
import { manualDirCommand } from '../src/state-acl.mjs';
import { composePresetPromptModules, normalizePresetPromptModules, PRESET_PROMPT_MODULE_DEFINITIONS } from '../src/preset-prompt.js';
import { DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS, normalizeDesktopAgentPromptTemplates } from '../src/desktop-agent-prompt-templates.js';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timestamp = '2026-09-20T08:30:00.000Z';
const ROLE_SOFT_RECOMMENDED_CHARS = 6000;

function roleCharCount(content) {
  return Array.from(String(content ?? '')).length;
}

function estimateRoleTokens(content) {
  let cjkChars = 0;
  let otherChars = 0;
  for (const character of String(content ?? '')) {
    const code = character.codePointAt(0);
    const isCjk =
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0x2fff) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0x3100 && code <= 0x312f) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x20000 && code <= 0x2fa1f);
    if (isCjk) cjkChars += 1;
    else otherChars += 1;
  }
  return Math.ceil(cjkChars * 0.6 + otherChars * 0.3);
}

function roleWarnings(content) {
  const chars = roleCharCount(content);
  return chars > ROLE_SOFT_RECOMMENDED_CHARS
    ? [`当前 ${chars} 字符，约 ${estimateRoleTokens(content)} tokens，超过建议的 ${ROLE_SOFT_RECOMMENDED_CHARS} 字符；仍会完整保存并加入 DSH persona 前缀`]
    : [];
}

// 预设状态：离线 UI 只模拟唯一的全局 desktop-agent。
function presetStatusFixture() {
  return {
    preset: 'desktop-agent',
    label: '全局数字角色',
    sourceFile: 'dsh/agent-presets/desktop-agent/agent.cordis.yml',
    installed: true,
    requiresRestart: true,
  };
}

function makeUsageFixture() {
  const rate = { input:1, cache_read:0.1, cache_write:1.25, output:2, tiers:[] };
  const catalog = {
    get: (provider,model) => provider === 'demo' && model === 'priced' ? rate : null,
    status: () => ({updatedAt:Date.now()}), auto() {}
  };
  const ledger = createTokenLedger({file:':memory:',catalog});
  for (const [index,feature] of ['main','memory','learning'].entries()) {
    ledger.ingestSample({sessionId:'demo-'+feature, feature, provider:'demo', model:index===2 ? 'unknown' : 'priced',
      turn:1,step:1,seq:1, at:Date.now()-index*3600000,usage:{inputTokens:5000,cacheReadTokens:500,outputTokens:100}});
  }
  return ledger;
}

export function makeFixtureState() {
  const promptContent = {
    identity: '你是用户长期相处的自主数字角色；人格卡定义你的具体身份和形态，可以采用非人设定。',
  };
  const desktopPromptModules = PRESET_PROMPT_MODULE_DEFINITIONS.map((definition) => ({
    ...definition,
    enabled: true,
    content: promptContent[definition.id] || `离线演示模块：${definition.title}。`,
  }));
  return {
    role: '小鲸鱼', desktopAgentStopped: false,
    snowluma: { connected: true, accountOnline: true, degraded: false, good: true },
    memorySettings: { enabled: true, namespace: 'demo', baseUrl: 'http://127.0.0.1:8080', apiKeyConfigured: true },
    memoryProviders: { embedding: { model: 'demo-embedding', dimension: 1024 }, llm: { model: 'demo-model' } },
    memoryRecords: [{ memoryId: 'demo-first', content: '离线记忆：记得周末整理书架。', metadata: { origin: 'assistant' }, observedAt: timestamp }],
    memorySequence: 0,
    organizerSource: { sessionId: 'mock-desktop-agent-session', title: '演示主会话', current: true, updatedAt: timestamp,
      lastScheduledSeq: 18, lastProcessedSeq: -1, asOfSeq: 25 },
    organizerJobs: [{ jobId: 'demo-retry', kind: 'rest', sourceSessionId: 'mock-desktop-agent-session',
      status: 'failed', createdAt: Date.parse(timestamp), updatedAt: Date.parse(timestamp), fromSeq: 0, throughSeq: 18,
      error: '模型请求超时，已保留分段进度。', progress: { completed: 2, total: 3 }, sourceSessionCurrent: true }],
    learning: { enabled: true, slang: true, stickers: true, minMessages: 20, cooldownMs: 300000, maxWaitMs: 900000, sources: [] },
    slang: [{ id: 'fixture-word', content: '摸鱼', meaning: '工作时偷闲', scope: 'group:123456789', status: 'learned', count: 3, usage: '熟人闲聊', evidence: [{ key: 'group:123456789', userId: '100001', text: '今天忙完了，可以摸鱼一会', time: Date.parse(timestamp) }] }],
    stickerReviews: [{ id: 'review-1', stickerId: 'fixture-sticker', scope: 'group:123456789', before: { desc: '开心的小猫', tags: ['开心', '赞同'] }, after: { desc: '猫咪点头', tags: ['赞同'] } }],
    learnedStickers: [{ id: 'fixture-sticker', desc: '开心的小猫', tags: ['开心', '赞同'], usage: '回应好消息', scope: 'group:123456789', status: 'learned', usedCount: 2 }],
    roles: ['小鲸鱼', '温柔助手', '技术伙伴'],
    roleContents: {
      小鲸鱼: '# 小鲸鱼\n\n- 性格：好奇、爱接梗，遇到不懂的会直接问\n- 说话风格：简短，偶尔用 emoji',
      温柔助手: '# 温柔助手\n\n- 性格：温和、有耐心\n- 说话风格：先共情再回答',
      技术伙伴: '# 技术伙伴\n\n- 性格：直接、爱讲原理\n- 说话风格：先给结论再解释',
    },
    desktopPrompt: composePresetPromptModules({ version: 1, modules: desktopPromptModules }),
    desktopPromptModules,
    runtimePromptTemplates: normalizeDesktopAgentPromptTemplates(DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS),
    dshEffort: 'max',
    whitelist: { allow: { groups: [123456789, 100003], private: [100001] }, deny: { groups: [], private: [] }, ownerQQ: '100001' },
    v2: qqChannelConfig({ attentionKeywords: ['看看这个'] }),
    buffers: [
      { key: 'group:123456789', name: '示例群聊', unreadCount: 2, attention: 'queued', lastIncomingAt: Date.now(), lastAiReplyAt: Date.now() - 120000 },
      { key: 'private:100001', name: '示例好友', unreadCount: 0, attention: '', lastIncomingAt: Date.now() - 60000, lastAiReplyAt: 0 },
    ],
    hardenStateDir: false,
    toolLog: [
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_unread_messages', type: 'call', args: JSON.stringify({ key: 'group:123456789', limit: 20 }) },
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_unread_messages', type: 'result', ok: true },
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_message_detail', type: 'result', ok: false, error: '消息定位已失效' },
    ],
    feedback: [{ time: timestamp, key: 'group:123456789', level: 'error', message: '离线演示错误。' }],
  };
}

/** Bind only to loopback. Mutations affect this server's disposable in-memory state. */
export async function startConsoleFixture({ port = 0, htmlPath, logWrites = false } = {}) {
  const file = htmlPath || resolve(projectRoot, 'public/console.html');
  await readFile(file); // Fail early rather than displaying a broken preview.
  const state = makeFixtureState();
  const usage = makeUsageFixture();
  const requests = [];
  const unknownRequests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (method === 'GET' && ['/', '/console', '/console.html'].includes(path)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'" });
        const markup = await readFile(file, 'utf8');
        res.end(markup.replace('<body>', '<body data-preview="offline">'));
        return;
      }
      if (method === 'GET' && ['/console.css', '/console.js', '/overview.css', '/overview.js'].includes(path)) {
        const asset = path.slice(1);
        res.writeHead(200, {
          'content-type': asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
          'cache-control': 'no-store'
        });
        res.end(await readFile(resolve(projectRoot, 'public', asset)));
        return;
      }
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (method === 'GET' && path === '/__fixture/requests') return json({ requests, unknownRequests });
      if (method === 'GET' && path === '/__fixture/info') return json({ offline: true, htmlPath: file });
      if (!path.startsWith('/api/')) return json({ ok: false, error: 'Offline fixture route not found' }, 404);

      let body = {};
      if (method !== 'GET') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        requests.push({ method, path, body });
        if (logWrites) console.log(`[mock write] ${method} ${path} ${JSON.stringify(body)}`);
      }
      if (method === 'GET') {
        switch (path) {
          case '/api/learning/status': return json({ ok: true, config: state.learning, running: false, pending: 12, runs: 4, words: state.slang.length, pictures: state.learnedStickers.length, dropped: 0 });
          case '/api/slang':
          case '/api/learning/stickers': {
            const collection = path === '/api/slang' ? state.slang : state.learnedStickers;
            const query = url.searchParams.get('query') || '', scope = url.searchParams.get('scope'), status = url.searchParams.get('status');
            const filtered = collection.filter(e => (!query || JSON.stringify(e).includes(query)) && (!scope || e.scope === scope) && (!status || e.status === status));
            return json({ ok: true, items: filtered, total: filtered.length, offset: 0, hasMore: false });
          }
          case '/api/learning/sticker-reviews': return json({ ok: true, reviews: state.stickerReviews });
          case '/api/memory/status': return json({ ok: true, memory: { ...state.memorySettings, serviceInstalled: true, gatewayReachable: true, configured: true } });
          case '/api/memory/settings': return json({ ok: true, settings: state.memorySettings });
          case '/api/memory/providers': return json({ ok: true, providers: state.memoryProviders });
          case '/api/memory/organizer': return json({ ok: true, organizer: { enabled: true, memoryConfigured: true, dshReady: true,
            sessions: [state.organizerSource], sessionsByDay: {}, jobs: state.organizerJobs, timeZone: 'Asia/Shanghai' } });
          case '/api/learning/sticker-reviews/image':
          case '/api/learning/stickers/image': {
            res.writeHead(200, { 'content-type': 'image/png' });
            return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64'));
          }
          case '/api/stickers': return json({ ok: true, stickers: [{ id: 'qq-fixture', desc: 'QQ 收藏示例' }], total: 1 });
          case '/api/status': return json({ ok: true, dshReady: true, snowluma: state.snowluma, role: state.role, ownerQQ: state.whitelist.ownerQQ, allowGroups: state.whitelist.allow.groups, allowPrivate: state.whitelist.allow.private, activity: '[08:30:00] 演示桥接已连接\n[08:30:12] desktop-agent 自主会话已就绪\n以上均为离线模拟数据。' });
          case '/api/roles': return json({
            roles: state.roles.slice(),
            summaries: state.roles.map((name) => {
              const content = state.roleContents[name] ?? '';
              return {
                name,
                bytes: Buffer.byteLength(content, 'utf8'),
                chars: roleCharCount(content),
                estimatedTokens: estimateRoleTokens(content),
                lines: content.split('\n').length,
                mtime: Date.parse(timestamp),
                excerpt: content.split('\n').find((line) => line.trim() && !line.trim().startsWith('#')) ?? '',
                recommendedLengthExceeded: roleCharCount(content) > ROLE_SOFT_RECOMMENDED_CHARS,
                warnings: roleWarnings(content).length,
              };
            }),
            current: state.role,
            limits: { nameMax: 40, recommendedChars: ROLE_SOFT_RECOMMENDED_CHARS },
          });
          case '/api/roles/content': {
            const name = url.searchParams.get('name') ?? '';
            if (!state.roleContents[name]) return json({ ok: false, error: `人格「${name}」不存在` }, 404);
            const content = state.roleContents[name];
            return json({
              ok: true,
              name,
              content,
              chars: roleCharCount(content),
              estimatedTokens: estimateRoleTokens(content),
              bytes: Buffer.byteLength(content, 'utf8'),
              warnings: roleWarnings(content),
              recommendedChars: ROLE_SOFT_RECOMMENDED_CHARS,
            });
          }
          case '/api/preset/desktop-agent-prompt/modules': {
            const content = composePresetPromptModules({ version: 1, modules: state.desktopPromptModules });
            return json({ ok: true, modules: state.desktopPromptModules, content, chars: content.length, warnings: [], status: presetStatusFixture() });
          }
          case '/api/desktop-agent/prompt-templates': {
            return json({ ok: true, templates: state.runtimePromptTemplates, defaults: DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS });
          }
          case '/api/preset/desktop-agent-prompt': {
            return json({
              ok: true,
              content: state.desktopPrompt,
              chars: state.desktopPrompt.length,
              bytes: Buffer.byteLength(state.desktopPrompt, 'utf8'),
              warnings: [],
              status: presetStatusFixture(),
              presets: [presetStatusFixture()],
            });
          }
          case '/api/preset/desktop-agent-prompt/backups': {
            return json({ ok: true, backups: [{ file: 'desktop-agent.agent.cordis.yml.fixture', mtime: Date.parse(timestamp) }] });
          }
          case '/api/dsh/model': return json({
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            reasoningEffort: state.dshEffort,
            options: ['low', 'high', 'max'],
            labels: { low: { name: 'Low', description: 'routine' }, high: { name: 'High', description: 'default balance' }, max: { name: 'Max', description: 'hardest tasks' } },
            default: 'max',
            providerDefault: 'high',
            catalogSource: 'dsh',
            globalSideEffect: true,
          });
          case '/api/whitelist': return json(state.whitelist);
          case '/api/console/desktop-agent': return json({
            ok: true, dshReady: true, presetAvailable: true, sessionId: 'mock-desktop-agent-session',
            found: true, running: false, blank: false, agentAvailable: true, lifecycle: state.desktopAgentStopped ? 'stopped' : 'idle'
          });
          case '/api/console/desktop-agent/history': {
            const older = url.searchParams.has('beforeSeq');
            const records = older ? [
              { seq: 9, event: { type: 'request/header', data: { turn: 1, step: 1 } }, hiddenInternalItems: 0 },
              { seq: 17, event: { type: 'user/message', data: { turn: 1, message: { content: [{ type: 'text', text: '请按当前角色在这个长期会话里自然活动。' }] } } }, hiddenInternalItems: 0 },
            ] : [
              { seq: 52, event: { type: 'tool/call', data: { turn: 1, step: 3, tool: 'computer-use' } }, hiddenInternalItems: 0 },
              { seq: 57, event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '我先看看桌面状态。' }] } } }, hiddenInternalItems: 1 },
            ];
            return json({
              ok: true,
              sessionId: 'mock-desktop-agent-session',
              throughSeq: Number(url.searchParams.get('throughSeq')) || 57,
              beforeSeq: older ? Number(url.searchParams.get('beforeSeq')) : null,
              nextBeforeSeq: older ? null : 52,
              hasMore: !older,
              records,
            });
          }
          case '/api/socialV2/config': return json({ ok: true, config: state.v2 });
          case '/api/socialV2/tool-log': return json({ ok: true, entries: url.searchParams.get('failed') === '1' ? state.toolLog.filter(e => e.ok === false) : state.toolLog });
          case '/api/socialV2/feedback': return json({ ok: true, entries: state.feedback });
          case '/api/socialV2/states': return json({ ok: true, enabled: state.v2.enabled, lifecycle: state.desktopAgentStopped ? 'stopped' : 'active', conversations: state.buffers });
          // state/ 的 ACL 收紧结果：用离线示例值演示「未收紧」的告警条（Windows 上未提权时的真实情况）
          // 命令本身必须来自 `src/state-acl.mjs`，不能在这里另抄一份：这里曾经抄的是
          // `icacls DIR /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /T /C` —— 正是那句
          // 会把子文件 DACL 清空、让桥接读不到自己令牌的破坏性命令。示例数据是给人照抄的，
          // 抄错的那一版和真的那一版看起来一模一样。
          case '/api/security': return json({
            ok: true,
            stateDir: state.hardenStateDir
              ? { hardened: true, path: 'D:\\demo\\qq-bridge\\state', manualCommand: '' }
              : { hardened: false, path: 'D:\\demo\\qq-bridge\\state', manualCommand: manualDirCommand('D:\\demo\\qq-bridge\\state') }
          });
          // 令牌与花费：全部为离线示例数据，不含任何真实用量。
          case '/api/tokens/summary': return json(usage.summary());
          case '/api/tokens/series': return json(usage.series({hours:Number(url.searchParams.get('hours')) || 24}));
          case '/api/tokens/turns': return json(usage.conversation(url.searchParams.get('key')));
          case '/api/tokens/recent': return json({ ok: true, symbol:'$', legacySymbol:'¥', entries:usage.recent() });
        }
      }
      if (method === 'POST') {
        switch (path) {
          case '/api/learning/settings': state.learning = { ...state.learning, ...body }; return json({ ok: true, config: state.learning });
          case '/api/learning/run': return json({ ok: true, running: true });
          case '/api/learning/sticker-reviews': {
            const review = state.stickerReviews.find(r => r.id === body.id);
            if (!review) return json({ ok: false, error: '建议已处理' }, 400);
            if (body.accept) Object.assign(state.learnedStickers[0], review.after, { status: 'confirmed' });
            state.stickerReviews = state.stickerReviews.filter(r => r !== review);
            return json({ ok: true });
          }
          case '/api/stickers/sync': return json({ ok: true, total: 1 });
          case '/api/slang':
          case '/api/learning/stickers': {
            const list = path === '/api/slang' ? state.slang : state.learnedStickers;
            let entry = list.find(e => e.id === body.id);
            if (!entry) { entry = { id: `fixture-${list.length + 1}`, evidence: [], count: 0 }; list.push(entry); }
            Object.assign(entry, { ...body, id: entry.id });
            return json({ ok: true, entry });
          }
          case '/api/slang/delete': state.slang = state.slang.filter(e => e.id !== body.id); return json({ ok: true });
          case '/api/learning/stickers/delete': state.learnedStickers = state.learnedStickers.filter(e => e.id !== body.id); return json({ ok: true });
          case '/api/role': state.role = body.role; return json({ ok: true });
          case '/api/roles/create': {
            const content = body.content ?? '';
            state.roles.push(body.name);
            state.roleContents[body.name] = content;
            return json({ ok: true, role: body.name, chars: roleCharCount(content), estimatedTokens: estimateRoleTokens(content), warnings: roleWarnings(content) });
          }
          case '/api/roles/update': {
            const content = body.content ?? '';
            state.roleContents[body.name] = content;
            return json({ ok: true, role: body.name, chars: roleCharCount(content), estimatedTokens: estimateRoleTokens(content), warnings: roleWarnings(content) });
          }
          case '/api/roles/rename': {
            const idx = state.roles.indexOf(body.from);
            if (idx >= 0) state.roles[idx] = body.to;
            state.roleContents[body.to] = state.roleContents[body.from] ?? '';
            delete state.roleContents[body.from];
            if (state.role === body.from) state.role = body.to;
            return json({ ok: true, role: body.to, renamed: true, currentFollowed: state.role === body.to });
          }
          case '/api/roles/delete': {
            const idx = state.roles.indexOf(body.name);
            if (idx >= 0) state.roles.splice(idx, 1);
            delete state.roleContents[body.name];
            const cleared = state.role === body.name;
            if (cleared) state.role = null;
            return json({ ok: true, deleted: body.name, clearedCurrent: cleared });
          }
          case '/api/preset/desktop-agent-prompt/modules': {
            state.desktopPromptModules = normalizePresetPromptModules({ version: 1, modules: body.modules }).modules;
            const content = composePresetPromptModules({ version: 1, modules: state.desktopPromptModules });
            const unchanged = content === state.desktopPrompt;
            if (!unchanged) state.desktopPrompt = content;
            return json({ ok: true, unchanged, chars: content.length, content, modules: state.desktopPromptModules, warnings: [], synced: true, requiresRestart: !unchanged, status: presetStatusFixture() });
          }
          case '/api/desktop-agent/prompt-templates': {
            if (!body.templates || typeof body.templates !== 'object' || Array.isArray(body.templates)) {
              return json({ ok: false, error: '请提交完整的运行时提示模板' }, 400);
            }
            state.runtimePromptTemplates = normalizeDesktopAgentPromptTemplates(body.templates);
            return json({ ok: true, templates: state.runtimePromptTemplates, message: '已保存；后续对应的会话提示会使用新模板' });
          }
          case '/api/preset/desktop-agent-prompt': {
            return json({ ok: false, error: 'fixture uses the modular prompt API' }, 409);
          }
          case '/api/preset/desktop-agent-prompt/restore': {
            return json({ ok: true, restoredFrom: 'desktop-agent.agent.cordis.yml.fixture', requiresRestart: true });
          }
          case '/api/dsh/effort': state.dshEffort = body.reasoningEffort; return json({ ok: true, reasoningEffort: body.reasoningEffort });
          case '/api/whitelist': {
            if (body.ownerQQ !== undefined) {
              const value = String(body.ownerQQ ?? '').trim();
              if (value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
                return json({ ok: false, error: 'ownerQQ 必须是 QQ 号（正整数）' }, 400);
              }
              state.whitelist.ownerQQ = value ? Number(value) : null;
            }
            for (const name of ['allow', 'deny']) {
              if (!body[name]) continue;
              for (const kind of ['groups', 'private']) {
                if (!Array.isArray(body[name][kind])) continue;
                const values = body[name][kind];
                if (values.some((value) => !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
                  return json({ ok: false, error: `${name}.${kind}必须只包含正整数 QQ 号` }, 400);
                }
                state.whitelist[name][kind] = [...new Set(values.map(Number))];
              }
            }
            return json({ ok: true, ...state.whitelist });
          }
          case '/api/socialV2/config': state.v2 = qqChannelConfig(state.v2, body); return json({ ok: true, config: state.v2 });
          case '/api/memory/settings': {
            const { apiKey, clearApiKey, timeoutSeconds, ...values } = body;
            Object.assign(state.memorySettings, values, { timeoutMs: timeoutSeconds * 1000,
              apiKeyConfigured: !clearApiKey && (!!apiKey || state.memorySettings.apiKeyConfigured) });
            return json({ ok: true, settings: state.memorySettings });
          }
          case '/api/memory/providers': {
            for (const key of ['embedding', 'llm']) {
              const { apiKey, clearApiKey, ...values } = body[key];
              state.memoryProviders[key] = { ...values, configured: !!values.model && !!values.endpoint,
                apiKeyConfigured: !clearApiKey && (!!apiKey || state.memoryProviders[key].apiKeyConfigured) };
            }
            return json({ ok: true, restarted: true });
          }
          case '/api/memory/service': return json({ ok: true });
          case '/api/memory/search':
          case '/api/memory/records/list': {
            const rows = state.memoryRecords.filter(record => record.content.includes(body.query || '')
              && (!body.origin || body.origin === 'all' || body.origin === record.metadata.origin)
              && (!body.timeStart || record.observedAt >= body.timeStart) && (!body.timeEnd || record.observedAt <= body.timeEnd));
            const offset = Number(body.cursor || 0);
            const hits = rows.slice(offset, offset + body.limit);
            const nextCursor = offset + hits.length < rows.length ? String(offset + hits.length) : '';
            return json({ ok: true, result: { hits, total: rows.length, nextCursor } });
          }
          case '/api/memory/read': {
            const record = state.memoryRecords.find(row => row.memoryId === body.memoryId);
            return json({ ok: !!record, result: record, error: record ? undefined : '记忆记录不存在' });
          }
          case '/api/memory/delete':
          case '/api/memory/replace':
          case '/api/memory/save': {
            if (path !== '/api/memory/save') {
              const index = state.memoryRecords.findIndex(record => record.memoryId === body.memoryId);
              if (index < 0) return json({ ok: false, error: '记忆记录不存在' }, 404);
              state.memoryRecords.splice(index, 1);
            }
            if (path === '/api/memory/delete') return json({ ok: true });
            const memoryId = 'demo-memory-' + ++state.memorySequence;
            state.memoryRecords.unshift({ ...body, memoryId, metadata: { ...body.metadata, origin: body.origin },
              observedAt: body.observedAt || new Date().toISOString() });
            return json({ ok: true, result: { memoryId } });
          }
          case '/api/memory/organizer': {
            if (body.action === 'cleanup') return json({ ok: true, archived: [], skipped: [] });
            if (body.action === 'start') {
              const source = state.organizerSource;
              if (source.sessionId !== body.sessionId || source.asOfSeq <= source.lastScheduledSeq) return json({ ok: false, error: '没有可整理的范围' }, 400);
              const job = { jobId: 'demo-manual', kind: 'manual', sourceSessionId: source.sessionId, status: 'queued',
                createdAt: Date.now(), updatedAt: Date.now(), fromSeq: source.lastScheduledSeq, throughSeq: source.asOfSeq };
              state.organizerJobs.unshift(job);
              source.lastScheduledSeq = source.asOfSeq;
              return json({ ok: true, ...job });
            }
            const job = state.organizerJobs.find(item => item.jobId === body.jobId);
            if (body.action !== 'retry' || job?.status !== 'failed') return json({ ok: false, error: '没有可重试的任务' }, 404);
            job.status = 'queued';
            job.error = '';
            return json({ ok: true, job });
          }
          case '/api/socialV2/tool-log/clear': state.toolLog = []; return json({ ok: true });
          case '/api/socialV2/feedback-clear': state.feedback = []; return json({ ok: true });
          case '/api/socialV2/reset': state.buffers = []; return json({ ok: true });
          case '/api/security':
            if (body.rehardenStateDir === true) {
              // 离线演示：把「重新检测」当成一次成功的收紧（真实实现要管理员权限）
              state.hardenStateDir = true;
              return json({ ok: true, hardened: true, path: 'D:\\demo\\qq-bridge\\state' });
            }
            return json({ ok: false, error: '该安全设置已停用' }, 400);
          case '/api/console/token': return json({ ok: true, token: body.token || 'offline-demo-token-123456', generated: !body.token });
          case '/api/test-send': return json({ ok: true, message_id: 'mock-message-001' });
          case '/api/console/desktop-agent':
            state.desktopAgentStopped = false;
            return json({ ok: true, sessionId: 'mock-desktop-agent-session', turnStarted: true });
          case '/api/console/desktop-agent/stop':
            state.desktopAgentStopped = true;
            return json({ ok: true, stopped: true });
          case '/api/console/desktop-agent/reset':
            state.desktopAgentStopped = false;
            return json({ ok: true, sessionId: 'mock-desktop-agent-session', created: true });
          case '/api/restart': return json({ ok: true, message: '离线预览：已模拟重启，实际服务未改变。' });
          case '/api/tokens/prices/refresh': return json({ ok:true });
          case '/api/tokens/reset': usage.reset(); return json({ ok:true });
        }
      }
      unknownRequests.push({ method, path });
      return json({ ok: false, error: `Unimplemented fixture route: ${method} ${path}` }, 404);
    } catch (error) {
      json({ ok: false, error: error.message }, 500);
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  return { server, state, requests, unknownRequests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolveClose => server.close(() => { usage.close(); resolveClose(); })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => args.find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  const fixture = await startConsoleFixture({ port: Number(value('--port') || 4173), htmlPath: value('--html') ? resolve(value('--html')) : undefined, logWrites: true });
  console.log(`Offline console preview: ${fixture.url}\nAll data is synthetic; writes stay in memory.\nRecorded requests: ${fixture.url}/__fixture/requests`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
