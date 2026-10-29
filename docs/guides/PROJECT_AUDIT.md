# 项目功能与 fork 来源审计

审计快照：本地 `HEAD=5e940ea`，日期 2026-10-29。本文按 Git 历史、当前注册入口、路由和回归检查整理；它用于区分来源与验证边界，不等同于对真实 QQ、DSH 或本机安装的在线验收。

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
| `src/state-acl.mjs` | 140 | 0 | 本机状态目录权限处理主要继承 |
| `src/a-memorix-gateway.js` | 0 | 244 | fork 后新增的记忆 Gateway 客户端 |
| `src/mcp-memory-safe.js` | 0 | 142 | fork 后新增的 DSH 记忆工具注册 |
| `public/console.html` | 352 | 312 | 原控制台界面经过大量 fork 后扩展 |
| `public/console.js` | 0 | 2,545 | 当前脚本由 fork 后的控制台重构维护 |

## 当前功能按来源整理

| 功能 | 当前入口/模块 | 来源与现状 |
| --- | --- | --- |
| QQ OneBot 收发、消息缓冲、会话历史和主动发送 | `src/bridge.js`、`src/mcp-snowluma-safe.js` | 主要继承原作者实现，fork 后改成单一全局陪伴者凭证与消息视图；当前群聊普通消息只缓冲，提醒仅传元数据 |
| DSH API、认证和事件流 | `src/dsh-client.js` | 主要继承；当前由 fork 后的全局会话控制器统一调用 |
| 搜索、外部网页抓取和 SSRF 防护 | `src/web-search.js`、`src/safe-fetch.js`、`src/mcp-web-search-safe.js` | 搜索与网络安全基础主要继承；MCP 接入和当前全局会话的使用方式由 fork 后维护 |
| 图片、转发、收藏表情与 FFmpeg 归一化 | `src/media-normalize.js`、`src/forward.js`、`src/sticker-lib.js`、`src/ffmpeg-resolve.js` | 原有媒体/表情能力仍在，fork 后修过图片读取、发送和 Windows FFmpeg 路径 |
| SnowLuma 连接发现、token 用量账本、安全与 ACL | `src/snowluma-conn.js`、`src/token-ledger.js`、`src/state-acl.mjs` 等 | 以继承模块为主，fork 后增加或调整了状态保护、成本展示与错误处理 |
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
- `voice-core.js`、`voice-tool-*`：目录地图标注为仓库外独立语音工具共用代码，不属于当前桥接运行入口；清理前仍需查外部调用方。

## 审计结果与尚未验证的面

### 已确认

- 离线 fixture/mock 回归 `node scripts/test-audit.mjs` 在本次审计前为 24/24 通过；其中提示词契约断言滞后于当前文案，协议超时测试没有保活 Node 事件循环。本次修正了这两项测试，并增加 DSH 模块定位、记忆浏览 HTTP 边界与 SQLite 只读账本 fixture 回归，最终结果为 26/26 脚本通过。
- `rg` 未在 `src/`、`scripts/`、`plugins/`、`public/` 和 `docs/` 找到 `TODO`、`FIXME`、`XXX` 或 `HACK` 标记；这不代表没有遗漏，只说明源码没有显式挂出的待办标签。
- 当前 WebUI 的原始记忆浏览路由可被控制台令牌调用，合法全局 agent token 被默认端点白名单拦截；回归检查只替换了 SQLite 读取函数，不连接真实 A_Memorix。
- 先前安全文档和代码注释误称发送要求当前 DSH 回合有效、控制台支持 URL `?token=`，并提到已不存在的旧只读工具。本次已将这几处描述改为当前行为。
- DSH profile 模块定位不再把普通 `js-yaml` 当作 DSH 安装的证据；它要求能从 profile `node_modules` 解析到 `@deepseek-ai/dsh-persona`，并有 fixture 检查。但这只适用于模块以独立包形式安装在 profile `node_modules` 的布局，不适用于把 bundle 打进桌面应用 `app.asar` 的布局。
- `setup-dsh.mjs` 支持任意 profile，但在线核验脚本曾固定读取 `profiles/web`。本次改为跟随 `<profile>` 参数或 `DSH_PROFILE`，同时校验 profile 名称，避免检查错 profile 或接受路径穿越输入。

