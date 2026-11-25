# 仓库目录地图

本文描述 `qq-bridge` 仓库中当前可见的目录和脚本类别，不描述仓库外的工作区布局或被 `.gitignore` 排除的本地资料。文档索引见 [README.md](README.md)；后续代码调整默认采用渐进式重构，见 [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) 与仓库根目录 [AGENTS.md](../AGENTS.md)。

## 顶层目录

| 路径 | 用途 |
| --- | --- |
| `src/` | 桥接运行时、DSH/桌面 QQ 独立通道客户端、MCP 服务与独立辅助模块 |
| `dsh/agent-presets/` | 唯一全局 `desktop-agent` preset 及固定前缀模块的权威源 |
| `plugins/` | `qq-agent-presets` bundle：主会话与后台分组 preset patch、旧记忆回顾专用入口 `memory-curator.mjs`、后台模型选择命令 `background-model.mjs`、工具守卫、上下文压缩钩子、DSH 纳管 MCP、`ownerQQ` 设置及可选 Maa-Agent 接入 |
| `public/` | 桥接本地控制台页面（运行总览、主会话、QQ 消息、长期记忆、学习与素材、令牌与花费、系统运维） |
| `roles/` | 可由管理员管理的人格卡；格式见 `roles/README.md` |
| `scripts/` | 离线回归脚本、DSH 安装/核验脚本、桌面 QQ 原生读取器与 Frida 探针、A_Memorix 部署脚本和辅助工具 |
| `docs/` | 使用指南、运行架构和目录说明；见 `docs/README.md` |
| `node_modules/` | 本地依赖，忽略并由 npm 管理 |

根目录的 `config.example.json` 是脱敏配置模板。真实 `config.json`、运行时 `state/` 等数据不属于版本控制内容；不要把它们当作可随意清理的源码目录。

## `src/` 主要边界

| 路径 | 职责 |
| --- | --- |
| `bridge.js` | 运行时组合与协调中心；全局会话生命周期、QQ 注意信号、消息缓冲、控制台和发送门禁仍有较多共享状态，改动时优先小步拆分 |
| `native-qq.js` / `native-reminders.js` | 桌面 QQ 本地通道（Frida 命名管道消息服务 + 常驻 SQLCipher 原库只读查询）与按账号持久化的原生提醒水位存储 |
| `qq-channel-config.js` | QQ 提醒、发送及表情配置的默认值与旧设置迁移 |
| `qq-card.js` | QQ Ark/JSON 卡片消息的安全解析与单行摘要格式化 |
| `qq-message-reference.js` / `qq-image-references.js` | QQ 消息定位（`id:` / `seq:本地序号@缓存标识`）解析，以及已读图片的会话内有界 `imageRef` 登记 |
| `autonomy-policy.js` / `sleep-schedule.js` | 不依赖运行时状态的 QQ 注意信号分类规则，以及桥接本地时区的每日睡眠/起床闹钟计算 |
| `dsh-client.js` / `dsh-diagnostics.js` / `dsh-mcp-management.js` | DSH API/鉴权/事件流客户端、主会话工具错误/图片接纳/模型重试有界诊断，以及 DSH MCP manager 状态订阅、探测与定向重连 |
| `background-sessions.js` | DSH Host 后台分组会话（长期记忆整理、后台学习、商城整包分析）创建、模型选择、持久事件读取与空闲归档 |
| `mcp-qq.js` | `mcp__qq__*` QQ 消息、合并转发、分级看图、表情、戳一戳、当前通道状态及主动休息工具 |
| `mcp-web-search-safe.js` / `web-search.js` / `safe-fetch.js` | 桥接侧安全搜索、网页抓取和 SSRF/DNS rebinding 网络目标校验 |
| `mcp-memory-safe.js` / `a-memorix-gateway.js` / `a-memorix-readonly.js` | A_Memorix Gateway 客户端、受全局 agent token 保护的 DSH 五个记忆工具，以及 WebUI 全量原始段落的本机 SQLite 只读适配器 |
| `memory-curator.js` / `curator-tool-guard.mjs` / `dsh-headless.js` | 存量记忆分组、版本核验、可恢复写入与撤销，无工具回顾守卫，以及后台任务共享的 CLI 和模型选择 |
| `memory-organizer.js` / `memory-organizer-tool-guard.mjs` | 休息后每日独立长期记忆整理队列、DSH 持久事件证据提取（含桌面工具结果压缩）与整理专用工具守卫 |
| `media-normalize.js` / `media-detail.js` / `ffmpeg-resolve.js` / `forward.js` | 预览缩图与 GIF 抽帧拼图、`qq_get_image_detail` 单图原图读取/重编码/EXIF 正向裁剪、通用 FFmpeg 路径解析与合并转发处理 |
| `sticker-lib.js` / `sticker-memory.js` | QQ 账号收藏表情读取/发送辅助，以及表情目录到独立 A_Memorix `qq-bridge-stickers` 空间的语义索引投影 |
| `market-packs.js` / `market-analysis.js` | 腾讯商城表情包目录读取、收录/移除管理，以及整包视觉分析会话调度 |
| `chat-learning.js` / `learning-api.js` / `learning-sessions.js` | 后台黑话/表情学习队列、知识存储与淘汰规则、控制台管理路由及已登记学习会话归档清理 |
| `learning-runner.js` / `learning-tool-guard.mjs` / `mcp-learning-images.js` | DSH 学习执行器（优先 Host `chat-learning` preset，回退隔离 headless）、只允许本批看图的工具守卫与图片 MCP |
| `learning-assets.js` | 本地学习表情与收录商城表情的内容哈希寻址、realpath/SHA-256 读取校验与清理 |
| `sensitive.js` / `md-to-plain.js` | 出站敏感内容判断与 Markdown 转 QQ 纯文本 |
| `token-ledger.js` / `model-catalog.js` / `model-prices.js` | 主会话/记忆整理/后台学习分功能 SQLite 用量账本、models.dev 价格目录缓存与旧 JSONL 账本迁移 |
| `preset-prompt.js` / `desktop-agent-prompt-templates.js` / `qq-model-view.js` | `desktop-agent` 模块化固定前缀读写、运行时提示模板默认值/旧模板升级，以及 QQ 消息的模型视图格式化 |
| `self-test.js` | DSH 侧连通性探针（创建独立测试会话后归档） |

