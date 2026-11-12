# 使用桌面 QQ 账号发送消息

桌面 QQ 的独立命令行原型已验证从当前登录账号向指定好友发送文字和纯 GIF 表情。角色可选用[桌面 QQ 独立通道](NTQQ_ATTENTION.md)或 SnowLuma 收发。

## 运行只读原型

新机器先按独立通道安装说明准备 Frida 环境。需要单独诊断 QQ 回调时，登录桌面 QQ，从 qq-bridge 根目录运行观察器。正常启动桥接会自动接入 QQ。[新机器安装](NTQQ_ATTENTION.md#新机器安装)

```powershell
.\state\ntqq-probe\venv\Scripts\python.exe -B scripts\ntqq-probe\probe.py --seconds 90
```

脚本定位已登录的 QQ 主进程。Frida 短暂观察 QQ 自己对 `wrapper.node` 的调用，将当前会话的消息服务交给观察代码。客户端空闲时，脚本通过 QQ 主聊天窗口的 IPC 请求第一页收藏来触发该服务。窗口中的会话和输入框无需切换。取得服务后，加载器断开。QQ 内部的观察代码在超时、完成或发现临时目录已清理时注销监听。

命令输出 JSON。账号取自 QQ 的 `authData.uin`，可与 Windows 报告被同一进程打开的账号消息库交叉核对。收藏只取第一页，最多 20 项，包含 QQ 返回的编号、资源 ID 和 MD5。`received` 统计原生来信回调中的消息，`incoming` 只统计能辨认为其他账号发来的消息。`lastChatType` 为最近一条这样的来信类型。消息正文、好友名、群名和媒体内容不进入报告。退出码 0 表示账号、收藏、他人来信及注销均已观察到。退出码 2 表示报告中仍有未验证项，1 表示接入失败。自定义 QQ 存储路径用 `--tencent-files` 指定，多个 QQ 主进程用 `--pid` 选择，`--wait` 调整等待接入的秒数。

## 指定私聊的发送测试

同一台 Windows QQ `9.9.36-53644` 上，2026-11-10 的实测分别发送一条文字和一条仅包含收藏 GIF 的消息。两次提交均返回 `result=0`，各收到与该次提交匹配的 `onMsgInfoListUpdate`，状态为 `sendStatus=2`，带有不同的原生消息 ID 和连续的服务器序号。发送端的 QQ 私聊库另行按账号、目标和原生消息 ID 查到了两行。第一行只有一个文字元素，第二行只有一个图片表情元素（子类型 1），其 MD5 与收藏原图一致。接收设备上的显示和对方已读状态需由对方核实。

测试入口是 [send_test.py](../../scripts/ntqq-probe/send_test.py)。从已获准的目标私聊中取一个原生消息 ID 及对端 NT UID。若使用已有的数据库直读器，可以对 `c2c_msg_table` 按 `40030` 和 `40033` 均等于目标 QQ 号筛一条对方来信，取 `40001` 消息 ID 和 `40020` 中的发送者 UID。每次命令还会通过 QQ 的 `getMsgsByMsgId` 核对该消息确实属于这位联系人的私聊。

```powershell
$python = '.\state\ntqq-probe\venv\Scripts\python.exe'
$script = 'scripts\ntqq-probe\send_test.py'
$target = @('--peer', '<对方QQ号>', '--uid', '<对方NT UID>', '--sample-id', '<既有消息ID>', '--run', 'private-test-1')
& $python -B $script check @target
& $python -B $script text @target
& $python -B $script sticker @target
```

`check` 会查询账号收藏并检查原图，`text` 和 `sticker` 各会**真实发送一条**。纯表情取自收藏第一页中能找到且通过 MD5 校验的原件，也可用 `--original` 指向与本次收藏匹配的本地原图。成功需要 QQ 的提交结果、匹配本次发送的状态事件及非零服务器序号。账号、动作和关联标识在发送前先写入 `state/ntqq-probe/send-tests/<run>/`，回执写入同目录。同一运行名下的同一动作只能提交一次。结果未知时，先查已有回执和目标私聊的 QQ 历史。

## 源码与许可证

观察器和加载脚本由 qq-bridge 自行实现。NapCat 和 lite-tools 用于核对 QQ 接口名、参数和事件含义，项目没有引入两者的源码、二进制或运行服务。核对的 NapCat 版本采用 Limited Redistribution License for NapCat，lite-tools 采用 AGPL-3.0。独立通道和诊断观察器使用同一个 Frida 虚拟环境，Python 绑定及核心的上游许可证为 wxWindows Library Licence 3.1。[NapCat 许可证](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/LICENSE) · [lite-tools 许可证](https://github.com/xiyuesaves/lite-tools/blob/c9ea751e81735419ba1a44a677e261216a9cba61/LICENSE) · [Frida Python 许可证](https://github.com/frida/frida-python/blob/17.24.1/COPYING) · [Frida Core 许可证](https://github.com/frida/frida-core/blob/17.24.1/COPYING)

## 本机能验证到哪一步

2026-11-10，观察器在已经登录的 Windows QQ `9.9.36-53644` 上读到了与该进程打开的数据库一致的账号。收藏查询成功返回一项带 MD5 的表情。两次独立观察分别收到了其他账号的一条群消息（`chatType=2`），随后注销。其中一次在 Frida 提前断开后完成。第三次用 3 秒窗口重新接入，收藏仍能读到，期间来信为零，报告按预期返回退出码 2。QQ 主进程始终使用同一个 PID。这里的重新接入指观察器退出后附加到同一实例，未覆盖 QQ 退出重登或客户端升级。

当前 QQ 的安装包入口仍是自带的 `application.asar/app_launcher/index.js`。独立启动探测中，该版本拒绝了 `--inspect-brk` 参数，主进程内也报告 Node Inspector 不可用。Frida 17.26.2 在这台 Windows 11 LTSC 的独立测试进程上报加载器 TLS 错误，17.24.1 通过同一测试并成功附加到 QQ。

单独的 Node.js 24.22.0 子进程即便加入 QQ 原生依赖目录，加载该模块也会得到 `ERR_DLOPEN_FAILED: Module did not self-register`。本项目实测的两条消息均由运行在桌面 QQ 进程里的代码调用消息服务发出。[lite-tools 对同一原生发送接口的使用](https://github.com/xiyuesaves/lite-tools/blob/c9ea751e81735419ba1a44a677e261216a9cba61/src/main/utils/nativeCall.ts#L241-L264)

## 直接调用 QQ 能覆盖哪些角色功能

这里的直接调用指插件在桌面 QQ 进程里取得 QQ 已经创建的登录会话，调用它的消息服务。NapCat 的桌面 Framework 在客户端加载 `wrapper.node` 时捕获 QQ 创建的 session，等待初始化完成后才注册监听。这个顺序说明了为什么只在另一个 Node 进程载入同名文件，并不能继承桌面登录态。[会话获取实现][bootstrap] · [登录与初始化][ready]

**本机静态验证。** 在 QQ 9.9.36-53644 的 `wrapper.node` 中定位到消息服务的原生方法注册表。从 `addKernelMsgListener` 到 `addNewOfflineFileList` 连续 299 项，每项占 64 字节，包含方法名和指向可执行代码的函数指针。抽查的 23 个方法在已下载、尚未运行的 9.9.37-54395 消息服务注册表中也都有对应项。当前构建自带的参数检查还能确认 `sendMsg` 接收 4 个参数，`fetchFavEmojiList` 接收 4 个，`sendNudge` 接收 3 个。两个版本的这一比对只验证注册入口。参数语义、服务器行为和插件加载兼容性仍需实测。

| 角色要做什么 | 已查到的直接路径 | 实际使用条件 |
| --- | --- | --- |
| 私聊或群里发文字、原生 @、引用回复 | QQ 接收目标会话和有序的消息元素。群 @ 带成员 UID；引用元素带原消息 ID、序号和发送者。 | 按来源把现有桥接引用解析为原生消息。多条消息可在同一发送队列逐条提交、逐条取回执。[文字、@ 与引用的构造][elements] |
| 只发一张学习到的表情，或图文同发 | 可以只提交一个图片元素，也可以和文字组合。QQ 图片元素包含资源路径、摘要、尺寸、格式和图片子类型。 | 来自桥接学习库的图片按编号定位原件即可，不要求先加入 QQ 收藏。需要保留 GIF 动画时应使用原件。[图片元素][media] |
| 用系统表情或商城表情 | 系统表情使用表情 ID。商城表情有独立元素，QQ 在其中保存包 ID、表情 ID、资源字段和名称。 | 独立通道通过 QQ 消息服务的 `getMarketEmoticonEncryptKeys` 获取当前账号的商城发送资料。包详情按整包核对，实际发送只取指定表情，在 QQ 内组装原生消息并等待回执。[商城表情发送](CHAT_LEARNING.md#手动管理商城表情) · [QQ 商城接口](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/services/NodeIKernelMsgService.ts#L353-L375) |
| 读取、增加或维护 QQ 收藏表情 | `fetchFavEmojiList` 能返回资源 ID、MD5、路径、缩略图及描述等字段。消息服务还注册了 `addFavEmoji`、`deleteFavEmoji` 和 `modifyFavEmojiDesc`，上游有具体调用。 | 检索仍可使用桥接的表情编号，发送时解析对应文件或 QQ 资源。角色提出的描述修正继续走 WebUI 确认，账号收藏有自己的描述字段。[收藏字段][favfields] · [收藏操作][favorites] |
| 列出会话、定位好友和群成员 | 已在当前构建找到好友列表、群列表、最近联系人与群成员分页方法。上游能按群号和成员 QQ 号或 UID 查询成员。 | 可以定位原生 @ 对象，也能核对消息将发往哪个会话。[好友查询][buddy] · [群与成员查询][group] |
| 实时收信、群提醒、补历史、看合并转发 | `onRecvMsg` 提供原生来信，元素保留 @ 和引用。可以按会话查最新一页、按消息 ID 回查、按序号翻页；已知转发根消息时可取其子消息。 | 可据此驱动已有提醒、后台学习和断线补查；断线期间的覆盖范围与去重仍要验证。QQ 可查会话未读并标记已读，角色读到哪一条仍由桥接记录。[收信处理][receive] · [历史方法][historyapi] · [展开转发][forwardread] · [QQ 未读接口][unread] |
| 发文件、视频、语音，补取本机缺少的媒体 | 有文件、视频和语音消息元素。上游会准备视频封面、时长，将语音处理为 SILK；下载原消息媒体时可用会话、消息 ID 和元素 ID 调用 QQ，并等待下载事件。 | 可尝试补取服务端仍提供的原件。端上只有视频封面时，下载成功与否要看该条消息实际返回的结果。[媒体准备][media] · [原件下载][download] |
| 撤回、转发已有消息、表情回应 | 原生接口包括 `recallMsg`、`forwardMsg`、`multiForwardMsgWithComment`、`setMsgEmojiLikes`。 | QQ 和服务端决定操作结果。转发实际已有的消息，与从外部资源 ID 取任意合并转发或组装新转发卡片，是不同调用。[撤回与转发][forward] · [表情回应][reaction] |
| 戳一戳 | 本机 QQ 9.9.36-53644 的消息服务存在 `sendNudge`；N-API 绑定接受 Contact 和两个十进制字符串，并将后两项转换为 64 位整数。诊断字段为 `target_uin` / `aio_uin`。 | 桥接已按目标 QQ 号、会话 QQ 号的顺序接入 `sendNudge(peer, targetUin, aioUin)`，以 `result: 0` 确认调用成功。群聊与私聊的参数映射、失败回执和身份切换已做离线测试；参数语义依据本机绑定及诊断推定，真实收件端表现与服务回执仍待实发验收。NapCat 另走协议包，不能据此认定该原生调用已实测。[上游戳一戳实现][poke] |

**本机历史样本。** 只读查询当前账号缓存的原库，按发送者等于本账号筛选，每种会话最多取最近 1,000 条，只统计消息元素。在 1,000 条群聊记录中，533 条带引用元素。在取到的 502 条私聊记录中，44 条带引用元素，22 条整条只有一个图片表情元素。这里验证的是该账号实际留存的消息形态；记录本身不能区分消息最初由哪个设备或发送程序发出。

**回执能说明什么。** QQ 会先返回提交结果，再用 `onMsgInfoListUpdate` 通知消息状态。发送端应按本次关联标识和原生消息 ID 对齐回执。上游类型还区分了成功但没有服务器序号的状态，其在本机的具体表现待测。超时保留“结果未知”，避免切回 SnowLuma 后同一句发两遍。QQ 报告发送成功与收件人已读也是两件事。[发送实现][send] · [发送状态定义][status]

在本轮命令行原型实验中，已验证登录账号、收藏列表、原生群消息监听，以及指定私聊的文字和纯 GIF 发送回执。后续桥接接入情况和运行依赖见[独立通道说明](NTQQ_ATTENTION.md)。

## 发送方式的取舍

| 方式 | 在本项目中的用途及代价 |
| --- | --- |
| 可选的桌面 QQ 插件 | 复用桌面 QQ 的登录态。桥接通过本机 IPC 提交目标和内容，由 QQ 构造消息并发送。可以后台操作，无需占用当前打开的聊天窗口。需要维护 QQ 版本兼容性，首次要验证插件能加载到已登录的会话。 |
| NapCat 提供 OneBot 发送 | 现有桥接已生成 OneBot 文本、回复、@ 和图片消息段，可以先复用这层格式。要使用独立的发送端地址与凭据，确认它驱动的账号与接收侧一致，并分别处理引用 ID 和 QQ 收藏同步。NapCat Framework 需要兼容的 LiteLoader 环境，Shell 模式有自己的启动和登录流程。[NapCat 安装方式](https://napneko.github.io/guide/install) · [桌面 Framework](https://napneko.github.io/guide/boot/Framework) |
| 操作 QQ 窗口 | 普通文字和剪贴板图片可以借用客户端的输入、发送操作。自动化需要核对目标会话、当前输入框和发送结果，引用和原生 @ 还要操作对应控件。本轮没有操作 QQ 窗口。 |
| 独立实现个人账号协议 | Lagrange 系列提供了这个方向的参考。采用独立客户端意味着另行处理账号登录与连接生命周期，也需要验证该账号的桌面共存情况。[LagrangeV2](https://github.com/LagrangeDev/LagrangeV2) |

腾讯官方机器人接口使用应用的机器人身份和用户或群的 OpenID，适合单独创建机器人时使用。现有 QQ 数据库密钥用于解密本地历史；向好友或群投递需要已认证的消息服务，本机历史行只能作为辅助核对。[腾讯机器人发送接口](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md) · [原生历史实验](NTQQ_HISTORY.md)

## 怎样验证适合 qq-bridge

1. 首先让插件在当前构建里取得登录账号、目标类型和事件监听能力。群聊以群号定位，私聊要将 QQ 号解析成 NT UID。用一个指定的测试会话验证目标解析，不必先切换主角色。[NapCat 的 UID 解析](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/apis/user.ts#L191-L201)
2. 从一条纯文本验证投递。记录提交结果，按本次发送的关联标识匹配 QQ 的状态更新，保存原生消息 ID，并在测试接收端确认消息出现。上游在提交后等待对应的 `onMsgInfoListUpdate`。超时后结果可能未知，先核对状态，再决定是否重试。同一条文本可能重复出现，不能仅凭正文判定哪次成功。[NapCat 的发送与回执](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/apis/msg.ts#L244-L279)
3. 再验证纯图片表情独立成一条消息、原生 @、引用回复。学习到的本地表情有文件可交给 QQ 制作图片元素；QQ 收藏仍依赖桥接的收藏同步；引用还要把接收端的 OneBot ID 解析到同一会话里的原生消息。原生 ID 按字符串保存。两条发送路径可以共用现有的顺序队列，分别保留各自的消息标识。[图片元素实现](https://github.com/xiyuesaves/lite-tools/blob/c9ea751e81735419ba1a44a677e261216a9cba61/src/renderer/utils/nativeCall.ts#L15-L108) · [桥接表情发送](../../src/bridge.js) · [原生历史与 ID 的核验范围](NTQQ_HISTORY.md)

以上为选型阶段的验证步骤。当前独立通道已经将 QQ 来信、提醒、收藏和历史接入同一角色工具集。部署条件、支持范围和首次导入数据库密钥的步骤见[独立通道说明](NTQQ_ATTENTION.md)。

[bootstrap]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-framework/napcat.cjs#L89-L169
[ready]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-framework/napcat.ts#L94-L188
[elements]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/api/msg.ts#L628-L709
[faces]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/api/msg.ts#L709-L761
[media]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/api/file.ts#L38-L214
[favfields]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/services/NodeIKernelMsgService.ts#L348-L380
[favorites]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/action/extends/CustomFace.ts
[buddy]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/apis/friend.ts#L15-L35
[group]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/apis/group.ts#L239-L350
[receive]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/index.ts#L311-L331
[historyapi]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/apis/msg.ts#L19-L59
[forwardread]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/api/msg.ts#L1051-L1066
[unread]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/services/NodeIKernelMsgService.ts#L261-L295
[download]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/apis/file.ts#L242-L282
[forward]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/apis/msg.ts#L209-L315
[reaction]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/apis/msg.ts#L35-L43
[poke]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/action/packet/SendPoke.ts
[send]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/apis/msg.ts#L244-L279
[status]: https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-core/types/msg.ts#L497-L502
