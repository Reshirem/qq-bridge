# 安全基线与威胁模型（qq-bridge）

> 本文把项目里**已经实现的**安全边界、**已知的**残余风险、以及**每次发布必须回归**的检查项集中到一处。与之配套的承诺性文档是 [../../RULES.md](../../RULES.md)（面向使用者的权限说明）；本文偏工程实现，供改动代码前后对照。
>
> 维护规则：任何改动如果改变了下面任一条目，**必须在同一个 PR 里更新本文**。
>
> 当前运行时只有一个全局 `desktop-agent` 会话。桥接通过 Windows 桌面 QQ 本地通道（`NativeQQ` + `openNativeReminders`）接收与发送消息，按需从桌面 QQ 原库查询正文，只把私聊、原生 @、已验证回复/引用、当前选中人格卡名称、配置关键词及发给当前账号的 QQ 戳一戳功能事件作为**不含正文的元数据提醒**。WebUI 可启动、提交任务或持久停止。每个活动回合应以 `agent_rest`（或 `qq_agent_rest`）收尾；它结束当前模型回合，但不限制后续工具调用。用户在 DSH 对话中发消息、有效 QQ 提醒或 WebUI 任务可提前结束普通休息并唤醒一轮；未调用休息工具的正常完成回合首次立即发收尾提醒、连续遗漏与异常回合按指数退避（最高间隔 30 分钟）；睡眠（`sleeping`）与 WebUI 停止态（`stopped`）抑制自动提醒唤醒。全局主体可使用完整 `mcp__qq__*` 工具集、可选 `mcp__qq-memory__*` 记忆工具、DSH 内置网页工具及 `dsh-computer-use-win`，其凭证与当前全局会话绑定，可访问账号内任意合法 QQ 会话 key。桥接 API 发送执行内容检查和审计；GUI 操作不经过这些 API 检查。逐 QQ DSH 映射、单会话令牌、SnowLuma/OneBot 支持与旧控制入口已移除。

---

## 一、威胁模型（我们要防谁、防什么）

| 威胁主体 | 能力假设 | 我们不防的 |
| --- | --- | --- |
| **QQ 群友 / 陌生人** | 能给机器人发任意文本、图片、表情、戳一戳、合并转发；能尝试提示注入 | 他们能看到的公开信息 |
| **被注入的模型** | 会尝试调用任意工具名、传任意参数、尝试外发本机内容 | —— |
| **本机其他用户** | 能登录同一台机器，能读文件系统 | 文件访问由操作系统和用户配置的目录权限决定；桥接不自动收紧 ACL |
| **本机其他进程 / 浏览器页面** | 能访问 `127.0.0.1`，能构造任意 HTTP 请求 | 已能读写本项目 `state/` 的主体 |
| **DSH 侧 desktop-agent** | 由 WebUI 任务、用户在 DSH 对话中的直接消息或 QQ 元数据提醒启动；每轮以 `agent_rest` 收尾 | 对任意 UI 动作的应用级授权；GUI 操作不经桥接 API 审计 |

**不在此模型的范围内**：QQ 账号本身被盗、桌面 QQ 客户端自身安全缺陷、DSH 本体漏洞、操作系统级攻击者。这些情况下本项目无法提供额外保护，README 中已声明。

---

## 二、已实现的边界（按攻击面）

