# DSH 端安装说明

本文说明如何把 `qq-bridge` 的固定 QQ 会话 preset 与安全 MCP 工具安装到目标 DSH profile。每个允许的 QQ 会话使用独立、持久的 DSH session，并固定采用 `qq-chat-v2`。这里不配置或切换 DSH 运行模式。

## 安装

在运行 DSH 的设备上获取仓库并安装依赖：

```bash
git clone https://github.com/Reshirem/qq-bridge.git
cd qq-bridge
npm install
```

Windows CMD 可用 `copy config.example.json config.json` 创建配置文件。填写 OneBot 的 `snowluma.wsUrl` / `snowluma.httpUrl`、需要的 `snowluma.accessToken`、`ownerQQ`，以及明确的 `allow.groups` / `allow.private`。示例配置默认 fail-closed：空白名单且 `allowAllWhenEmpty: false` 时不会处理 QQ 会话。

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

1. 从 `dsh/agent-presets/` 的权威源生成固定 `qq-chat-v2` 的 bundle patch，并注册 `qq-agent-presets`。
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

## 验证

可以先运行不依赖在线 DSH 的回归：

```bash
node scripts/build-agent-preset-patches.mjs --check
node scripts/test-setup-dsh-idempotent.mjs
node scripts/test-autonomy-policy.mjs
node scripts/test-preset-local-tools.mjs
node scripts/test-audit-setup-guards.mjs
```

确认 DSH `agentPresets/list` 能列出 `qq-chat-v2`，并在新建的测试 session 中检查工具面：应看到 `mcp__snowluma__*`、`mcp__snowluma-host__*` 和 `mcp__web-search-safe__*`，不应出现 shell、文件写入或 Harness 管理工具。桥接会严格要求 `qq-chat-v2` 存在；缺失时拒绝为 QQ 创建 session，不会回退到 DSH 默认 preset。

如要验证当前 DSH 版本的协议兼容性，可运行 `npm run verify:adaptation`；其中部分检查需要正在运行且可访问的 DSH。不要把该在线探测与上述离线测试混为一谈。

## 常见问题

- **QQ 收不到回复，但 SnowLuma 在线**：先查看桥接日志中的 `qq-chat-v2` 缺失/会话创建错误，再确认 DSH 侧已重启并且 `agentPresets/list` 包含该 preset。它缺失时桥接会 fail closed，不会使用包含本地工具的默认 preset。
- **`cannot resolve profile bundle`**：从仓库目录运行 `dsh plugin --profile <profile> install`，确认 profile 的 `package.json` 有 `qq-agent-presets` 和 host 配置 bundle 依赖，然后重启 DSH。
- **MCP 工具不见了**：检查目标 profile 的 `cordis.patch.yml` 是否有三个 `mcp-*` 条目及当前仓库路径，重跑 `node scripts/setup-dsh.mjs <profile>` 并重启 DSH。
- **preset 未出现**：检查 `qq-agent-presets` bundle 是否注册并安装，再运行 `node scripts/build-agent-preset-patches.mjs --check`；修改源文件后需重新生成 patch 并重启 DSH。
- **401 / Cookie 鉴权失败**：确认 `DSH_HOME` 指向当前 DSH 根目录且本机凭据可读。`dsh.authToken` 通常应留空；详见根目录 README 的配置说明。
- **SnowLuma 收不到 QQ 事件**：桥接只探测 OneBot 网关，不启动或控制 SnowLuma。检查 SnowLuma 自己的日志、QQ 登录状态以及 OneBot HTTP/WebSocket 配置。

## 唤醒与消息读取模型

- 私聊来信在对应会话允许时唤醒；群聊仅真正发给机器人的原生 @ 或已验证回复/引用机器人消息唤醒。
- 普通群消息保存在桥接侧，不会被周期性送入模型。直接唤醒快照只包含触发消息；agent 需要更多上下文时，按需调用未读、最近消息或会话历史读取工具。
- 没有模型心跳或定时轮询。工具等待、读取和发送都由当前 agent 回合主动决定；回合文本不会自动转发到 QQ。
- 任何 QQ 发送仍需活动回合令牌、目标白名单通过，并接受速率限制和审计。

更多权限与安全约束见 [RULES.md](../../RULES.md)。
