import z from '@deepseek-ai/schemastery';

export const name = 'qq-agent-presets';
export const inject = ['settings'];

export const Config = z.object({
  ownerQQ: z.string()
    .description('管理员 QQ（ownerQQ）；留空表示不覆盖 config.json')
    .extra('volatile', true),
});

export function apply() {}
