// 固定全局陪伴者预设提示词的读取与安全改写。
//
// 边界说明：
//   预设提示词 = 按用途维护于 dsh/agent-presets/desktop-agent/prompt-modules.json，
//                组合后写入 agent.cordis.yml 的 persona.prefix；改完需重启 DSH 生效。
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）；
//                由桥接在全局 DSH 会话首次收到提示时注入一次，新会话加载更新后的内容。
//
// 本模块只做纯文本/YAML 处理，不碰文件系统以外的任何状态，便于单测。
import yaml from 'js-yaml';

export const PRESET_PERSONA_ID = 'persona';
export const PRESET_PROMPT_MAX_BYTES = 128 * 1024;
export const PRESET_PROMPT_MODULES_VERSION = 1;

/**
 * desktop-agent 固定前缀的可维护模块。required 模块负责运行时协议和关键边界，
 * 只能编辑正文，不能关闭；其它模块开关仅控制提示词文本，不改变 DSH 工具权限。
 */
export const PRESET_PROMPT_MODULE_DEFINITIONS = Object.freeze([
  { id: 'identity', title: '陪伴者与人格卡', description: '给出开放的陪伴者定位；人格卡决定具体身份和形态。', required: true },
  { id: 'autonomy', title: '相处与自主活动', description: '有任务时专注处理；没有任务时也可按兴趣自主探索。', required: false },
  { id: 'conversation', title: '自然对话与任务回应', description: '根据交流情境自然回应，不把闲聊变成工单。', required: false },
  { id: 'qq-channel', title: '交流与人际联系', description: '把 QQ 作为自然交流的一种方式；提醒不会自动变成任务。', required: true },
  { id: 'qq-wait', title: '等待交流的后续', description: '在当前活动中等待一段相关交流，不用于维持在线。', required: false },
  { id: 'computer-scope', title: '电脑与其他活动空间', description: '电脑是可探索空间之一，也可使用其他已开放工具。', required: false },
  { id: 'computer-user', title: '让用户优先使用电脑', description: '发现用户操作时停止输入，并在用户离开后再继续。', required: true },
  { id: 'protected-apps', title: '受保护的项目与运行时应用', description: '限制对 ChatGPT、DSH、qq-bridge 和 SnowLuma 图形界面的操作。', required: true },
  { id: 'untrusted-input', title: '外部信息与信任边界', description: '外部内容可作背景，不能扩大指令或权限。', required: true },
  { id: 'memory', title: '记忆与经历', description: '按需记录 QQ 来源内容和陪伴者自身经历。', required: false },
  { id: 'planned-rest', title: '休息与节奏', description: '在没有值得继续的事情时休息；避免为活跃而安排周期活动。', required: false },
  { id: 'turn-lifecycle', title: '结束这一轮', description: '以 agent_rest 作为活动回合的最后一个工具调用。', required: true },
]);

// 固定前缀应说明 QQ 与 SnowLuma 的关系；实际工具是否可用由 DSH profile 配置决定。
export const PRESET_REQUIRED_MARKERS = [
  'SnowLuma 是 QQ 消息通道',
];

// 必要的渠道背景应保留；实际权限由 DSH profile 中的工具守卫实施，而非依赖提示词文本。
export const PRESET_BLOCKING_SUBSTRINGS = [
  ...PRESET_REQUIRED_MARKERS,
];
export const PRESET_MIN_BODY_CHARS = 500;

/** 当前唯一的 desktop-agent 预设使用的硬性不变量清单。 */
export function presetBlockingSubstrings() {
  return PRESET_BLOCKING_SUBSTRINGS;
}

