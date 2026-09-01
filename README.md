# 求职管家独立版

一个本地招聘工作台。配置平台条件后，在可见的 Chrome 页面中登录招聘平台并执行投递。

本版本直接使用网页工作台，不接入 Agent，也不包含聊天、QQ 或微信功能。需要通过 Agent 用自然语言控制投递，请使用配套的 [求职管家 MCP 版](https://github.com/Alxdzh/job-agent-mcp)。

工作台界面只保留投递相关配置、平台登录、运行状态和投递记录，不再提供简历或个人资料编辑区。投递条件统一在“设置 → 投递偏好”中维护，包括城市、关键词、薪资、启用状态和筛选词。

## 功能

- 支持 BOSS 直聘、智联招聘、51job（前程无忧）和猎聘。
- 使用页面控件完成登录、城市选择、搜索、职位详情和投递。
- 支持手动指定数量，或按时间窗持续投递。
- 每个平台独立配置关键词、登录态、节奏和冷却。
- 批次数量、休息时间和岗位间隔支持随机范围。
- 查看扫描数、成功数、跳过原因、冷却状态和投递记录。
- 可在设置中填写云端模型 API，用于 JD 判断。

启动工作台不会自动投递；需要在工作台中点击开始。默认使用可见浏览器，静默模式需手动开启。

## 安装和启动

### Windows：下载 ZIP

1. 下载 ZIP 并解压。
2. 双击 `install.bat`，安装依赖并创建桌面快捷方式。
3. 以后双击桌面上的 `Job-Agent-Workbench`，或双击 `start.bat` 启动。

想一步完成安装和启动，可以双击 `one-click-start.bat`。

### Windows：命令行

在仓库根目录执行：

```powershell
npm run setup
npm start
```

`npm run setup` 只安装和准备环境，`npm start` 启动工作台；两条命令可以连续执行。需要 Node.js 22.12+、Google Chrome 和网络连接来安装 npm 依赖。

### macOS / Linux

先安装 Node.js 22.12+ 和 Google Chrome，然后在仓库根目录执行：

```bash
sh install.sh
sh start.sh
```

也可以使用 `npm run setup` 和 `npm start`。如果系统有 `Desktop` 目录，安装时会创建桌面启动文件。

## 第一次使用

1. 在“设置”中配置平台、城市、关键词、薪资、投递时间和随机节奏。
2. 在登录区域逐个平台打开可见浏览器，完成登录并检查登录态。
3. 手动投递选择平台和数量后点击开始；持续投递点击右上角开始按钮。
4. 在状态卡片和“投递记录”标签中查看实际结果。

遇到登录失效、验证码、风控、弹窗或页面异常时，先暂停任务，处理浏览器页面后再继续。

## 运行数据

配置和运行数据保存在当前用户目录以及项目的 `daemon/state`、`daemon/log`。登录态和历史记录不会随源码仓库分发。

## 第三方声明

本仓库包含 `@geekgeekrun/puppeteer-extra-plugin-laodeng` 第三方源码，来源为 [geekgeekrun](https://github.com/geekgeekrun/geekgeekrun)。该组件随附元数据未声明许可证，不属于本项目 MIT 许可证范围；详情见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 相关版本

- [求职管家 MCP 版](https://github.com/Alxdzh/job-agent-mcp)：把本项目接入 Agent，由 Agent 负责自然语言控制。

## 许可证

本项目自有代码按 [`LICENSE`](LICENSE) 发布；第三方组件按其自身授权情况使用。
