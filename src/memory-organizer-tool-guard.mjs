// Fail closed even if a customized headless profile mounts additional tools.
export const name = 'qq-memory-organizer-tool-guard';
export const inject = ['tools'];
const ALLOWED = new Set(['memory_search', 'memory_save', 'memory_read', 'memory_replace', 'memory_forget']
  .map(name => `mcp__qq-memory-organizer__${name}`));
export function apply(ctx) {
  ctx.tools.guard(exec => ALLOWED.has(exec?.name)
    ? undefined : '记忆整理仅允许本任务的记忆工具，不能调用其他工具');
}
