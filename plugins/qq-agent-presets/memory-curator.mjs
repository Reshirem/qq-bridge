import { CURATOR_PROMPT } from '../../src/memory-curator.js';
import { registerBackgroundModel } from './background-model.mjs';

export const inject = ['tools', 'systemPrompt', 'commands', 'llm'];

export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ allow: [] }); });
  ctx.tools.guard(() => '旧记忆回顾只分析本批原文，不执行工具');
  ctx.systemPrompt.variable('qq_background_prompt', () => CURATOR_PROMPT);
  registerBackgroundModel(ctx);
}
