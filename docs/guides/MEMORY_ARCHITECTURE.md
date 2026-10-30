# 长期记忆方案

本文记录 qq-bridge 长期记忆的已对齐目标、首期实现和运行边界。关于数字角色提示、记忆整理与摘要模板的后续讨论，见 [数字角色提示、隐私与长期记忆改进计划](COMPANION_PROMPT_MEMORY_PLAN.md)。

## 目标

qq-bridge 使用一个跨电脑活动与 QQ 的共享长期记忆空间。QQ 是内容来源之一，数字角色自身的行动、发现和经历也是内容来源。群聊或私聊不会各自拥有独立的 DSH 会话或记忆库。

记忆来源只分为两类：

- `qq`：数字角色实际读取过的 QQ 内容，且数字角色判断值得保存后主动调用记忆工具。
- `assistant`：数字角色对自身经历、行动、发现、问题和结果的记录，由数字角色自行判断是否保存。该值是现有数据格式中的来源标记，不限定人格形态。

来源类别用于说明信息从哪里来，不等同于事实可信度。固定前缀引导数字角色记录涉及 QQ 的内容时，在正文和 `sourceContext` 中尽量注明具体群或私聊及相关说话人；引用他人说法时仍要明确归属，不能把转述自动写成已确认事实。`qq` 来源类别本身不区分不同的群或私聊，旧记录也不会自动补上来源；当前检索和共享上下文没有按群隔离。QQ 正文不会仅因收到、被提及或缓存在桥接中就自动进入长期记忆。

## 存储与运行架构

采用 MaiBot 集成 A_Memorix 的总体思路：结构化元数据和记忆正文作为可追溯记录保存；语义向量和关系图用于检索；Episode 与人物画像是从证据派生的整理结果。存储空间在运行时固定为一个全局 namespace，来源字段使用上述 `qq` / `assistant` 两个值。

MaiBot 源码中的 A_Memorix 宿主接入依赖 MaiBot 自己的服务和数据库。本项目复用其长期记忆架构与公开接口，不直接复制 MaiBot 的宿主集成代码。当前代码面向独立的 A_Memorix 2.x HTTP/JSON Gateway；MaiBot 项目内的旧版插件/数据目录不是这个 Gateway，不能直接填入配置，也不会自动迁移。若要复用 MaiBot 现有数据，需先按 A_Memorix 提供的正式导入/迁移接口处理。底层记忆服务应是唯一的存储所有者；DSH 工具、会话启动摘要和 WebUI 访问同一份数据。记忆写入仍由 Gateway 负责，WebUI 为完整浏览原始记录增加了受限的只读账本读取路径。

```text
DSH 全局会话
  └─ 按需调用记忆工具
       └─ qq-bridge 的 MCP/API 适配层
            └─ A_Memorix 记忆运行时与唯一持久存储

主会话成功 agent_rest ── qq-bridge 持久队列 ── DSH headless 整理会话 ── 同一记忆工具/API

新会话启动 ── qq-bridge 查询精简记忆 ── 注入一次
WebUI      ── qq-bridge 管理 API   ── 浏览、编辑、取代或删除
```

运行时按本机 A_Memorix HTTP/JSON Gateway 接口访问服务。DSH 的 `mcp-memory-safe.js` 工具经桥接 API 转发到 Gateway；会话启动摘要和 WebUI 的搜索、读取、写入、替代与删除也由桥接访问同一个 namespace。WebUI 的“浏览全部”专用读取器按 namespace 映射定位 metadata SQLite，以只读连接分页读取活动原始段落；它不修改数据、不接触向量库或图文件，也不提供给 DSH agent-call。

