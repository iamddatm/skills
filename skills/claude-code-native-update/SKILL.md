---
name: claude-code-native-update
description: 'Windows 受限网络环境下安装、更新或迁移 Claude Code 原生版：直连 downloads.claude.ai 报 ECONNREFUSED、"Download timed out"、"connection dropped"，claude install/update 下载超时失败，doctor 报 claude.exe 缺失或损坏，或用户提到 install claude / 安装 claude / 全新安装 / update claude / 更新 claude / 迁移到原生安装时使用。走本地代理手动下载 + SHA256 校验 + 离线部署；更新流程在交棒前附「变更总结与配置影响分析」，用户更新后追问「更新了什么」「这次更新对我有什么影响」时同样使用。'
---

# Claude Code 原生安装：安装、更新与迁移

## 概述

适用于**无法直连 `downloads.claude.ai`**（直连报 ECONNREFUSED / 超时）的受限网络环境，此时必须走本地代理下载。若当前环境可以直连（官方 install/update 正常），无需本技能。

受限网络下 `claude install` / `claude update` 的**内置下载必然超时失败**，**不要重试它们**，直接走手动路线：代理下载 → SHA256 校验 → 离线部署。更新与全新安装只在最后一步不同。

## 关键事实

| 项目 | 值 |
|---|---|
| 原生二进制 | `%USERPROFILE%\.local\bin\claude.exe`（须在用户 PATH 中，缺失则手动添加） |
| 安装方式标记 | `%USERPROFILE%\.claude.json` 的 `installMethod`（原生 = `"native"`，npm = `"global"`；缺失会让 `claude doctor` 报 issue） |
| 平台标识 | `win32-x64` |
| 版本接口 | `https://downloads.claude.ai/claude-code-releases/latest` |
| Manifest | `.../claude-code-releases/<ver>/manifest.json` → `platforms."win32-x64"` 含 `checksum`（SHA256）与 `size` |
| 二进制 URL | `.../claude-code-releases/<ver>/win32-x64/claude.exe` |
| 体检命令 | `claude doctor`（期望 "No installation issues found"） |
| 官方 CHANGELOG | `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`（约 1 MB，`## <版本号>` 分节、新版在前；先直连、失败再加代理） |
| 文档索引 | `https://code.claude.com/docs/llms.txt` |
| 配置键总表 | `https://code.claude.com/docs/en/settings-reference.md` |
| 本地代理 | 三级优先级自动检测（`proxy-detect.ps1`） |

发往 `downloads.claude.ai` 的请求必须带代理。

**取文档要认后缀**：`.md` 直取纯 markdown（如上表的 settings-reference.md）；`.html` 是 SPA，**正文不在 HTML 源码里**，抓下来是空壳。查配置键直取 `.md`，找不到入口再翻 `llms.txt` 索引。

## 执行纪律

这几条不是风格偏好，是实测踩出来的——每违反一次就是一轮白耗。

### 1. PowerShell 一律先落盘成 .ps1，再 `pwsh -NoProfile -File` 执行

Bash 工具的底层是 Git Bash：内联 `pwsh -c "..."` 里的双引号与 `$` 会被 Git Bash 提前展开，实测两次因转义翻车，每次白耗一轮。

- **固定脚本已随技能提供，不要重写**，直接调用技能目录下的 `scripts/`：`proxy-detect.ps1`、`download.ps1`、`changelog.ps1`、`changelog-index.ps1`、`recon.ps1`。技能加载时给出的 Base directory 就是技能目录，拼 `/scripts/<名字>.ps1` 即可：

  ```bash
  pwsh -NoProfile -File "<技能目录>/scripts/proxy-detect.ps1"
  ```

  该目录缺失说明技能安装没更新到位——重新安装技能，不要用手抄脚本顶上。
