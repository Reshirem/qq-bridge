# 安全基线与威胁模型（qq-bridge）

> 本文把项目里**已经实现的**安全边界、**已知的**残余风险、以及**每次发布必须回归**的
> 检查项集中到一处。与之配套的承诺性文档是 [../../RULES.md](../../RULES.md)（面向使用者的
> 权限说明）；本文偏工程实现，供改动代码前后对照。
>
> 维护规则：任何改动如果改变了下面任一条目，**必须在同一个 PR 里更新本文**。
>
> 当前只有一个全局 `desktop-agent`。桥接缓存 QQ 消息，只把私聊、原生 @、验证回复/引用及配置关键词作为元数据提醒。WebUI 可启动、提交任务或持久停止。每个活动回合应以 `agent_rest` 收尾；它结束当前模型回合，但不限制后续工具调用。用户在 DSH 对话中发消息、有效 QQ 提醒或 WebUI 任务可提前结束休息并唤醒一轮，休息期间异常回合的指数恢复重试暂停。未调用休息工具的回合按指数退避恢复，最高间隔 30 分钟；WebUI 停止态不自动恢复自动调度。全局主体可使用本项目当前完整 QQ MCP 工具集及 `dsh-computer-use-win`，其令牌可访问任意合法 QQ 会话 key。桥接 API 发送执行内容检查和审计；GUI 操作不经过这些 API 检查。逐 QQ DSH 映射、令牌与控制入口已移除。

---

独立 QQ 通道沿用相同的桥接鉴权、来源检查和出站审计。桥接与 QQ 使用每次启动新建的本机命名管道和随机握手凭证。数据库连接只读，原生 64 位消息 ID 以字符串传递。选择 SnowLuma 时独立组件不会启动。[QQ 接入方案](NTQQ_ATTENTION.md)

## 一、威胁模型（我们要防谁、防什么）

| 威胁主体 | 能力假设 | 我们不防的 |
| --- | --- | --- |
| **QQ 群友 / 陌生人** | 能给机器人发任意文本、图片、表情、拍一拍；能尝试提示注入 | 他们能看到的公开信息 |
| **被注入的模型** | 会尝试调用任意工具名、传任意参数、尝试外发本机内容 | —— |
| **本机其他用户** | 能登录同一台机器，能读文件系统 | 已取得管理员/root 的主体 |
| **本机其他进程 / 浏览器页面** | 能访问 `127.0.0.1`，能构造任意 HTTP 请求 | 已能读写本项目 `state/` 的主体 |
| **DSH 侧 desktop-agent** | 由 WebUI 自主探索/任务动作、用户在 DSH 对话中的直接消息或 QQ 元数据提醒启动；每轮以 `agent_rest` 收尾；直接 DSH 消息和有效 QQ 提醒可提前结束休息，异常恢复重试不会在休息期间触发 | 对任意 UI 动作的应用级授权；GUI 操作不经桥接 API 审计 |

**不在此模型的范围内**：QQ 账号本身被盗、SnowLuma 网关被攻陷、DSH 本体漏洞、
操作系统级攻击者。这些情况下本项目无法提供额外保护，README 中已声明。

---

## 二、已实现的边界（按攻击面）