A_Memorix 的独立服务单独运行，Gateway 与 gRPC 服务只监听本机回环。Windows 部署脚本固定使用官方 `v2.0.0a4` wheel 和 Gateway 发布文件，并校验 SHA-256；运行文件、Python 虚拟环境、密钥、数据和日志保存在 qq-bridge 的 `state/a-memorix/`，不需要 clone 上游源码或添加 submodule。部署脚本安装 `[rpc,observability,vector]`，其中 `vector` 提供 Windows 可用的 `faiss-cpu`；Embedding 配置使用每批 16 条以符合当前服务每批最多 20 条的限制。默认 namespace 开启 metadata-only 写入和 sparse 检索；没有配置 Provider 时不会产生外部模型调用，但也没有语义向量和自动关系抽取。项目不得为了工具进程和 WebUI 分别启动两个共享数据目录的 A_Memorix 写入者。

上游 A_Memorix 2.x 目前仍标为 alpha。部署版本及发行文件校验值记录在 `scripts/a-memorix.ps1`；升级前应核对上游版本与 Gateway 协议并一并更新固定校验值。本项目只依赖 HTTP/JSON 公共接口，不捆绑或复制 A_Memorix 服务端源码。桥接侧的 namespace API key 只从不入库的 `config.json` 读取，不传给模型，也不写入工具调用参数日志。

## 谁决定保存和检索

主 DSH 会话负责判断何时自行调用记忆工具。另有项目侧的独立整理流程：主会话成功调用 `agent_rest` 后，qq-bridge 按配置时区每天最多排队一次；该次会整理到当天触发的休息边界，之后新产生的内容会在下一个可触发日接续处理。桥接按持久队列读取 DSH 会话中已记录的可见消息和成功工具结果，再启动专用 headless DSH 会话判断是否有值得保存的内容。首次启用长期记忆后，桥接会补查当前会话尚未排队的成功休息边界。整理器只使用主会话实际读到并留在 DSH 记录中的证据，不扫描 QQ 消息库。它可以选择不写入；不会逐条自动归档 QQ 消息，也不会每个回合无条件写一条摘要。

- QQ 记忆只从数字角色已经读取的内容中选择；数字角色通过记忆工具明确提交后才保存。
- 数字角色自身经历由其自主选择记录。提示应给宽泛、非穷尽的方向，不要求每项任务都写记忆，也不把可记忆内容限制在固定清单中。
- 数字角色可以按需搜索、读取和维护记忆。交流涉及过去的共同经历、约定或偏好，或对方提到“上次”“还记得吗”等内容时，固定前缀和 `memory_search` 工具说明会引导它结合当前话题、人物和场景主动检索，必要时读取原记录并核对来源；这不要求每条消息都查。收到 QQ 提醒本身不强制触发记忆检索或保存。
- 工具参数可提供自然语言记忆内容和可选的关联元数据；来源标记应由可信的工具调用上下文限制为 `qq` 或 `assistant`，不允许写入任意来源类别。`assistant` 是现有数据格式中的来源值，表示数字角色自身经历，不规定它的人格形态。

## 新会话启动上下文

每个新建或重建的全局 DSH 会话，在第一次工作提示中得到一份精简摘要，内容优先包括：

- 数字角色近期有价值的经历、尝试结果和发现；
- 仍未完成或需要继续跟进的事项；
- 少量长期稳定且对当前工作有帮助的用户或项目偏好。

QQ 联系人或群聊记忆按当前任务和对象按需检索，不把所有 QQ 记忆一并注入。摘要只在新会话首次引导时注入，不在每轮重复注入。单一 DSH 全局会话、停止/休息/异常恢复规则保持不变。

## WebUI 管理

WebUI 管理同一个长期记忆空间，侧栏按“长期记忆”归组，并拆为“检索与记录”和“设置”两个入口。检索与记录页提供按时间检索、关键词搜索、按来源筛选、查看记录和证据、编辑、标记被新记录取代，以及删除；设置页管理 Gateway 连接、首次会话摘要和 Embedding / LLM Provider。界面操作经桥接管理 API 访问后端；DSH 使用独立的 MCP 工具，不获得 WebUI 管理令牌。

