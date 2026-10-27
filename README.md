# QQ ↔ DeepSeek Harness 桥接

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 🗂️ 文档索引（全部文档一句话说明 + 是否仍然有效）见 **[docs/README.md](docs/README.md)**；仓库目录/脚本命名约定见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
>
> 🧭 当前运行架构与渐进式重构原则见 **[docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)**；代码代理修改指引见 **[AGENTS.md](AGENTS.md)**。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。

项目使用一个持久的全局 DSH 桌面 agent；WebUI 是主要控制入口，QQ 是它可自行使用的消息通道。SnowLuma 事件进入桥接缓冲；私聊、原生 @、已验证回复/引用和配置关键词只向全局会话发送不含正文的提醒，agent 可选择是否使用完整 SnowLuma MCP 工具集读取或写入 QQ，也可通过 `dsh-computer-use-win` 操作桌面。逐 QQ DSH 会话映射及其控制面已从当前代码和 preset 安装包移除。

> ⚠️ **当前版本 `v0.2.1-r1`，适配 DSH 0.2.1-rc.2**（0.2.0-rc.2 亦兼容；两个版本上都逐项实测：`npm run verify:adaptation`）。
> 鉴权用 `~/.dsh` 里持久化的浏览器会话签名密钥**离线铸造 Cookie** —— DSH 0.1.7 起进程启动 token
> 只存在于内存、不再落盘，旧版「从 guard 日志里读 token」的方式已失效。agent preset 是 DSH 0.1.7 起的
> `@deepseek-ai/dsh-agent-preset` Cordis 行（`~/.dsh/.agent-presets/` 目录机制已废）。协议代次
> （Cookie 鉴权 / 斜杠 RPC / `/api/remote.mux` 事件流）自 DSH `0.1.2-alpha.1` 起引入，与更早的点号
> endpoint 协议不兼容 —— **DSH `0.1.1-rc.2` 及更早**请改用 tag
> [`v0.1.0`](https://github.com/Reshirem/qq-bridge/releases/tag/v0.1.0)；**DSH 0.1.5-rc.1** 用
> [`v0.1.5`](https://github.com/Reshirem/qq-bridge/releases/tag/v0.1.5)；**DSH 0.1.7-rc.2** 用
> [`v0.1.7`](https://github.com/Reshirem/qq-bridge/releases/tag/v0.1.7)。
>
> v0.2.0 修的主要是**会话待处理队列读不出来**：桥接退役/重置 QQ 会话时要先清掉 DSH 侧没跑的队列，
> 而那段解析认的是一个**从来不存在的字段**（`session/control` baseline 的 `value.queues[<id>]`）——
> 于是**每一次**退役都抛 `invalid session/control baseline`，队列清不掉、旧任务继续在 DSH 里跑，
> 而日志里只有一行警告。**注意：这不是 0.2.0 引入的**——该代码随 v0.1.7 发布，报错日志早于
> 0.2.0-rc.2 的发布，0.2.0 只是把它翻了出来。现在读队列以一元 RPC `session/projections` 为主路径、
> 以 `projections[<id>].values.inbox` 为回退形状，并补了两条回归网。
> 同一轮还按 0.2.0 的真实工具清单重新对账了 QQ 安全守卫（新增 15 个必须隐藏的工具名，
> 含全局层默认启用的 `read_mcp_resource`、`plugin_manager`、`subagent_codex` 等）。
>
> 逐条改动说明见 [docs/guides/DSH_020_ADAPTATION.md](docs/guides/DSH_020_ADAPTATION.md)（0.2.0）
> 与 [docs/guides/DSH_021_ADAPTATION.md](docs/guides/DSH_021_ADAPTATION.md)（0.2.1）。
>
> **r4 主要改动**：QQ 表情包/动图链路（表情 CDN 优先、`emoji_id` 兜底、DNS 多地址故障切换）、
> 联网搜索改用与 DSH 同源的 DeepSeek 搜索（Bing 仅兜底）、`qq_wait_for_messages` 改 5 分钟长轮询、
> 固定自主会话的回合收尾与机器人身份注入修复，外加一轮整体体检。
> 逐条见 [**Release v0.2.0-r4**](https://github.com/Reshirem/qq-bridge/releases/tag/v0.2.0-r4)。
>
> **v0.2.1-r1 主要改动**：适配 DSH 0.2.1-rc.2。修掉一处 **P0**——persona 里的 `{{cwd}}`
> 提示词变量在 0.2.1 被删除，导致**每个回合在系统提示词装配阶段直接 error、模型一次都不跑**
> （QQ 侧表现为「发消息完全没反应」）；同时把 0.2.1 新进全局层的 `working_directory`
> 与 terminal / session-query / plugin_market 一族补进安全守卫名单。
> 逐条见 [docs/guides/DSH_021_ADAPTATION.md](docs/guides/DSH_021_ADAPTATION.md)。
>
> 默认分支 `main` **就是**本版本，`git clone` 直接拿到，无需切换分支。

```
WebUI 任务 ─────────────────────────► DSH 全局 desktop-agent ──► Windows 桌面 / SnowLuma MCP
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接缓冲 ──元数据提醒──► 同一个全局会话
```

## 项目展示

📽️ [AI 仿真群友 - 项目介绍视频](https://github.com/Reshirem/qq-bridge/releases/download/v0.1.5/project-intro.mp4)（约 11 MB）

> 视频改由 **Release 附件**托管，不在仓库里——只想安装桥接的人不必再下载这 11 MB（它此前占整个仓库体积的 88%）。

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：适配 DSH 0.1.2 起引入、**0.2.1-rc.2 上逐项复核**的协议——用本机持久化签名密钥铸造会话 Cookie 鉴权、`/api/<namespace>/<method>` 斜杠 RPC、`/api/remote.mux` + `session/follow` 事件流（`session/control` 的队列读 `value.projections[<id>].values.inbox`，另有一元 `session/projections` 主路径）；复用 `AbstractApiClient` 传输层但不再依赖旧版 zod value schema。全局会话创建后，桥接按 `config.json` 的 `dsh.model` 用 `session.selectModel` 固定模型（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入三个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：本项目当前注册的完整 QQ 消息/媒体读写工具集；全局桌面会话可面向任意合法群/私聊 key 使用。发送要求活动 DSH 回合，仍受限频和审计；这不包含未注册在 MCP 内的 OneBot 群管理 API。
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：**只有** `snowluma_status`（只读探活 `get_login_info`）。
    ⚠️ **v0.1.5 起移除了 `start_snowluma` / `stop_snowluma`**（以及 `snowluma.allowProcessControl` 配置项）——
    原因是 **SnowLuma EULA §5.4** 规定「将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**」
    须事先取得书面授权，而原生组件属专有组件。本程序**只探测、不部署**：SnowLuma 的安装、启动与扫码
    始终由你自己完成（详见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)）。
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 按需查公开资料。
    **搜索优先复用 DSH 原本的联网搜索**（同一个 DeepSeek Anthropic 兼容端点 + `web_search` 服务端工具，凭据按 `config.webSearch.apiKey` → 环境变量 `DEEPSEEK_API_KEY` → DSH 的 `.credentials.yaml` 顺序解析），
    因而结果质量与 DSH 内的搜索一致、且**不再默认把群聊关键词发给 Bing**（Bing RSS 只在 DeepSeek 不可用时兜底）。
    抓取由桥接自己做 SSRF 校验并限制正文大小。搜索只在 agent 明确调用时发生，不会自动从群聊提取词条或建立词库。
    数据出机清单见 [LICENSE](LICENSE) 的「数据出机清单」。
- **会话模型**：所有自主活动共用一个持久的 `desktop-agent` DSH 会话。QQ 群和私聊 ID 只作为消息来源/目标，不拆分 agent 上下文；全局助手可通过 `qq_list_conversations` 发现账号中的群和好友，再按需读写。桥接不再创建或管理逐 QQ DSH 会话。
- **个人桌面助手**：WebUI 的“会话控制”页可启动/继续自主探索、提交任务或持久停止；QQ 私聊、原生 @、已验证回复/引用或 `socialV2.attentionKeywords` 命中也会向同一个全局会话发送元数据提醒。普通群消息留在桥接缓冲，agent 选择是否通过 SnowLuma MCP 或 QQ 桌面界面查看和操作。每个活动回合以 `agent_rest` 结束：有限休息到期后恢复一轮，无限休息期间 QQ 提醒只缓冲；漏掉休息调用时按指数退避恢复，最长间隔 30 分钟。WebUI 停止会取消当前/排队任务并阻断自动恢复，只有 WebUI 手动任务能解除。
- **提示词维护**：全局助手固定使用 `desktop-agent` preset；人格提示词源位于 `dsh/agent-presets/desktop-agent/agent.cordis.yml`，WebUI 可编辑并生成 `plugins/qq-agent-presets/` bundle patch。DSH 0.1.7 起 preset 由 `@deepseek-ai/dsh-agent-preset` 行加载，保存后需重启 DSH，并重建全局会话才能获得新版提示词。
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——按操作任务提供运行总览、会话控制、助手提示词、提醒与消息、令牌与花费、访问与安全、调试与运维七个页面，右上角搜索框可跨页定位功能项；“会话控制”页启动/继续或停止全局桌面助手，提示词页维护 `desktop-agent`；支持**浅色 / 深色双主题**（顶栏一键切换，未选择时跟随系统）；可查看活动日志、维护关键词提醒、配置管理员/控制台令牌（`consoleToken` 未配置时自动生成并打印在启动日志；可在控制台内修改或重新生成）
  - **令牌与花费看板**：实时显示 AI 的 token 消耗与折算金额（元），可下钻到**每个群 / 每个好友 / 每一轮对话**（轮次、步数、缓存命中/未命中输入、输出、命中率、花费、峰谷时段），并有**按时间的消耗走势图**（24 小时 / 3 天 / 7 天 / 30 天，柱子按高峰/空闲着色，一眼看出什么时候烧得凶、哪几个小时是 2 倍价）。累计总量取自 DSH 的 `tokenUsage` 投影（精确，含桥接启动前的历史），逐轮明细由 `assistant/message` 的 `usage` 折叠而来；金额按 DeepSeek 官方价目表折算并区分**高峰 / 空闲时段**（高峰单价为空闲的 2 倍，已内置中国法定节假日）。详见 [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)
  - **人格（角色扮演）管理**：列表点选即可载入查看/编辑提示词，支持新建、保存修改、改名（自动重命名文件）、另存为副本、删除；全局会话开场只注入一次，超过字符上限会实时提示
  - **全局助手提示词**：WebUI 维护 `desktop-agent` 内置提示词，保存前校验 SnowLuma/QQ 通道核心约定，自动备份并重新生成 DSH bundle patch；重启 DSH 并重建全局会话后生效。当前选中的 `roles/*.md` 人格卡只在全局会话首次收到任务或提醒时注入一次；编辑或切换后，新卡片在新建或重建会话时生效。
  - **DSH 思考强度**：默认 `max`，可选 `high` / `low`，档位从 DSH 实际公布的能力读取，保存后下一条消息生效；控制台会明示该设置同时写入 DSH 全局默认（`~/.dsh/settings.yaml`）
- **全局 QQ 自主策略**：无周期模型心跳，也不靠长等待工具维持在线。每个活动回合必须最后调用 `agent_rest`；休息时 QQ 提醒只缓冲，未正常休息则以 1、2、4、8、16 分钟递增重试，之后最长每 30 分钟一次。私聊、原生 @、已验证回复/引用和配置关键词只产生不带正文的提醒，agent 可忽略；普通群消息只缓冲。SnowLuma MCP 读写使用全局会话令牌，可访问任意合法 QQ key，不依赖逐会话白名单；bridge API 发送仍要求活动回合并经过限频和审计。
- **个人桌面助手**：WebUI 和符合条件的 QQ 注意信号复用一个持久 `desktop-agent` DSH session。它可以使用 `dsh-computer-use-win` 和完整的当前 SnowLuma MCP 工具集。GUI 发送不经过桥接 API 限频和审计。
- **交互增强**：
  - 全局桌面助手通过 DSH 当前的用户交互流程与管理员沟通
  - 支持 DSH 斜杠命令（如 `/model`）；旧 QQ `/reset` 映射命令已停用，会提示在 WebUI 管理全局会话
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH，让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；只有被明确引用/回复到机器人时才会触发群聊唤醒，但唤醒不代表必须发言
  - **图片/表情（含动图 GIF）**：表情包优先走 QQ 的 CDN 直链，`get_image` 失败时用 `emoji_id` 推出 CDN 地址兜底；媒体元数据保留 `emoji_id`/`summary`/`sub_type` 等字段。下载走同一套 SSRF 防护传输，并修掉了「DNS 先返回 IPv6、本机没有 IPv6 出口 → 每次白等 20 秒」的根因（改为 **IPv4 优先 + 逐地址故障切换**），动图表情不再时好时坏。单条消息上限默认 8MB / 64MP / 5 张（`socialV2.media`）
  - MCP 发送工具支持可选 `replyToMessageId`，并提供专用 `qq_reply` 工具：AI 可以先用 `qq_get_recent_messages` 或 `qq_get_conversation_history` 拿到真实消息 id，再引用/回复某条消息（桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - `qq_send_message` 可用字符串发送一条，或用数组分开发送多条；引用回复用 `qq_reply` 或 `replyToMessageId`，工具调用是唯一的 QQ 发送路径

## 前置条件

1. 运行中的 DeepSeek Harness Desktop 或 Web API。Windows 桌面版端口由桥接启动时自动发现；固定端口部署默认使用 `http://127.0.0.1:3080`
2. 运行中的 SnowLuma，且配置好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | 固定 DSH API 地址及自动发现的回退地址，默认 `http://127.0.0.1:3080` |
| `dsh.autoDetectPort` | 默认 `true`。Windows DSH 桌面版可能动态分配 API 端口；桥接启动时会从 DSH 进程持有的本机监听端口中识别 API。启动桥接前先启动 DSH；发现的端口仅用于本次运行，不写回配置。未发现桌面 API 时使用 `baseUrl`；若匹配到多个 API 且 `baseUrl` 不在其中，桥接会拒绝猜测，需指定目标地址 |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `dsh.authToken` | DSH launch token（进程启动凭据）。**通常应留空**：留空时桥接用 `~/.dsh/.credentials.yaml` 里持久化的签名密钥**离线铸造**会话 Cookie，不依赖任何进程期状态（DSH 0.1.7 起启动 token 只存在于内存、日志里那条是上一个进程的陈旧值，换 Cookie 只会 401）。只有显式填了才会优先走 token 交换 |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.followDiscoveredEndpoint` | 默认 `true`。换 QQ 账号后 token 与端口都会变，桥接会自愈：重新发现并**跟随** SnowLuma 的端点（同时写回 `config.json`）。**想跑第二个实例 / 指向另一份 SnowLuma 安装（多账号、测试）时设为 `false`** —— 那时只自愈 token，绝不动 URL，也不写回 URL。详见「已知行为」 |
| `snowluma.silenceWarnMs` | 上游静默告警阈值（毫秒），默认 `600000`（10 分钟）。已连接但这么久没收到任何事件包（含心跳）时打警告；这只是**提示**，不确定性的判断交给 `good` |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 安装目录（用于 token/端点自发现）。⚠️ 桥接**不会**启动或停止 SnowLuma（见 `LICENSE`） |
| 会话 preset | 全局 DSH 会话固定使用 `desktop-agent` |
| `socialV2.media` | 图片/表情的上限：`maxBytes`（单条消息总字节，默认 8MB）、`maxPixels`（单张像素，默认 64MP）、`maxCount`（单条最多处理几张，默认 5）。越界值启动时收敛 |
| `webSearch.provider` | 联网搜索后端：`auto`（默认，优先 DeepSeek、失败回退 Bing）/ `deepseek`（仅 DeepSeek，无凭据时报错）/ `bing` |
| `webSearch.apiKeyEnv` / `apiKey` | 搜索凭据的环境变量名（默认 `DEEPSEEK_API_KEY`）/ 直接写死 key（不推荐）。都不设置时读 DSH 的 `$DSH_HOME/.credentials.yaml` 里同名 ref |
| `webSearch.baseURL` / `model` / `maxUses` / `maxResults` | 搜索端点（默认 `https://api.deepseek.com/anthropic/v1`，必须 https 且解析到公网）、模型（默认 `deepseek-v4-flash`）、单次搜索最多用几次工具、返回条数上限 |
| `allow.private` / `allow.groups` | 控制台直接测试发送的目标白名单；全局桌面会话的 SnowLuma 工具不受其限制 |
| `socialV2.attentionKeywords` | 可选关键词数组。匹配群聊正文时只给全局 agent 发元数据提醒，不把正文注入提示词；空数组关闭关键词提醒 |
| `ownerQQ` | 兼容 QQ 管理命令的可选管理员 QQ；也可由 DSH 的 `qq-mode.ownerQQ` 设置提供 |
| `consolePort` / `consoleToken` | 本地控制台固定端口（默认 `3100`）和访问令牌；端口占用时桥接会报错退出，不会随机换端口。令牌留空时自动生成并保存到 `state/console-token`；登录页验证后使用仅当前浏览器会话有效的 HttpOnly Cookie |
| `deny.*` | 控制台直接测试发送的目标拒绝名单；全局桌面会话具有完整 SnowLuma 读写能力 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |

> `allowAllWhenEmpty` 只影响控制台直接测试发送在白名单为空时是否放行，不限制全局 desktop-agent。SnowLuma MCP 的全局会话令牌可读写任意合法 QQ 群/私聊 key。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装 `desktop-agent` preset，并挂载 MCP 工具。桌面助手还要求 DSH profile 已启用 `dsh-computer-use-win`。**单机新装同样必须执行这一步**，装完还要**重启 DSH**：

```bash
node scripts/setup-dsh.mjs
```

> `setup-dsh.mjs` 只安装 `desktop-agent` 和当前 MCP 工具；不再设置 DSH 运行模式或创建 `state/mode.json`。历史 `qq-mode` 兼容命名空间仍承载 DSH 设置中的 `ownerQQ` 管理员配置。

详细步骤见 **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 6 步。先启动 DSH 和 SnowLuma，再安装并启动桥接。Windows DSH 桌面版的 API 端口可能动态变化，桥接会在启动时自动发现；固定端口部署使用 `dsh.baseUrl`。

1. **启动 DSH**
   确认 DSH 桌面版或 Web 服务正在运行。`3080` 是固定地址部署的默认值；Windows 桌面版的动态 API 端口由桥接启动时识别，所以应先开 DSH，再启动桥接。

2. **装桥接并复制配置**
   ```bash
   git clone https://github.com/Reshirem/qq-bridge.git
   cd qq-bridge
   npm install
   ```
   Windows CMD 用 `copy config.example.json config.json`，其他平台用 `cp config.example.json config.json`。
   全局 agent 的 SnowLuma 工具不要求填写 `allow.private` / `allow.groups`；它会缓存收到的 QQ 消息，并只把私聊、原生 @、已验证回复/引用或关键词命中作为元数据提醒。白名单仅用于控制台直接测试发送。

3. **装 DSH 端（preset + MCP），然后重启 DSH**
   ```bash
   node scripts/setup-dsh.mjs
   ```
   装完**必须重启 DSH**——preset 与 MCP 只在 DSH 启动时加载。
   跳过这步桥接不会崩，但 QQ 注意信号或 WebUI 任务拿不到 `desktop-agent` preset，桥接会**拒绝建会话**（有意的安全设计：绝不回退到 DSH 默认 preset）。

4. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`

5. **首次引导（WebUI）+ 填写桥接配置**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）
   - 回到 `config.json` 填好 `snowluma` 段；如需关键词提醒，可配置 `socialV2.attentionKeywords`：

     ```json
     "snowluma": {
       "wsUrl": "ws://127.0.0.1:3001",
       "httpUrl": "http://127.0.0.1:3000",
       "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
     }
     ```

   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。

6. **启动桥接**
   ```bash
   npm start          # 前台运行（崩溃不自动重启）
   ```
   看到 `SnowLuma 已连接` 且 DSH 就绪即成功；然后私聊机器人，或在群聊中 @ 机器人测试。桥接会向同一个全局 desktop-agent 会话发送不含正文的提醒。
   Windows 想要「崩溃自动重启」请改用 `start.bat`（见下节）。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **DSH 重启后的处理**：DSH Web 通常可由桥接每 5 秒探活并自动重连。Windows DSH 桌面版重启后可能换 API 端口；此时重启桥接以重新发现端口。DSH 不可用期间消息正文仍在桥接缓冲，元数据提醒按会话聚合在内存队列（最多 50 个来源）；DSH 恢复后补投。桥接进程退出会丢失未投递的内存提醒；会话休息截止时间、恢复退避和停止态保存在 `state/desktop-agent.json`。
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `dsh/agent-presets/`（改完要跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] QQ 注意信号已排队（private，元数据）
12:00:03 [bridge] 全局 desktop-agent session 已创建：sess_xxxx
12:00:20 [bridge] desktop-agent 完成当前回合
```

## 自测（不需要 SnowLuma / QQ）

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 QQ 消息）：

```bash
node scripts/test-audit.mjs
```

QQ 消息模型视图和全局 `desktop-agent` preset 契约可单独运行 `npm run test:qq-contract`。旧逐会话令牌与唤醒回归已随映射运行时一并移除。

控制台「令牌与花费」看板的账本与价目表回归（峰谷分时、幂等折叠、基线合并、压缩与容错）：

```bash
npm run test:tokens        # 单元测试
npm run test:console-ui    # 离线浏览器回归（含看板渲染与逐轮下钻）
```

升级后，QQ 注意信号进入唯一全局 `desktop-agent`。桥接不再管理逐 QQ DSH 映射；历史会话记录由 DSH 自己保留。

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 创建一个独立测试 session → prompt 被接受 → 打印 agent 回复 → 归档测试 session。它不会创建 SnowLuma/QQ 映射。

## 目录结构

```
qq-bridge/
  AGENTS.md             # 代码代理自动读取的仓库级修改指引
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  README.md / README.en.md / RULES.md
  docs/
    README.md           # 当前仓库文档索引
    FOLDER_MAP.md       # 目录结构与 scripts/ 命名约定
    guides/             # 当前架构、安装、安全、隐私、控制台与兼容性指南
  dsh/agent-presets/    # 全局 desktop-agent preset 源文件
  plugins/qq-mode-console  # DSH 兼容设置命名空间：承载 ownerQQ，不提供运行模式选择
  src/
    bridge.js           # 主程序
    autonomy-policy.js  # 纯唤醒策略
    dsh-client.js       # DSH API 客户端
    mcp-snowluma-safe.js # SnowLuma QQ 消息读写 MCP 工具
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测
  scripts/              # 测试、运维与协议探针
    patch-snowluma-sdk.mjs  # 修补 SDK 的 ESM 打包 bug（postinstall 自动执行）
  state/                # 运行时数据（不入库）
```

## SnowLuma 版本与上游健康（「连上了但收不到消息」）

「注入」在这个技术栈里只发生在一处：**SnowLuma 用原生组件挂进 QQ 客户端进程**（它自己日志里叫
`[Hook]`，载体是安装目录的 `native/snowluma-win32-x64.{dll,node}`）。**本桥接没有任何原生/注入面**
（依赖全为纯 JS，源码里没有 `.dll` / `.node` / FFI / 进程注入），也不启动、不控制 SnowLuma 或 QQ ——
所以「QQ 注入失败」不可能是本桥接造成的。但**桥接过去无法把这个失败讲清楚**，于是它经常被误报成
「qq-bridge 的问题」。现在桥接会主动把上游健康报出来。

### 已知行为：连上了 ≠ 收得到

SnowLuma 的 `[Hook]` 会退化：它的进程和 OneBot WebSocket **都还活着**，但收不到 QQ 侧的数据。
它自己的日志长这样：

```
WARN [Hook] receive path stale: PID=… UIN=… silentFor=136193ms; reporting good=false
WARN [Hook] process enumeration timed out after 4000ms (worker abandoned)
```

这时桥接这边**一切正常**：WebSocket 通、日志打过 `SnowLuma 已连接`、控制台没有异常，但群里一条消息都不来。
桥接现在对此做两件事：

1. **主信号**：每 30 秒一次的 `meta_event/heartbeat` 载荷里的 `status.good`（SnowLuma 对「QQ → 原生 hook → 我」这条**接收链路**的自评，静默约 105 秒后翻 `false`）。心跳是 SnowLuma 自己的定时器无条件发的，所以这条信号免费且及时，且不需要较新的运行时。
   兜底：每 60 秒问一次 `get_status`（`{online, good}`）。加分项：`bot_status`（账号会话上下线，**SnowLuma 1.14.20 才真的有**）+「距最近一个事件包的时长」（只能证明进程/WS 还活着，**不能**证明收得到 QQ 数据 —— 心跳会一直来）。
   > ⚠️ **不要用 `get_login_info` 取 `good`**：它只返回 `{user_id, nickname}`，而 SDK 不校验 data 载荷 ⇒ 不会报错、`good` 永远是 `null`、这条判断变成永不触发的死代码。（本功能的第一版实现正是这么写错的，回归里已加反面断言钉住。）
2. 判定退化时：日志打**明确指向 SnowLuma `[Hook]`** 的警告、控制台「运行总览」出现 `SnowLuma 上游` 卡片、
   「访问与安全」页出现告警条，`GET /api/status` 的 `snowluma` 字段给出 `degraded` / `good` / `hint`。

排查顺序：控制台看 `SnowLuma 上游` 卡片 → 看 SnowLuma 的 `logs/snowluma-*.log` 里的 `[Hook]` 行 → 再考虑升级 SnowLuma（**升级不换原生组件，见下**）。

### 版本要求

> 下方带日期的实测记录保留当时环境与运行方式；其中 2026-10-03 的 `qq-chat-v2` 往返记录属于旧逐会话运行时，不代表当前架构。当前唯一 DSH 会话使用 `desktop-agent`。

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| SnowLuma **运行时**（QQ 网关本体） | **1.14.20 已实测**（1.14.9 亦兼容） | **实测记录（2026-10-03，SnowLuma 1.14.20 + QQ 在线）**：包 SHA256 与官方发布摘要一致；心跳 `status.good=true`／`interval=30000`；桥接走完「首次 1006 → 自愈 WS token → 已连接」；收到群消息（`lastPacketKind: message/group`）；完整往返成功（唤醒 → DSH 建会话挂 `qq-chat-v2` → 工具发送 1/1 条 → 实际发出两条回复）。 ⚠️ **升级运行时不会更换注入用的原生组件**：实测 `native/snowluma-win32-x64.{dll,node}` 与 `websocket-win32-x64.node` 在 **1.14.9 与 1.14.20 之间逐字节完全相同**（三方对比：官方 1.14.9 包 == 本机安装 == 官方 1.14.20 包），变的只有 `index.mjs`（+414 KB）等 JS 层。所以**升级能带来 OneBot 事件流水线、收发与新区块链路上的修复（`bot_status`、markdown 带 text、事件种类订阅更全），但不会修「原生 hook 挂不上 QQ」这类问题** —— 那种要走 SnowLuma 自己的排查。**升级 SnowLuma 是使用者自己的事**：本桥接只探测、不部署（见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)） |
| `@snowluma/sdk` / `@snowluma/mcp`（本仓库依赖） | 已钉 `^1.14.20` | 客户端库；OneBot v11 是稳定契约，新库可连旧运行时（本项目实测：库 1.14.20 + 运行时 1.14.9 可正常收发） |
| `bot_status`（账号上下线） | **1.14.20 有；1.14.9 没有** | 逐一核对的只有这两个版本：`bot_status` 在 1.14.9 的 `index.mjs` 里出现 **0** 次、1.14.20 里 **3** 次（带 `sub_type`/`user_id`）。**具体从哪个版本引入未逐版核对**。桥接对老运行时**优雅降级**：订阅不到就只靠心跳 `good` 与 `get_status` |

### 已知行为：HTTP token 与 WS token 是**两个不同的值**

SnowLuma 同一个账号的 **HTTP token（默认 3000 端口）与 WebSocket token（默认 3001 端口）并不相同**
（实测；`snowluma.accessToken` 里通常只能存一个 —— 存的是 HTTP 那个）。因此：

- **桥接每次启动的首次 WS 连接几乎必然失败一次**（日志里 `SnowLuma 连接断开（code=1006）` →
  `SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）`），随后自愈重新发现 WS token、
  重连成功，才打出 `SnowLuma 已连接`。**这条序列是正常的，不是故障。**
- 真正会一直连不上的情况：**自愈无从下手** —— `snowluma.homeDir` 没配 / 被移动 / 读不到
  SnowLuma 的 `config/onebot_<QQ号>.json`，或权限不足。这时日志里会有 `token 自愈失败`，
  而 QQ 侧表现为**完全收不到消息**。先确认 `homeDir` 指向真正的 SnowLuma 安装目录。

### 已知行为：端点自愈会覆盖你写的 `wsUrl`

换 QQ 账号后 OneBot 端口与 token 都会变，所以桥接在连不上时会自愈：重新发现 SnowLuma 的端点并
**写回 `config.json`**。这在主场景下是对的，但它不区分「配置里是个过期值」和「你就是要指向别处」——
想跑第二个实例或指向另一份 SnowLuma 安装时会连错账号。要关掉：

```json
"snowluma": { "followDiscoveredEndpoint": false }
```

关掉后**只自愈 token**（换账号仍能恢复），绝不动 URL、也不写回 URL。

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 `socialV2.send.maxMessageChars`（默认 500 字，可用 `social.maxReplyChars` 调整）自动按句读/URL 边界分段
- 图片及部分表情可以通过安全下载接入多模态模型；视频和其它不支持的媒体类型不做内容解析
- 当前桥接运行时不提供 QQ 语音发送、接收或转写能力；旧语音实现不属于受支持的运行功能
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