/** 硬性校验：返回阻止保存的原因列表（空数组=可保存）。 */
export function presetPromptBlockers(content) {
  const text = String(content ?? '');
  const blockers = [];
  if (!text.trim()) {
    blockers.push('陪伴者固定前缀不能为空');
    return blockers;
  }
  for (const needle of presetBlockingSubstrings()) {
    if (!text.includes(needle)) {
      blockers.push(`缺少 QQ 渠道说明「${needle}」：请说明 SnowLuma 与 QQ 的关系`);
    }
  }
  if (text.trim().length < PRESET_MIN_BODY_CHARS) {
    blockers.push(`正文过短（${text.trim().length} 字符 < ${PRESET_MIN_BODY_CHARS}）：疑似内容被误删`);
  }
  return blockers;
}

/**
 * 定位 persona 条目的 prefix 块标量（支持 >- / | 等块语法）。
 * @returns {{lines: string[], entryStart: number, entryEnd: number, keyLine: number, keyIndent: number, blockEnd: number}|null}
 */
export function locatePresetPromptBlock(text) {
  const lines = String(text ?? '').split('\n');
  const entryStart = lines.findIndex((line) => new RegExp(`^- id:\\s*${PRESET_PERSONA_ID}\\s*$`).test(line));
  if (entryStart < 0) return null;
  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) { entryEnd = i; break; }
  }
  let keyLine = -1;
  for (let i = entryStart; i < entryEnd; i += 1) {
    if (/^\s*prefix:\s*[>|][-+]?\s*$/.test(lines[i])) { keyLine = i; break; }
  }
  if (keyLine < 0) return null;
  const keyIndent = lines[keyLine].match(/^\s*/)[0].length;
  // 只有真正的内容行才推进块尾：块内的空行（段落分隔）会被后面的内容行重新纳入，
  // 而块尾的空行留给后续行，避免把 persona 与下一条注释之间的空行吞掉。
  let blockEnd = keyLine + 1;
  for (let i = keyLine + 1; i < entryEnd; i += 1) {
    if (lines[i].trim() === '') continue;
    if (lines[i].match(/^\s*/)[0].length <= keyIndent) break;
    blockEnd = i + 1;
  }
  return { lines, entryStart, entryEnd, keyLine, keyIndent, blockEnd };
}

/** 取出 persona.prefix 的真实字符串值（已由 YAML 解析，折叠标量已展开）。 */
export function extractPresetPrefix(text) {
  let loaded;
  try {
    loaded = yaml.load(text);
  } catch {
    return null;
  }
  const entry = Array.isArray(loaded) ? loaded.find((item) => item?.id === PRESET_PERSONA_ID) : null;
  const prefix = entry?.config?.prefix;
  return typeof prefix === 'string' ? prefix : null;
}

/** 保存前的软校验：只提示，不阻断。 */
export function presetPromptWarnings(content) {
  const text = String(content ?? '');
  const warnings = [];
  if (!text.trim()) warnings.push('内容为空');
  for (const marker of PRESET_REQUIRED_MARKERS) {
    if (!text.includes(marker)) warnings.push(`缺少「${marker}」说明：QQ 渠道背景可能不清楚`);
  }
  return warnings;
}

