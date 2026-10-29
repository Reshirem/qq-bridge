async function api(path, method, body) {
  const headers = body ? {'content-type':'application/json'} : {};
  const res = await fetch(path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    location.replace('/?login=expired');
    throw new Error('控制台登录已失效，正在返回登录页');
  }
  return res.json();
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// 上游静默时长的人话渲染：只用于 SnowLuma 健康提示（秒 / 分钟 / 小时）。
function fmtAgoMs(ms) {
  if (ms === null || ms === undefined || ms === '') return '未知';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '未知';
  if (n < 1000) return '刚刚';
  if (n < 60_000) return Math.round(n / 1000) + ' 秒';
  if (n < 3_600_000) return Math.round(n / 60_000) + ' 分钟';
  if (n < 86_400_000) return Math.round(n / 3_600_000) + ' 小时';
  return Math.round(n / 86_400_000) + ' 天';
}
// SnowLuma 上游健康：控制台是唯一的可视化出口（桥接侧只有日志）。
function renderSnowlumaHealth(sl) {
  const el = document.getElementById('snowlumaWarn');
  const strong = document.getElementById('metricSnowluma');
  const hint = document.getElementById('metricSnowlumaHint');
  if (!el || !strong || !hint) return;
  if (!sl || typeof sl !== 'object') {
    el.style.display = 'none';
    strong.textContent = '未知';
    strong.className = '';
    hint.textContent = '桥接未上报上游健康状态';
    return;
  }
  const degraded = sl.degraded === true;
  const connected = sl.connected === true;
  const ago = sl.lastPacketAgoMs;
  const receiving = Number.isFinite(ago);
  const goodText = sl.good === true ? 'good=true' : sl.good === false ? 'good=false' : 'good 未知';
  if (degraded) {
    strong.textContent = '已连接 · 未接收';
    strong.className = 'err';
    hint.textContent = '网关连着，但 QQ 侧数据没到';
  } else if (!connected) {
    strong.textContent = '未连接';
    strong.className = 'err';
    hint.textContent = '连不上 QQ 网关，请先启动 SnowLuma';
  } else {
    strong.textContent = '正常 · 接收中';
    strong.className = 'ok';
    hint.textContent = (receiving ? '最近一份上游事件包在 ' + fmtAgoMs(ago) + '前 · ' : '')
      + (sl.good === false ? 'good=false' : sl.good === true ? 'good=true' : 'good 未上报');
  }
  if (!degraded) { el.style.display = 'none'; return; }
  document.getElementById('snowlumaWarnHint').textContent = sl.hint
    || '桥接与 QQ 网关的 WebSocket 连着，但一直收不到 QQ 侧的数据。';
  document.getElementById('snowlumaWarnPkt').textContent = (receiving ? fmtAgoMs(ago) + '前' : '从未收到')
    + (sl.lastPacketKind ? '（' + sl.lastPacketKind + '）' : '');
  document.getElementById('snowlumaWarnGood').textContent = goodText;
  el.style.display = '';
}

async function refresh() {
  try {
    const s = await api('/api/status');
    document.getElementById('roleText').textContent = s.role || '无';
    updateOverview(s);
    document.getElementById('activity').textContent = s.activity || '（空）';
  } catch (e) { document.getElementById('statusText').textContent = '连接中断 · 请检查桥接服务'; setConnectionError(e); }
}

// ── 人格管理 ────────────────────────────────────────────────────────────────
// 当前人格卡由 DSH 每次提示词组装时动态放入 persona 固定前缀。
let roleEditorState = { mode: 'new', name: '' };
let roleCache = [];
let roleRecommendedChars = 6000;

function roleCharCount(text) {
  return Array.from(String(text ?? '')).length;
}

function estimateRoleTokens(text) {
  let cjkChars = 0;
  let otherChars = 0;
  for (const character of String(text ?? '')) {
    const code = character.codePointAt(0);
    const isCjk =
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0x2fff) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0x3100 && code <= 0x312f) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x20000 && code <= 0x2fa1f);
    if (isCjk) cjkChars += 1;
    else otherChars += 1;
  }
  return Math.ceil(cjkChars * 0.6 + otherChars * 0.3);
}

function setRoleMsg(text, ok) {
  const el = document.getElementById('roleCreateMsg');
  el.textContent = text;
  el.className = ok === undefined ? 'meta' : (ok ? 'meta ok' : 'meta err');
}

function renderRoleEditor() {
  const editing = roleEditorState.mode === 'edit';
  document.getElementById('roleEditorMeta').textContent = editing
    ? `正在编辑「${roleEditorState.name}」：改完点「保存修改」；改名字会同时重命名文件。`
    : '当前是「新建」模式：填好名称与内容后点「新建人格」；名称与已有的人格同名则会改为保存修改。';
  document.getElementById('roleCreate').textContent = editing ? '保存修改' : '新建人格';
  updateRoleEditorWarnings();
}

function roleEditorWarnings(text) {
  const chars = roleCharCount(text);
  return chars > roleRecommendedChars
    ? `⚠️ 超过建议的 ${roleRecommendedChars} 字符（约 ${estimateRoleTokens(text)} tokens）；保存后仍会完整加入 persona 固定前缀。`
    : '';
}

function updateRoleEditorWarnings() {
  const content = document.getElementById('newRoleContent').value;
  const chars = roleCharCount(content);
  const tokens = estimateRoleTokens(content);
  document.getElementById('roleEditorStats').textContent = `${chars.toLocaleString()} 字符 · 约 ${tokens.toLocaleString()} tokens`;
  document.getElementById('roleEditorWarnings').textContent = roleEditorWarnings(content);
}

async function openRoleForEdit(name) {
  setRoleMsg('读取中…');
  const res = await api('/api/roles/content?name=' + encodeURIComponent(name));
  if (!res.ok) { setRoleMsg(res.error || '读取失败', false); return; }
  document.getElementById('newRoleName').value = name;
  document.getElementById('newRoleContent').value = res.content;
  roleEditorState = { mode: 'edit', name };
  renderRoleEditor();
  updateRoleEditorWarnings();
  setRoleMsg(`已载入「${name}」（${res.chars.toLocaleString()} 字符，约 ${Number(res.estimatedTokens ?? estimateRoleTokens(res.content)).toLocaleString()} tokens）`, true);
}

function resetRoleForm() {
  document.getElementById('newRoleName').value = '';
  document.getElementById('newRoleContent').value = '';
  roleEditorState = { mode: 'new', name: '' };
  renderRoleEditor();
  updateRoleEditorWarnings();
  setRoleMsg('');
}

async function refreshRoles() {
  try {
    const r = await api('/api/roles');
    if (Number.isFinite(Number(r.limits?.recommendedChars))) roleRecommendedChars = Number(r.limits.recommendedChars);
    const names = Array.isArray(r.roles) ? r.roles : [];
    roleCache = Array.isArray(r.summaries) && r.summaries.length === names.length
      ? r.summaries
      : names.map((name) => ({ name, chars: 0, estimatedTokens: 0, bytes: 0, excerpt: '', recommendedLengthExceeded: false }));
    const box = document.getElementById('roleList');
    box.replaceChildren();
    if (!roleCache.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<strong>还没有人格</strong><p>在「编辑人格提示词」里填名称与内容，点「新建人格」创建第一个。</p>';
      box.appendChild(empty);
    }
    for (const role of roleCache) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'persona-item' + (role.name === r.current ? ' active' : '');
      item.setAttribute('aria-pressed', String(role.name === r.current));
      const head = document.createElement('span');
      head.className = 'persona-item-head';
      const title = document.createElement('strong');
      title.textContent = role.name;
      head.appendChild(title);
      if (role.name === r.current) {
        const badge = document.createElement('span');
        badge.className = 'persona-badge';
        badge.textContent = '启用中';
        head.appendChild(badge);
      }
      if (role.recommendedLengthExceeded) {
        const badge = document.createElement('span');
        badge.className = 'persona-badge warn';
        badge.textContent = '较长';
        badge.title = `超过建议的 ${roleRecommendedChars} 字符；人格卡仍会完整载入`;
        head.appendChild(badge);
      }
      const meta = document.createElement('small');
      meta.textContent = `${role.chars.toLocaleString()} 字符 · 约 ${Number(role.estimatedTokens ?? 0).toLocaleString()} tokens · 完整载入${role.excerpt ? ' · ' + role.excerpt : ''}`;
      item.append(head, meta);
      item.addEventListener('click', () => openRoleForEdit(role.name));
      box.appendChild(item);
    }
    const hint = document.getElementById('roleListHint');
    if (hint) hint.textContent = roleCache.length ? `共 ${roleCache.length} 个 · 点任意一个载入编辑` : '';
    renderRoleEditor();
  } catch (error) {
    document.getElementById('roleList').textContent = '加载失败：' + (error?.message ?? error);
  }
}

// ── 全局 desktop-agent 提示词 ───────────────────────────────────────────────
let desktopPromptOriginalModules = [];
let desktopPromptOriginalContent = '';
let desktopPromptEditing = false;
let desktopPromptPreset = 'desktop-agent';

function setSimMsg(text, ok) {
  const el = document.getElementById('desktopPromptMsg');
  el.textContent = text;
  el.className = ok === undefined ? 'meta' : (ok ? 'meta ok' : 'meta err');
}

function setSimEditing(editing) {
  desktopPromptEditing = editing;
  document.querySelectorAll('#desktopPromptModules .prompt-module-card').forEach((card) => {
    const textarea = card.querySelector('.prompt-module-textarea');
    const toggle = card.querySelector('.prompt-module-toggle input');
    const titleInput = card.querySelector('.prompt-module-title-input');
    const titleDisplay = card.querySelector('.prompt-module-title-display');
    const removeButton = card.querySelector('.prompt-module-remove');
    const required = card.dataset.required === 'true';
    textarea.readOnly = !editing;
    textarea.classList.toggle('editing', editing);
    toggle.disabled = !editing || required;
    if (titleInput) {
      titleInput.disabled = !editing;
      if (titleDisplay) titleDisplay.hidden = editing;
      titleInput.hidden = !editing;
    }
    if (removeButton) removeButton.hidden = !editing;
  });
  const addButton = document.getElementById('desktopPromptAddModule');
  addButton.hidden = !editing;
  addButton.disabled = !editing;
  document.getElementById('desktopPromptEdit').disabled = editing;
  document.getElementById('desktopPromptSave').disabled = !editing;
  document.getElementById('desktopPromptCancel').disabled = !editing;
}

function collectPromptModules() {
  return [...document.querySelectorAll('#desktopPromptModules .prompt-module-card')].map((card) => {
    const module = {
      id: card.dataset.moduleId,
      enabled: card.querySelector('.prompt-module-toggle input').checked,
      content: card.querySelector('.prompt-module-textarea').value,
    };
    if (card.dataset.custom === 'true') {
      module.custom = true;
      module.title = card.querySelector('.prompt-module-title-input').value;
    }
    return module;
  });
}

function updatePromptPreview() {
  const content = collectPromptModules()
    .filter((module) => module.enabled)
    .map((module) => {
      const definition = desktopPromptOriginalModules.find((item) => item.id === module.id);
      return `【${module.title || definition?.title || module.id}】\n${module.content.trim()}`;
    })
    .join('\n\n');
  document.getElementById('desktopPromptPreview').value = content;
  return content;
}

function renderPromptModules(modules) {
  const list = document.getElementById('desktopPromptModules');
  list.replaceChildren();
  for (const module of modules || []) {
    const card = document.createElement('section');
    card.className = 'prompt-module-card';
    card.dataset.moduleId = module.id;
    card.dataset.required = module.required ? 'true' : 'false';
    card.dataset.custom = module.custom === true ? 'true' : 'false';

    const head = document.createElement('div');
    head.className = 'prompt-module-head';
    if (module.custom) {
      const titleDisplay = document.createElement('h4');
      titleDisplay.className = 'prompt-module-title-display';
      titleDisplay.textContent = module.title;
      head.appendChild(titleDisplay);

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'prompt-module-title-input';
      titleInput.value = module.title;
      titleInput.maxLength = 80;
      titleInput.placeholder = '模块名称';
      titleInput.disabled = !desktopPromptEditing;
      titleInput.hidden = !desktopPromptEditing;
      titleInput.setAttribute('aria-label', '自定义模块名称');
      titleInput.addEventListener('input', () => {
        titleDisplay.textContent = titleInput.value || '未命名模块';
        updatePromptPreview();
      });
      head.appendChild(titleInput);
    } else {
      const title = document.createElement('h4');
      title.className = 'prompt-module-title-display';
      title.textContent = module.title;
      head.appendChild(title);
    }

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'prompt-module-toggle';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = module.enabled === true;
    toggle.disabled = module.required === true;
    toggle.setAttribute('aria-label', `${module.title} 模块开关`);
    const toggleText = document.createElement('span');
    if (module.required) toggleText.className = 'prompt-module-required';
    toggleText.textContent = module.required ? '必须启用' : (toggle.checked ? '已启用' : '已关闭');
    toggle.addEventListener('change', () => {
      toggleText.textContent = toggle.checked ? '已启用' : '已关闭';
      updatePromptPreview();
    });
    toggleLabel.append(toggle, toggleText);
    head.appendChild(toggleLabel);
    if (module.custom) {
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'prompt-module-remove small';
      removeButton.textContent = '删除模块';
      removeButton.hidden = !desktopPromptEditing;
      removeButton.addEventListener('click', () => {
        card.remove();
        updatePromptPreview();
      });
      head.appendChild(removeButton);
    }
    card.appendChild(head);

    const description = document.createElement('p');
    description.className = 'prompt-module-description';
    description.textContent = module.description || '';
    card.appendChild(description);

    const editor = document.createElement('details');
    editor.className = 'prompt-module-editor';
    const editorSummary = document.createElement('summary');
    editorSummary.textContent = '查看 / 编辑模块正文';
    editor.appendChild(editorSummary);
    const textarea = document.createElement('textarea');
    textarea.className = 'prompt-module-textarea';
    textarea.spellcheck = false;
    textarea.readOnly = true;
    textarea.value = module.content || '';
    textarea.setAttribute('aria-label', `${module.title} 提示词正文`);
    textarea.addEventListener('input', updatePromptPreview);
    editor.appendChild(textarea);
    card.appendChild(editor);
    list.appendChild(card);
  }
  updatePromptPreview();
}

function newCustomPromptModuleId() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `custom-${random.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
}

function addCustomPromptModule() {
  const modules = collectPromptModules();
  if (modules.filter((module) => module.custom).length >= 32) {
    setSimMsg('自定义模块最多添加 32 个。', false);
    return;
  }
  const existingTitles = new Set(modules.map((module) => String(module.title || '').trim().toLocaleLowerCase()));
  let number = 1;
  while (existingTitles.has(`自定义模块 ${number}`.toLocaleLowerCase())) number += 1;
  const module = {
    id: newCustomPromptModuleId(),
    title: `自定义模块 ${number}`,
    description: '用户添加的固定前缀模块。',
    required: false,
    enabled: true,
    content: '',
    custom: true,
  };
  renderPromptModules([...modules, module]);
  setSimEditing(desktopPromptEditing);
  const card = document.querySelector(`#desktopPromptModules [data-module-id="${module.id}"]`);
  card?.querySelector('.prompt-module-editor')?.setAttribute('open', '');
  card?.querySelector('.prompt-module-title-input')?.focus();
  updatePromptPreview();
  setSimMsg('已添加自定义模块，请填写正文后保存。');
}

async function refreshSimPrompt() {
  setSimMsg('读取中…');
  try {
    const r = await api('/api/preset/desktop-agent-prompt/modules?preset=' + encodeURIComponent(desktopPromptPreset));
    if (!r.ok) {
      document.getElementById('desktopPromptModules').replaceChildren();
      document.getElementById('desktopPromptPreview').value = '';
      setSimEditing(false);
      document.getElementById('desktopPromptEdit').disabled = true;
      setSimMsg(r.error || '读取失败', false);
      document.getElementById('desktopPromptStatus').textContent = '不可用';
      return;
    }
    desktopPromptOriginalModules = (r.modules || []).map((module) => ({ ...module }));
    desktopPromptOriginalContent = r.content || '';
    renderPromptModules(desktopPromptOriginalModules);
    setSimEditing(false);
    document.getElementById('desktopPromptEdit').disabled = false;
    setSimMsg('');
    document.getElementById('desktopPromptStatus').textContent =
      `陪伴者 · ${r.chars} 字符${r.status?.patchCurrent ? ' · 配置包已同步' : ' · 配置包待更新'}`;
    document.getElementById('desktopPromptWarnings').textContent = (r.warnings || []).length
      ? '⚠️ ' + r.warnings.join('；') : '';
    document.getElementById('desktopPromptRestart').textContent =
      '更改会写入陪伴者预设；重启 DSH 并重建全局会话后加载新版。';
  } catch (error) {
    setSimEditing(false);
    document.getElementById('desktopPromptEdit').disabled = true;
    setSimMsg('读取失败：' + (error?.message ?? error), false);
  }
}