- 一次性脚本（如替换脚本）也用 Write 工具写进 `%TEMP%\cc-*.ps1` 再执行。
- **不要在 `pwsh -c "..."` 里写嵌套引号或 PowerShell 变量**。确实需要一行短命令时，用单引号包裹且不含 `$`。
- 自己写的 .ps1 首行加 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`——pwsh 默认按 GBK 输出、Git Bash 按 UTF-8 读，不设则中文乱码。

### 2. 能并发的绝不串行

见下面的阶段表。归纳与配置影响分析互不依赖，必须同一轮发起。

### 3. 禁止轮询后台任务

下载丢后台后**不要再 sleep 检查文件大小**：任务完成会主动通知，轮询实测纯浪费 90 秒（文件 15 秒就下完了）。等待期拿去做配置影响分析。只在长时间收不到通知时才兜底看一次。

### 4. 不要给下载写死时间预期

带宽充足时下载根本不是瓶颈（实测 248 MB / 14.6 s）。成败**以两项校验的输出为准**，别按预估时间判断卡没卡死。

## 并发流水线

| 阶段 | 何时进入 | 同一轮里并发发起 |
|---|---|---|
| A 起点 | 会话开始 | ① `proxy-detect.ps1`　② `changelog.ps1`（直连，失败自动加代理）　③ `recon.ps1` 本地侦察 |
| B 下载 | 代理验证通过 | `download.ps1` **丢后台**（解析版本 → 取 manifest → 下载 → 双校验，一条龙） |
| C 重活 | CHANGELOG 已落盘即可，**不必等下载** | ① K 个归纳子 agent　② 主 agent 做配置影响分析 |
| D 合并 | 下载 `VERIFY_OK=True` 且归纳已返回 | 合并式抽查 → 输出七段总结 → 生成替换脚本 → 交棒 |

阶段 A 的三项互不依赖，一条消息里同时发出去。阶段 C 的两项也互不依赖——实测把它们串起来做过一次，白白多等 6.8 分钟，那正是整条流程最大的瓶颈。

## 更新原生版（常用流程）

### 第 0 步：检测并验证代理

```bash
pwsh -NoProfile -File "<技能目录>/scripts/proxy-detect.ps1"
```

按三级优先级检测并逐个做连通性验证：环境变量 `HTTPS_PROXY`/`HTTP_PROXY` → Windows 系统代理注册表 → 常见本地端口（7890/10809/1080）。输出 `PROXY_OK=<url>` 或 `NO_PROXY_FOUND`。

**只有 `NO_PROXY_FOUND` 才去问用户**——系统通常已经配好代理，直接问纯属多一轮无意义交互。要用 `AskUserQuestion` 的话给常见默认值（Clash `http://127.0.0.1:7890`、V2Ray `http://127.0.0.1:10809`），拿到后用同一脚本验证。

### 第 1 步：后台下载并校验

```bash
pwsh -NoProfile -File "<技能目录>/scripts/download.ps1" -Proxy "<proxy>"    # 丢后台执行
```

输出 `VERSION` / `EXPECT_SHA256` / `EXPECT_SIZE` / `FILE` / `DOWNLOAD_SECONDS` / `VERIFY_SHA256` / `VERIFY_SIZE`，末行 `VERIFY_OK`。**两项校验都为 True 才能部署**，否则删掉重下（残缺文件装上去会直接崩溃）。丢后台后按纪律 3 处理，不要再轮询。

### 第 2 步：拉 CHANGELOG（与下载并行）

```bash
pwsh -NoProfile -File "<技能目录>/scripts/changelog.ps1" -Version "<ver>" -Proxy "<proxy>"
```

先直连 `raw.githubusercontent.com`，失败自动加代理（未给 `-Proxy` 时它会自己调 `proxy-detect.ps1`）。落盘 `%TEMP%\cl-changelog-<ver>.md`，同日已有缓存直接复用（`CACHE_HIT=True`，重跑免下载）。

### 第 3 步：变更总结与配置影响分析（交棒前必须完成）

交棒后本会话即结束，等用户替换完再想补做，已经没有会话可以执行了。

版本区间 = **本机当前版本（不含）→ 新版本**。起点用 `claude --version` 取，此刻它仍是替换前的旧版本（`recon.ps1` 已含）。区间不含旧版本自己那一节——那是用户已经装上的内容，写进「你更新到了什么」只是噪声。

若用户是在**更新完成后**的新会话里追问「更新了什么」（没有本次下载校验的上下文），区间起点用 `AskUserQuestion` 问用户旧版本号——别猜，此时 `claude --version` 已经是新版本了。

#### 3a. 归纳：按区间大小决定要不要切段并发

先算区间，脚本会直接给出每段的 `OFFSET` / `LIMIT`：

```bash
pwsh -NoProfile -File "<技能目录>/scripts/changelog-index.ps1" \
  -File "$TEMP/cl-changelog-<ver>.md" -Old "<旧版本>" -New "<新版本>" -K 4
```

- **版本数 ≤ 10**：主 agent 直接读，不开子 agent（扇出反而不划算）。
- **版本数 > 10**：按 `SEGMENT` 行同一轮并发 K=3~4 个 general-purpose 子 agent，每人只读自己那段（Read 的 offset/limit 照抄脚本给的 OFFSET/LIMIT）。并发就用 Agent 工具、在一条消息里发多个调用即可，规模远在合理范围内；`Workflow` 工具需要用户显式授权，不要擅自启用。

让**单个**子 agent 串行读完 1600 行实测 6.8 分钟，是整条流程最大的瓶颈；切 4 段并发后每段只有 300~500 行。

**子 agent 必须按固定字段逐条返回**——缺字段的条目无法抽查，会被打回重来：

