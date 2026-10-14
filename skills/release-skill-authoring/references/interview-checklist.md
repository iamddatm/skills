# 生成前必问清单（三轮制）

每次生成都要读这一份，**不要凭记忆提问**：下面每一问都对应 `release.config.json` 里的一个必填字段，
漏问的后果是渲染报错（运气好）或生成出一个路径全错的技能（运气差）。

提问纪律：**一次问完**（用 ask-ui 或一次多选题），每问给选项 + 推荐，让用户只需确认。
挤牙膏式来回问会把用户耗到随便点一个了事 —— 那还不如别问。

---

## 第一轮：自己探测，不问用户

```bash
node <技能目录>/scripts/engine/release-probe.mjs <项目根> --json
```

| 探测项 | 用途 | 落到哪个字段 |
|---|---|---|
| 语言/框架（逐组件） | 选 per-framework 参考文档、定构建命令 | `commands.build` |
| 构建命令与产物目录 | 生成打包脚本 | `frontend.buildCommand` / `frontend.outputDir` / `client.buildOutputDir` |
| 版本号来源 | 决定版本号从哪读 | `version.source` |
| docker compose 文件与服务 | 生成部署脚本 | `backend.composeFile` / `services` / `singleFileMountServices` |
| 数据库迁移目录与 down 脚本 | 生成迁移脚本 | `database.migrationsDir`（down 靠文件命名约定，无独立字段） |
| 客户端形态与主 exe 名 | 生成客户端脚本 | `client.exeName` / `client.archive` |
| 前端是否由后端托管 | 决定前端是独立发布还是随后端 | `frontend.mode` |
| 现有 CI | **只作参考，不写文件** | — |

**版本号来源的优先级**（探测出来的候选，仍需用户确认用哪个）：

1. 已构建产物内嵌的版本（最可信，打进包的那份才是事实）
2. `.csproj` 的 `<Version>`
3. `package.json` 的 `version`
4. 独立 `VERSION` / `version.txt`
5. git tag

独立的版本文件容易和产物漂移，优先读产物本身。

---

## 第二轮：必须用户拍板

每条都要给选项和推荐。**用户没答的项不许填默认值**。

### 1. 发布范围与停机窗口

决定 compose 用停机更新还是滚动。

| 选项 | 说明 |
|---|---|
| 接受短暂停机（推荐，单机 compose 最省事且最可预期） | `docker compose stop/up`，秒级到分钟级不可用；DB 迁移在同一窗口内完成 |
| 零停机滚动 | 多副本 + 健康检查逐副本替换，要求新旧 API 兼容、迁移向后兼容 |
| 蓝绿/灰度 | 两套 compose 项目或反代切换，可秒级回滚，成本最高 |

→ `release.stopWindow`

### 2. 业务文件边界（**最关键的一问**）

哪些目录/后缀算「业务相关」（进更新包），哪些算「运行时」（只能靠全量包覆盖）？

| 选项 | 说明 |
|---|---|
| 排除法（推荐）：先列运行时名单，其余全算业务 | 加上 fail-closed 分类断言：构建期出现未分类文件即发版失败 |
| 逐目录列举白名单 | **不推荐**：漏一项就会出现「该更新的没更新」且完全无人察觉 |

必须让用户**逐条确认**运行时 glob。典型运行时：`*.dll`、原生模块（`*.node`）、`node_modules` 清单快照、
`package-lock.json`、`jre/**`、`runtime/**`、嵌入式运行时目录。

→ `components.client.businessGlobs` / `runtimeGlobs`

### 3. 更新清单托管

| 选项 | 说明 |
|---|---|
| 静态 HTTP / 对象存储，由**发版脚本**生成清单并上传（推荐，与后端解耦） | 后端挂了也不影响客户端更新；多机发布靠「先拉线上清单再取大版本号」保证不发低版本 |
| 后端 API 生成清单 | 服务端是唯一共享状态，多机/多人发布最稳；代价是客户端更新依赖后端可用 |
| 后端生成 + 同步到静态站 | 最稳但多一套同步机制要维护 |

