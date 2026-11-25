# 运行架构与渐进式重构

项目托管一个持久的全局 `desktop-agent` DSH 会话，作为可交流、可按需行动的数字角色。这里的“长期”指会话历史和角色设定可以接续；桥接在直接对话、QQ 提醒、WebUI 任务和生命周期恢复等事件后发起模型回合。模型休息时没有周期性心跳或持续观察。WebUI 是主要控制入口；电脑、QQ 和长期记忆是可按需使用的活动空间、渠道与能力。

当前权限约定见 [RULES.md](../../RULES.md)，安装过程见 [DSH_SETUP.md](DSH_SETUP.md)，长期记忆目标与实施边界见 [MEMORY_ARCHITECTURE.md](MEMORY_ARCHITECTURE.md)。

---

## 一、身份、会话生命周期与自主调度

### 1. 身份与项目用词

- **“数字角色”是产品定位用语，不是程序中的身份枚举**：代码只维护一个全局 `desktop-agent` 会话，并按提示词规则处理交流与工具调用。
- **人格卡动态注入**：人格卡是用户维护的 Markdown 自由文本，程序不会解析物种或关系字段。当前选择保存在 `state/current-role.json`，并通过 `qq-agent-presets` 注册的 `{{qq_bridge_active_role_card}}` 在每次 DSH system prompt 组装时动态注入；普通历史压缩不会移除这段固定前缀。卡片定义具体身份、形态、性格、兴趣、关系、行为习惯和表达方式；自然的聊天风格属于表达方式，不会自动把卡片设定的身体、感知或经历改成人类设定。没有选中人格卡时，通用数字角色定位保留物种、外形、身体感知和关系称谓的开放性，不设固定默认关系。
- **`ownerQQ` 账号身份锚点**：`ownerQQ` 只锚定配置的 QQ 账号；每条已处理消息都保留结构化 `userId`，QQ 提醒也带发送者 QQ 号；`isOwner` 是桥接依据账号 ID（`event.user_id` 或 `event.sender.user_id`，且仅针对对方消息）匹配出的消息字段，不定义角色之间的关系称谓。提示身份时以 `userId` / `senderId`、`isOwner` 与配置的 `ownerQQ` 为准，不以昵称或群名片作账号识别。`qq_get_owner_identity` 可读取当前设置或未配置状态供模型比对。`ownerQQ` 首次由 WebUI 保存或清除后，本地值优先于 DSH 同名设置；此前的旧安装继续兼容 DSH 设置。账号改变时，缓存消息的身份标记按当前账号计算；QQ 工具访问范围不受该设置影响。
- **跨场合隐私边界（模型行为约定）**：群聊和私聊共用同一个 DSH 上下文。固定前缀引导数字角色区分聊天场合：当前场合的普通交流可以自然参与；其他群/私聊的对话、人物、观点、关系、群内梗和未公开经历不主动带入，也不因当前场合中的第三方请求而复述、概括或确认。私聊同样遵守来源边界；QQ 好友或好友列表只表示平台联系人关系，不自动表示信任等级、主人身份或信息分享授权。单一来源内持续清楚形成的角色扮演关系可以在该来源内延续，但不代表现实账号身份、跨来源关系或权限；来源内的日常状态或行程描述（如“回到家了”）只说明该发言者在该来源中的自述，不能单独证明其是主人/owner 或与其他来源中的账号对应起来。同一当事人主动提起自己此前私聊说过的事时，需能确认当前发言者与原私聊对象一致，再结合当前问题所需内容自然回应。这是模型行为约定，不是程序级跨群隔离或出站过滤。
- **技术契约命名**：DSH 会话 ID、桌面会话状态和人格卡不会合并成一个身份字段：`desktop-agent` 是 preset ID，`desktopAgent` 是桥接内部名称，`state/desktop-agent.json` 与 `state/current-role.json` 是既有持久文件，`/api/console/desktop-agent` 是管理路由，历史 API 字段 `globalCompanionSource` 继续作为兼容字段（WebUI 展示为数字角色来源）。文档、preset 展示名和 WebUI 统一使用“数字角色”或“全局数字角色会话”；描述运行机制时写“活动回合”“休息”“恢复”，描述工具时写“电脑操作”“QQ 消息渠道”等实际能力。

### 2. 全局会话生命周期与收尾/恢复

