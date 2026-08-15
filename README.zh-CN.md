# dshed

> 像桌面应用一样运行 dsh。

dshed（读作“迪谢德”）是开源 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立桌面包装。

[English](README.md) · [dshed.app](https://dshed.app) · [Releases](https://github.com/mcattx/dshed/releases) · [Issues](https://github.com/mcattx/dshed/issues)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

dsh 是一个完整的 agent harness——会话、工作区、工具、多模型路由——以 Web UI 的形式跑在 localhost 上。dshed 把这个 UI 装进 Electron 壳：内置独立 Node 22 运行时拉起引擎，一层 token 认证的本地代理把应用与引擎隔开，托盘让你随时收起再回来。装上、打开，harness 就在你的屏幕上。

与其他包装器不一样的是：**安全边界是真实的，不是摆设**。代理上的每个请求都要认证——HTTP/SSE 用会话 token，WebSocket 用 Origin 校验——窗口只允许导航到代理。威胁模型针对：恶意网页、DNS rebinding、CSRF，以及任何想从外部够到引擎的东西。

## 安装

从 [Releases](https://github.com/mcattx/dshed/releases) 下载对应平台的安装包：

| 平台 | 产物 |
|---|---|
| macOS（Apple Silicon） | `dshed-*-mac-arm64.dmg` |
| macOS（Intel） | `dshed-*-mac-x64.dmg` |
| Windows | `dshed-*-win-x64.exe` |
| Linux | `dshed-*-linux-*.AppImage` / `.deb` |

> **签名状态**：当前版本**未签名**。dshed 是社区项目，暂无力承担 Apple 开发者证书（¥688/年）与 Windows 代码签名证书费用。影响：
>
> - macOS：Gatekeeper 首次启动提示"无法验证开发者"——右键 → 打开即可运行
> - Windows：SmartScreen 可能弹出警告
> - 自动更新通道无代码签名校验
>
> **如果社区众筹或赞助者覆盖证书费用，我们将提供签名版本**——详见 [SECURITY.md](SECURITY.md)。

## 使用

启动应用，dsh 引擎自动拉起，UI 在主窗口打开，凭证自动就位——dshed 读取你环境里的 `DEEPSEEK_API_KEY` 或 `dsh auth` 配置，自己从不读取、不存储你的 key。

- macOS 关窗：应用收到托盘；点图标恢复，右键可显示/退出
- 二次启动：聚焦已有窗口，不重复拉起
- 引擎崩溃：自动重启并重连代理；连续崩溃进入错误页，而不是无声消亡

## 它能做什么

- **零配置。** 不用 `export`、不用 `--port`、没有设置页。harness 能看到你的凭证，dshed 就无事可做。
- **真实的安全边界。** 渲染进程只连代理，代理转发到 `127.0.0.1` 上的引擎（重写 Host/Origin 使引擎视为同源调用）。无 token、Origin 不匹配、伪造 Host 的请求一律拒绝；导航白名单拦下代理源之外的任何页面。
- **生命周期管理。** 端口发现、优雅退出（SIGTERM → 等待 → 杀进程树）、指数退避崩溃重启、退出时校验端口释放——没有孤儿进程，没有残留监听。
- **桌面公民。** Dock 图标、托盘菜单、窗口恢复、单实例锁，以及首次运行迁移——把已有的 `~/.dsh` 并进 dshed 数据目录，绝不覆盖任何东西。
- **更新就绪。** electron-updater 已接入，带 zip 产物与 `latest-mac.yml` 元数据；后台静默暂存新版本，重启前询问。

## 从源码构建

```bash
npm install
npm run prepare:dsh   # 下载 dsh 引擎与内置 Node 运行时
npm start             # 开发模式
```

冒烟测试覆盖引擎生命周期、认证代理、崩溃重启：`npm test`。

## 路线图

- [x] 引擎生命周期 + 认证代理——端到端验证
- [x] macOS 打包（arm64 + x64）含自动更新元数据
- [x] 托盘、窗口管理、首次运行迁移
- [ ] Windows / Linux 打包验证
- [ ] 签名 + 公证的正式发布
- [ ] 三平台 CI 构建

## 参与贡献

带复现步骤的 issue、日志、功能请求都是实打实的项目工作。保持改动范围克制，提 PR 前跑 `npm test`。

## 许可证

[MIT](LICENSE)。独立的社区项目，与 DeepSeek 官方无关联。