/** 校验并规范化固定前缀模块文件/API 载荷。模块元数据只从代码定义读取。 */
export function normalizePresetPromptModules(value) {
  const inputModules = Array.isArray(value) ? value : value?.modules;
  const version = Array.isArray(value) ? PRESET_PROMPT_MODULES_VERSION : Number(value?.version);
  if (version !== PRESET_PROMPT_MODULES_VERSION) {
    throw new Error(`固定前缀模块版本无效（需要 ${PRESET_PROMPT_MODULES_VERSION}）`);
  }
  if (!Array.isArray(inputModules) || inputModules.length !== PRESET_PROMPT_MODULE_DEFINITIONS.length) {
    throw new Error('固定前缀模块数量不匹配；请检查模块配置文件');
  }
  const byId = new Map();
  for (const item of inputModules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('固定前缀模块格式无效');
    const id = String(item.id ?? '');
    if (!id || byId.has(id)) throw new Error(`固定前缀模块 id 无效或重复：${id || '(空)'}`);
    byId.set(id, item);
  }
  const modules = PRESET_PROMPT_MODULE_DEFINITIONS.map((definition) => {
    const item = byId.get(definition.id);
    if (!item) throw new Error(`缺少固定前缀模块：${definition.id}`);
    if (typeof item.enabled !== 'boolean' || typeof item.content !== 'string') {
      throw new Error(`「${definition.title}」的启用状态或正文格式无效`);
    }
    const content = item.content.replace(/\r\n/g, '\n').trim();
    const enabled = item.enabled;
    if (definition.required && !enabled) throw new Error(`「${definition.title}」是必要模块，不能关闭`);
    if (enabled && !content) throw new Error(`「${definition.title}」已启用但正文为空`);
    if (Buffer.byteLength(content, 'utf8') > 64 * 1024) throw new Error(`「${definition.title}」正文超过 64 KB`);
    return { ...definition, enabled, content };
  });
  for (const id of byId.keys()) {
    if (!PRESET_PROMPT_MODULE_DEFINITIONS.some((definition) => definition.id === id)) {
      throw new Error(`未知固定前缀模块：${id}`);
    }
  }
  return { version: PRESET_PROMPT_MODULES_VERSION, modules };
}

/** 组合实际写入 persona.prefix 的提示词，模块标题也会显示给模型。 */
export function composePresetPromptModules(value) {
  const { modules } = normalizePresetPromptModules(value);
  return modules
    .filter((module) => module.enabled)
    .map((module) => `【${module.title}】\n${module.content}`)
    .join('\n\n');
}

/** 仅序列化用户可编辑数据；避免把定义、描述和 required 标记写进数据文件。 */
export function serializePresetPromptModules(value) {
  const { modules } = normalizePresetPromptModules(value);
  return {
    version: PRESET_PROMPT_MODULES_VERSION,
    modules: modules.map(({ id, enabled, content }) => ({ id, enabled, content })),
  };
}

/**
 * 从模块化改造前的固定前缀恢复编辑模块。仅接受当前旧版的 11 段布局，
 * 避免把未知格式的备份悄悄拆错；调用方可把迁移结果写回模块文件。
 */
