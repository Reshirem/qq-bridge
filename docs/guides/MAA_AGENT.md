# 明日方舟 · 可选 Maa-Agent

角色通过 Maa-Agent 的 Python CLI 观察画面和运行作业。角色仍然使用当前 DSH 模型。此模块按需安装，适配验证的上游版本为 [`87ce0d1`](https://github.com/TURLEing/Maa-Agent/tree/87ce0d12473c6ca9ab1c7bee90c84eca90646791)。

## 安装

先准备 Python 3.11+、已登录明日方舟的模拟器、ADB、maa-cli 和 MaaCore 资源。配置 maa-cli 的 `default` JSON 或 TOML profile，指定模拟器地址，确保 ADB 能连接。上游提供了[配置说明](https://github.com/TURLEing/Maa-Agent/blob/87ce0d12473c6ca9ab1c7bee90c84eca90646791/docs/configuration.md)。

在 qq-bridge 仓库根目录运行以下命令。已有同级 Maa-Agent 源码时跳过 clone，放在其他目录时给 `install` 加上 `--source "源码目录"`。可用 `--python "解释器路径"` 选择创建虚拟环境的 Python。

```powershell
git clone https://github.com/TURLEing/Maa-Agent.git ../Maa-Agent
node scripts/maa-agent.mjs install
node scripts/maa-agent.mjs doctor
```

安装器会为兼容的 Maa-Agent 源码应用随附的导航补丁，并在 `state/maa-agent/venv` 独立安装上游依赖。已应用的补丁会跳过。如果源码与补丁不兼容，安装器会提示，届时以本地 CLI 的 `--help` 为准。安装并导入成功后才写入启用记录。`doctor` 会逐项检查资源、原生库与设备。使用非默认安装时，可在执行 `install` 前设置 `MAA_AGENT_CLI`（maa 可执行文件绝对路径）、`MAA_AGENT_CONFIG_DIR`、`MAA_AGENT_DATA_DIR` 或 `MAA_AGENT_PROFILE`。安装器会记录这些配置供 DSH 使用。上游默认将截图、设备锁和作业记录放在源码的 `.runtime/`。如已有自定义运行目录，安装前把 `MAA_AGENT_RUNTIME_DIR` 设为同一个绝对路径，让手动 CLI 与角色共享设备锁和运行记录。

按本项目的常规步骤安装或更新 `desktop-agent` 预设。正在运行的角色会沿用启动时的工具列表，等当前回合结束后，退出并重新打开 DSH，让桥接接续原会话即可加载新工具。执行 `node scripts/maa-agent.mjs status` 可以查看本机安装记录。以后更新或重新启用模块时，直接运行 `install` 会沿用已保存的源码、设备配置目录和资源目录。

## 准备和运行作业

将 Copilot JSON 直接放进 `state/maa-agent/copilots/`，角色下次调用 `maa_copilots` 就能看到。列表会读取作业的 `stage_name`，用本机 MaaCore 的关卡表将 `main_01-01` 这样的内部编号显示为游戏里的 `1-1`。已有的关卡子目录仍可使用，格式错误的文件会在结果里给出原因。如果关卡表里没有对应项，角色可以看游戏准备页填写关卡名。

角色也可以把下载文件的**绝对路径**直接传给 `maa_run_copilot`，无需先复制进作业目录。执行和准备页核验交给 Maa-Agent。上游以第 4 编队执行，可能消耗理智。[上游作业说明](https://github.com/TURLEing/Maa-Agent/blob/87ce0d12473c6ca9ab1c7bee90c84eca90646791/README.md#使用说明)

可以直接对角色说“打开日常任务页”或“从首页打开 1-1，停在准备页”。前者通过 MaaCore 的任务入口打开页面，后者进入终端和目标主线章节，再根据准备页的编号或唯一关卡标题确认到达。主线作业也可以从首页或终端提交。活动关需要先进入对应地图，剿灭有单独的导航入口。

| 角色工具 | 用途 |
| --- | --- |
| `maa_cli` | 直接传入 Maa-Agent 命令及参数。用 `["missions"]` 打开任务页，用 `["--help"]` 查看当前安装支持的操作 |
| `maa_doctor`、`maa_observe` | 检查部署、识别当前页面，`withImage=true` 时观察结果附截图 |
| `maa_copilots`、`maa_stage` | 列出已准备的作业，导航并核对关卡；剿灭使用 `annihilation=true` |
| `maa_run_copilot` | 按文件路径提交作业，返回 `run_id`。Maa-Agent 的执行进程负责核对关卡和运行作业 |
| `maa_poll` | 按编号读取执行状态及战果。省略编号可找回近期运行，附图时取该次作业记录的画面 |
| `maa_verify` | 用当前结算画面的星数或剿灭击杀数判定战果，证据不足时返回 `unknown` |
| `maa_cancel` | 请求停止指定执行器，之后用 `maa_poll` 确认。游戏中的战斗可继续 |

`executor=completed` 表示执行器结束。是否通关看对应运行的 `game_result` 和结算证据。用 `maa_poll` 可以跟进同一次运行。

## 禁用

先处理想要停止的作业，再运行 `node scripts/maa-agent.mjs disable`。后续游戏调用立即失效，重启 DSH 后工具从原会话的列表消失。该命令保留设备配置、虚拟环境、本地作业、上游源码和战斗记录，便于以后再次运行 `install` 启用。