### 1. 准入（谁能触发 agent）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 管理端目标白名单 | `src/bridge.js` `allowed()` | 控制台直接操作 QQ 目标时使用 allow/deny 配置；全局 desktop-agent 的合法 QQ key 不受该列表限制 |
| 全局会话授权 | `isDesktopAgentToken()` / `agentTokenOk()` | MCP 从 `state/desktop-agent.json` 自动读取并附加桥接内部凭证，模型无需传递；不检查调用方 DSH session，桥接将凭证与全局自主运行时状态比对；QQ key 仍须匹配 `^(group\|private):\d+$` |
| 唤醒与可见性 | `src/autonomy-policy.js` + `handleIncoming()` | 私聊、原生 @ 机器人、已验证回复/引用和 `socialV2.attentionKeywords` 只发元数据提醒。普通群消息可按来源查历史；正文由全局 agent 主动读，无周期模型心跳 |
| 全局生命周期 | `state/desktop-agent.json` + `agent_rest` + WebUI stop | `active` 回合最后调用 `agent_rest` 后休息 1 至 5 分钟；用户在 DSH 对话中发消息、WebUI 提交任务或有效 QQ 提醒可提前结束休息。未休息的回合按 1、2、4、8、16 分钟退避，随后最长每 30 分钟恢复尝试；该重试不会在休息期间运行。WebUI Stop 取消当前/排队 DSH 工作并持久关闭自动恢复；只有 WebUI 手动启动/提交任务清除停止态 |
| 配置失败 | `loadConfig()` | `config.json` 缺失/解析失败 → **fail-fast 退出**（不是"用默认值继续跑"） |
| QQ 关系对象标记 | `handleIncoming()`、`appendSocialV2Message()` | 消息发送者 ID 取 `event.user_id`，缺失时回退 `event.sender.user_id`；仅当 `ownerQQ` 已配置且发送者 QQ 号相同才标记为 owner。显示名称不参与身份判断；关系称谓由人格卡及双方表达决定。该账号仅被授权通过纯文本私聊 `/睡觉` 和 `/起床` 控制睡眠，不授予其他管理权限；群消息和引用、转发等非纯文本消息不触发命令。身份依赖当前 QQ 后端提供的事件数据。 |
| QQ 工具会话与凭证 | agent API 集中入口、`mcp-qq.js` | 数字角色可访问账号中的 QQ 会话，不按提醒来源或 owner 身份限制；桥接校验内部凭证和当前 DSH 会话绑定，管理接口仅控制台可用。发送仍执行内容检查和审计。 |

独立通道按账号保存提醒位置，SnowLuma 通道每个来源保留最多 500 条未读。获授权的角色读取请求完成响应后，桥接按本次未读页、单条详情或历史页实际返回的来信逐条确认。历史通过所选后端按群或好友查询，按该来源的有效 QQ 消息 ID 匹配。跳过的未读、读取期间新到且未返回的来信、管理端预览和后台学习均保留原未读状态。媒体回查必须匹配返回的 QQ 消息 ID。SQLite 缓存的序号、未读和来源元数据同事务保存，导入旧 JSON 成功后才移除旧文件。等待消息工具及其 HTTP 路由已移除。

### 2. 工具面（agent 能做什么）

后台黑话/表情学习明确允许在主角色未读取消息时分析有界的新消息批次。这是独立的 headless 进程，不能向主角色注入任务或向 QQ 发消息。`learning-tool-guard.mjs` 在执行前仅放行本批图片工具；通用执行、文件、联网、插件管理与子代理工具同时在临时 patch 中禁用。最终 JSON 只作为数据处理，证据须来自本批且黑话须在所引用的原文出现；匹配仅归一化大小写、Unicode NFKC 与空白，证据原文不改写，不以同义改写或模板替代原词。图片编号须来自本批桥接准备的清单。含义和表情分类仍可能被模型误判，管理端可以确认或拒绝。

