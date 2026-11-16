// Owned QQ registrations for DSH 0.2.2+'s manager. The manager owns the child
// lifecycle, reconnect policy and cleanup; disposing this plugin withdraws its
// registration through Cordis's service effect scope.
import z from '@deepseek-ai/schemastery';

export const name = 'qq-managed-mcp';
export const inject = ['mcpManager'];
export const Config = z.object({
  serverName: z.union(['qq', 'qq-memory']).required(),
  transport: z.const('stdio').default('stdio'),
  command: z.string().required(),
  args: z.array(String).default([]),
  toolCallTimeoutMs: z.number().min(1).required(),
});

export function apply(ctx, config) {
  // Keep this boundary explicit even when called without Cordis validation.
  if (!['qq', 'qq-memory'].includes(config.serverName) || config.transport !== 'stdio') {
    throw new Error('QQ managed MCP only supports qq / qq-memory over stdio');
  }
  ctx.mcpManager.register(config.serverName, {
    transport: 'stdio', command: config.command, args: [...config.args],
    toolCallTimeoutMs: config.toolCallTimeoutMs,
  });
}
