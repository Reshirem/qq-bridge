# 控制台离线预览与浏览器检查

离线预览只读取控制台 HTML，并用内存数据模拟 API。它不会加载桥接入口、读取 `config.json` 或真实 `state/`，也不会连接 DSH、SnowLuma 或 QQ。按钮提交只改变丢弃式演示数据。

## 启动预览

在项目根目录执行：

```sh
npm run preview:console
```

浏览器打开 `http://127.0.0.1:4173`。写请求会打印到终端，也可以访问 `/__fixture/requests` 查看。服务只监听 loopback 地址；按 `Ctrl+C` 退出后演示数据会丢弃。

首页是运行总览。四张状态卡分别对应主会话、QQ 消息、记忆整理和后台学习。可以从待处理事项打开具体的整理任务或表情修正建议，从消息动态定位到对应来源。七个一级入口共用同一控制台；直接打开带页面片段的链接和浏览器前进、后退都可用。旧地址 `/?view=overview` 也会进入首页。

可用选项：

```sh
node scripts/console-ui-fixture.mjs --port=4174
node scripts/console-ui-fixture.mjs --html=path/to/console.html
```

## 浏览器检查

```sh
npm run test:console-ui
```

脚本需要本机已有的 Playwright 和 Chromium、Chrome 或 Edge。可用 `PLAYWRIGHT_MODULE` 指向 Playwright 模块，也可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定浏览器。脚本不会安装依赖或下载浏览器。

检查覆盖范围：

- 页面提供唯一全局 `desktop-agent` 的启动、任务提交和停止控制。
- 页面不再显示逐 QQ DSH 会话映射、逐来源通知或审批转发控件。
- 提示词编辑区固定对应 `desktop-agent`。
- QQ 通道面板保留提醒配置、消息缓存状态和清空缓存操作；清空缓存不会重置全局 DSH 会话。
- “系统运维 → 访问设置”可独立保存和清除 ownerQQ。测试发送名单在同一模块的“诊断与维护”中独立保存。
- 浏览器没有 JavaScript 错误、未实现的 fixture API 请求或外部网络请求。

新增控制台 API 时，需在 `scripts/console-ui-fixture.mjs` 里补充对应的内存 mock。

离线检查验证的是前端页面和控制台交互，不替代真实 DSH、SnowLuma 或 QQ 集成验证。
