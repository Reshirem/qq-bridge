# 直接读取 Windows QQ 历史

在 Windows 上，`scripts/ntqq_history.py` 可以查询当前登录账号的 `nt_msg.db`。默认只报告群聊和私聊的记录数。给定来源后，输出该来源的消息，最新在前，可继续向前翻页。QQ 和 SnowLuma 保持登录，桥接和 DSH 无需启动。此脚本独立于角色会话、未读水位和记忆整理。

## 使用

本机已在 `state\ntqq-reader\venv` 装好依赖。从 qq-bridge 根目录运行：

```powershell
$reader = '.\state\ntqq-reader\venv\Scripts\python.exe'
& $reader -B scripts\ntqq_history.py
& $reader -B scripts\ntqq_history.py --source group:123456 --limit 20
& $reader -B scripts\ntqq_history.py --source private:123456 --limit 20
```

将示例号码换成实际群号或好友 QQ 号。下一页沿用同一来源，另传 `--before-id` 和上一页最后一行的 `nativeId`。时间相同的记录按主键排序。此 ID 是原生库行标识，不能直接用于 SnowLuma 的发送、引用或未读确认。聊天正文只随有来源的查询输出。

新机器需要 Windows x64、可安装 wheel 的 Python（本机验证为 3.12），以及在本机提供 `request_decrypt_key` 的 SnowLuma OneBot HTTP 服务。按项目的 `config.json` 设置地址和令牌，再运行：

```powershell
py -3.12 -m venv state\ntqq-reader\venv
.\state\ntqq-reader\venv\Scripts\python.exe -m pip install --only-binary=:all: -r scripts\ntqq-requirements.txt
.\state\ntqq-reader\venv\Scripts\python.exe -m pip install --only-binary=:all: ziglang==0.13.0
.\state\ntqq-reader\venv\Scripts\python.exe -B scripts\build_ntqq_vfs.py
```

默认从用户文档目录的 `Tencent Files\当前账号\nt_qq\nt_db` 查找消息库。重定向了文档目录或自选了 QQ 数据目录时，用 `--tencent-files` 指定 `Tencent Files` 文件夹的完整路径。当前实验需要 QQ 在线打开该库，并有可读取的 WAL 索引。

## 在线读取

