# qq-bridge — DSH 自主陪伴运行时与 QQ 消息桥接

> 🗂️ 文档索引（全部文档一句话说明 + 是否仍然有效）见 **[docs/README.md](docs/README.md)**；仓库目录/脚本命名约定见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
>
> 🧭 当前运行架构与渐进式重构原则见 **[docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)**；代码代理修改指引见 **[AGENTS.md](AGENTS.md)**。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。

项目围绕一个持久的全局 DSH 陪伴者会话运行，支持主动探索和自主选择关注点。固定前缀描述长期会话、自主活动与工具规则；当前人格卡定义具体身份、形态、性格、相处习惯和表达方式，可使用人类、动物、幻想角色及其他非人设定。相处、交流和自主活动的通用建议与人格卡不一致时，以人格卡为准；工具权限和回合运行流程仍按实际配置执行。电脑操作、QQ 消息和记忆都是可按需使用的空间、渠道或能力；`desktop-agent` 是技术 preset ID，不限定陪伴者的身份。WebUI 是主要控制入口，QQ 是可自行使用的消息渠道。

当前 qq-bridge 版本为 `v0.2.1-r1`，面向 DSH `0.2.1-rc.2`。安装、配置与运行步骤见 [DSH 安装说明](docs/guides/DSH_SETUP.md)。

