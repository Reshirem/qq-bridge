const $ = id => document.getElementById(id);
const endpoints = {
  bridge: '/api/status', agent: '/api/console/desktop-agent', qq: '/api/socialV2/states',
  memory: '/api/memory/organizer', learning: '/api/learning/status', reviews: '/api/learning/sticker-reviews',
};
const links = {
  agent: '/#sessions', qq: '/#social-v2', memory: '/#memory-organizer',
  learning: '/#learning', reviews: '/?focus=reviews#stickers', bridge: '/#operations',
};
const labels = { agent: '主会话', qq: 'QQ 消息', memory: '记忆整理', learning: '后台学习', reviews: '表情复检', bridge: '桥接状态' };
let tasks = [];
let filter = 'all';
let refreshing = false;
let lastRefresh = 0;

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function time(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const options = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (date.toDateString() !== new Date().toDateString()) Object.assign(options, { month: 'numeric', day: 'numeric' });
  return date.toLocaleString('zh-CN', options);
}

function card(key, status, detail, tone = 'normal') {
  const link = element('a', undefined, 'module');
  link.href = links[key];
  link.dataset.tone = tone;
  const head = element('div', undefined, 'card-head');
  head.append(element('span', labels[key]), element('span', '↗'));
  link.append(head, element('strong', status), element('p', detail));
  return link;
}

function issue(title, detail, href) {
  tasks.push({ type: 'issue', title, detail, href });
}

function agentCard(agent) {
  const key = 'agent';
  if (!agent) return card(key, '状态未知', '未能读取主会话状态');
  if (!agent.dshReady || !agent.presetAvailable || agent.error || (agent.sessionId && !agent.found)) {
    const detail = !agent.dshReady ? 'DSH 尚未连接' : !agent.presetAvailable ? '角色预设未加载' : agent.error || '当前会话未找到';
    issue('主会话需要检查', detail, links.agent);
    return card(key, '暂不可用', detail, 'warn');
  }
  if (agent.lifecycle === 'recovering') {
    const detail = '第 ' + (agent.recoveryAttempt || 1) + ' 次恢复 · ' + time(agent.recoveryAt) + ' 重试';
    issue('主会话正在等待重试', detail, links.agent);
    return card(key, '等待重试', detail, 'warn');
  }
  if (agent.lifecycle === 'resting') return card(key, '休息中', '预计 ' + time(agent.restUntil) + ' 恢复');
  if (agent.lifecycle === 'sleeping') return card(key, '睡眠中', '已暂停会话级提醒');
  if (agent.lifecycle === 'stopped') return card(key, '已停止', '自主运行已停止');
  if (!agent.sessionId) return card(key, '尚未启动', '可从主会话启动角色');
  if (agent.agentAvailable === false) {
    issue('主会话的角色暂不可用', '查看 DSH 会话状态', links.agent);
    return card(key, '暂不可用', '角色尚未就绪', 'warn');
  }
  return card(key, agent.running ? '运行中' : '空闲', '已连接 DSH 主会话', 'ok');
}

function qqCard(bridge, qq) {
  const health = bridge?.snowluma;
  const names = qq?.conversations ?? [];
  const unread = names.reduce((sum, row) => sum + row.unreadCount, 0);
  const queued = names.filter(row => row.attention === 'queued').length;
  const detail = qq ? unread + ' 条未读 · ' + queued + ' 个来源等待提交' : '未能读取 QQ 消息缓冲';
  if (!health || !qq) return card('qq', '状态未知', detail);
  if (!health.connected || health.accountOnline === false || health.degraded) {
    const title = !health.connected ? '网关已断开' : health.accountOnline === false ? 'QQ 账号离线' : '连接异常';
    issue('QQ 消息通道需要检查', health.hint || title, '/#maintenance');
    return card('qq', title, detail, 'warn');
  }
  return card('qq', qq.enabled ? '已连接' : '提醒关闭', detail, qq.enabled ? 'ok' : 'normal');
}

function memoryCard(organizer) {
  if (!organizer) return card('memory', '状态未知', '未能读取整理队列');
  const jobs = organizer.jobs ?? [];
  const failed = jobs.filter(job => job.status === 'failed').sort((a, b) => b.updatedAt - a.updatedAt);
  for (const job of failed) {
    const detail = job.error || job.progress?.error || '打开任务查看错误和重试入口';
    issue('记忆整理失败 · ' + time(job.createdAt), String(detail).slice(0, 180),
      '/?job=' + encodeURIComponent(job.jobId) + '#memory-organizer');
  }
  const waiting = jobs.filter(job => job.status === 'queued').length;
  const running = jobs.some(job => ['reading', 'organizing', 'writing'].includes(job.status));
  const detail = waiting + ' 个排队 · ' + failed.length + ' 个失败';
  if (!organizer.enabled || !organizer.memoryConfigured) return card('memory', organizer.enabled ? '待配置' : '已关闭', detail);
  if (!organizer.dshReady) return card('memory', '等待 DSH', detail);
  return card('memory', running ? '整理中' : failed.length ? '有失败任务' : '就绪', detail, failed.length ? 'warn' : 'ok');
}

