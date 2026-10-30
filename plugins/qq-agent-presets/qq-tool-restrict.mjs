// 全局 desktop-agent 的工具策略：开放 SnowLuma QQ 工具与 Windows computer-use，
// 同时拦截 DSH 的 shell、通用文件、子代理和管理工具。
//
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Shared tool policy implementation loaded by the desktop-agent preset bundle.
export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * Deny local execution, file, process, plugin-management, and cross-session tools.
 * Keep names aligned with the installed DSH registry; missing optional names are skipped individually.
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // Plugin and host runtime inspection
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // MCP resource access
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  // Agent delegation and external execution
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  // Plugin loading
  'plugin_manager',
  // Scheduling
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // Additional global and optional tools
  'working_directory',
  // Terminal access
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  // Cross-session history access
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  // Plugin loading and worktree creation
  'plugin_market', 'create_worktree',
  // Agent coordination
  'wait_agent',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

/** Tools from optional DSH bundles remain denied whenever they are registered. */
export const OPTIONAL_BUNDLE_TOOL_NAMES = Object.freeze([
  'subagent_codex',
  'subagent_claude_code',
])

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // Optional bundles
  ...OPTIONAL_BUNDLE_TOOL_NAMES,
  // Developer injection tools are registered at runtime; the execution guard is authoritative.
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// DSH's tool-web config controls registration; this allowlist only lets those
// native tools pass the desktop-agent execution guard when DSH has enabled them.
const SAFE_EXACT = new Set(['web_search', 'web_fetch'])

// Record bounded diagnostics for failed restrictions and retry after the tool registry loads.
const DIAG_FILE = (() => {
  // 测试可用 QQ_TOOL_RESTRICT_LOG 改到临时文件，避免污染真实 state/
  if (process.env.QQ_TOOL_RESTRICT_LOG) return path.resolve(process.env.QQ_TOOL_RESTRICT_LOG)
  try {
    // 本文件位于 <repo>/plugins/qq-agent-presets/，往上两层就是仓库根
    return fileURLToPath(new URL('../../state/tool-restrict.log', import.meta.url))
  } catch { return '' }
})()
const DESKTOP_AGENT_STATE_FILE = (() => {
  try {
    return fileURLToPath(new URL('../../state/desktop-agent.json', import.meta.url))
  } catch { return '' }
})()

const QQ_TOOL_PREFIXES = ['mcp__snowluma__', 'mcp__snowluma-host__']

function currentDesktopAgentSessionId() {
  if (!DESKTOP_AGENT_STATE_FILE) return ''
  try {
    const state = JSON.parse(fs.readFileSync(DESKTOP_AGENT_STATE_FILE, 'utf8'))
    return typeof state?.sessionId === 'string' ? state.sessionId.trim() : ''
  } catch { return '' }
}

function writeDiagnostics(lines) {
  if (!DIAG_FILE || !lines.length) return
  // 单行截断：DSH 的报错里会把**整份** known global tools 清单拼进去（实测单行 2KB+），
  // 不截就等于把日志变成噪声。保留开头足够定位的信息即可。
  const trim = (line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line)
  try {
    const previous = (() => {
      try { return fs.readFileSync(DIAG_FILE, 'utf8').split('\n').filter(Boolean) } catch { return [] }
    })()
    // 有界：只保留最近 20 条（每次 agent 创建都会写一轮，别让文件无限长）
    const next = [...previous, ...lines.map(trim)].slice(-20)
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true })
    fs.writeFileSync(DIAG_FILE, next.join('\n') + '\n', 'utf8')
  } catch {}
}

export function apply(ctx) {
  // 群/私聊是消息来源；所有自主操作都使用这一份全局 desktop-agent。
  // Hide known risky global tools. A missing optional name must not prevent the rest from being restricted.
  const stamp = new Date().toISOString()
  const failed = []
  const attempt = (names) => {
    let ok = 0
    for (const name of names) {
      try {
        ctx.tools.restrict({ deny: [name] })
        ok += 1
      } catch (error) {
        failed.push({ name, message: String(error?.message ?? error) })
      }
    }
    return ok
  }

  const firstOk = attempt(KNOWN_DANGEROUS_GLOBAL_TOOLS)
  const firstFailed = failed.slice()
  failed.length = 0

  if (firstFailed.length > 0) {
    // Group identical errors to keep the log readable.
    const reasons = [...new Set(firstFailed.map((f) => f.message))]
    console.error(
      `[qq-tool-restrict] restrict 失败 ${firstFailed.length}/${KNOWN_DANGEROUS_GLOBAL_TOOLS.length}：${reasons.join(' | ')}`
    )
    writeDiagnostics([
      `${stamp} restrict ok=${firstOk} failed=${firstFailed.length} 原因: ${reasons.join(' | ')}`,
      `${stamp} 失败样例: ${firstFailed.slice(0, 3).map((f) => f.name).join(', ')}`,
    ])
    // 时序兜底：注入器的工具可能在 preset apply 之后才注册进全局层。
    // 3 秒后重试失败项；成功则记一行，失败保留原因。
    const timer = setTimeout(() => {
      let ok = 0
      const still = []
      for (const { name } of firstFailed) {
        try { ctx.tools.restrict({ deny: [name] }); ok += 1 } catch (error) { still.push(`${name}: ${error?.message ?? error}`) }
      }
      if (ok > 0) console.error(`[qq-tool-restrict] 延迟重试补藏成功 ${ok} 个`)
      writeDiagnostics([
        `${new Date().toISOString()} 延迟重试 ok=${ok} 仍失败=${still.length}${still.length ? ` 原因: ${still[0]}` : ''}`,
      ])
    }, 3000)
    timer?.unref?.()
  }

  // DSH exposes the invoking session as exec.agent.id. The MCP provider is
  // shared by a profile, so bind QQ calls to the one bridge-owned session
  // before the MCP subprocess receives them. Missing state is fail-closed.
  if (typeof ctx.on === 'function') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const name = exec?.name
      if (typeof name !== 'string' || !QQ_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) return next()
      const expectedSessionId = currentDesktopAgentSessionId()
      const callerSessionId = String(exec?.agent?.id ?? '').trim()
      if (!expectedSessionId || callerSessionId !== expectedSessionId) {
        return { kind: 'deny', reason: 'QQ 工具仅允许桥接当前绑定的全局 desktop-agent 会话调用' }
      }
      return next()
    })
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (SAFE_EXACT.has(name)) return
    if (['mcp__wincu__', 'mcp__snowluma__', 'mcp__snowluma-host__', 'mcp__qq-memory__'].some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 Windows computer-use、SnowLuma QQ 工具和 A_Memorix 记忆工具）`
  })
}