```
版本号 | 主题分类 | 原文关键句（英文原句） | 行号 | 是否涉及 settings/env/hooks/MCP/权限/CLAUDE.md/AGENTS.md
主题分类 ∈ {新功能, 行为与破坏性变更, 安全修复, 更新机制修复}
```

要求带**行号 + 英文原句**，正是为了下一步能直接核对，而不是再去全文搜索。

#### 3b. 抽查（合并成一条，别串行 grep 六次）

🔴 子 agent 的条目**必须回原文抽查**，且**抽查必须放宽关键词**：实测用窄词 `non-UTF-8` 判定某条不存在，换成宽匹配 `not valid UTF-8` 后原文命中。窄词的否定结论不可采信，它会把真实条目误判成编造。

用**一条交替正则 + `-n`** 一次取全部候选行；子 agent 已给行号，直接对行号核：

```bash
grep -n -E -i "关键词1|关键词2|关键词3" "$TEMP/cl-changelog-<ver>.md"
```

#### 3c. 配置影响分析（与归纳并行做）

读 `%USERPROFILE%\.claude\settings.json`、全局 `CLAUDE.md` / `AGENTS.md`、项目级 settings，看哪些变更恰好落在用户已设的键位或已写下的约定上。`recon.ps1` 已经把键位、hooks 事件、MCP 服务器与传输类型列了出来，直接拿它的输出对照 CHANGELOG 条目。

**`.claude.json` 只读，严禁写入**（内含登录态）。确实没有影响就直说「未见直接影响」，不为凑数编关联。

拿不准某个键是否真实存在，用下面的二进制字符串检索定论，别去爬文档。

#### 3d. 输出七段（固定顺序）

1. **版本区间**——旧 → 新
2. **与你配置相关**（置顶）——逐条「变更 + 受影响的文件/约定 + 建议动作」
3. **新功能速览**——只列用户可感知的命令、flag、键位
4. **行为变更 / 破坏性变更**——每条标注「想保持旧行为要怎么做」
5. **性能与安全修复**——概述
6. **安装更新机制相关**——与手动流程有关的部分
7. **待确认项**——需要用户回答才能给出准确建议的问题

### 第 4 步：生成替换脚本并交棒

运行中的 claude.exe 被 Windows 锁定，锁住它的正是 agent 自己的会话，所以会话内 `Copy-Item` 必然失败（EPERM）。正确姿势：

1. 会话内用 Write 生成独立替换脚本 `%TEMP%\install-claude-<ver>.ps1`，三个要点：
   - 硬编码 manifest 的 SHA256 与 size，替换前离线复验一次（防下载文件在关会话后被改动）
   - `Copy-Item $dl "$env:USERPROFILE\.local\bin\claude.exe" -Force` 失败时明确报「可能还有 claude 会话或终端在运行」
   - 替换成功后 `Remove-Item $dl`；`installMethod` 的补写也放在这里（理由见下节）
2. 🔴 CHECKPOINT · 交棒用户（流程在此离开 agent）：**交棒前必须已输出变更总结**（见第 3 步），交棒后无法补做 → 告知用户关闭所有 claude 会话和终端 → 新开 PowerShell 运行 `& $env:TEMP\install-claude-<ver>.ps1`。这一步只能用户做：agent 无法在自己退出后再执行命令，交代完即结束本次任务，不要尝试自己跑替换。
3. 用户开新终端验证：`claude --version` 应显示新版本，`claude doctor` 应无异常，`claude mcp list` 应正常（2.1.292 起 MCP 协议协商规则有变，stdio 服务器值得复验一遍）。

## installMethod：只动一个键

`installMethod` 缺失时 `claude doctor` 会报 issue。两条容易踩的：

- **更新的场合把它写进替换脚本**：会话内改会被运行中的会话在退出时回写覆盖；替换脚本在「所有 claude 会话已关闭」之后运行，才写得进去。
- **只增改这一个键，严禁整文件覆盖**——`.claude.json` 内含登录态与用户配置。写回用 UTF-8 无 BOM。

该键是否存在、合法取值是什么，用下面的方法在 claude.exe 里查（实测能读到 `if (e==="native" && s.installMethod!=="native")` 的判定逻辑与报错文案）。

## 配置键真伪核查：直接翻二进制字符串

判断某个配置键 / env 变量 / 特性开关是不是 Claude Code 的、有哪些合法取值，最便宜也最权威的手段是在二进制里搜字符串——比爬文档快得多（本轮爬文档绕了 3 轮，这里一条命令定论）：

```bash
f=~/.local/bin/claude.exe
grep -a -o -F "installMethod" "$f" | wc -l              # 0 = 这个键在 Claude Code 里根本不存在
grep -a -o -P '.{0,120}installMethod.{0,220}' "$f"      # 命中即取上下文，能直接读到判定逻辑与合法取值
```