const runtimePromptTemplateFields = [
  ['roleCard', 'runtimePromptRoleCard'],
  ['qqAttention', 'runtimePromptQqAttention'],
  ['qqSource', 'runtimePromptQqSource'],
  ['restExpired', 'runtimePromptRestExpired'],
  ['qqWake', 'runtimePromptQqWake'],
  ['recovery', 'runtimePromptRecovery'],
  ['memoryBootstrap', 'runtimePromptMemoryBootstrap'],
];
let runtimePromptTemplateDefaults = null;

function setRuntimePromptTemplatesMsg(text, ok) {
  const el = document.getElementById('runtimePromptTemplatesMsg');
  el.textContent = text;
  el.className = ok === undefined ? 'meta' : (ok ? 'meta ok' : 'meta err');
}

function renderRuntimePromptTemplates(templates) {
  for (const [key, id] of runtimePromptTemplateFields) {
    document.getElementById(id).value = templates?.[key] ?? '';
  }
}

function collectRuntimePromptTemplates() {
  return Object.fromEntries(runtimePromptTemplateFields.map(([key, id]) => [
    key,
    document.getElementById(id).value,
  ]));
}

async function refreshRuntimePromptTemplates() {
  const saveButton = document.getElementById('runtimePromptTemplatesSave');
  saveButton.disabled = true;
  setRuntimePromptTemplatesMsg('读取中…');
  try {
    const response = await api('/api/desktop-agent/prompt-templates');
    if (!response.ok) throw new Error(response.error || '读取失败');
    runtimePromptTemplateDefaults = response.defaults || {};
    renderRuntimePromptTemplates(response.templates || {});
    saveButton.disabled = false;
    setRuntimePromptTemplatesMsg('');
  } catch (error) {
    setRuntimePromptTemplatesMsg(`读取失败：${error?.message ?? error}`, false);
  }
}

document.getElementById('runtimePromptTemplatesSave').addEventListener('click', async () => {
  const templates = collectRuntimePromptTemplates();
  const saveButton = document.getElementById('runtimePromptTemplatesSave');
  saveButton.disabled = true;
  setRuntimePromptTemplatesMsg('保存中…');
  try {
    const response = await api('/api/desktop-agent/prompt-templates', 'POST', { templates });
    if (!response.ok) throw new Error(response.error || '保存失败');
    renderRuntimePromptTemplates(response.templates || templates);
    setRuntimePromptTemplatesMsg('已保存；人格卡模板会在下一次 DSH 提示词组装时生效，其他模板用于后续对应事件。', true);
  } catch (error) {
    setRuntimePromptTemplatesMsg(`保存失败：${error?.message ?? error}`, false);
  } finally {
    saveButton.disabled = false;
  }
});

document.getElementById('runtimePromptTemplatesDefaults').addEventListener('click', () => {
  if (!runtimePromptTemplateDefaults) return;
  renderRuntimePromptTemplates(runtimePromptTemplateDefaults);
  setRuntimePromptTemplatesMsg('已填入默认内容；点击“保存运行时提示模板”后才会生效。');
});

// ── DSH 模型与思考强度 ──────────────────────────────────────────────────────
let dshModelOptions = [];
let dshEffortFallbackOptions = ['low', 'high', 'max'];

function populateDshEfforts(options, labels, preferred, providerDefault) {
  const select = document.getElementById('dshEffortSelect');
  const values = [...new Set((options || []).map((value) => String(value ?? '').trim()).filter(Boolean))];
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    const info = labels?.[value] || {};
    const isDefault = value === providerDefault;
    option.textContent = `${info.name ? `${info.name} · ` : ''}${value}${isDefault ? '（DSH 默认）' : ''}`;
    if (info.description) option.title = info.description;
    select.appendChild(option);
  }
  const selected = values.includes(preferred) ? preferred
    : values.includes(providerDefault) ? providerDefault
      : values[0] || '';
  select.value = selected;
}

function renderDshModelOptions(r) {
  const select = document.getElementById('dshModelSelect');
  const note = document.getElementById('dshModelNote');
  const raw = Array.isArray(r.modelOptions) ? r.modelOptions : [];
  dshEffortFallbackOptions = Array.isArray(r.options) && r.options.length ? r.options : ['low', 'high', 'max'];
  dshModelOptions = raw.map((item) => ({ ...item }));

  let currentIndex = dshModelOptions.findIndex((item) => item.provider === r.provider && item.model === r.model);
  if (currentIndex < 0 && r.provider && r.model) {
    dshModelOptions.push({
      provider: r.provider,
      providerName: `${r.provider}（当前配置）`,
      model: r.model,
      modelName: r.model,
      description: '当前配置不在 DSH 返回的可用模型目录中；如需修改，请使用手动填写。',
      reasoningEfforts: dshEffortFallbackOptions,
      reasoningLabels: r.labels || {},
      effortSource: 'fallback',
      defaultEffort: r.providerDefault || ''
    });
    currentIndex = dshModelOptions.length - 1;
  } else if (currentIndex >= 0 && !dshModelOptions[currentIndex].reasoningEfforts?.length) {
    dshModelOptions[currentIndex].reasoningEfforts = dshEffortFallbackOptions;
    dshModelOptions[currentIndex].reasoningLabels = r.labels || {};
    dshModelOptions[currentIndex].effortSource = 'fallback';
    dshModelOptions[currentIndex].defaultEffort = r.providerDefault || '';
  }

  select.replaceChildren();
  if (raw.length) {
    const groups = new Map();
    dshModelOptions.forEach((item, index) => {
      const label = item.providerName || item.provider;
      let group = groups.get(label);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = label;
        groups.set(label, group);
        select.appendChild(group);
      }
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = item.modelName && item.modelName !== item.model
        ? `${item.modelName} · ${item.model}` : item.model;
      if (item.description) option.title = item.description;
      group.appendChild(option);
    });
    select.disabled = false;
    if (currentIndex >= 0) select.value = String(currentIndex);
    note.textContent = `已从 DSH 读取 ${raw.length} 个模型。思考强度会随所选模型切换；若目录未列出所需模型，可展开手动填写。`;
  } else {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'DSH 模型目录不可用，请手动填写';
    select.appendChild(option);
    select.disabled = true;
    note.textContent = r.catalogError
      ? `无法读取 DSH 模型目录：${r.catalogError}。仍可手动填写 Provider / Model ID。`
      : 'DSH 没有返回可用模型；仍可手动填写 Provider / Model ID。';
  }

  document.getElementById('dshProviderInput').value = r.provider || '';
  document.getElementById('dshModelInput').value = r.model || '';
  const currentModel = currentIndex >= 0 ? dshModelOptions[currentIndex] : null;
  const currentModelEfforts = currentModel?.reasoningEfforts?.length ? [...currentModel.reasoningEfforts] : [...dshEffortFallbackOptions];
  const currentEffortSupported = currentModel?.effortSource !== 'dsh' || currentModel.reasoningEfforts.includes(r.reasoningEffort);
  const currentLabels = { ...(currentModel?.reasoningLabels || r.labels || {}) };
  if (!currentEffortSupported && r.reasoningEffort) {
    currentModelEfforts.push(r.reasoningEffort);
    currentLabels[r.reasoningEffort] = { name: '当前配置（未被 DSH 目录声明）', description: '请从当前模型公布的思考档位中选择并保存。' };
  }
  populateDshEfforts(
    currentModelEfforts,
    currentLabels,
    r.reasoningEffort,
    currentModel?.defaultEffort || r.providerDefault
  );

  const effortParts = [];
  if (currentModel?.defaultEffort || r.providerDefault) effortParts.push(`所选模型的 DSH 默认档位是 ${currentModel?.defaultEffort || r.providerDefault}`);
  effortParts.push(currentEffortSupported && currentModel?.effortSource === 'dsh'
    ? '档位取自所选模型在 DSH 公布的能力'
    : currentEffortSupported
      ? '当前模型能力暂不可读，档位使用内置回退清单'
      : `当前配置档位 ${r.reasoningEffort} 不在 DSH 公布的可用范围内，请选择并保存一个已列出的档位`);
  document.getElementById('dshEffortNote').textContent = effortParts.join('；') + '。';
  document.getElementById('dshEffortSideEffect').textContent = r.globalSideEffect
    ? '模型或思考强度会在下一条消息应用；DSH 也会将选择写入全局默认，新建的 DSH 会话默认值会随之改变。'
    : '';
}

async function refreshDshModel() {
  try {
    const r = await api('/api/dsh/model');
    document.getElementById('dshModelText').textContent = r.model || '-';
    document.getElementById('dshProviderText').textContent = r.provider || '-';
    renderDshModelOptions(r);
    document.getElementById('dshModelMsg').textContent = '';
    document.getElementById('dshEffortMsg').textContent = '';
  } catch (error) {
    const message = '读取失败：' + (error?.message ?? error);
    document.getElementById('dshModelNote').textContent = message + '。可展开手动填写模型。';
    document.getElementById('dshEffortNote').textContent = message;
    document.getElementById('dshModelSelect').disabled = true;
    document.getElementById('dshEffortMsg').textContent = message;
  }
}

async function refreshWhitelist() {
  try {
    const w = await api('/api/whitelist');
    document.getElementById('wlGroups').value = (w.allow.groups || []).join(', ');
    document.getElementById('wlPrivate').value = (w.allow.private || []).join(', ');
    document.getElementById('ownerQQ').value = w.ownerQQ != null ? String(w.ownerQQ) : '';
    document.getElementById('dnGroups').value = (w.deny.groups || []).join(', ');
    document.getElementById('dnPrivate').value = (w.deny.private || []).join(', ');
  } catch {}
}

let desktopAgentStatusAt = 0;
let desktopAgentStatusRequest = null;
let desktopAgentControlsAvailable = false;

async function refreshDesktopAgentStatus(force = false) {
  if (!force && Date.now() - desktopAgentStatusAt < 5000) return;
  if (desktopAgentStatusRequest) return desktopAgentStatusRequest;
  const request = (async () => {
    const status = document.getElementById('desktopAgentStatus');
    const summary = document.getElementById('metricDesktopAgent');
    const summaryHint = document.getElementById('metricDesktopAgentHint');
    try {
      const info = await api('/api/console/desktop-agent');
      let label = '正在读取会话状态';
      let tone = 'meta ok';
      let summaryLabel = '已就绪';
      let hint = '持久会话可启动自主探索或接收任务';
      if (!info.dshReady) { label = 'DSH 当前未连接'; tone = 'meta err'; summaryLabel = 'DSH 未连接'; hint = '检查 DSH 是否正在运行'; }
      else if (!info.presetAvailable) { label = '陪伴者 preset 未加载；请安装 preset bundle 并重启 DSH'; tone = 'meta err'; summaryLabel = '缺少 preset'; hint = '请先完成 DSH preset 配置'; }
      else if (info.error) { label = '读取会话状态失败：' + info.error; tone = 'meta err'; summaryLabel = '状态异常'; hint = '点击“刷新状态”重试'; }
      else if (info.lifecycle === 'stopped') {
        label = info.running ? '已停止；正在等待 DSH 取消当前回合' : '已停止；不会自动唤醒';
        tone = info.running ? 'meta err' : 'meta'; summaryLabel = '已停止'; hint = '从此页面启动自主探索或发送任务可恢复';
      }
      else if (!info.sessionId) { label = '尚未创建'; tone = 'meta'; summaryLabel = '尚未创建'; hint = '启动自主探索或发送任务时自动创建'; }
      else if (!info.found) { label = 'DSH 中已找不到当前会话；启动时会重新创建'; tone = 'meta err'; summaryLabel = '待重新创建'; hint = '启动时自动恢复'; }
      else if (!info.agentAvailable) { label = '会话存在，但 agent 当前不可用'; tone = 'meta err'; summaryLabel = '暂不可用'; hint = '请检查 DSH 会话状态'; }
      else if (info.lifecycle === 'resting') {
        const until = info.restUntil ? `，至 ${new Date(info.restUntil).toLocaleString()}` : '，无限期';
        const queued = info.pendingManualTasks > 0 ? `，${info.pendingManualTasks} 个手动任务排队` : '';
        label = '休息中' + until + queued; tone = 'meta'; summaryLabel = '休息中'; hint = info.pendingManualTasks > 0 ? 'WebUI 手动任务已排队；DSH 对话输入和有效 QQ 提醒也可提前唤醒' : '可直接在 DSH 对话中发消息，或由 WebUI 任务、有效 QQ 提醒提前结束休息';
      }
      else if (info.lifecycle === 'recovering') {
        const retryAt = info.recoveryAt ? new Date(info.recoveryAt).toLocaleString() : '即将';
        label = `异常恢复等待 · 第 ${info.recoveryAttempt || 1} 次，${retryAt} 重试`; tone = 'meta err'; summaryLabel = '等待恢复'; hint = '未正常进入休息态，桥接按指数间隔尝试恢复';
      }
      else if (info.running) { label = '正在运行'; tone = 'meta ok'; summaryLabel = '运行中'; hint = '陪伴者正在自主探索或处理任务'; }
      else if (info.blank) { label = '会话已创建，尚未启动'; tone = 'meta'; summaryLabel = '等待启动'; hint = '点击“启动自主探索”'; }
      else { label = '会话空闲，可继续探索'; tone = 'meta'; summaryLabel = '空闲'; hint = '点击“启动自主探索”或发送具体任务'; }
      status.textContent = label + (info.sessionId ? ` · ${info.sessionId}` : '');
      status.className = tone;
      const mediaWarning = document.getElementById('desktopAgentMediaWarning');
      mediaWarning.hidden = info.ffmpegAvailable !== false;
      mediaWarning.textContent = info.ffmpegAvailable === false
        ? '未检测到 FFmpeg：超过 1 MiB 的图片可能无法提供给模型；动图无法生成多帧预览，且超过上限时可能无法读取。请安装 FFmpeg 并设置 FFMPEG_PATH 或加入 PATH，然后重启桥接。'
        : '';
      summary.textContent = summaryLabel;
      summaryHint.textContent = hint;
      const startButton = document.getElementById('desktopAgentStart');
      const rebuildButton = document.getElementById('desktopAgentRebuild');
      const submitButton = document.getElementById('desktopAgentSubmit');
      const stopButton = document.getElementById('desktopAgentStop');
      const blocked = !!info.error || !info.dshReady || !info.presetAvailable
        || (!!info.sessionId && !!info.found && !info.agentAvailable);
      desktopAgentControlsAvailable = !blocked;
      startButton.textContent = info.running ? '正在运行…' : info.lifecycle === 'stopped' ? '重新启动自主探索' : (info.sessionId && !info.blank ? '继续自主探索' : '启动自主探索');
      startButton.disabled = blocked || !!info.running;
      stopButton.disabled = (info.lifecycle === 'stopped' && !info.running) || (info.lifecycle === 'idle' && !info.sessionId);
      rebuildButton.hidden = !info.sessionId || !info.found;
      rebuildButton.disabled = !info.dshReady || !info.presetAvailable || !!info.running;
      submitButton.disabled = blocked || !document.getElementById('desktopAgentMessage').value.trim();
    } catch (error) {
      status.textContent = '状态读取失败：' + (error?.message || '请求失败');
      status.className = 'meta err';
      summary.textContent = '状态未知';
      summaryHint.textContent = '点击“刷新状态”重试';
      desktopAgentControlsAvailable = false;
      document.getElementById('desktopAgentStart').disabled = true;
      document.getElementById('desktopAgentSubmit').disabled = true;
      document.getElementById('desktopAgentStop').disabled = true;
    } finally {
      desktopAgentStatusAt = Date.now();
    }
  })();
  desktopAgentStatusRequest = request;
  try { await request; } finally { if (desktopAgentStatusRequest === request) desktopAgentStatusRequest = null; }
}

// DSH 持久会话事件预览使用稳定的 throughSeq 分页，刷新时重新从最新游标读取。
const desktopAgentHistoryState = {
  sessionId: '',
  throughSeq: null,
  beforeSeq: null,
  hasMore: false,
  loadedCount: 0,
  loading: false
};