学习管理端 `/api/learning/*` 与 `/api/slang*` 受现有控制台鉴权、Host/Origin 和请求体限制保护，agent 默认拒绝白名单不扩张。`/api/socialV2/slang-query` 复用内部 token 与全局 session 绑定。新知识读取按目标来源和管理员明确指定的 global 筛选；这不改变全局会话上下文本身共享的残余风险。本地表情只读哈希命名的 `state/learned-stickers/` 文件，校验真实路径和 SHA-256，并在发送排队结束后重新检查来源与状态；没有开放任意文件发送。完整数据和资源上限见 [CHAT_LEARNING.md](CHAT_LEARNING.md)。

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 预设工具守卫 | `plugins/qq-agent-presets/qq-tool-restrict.mjs`（唯一权威实现） | 唯一 `desktop-agent` 开放 computer-use、完整 `mcp__qq__*` QQ 工具 与 `mcp__qq-memory__*` 记忆工具，以及 DSH 原生 `web_search` / `web_fetch`；是否注册网页工具由 DSH `tool-web` 配置控制。QQ MCP 调用在 `tools/pre-execute` 中核对 `exec.agent.id` 是否等于桥接当前 `desktop-agent` session id，缺少/不匹配时拒绝。`ask_user_question` / `todo_write` 不由 preset 挂载且不在工具白名单中；shell、通用文件、子代理和 Harness 管理工具仍被拒绝。 |
| 独立记忆整理工具面 | `memoryOrganizerPatchText()` / `runMemoryOrganizerHeadless()` | 整理输入视为不可信资料；每次 headless 启动用临时 patch 关闭 shell、PowerShell、通用文件、网页、workflow、子代理等 DSH 工具，只留下本次注册的记忆 MCP 工具。若当前模型 provider 只在 Desktop profile 配置，patch 只复制该 provider 和所选模型；需要 `apiKeyEnv` 时在该子进程启用 DSH 本地凭据解析器，密钥值不写入 patch 或日志。不修改 DSH profile 或默认模型。 |
| DSH 网页工具配置 | `dsh/agent-presets/desktop-agent/agent.cordis.yml` 的 `tool-web` 行 | `desktop-agent` 加载 DSH `@deepseek-ai/dsh-tool-web` 并沿用其默认配置，默认启用搜索和抓取。工具通过 DSH 选择的提供方访问网络，不经过桥接 `safeFetch`；`http` 抓取提供方允许访问本机和内网地址。 |
| 预设 fail-closed | `ensureDesktopAgentSession()` | `desktop-agent` 不可用时拒绝创建全局会话，不回退到 DSH 默认 preset |
| 发送强制授权 | 所有 `/api/send/*`、`/api/socialV2/send-*` | MCP 自动携带全局 agent 令牌；不要求当前 DSH 回合处于 active。所有 bridge API 发送仍受会话授权、敏感内容检查和工具调用审计 |
| 动态 ACL | sticker / image media helpers | 贴纸只能发 QQ 收藏库或当前来源可用的本地学习表情；学习表情校验专用目录 realpath 与内容哈希。其他图片只能读 SnowLuma home 内的本地文件（realpath 复核防符号链接逃逸） |
| **只探测、不部署** | `mcp-qq.js` | `qq_status` 查询桥接选定的 QQ 通道和登录状态。SnowLuma EULA §5.4 要求将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署时事先取得书面授权；原生组件属专有组件。本程序不安装、不复制、不打包或程序化启停 SnowLuma；用户自行安装与启动。边界见 `LICENSE` 与根目录 `RULES.md` |

### 2.1 桌面应用范围（提示词边界）

`desktop-agent` 的会话提示要求：使用 computer-use 操作电脑时，ChatGPT、DeepSeek Harness、qq-bridge 和 SnowLuma 的 GUI 在无关任务中属于受保护界面，不读取或改动其中内容、设置、会话或运行控制；挡住目标应用时，仅在用户未使用该窗口的前提下允许最小化。数字角色可按需观察用户的电脑活动。电脑操作插件支持部分后台操作和由用户通过 Esc 停止桌面操作，但普通鼠标移动或按键不会自动停止工具。该界面规则不禁用 QQ MCP 等已有非 GUI 工具，它们仍受现有 QQ 自主运行规则约束。

这是模型行为规则，不是 computer-use 服务端的应用级访问控制。当前工具守卫不按窗口标题或应用名拦截操作；用户明确提出涉及这些应用的任务时，仍由会话提示限定到所请求的范围。

固定前缀要求数字角色区分 QQ 聊天场合：当前场合的普通交流可正常参与；其他群/私聊的对话、人物、观点、关系、群内梗和个人经历不主动带入，也不因第三方请求而复述、概括或确认。来源特定信息在上下文或记忆中出现时仍受边界约束；同一当事人问起自己先前私聊的内容时可按当前问题所需自然回应。提示词用情形示例支持模型判断，不规定固定回复。这是模型行为引导；群聊、私聊和记忆仍共享全局会话上下文，并无程序级会话隔离或内容过滤。

