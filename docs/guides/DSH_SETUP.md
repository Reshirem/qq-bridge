# DSH 端安装说明

本文说明如何把唯一的全局 `desktop-agent` preset 与 MCP 工具安装到目标 DSH profile。WebUI 任务和 QQ 注意信号都进入同一个全局陪伴者。这里不配置或切换 DSH 运行模式。

## 安装

在运行 DSH 的设备上获取仓库并安装依赖：

```bash
git clone https://github.com/Reshirem/qq-bridge.git
cd qq-bridge
npm install
```

Windows CMD 可用 `copy config.example.json config.json` 创建配置文件。填写 OneBot 的 `snowluma.wsUrl` / `snowluma.httpUrl` 和需要的 `snowluma.accessToken`。全局 desktop-agent 可读取账号的群/好友目录并面向任意合法会话 key 使用完整的当前 SnowLuma MCP 工具集。`ownerQQ` 是可选的管理者身份标记，用于在 QQ 消息上下文中区分管理者；桥接不解析 QQ 管理命令。也可在 DSH 设置的 `qq-agent-presets.ownerQQ` 中填写。DSH 运行模式字段不参与运行。

长期记忆为可选能力。Windows 上可在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\a-memorix.ps1 setup
```

脚本使用官方 [`v2.0.0a4` 发布](https://github.com/A-Dawn/A_memorix/releases/tag/v2.0.0a4)中的 Python wheel 和 Windows Gateway，并在安装前校验固定的 SHA-256。此部署不需要 Docker 或 Go；需要 Python 3.12+。脚本会建立 namespace `qq-bridge`、生成本机管理员令牌和 namespace API key、设置 `config.json` 并启动服务。发布版本固定在 `scripts/a-memorix.ps1`；运行时文件、虚拟环境、密钥、数据库和日志都位于被忽略的 `state/a-memorix/`。不需要把 A_Memorix 源码 clone 到 qq-bridge，也没有设置 Git submodule。

WebUI 的“浏览全部”由桥接自动调用仓库内的只读 Python 脚本，并复用上述 `state/a-memorix/venv/`，不需另装 Python 包或手动运行脚本。它只能浏览本项目 `state/a-memorix/data/` 中的 namespace 原始记录。若虚拟环境缺失或损坏，可重新运行 `setup`；若预期账本数据缺失，应检查 `config.toml` 中的数据目录并从备份恢复，重新 `setup` 不会恢复已丢失的记录。单独配置另一个 Gateway 不会把它的数据库带到这个本机读取路径；Gateway 相关度检索和常规记忆操作仍使用设置页里的连接。详细范围见 [长期记忆方案](MEMORY_ARCHITECTURE.md)。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\a-memorix.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\a-memorix.ps1 start
powershell -ExecutionPolicy Bypass -File scripts\a-memorix.ps1 stop
```

初始 namespace 允许 metadata-only 写入并启用 sparse 检索，因此不需要外部模型凭据即可先保存和按关键词检索。语义向量和自动关系抽取尚未启用；需要另行配置 A_Memorix 的 Embedding/LLM Provider 后才能使用。A_Memorix 2.x 当前仍处于 alpha 阶段；若要升级，先核对上游版本与 Gateway 协议，再同步修改脚本中的版本和校验值。记忆内容由桥接发送到本机 Gateway；如配置了 Provider，A_Memorix 会按其服务配置处理相应数据。

Windows 下使用 `start.bat` 启动桥接时，只要本机 A_Memorix 已通过 `setup` 安装，启动器会先尝试启动 Gateway 和记忆服务；启动失败会显示警告，但不会阻止桥接运行。直接使用 `npm start` 时，需先单独运行脚本的 `start` 操作。

如果在桥接运行期间首次运行了 `setup`，重启一次 qq-bridge 以读取脚本写入的 namespace 凭据。之后无需改 `config.json`，可在 WebUI「长期记忆 → 设置 → 桥接连接与启动摘要」中设置启用状态、本机 Gateway 地址、已创建的 namespace、namespace API key、请求超时和首次摘要上限。Gateway 地址只允许本机回环地址；切换 namespace 前需先在 A_Memorix 中创建它。保持 `config.example.json` 中的 `memory.enabled: false` 即为关闭状态；未配置时桥接仍可正常运行，WebUI 会显示连接状态。

