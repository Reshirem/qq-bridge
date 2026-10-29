import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROLE_STATE_FILE = path.join(PROJECT_ROOT, 'state', 'current-role.json');
const ROLES_DIR = path.join(PROJECT_ROOT, 'roles');
const DEFAULT_ROLE_MAX_CHARS = 8000;
const MAX_ROLE_CHARS = 20000;
const MAX_ROLE_BYTES = 64 * 1024;
const DEFAULT_ROLE_CARD_TEMPLATE = '【当前角色卡：{roleName}】\n{roleContent}';
const ROLE_NAME_RE = /^[\w\u4e00-\u9fff-]{1,40}$/;

export const name = 'qq-agent-presets';
export const inject = ['settings', 'systemPrompt'];

export const Config = z.object({
  ownerQQ: z.string()
    .description('管理员身份标记 QQ（ownerQQ）；留空表示不覆盖 config.json')
    .extra('volatile', true),
});

function activeRoleCardForPrompt() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(ROLE_STATE_FILE, 'utf8'));
  } catch {
    return '';
  }

  const roleName = typeof state?.role === 'string' ? state.role : '';
  if (!roleName) return '';
  if (!ROLE_NAME_RE.test(roleName)) {
    return '【人格卡加载提示】当前选择的人格卡名称无效。请按通用陪伴者定位继续，不要臆造卡片内容。';
  }

  let content;
  try {
    const rolesRoot = fs.realpathSync(ROLES_DIR);
    const roleFile = fs.realpathSync(path.join(ROLES_DIR, `${roleName}.md`));
    const relative = path.relative(rolesRoot, roleFile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('role file escaped roles directory');
    const stat = fs.statSync(roleFile);
    if (!stat.isFile() || stat.size > MAX_ROLE_BYTES) throw new Error('role file is missing or oversized');
    content = fs.readFileSync(roleFile, 'utf8');
  } catch {
    return `【人格卡加载提示】当前选择了「${roleName}」，但没有安全可读的人格卡正文。请按通用陪伴者定位继续，不要臆造卡片内容。`;
  }

  const configuredLimit = state.maxInjectChars;
  const maxChars = Number.isFinite(configuredLimit)
    ? Math.min(MAX_ROLE_CHARS, Math.max(1000, Math.round(configuredLimit)))
    : DEFAULT_ROLE_MAX_CHARS;
  const truncated = content.length > maxChars;
  const promptContent = truncated ? content.slice(0, maxChars) : content;
  const template = typeof state.roleCardTemplate === 'string' && state.roleCardTemplate.includes('{roleContent}')
    ? state.roleCardTemplate
    : DEFAULT_ROLE_CARD_TEMPLATE;
  const formatted = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, token) => {
    if (token === 'roleName') return roleName;
    if (token === 'roleContent') return promptContent;
    return placeholder;
  });
  return truncated
    ? `${formatted}\n\n【人格卡长度提醒】仅提供了前 ${maxChars} 个字符；不要臆测被省略的内容。`
    : formatted;
}

export function apply(ctx) {
  // DSH evaluates this provider for every system-prompt assembly. The current
  // card therefore tracks bridge-side selection and edits without becoming a
  // compactable user-message event or requiring a session rebuild each time.
  ctx.systemPrompt.variable('qq_bridge_active_role_card', () => activeRoleCardForPrompt());
}