实测用它判定了三件事：`installMethod` 命中 32 次（存在）、`litellm_settings` / `allowed_openai_params` 命中 0 次（是 LiteLLM 的键，写在这里无效）、`MCP_PROTOCOL_NEGOTIATION` 与 `DISABLE_AUTOUPDATER` 均命中（CHANGELOG 条目属实）。同一手段也可反过来验证 CHANGELOG 里拿不准的条目。

搜的是磁盘上的 claude.exe（已安装的或刚下载的，两者同源），不是当前会话进程。

## 全新安装原生版

适用：机器上从未装过 Claude Code，或 doctor 报 claude.exe 缺失/损坏需要修复。

前半段同上（第 0~2 步）；**第 3 步变更总结跳过**——没有旧版本，也就没有区间起点。后半段与更新不同：目标位置没有运行中的 claude.exe，不存在 Windows 文件锁，**无需交棒脚本，会话内直接完成部署**：

1. `New-Item -ItemType Directory "$env:USERPROFILE\.local\bin" -Force`
2. `Copy-Item $dl "$env:USERPROFILE\.local\bin\claude.exe" -Force`。若竟报文件被锁（全新安装本不该出现，说明有旧残留正被某个会话占用），告知用户关闭相关会话后重试
3. 确保 `%USERPROFILE%\.claude.json` 含 `"installMethod": "native"`——文件不存在则新建只含此键的文件；已存在则只增改这一个键，**严禁整文件覆盖**。写回用 UTF-8 无 BOM
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

前半段同上，**变更总结通常跳过**（迁移前后版本一致，无区间可总结）。额外步骤：

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
| 下载丢后台后 `sleep` 轮询文件大小 | 任务完成会主动通知，轮询实测白耗 90 秒；等待期应并行做配置影响分析，只在长时间无通知时兜底查一次 |
| 用内联 `pwsh -c "..."` 跑长脚本，或命令里带嵌套引号/`$` | Git Bash 会提前展开引号与 `$`，实测两次翻车各白耗一轮；一律先落盘 .ps1 再 `pwsh -NoProfile -File` |
| 让单个子 agent 串行读完整个版本区间 | 实测 1600 行耗 6.8 分钟，是最大瓶颈；按 K=3~4 段并发，≤10 个版本时主 agent 直读 |
| 归纳与配置影响分析串行做 | 两者互不依赖，串行等于白等；同一轮并发发起 |
| 抽查按主题串行 grep 多次 | 合并成一条交替正则 + `-n`，一次取全 |
| 用窄关键词抽查、据此否定子 agent 的条目 | 会把真实条目误判成编造（窄词 `non-UTF-8` 漏掉原文 `not valid UTF-8`）；抽查一律放宽关键词 |
| 从 `settings.html` 这类 SPA 页面找配置键 | `.html` 正文不在源码里，抓到的是空壳；直取 `.md`（如 `docs/en/settings-reference.md`），找不到入口再查 `llms.txt` |
| 会话还在运行就替换二进制 | 文件被锁，EPERM；必须先关闭所有 claude 会话 |
| 在会话内改 `.claude.json` 的 `installMethod` | 运行中的会话会在退出时回写覆盖；写进替换脚本，等会话都关了再改 |
| 为写 `installMethod` 整文件覆盖 `.claude.json` | 该文件含登录态与用户配置，必须保留原内容只改这一个键 |
| 只卸当前 node 版本 | 其他版本残留 shim，切换 node 后旧版复活 |
| 迁移后再跑 `npm install -g @anthropic-ai/claude-code` | 双安装冲突，`claude update` 报 multiple installations |
| 留着自动更新等它自己好 | 受限网络下必然失败、提示常驻；`settings.json` 的 `env` 加 `DISABLE_AUTOUPDATER=1` 关掉，走手动流程 |
| 全新安装也照更新流程生成交棒脚本等用户执行 | 全新安装目标位置无文件锁，会话内直接部署即可；盲目交棒徒增用户操作 |
| 跳过代理自动检测直接问用户 | 系统通常已配好代理（环境变量/系统设置/本地端口），直接问多一轮无意义交互；按第 0 步三级检测，全部失败再问 |
| 交棒后才想起做变更总结 | 会话已结束，等用户替换完已无人可执行；总结必须在 🔴 CHECKPOINT 之前完成 |
| 凭训练数据里的记忆写变更条目 | 记忆中的版本信息与实际 CHANGELOG 常不符，会写出根本不存在的变更；一律回原文取 |
| 影响分析时顺手改 `.claude.json` | 分析阶段只读；该文件含登录态，任何写入都只应是迁移/全新安装所需的 `installMethod` 单键改动 |
