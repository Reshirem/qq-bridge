# qq-bridge — DSH 自主数字角色运行时与 QQ 消息桥接

> 🗂️ 文档索引（全部文档一句话说明 + 是否仍然有效）见 **[docs/README.md](docs/README.md)**；仓库目录/脚本命名约定见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
>
> 🧭 当前运行架构与渐进式重构原则见 **[docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)**；代码代理修改指引见 **[AGENTS.md](AGENTS.md)**。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。

项目围绕一个持久的全局 DSH 数字角色会话运行，支持主动探索和自主选择关注点。固定前缀描述长期会话、自主活动与工具规则；当前人格卡定义具体身份、形态、性格、相处习惯和表达方式，可使用人类、动物、幻想角色及其他非人设定。相处、交流和自主活动的通用建议与人格卡不一致时，以人格卡为准；工具权限和回合运行流程仍按实际配置执行。电脑操作、QQ 消息和记忆都是可按需使用的空间、渠道或能力；`desktop-agent` 是技术 preset ID，不限定数字角色的身份。WebUI 是主要控制入口，QQ 是可自行使用的消息渠道。

当前 qq-bridge 版本为 `v0.2.1-r1`，面向 DSH `0.2.2` 系列（支持宿主 MCP manager 纳管、`session/state` 单会话状态查询及桌面版 `app.asar` 共享模块解析；旧版 `0.2.1` 宿主可通过 `--legacy-mcp` 沿用直连模式）。安装、配置与运行步骤见 [DSH 安装说明](docs/guides/DSH_SETUP.md)。

```
WebUI 任务 ─────────────────────────► DSH 全局数字角色（`desktop-agent`）──► 电脑 / QQ 工具
QQ 消息 ──► Windows 桌面 QQ 本地通道 ──元数据提醒──► 同一个全局会话
```

## 架构

- **后台黑话与表情学习**：新消息按来源进入有界队列，优先在专用的 DSH Host 学习会话（`chat-learning` / `market-analysis`）中批量分析，Host 无法预建时回退到隔离的 DSH headless 进程；黑话保留证据和确认状态，表情按图片内容去重并保存描述、情绪标签及使用场景，同时支持在 WebUI 手动收录腾讯商城表情包并编入独立的 A_Memorix 表情检索空间。WebUI 的“学习与素材”可查看、编辑、停用和调整范围；主角色按来源查询黑话、按意图检索普通或商城表情，并继续使用现有 QQ 发送链路。默认启用，每批最多 30 条消息和 3 张表情，至少间隔 5 分钟；会产生额外模型用量。说话风格不由此模块学习或修改。详见 [黑话与表情学习说明](docs/guides/CHAT_LEARNING.md)。

