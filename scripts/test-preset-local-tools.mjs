// Verify the desktop-agent preset denies local DSH tools and loads the shared guard.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { collectDshToolNames as collectDshToolNamesShared } from './dsh-tool-names.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRESETS_DIR = path.join(ROOT, 'dsh', 'agent-presets');

/** 唯一全局运行时使用的 preset。 */
const GLOBAL_AGENT_PRESETS = ['desktop-agent'];
const GUARD_PATH = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');

/** Deny every known DSH tool that can access local execution, files, or delegation. */
const LOCAL_EXECUTION_TOOLS = [
  'pwsh', 'bash',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'load_workspace_dependencies',
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  'cordis_inspect_list', 'cordis_inspect_query',
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // Workspace, terminal, history, plugin, and agent coordination tools
  'working_directory',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  'plugin_market', 'create_worktree', 'wait_agent',
  // Optional bundle tools remain denied whenever registered.
  'subagent_codex', 'subagent_claude_code',
];

/** Codex and Claude Code tools may be absent unless their optional bundles are installed. */
const OPTIONAL_BUNDLE_TOOLS = new Set(['subagent_codex', 'subagent_claude_code']);

/** Read installed DSH names through the shared scanner. */
function collectDshToolNames() {
  try {
    const { names } = collectDshToolNamesShared();
    return names.size === 0 ? null : new Set(names.keys());
  } catch (error) {
    if (/无法定位含 @deepseek-ai\/dsh-persona/.test(String(error?.message ?? error))) return null;
    throw error;
  }
}
/** 允许出现在名单里、但不属于"本地执行"语义的名字（开发/注入器）。 */
const DEV_TOOL_PREFIX = /^dev_/;

/** 全局数字角色允许使用的 MCP 命名空间前缀。 */
const EXPECTED_SAFE_PREFIXES = [
  'mcp__wincu__',
  'mcp__snowluma__',
  'mcp__snowluma-host__',
];

function readPreset(id) {
  const dir = path.join(PRESETS_DIR, id);
  assert.ok(fs.existsSync(dir), `preset 目录存在：${id}`);
  const cordis = path.join(dir, 'agent.cordis.yml');
  assert.ok(fs.existsSync(cordis), `preset 有 agent.cordis.yml：${id}`);
  return { dir, yml: fs.readFileSync(cordis, 'utf8'), cordis };
}

// ---------------------------------------------------------------------------
test('模拟会话的 preset 都挂了工具守卫（否则 L7 没有任何载体）', () => {
  for (const id of GLOBAL_AGENT_PRESETS) {
    const { yml } = readPreset(id);
    assert.match(
      yml,
      /qq-tool-restrict/,
      `${id} 必须挂载 qq-tool-restrict（L7 的落点），否则本地工具会随全局层继承进来`,
    );
    // The preset source uses a relative guard path; the generated bundle patch rewrites it
    // to the profile-resolvable package specifier checked by test-agent-preset-patches.mjs.
    assert.match(yml, /\.\/qq-tool-restrict\.mjs/, `${id} 的守卫要指向本目录的 .mjs`);
  }
});

test('desktop-agent 源 preset 默认关闭 tool-web 的 search/fetch', () => {
  for (const id of GLOBAL_AGENT_PRESETS) {
    const { yml } = readPreset(id);
    const webRow = /id:\s*tool-web[\s\S]{0,200}/.exec(yml);
    assert.ok(webRow, `${id} 应有 tool-web 条目`);
    assert.match(webRow[0], /search:\s*false/, `${id}: tool-web.search 必须为 false`);
    assert.match(webRow[0], /fetch:\s*false/, `${id}: tool-web.fetch 必须为 false`);
  }
});