QQDecrypt 的解密工具会导出剥除文件头的中间库和明文 SQLite 库，适合离线分析。它的 Linux 研究记录观察到同一账号多次登录时数据库密钥相同，已有库的 `key_meta` 通常也保持稳定。本读取器用该标识复用经过验证的密钥。查询历史时直接访问原库，取完一页消息便关闭读事务，再解析图片和视频缓存。[QQDecrypt 解密流程](https://github.com/QQBackup/QQDecrypt/blob/main/docs/decrypt/decrypt_db.md) · [密钥研究](https://github.com/QQBackup/QQDecrypt/blob/main/docs/research/NTQQ-Linux-DB-Key-Research.md)

1. 每次启动用 SnowLuma 查询登录账号，从本机消息库读出 `key_meta`。密钥按“账号 + key_meta”区分，使用 Windows 当前用户的 DPAPI 加密保存在 `state/ntqq-reader/keys`。首次遇到该组合、缓存丢失或无法解密时，才向 SnowLuma 取密钥。若 SQLCipher 用缓存密钥打开时返回 `SQLITE_NOTADB`，再取一次并验证；文件被锁、WAL 缺失等错误不会触发重新取钥。只有成功打开并验证消息表结构后才写入缓存。输出的 `keyStatus` 为 `cached` 或 `fetched`。取钥时只把含标识的 175 字节文件头临时交给 SnowLuma，避免其读取整个主库。[SnowLuma 上游实现](https://github.com/SnowLuma/SnowLuma/pull/69)
2. 读取器加载 `state/ntqq-reader/ntqq_vfs.dll`，通过 SQLCipher 直接打开 QQ 原文件。该 SQLite 文件系统适配器只对主库读取偏移加 1024 字节，并相应调整可见长度。主库和 WAL 的文件句柄都只读；共享内存索引使用 Windows SQLite 的 `readonly_shm=1`。WAL 页位置和操作系统锁使用原生 Win32 VFS。每次查询持有一个读事务，能看到事务开始时已经提交的消息。源库不产生副本，源文件的写入、删除及创建均不属于该 VFS 的读路径。[SQLite WAL 并发读取](https://sqlite.org/wal.html)
3. 平时按需解密并核验访问的页。需要检查整库时传 `--check`，显式运行 `quick_check`。QQ 的 WAL 或共享内存索引不可用时，本次读取报错。VFS 一次编译即可复用；构建脚本下载并核验 SQLite 接口头文件，运行时使用 sqlcipher3 自带的 SQLCipher 引擎。[上游解密参数](https://github.com/QQBackup/nt_msg_db_util/blob/master/1.decrypt.py)
4. 群聊使用 `group_msg_table`，私聊使用 `c2c_msg_table`，两者都按 `40030` 匹配目标。通过 `40800` 正文内的有序 Protobuf 段提取文本和媒体引用。未识别或损坏的正文显式标记；当前输出不解析 @ 对象或引用目标。[上游消息结构](https://github.com/QQBackup/nt_msg_db_util/blob/master/db_docs/c2c_msg_table/40800.md)

## 图片、表情与视频

历史查询保留图文段的顺序，同时返回媒体标识和在当前账号 `nt_data` 中实际找到的文件路径。数据库里的 QQ 图片子类型 1 输出为 `sticker`，其他子类型保留在 `image.subType` 中。这表示发送时的图片类型，不能据此判断它是否仍在本账号的收藏里。系统表情输出 `faceId` 和可用的名称；商城表情输出 `packageId` 和 `emojiId`。

| `localFiles` 字段 | 含义 |
| --- | --- |
| `original` | 图片、图片表情或视频的本地原件。检查文件头，并核对整个文件的 MD5 与该消息记录一致。 |
| `thumbnail` | 图片或表情的可显示预览。商城表情通过表情包 ID 和表情 ID 定位本地 PNG。 |
| `cover` | 视频的封面图。 |
| 空对象 | 在当前支持的缓存目录中没有找到可验证的文件。仍返回数据库中的媒体标识，查询不会下载附件。 |

2026-11-09 按同群、同消息、同发送者和时间对照 SnowLuma 的本机记录。在双方媒体段数量一致的消息中，8,402 个普通图片段、4,880 个图片表情段、372 个系统表情段、254 个商城表情段和 107 个视频段的分类逐段匹配。普通图片和图片表情的 MD5 均匹配，系统表情 ID 和商城表情的包 ID、表情 ID 也均匹配。103 个视频双方都有 MD5 且相同，另外 4 个视频的 SnowLuma 记录没有 MD5。另有 53 条群消息的媒体段数量不同，其中 52 条在 NTQQ 中只剩系统提示段。

文件层面抽查了普通原图、图片表情原图、两者的缩略图、商城表情预览和视频封面，每类 8 个文件均成功解码。另有 12 个图片表情原始 GIF 实测为 24 到 117 帧。本机原生库的 160 个视频段均找得到封面，这次在支持的目录内没有找到可核验的视频原件。另用生成的 MP4 验证了原件存在时的匹配与解码。

## 实测与接入取舍

最早的架构讨论记录在提交 `e3b3b08`。当时尚待验证的环节有取密钥、在线加密库与 WAL、Protobuf 正文，以及识别真正的 @ 和引用。2026-11-09 在当前 Windows 客户端和 SnowLuma 2.0.3 上实测：

- 一次通过完整性检查的快照包含 77,491 条群聊、1,752 条私聊。两个来源均取了 100 条，并从末条继续取 5 条，更早一页与上一页没有重复。
- 在一个群聊样本中，SnowLuma 返回的 11 条纯文本，其发送者、时间、正文全部与原生记录一致。在一个私聊样本中，15 条纯文本有 6 条一致。其余 9 条均为本账号发出，在整个原生私聊表中找不到相同正文。两边的历史覆盖范围不同。
- 对抽查的 200 条群消息，按原生群内序号、群号和 SnowLuma 群消息事件名计算出的 OneBot ID 全部命中。14 条 OneBot 引用消息均有原生引用段。该样本只验证了引用段的存在。私聊 ID 的映射、引用指向谁、原生 @ 与手打文本的区别还需单独核验。

接入时优先给角色提供**按来源向前补查历史**的入口，查到的消息带来源和原生 ID。OneBot 实时事件继续驱动未读、@ 和引用唤醒。

## 原库只读耗时

2026-11-10，在 72 MiB 原库、同一大群和私聊上重新测量。独立 CLI 进程，密钥缓存命中，每组预热一次再测五次，包含启动、账号识别、开库、历史查询和本地媒体解析。旧值和 SnowLuma 值使用前一晚的同机结果，两轮分别采样。

| 最近历史 | 旧版复制后读取 | 直接只读原库 | 此前实测的桥接历史接口 |
| --- | ---: | ---: | ---: |
| 群聊 20 条 | 1,927 ms | 602 ms | 378 ms |
| 群聊 100 条 | 2,059 ms | 698 ms | 1,438 ms |
| 私聊 20 条 | 1,538 ms | 257 ms | 253 ms |

直接读取去除了整库复制和默认全库检查的固定开销。当前按来源与时间排序的群聊 SQL 仍会扫描群消息表。随着记录量增加，这项开销仍需关注；下述内存索引实验尚未接入读取器。

## 旧版快照方案与媒体对照

2026-11-09 实测，Windows、i7-4910MQ、约 16 GiB 内存、SATA SSD，NTQQ 主库 72 MiB。选择两端都有记录的同一群和同一私聊，原生库中分别有 53,023 和 741 条记录。QQ、SnowLuma 和桥接保持运行。每组预热一次，随后串行测五次；下表为中位数，操作系统文件缓存未清空。

| 最近历史 | SnowLuma OneBot WS | qq-bridge 历史接口 | 每次新启动直读 CLI | 复用已校验快照与媒体索引，当前 SQL |
| --- | ---: | ---: | ---: | ---: |
| 群聊 20 条 | 408 ms | 378 ms | 1,927 ms | 402 ms |
| 群聊 100 条 | 1,572 ms | 1,438 ms | 2,059 ms | 438 ms |
| 私聊 20 条 | 125 ms | 253 ms | 1,538 ms | 6 ms |

前三组配对的每一次都返回了请求条数。另测同一私聊请求 100 条，SnowLuma 三次都返回 24 条，耗时 0.50–0.68 秒；这一组不计算等量速度比。OneBot 使用常驻 WebSocket，桥接一列通过控制台只读鉴权单独测量，包含昵称、引用和黑话等加工。两列在不同轮次采样，会受上游波动影响。直读会查本机媒体缓存；表中都没有下载或转换图片，也未调用模型。

**每次直读的固定成本。** 独立分段计时五次，取密钥中位数 142 ms，复制主库和已提交 WAL 为 547 ms，SQLCipher 打开及校验为 611 ms，其中 `quick_check` 占 606 ms。临时文件约 72 MiB。一次分段测试因在线 WAL 持续变化，在五次快照尝试后失败；后续五次分段测试成功，其中复制最长 2.26 秒。当前查询计划显示群聊和私聊均整表扫描，并为排序创建临时 B 树。

**同一份快照内连续翻页。** 另做了内存索引实验，按来源、时间、原生 ID 排序，再按主键从快照读取正文。索引覆盖 77,776 条带有效来源和时间的记录，构建中位数 548 ms，SQLite 页空间为 2.06 MiB。每个场景取连续五页，逐页比对现有读取器，顺序、消息和媒体路径均相同。从空媒体缓存开始，五页群聊各 20 条合计 53 ms，各 100 条合计 86 ms，五页私聊各 20 条合计 30 ms。这些时间从快照和索引就绪开始计算，不含刷新，也不代表快照里已经有最新来信。内存索引只用于本次测量，没有接入运行中的桥接。

**原图字节。** 从同一群中选了 4 张普通图片、4 张图片表情，每个样本需要两端都有原件。大小约 52–1,654 KiB。已取得消息标识且本地媒体目录索引就绪时，首次定位、校验并读出普通原图的中位数为 4.0 ms，图片表情为 1.3 ms。通过 SnowLuma 的 `get_image` 和 QQ 消息图片地址取得对应字节，分别为 92 ms 和 109 ms。每张取三次，24 次返回字节的 MD5 均与本地原图一致。此项不含历史查询和模型图片转码，缓存缺失的文件、视频正文及新消息通知延迟不在该样本中。

离线测试使用自己的 SQLCipher 写入连接，验证仅在 WAL 中的已提交消息、未提交记录不可见、读事务隔离、同秒分页、跨来源游标、源文件内容不变，以及密钥缓存复用与失效重取：

```powershell
.\state\ntqq-reader\venv\Scripts\python.exe -B scripts\test_ntqq_history.py
```