function learningCard(learning) {
  if (!learning) return card('learning', '状态未知', '未能读取后台学习队列');
  if (learning.failedMessages > 0) issue('后台学习已暂停重试', learning.failedMessages + ' 条消息连续失败，可查看原因并重新分析。', links.learning);
  const detail = learning.pending + ' 条待分析 · ' + learning.runs + ' 批已完成';
  const status = !learning.config?.enabled ? '已关闭' : learning.running ? '分析中' : '等待批次';
  return card('learning', status, detail, learning.failedMessages ? 'warn' : learning.config?.enabled ? 'ok' : 'normal');
}

function renderTasks() {
  const visible = tasks.filter(t => filter === 'all' || t.type === filter);
  $('task-count').textContent = String(tasks.length);
  for (const button of $('filters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  const rows = visible.map(task => {
    const link = element('a', undefined, 'task');
    link.href = task.href;
    const heading = element('div', undefined, 'task-header');
    heading.append(element('span', task.type === 'review' ? '待确认' : '异常', 'tag ' + task.type), element('strong', task.title));
    link.append(heading, element('p', task.detail));
    return link;
  });
  $('tasks').replaceChildren(...(rows.length ? rows : [element('p', filter === 'all' ? '当前没有需要处理的事项。' : '当前没有此类事项。', 'empty')]));
}

function renderSources(qq) {
  const rows = [...(qq?.conversations || [])].sort((a, b) => b.lastIncomingAt - a.lastIncomingAt).slice(0, 6);
  $('qq-list').replaceChildren(...(rows.length ? rows.map(row => {
    const link = element('a', undefined, 'qq-row');
    link.href = '/?source=' + encodeURIComponent(row.key) + '#social-v2';
    const meta = element('div', undefined, 'qq-meta');
    const attention = { queued: '提醒待提交', unread: '提醒待读' }[row.attention];
    meta.append(element('span', '最近来信 ' + time(row.lastIncomingAt)), element('span', [attention, row.unreadCount + ' 条未读'].filter(Boolean).join(' · ')));
    link.append(element('strong', row.name || row.key, 'qq-name'), meta);
    return link;
  }) : [element('p', qq ? '还没有收到 QQ 消息。' : 'QQ 来源暂时不可用。', 'empty')]));
}

export async function refreshOverview({ force = false, onStatus, onError }) {
  if (refreshing || (!force && Date.now() - lastRefresh < 60000)) return;
  refreshing = true;
  $('sync-status').textContent = '同步中…';
  try {
    const data = {};
    const errors = [];
    await Promise.all(Object.entries(endpoints).map(async ([key, url]) => {
      try {
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (response.status === 401) { location.reload(); throw new Error('登录已失效'); }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const body = await response.json();
        if (body.ok === false) throw new Error(body.error || '接口读取失败');
        data[key] = body;
      } catch (error) { errors.push({ key, message: error.message }); }
    }));
    if (data.bridge) onStatus(data.bridge);
    else onError(new Error('状态接口不可用'));
    tasks = [];
    for (const error of errors) issue(labels[error.key] + '读取失败', error.message, links[error.key]);
    $('modules').replaceChildren(agentCard(data.agent), qqCard(data.bridge, data.qq), memoryCard(data.memory?.organizer), learningCard(data.learning));
    $('modules').setAttribute('aria-busy', 'false');
    const pending = data.reviews?.reviews?.length;
    if (pending) tasks.push({ type: 'review', title: '表情描述修正待确认', detail: '角色提出了 ' + pending + ' 条修正建议，等待你处理。', href: links.reviews });
    renderTasks();
    renderSources(data.qq);
    lastRefresh = Date.now();
    $('sync-status').textContent = errors.length ? '有 ' + errors.length + ' 项读取失败' : '更新于 ' + time(lastRefresh);
  } finally {
    refreshing = false;
  }
}

$('filters').addEventListener('click', event => {
  const button = event.target.closest('button[data-filter]');
  if (button) { filter = button.dataset.filter; renderTasks(); }
});