### 3. 出站内容（模型能说什么、能发什么）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 敏感信息拦截 | 发送 API 中的 `SENSITIVE_RE` 检查 | 消息含本机路径、UNC 或凭据赋值形态时拦截，不发送；控制台测试发送也执行检查 |
| 会话令牌防外发 | `redactKnownTokensOnly()` + `onebotSend()` | 所有已知 agent token 在发送前脱敏；文本里若仍出现已知令牌则**直接抛错不发** |
| CQ 注入 | `onebotSend()` | 出站文本一律包成 `{type:'text'}` 段并做 `[CQ:` → `[CQ：` 转义，杜绝 CQ 码注入 |
| @ 限制 | `onebotSend()` | `atUserId` 只接受正整数，禁止 `@all` |
| 分条与收藏 | `socialV2.send` / `sticker.collect` | 限制一次调用的气泡数。消息发送不设每分钟、每小时或单条字数配额。收藏 QQ 表情另有频率限制。 |

### 4. 控制台（本机最高权限入口）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 只监听回环 | `server.listen(port, '127.0.0.1')` | 永不绑 `0.0.0.0` |
| 令牌门 | 请求最前面 | 管理业务 API 都要 `x-console-token` 或登录后设置的 HttpOnly `qq_bridge_console` Cookie；登录通过 `POST /api/console/login` 的 JSON token 校验，根路径可返回登录页，favicon/触摸图标免鉴权返回 204。URL 查询参数不参与鉴权，`/?token=...` 会被拒绝；未配置时启动自动生成 192 bit 随机值 |
| 定长比较 | `crypto.timingSafeEqual` | 比较前先比长度，避免 `!==` 短路带来的时延侧信道 |
| Host 校验 | 请求最前面 | Host 必须是 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，否则 403（DNS rebinding 硬化） |
| CSRF | 非 GET 请求 | 必须 `content-type: application/json`；若带 `Origin`，其 host 必须等于本机 |
| agent 令牌隔离 | 请求前缀白名单 | 带 `x-agent-token` 的请求默认拒绝，仅放行 `/api/status`、`/api/desktop-agent/rest`、`/api/desktop-agent/memory/*`、`/api/socialV2/*`、`/api/send/*`、`/api/images/*`；其它管理端点一律 403。`active`、`resting`、`recovering` 和 `stopped` 生命周期状态不控制白名单工具是否可调用；每个端点仍执行自身的参数校验和内容检查和工具审计。 |
| 空令牌拒绝 | `x-agent-token === ''` | 一律 403，避免"空 = 管理端"的绕过 |
| 写操作不挂 GET | 全路由审查 | 会触发副作用的接口（如表情强制同步）一律 POST；GET 只读 |
| WebUI 会话管理 | `/api/console/desktop-agent` | 仅控制台令牌可查看状态、启动或提交任务；同一全局会话也接收 QQ 元数据注意信号。 |
| WebUI 关系对象设置 | `/api/whitelist` | 仅控制台令牌可设置或清除 `ownerQQ`；首次保存后由本地配置优先，忽略 DSH 的同名设置。更改账号时，已缓存消息的身份标记按当前账号重新计算；QQ 工具访问范围不受影响。测试发送名单独立保存，仍只限制控制台测试发送。 |
| WebUI 桌面 agent | `/api/console/desktop-agent` | 仅控制台令牌可查看状态/提交任务；GET 不启动回合；WebUI 手动任务可恢复停止/休息状态，用户在 DSH 对话中的直接消息和 QQ 注意信号可提前结束休息但不能解除持久停止态；所有入口复用单一 `desktop-agent` session。QQ MCP 在内部附加持久全局 agent token；computer-use 的 QQ GUI 操作不经过桥接 `/api/send/*` 或 `/api/socialV2/send-*` 守卫。 |
| WebUI 持久停止 | `/api/console/desktop-agent/stop` | 仅控制台令牌可调用；先持久化 `stopped` 并清除休息/恢复定时器，再尝试取消当前和排队的 DSH 工作。DSH 暂不可用时停止态仍保存，恢复连接后不会自动唤醒。 |
| QQ 持久睡眠 | `handleIncoming()`、`sleepDesktopAgent()` | 只有配置账号的私聊纯文本命令可进入或结束；进入时保存 `sleeping`、清除待处理提醒并尝试取消 DSH 工作，消息继续缓冲但不生成提醒。桥接重启和 DSH 重连后保持睡眠；恢复后不补发睡眠期间的提醒。DSH 外部直接发起的回合在事件到达后请求取消，并非 DSH 层的入口拦截。 |
| WebUI 长期记忆设置 | `/api/memory/settings`、`/api/memory/providers`、`/api/memory/service` | 仅控制台令牌可配置或启停本机服务；状态接口只返回密钥是否已设置，不回显密钥。Provider 密钥只写入 `state/a-memorix/secrets/`，TOML 中仅保存密钥文件路径；Provider 保存后重启 A_Memorix。 |
| 模型主动休息 | `/api/desktop-agent/rest` | MCP 自动附加当前全局 agent token；调用会保存定时休息状态，并在返回工具结果后取消当前 DSH turn。该状态不限制后续工具调用；休息到期只发起一次恢复回合。 |
| 记忆工具 | `/api/desktop-agent/memory/*` | 校验全局 agent token，并固定访问 `config.json` 中的 A_Memorix namespace，不受 `agent_rest` 生命周期限制。参数正文与检索词不写入工具参数日志。 |
| 记忆管理 | `/api/memory/*` | 受控制台令牌保护；用于 WebUI 搜索、查看、保存、替代和删除。A_Memorix namespace API key 留在桥接本地配置，不返回给页面或 DSH。 |
| 记忆全量浏览 | `POST /api/memory/records/list` | 受控制台令牌与 JSON/Origin 校验保护；带 `x-agent-token` 时因默认拒绝白名单而返回 403。仅读取配置 namespace 的 `paragraphs` 表，校验 storage key 路径与必需列，使用 SQLite `mode=ro` + `query_only` 和参数化查询；不读向量/图存储，不写数据库。 |
| 记忆开场摘要 | `submitDesktopAgentPrompt()` | 只在新/重建会话首次提示查询 `assistant` 来源；QQ 来源不自动注入。检索失败不阻止提示提交。 |
| 请求体限制 | `readBody()` | 声明长度或实际累计超过 1 MB → 413；30 秒读取超时 |
| 安全响应头 | 全部响应 | `X-Frame-Options: DENY`、CSP、`nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store` |