```
WebUI 任务 ─────────────────────────► DSH 全局陪伴者（`desktop-agent`）──► 电脑 / SnowLuma MCP
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接缓冲 ──元数据提醒──► 同一个全局会话
```

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：使用当前 DSH Web API 的 Cookie 鉴权、斜杠 RPC 与 `/api/remote.mux` 事件流；全局会话创建后，桥接按 `config.json` 的 `dsh.provider`、`dsh.model` 和 `dsh.reasoningEffort` 选择模型（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入四个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：本项目当前注册的完整 QQ 消息/媒体读写工具集；全局陪伴者会话可面向任意合法群/私聊 key 使用。发送要求活动 DSH 回合，仍受限频和审计；这不包含未注册在 MCP 内的 OneBot 群管理 API。
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：**只有** `snowluma_status`（只读探活 `get_login_info`）。
    本程序只探测 SnowLuma 状态，不安装、复制或程序化启停 SnowLuma；安装、启动和扫码由管理员自行完成（详见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)）。
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 按需查公开资料。
    **搜索优先复用 DSH 原本的联网搜索**（同一个 DeepSeek Anthropic 兼容端点 + `web_search` 服务端工具，凭据按 `config.webSearch.apiKey` → 环境变量 `DEEPSEEK_API_KEY` → DSH 的 `.credentials.yaml` 顺序解析），
    因而结果质量与 DSH 内的搜索一致、且**不再默认把群聊关键词发给 Bing**（Bing RSS 只在 DeepSeek 不可用时兜底）。
    抓取由桥接自己做 SSRF 校验并限制正文大小。搜索只在 agent 明确调用时发生，不会自动从群聊提取词条或建立词库。
    数据出机清单见 [LICENSE](LICENSE) 的「数据出机清单」。
  - `qq-memory`（桥接自带 `src/mcp-memory-safe.js`）：可选的 A_Memorix 长期记忆接口。QQ 内容只有被 agent 实际读取并选择保存后才写入；自身经历由 agent 自行选择记录。QQ 与自身经历共用固定 namespace，工具仅提供搜索、读取、保存和删除，并校验全局 agent 令牌；普通内容检索默认使用 `SEARCH_MODE_SEARCH`，`SEARCH_MODE_TIME` 和 `SEARCH_MODE_HYBRID` 至少需要提供 `timeStart` 或 `timeEnd`；`agent_rest` 不限制记忆工具调用。WebUI 的“长期记忆 → 检索与记录”页支持 Gateway 相关度检索，也可按正文、时间和来源只读分页浏览本机账本中的全部活动原始记录；编辑和删除仍走 Gateway。“长期记忆 → 设置”页配置连接、启动摘要上限、Embedding/LLM Provider 和服务状态。Provider 地址、模型和密钥由用户手动填写。Windows 部署见 [记忆部署说明](docs/guides/DSH_SETUP.md#安装)；官方 `v2.0.0a4` 发布文件及校验值由部署脚本固定，运行数据留在 `state/a-memorix/`。
- **会话模型**：所有自主活动共用一个持久的 `desktop-agent` DSH 会话。人格卡决定陪伴者的具体身份；QQ 群和私聊 ID 只作为消息来源/目标，不拆分会话上下文。固定前缀引导陪伴者区分聊天来源，不主动向其他 QQ 会话转述群聊或私聊内容；这属于模型行为约定，并非程序级隔离。全局陪伴者可通过 `qq_list_conversations` 发现账号中的群和好友，再按需读写。桥接不再创建或管理逐 QQ DSH 会话。
- **全局陪伴者活动**：WebUI 的“会话控制”页可启动/继续自主探索、提交任务或持久停止；QQ 私聊、原生 @、已验证回复/引用、群消息中提到当前选中的人格卡名称或 `socialV2.attentionKeywords` 命中，也会向同一个全局会话发送元数据提醒。默认提醒包含会话标识、消息定位（`id:` 为 QQ 消息 ID；没有 QQ 消息 ID 时为 `seq:本地序号@缓存标识`）和合并数量；多条提醒合并时定位最后一条，完整内容按需读取。查看、引用或获取图片时保留完整定位；旧式纯数字若与本地序号产生歧义，会提示使用前缀。清空 QQ 消息缓存后，之前的本地序号提醒会失效，避免指向新消息。提醒队列保存在内存中；桥接重启后若仅恢复了唤醒状态而未保留来源，提醒会注明来源未保留。活动回合中的提醒会送到 DSH 下一步，休息期间可提前唤醒。普通群消息留在桥接缓冲，由陪伴者自行选择是否通过 SnowLuma MCP 或 QQ 桌面界面查看和操作。每个活动回合以 `agent_rest` 结束：有限休息（最长 12 小时）到期后恢复一轮；未读的 QQ 提醒会在后续休息期间每分钟检查一次，最多补发一次；指数退避恢复时不补发。漏掉休息调用时按指数退避恢复，最长间隔 30 分钟。WebUI 停止会取消当前/排队任务并阻断自动恢复，只有 WebUI 手动任务能解除。
- **提示词维护**：全局陪伴者固定使用技术 preset `desktop-agent`；WebUI 按用途拆分编辑固定前缀，支持逐个添加、命名、启用或删除自定义模块。模块源配置在 `dsh/agent-presets/desktop-agent/prompt-modules.json`，生成的完整前缀写入 `agent.cordis.yml` 并同步 `plugins/qq-agent-presets/` bundle patch。必要的会话、安全和回合收尾模块不能关闭；固定前缀中的模块开关只控制提示词文本，实际工具能力仍由各自设置控制。保存固定前缀后需重启 DSH，并重建全局会话才能获得新版前缀。当前人格卡由 `qq-agent-presets` 在每次提示词组装时动态加入 DSH persona 固定前缀，普通历史压缩不会移除它；切换、编辑或清除后在下一次模型请求时更新。首次部署这项前缀变量时，仍需重启 DSH 并重建全局会话。
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——按操作任务提供运行总览、会话控制、陪伴者提示词、长期记忆（检索与记录、设置）、提醒与消息、令牌与花费、访问与安全、调试与运维九个页面，右上角搜索框可跨页定位功能项；导航按工作空间、长期记忆、QQ 通道、系统与管理分组；“会话控制”页管理全局陪伴者，提示词页维护技术 preset `desktop-agent`；支持**浅色 / 深色双主题**（顶栏一键切换，未选择时跟随系统）；可查看活动日志、维护关键词提醒、配置管理员/控制台令牌（`consoleToken` 未配置时自动生成并打印在启动日志；可在控制台内修改或重新生成）
  - **令牌与花费看板**：实时显示 AI 的 token 消耗与折算金额（元），可下钻到**每个群 / 每个好友 / 每一轮对话**（轮次、步数、缓存命中/未命中输入、输出、命中率、花费、峰谷时段），并有**按时间的消耗走势图**（24 小时 / 3 天 / 7 天 / 30 天，柱子按高峰/空闲着色，一眼看出什么时候烧得凶、哪几个小时是 2 倍价）。累计总量取自 DSH 的 `tokenUsage` 投影（精确，含桥接启动前的历史），逐轮明细由 `assistant/message` 的 `usage` 折叠而来；金额按 DeepSeek 官方价目表折算并区分**高峰 / 空闲时段**（高峰单价为空闲的 2 倍，已内置中国法定节假日）。详见 [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)
  - **人格（角色扮演）管理**：列表点选即可载入查看/编辑提示词，支持新建、保存修改、改名（自动重命名文件）、另存为副本、删除；当前卡完整加入 DSH persona 固定前缀，列表和编辑区显示字符数与 token 粗估，超过建议的 6000 字符时只提醒、不截断。切换、编辑、清除、改名或删除后，会在下一次模型请求组装提示词时更新。
  - **全局陪伴者提示词**：WebUI 按模块编辑 `desktop-agent` 固定前缀，可独立调整自主探索、有限休息、QQ 等待、长期记忆等指引，也可逐个追加自定义模块，并预览组合后的完整前缀；保存会备份模块文件和 preset 并重新生成 DSH bundle patch。运行时提示模板仍可编辑 QQ 来源提醒、休息/恢复和长期记忆摘要；其中人格卡模板用于格式化 persona 固定前缀中的动态人格卡，保存后下一次模型请求生效。首次部署或修改固定前缀后仍需重启 DSH 并重建全局会话；普通切卡和编辑人格卡不需要重建。固定前缀中的人格卡会增加每次模型请求的上下文 token。
  - **DSH 模型与思考强度**：控制台从 DSH 模型目录读取可用模型和对应思考档位；目录不可用或模型未列出时可手动填写 Provider / Model ID。保存后下一条消息生效，并会同步改变 DSH 全局默认
  - **长期记忆**：namespace 有效且本机账本可读取时，可在“检索与记录”页按关键词、时间范围和来源进行 Gateway 检索，也可“浏览全部”分页查看本机账本中的活动原始记录；全量浏览不依赖 Gateway 可达性，是受控制台鉴权保护的 SQLite 只读查询。读取器随桥接自动运行，复用 `setup` 创建的 Python 3.12+ 虚拟环境，不需额外安装依赖或手动启动脚本；只配置其他 Gateway、但没有本机 `state/a-memorix/data/` 账本时，不能浏览全部。Gateway 检索、编辑和删除仍要求 A_Memorix 服务配置可用。纯关键词不选日期时走 `SEARCH`，关键词与日期同时给出时走 `HYBRID`，纯时间检索走 `TIME` 且至少需要一个日期边界。查看、编辑、删除均可从记录列表操作，修改采用新版本替代旧记录。“设置”页独立管理 Gateway、首次摘要和 Provider。新建或重建的 DSH 会话在首次任务前得到一次精简的自身经历摘要，QQ 来源记忆仍按需查询。全量列表只包含活动原始段落，不包含已删除项或关系、Episode、人物画像等派生管理视图。
- **全局 QQ 自主策略**：无周期模型心跳，也不靠长等待工具维持在线。每个活动回合必须最后调用 `agent_rest`；陪伴者可以按自己的节奏设定有限休息，到期后回来继续交流或探索，也可以选择无限期休息。有效 QQ 提醒可中断休息并唤醒一轮。桥接运行期间，未由 `readThroughSeq` 确认的 QQ 提醒会在后续休息期间每分钟检查一次，最多补发一次；异常回合处于指数退避时不提醒。未正常休息则以 1、2、4、8、16 分钟递增重试，之后最长每 30 分钟一次。私聊、原生 @、已验证回复/引用、群消息中提到当前选中的人格卡名称和配置关键词只产生不带正文的提醒，agent 可忽略；普通群消息只缓冲。SnowLuma MCP 在每次桥接请求时自动附加 `state/desktop-agent.json` 中的桥接内部凭证，模型不用传令牌，也不区分哪个 DSH session 发起调用；可访问任意合法 QQ key，不依赖逐会话白名单。`agent_rest` 只结束当前模型回合，不限制休息或停止生命周期中的后续工具调用；发送仍执行限频和审计。
- **全局陪伴者能力**：WebUI 和符合条件的 QQ 注意信号复用一个持久 `desktop-agent` DSH session。会话可按需使用 `dsh-computer-use-win` 和完整的当前 SnowLuma MCP 工具集。GUI 发送不经过桥接 API 限频和审计。
- **交互增强**：
  - 全局陪伴者通过 DSH 当前的用户交互流程与管理员沟通
  - DSH 自带的斜杠命令（如 `/model`）仍由 DSH 界面处理；QQ 聊天消息不由桥接解析为管理命令，全局会话在 WebUI 管理
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH，让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；只有被明确引用/回复到机器人时才会触发群聊唤醒，但唤醒不代表必须发言
  - **图片/表情（含动图 GIF）**：表情包优先走 QQ 的 CDN 直链，`get_image` 失败时用 `emoji_id` 推出 CDN 地址兜底；媒体元数据保留 `emoji_id`/`summary`/`sub_type` 等字段。下载走同一套 SSRF 防护传输，并修掉了「DNS 先返回 IPv6、本机没有 IPv6 出口 → 每次白等 20 秒」的根因（改为 **IPv4 优先 + 逐地址故障切换**），动图表情不再时好时坏。单条消息上限默认 8MB / 64MP / 5 张（`socialV2.media`）
  - MCP 发送工具支持可选 `replyToMessageId`，并提供专用 `qq_reply` 工具：AI 可以先用 `qq_get_recent_messages` 或 `qq_get_conversation_history` 拿到真实消息 id，再引用/回复某条消息（桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - `qq_send_message` 可用字符串发送一条，或用数组分开发送多条；多条发送时，数组中的某一项可写成 `{text, replyToMessageId}`，由陪伴者选择哪条消息带引用，各条也可引用不同的消息。群聊单条发送仍可使用 `qq_reply`；统一发送的顶层 `replyToMessageId` 兼容旧写法，分多条时默认用于第一条。工具调用是唯一的 QQ 发送路径

- **DSH 内置网页工具**：`@deepseek-ai/dsh-tool-web` 提供 `web_search`（搜索并返回来源）和 `web_fetch`（抓取指定网页正文），分别调用 DSH 当前选择的 `ctx.web` 搜索/抓取提供方。设置位置是 DSH 的 `desktop-agent` 预设 → `tool-web` 插件配置：`search` 和 `fetch` 分别控制工具注册。当前 preset 默认将两项设为关闭；启用后，DSH 也会向模型加入相应用法提示，并标注网页内容为不可信数据。此配置与桥接的 `webSearch` / `web-search-safe` 能力分开；若 DSH 选择随附的 `http` 抓取提供方，它允许访问本机和内网地址，不受桥接 SSRF 防护约束。修改 preset 配置后，重载 DSH 并重建全局会话。

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
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；可在 WebUI“DSH 模型与思考强度”中从模型目录选择或手动填写 Provider / Model ID |
| `dsh.authToken` | DSH launch token（进程启动凭据）。通常留空；桥接会用 `~/.dsh/.credentials.yaml` 中的浏览器会话签名密钥铸造 Cookie。显式填写时优先使用该 token 交换 Cookie |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.followDiscoveredEndpoint` | 默认 `true`。换 QQ 账号后 token 与端口都会变，桥接会自愈：重新发现并**跟随** SnowLuma 的端点（同时写回 `config.json`）。**想跑第二个实例 / 指向另一份 SnowLuma 安装（多账号、测试）时设为 `false`** —— 那时只自愈 token，绝不动 URL，也不写回 URL。详见「已知行为」 |
| `snowluma.silenceWarnMs` | 上游静默告警阈值（毫秒），默认 `600000`（10 分钟）。已连接但这么久没收到任何事件包（含心跳）时打警告；这只是**提示**，不确定性的判断交给 `good` |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 安装目录（用于 token/端点自发现）。⚠️ 桥接**不会**启动或停止 SnowLuma（见 `LICENSE`） |
| 会话 preset | 全局 DSH 会话固定使用 `desktop-agent` |
| `socialV2.media` | 图片/表情的接收上限：`maxBytes`（单条消息总字节，默认 8MB）、`maxPixels`（单张像素，默认 64MP）、`maxCount`（单条最多处理几张，默认 5）。交给模型前默认将单图控制在 1MiB；大图缩放与动图抽帧需要 FFmpeg。部署检查见 [DSH 端安装说明](docs/guides/DSH_SETUP.md#图片与动图依赖) |
| `webSearch.provider` | 联网搜索后端：`auto`（默认，优先 DeepSeek、失败回退 Bing）/ `deepseek`（仅 DeepSeek，无凭据时报错）/ `bing` |
| `webSearch.apiKeyEnv` / `apiKey` | 搜索凭据的环境变量名（默认 `DEEPSEEK_API_KEY`）/ 直接写死 key（不推荐）。都不设置时读 DSH 的 `$DSH_HOME/.credentials.yaml` 里同名 ref |
| `webSearch.baseURL` / `model` / `maxUses` / `maxResults` | 搜索端点（默认 `https://api.deepseek.com/anthropic/v1`，必须 https 且解析到公网）、模型（默认 `deepseek-v4-flash`）、单次搜索最多用几次工具、返回条数上限 |
| `allow.private` / `allow.groups` | 控制台直接测试发送的目标白名单；全局陪伴者会话的 SnowLuma 工具不受其限制 |
| `socialV2.attentionKeywords` | 可选关键词数组。匹配群聊正文时只给全局 agent 发元数据提醒，不把正文注入提示词；空数组关闭关键词提醒 |
| `ownerQQ` | 可选的管理员身份标记，用于在 QQ 消息上下文中标出管理者；也可由 DSH 的 `qq-agent-presets.ownerQQ` 设置提供 |
| `consolePort` / `consoleToken` | 本地控制台固定端口（默认 `3100`）和访问令牌；端口占用时桥接会报错退出，不会随机换端口。令牌留空时自动生成并保存到 `state/console-token`；登录页验证后使用仅当前浏览器会话有效的 HttpOnly Cookie |
| `memory.enabled` / `baseUrl` / `namespace` / `apiKey` | 可选 A_Memorix 长期记忆。默认关闭；部署本机 HTTP/JSON Gateway 并创建 namespace 后，可在 WebUI 配置连接地址、namespace、密钥和使用上限；API key 只保存在不入库的 `config.json`。 |
| `memory.timeoutMs` / `bootstrapLimit` / `bootstrapMaxChars` | A_Memorix 请求超时与新会话首次注入摘要的条数/字符上限；默认 `45000` ms、`6` 条、`2500` 字符。配置与维护说明见 [长期记忆方案](docs/guides/MEMORY_ARCHITECTURE.md) |
| `deny.*` | 控制台直接测试发送的目标拒绝名单；全局陪伴者会话具有完整 SnowLuma 读写能力 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |

> `allowAllWhenEmpty` 只影响控制台直接测试发送在白名单为空时是否放行，不限制全局 desktop-agent。SnowLuma MCP 自动附加桥接内部凭证，可读写任意合法 QQ 群/私聊 key；调用方不用提供令牌，也不按发起调用的 DSH session 区分权限。令牌不暴露给模型。

长期记忆的完整目标、A_Memorix 部署前提、来源约定与检索限制见 [docs/guides/MEMORY_ARCHITECTURE.md](docs/guides/MEMORY_ARCHITECTURE.md)。A_Memorix 目前处于 alpha 阶段；未启用时，桥接与其余功能正常运行。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装 `desktop-agent` preset，并挂载 MCP 工具。启用电脑操作能力还要求 DSH profile 已启用 `dsh-computer-use-win`。**单机新装同样必须执行这一步**，装完还要**重启 DSH**：

```bash
node scripts/setup-dsh.mjs
```

> `setup-dsh.mjs` 安装 `desktop-agent`、`ownerQQ` 管理者身份标记设置和当前 MCP 工具；不再设置 DSH 运行模式或创建 `state/mode.json`。设置命名空间为 `qq-agent-presets.ownerQQ`。

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

QQ 消息模型视图和全局 `desktop-agent` preset 契约可单独运行 `npm run test:qq-contract`。

控制台「令牌与花费」看板的账本与价目表回归（峰谷分时、幂等折叠、基线合并、压缩与容错）：

```bash
npm run test:tokens        # 单元测试
npm run test:console-ui    # 离线浏览器回归（含看板渲染与逐轮下钻）
```

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
  README.md / RULES.md
  docs/
    README.md           # 当前仓库文档索引
    FOLDER_MAP.md       # 目录结构与 scripts/ 命名约定
    guides/             # 当前架构、安装、安全、隐私与控制台指南
  dsh/agent-presets/    # 全局 desktop-agent preset 源文件
  plugins/qq-agent-presets/ # DSH 全局 preset、工具守卫及 ownerQQ 身份标记设置
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

## SnowLuma 上游健康（「连上了但收不到消息」）

「注入」在这个技术栈里只发生在一处：**SnowLuma 用原生组件挂进 QQ 客户端进程**（它自己日志里叫
`[Hook]`，载体是安装目录的 `native/snowluma-win32-x64.{dll,node}`）。**本桥接没有任何原生/注入面**
（依赖全为纯 JS，源码里没有 `.dll` / `.node` / FFI / 进程注入），也不启动、不控制 SnowLuma 或 QQ ——
因此桥接无法修复 QQ 客户端内的 Hook 故障。桥接会展示上游健康信号，帮助区分网关连接问题和 QQ 接收链路问题。

### 已知行为：连上了 ≠ 收得到

SnowLuma 的 `[Hook]` 会退化：它的进程和 OneBot WebSocket **都还活着**，但收不到 QQ 侧的数据。
它自己的日志长这样：

```
WARN [Hook] receive path stale: PID=… UIN=… silentFor=136193ms; reporting good=false
WARN [Hook] process enumeration timed out after 4000ms (worker abandoned)
```

这时桥接这边**一切正常**：WebSocket 通、日志打过 `SnowLuma 已连接`、控制台没有异常，但群里一条消息都不来。
桥接现在对此做两件事：

1. **主信号**：`meta_event/heartbeat` 载荷里的 `status.good`，用于判断 SnowLuma 的 QQ 接收链路是否正常。兜底是定时查询 `get_status`；若运行时提供账号会话上下线事件，也会一并显示。事件包到达时间只能证明进程和 WebSocket 仍有活动，不能单独证明 QQ 接收正常。
   `get_login_info` 只用于读取账号身份，不作为接收健康信号。
2. 判定退化时：日志打**明确指向 SnowLuma `[Hook]`** 的警告、控制台「运行总览」出现 `SnowLuma 上游` 卡片、
   「访问与安全」页出现告警条，`GET /api/status` 的 `snowluma` 字段给出 `degraded` / `good` / `hint`。

排查顺序：控制台查看 `SnowLuma 上游` 卡片，再查看 SnowLuma 的 `logs/snowluma-*.log` 中 `[Hook]` 相关日志。

### SnowLuma 连接注意事项

SnowLuma 需要启用 OneBot v11 HTTP 和 WebSocket。HTTP 与 WebSocket 可以使用不同 token；桥接会从 SnowLuma 配置中发现 WebSocket 连接信息，并在必要时重新探测。

若控制台显示网关已连接但没有收到 QQ 事件，先检查 SnowLuma 登录状态和自身日志中的 hook 报错。若要固定连接到指定网关，可在配置中设置 `snowluma.followDiscoveredEndpoint` 为 `false`；这时桥接仍可更新 token，但不会覆盖 `wsUrl`。
## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 `socialV2.send.maxMessageChars`（默认 500 字，可用 `social.maxReplyChars` 调整）自动按句读/URL 边界分段
- 图片及部分表情可以通过安全下载接入多模态模型；视频和其它不支持的媒体类型不做内容解析
- 当前桥接运行时不提供 QQ 语音发送、接收或转写能力
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