- **QQ 通道**：桥接唯一使用 Windows 桌面 QQ 本地通道（`NativeQQ` + `openNativeReminders`），通过 Frida 命名管道连接已登录的桌面 QQ 处理来信与发送，按需只读查询 QQ 原库，只在 `state/ntqq-reminders-<account>.sqlite` 保存提醒位置与确认状态（已移除 SnowLuma / OneBot 支持）。[桌面 QQ 通道安装与可用范围](docs/guides/NTQQ_ATTENTION.md)
- **DSH 侧**：使用当前 DSH Web API 的 Cookie 鉴权、斜杠 RPC 与 `/api/remote.mux` 事件流；全局会话创建后，桥接按 `config.json` 的 `dsh.provider`、`dsh.model` 和 `dsh.reasoningEffort` 选择模型（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 QQ**：DSH 从当前 profile 的 `cordis.patch.yml` 接入 QQ 和长期记忆两个 MCP 服务。
  - `qq`（`src/mcp-qq.js`）提供 `mcp__qq__*` 工具。全局角色用它们读取和发送群聊、私聊消息（含 Ark/JSON 卡片安全摘要），查看并处理 QQ 好友申请（`qq_list_friend_requests` / `qq_handle_friend_request`）与邀请加群通知（`qq_list_group_invites` / `qq_handle_group_invite`），用 `mcp__qq__qq_status` 查看桌面 QQ 连接与原库只读状态（`src/mcp-qq.js` 不含进程控制原语）。桥接在发送及操作前校验会话凭证并记录审计。
  - `qq-memory`（桥接自带 `src/mcp-memory-safe.js`）：可选的 A_Memorix 长期记忆接口。QQ 内容只有被 agent 实际读取并选择保存后才写入；自身经历由 agent 自行选择记录。QQ 与自身经历共用固定 namespace，工具提供搜索（`memory_search`）、读取（`memory_read`）、保存（`memory_save`）、合并替换（`memory_replace`）和删除（`memory_forget`），并校验全局 agent 令牌；普通内容检索默认使用 `SEARCH_MODE_SEARCH`，`SEARCH_MODE_TIME` 和 `SEARCH_MODE_HYBRID` 至少需要提供 `timeStart` 或 `timeEnd`；`agent_rest` 不限制记忆工具调用。WebUI 的“长期记忆 → 检索与记录”页支持 Gateway 相关度检索，也可按正文、时间和来源只读分页浏览本机账本中的全部活动原始记录；编辑和删除仍走 Gateway。“长期记忆 → 服务设置”页配置连接、启动摘要上限、Embedding/LLM Provider 和服务状态。Provider 地址、模型和密钥由用户手动填写。Windows 部署见 [记忆部署说明](docs/guides/DSH_SETUP.md#长期记忆)；官方 `v2.0.0a4` 发布文件及校验值由部署脚本固定，运行数据留在 `state/a-memorix/`。
- **会话模型**：所有自主活动共用一个持久的 `desktop-agent` DSH 会话。人格卡决定数字角色的具体身份；QQ 群和私聊 ID 只作为消息来源/目标，不拆分会话上下文。固定前缀引导数字角色区分聊天场合：当前场合的普通交流可以正常参与；其他 QQ 会话的内容不主动带入，也不因当前场合第三方的请求而复述、概括或确认聊天、人物、观点、关系、群内梗或个人经历。同一当事人主动提起自己先前私聊说过的事时，需能确认当前说话人与原私聊对象一致，再结合当前问题所需内容自然回应。QQ 好友只表示平台联系人关系，不自动代表信任等级或信息分享授权；来源内持续互动形成的关系扮演可以自然延续，但不代表实际账号身份或权限。来源边界也适用于上下文、记忆和工具结果；这是模型行为约定，并非程序级隔离。全局数字角色可通过 `qq_list_conversations` 发现账号中的群和好友，再按需读写。桥接不再创建或管理逐 QQ DSH 会话。
- **全局数字角色活动**：WebUI 的“主会话”页可启动/继续自主探索、提交任务或持久停止；QQ 私聊、原生 @、已验证回复/引用、群消息中提到当前选中的人格卡名称、`socialV2.attentionKeywords` 命中、他人对当前账号的 QQ 戳一戳功能事件，以及收到的 QQ 好友申请 / 邀请加群事件（仅携带申请者/群号元数据，不含验证留言、群名称与昵称正文；受提醒总开关与私聊开关控制），构成 P1 强召唤元数据提醒；此外，角色向群发送文字或表情包后该群独立进入 4 分钟自然超时热窗（P2 热群跟进，`reminders.groupFollowup`，空闲 5–10 秒防抖），不在热窗的冷群则在无热聊空闲时聚合 60 秒并按 20 分钟冷却低优提醒（P3 冷群低优余光，`reminders.groupActivity`）；P2/P3 均只传元数据、绝不中途 `steer` 打断活动回合。默认提醒包含会话标识、消息定位（`id:` 为 QQ 消息 ID；没有 QQ 消息 ID 时为 `seq:本地序号@缓存标识`）和合并数量；群聊类唤醒入口会附带一行极简其他未读概况（热群标 `,热` 置顶），纯私聊唤醒保持纯粹不附冷群未读。桥接按账号在 `state/ntqq-reminders-<account>.sqlite` 保留待处理 P1 提醒的位置、投递进度和确认状态。回合正常完成未调 `agent_rest` 时，桥接自动进入默认 30 分钟（`desktopAgent.rest.defaultMs`）后台自运转待机，不再发收尾催促；角色也可按需调用可选的 `agent_rest`（或同义 `qq_agent_rest`）自定义 1 分钟至 4 小时待机时长。未读的 P1 提醒会在进入待机且回合停稳 **5 秒**后检查一次，最多补发一次；中断或异常失败仍走指数退避恢复。WebUI 停止会取消当前/排队任务并阻断自动恢复，只有 WebUI 手动任务能解除。
- **提示词维护**：全局数字角色固定使用技术 preset `desktop-agent`；WebUI 按用途拆分编辑固定前缀，支持逐个添加、命名、启用或删除自定义模块。模块源配置在 `dsh/agent-presets/desktop-agent/prompt-modules.json`，生成的完整前缀写入 `agent.cordis.yml` 并同步 `plugins/qq-agent-presets/` bundle patch。每个内置模块都可单独编辑或关闭（缺少人格卡变量或收尾工具提示时仅给出非阻断提醒）；固定前缀中的模块开关只控制提示词文本，实际工具能力仍由各自设置控制。保存固定前缀后需重启 DSH，并重建全局会话才能获得新版前缀。当前人格卡由 `qq-agent-presets` 在每次提示词组装时动态加入 DSH persona 固定前缀，普通历史压缩不会移除它；切换、编辑或清除后在下一次模型请求时更新。首次部署这项前缀变量时，仍需重启 DSH 并重建全局会话。
- **QQ 历史与未读**。聊天历史通过桌面 QQ 原库/消息服务按需获取（历史单条正文最多返回 1000 字符，超出时附带 200 字符尾段；`qq_get_message_detail` 单条详情最多 4000 字符）。未读队列仅含待阅读的提醒，正文按消息 ID 从 QQ 获取，角色读过最新历史、未读页或单条详情后按实际返回的来信逐条确认。发送气泡数由模型决定，条间延迟为下一条的 Unicode 字符数乘 `socialV2.send.delayPerCharMs`，默认 20 ms/字，最多 1000 ms。0 表示连续发送，第一条直接发出。等待消息工具已移除。
- **本地控制台**位于 `http://127.0.0.1:3100`。首页汇总主会话、QQ 消息、记忆整理、后台学习的状态及待处理事项。主会话管理任务、记录、人格和模型。在「QQ 消息 → 消息来源」可按名称、群号或 QQ 号搜索，并筛选有未读或有待处理提醒的来源。顶部统计始终汇总全部来源。“长期记忆”提供记录检索和整理任务，“学习与素材”管理黑话、表情包和角色的修正建议。“令牌与花费”按功能展示用量，“系统运维”收纳日志、诊断和访问设置。
  - **令牌与花费看板**按主会话、记忆整理、旧记忆回顾和后台学习汇总模型用量，支持查看逐轮明细和消耗走势。通过 models.dev 更新价格，已入账费用随调用保存。旧账本金额保留原币种。详见[令牌与花费](docs/guides/TOKEN_USAGE_CONSOLE.md)。
  - **人格（角色扮演）管理**：列表点选即可载入查看/编辑提示词，支持新建、保存修改、改名（自动重命名文件）、另存为副本、删除；当前卡完整加入 DSH persona 固定前缀，列表和编辑区显示字符数与 token 粗估，超过建议的 6000 字符时只提醒、不截断。切换、编辑、清除、改名或删除后，会在下一次模型请求组装提示词时更新。
  - **全局数字角色提示词**：WebUI 按模块编辑 `desktop-agent` 固定前缀，可独立调整自主探索、有限休息、长期记忆等指引，也可逐个追加自定义模块，并预览组合后的完整前缀；保存会备份模块文件和 preset 并重新生成 DSH bundle patch。运行时提示模板仍可编辑 QQ 来源提醒、休息/恢复和长期记忆摘要；其中人格卡模板用于格式化 persona 固定前缀中的动态人格卡，保存后下一次模型请求生效。首次部署或修改固定前缀后仍需重启 DSH 并重建全局会话；普通切卡和编辑人格卡不需要重建。固定前缀中的人格卡会增加每次模型请求的上下文 token。
  - **DSH 模型与思考强度**：控制台从 DSH 模型目录读取可用模型和对应思考档位；目录不可用或模型未列出时可手动填写 Provider / Model ID。保存后下一条消息生效，并会同步改变 DSH 全局默认
  - **长期记忆**：namespace 有效且本机账本可读取时，可在“检索与记录”页按关键词、时间范围和来源进行 Gateway 检索，也可“浏览全部”分页查看本机账本中的活动原始记录；全量浏览不依赖 Gateway 可达性，是受控制台鉴权保护的 SQLite 只读查询。读取器随桥接自动运行，复用 `setup` 创建的 Python 3.12+ 虚拟环境，不需额外安装依赖或手动启动脚本；只配置其他 Gateway、但没有本机 `state/a-memorix/data/` 账本时，不能浏览全部。Gateway 检索、编辑和删除仍要求 A_Memorix 服务配置可用。纯关键词不选日期时走 `SEARCH`，关键词与日期同时给出时走 `HYBRID`，纯时间检索走 `TIME` 且至少需要一个日期边界。查看、编辑、删除均可从记录列表操作，修改采用新版本替代旧记录。“设置”页独立管理 Gateway、首次摘要和 Provider。新建或重建的 DSH 会话在首次任务前得到一次精简的自身经历摘要，QQ 来源记忆仍按需查询。全量列表只包含活动原始段落，不包含已删除项或关系、Episode、人物画像等派生管理视图。
- **全局 QQ 自主策略**：无周期模型心跳，也不靠阻塞等待工具维持在线。回合正常结束未调 `agent_rest` 时，桥接自动进入默认 30 分钟自运转待机；角色也可按需调用可选工具 `agent_rest`（或同义 `qq_agent_rest`）自定义 1 分钟至 4 小时待机时长，到期后以「自由活动时间」唤醒。有效 QQ 事件（P1 强召唤、P2 热群跟进、P3 冷群低优余光）按优先级打断待机，其中 P2/P3 绝不中途 `steer` 打断活动回合。桥接运行期间，对应来信仍未读的 P1 提醒会在进入待机且回合彻底停稳 5 秒后检查一次，最多补发一次；异常回合处于指数退避时不补发。`qq_list_conversations` 附带热群标记 `hot: true` 并置顶排序；出站 `send-message` / `send-burst` 除敏感内容拦截与审计外，还会拦截 `\uFFFD` 乱码与明显 Markdown 语法（返回 `400` 打回重发）。QQ MCP 在每次桥接请求时自动附加 `state/desktop-agent.json` 中的桥接内部凭证与全局会话 ID，模型不用传令牌；项目工具守卫与桥接 API 均校验当前全局 `desktop-agent` 会话绑定，可访问账号内任意合法 QQ key，不依赖逐会话白名单。`agent_rest` 只结束当前模型回合，不限制休息或停止生命周期中的后续工具调用。
- **全局数字角色能力**：WebUI 和符合条件的 QQ 注意信号复用一个持久 `desktop-agent` DSH session。会话可按需使用 `dsh-computer-use-win` 和 `mcp__qq__*` QQ 工具。GUI 发送不经过桥接 API 内容检查和审计。
- **交互增强**：
  - 全局数字角色通过 DSH 当前的用户交互流程与管理员沟通
  - DSH 自带的斜杠命令（如 `/model`）仍由 DSH 界面处理。桥接仅在已配置的 ownerQQ 私聊中识别纯文本 `/睡觉` 和 `/起床`：前者持久进入睡眠，取消当前与排队任务、清除已有提醒，并暂停 QQ 提醒与自动唤醒；后者结束睡眠并恢复一轮。WebUI「主会话」还可配置每日睡眠与起床闹钟（`desktopAgent.sleepSchedule`）。睡眠中的消息仍会缓冲，但不会积压提醒。WebUI 显示睡眠状态；重新启动桥接仍保持睡眠。其他 QQ 内容不解析为管理命令
  - 群聊中只有明确引用/回复到当前账号时才会触发群聊元数据唤醒（唤醒不代表必须发言）；角色按需读取历史、未读或单条详情时，引用/回复会解析为 `plain` 中的 `[引用 被引用人：原文]` 并附带结构化 `replyTo`（含精确 `messageId`、`sender`、`text`、`at`/`ago`、`hasMedia`、`forwardIds`），便于直接看图或定位原消息并避免把群友之间引用第三方的对话误当成指向自己
  - **分级看图与表情（含动图 GIF）**：普通消息和合并转发图片默认先返回归一化预览（长边 1280、1 MiB 以内，GIF 经 FFmpeg 抽帧拼图）及会话内有界 `imageRef`；需要辨认小字或核对细节时，角色可调用 `qq_get_image_detail` 按 `imageRef` 获取单张原图或按 `0..1` 归一化坐标裁剪局部（`crop`）。桌面 QQ 通道默认在收到新图片时后台预取补齐缓存（WebUI 可关闭），缺失时按需向 QQ 请求补取并校验原图 MD5；商城表情优先读取 QQ 预览缓存与原生发送资料，缺图时走 SSRF 防护的 CDN 回退（**IPv4 优先 + 逐地址故障切换**）。单条消息默认上限 8MB / 64MP / 5 张（`socialV2.media`）
  - MCP 发送工具支持可选 `replyToMessageId`，并提供专用 `qq_reply` 工具：AI 可以先用 `qq_get_conversation_history` 拿到真实消息定位，再引用/回复某条消息
  - `qq_send_message` 可用字符串发送一条，或用数组分开发送多条；多条发送时，数组中的某一项可写成 `{text, replyToMessageId}`，由数字角色选择哪条消息带引用，各条也可引用不同的消息。群聊单条发送仍可使用 `qq_reply`；统一发送的顶层 `replyToMessageId` 兼容旧写法，分多条时默认用于第一条。工具调用是唯一的 QQ 发送路径

- **DSH 内置网页工具**：`@deepseek-ai/dsh-tool-web` 提供 `web_search`（搜索并返回来源）和 `web_fetch`（抓取指定网页正文），分别调用 DSH 当前选择的 `ctx.web` 搜索/抓取提供方。`desktop-agent` 预设沿用插件默认值，默认启用两项，DSH 会向模型加入相应用法提示，并标注网页内容为不可信数据。请在 DSH 的「插件 → 网页搜索」配置提供方和所需凭据；实际可用性取决于提供方状态。此配置与桥接的 `webSearch` / `web-search-safe` 能力分开；若 DSH 选择随附的 `http` 抓取提供方，它允许访问本机和内网地址，不受桥接 SSRF 防护约束。更新预设后重启 DSH，并在桥接 WebUI 的「主会话」重建全局会话。

## 前置条件

1. 运行中的 DeepSeek Harness Desktop 或 Web API。Windows 桌面版端口由桥接启动时自动发现；固定端口部署默认使用 `http://127.0.0.1:3080`
2. 运行中的 Windows 桌面 QQ（64 位）及[本地通道依赖](docs/guides/NTQQ_ATTENTION.md)
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | 固定 DSH API 地址及自动发现的回退地址，默认 `http://127.0.0.1:3080` |
| `dsh.autoDetectPort` | 默认 `true`。Windows DSH 桌面版可能动态分配 API 端口；桥接启动时及 DSH 离线后会从其本机监听端口中识别 API。未发现时继续定期搜索，并检查配置的 `baseUrl`；就绪后连接事件流。发现的端口只在内存中使用，不写回配置。匹配到多个 API 且 `baseUrl` 不在其中时暂停连接，需指定目标地址并重启桥接 |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；可在 WebUI“DSH 模型与思考强度”中从模型目录选择或手动填写 Provider / Model ID |
| `dsh.authToken` | DSH launch token（进程启动凭据）。通常留空；桥接会用 `~/.dsh/.credentials.yaml` 中的浏览器会话签名密钥铸造 Cookie。显式填写时优先使用该 token 交换 Cookie |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| 会话 preset | 全局 DSH 会话固定使用 `desktop-agent` |
| `desktopAgent.rest` | 自运转待机时长配置：`defaultMs` 默认 `1800000`（30 分钟，回合自然结束未调 `agent_rest` 时自动采用），`maxMs` 默认 `14400000`（4 小时，上限 8 小时） |
| `desktopAgent.sleepSchedule` | 可选的每日睡眠与起床闹钟（`enabled`、`sleepTime`、`wakeTime`），默认关闭；采用桥接机器本地时区，可在 WebUI「主会话」配置 |
| `socialV2.media` | 图片/表情设置：`prefetchOnReceive` 默认 `true`，原生 QQ 通道收到新图片消息后后台检查并补齐缓存；设为 `false` 后仅在角色读取图片时补取。`maxBytes`（单条消息总字节，默认 8MB）、`maxPixels`（单张像素，默认 64MP）、`maxCount`（单条最多处理几张，默认 5）限制读取。交给模型前默认将单图控制在 1MiB；大图缩放与动图抽帧需要 FFmpeg。部署检查见 [DSH 端安装说明](docs/guides/DSH_SETUP.md#图片与动图依赖) |
| `socialV2.sticker` | `regularEnabled`（普通表情：聊天学习库与 QQ 账号收藏）和 `marketEnabled`（管理员收录的商城表情包）默认均开启，可在 WebUI「学习与素材」独立控制 |
| `webSearch.provider` | 桥接内置搜索模块（`src/web-search.js`）后端：`auto`（默认，优先 DeepSeek、失败回退 Bing）/ `deepseek` / `bing`。注：全局 `desktop-agent` 会话现默认使用 DSH 内置 `@deepseek-ai/dsh-tool-web`（`web_search` / `web_fetch`，在 DSH「插件 → 网页搜索」配置），不再挂载旧版桥接搜索 MCP |
| `webSearch.apiKeyEnv` / `apiKey` | 搜索凭据的环境变量名（默认 `DEEPSEEK_API_KEY`）/ 直接写死 key（不推荐）。都不设置时读 DSH 的 `$DSH_HOME/.credentials.yaml` 里同名 ref |
| `webSearch.baseURL` / `model` / `maxUses` / `maxResults` | 搜索端点（默认 `https://api.deepseek.com/anthropic/v1`，必须 https 且解析到公网）、模型（默认 `deepseek-v4-flash`）、单次搜索最多用几次工具、返回条数上限 |
| `allow.private` / `allow.groups` | 控制台直接测试发送的目标白名单；全局数字角色会话的 QQ 工具不受其限制 |
| `socialV2.attentionKeywords` | 可选关键词数组。匹配群聊正文时只给全局 agent 发元数据提醒，不把正文注入提示词；空数组关闭关键词提醒 |
| `socialV2.reminders.unreadFollowup` | 默认 `true`。单独控制未读 P1 提醒的补提醒，在进入待机且回合停稳 5 秒后检查一次、每项最多补发一次；关闭后取消定时器与待发补提醒 |
| `socialV2.reminders` | 八类提醒与补提醒的独立开关：`private` 私聊（同时约束好友申请提醒 `friendRequest`）、`atMention` 原生 @、`reply` 回复/引用、`roleCardName` 人格卡名称、`keyword` 关键词、`poke` QQ 戳一戳功能事件、`groupFollowup` 热群跟进（4 分钟自然超时热窗）、`groupActivity` 冷群低优余光（60 秒聚合 + 20 分钟冷却，有热聊时让路）。缺省全开，受 `socialV2.enabled` 总开关控制；WebUI「QQ 消息 → 提醒与发送」保存后立即生效 |
| `socialV2.groupAttention` | 可选热群/冷群调度参数：`hotWindowMs`（默认 4 分钟）、`hotDebounceMs`/`hotExtendMs`/`hotMaxDebounceMs`（默认 5/3/10 秒）、`privateActiveMs`（默认 3 分钟）、`coldAggregateMs`（默认 60 秒）、`coldCooldownMs`（默认 20 分钟） |
| `ownerQQ` | 可选的 QQ 账号身份锚点，也用于验证私聊睡眠命令；具体关系和称谓由当前人格卡及双方表达决定。可在控制台“系统运维 → 访问设置”中设置或清除；保存后本地配置优先于 DSH 的同名设置。旧安装在首次通过控制台保存之前仍兼容 DSH 的 `qq-agent-presets.ownerQQ` |
| `consolePort` / `consoleToken` | 本地控制台固定端口（默认 `3100`）和访问令牌；端口占用时桥接会报错退出，不会随机换端口。令牌留空时自动生成并保存到 `state/console-token`；登录页验证后使用仅当前浏览器会话有效的 HttpOnly Cookie |
| `memory.enabled` / `baseUrl` / `namespace` / `apiKey` | 可选 A_Memorix 长期记忆。默认关闭；部署本机 HTTP/JSON Gateway 并创建 namespace 后，可在 WebUI 配置连接地址、namespace、密钥和使用上限；API key 只保存在不入库的 `config.json`。 |
| `memory.timeoutMs` / `bootstrapLimit` / `bootstrapMaxChars` | A_Memorix 请求超时与新会话首次注入摘要的条数/字符上限；默认 `45000` ms、`6` 条、`2500` 字符。配置与维护说明见 [长期记忆方案](docs/guides/MEMORY_ARCHITECTURE.md) |
| `memoryCurator.enabled` | 默认 `true`。长期记忆启用且连接本机部署的 Gateway 后，独立后台 preset 自动回顾已存原文。控制台「长期记忆 → 整理任务 → 旧记忆回顾」显示依据、用量、暂停与撤销，无每日组数或 token 配额。详见[旧记忆回顾](docs/guides/MEMORY_ARCHITECTURE.md#旧记忆回顾)。 |
| `memoryOrganizer` | 休息后每日独立长期记忆整理配置（`enabled` 默认 `true`、`timeZone` 默认 `Asia/Shanghai`、`cliPath` 可选 headless CLI 覆盖） |
| `chatLearning` | 后台黑话与表情学习开关、来源范围及批次预算；默认启用，详见 [CHAT_LEARNING.md](docs/guides/CHAT_LEARNING.md) |
| `deny.*` | 控制台直接测试发送的目标拒绝名单；全局数字角色会话通过桌面 QQ 通道读写 QQ |

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

3. 准备 Windows x64 桌面 QQ 本地通道环境（需同机已登录桌面 QQ）：安装 Frida 与 SQLCipher 数据库读取器、导入当前账号数据库密钥，并运行只读诊断命令确认能打开原库。[桌面 QQ 通道安装与验收](docs/guides/NTQQ_ATTENTION.md#新机器安装)
4. 在仓库根目录将角色预设与 MCP 工具安装到正在使用的 DSH profile。桌面版运行 `node scripts/setup-dsh.mjs desktop`，Web 版运行 `node scripts/setup-dsh.mjs web`。完成后退出并重新打开 DSH。
5. Windows 运行 `.\start.bat` 启动守护进程，也可用 `npm start` 前台运行。打开 `http://127.0.0.1:3100`，使用配置的控制台令牌登录，自动生成的令牌在 `state/console-token`。在「系统运维 → 诊断与维护」核对 DSH 和 QQ 消息通道，确认显示桌面 QQ 连接与「原库只读连接已就绪」。[DSH 验证与排错](docs/guides/DSH_SETUP.md#验证)

已有安装升级时请保留原配置和会话数据，按当前 profile 操作（如旧版 `config.json` 保留 `"qqBackend": "snowluma"`，请移除该字段或改为 `"native"`；SnowLuma 通道已移除）。[从旧版升级](docs/guides/DSH_SETUP.md#从旧版升级)

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **DSH 重启后**，桥接重新探测 API 端口并接续原角色会话。提醒位置和确认进度按账号保存在 `state/ntqq-reminders-<account>.sqlite`。会话休息截止时间、恢复退避和停止状态保存在 `state/desktop-agent.json`。
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `dsh/agent-presets/`（改完要跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] 桌面 QQ 通道已连接
12:00:02 [bridge] QQ 注意信号已排队（private，元数据）
12:00:03 [bridge] 全局 desktop-agent session 已创建：sess_xxxx
12:00:20 [bridge] desktop-agent 完成当前回合
```

## 自测（不需要 DSH / QQ）

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 QQ 消息）：

```bash
npm test
```

日常开发可先跑改动涉及的专项，推送前跑上述离线回归。WebUI 交互有变化时加跑 `npm run test:console-ui`。表情、外网搜索和独立语音 GUI 等专项的真实联调需显式设置 `QQ_BRIDGE_TEST_LIVE=1`。

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

预期输出：连接成功 → 创建一个独立测试 session → prompt 被接受 → 打印 agent 回复 → 归档测试 session。它不会操作 QQ 会话。

## 开发与文档同步规范（接手必读）

为防止代码演进后文档滞后、前后矛盾或沦为“只追加不清理”的流水账，任何功能、配置、提示词或安全边界改动**必须在同一提交中同步更新对应文件**：

### 1. 改动类型与必更文件映射

| 改动内容 | 必须同步更新的文件 / 执行的命令 |
| --- | --- |
| 新增、重命名或删除 `src/`、`plugins/`、`scripts/` 模块 | [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)、[docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)（第五节代码边界） |
| 新增、删除或移动 `docs/` 下的文档 | [docs/README.md](docs/README.md)（保持索引零断链） |
| 修改 `config.json` 配置项、默认值或运行时提示模板 | [config.example.json](config.example.json)、[README.md](README.md)（配置表）、[src/desktop-agent-prompt-templates.js](src/desktop-agent-prompt-templates.js) |
| 修改固定前缀模块 `dsh/agent-presets/desktop-agent/prompt-modules.json` | 同步 `agent.cordis.yml`，并运行 `node scripts/build-agent-preset-patches.mjs` 更新 `plugins/qq-agent-presets/presets/desktop-agent.patch.yml` |
| 改变会话生命周期、唤醒/提醒规则、工具权限或桌面边界 | [RULES.md](RULES.md)、[docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md)、[AGENTS.md](AGENTS.md) |
| 改变鉴权、路由白名单、工具守卫、路径/网络校验或文件落盘策略 | [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md)、[RULES.md](RULES.md)、对应 `scripts/test-audit-*.mjs` |
| 修改控制台 API 或前端交互（`public/console.*`） | [scripts/console-ui-fixture.mjs](scripts/console-ui-fixture.mjs)（补齐离线 mock），并运行 `node scripts/test-console-static.mjs`（有 Playwright 时加跑 `npm run test:console-ui`） |
| 修改独立通道（NTQQ）、长期记忆、后台学习、令牌计价或 Maa-Agent | 对应专题文档：[NTQQ_ATTENTION.md](docs/guides/NTQQ_ATTENTION.md) / [NTQQ_HISTORY.md](docs/guides/NTQQ_HISTORY.md) / [NTQQ_SEND.md](docs/guides/NTQQ_SEND.md) / [MEMORY_ARCHITECTURE.md](docs/guides/MEMORY_ARCHITECTURE.md) / [CHAT_LEARNING.md](docs/guides/CHAT_LEARNING.md) / [TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md) / [MAA_AGENT.md](docs/guides/MAA_AGENT.md) |

### 2. 文档编写与维护四原则

1. **就地修改，禁止盲目头尾追加**：更新既有功能时，找到文档中对应的章节直接修改，**不要**为了省事直接往文件顶部或末尾追加一段新说明（否则会导致同一份文档内出现多处重复或新旧规则互相冲突）。
2. **清理被取代的旧结论**：当过渡方案（如旧接口、旧限制、临时回退）被正式实现取代时，直接删改旧描述；**不要**把单次排查的过程流水账混入长期维护指南。
3. **代码与模板是唯一事实来源**：文档中的配置键名、默认值、工具名、路由白名单和提示词模板，必须与 `src/`、`plugins/` 和 `config.example.json` 的实际代码逐字对齐。
4. **提交前必跑离线门禁**：

```bash
node --check src/bridge.js                           # 主程序语法门禁
node scripts/build-agent-preset-patches.mjs --check  # preset 源与 bundle patch 一致性
npm test                                             # 全量离线回归套件（50 个脚本）
node scripts/privacy-scan.mjs --tracked-only         # 隐私与敏感信息扫描（防真凭据/本机路径入库）
```

> 给 AI 代码代理的仓库级约束位于 [AGENTS.md](AGENTS.md)。若核心架构或开发门禁发生变化，请优先同步更新 `AGENTS.md`。

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
  plugins/qq-agent-presets/ # DSH 全局/后台 preset、工具守卫、压缩钩子、纳管 MCP 及 ownerQQ 设置
  src/
    bridge.js           # 主程序（运行时组合与协调）
    native-qq.js        # 桌面 QQ 本地通道运行时
    autonomy-policy.js  # 纯唤醒策略
    dsh-client.js       # DSH API 客户端
    mcp-qq.js           # QQ 消息与媒体读写 MCP 工具
    mcp-memory-safe.js  # A_Memorix 长期记忆 MCP 工具
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测（完整模块列表见 docs/FOLDER_MAP.md）
  scripts/              # 测试、运维与诊断脚本
  state/                # 运行时数据（不入库）
```

## 已知限制

- 角色通过 QQ 发送工具选择每条消息的内容。多条发送间隔由 `socialV2.send.delayPerCharMs` 决定，每条最多等待 1000 ms。
- 图片及部分表情可以通过安全读取接入多模态模型；视频和其它不支持的媒体类型不做内容解析
- 当前桥接运行时不提供 QQ 语音发送、接收或转写能力
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