`voice-core.js` 与 `voice-tool-*` 脚本供仓库外的独立语音工具共用，不属于当前桥接运行时。修改前先确认该外部工具的调用关系。

## `scripts/` 类别

| 类别 | 用途 | 注意事项 |
| --- | --- | --- |
| `test-*.mjs` / `test_ntqq_*.py` | 离线回归、契约和边界检查 | 是否纳入总审计清单以 `scripts/test-audit.mjs` 为准；Python 测试验证 NTQQ 原库只读历史与媒体 |
| `test-dsh-*.mjs` / `test-*-dsh.mjs` | DSH 协议、会话队列投影及本机 DSH 隔离集成测试 | 部分 `*-dsh.mjs` 需要本机已安装 DSH（使用临时空 `DSH_HOME`）；执行前查看脚本说明 |
| `setup-dsh.mjs` / `build-agent-preset-patches.mjs` | 生成 preset bundle patch 并安装/更新目标 DSH profile 配置 | `setup-dsh.mjs` 会写入目标 DSH profile，先核对 `<profile>` 参数 |
| `ntqq_*.py` / `ntqq_vfs.c` / `build_ntqq_vfs.py` / `ntqq-probe/*` | Windows 桌面 QQ 独立通道的只读 SQLCipher VFS、常驻历史/媒体读取服务与 Frida 进程内通信/诊断工具 | 依赖 `state/ntqq-reader/venv` 与 `state/ntqq-probe/venv`；`send_test.py` 会真实发消息，勿在离线排查中误跑 |
| `a-memorix.ps1` / `a-memorix-readonly-list.py` | 本机 A_Memorix 部署/启停管理脚本与 WebUI 原始记忆段落 SQLite 只读分页读取器 | 运行数据保存在 `state/a-memorix/` |
| `maa-agent.mjs` / `maa-agent-navigation.patch` | 可选明日方舟 Maa-Agent 模块的安装、诊断与禁用工具 | 按需启用，状态保存在 `state/maa-agent/install.json` |
| `verify-*.mjs` / `scan-dsh-tool-names.mjs` | 配置、persona schema 与 DSH 工具名对账脚本 | `verify-dsh-current.mjs` 会创建真实会话并调用模型，仅在获准在线实测时执行 |
| `probe-*.mjs` | 查询 DSH 的实际协议与连接健康 | 按需执行；读取配置或连入运行服务前检查脚本行为 |
| `evaluate-memory-curator.mjs` / `test-memory-curator.mjs` | 本机存量只读模型评估与离线回归 | 前者调用配置的模型，后者仅用 fixture |
| `console-ui-fixture.mjs` | 控制台离线预览桩服务（`npm run preview:console`） | 纯内存 mock，不读真实 `config.json` 或 `state/` |
| `privacy-scan.mjs` | 发布前隐私与敏感信息扫描（`npm run privacy-scan`） | 提交或发布前必跑 |

`scripts/voice-tool-locator.mjs` 与 `test-voice-*` 面向仓库外的独立语音工具，不是桥接的运行入口。

## 运行数据与文档

- `config.json`、`state/` 和日志由本地运行创建或维护，不要提交真实凭据、消息历史或令牌。
- 文档索引只链接当前仓库实际维护的文档。
- 新会话/代码代理先读 `AGENTS.md`；安全变更再读 `RULES.md` 与 `docs/guides/SECURITY_BASELINE.md`。