→ `manifest.baseUrl` / `manifest.channel`

**问清 baseUrl 到底指什么。** 用户说「清单放 `https://dl.example.com/stable/` 上」时，
把整串填进 `baseUrl` 是**最自然的读法** —— 但 `baseUrl` 的语义是「站点根」，通道另算，
两者一拼就成了 `.../stable/stable/manifest.json`（不存在的地址）。
`release-scaffold.mjs` 现在两种填法都认并会提示，但配置语义写清楚更省事：
`baseUrl` 填站点根（`https://dl.example.com`），`channel` 填通道名（`stable`）。
托管地址本身带路径时（`https://dl.example.com/dl`），路径归 `baseUrl`，通道仍单独写。

**如果选静态站**：确认托管方能自定义 `Cache-Control`（清单必须 `no-store`）。CDN 前置时必须验证它能强制不缓存。

**再问一句：有没有「固定文件名」的产物？** 载荷包靠随机 hash 名躲开 CDN 缓存，但有些东西天然是固定 URL ——
给人点的「下载最新版」入口、项目坚持不改名的安装包、反代上「固定路径指向最新」的规则。
**这些必须 `no-store`**：固定 URL 会被 CDN 当永久资源，新包永远命中旧缓存，而且重传同名文件也清不掉边缘副本。
在本地开发时完全看不出问题，只能靠发版后验。问到的路径写进 `manifest.fixedNamePaths`，`release-verify.mjs` 会挨个验。

代价要说清：`no-store` = 每次下载都回源，所以固定名只该用于小文件或低频人工入口，载荷包一律走随机 hash。

### 4. 客户端更新执行方式

| 选项 | 说明 |
|---|---|
| 独立 updater 进程（推荐） | 主程序退出后由 `updater.exe` 替换；能替换主程序自身的 exe/dll |
| 主程序内替换 + 重启生效 | 逻辑分散在启动阶段，主 exe 替换仍受限 |
| 靠安装包静默升级 | 复用 Inno/NSIS 的静默参数，但升级包体积大 |

→ `client.updateExecutor`

### 5. 归档格式

`zip` / `tar.gz` / 按栈定。注意 Inno 的 `extractarchive` 只保证 `.7z/.zip/.rar`，用 tar.gz 要走系统 `tar.exe`。

→ `client.archive`

### 6. 后端向后兼容窗口

后端必须兼容几个客户端版本 / 多少天？决定数据库破坏性变更的节奏。

推荐：**「至少 3 个版本」与「至少 90 天」取较大者**。

→ `release.backwardCompatVersions` / `backwardCompatDays`

### 7. 数据库迁移

| 选项 | 说明 |
|---|---|
| up/down 双向脚本，可回滚（推荐） | 破坏性变更走 expand/contract：本次只加不删，N+2 再清理 |
| 只向前迁移 + 发版前备份 | 回滚靠恢复备份 |
| 框架自动迁移 | 发版脚本只负责调用与校验 |

→ `database.strategy`

### 8. 前端发布形态

独立静态站（`index.html` no-cache、带哈希资源长缓存、先传后翻指针）/ 由后端托管。

→ `frontend.mode`

### 9. 更新说明的产出方式

| 选项 | 说明 |
|---|---|
| AI 从「上次发版 tag..HEAD」的提交区间生成草稿，发版者确认（推荐） | 只写用户可感知的变化 |
| 发版者手写 + 模板校验 | 脚本只拒绝不合规措辞 |
| 纯自动 | 风险最高，容易把内部改动漏给用户看 |

→ `manifest.notesSource`

### 10. 通道与灰度

单通道 / stable+beta / 再加灰度。先做单通道，schema 预留 `channel` 字段即可。

→ `manifest.channel`

### 11. 本地保留份数与清理

发版会一轮轮堆构建产物、清单归档、业务文件清单。问清楚「保留几个版本」，
默认给**保守值**（宁多留不误删）：构建产物 1 轮、清单归档 5 份、业务文件清单 2 份。

