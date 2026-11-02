# MaaMCP 接入

MaaMCP 由 DSH 通过 stdio 调用，Python 环境独立于 qq-bridge 和 A_Memorix。`src/maa_mcp_server.py` 是标准 MaaMCP 的启动入口：保留上游工具名称，修正 DSH 使用说明，让 ADB 连接工具接受网络地址，并将 `screencap` 的路径结果扩展为 MCP 图片。`desktop-agent` 的工具守卫放行固定的 `mcp__maa__*` 命名空间。目前 `setup-dsh.mjs` 不自动安装或配置 MaaMCP。

## 部署参考

2026-11-02 已完成 Windows 本机安装联调。以下示例以 `C:/apps/MaaMCP/.venv` 为独立环境，在 `%USERPROFILE%/.dsh/profiles/<profile>/cordis.patch.yml` 注册 `mcp-maa`，服务名称为 `maa`。DSH 启动后自动加载，全部 24 个标准工具以 `mcp__maa__*` 名称提供给模型；部署时按实际目录和 profile 修改路径。

- Python：3.12.14；MaaMCP 源码：`3005b2971efa9f2ee5ec62c8331dbe824b85cc7e`（editable 安装）。
- 主要依赖：MaaFw 5.14.3、FastMCP 4.1.4、OpenCV 5.0.0.93；完整安装快照保存在 `state/maa-mcp/installed-requirements.txt`。
- 数据目录示例：`C:/apps/qq-bridge/state/maa-mcp`，包括 OCR 模型、截图、Pipeline 和运行日志；本机联调已下载 OCR 的 `det.onnx`、`keys.txt`、`rec.onnx`。
- ADB：官方 Android Platform-Tools 37.0.1，安装在 `state/maa-mcp/tools/platform-tools/`，通过 `QQ_MAAMCP_ADB_PATH` 配置给服务；不修改系统 PATH。
- MCP 工具请求超时：180 秒。短 Pipeline 应显式设置更短的 `timeout_seconds`，为工具返回和清理留出时间。
- 修改前的 profile 配置已在同目录备份为 `cordis.patch.yml.before-maa-*.bak`。安装期间曾重启 DSH，使已缓存的旧版工具守卫更新生效；常规使用无需手动启动 Python。

可以直接在 DSH 或 WebUI 任务中要求模型用 Maa 操作指定窗口，例如“用 Maa 截取某个窗口并读取文字”。窗口名称明确后，模型发现并连接目标，再使用截图、OCR、输入和 Pipeline 工具；有效控制器可以继续复用。

## 截图行为

- `screencap` 默认 `include_metadata=True`，文字部分保留原 PNG 路径、控制器尺寸、图像尺寸和坐标变换；图片部分可以由支持图像输入的 DSH 模型直接查看。
- 明确传入 `include_metadata=False` 时，文字部分仍返回原路径，图片仍随结果返回。
- 原 PNG 超过 1 MiB 时，传输图片转为同尺寸 JPEG；不缩放画面，原 PNG 仍供 `save_captured_image` 使用。转码后仍超过 3 MiB 时明确报错，调用方可缩小 `region` 或 `resolution` 后重试。
- 图片读取限定在 MaaMCP 截图目录中，并在读取前解析真实路径；入口没有让模型任意传本地文件路径的参数。失效控制器或读取失败会作为工具错误返回。

## DSH 挂载示例

先准备含 MaaMCP 依赖的独立 Python 环境。下例路径需要按部署位置填写；它不会创建虚拟环境，也不会自动写入当前 DSH profile。注册名称使用 `maa`，对应预设已放行的命名空间。

```yaml
- insert:
    - id: mcp-maa
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: maa
        transport: stdio
        command: 'C:/apps/MaaMCP/.venv/Scripts/python.exe'
        args: ['C:/apps/qq-bridge/src/maa_mcp_server.py']
        cwd: 'C:/apps/MaaMCP'
        toolCallTimeoutMs: 180000
        env:
          QQ_MAAMCP_DATA_DIR: 'C:/apps/qq-bridge/state/maa-mcp'
          QQ_MAAMCP_ADB_PATH: 'C:/apps/qq-bridge/state/maa-mcp/tools/platform-tools/adb.exe'
          PYTHONDONTWRITEBYTECODE: '1'
```

