export const name = 'qq-memory-curator-tool-guard';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => '旧记忆回顾只分析本批原文，不执行工具');
}
