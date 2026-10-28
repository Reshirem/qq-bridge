#!/usr/bin/env node
/** Offline console preview. No production modules, credentials, state, or network clients are loaded. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleCharStats, roleSectionReport } from '../src/role-card.js';
import { pickBucketMs } from '../src/token-ledger.js';
import { manualDirCommand } from '../src/state-acl.mjs';
import { composePresetPromptModules, normalizePresetPromptModules, PRESET_PROMPT_MODULE_DEFINITIONS } from '../src/preset-prompt.js';
import { DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS, normalizeDesktopAgentPromptTemplates } from '../src/desktop-agent-prompt-templates.js';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timestamp = '2026-09-20T08:30:00.000Z';

// 预设状态：离线 UI 只模拟唯一的全局 desktop-agent。
function presetStatusFixture() {
  return {
    preset: 'desktop-agent',
    label: '全局陪伴者',
    sourceFile: 'dsh/agent-presets/desktop-agent/agent.cordis.yml',
    installed: true,
    requiresRestart: true,
  };
}

// ── 令牌与花费：离线示例数据 ──────────────────────────────────────────────
// 字段口径与 src/token-ledger.js 的 summary()/conversation()/recent() 保持一致，
// 这样控制台渲染路径在离线预览与真实环境走的是同一套形状。
const USAGE_SYMBOL = '¥';
const USAGE_PRICE_TABLE = {
  version: '2026-11-04',
  currency: 'CNY',
  symbol: USAGE_SYMBOL,
  unit: 1e6,
  peakMultiplier: 2,
  peakWindows: [[9, 12], [14, 18]],
  peakWeekdays: [1, 2, 3, 4, 5],
  holidayCount: 33,
  models: {
    'deepseek-flash': { label: 'DeepSeek-V4.1-Flash', off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 } },
    'deepseek-v4-pro': { label: 'DeepSeek-V4-Pro-0813', off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 } },
  },
};

function usageConversationFixture(key, buckets, cost, turns, steps, unattributed = 0) {
  const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  return {
    key,
    sessionIds: [`fixture-session-${key.replace(/\W/g, '')}`],
    sessions: 1,
    buckets,
    cost,
    unattributedCost: unattributed,
    attributedCost: cost - unattributed,
    byTier: { peak: cost * 0.4, off: cost * 0.6 },
    turns,
    steps,
    estimated: false,
    lastAt: Date.parse(timestamp),
    firstAt: Date.parse(timestamp) - 3600_000,
    models: ['deepseek-flash'],
    cacheHitRate: input > 0 ? buckets.cacheHit / input : 0,
  };
}

function usageSummaryFixture() {
  const conversations = [
    usageConversationFixture('group:123456789', { cacheMiss: 41230, cacheHit: 1284000, cacheWrite: 0, output: 18420, reasoning: 0 }, 0.2886, 42, 231),
    usageConversationFixture('private:100001', { cacheMiss: 8600, cacheHit: 210400, cacheWrite: 0, output: 3900, reasoning: 0 }, 0.0467, 9, 48),
  ];
  const buckets = conversations.reduce((acc, c) => ({
    cacheMiss: acc.cacheMiss + c.buckets.cacheMiss,
    cacheHit: acc.cacheHit + c.buckets.cacheHit,
    cacheWrite: acc.cacheWrite + c.buckets.cacheWrite,
    output: acc.output + c.buckets.output,
    reasoning: 0,
  }), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  const cost = conversations.reduce((acc, c) => acc + c.cost, 0);
  const input = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;
  const turns = conversations.reduce((acc, c) => acc + c.turns, 0);
  const steps = conversations.reduce((acc, c) => acc + c.steps, 0);
  return {
    ok: true,
    generatedAt: Date.parse(timestamp),
    priceVersion: USAGE_PRICE_TABLE.version,
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    nowTier: { model: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', tier: 'off', tierLabel: '空闲时段', estimated: false },
    priceTable: USAGE_PRICE_TABLE,
    totals: {
      buckets,
      cost,
      attributedCost: cost - 0.02,
      unattributedCost: 0.02,
      byTier: { peak: cost * 0.4, off: cost * 0.6 },
      turns,
      steps,
      conversations: conversations.length,
      estimated: false,
      totalTokens: buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite + buckets.output,
      inputTokens: input,
      cacheHitRate: input > 0 ? buckets.cacheHit / input : 0,
      avgCostPerTurn: cost / turns,
      avgCostPerStep: cost / steps,
    },
    conversations,
    ledger: { file: '(fixture)', journalLines: 0, maxLines: 20000, droppedLines: 0, sessions: 3, baselines: 3, samples: steps, lastIngestAt: Date.parse(timestamp), lastCompactedAt: 0, priceVersion: USAGE_PRICE_TABLE.version },
  };
}

// 走势图示例数据：24 小时 × 30 分钟 = 48 格，故意留出空白时段。
// 峰谷档位按**真实规则**推算（周一至周五 9:00-12:00、14:00-18:00 为高峰），
// 这样示例图看起来和真实使用一致（两条高峰带），而不是人为交替的噪点。
function usageSeriesFixture(hoursRaw) {
  const hours = [24, 72, 168, 720].includes(Number(hoursRaw)) ? Number(hoursRaw) : 24;
  // 桶宽用**生产同一套阶梯**（从 token-ledger 导出），避免预览与线上粒度不一致。
  const bucketMs = pickBucketMs(hours * 3600 * 1000, 48);
  // 走势图的锚点固定在一个**工作日**：fixture 的 timestamp 落在周日，按真实峰谷规则
  // 算出来整条图都是空闲色，示例数据就永远看不到高峰带（离线预览也就失去意义）。
  // 锚点固定也让截图/断言可复现。
  const anchor = Date.parse('2026-09-16T08:30:00.000Z'); // 周三
  const end = Math.floor(anchor / bucketMs) * bucketMs + bucketMs;
  const start = end - Math.ceil((hours * 3600 * 1000) / bucketMs) * bucketMs;
  const count = Math.round((end - start) / bucketMs);
  const isPeakHour = (ms) => {
    const d = new Date(ms);
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const h = d.getHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  };
  // 档位要**扫完整个桶**，不能只看首尾：12 小时的桶完全可能把 9:00-12:00 整段包在
  // 中间，而两端都在空闲区（首尾采样法会把它误判成「空闲」）。
  const tierOfBucket = (t) => {
    let sawPeak = false;
    let sawOff = false;
    for (let ms = t; ms < t + bucketMs; ms += Math.min(bucketMs, 30 * 60 * 1000)) {
      if (isPeakHour(ms)) sawPeak = true; else sawOff = true;
      if (sawPeak && sawOff) return 'mixed';
    }
    return sawPeak ? 'peak' : 'off';
  };
  const buckets = [];
  // 桶内按 30 分钟小格累加，而不是"只看桶起点那一小时"：
  // 粗桶（如 24 小时）起点可能落在深夜，只看起点会让整条 30 天视图全是 0。
  // 累加也更接近真账本的行为（一个桶 = 该时段所有采样之和）。
  const subStepMs = Math.min(bucketMs, 30 * 60 * 1000);
  for (let i = 0; i < count; i += 1) {
    const t = start + i * bucketMs;
    let cacheMiss = 0;
    let cacheHit = 0;
    let output = 0;
    let cost = 0;
    let turns = 0;
    let steps = 0;
    for (let ms = t; ms < t + bucketMs; ms += subStepMs) {
      const hour = new Date(ms).getHours();
      if (hour < 9 || hour > 23) continue; // 深夜为 0，图上有明显的空白段
      const wave = (Math.sin((ms - start) / (3 * subStepMs)) + 1) / 2;
      const cm = Math.round(300 + wave * 1800);
      const ch = Math.round(6000 + wave * 42000);
      const out = Math.round(60 + wave * 400);
      const sub = (cm / 1e6) * 1 + (ch / 1e6) * 0.02 + (out / 1e6) * 4;
      cacheMiss += cm;
      cacheHit += ch;
      output += out;
      cost += isPeakHour(ms) ? sub * 2 : sub; // 高峰单价 ×2，逐格判定
      turns += 1;
      steps += 3 + (Math.floor(ms / subStepMs) % 5);
    }
    buckets.push({
      t,
      cost,
      tokens: cacheMiss + cacheHit + output,
      cacheMiss,
      cacheHit,
      cacheWrite: 0,
      output,
      turns,
      steps,
      tier: tierOfBucket(t),
      keys: steps > 0 ? ['group:123456789'] : [],
    });
  }
  const totals = buckets.reduce((acc, b) => ({
    cost: acc.cost + b.cost,
    tokens: acc.tokens + b.tokens,
    turns: acc.turns + b.turns,
    steps: acc.steps + b.steps,
  }), { cost: 0, tokens: 0, turns: 0, steps: 0 });
  const busiest = buckets.reduce((best, b) => (!best || b.cost > best.cost ? b : best), null);
  return {
    ok: true,
    generatedAt: Date.parse(timestamp),
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    hours,
    bucketMs,
    from: start,
    to: end,
    buckets,
    totals,
    busiest: busiest ? { t: busiest.t, cost: busiest.cost, tokens: busiest.tokens } : null,
    estimated: false,
    countedSamples: buckets.reduce((n, b) => n + b.steps, 0),
    offChartCost: 0.02,
    offChartTokens: 18000,
  };
}

function usageTurnsFixture(key) {
  const target = key || 'group:123456789';
  const base = Date.parse(timestamp);
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    const buckets = { cacheMiss: 900 + i * 120, cacheHit: 32000 + i * 800, cacheWrite: 0, output: 420 + i * 30, reasoning: 0 };
    rows.push({
      sessionId: `fixture-session-${target.replace(/\W/g, '')}`,
      key: target,
      turn: 42 - i,
      steps: 4 + (i % 3),
      attempts: i === 2 ? 1 : 0,
      startedAt: base - (i + 1) * 600_000,
      endedAt: base - i * 600_000,
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      buckets,
      cost: (buckets.cacheMiss / 1e6) * 1 + (buckets.cacheHit / 1e6) * 0.02 + (buckets.output / 1e6) * 4,
      tier: i === 1 ? 'peak' : (i === 4 ? 'mixed' : 'off'),
    });
  }
  const cost = rows.reduce((acc, t) => acc + t.cost, 0);
  return {
    ok: true,
    generatedAt: base,
    currency: 'CNY',
    symbol: USAGE_SYMBOL,
    key: target,
    sessionIds: [`fixture-session-${target.replace(/\W/g, '')}`],
    sessions: 1,
    steps: rows.reduce((acc, t) => acc + t.steps, 0),
    cost,
    attributedCost: cost,
    unattributedCost: 0.0123,
    buckets: rows.reduce((acc, t) => ({
      cacheMiss: acc.cacheMiss + t.buckets.cacheMiss,
      cacheHit: acc.cacheHit + t.buckets.cacheHit,
      cacheWrite: 0,
      output: acc.output + t.buckets.output,
      reasoning: 0,
    }), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 }),
    byTier: { peak: cost * 0.3, off: cost * 0.7 },
    estimated: false,
    models: ['deepseek-flash'],
    turnLimit: 200,
    // 与 src/token-ledger.js 的 conversation() 一致：`turns` 是**数组**（不是条数）。
    turns: rows,
  };
}

function usageRecentFixture() {
  const base = Date.parse(timestamp);
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push({
      time: base - i * 45_000,
      key: i % 3 === 2 ? 'private:100001' : 'group:123456789',
      sessionId: 'fixture-session',
      turn: 42 - Math.floor(i / 4),
      step: 1 + (i % 4),
      retry: 0,
      model: 'deepseek-flash',
      tokens: 34000 + i * 500,
      cacheMiss: 820 + i * 40,
      cacheHit: 33000 + i * 400,
      cacheWrite: 0,
      output: 260 + i * 12,
      reasoning: 0,
      cost: 0.0021 + i * 0.0001,
      tier: i === 3 ? 'peak' : 'off',
      estimated: false,
    });
  }
  return rows;
}

export function makeFixtureState() {
  const promptContent = {
    identity: '你是用户长期相处的自主陪伴者；人格卡定义你的具体身份和形态，可以采用非人设定。',
  };
  const desktopPromptModules = PRESET_PROMPT_MODULE_DEFINITIONS.map((definition) => ({
    ...definition,
    enabled: true,
    content: promptContent[definition.id] || `离线演示模块：${definition.title}。`,
  }));
  return {
    role: '小鲸鱼', activityPaused: false, desktopAgentStopped: false,
    roles: ['小鲸鱼', '温柔助手', '技术伙伴'],
    roleContents: {
      小鲸鱼: '# 小鲸鱼\n\n- 性格：好奇、爱接梗，遇到不懂的会直接问\n- 说话风格：简短，偶尔用 emoji',
      温柔助手: '# 温柔助手\n\n- 性格：温和、有耐心\n- 说话风格：先共情再回答',
      技术伙伴: '# 技术伙伴\n\n- 性格：直接、爱讲原理\n- 说话风格：先给结论再解释',
    },
    desktopPrompt: composePresetPromptModules({ version: 1, modules: desktopPromptModules }),
    desktopPromptModules,
    runtimePromptTemplates: normalizeDesktopAgentPromptTemplates(DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS),
    roleInjectMax: 8000,
    dshEffort: 'max',
    whitelist: { allow: { groups: [123456789, 100003], private: [100001] }, deny: { groups: [], private: [] }, ownerQQ: '100001' },
    v2: {
      enabled: true,
      attentionKeywords: ['看看这个'],
      send: { burstEnabled: true, burstMaxMessages: 8, burstIntervalMinMs: 1000, burstIntervalMaxMs: 3000, longGapProbability: 0.2, longGapMinMs: 5000, longGapMaxMs: 10000, maxSendPerMinute: 8, maxSendPerHour: 60, maxMessageChars: 500, maxGapMs: 10000, gapBaseMs: 800, gapPerCharMs: 20, recommendedHint: '单条消息保持完整，避免连续刷屏。' },
      wait: { defaultMs: 30000, minMs: 5000, maxMs: 600000, defaultQuietMs: 8000, minQuietAfterNewMs: 10000 },
      sticker: { enabled: true, syncTtlMs: 60000, maxListCount: 100, collect: { enabled: true, maxPerMinute: 2, maxPerHour: 10 } },
      context: { recentLimit: 100, unreadLimit: 30, contextWindow: 20 },
      feedback: { maxLength: 500, notifyOwnerOnError: false },
    },
    security: { interceptNotify: true },
    hardenStateDir: false,
    toolLog: [
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_unread_messages', type: 'call', args: JSON.stringify({ key: 'group:123456789', limit: 20 }) },
      { time: timestamp, key: 'group:123456789', tool: 'qq_get_unread_messages', type: 'result', ok: true },
    ],
    feedback: [{ time: timestamp, level: 'info', message: '这是离线演示反馈。' }],
  };
}

/** Bind only to loopback. Mutations affect this server's disposable in-memory state. */
export async function startConsoleFixture({ port = 0, htmlPath, logWrites = false } = {}) {
  const file = htmlPath || resolve(projectRoot, 'public/console.html');
  await readFile(file); // Fail early rather than displaying a broken preview.
  const state = makeFixtureState();
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
        res.end(await readFile(file));
        return;
      }
      if (method === 'GET' && ['/console.css', '/console.js'].includes(path)) {
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
          case '/api/status': return json({ ok: true, dshReady: true, role: state.role, ownerQQ: state.whitelist.ownerQQ, allowGroups: state.whitelist.allow.groups, allowPrivate: state.whitelist.allow.private, activity: '[08:30:00] 演示桥接已连接\n[08:30:12] desktop-agent 自主会话已就绪\n以上均为离线模拟数据。' });
          case '/api/roles': return json({
            roles: state.roles.slice(),
            summaries: state.roles.map((name) => {
              const content = state.roleContents[name] ?? '';
              const stats = roleCharStats(content);
              const injectMax = state.roleInjectMax;
              return {
                name,
                bytes: Buffer.byteLength(content, 'utf8'),
                chars: content.length,
                lines: content.split('\n').length,
                mtime: Date.parse(timestamp),
                excerpt: content.split('\n').find((line) => line.trim() && !line.trim().startsWith('#')) ?? '',
                injectedV1: Math.min(stats.v1, injectMax),
                injectedV2: Math.min(stats.v2, injectMax),
                charsV1: stats.v1,
                charsV2: stats.v2,
                hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
                truncated: stats.v1 > injectMax || stats.v2 > injectMax,
                warnings: 0,
              };
            }),
            current: state.role,
            limits: { nameMax: 40, contentMaxBytes: 65536, injectMaxChars: state.roleInjectMax },
          });
          case '/api/roles/content': {
            const name = url.searchParams.get('name') ?? '';
            if (!state.roleContents[name]) return json({ ok: false, error: `人格「${name}」不存在` }, 404);
            const content = state.roleContents[name];
            return json({
              ok: true,
              name,
              content,
              chars: content.length,
              bytes: Buffer.byteLength(content, 'utf8'),
              warnings: [],
              limits: { injectMaxChars: state.roleInjectMax },
              stats: roleCharStats(content),
              sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
            });
          }
          case '/api/preset/desktop-agent-prompt/modules': {
            const content = composePresetPromptModules({ version: 1, modules: state.desktopPromptModules });
            return json({ ok: true, modules: state.desktopPromptModules, content, chars: content.length, warnings: [], migrated: false, status: presetStatusFixture() });
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
          case '/api/socialV2/activity': return json({ ok: true, paused: state.activityPaused });
          case '/api/socialV2/tool-log': return json({ ok: true, entries: state.toolLog });
          case '/api/socialV2/feedback': return json({ ok: true, entries: state.feedback });
          case '/api/socialV2/states': return json({ ok: true, conversations: [
            { key: 'group:123456789', bufferedCount: 3 },
            { key: 'private:100001', bufferedCount: 1 },
          ] });
          // state/ 的 ACL 收紧结果：用离线示例值演示「未收紧」的告警条（Windows 上未提权时的真实情况）
          // 命令本身必须来自 `src/state-acl.mjs`，不能在这里另抄一份：这里曾经抄的是
          // `icacls DIR /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /T /C` —— 正是那句
          // 会把子文件 DACL 清空、让桥接读不到自己令牌的破坏性命令。示例数据是给人照抄的，
          // 抄错的那一版和真的那一版看起来一模一样。
          case '/api/security': return json({
            ok: true,
            security: state.security,
            stateDir: state.hardenStateDir
              ? { hardened: true, path: 'D:\\demo\\qq-bridge\\state', manualCommand: '' }
              : { hardened: false, path: 'D:\\demo\\qq-bridge\\state', manualCommand: manualDirCommand('D:\\demo\\qq-bridge\\state') }
          });
          // 令牌与花费：全部为离线示例数据，不含任何真实用量。
          case '/api/tokens/summary': return json(usageSummaryFixture());
          case '/api/tokens/series': return json(usageSeriesFixture(url.searchParams.get('hours')));
          case '/api/tokens/turns': return json(usageTurnsFixture(url.searchParams.get('key')));
          case '/api/tokens/recent': return json({ ok: true, symbol: '¥', entries: usageRecentFixture() });
        }
      }
      if (method === 'POST') {
        switch (path) {
          case '/api/role': state.role = body.role; return json({ ok: true });
          case '/api/roles/create': state.roles.push(body.name); state.roleContents[body.name] = body.content ?? ''; return json({ ok: true, role: body.name, warnings: [] });
          case '/api/roles/update': state.roleContents[body.name] = body.content ?? ''; return json({ ok: true, role: body.name, chars: String(body.content ?? '').length, warnings: [] });
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
          case '/api/roles/limit': state.roleInjectMax = Number(body.maxInjectChars) || state.roleInjectMax; return json({ ok: true, maxInjectChars: state.roleInjectMax, limits: { injectMaxChars: state.roleInjectMax } });
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
          case '/api/whitelist': state.whitelist = body; return json({ ok: true });
          case '/api/socialV2/config': state.v2 = body; return json({ ok: true });
          case '/api/socialV2/activity': state.activityPaused = body.paused; return json({ ok: true });
          case '/api/socialV2/tool-log/clear': state.toolLog = []; return json({ ok: true });
          case '/api/socialV2/feedback-clear': state.feedback = []; return json({ ok: true });
          case '/api/socialV2/reset': return json({ ok: true });
          case '/api/security':
            if (body.rehardenStateDir === true) {
              // 离线演示：把「重新检测」当成一次成功的收紧（真实实现要管理员权限）
              state.hardenStateDir = true;
              return json({ ok: true, hardened: true, path: 'D:\\demo\\qq-bridge\\state' });
            }
            state.security = body;
            return json({ ok: true });
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
          case '/api/tokens/reset': return json({ ok: true });
        }
      }
      unknownRequests.push({ method, path });
      return json({ ok: false, error: `Unimplemented fixture route: ${method} ${path}` }, 404);
    } catch (error) {
      json({ ok: false, error: error.message }, 500);
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  return { server, state, requests, unknownRequests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => args.find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  const fixture = await startConsoleFixture({ port: Number(value('--port') || 4173), htmlPath: value('--html') ? resolve(value('--html')) : undefined, logWrites: true });
  console.log(`Offline console preview: ${fixture.url}\nAll data is synthetic; writes stay in memory.\nRecorded requests: ${fixture.url}/__fixture/requests`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