### 5. 秘密与落盘

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 原子写 | `atomicWriteJson/Text()` | 唯一随机临时名 + rename（Windows EPERM 退避重试），不会写坏配置 |
| 敏感配置替换 | `atomicWriteConfigJson()` | 先创建空临时文件并收紧 ACL，再写入内容后原子替换 `config.json`，避免临时副本继承仓库根目录宽松权限 |
| Windows ACL 收紧 | `hardenStateDirAcl()` + `scripts/harden-state-acl.mjs` | Windows 上 `mode: 0o600` 是**空操作**，因此启动时切断 `state/` 的继承链，只保留当前用户/SYSTEM/Administrators。改 ACL 需要 WRITE_DAC —— **目录属主通常本来就有，所以一般不弹 UAC**；失败时用 `Start-Process -Verb RunAs` 提权重试一次（`--elevated` 短路自身，杜绝递归），再失败就打印可复制命令并**以 0 退出、绝不阻断启动**。控制台「系统运维 → 访问设置」页显示告警条与「重新检测」按钮 |
| 令牌不回显 | 日志/活动/工具日志 | 控制台令牌只打前 6 位；活动日志与工具调用参数过 `redactSensitiveText` / `redactSensitive`（递归处理 JSON 字符串叶子） |
| 令牌只发回环 | `dsh-client.ensureAuth()` | DSH launch token 换 Cookie 时必须放进 URL，因此**默认拒绝非回环 baseUrl**；远程部署需显式 `dsh.allowRemote: true` |
| 路径校验（读点） | `plugins/qq-agent-presets/lib/index.js` 的人格卡 provider | DSH 每次组装 system prompt 时验证人格名格式，并用 `realpath` 确认卡片文件仍位于 `roles/` 目录内；`state/current-role.json` 是本地可编辑状态文件，不能作为路径信任边界 |
| 原型污染 | audit-log redaction | 日志脱敏跳过 `__proto__` / `constructor` / `prototype` 键，并使用无原型对象 |