function setDesktopAgentHistoryStatus(text, isError = false) {
  const status = document.getElementById('desktopAgentHistoryStatus');
  status.textContent = text;
  status.className = isError ? 'meta err' : 'meta';
}

function renderDesktopAgentHistory(records, prepend = false) {
  const box = document.getElementById('desktopAgentHistory');
  if (!prepend) box.replaceChildren();
  if (!records.length && !prepend && !box.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = '当前会话还没有持久事件';
    const detail = document.createElement('p');
    detail.textContent = '会话开始后，消息和回合事件会显示在这里。';
    empty.append(title, detail);
    box.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const record of records) {
    const event = record?.event && typeof record.event === 'object' ? record.event : {};
    const details = document.createElement('details');
    details.className = 'context-record';
    if (event.type === 'user/message' || event.type === 'assistant/message') details.open = true;

    const summary = document.createElement('summary');
    const sequence = document.createElement('span');
    sequence.className = 'context-record-seq';
    sequence.textContent = Number.isSafeInteger(record.seq) ? `#${record.seq}` : '#?';
    const type = document.createElement('span');
    type.className = 'context-record-type';
    type.textContent = String(event.type ?? '未知事件');
    summary.append(sequence, type);
    const eventData = event.data && typeof event.data === 'object' ? event.data : {};
    const metaParts = [];
    if (eventData.turn !== undefined) metaParts.push(`turn ${eventData.turn}`);
    if (eventData.step !== undefined) metaParts.push(`step ${eventData.step}`);
    if (metaParts.length) {
      const meta = document.createElement('span');
      meta.className = 'context-record-meta';
      meta.textContent = metaParts.join(' · ');
      summary.appendChild(meta);
    }
    details.appendChild(summary);

    const body = document.createElement('pre');
    body.className = 'context-record-body';
    body.textContent = JSON.stringify(event, null, 2);
    details.appendChild(body);
    if (record.hiddenInternalItems > 0 || record.internalDetailsOmitted) {
      const note = document.createElement('span');
      note.className = 'context-record-note';
      note.textContent = record.internalDetailsOmitted
        ? '该模型内部事件的详细内容未展示。'
        : `已隐藏 ${record.hiddenInternalItems} 项推理内容或流式数据。`;
      details.appendChild(note);
    }
    fragment.appendChild(details);
  }
  if (prepend) box.insertBefore(fragment, box.firstChild);
  else box.appendChild(fragment);
}

async function loadDesktopAgentHistory(loadOlder = false) {
  const refreshButton = document.getElementById('desktopAgentHistoryRefresh');
  const olderButton = document.getElementById('desktopAgentHistoryOlder');
  if (desktopAgentHistoryState.loading) return;
  if (loadOlder && (!desktopAgentHistoryState.sessionId || desktopAgentHistoryState.throughSeq === null
    || desktopAgentHistoryState.beforeSeq === null || !desktopAgentHistoryState.hasMore)) return;

  desktopAgentHistoryState.loading = true;
  refreshButton.disabled = true;
  olderButton.disabled = true;
  setDesktopAgentHistoryStatus(loadOlder ? '正在读取更早记录…' : '正在读取当前会话…');
  try {
    const historyBox = document.getElementById('desktopAgentHistory');
    const previousScrollTop = historyBox.scrollTop;
    const previousScrollHeight = historyBox.scrollHeight;
    const query = new URLSearchParams({ limit: '8' });
    if (loadOlder) {
      query.set('sessionId', desktopAgentHistoryState.sessionId);
      query.set('throughSeq', String(desktopAgentHistoryState.throughSeq));
      query.set('beforeSeq', String(desktopAgentHistoryState.beforeSeq));
    }
    const result = await api('/api/console/desktop-agent/history?' + query.toString());
    if (!result.ok) {
      setDesktopAgentHistoryStatus(result.error || '读取会话记录失败', true);
      return;
    }
    const records = Array.isArray(result.records) ? result.records : [];
    if (loadOlder && (result.sessionId !== desktopAgentHistoryState.sessionId
      || result.throughSeq !== desktopAgentHistoryState.throughSeq)) {
      setDesktopAgentHistoryStatus('当前会话或历史游标已变化，请刷新记录', true);
      return;
    }
    if (!loadOlder) {
      desktopAgentHistoryState.sessionId = String(result.sessionId ?? '');
      desktopAgentHistoryState.throughSeq = Number.isSafeInteger(result.throughSeq) ? result.throughSeq : null;
      desktopAgentHistoryState.loadedCount = 0;
      renderDesktopAgentHistory(records, false);
    } else {
      renderDesktopAgentHistory(records, true);
    }
    desktopAgentHistoryState.loadedCount += records.length;
    desktopAgentHistoryState.beforeSeq = Number.isSafeInteger(result.nextBeforeSeq) ? result.nextBeforeSeq : null;
    desktopAgentHistoryState.hasMore = result.hasMore === true && desktopAgentHistoryState.beforeSeq !== null;
    historyBox.scrollTop = loadOlder
      ? previousScrollTop + (historyBox.scrollHeight - previousScrollHeight)
      : historyBox.scrollHeight;
    olderButton.hidden = !desktopAgentHistoryState.hasMore;
    const cursor = desktopAgentHistoryState.throughSeq === null ? '未知' : `seq ${desktopAgentHistoryState.throughSeq}`;
    setDesktopAgentHistoryStatus(`已加载 ${desktopAgentHistoryState.loadedCount} 条事件 · 最新游标 ${cursor}${desktopAgentHistoryState.hasMore ? ' · 还有更早记录' : ''}`);
  } catch (error) {
    setDesktopAgentHistoryStatus('读取失败：' + (error?.message || '请求失败'), true);
  } finally {
    desktopAgentHistoryState.loading = false;
    refreshButton.disabled = false;
    olderButton.disabled = !desktopAgentHistoryState.hasMore;
  }
}

document.getElementById('roleSet').addEventListener('click', async () => {
  const r = await api('/api/role', 'POST', { role: document.getElementById('roleInput').value.trim() });
  if (r.ok) {
    setRoleMsg(r.role
      ? `已选择「${r.role}」。当前人格卡会放入 DSH persona 固定前缀，下次模型请求时更新。`
      : '已清除人格卡选择；下次模型请求时 persona 前缀恢复为通用陪伴者定位。', true);
    refreshRoles();
  } else alert(r.error || '设置失败');
});
document.getElementById('roleClear').addEventListener('click', async () => {
  const r = await api('/api/role', 'POST', { role: null });
  setRoleMsg(r.ok ? '已清除人格卡选择；下次模型请求时 persona 前缀恢复为通用陪伴者定位。' : (r.error || '清除失败'), r.ok);
  refreshRoles();
  refresh();
});
document.getElementById('roleCreate').addEventListener('click', async () => {
  const name = document.getElementById('newRoleName').value.trim();
  const content = document.getElementById('newRoleContent').value;
  if (!name) { setRoleMsg('请先填人格名', false); return; }
  const editing = roleEditorState.mode === 'edit';
  const exists = roleCache.some((role) => role.name === name);
  // 编辑模式下改了名字 → 先重命名文件，再保存内容
  if (editing && roleEditorState.name !== name) {
    const renamed = await api('/api/roles/rename', 'POST', { from: roleEditorState.name, to: name });
    if (!renamed.ok) { setRoleMsg('❌ ' + (renamed.error || '重命名失败'), false); return; }
  }
  const endpoint = editing || exists ? '/api/roles/update' : '/api/roles/create';
  const r = await api(endpoint, 'POST', { name, content });
  const stats = `${Number(r.chars ?? roleCharCount(content)).toLocaleString()} 字符，约 ${Number(r.estimatedTokens ?? estimateRoleTokens(content)).toLocaleString()} tokens`;
  const softNote = (r.warnings || []).length ? ` ${r.warnings.join('；')}` : '';
  setRoleMsg(r.ok ? `✅ 已完整保存「${name}」（${stats}）。如果是当前人格卡，下一次模型请求会载入更新后的内容。${softNote}` : ('❌ ' + (r.error || '失败')), r.ok);
  if (r.ok) {
    roleEditorState = { mode: 'edit', name };
    updateRoleEditorWarnings();
    await refreshRoles();
  }
});
document.getElementById('roleDuplicate').addEventListener('click', async () => {
  const source = document.getElementById('newRoleName').value.trim();
  const content = document.getElementById('newRoleContent').value;
  const target = (prompt('把当前内容另存为新的人格，名称：', source ? source + '-副本' : '') || '').trim();
  if (!target) return;
  const r = await api('/api/roles/create', 'POST', { name: target, content });
  if (!r.ok) { setRoleMsg('❌ ' + (r.error || '另存失败'), false); return; }
  document.getElementById('newRoleName').value = target;
  roleEditorState = { mode: 'edit', name: target };
  renderRoleEditor();
  const stats = `${Number(r.chars ?? roleCharCount(content)).toLocaleString()} 字符，约 ${Number(r.estimatedTokens ?? estimateRoleTokens(content)).toLocaleString()} tokens`;
  const softNote = (r.warnings || []).length ? ` ${r.warnings.join('；')}` : '';
  setRoleMsg(`✅ 已完整另存为「${target}」（${stats}）。${softNote}`, true);
  updateRoleEditorWarnings();
  refreshRoles();
});
document.getElementById('roleDelete').addEventListener('click', async () => {
  const name = document.getElementById('newRoleName').value.trim();
  if (!name) { setRoleMsg('请先选择或填写要删除的人格名', false); return; }
  if (!confirm(`确定删除人格「${name}」？该操作不可撤销（roles/${name}.md）。`)) return;
  const r = await api('/api/roles/delete', 'POST', { name });
  if (!r.ok) { setRoleMsg('❌ ' + (r.error || '删除失败'), false); return; }
  resetRoleForm();
  setRoleMsg(r.clearedCurrent ? `已删除「${name}」，并清除了当前启用的人格` : `已删除「${name}」`, true);
  refreshRoles();
  refresh();
});
document.getElementById('roleFormReset').addEventListener('click', () => resetRoleForm());
document.getElementById('newRoleContent').addEventListener('input', updateRoleEditorWarnings);

// ── 全局陪伴者提示词 ──────────────────────────────────────────────────────
document.getElementById('desktopPromptEdit').addEventListener('click', () => {
  setSimEditing(true);
  setSimMsg('编辑中：可修改模块正文和开关，也可逐个添加自定义模块。必要模块保持启用。');
});
document.getElementById('desktopPromptAddModule').addEventListener('click', addCustomPromptModule);
document.getElementById('desktopPromptCancel').addEventListener('click', () => {
  renderPromptModules(desktopPromptOriginalModules);
  setSimEditing(false);
  setSimMsg('已放弃修改');
});
document.getElementById('desktopPromptSave').addEventListener('click', async () => {
  const modules = collectPromptModules();
  const invalidCustom = modules.find((module) => module.custom
    && (!String(module.title || '').trim() || String(module.title).trim().length > 80
      || (module.enabled && !String(module.content || '').trim())));
  if (invalidCustom) {
    setSimMsg(!String(invalidCustom.title || '').trim()
      ? '请填写自定义模块名称。'
      : String(invalidCustom.title).trim().length > 80
        ? '自定义模块名称不能超过 80 个字符。'
        : `请填写「${invalidCustom.title}」的正文，或先关闭该模块。`, false);
    return;
  }
  const activeContent = updatePromptPreview();
  const changesActivePrompt = activeContent !== desktopPromptOriginalContent;
  const confirmText = changesActivePrompt
    ? '保存会更新陪伴者的固定前缀。重启 DSH 并重建全局会话后加载新版。确定继续？'
    : '保存模块设置。当前启用的固定前缀不变，因此无需重启 DSH。确定继续？';
  if (!confirm(confirmText)) return;
  setSimMsg('保存中…');
  const r = await api('/api/preset/desktop-agent-prompt/modules', 'POST', { preset: desktopPromptPreset, modules });
  if (!r.ok) { setSimMsg('❌ ' + (r.error || '保存失败'), false); return; }
  if (r.unchanged) {
    setSimEditing(false);
    setSimMsg('模块没有变化，未写入文件', true);
    return;
  }
  desktopPromptOriginalModules = (r.modules || modules).map((module) => ({ ...module }));
  desktopPromptOriginalContent = r.content || activeContent;
  renderPromptModules(desktopPromptOriginalModules);
  setSimEditing(false);
  setSimMsg(r.requiresRestart
    ? `✅ 已保存${r.synced ? '并更新 DSH 配置包' : ''}；重启 DSH 并重建全局会话后加载新版`
    : '✅ 已保存未启用模块的正文；当前固定前缀未变化', true);
  document.getElementById('desktopPromptWarnings').textContent = (r.warnings || []).length ? '⚠️ ' + r.warnings.join('；') : '';
  document.getElementById('desktopPromptStatus').textContent = `陪伴者 · ${r.chars} 字符 · 已保存`;
});
document.getElementById('desktopPromptRestore').addEventListener('click', async () => {
  if (!confirm('还原陪伴者上次保存前的模块和固定前缀？当前改动会丢失（现有配置会先自动备份）。')) return;
  const r = await api('/api/preset/desktop-agent-prompt/restore', 'POST', { preset: desktopPromptPreset });
  if (!r.ok) { setSimMsg('❌ ' + (r.error || '还原失败'), false); return; }
  setSimMsg('✅ 已还原模块和提示词备份；重启 DSH 并重建全局会话后加载新版', true);
  refreshSimPrompt();
});
document.getElementById('desktopAgentHistoryRefresh').addEventListener('click', () => loadDesktopAgentHistory(false));
document.getElementById('desktopAgentHistoryOlder').addEventListener('click', () => loadDesktopAgentHistory(true));

// ── DSH 思考强度 ────────────────────────────────────────────────────────────
async function saveDshModel(provider, model, reasoningEffort, msg) {
  const cleanProvider = String(provider ?? '').trim();
  const cleanModel = String(model ?? '').trim();
  if (!cleanProvider || !cleanModel) {
    msg.textContent = '❌ Provider ID 和 Model ID 都不能为空';
    msg.className = 'meta err';
    return;
  }
  msg.textContent = '保存中…';
  msg.className = 'meta';
  const r = await api('/api/dsh/model', 'POST', {
    provider: cleanProvider,
    model: cleanModel,
    reasoningEffort: String(reasoningEffort ?? '').trim() || document.getElementById('dshEffortSelect').value
  });
  if (!r.ok) {
    msg.textContent = '❌ ' + (r.error || '保存失败');
    msg.className = 'meta err';
    return;
  }
  await refreshDshModel();
  msg.textContent = `✅ 已设为 ${r.provider}/${r.model}（${r.reasoningEffort}），下一条消息生效`;
  msg.className = 'meta ok';
}

document.getElementById('dshModelSelect').addEventListener('change', () => {
  const index = Number(document.getElementById('dshModelSelect').value);
  const item = Number.isInteger(index) ? dshModelOptions[index] : null;
  if (!item) return;
  const current = document.getElementById('dshEffortSelect').value;
  const efforts = item.reasoningEfforts?.length ? item.reasoningEfforts : dshEffortFallbackOptions;
  populateDshEfforts(efforts, item.reasoningLabels, current, item.defaultEffort);
  document.getElementById('dshEffortNote').textContent = item.effortSource === 'dsh' && item.reasoningEfforts?.length
    ? `档位取自 ${item.providerName || item.provider} / ${item.modelName || item.model} 在 DSH 公布的能力；不支持当前档位时已选该模型默认值或首个可用值。`
    : 'DSH 未公布该模型的思考档位，暂用内置回退清单；也可在手动设置中填写 DSH 档位 ID。';
  document.getElementById('dshModelMsg').textContent = '模型尚未保存；保存后下一条消息生效。';
  document.getElementById('dshModelMsg').className = 'meta';
});

document.getElementById('dshModelRefresh').addEventListener('click', async () => {
  const button = document.getElementById('dshModelRefresh');
  button.disabled = true;
  button.textContent = '读取中…';
  await refreshDshModel();
  button.disabled = false;
  button.textContent = '刷新目录';
});

document.getElementById('dshModelSave').addEventListener('click', async () => {
  const modelSelect = document.getElementById('dshModelSelect');
  const selectedValue = modelSelect.value;
  const index = selectedValue === '' ? -1 : Number(selectedValue);
  const item = !modelSelect.disabled && Number.isInteger(index) ? dshModelOptions[index] : null;
  if (!item) {
    const msg = document.getElementById('dshModelMsg');
    msg.textContent = '请先从目录选择模型，或使用手动填写';
    msg.className = 'meta err';
    return;
  }
  await saveDshModel(item.provider, item.model, document.getElementById('dshEffortSelect').value, document.getElementById('dshModelMsg'));
});

