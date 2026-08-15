# dshed 开发指南

面向想二次开发或参与 dshed 的开发者。

## 架构概览

dshed 是一个 Electron 桌面壳，把 dsh（DeepSeek Harness）引擎包装成原生应用：

```
┌──────────────┐   仅连代理    ┌──────────────┐   本地转发     ┌──────────────┐
│  Electron    │ ────────────► │  dshed 认证  │ ────────────► │  dsh 引擎     │
│  主窗口       │   token 注入   │  代理（HTTP/WS）│  Host/Origin  │（内置 Node）  │
└──────────────┘               └──────────────┘   重写          └──────────────┘
```

| 模块 | 职责 |
|---|---|
| `src/main.js` | 应用生命周期、窗口、托盘、引擎与代理编排、安全白名单 |
| `src/engine-manager.js` | dsh 引擎子进程生命周期：spawn、端口发现、健康检查、崩溃重启、退出清理 |
| `src/auth-proxy.js` | 本地认证代理：HTTP token 注入校验、WS Origin 校验、Host/Origin 重写、CSRF 防护 |
| `src/migration.js` | 首次启动迁移（合并旧 `~/.dsh`）、版本记录与升级钩子 |
| `src/updater.js` | electron-updater 自动更新（仅打包版启用） |
| `src/preload.js` | 渲染进程最小桥接（白名单信息） |
| `src/assets/` | 自有页面：启动页、错误页、图标、托盘图 |

### 安全模型

- 渲染进程只连接代理源（`http://127.0.0.1:<port>`），窗口导航白名单拦截其余地址
- 代理对每个请求认证：HTTP/SSE 用会话 token，WS upgrade 用 Origin 校验
- 代理转发时重写 Host 与 Origin，使 dsh 引擎视为同源调用（dsh 对 mutation 请求有 CSRF Origin 检查）
- API 凭证由 dsh 引擎自行管理（环境变量或 dsh 凭证文件），dshed 不读取、不存储

## 开发环境

要求：Node.js 22+（开发机）、npm。

```bash
npm install
npm run prepare:dsh   # 下载 dsh 引擎 + 内置 Node 运行时（跨平台用 HARBOR_TARGET_ARCH 指定）
npm start             # 开发模式（GUI）
```

## 构建与测试

```bash
npm test              # 冒烟测试（引擎生命周期 + 认证代理 + 崩溃重启）
npm run verify        # 冒烟验证脚本
npm run dist -- --mac --arm64   # 打包 mac arm64（其它平台同理：--win/--linux + arch）
```

### 跨平台资源

`resources/` 含平台相关的 Node 运行时与 dsh 原生依赖（koffi 等），**按平台/架构单独准备**：

```bash
HARBOR_TARGET_ARCH=darwin-x64 node scripts/prepare-dsh.js   # mac x64
HARBOR_TARGET_ARCH=win32-x64  node scripts/prepare-dsh.js   # win x64（需在 Windows 或相应环境）
HARBOR_TARGET_ARCH=linux-x64  node scripts/prepare-dsh.js   # linux x64
```

注意：原生依赖（如 koffi）只能在对应系统上安装，跨平台打包请使用 CI 或真机。

### 打包与签名

- 项目**不使用开发者证书签名**（`mac.identity: null`），构建产物 ad-hoc 签名
- 未来配置个人证书：在 `electron-builder.yml` 的 `mac.identity` 指定，并在 `build/after-sign.js` 中重签主应用

## 发布流程

1. 更新版本号（`package.json`）
2. 在目标平台（或 CI）上 `npm run prepare:dsh` + `npm run dist -- --<platform> --<arch>`
3. 将产物与 `latest*.yml` 上传到 GitHub Releases
4. 客户端自动更新即可检测到新版本

## 代码规范

- 2 空格缩进、单引号、无分号（参考 `.eslintrc` 风格）
- 保持改动范围克制，避免新增重复职责的封装
- 用户可见日志用中文，代码注释与项目风格一致
- 提交前跑 `npm test`

详见 [贡献规范](CONTRIBUTING.md)。
