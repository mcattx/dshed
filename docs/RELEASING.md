# dshed 发布手册

把打包产物发布到 GitHub Releases（客户端自动更新也依赖此流程）。

## 前置条件

1. 仓库已重建并推送（`github.com/mcattx/dshed`）
2. 仓库设置开启 **Private vulnerability reporting**（Settings → Security）
3. 一个 GitHub token，权限：`Contents: write`（用于上传 Release 产物）

## 重要：产物可发布性检查

| 产物 | 可发布？ | 说明 |
|---|---|---|
| mac-arm64 dmg/zip | ✅ | 完整（本机验证过） |
| mac-x64 dmg/zip | ✅ | 完整（资源已按 x64 准备） |
| win-x64 exe | ⚠️ 待真机重打 | 当前是"壳"，koffi 原生模块需在 Windows 上 `npm run prepare:dsh` 后重新构建 |
| linux x64/arm64 | ⚠️ 待真机重打 | 同上，需 Linux 环境 |
| latest*.yml | 随对应构建生成 | 发布时与产物一起上传 |

**mac 自动更新的架构限制**：`latest-mac.yml` 由最后一次构建生成。当前单架构构建下，它只指向一个架构的 zip——另一架构用户无法自动更新（只能手动下载）。解决：优先发布 arm64（主流），x64 手动下载；或未来用 CI 双架构构建一次生成合并元数据。

## 方案 A：electron-builder 自动发布（推荐）

electron-builder 构建后自动创建 Release、上传产物、生成并上传 `latest*.yml`：

```bash
export GH_TOKEN=ghp_xxx            # 或 GitHub Actions 环境变量
npm run dist -- --mac --arm64 --publish always
```

- `--publish always`：强制发布（默认 onTagOrDraft 只在有 tag 时发布）
- 首次会给最新 commit 打 tag `v0.1.0`？——不，`--publish always` 上传到**已存在的 tag**；没有 tag 请先打：
  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```
- 上传完成后在 GitHub 网页编辑 Release 标题/说明（Release notes 自动取自 CHANGELOG 或手动填）

## 方案 B：手动上传

1. 打 tag 并推送：
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
2. GitHub 网页 → Releases → **Draft a new release** → 选 tag `v0.1.0`
3. 上传产物（**必须包含对应的 latest*.yml，否则自动更新失效**）：
   ```
   dshed-0.1.0-mac-arm64.dmg
   dshed-0.1.0-mac-arm64.zip
   dshed-0.1.0-mac-arm64.dmg.blockmap
   dshed-0.1.0-mac-arm64.zip.blockmap
   latest-mac.yml
   ```
4. 填写 Release 说明（参考 CHANGELOG），点击 Publish

## 发布后验证

- 网页上确认产物可下载
- 打开已安装的 dshed，检查自动更新是否能检测到新版本
- 用另一台 arm64 mac 下载 dmg，验证 Gatekeeper 提示与右键打开流程

## 安装 gh CLI（可选，手动上传命令行版）

```bash
brew install gh
gh auth login                        # 走浏览器授权，无需手动 token
gh release create v0.1.0 "dist/dshed-0.1.0-mac-arm64.dmg" "dist/latest-mac.yml" --title "dshed v0.1.0" --notes "..."
```
