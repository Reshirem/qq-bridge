# 长期记忆方案

本文记录 qq-bridge 长期记忆的已对齐目标、首期实现和运行边界。

## 目标

qq-bridge 使用一个跨电脑活动与 QQ 的共享长期记忆空间。QQ 是内容来源之一，陪伴者自身的行动、发现和经历也是内容来源。群聊或私聊不会各自拥有独立的 DSH 会话或记忆库。

记忆来源只分为两类：

- `qq`：陪伴者实际读取过的 QQ 内容，且陪伴者判断值得保存后主动调用记忆工具。
- `assistant`：陪伴者对自身经历、行动、发现、问题和结果的记录，由陪伴者自行判断是否保存。该值是现有数据格式中的来源标记，不限定人格形态。

来源类别用于说明信息从哪里来，不等同于事实可信度。记录可保留说话人、QQ 群/私聊、任务、时间、消息或会话引用等证据元数据；引用他人说法时仍要明确归属，不能把转述自动写成已确认事实。QQ 正文不会仅因收到、被提及或缓存在桥接中就自动进入长期记忆。

## 存储与运行架构

采用 MaiBot 集成 A_Memorix 的总体思路：结构化元数据和记忆正文作为可追溯记录保存；语义向量和关系图用于检索；Episode 与人物画像是从证据派生的整理结果。存储空间在运行时固定为一个全局 namespace，来源字段使用上述 `qq` / `assistant` 两个值。

MaiBot 源码中的 A_Memorix 宿主接入依赖 MaiBot 自己的服务和数据库。本项目复用其长期记忆架构与公开接口，不直接复制 MaiBot 的宿主集成代码。当前代码面向独立的 A_Memorix 2.x HTTP/JSON Gateway；MaiBot 项目内的旧版插件/数据目录不是这个 Gateway，不能直接填入配置，也不会自动迁移。若要复用 MaiBot 现有数据，需先按 A_Memorix 提供的正式导入/迁移接口处理。底层记忆服务应是唯一的存储所有者；DSH 工具、会话启动摘要和 WebUI 都访问同一份数据，不各自直接改写存储文件。

```text
DSH 全局会话
  └─ 按需调用记忆工具
       └─ qq-bridge 的 MCP/API 适配层
            └─ A_Memorix 记忆运行时与唯一持久存储

新会话启动 ── qq-bridge 查询精简记忆 ── 注入一次
WebUI      ── qq-bridge 管理 API   ── 浏览、编辑、取代或删除
```

运行时按本机 A_Memorix HTTP/JSON Gateway 接口访问服务。DSH 的 `mcp-memory-safe.js` 工具经桥接 API 转发到 Gateway；会话启动摘要和 WebUI 也由桥接访问同一个 namespace。桥接不直接读写 A_Memorix 的 SQLite、向量或图文件。

A_Memorix 的独立服务单独运行，Gateway 与 gRPC 服务只监听本机回环。Windows 部署脚本固定使用官方 `v2.0.0a4` wheel 和 Gateway 发布文件，并校验 SHA-256；运行文件、Python 虚拟环境、密钥、数据和日志保存在 qq-bridge 的 `state/a-memorix/`，不需要 clone 上游源码或添加 submodule。默认 namespace 开启 metadata-only 写入和 sparse 检索；没有配置 Provider 时不会产生外部模型调用，但也没有语义向量和自动关系抽取。项目不得为了工具进程和 WebUI 分别启动两个共享数据目录的 A_Memorix 写入者。

上游 A_Memorix 2.x 目前仍标为 alpha。部署版本及发行文件校验值记录在 `scripts/a-memorix.ps1`；升级前应核对上游版本与 Gateway 协议并一并更新固定校验值。本项目只依赖 HTTP/JSON 公共接口，不捆绑或复制 A_Memorix 服务端源码。桥接侧的 namespace API key 只从不入库的 `config.json` 读取，不传给模型，也不写入工具调用参数日志。

## 谁决定保存和检索

DSH 会话负责判断何时调用记忆工具。桥接不在每轮结束时自动总结或保存对话，也不把每条 QQ 消息自动归档。

- QQ 记忆只从陪伴者已经读取的内容中选择；陪伴者通过记忆工具明确提交后才保存。
- 陪伴者自身经历由其自主选择记录。提示应给宽泛、非穷尽的方向，不要求每项任务都写记忆，也不把可记忆内容限制在固定清单中。
- 陪伴者可以按需搜索、读取和维护记忆；收到 QQ 提醒本身不强制触发记忆检索或保存。
- 工具参数可提供自然语言记忆内容和可选的关联元数据；来源标记应由可信的工具调用上下文限制为 `qq` 或 `assistant`，不允许写入任意来源类别。`assistant` 是现有数据格式中的来源值，表示陪伴者自身经历，不规定它的人格形态。

## 新会话启动上下文

