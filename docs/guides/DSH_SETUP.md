# DSH 端安装说明

本文说明如何把兼容用的 `qq-chat-v2`、全局 `desktop-agent` preset 与 MCP 工具安装到目标 DSH profile。新的 QQ 注意信号及 WebUI 任务都进入同一个全局桌面助手。这里不配置或切换 DSH 运行模式。

## 安装

在运行 DSH 的设备上获取仓库并安装依赖：

```bash
git clone https://github.com/Reshirem/qq-bridge.git
cd qq-bridge
npm install
```

Windows CMD 可用 `copy config.example.json config.json` 创建配置文件。填写 OneBot 的 `snowluma.wsUrl` / `snowluma.httpUrl` 和需要的 `snowluma.accessToken`。全局 desktop-agent 不要求填写 `allow.groups` / `allow.private`；它可读取账号的群/好友目录并面向任意合法会话 key 使用完整的当前 SnowLuma MCP 工具集。`ownerQQ` 只供兼容中的 QQ 管理命令使用。

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

1. 从 `dsh/agent-presets/` 的权威源生成 `qq-chat-v2` 和 `desktop-agent` 的 bundle patch，并注册 `qq-agent-presets`。
2. 将 `mcp-snowluma`、`mcp-snowluma-host`、`mcp-web-search-safe` 三个受控 MCP 条目写入目标 profile 的 `cordis.patch.yml`。
3. 注册 `qq-agent-presets` 和 host 配置插件 bundle。host 插件的既有包名 `qq-mode-console` 为兼容性名称，当前仅承载管理配置，不提供运行模式切换。
4. 尝试执行 `dsh plugin --profile <profile> install` 安装 bundle 依赖；如 DSH CLI 不可用，会提示手动执行命令。

脚本可重复运行；修改 MCP 配置前会备份目标文件，解析失败时不会覆盖它。preset patch 是生成文件，修改 preset 时请编辑 `dsh/agent-presets/<preset>/` 下的源文件，然后运行：

```bash
node scripts/build-agent-preset-patches.mjs
```

如果把仓库移动或重新 clone 到新路径，请再次运行 `setup-dsh.mjs`，以更新 profile 中的 MCP 路径和 bundle 链接。`QQ_BRIDGE_SKIP_DSH_INSTALL=1` 可跳过脚本调用 DSH CLI，之后需手动安装依赖。

> DSH 0.1.7 起不再读取旧的 `~/.dsh/.agent-presets/<name>/` 目录。安装脚本只报告并保留该旧目录，不会删除或迁移其中的手工修改；如有自定义内容，请自行合并到仓库源文件。

安装完成后，重启 DSH（或重新加载 profile），使 preset 和 MCP 工具生效。脚本不设置 DSH 运行模式，也不创建 `state/mode.json`；历史 `qq-mode` 兼容命名空间仍承载 `ownerQQ` 管理员配置，旧 `mode` 字段不参与运行。

个人桌面助手要求目标 profile 已安装并启用 `dsh-computer-use-win`，并配置本项目的 SnowLuma MCP servers。项目只读取 computer-use 插件的工具命名空间并在 preset 中授权，不复制或打包插件本体。`desktop-agent` 可使用 `mcp__wincu__*`、完整的当前 `mcp__snowluma__*` QQ 工具集、只读的 `mcp__snowluma-host__snowluma_status` 及无害的 ask-user/todo 工具；它能按需列出账号的群和好友、读写任意合法会话 key。未由本桥接注册的 SnowLuma 群管理 API不在这套工具里。其它 MCP 和 DSH 本地执行工具仍被拒绝。会话可由 WebUI 任务或 QQ 注意信号懒创建。

更新 `desktop-agent` preset 并重启 DSH 后，已存在的全局 DSH session 仍保留创建时的 preset。打开桥接 WebUI 的“全局桌面助手”面板，选择“重建会话以加载新提示词”。桥接会先确认当前没有活动回合，再归档旧 session 并创建新的 `desktop-agent` session；DSH 中的旧会话历史会保留。

