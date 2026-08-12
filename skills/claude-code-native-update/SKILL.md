---
name: claude-code-native-update
description: 'Windows 受限网络环境下安装、更新或迁移 Claude Code 原生版：直连 downloads.claude.ai 报 ECONNREFUSED、"Download timed out"、"connection dropped"，claude install/update 下载超时失败，doctor 报 claude.exe 缺失或损坏，或用户提到 install claude / 安装 claude / 全新安装 / update claude / 更新 claude / 迁移到原生安装时使用。走本地代理手动下载 + SHA256 校验 + 离线部署。'
---

# Claude Code 原生安装：安装、更新与迁移

## 概述

适用于**无法直连 `downloads.claude.ai`**（直连报 ECONNREFUSED / 超时）的受限网络环境，此时必须走本地代理下载。若当前环境可以直连（官方安装/更新正常），无需本技能。

受限网络下代理下载大文件慢（完整包约 300 MB 且随版本增长，以 manifest 的 `size` 为准），因此 `claude install` / `claude update` 的**内置下载必然超时失败**。

**不要重试 `claude install` / `claude update`**，直接走下面的手动路线：PowerShell 代理下载 → SHA256 校验 → 离线部署。

## 关键事实

| 项目 | 值 |
|---|---|
| 原生二进制 | `%USERPROFILE%\.local\bin\claude.exe`（须在用户 PATH 中，缺失则手动添加） |
| 安装方式标记 | `%USERPROFILE%\.claude.json` 的 `installMethod`（原生 = `"native"`，npm = `"global"`） |
| 平台标识 | `win32-x64` |
| 版本接口 | `https://downloads.claude.ai/claude-code-releases/latest` |
| Manifest | `.../claude-code-releases/<ver>/manifest.json` → `platforms."win32-x64"` 含 `checksum`（SHA256）与 `size` |
| 二进制 URL | `.../claude-code-releases/<ver>/win32-x64/claude.exe` |
| 体检命令 | `claude doctor`（期望 "No installation issues found"） |
| 本地代理 | 以用户实际环境为准（Clash/Mihomo 混合端口常见为 `http://127.0.0.1:7890`；也可查 `$env:HTTPS_PROXY` / `$env:HTTP_PROXY`） |

所有网络请求都必须带 `-Proxy $proxy`。

## 更新原生版（常用流程）

**第 0 步：确认代理地址**——先问清用户的本地代理地址（Clash/Mihomo 常见默认 `http://127.0.0.1:7890`；用户不确定时查代理客户端设置或 `$env:HTTPS_PROXY`），下文赋给 `$proxy`。

**前半段（会话内可做）**——下载并校验：

```powershell
$proxy = 'http://127.0.0.1:7890'   # 换成用户实际代理地址
$ver  = Invoke-RestMethod 'https://downloads.claude.ai/claude-code-releases/latest' -Proxy $proxy
$man  = Invoke-RestMethod "https://downloads.claude.ai/claude-code-releases/$ver/manifest.json" -Proxy $proxy
$sum  = $man.platforms.'win32-x64'.checksum
$size = $man.platforms.'win32-x64'.size
$dl   = "$env:TEMP\claude-$ver.exe"
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest "https://downloads.claude.ai/claude-code-releases/$ver/win32-x64/claude.exe" -Proxy $proxy -OutFile $dl -TimeoutSec 0
# 两项都必须为 True 才能部署，否则删除重下
(Get-FileHash $dl -Algorithm SHA256).Hash.ToLower() -eq $sum
(Get-Item $dl).Length -eq $size
```

下载耗时随代理带宽浮动（几分钟到十几分钟不等），别按预估时间判断，**以后台任务完成通知和两项校验输出为准**：下载**必须放后台执行**，期间定期检查 `$dl` 文件大小增长，确认没卡死。注意：`sleep N && 检查大小` 这类监控命令，N 控制在约 100 秒内——Bash 工具默认 2 分钟超时，会连监控命令一起杀死（exit 143）；要盯更久就拆成多次检查或显式传 timeout 参数。

**后半段（agent 无法在自己的会话内执行）**——运行中的 claude.exe 被 Windows 锁定，锁住它的正是 agent 自己的会话，所以会话内 `Copy-Item` 必然失败。正确姿势：

1. 会话内用 Write 生成独立替换脚本 `%TEMP%\install-claude-<ver>.ps1`，三个要点：
   - 硬编码 manifest 的 SHA256 与 size，替换前离线复验一次（防下载文件在关会话后被改动）
   - `Copy-Item $dl "$env:USERPROFILE\.local\bin\claude.exe" -Force` 失败时明确报「可能还有 claude 会话或终端在运行」
   - 替换成功后 `Remove-Item $dl`