### 6. 与 DSH 沙箱的 ACL 交互

DSH 的 Windows 文件沙箱按**能力 SID** 授权：SID 由 `sha256(规范化工作区路径)` 派生
（形如 `S-1-4-<a>-<b>`；同一个工作区路径每次会话派生出同一个 SID，**重命名工作区会换一个**），
沙箱进程跑在 `WRITE_RESTRICTED` + Low 完整性的令牌里，**写权限要靠工作区根上那条
可继承 ACE 沿继承链传下来**。DSH 只在首次进入工作区时下发一次
（之后有 exact-ACE 跳过，不会重新下发），也从不修改任何对象的保护标志。

由此产生一条必须知道的交互：

| 事实 | 后果 |
| --- | --- |
| `harden-state-acl.mjs` 用 `/inheritance:r` 切断 `state/` 与 `config.json` 的继承链 | 这两处的 DACL 里**没有**能力 SID ⇒ **DSH 沙箱会话写不进去**（EPERM / Access denied），而无沙箱终端完全正常 |
| 这是收紧凭据的**唯一手段**（Windows 上 `mode 0o600` 是空操作） | 取舍明确：**保住凭据不外泄** > 沙箱内可写 |

因此本项目的规矩是：**任何从沙箱里跑的东西都不得写 `state/`**。
测试夹具、探针、self-test 的临时产物一律落在系统临时目录
（见 `scripts/probe-auth.mjs` 的 `probeWorkspaceDir`）。

诊断：`npm run diagnose:acl` —— 只读扫描，列出全部被切断继承的路径并分成
「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类。

> ⛔ **绝不要用 `/inheritance:e` 去"修好" `state/` 的沙箱写入**：恢复继承会把父目录的
> 可继承 ACE 一起带回来，其中包含 `NT AUTHORITY\Authenticated Users: Modify` 与
> `BUILTIN\Users: ReadAndExecute` —— 那正是收紧时要摘掉的两条，等于把控制台令牌、
> SnowLuma OneBot 令牌与全部 QQ 聊天记录重新开放给本机任何已登录用户。

> ⚠️ 已知的**非预期**收紧（2026-09-29 实测）：`plugins/qq-agent-presets/**` 的内容
> 也被切断了继承（`plugins/` 自身没有）。
> **本仓库没有任何脚本这么做**，来源不明（手工 icacls 或仓库外工具）。
> 它的副作用是沙箱会话里改不动 L7 守卫（`qq-tool-restrict.mjs`）。
> 这两处不含凭据，恢复继承不涉及泄密风险 —— 是否恢复由使用者决定（`npm run diagnose:acl`
> 会打印命令）。`state/` 不在此列。

### 7. 网络