test('守卫拒绝每一个已知本地执行工具', async () => {
  for (const id of GLOBAL_AGENT_PRESETS) {
    const guardPath = GUARD_PATH;
    assert.ok(fs.existsSync(guardPath), `${id} 的守卫文件存在`);

    // 用假 tools 服务调用真实守卫，捕获它实际下发的 restrict 请求。
    const restricted = new Set();
    const fakeTools = {
      restrict({ deny }) { for (const n of deny ?? []) restricted.add(n); },
      guard(fn) { this._guard = fn; },
    };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    assert.ok(restricted.size > 0, `${id}: restrict 至少应隐藏已知危险的全局工具`);
    assert.equal(typeof fakeTools._guard, 'function', `${id}: 守卫注册了执行期白名单`);
    for (const tool of LOCAL_EXECUTION_TOOLS) {
      const verdict = fakeTools._guard({ name: tool });
      assert.ok(
        typeof verdict === 'string' && verdict.length > 0,
        `${id}: 本地工具 "${tool}" 必须在执行期被拒绝，实际返回 ${JSON.stringify(verdict)}`,
      );
    }
  }
});

test('restrict 实际下发的名字与守卫导出的隐藏全局工具名单一致', async () => {
  for (const id of GLOBAL_AGENT_PRESETS) {
    const mod = await import(pathToFileURL(GUARD_PATH).href);
    assert.ok(
      Array.isArray(mod.RESTRICTED_TOOL_NAMES) && mod.RESTRICTED_TOOL_NAMES.length > 0,
      `${id}: 守卫必须导出 RESTRICTED_TOOL_NAMES，供测试对账`,
    );
    const restricted = new Set();
    mod.apply({ tools: { restrict: ({ deny }) => deny.forEach(name => restricted.add(name)), guard() {} } });
    assert.deepEqual([...restricted].sort(), [...mod.RESTRICTED_TOOL_NAMES].sort(),
      `${id}: 实际 restrict 名单必须与权威导出一致`);
  }
});

test('守卫名单里的每个名字都是 DSH 真实注册的工具（防拼错假名静默失效）', async () => {
  // 为什么必须测：`tools.restrict()` 对未知名字会**抛错**，而守卫逐个 try/catch
  // 只打日志 ⇒ 拼错的名字 = **静默 no-op**。这正是本名单初版的真实缺陷：
  // pwsh_persistent / bash_persistent / cordis / goal_write / goal_read 五个假名
  // 让整批限制悄悄少生效，而套件当时全绿。
  const dshNames = collectDshToolNames();
  if (dshNames === null) {
    console.log('  ⏭  跳过：未找到 DSH 工具包（设 DSH_TOOL_PACKAGES 指向 @deepseek-ai 目录即可启用）');
    return;
  }
  for (const id of GLOBAL_AGENT_PRESETS) {
    const mod = await import(pathToFileURL(GUARD_PATH).href);
    const fabricated = mod.RESTRICTED_TOOL_NAMES
      .filter((n) => !DEV_TOOL_PREFIX.test(n) && !OPTIONAL_BUNDLE_TOOLS.has(n) && !dshNames.has(n));
    assert.deepEqual(fabricated, [],
      `${id}: 以下名字在 DSH 已安装的工具包里找不到 ⇒ restrict 会抛错并被吞掉，`
      + `限制静默失效：${fabricated.join(', ')}`);
  }
});

test('守卫放行全局数字角色 MCP 命名空间与 DSH 网页工具', async () => {
  for (const id of GLOBAL_AGENT_PRESETS) {
    const guardPath = GUARD_PATH;
    const fakeTools = { restrict() {}, guard(fn) { this._guard = fn; } };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    for (const prefix of EXPECTED_SAFE_PREFIXES) {
      assert.equal(
        fakeTools._guard({ name: `${prefix}some_tool` }), undefined,
        `${id}: MCP 前缀 ${prefix} 应放行`,
      );
    }
    for (const name of ['ask_user_question', 'todo_write']) {
      assert.ok(typeof fakeTools._guard({ name }) === 'string', `${id}: 已移除的工具应拒绝 ${name}`);
    }
    for (const name of ['web_search', 'web_fetch']) {
      assert.equal(fakeTools._guard({ name }), undefined, `${id}: DSH 配置启用的工具应放行 ${name}`);
    }
    // 未知工具名必须 fail-closed。
    for (const name of ['', null, undefined, 'mcp__unknown__x', 'totally_new_tool']) {
      assert.ok(
        typeof fakeTools._guard({ name }) === 'string',
        `${id}: 未知工具 ${JSON.stringify(name)} 必须被拒绝（fail-closed）`,
      );
    }
  }
});