`QQ_MAAMCP_DATA_DIR` 必须是绝对路径；不指定时沿用上游数据目录。本机 Windows 实测为 `%LOCALAPPDATA%/MaaXYZ/MaaMCP`。从源码运行时，可额外设置 `PYTHONPATH` 指向 MaaMCP 源码根目录，Python 环境仍须包含该项目依赖。MCP 的 Python 进程由 DSH 启停，不由 QQ 聊天触发安装。

## 网络 ADB

上游服务器提示词要求设备操作经由 Maa 工具，不在模型终端中直接运行 adb。原版 `connect_adb_device` 仅从已发现设备的注册表中查找名称，因此会把直接传入的网络地址当作未知设备名并返回空值；这不代表 MaaFramework 不支持网络连接。

适配后的同名工具接受两种输入：先枚举得到的设备名，或明确指定的 `IP:端口`（IPv6 使用 `[IP]:端口`）。例如：

```json
{"device_name":"192.0.2.10:5555"}
```

网络地址无需先出现在列表中。适配器创建 ADB 设备描述，再交给 MaaFramework 的原有连接流程；MaaFramework 内部执行 ADB 网络连接。模型不需要额外的 `adb connect`、shell 权限或新工具名称，工具总数仍为 24。

本机 adb 路径由服务环境变量 `QQ_MAAMCP_ADB_PATH` 指定，未配置时查找进程 PATH；模型不能通过工具参数选择可执行文件。配置路径必须是现有绝对文件路径。枚举也使用该 adb，USB/已发现设备的原有调用方式保留。地址格式错误、adb 缺失或连接失败会返回明确的工具错误；网络连通性、设备调试授权和无线调试配对仍由设备实际状态决定。

## 两种 Pipeline 与停止范围

接入时从首轮起暴露 Pipeline 工具及其用途说明，让模型提前了解这项能力。模型在已授权任务中发现稳定、会重复使用的操作流程时，可主动考虑生成、验证并复用 Pipeline，以减少逐步看图和调用工具的开销。当前保留标准入口全部 24 个工具，说明精简在接入方案确定后再做。

适配入口会修正上游服务器说明：直接查看截图返回的图片，移除未挂载的持续监控工具用法，并加入主动考虑复用 Pipeline 的提示。这些说明会通过 MCP 初始化结果交给 DSH，无需另开文件读取权限。

标准入口包含 MaaFramework `run_pipeline`：按 JSON 中的节点执行识别和操作，例如反复使用的“识别结算页 → 领取奖励 → 返回主界面”。任务仍是一次同步工具调用，适合短流程；长期阻塞会推迟同一模型回合对 QQ 提醒的响应。`timeout_seconds` 默认不限时，实际使用需设置适当时限，并与 DSH 工具请求超时协调。

运行已保存的 Pipeline 时，直接使用 `save_pipeline` 返回的绝对路径。`load_pipeline` 支持相对于数据目录 `pipelines/` 的路径，`run_pipeline` 的相对路径则按进程工作目录解析，两者不要混用。OCR 在局部 ROI 内可能将整段文字拆成多个框，节点匹配应结合 ROI 选择稳定的关键词，而不是假定与全图 OCR 的分词完全相同。

DSH 通过 stdio 启动的 MaaMCP Python 进程负责提供工具；普通 JSON Pipeline 由其加载的 MaaFramework 执行，不需要额外的 Custom action 程序。只有 `run_pipeline` 允许启动 agent 且资源项目的 `interface.json` 声明了相应配置时，MaaMCP 才会另起自定义识别/动作子进程。独立进程不改变 `run_pipeline` 等待结果的调用方式；若要让长流程执行期间模型继续处理 QQ，需要额外设计异步任务提交、状态查询、停止和完成事件通知，目前未实现。