document.getElementById('dshModelManualSave').addEventListener('click', async () => {
  const manualEffort = document.getElementById('dshEffortInput').value.trim();
  await saveDshModel(
    document.getElementById('dshProviderInput').value,
    document.getElementById('dshModelInput').value,
    manualEffort || document.getElementById('dshEffortSelect').value,
    document.getElementById('dshModelMsg')
  );
});

document.getElementById('dshEffortSave').addEventListener('click', async () => {
  const effort = document.getElementById('dshEffortSelect').value;
  const msg = document.getElementById('dshEffortMsg');
  msg.textContent = '保存中…';
  msg.className = 'meta';
  const r = await api('/api/dsh/effort', 'POST', { reasoningEffort: effort });
  if (r.ok) {
    await refreshDshModel();
    msg.textContent = `✅ 已设为 ${r.reasoningEffort}，下一条消息生效`;
    msg.className = 'meta ok';
  } else {
    msg.textContent = '❌ ' + (r.error || '保存失败');
    msg.className = 'meta err';
  }
});
document.getElementById('wlSave').addEventListener('click', async () => {
  const parse = (s) => s.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  const r = await api('/api/whitelist', 'POST', {
    allow: { private: parse(document.getElementById('wlPrivate').value), groups: parse(document.getElementById('wlGroups').value) },
    deny: { private: parse(document.getElementById('dnPrivate').value), groups: parse(document.getElementById('dnGroups').value) },
    ownerQQ: document.getElementById('ownerQQ').value.trim()
  });
  if (r.ok) { refreshWhitelist(); refresh(); alert('白名单已保存并生效'); }
  else alert(r.error || '保存失败');
});
document.getElementById('tsSend').addEventListener('click', async () => {
  const r = await api('/api/test-send', 'POST', {
    kind: document.getElementById('tsKind').value,
    id: document.getElementById('tsId').value.trim(),
    message: document.getElementById('tsMsg').value
  });
  document.getElementById('tsMsg2').textContent = r.ok ? ('✅ 已发送 message_id=' + r.message_id) : ('❌ ' + (r.error || '失败'));
  document.getElementById('tsMsg2').className = r.ok ? 'meta ok' : 'meta err';
});
document.getElementById('restartBtn').addEventListener('click', async () => {
  if (!confirm('确定重启桥接？')) return;
  const r = await api('/api/restart', 'POST', {});
  document.getElementById('restartMsg').textContent = r.message || '正在重启…';
});
document.getElementById('desktopAgentRefresh').addEventListener('click', async () => {
  const button = document.getElementById('desktopAgentRefresh');
  button.disabled = true;
  try { await refreshDesktopAgentStatus(true); } finally { button.disabled = false; }
});
document.getElementById('desktopAgentStart').addEventListener('click', async () => {
  const button = document.getElementById('desktopAgentStart');
  const status = document.getElementById('desktopAgentMessageStatus');
  const task = document.getElementById('desktopAgentMessage').value.trim();
  const message = task ?
    `请按当前角色优先处理这项任务：\n${task}\n\n完成后只在有自然且有价值的下一步时继续；没有就结束行动。每个主动回合结束前都必须调用 agent_rest 并将它作为最后一个工具调用，自行选择休息时长；不要用长等待工具维持会话在线，也不要做周期性心跳。`
    : '请按当前人格卡在这个长期会话里自然活动。你可以从电脑上看到的线索、QQ 提醒、其他可用工具或之前聊到的事情里，挑一件你真感兴趣或觉得有用的事；也可以判断现在没什么想做的，直接结束行动。不要为了证明自主而反复巡查、制造目标或汇报每一步。每个主动回合结束前都必须调用 agent_rest 并将它作为最后一个工具调用，自行选择休息时长；不要用长等待工具维持会话在线，也不要做周期性心跳。';
  button.disabled = true;
  status.textContent = '正在启动自主探索…';
  status.className = 'meta';
  try {
    const result = await api('/api/console/desktop-agent', 'POST', { message });
    status.textContent = result.ok ? `✅ 自主探索已启动：${result.sessionId}` : ('❌ ' + (result.error || '启动失败'));
    status.className = result.ok ? 'meta ok' : 'meta err';
    desktopAgentStatusAt = 0;
    await refreshDesktopAgentStatus(true);
  } catch (error) {
    status.textContent = '❌ ' + (error?.message || '启动失败');
    status.className = 'meta err';
  } finally {
    desktopAgentStatusAt = 0;
    await refreshDesktopAgentStatus(true);
  }
});
document.getElementById('desktopAgentStop').addEventListener('click', async () => {
  if (!confirm('停止全局陪伴者？当前运行和排队中的 DSH 任务会被取消；自动唤醒会保持关闭，直到你从此页面手动启动或提交任务。')) return;
  const button = document.getElementById('desktopAgentStop');
  const status = document.getElementById('desktopAgentMessageStatus');
  button.disabled = true;
  status.textContent = '正在停止并取消当前任务…';
  status.className = 'meta';
  try {
    const result = await api('/api/console/desktop-agent/stop', 'POST', {});
    status.textContent = result.cancelled
      ? '✅ 已停止并取消当前/排队任务；再次手动启动即可恢复。'
      : `✅ 已设置持久停止态${result.error ? `；DSH 取消未确认：${result.error}` : !result.dshReady ? '；DSH 当前不可用，恢复连接后会重申停止' : '；当前没有可取消的 DSH 任务'}`;
    status.className = result.error ? 'meta err' : 'meta ok';
  } catch (error) {
    status.textContent = '❌ ' + (error?.message || '停止失败');
    status.className = 'meta err';
  } finally {
    desktopAgentStatusAt = 0;
    await refreshDesktopAgentStatus(true);
  }
});
document.getElementById('desktopAgentRebuild').addEventListener('click', async () => {
  if (!confirm('将归档当前全局 DSH 会话并创建一个新会话，以加载 DSH 刚载入的 desktop-agent 提示词。会话历史仍保留在 DSH 中。继续吗？')) return;
  const button = document.getElementById('desktopAgentRebuild');
  const status = document.getElementById('desktopAgentMessageStatus');
  button.disabled = true;
  status.textContent = '正在重建全局陪伴者会话…';
  status.className = 'meta';
  try {
    const result = await api('/api/console/desktop-agent/reset', 'POST', {});
    status.textContent = result.ok
      ? `✅ 新会话已创建：${result.sessionId}${result.archivedSessionId ? `；旧历史已归档：${result.archivedSessionId}` : ''}`
      : ('❌ ' + (result.error || '重建失败'));
    status.className = result.ok ? 'meta ok' : 'meta err';
    desktopAgentStatusAt = 0;
    await refreshDesktopAgentStatus(true);
  } catch (error) {
    status.textContent = '❌ ' + (error?.message || '重建失败');
    status.className = 'meta err';
  } finally {
    button.disabled = false;
  }
});
document.getElementById('desktopAgentSubmit').addEventListener('click', async () => {
  const message = document.getElementById('desktopAgentMessage').value.trim();
  const button = document.getElementById('desktopAgentSubmit');
  const status = document.getElementById('desktopAgentMessageStatus');
  if (!message) { status.textContent = '请填写任务，或使用“启动自主探索”。'; status.className = 'meta err'; return; }
  button.disabled = true;
  status.textContent = '正在提交到 DSH…';
  status.className = 'meta';
  try {
    const result = await api('/api/console/desktop-agent', 'POST', { message });
    status.textContent = result.ok ? `✅ 已提交到全局会话：${result.sessionId}` : ('❌ ' + (result.error || '提交失败'));
    status.className = result.ok ? 'meta ok' : 'meta err';
    desktopAgentStatusAt = 0;
    await refreshDesktopAgentStatus(true);
  } catch (error) {
    status.textContent = '❌ ' + (error?.message || '提交失败');
    status.className = 'meta err';
  } finally {
    button.disabled = false;
  }
});
document.getElementById('desktopAgentMessage').addEventListener('input', event => {
  document.getElementById('desktopAgentSubmit').disabled = !desktopAgentControlsAvailable || !event.currentTarget.value.trim();
});
document.getElementById('desktopAgentMessage').addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    document.getElementById('desktopAgentSubmit').click();
  }
});
// ── QQ 消息通道配置 ────────────────────────────────────────────────────────
async function loadV2Config() {
  try {
    const r = await api('/api/socialV2/config');
    const c = r.config || {};
    document.getElementById('v2Enabled').checked = c.enabled !== false;
    document.getElementById('v2AttentionKeywords').value = Array.isArray(c.attentionKeywords) ? c.attentionKeywords.join('\n') : '';
    const s = c.send || {};
    document.getElementById('v2BurstEnabled').checked = s.burstEnabled !== false;
    document.getElementById('v2BurstMax').value = s.burstMaxMessages ?? 8;
    document.getElementById('v2BurstMin').value = s.burstIntervalMinMs ?? 1000;
    document.getElementById('v2BurstMaxMs').value = s.burstIntervalMaxMs ?? 3000;
    document.getElementById('v2LongGapProb').value = s.longGapProbability ?? 0.2;
    document.getElementById('v2LongGapMin').value = s.longGapMinMs ?? 5000;
    document.getElementById('v2LongGapMax').value = s.longGapMaxMs ?? 10000;
    document.getElementById('v2MaxSendMin').value = s.maxSendPerMinute ?? 8;
    document.getElementById('v2MaxSendHour').value = s.maxSendPerHour ?? 60;
    document.getElementById('v2MaxMsgChars').value = s.maxMessageChars ?? 500;
    document.getElementById('v2MaxGapMs').value = s.maxGapMs ?? 10000;
    document.getElementById('v2GapBaseMs').value = s.gapBaseMs ?? 800;
    document.getElementById('v2GapPerCharMs').value = s.gapPerCharMs ?? 20;
    document.getElementById('v2SendHint').value = s.recommendedHint || '';
    const wt = c.wait || {};
    document.getElementById('v2WaitDefaultMs').value = wt.defaultMs ?? 30000;
    document.getElementById('v2WaitMinMs').value = wt.minMs ?? 5000;
    document.getElementById('v2WaitMaxMs').value = wt.maxMs ?? 600000;
    document.getElementById('v2WaitDefaultQuietMs').value = wt.defaultQuietMs ?? 8000;
    document.getElementById('v2MinQuietAfterNewMs').value = wt.minQuietAfterNewMs ?? 10000;
    const stk = c.sticker || {};
    document.getElementById('v2StickerEnabled').checked = stk.enabled !== false;
    document.getElementById('v2StickerSyncTtlSec').value = Math.round((stk.syncTtlMs || 60000) / 1000);
    document.getElementById('v2StickerMaxList').value = stk.maxListCount ?? 100;
    const stkCollect = stk.collect || {};
    document.getElementById('v2StickerCollectEnabled').checked = stkCollect.enabled !== false;
    document.getElementById('v2StickerCollectPerMin').value = stkCollect.maxPerMinute ?? 2;
    document.getElementById('v2StickerCollectPerHour').value = stkCollect.maxPerHour ?? 10;
    const ctx = c.context || {};
    document.getElementById('v2ContextRecentLimit').value = ctx.recentLimit ?? 100;
    document.getElementById('v2ContextUnreadLimit').value = ctx.unreadLimit ?? 30;
    document.getElementById('v2ContextWindow').value = ctx.contextWindow ?? 20;
    const fb = c.feedback || {};
    document.getElementById('v2FeedbackMaxLength').value = fb.maxLength ?? 500;
    document.getElementById('v2FeedbackNotifyOwner').checked = fb.notifyOwnerOnError === true;
  } catch {}
}

async function saveV2Config() {
  const body = {
    enabled: document.getElementById('v2Enabled').checked,
    attentionKeywords: document.getElementById('v2AttentionKeywords').value
      .split(/[\r\n,，]+/)
      .map(value => value.trim())
      .filter(Boolean),
    send: {
      burstEnabled: document.getElementById('v2BurstEnabled').checked,
      burstMaxMessages: Math.round(Number(document.getElementById('v2BurstMax').value) || 8),
      burstIntervalMinMs: Math.round(Number(document.getElementById('v2BurstMin').value) || 1000),
      burstIntervalMaxMs: Math.round(Number(document.getElementById('v2BurstMaxMs').value) || 3000),
      longGapProbability: Number(document.getElementById('v2LongGapProb').value) || 0,
      longGapMinMs: Math.round(Number(document.getElementById('v2LongGapMin').value) || 5000),
      longGapMaxMs: Math.round(Number(document.getElementById('v2LongGapMax').value) || 10000),
      maxSendPerMinute: Math.round(Number(document.getElementById('v2MaxSendMin').value) || 0),
      maxSendPerHour: Math.round(Number(document.getElementById('v2MaxSendHour').value) || 0),
      maxMessageChars: Math.round(Number(document.getElementById('v2MaxMsgChars').value) || 500),
      maxGapMs: Math.round(Number(document.getElementById('v2MaxGapMs').value) || 10000),
      gapBaseMs: Math.round(Number(document.getElementById('v2GapBaseMs').value) || 800),
      gapPerCharMs: Math.round(Number(document.getElementById('v2GapPerCharMs').value) || 20),
      recommendedHint: document.getElementById('v2SendHint').value
    },
    wait: {
      defaultMs: Math.round(Number(document.getElementById('v2WaitDefaultMs').value) || 5000),
      minMs: Math.round(Number(document.getElementById('v2WaitMinMs').value) || 1000),
      maxMs: Math.round(Number(document.getElementById('v2WaitMaxMs').value) || 10000),
      defaultQuietMs: Number.isFinite(Number(document.getElementById('v2WaitDefaultQuietMs').value)) ? Math.max(0, Math.round(Number(document.getElementById('v2WaitDefaultQuietMs').value))) : 8000,
      minQuietAfterNewMs: Number.isFinite(Number(document.getElementById('v2MinQuietAfterNewMs').value)) ? Math.max(0, Math.round(Number(document.getElementById('v2MinQuietAfterNewMs').value))) : 10000
    },
    sticker: {
      enabled: document.getElementById('v2StickerEnabled').checked,
      syncTtlMs: Math.max(1000, Math.round(Number(document.getElementById('v2StickerSyncTtlSec').value) || 60) * 1000),
      maxListCount: Math.min(500, Math.max(1, Math.round(Number(document.getElementById('v2StickerMaxList').value) || 100))),
      collect: {
        enabled: document.getElementById('v2StickerCollectEnabled').checked,
        maxPerMinute: Math.max(0, Math.round(Number(document.getElementById('v2StickerCollectPerMin').value) || 0)),
        maxPerHour: Math.max(0, Math.round(Number(document.getElementById('v2StickerCollectPerHour').value) || 0))
      }
    },
    context: {
      recentLimit: Math.round(Number(document.getElementById('v2ContextRecentLimit').value) || 100),
      unreadLimit: Math.round(Number(document.getElementById('v2ContextUnreadLimit').value) || 30),
      contextWindow: Math.round(Number(document.getElementById('v2ContextWindow').value) || 20)
    },
    feedback: {
      maxLength: Math.round(Number(document.getElementById('v2FeedbackMaxLength').value) || 500),
      notifyOwnerOnError: document.getElementById('v2FeedbackNotifyOwner').checked
    }
  };
  const r = await api('/api/socialV2/config', 'POST', body);
  const msg = document.getElementById('v2ConfigMsg');
  msg.textContent = r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadV2Config();
}