检索模式按输入自动选择：只有关键词时使用 `SEARCH`，只有时间范围时使用 `TIME`，关键词和时间范围同时提供时使用 `HYBRID`。A_Memorix 要求 `TIME` 与 `HYBRID` 至少提供一个起止边界；控制台会在请求前提示无效的空范围，避免 Gateway 返回参数错误。未选择日期的关键词搜索不再错误地请求 `HYBRID`。

界面与 MaiBot 当前的 A_Memorix 记忆模型保持一致：原始记录作为可追溯证据，关系、Episode 和人物画像属于整理与召回视图。qq-bridge 当前客户端实际使用 Gateway 的记录写入、检索、按 ID 读取和删除接口；`SEARCH`、`TIME`、`HYBRID`、`EPISODE`、`AGGREGATE` 是检索模式，不代表对应的管理接口也已开放。MaiBot WebUI 的管理路由依赖 MaiBot 宿主服务，不属于独立 Gateway 接口。

修改事实时以新记忆记录替代旧记录并保留来源和变更关系。删除操作应由后端完成，并同步清理由正文派生的索引或关联；不能只从界面隐藏一条记录。

目前已使用的 A_Memorix Gateway 记忆接口没有独立的“列出全部记忆”操作。WebUI 的相关度检索仍受 Gateway 返回条数限制；“浏览全部”通过独立只读适配器分页读取活动原始段落，按事件时间或创建时间倒序排列，并可按正文、来源和时间筛选。这个列表不包含已删除段落，也不把关系、Episode、人物画像等派生对象混入原始记录列表。

只读账本适配器从 A_Memorix 控制数据库读取当前 namespace 的 storage key，并限制路径位于配置的数据目录；查询固定在 `paragraphs` 表、使用参数化 SQL、每页最多 100 条。连接启用 SQLite `mode=ro` 和 `query_only`，缺少必需表或列时拒绝读取并提示检查版本兼容性。此接口只接受控制台鉴权，不进入 agent-call 白名单。所有写入仍走 Gateway。

“浏览全部”不是额外安装的 Python 应用，也不需要手动启动脚本。桥接会自动调用仓库内的 `scripts/a-memorix-readonly-list.py`，复用 `scripts/a-memorix.ps1 setup` 创建的 `state/a-memorix/venv/Scripts/python.exe`；该部署本身要求 Python 3.12+，读取器只使用 Python 标准库，不需要额外 `pip install`。它读取本项目 `state/a-memorix/data/` 下的 namespace 数据，因此本机 A_Memorix 安装、虚拟环境和账本必须存在。若虚拟环境缺失或损坏，可重新运行部署脚本的 `setup`；若预期的账本数据缺失，应检查 `config.toml` 中的数据目录并从备份恢复，重新 `setup` 不会恢复已丢失的记录。若只配置了另一个 Gateway 或数据目录不在本机 `state/a-memorix/`，全量浏览不会读取那个实例，但 Gateway 检索与常规记忆操作仍按其连接配置工作。

### MaiBot WebUI 模块与当前 Gateway 能力缺口

部署脚本固定使用 A_Memorix Gateway `v2.0.0a4`（版本定义见 `scripts/a-memorix.ps1`）。当前将 Gateway 源码视为只读；未获得正式新版接口前，不修改其源码、二进制或底层存储。MaiBot 源码中的 `src/webui/routers/memory.py` 是 MaiBot 宿主 WebUI API，依赖 MaiBot 自己的记忆服务和数据库会话，不是独立 Gateway 的实现。

qq-bridge 现有客户端只调用记忆写入、批量写入、读取、删除和检索接口。已安装 Python 包中的 Gateway 协议另外包含 namespace 健康/能力、整库备份与恢复，以及按来源删除任务等服务契约；这些能力目前尚未接入 qq-bridge。整库备份/恢复可以作为后续可用性核对项，但它不能替代 MaiBot 的资料导入解析、导入任务队列或记忆包管理。开始实现前，还需确认当前发布版的对应传输接口确实可用，并核对所需权限。