### 1. 准入与会话绑定（谁能触发 agent、谁能调工具）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 管理端测试发送白名单 | `src/bridge.js` `allowed()` | 控制台直接测试发送时使用 `allow` / `deny` 配置；全局 `desktop-agent` 的合法 QQ key 不受该列表限制 |
| 全局会话令牌与 Session ID 绑定 | `isDesktopAgentToken()`、`src/mcp-qq.js`、`qq-tool-restrict.mjs` | MCP 从 `state/desktop-agent.json` 自动读取并附加桥接内部 `x-agent-token` 与 `x-agent-session-id`；`qq-tool-restrict.mjs` 在 `tools/pre-execute` 校验 `exec.agent.id === state.sessionId`，桥接对 `/api/desktop-agent/owner-identity`、`/api/socialV2/*`、`/api/send/*`、`/api/images/*` 同步校验令牌与当前 `desktopAgentSessionId` 一致；QQ key 须匹配 `^(group\|private):\d+$` |
| 唤醒与可见性 | `src/autonomy-policy.js` + `handleIncoming()` | 私聊、原生 @ 机器人、已验证回复/引用、当前选中人格卡名称、`socialV2.attentionKeywords` 和发给当前账号的 QQ 戳一戳功能事件只发元数据提醒。普通群消息可按来源查历史；正文由全局 agent 主动读，无周期模型心跳 |
| 全局生命周期 | `state/desktop-agent.json` + `agent_rest` + WebUI stop | `active` 回合最后调用 `agent_rest` 后休息 1 至 15 分钟（默认 5 分钟）；用户在 DSH 对话中发消息、WebUI 提交任务或有效 QQ 提醒可提前结束休息。正常完成漏调休息工具时首次立即提醒，连续遗漏与异常回合按 1、2、4、8、16 分钟退避（随后最长每 30 分钟），休息期间不运行异常退避。WebUI Stop 取消当前/排队 DSH 工作并持久关闭自动恢复；只有 WebUI 手动启动/提交任务清除停止态 |
| 配置失败 | `loadConfig()` | `config.json` 缺失/解析失败，或显式设置了已移除的非 `native` `qqBackend` → **fail-fast 退出**（不是“用默认值继续跑”） |
| QQ 关系对象标记 | `handleIncoming()`、`withCurrentOwnerIdentity()` | 消息发送者 ID 取 `event.user_id`，缺失时回退 `event.sender.user_id`；仅当 `ownerQQ` 已配置且对方发送者 QQ 号相同才标记为 owner。显示名称不参与身份判断；关系称谓由人格卡及双方表达决定。该账号仅被授权通过纯文本私聊 `/睡觉` 和 `/起床` 控制睡眠，不授予其他管理权限；群消息和引用、转发等非纯文本消息不触发命令 |

**未读确认与最近已读定位映射**：桥接按账号在 `state/ntqq-reminders-<account>.sqlite` 中保存提醒位置、投递进度与确认状态（由 `src/native-reminders.js` 管理，不缓存聊天正文或附件）。获授权的角色读取请求完成响应后，桥接按本次未读页、单条详情或历史页实际返回的来信逐条确认；跳过的未读、读取期间新到且未返回的来信、管理端预览和后台学习均保留原未读状态。确认已读后，每个来源在内存最多保留最近 100 条 `seq → messageId` 对应关系，后续序号读取仍校验来源与缓存标识并以实际 QQ 消息 ID 回查；切换账号、清空缓存或重启后映射失效，过期引用须改用原读取结果中的稳定 `id:<QQ消息ID>`。

### 2. 工具面与后台任务隔离（agent 能做什么）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 主会话预设工具守卫 | `plugins/qq-agent-presets/qq-tool-restrict.mjs`（唯一权威实现） | 唯一 `desktop-agent` 开放 `mcp__wincu__*`、完整 `mcp__qq__*` QQ 工具、`mcp__qq-memory__*` 记忆工具、可选已启用的 `maa_*` 游戏工具，以及 DSH 原生 `web_search` / `web_fetch`。`ask_user_question` / `todo_write` 不由 preset 挂载且不在工具白名单中；shell、通用文件、子代理和 Harness 管理工具一律拒绝 |
| 后台黑话/表情学习与商城整包分析工具面 | `background-tools.mjs`、`src/learning-tool-guard.mjs`、`src/mcp-learning-images.js` | 允许在主角色未读取消息时分析有界的新消息批次或管理员收录的商城表情包。Host `chat-learning` / `market-analysis` preset 与隔离 headless 回退均只暴露本批图片工具 `learning_images`；桥接通过控制台鉴权和执行会话 ID 查找内存中的图片批次，批次结束即解绑。模型输出仅作为结构化数据校验：黑话证据须来自本批原文（仅归一化大小写、NFKC 与空白，不改写证据原文），图片编号须来自本批清单。不能向 QQ 发消息或控制主会话 |
| 旧记忆回顾 | `src/memory-curator.js`、`plugins/qq-agent-presets/memory-curator.mjs`、`curator-tool-guard.mjs` | 模型只接收同来源候选原文，Host 和 headless 均禁止执行工具。桥接核对原文版本，经 Gateway 保存可撤销的派生记录；回顾控制仅限鉴权控制台。 |
| 独立记忆整理工具面 | `background-tools.mjs`、`memoryOrganizerPatchText()`、`src/memory-organizer-tool-guard.mjs` | 整理输入视为不可信资料，只采用主会话已保存的可见证据（`session/page` + `readThroughSeq`）。Host `memory-organizer` preset 与隔离 headless 回退严格限于五个记忆工具（`memory_search/save/read/replace/forget`），桥接校验当前任务绑定的执行会话 ID。headless 回退时只复制当前所选 provider 与模型，使用 `apiKeyEnv` 时启用 DSH 本地凭据解析器，密钥值不写入 patch 或日志，不修改 DSH profile 默认模型 |
| DSH 网页工具配置 | `dsh/agent-presets/desktop-agent/agent.cordis.yml` 的 `tool-web` 行 | `desktop-agent` 加载 `@deepseek-ai/dsh-tool-web` 并沿用其默认配置。工具通过 DSH 选择的提供方访问网络，不经过桥接 `safeFetch`；随附的 `http` 抓取提供方允许访问本机和内网地址 |
| 预设 fail-closed | `ensureDesktopAgentSession()` | `desktop-agent` 不可用时拒绝创建全局会话，不回退到 DSH 默认 preset |
| 压缩宿主依赖 | `plugins/qq-agent-presets/dsh-host-modules.mjs` | 只从当前 DSH 宿主/CLI 运行入口（含桌面版 `app.asar`）解析共享压缩与 LLM 模块并校验类身份；缺失、不支持或分裂时拒绝加载，不回退私有旧依赖、不修改 DSH 安装包 |
| 发送强制授权 | 所有 `/api/send/*`、`/api/socialV2/send-*` | MCP 自动携带全局 agent 令牌与全局会话 ID；不要求当前 DSH 回合处于 `active`。所有桥接 API 发送均受会话授权、敏感内容检查和工具调用审计 |
| 媒体与本地表情动态 ACL | `src/learning-assets.js`、`src/sticker-lib.js`、`src/native-qq.js` | 表情只能发 QQ 收藏库、当前来源可用的本地学习表情或已启用的收录商城包；本地素材只读 `state/learned-stickers/` 哈希命名文件，校验 `realpath` 与 SHA-256，并在发送排队结束后重验来源与启用开关。本机图片仅限制到当前已登录 QQ 账号的 `nt_data`，以 `realpath` 复核防止符号链接逃逸 |
| **进程控制守卫（L6 不变量）** | `src/mcp-qq.js` | `qq_status` 只读查询桌面 QQ 连接与原库健康状态；`src/mcp-qq.js` 严禁引入 `child_process` 或进程控制原语，由 `scripts/test-audit-setup-guards.mjs` 静态检查守护 |

