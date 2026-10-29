// A_Memorix tool facade for the persistent desktop-agent session.
// All persistence goes through qq-bridge and the configured A_Memorix Gateway;
// this process never opens or edits A_Memorix storage files directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function bridgeBaseUrl() {
  const port = Number(loadConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}

function readConsoleToken() {
  const configured = String(loadConfig().consoleToken ?? '').trim();
  if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

function readAgentToken() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'desktop-agent.json'), 'utf8'));
    const token = String(state?.agentToken ?? '').trim();
    if (/^[a-f0-9]{64}$/i.test(token)) return token;
  } catch {}
  throw new Error('桥接内部调用凭证尚未就绪');
}

async function memoryApi(operation, payload) {
  const headers = {
    'content-type': 'application/json',
    'x-agent-call': '1',
    'x-agent-token': readAgentToken(),
    ...(readConsoleToken() ? { 'x-console-token': readConsoleToken() } : {})
  };
  let response;
  try {
    response = await fetch(`${bridgeBaseUrl()}/api/desktop-agent/memory/${operation}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(125_000)
    });
  } catch (error) {
    throw new Error(`连接 qq-bridge 失败：${String(error?.message ?? error).slice(0, 300)}`);
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok || body?.ok === false) {
    throw new Error(String(body?.error || `qq-bridge HTTP ${response.status}`).slice(0, 700));
  }
  return body?.result ?? {};
}

function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function toolError(error) {
  return { content: [{ type: 'text', text: `长期记忆操作失败：${error?.message ?? error}` }], isError: true };
}

const server = new McpServer({ name: 'qq-bridge-memory', version: '1.0.0' });

server.tool(
  'memory_search',
  '按需检索 A_Memorix 长期记忆。来源可以筛选为 qq（从 QQ 对话中读到并判断值得保留的内容）或 assistant（陪伴者自身经历、发现与待办；assistant 是现有数据来源标记）；QQ 来源记忆只在需要时读取。',
  {
    query: z.string().max(2000).optional().describe('用于检索的自然语言问题或关键词；仅按时间检索时可省略'),
    limit: z.number().int().min(1).max(20).optional().describe('最多返回条数，默认 8'),
    origin: z.enum(['qq', 'assistant']).optional().describe('按来源筛选；省略时搜索两类来源'),
    mode: z.enum(['SEARCH_MODE_SEARCH', 'SEARCH_MODE_TIME', 'SEARCH_MODE_HYBRID']).optional().describe('检索方式：无时间范围的普通内容检索默认 SEARCH_MODE_SEARCH；SEARCH_MODE_TIME 和 SEARCH_MODE_HYBRID 必须至少提供 timeStart 或 timeEnd，前者按时间检索，后者结合关键词与时间范围'),
    timeStart: z.string().optional().describe('可选 ISO 起始时间'),
    timeEnd: z.string().optional().describe('可选 ISO 结束时间')
  },
  async (args) => {
    try { return toolResult(await memoryApi('search', args)); } catch (error) { return toolError(error); }
  }
);

server.tool(
  'memory_save',
  '将值得长期保留的信息写入共享记忆。只有模型自己读到 QQ 内容并判断有保存价值后才标记 origin=qq；陪伴者自身的经历、发现和未完成事项使用现有数据标记 origin=assistant。标明来源，不把未经核实的他人说法写成已验证事实。',
  {
    content: z.string().min(1).max(20000).describe('要保存的记忆，尽量写清来源、时间、背景与确定程度'),
    origin: z.enum(['qq', 'assistant']).default('assistant').describe('来源类别：qq 或 assistant'),
    tags: z.array(z.string().max(80)).max(20).optional().describe('可选检索标签'),
    participants: z.array(z.string().max(120)).max(20).optional().describe('可选涉及的人或主体'),
    observedAt: z.string().optional().describe('可选 ISO 观察时间'),
    sourceContext: z.string().max(2000).optional().describe('可选来源上下文，例如 QQ 群/私聊、任务、说话人；不要加入无关的敏感信息'),
    confidence: z.enum(['firsthand', 'reported', 'inferred', 'uncertain']).optional().describe('可选可信程度：亲自观察、他人陈述、推断或不确定'),
    evidenceReferences: z.array(z.string().max(300)).max(20).optional().describe('可选证据引用，例如消息 ID、会话 ID、任务记录标题')
  },
  async (args) => {
    try {
      const { sourceContext, confidence, evidenceReferences, ...memory } = args;
      const metadata = {
        ...(sourceContext ? { sourceContext } : {}),
        ...(confidence ? { confidence } : {}),
        ...(evidenceReferences?.length ? { evidenceReferences } : {})
      };
      return toolResult(await memoryApi('save', { ...memory, metadata }));
    } catch (error) { return toolError(error); }
  }
);

server.tool(
  'memory_read',
  '读取指定长期记忆的完整内容和来源信息。memoryId 通常来自 memory_search。',
  { memoryId: z.string().min(1).max(300).describe('A_Memorix 返回的 memoryId') },
  async (args) => {
    try { return toolResult(await memoryApi('read', args)); } catch (error) { return toolError(error); }
  }
);

server.tool(
  'memory_forget',
  '从长期记忆中删除指定记录。此操作会删除记忆，不可恢复；先确认 memoryId 指向的是要删除的记录。',
  {
    memoryId: z.string().min(1).max(300).describe('要删除的 A_Memorix memoryId'),
    reason: z.string().max(500).optional().describe('删除原因')
  },
  async (args) => {
    try { return toolResult(await memoryApi('forget', args)); } catch (error) { return toolError(error); }
  }
);

await server.connect(new StdioServerTransport());
