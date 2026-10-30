import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROLE_STATE_FILE = path.join(PROJECT_ROOT, 'state', 'current-role.json');
const ROLES_DIR = path.join(PROJECT_ROOT, 'roles');
const DEFAULT_ROLE_CARD_TEMPLATE = '【当前角色卡：{roleName}】\n{roleContent}';
const ROLE_NAME_RE = /^[\w\u4e00-\u9fff-]{1,40}$/;

export const name = 'qq-agent-presets';
export const inject = ['settings', 'systemPrompt'];

export const Config = z.object({
  ownerQQ: z.string()
    .description('用于识别配置的 QQ 关系对象；关系称谓由人格卡决定。未设置时不注入账号标记，直接一对一会话按当前人格卡处理，不覆盖 config.json')
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
    return '【人格卡加载提示】当前选择的人格卡名称无效。请按通用数字角色定位继续，不要臆造卡片内容。';
  }

  let content;
  try {
    const rolesRoot = fs.realpathSync(ROLES_DIR);
    const roleFile = fs.realpathSync(path.join(ROLES_DIR, `${roleName}.md`));
    const relative = path.relative(rolesRoot, roleFile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('role file escaped roles directory');
    const stat = fs.statSync(roleFile);
    if (!stat.isFile()) throw new Error('role file is missing or unreadable');
    content = fs.readFileSync(roleFile, 'utf8');
  } catch {
    return `【人格卡加载提示】当前选择了「${roleName}」，但没有安全可读的人格卡正文。请按通用数字角色定位继续，不要臆造卡片内容。`;
  }

  const template = typeof state.roleCardTemplate === 'string'
    ? state.roleCardTemplate
    : DEFAULT_ROLE_CARD_TEMPLATE;
  const formatted = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, token) => {
    if (token === 'roleName') return roleName;
    if (token === 'roleContent') return content;
    return placeholder;
  });
  return formatted;
}

export function apply(ctx) {
  // DSH evaluates this provider for every system-prompt assembly. The current
  // card therefore tracks bridge-side selection and edits without becoming a
  // compactable user-message event or requiring a session rebuild each time.
  ctx.systemPrompt.variable('qq_bridge_active_role_card', () => activeRoleCardForPrompt());
}