- **六个生命周期状态**：全局会话生命周期为 `idle`、`active`、`resting`、`recovering`、`sleeping` 和 `stopped`，与全局会话 ID、内部令牌一起持久化在 `state/desktop-agent.json`（DSH 负责保留会话历史）。
- **自运转待机与可选 `agent_rest` / `qq_agent_rest`**：回合以 `completed` 正常结束且未显式调用 `agent_rest` 时，桥接直接提交已读水位与每日记忆整理并自动隐式进入 `resting`（默认自运转间隔 30 分钟，可通过 `desktopAgent.rest.defaultMs` 配置），不再发送 `missing-rest` 收尾催促回合。角色也可按需主动调用 `agent_rest`（或同义的 `qq_agent_rest`）自定义 1 分钟至 4 小时（`desktopAgent.rest.maxMs` 上限 8 小时）的后台自运转待机时长，到期后以「自由活动时间」附带未读会话简短摘要 `{unreadSummary}`（热群排最前）恢复一轮。显式调用 `/api/desktop-agent/rest` 时若检测到仍有未提交的 P1 强召唤队列或刚送达且模型尚未输出回复的活跃 `steer` 提醒，会返回 `restSkipped: true` 并保持 `active` 立即投递，不取消当前回合。用户在 DSH 对话中直接发消息、提交 WebUI 任务或收到有效 QQ 事件（P1/P2/P3），都可按优先级提前结束普通待机。QQ 等待工具及其静默判断已移除，热群连续性由无阻塞事件热窗驱动。
- **正常隐式待机、5 秒落稳与异常回合恢复**：
  - 回合以 `completed` 正常结束时，若队列已有排队强召唤或待发唤醒原因，桥接在 `turn/end` 确认旧回合彻底停稳后统一等待 **5 秒**（`DESKTOP_ATTENTION_POST_REST_SETTLE_MS`）再提交下一轮 `queue` 唤醒，防止过快提交被 DSH 忽略；否则直接自动进入默认 30 分钟 `resting`。`desktopAgent.promptTemplates.missingRest` 字段仅保留旧配置兼容，运行时不再触发。
  - 中断或运行失败仍走异常恢复指数退避（1、2、4、8、16 分钟递增，最长 30 分钟）。异常退避期间新到的 QQ 提醒留在桥接队列，暂停未读补提醒；若 DSH 已经开始新回合，桥接把等待的提醒提交给该回合的下一步；若到重试时间会话仍空闲，恢复提示会带上排队的 QQ 提醒。
  - **停止/并发投递保护与启动核验**：活动回合内仅 P1 强召唤按 30 秒冷却注入 `mode: 'steer'`，空闲或刚停止唤醒使用 `mode: 'queue'`；`flushDesktopAttentionSignals` 提交前会先等待正在进行的 `agent_rest` `session/cancel` 结束。桥接追踪待确认的活跃 `steer`（`submitting` → `queued` → `delivered`，收到 `assistant/message` 或结束后清理）；若休息收尾触发的 `session/cancel` 把刚送达但尚未响应的 `steer` 中断为 `turn/end (aborted)`，会自动将未读条目重新入队并在 `turn/end` 落稳 5 秒后唤醒新回合。提交提示后若 3 秒内（`DESKTOP_AGENT_START_VERIFY_MS`）既无 DSH 活动事件且 `session.state` 仍显示 `running=false`，桥接会清理滞留在队列中的同 `requestId` 项并自动补发（最多 2 次后转入异常恢复退避）。
  - 提示提交期间到达的回合结束事件，在回执确认后统一处理；较晚的提交回执不能覆盖事件流已经确认的结束状态，避免快速回合漏发后续提醒。桥接重启后重新订阅原主会话；事件流重连时若快照确认前回合已 `completed`，自动进入隐式待机或按 5 秒落稳继续处理排队提醒。
- **WebUI 持久停止（`stopped`）**：WebUI“停止自主运行”会取消当前和排队中的 DSH 工作并持久进入 `stopped`；只有 WebUI 手动启动或提交任务才解除停止态。
- **持久睡眠（`sleeping`）与每日睡眠闹钟**：
  - QQ 仅接受已配置 `ownerQQ` 的纯文本私聊 `/睡觉` 和 `/起床` 控制睡眠（其他聊天不作为管理命令执行）。进入 `sleeping` 时持久保存、取消当前/排队工作并清除已有提醒，禁止 QQ 提醒和普通恢复自动唤醒，消息仍继续缓冲；`/起床` 或已配置的起床闹钟恢复一轮。睡眠期间 DSH 直接启动的回合会被桥接请求取消。
  - `src/sleep-schedule.js` 计算桥接本地时区的每日睡眠/起床事件，不直接访问 DSH。配置 `desktopAgent.sleepSchedule={enabled:false,sleepTime:'',wakeTime:''}` 默认关闭且不预填时间，启用需填写两个不同的 `HH:mm`。控制台通过 `/api/console/desktop-agent/sleep-schedule` 读写完整配置，状态 GET 同时返回时区和下次触发毫秒时间戳。保存相同配置保留游标；开启、更改时间或时区变化从未来事件开始，采用本地日历计算跨午夜及夏令时（重复小时只触发一次）。
  - 调度游标 `sleepScheduleState` 保存在 `state/desktop-agent.json`。运行时最多每分钟做一次本地时钟检查（不产生模型心跳）；重启或长时间停顿只补最近一个过期事件，不重放多天动作。先持久化幂等的睡醒状态再推进游标；手动提前睡醒不改变计划，到点已在目标状态时直接消费。两个定时动作都跳过 `stopped`，关闭定时不解除 `sleeping`。执行互斥、配置代次及唤醒前的生命周期/会话复核防止旧异步动作覆盖后续设置；离线起床保留 `scheduled-wake` 原因并沿用 DSH 恢复流程。

