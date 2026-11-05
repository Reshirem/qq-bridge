// Fail closed even when a user's headless profile happens to mount other tools.
export const name = 'qq-learning-tool-guard';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.guard(exec => exec?.name === 'mcp__qq-learning-images__learning_images'
    ? undefined : '后台学习仅允许读取本批图片，不能调用其他工具');
}
