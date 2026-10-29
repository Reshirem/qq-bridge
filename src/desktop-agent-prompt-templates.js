// Bridge-generated prompt fragments appended to desktop-agent session.prompt messages.
// Keep these separate from the DSH preset prefix: they are runtime context templates.

export const DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS = Object.freeze({
  roleCard: '【当前角色卡：{roleName}】\n{roleContent}',
  qqAttention: '【QQ 提醒】\n有以下 QQ 来源触发了提醒。这里只附来源信息，不含消息正文；你可以结合正在做的事，决定是否查看、回应或稍后再看。\n{sources}',
  qqSource: '- {key}（{kind}，提醒原因：{reason}，发送者：{sender}{senderId}{messageId}{count}）',
  restExpired: '【休息结束】休息时间到了。先留意当前情况，再按自己的兴趣和判断决定下一步。',
  qqWake: '【休息被 QQ 提醒提前结束】',
  recovery: '【状态恢复检查】桥接需要重新确认会话状态。先查看当前会话和已有操作，避免重复已完成的事，再按当前情况继续。',
  memoryBootstrap: '【长期记忆摘要｜来源为自身经历；用于延续经历与未完成事项，仍需按当前上下文判断】\n{entries}',
});

export const DESKTOP_AGENT_PROMPT_TEMPLATE_FIELDS = Object.freeze({
  roleCard: {
    label: 'persona 前缀人格卡模板',
    description: '用于格式化动态加入 DSH persona 固定前缀的当前人格卡。必须保留 {roleContent}；{roleName} 可按需省略。修改后在下一次 DSH 提示词组装时生效。',
    tokens: ['roleName', 'roleContent'],
    requiredTokens: ['roleContent'],
  },
  qqAttention: {
    label: 'QQ 消息提醒模板',
    description: '有 QQ 来源提醒时使用。必须保留 {sources}，正文不会被放进提醒。',
    tokens: ['sources'],
    requiredTokens: ['sources'],
  },
  qqSource: {
    label: 'QQ 来源信息行模板',
    description: '每个提醒来源生成一行；{senderId}、{messageId} 和 {count} 在无对应信息时为空。',
    tokens: ['key', 'kind', 'reason', 'sender', 'senderId', 'messageId', 'count'],
    requiredTokens: ['key', 'reason'],
  },
  restExpired: {
    label: '休息到期提示',
    description: '陪伴者主动休息时间结束时使用；可留空。',
    tokens: [],
    requiredTokens: [],
    allowEmpty: true,
  },
  qqWake: {
    label: 'QQ 提前结束休息提示',
    description: 'QQ 提醒提前结束休息时使用；可留空。',
    tokens: [],
    requiredTokens: [],
    allowEmpty: true,
  },
  recovery: {
    label: '异常回合恢复提示',
    description: '会话状态需要恢复检查时使用；可留空。',
    tokens: [],
    requiredTokens: [],
    allowEmpty: true,
  },
  memoryBootstrap: {
    label: '长期记忆开场摘要模板',
    description: '首次开场存在自身经历记忆时使用。必须保留 {entries}。',
    tokens: ['entries'],
    requiredTokens: ['entries'],
  },
});

const PROMPT_TEMPLATE_MAX_CHARS = 16_000;
export function normalizeDesktopAgentPromptTemplates(value) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('运行时提示模板必须是对象');
  }
  const input = value ?? {};
  const output = {};
  let totalChars = 0;
  for (const [key, field] of Object.entries(DESKTOP_AGENT_PROMPT_TEMPLATE_FIELDS)) {
    const raw = Object.hasOwn(input, key) ? input[key] : DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS[key];
    if (typeof raw !== 'string') throw new Error(`「${field.label}」必须是文本`);
    const template = raw.replace(/\r\n/g, '\n').trim();
    if (!template && !field.allowEmpty) throw new Error(`「${field.label}」不能为空`);
    if (template.length > PROMPT_TEMPLATE_MAX_CHARS) {
      throw new Error(`「${field.label}」不能超过 ${PROMPT_TEMPLATE_MAX_CHARS} 个字符`);
    }
    const placeholders = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    const unknown = [...new Set(placeholders.filter((token) => !field.tokens.includes(token)))];
    if (unknown.length) throw new Error(`「${field.label}」含未知占位符：${unknown.map((token) => `{${token}}`).join('、')}`);
    const missing = field.requiredTokens.filter((token) => !placeholders.includes(token));
    if (missing.length) throw new Error(`「${field.label}」必须保留 ${missing.map((token) => `{${token}}`).join('、')}`);
    output[key] = template;
    totalChars += template.length;
  }
  if (totalChars > 64_000) throw new Error('运行时提示模板总长度不能超过 64000 个字符');
  return output;
}

export function renderDesktopAgentPromptTemplate(template, values = {}) {
  return String(template ?? '').replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, token) => (
    Object.hasOwn(values, token) ? String(values[token] ?? '') : placeholder
  ));
}