---

## 二、QQ 接入、消息读取与提醒投递

### 1. Windows 桌面 QQ 本地通道

桥接唯一运行在桌面 QQ 本地通道上（详见 [桌面 QQ 通道运行方式](NTQQ_ATTENTION.md)；原 SnowLuma / OneBot 支持已移除）：
- **进程内消息与只读原库（`src/native-qq.js` + `src/native-reminders.js`）**：持有桌面 QQ 原生消息服务（Frida 命名管道）和账号对应的只读 SQLCipher 数据库连接（`scripts/ntqq_reader_service.py` + `ntqq_vfs.dll`），原生提醒库（`state/ntqq-reminders-<account>.sqlite`）按账号隔离保存待阅读提醒的位置与投递/确认水位，不复制聊天正文或好友历史。桌面 QQ 的[进程内诊断与发送测试工具](NTQQ_SEND.md)也可独立运行验证账号、收藏与收发回执。
- **提醒分类与授权边界**：桥接在 `src/autonomy-policy.js` 中对来信做元数据分类，向全局会话提供统一的 `mcp__qq__*` 工具面（`src/mcp-qq.js`），并在 API 层强制执行全局凭证校验、敏感内容拦截与审计。全局数字角色可访问账号中的群聊和私聊，不按提醒来源限制会话；管理接口仅控制台可用，直接通过 QQ 桌面 GUI 发送不经过桥接 API 检查。

### 2. 三层注意信号（强召唤 / 热群跟进 / 冷群低优）与未读补提醒

- **P1 强召唤（六类首次提醒、好友申请与邀请加群事件）**：私聊（`private`）、真正发给机器人的原生 @（`atMention`）、已验证的回复/引用（`reply`）、群消息中提到当前选中的人格卡名称（`roleCardName`）、配置的 `socialV2.attentionKeywords` 命中（`keyword`），以及他人对当前账号的 QQ 戳一戳功能事件（`poke`），会向全局会话发送**不含消息正文**的元数据提醒；入站 QQ 好友申请（`friendRequest`）与邀请加群（`groupInvite`，均受 `socialV2.enabled` 与 `reminders.private` 约束）同样仅推送申请者/群号等元数据，绝不把验证留言、群名称或昵称带入唤醒提示词，而是在独立的内存 queue key（`friendRequest:<userId>` / `groupInvite:<groupId>`）上聚合以避免覆盖普通消息未读提醒。
- **P2 热群跟进（`groupFollowup`）与 P3 冷群低优余光（`groupActivity`）**：
  - **独立热窗（P2）**：只要角色向某个群成功发出了文字（`send-message` / `send-burst`）或表情包（`send-sticker`），桥接即为该群独立开启/续期默认 4 分钟的自然超时热窗（纯内存，互不踢冷，发送私聊或其他群不清空原热群）。热窗内整群发送完成后的任意新消息（不按人拆分）在空闲时经 5 秒起、连发顺延 3 秒、封顶 10 秒的动态防抖后以纯元数据唤醒，**绝不中途 `steer` 打断活动回合**，也不进入 `unreadFollowup` 补提醒。
  - **冷群低优余光（P3）**：不在热窗内的群视为冷群（与消息条数或发言人数无关，本质为低优先级）。冷群出现新未读后先聚合 60 秒；仅在无活动回合、无待发 P1/P2、且当前无任意热群或近期私聊（3 分钟内）活跃，并且距上次查看/触发该冷群已满 20 分钟冷却时，才推送一条纯元数据低优提醒，同样绝不中途 `steer` 或触发补提醒。
  - **全局未读优先级**：`qq_list_conversations` 附带 `hot: true` 并将热群置顶排序；自由活动及非纯私聊唤醒入口附带一行极简元数据未读概况（热群标 `,热`），纯私聊唤醒不附冷群未读；单会话历史/发送接口不夹带其他群未读。
