# qq-bridge — DSH 自主数字角色运行时与 QQ 消息桥接

> 🗂️ 文档索引（全部文档一句话说明 + 是否仍然有效）见 **[docs/README.md](docs/README.md)**；仓库目录/脚本命名约定见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
>
> 🧭 当前运行架构与渐进式重构原则见 **[docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)**；代码代理修改指引见 **[AGENTS.md](AGENTS.md)**。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。

项目围绕一个持久的全局 DSH 数字角色会话运行，支持主动探索和自主选择关注点。固定前缀描述长期会话、自主活动与工具规则；当前人格卡定义具体身份、形态、性格、相处习惯和表达方式，可使用人类、动物、幻想角色及其他非人设定。相处、交流和自主活动的通用建议与人格卡不一致时，以人格卡为准；工具权限和回合运行流程仍按实际配置执行。电脑操作、QQ 消息和记忆都是可按需使用的空间、渠道或能力；`desktop-agent` 是技术 preset ID，不限定数字角色的身份。WebUI 是主要控制入口，QQ 是可自行使用的消息渠道。

当前 qq-bridge 版本为 `v0.2.1-r1`，面向 DSH `0.2.1-rc.2`。安装、配置与运行步骤见 [DSH 安装说明](docs/guides/DSH_SETUP.md)。

```
WebUI 任务 ─────────────────────────► DSH 全局数字角色（`desktop-agent`）──► 电脑 / QQ 工具
QQ 消息 ──► 桌面 QQ 独立通道（默认）或 SnowLuma ──元数据提醒──► 同一个全局会话
```

## 架构

- **后台黑话与表情学习**：新消息按来源进入有界队列，在独立 DSH headless 进程中批量分析；黑话保留证据和确认状态，表情按图片内容去重并保存描述、情绪标签及使用场景。WebUI 的“黑话记录 / 表情包 / 后台学习”可查看、编辑、停用和调整范围；主角色按来源查询，表情继续使用现有 QQ 发送链路。默认启用，每批最多 30 条消息和 3 张表情，至少间隔 5 分钟；会产生额外模型用量。说话风格不由此模块学习或修改。详见 [黑话与表情学习说明](docs/guides/CHAT_LEARNING.md)。

