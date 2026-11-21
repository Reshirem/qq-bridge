import { z } from 'zod';
import { bridgeBaseUrl, readConsoleToken, registerMemoryTools } from '../../src/mcp-memory-safe.js';
import { MEMORY_ORGANIZER_SYSTEM_PROMPT } from '../../src/memory-organizer.js';
import { LEARNING_SYSTEM_PROMPT } from '../../src/chat-learning.js';
import { MARKET_ANALYSIS_PROMPT } from '../../src/market-analysis.js';
import { apply as memoryGuard } from '../../src/memory-organizer-tool-guard.mjs';
import { apply as learningGuard } from '../../src/learning-tool-guard.mjs';

export const inject = ['tools', 'systemPrompt', 'commands', 'llm'];
const prompts = { memory: MEMORY_ORGANIZER_SYSTEM_PROMPT, chat: LEARNING_SYSTEM_PROMPT, market: MARKET_ANALYSIS_PROMPT };

async function imagesForExecution(sessionId, page, signal) {
  if (!sessionId) throw new Error('缺少学习会话身份');
  const response = await fetch(`${bridgeBaseUrl()}/api/learning/session-images`, {
    method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json', 'x-console-token': readConsoleToken() },
    body: JSON.stringify({ sessionId, page }),
  });
  if (!response.ok) throw new Error('本会话没有可读取的学习图片页');
  return response.json();
}

export function apply(ctx, { kind }) {
  if (!Object.hasOwn(prompts, kind)) throw new Error('未知的后台 preset');
  const imageTool = 'mcp__qq-learning-images__learning_images';
  const allowed = [];
  // Preset definitions live in a parent scope. Restrict the concrete agent so
  // its whitelist includes these inherited definitions and excludes Host tools.
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: allowed }); });
  ctx.systemPrompt.variable('qq_background_prompt', () => prompts[kind]);
  // The Host's session/selectModel also saves the global default. A preset
  // command selects only this agent's route and never submits a model turn.
  ctx.commands.register({
    name: 'qq-background-model', description: '设置当前后台任务的模型', recordInput: false,
    async handler({ agent, rawInput }) {
      const selection = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() }).parse(JSON.parse(rawInput));
      await ctx.llm.resolveCallConfig(selection);
      agent.model.select(selection);
      return { kind: 'success' };
    },
  });
  if (kind === 'memory') {
    memoryGuard(ctx);
    registerMemoryTools((name, description, fields, invoke) => {
      const schema = z.object(fields);
      allowed.push('mcp__qq-memory-organizer__' + name);
      ctx.tools.register({
        name: 'mcp__qq-memory-organizer__' + name, description, timeoutMs: 150000,
        parameters: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute(input, exec) {
          if (!exec.agent?.id) throw new Error('缺少整理会话身份');
          const result = await invoke(schema.parse(input), exec.agent.id);
          const text = result.content[0].text;
          if (result.isError) throw new Error(text);
          return text;
        },
      });
    }, true);
    return;
  }
  learningGuard(ctx);
  allowed.push(imageTool);
  const market = kind === 'market';
  ctx.tools.register({
    name: imageTool,
    description: market ? '按页查看本包表情，页码从 1 开始。' : '查看本次聊天学习批次的图片。',
    parameters: { type: 'object', properties: market ? { page: { type: 'integer', minimum: 1 } } : {},
      required: market ? ['page'] : [], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => value.content },
    async execute(input, exec) {
      const { images, page } = await imagesForExecution(exec.agent?.id, market ? input.page : 1, exec.signal);
      const attachments = ctx.get('attachments');
      if (!attachments || !images.length) throw new Error('本批没有可提交给 DSH 的图片');
      const content = market ? [{ type: 'text', text: 'QQ_PACK_PAGE=' + page }] : [];
      for (const image of images) {
        const attachment = await attachments.saveImage({ data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType, name: 'sticker' });
        content.push({ type: 'text', text: JSON.stringify({ id: image.id, evidence: image.evidence, note: image.note }) },
          { type: 'image', attachment });
      }
      return { content };
    },
  });
}