**记忆整理证据完整性（版本 3 / 版本 4 / 版本 5）**：新版整理证据会移除 QQ 正文字段中完整值为 `[notice]` 的通用占位，仅同来源、同消息在主会话其他成功读取中已有正文时才可补全（记录 `bodySourceSeq`）；不回查当前 QQ 数据库、不把占位解释成撤回，真实正文或账号/时间冲突仍阻断整理。证据版本 4 对外部桌面/浏览器/OCR/控件树辅助工具结果做有界压缩（超 16,000 字节保留脱敏预览并标 `resultTruncated: true`）。证据版本 5 在不读取本机 spill 临时文件、不回查 QQ 库的前提下，对 `surfaceOp === 'append'` 且仅因 DSH 溢出页脚截断的 `qq_get_conversation_history` / `qq_get_unread_messages` 执行 fail-closed 结构解析，仅保留首尾完整可见消息与 `readThroughSeq`、丢弃残片与临时路径并标记 `partial: true` 与 `resultTruncated: true`；`/api/socialV2/conversation-history` 与 `/api/socialV2/unread` 同步施加 40,000 字节单页模型视图上限，仅确认实际返回页的未读条数。非溢出的 `[truncated]`、记忆/休息/单条详情读取截断以及替换过的工具结果仍阻断整理；已有分段的旧任务保留原证据版本以保持幂等 `externalId`（详见 [MEMORY_ARCHITECTURE.md](MEMORY_ARCHITECTURE.md#独立整理的读取失败与恢复)）。

**表情检索空间与商城包管理**：商城包管理走控制台 `/api/learning/market-packs` 接口；分享链接仅用于解析数字包 ID，桥接根据包 ID 和商城清单中的表情 ID 构造固定腾讯 CDN 地址。表情语义索引使用独立的 A_Memorix `qq-bridge-stickers` 空间（专用密钥保存在本机 `state/a-memorix/secrets/`，仅桥接可用），图片字节与聊天证据不写入表情索引。角色只能在看过图片后提交有界的修改建议，采纳与忽略均限控制台。

**可选的 Maa-Agent 游戏工具**：安装记录位于 `state/maa-agent/install.json`。启用后，角色预设提供 Maa-Agent 原生命令和常用游戏工具；桥接将作业路径和参数传给已安装的 Python 模块，使用上游设备锁、关卡核验和任务状态，截图由 DSH 附件服务交给模型（详见 [MAA_AGENT.md](MAA_AGENT.md)）。

### 2.1 桌面应用范围与跨场合隐私（提示词边界）

- **底层运行/开发窗口保护**：`desktop-agent` 的会话提示要求，使用 computer-use 观察或操作电脑时，看到 ChatGPT、DeepSeek Harness、qq-bridge 或相关开发窗口属于正常现象，但不得关闭、停止这些程序或改动其中的运行控制、配置与代码，也不得将屏幕上看到的内部凭据、路径或日志外发到聊天中；挡住目标应用时，仅在用户未使用该窗口的前提下允许最小化（网页浏览优先走不抢焦点的 `browserTab` 后台浏览器通道）。电脑操作插件支持后台操作和由用户通过 Esc 停止前台桌面操作，但普通鼠标移动或按键不会自动停止工具。这是模型行为规则，不是 computer-use 服务端的应用级访问控制。
- **跨 QQ 场合隐私**：固定前缀要求数字角色区分 QQ 聊天场合，不主动带入、也不因第三方请求而复述、概括或确认其他群/私聊的对话、人物、观点、关系、群内梗和个人经历；同一当事人问起自己先前私聊的内容且账号身份可确认时，仅围绕当前问题自然回应。这是模型行为引导；群聊、私聊、知识查询和记忆仍共享全局会话上下文，并无程序级会话隔离或出站语义过滤。

### 2.2 桌面 QQ 本地通道、分级看图与合并转发边界

- **进程内通信与只读原库**：桥接在当前登录用户权限下通过 Frida 将仓库内固定运行代码加载到 QQ 主进程，使用每次启动新建的本机命名管道和随机握手令牌通信。常驻读取器由 Windows 文件句柄确认 QQ 主进程打开了对应账号的数据库；首次导入的密钥经原库验证后由当前 Windows 用户 DPAPI 加密保存在 `state/ntqq-reader/keys/`。SQLCipher 通过只读 Win32 VFS 访问 QQ 主库、WAL 和共享内存索引，原生 64 位消息 ID 全程以字符串传递（详见 [NTQQ_ATTENTION.md](NTQQ_ATTENTION.md) 与 [NTQQ_HISTORY.md](NTQQ_HISTORY.md)）。
- **主动戳一戳（`qq_send_poke`）**：校验全局 agent token 与当前全局会话绑定。群聊目标须通过本群成员查询，私聊显式目标须等于当前私聊对象；号码转为 Number 前拒绝超出安全整数范围的输入。成员查询与 UID 解析前后重验 QQ 账号、全局凭证与连接状态；原生 `sendNudge` 的失败、缺失回执和不支持均不得返回成功，断线或超时不自动重发。接收戳一戳提醒的开关不限制主动发送。
- **好友申请、邀请加群与 Ark 卡片边界（`qq_list_friend_requests` / `qq_handle_friend_request`、`qq_list_group_invites` / `qq_handle_group_invite`、`src/qq-card.js`）**：入站好友申请的昵称与验证留言、以及入站群邀请的群名称、邀请人昵称、附言与风险提示均视为外部不可信输入，绝不进入唤醒提示词或活动摘要，仅经 `GET /api/socialV2/friend-requests` 与 `GET /api/socialV2/group-invites` 有界截断返回。`POST /api/socialV2/friend-request/handle` 与 `POST /api/socialV2/group-invite/handle` 强制校验全局 agent token 与当前 `desktop-agent` 会话绑定，仅允许匹配桥接已观测或实时从 QQ 拉取到的待处理通知（拒绝伪造 `flag` 或重复处理）；`approve` 须为布尔值，拒绝时禁止传 `remark`，同意群邀请时禁止传 `reason`；`remark`（最多 64 字符）与 `reason`（最多 100 字符）拒绝换行与控制字符并执行 `SENSITIVE_RE` 与已知令牌检查（命中返回 403）；执行前经 `captureSendGuard` 确认账号与会话未切换，失败不自动重试。群邀请处理仅限 `INVITED_BY_MEMBER`（`type=1`）入站邀请，不暴露群管理员审批接口。Ark 卡片解析器 `src/qq-card.js` 限制原始 JSON 不超过 32 KiB、剥离换行与控制字符、隐藏内部 `config.token` 与 `mqqapi://` 参数（仅保留无凭据的 `http`/`https` 链接与安全群号摘要），且 `handleIncoming` 判醒/后台黑话学习仍关闭卡片正文展开以防止标题关键词误唤醒或污染词库。
- **接收预取与转换预览校验**：原生接收预取仅依据当前账号新来信事件中的来源、消息 ID 和 MD5 图片标识检查缓存（跳过历史补查），每条受 `maxCount` 约束，最多 2 项并发、100 项待完成；关闭预取、断线或换账号丢弃未启动任务，进行中的读取重验原账号、连接与读取器未变。转换预览的候选路径取自原生运行时核验过的消息图片元素：`thumbPath[0]` 限于当前账号 `Pic` 或 `Emoji/emoji-recv` 的年月 `Ori/Thumb` 目录；普通消息 `picSubType=0` 的 `sourcePath` 预览须位于当前账号 `Pic/YYYY-MM/Ori/<消息摘要>.<扩展名>`，核验真实路径与词法路径，且实际交付字节须是符合元素声明宽高的 JPEG。两种转换预览都执行大小、64MP 像素及有界完整解码检查；原图继续强制校验文件头与 MD5。
- **合并转发与转发内媒体（`qq_get_forward_msg`）**：原生句柄包含根消息 ID；QQ 进程内先查验来源中的根消息确为合并转发，再调用 `getMultiMsg`。嵌套节点和转发内媒体只接受当前账号与连接实际返回、并在有界索引中登记过的节点（不保存完整原生元素，不持久化正文或下载鉴权信息，切换账号或断线即失效）。转发图片使用 `downloadRichMedia`，定位固定为已核验的最外层来源、根消息 ID 加内部图片元素 ID；下载完成事件须匹配根消息和元素 ID，仍由读取器验证实际缓存，不使用请求体中的 URL 作为下载回退，也不允许调用方指定本地路径。工具可见的下载错误只保留数字错误码，不回传本机路径或带签名 URL。
- **单图原图与裁剪（`qq_get_image_detail`）**：通过 `POST /api/socialV2/image-detail` 校验全局会话令牌、会话绑定及目标来源，只接受桥接为已读取 QQ 媒体登记的随机 `imageRef`（绑定登录账号、来源、消息/转发节点与图片位置，最多 2000 项、空闲 24 小时过期、断线即清空；不能用裸 MD5、路径、URL 或跨来源引用探测本机文件，额外参数不能替换引用内身份，读取完成前再次核对账号和引用）。原图解码限制为 32 MiB、6400 万像素、单边 32768 像素；FFmpeg 使用固定参数、单线程、有界分配和总超时，私有临时目录在成功或失败后清理。先按 EXIF 正向处理显式 `0..1` 裁剪区域，保持尺寸重编码到最多 3 MiB；无法满足时报错建议缩小裁剪区域，不隐式降采样。模型可见元数据不包含本机路径。
- **独立发送测试命令（`scripts/ntqq-probe/send_test.py`）**：仅在人工显式执行且 QQ 核对账号及目标私聊后，才发送固定测试文字或经 MD5 校验的收藏原图；调用前原子创建本地尝试记录，日志位于 Git 忽略的 `state/ntqq-probe/send-tests/`（详见 [NTQQ_SEND.md](NTQQ_SEND.md)）。

### 3. 出站内容（模型能说什么、能发什么）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 敏感信息拦截 | 发送 API 中的 `SENSITIVE_RE` 检查 | 消息含本机路径、UNC 或凭据赋值形态时整条拦截，不发送；控制台测试发送也执行检查 |
| 会话令牌防外发 | `redactKnownTokensOnly()` + `sendQQMessage()` | 所有已知 agent token 在发送前脱敏；文本里若仍出现已知令牌则**直接抛错不发** |
| 结构化消息段发送 | `sendQQMessage()` | 出站文本一律包成结构化 `{type:'text'}` 段构造原生消息，不进行 CQ 码字符串拼接或转义插值 |
| @ 限制 | `sendQQMessage()` | `atUserId` 只接受正整数，禁止 `@all` |
| 分条与收藏配额 | `socialV2.send` / `sticker.collect` | 限制一次调用的气泡数；条间按 `delayPerCharMs` 延迟（最多 1000 ms）。消息发送不设每分钟/每小时/单条字数配额；收藏 QQ 表情另有频率限制 |

### 4. 控制台（本机最高权限入口）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 只监听回环 | `server.listen(port, '127.0.0.1')` | 永不绑 `0.0.0.0` |
| 令牌门 | 请求最前面 | 管理业务 API 都要 `x-console-token` 或登录后设置的 HttpOnly `qq_bridge_console` Cookie；登录通过 `POST /api/console/login` 的 JSON token 校验，根路径可返回登录页，favicon/触摸图标免鉴权返回 204。URL 查询参数不参与鉴权，`/?token=...` 会被拒绝；未配置时启动自动生成 192 bit 随机值 |
| 定长比较 | `crypto.timingSafeEqual` | 比较前先比长度，避免 `!==` 短路带来的时延侧信道 |
| Host 校验 | 请求最前面 | Host 必须是 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，否则 403（DNS rebinding 硬化） |
| CSRF | 非 GET 请求 | 必须 `content-type: application/json`；若带 `Origin`，其 host 必须等于本机 |
| agent 令牌隔离 | 请求前缀白名单 | 带 `x-agent-token` 的请求默认拒绝，仅放行 `/api/status`、`/api/desktop-agent/owner-identity`、`/api/desktop-agent/rest`、`/api/desktop-agent/memory/*`、`/api/socialV2/*`（显式排除 `/api/socialV2/config`、`/api/socialV2/reset`、`/api/socialV2/states` 及 `GET /api/socialV2/feedback`、`GET /api/socialV2/tool-log`）、`/api/send/*`、`/api/images/*`；其它管理端点（含 `/api/learning/*`、`/api/slang*`、`/api/stickers*`、`/api/memory/*`、`/api/console/*`）一律 403。`idle`、`active`、`resting`、`recovering`、`sleeping` 和 `stopped` 生命周期状态不控制白名单工具是否可调用；每个端点仍执行自身的参数校验、会话绑定、内容检查和工具审计 |
| 空令牌拒绝 | `x-agent-token === ''` | 一律 403，避免“空 = 管理端”的绕过 |
| 写操作不挂 GET | 全路由审查 | 会触发副作用的接口（如表情强制同步、MCP 探测/重连）一律 POST；GET 只读 |
| WebUI 会话与停止管理 | `/api/console/desktop-agent`、`/stop` | 仅控制台令牌可查看状态、启动、提交任务或持久停止；停止时先持久化 `stopped` 并清除休息/恢复定时器，再尝试取消当前和排队的 DSH 工作 |
| WebUI 关系对象设置 | `/api/whitelist` | 仅控制台令牌可设置或清除 `ownerQQ`；首次保存后由本地配置优先，忽略 DSH 同名设置。测试发送名单独立保存，只限制控制台测试发送 |
| QQ 持久睡眠与每日闹钟 | `handleIncoming()`、`/api/console/desktop-agent/sleep-schedule` | QQ 睡眠命令仅限已配置 `ownerQQ` 的私聊纯文本 `/睡觉` 和 `/起床`；每日睡眠闹钟默认关闭、仅认证控制台可读写，睡觉与起床定时动作均跳过 `stopped`，关闭定时不唤醒 `sleeping`，配置代次和生命周期复核阻止旧回调覆盖新设置 |
| MCP 连接诊断与重连 | `/api/console/mcp` | 仅认证控制台可用；GET 只订阅状态，POST 仅限操作 `qq` / `qq-memory`，不能传命令、环境变量或其他服务名。同名操作互斥且有总超时，超时视为未确认、不自动重发，只返回白名单状态字段和有界脱敏诊断 |
| 长期记忆设置与管理 | `/api/memory/*` | 受控制台令牌保护；Provider 密钥只写入 `state/a-memorix/secrets/`，TOML 中仅保存密钥文件路径，状态接口只返回密钥是否已设置、不回显密钥。`POST /api/memory/records/list` 仅供控制台使用 SQLite `mode=ro` + `query_only` 和参数化查询只读分页浏览当前 namespace 的 `paragraphs` 表，校验 storage key 路径与必需列，不写数据库 |
| 记忆工具与开场摘要 | `/api/desktop-agent/memory/*`、`submitDesktopAgentPrompt()` | 校验全局 agent token，固定访问 `config.json` 中的 A_Memorix namespace；参数正文与检索词不写入工具参数日志。`memory_replace` 逐条预读目标并核对同来源，确认新 ID 后才经 Gateway 删除旧记录。开场摘要只在新/重建会话首次提示查询 `assistant` 来源，QQ 来源不自动注入 |
| 请求体限制 | `readBody()` | 声明长度或实际累计超过 1 MB → 413；30 秒读取超时 |
| 安全响应头 | 全部响应 | `X-Frame-Options: DENY`、CSP、`nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store` |

### 5. 秘密、诊断脱敏与落盘

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 原子写 | `atomicWriteJson/Text()`、`atomicWriteConfigJson()` | 唯一随机临时名 + rename（Windows EPERM 退避重试），不会写坏配置；新文件保留 `mode: 0o600`，不调用 ACL 修改命令 |
| 本地文件权限 | `state/`、`config.json` 及其临时文件 | Windows 新建文件沿用父目录权限，桥接不自动检查、收紧或恢复 ACL，也不请求管理员提权。支持 POSIX 文件模式的平台继续对相应新文件使用 `0600`；现有目录权限由用户和操作系统管理 |
| 令牌与敏感参数不回显 | 日志/活动/工具/诊断日志 | 控制台令牌只打前 6 位；活动日志与工具调用参数过 `redactSensitiveText` / `redactSensitive`（递归处理 JSON 字符串叶子，跳过 `__proto__` / `constructor` / `prototype` 并使用无原型对象）。工具图片诊断不保存图片字节、成功正文或附件路径，记忆工具错误正文省略，data URI 与长编码串过滤 |
| 令牌只发回环 | `dsh-client.ensureAuth()` | DSH launch token 换 Cookie 时必须放进 URL，因此**默认拒绝非回环 baseUrl**；远程部署需显式 `dsh.allowRemote: true`。旧接口回退仅限已确认的未导出错误，鉴权和服务错误不得静默降级 |
| 路径校验（读点） | `plugins/qq-agent-presets/lib/index.js` 人格卡 provider | DSH 每次组装 system prompt 时验证人格名格式，并用 `realpath` 确认卡片文件仍位于 `roles/` 目录内；`state/current-role.json` 是本地可编辑状态文件，不作为路径信任边界 |

### 6. 现有文件权限与测试目录

旧版桥接会主动切断 `state/` 与 `config.json` 的 ACL 继承，并在失败时提权重试。这套自动收紧策略已于 2026-11-16 移除，相关启动步骤、配置写入门槛、控制台告警和命令入口均不再提供。

更新不会主动重置现存文件或目录的 ACL，也不会恢复继承。旧版留下的权限或用户手动设置的权限仍然有效；后续在 Windows 新建或原子替换的文件沿用父目录权限。DSH 沙箱能否读写仍取决于实际文件权限与 DSH 自身设置，桥接不修改外部程序的权限策略。

测试夹具、探针和 self-test 继续把临时产物放在系统临时目录，避免混入生产 `state/`，而不是依赖桥接主动收紧目录来隔离。共享机器上的本地文件与备份权限由使用者管理。

### 7. 网络（`src/safe-fetch.js`）

`src/safe-fetch.js`（暴露给桥接侧只读联网与受限媒体下载）：

- 只允许 `http` / `https`；拒绝 URL 内嵌凭据；拒绝 `file:` / `gopher:` 等 scheme
- 解析出的**每一个** DNS 结果都要过私有地址判定（含 IPv4-mapped IPv6、NAT64、6to4、ULA、link-local、zone-id、十进制/八进制/十六进制 IPv4）
- **连接到已校验的 IP**，同时保留原 `Host` 与 TLS SNI ⇒ 关闭 DNS rebinding 的检查-连接间隙
- 每一跳重定向都重新校验，最多 5 跳，重定向响应体立即销毁
- 响应体大小与图片像素上限；图片按 magic number 校验
- 不读取任何代理环境变量（不存在 `HTTP_PROXY` 绕过）

---

## 三、已知残余风险（明确不修 / 修不了，必须让用户知道）

| # | 风险 | 现状与缓解 | 为什么不修 |
| --- | --- | --- | --- |
| R1 | **敏感信息审计是启发式的** | 能抓“带赋值关系的凭据”和本机路径；抓不到任意形态的秘密 | 通用秘密检测无法在没有密钥的情况下做对；硬边界在白名单与工具面，审计是兜底 |
| R2 | **本地配置与 `state/` 里的令牌是明文** | Windows 使用实际父目录权限，不再自动收紧 ACL；支持 POSIX 文件模式的平台继续对相应新文件使用 `0600` | 自动 ACL 策略已按用户要求移除；凭据库/DPAPI 尚未覆盖通用配置，如未来提出该需求应单独评估恢复流程 |
| R3 | **远程停止不是原子的** | 清空待处理队列后请求取消当前回合，已执行的工具副作用无法回滚 | DSH 协议没有事务语义 |
| R4 | **内存待投递提醒队列在关闭后由提醒库恢复** | 未发出 DSH 的内存提醒队列与已读 `seq → messageId` 映射在进程退出后清空；各账号待阅读提醒的位置、投递进度与确认状态持久保存在 `state/ntqq-reminders-<account>.sqlite`，重连及启动时按原生水位恢复 | 聊天正文、媒体与好友历史始终按需直读桌面 QQ 原库，不额外落盘复制正文 |
| R5 | **预设提示词警告是非阻断的** | 固定前缀模块允许管理员自由编辑或关闭，缺少关键变量时仅提醒 | 能改 preset 的人本来就是本机管理员，真正的硬边界在工具守卫（`qq-tool-restrict.mjs`）与桥接路由白名单 |
| R6 | **`self-test.js` 只证明链路通** | 不做安全断言 | 它是连通性探针，不是回归套件（离线回归由 `node scripts/test-audit.mjs` 运行） |
| R7 | **单人维护、无外部安全审计** | 有 50 个脚本的离线回归套件 + 本文档 + 隐私扫描 | 目前没有已安排的外部/对抗式复审日期 |
| R8 | **现有文件可能保留旧版或手动设置的 ACL**（见 §2.6） | 自动收紧已移除，但更新不重置磁盘权限；写入失败仍按正常文件系统错误报告 | 自动恢复继承会改变用户既有授权，因此不随代码更新执行 |

---

## 四、发布前必须跑的检查（回归清单）

```bash
node scripts/test-audit.mjs                 # 纯 mock/fixture 离线回归（50 个脚本），必须全绿
node --check src/bridge.js                  # 语法门禁（大文件改动后必跑）
node scripts/build-agent-preset-patches.mjs --check # preset 权威源与 bundle patch 一致性检查
node scripts/privacy-scan.mjs --tracked-only # 发布前隐私与敏感信息扫描
npm run verify:dsh                          # 有副作用：创建真实会话并调用模型，仅在获准实测时执行
npm run verify:persona                      # 人格配置 schema 校验；需 DSH_INSTALL_MODULES 指向可解析的 DSH node_modules
npm run scan:tool-names                     # 对比可扫描的 DSH 模块目录中的工具注册表
```

安全专项必须覆盖（缺一不可）：

- [x] 注意信号包括私聊、原生 @、已验证回复、当前人格卡名称、配置关键词及发给当前账号的 QQ 戳一戳功能事件；入站 QQ 好友申请与邀请加群事件同样只推送不含验证留言、群名称与昵称的元数据提醒（受提醒总开关与私聊开关控制）；六类各有开关，新事件只携带元数据，正文/申请与邀请详情按需读取。戳一戳按结构化事件及参与者账号识别，不使用可定制文案，自己发出或发给其他账号的事件不唤醒。
- [x] 唯一 `desktop-agent` preset 不可用时拒绝创建全局会话（不回退到默认预设）
- [x] agent token 无法访问任何管理端点；空 agent token 被拒；QQ 路由同时核对当前 `desktop-agent` session ID 绑定
- [x] MCP manager 管理接口仅允许控制台显式操作 `qq` / `qq-memory`，刷新不探测/重启；错误、超时、换端点和未纳管不自动重试动作（`test-dsh-mcp-management.mjs` / `test-dsh-mcp-routes.mjs`）
- [x] 控制台伪造 `Host` 被拒；错令牌（含错长度、大小写、尾空格）被拒
- [x] 全局 `desktop-agent` 令牌可读写任意格式有效的 QQ key
- [x] 出站文本命中敏感信息时整条拦截；含已知会话令牌时直接抛错
- [x] SSRF：scheme、URL 凭据、私有 IP、重定向、超时、大小限制（11 项）
- [x] 桥接 `200 + {ok:false}` 会被 MCP 当作失败上报（不产生静默假成功）
- [x] bridge API 发送校验全局会话令牌、会话绑定、内容检查和审计，不受 `agent_rest` 生命周期限制
- [x] WebUI 全量记忆浏览 HTTP 路由：控制台令牌可到达只读适配器，desktop-agent token 默认 403（`test-audit-bridge.mjs`）
- [x] Python SQLite 记忆读取器：临时 fixture 覆盖分页、来源/时间/关键词筛选、LIKE 转义、storage key 越界拒绝，且读取前后数据库摘要不变（`test-a-memorix-readonly.mjs`）
- [x] 启动和配置保存不调用 ACL 修改或管理员提权；不再提供目录权限告警、重试接口及 ACL 命令入口，`start.bat` 通过纯 ASCII + CRLF 与启动接线检查（`test-audit-setup-guards.mjs`）

---

## 五、改动检查单（每个 PR 自问）

1. 这次改动有没有让某个“不确定”变成“放行”？（违反 fail-closed 即阻断）
2. 有没有新增一个**只有控制台该用**的端点却没进 agent 白名单的默认拒绝？
3. 有没有新增读写文件的路径参数？它是否做了包含性校验与 `realpath`？
4. 有没有把外部数据（QQ 内容、文件名、配置值）直接插进 HTML / 日志 / 提示词？
5. 新增的定时器、Map/Set、监听器，在会话退役与进程退出路径上都清理了吗？
6. 是否更新了对应的测试与本文档？