`src/safe-fetch.js`（仅暴露给 agent 的只读联网）：

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
| R1 | **敏感信息审计是启发式的** | 能抓"带赋值关系的凭据"和本机路径；抓不到任意形态的秘密 | 通用秘密检测无法在没有密钥的情况下做对；硬边界在白名单与工具面，审计是兜底 |
| R2 | **`state/` 里的令牌是明文** | Windows 已用 ACL 收紧；Linux 用 `0700` | 凭据库/DPAPI 尚未实现；如未来提出该需求，应单独评估部署复杂度和恢复流程 |
| R3 | **远程停止不是原子的** | 清空待处理队列后请求取消当前回合，已执行的工具副作用无法回滚 | DSH 协议没有事务语义 |
| R4 | **离线队列不保证送达** | 每会话最多 50 条，进程退出即丢 | 一致性代价过高；README 已写明 |
| R5 | **预设不变量检查是子串存在性** | 防误删，不防恶意 | 能改这个文件的人本来就是管理员，真正的硬边界在工具守卫与白名单 |
| R6 | **`self-test.js` 只证明链路通** | 不做断言 | 它是连通性探针，不是回归套件（离线回归由 `node scripts/test-audit.mjs` 运行） |
| R7 | **单人维护、无外部安全审计** | 有离线回归 + 本文档 | 目前没有已安排的外部/对抗式复审日期 |
| R8 | **`state/` 的 ACL 收紧可能失败**（未提权且目录属主权限被策略收走时） | `scripts/harden-state-acl.mjs` 会自动提权重试一次；仍失败则明确告警 + 给出可复制命令 + 控制台告警条 | 改 ACL 属于需要特权的操作；**降级为"明确告警"而不是"阻断启动"**是刻意的取舍（否则用户会为了能启动而关掉整条安全链路） |
| R9 | **收紧 `state/` 后，DSH 沙箱会话写不进 `state/`**（见 §2.6） | 有意取舍，非缺陷；诊断见 `npm run diagnose:acl` | 两者不可兼得：能力 SID 只能靠继承下发，而切断继承正是防"本机其他用户读令牌"的唯一手段。**代价已被接受并写进文档**，项目自己的测试夹具/探针据此改用系统临时目录 |
| R10 | **`plugins/**` 内容被意外切断继承，沙箱里改不动 L7 守卫** | 来源不明（本仓库无此脚本）；`npm run diagnose:acl` 会列出并打印恢复命令 | 该处不含凭据，恢复继承无泄密风险；但若不恢复，被沙箱约束的 DSH agent 就无法维护工具守卫 —— 需要人工在无沙箱终端改 |

---

## 四、发布前必须跑的检查（回归清单）

```bash
node scripts/test-audit.mjs # 纯 mock/fixture 离线回归，必须全绿
npm run verify:dsh          # DSH 当前 preset/工具守卫/MCP 挂载与在线 API
npm run verify:persona      # 人格配置一致性；需 DSH_INSTALL_MODULES 指向可解析的 DSH node_modules（桌面版 app.asar 暂不支持）
npm run diagnose:acl        # ACL 收紧路径盘点（只读；需在**无沙箱**终端跑，见 §2.6）
npm run scan:tool-names     # 对比可扫描的 DSH 模块目录；当前只支持独立 node_modules，不支持桌面版 app.asar
node --check src/bridge.js  # 语法门禁（大文件改动后必跑）
```

安全专项必须覆盖（缺一不可）：

- [x] 注意信号只包括私聊、原生 @、已验证回复和配置关键词；新事件携带元数据，未展示消息继续留在桥接缓冲
- [x] 唯一 `desktop-agent` preset 不可用时拒绝创建全局会话（不回退到默认预设）
- [x] agent token 无法访问任何管理端点；空 agent token 被拒
- [x] 控制台伪造 `Host` 被拒；错令牌（含错长度、大小写、尾空格）被拒
- [x] 全局 desktop-agent 令牌可读写任意格式有效的 QQ key
- [x] 出站文本命中敏感信息时整条拦截；含已知会话令牌时直接抛错
- [x] SSRF：scheme、URL 凭据、私有 IP、重定向、超时、大小限制（11 项）
- [x] 桥接 `200 + {ok:false}` 会被 MCP 当作失败上报（不产生静默假成功）
- [x] bridge API 发送校验全局会话令牌、内容检查和审计，不受 `agent_rest` 生命周期限制
- [x] WebUI 全量记忆浏览 HTTP 路由：控制台令牌可到达只读适配器，desktop-agent token 默认 403（`test-audit-bridge.mjs`）
- [x] Python SQLite 记忆读取器：临时 fixture 覆盖分页、来源/时间/关键词筛选、LIKE 转义、storage key 越界拒绝，且读取前后数据库摘要不变（`test-a-memorix-readonly.mjs`）
- [ ] A_Memorix 实际安装版本与生产 namespace 的 schema/Gateway 联调；fixture 只覆盖当前读取器要求的列和关系表形态
- [x] `state/` ACL 助手：非阻断、防递归、`start.bat` 纯 ASCII+CRLF 且先于桥接调用（**结构级断言**）
- [ ] **`state/` ACL 的真实 icacls/UAC 行为**：需在普通终端手动复跑 `node scripts/harden-state-acl.mjs` 确认（沙箱/CI 里改 ACL 会被拒，无法自动化）

---