需要反复迭代打包的项目把构建产物调到 2~3，免得下一轮改一行就得重跑全量构建。
用户说「只留最新」→ 构建产物给 1 即可；但业务文件清单**不能低于 2**
（下一轮要用上一份算删除清单，脚本会强制抬回 2）。

→ `release.retention.localDistVersions` / `localHistoryVersions` / `localPayloadFilelists`

### 12. 验收确认点

每阶段人工确认 / 只在「上线」与「回滚」两个点确认（推荐）/ 全自动。

→ `release.checkpoints`

### 13. 安装包版本从哪读（**仅客户端项目**）

`VersionInfoVersion` 只接受纯数字四段，所以安装包版本必须从**已构建产物**里读，不能读独立版本文件
（会漂移）。问清楚版本号藏在哪，把读取方式写成一段 PowerShell 表达式：

| 选项 | 表达式 |
|---|---|
| .NET 桌面端 | `(Get-Item "$payloadFull/MyApp.exe").VersionInfo.FileVersion` |
| Electron | `(Get-Content "$payloadFull/resources/app/package.json" -Raw \| ConvertFrom-Json).version` |
| 其他 | 该项目的 `--version` 输出或嵌入文件 |

→ `installer.payloadVersionCommand`（写成说明文字会被脚手架直接拒绝）

### 14. 生成后的落盘与确认状态

生成物是否入库：**推荐提交**（技能即文档，团队共享），`release-state.json` 一并提交，
下一轮才做得了变更检测。这条是纪律，不在配置里。

以及最后一件事：**参数是用户确认过的，还是按假定填的？**

- 确认过 → 把确认人写进 `release.confirmedBy`；
- 没确认 → 把每个猜的值写进 `release.pendingConfirmations`（生成物会挂「尚未就绪」横幅）。

两者必须有一个，脚手架会校验。**没有第三种状态** —— 一个「看着完整、其实全靠猜」的技能，
比一个明确标着「尚未就绪」的技能危险得多。

---

## 第三轮：探测命中才追问

| 命中 | 追问 |
|---|---|
| Electron | 是否启用 asar？是否代码签名？原生模块怎么处理？ |
| WPF / WinForms | 单文件发布？自带运行时（self-contained）？→ 决定 Inno 要不要装 .NET |
| Go / Rust | 静态链接？CGO？ |
| Python | 有 venv 吗？要不要编译 pyc？ |
| Java | 是否嵌入式 JRE？ |
| 有多个环境 | dev/staging/prod 是否共用同一份清单？**不推荐共用**，按 channel 隔离 |
| 安装根目录有业务文件之外的东西 | 哪些是「payload 覆盖不到」的 → 这些变了必须转全量 |

---

## 反问清单（生成前最后一遍自检）

渲染前逐条问自己：

- [ ] 业务文件 glob 是**用户确认过**的，不是我定的？
- [ ] 运行时 glob 覆盖了「换了就不能只发更新包」的所有东西？
- [ ] 最低支持版本的初始值是什么？（首次发版可设为当前版本）
- [ ] 兼容窗口 N 有具体数字？
- [ ] 清单托管方的缓存头可控？（客户端项目）
- [ ] 客户端归档格式与 updater 实现匹配？（客户端项目）
- [ ] 安装包的 `installer.payloadVersionCommand` 是**真表达式**，不是一句说明文字？（客户端项目）
- [ ] 本地保留份数定了？业务文件清单没被压到 2 以下？
- [ ] 生成物要落哪些 Agent 目录（是否需要 `--user`）？
- [ ] `release.confirmedBy` 与 `release.pendingConfirmations` **至少填了一个**？

任何一条答不上来，就是还没问完。

最后一条尤其别跳过：它决定了生成物是「可以直接拿去发版」还是「先跟用户把欠账对清楚」。
问不到答案不是失败，**把猜的当成确认的**才是。