function v2ToolLogStatus(entry) {
  if (entry.type === 'result') {
    const ok = entry.ok !== false;
    return `<span class="pill ${ok ? 'g' : 'r'}">${ok ? '成功' : '失败'}</span>`;
  }
  return '<span class="pill b">调用</span>';
}
function summarizeToolArgs(tool, args) {
  let obj = args;
  if (typeof args === 'string') {
    try { obj = JSON.parse(args); } catch { return args || ''; }
  }
  if (!obj || typeof obj !== 'object') return String(obj ?? '');
  const parts = [];
  const push = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    parts.push(`${k}=${v}`);
  };
  const t = String(tool || '');
  if (t.includes('qq_wait_for_messages')) {
    push('timeoutMs', obj.timeoutMs != null ? obj.timeoutMs : '默认30000');
    push('minNewMessages', obj.minNewMessages != null ? obj.minNewMessages : 1);
    push('quietMs', obj.quietMs != null ? obj.quietMs : '默认8000');
  } else if (t.includes('qq_send_message')) {
    const msgs = Array.isArray(obj.messages) ? obj.messages : (obj.messages != null ? [obj.messages] : []);
    push('条数', msgs.length);
    if (msgs.length) push('首条', String(msgs[0]).slice(0, 30));
    push('gapMode', obj.gapMode || 'auto');
    if (obj.gapMs != null) push('gapMs', obj.gapMs);
    if (Array.isArray(obj.gaps) && obj.gaps.length) push('gaps', obj.gaps.join(','));
    if (obj.replyToMessageId != null && obj.replyToMessageId !== '') push('引用id', obj.replyToMessageId);
  } else if (t.includes('qq_send_burst')) {
    const msgs = Array.isArray(obj.messages) ? obj.messages : [];
    push('条数', msgs.length);
    if (msgs.length) push('首条', String(msgs[0]).slice(0, 30));
  } else if (t.includes('qq_send_poke')) {
    push('key', obj.key);
    if (obj.targetUserId != null && obj.targetUserId !== '') push('target', obj.targetUserId);
  } else if (t.includes('qq_get_forward_msg')) {
    push('key', obj.key);
    if (obj.id != null && obj.id !== '') push('id', String(obj.id).slice(0, 40));
  } else if (t.includes('qq_mark_read')) {
    push('key', obj.key);
  } else if (t.includes('qq_get_unread_messages') || t.includes('qq_get_recent_messages') || t.includes('qq_social_state') || t.includes('qq_get_my_recent_messages') || t.includes('qq_get_message_detail') || t.includes('qq_get_active_members')) {
    push('key', obj.key);
    if (obj.messageId != null) push('messageId', obj.messageId);
    if (obj.limit != null) push('limit', obj.limit);
  } else {
    push('key', obj.key);
  }
  return parts.join(' | ') || JSON.stringify(obj);
}
function v2ToolLogCell(value, tool) {
  const text = value == null ? '' : String(value);
  if (!text) return '<span class="meta">-</span>';
  const summary = tool ? summarizeToolArgs(tool, text) : text;
  const short = summary.length > 100 ? summary.slice(0, 100) + '…' : summary;
  return `<span class="tool-log-cell" data-full="${esc(text)}" data-short="${esc(short)}" title="点击查看完整 JSON">${esc(short)}</span>`;
}
function renderV2ToolLog(entries) {
  const box = document.getElementById('v2ToolLogOutput');
  const list = entries || [];
  if (!list.length) { box.innerHTML = '<span class="meta">（空）</span>'; return; }
  let html = '<table><tr><th>时间</th><th>会话 key</th><th>工具名</th><th>状态</th><th>参数</th><th>错误信息</th></tr>';
  for (const e of list) {
    const time = e.time ? new Date(e.time).toLocaleString() : '-';
    const key = esc(e.key || '');
    const tool = esc(e.tool || '-');
    const status = v2ToolLogStatus(e);
    const params = e.type === 'call' ? v2ToolLogCell(e.args, e.tool) : '<span class="meta">-</span>';
    const error = e.type === 'result' ? v2ToolLogCell(e.error) : '<span class="meta">-</span>';
    html += `<tr><td>${esc(time)}</td><td>${key}</td><td>${tool}</td><td>${status}</td><td>${params}</td><td>${error}</td></tr>`;
  }
  html += '</table>';
  box.innerHTML = html;
}
function loadV2ToolLog() {
  return api('/api/socialV2/tool-log?limit=200')
    .then(r => { renderV2ToolLog(r.entries || []); })
    .catch(() => { renderV2ToolLog([]); });
}
document.getElementById('v2ToolLogOutput').addEventListener('click', (ev) => {
  const cell = ev.target.closest('.tool-log-cell');
  if (!cell) return;
  const full = cell.dataset.full;
  const short = cell.dataset.short;
  if (cell.classList.contains('expanded')) {
    cell.classList.remove('expanded');
    cell.textContent = short;
  } else {
    cell.classList.add('expanded');
    cell.textContent = full;
  }
});

document.getElementById('v2ConfigSave').addEventListener('click', saveV2Config);
async function refreshV2Activity() {
  try {
    const r = await api('/api/socialV2/activity');
    const el = document.getElementById('v2ActivityStatus');
    el.textContent = r.paused ? '已暂停' : '运行中';
    el.className = r.paused ? 'meta err' : 'meta ok';
  } catch {}
}
document.getElementById('v2PauseBtn').addEventListener('click', async () => {
  await api('/api/socialV2/activity', 'POST', { paused: true });
  refreshV2Activity();
});
document.getElementById('v2ResumeBtn').addEventListener('click', async () => {
  await api('/api/socialV2/activity', 'POST', { paused: false });
  refreshV2Activity();
});
document.getElementById('v2ResetBtn').addEventListener('click', async () => {
  if (!confirm('确定清空本地 QQ 消息缓存、读取水位和待处理 QQ 提醒？全局陪伴者会话和运行状态不会改变。')) return;
  const r = await api('/api/socialV2/reset', 'POST', {});
  const msg = document.getElementById('v2ConfigMsg');
  msg.textContent = r.ok ? '✅ 已清空 QQ 消息缓存' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) document.getElementById('v2AllStatesOutput').textContent = '（空）';
});
document.getElementById('v2StatesList').addEventListener('click', async () => {
  const r = await api('/api/socialV2/states');
  document.getElementById('v2AllStatesOutput').textContent = JSON.stringify(r.conversations || [], null, 2);
});
document.getElementById('v2FeedbackLoad').addEventListener('click', async () => {
  const r = await api('/api/socialV2/feedback');
  document.getElementById('v2FeedbackOutput').textContent = JSON.stringify(r.entries || [], null, 2);
});
document.getElementById('v2FeedbackClear').addEventListener('click', async () => {
  if (!confirm('确定清空全部 AI 反馈？')) return;
  const r = await api('/api/socialV2/feedback-clear', 'POST', {});
  const msg = document.getElementById('v2FeedbackMsg');
  msg.textContent = r.ok ? '✅ 已清空' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) document.getElementById('v2FeedbackOutput').textContent = '（空）';
});
document.getElementById('v2ToolLogLoad').addEventListener('click', async () => {
  const msg = document.getElementById('v2ToolLogMsg');
  msg.textContent = '';
  await loadV2ToolLog();
});
document.getElementById('v2ToolLogClear').addEventListener('click', async () => {
  if (!confirm('确定清空全部工具调用日志？')) return;
  const r = await api('/api/socialV2/tool-log/clear', 'POST', {});
  const msg = document.getElementById('v2ToolLogMsg');
  msg.textContent = r.ok ? '✅ 已清空' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  renderV2ToolLog([]);
});

function loadSecurity() {
  api('/api/security').then(r => {
    document.getElementById('secInterceptNotify').checked = r.security?.interceptNotify !== false;
    // state/ 的 ACL 是否收紧（Windows 上需要管理员权限，未提权时会失败）。
    // 明确警示 + 给出可复制的命令，而不是让用户以为已经安全。
    const warn = document.getElementById('stateDirWarn');
    const hardened = r.stateDir?.hardened;
    if (hardened === false) {
      document.getElementById('stateDirPath').textContent = r.stateDir?.path || 'state/';
      document.getElementById('stateDirCmd').textContent = r.stateDir?.manualCommand || '';
      warn.style.display = '';
    } else {
      warn.style.display = 'none';
    }
  }).catch(() => {});
}
document.getElementById('secSave').addEventListener('click', async () => {
  const r = await api('/api/security', 'POST', { interceptNotify: document.getElementById('secInterceptNotify').checked });
  const msg = document.getElementById('secMsg');
  msg.textContent = r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadSecurity();
});
document.getElementById('stateDirReharden').addEventListener('click', async () => {
  const msg = document.getElementById('stateDirMsg');
  msg.textContent = '检测中…';
  const r = await api('/api/security', 'POST', { rehardenStateDir: true });
  msg.textContent = r.hardened === true ? '✅ 权限已收紧' : '❌ 仍未收紧（改 ACL 需要管理员权限；请按上面两种做法之一操作后复检）';
  msg.className = r.hardened === true ? 'meta ok' : 'meta err';
  loadSecurity();
});

async function changeConsoleToken(generate) {
  const input = document.getElementById('consoleTokenInput');
  const msg = document.getElementById('consoleTokenMsg');
  const token = generate ? '' : input.value.trim();
  if (!generate && token && token.length < 16) {
    msg.textContent = '❌ 令牌至少需要 16 位';
    msg.className = 'meta err';
    return;
  }
  const r = await api('/api/console/token', 'POST', { token });
  if (!r.ok) {
    msg.textContent = '❌ ' + (r.error || '修改失败');
    msg.className = 'meta err';
    return;
  }
  input.value = r.token;
  msg.textContent = r.generated ? '已生成随机令牌，当前页面已自动使用。可点击显示后复制。' : '已保存新令牌';
  msg.className = 'meta ok';
}
document.getElementById('consoleTokenSave').addEventListener('click', () => changeConsoleToken(false));
document.getElementById('consoleTokenRandom').addEventListener('click', () => changeConsoleToken(true));