2. 🔴 CHECKPOINT · 交棒用户（流程在此离开 agent）：告知用户关闭所有 claude 会话和终端 → 新开 PowerShell 运行 `& $env:TEMP\install-claude-<ver>.ps1`（这一步只能用户做：agent 无法在自己退出后再执行命令，交代完即结束本次任务，不要尝试自己跑替换）
3. 用户开新终端验证：`claude --version` 应显示新版本，`claude doctor` 应无异常

## 全新安装原生版

适用：机器上从未装过 Claude Code，或 doctor 报 claude.exe 缺失/损坏需要修复。

前半段同上（第 0 步确认代理 → 后台下载 → SHA256 与 size 两项校验都为 True）。后半段与更新不同：目标位置没有运行中的 claude.exe，不存在 Windows 文件锁，**无需生成交棒脚本，会话内直接完成部署**：

1. `New-Item -ItemType Directory "$env:USERPROFILE\.local\bin" -Force`
2. `Copy-Item $dl "$env:USERPROFILE\.local\bin\claude.exe" -Force`。若竟报文件被锁（全新安装本不该出现，说明有旧残留正被某个会话占用），告知用户关闭相关会话后重试
3. 标记安装方式：确保 `%USERPROFILE%\.claude.json` 含 `"installMethod": "native"`——文件不存在则新建只含此键的文件；已存在则只增改这一个键，**严禁整文件覆盖**（内含登录态与用户配置）。写回用 UTF-8 无 BOM
4. 检查 PATH：`where.exe claude` 第一行应指向 `%USERPROFILE%\.local\bin\claude.exe`；未指向则把 `%USERPROFILE%\.local\bin` 追加进**用户** PATH：

   ```powershell
   $p = [Environment]::GetEnvironmentVariable('Path', 'User')
   [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ";$env:USERPROFILE\.local\bin"), 'User')
   ```

   环境变量改动只对新开的终端生效，提醒用户。
5. `Remove-Item $dl`，然后验证：新开终端 `claude --version`、`claude doctor` 应无异常；首次运行 `claude` 会进入登录流程

## 关闭自动更新（受限网络环境必须）

内置自动更新器走同一条下载通道，在受限网络下必然失败，终端会一直刷 `✘ Auto-update failed · Run claude doctor`。在 `%USERPROFILE%\.claude\settings.json` 的 `env` 块加：

```json
"DISABLE_AUTOUPDATER": "1"
```

更新只走上文手动流程。若用户终端仍在刷该提示，先查这个键在不在。

## 从 npm 迁移到原生

前半段同上。额外步骤：

1. 复制到 `.local\bin\claude.exe`。
2. `.claude.json` 中 `"installMethod": "global"` 字符串替换为 `"native"`（写回用 UTF-8 无 BOM）。
3. 卸载 **每个** node 版本下的 npm 包：`npm uninstall -g @anthropic-ai/claude-code`。使用多版本管理器（fnm/nvm-windows 等）时要逐版本卸载，残留检查认准实际安装目录下的 `node_modules\@anthropic-ai`（如 fnm 为 `%APPDATA%\fnm\node-versions\<v>\installation\`；fnm multishell 目录是每 shell 临时生成的，不可信）。
4. 验证 `where.exe claude` 第一行指向 `.local\bin\claude.exe`。

迁移不影响登录状态、settings.json、MCP 配置和会话历史。

## 常见错误

| 错误 | 后果/正解 |
|---|---|
| 先试直连、反复重试 `claude install`/`claude update`，或以为给它们设 `HTTPS_PROXY` 环境变量就行 | 受限网络下全部必然失败（内置下载有时限，即使走代理也常超时）；直接走手动路线 |
| 跳过 SHA256/大小校验 | 断点残缺文件装上去直接启动崩溃 |
| 用 `sleep 120 && ...` 之类的长命令监控后台下载 | Bash 工具默认 2 分钟超时把监控命令一起杀（exit 143）；单次 sleep 控制在约 100 秒内，或显式传 timeout 参数 |
| 会话还在运行就替换二进制 | 文件被锁，EPERM；必须先关闭所有 claude 会话 |
| 只卸当前 node 版本 | 其他版本残留 shim，切换 node 后旧版复活 |
| 迁移后再跑 `npm install -g @anthropic-ai/claude-code` | 双安装冲突，`claude update` 报 multiple installations |
| 在 agent 的 Bash/POSIX shell 工具里直接粘 PowerShell 代码 | 底层是 Git Bash/POSIX shell，须包 `pwsh -c '...'` 并处理 `$` 转义（外层用单引号包裹，或转义内部 `$`） |
| 留着自动更新等它自己好 | 受限网络下必然失败、提示常驻；`settings.json` 的 `env` 加 `DISABLE_AUTOUPDATER=1` 关掉，走手动流程 |
| 全新安装也照更新流程生成交棒脚本等用户执行 | 全新安装目标位置无文件锁，会话内直接部署即可；盲目交棒徒增用户操作 |
| 为写 `installMethod` 整文件覆盖 `.claude.json` | 该文件含登录态与用户配置，必须保留原内容只改这一个键 |
