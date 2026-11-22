# 项目功能与 fork 来源审计

审计快照：本地 `HEAD=5e940ea`，日期 2026-10-29。本文按 Git 历史、当前注册入口、路由和回归检查整理；它用于区分来源与验证边界，不等同于对真实 QQ、DSH 或本机安装的在线验收。

后续维护说明：
- 2026-11 之后已新增桌面 QQ 独立通道（`src/native-qq.js`、`src/native-reminders.js`，默认 `qqBackend: "native"`），并将原 `src/mcp-snowluma-safe.js` 扩展重命名为双后端共用的 `src/mcp-qq.js`；同时新增后台黑话/表情学习、商城表情包收录、独立记忆整理、分级看图（`qq_get_image_detail`）、每日睡眠闹钟与 DSH 纳管 MCP 等模块。当前完整模块地图见 [../FOLDER_MAP.md](../FOLDER_MAP.md)。
- 2026-11-16 已移除自动 ACL 收紧、提权、目录权限告警及 ACL 命令入口；下表的 ACL 模块行保留为该审计快照的来源记录，不表示当前仍有这一模块。当前文件权限行为见[安全基线](SECURITY_BASELINE.md#6-现有文件权限与测试目录)。

## Fork 边界与贡献者

本地历史显示，`a49877f4e58d04e47532d44b803360d0f001160d`（Derpyu520，2026-10-22，`v0.2.1-r1`）是 fork 前的父提交；首个 Reshirem 提交是 `9c7834f`（2026-10-27，`refactor: unify QQ bridge on autonomous session runtime`）。这比按文件名推测来源可靠：许多原文件后来被 fork 改写或扩展。

以下是当前 HEAD 的 `git blame` 行数快照，表示每行最后一次被哪位作者改动，**不等于整项功能的唯一作者**：

| 当前文件 | Derpyu520 最后改动行 | Reshirem 最后改动行 | 说明 |
| --- | ---: | ---: | --- |
| `src/bridge.js` | 5,349 | 2,628 | 混合最多；原来的 QQ/控制台/发送逻辑仍在，fork 后又重做了全局会话和调度 |
| `src/dsh-client.js` | 805 | 92 | DSH 客户端主要继承，fork 后有认证和会话接线调整 |
| `src/mcp-snowluma-safe.js` | 766 | 172 | QQ MCP 工具以原有功能为底，fork 后适配全局凭证与新会话行为 |
| `src/snowluma-conn.js` | 213 | 2 | 连接发现逻辑几乎全部继承 |
| `src/web-search.js` | 495 | 1 | 搜索模块几乎全部继承 |
| `src/safe-fetch.js` | 385 | 0 | SSRF 防护与安全抓取主要继承 |
| `src/token-ledger.js` | 958 | 0 | 用量账本主要继承 |
| `src/state-acl.mjs`（已移除） | 140 | 0 | 本机状态目录权限处理主要继承；此行为与模块已于 2026-11-16 移除 |
| `src/a-memorix-gateway.js` | 0 | 244 | fork 后新增的记忆 Gateway 客户端 |
| `src/mcp-memory-safe.js` | 0 | 142 | fork 后新增的 DSH 记忆工具注册 |
| `public/console.html` | 352 | 312 | 原控制台界面经过大量 fork 后扩展 |
| `public/console.js` | 0 | 2,545 | 当前脚本由 fork 后的控制台重构维护 |

## 当前功能按来源整理

| 功能 | 当前入口/模块 | 来源与现状 |
| --- | --- | --- |
| QQ OneBot 收发、消息缓冲、会话历史和主动发送 | `src/bridge.js`、`src/mcp-snowluma-safe.js` | 主要继承原作者实现，fork 后改成单一全局数字角色凭证与消息视图；当前群聊普通消息只缓冲，提醒仅传元数据 |
| DSH API、认证和事件流 | `src/dsh-client.js` | 主要继承；当前由 fork 后的全局会话控制器统一调用 |
| 搜索、外部网页抓取和 SSRF 防护 | `src/web-search.js`、`src/safe-fetch.js`、`src/mcp-web-search-safe.js` | 搜索与网络安全基础主要继承；MCP 接入和当前全局会话的使用方式由 fork 后维护 |
| 图片、转发、收藏表情与 FFmpeg 归一化 | `src/media-normalize.js`、`src/forward.js`、`src/sticker-lib.js`、`src/ffmpeg-resolve.js` | 原有媒体/表情能力仍在，fork 后修过图片读取、发送和 Windows FFmpeg 路径 |
| SnowLuma 连接发现、token 用量账本、安全与旧版 ACL | `src/snowluma-conn.js`、`src/token-ledger.js`；审计时还包括现已移除的 `src/state-acl.mjs` | 以继承模块为主，fork 后增加或调整了状态保护、成本展示与错误处理；自动 ACL 策略已于 2026-11-16 移除 |
| 全局自主会话、生命周期和恢复 | `src/bridge.js`、`src/autonomy-policy.js`、`dsh/agent-presets/desktop-agent/` | fork 后新增/重写：由 WebUI 任务、DSH 输入、QQ 提醒共同唤醒一个 `desktop-agent`；`agent_rest` 结束当前回合，但不限制休息后的工具调用 |
| QQ 唤醒 | `src/autonomy-policy.js`、`src/bridge.js` | fork 后整理：私聊、发给机器人的原生 @、验证过的回复/引用、配置关键词，以及**当前选中人格卡**名称；普通群消息正文不自动交给模型 |
| 未处理提醒 | `src/bridge.js` | fork 后新增：消息未被连续读取水位覆盖时，进入休息后全局每分钟检查一次，最多补发一次；指数退避恢复期间不检查 |
| DSH 提示词与 preset 守卫 | `dsh/agent-presets/desktop-agent/`、`plugins/qq-agent-presets/`、`src/desktop-agent-prompt-templates.js` | fork 后新增/重组：模块化固定前缀、运行时模板、`desktop-agent` 工具限制；不再按 QQ 群映射多个 DSH agent |
| A_Memorix 长期记忆 | `src/a-memorix-gateway.js`、`src/mcp-memory-safe.js`、`src/a-memorix-readonly.js` | fork 后新增：Gateway 搜索/写入/读取/删除工具与控制台管理；原始段落浏览走 Python SQLite 只读适配器 |
| WebUI 管理和观察 | `public/`、`src/bridge.js` | 原控制台为底，fork 后扩展全局会话、人格卡、提示词、长期记忆和成本页面 |

## 当前不存在或已从主流程移除的旧功能

- 逐群/逐私聊 DSH session 映射和各来源 agent token：被单一全局 `desktop-agent` 取代。
- `qq-mode-console` 的独立运行入口：当前 preset 与设置接在 `qq-agent-presets`。
- QQ 聊天命令、中文短语拦截和静默模式：当前主流程不注册或解析这些命令。
- 默认头像图片推断：当前不再根据 `assets/deepseek娘.png` 指定人物外观。
- 旧版本兼容分支：最近的 fork 提交 `5e940ea` 清理了已不用的兼容代码。
- 旧接口 `/api/authorize/read`：代码仓库中没有当前 MCP 调用方；本次审计将孤立路由和 agent allowlist 项移除。
- 自动 ACL 收紧：2026-11-16 移除了启动提权、配置写入时收紧临时文件、目录权限告警与相关命令入口；更新不会主动恢复现有磁盘权限的继承。
- `voice-core.js`、`voice-tool-*`：目录地图标注为仓库外独立语音工具共用代码，不属于当前桥接运行入口；清理前仍需查外部调用方。

## 审计结果与尚未验证的面

### 已确认

- 离线 fixture/mock 回归 `node scripts/test-audit.mjs` 在本次审计前为 24/24 通过；其中提示词契约断言滞后于当前文案，协议超时测试没有保活 Node 事件循环。本次修正了这两项测试，并增加 DSH 模块定位、记忆浏览 HTTP 边界与 SQLite 只读账本 fixture 回归，最终结果为 26/26 脚本通过。
- `rg` 未在 `src/`、`scripts/`、`plugins/`、`public/` 和 `docs/` 找到 `TODO`、`FIXME`、`XXX` 或 `HACK` 标记；这不代表没有遗漏，只说明源码没有显式挂出的待办标签。
- 当前 WebUI 的原始记忆浏览路由可被控制台令牌调用，合法全局 agent token 被默认端点白名单拦截；回归检查只替换了 SQLite 读取函数，不连接真实 A_Memorix。
- 先前安全文档和代码注释误称发送要求当前 DSH 回合有效、控制台支持 URL `?token=`，并提到已不存在的旧只读工具。本次已将这几处描述改为当前行为。
- DSH profile 模块定位不再把普通 `js-yaml` 当作 DSH 安装的证据；它要求能从 profile `node_modules` 解析到 `@deepseek-ai/dsh-persona`，并有 fixture 检查。但这只适用于模块以独立包形式安装在 profile `node_modules` 的布局，不适用于把 bundle 打进桌面应用 `app.asar` 的布局。
- `setup-dsh.mjs` 支持任意 profile，但在线核验脚本曾固定读取 `profiles/web`。本次改为跟随 `<profile>` 参数或 `DSH_PROFILE`，同时校验 profile 名称，避免检查错 profile 或接受路径穿越输入。

### 2026-10-29 审计时的核验缺口与后续解决状态

1. **桌面版 `app.asar` 模块解析与工具名扫描**
   - **已解决（压缩与 LLM 共享模块）**：2026-11 新增 `plugins/qq-agent-presets/dsh-host-modules.mjs` 与 `scripts/test-compaction-host-modules.mjs`、`scripts/test-compaction-dsh.mjs`，直接从当前 DSH 宿主/CLI 运行入口（含桌面版 `resources/app.asar`）动态解析 `dsh-compaction-basic` 与 `dsh-llm` 共享类实例，不再依赖 profile 下的独立 `@deepseek-ai` 包目录。
   - **仍需注意（静态工具名扫描器）**：`scripts/scan-dsh-tool-names.mjs` 仍面向解包后的 `@deepseek-ai` 模块目录（可通过 `DSH_TOOL_PACKAGES` 指定），不会直接解包扫描桌面版 `app.asar`。
2. **在线 QQ / DSH 实机回归与离线回归套件的边界**
   - 离线回归 `node scripts/test-audit.mjs` 已从审计时的 26 个脚本扩展至 **52 个脚本**（覆盖双 QQ 后端、合并转发、图片分级/裁剪、戳一戳收发、睡眠命令与每日睡眠闹钟、后台黑话/表情学习、独立记忆整理、MCP manager 纳管、令牌账本等），另有 `scripts/test-compaction-dsh.mjs`、`scripts/test-managed-mcp-dsh.mjs`、`scripts/test-background-presets-dsh.mjs` 使用本机安装的 DSH 在临时空 `DSH_HOME` 中做隔离集成验证。
   - 连接真实登录 QQ 账号或发起真实模型调用的脚本（如 `npm run verify:dsh`、`scripts/ntqq-probe/send_test.py`）属于有副作用的在线验收，不在默认离线测试中自动运行。
3. **A_Memorix 原始账本只读适配器版本兼容**
   - `scripts/a-memorix-readonly-list.py` 已由 `scripts/test-a-memorix-readonly.mjs` 覆盖分页、来源/时间/关键词过滤、LIKE 转义、storage key 越界拒绝及数据库摘要不变检查，并与固定部署的 A_Memorix `v2.0.0a4` 对齐；若未来升级上游 A_Memorix 版本，仍需重新核对 `paragraphs` 表结构。
4. **提醒队列与未读补提醒计时器测试（已补齐）**
   - 审计时缺失的“进入休息后每分钟检查一次、每条未读最多补发一次、异常退避态不补发、正常结束漏调 `agent_rest` 首次立即提醒后递增退避”端到端时间状态流，已由 `scripts/test-attention-delivery.mjs` 与 `scripts/test-poke-reminders.mjs` 完整覆盖。
5. **自动 ACL 策略（已移除）**
   - 2026-11-16 已彻底移除启动与配置保存时的自动 `icacls` / UAC 提权逻辑，并由 `scripts/test-audit-setup-guards.mjs` 守护。

### 使用时要知道的设计边界

全局数字角色可以枚举当前 QQ 账号的群/好友，并通过合法的 `group:<数字>`、`private:<数字>` key 读取或发送；这是从原来的逐 QQ session 改成单一全局 session 后的行为，不是残留的白名单错误。桥接 API 执行内容审计，但 computer-use 通过 QQ 图形界面的动作不经过这些 API 检查。相关边界见 [安全基线](SECURITY_BASELINE.md) 与 [运行架构](ARCHITECTURE.md)。

`src/bridge.js` 同时拥有 QQ 消息状态、提醒队列、DSH 生命周期、WebUI API 和出站策略，仍是最大维护风险；目前它不是一处孤立的旧代码，而是多个 fork 后功能的共享协调点。继续拆分时应先为提醒计时器与 A_Memorix 只读读取器补齐 fixture 验证，再逐步抽离职责。