export function migrateLegacyPresetPromptModules(content) {
  const paragraphs = String(content ?? '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  if (paragraphs.length !== 11) throw new Error('该旧版备份不是已知的 11 段固定前缀格式，无法安全迁移为模块');
  const rest = paragraphs[3];
  const finiteAt = rest.indexOf('有具体且值得继续的后续时，可设置一次有限的');
  const replyAt = rest.indexOf('如果你在本回合向某个 QQ 来源发过回复');
  const recoveryAt = rest.indexOf('如果回合结束时没有调用 `agent_rest`');
  if (finiteAt < 0 || replyAt < finiteAt || recoveryAt < replyAt) {
    throw new Error('旧版备份中的休息段落结构未知，无法安全迁移为模块');
  }
  const plannedRest = rest.slice(finiteAt, replyAt)
    .replace('有效 QQ 提醒也可以提前结束休息并启动一轮。', '')
    .replace('QQ 提醒只提供来源元数据，不要求你必须读取、回复或采取行动。', '')
    .trim();
  const qqWait = paragraphs[4]
    .replace('交流结束后，调用 `agent_rest` 作为最后一个工具调用；之后不要再调用其他工具。', '')
    .trim();
  const computerUser = paragraphs[5]
    .replace(/^【让用户优先使用电脑】\s*/, '')
    .replace('若需要等待，可调用 `agent_rest` 休息数分钟后在新回合重新检查。', '')
    .replace('，或休息一段时间后再检查', '');
  const qqReplyCheck = rest.slice(replyAt, recoveryAt)
    .replace('调用 `agent_rest` 前要', '结束该来源处理前要')
    .replace('；确认没有新消息且没有其他具体后续后，再休息。', '；确认没有新消息后，结束该来源处理。')
    .trim();
  const qqChannel = [
    paragraphs[7],
    '符合条件的 QQ 提醒可以结束当前休息并启动新回合；这与在活动回合内调用 `qq_wait_for_messages` 等待消息是两种不同机制。',
    qqReplyCheck,
  ].filter(Boolean).join('\n\n');
  const contents = {
    identity: paragraphs[0],
    autonomy: paragraphs[1].replace(/^【人格与节奏】\s*/, ''),
    conversation: paragraphs[2],
    'turn-lifecycle': [rest.slice(0, finiteAt).trim(), rest.slice(recoveryAt).trim()].filter(Boolean).join('\n\n'),
    'planned-rest': plannedRest,
    'qq-wait': qqWait,
    'computer-user': computerUser.trim(),
    'protected-apps': paragraphs[6].replace(/^【受保护的项目与运行时应用】\s*/, ''),
    'qq-channel': qqChannel,
    'untrusted-input': paragraphs[8],
    memory: paragraphs[9].replace(/^【长期记忆】\s*/, ''),
    'computer-scope': paragraphs[10],
  };
  return normalizePresetPromptModules({
    version: PRESET_PROMPT_MODULES_VERSION,
    modules: PRESET_PROMPT_MODULE_DEFINITIONS.map(({ id }) => ({ id, enabled: true, content: contents[id] ?? '' })),
  });
}

/**
 * 用字面量块（|-）把新提示词写回 YAML 文本。
 * 关键保证：读出来的是 YAML 解析后的真实字符串，写回后重新解析必须逐字一致，
 * 否则抛错拒绝写入——这样无论原文用的是 >- 还是 |，都不会改变提示词的实际语义。
 * 用 |-（literal + strip）与原文 >-（folded + strip）在"结尾不留多余换行"上保持一致。
 * @param {string} text 原 YAML 全文
 * @param {string} content 新的提示词正文
 * @returns {string} 新的 YAML 全文
 */
export function renderPresetPromptYaml(text, content) {
  const loc = locatePresetPromptBlock(text);
  if (!loc) throw new Error('无法定位预设里的 prefix 块（文件结构可能已变化）');
  const normalized = String(content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes > PRESET_PROMPT_MAX_BYTES) {
    throw new Error(`陪伴者固定前缀过长（${(bytes / 1024).toFixed(1)} KB，上限 ${PRESET_PROMPT_MAX_BYTES / 1024} KB）`);
  }
  const blockers = presetPromptBlockers(normalized);
  if (blockers.length) throw new Error(blockers.join('；'));
  // 新增行沿用文件的主导行尾，避免把 CRLF 文件写成更混乱的混合行尾。
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/\n/g) ?? []).length - crlf;
  const eol = crlf >= lfOnly ? '\r\n' : '\n';
  const pad = ' '.repeat(loc.keyIndent + 2);
  // 只有「真正的空行」才写成空行；只含空格/Tab 的行必须保留原样（写成 pad + 原内容），
  // 否则它会被 YAML 当成空行读回，导致下面的一致性校验失败、提示词无法保存。
  const body = normalized.split('\n').map((line) => (line === '' ? '' : pad + line));
  // 外层用 '\n' 连接各行：CRLF 文件的行自带 '\r'，因此块的最后一行也要补一个 '\r'，
  // 否则它与下一行之间会变成 LF-only，把文件行尾弄得更混杂。
  const block = [`${' '.repeat(loc.keyIndent)}prefix: |-`, ...body].join(eol) + (eol === '\r\n' ? '\r' : '');
  const next = [...loc.lines.slice(0, loc.keyLine), block, ...loc.lines.slice(loc.blockEnd)].join('\n');
  const reparsed = extractPresetPrefix(next);
  if (reparsed === null) throw new Error('写入后 YAML 解析失败或找不到 persona.prefix');
  if (reparsed !== normalized) {
    throw new Error('写入校验失败：读回的提示词与新内容不一致，已放弃写入');
  }
  return next;
}