每个新建或重建的全局 DSH 会话，在第一次工作提示中得到一份精简摘要，内容优先包括：

- 陪伴者近期有价值的经历、尝试结果和发现；
- 仍未完成或需要继续跟进的事项；
- 少量长期稳定且对当前工作有帮助的用户或项目偏好。

QQ 联系人或群聊记忆按当前任务和对象按需检索，不把所有 QQ 记忆一并注入。摘要只在新会话首次引导时注入，不在每轮重复注入。单一 DSH 全局会话、停止/休息/异常恢复规则保持不变。

## WebUI 管理

WebUI 管理同一个长期记忆空间，首期目标是提供按时间检索、关键词搜索、按来源筛选、查看记录和证据、编辑、标记被新记录取代，以及删除。界面操作经桥接管理 API 访问后端；DSH 使用独立的 MCP 工具，不获得 WebUI 管理令牌。

修改事实时以新记忆记录替代旧记录并保留来源和变更关系。删除操作应由后端完成，并同步清理由正文派生的索引或关联；不能只从界面隐藏一条记录。

目前 A_Memorix Gateway 暴露写入、检索、按 ID 读取和删除等 API，没有独立的“列出全部记忆”接口。因此首期浏览以 A_Memorix 的时间检索结果为准，不承诺返回后端全部记录；如果后续需要完整分页账本，应先给服务增加正式接口，不在桥接中绕过 API 直接查数据库。

通过 A_Memorix 的删除接口删除活动记录；若该版本将删除项放入可恢复区，实际清理期限仍由后端策略决定。编辑时先保存新记录并标记 `supersedes`，成功后再请求删除旧记录。若旧记录删除失败，WebUI 会显示警告并保留新旧记录，避免更新失败造成数据丢失。

## 首期实现与部署前提

桥接首期已接入 Gateway 客户端、四个 DSH 工具（搜索、保存、读取、删除）、活动回合与会话令牌校验、记忆参数日志省略、首次会话自身经历摘要，以及 WebUI 搜索/查看/新建/编辑/删除。WebUI 可配置本机 Gateway 地址、已创建的 namespace、桥接启用状态、namespace API key、请求超时和启动摘要上限；Gateway 地址仅允许本机回环地址。Embedding/LLM Provider 由用户在 WebUI 手动配置 OpenAI 兼容服务地址、模型和密钥。A_Memorix 目前使用 OpenAI Chat Completions；请确保配置的服务兼容该协议。Provider 密钥只写入本机 `state/a-memorix/secrets/`，不回显，保存 Provider 变更会重启 A_Memorix。Windows 部署入口为 `scripts/a-memorix.ps1 setup|start|stop|status`；未启用时桥接照常工作，WebUI 会说明当前状态，记忆工具返回明确的配置错误。

Windows 部署脚本已将 A_Memorix `v2.0.0a4` 启动在 `127.0.0.1:8080`，创建 `qq-bridge` namespace 和 namespace API key，并启用本地 `config.json`。本机 Gateway 健康检查已通过，qq-bridge 已重启并确认读取到已配置的 namespace。当前 namespace 尚未配置 Embedding/LLM Provider；WebUI 已提供设置入口，但需要用户填写服务地址、模型和可选密钥后，语义向量及自动关系抽取才能实际运行。尚未验证记忆写入/检索及 DSH/WebUI 完整链路。使用 `start.bat` 时会在桥接启动前尝试启动已安装的 A_Memorix 服务；直接运行 `npm start` 时需先手动运行部署脚本的 `start`。部署步骤见 [DSH_SETUP.md](DSH_SETUP.md)。桥接管理 API 只供带控制台令牌的 WebUI 使用；DSH MCP 工具只通过受会话令牌保护的 agent API 使用，且必须处于活动回合。记忆内容会经本机 Gateway 交给 A_Memorix；配置 Embedding/LLM Provider 后，记忆内容会按配置发送到相应服务。

`memory.timeoutMs` 默认 45 秒；新会话摘要有独立的 8 秒请求上限，超时后继续提交首次提示。`bootstrapLimit` 默认最多检索 6 条自身经历来源记录，`bootstrapMaxChars` 默认最多注入 2500 字符，均可在 `config.json` 调整。

本机 A_Memorix 服务已经通过 Gateway `/healthz` 检查，桥接重启后 `/api/memory/status` 返回已配置。WebUI 配置入口已接入；尚未执行记忆写入/检索的端到端核验，也未执行自动化测试。仍需核验 WebUI 状态和 DSH 工具链路。

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
4. 在 WebUI 提供记忆检索和管理页面。——已接入；受 Gateway 无全量列举接口限制
5. 部署 A_Memorix 服务、配置 namespace/key，并核验真实 DSH 和 WebUI 链路。——服务已部署、桥接已重启，端到端核验待完成

当前实现状态以代码和用户手册为准；上列步骤尚未完成时，不要在 README 中宣称长期记忆已经可用。