- **独立开关、高频聚合与即时生效**：WebUI「QQ 消息 → 提醒与发送」中，提醒总开关（`socialV2.enabled`）、六类 P1 提醒、热群跟进（`groupFollowup`）、冷群低优余光（`groupActivity`）和未读补提醒（`unreadFollowup`）各用独立按钮，点击仅保存该项并立即生效；关键词列表另行保存。关闭分项时清理该类待发与内存挂起队列，并在原生提醒库确认已关闭 P1 类型的提醒位置。活动回合内对连续 P1 强召唤保持 30 秒投递冷却（`DESKTOP_ATTENTION_ACTIVE_COOLDOWN_MS`）在队列内合并后再通过 `steer` 送到当前回合下一步，回合 `turn/end` 停稳后等 5 秒落稳再唤醒；待机期间收到新 P1 提醒先经 5 秒窗口（`DESKTOP_ATTENTION_BATCH_MS`）合并突发来信，再提前唤醒。
- **未读补提醒与历史提醒退役**：桥接运行期间，角色读到触发 P1 提醒的消息（或读过最新一页历史并正常结束回合/进入待机）时确认对应提醒；若它仍未被覆盖，在进入待机且 `turn/end` 确认旧回合停稳 **5 秒**（`DESKTOP_ATTENTION_REMINDER_CHECK_MS`）后检查一次，最多补发一次（指数退避恢复期间不补发）。已补发完毕的耗尽提醒（`stage >= 2`）以及超过 6 小时且未再被后续来信激活的首次提醒会在回合正常结束与桥接启动/绑定原生账号（`bindNativeReminders`）时自动退役清理。关闭 `unreadFollowup` 会清除补提醒定时器与排队补提醒，保留未读定位和新事件的首次提醒。
- **出站校验打回**：`/api/socialV2/send-message` 与 `/api/socialV2/send-burst` 在执行敏感信息拦截的同时通过 `validateQQOutboundText` 校验乱码替换字符（`\uFFFD`）与明显 Markdown 排版语法（`[文字](链接)`、`**粗体**`、代码块），违规返回 `400` 明确提示打回给模型修正重发，不做静默改写。

### 3. 未读计数、读取水位与消息定位（`id:` / `seq:`）

- **来源来信计数、自主向前翻页与回合水位提交**：主会话目录（`qq_list_conversations`）和休息唤醒摘要显示各来源自上次查看以来的来信数（最多显示 500）。不带 `messageId` 读取最新一页 `qq_get_conversation_history` 时，若返回的非截断最新页末尾仍标记为 `isNew=true` 且之前还有未读消息，响应会返回 `hasOlderUnread=true`、`olderUnreadCount` 与 `nextMessageId`（`id:...`），供数字角色自主决定是否传入 `messageId=nextMessageId` 继续往前翻阅或只看近期消息；角色读过最新历史或非空未读页后，桥接在 `agent_rest` 或回合正常结束时一并提交该来源的计数与早于读取起点的未读/提醒队列记录（`seq <= visit.unreadSeq`），读取开始之后新到达的消息与提醒继续保留。同轮复查保留原来的 `previousHandled` 和 `isNew` 判断基准；回合中断或桥接重启时保留尚未提交的计数。带消息 ID 往前翻历史、查看单条详情和 WebUI 预览均不会清掉整个来源的计数。
- **未读确认与最近已读映射**：提醒队列按实际返回的条目逐条确认（历史页按同一来源的 QQ 消息 ID 匹配；跳读保留间隙中的未读，补齐间隙后连续水位才前进）。每个来源在内存保留最近已读取的 100 条 `seq → messageId` 定位映射（仅保留序号到原生消息 ID 的映射，不保留正文或附件），使后续看图、查详情或引用仍能按原序号回查；映射在重启、切换账号或清缓存后失效，超出保留范围时改用读取结果中的 `id:<QQ消息ID>`。
- **`id:` 与 `seq:` 前缀、单跳引用解析与正文上限**：消息提醒与 QQ 工具使用 `id:` 和 `seq:`（未绑定 QQ 消息 ID 的本地序号可使用 `seq:本地序号@缓存标识`）区分 QQ 消息 ID 与本地序号；有歧义的纯数字会返回明确提示。常驻读取器在同一次只读 SQLite 事务内对每页去重并单跳附带被引用消息（`reply.data.source`），历史、未读与 `qq_get_message_detail` 在保留 `plain` 中 `[引用 被引用人：原文]` 的同时额外返回结构化 `replyTo`（`messageId`、`sender`、`text` 200 字预览、`at`/`ago`、`hasMedia`、`forwardIds`）；历史页单条正文最多返回 1000 字符（超出时附带 200 字符 `tail`，并受页级 40 KB 预算约束），`qq_get_message_detail` 单条详情正文上限为 4000 字符并按实际超限标记 `textTruncated`。`qq_get_message_images` 在外层无图但 `replyTo.hasMedia=true` 时引导模型改用 `replyTo.messageId`；清空 QQ 缓存时同步丢弃待处理提醒，并更换缓存标识使之前的本地序号提醒失效，避免序号重新指向新消息。
- **出站分条节奏**：发送数量由模型决定，桥接无多条开关和数量上限。第一条直接发送，后续每条消息前等待 `min(1000, 下一条Unicode字符数 × delayPerCharMs)` 毫秒（默认 20 ms/字，设为 0 可连续发送）。

### 4. 戳一戳、好友申请、邀请加群与 Ark 卡片解析

