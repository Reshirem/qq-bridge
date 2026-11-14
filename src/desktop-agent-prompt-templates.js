// Bridge-generated prompt fragments appended to desktop-agent session.prompt messages.
// Keep these separate from the DSH preset prefix: they are runtime context templates.

export const DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS = Object.freeze({
  roleCard: '【当前角色卡：{roleName}】\n{roleContent}',
  qqAttention: '【QQ 提醒】\n{sources}',
  qqSource: '- {key}{senderId}{messageId}{count}',
  restExpired: '【回合等待结束】等待时间到了。先留意当前情况，再按自己的兴趣和判断决定下一步。',
  qqWake: '',
  recovery: '【状态恢复检查】桥接需要重新确认会话状态。先查看当前会话和已有操作，避免重复已完成的事，再按当前情况继续。',
  missingRest: '【回合收尾提醒】上一轮已正常结束，但桥接尚未收到 agent_rest。不要重复刚才的回复或已完成的操作。若当前事项已处理完，请现在直接调用 agent_rest 作为最后一个工具调用（选择 1 至 5 分钟的等待间隔，无需向对话方发消息道别或声称去休息）；若仍有未完成事项，处理完后再调用。',
  memoryBootstrap: '【长期记忆摘要｜来源为自身经历；用于延续经历与未完成事项，仍需按当前上下文判断】\n{entries}',
});

export const DESKTOP_AGENT_PROMPT_TEMPLATE_FIELDS = Object.freeze({
  roleCard: {
    label: 'persona 前缀人格卡模板',
    description: '用于格式化动态加入 DSH persona 固定前缀的当前人格卡。可使用 {roleContent} 和 {roleName}。修改后在下一次 DSH 提示词组装时生效。',
    tokens: ['roleName', 'roleContent'],
    requiredTokens: [],
  },
  qqAttention: {
    label: 'QQ 消息提醒模板',
    description: '有 QQ 来源提醒时使用。可使用 {sources}；正文不会被放进提醒。',
    tokens: ['sources'],
    requiredTokens: [],
  },
  qqSource: {
    label: 'QQ 来源信息行模板',
    description: '每个提醒来源生成一行；{messageId} 使用 id:QQ消息ID，缺失时使用 seq:本地序号@缓存标识，定位时需完整保留。{senderId}、{messageId} 和 {count} 在无对应信息时为空。',
    tokens: ['key', 'kind', 'reason', 'sender', 'senderId', 'messageId', 'count'],
    requiredTokens: [],
  },
  restExpired: {
    label: '休息到期提示',
    description: '数字角色主动休息时间结束时使用；可留空。',
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
  missingRest: {
    label: '遗漏休息工具时的收尾提醒',
    description: '回合正常完成却未调用 agent_rest 时发给 DSH；首次立即提醒，连续遗漏时延长提醒间隔。',
    tokens: [],
    requiredTokens: [],
  },
  memoryBootstrap: {
    label: '长期记忆开场摘要模板',
    description: '首次开场存在自身经历记忆时使用，可使用 {entries}。',
    tokens: ['entries'],
    requiredTokens: [],
  },
});

// Upgrade previously shipped defaults; any edited template remains untouched.
const LEGACY_PROMPT_TEMPLATE_DEFAULTS = Object.freeze({
  qqAttention: [
    '【QQ 提醒】\n有以下 QQ 来源触发了提醒。这里只附来源信息，不含消息正文；你可以结合正在做的事，决定是否查看、回应或稍后再看。\n{sources}',
    '【QQ 提醒】\n有以下 QQ 来源触发了提醒。这里只附来源信息，不含消息正文；你可以查看相关对话和上下文，再决定如何参与。\n{sources}',
  ],
  qqSource: [
    '- {key}{messageId}{count}',
    '- {key}（{kind}，提醒原因：{reason}，发送者：{sender}{senderId}{messageId}{count}）',
  ],
  qqWake: ['【休息被 QQ 提醒提前结束】'],
  restExpired: [
    '【休息结束】休息时间到了。先留意当前情况，再按自己的兴趣和判断决定下一步。',
  ],
  missingRest: [
    '【回合收尾提醒】上一轮已正常结束，但桥接尚未收到 agent_rest。不要重复刚才的回复或已完成的操作。若当前事项已处理完，请现在调用 agent_rest 作为最后一个工具调用，并自行选择 1 至 5 分钟的休息时间；若仍有未完成事项，处理完后再调用。',
  ],
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
    const normalized = raw.replace(/\r\n/g, '\n').trim();
    const template = LEGACY_PROMPT_TEMPLATE_DEFAULTS[key]?.includes(normalized)
      ? DESKTOP_AGENT_PROMPT_TEMPLATE_DEFAULTS[key]
      : normalized;
    if (template.length > PROMPT_TEMPLATE_MAX_CHARS) {
      throw new Error(`「${field.label}」不能超过 ${PROMPT_TEMPLATE_MAX_CHARS} 个字符`);
    }
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
