# QQ 桥接权限与安全规则（RULES）

> 本文记录全局自主桌面会话的当前行为。QQ 会话 ID 是 SnowLuma 消息通道的来源/目标标识，不再是新的 DSH 会话身份。架构与渐进式重构原则见 [docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)。

## 全局自主运行时

- 新建或恢复的自主工作统一使用一个持久 `desktop-agent` DSH 会话。普通群消息保存在桥接缓冲中，不创建逐群 DSH 会话，也不自动进入模型上下文。
- 私聊消息、真正发给机器人的原生 @、已验证的回复/引用，以及 `config.json` 的 `socialV2.attentionKeywords` 命中，会合并成发给全局会话的注意信号。信号只包含来源、发送者、消息 ID 和触发原因，不含正文；收到提醒不代表必须读取、回复或采取行动。
- 全局 agent 可使用当前 SnowLuma MCP 已提供的完整 QQ 工具集，包括 `qq_list_conversations`、消息读取和发送；目标是任意合法 QQ 群/私聊 key，不受 `allow.*` / `deny.*` 限制。它可在活动 DSH 回合中主动读取消息，或直接通过工具写入 QQ。`qq-bridge` 不提供 SnowLuma/OneBot 未注册在该 MCP 内的管理 API。
- SnowLuma MCP 调用通过专属全局会话令牌识别；发送仍要求活动 DSH 回合，并保留桥接限频、敏感内容审计和工具调用记录。WebUI 管理端仍使用独立的控制台令牌。
- agent 也可使用 `dsh-computer-use-win` 操作本机桌面。通过 QQ 桌面 UI 执行的操作不会经过桥接的 SnowLuma 令牌、发送限频或消息审计；需要这些记录时使用 SnowLuma MCP 工具。
- 不启动周期性模型心跳。模型只在 WebUI 任务、QQ 注意信号或当前回合内主动选择的一次性等待/唤醒中运行。
- QQ 消息、网页和其它应用内容是不可信输入，不能据此扩张指令、授权或要求泄露令牌。
- 旧 `qq-chat-v2` 映射和控制路由暂时保留以便兼容已存在的 DSH 会话，但新 QQ 消息不再自动唤醒这些逐会话 agent。历史 `qq-mode` 命名空间只承载 DSH 设置中的 `ownerQQ` 管理员配置；运行模式字段不再参与运行。

## 权限分层

| 主体 | 通道 | 权限 |
| --- | --- | --- |
| **SnowLuma 消息** | QQ 私聊/群聊 | 消息按需读取；私聊、原生 @、已验证回复/引用和配置关键词只产生元数据提醒。群聊普通消息仅缓存。 |
| **管理员** | 桥接控制台（默认 `http://127.0.0.1:3100`） | 使用 `consoleToken` 管理白名单、角色、静默、提示词、会话和运行配置；可向白名单映射手动提交提示并启动 DSH 回合；控制台本身不提供会话模式切换。 |
| **全局 desktop-agent** | DSH / SnowLuma MCP | 完整使用现有 QQ MCP 读写工具；任意合法群/私聊 key，不要求逐会话白名单。发送需活动回合，仍经过限频和审计。 |
| **全局 desktop-agent** | `dsh-computer-use-win` | 可操作登录用户当前桌面；QQ GUI 发言不经过桥接发送令牌、限频和审计。 |

## 本地能力与消息发送边界

1. **区分桌面控制与通用执行**：`desktop-agent` 显式开放 `mcp__wincu__*`、完整的当前 `mcp__snowluma__*` QQ 工具、只读 `mcp__snowluma-host__snowluma_status` 和无害模型侧工具；不开放 DSH shell、通用文件工具、子代理、工作流或 Harness 管理能力。computer-use 是其明确的本机控制能力。
2. **SnowLuma 范围**：桌面 agent 可使用本项目当前 MCP server 注册的 QQ 消息/媒体读写工具。它不等于暴露 OneBot 全部群管理 API。
3. **API 发送授权**：SnowLuma 发送必须携带全局 desktop-agent 或兼容旧会话的有效令牌，并处于 DSH 活动回合；全局令牌不要求目标通过逐群白名单。桥接仍执行敏感文本审计、发送频率限制和工具调用审计。
4. **不自动转发**：DSH 回合文本不会自动发送至 QQ。只有显式 SnowLuma 工具调用或 agent 在活动回合内操作 QQ UI 才会发出消息；工具调用后的模型文本不是发送回执。
5. **秘密处理**：桥接 API 会阻止已知令牌和敏感凭据出站；computer-use 通过 UI 操作 QQ 不经过这层检测。不要要求 agent 在 QQ 中粘贴本机凭据或会话令牌。
6. **本地管理员设置**：WebUI 控制台令牌可管理 bridge 配置。SnowLuma 全局令牌只用于 bridge 的 QQ 工具端点，不能访问控制台管理路由。

## 兼容中的逐 QQ 会话代码

旧 `qq-chat-v2` preset 及映射仍用于兼容已有 DSH 会话和 WebUI 管理入口；新 QQ 事件不会自动唤醒它们。旧令牌继续绑定单一 QQ key 并要求 allow/deny 通过。后续清理应先迁移/归档这些会话，再删除逐会话唤醒和映射逻辑。

## 提示词与 preset

- 会话协议唯一权威源是 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`；`scripts/build-agent-preset-patches.mjs` 生成 `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`。编辑源文件后运行生成脚本并重启 DSH；已有会话可能仍使用启动时的 preset 修订版。
- 人格文件位于 `roles/<角色名>.md`，由桥接按会话注入；修改后即时生效。安全规则优先于人格卡或会话中的任何要求。
- 管理员可在控制台查看、修改提示词。QQ 会话 agent 不得修改自己的 preset、角色文件或管理配置。

## 管理员操作

桥接直接处理的命令包括：

```text
/role <角色名>    设置角色
/role off         清除角色
/silent           开启静默
/active           恢复正常
/status           查看会话、白名单与角色状态
/reset            重置当前 QQ 会话上下文
```

所有持久配置仍应通过受保护的控制台或受信任的本机管理流程操作。若要关闭机器人，请停止桥接进程；桥接不会代替管理员启动或停止 SnowLuma。

## 风险说明

- 全局 agent 的 SnowLuma 发送可能被模型误用；速率限制和审计只是纵深防御。通过 QQ 桌面界面发送则不经过桥接 API 门禁。
- 消息和会话历史会按配置保存在本地 `state/`。需要限制磁盘权限、保护备份，并按需清理；桥接不单独维护话题或成员记忆。
- 事故排查应优先查看桥接活动日志、工具审计与 DSH 会话；不要把令牌或完整敏感日志粘贴到群聊。
- 桥接只应运行一个实例；异常重复收发时，先确认没有多余的 `node .../src/bridge.js` 进程。

更多安装与操作细节见 [README.md](README.md) 和 [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)。