上游 `maa_mcp.pipeline_server` 是另一种运行入口，可启动持续截图/OCR 的后台循环；本适配器使用标准入口，不导入该后台服务器。当前上游两处注册的 `stop_pipeline` 同名但参数和清理范围不同，不能把停止后台 OCR 等同于清理 Tasker 和 Custom action 子进程。

MaaMCP 服务进程复用 DSH 现有的 MCP 托管机制，普通回合结束或 `agent_rest` 不要求关闭进程，不额外设计逐回合进程回收和重启。需要清理任务时复用上游 `stop_pipeline(controller_id)`；该工具同时注销控制器，后续操作需要重新连接。

按当前确定的方案，不增加 WebUI 的 Maa 停止按钮或自动联动。`agent_rest` 结束模型当前回合，WebUI 停止取消 DSH 当前和排队工作，现有 Windows computer-use 插件的 Esc 机制也不负责 MaaMCP。MaaMCP 服务与可复用控制器保留到 DSH 关闭，由 DSH 的 stdio MCP 生命周期统一销毁；需要提前清理某个控制器时，模型仍可调用 `stop_pipeline`。关闭 DSH 与点击 WebUI 停止是不同的操作。

命名空间放行保留上游 Pipeline 的能力；`run_pipeline` 可按资源中的 `interface.json` 启动 Custom action 子进程。这些能力不受 DSH 通用 shell/文件工具禁用名单隔离。工具裁剪和说明精简尚未实施。

## 验证

`node scripts/test-maa-mcp.mjs` 需要 `QQ_MAAMCP_TEST_PYTHON` 指向有 MaaMCP 依赖的 Python；源码运行可同时设置 `PYTHONPATH`。测试使用合成画面，不连接真实设备，验证真实 stdio 协议中的服务器说明、PNG/JPEG 图片、裁剪缩放坐标、旧路径格式、失效控制器和越界路径拒绝。数据写入独立临时目录。

本机通过的组合为 MaaMCP 源码 `3005b2971efa9f2ee5ec62c8331dbe824b85cc7e`、Python 3.12.14、MaaFw 5.14.3、FastMCP 4.1.4 与 OpenCV 5.0.0.93。`pip check` 和工具守卫回归也已通过。

2026-11-02 另做了实际安装联调：

- 在临时 `desktop-agent` 会话中，使用当前 `opencode-go / deepseek-v4.1-flash` 调用已注册的 Maa 工具。模型在首次调用 OCR 前，直接从 MCP 图片中正确读出了测试窗口的随机校验码，随后成功获取 OCR 结果。
- 使用真实 Win32 测试窗口，以 `PrintWindow + Seize` 连接；单次 `click` 后，窗口自身保存的计数恰好增加 1，排除了仅检查工具返回 `true` 的假阳性。
- 通过真实 stdio 工具保存并加载一个“识别就绪文字 → OCR 定位并点击按钮 → 识别计数标签”的三节点 Pipeline。在同一个控制器上连续运行两次，均返回 `succeeded`，窗口计数每次恰好增加 1。测试设置 `timeout_seconds=15`、`start_agent=False`；样例保存在本机 `state/maa-mcp/pipelines/installation-smoke.json`，仅适用于该测试窗口。
- 正常退出 DSH 后，托管 MaaMCP 的两个 Python 进程均退出；重新启动 DSH 后，Maa 插件自动恢复为 `active`。测试会话已归档，测试控制器已清理。

随后补充网络 ADB 联调：真实 stdio 客户端及临时 DSH `desktop-agent` 会话均直接传入设备的网络地址，未先枚举设备，成功获得控制器 ID；仅检查连接并清理测试控制器，未读取设备画面或执行输入。回归覆盖已发现设备、IPv4/IPv6 直连、尺寸配置、无效地址/端口、缺失 adb 和失败连接。

本机测试发现：WinForms 测试窗口的 FramePool 会返回陈旧画面，改用 PrintWindow 后能看到最新状态；PostMessage 类后台输入也未可靠触发该窗口的子控件，Seize 的真实鼠标点击通过。具体应用需验证截图是否更新及输入是否生效，不能根据 `true` 推断界面结果。Android 的截图/输入及资源项目的 Custom action 子进程未做设备联调。
