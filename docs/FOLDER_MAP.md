# 仓库目录地图

本文描述 `qq-bridge` 仓库中当前可见的目录和脚本类别，不描述仓库外的工作区布局或被 `.gitignore` 排除的本地资料。文档索引见 [README.md](README.md)；后续代码调整默认采用渐进式重构，见 [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) 与仓库根目录 [AGENTS.md](../AGENTS.md)。

## 顶层目录

| 路径 | 用途 |
| --- | --- |
| `src/` | 桥接运行时、DSH/OneBot 客户端、MCP 服务与独立辅助模块 |
| `dsh/agent-presets/` | 唯一全局 `desktop-agent` preset 的权威源 |
| `plugins/` | DSH preset bundle 与承载 `ownerQQ` 的兼容设置插件 |
| `public/` | 桥接本地控制台页面 |
| `roles/` | 可由管理员管理的人格卡；格式见 `roles/README.md` |
| `scripts/` | 回归脚本、DSH 安装/核验脚本、协议探针和辅助工具 |
| `docs/` | 使用指南、运行架构和目录说明；见 `docs/README.md` |
| `node_modules/` | 本地依赖，忽略并由 npm 管理 |

根目录的 `config.example.json` 是脱敏配置模板。真实 `config.json`、运行时 `state/` 等数据不属于版本控制内容；不要把它们当作可随意清理的源码目录。

## `src/` 主要边界

| 路径 | 职责 |
| --- | --- |
| `bridge.js` | 运行时组合与协调中心；全局会话生命周期、QQ 注意信号、消息缓冲、控制台和发送门禁仍有较多共享状态，改动时优先小步拆分 |
| `autonomy-policy.js` | 不依赖运行时状态的消息唤醒分类规则 |
| `dsh-client.js` | DSH API、鉴权和事件流客户端 |
| `mcp-snowluma-safe.js` / `mcp-host-server.js` | 受限 QQ 工具与只读网关状态工具 |
| `mcp-web-search-safe.js` / `web-search.js` / `safe-fetch.js` | 安全搜索、抓取和网络目标校验 |
| `mcp-memory-safe.js` / `a-memorix-gateway.js` | A_Memorix Gateway 客户端、受全局 agent token 保护的 DSH 记忆工具与共享记忆检索/管理接口 |
| `media-normalize.js` / `ffmpeg-resolve.js` / `forward.js` | 图片媒体转换、通用 ffmpeg 路径解析与合并转发处理 |
| `sticker-lib.js` | QQ 收藏表情数据读取与发送辅助 |
| `state-acl.mjs` / `sensitive.js` | 本地状态目录 ACL 与敏感内容判断 |
| `token-ledger.js` / `model-prices.js` | token 用量统计与价格换算 |
| `role-card.js` / `preset-prompt.js` / `qq-model-view.js` | 角色卡、preset 提示词和 QQ 消息视图处理 |

`voice-core.js` 仍留有旧语音实现，但当前桥接运行时不注册或调用它；不要据此推断语音能力仍受支持。语音功能如需恢复，应按新的需求单独设计。

## `scripts/` 类别

| 类别 | 用途 | 注意事项 |
| --- | --- | --- |
| `test-*.mjs` | 离线回归、契约和边界检查 | 是否纳入总审计清单以 `scripts/test-audit.mjs` 为准 |
| `test-dsh-*.mjs` | DSH 协议与全局会话队列投影检查 | 部分脚本需要正在运行的 DSH；执行前查看脚本说明 |
| `setup-*.mjs` | 安装或更新 DSH profile 配置 | 可能写入用户 DSH profile，先核对目标 profile |
| `verify-*.mjs` | 配置、preset 或 DSH 版本适配核验 | 在线核验可能访问真实 DSH |
| `probe-*.mjs` | 查询 DSH 或 SnowLuma 的实际协议与能力 | 按需执行；读取配置或连入运行服务前检查脚本行为 |
| `patch-*.mjs` | 构建或应用补丁 | `patch-snowluma-sdk.mjs` 是 `postinstall` 依赖，不要随意删除 |

`scripts/` 下仍有 `voice-tool-locator.mjs`、`test-voice-*` 等旧语音工具兼容脚本。它们面向仓库外曾有的独立工具，不代表当前全局 desktop-agent 支持语音；后续清理或重写前不要把它们当作运行入口。

## 运行数据与文档

- `config.json`、`state/` 和日志由本地运行创建或维护，不要提交真实凭据、消息历史或令牌。
- 只信任当前存在的文档链接。被 `.gitignore` 排除的旧设计、审计笔记不在仓库文档索引中。
- 新会话/代码代理先读 `AGENTS.md`；安全变更再读 `RULES.md` 与 `docs/guides/SECURITY_BASELINE.md`。