// Presentation layer: keep every existing control mounted so drafts and API contracts survive navigation.
const consolePages = {
  overview: ['陪伴者', '全局陪伴者运行状态', '查看 DSH 与 QQ 通道状态，或前往会话控制启动自主探索。', '工作空间'],
  sessions: ['会话控制', '控制全局陪伴者', '启动或继续唯一的全局 DSH 会话，也可发送具体任务。', '工作空间'],
  persona: ['陪伴者提示词', '维护自主陪伴者的固定提示词', '这里可以编辑陪伴者的固定提示词和当前人格卡。', '工作空间'],
  memory: ['检索与记录', '长期记忆 · 检索与记录', '在共享 A_Memorix 中相关度检索或分页浏览全部活动原始记录，并查看、替代或删除记录。', '长期记忆'],
  'memory-settings': ['记忆设置', '长期记忆设置', '配置 A_Memorix 连接、启动摘要和 Embedding / LLM Provider。', '长期记忆'],
  'social-v2': ['提醒与消息', 'QQ 消息渠道', '查看 QQ 提醒策略、消息工具和发送安全设置。', 'QQ 通道'],
  usage: ['令牌与花费', '每一次思考，都算得清楚。', '实时查看 AI 的 token 消耗与花费，可下钻到每个群、每个好友、每一轮对话。', '系统与管理'],
  access: ['访问与安全', '明确边界，安心连接。', '管理允许对话的对象、管理员权限与控制台访问凭证。', '系统与管理'],
  operations: ['调试与运维', '让桥接，始终井然有序。', '测试消息、引导 AI，或维护桥接进程与会话工作区。', '系统与管理']
};
let memoryHits = [];
let memoryBrowseMode = false;
let memoryBrowseCursor = '';
let memoryBrowseTotal = 0;
function resetMemoryBrowsePaging() {
  memoryBrowseCursor = '';
  const container = document.getElementById('memoryLoadMoreContainer');
  const button = document.getElementById('memoryLoadMore');
  if (container) container.hidden = true;
  if (button) button.disabled = false;
}
function memoryDateInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function memoryListInput(value) {
  return Array.isArray(value) ? value.map(String).join(', ') : '';
}
function memoryListParse(value) {
  return String(value || '').split(/[\n,，]/).map(item => item.trim()).filter(Boolean).slice(0, 20);
}
async function refreshMemoryStatus() {
  const statusElements = [
    document.getElementById('memoryStatus'),
    document.getElementById('memorySettingsGatewayStatus')
  ].filter(Boolean);
  try {
    const response = await api('/api/memory/status');
    const memory = response.memory || {};
    const serviceButton = document.getElementById('memoryServiceStart');
    serviceButton.disabled = !memory.serviceInstalled;
    serviceButton.title = memory.serviceInstalled ? '' : '先在仓库根目录运行 scripts/a-memorix.ps1 setup';
    let message = '';
    if (!memory.serviceInstalled) message = '尚未安装本机 A_Memorix。先运行 scripts/a-memorix.ps1 setup，再回来启用长期记忆。';
    else if (!memory.gatewayReachable) message = `A_Memorix Gateway 未连接${memory.gatewayHealthError ? `（${memory.gatewayHealthError}）` : ''}。可点击“启动 A_Memorix”。`;
    else if (!memory.enabled) message = `A_Memorix Gateway 正常 · 长期记忆尚未启用 · namespace ${memory.namespace}`;
    else if (!memory.configured) message = `Gateway 正常，但桥接长期记忆配置不完整：${memory.error || '检查 namespace API Key'}`;
    else message = `长期记忆已启用 · Gateway 正常 · namespace ${memory.namespace} · ${memory.baseUrl}`;
    const className = `meta ${memory.serviceInstalled && memory.gatewayReachable && (!memory.enabled || memory.configured) ? 'ok' : 'err'}`;
    for (const status of statusElements) {
      status.textContent = message;
      status.className = className;
    }
  } catch (error) {
    for (const status of statusElements) {
      status.textContent = `读取状态失败：${error.message || '未知错误'}`;
      status.className = 'meta err';
    }
  }
}
async function refreshMemorySettings() {
  const status = document.getElementById('memorySettingsStatus');
  try {
    const [settingsResponse, providerResponse] = await Promise.all([
      api('/api/memory/settings'), api('/api/memory/providers')
    ]);
    if (!settingsResponse.ok) throw new Error(settingsResponse.error || '无法读取长期记忆设置');
    if (!providerResponse.ok) throw new Error(providerResponse.error || '无法读取 Provider 设置');
    const settings = settingsResponse.settings || {};
    document.getElementById('memoryEnabled').checked = settings.enabled === true;
    document.getElementById('memoryBaseUrl').value = settings.baseUrl || '';
    document.getElementById('memoryNamespace').value = settings.namespace || '';
    document.getElementById('memoryTimeoutSeconds').value = Math.round(Number(settings.timeoutMs || 45000) / 1000);
    document.getElementById('memoryBootstrapLimit').value = Number(settings.bootstrapLimit || 6);
    document.getElementById('memoryBootstrapMaxChars').value = Number(settings.bootstrapMaxChars || 2500);
    document.getElementById('memoryApiKey').value = '';
    document.getElementById('memoryClearApiKey').checked = false;
    status.textContent = settings.apiKeyConfigured ? 'namespace API Key 已保存（不回显）' : '尚未保存 namespace API Key';
    status.className = `meta ${settings.apiKeyConfigured ? 'ok' : 'err'}`;

    const providers = providerResponse.providers || {};
    const embedding = providers.embedding || {};
    const llm = providers.llm || {};
    document.getElementById('memoryEmbeddingEndpoint').value = embedding.endpoint || '';
    document.getElementById('memoryEmbeddingModel').value = embedding.model || '';
    document.getElementById('memoryEmbeddingDimension').value = Number(embedding.dimension || 1024);
    document.getElementById('memoryEmbeddingKey').value = '';
    document.getElementById('memoryEmbeddingClearKey').checked = false;
    document.getElementById('memoryEmbeddingStatus').textContent = embedding.configured
      ? `设置已保存 · ${embedding.model} · API Key ${embedding.apiKeyConfigured ? '已保存' : '未设置'}；连通性尚未探测`
      : `未配置 · API Key ${embedding.apiKeyConfigured ? '已保存' : '未设置'}`;
    document.getElementById('memoryEmbeddingStatus').className = 'meta';
    document.getElementById('memoryLlmEndpoint').value = llm.endpoint || '';
    document.getElementById('memoryLlmModel').value = llm.model || '';
    document.getElementById('memoryLlmMaxTokens').value = Number(llm.maxTokens || 8192);
    document.getElementById('memoryLlmTemperature').value = Number(llm.temperature || 0);
    document.getElementById('memoryLlmKey').value = '';
    document.getElementById('memoryLlmClearKey').checked = false;
    document.getElementById('memoryLlmStatus').textContent = llm.configured
      ? `设置已保存 · ${llm.model} · API Key ${llm.apiKeyConfigured ? '已保存' : '未设置'}；连通性尚未探测`
      : `未配置 · API Key ${llm.apiKeyConfigured ? '已保存' : '未设置'}`;
    document.getElementById('memoryLlmStatus').className = 'meta';
  } catch (error) {
    status.textContent = `读取设置失败：${error.message || '未知错误'}`;
    status.className = 'meta err';
  }
}
async function saveMemorySettings() {
  const status = document.getElementById('memorySettingsStatus');
  const button = document.getElementById('memorySettingsSave');
  button.disabled = true;
  status.textContent = '正在保存…';
  status.className = 'meta';
  try {
    const result = await api('/api/memory/settings', 'POST', {
      enabled: document.getElementById('memoryEnabled').checked,
      baseUrl: document.getElementById('memoryBaseUrl').value,
      namespace: document.getElementById('memoryNamespace').value,
      apiKey: document.getElementById('memoryApiKey').value,
      clearApiKey: document.getElementById('memoryClearApiKey').checked,
      timeoutSeconds: Number(document.getElementById('memoryTimeoutSeconds').value),
      bootstrapLimit: Number(document.getElementById('memoryBootstrapLimit').value),
      bootstrapMaxChars: Number(document.getElementById('memoryBootstrapMaxChars').value)
    });
    if (!result.ok) throw new Error(result.error || '保存失败');
    status.textContent = result.settings.apiKeyConfigured ? '连接设置已保存；密钥已保存在本机且不会回显。' : '连接设置已保存。';
    status.className = 'meta ok';
    await Promise.all([refreshMemoryStatus(), refreshMemorySettings()]);
    status.textContent = result.settings.apiKeyConfigured ? '连接设置已保存；namespace API Key 仅本机保存，不会回显。' : '连接设置已保存。';
    status.className = 'meta ok';
  } catch (error) {
    status.textContent = error.message || '保存失败';
    status.className = 'meta err';
  } finally { button.disabled = false; }
}
async function saveMemoryProviders() {
  const status = document.getElementById('memoryProviderSaveStatus');
  const button = document.getElementById('memoryProvidersSave');
  button.disabled = true;
  status.textContent = '正在校验并保存；A_Memorix 会短暂重启…';
  status.className = 'meta';
  try {
    const result = await api('/api/memory/providers', 'POST', {
      embedding: {
        endpoint: document.getElementById('memoryEmbeddingEndpoint').value,
        model: document.getElementById('memoryEmbeddingModel').value,
        apiKey: document.getElementById('memoryEmbeddingKey').value,
        clearApiKey: document.getElementById('memoryEmbeddingClearKey').checked,
        dimension: Number(document.getElementById('memoryEmbeddingDimension').value)
      },
      llm: {
        endpoint: document.getElementById('memoryLlmEndpoint').value,
        model: document.getElementById('memoryLlmModel').value,
        apiKey: document.getElementById('memoryLlmKey').value,
        clearApiKey: document.getElementById('memoryLlmClearKey').checked,
        maxTokens: Number(document.getElementById('memoryLlmMaxTokens').value),
        temperature: Number(document.getElementById('memoryLlmTemperature').value)
      }
    });
    if (!result.ok) throw new Error(result.error || 'Provider 配置保存失败');
    status.textContent = result.restarted ? 'Provider 配置已保存，A_Memorix 已重启。' : 'Provider 配置没有变化。';
    status.className = 'meta ok';
    await Promise.all([refreshMemoryStatus(), refreshMemorySettings()]);
    status.textContent = result.restarted ? 'Provider 配置已保存，A_Memorix 已重启。' : 'Provider 配置没有变化。';
    status.className = 'meta ok';
  } catch (error) {
    status.textContent = error.message || 'Provider 配置保存失败';
    status.className = 'meta err';
  } finally { button.disabled = false; }
}
async function startAMemorix() {
  const button = document.getElementById('memoryServiceStart');
  const status = document.getElementById('memorySettingsStatus');
  button.disabled = true;
  status.textContent = '正在启动 A_Memorix…';
  status.className = 'meta';
  try {
    const result = await api('/api/memory/service', 'POST', { action: 'start' });
    if (!result.ok) throw new Error(result.error || '启动失败');
    status.textContent = 'A_Memorix 已启动。';
    status.className = 'meta ok';
    await refreshMemoryStatus();
  } catch (error) {
    status.textContent = error.message || '启动失败';
    status.className = 'meta err';
  } finally { button.disabled = false; }
}
function renderMemoryResults(result, { append = false } = {}) {
  const box = document.getElementById('memoryResults');
  const incoming = Array.isArray(result?.hits) ? result.hits : [];
  if (!append) memoryHits = [];
  const startIndex = memoryHits.length;
  memoryHits.push(...incoming);
  if (!memoryHits.length) {
    box.innerHTML = '<div class="empty-state"><strong>没有匹配记录</strong><p>可以换个问法，或扩大时间范围。</p></div>';
    return;
  }
  const html = incoming.map((hit, index) => {
    const origin = hit.metadata?.origin === 'qq' ? 'QQ 对话' : hit.metadata?.origin === 'assistant' ? '自身经历' : '来源未标注';
    const title = hit.title || hit.kind || origin;
    const time = hit.observedAt || hit.metadata?.observedAt || '';
    return `<button class="memory-hit" type="button" data-memory-index="${startIndex + index}"><span class="memory-hit-head"><strong>${esc(title)}</strong><span class="tag">${esc(origin)}</span></span><span class="memory-hit-content">${esc(hit.content)}</span><span class="meta">${time ? `观察时间：${esc(new Date(time).toLocaleString())} · ` : ''}memoryId：<code>${esc(hit.memoryId)}</code></span></button>`;
  }).join('');
  if (append) box.insertAdjacentHTML('beforeend', html);
  else box.innerHTML = html;
}
async function searchMemory() {
  const status = document.getElementById('memorySearchStatus');
  const query = document.getElementById('memoryQuery').value.trim();
  const start = document.getElementById('memoryTimeStart').value;
  const end = document.getElementById('memoryTimeEnd').value;
  if (!query && !start && !end) {
    status.textContent = '请输入关键词，或设置时间范围。';
    status.className = 'meta err';
    return;
  }
  if (start && end && start > end) {
    status.textContent = '起始日期不能晚于结束日期。';
    status.className = 'meta err';
    return;
  }
  memoryBrowseMode = false;
  resetMemoryBrowsePaging();
  const mode = query
    ? (start || end ? 'SEARCH_MODE_HYBRID' : 'SEARCH_MODE_SEARCH')
    : 'SEARCH_MODE_TIME';
  status.textContent = '正在检索…';
  status.className = 'meta';
  try {
    const response = await api('/api/memory/search', 'POST', {
      query,
      origin: document.getElementById('memoryOriginFilter').value,
      mode,
      timeStart: start ? new Date(`${start}T00:00:00`).toISOString() : undefined,
      timeEnd: end ? new Date(`${end}T23:59:59.999`).toISOString() : undefined,
      limit: 50
    });
    if (!response.ok) throw new Error(response.error || '检索失败');
    const result = response.result || {};
    renderMemoryResults(result);
    const modeLabel = mode === 'SEARCH_MODE_HYBRID' ? '关键词 + 时间范围' : mode === 'SEARCH_MODE_TIME' ? '时间范围' : '关键词';
    const degradedHint = result.degraded
      ? `（检索方式：${result.retrievalMode || '降级模式'}；可到“长期记忆 → 设置”检查 Embedding Provider）`
      : '';
    status.textContent = `按${modeLabel}检索到 ${memoryHits.length} 条${degradedHint}。`;
    status.className = result.degraded ? 'meta err' : 'meta ok';
  } catch (error) {
    document.getElementById('memoryResults').innerHTML = `<div class="empty-state"><strong>检索失败</strong><p>${esc(error.message || '未知错误')}</p></div>`;
    status.textContent = error.message || '检索失败';
    status.className = 'meta err';
  }
}
async function browseAllMemory({ append = false } = {}) {
  const status = document.getElementById('memorySearchStatus');
  const browseButton = document.getElementById('memoryBrowseAll');
  const button = document.getElementById('memoryLoadMore');
  const container = document.getElementById('memoryLoadMoreContainer');
  const query = document.getElementById('memoryQuery').value.trim();
  const start = document.getElementById('memoryTimeStart').value;
  const end = document.getElementById('memoryTimeEnd').value;
  if (start && end && start > end) {
    status.textContent = '起始日期不能晚于结束日期。';
    status.className = 'meta err';
    return;
  }
  if (!append) {
    memoryBrowseMode = true;
    resetMemoryBrowsePaging();
    memoryBrowseTotal = 0;
    renderMemoryResults({ hits: [] });
  }
  status.textContent = append ? '正在读取下一页…' : '正在读取本机只读记忆账本…';
  status.className = 'meta';
  if (browseButton) browseButton.disabled = true;
  if (button) button.disabled = true;
  try {
    const response = await api('/api/memory/records/list', 'POST', {
      limit: 50,
      query,
      origin: document.getElementById('memoryOriginFilter').value,
      timeStart: start ? new Date(`${start}T00:00:00`).toISOString() : undefined,
      timeEnd: end ? new Date(`${end}T23:59:59.999`).toISOString() : undefined,
      cursor: append ? memoryBrowseCursor : undefined
    });
    if (!response.ok) throw new Error(response.error || '读取全量记录失败');
    const result = response.result || {};
    renderMemoryResults(result, { append });
    memoryBrowseCursor = String(result.nextCursor || '');
    memoryBrowseTotal = Number(result.total || 0);
    if (container) container.hidden = !memoryBrowseCursor;
    if (browseButton) browseButton.disabled = false;
    if (button) button.disabled = false;
    status.textContent = memoryHits.length
      ? `全量浏览：共 ${memoryBrowseTotal} 条活动原始记录，已显示 ${memoryHits.length} 条。`
      : '没有符合筛选条件的活动原始记录。';
    status.className = 'meta ok';
  } catch (error) {
    if (browseButton) browseButton.disabled = false;
    if (button) button.disabled = false;
    if (!append) resetMemoryBrowsePaging();
    else {
      memoryBrowseCursor = '';
      if (container) container.hidden = true;
    }
    status.textContent = error.message || '读取全量记录失败';
    status.className = 'meta err';
    if (!append) document.getElementById('memoryResults').innerHTML = `<div class="empty-state"><strong>读取失败</strong><p>${esc(error.message || '未知错误')}</p></div>`;
  }
}
function resetMemoryEditor() {
  document.getElementById('memoryId').value = '';
  document.getElementById('memoryOrigin').value = 'assistant';
  document.getElementById('memoryContent').value = '';
  document.getElementById('memorySourceContext').value = '';
  document.getElementById('memoryConfidence').value = '';
  document.getElementById('memoryEvidenceReferences').value = '';
  document.getElementById('memoryTags').value = '';
  document.getElementById('memoryParticipants').value = '';
  document.getElementById('memoryObservedAt').value = '';
  document.getElementById('memoryEditorTitle').textContent = '新建记忆';
  document.getElementById('memorySave').hidden = false;
  document.getElementById('memoryReplace').hidden = true;
  document.getElementById('memoryDelete').hidden = true;
  document.getElementById('memoryEditorStatus').textContent = '';
}
async function selectMemoryHit(index) {
  const hit = memoryHits[index];
  if (!hit?.memoryId) return;
  const status = document.getElementById('memoryEditorStatus');
  status.textContent = '正在读取完整记录…';
  try {
    const response = await api('/api/memory/read', 'POST', { memoryId: hit.memoryId });
    if (!response.ok) throw new Error(response.error || '读取失败');
    const record = response.result;
    if (!record) throw new Error('记忆记录不存在');
    document.getElementById('memoryId').value = record.memoryId;
    const recordOrigin = record.metadata?.origin || record.sourceType;
    document.getElementById('memoryOrigin').value = recordOrigin === 'qq' || recordOrigin === 'assistant' ? recordOrigin : '';
    document.getElementById('memoryContent').value = record.content || '';
    document.getElementById('memorySourceContext').value = record.metadata?.sourceContext || '';
    document.getElementById('memoryConfidence').value = ['firsthand', 'reported', 'inferred', 'uncertain'].includes(record.metadata?.confidence) ? record.metadata.confidence : '';
    document.getElementById('memoryEvidenceReferences').value = memoryListInput(record.metadata?.evidenceReferences);
    document.getElementById('memoryTags').value = memoryListInput(record.tags || record.metadata?.tags);
    document.getElementById('memoryParticipants').value = memoryListInput(record.participants || record.metadata?.participants);
    document.getElementById('memoryObservedAt').value = memoryDateInput(record.observedAt);
    document.getElementById('memoryEditorTitle').textContent = '编辑记忆';
    document.getElementById('memorySave').hidden = true;
    document.getElementById('memoryReplace').hidden = false;
    document.getElementById('memoryDelete').hidden = false;
    status.textContent = `已读取 ${record.memoryId}`;
    status.className = 'meta ok';
  } catch (error) {
    status.textContent = error.message || '读取失败';
    status.className = 'meta err';
  }
}
function memoryEditorBody() {
  const observed = document.getElementById('memoryObservedAt').value;
  return {
    content: document.getElementById('memoryContent').value,
    origin: document.getElementById('memoryOrigin').value,
    tags: memoryListParse(document.getElementById('memoryTags').value),
    participants: memoryListParse(document.getElementById('memoryParticipants').value),
    observedAt: observed ? new Date(observed).toISOString() : undefined,
    metadata: {
      sourceContext: document.getElementById('memorySourceContext').value.trim(),
      confidence: document.getElementById('memoryConfidence').value || undefined,
      evidenceReferences: String(document.getElementById('memoryEvidenceReferences').value || '').split(/\n/).map(item => item.trim()).filter(Boolean).slice(0, 20)
    }
  };
}
async function saveMemory(isReplace) {
  const status = document.getElementById('memoryEditorStatus');
  const memoryId = document.getElementById('memoryId').value;
  if (isReplace && !memoryId) return;
  if (isReplace && !document.getElementById('memoryOrigin').value) {
    status.textContent = '该记录没有已知来源；请选择“自身经历”或“QQ 对话”后再保存。';
    status.className = 'meta err';
    return;
  }
  status.textContent = '正在保存…';
  status.className = 'meta';
  try {
    const response = await api(isReplace ? '/api/memory/replace' : '/api/memory/save', 'POST', {
      ...memoryEditorBody(),
      ...(isReplace ? { memoryId } : {})
    });
    if (!response.ok) throw new Error(response.error || '保存失败');
    const warning = response.result?.warning;
    if (!isReplace) resetMemoryEditor();
    status.textContent = warning ? `已保存，但有提示：${warning}` : (isReplace ? '已保存修改' : '已保存新记忆');
    status.className = warning ? 'meta err' : 'meta ok';
    await searchMemoryIfActive();
  } catch (error) {
    status.textContent = error.message || '保存失败';
    status.className = 'meta err';
  }
}
async function searchMemoryIfActive() {
  if (currentConsolePage !== 'memory') return;
  if (memoryBrowseMode) await browseAllMemory();
  else if (document.getElementById('memoryQuery').value.trim() || document.getElementById('memoryTimeStart').value || document.getElementById('memoryTimeEnd').value) await searchMemory();
}
async function deleteMemory() {
  const memoryId = document.getElementById('memoryId').value;
  if (!memoryId || !confirm(`删除这条长期记忆？\n${memoryId}\n此操作不可恢复。`)) return;
  const status = document.getElementById('memoryEditorStatus');
  status.textContent = '正在删除…';
  try {
    const response = await api('/api/memory/delete', 'POST', { memoryId });
    if (!response.ok) throw new Error(response.error || '删除失败');
    resetMemoryEditor();
    status.textContent = '已删除';
    status.className = 'meta ok';
    await searchMemoryIfActive();
  } catch (error) {
    status.textContent = error.message || '删除失败';
    status.className = 'meta err';
  }
}
let currentConsolePage = 'overview';
let toastTimer;
function showConsoleToast(message) {
  const toast = document.getElementById('consoleToast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}
function setConsolePage(page, { updateHash = true, focus = false, target = '' } = {}) {
  if (!Object.hasOwn(consolePages, page)) page = 'overview';
  currentConsolePage = page;
  document.querySelectorAll('[data-page]').forEach(el => { el.hidden = el.dataset.page !== page; });
  document.querySelectorAll('#mainNav [data-view]').forEach(button => {
    const selected = button.dataset.view === page;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.getElementById('breadcrumbSection').textContent = consolePages[page][3] || '工作空间';
  document.getElementById('breadcrumbPage').textContent = consolePages[page][0];
  document.getElementById('pageTitle').textContent = consolePages[page][1];
  document.getElementById('pageDescription').textContent = consolePages[page][2];
  document.title = consolePages[page][0] + ' · QQ 桥接控制台';
  if (updateHash && location.hash !== '#' + page) history.pushState({}, '', '#' + page);
  if (page === 'overview' || page === 'sessions') refreshDesktopAgentStatus();
  if (page === 'memory') refreshMemoryStatus();
  if (page === 'memory-settings') { refreshMemoryStatus(); refreshMemorySettings(); }
  closeConsoleSearch();
  if (focus) {
    document.getElementById('mainContent').focus({ preventScroll: true });
    document.getElementById(target || 'mainContent')?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  setConsolePage(button.dataset.view, { focus: true, target: button.dataset.target });
}));
document.getElementById('memoryRefreshStatus').addEventListener('click', refreshMemoryStatus);
document.getElementById('memorySettingsRefreshStatus').addEventListener('click', () => { refreshMemoryStatus(); refreshMemorySettings(); });
document.getElementById('memorySettingsSave').addEventListener('click', saveMemorySettings);
document.getElementById('memoryProvidersSave').addEventListener('click', saveMemoryProviders);
document.getElementById('memoryServiceStart').addEventListener('click', startAMemorix);
document.getElementById('memoryClearApiKey').addEventListener('change', event => { if (event.target.checked) document.getElementById('memoryApiKey').value = ''; });
document.getElementById('memoryEmbeddingClearKey').addEventListener('change', event => { if (event.target.checked) document.getElementById('memoryEmbeddingKey').value = ''; });
document.getElementById('memoryLlmClearKey').addEventListener('change', event => { if (event.target.checked) document.getElementById('memoryLlmKey').value = ''; });
document.getElementById('memorySearch').addEventListener('click', searchMemory);
document.getElementById('memoryBrowseAll').addEventListener('click', () => browseAllMemory());
document.getElementById('memoryLoadMore').addEventListener('click', () => browseAllMemory({ append: true }));
document.getElementById('memoryQuery').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); searchMemory(); }
});
document.getElementById('memoryResults').addEventListener('click', event => {
  const hit = event.target.closest('[data-memory-index]');
  if (hit) selectMemoryHit(Number(hit.dataset.memoryIndex));
});
document.getElementById('memorySave').addEventListener('click', () => saveMemory(false));
document.getElementById('memoryReplace').addEventListener('click', () => saveMemory(true));
document.getElementById('memoryDelete').addEventListener('click', deleteMemory);
document.getElementById('memoryClear').addEventListener('click', resetMemoryEditor);
window.addEventListener('hashchange', () => {
  const page = location.hash.slice(1);
  if (Object.hasOwn(consolePages, page) || !page) setConsolePage(page, { updateHash: false });
});
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  document.getElementById('mainContent').focus();
  document.getElementById('mainContent').scrollIntoView({ block: 'start', behavior: 'instant' });
});
function updateOverview(status) {
  const connection = document.getElementById('statusText');
  connection.textContent = status.dshReady ? 'DSH 已连接' : 'DSH 未连接';
  connection.className = 'status-badge ' + (status.dshReady ? 'online' : 'offline');
  document.getElementById('metricDsh').textContent = status.dshReady ? '已连接' : '未连接';
  document.getElementById('metricDsh').className = status.dshReady ? 'ok' : 'err';
  document.getElementById('metricDshHint').textContent = status.dshReady ? '桥接状态已同步' : '请检查 DSH 是否运行';
  renderSnowlumaHealth(status.snowluma);
  document.getElementById('metricMode').textContent = '按需提醒';
  document.getElementById('metricRole').textContent = '私聊、@、回复/引用、关键词';
  document.getElementById('accessSummary').textContent = '管理员 ' + (status.ownerQQ || '未设置') + ' · ' + (status.allowGroups || []).length + ' 个白名单群 · ' + (status.allowPrivate || []).length + ' 位白名单好友';
  document.getElementById('lastUpdated').textContent = '状态同步于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  document.getElementById('connectionAlert').hidden = true;
}
function setConnectionError(error) {
  document.getElementById('statusText').className = 'status-badge offline';
  document.getElementById('metricDsh').textContent = '连接中断';
  document.getElementById('metricDsh').className = 'err';
  document.getElementById('metricDshHint').textContent = '当前状态可能已过期';
  // 上游健康也一起过期：桥接都联系不上时，别让上一次的 SnowLuma 结论继续挂着。
  document.getElementById('metricSnowluma').textContent = '未知';
  document.getElementById('metricSnowluma').className = '';
  document.getElementById('metricSnowlumaHint').textContent = '当前状态可能已过期';
  document.getElementById('snowlumaWarn').style.display = 'none';
  const alert = document.getElementById('connectionAlert');
  alert.textContent = error.message === '未授权' ? '访问令牌无效或已取消输入。请使用启动日志中的控制台链接重新打开。' : '无法连接桥接服务，当前显示的是上次同步结果。请检查桥接是否运行，再点击右上角刷新。';
  alert.hidden = false;
}
document.getElementById('refreshConsole').addEventListener('click', async function () {
  this.disabled = true;
  const jobs = [refresh(), refreshV2Activity()];
  if (currentConsolePage === 'overview') jobs.push(refreshDesktopAgentStatus(true));
  await Promise.allSettled(jobs);
  this.disabled = false;
  if (document.getElementById('connectionAlert').hidden) showConsoleToast('运行状态已刷新');
});

