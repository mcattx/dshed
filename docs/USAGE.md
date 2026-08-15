# dshed 使用指南

本文面向 dshed 的最终用户：安装、使用、配置与常见问题。

## 安装

从 [Releases](https://github.com/mcattx/dshed/releases) 页面下载对应平台的安装包：

| 平台 | 安装包 |
|---|---|
| macOS（Apple Silicon） | `dshed-*-mac-arm64.dmg` |
| macOS（Intel） | `dshed-*-mac-x64.dmg` |
| Windows | `dshed-*-win-x64.exe` |
| Linux | `dshed-*-linux-*.AppImage` / `*.deb` |

### macOS 首次打开

当前版本**未签名**。首次打开会提示"无法验证开发者"，请：

1. 右键（或按住 Control 点击）应用图标
2. 选择「打开」
3. 确认打开

以后即可正常双击启动。

### Linux

- AppImage：`chmod +x dshed-*.AppImage && ./dshed-*.AppImage`
- deb：`sudo dpkg -i dshed-*.deb`

## 首次使用

启动 dshed 后，dsh 引擎会自动拉起，主窗口显示引擎界面。

**API 凭证**：dshed 不读取、不存储你的 API Key。首次使用时：

- 若你的系统环境已有 `DEEPSEEK_API_KEY`（或已配置 `dsh auth`），引擎会自动使用，无需任何操作；
- 否则引擎会显示引导页，按提示填写 API Key 并保存（密钥保存在本机的 dsh 凭证文件中，权限 0600）。

## 日常使用

### 窗口与托盘

| 操作 | 行为 |
|---|---|
| 关闭窗口（macOS） | 应用收到托盘，点击托盘图标恢复 |
| 点击托盘图标 | 恢复/聚焦主窗口 |
| 右键托盘图标 | 菜单：显示 dshed / 退出 |
| 点击 Dock 图标（macOS） | 恢复主窗口 |
| 再次启动应用 | 聚焦已有窗口，不会重复拉起 |

Windows / Linux 上关闭窗口会直接退出应用。

### 引擎状态

- 引擎崩溃：dshed 自动重启并重连（最多重试 5 次，指数退避）
- 连续崩溃：显示错误页，而非无声退出
- 引擎的日志输出在启动时的控制台（开发模式）或系统日志

### 更新

dshed 启动后会在后台检查新版本：

- 发现新版本：自动下载
- 下载完成：弹窗提示「立即重启 / 稍后」
- 选择立即重启：应用自动更新并重启

## 常见问题

**Q: dshed 和 DeepSeek 官方是什么关系？**
A: 无关联。dshed 是独立社区项目，包装的是开源项目 DeepSeek Harness。

**Q: 我的 API Key 存在哪里？**
A: 你通过 dsh 界面填写的密钥保存在本机 dsh 凭证文件（`~/.dsh/.credentials.yaml` 或 dshed 数据目录的 `dsh/.credentials.yaml`），权限 0600。dshed 本身不接触它。

**Q: 启动后窗口是空白/错误页？**
A: 通常是引擎启动失败。请完全退出后重新启动；若持续失败，可在 Issue 中附上启动日志。

**Q: 如何卸载？**
A: 直接删除应用（macOS 拖入废纸篓；Windows 用卸载程序；Linux 用包管理器）。用户数据在系统应用数据目录（macOS 为 `~/Library/Application Support/dshed`），如需彻底清理一并删除。

## 隐私与遥测

dshed 本身不收集任何遥测、分析或崩溃报告。

dsh 引擎会生成一个**匿名随机 UUID**（`.anonymous-user-id`），按上游说明随会话遥测与 DeepSeek 请求发送（请求头 `x-deepseek-harness-user-id`）。该 ID 不包含任何可识别身份的信息；删除该文件可重置身份；设置环境变量 `DSH_TELEMETRY_DISABLED=1` 可关闭遥测导出。

## 反馈问题

遇到问题请到 [Issues](https://github.com/mcattx/dshed/issues) 提交，附上：
- 平台与版本（macOS 14 / Windows 11 / Ubuntu 22.04…）
- dshed 版本号（设置或关于中可见）
- 复现步骤与现象
