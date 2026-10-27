# 控制台离线预览与回归测试

这些脚本只读取控制台 HTML，使用内存中的演示数据模拟 API。不会加载项目入口、配置文件、真实 state，也不会连接 QQ 或 DSH。重启、清空、发送消息等按钮只改变内存或返回模拟结果。

## 启动预览

在项目根目录执行：

```sh
npm run preview:console          # 等价于 node scripts/console-ui-fixture.mjs
```

浏览器访问 `http://127.0.0.1:4173`。写请求会打印到终端，也可以访问 `/__fixture/requests` 查看记录。服务只监听 loopback 地址。按 `Ctrl+C` 退出，演示数据随之丢弃。

可用选项：

```sh
node scripts/console-ui-fixture.mjs --port=4174
node scripts/console-ui-fixture.mjs --original --port=4174
node scripts/console-ui-fixture.mjs --html=path/to/console.html
```

`--original` 读取 `scripts/fixtures/console.before.html`（改造前的原版，随仓库保留），仅用于对照预览；正常预览读取 `public/console.html`。

## 浏览器回归

```sh
npm run test:console-ui          # 等价于 node scripts/test-console-ui.mjs
node scripts/test-console-ui.mjs --artifacts=docs/ui-verification
```

脚本使用 Playwright 和 Chromium。优先使用项目内安装的 `playwright`；Windows 上若未安装 Playwright，会自动改用本机 Chrome / Edge，无需下载浏览器。其他环境可安装 Playwright 及其浏览器，或通过以下环境变量指定：

- `PLAYWRIGHT_MODULE`：Playwright 模块目录（例如 `npm install --no-save playwright` 后指向 `node_modules/playwright`）。
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`：Chromium / Chrome 可执行文件。

测试自行启动随机端口的 fixture，并在退出时关闭浏览器和服务。浏览器请求被限制到该 fixture 的 origin，外部请求会被阻止并使检查失败。

覆盖范围：

- 改造前 225 个元素 ID 保留或列入退役清单，DOM ID 唯一。
- 八个导航视图及切换后草稿保留，跨越实际的 3 秒状态轮询。
- 固定 QQ 会话运行时、旧模式与 preset 选择器不再出现、角色创建与切换、静默模式、白名单及安全设置。
- QQ 会话运行时配置上下两个保存按钮的完整 payload，包括休眠与唤醒限值、合并窗口、发送限制、工具开关、暂停及恢复。
- 测试消息、AI 提醒仅发送到 mock API。
- 全部写请求与 API payload 基线逐项完全比较。
- 手机 390px 与平板 768px 下各视图没有页面级横向溢出。
- 深色模式：切换生效、写入 `localStorage`、刷新后保持、`aria-pressed` 与 `color-scheme` 同步、正文对比度 ≥ 7:1、深色下 390 / 768px 无横向溢出。
- 未做选择时跟随系统 `prefers-color-scheme`。
- `prefers-reduced-motion: reduce` 下关闭背景动效、页面切换动画与过渡。
- 人格管理全流程：新建 → 点列表载入编辑（内容回填、按钮切到「保存修改」）→ 保存修改 → 改名保存（先重命名再保存）→ 删除（确认框自动接受），每步都断言列表随之更新。
- QQ 会话提示词：固定使用 `qq-chat-v2`，默认可查看且只读、解锁后可编辑、保存后回到只读，并提示新建或重置会话后加载新版。
- 思考强度：档位来自 DSH 公布的能力（low/high/max）、默认 max、可切换保存，并断言页面明示会连带修改 DSH 全局默认。
- 无 JavaScript 错误、未知 API 或外部网络请求。

新增的控制台 API 都已在 `console-ui-fixture.mjs` 里 mock；**改动控制台时若加了新接口，必须同步补 mock**，否则本套件会在「未知 API」这一项失败。

`--artifacts` 会保存检查结果 JSON、模拟写请求记录和桌面 / 手机截图（浅色与深色各一组），截图时会静止动画以保证可复现。默认不生成额外文件。

## 基线说明

`console-ui-legacy-ids.json` 保存改造前的 225 个元素 ID。`console-ui-contracts.json` 保存当前控制台操作的 API 写请求基线，包含自主会话配置的完整嵌套参数。

只有后端写入契约经过明确调整时才更新基线，并在审阅实际请求后手动修改 `scripts/console-ui-contracts.json`。`--record-baseline` 已退役，测试脚本会拒绝该参数；`scripts/fixtures/console.before.html` 仅供对照预览，不用于生成 API 基线。

普通回归不依赖 `console.before.html`。不要用真实的 `test-console.mjs` 替代本脚本：那个脚本可能向真实 QQ 发送消息。

此回归验证前端行为和提交契约，不能替代真实 QQ / DSH 集成测试。
