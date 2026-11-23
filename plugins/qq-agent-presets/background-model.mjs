import { z } from 'zod';

export function registerBackgroundModel(ctx) {
  // The Host's session/selectModel also saves the global default. Select only this agent's route.
  ctx.commands.register({
    name: 'qq-background-model', description: '设置当前后台任务的模型', recordInput: false,
    async handler({ agent, rawInput }) {
      const selection = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() }).parse(JSON.parse(rawInput));
      await ctx.llm.resolveCallConfig(selection);
      agent.model.select(selection);
      return { kind: 'success' };
    },
  });
}
