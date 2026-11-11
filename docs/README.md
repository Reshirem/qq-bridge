# 文档索引

> 本索引只列当前仓库中实际维护的文档。
> 当前运行时与权限边界以根目录 [README.md](../README.md)、[RULES.md](../RULES.md) 为准；代码代理改动指引见 [AGENTS.md](../AGENTS.md)。

## 项目入口

| 文档 | 用途 |
| --- | --- |
| [README.md](../README.md) | 项目概览、架构、安装、配置与运行说明 |
| [RULES.md](../RULES.md) | 全局数字角色会话、电脑操作与 QQ 工具的权限边界 |
| [AGENTS.md](../AGENTS.md) | 给代码代理的仓库级约束，指导其渐进式修改 |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 当前仓库目录与脚本类别说明 |
| [guides/PROJECT_AUDIT.md](guides/PROJECT_AUDIT.md) | fork 来源、当前功能清单、离线核验结果与未覆盖风险 |

## 当前使用与维护指南

| 文档 | 用途 |
| --- | --- |
| [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) | 当前会话运行模型、代码结构评估与渐进式重构原则 |
| [guides/NTQQ_HISTORY.md](guides/NTQQ_HISTORY.md) | Windows QQ 原生消息库只读实验、运行命令、覆盖差异和接入条件 |
| [guides/NTQQ_ATTENTION.md](guides/NTQQ_ATTENTION.md) | Windows 独立通道的新装、取钥与导入、运行状态核对及提醒实测 |
| [guides/NTQQ_SEND.md](guides/NTQQ_SEND.md) | 桌面 QQ 进程内观察器的运行方法、原生收发验证及参考项目许可证 |
| [guides/MEMORY_ARCHITECTURE.md](guides/MEMORY_ARCHITECTURE.md) | 长期记忆目标、MaiBot/A_Memorix 对齐方式、调用与上下文职责 |
| [guides/CHAT_LEARNING.md](guides/CHAT_LEARNING.md) | 黑话记录、表情包后台学习、来源范围、资源限制与验证 |
| [guides/MAA_AGENT.md](guides/MAA_AGENT.md) | 安装、验证或禁用可选的明日方舟游戏工具 |
| [guides/COMPANION_PROMPT_MEMORY_PLAN.md](guides/COMPANION_PROMPT_MEMORY_PLAN.md) | 数字角色聊天、隐私、记忆和上下文压缩改进计划与进度 |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | 桌面版与 Web 版安装、旧版迁移、原会话工具验收及可选模块入口 |
| [../roles/README.md](../roles/README.md) | 人格卡格式与编辑说明 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全机制、残余风险与安全相关改动的工程基线 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 发布前隐私扫描方法 |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台令牌与花费看板的数据来源和口径 |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览与 UI 回归说明 |

## 按任务查找

| 我想…… | 看这个 |
| --- | --- |
| 了解当前架构，决定怎么整理代码 | [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) |
| 了解长期记忆设计与实施边界 | [guides/MEMORY_ARCHITECTURE.md](guides/MEMORY_ARCHITECTURE.md) |
| 讨论数字角色提示、跨聊天隐私与记忆后续计划 | [guides/COMPANION_PROMPT_MEMORY_PLAN.md](guides/COMPANION_PROMPT_MEMORY_PLAN.md) |
| 在新机器上部署 QQ 与 DSH | [完整启动流程](../README.md#完整启动流程从零开始) · [独立 QQ 依赖](guides/NTQQ_ATTENTION.md#新机器安装) |
| 从旧工具名升级并保留角色会话 | [从旧版升级](guides/DSH_SETUP.md#从旧版升级) |
| 安装或重装 DSH 侧配置 | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 修改安全边界或做安全审查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) 和 [../RULES.md](../RULES.md) |
| 核对仓库内某个目录或脚本的用途 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 区分 fork 前原作者与后续新增功能，查看尚未验证的风险 | [guides/PROJECT_AUDIT.md](guides/PROJECT_AUDIT.md) |
| 查看 token 消耗与计价方式 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 修改控制台并了解 UI 回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