- **QQ 通道**在 WebUI 的「QQ 消息 → 提醒与发送 → QQ 接入方案」选择，或在配置中设置 `qqBackend` 为 `native`（默认）或 `snowluma`。桥接启动时只连接所选通道。独立模式通过桌面 QQ 处理来信与发送，按需查询 QQ 原库，只保存提醒位置与确认状态。SnowLuma 模式使用 OneBot WS、HTTP 和每来源最多 500 条的未读缓存。[独立通道安装与可用范围](docs/guides/NTQQ_ATTENTION.md)
- **DSH 侧**：使用当前 DSH Web API 的 Cookie 鉴权、斜杠 RPC 与 `/api/remote.mux` 事件流；全局会话创建后，桥接按 `config.json` 的 `dsh.provider`、`dsh.model` 和 `dsh.reasoningEffort` 选择模型（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 QQ**：DSH 从当前 profile 的 `cordis.patch.yml` 接入 QQ 和长期记忆两个 MCP 服务。
  - `qq`（`src/mcp-qq.js`）提供 `mcp__qq__*` 工具。全局角色用它们读取和发送群聊、私聊消息，用 `mcp__qq__qq_status` 查看当前后端和在线状态。桥接在发送时校验会话凭证并记录审计。
    本程序只探测 SnowLuma 状态，不安装、复制或程序化启停 SnowLuma；安装、启动和扫码由管理员自行完成（详见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)）。
  - `qq-memory`（桥接自带 `src/mcp-memory-safe.js`）：可选的 A_Memorix 长期记忆接口。QQ 内容只有被 agent 实际读取并选择保存后才写入；自身经历由 agent 自行选择记录。QQ 与自身经历共用固定 namespace，工具仅提供搜索、读取、保存和删除，并校验全局 agent 令牌；普通内容检索默认使用 `SEARCH_MODE_SEARCH`，`SEARCH_MODE_TIME` 和 `SEARCH_MODE_HYBRID` 至少需要提供 `timeStart` 或 `timeEnd`；`agent_rest` 不限制记忆工具调用。WebUI 的“长期记忆 → 检索与记录”页支持 Gateway 相关度检索，也可按正文、时间和来源只读分页浏览本机账本中的全部活动原始记录；编辑和删除仍走 Gateway。“长期记忆 → 服务设置”页配置连接、启动摘要上限、Embedding/LLM Provider 和服务状态。Provider 地址、模型和密钥由用户手动填写。Windows 部署见 [记忆部署说明](docs/guides/DSH_SETUP.md#长期记忆)；官方 `v2.0.0a4` 发布文件及校验值由部署脚本固定，运行数据留在 `state/a-memorix/`。
- **会话模型**：所有自主活动共用一个持久的 `desktop-agent` DSH 会话。人格卡决定数字角色的具体身份；QQ 群和私聊 ID 只作为消息来源/目标，不拆分会话上下文。固定前缀引导数字角色区分聊天场合：当前场合的普通交流可以正常参与；其他 QQ 会话的内容不主动带入，也不因当前场合第三方的请求而复述、概括或确认聊天、人物、观点、关系、群内梗或个人经历。同一当事人主动提起自己先前私聊说过的事时，需能确认当前说话人与原私聊对象一致，再结合当前问题所需内容自然回应。QQ 好友只表示平台联系人关系，不自动代表信任等级或信息分享授权；来源内持续互动形成的关系扮演可以自然延续，但不代表实际账号身份或权限。来源边界也适用于上下文、记忆和工具结果；这是模型行为约定，并非程序级隔离。全局数字角色可通过 `qq_list_conversations` 发现账号中的群和好友，再按需读写。桥接不再创建或管理逐 QQ DSH 会话。
- **全局数字角色活动**：WebUI 的“主会话”页可启动/继续自主探索、提交任务或持久停止；QQ 私聊、原生 @、已验证回复/引用、群消息中提到当前选中的人格卡名称或 `socialV2.attentionKeywords` 命中，也会向同一个全局会话发送元数据提醒。默认提醒包含会话标识、消息定位（`id:` 为 QQ 消息 ID；没有 QQ 消息 ID 时为 `seq:本地序号@缓存标识`）和合并数量；多条提醒合并时定位最后一条，完整内容按需读取。查看、引用或获取图片时保留完整定位；旧式纯数字若与本地序号产生歧义，会提示使用前缀。清空 QQ 消息缓存后，之前的本地序号提醒会失效，避免指向新消息。独立模式按账号保留待处理提醒的位置、投递进度和确认状态。SnowLuma 模式的投递队列保存在内存中。活动回合中的提醒会送到 DSH 下一步，休息期间可提前唤醒。普通群消息可通过 QQ 历史工具按需查看。每个活动回合以 `agent_rest` 结束：休息 1 至 5 分钟后恢复一轮；未读的 QQ 提醒会在后续休息期间每分钟检查一次，最多补发一次；指数退避恢复时不补发。漏掉休息调用时按指数退避恢复，最长间隔 30 分钟。WebUI 停止会取消当前/排队任务并阻断自动恢复，只有 WebUI 手动任务能解除。
- **提示词维护**：全局数字角色固定使用技术 preset `desktop-agent`；WebUI 按用途拆分编辑固定前缀，支持逐个添加、命名、启用或删除自定义模块。模块源配置在 `dsh/agent-presets/desktop-agent/prompt-modules.json`，生成的完整前缀写入 `agent.cordis.yml` 并同步 `plugins/qq-agent-presets/` bundle patch。必要的会话、安全和回合收尾模块不能关闭；固定前缀中的模块开关只控制提示词文本，实际工具能力仍由各自设置控制。保存固定前缀后需重启 DSH，并重建全局会话才能获得新版前缀。当前人格卡由 `qq-agent-presets` 在每次提示词组装时动态加入 DSH persona 固定前缀，普通历史压缩不会移除它；切换、编辑或清除后在下一次模型请求时更新。首次部署这项前缀变量时，仍需重启 DSH 并重建全局会话。
- **QQ 历史与未读**。双方历史通过所选通道按需获取。独立模式的未读仅含待阅读的提醒，正文按消息 ID 从 QQ 获取。SnowLuma 模式为每个来源保留最多 500 条未读，角色从最早未读分页查看，本页返回的来信自动扣除。查看历史或单条详情时也按本次返回的来信逐条确认。SnowLuma 未读使用 `state/qq-unread.sqlite` 增量保存，升级时迁移旧 JSON 的未读、序号和来源状态，事务提交后移除旧文件。发送气泡数由模型决定，条间延迟为下一条的 Unicode 字符数乘 `socialV2.send.delayPerCharMs`，默认 20 ms/字，最多 1000 ms。0 表示连续发送，第一条直接发出。等待消息工具已移除。
- **本地控制台**位于 `http://127.0.0.1:3100`。首页汇总主会话、QQ 消息、记忆整理、后台学习的状态及待处理事项。主会话管理任务、记录、人格和模型。QQ 消息按来源显示未读和提醒。“长期记忆”提供记录检索和整理任务，“学习与素材”管理黑话、表情包和角色的修正建议。“令牌与花费”按功能展示用量，“系统运维”收纳日志、诊断和访问设置。
  - **令牌与花费看板**按主会话、记忆整理和后台学习汇总模型用量，支持查看逐轮明细和消耗走势。通过 models.dev 更新价格，已入账费用随调用保存。旧账本金额保留原币种。详见[令牌与花费](docs/guides/TOKEN_USAGE_CONSOLE.md)。
  - **人格（角色扮演）管理**：列表点选即可载入查看/编辑提示词，支持新建、保存修改、改名（自动重命名文件）、另存为副本、删除；当前卡完整加入 DSH persona 固定前缀，列表和编辑区显示字符数与 token 粗估，超过建议的 6000 字符时只提醒、不截断。切换、编辑、清除、改名或删除后，会在下一次模型请求组装提示词时更新。
  - **全局数字角色提示词**：WebUI 按模块编辑 `desktop-agent` 固定前缀，可独立调整自主探索、有限休息、长期记忆等指引，也可逐个追加自定义模块，并预览组合后的完整前缀；保存会备份模块文件和 preset 并重新生成 DSH bundle patch。运行时提示模板仍可编辑 QQ 来源提醒、休息/恢复和长期记忆摘要；其中人格卡模板用于格式化 persona 固定前缀中的动态人格卡，保存后下一次模型请求生效。首次部署或修改固定前缀后仍需重启 DSH 并重建全局会话；普通切卡和编辑人格卡不需要重建。固定前缀中的人格卡会增加每次模型请求的上下文 token。
  - **DSH 模型与思考强度**：控制台从 DSH 模型目录读取可用模型和对应思考档位；目录不可用或模型未列出时可手动填写 Provider / Model ID。保存后下一条消息生效，并会同步改变 DSH 全局默认
  - **长期记忆**：namespace 有效且本机账本可读取时，可在“检索与记录”页按关键词、时间范围和来源进行 Gateway 检索，也可“浏览全部”分页查看本机账本中的活动原始记录；全量浏览不依赖 Gateway 可达性，是受控制台鉴权保护的 SQLite 只读查询。读取器随桥接自动运行，复用 `setup` 创建的 Python 3.12+ 虚拟环境，不需额外安装依赖或手动启动脚本；只配置其他 Gateway、但没有本机 `state/a-memorix/data/` 账本时，不能浏览全部。Gateway 检索、编辑和删除仍要求 A_Memorix 服务配置可用。纯关键词不选日期时走 `SEARCH`，关键词与日期同时给出时走 `HYBRID`，纯时间检索走 `TIME` 且至少需要一个日期边界。查看、编辑、删除均可从记录列表操作，修改采用新版本替代旧记录。“设置”页独立管理 Gateway、首次摘要和 Provider。新建或重建的 DSH 会话在首次任务前得到一次精简的自身经历摘要，QQ 来源记忆仍按需查询。全量列表只包含活动原始段落，不包含已删除项或关系、Episode、人物画像等派生管理视图。
- **全局 QQ 自主策略**：无周期模型心跳，也不靠长等待工具维持在线。每个活动回合必须最后调用 `agent_rest`；数字角色可以在 1 至 5 分钟内选择休息时长，到期后回来继续交流或探索；省略时长默认为 5 分钟，超出范围自动调整。有效 QQ 提醒可中断休息并唤醒一轮。桥接运行期间，对应来信仍未读的 QQ 提醒会在后续休息期间每分钟检查一次，最多补发一次；异常回合处于指数退避时不提醒。未正常休息则以 1、2、4、8、16 分钟递增重试，之后最长每 30 分钟一次。私聊、原生 @、已验证回复/引用、群消息中提到当前选中的人格卡名称和配置关键词只产生不带正文的提醒，agent 可忽略；普通群消息可从历史中读取。QQ MCP 在每次桥接请求时自动附加 `state/desktop-agent.json` 中的桥接内部凭证，模型不用传令牌，也不区分哪个 DSH session 发起调用；可访问任意合法 QQ key，不依赖逐会话白名单。`agent_rest` 只结束当前模型回合，不限制休息或停止生命周期中的后续工具调用；发送仍执行内容检查和审计。
- **全局数字角色能力**：WebUI 和符合条件的 QQ 注意信号复用一个持久 `desktop-agent` DSH session。会话可按需使用 `dsh-computer-use-win` 和当前通道支持的 QQ 工具。GUI 发送不经过桥接 API 内容检查和审计。
- **交互增强**：
  - 全局数字角色通过 DSH 当前的用户交互流程与管理员沟通
  - DSH 自带的斜杠命令（如 `/model`）仍由 DSH 界面处理。桥接仅在已配置的 ownerQQ 私聊中识别纯文本 `/睡觉` 和 `/起床`：前者持久进入睡眠，取消当前与排队任务、清除已有提醒，并暂停 QQ 提醒与自动唤醒；后者结束睡眠并恢复一轮。睡眠中的消息仍会缓冲，但不会积压提醒。WebUI 显示睡眠状态；重新启动桥接仍保持睡眠。其他 QQ 内容不解析为管理命令
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH，让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；只有被明确引用/回复到机器人时才会触发群聊唤醒，但唤醒不代表必须发言
  - **图片/表情（含动图 GIF）**：表情包优先走 QQ 的 CDN 直链，`get_image` 失败时用 `emoji_id` 推出 CDN 地址兜底；媒体元数据保留 `emoji_id`/`summary`/`sub_type` 等字段。下载走同一套 SSRF 防护传输，并修掉了「DNS 先返回 IPv6、本机没有 IPv6 出口 → 每次白等 20 秒」的根因（改为 **IPv4 优先 + 逐地址故障切换**），动图表情不再时好时坏。单条消息上限默认 8MB / 64MP / 5 张（`socialV2.media`）
  - MCP 发送工具支持可选 `replyToMessageId`，并提供专用 `qq_reply` 工具：AI 可以先用 `qq_get_conversation_history` 拿到真实消息 id，再引用/回复某条消息（桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - `qq_send_message` 可用字符串发送一条，或用数组分开发送多条；多条发送时，数组中的某一项可写成 `{text, replyToMessageId}`，由数字角色选择哪条消息带引用，各条也可引用不同的消息。群聊单条发送仍可使用 `qq_reply`；统一发送的顶层 `replyToMessageId` 兼容旧写法，分多条时默认用于第一条。工具调用是唯一的 QQ 发送路径

- **DSH 内置网页工具**：`@deepseek-ai/dsh-tool-web` 提供 `web_search`（搜索并返回来源）和 `web_fetch`（抓取指定网页正文），分别调用 DSH 当前选择的 `ctx.web` 搜索/抓取提供方。`desktop-agent` 预设沿用插件默认值，默认启用两项，DSH 会向模型加入相应用法提示，并标注网页内容为不可信数据。请在 DSH 的「插件 → 网页搜索」配置提供方和所需凭据；实际可用性取决于提供方状态。此配置与桥接的 `webSearch` / `web-search-safe` 能力分开；若 DSH 选择随附的 `http` 抓取提供方，它允许访问本机和内网地址，不受桥接 SSRF 防护约束。更新预设后重启 DSH，并在桥接 WebUI 的「主会话」重建全局会话。

## 前置条件

1. 运行中的 DeepSeek Harness Desktop 或 Web API。Windows 桌面版端口由桥接启动时自动发现；固定端口部署默认使用 `http://127.0.0.1:3080`
2. 运行中的 Windows 桌面 QQ 和[独立通道依赖](docs/guides/NTQQ_ATTENTION.md)。选择 SnowLuma 时需运行 SnowLuma 并配置 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
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
| `qqBackend` | `native`（默认）使用桌面 QQ，`snowluma` 使用 OneBot。WebUI「QQ 消息 → 提醒与发送」可切换并重启桥接。 |
| `dsh.baseUrl` | 固定 DSH API 地址及自动发现的回退地址，默认 `http://127.0.0.1:3080` |
| `dsh.autoDetectPort` | 默认 `true`。Windows DSH 桌面版可能动态分配 API 端口；桥接启动时及 DSH 离线后会从其本机监听端口中识别 API。未发现时继续定期搜索，并检查配置的 `baseUrl`；就绪后连接事件流。发现的端口只在内存中使用，不写回配置。匹配到多个 API 且 `baseUrl` 不在其中时暂停连接，需指定目标地址并重启桥接 |
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
| `allow.private` / `allow.groups` | 控制台直接测试发送的目标白名单；全局数字角色会话的 QQ 工具不受其限制 |
| `socialV2.attentionKeywords` | 可选关键词数组。匹配群聊正文时只给全局 agent 发元数据提醒，不把正文注入提示词；空数组关闭关键词提醒 |
| `ownerQQ` | 可选的 QQ 账号身份锚点，也用于验证私聊睡眠命令；具体关系和称谓由当前人格卡及双方表达决定。可在控制台“系统运维 → 访问设置”中设置或清除；保存后本地配置优先于 DSH 的同名设置。旧安装在首次通过控制台保存之前仍兼容 DSH 的 `qq-agent-presets.ownerQQ` |
| `consolePort` / `consoleToken` | 本地控制台固定端口（默认 `3100`）和访问令牌；端口占用时桥接会报错退出，不会随机换端口。令牌留空时自动生成并保存到 `state/console-token`；登录页验证后使用仅当前浏览器会话有效的 HttpOnly Cookie |
| `memory.enabled` / `baseUrl` / `namespace` / `apiKey` | 可选 A_Memorix 长期记忆。默认关闭；部署本机 HTTP/JSON Gateway 并创建 namespace 后，可在 WebUI 配置连接地址、namespace、密钥和使用上限；API key 只保存在不入库的 `config.json`。 |
| `memory.timeoutMs` / `bootstrapLimit` / `bootstrapMaxChars` | A_Memorix 请求超时与新会话首次注入摘要的条数/字符上限；默认 `45000` ms、`6` 条、`2500` 字符。配置与维护说明见 [长期记忆方案](docs/guides/MEMORY_ARCHITECTURE.md) |
| `deny.*` | 控制台直接测试发送的目标拒绝名单；全局数字角色会话通过所选通道读写 QQ |

> 测试发送名单在控制台“系统运维 → 诊断与维护 → 测试发送”中配置；`allowAllWhenEmpty` 只影响对应允许名单为空时是否放行。它们不限制全局 desktop-agent；数字角色可以访问账号中的群聊和私聊。`ownerQQ` 用于识别账号和验证睡眠命令，不限制工具访问范围。QQ MCP 自动附加桥接内部凭证，令牌不暴露给模型。

> 控制台保存 `ownerQQ` 时会在 `config.json` 写入 `ownerQQSource: "config"`，包括清空账号的情况。需要恢复旧版的 DSH 同名设置优先行为时，可从本地配置删除该字段并重启桥接；手工编辑 `ownerQQ` 时也可设置该字段以确保本地值优先。

> 已失效的 `sendDelayMs` 和 `security.interceptNotify` 会在控制台保存 QQ 号或测试发送名单时从本地配置清除；`security` 中的其他字段会保留。

长期记忆的完整目标、A_Memorix 部署前提、来源约定与检索限制见 [docs/guides/MEMORY_ARCHITECTURE.md](docs/guides/MEMORY_ARCHITECTURE.md)。A_Memorix 目前处于 alpha 阶段；未启用时，桥接与其余功能正常运行。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装 `desktop-agent` preset，并挂载 MCP 工具。启用电脑操作能力还要求 DSH profile 已启用 `dsh-computer-use-win`。**单机新装同样必须执行这一步**，装完还要**重启 DSH**：

```powershell
node scripts/setup-dsh.mjs desktop
```

使用 Web profile 时把 `desktop` 换成 `web`。

> `setup-dsh.mjs` 安装 `desktop-agent`、`ownerQQ` 关系对象身份标记设置和当前 MCP 工具；不再设置 DSH 运行模式或创建 `state/mode.json`。设置命名空间为 `qq-agent-presets.ownerQQ`。

**可选的明日方舟模块**。安装后，数字角色可以观察模拟器画面、选择本地 Copilot 作业、按运行编号跟进战斗，并根据结算星数或剿灭击杀数核验结果。普通 QQ 安装可以跳过这一步。[安装、准备作业与使用示例](docs/guides/MAA_AGENT.md)

详细步骤见 **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

1. 安装 DSH 并启动一次实际使用的 profile。在 DSH 中配置一个可用的模型。桥接需要 Node.js 22.13 或更高版本。
2. 获取仓库，在 Windows PowerShell 中创建本地配置。

   ```powershell
   git clone https://github.com/Reshirem/qq-bridge.git
   cd qq-bridge
   npm install
   Copy-Item config.example.json config.json
   ```

3. 选择一个 QQ 后端。**独立方案（默认）**使用同机已登录的 Windows x64 桌面 QQ。安装 Frida 和数据库读取器、导入账号密钥，运行只读命令确认能打开原库。[独立方案安装与验收](docs/guides/NTQQ_ATTENTION.md#新机器安装)

   **SnowLuma 方案**在 `config.json` 设置 `"qqBackend": "snowluma"`。启动 SnowLuma 的 `launcher.bat`，按其启动日志打开管理页面并登录 QQ。开启 OneBot WebSocket 服务端和 HTTP API，将两个地址与配置的令牌填入 `snowluma.wsUrl`、`snowluma.httpUrl`、`snowluma.accessToken`。示例端口分别为 3001 和 3000。[SnowLuma 发布页](https://github.com/SnowLuma/SnowLuma/releases/latest)
4. 在仓库根目录将角色预设与 MCP 工具安装到正在使用的 DSH profile。桌面版运行 `node scripts/setup-dsh.mjs desktop`，Web 版运行 `node scripts/setup-dsh.mjs web`。完成后退出并重新打开 DSH。
5. Windows 运行 `.\start.bat` 启动守护进程，也可用 `npm start` 前台运行。打开 `http://127.0.0.1:3100`，使用配置的控制台令牌登录，自动生成的令牌在 `state/console-token`。在「系统运维 → 诊断与维护」核对 DSH 和 QQ 消息通道。独立模式应显示「独立通道已连接」及「原库只读连接已就绪」，SnowLuma 模式查看网关和心跳状态。[DSH 验证与排错](docs/guides/DSH_SETUP.md#验证)

已有安装升级时请保留原配置和会话数据，按实际后端与 profile 操作。[从旧版升级](docs/guides/DSH_SETUP.md#从旧版升级)

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **DSH 重启后**，桥接重新探测 API 端口并接续原角色会话。独立模式按账号保存提醒位置和确认进度，SnowLuma 模式保存未读缓存，尚未投递的提醒队列位于内存。会话休息截止时间、恢复退避和停止状态保存在 `state/desktop-agent.json`。
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
npm test
```

日常开发可先跑改动涉及的专项，推送前跑上述离线回归。WebUI 交互有变化时加跑 `npm run test:console-ui`。需要验证实际 SnowLuma 网关连接和心跳时，运行 `npm run probe:heartbeat`。表情、外网搜索和独立语音 GUI 等专项的真实联调需显式设置 `QQ_BRIDGE_TEST_LIVE=1`。

QQ 消息模型视图和全局 `desktop-agent` preset 契约可单独运行 `npm run test:qq-contract`。

控制台「令牌与花费」的专项回归覆盖旧账迁移、重复上报、报价刷新和已入账金额冻结。

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
  plugins/qq-agent-presets/ # DSH 全局 preset、工具守卫及 ownerQQ 关系对象身份标记设置
  src/
    bridge.js           # 主程序
    autonomy-policy.js  # 纯唤醒策略
    dsh-client.js       # DSH API 客户端
    mcp-qq.js # QQ 消息读写 MCP 工具
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测
  scripts/              # 测试、运维与协议探针
    patch-snowluma-sdk.mjs  # 修补 SDK 的 ESM 打包 bug（postinstall 自动执行）
  state/                # 运行时数据（不入库）
```

## SnowLuma 上游健康（「连上了但收不到消息」）

SnowLuma 模式通过 OneBot 连接网关，由 SnowLuma 自己的原生组件接入 QQ。以下诊断针对该模式。默认独立模式由桥接通过 Frida 接入桌面 QQ，其连接与数据库状态见[独立通道验收](docs/guides/NTQQ_ATTENTION.md#启动后核对)。

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
2. 网关报告接收异常或心跳中断时，「运行总览」的 QQ 消息卡片显示异常状态。「系统运维 → 诊断与维护」的 QQ 消息通道给出具体原因。

排查时可将「系统运维 → 诊断与维护」的状态与 SnowLuma 日志 `logs/snowluma-*.log` 中的 `[Hook]` 记录对照。

### SnowLuma 连接注意事项

SnowLuma 需要启用 OneBot v11 HTTP 和 WebSocket。HTTP 与 WebSocket 可以使用不同 token；桥接会从 SnowLuma 配置中发现 WebSocket 连接信息，并在必要时重新探测。

若控制台显示网关已连接但没有收到 QQ 事件，先检查 SnowLuma 登录状态和自身日志中的 hook 报错。若要固定连接到指定网关，可在配置中设置 `snowluma.followDiscoveredEndpoint` 为 `false`；这时桥接仍可更新 token，但不会覆盖 `wsUrl`。
## 已知限制

- 角色通过 QQ 发送工具选择每条消息的内容。多条发送间隔由 `socialV2.send.delayPerCharMs` 决定，每条最多等待 1000 ms。
- 图片及部分表情可以通过安全下载接入多模态模型；视频和其它不支持的媒体类型不做内容解析
- 当前桥接运行时不提供 QQ 语音发送、接收或转写能力
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