启用后可在 WebUI「长期记忆 → 设置 → A_Memorix 模型服务」中手动配置 OpenAI 兼容的 Embedding / LLM 服务地址、模型、向量维度、生成参数和 API Key。A_Memorix 目前使用 OpenAI Chat Completions；请确保所填服务兼容该协议。Provider 密钥只写入本机受 ACL 保护的 `state/a-memorix/secrets/`，页面只显示是否已保存；应用 Provider 设置会重启 A_Memorix。配置前请确认对应服务是否会接收记忆内容及是否计费。

Windows DSH 桌面版可能动态分配 Web API 端口。`dsh.autoDetectPort` 默认开启，桥接会在**每次启动时**识别由 DeepSeek Harness 进程持有并经 API 确认的本机监听端口，因此应先启动 DSH，再启动桥接。发现的 URL 只用于当前桥接进程，不写回 `config.json`。未发现桌面 API 时使用 `dsh.baseUrl`（默认 `http://127.0.0.1:3080`）作为回退；非 Windows 或固定端口部署可设置 `dsh.autoDetectPort: false`。如果匹配到多个可用 API 且 `dsh.baseUrl` 不在其中，桥接会拒绝猜测；将 `dsh.baseUrl` 指向目标实例即可明确选择。DSH Desktop 重启后若换了端口，重启桥接以重新发现。

这个 API 端口由 DSH 本身开放；profile 里的 MCP 插件通过 stdio 启动，不另开 API 端口。桥接控制台的 `consolePort` 是独立端口，默认固定为 `3100`，占用时会报错退出。

运行安装脚本：

```bash
node scripts/setup-dsh.mjs
```

默认使用 `web` profile；若使用另一个 profile，可传单个 profile 目录名：

```bash
node scripts/setup-dsh.mjs <profile>
```

也可通过 `DSH_HOME` 指定 DSH 根目录：

```bash
DSH_HOME=/path/to/.dsh node scripts/setup-dsh.mjs <profile>
```

脚本会：

1. 从 `dsh/agent-presets/` 的权威源生成唯一 `desktop-agent` 的 bundle patch，并将用于管理者身份标记的 `qq-agent-presets.ownerQQ` 设置层一并注册进同一个 `qq-agent-presets` bundle。
2. 将 `mcp-snowluma`、`mcp-snowluma-host`、`mcp-web-search-safe`、`mcp-qq-memory` 四个受控 MCP 条目写入目标 profile 的 `cordis.patch.yml`。记忆 MCP 始终由桥接托管；只有配置并启用 A_Memorix 后才能实际读写。
3. 从目标 profile 移除旧的 `qq-mode-console` bundle 及安装脚本创建的链接，并注册合并后的 `qq-agent-presets`。
4. 尝试执行 `dsh plugin --profile <profile> install` 安装 bundle 依赖；如 DSH CLI 不可用，会提示手动执行命令。

脚本可重复运行；修改 MCP 配置前会备份目标文件，解析失败时不会覆盖它。preset patch 是生成文件，修改 preset 时请编辑 `dsh/agent-presets/<preset>/` 下的源文件，然后运行：

```bash
node scripts/build-agent-preset-patches.mjs
```

如果把仓库移动或重新 clone 到新路径，请再次运行 `setup-dsh.mjs`，以更新 profile 中的 MCP 路径和 bundle 链接。`QQ_BRIDGE_SKIP_DSH_INSTALL=1` 可跳过脚本调用 DSH CLI，之后需手动安装依赖。

> DSH 0.1.7 起不再读取旧的 `~/.dsh/.agent-presets/<name>/` 目录。安装脚本只报告并保留该旧目录，不会删除或迁移其中的手工修改；如有自定义内容，请自行合并到仓库源文件。

安装完成后，重启 DSH（或重新加载 profile），使 preset、管理者身份标记设置和 MCP 工具生效。脚本不设置 DSH 运行模式，也不创建 `state/mode.json`。`ownerQQ` 设置现在位于 `qq-agent-presets.ownerQQ`；旧 `qq-mode.ownerQQ` 值不会自动迁移，需要在新命名空间重新填写。