### 仍是核验缺口，不是已确认的运行故障

1. **当前工具名扫描器不能读取 DSH Desktop 内置 bundle。** 本机 DSH Desktop 版本为 `44.7.0`。`C:\Users\Reshirem\.dsh\profiles\desktop\package.json` 注册了 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` 等 bundle；profile `node_modules` 里有 `dshmarket`、`dsh-computer-use-win` 和 `qq-agent-presets`，但没有独立的 `@deepseek-ai` 包目录。桌面安装的 `resources\app.asar` 中可检索到 `@deepseek-ai/dsh-tool-pwsh`、`@deepseek-ai/dsh-tool-bash`、`@deepseek-ai/dsh-tool-fs`、`@deepseek-ai/dsh-tool-terminal`、`@deepseek-ai/dsh-tool-session-query`、`@deepseek-ai/dsh-tool-subagent`、`@deepseek-ai/dsh-tool-web` 等包名引用。这能确认包名线索，却不能证明每个包在运行时注册了哪些工具名。现有 `dshModulesDir()`、`verify:persona` 和 `scan:tool-names` 只读取独立的 profile `node_modules`，因此这次不能据它们判断 DSH 44.7.0 的真实工具注册表，也不能确认守卫覆盖了该版本全部工具。下一步需要给扫描器增加 `app.asar` 支持，或取得可扫描的解包模块目录；在此之前，守卫与 DSH 工具名的版本对账仍属未完成。
2. **没有连接真实 QQ / SnowLuma，也没有跑在线 DSH 生命周期核验。** 26/26 离线回归使用模拟接口，不代表网关登录、事件订阅、真实发送和在线生命周期全部已验收。`npm run verify:dsh` 会创建临时 workspace/session 后归档，这次没有运行。
3. **真实 A_Memorix schema/Gateway 尚未联调。** `scripts/a-memorix-readonly-list.py` 已通过临时 SQLite fixture 的分页、来源/时间/关键词过滤、LIKE 转义、storage key 越界拒绝及数据库摘要不变检查；fixture 使用读取器要求的当前列结构，不证明用户实际安装的 A_Memorix 版本结构兼容。系统 PATH 没有 Python 命令，但仓库内 A_Memorix venv 可用于该 fixture。
4. **提醒队列缺少端到端时间测试。** 唤醒分类有纯函数测试，消息水位与 MCP schema 有协议测试；“进入休息后等一分钟、只补发一次、退避态不补发”的完整计时器状态流目前没有单独 fixture 测试。
5. **ACL 的真实系统行为仍未自动化。** [安全基线](SECURITY_BASELINE.md) 已注明 `icacls`/UAC 行为需要在普通 Windows 终端手动检查；离线回归只做结构断言。

### 使用时要知道的设计边界

全局陪伴者可以枚举当前 QQ 账号的群/好友，并通过合法的 `group:<数字>`、`private:<数字>` key 读取或发送；这是从原来的逐 QQ session 改成单一全局 session 后的行为，不是残留的白名单错误。桥接 API 仍有限频与内容审计，但 computer-use 通过 QQ 图形界面的动作不经过这些 API 检查。相关边界见 [安全基线](SECURITY_BASELINE.md) 与 [运行架构](ARCHITECTURE.md)。

`src/bridge.js` 同时拥有 QQ 消息状态、提醒队列、DSH 生命周期、WebUI API 和出站策略，仍是最大维护风险；目前它不是一处孤立的旧代码，而是多个 fork 后功能的共享协调点。继续拆分时应先为提醒计时器与 A_Memorix 只读读取器补齐 fixture 验证，再逐步抽离职责。