// Attach real accessible names to the original form controls, including paired min/max inputs.
document.querySelectorAll('input,select,textarea').forEach(input => {
  if (input.labels?.length || input.hasAttribute('aria-label')) return;
  let label = input.previousElementSibling;
  while (label && label.tagName !== 'LABEL') label = label.previousElementSibling;
  if (label) {
    const siblings = [];
    let next = label.nextElementSibling;
    while (next && next.tagName !== 'LABEL') {
      if (next.matches('input,select,textarea')) siblings.push(next);
      next = next.nextElementSibling;
    }
    input.setAttribute('aria-label', label.textContent.trim() + (siblings.length > 1 ? (siblings.indexOf(input) === 0 ? '（下限）' : '（上限）') : ''));
  } else {
    const sectionLabel = input.closest('section')?.querySelector('h2')?.textContent?.trim();
    const controlLabel = input.placeholder || sectionLabel || input.id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    input.setAttribute('aria-label', controlLabel || '设置');
  }
});
document.querySelectorAll('.meta[id$="Msg"], .meta[id$="Msg2"]').forEach(el => el.setAttribute('role','status'));
document.getElementById('section-activity').querySelector('h2').dataset.note = '每 3 秒自动同步';

const searchInput = document.getElementById('consoleSearch');
const searchResults = document.getElementById('searchResults');
const featureIndex = [];
document.querySelectorAll('section[data-page]').forEach(section => {
  const page = section.dataset.page;
  featureIndex.push({ page, label: section.querySelector('h2').textContent, target: section });
  section.querySelectorAll('details.settings-group>summary,input,textarea,select').forEach(el => {
    let label = el.tagName === 'SUMMARY' ? el.textContent : (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.placeholder);
    if (label) featureIndex.push({ page, label: label.trim(), target: el });
  });
});
function closeConsoleSearch() { searchResults.hidden = true; searchInput.setAttribute('aria-expanded','false'); }
searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim().toLowerCase();
  searchResults.replaceChildren();
  if (!query) return closeConsoleSearch();
  const matches = featureIndex.filter(entry => (consolePages[entry.page][0] + entry.label + entry.target.id).toLowerCase().includes(query)).slice(0,12);
  if (!matches.length) { const empty = document.createElement('p'); empty.textContent = '未找到匹配功能，试试「唤醒」「白名单」或「表情」。'; searchResults.append(empty); }
  matches.forEach(entry => {
    const button = document.createElement('button');
    const title = document.createElement('span'); title.textContent = entry.label;
    const caption = document.createElement('small'); caption.textContent = consolePages[entry.page][0];
    button.append(title,caption);
    button.addEventListener('click', () => {
      setConsolePage(entry.page);
      let ancestor = entry.target.closest('details');
      while (ancestor) { ancestor.open = true; ancestor = ancestor.parentElement.closest('details'); }
      entry.target.scrollIntoView({ block:'center', behavior:'instant' });
      if (!entry.target.hasAttribute('tabindex') && !entry.target.matches('input,textarea,select,button,summary')) entry.target.tabIndex = -1;
      entry.target.focus({ preventScroll:true });
      entry.target.classList.add('search-highlight');
      setTimeout(() => entry.target.classList.remove('search-highlight'), 2000);
    });
    searchResults.append(button);
  });
  searchResults.hidden = false;
  searchInput.setAttribute('aria-expanded','true');
});
searchInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeConsoleSearch();
  if ((event.key === 'ArrowDown' || event.key === 'Enter') && !searchResults.hidden) { event.preventDefault(); searchResults.querySelector('button')?.focus(); }
});
document.addEventListener('click', event => { if (!event.target.closest('.search-wrap')) closeConsoleSearch(); });
searchResults.addEventListener('keydown', event => { if (event.key === 'Escape') { closeConsoleSearch(); searchInput.focus(); } });

const tokenToggle = document.createElement('button');
tokenToggle.id = 'consoleTokenToggle'; tokenToggle.className = 'small'; tokenToggle.textContent = '显示令牌'; tokenToggle.type = 'button'; tokenToggle.setAttribute('aria-pressed','false');
tokenToggle.addEventListener('click', () => {
  const input = document.getElementById('consoleTokenInput');
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  tokenToggle.textContent = visible ? '隐藏令牌' : '显示令牌';
  tokenToggle.setAttribute('aria-pressed',String(visible));
});
document.getElementById('consoleTokenInput').after(tokenToggle);
// ── 消耗走势图（手写 SVG） ───────────────────────────────────────────────
// 为什么不用图表库：控制台 CSP 是 default-src 'self'，不能引外部脚本；
// 而 SVG 用 document.createElementNS 生成既没有 innerHTML 转义风险，
// 也能直接用 CSS 变量跟随深浅主题。
let usageChartHours = 24;
let usageChartMetric = 'cost';
let usageChartData = null;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}
function usageBucketValue(b, metric) {
  return metric === 'tokens' ? (Number(b.tokens) || 0) : (Number(b.cost) || 0);
}
function usageMetricLabel(metric) {
  return metric === 'tokens' ? 'token' : '花费';
}
function usageAxisValue(v, metric, sym) {
  if (metric === 'tokens') return usageNum(v);
  if (v === 0) return sym + '0';
  return v < 0.01 ? sym + v.toFixed(4) : sym + v.toFixed(2);
}
function usageBucketClock(ms, bucketMs) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  // 桶宽 ≥ 1 天时只显示日期，否则显示「日 时:分」，跨天也能分辨。
  if (bucketMs >= 24 * 3600 * 1000) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderUsageChart(series) {
  const box = document.getElementById('usageChart');
  const totalEl = document.getElementById('usageChartTotal');
  const hintEl = document.getElementById('usageChartHint');
  const noteEl = document.getElementById('usageChartNote');
  usageChartData = series;
  const sym = series?.symbol || '¥';
  const buckets = Array.isArray(series?.buckets) ? series.buckets : [];
  if (!buckets.length) {
    box.innerHTML = '';
    box.textContent = '暂无数据';
    totalEl.textContent = '—';
    hintEl.textContent = '还没有用量记录';
    noteEl.textContent = '';
    return;
  }
  const metric = usageChartMetric;
  const values = buckets.map((b) => usageBucketValue(b, metric));
  const max = Math.max(...values, 0);
  // 全零时给一个假上限，避免除零；同时让空图看起来是"平"的而不是报错。
  const scaleMax = max > 0 ? max : 1;

  const W = 960;
  const H = 240;
  const padL = 62;
  const padR = 12;
  const padT = 12;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const step = plotW / buckets.length;
  const barW = Math.max(2, step * 0.72);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${usageMetricLabel(metric)}随时间的走势图` });

  // 横向网格 + 纵轴刻度（3 条线即可：0 / 一半 / 最大）
  // 窗口内完全没有用量时（max === 0）三条刻度都写 0：不能编出一个 ¥1 的假量程，
  // 那会让人以为"有量但很小"。
  for (let i = 0; i <= 2; i += 1) {
    const y = padT + plotH - (plotH * i) / 2;
    svg.appendChild(svgEl('line', { class: 'usage-grid', x1: padL, y1: y, x2: W - padR, y2: y }));
    const label = svgEl('text', { class: 'usage-axis', x: padL - 8, y: y + 3, 'text-anchor': 'end' });
    label.textContent = usageAxisValue(max > 0 ? (scaleMax * i) / 2 : 0, metric, sym);
    svg.appendChild(label);
  }

  // 柱：颜色 = 该桶的峰谷档位，所以"什么时候贵"是一眼可见的
  for (let i = 0; i < buckets.length; i += 1) {
    const b = buckets[i];
    const v = values[i];
    const x = padL + i * step + (step - barW) / 2;
    const h = v > 0 ? Math.max(1.5, (v / scaleMax) * plotH) : 0;
    const tooltip = svgEl('title');
    tooltip.textContent = `${usageBucketClock(b.t, series.bucketMs)}\n${usageMetricLabel(metric)}：${usageAxisValue(v, metric, sym)}`
      + `\n未命中输入：${usageNum(b.cacheMiss)} ｜ 命中输入：${usageNum(b.cacheHit)} ｜ 输出：${usageNum(b.output)}`
      + `\n步数：${usageNum(b.steps)} ｜ 轮次：${usageNum(b.turns)}`
      + `\n时段：${b.tier === 'peak' ? '高峰（单价 ×2）' : (b.tier === 'mixed' ? '跨时段' : '空闲')}`
      + (b.keys?.length ? `\n会话：${b.keys.join('、')}` : '');
    if (h > 0) {
      const rect = svgEl('rect', { x, y: padT + plotH - h, width: barW, height: h, rx: 2, class: `usage-bar-${b.tier === 'peak' ? 'peak' : (b.tier === 'mixed' ? 'mixed' : 'off')}` });
      rect.appendChild(tooltip);
      svg.appendChild(rect);
    }
    // 透明命中区：0 值的桶也能 hover（鼠标移到空白处也要能看出那一刻是空闲还是高峰）
    const hit = svgEl('rect', { x: padL + i * step, y: padT, width: step, height: plotH, class: 'usage-hit' });
    hit.appendChild(tooltip.cloneNode(true));
    svg.appendChild(hit);
  }

  // 横轴：最多 6 个刻度，避免挤在一起
  const tickEvery = Math.max(1, Math.ceil(buckets.length / 6));
  for (let i = 0; i < buckets.length; i += tickEvery) {
    const label = svgEl('text', { class: 'usage-axis', x: padL + i * step + step / 2, y: H - padB + 16, 'text-anchor': 'middle' });
    label.textContent = usageBucketClock(buckets[i].t, series.bucketMs);
    svg.appendChild(label);
  }

  box.innerHTML = '';
  box.appendChild(svg);

  const windowTotal = buckets.reduce((sum, b) => sum + usageBucketValue(b, metric), 0);
  totalEl.textContent = metric === 'tokens' ? `${usageNum(windowTotal)} token` : usageMoney(windowTotal, sym);
  const busiest = series.busiest;
  hintEl.textContent = `窗口内合计 ｜ 每格 ${Math.round(series.bucketMs / 60000)} 分钟`
    + (busiest && metric === 'cost' ? ` ｜ 最贵一格：${usageBucketClock(busiest.t, series.bucketMs)} ${usageMoney(busiest.cost, sym)}` : '')
    + (series.estimated ? ' ｜ ⚠️ 含按兜底价估算的模型' : '');

  // 图上一定要能看出"还有多少没画进来"：投影基线覆盖的更早历史没有逐时明细。
  const notes = [];
  if (Number(series.offChartCost) > 0.0001) {
    notes.push(`另有 ${usageMoney(series.offChartCost, sym)}（约 ${usageNum(series.offChartTokens)} token）属于更早的历史，只有累计值、没有逐时明细，因此不在上图里；所以本图合计会小于「总花费」。`);
  }
  if (series.countedSamples === 0) {
    notes.push('所选时间窗内没有采样：要么这段时间真的没调用，要么逐轮明细已被容量上限淘汰（累计总量仍然准确）。');
  }
  noteEl.textContent = notes.join(' ');
}

async function refreshUsageChart() {
  try {
    const r = await api(`/api/tokens/series?hours=${usageChartHours}`);
    renderUsageChart(r);
  } catch (error) {
    document.getElementById('usageChart').textContent = `走势读取失败：${error?.message || '未知错误'}`;
  }
}

document.getElementById('usageChartControls').addEventListener('click', (ev) => {
  const hoursBtn = ev.target.closest('[data-usage-hours]');
  const metricBtn = ev.target.closest('[data-usage-metric]');
  if (hoursBtn) {
    usageChartHours = Number(hoursBtn.dataset.usageHours) || 24;
    document.querySelectorAll('#usageChartControls [data-usage-hours]').forEach((b) => b.classList.toggle('active', b === hoursBtn));
    refreshUsageChart();
  } else if (metricBtn) {
    usageChartMetric = metricBtn.dataset.usageMetric === 'tokens' ? 'tokens' : 'cost';
    document.querySelectorAll('#usageChartControls [data-usage-metric]').forEach((b) => b.classList.toggle('active', b === metricBtn));
    // 只换纵轴：不重新请求，直接重画现有数据。
    if (usageChartData) renderUsageChart(usageChartData);
  }
});

// ── 令牌与花费 ───────────────────────────────────────────────────────────
// 数据分三层：累计总量（DSH tokenUsage 投影，权威）→ 按会话归并 → 逐轮明细。
// 金额一律在渲染时算，价目表改了不需要重算历史。
let usageSelectedKey = '';
let usageConversationsCache = [];

function usageNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e5) return (v / 1e4).toFixed(0) + ' 万';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function usageMoney(n, sym) {
  const s = sym || '¥';
  const v = Number(n) || 0;
  if (v === 0) return s + '0';
  if (v < 0.01) return s + v.toFixed(4);
  return s + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function usagePct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return (v * 100).toFixed(1) + '%';
}
function usageRate(buckets) {
  const b = buckets || {};
  const input = (b.cacheMiss || 0) + (b.cacheHit || 0) + (b.cacheWrite || 0);
  return input > 0 ? (b.cacheHit || 0) / input : 0;
}
function usageTime(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch (error) { return '—'; }
}
function usageBar(share) {
  const ratio = Math.max(0, Math.min(1, Number(share) || 0));
  const width = Math.max(2, Math.round(ratio * 100));
  return `<span class="usage-bar-wrap"><span class="usage-bar-track"><span class="usage-bar-fill" style="width:${width}%"></span></span><span class="meta">${(ratio * 100).toFixed(1)}%</span></span>`;
}
function usageTierTag(tier) {
  if (tier === 'peak') return '<span class="pill r usage-tier">高峰</span>';
  if (tier === 'off') return '<span class="pill g usage-tier">空闲</span>';
  if (tier === 'mixed') return '<span class="pill b usage-tier">跨时段</span>';
  return '<span class="meta">—</span>';
}

function syncUsageKeySelect(keys) {
  const sel = document.getElementById('usageKeySelect');
  if (!sel) return;
  if (!keys.includes(usageSelectedKey)) usageSelectedKey = keys[0] || '';
  const signature = keys.join('\u0000');
  if (sel.dataset.signature !== signature) {
    sel.dataset.signature = signature;
    sel.innerHTML = keys.length
      ? keys.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('')
      : '<option value="">（暂无会话）</option>';
  }
  // 每 3 秒的轮询不得覆盖用户正在操作的控件。
  if (document.activeElement !== sel) sel.value = usageSelectedKey;
}

function renderUsageConversations(r) {
  const box = document.getElementById('usageConversations');
  const list = r.conversations || [];
  const sym = r.symbol || '¥';
  usageConversationsCache = list;
  if (!list.length) {
    box.innerHTML = '<div class="empty-state"><strong>还没有用量记录</strong><p>QQ 会话产生一次 LLM 调用后，这里会按群 / 好友列出 token 与花费。新账本从桥接重启后开始记账。</p></div>';
    return;
  }
  const maxCost = Math.max(...list.map(x => Number(x.cost) || 0), 0);
  let html = '<table><tr><th>会话</th><th>类型</th><th class="num">轮数</th><th class="num">步数</th><th class="num">未命中输入</th><th class="num">命中输入</th><th class="num">命中率</th><th class="num">输出</th><th class="num">花费</th><th>占比</th></tr>';
  for (const c of list) {
    const key = String(c.key ?? '');
    const isInternal = key.startsWith('internal:');
    const type = isInternal ? '<span class="pill b">内部</span>'
      : (key.startsWith('private:') ? '<span class="pill b">私聊</span>' : '<span class="pill g">群</span>');
    const b = c.buckets || {};
    html += '<tr>'
      + `<td class="usage-key"><button class="usage-key-button" data-usage-key="${esc(key)}" aria-pressed="${key === usageSelectedKey}">${esc(key)}</button></td>`
      + `<td>${type}</td>`
      + `<td class="num">${usageNum(c.turns)}</td>`
      + `<td class="num">${usageNum(c.steps)}</td>`
      + `<td class="num">${usageNum(b.cacheMiss)}</td>`
      + `<td class="num">${usageNum(b.cacheHit)}</td>`
      + `<td class="num">${usagePct(usageRate(b))}</td>`
      + `<td class="num">${usageNum(b.output)}</td>`
      + `<td class="num">${usageMoney(c.cost, sym)}</td>`
      + `<td>${usageBar(maxCost > 0 ? (Number(c.cost) || 0) / maxCost : 0)}</td>`
      + '</tr>';
  }
  html += '</table>';
  const totals = r.totals || {};
  if (Number(totals.unattributedCost) > 0) {
    html += `<div class="meta" style="padding:8px 10px">其中 ${usageMoney(totals.unattributedCost, sym)} 来自更早的回合：它们只剩累计值（在逐轮快照窗口之外），无法再拆到具体某一轮。</div>`;
  }
  if (totals.estimated) {
    html += '<div class="meta" style="padding:8px 10px">⚠️ 有模型未登记在价目表里，这部分按 <code>deepseek-flash</code> 兜底价估算，可在 <code>config.json</code> 的 <code>pricing.models</code> 补充。</div>';
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-usage-key]').forEach(btn => btn.addEventListener('click', () => {
    usageSelectedKey = btn.dataset.usageKey;
    box.querySelectorAll('[data-usage-key]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.usageKey === usageSelectedKey)));
    const sel = document.getElementById('usageKeySelect');
    if (sel) sel.value = usageSelectedKey;
    refreshUsageTurns();
  }));
}

function renderUsageTurns(r) {
  const box = document.getElementById('usageTurns');
  const scope = document.getElementById('usageTurnScope');
  const rows = r.turns || [];
  const sym = r.symbol || '¥';
  if (scope) {
    scope.textContent = `${esc(r.key || '')} ｜ 共 ${rows.length} 轮可追溯 ｜ 已归属 ${usageMoney(r.attributedCost, sym)}`
      + (Number(r.unattributedCost) > 0 ? ` ｜ 未逐轮归属 ${usageMoney(r.unattributedCost, sym)}` : '');
  }
  if (!rows.length) {
    box.innerHTML = '<span class="meta">该会话还没有可追溯的逐轮记录（只有累计值）。</span>';
    return;
  }
  let html = '<table><tr><th class="num">轮次</th><th>结束时间</th><th class="num">步数</th><th class="num">未命中输入</th><th class="num">命中输入</th><th class="num">命中率</th><th class="num">输出</th><th class="num">花费</th><th>时段</th></tr>';
  for (const t of rows) {
    const b = t.buckets || {};
    html += '<tr>'
      + `<td class="num">#${esc(t.turn)}</td>`
      + `<td>${esc(usageTime(t.endedAt))}</td>`
      + `<td class="num">${usageNum(t.steps)}</td>`
      + `<td class="num">${usageNum(b.cacheMiss)}</td>`
      + `<td class="num">${usageNum(b.cacheHit)}</td>`
      + `<td class="num">${usagePct(usageRate(b))}</td>`
      + `<td class="num">${usageNum(b.output)}</td>`
      + `<td class="num">${usageMoney(t.cost, sym)}</td>`
      + `<td>${usageTierTag(t.tier)}</td>`
      + '</tr>';
  }
  box.innerHTML = html + '</table>';
}