- **结构化接收识别**：戳一戳识别使用原生 QQ 的结构化灰条事件（JSON 灰条业务 `1061`）与参与者账号，不使用可定制的动作文字或后缀；主会话提示与按需历史明确标为「QQ 戳一戳事件」。原生断线补查保留系统发送者的灰条记录，再按原消息 ID 向 QQ 查询结构化事件。自己发出或目标为其他人的事件不提醒角色；群聊和私聊共用 `poke` 开关，不依赖私聊消息开关。
- **主动发送（`qq_send_poke`）**：沿用 `qq_send_poke` → `/api/socialV2/send-poke`。桌面 QQ 通道把群聊/私聊戳一戳映射为 QQ 消息服务 `sendNudge(peer, targetUin, aioUin)`（群聊 peer 使用群号，私聊先解析 NT UID，两个 UIN 参数以十进制字符串传递）。发送前核验群成员或私聊目标一致性，成员查询及 UID 解析期间账号/凭证/连接切换会取消发送。仅 QQ 返回 `result: 0` 才确认原生调用成功，失败或超时不重发。主动发送与接收提醒开关独立。
- **好友申请查看与同意/拒绝（`qq_list_friend_requests` / `qq_handle_friend_request`）**：通过 `GET /api/socialV2/friend-requests` 与 `POST /api/socialV2/friend-request/handle` 暴露给全局会话。在桌面 QQ 进程内注册 `BuddyService.addKernelBuddyListener`（监听 `onBuddyReqChange` 与 `onDoubtBuddyReqChange`，连接关闭时 `removeKernelBuddyListener`），支持 `get_friend_requests`（调用 `getBuddyReq` / `getDoubtBuddyReq` 拉取）及 `set_friend_add_request`（普通申请调用 `approvalFriendRequest`，疑问申请同意/拒绝分别调用 `approvalDoubtBuddyReq` / `delDoubtBuddyReq`，同意后按需调用 `setBuddyRemark` 并更新 `privateChatTypes` 缓存为正式好友）。
- **邀请加群查看与同意/拒绝（`qq_list_group_invites` / `qq_handle_group_invite`）**：通过 `GET /api/socialV2/group-invites` 与 `POST /api/socialV2/group-invite/handle` 暴露给全局会话。在桌面 QQ 进程内注册 `GroupService.addKernelGroupListener`（监听 `onGroupSingleScreenNotifies` / `onGroupNotifiesUpdated`，连接关闭时移除），仅过滤 `type === 1`（`INVITED_BY_MEMBER`）待处理群邀请，支持 `get_group_invites`（同步 `fetchGroupNotify` + `getSingleScreenNotifies`，并合并读取只读原库 `group_invite_cards` 中的私聊 `qun.invite` 邀群卡片以及实时私聊捕获，按 `get_group_list` 过滤已加入群聊）与 `set_group_invite_request`（对 `native:` / `native-doubt:` / `native-card:` 调用 `operateSysNotify` 执行同意/拒绝；当同意 `native-card:` 触发本地通知缓存 `target_seq not found` 或同意操作返回 `already agree` 时，强刷 `get_group_list({ force: true })` 核验目标群确已在已加入群列表中才标记成功并附 `confirmedByGroupList: true`，未确认仍 fail-closed 报错）。
- **Ark 卡片消息解码与摘要（`src/qq-card.js`）**：原生历史读取器（`scripts/ntqq_history.py`、`scripts/ntqq_reader_service.py` 解析 protobuf `47901`）与实时探针（`arkElement.bytesData`）统一输出 `{ type: 'card', data: { data } }`；`formatQQCardText` 将其压成单行安全摘要（供历史/详情/合并转发展示，但入站唤醒与后台学习保持占位符防关键词误触）。

---

## 三、媒体预取、分级看图与合并转发

### 1. 原生图片接收预取与转换预览回退

- **接收时后台预取**：原生 QQ 通道默认在新图片消息进入桥接后，异步检查并补齐当前账号的图片缓存。WebUI「QQ 设置 → 图片缓存」的 `socialV2.media.prefetchOnReceive` 可关闭接收时预取（旧配置缺省开启）。预取复用 `NativeQQ.getImage` 的缓存查找和 MD5 校验，每条消息最多处理 `maxCount` 张（默认 5），同时最多运行 2 项、保留 100 项待完成任务；超额图片仍可按需获取。预取只填充 QQ 缓存，不调用模型、不抓取事件 CDN URL 或转换图片；历史正文查询本身也不下载媒体。关闭开关、断线或换账号丢弃未启动任务，已提交 QQ 的下载允许完成；并发读取同一消息图片共用请求。无论预取是否开启，角色的图片工具都保留按需补取和输出大小检查；商城表情沿用本机预览与受限 CDN 回退。
- **QQ `Ori` 目录转换预览回退**：QQ 有时将转换后的图片放在 `Ori` 目录，沿用原件摘要与扩展名，但文件内容不再匹配原图 MD5。常规缓存未命中时，原生通道核验精确消息或已读取的转发节点，可使用该图片元素 `thumbPath[0]` 指向的当前账号缓存作为预览。对于普通消息的常规图片（`picSubType=0`），若 QQ 只提供与元素 `sourcePath` 对应的 JPEG，桥接在照常向 QQ 请求补取的同时，允许用该文件生成预览，条件是它位于当前账号的 `Pic/YYYY-MM/Ori`、文件名匹配消息摘要，且 JPEG 实际尺寸与该元素声明的宽高完全一致。读取器检查真实路径、大小和尺寸，桥接对交付的转换预览字节执行有界完整解码；**原图模式仍强制要求通过 MD5 校验**。