电脑操作能力要求目标 profile 已安装并启用 `dsh-computer-use-win`，并配置本项目的 SnowLuma MCP servers。项目只读取 computer-use 插件的工具命名空间并在 preset 中授权，不复制或打包插件本体。`desktop-agent` 可使用 `mcp__wincu__*`、完整的当前 `mcp__snowluma__*` QQ 工具集、只读的 `mcp__snowluma-host__snowluma_status`、可选配置的 `mcp__qq-memory__*` 记忆工具及无害的 ask-user/todo 工具；它能按需列出账号的群和好友、读写任意合法会话 key。记忆工具通过桥接 API 访问固定的 A_Memorix namespace，MCP 不接触 A_Memorix 数据文件或 namespace API key。未由本桥接注册的 SnowLuma 群管理 API 不在这套工具里。其它 MCP 和 DSH 本地执行工具仍被拒绝。会话可由 WebUI 任务或 QQ 注意信号懒创建；WebUI 也可单独创建持久会话而不启动模型回合。

### 图片与动图依赖

图片读取工具会把大图缩小后再交给模型，并把 GIF/动态表情抽帧拼图；这些处理需要 FFmpeg。安装脚本和桥接启动时都会检查 FFmpeg，控制台的会话面板也会显示缺失警告。没有 FFmpeg 时，小图通常仍可读取，但超过 1 MiB 的图片可能无法提供给模型；动图无法生成多帧预览，超过上限时也可能无法读取。

安装 FFmpeg 后，把 `FFMPEG_PATH` 指向 `ffmpeg.exe`，或将其所在目录加入 `PATH`。例如在 PowerShell 中：

```powershell
$env:FFMPEG_PATH = 'C:\tools\ffmpeg\bin\ffmpeg.exe'
npm start
```

该写法只对当前 PowerShell 窗口及其启动的进程生效。若通过 `start.bat` 启动，脚本会在未设置 `FFMPEG_PATH` 时自动检查仓库旁边的 `..\ffmpeg\bin\ffmpeg.exe`；其它安装位置请在 Windows 用户环境变量中设置 `FFMPEG_PATH`。修改环境变量后重新打开启动窗口并重启桥接。图片工具失败时，陪伴者会收到具体原因；缺少 FFmpeg 时应向用户说明部署依赖未配置。

固定前缀在 WebUI“全局陪伴者”面板中按用途分模块维护。模块源文件是 `dsh/agent-presets/desktop-agent/prompt-modules.json`，组合后的内容写入 `agent.cordis.yml` 并生成 bundle patch。每个内置模块都可单独编辑；可选模块可切换是否写入提示词，必要的会话、安全和回合收尾模块保持启用。编辑时也可以逐个添加自定义模块，为其填写名称和正文、单独启用或删除；自定义模块会追加在固定前缀末尾并持久保存。开关只控制提示词文本：长期记忆实际是否可用仍由 WebUI“长期记忆”页管理，`agent_rest` 仍负责正常结束活动回合。保存后需重启 DSH，并在桥接 WebUI 选择“重建会话以加载新提示词”。桥接会先确认当前没有活动回合，再归档旧 session 并创建新的 `desktop-agent` session；DSH 中的旧会话历史会保留。

同一面板下方的“运行时提示模板”维护桥接在具体事件中追加的文本，包括人格卡首次注入、QQ 来源提醒、休息到期/QQ 打断/异常恢复，以及长期记忆开场摘要。这些模板保存在 `config.json` 的 `desktopAgent.promptTemplates`，保存后立即用于后续对应事件；人格卡与记忆摘要只在新建或重建会话的首次提示中出现。模板里的花括号占位符需要保留，WebUI 会说明每个字段可用的占位符。

## 验证

可以先运行不依赖在线 DSH 的回归：

```bash
node scripts/build-agent-preset-patches.mjs --check
node scripts/test-setup-dsh-idempotent.mjs
node scripts/test-autonomy-policy.mjs
node scripts/test-preset-local-tools.mjs
node scripts/test-audit-setup-guards.mjs
```

