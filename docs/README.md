# 文档索引

> 本索引只列当前仓库中实际存在、可以取得的文档；被 `.gitignore` 排除的本地笔记不再作为链接列出。
> 当前运行时与权限边界以根目录 [README.md](../README.md)、[RULES.md](../RULES.md) 为准；代码代理改动指引见 [AGENTS.md](../AGENTS.md)。

## 项目入口

| 文档 | 用途 |
| --- | --- |
| [README.md](../README.md) / [README.en.md](../README.en.md) | 项目概览、架构、安装、配置与运行说明 |
| [RULES.md](../RULES.md) | QQ 会话的权限边界与安全承诺 |
| [AGENTS.md](../AGENTS.md) | 给代码代理的仓库级约束，指导其渐进式修改 |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 当前仓库目录与脚本类别说明 |

## 当前使用与维护指南

| 文档 | 用途 |
| --- | --- |
| [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) | 当前会话运行模型、代码结构评估与渐进式重构原则 |
| [guides/MEMORY_ARCHITECTURE.md](guides/MEMORY_ARCHITECTURE.md) | 长期记忆目标、MaiBot/A_Memorix 对齐方式、调用与上下文职责 |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | 将唯一的 `desktop-agent` preset 和 MCP 工具安装到 DSH |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全机制、残余风险与安全相关改动的工程基线 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 发布前隐私扫描方法与历史扫描记录 |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台令牌与花费看板的数据来源和口径 |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览与 UI 回归说明 |

## 历史兼容性记录

| 文档 | 范围 |
| --- | --- |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | 2026-10-22 对 DSH 0.2.1-rc.2 的适配快照；其中的双 preset 清单是历史状态，不应当作当前安装说明 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | DSH 0.2.0-rc.2 适配历史；不作为当前运行手册 |
| [../roles/README.md](../roles/README.md) | 角色卡格式及旧标记兼容说明 |

## 按任务查找

| 我想…… | 看这个 |
| --- | --- |
| 了解当前架构，决定怎么整理代码 | [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) |
| 了解长期记忆设计与实施边界 | [guides/MEMORY_ARCHITECTURE.md](guides/MEMORY_ARCHITECTURE.md) |
| 安装或重装 DSH 侧配置 | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 修改安全边界或做安全审查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) 和 [../RULES.md](../RULES.md) |
| 核对仓库内某个目录或脚本的用途 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 查看 token 消耗与计价方式 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 修改控制台并了解 UI 回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