以下 MaiBot WebUI 功能没有在当前记忆 API 契约中找到对应管理接口，因此基于固定的 `v2.0.0a4` 不能完整实现：

- **人物画像管理**：按平台账号查询完整画像快照，读取画像支撑证据，确认/维护别名，设置或删除人工覆写，以及纠正画像证据。已知 `person_id` 可作为记忆检索条件，不等于画像查询与维护 API。
- **记忆流审计**：按聊天、时间、事件类别列出段落、Episode、画像、反馈纠错、删除和维护事件，并查看事件详情、跳转到相关对象。`TIME` 只能按时间检索记忆记录，不能重建这些审计事件。
- **知识图谱管理**：列出/搜索节点和关系、查看节点/边/段落详情，以及创建、改名、删除节点或关系、调整关系权重。
- **Episode 管理**：Episode 模式检索可用；按条件列出 Episode、查看管理状态、迁移回填、重建及处理待办等操作接口缺失。
- **图片记忆管理**：图片资产列表/详情/内容、图片检索、关联与观察记录维护、索引回填和图片任务队列接口缺失。
- **记忆检修与纠错**：记忆强化/冻结/保护与逐条恢复、纠错预览/执行/回滚、反馈纠错历史，以及检索调优任务和配置管理接口缺失。
- **完整导入流程**：文件/文本/目录导入、Raw Scan、LPMM 转换、时间数据回填、MaiBot 迁移、分块任务队列，以及 MaiBot 记忆包的导入/导出/安装管理接口缺失。Gateway 的 namespace 备份/恢复只覆盖整库备份语义。
- **完整删除管理**：按单条 ID 删除和按来源提交删除任务有对应能力；MaiBot 的删除预览、操作历史、逐项恢复、回收区维护等接口缺失。namespace 级恢复不等同于逐条恢复。

后续升级检查应以官方 Gateway 发布说明和公开协议为准，逐项核对画像、审计时间线、图谱、Episode、图片、导入、检修、删除管理和调优接口是否正式开放，并确认接口作用于 qq-bridge 正在使用的 namespace。Gateway 或本地数据结构升级后，也要检查只读账本适配器的字段兼容性；不兼容时保持安全失败并更新读取器。确认前，不在 WebUI 中展示无数据来源或只能伪造的同名功能；`TIME`/`EPISODE` 检索、namespace 状态、整库备份和原始段落全量列表等能力应单独标注，不宣称已实现对应的 MaiBot 管理模块。

通过 A_Memorix 的删除接口删除活动记录；若该版本将删除项放入可恢复区，实际清理期限仍由后端策略决定。编辑时先保存新记录并标记 `supersedes`，成功后再请求删除旧记录。若旧记录删除失败，WebUI 会显示警告并保留新旧记录，避免更新失败造成数据丢失。

## 首期实现与部署前提

桥接首期已接入 Gateway 客户端、四个 DSH 工具（搜索、保存、读取、删除）、全局会话令牌校验、记忆参数日志省略、首次会话自身经历摘要，以及 WebUI 搜索/查看/新建/编辑/删除。`agent_rest` 不限制记忆工具调用。WebUI 可配置本机 Gateway 地址、已创建的 namespace、桥接启用状态、namespace API key、请求超时和启动摘要上限；Gateway 地址仅允许本机回环地址。Embedding/LLM Provider 由用户在 WebUI 手动配置 OpenAI 兼容服务地址、模型和密钥。A_Memorix 目前使用 OpenAI Chat Completions；请确保配置的服务兼容该协议。Provider 密钥只写入本机 `state/a-memorix/secrets/`，不回显，保存 Provider 变更会重启 A_Memorix。Windows 部署入口为 `scripts/a-memorix.ps1 setup|start|stop|status`；未启用时桥接照常工作，WebUI 会说明当前状态，记忆工具返回明确的配置错误。