## 五、改动检查单（每个 PR 自问）

1. 这次改动有没有让某个"不确定"变成"放行"？（违反 fail-closed 即阻断）
2. 有没有新增一个**只有控制台该用**的端点却没进 agent 白名单的默认拒绝？
3. 有没有新增读写文件的路径参数？它是否做了包含性校验与 realpath？
4. 有没有把外部数据（QQ 内容、文件名、配置值）直接插进 HTML / 日志 / 提示词？
5. 新增的定时器、Map/Set、监听器，在会话退役与进程退出路径上都清理了吗？
6. 是否更新了对应的测试与本文档？

## NTQQ 原生历史读取

独立通道将 QQ 登录账号和主进程 PID 交给常驻读取器，由 Windows 文件句柄确认该进程打开了对应账号的数据库。命令行读取器也根据已打开的数据库识别账号。首次导入的密钥经原库验证，由当前 Windows 用户的 DPAPI 加密保存在 `state/ntqq-reader/keys`。SQLCipher 通过只读 Win32 VFS 访问 QQ 主库、WAL 和已有的共享内存索引。角色和 WebUI 的历史查询复用同一个常驻连接。命令行默认仅输出条数和读取状态，显式指定来源时才打印聊天内容。[安装与验收](NTQQ_ATTENTION.md#新机器安装)

## 桌面 QQ 进程内观察和发送测试

独立模式下，桥接在登录用户权限下通过 Frida 将仓库内的固定运行代码加载到 QQ 主进程，由本机命名管道收发 QQ 事件和工具请求。桥接为每次运行生成管道名称和握手令牌。SnowLuma 模式使用 OneBot。另有按需运行的观察器，可报告账号、收藏标识及来信计数。[诊断工具](NTQQ_SEND.md)

原生 QQ 图片工具仅在会话令牌、来源策略和原消息定位通过后，才会按该消息内匹配的媒体元素 ID 请求 QQ 下载。桥接不接收任意媒体 URL 或本机目标路径；文件路径由 QQ 缓存索引解析，普通图片和图片表情原件还需匹配消息 MD5，输出前继续执行图片格式、字节数和像素限制。商城表情只从 QQ 的固定市场表情缓存目录读取预览图。

独立的发送测试命令在 QQ 核对账号及目标私聊后，可以发送一条固定测试文字或一张经过 MD5 校验的 QQ 收藏原图。每个动作在调用 QQ 之前原子创建本地尝试记录，收到回执后保存结果。日志含私聊标识与消息 ID，位于 Git 忽略的 `state/ntqq-probe/send-tests/`。

## 可选的 Maa-Agent 游戏工具

安装记录位于 `state/maa-agent/install.json`。启用后，角色预设提供 Maa-Agent 原生命令和常用游戏工具。桥接把作业路径和参数传给已安装的 Python 模块，使用 Maa-Agent 的设备锁、关卡核验和任务状态。作业可从索引选择，也可直接使用下载文件的绝对路径。截图由 DSH 附件服务交给模型。禁用后，已经排队的游戏作业由上游 worker 继续管理。

## 表情检索与复检

商城包管理走控制台的 `/api/learning/market-packs` 接口。分享链接只用于解析数字包 ID，桥接根据包 ID 和商城清单中的表情 ID 构造腾讯 CDN 地址。预览和收录沿用现有受限图片读取。角色检索、查看原图、提交修正及发送时分别检查该来源的使用开关，发送队列在交付 QQ 前再次检查。控制台可管理已关闭来源的素材。
整包分析复用后台学习进程的图片工具和权限范围，输入是管理员已收录的整包素材和商城释义。每个分页工具回执和返回的表情序号均由桥接核对，后台模型的输出只用于注解和检索。

记忆工具绑定角色经历空间，表情专用密钥保存在本机 A_Memorix 的 secrets 目录，仅桥接可用。图片和聊天证据不会写入表情索引；只索引描述、情绪、用法和标识。检索结果以当前启用状态和来源再次过滤。角色只能在看过图片后提交有界的修改建议，采纳与忽略均限控制台；QQ 账号收藏的修订只写入本地资料。