### 2. 原生合并转发与转发内媒体

- **按需展开（`qq_get_forward_msg`）**：历史和实时事件提供 `native:<原消息ID>` 句柄，桥接核验来源中的原消息后调用 QQ 的 `getMultiMsg` 获取记录，无需先手动在 QQ 点开。嵌套转发使用同一根消息和已读取节点的句柄。转发正文不会随提醒自动送入主会话，也不受表情学习开关控制。
- **转发图片补取（`downloadRichMedia`）**：转发子节点不一定存在于普通消息表，因此转发内图片走 QQ 的 `downloadRichMedia`，使用已核验的最外层来源、根消息 ID 及内部图片元素 ID（嵌套转发沿用同一根定位）。内存仅保留有界、按来源登记的嵌套引用、媒体身份与缓存定位，断线即失效。下载完成事件匹配根消息与图片元素，下载失败码与缓存未完成分开处理，实际成功以媒体读取器验证的文件为准；图片批次使用两路并发与总时限（单张 45 秒、整批 135 秒），部分失败不丢弃已完成结果。

### 3. 分级看图（`preview` 与 `qq_get_image_detail`）

- **默认预览与有界 `imageRef`**：普通消息与转发图片默认使用 `quality=preview`，优先 QQ 缓存的有效缩略图，无缩略图时可用合限原图生成预览（默认长边 1280、1 MiB 归一化，GIF 抽帧拼图）。`src/qq-image-references.js` 为实际从 QQ 读到的图片登记当前账号、来源、消息/转发节点及图片位置，返回会话内有界 `imageRef`（包括转发正文中未自动附图的项）；最多保留 2000 项，空闲 24 小时或断线/重启后失效。
- **单图原图与归一化裁剪（`qq_get_image_detail`）**：通过 `POST /api/socialV2/image-detail` 按 `imageRef` 只读取一张图片，默认 `quality=original`，可指定 `preview` 或原图归一化 `crop={x,y,width,height}`（`0..1` 坐标）。原图补取由原生 QQ 通道提供，只接受文件头与 MD5 校验过的原件，缺失时请求 QQ 补取，绝不退回缩略图；商城表情不冒称具备可验证原图通道。`src/media-detail.js` 独立于预览缩图策略：最多 32 MiB、64MP（单边 32768）原图优先原字节返回，超出 3 MiB 传输预算时保持分辨率重编码，仍超限则明确建议缩小裁剪区域，不暗中降采样。裁剪以 EXIF 正向图像为基准，先裁剪再编码；透明背景合白和动图仅首帧均明确说明，不修改 QQ 原缓存。并发细节转换最多两项并行，相同请求合并；已有缓存全部超限时明确报错，不重复下载同一大原图。
- **下游缩放说明**：图片结果显式提供 `imageRef`、实际输出尺寸、原图尺寸、`representation`、`originalAvailable` 与 `canFetchOriginal`。这些描述的是桥接交付的字节；当前 DSH 附件归一化与 `llm-pi-ai` 请求预处理默认有 4,194,304 像素与 1 MiB 重编码预算，桥接不修改 DSH 全局图片限制，工具说明明确提示需要看清小字细节时应从原图读取更小的 `crop`。

---

## 四、DSH 宿主集成、后台分组会话与扩展能力

### 1. DSH 客户端、诊断、MCP 纳管与上下文压缩