Windows 部署脚本已将 A_Memorix `v2.0.0a4` 启动在 `127.0.0.1:8080`，创建 `qq-bridge` namespace 和 namespace API key，并启用本地 `config.json`。Embedding/LLM Provider 可在 WebUI 设置，配置之后仍需检查模型服务实际可用性：Gateway 的 `/healthz` 通过只说明服务可访问，不代表 namespace 的向量检索或模型调用正常。2026-10-30 本机检查发现原部署缺少 `faiss-cpu`，导致搜索使用 `sparse_graph`；补装 Faiss 并为已有 385 条段落/实体/关系记录重建向量后，双向量池 manifest 报告 15 条段落向量和 370 条图向量。首次重启时，A_Memorix 会先跳过实际 Embedding 自检，并因当前指纹尚未观测到而暂时禁用向量通道；本机观察到后台默认 180 秒探测后恢复，搜索切换为 `hybrid`，命中来源为 `dual_vector_pool`。具体观察及排查方向见 [改进计划](COMPANION_PROMPT_MEMORY_PLAN.md#2026-10-30-faiss-向量通道恢复)。带时间边界的 `TIME` 请求可返回记录；`HYBRID` 不带时间边界会被 Gateway 拒绝。记忆写入/删除、WebUI 页面和 DSH 工具的完整链路仍待核验。使用 `start.bat` 时会在桥接启动前尝试启动已安装的 A_Memorix 服务；直接运行 `npm start` 时需先手动运行部署脚本的 `start`。部署步骤见 [DSH_SETUP.md](DSH_SETUP.md)。桥接管理 API 只供带控制台令牌的 WebUI 使用；DSH MCP 工具只通过受全局会话令牌保护的 agent API 使用，`agent_rest` 不限制工具调用。记忆内容会经本机 Gateway 交给 A_Memorix；配置 Embedding/LLM Provider 后，记忆内容会按配置发送到相应服务。

`memory.timeoutMs` 默认 45 秒；新会话摘要有独立的 8 秒请求上限，超时后继续提交首次提示。`bootstrapLimit` 默认最多检索 6 条自身经历来源记录，`bootstrapMaxChars` 默认最多注入 2500 字符，均可在 `config.json` 调整。

本机 A_Memorix 服务已经通过 Gateway `/healthz` 检查，桥接重启后 `/api/memory/status` 返回已配置。Gateway 的只读检索已核验；尚未执行记忆写入/检索的 WebUI 与 DSH 端到端核验，也未执行自动化测试。仍需核验 WebUI 页面状态和 DSH 工具链路。

## 边界与非目标

- QQ 数据库直接读取仍是延期的技术尝试；QQ 当前来源仍为 SnowLuma。
- 不恢复按 QQ 群/私聊拆分 DSH session 或记忆库。
- 不设置周期性模型心跳，也不周期性运行 LLM 总结。
- 不因消息提醒自动读取或保存 QQ 内容。
- A_Memorix 的人物画像和关系图用于整理、召回证据，不取代原始来源记录。

## 实施顺序

1. 固定共享记忆数据契约、双来源标记和 A_Memorix Gateway 接口。——已完成
2. 提供有界的 MCP 工具面与桥接查询/管理 API，二者访问同一 namespace。——已接入并配置，完整读写链路待核验
3. 在全局 DSH 会话首次提示中加入自身经历来源摘要，避免每轮重复注入。——已接入，待 DSH 实际会话核验
4. 在 WebUI 提供记忆检索和管理页面。——检索/写入/单条管理经 Gateway 接入；活动原始段落可通过本机受限只读适配器全量分页浏览；MaiBot 高级管理接口仍缺失
5. 部署 A_Memorix 服务、配置 namespace/key，并核验真实 DSH 和 WebUI 链路。——服务已部署、桥接已重启，端到端核验待完成

当前实现状态以代码和用户手册为准；上列步骤尚未完成时，不要在 README 中宣称长期记忆已经可用。