确认 DSH `agentPresets/list` 能列出 `desktop-agent`。全局陪伴者应看到 `mcp__wincu__*`、完整的 `mcp__snowluma__*`、只读的 `mcp__snowluma-host__snowluma_status`、`mcp__qq-memory__*`、`ask_user_question` 和 `todo_write`，不应出现 shell、通用文件工具、子代理或 Harness 管理工具。记忆未启用时，调用记忆工具会收到明确的配置错误。缺少 `desktop-agent` 时，桥接不会回退到 DSH 默认 preset。旧 `qq-chat-v2` preset 已从当前仓库安装包移除；历史 DSH 会话由 DSH 自己保留，桥接不再管理它们。

如要验证当前 DSH 版本的协议兼容性，可运行 `npm run verify:adaptation`；其中部分检查需要正在运行且可访问的 DSH。不要把该在线探测与上述离线测试混为一谈。

## 常见问题

- **QQ 信号没有启动全局会话**：确认 SnowLuma 事件进入桥接，且私聊或群聊原生 @ / 验证回复 / 配置关键词符合注意信号规则；普通群消息只缓冲。再检查 DSH preset 清单是否包含 `desktop-agent`。
- **陪伴者会话不可用**：确认 `desktop-agent` 已出现在 DSH preset 清单，且 DSH profile 中的 `dsh-computer-use-win` 已启用；更新 bundle 后重启 DSH，再从 WebUI 提交任务或触发一条 QQ 注意信号。
- **`cannot resolve profile bundle`**：从仓库目录运行 `dsh plugin --profile <profile> install`，确认 profile 的 `package.json` 已注册 `qq-agent-presets`，然后重启 DSH。
- **MCP 工具不见了**：检查目标 profile 的 `cordis.patch.yml` 是否有三个 `mcp-*` 条目及当前仓库路径，重跑 `node scripts/setup-dsh.mjs <profile>` 并重启 DSH。
- **preset 未出现**：检查 `qq-agent-presets` bundle 是否注册并安装，再运行 `node scripts/build-agent-preset-patches.mjs --check`；修改源文件后需重新生成 patch 并重启 DSH。
- **401 / Cookie 鉴权失败**：确认 `DSH_HOME` 指向当前 DSH 根目录且本机凭据可读。`dsh.authToken` 通常应留空；详见根目录 README 的配置说明。
- **DSH Desktop 重启后桥接连不上**：桌面版可能在重启时换 API 端口；确认 DSH 已启动，再重启桥接触发端口重新发现。
- **SnowLuma 收不到 QQ 事件**：桥接只探测 OneBot 网关，不启动或控制 SnowLuma。检查 SnowLuma 自己的日志、QQ 登录状态以及 OneBot HTTP/WebSocket 配置。

## 唤醒与消息读取模型

- 私聊、真正发给机器人的原生 @、已验证回复/引用和可选关键词只向全局陪伴者发不含消息正文的提醒；是否处理由 agent 自行判断。
- 普通群消息正文保存在桥接侧，不会自动注入模型。全局 agent 可先用 `qq_list_conversations` 发现群/好友，再按需调用消息、历史或成员读取工具。
- 没有模型心跳或定时轮询，也不靠长等待工具维持在线。每个活动回合必须以 `agent_rest` 作为最后一个工具调用；可设 1 秒至 12 小时的休息，或省略时长进入无限休息。用户可直接在 DSH 对话中发消息，或提交 WebUI 任务；有效 QQ 提醒也可提前结束休息并唤醒一轮。休息期间异常回合的指数恢复重试暂停。
- 回合未调用 `agent_rest` 就结束时，桥接按 1、2、4、8、16 分钟递增恢复尝试，之后最长每 30 分钟尝试一次。WebUI“停止自主运行”会取消当前和排队的 DSH 工作并持久停用自动恢复；只有从 WebUI 手动启动或提交任务才会恢复。
- 工具等待、读取和发送都由当前 agent 回合主动决定；回合文本不会自动转发到 QQ。
- 全局陪伴者通过 SnowLuma MCP 发送时自动使用全局 agent 令牌，任意合法群/私聊 key 均可用；`agent_rest` 不限制休息或停止状态中的后续工具调用，发送仍接受速率限制与审计。若陪伴者通过 QQ 桌面界面操作，行为不经过这些桥接 API 检查。

更多权限与安全约束见 [RULES.md](../../RULES.md)。