function renderUsageRecent(r) {
  const box = document.getElementById('usageRecent');
  const list = r.entries || [];
  const sym = r.symbol || '¥';
  if (!list.length) { box.innerHTML = '<span class="meta">（空）</span>'; return; }
  let html = '<table><tr><th>时间</th><th>会话</th><th class="num">轮</th><th class="num">步</th><th class="num">未命中</th><th class="num">命中</th><th class="num">输出</th><th class="num">花费</th><th>时段</th></tr>';
  for (const e of list) {
    html += '<tr>'
      + `<td>${esc(usageTime(e.time))}</td>`
      + `<td>${esc(e.key || '未归属')}</td>`
      + `<td class="num">#${esc(e.turn)}</td>`
      + `<td class="num">${esc(e.step)}</td>`
      + `<td class="num">${usageNum(e.cacheMiss)}</td>`
      + `<td class="num">${usageNum(e.cacheHit)}</td>`
      + `<td class="num">${usageNum(e.output)}</td>`
      + `<td class="num">${usageMoney(e.cost, sym)}</td>`
      + `<td>${usageTierTag(e.tier)}</td>`
      + '</tr>';
  }
  box.innerHTML = html + '</table>';
}

function renderUsagePrices(pt) {
  const box = document.getElementById('usagePrices');
  if (!pt || !pt.models) { box.textContent = '（价目表不可用）'; return; }
  const sym = pt.symbol || '¥';
  const tier = pt.nowTier;
  let html = `<div style="margin-bottom:6px">价目表版本 <code>${esc(pt.version)}</code> ｜ 高峰时段为北京时间的 2 倍价（周一至周五 9:00-12:00、14:00-18:00，法定节假日除外，已内置 ${esc(pt.holidayCount)} 天假期）</div>`;
  html += '<table><tr><th>模型</th><th class="num">缓存命中</th><th class="num">缓存未命中</th><th class="num">输出</th></tr>';
  for (const [name, m] of Object.entries(pt.models)) {
    // 单价与货币符号都可能来自 config.json 的 pricing 覆盖项（运维可写），
    // 不能直接拼进 innerHTML：这里统一走 esc() （数字原样显示仍然是数字）。
    const price = (v) => esc(sym + (Number.isFinite(Number(v)) ? Number(v) : (v ?? '')));
    html += `<tr><td><code>${esc(name)}</code><div class="meta">${esc(m.label)}</div></td>`
      + `<td class="num">${price(m.off?.cacheHit)}</td>`
      + `<td class="num">${price(m.off?.cacheMiss)}</td>`
      + `<td class="num">${price(m.off?.output)}</td></tr>`;
  }
  html += '</table>';
  html += `<div class="meta" style="padding:8px 10px">上表为<b>空闲时段</b>单价（元 / 百万 token）。当前时刻属于 <b>${tier ? esc(tier.tierLabel) : '—'}</b>${tier?.estimated ? '，且价目表里没有 <code>' + esc(tier.model) + '</code>，按兜底价估算' : ''}。</div>`;
  box.innerHTML = html;
}

async function refreshUsage() {
  const msg = document.getElementById('usageMsg');
  try {
    const r = await api('/api/tokens/summary?limit=200');
    const t = r.totals || {};
    const b = t.buckets || {};
    const sym = r.symbol || '¥';
    document.getElementById('metricUsageCost').textContent = usageMoney(t.cost, sym);
    document.getElementById('metricUsageCostHint').textContent =
      `高峰 ${usageMoney(t.byTier?.peak, sym)} ｜ 空闲 ${usageMoney(t.byTier?.off, sym)}`;
    document.getElementById('metricUsageTokens').textContent = usageNum(t.totalTokens);
    document.getElementById('metricUsageTokensHint').textContent =
      `输入 ${usageNum(t.inputTokens)} ｜ 输出 ${usageNum(b.output)}`;
    document.getElementById('metricUsageHitRate').textContent = usagePct(t.cacheHitRate);
    document.getElementById('metricUsageHitHint').textContent =
      `命中 ${usageNum(b.cacheHit)} ｜ 未命中 ${usageNum(b.cacheMiss)}`;
    document.getElementById('metricUsagePerTurn').textContent = usageMoney(t.avgCostPerTurn, sym);
    document.getElementById('metricUsagePerTurnHint').textContent =
      `${usageNum(t.turns)} 轮 ｜ ${usageNum(t.steps)} 步 ｜ 当前${r.nowTier?.tier === 'peak' ? '高峰' : '空闲'}时段`;
    renderUsageConversations(r);
    renderUsagePrices(r.priceTable ? { ...r.priceTable, nowTier: r.nowTier } : null);
    syncUsageKeySelect((r.conversations || []).map(c => String(c.key ?? '')));
    if (!document.getElementById('usageTurns').dataset.loaded && usageSelectedKey) refreshUsageTurns();
    msg.textContent = `✅ 已同步于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    msg.className = 'meta ok';
  } catch (error) {
    msg.textContent = `❌ 读取失败：${error?.message || '未知错误'}`;
    msg.className = 'meta err';
  }
}

async function refreshUsageTurns() {
  const box = document.getElementById('usageTurns');
  if (!usageSelectedKey) {
    box.innerHTML = '<span class="meta">选择一个会话后加载逐轮明细…</span>';
    box.dataset.loaded = '';
    return;
  }
  try {
    const r = await api('/api/tokens/turns?key=' + encodeURIComponent(usageSelectedKey) + '&limit=200');
    renderUsageTurns(r);
    box.dataset.loaded = '1';
  } catch (error) {
    box.innerHTML = `<span class="meta err">读取失败：${esc(error?.message || '未知错误')}</span>`;
    box.dataset.loaded = '';
  }
}

async function refreshUsageRecent() {
  try {
    renderUsageRecent(await api('/api/tokens/recent?limit=40'));
  } catch (error) {
    document.getElementById('usageRecent').innerHTML = '<span class="meta">（读取失败）</span>';
  }
}

document.getElementById('usageRefresh').addEventListener('click', () => {
  refreshUsage();
  refreshUsageChart();
  refreshUsageTurns();
  refreshUsageRecent();
  showConsoleToast('用量已刷新');
});
document.getElementById('usageTurnsLoad').addEventListener('click', () => refreshUsageTurns());
document.getElementById('usageKeySelect').addEventListener('change', (ev) => {
  usageSelectedKey = ev.target.value;
  refreshUsageTurns();
});
document.getElementById('usageClear').addEventListener('click', async () => {
  if (!confirm('确定清空 token 用量账本？累计花费与逐轮明细都会被删除，且不可恢复（下一次同步会从 DSH 重新拉取会话累计值）。')) return;
  const msg = document.getElementById('usageMsg');
  try {
    const r = await api('/api/tokens/reset', 'POST', {});
    msg.textContent = r.ok ? '✅ 账本已清空' : ('❌ ' + (r.error || '失败'));
    msg.className = r.ok ? 'meta ok' : 'meta err';
  } catch (error) {
    msg.textContent = '❌ ' + (error?.message || '失败');
    msg.className = 'meta err';
  }
  usageSelectedKey = '';
  document.getElementById('usageTurnScope').textContent = '—';
  document.getElementById('usageTurns').dataset.loaded = '';
  refreshUsage();
  refreshUsageRecent();
});

setConsolePage(location.hash.slice(1), { updateHash:false });

refresh(); refreshRoles(); refreshWhitelist(); loadV2Config(); refreshV2Activity(); loadV2ToolLog(); loadSecurity(); refreshSimPrompt(); refreshRuntimePromptTemplates(); refreshDshModel(); refreshUsage(); refreshUsageChart(); refreshUsageRecent();
setInterval(() => {
  refresh();
  if (currentConsolePage === 'overview') refreshDesktopAgentStatus();
}, 3000);
// 用量看板只在本页可见时轮询：既保证「实时」，又不让其它页白白多打两份接口。
setInterval(() => { if (currentConsolePage !== 'usage') return; refreshUsage(); refreshUsageChart(); refreshUsageRecent(); }, 3000);
// 主题切换（纯前端，不发任何请求；选择写入 localStorage，未选择时跟随系统）
(function () {
  var root = document.documentElement;
  var button = document.getElementById('themeToggle');
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  function stored() {
    try { return localStorage.getItem('qq-console-theme'); } catch (error) { return null; }
  }
  function apply(theme, persist) {
    root.dataset.theme = theme;
    if (persist) { try { localStorage.setItem('qq-console-theme', theme); } catch (error) {} }
    var dark = theme === 'dark';
    button.textContent = dark ? '☀' : '☾';
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? '切换浅色模式' : '切换深色模式');
    button.title = dark ? '切换到浅色主题' : '切换到深色主题';
  }
  apply(root.dataset.theme === 'dark' ? 'dark' : 'light', false);
  button.addEventListener('click', function () {
    apply(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
  });
  media.addEventListener('change', function (event) {
    if (!stored()) apply(event.matches ? 'dark' : 'light', false);
  });
})();