- **单会话状态与序列投影（`src/dsh-client.js`）**：优先用新版 `session/state` 读取单个会话，仅确认旧宿主未导出此接口时才回退全量列表。冷会话 `active:false` 仍存在，`queue:null` 表示未装载而非空队列。历史、记忆整理、用量游标及停止队列均要求 `sequenced` 持久投影；`migration-required` 缓存只作提示，不能用来推断队列为空或历史已迁移。停止时读取队列失败仍尝试取消当前回合，并保留错误。
- **主会话有界诊断（`src/dsh-diagnostics.js`）**：从主会话事件提取结构化工具错误、DSH 图片接纳计数及模型请求重试。重连从快照重建重试状态，回合/步骤边界和成功回复清理状态；重建会话不继承旧重试。WebUI 分别显示等待审批/回答、模型重试和桥接生命周期恢复，图片日志明确区分工具成功与 DSH 附件接纳。
- **DSH MCP manager 纳管（`plugins/qq-agent-presets/managed-mcp.mjs` 与 `src/dsh-mcp-management.js`）**：仅把桥接的 `qq` 与 `qq-memory` 注册给 DSH 自身的 MCP manager，保留工具命名空间和调用超时。新安装脚本默认生成纳管条目，`--legacy-mcp` 保留旧直连模式，不覆盖其他 manager 配置。WebUI「系统运维 → 诊断与维护」共享一个按需建立的只读状态订阅，可显式探测（初始化、列工具并关闭临时连接）或定向重连选定服务，失败与超时不自动重试。
- **上下文压缩钩子（`plugins/qq-agent-presets/compaction-persona.mjs` 与 `dsh-host-modules.mjs`）**：仅覆盖宿主 `dsh-compaction-basic` 的 `summarize()` 摘要生成钩子。`dsh-host-modules.mjs` 根据当前 DSH 宿主/CLI 运行入口动态加载同一模块树中的基础压缩引擎、流组装器和 `LlmError` 类（支持桌面版 `app.asar`），不从插件私有依赖猜测宿主版本；共享类身份保留图片卸载错误恢复并继承宿主模型切换前压缩保护，解析失败或实例分裂时 fail-closed 拒绝加载。
- **DSH 内置网页工具**：`desktop-agent` 预设加载 `@deepseek-ai/dsh-tool-web`，默认注册 `web_search` 与 `web_fetch` 并通过 `qq-tool-restrict` 放行；它们调用当前 DSH profile 选择的 `ctx.web` 提供方（与桥接的 `webSearch` 模块分开，随附的 DSH `http` 抓取提供方允许访问本机和内网地址，不经过桥接 `safeFetch`）。
- **电脑操作（`dsh-computer-use-win`）**：提供本机桌面操作与不抢焦点的后台浏览器通道（`browserLane` / `browserTab`）；前台键鼠操作支持用户按 Esc 中断。观察屏幕时看到 ChatGPT、DSH、qq-bridge 或开发窗口属于正常现象，提示词要求不关闭、停止或篡改这些底层程序，也不外发内部凭据（详见 [RULES.md](../../RULES.md)）。

### 2. 长期记忆、后台黑话/表情学习与商城表情