## 验证

可以先运行不依赖在线 DSH 的回归：

```bash
node scripts/build-agent-preset-patches.mjs --check
node scripts/test-setup-dsh-idempotent.mjs
node scripts/test-autonomy-policy.mjs
node scripts/test-preset-local-tools.mjs
node scripts/test-audit-setup-guards.mjs
```

确认 DSH `agentPresets/list` 能列出 `desktop-agent`。全局桌面助手应看到 `mcp__wincu__*`、完整的 `mcp__snowluma__*`、只读 `mcp__snowluma-host__snowluma_status`、`ask_user_question` 和 `todo_write`，不应出现 shell、通用文件工具、子代理或 Harness 管理工具。旧 `qq-chat-v2` 仅供已经存在的逐 QQ 映射会话兼容使用。缺少 `desktop-agent` 时，桥接不会回退到 DSH 默认 preset。

如要验证当前 DSH 版本的协议兼容性，可运行 `npm run verify:adaptation`；其中部分检查需要正在运行且可访问的 DSH。不要把该在线探测与上述离线测试混为一谈。

## 常见问题

- **QQ 信号没有启动全局会话**：确认 SnowLuma 事件进入桥接，且私聊或群聊原生 @ / 验证回复 / 配置关键词符合注意信号规则；普通群消息只缓冲。再检查 DSH preset 清单是否包含 `desktop-agent`。
- **桌面助手不可用**：确认 `desktop-agent` 已出现在 DSH preset 清单，且 DSH profile 中的 `dsh-computer-use-win` 已启用；更新 bundle 后重启 DSH，再从 WebUI 提交任务或触发一条 QQ 注意信号。
- **`cannot resolve profile bundle`**：从仓库目录运行 `dsh plugin --profile <profile> install`，确认 profile 的 `package.json` 有 `qq-agent-presets` 和 host 配置 bundle 依赖，然后重启 DSH。
- **MCP 工具不见了**：检查目标 profile 的 `cordis.patch.yml` 是否有三个 `mcp-*` 条目及当前仓库路径，重跑 `node scripts/setup-dsh.mjs <profile>` 并重启 DSH。
- **preset 未出现**：检查 `qq-agent-presets` bundle 是否注册并安装，再运行 `node scripts/build-agent-preset-patches.mjs --check`；修改源文件后需重新生成 patch 并重启 DSH。
- **401 / Cookie 鉴权失败**：确认 `DSH_HOME` 指向当前 DSH 根目录且本机凭据可读。`dsh.authToken` 通常应留空；详见根目录 README 的配置说明。
- **DSH Desktop 重启后桥接连不上**：桌面版可能在重启时换 API 端口；确认 DSH 已启动，再重启桥接触发端口重新发现。
- **SnowLuma 收不到 QQ 事件**：桥接只探测 OneBot 网关，不启动或控制 SnowLuma。检查 SnowLuma 自己的日志、QQ 登录状态以及 OneBot HTTP/WebSocket 配置。

## 唤醒与消息读取模型

- 私聊、真正发给机器人的原生 @、已验证回复/引用和可选关键词只向全局桌面助手发不含消息正文的提醒；是否处理由 agent 自行判断。
- 普通群消息正文保存在桥接侧，不会自动注入模型。全局 agent 可先用 `qq_list_conversations` 发现群/好友，再按需调用消息、历史或成员读取工具。
- 没有模型心跳或定时轮询。工具等待、读取和发送都由当前 agent 回合主动决定；回合文本不会自动转发到 QQ。
- 全局桌面助手通过 SnowLuma MCP 发送需活动回合令牌，任意合法群/私聊 key 均可用，不要求命中逐会话白名单；发送仍接受速率限制与审计。若助手通过 QQ 桌面 UI 操作，行为不经过这些桥接 API 检查。

更多权限与安全约束见 [RULES.md](../../RULES.md)。