- **A_Memorix 长期记忆（`src/a-memorix-gateway.js` 与 `src/a-memorix-readonly.js`）**：可选记忆的写入、相关度检索、单条读取、合并替换（`memory_replace`）和删除由 Gateway 统一接入；DSH 五个记忆工具、首次会话自身经历摘要和 WebUI 常规记忆操作访问同一 namespace。已认证的本机 WebUI 还可通过只读 SQLite 适配器分页浏览该 namespace 的 `paragraphs` 活动原始段落（agent-call 白名单不开放此路由）。设计和部署前提见 [MEMORY_ARCHITECTURE.md](MEMORY_ARCHITECTURE.md)。
- **存量记忆回顾**：`memory-curator` 独立处理同来源已存原文，使用拒绝全部工具的 Host preset 或隔离 headless。桥接核验来源和版本并管理可撤销的派生记录。[回顾流程](MEMORY_ARCHITECTURE.md#旧记忆回顾)
- **DSH Host 后台分组会话（`src/background-sessions.js`）**：后台任务沿用主角色的 Host Workspace 和 Session 创建接口。`memory-organizer` 归入「长期记忆整理」分组，`chat-learning` 和 `market-analysis` 共用「后台黑话与表情学习」分组。桥接只在首次创建时命名分组，提交任务前登记并命名会话，按请求 ID 读取本回合持久事件，模型选择只作用于当前后台会话；任务完成后按登记 ID 自动归档空闲后台会话（控制台也可手动清理）。`qq-agent-presets` 为四个后台 preset 的 `persona` 设置 `complete: true` 与 `includeRuntimeContext: false`（剥离无关的宿主桌面操作、MCP 资源列表和 Web GUI 提示片段），并注册专属工具与执行守卫：学习仅能读取绑定到当前会话的批次图片，记忆整理仅能调用五个记忆工具。Host 无法预建会话时，桥接回退到隔离的 headless 流程和临时 patch。
- **黑话、表情语义索引与商城表情包（`src/chat-learning.js`、`src/sticker-memory.js`、`src/market-packs.js`）**：按 QQ 来源分批保存学习队列、证据与知识，`src/learning-assets.js` 按内容哈希保存本地表情（详见 [CHAT_LEARNING.md](CHAT_LEARNING.md)）。`sticker-memory.js` 将表情目录投影到独立的 A_Memorix `qq-bridge-stickers` 空间，QQ 工具按当前会话和普通表情（`regularEnabled`）、商城表情（`marketEnabled`）各自开关将检索命中映射回可发送的稳定 ID；角色复检建议经 WebUI 采纳后生效。`market-packs.js` 支持按包 ID/分享链接读取腾讯商城目录、预览、整包收录与移除；收录时将整包视觉分析任务提交到独立 `market-analysis` 会话，商城原释义与分析注解共同编入表情索引。

### 3. 令牌账本、可选游戏工具与文件权限

- **分功能令牌与花费账本（`src/token-ledger.js` 与 `src/model-catalog.js`）**：将主会话、记忆整理、旧记忆回顾和后台学习的用量存入 `state/token-usage.sqlite`，缓存 `models.dev` 目录按服务商和模型匹配美元单价并冻结已入账金额；旧 JSONL 账本在单事务内一次性迁移。详见 [TOKEN_USAGE_CONSOLE.md](TOKEN_USAGE_CONSOLE.md)。
- **可选明日方舟模块（`plugins/qq-agent-presets/maa-agent.mjs`）**：在存在本地安装记录（`state/maa-agent/install.json`）时注册 `maa_*` 游戏工具和原生 CLI 入口，按需调用独立虚拟环境的 Python 模块；作业执行、设备锁和战果记录由上游维护。详见 [MAA_AGENT.md](MAA_AGENT.md)。
- **文件权限策略**：启动和配置保存不自动修改文件 ACL、不请求管理员提权；Windows 新建或原子替换的文件沿用父目录权限，支持 POSIX 文件模式的平台继续对相应新文件使用 `0600`。更新不重置既有磁盘权限或恢复继承，临时测试产物仍与生产 `state/` 分开。

---

## 五、当前代码边界与渐进式重构原则

### 1. 当前模块边界

继续按明确职责渐进式整理 `src/bridge.js`，不需要为了代码体量整体重写。每次改动先找出状态所有者、持久化格式、调用方和安全门，再以小步迁移保持行为可审查。

`src/bridge.js` 仍是组合与协调中心，涵盖启动配置、QQ 事件接线、全局 DSH 生命周期、QQ 消息缓存、WebUI HTTP 路由和发送策略。已抽离的模块边界包括（完整列表见 [../FOLDER_MAP.md](../FOLDER_MAP.md)）：

- `src/native-qq.js` / `src/native-reminders.js`：桌面 QQ 本地通道运行时、常驻 SQLCipher 只读查询连接与按账号持久化的原生提醒水位。
- `src/autonomy-policy.js` / `src/sleep-schedule.js`：纯函数形式的 QQ 注意信号分类与每日睡眠/起床闹钟计算。
- `src/dsh-client.js` / `src/dsh-diagnostics.js` / `src/dsh-mcp-management.js` / `src/background-sessions.js`：DSH API/鉴权/事件流、主会话有界诊断、MCP manager 状态/探测/重连，以及后台分组会话调度。
- `src/mcp-qq.js`：以 `mcp__qq__*` 注册 QQ 消息、合并转发、分级看图、表情、戳一戳、状态和主动休息工具。
- `src/mcp-memory-safe.js` / `src/a-memorix-gateway.js` / `src/a-memorix-readonly.js` / `src/memory-organizer.js`：A_Memorix 长期记忆工具、Gateway 客户端、WebUI 原始记录 SQLite 只读浏览与休息后每日独立整理。
- `src/chat-learning.js` / `src/learning-api.js` / `src/learning-runner.js` / `src/sticker-memory.js` / `src/market-packs.js`：后台黑话/表情学习、商城表情包收录与整包分析、表情语义索引投影。
- `src/media-normalize.js` / `src/media-detail.js` / `src/qq-image-references.js` / `src/qq-message-reference.js`：预览归一化、单图原图/裁剪读取与消息/图片定位引用。
- 角色卡与提示模板、安全网络抓取、敏感内容检查和 SQLite token 账本等独立模块。

### 2. 渐进式重构顺序与改动原则

把以下职责作为可逐步明确的边界，不强制采用固定目录结构：

1. **运行时组合**：启动、依赖接线与关闭流程。
2. **QQ 通道**：桌面 QQ 事件与消息服务适配、媒体预取、好友申请与出站发送传输。
3. **全局会话管理**：唯一 `desktop-agent` 会话的创建、恢复、停止与状态持久化。
4. **自主调度**：休息、睡眠闹钟、异常恢复、注意信号与活动回合协调。
5. **QQ 提醒存储**：按账号与来源索引、去重、水位与确认状态（保持 `native-reminders.js` 的窄接口）。
6. **控制台 API**：将管理路由与会话、消息和发送策略解耦。
7. **动作策略**：集中说明桥接 API 发送的授权、内容检查和审计边界，并保留用户允许的桌面控制能力。

改动原则：
- 一次处理一个具体职责，先确认它读写的状态与所有调用方。
- 抽取时传入窄依赖，避免模块反向依赖桥接入口形成隐式全局耦合。
- 结构整理应保持既有行为；有意改变行为时，同步更新 `RULES.md`、文档、控制台和持久状态迁移。
- 不要把 QQ 消息正文或关键词信号自动塞进全局模型上下文。活动检测和模型观察是两件事。
- 不要在清理中重新引入逐群/逐私聊 DSH 会话、逐来源 agent 令牌或并行运行时。
- 发送授权检查应保持集中，覆盖桥接 API 发送；桌面 GUI 发送的限制另见当前用户授权与 [RULES.md](../../RULES.md)。
- 只有当单一全局会话的具体功能无法通过小步整理实现，或共享状态让迁移风险不可接受时，才重新评估更大规模重构。
