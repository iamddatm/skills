---
name: release-skill-authoring
description: '元技能：为某个具体项目**生成或优化它专属的发版技能**，在项目内 `.claude/skills/` 下产出一个自包含的发版技能包（含数据库迁移、后端 docker compose、前端、客户端更新包与全量包、Inno Setup 安装包、更新清单、更新说明、本地清理）。**生成**用于把某个项目的发版/上线流程固化成可重复执行的技能：「做个发版 skill」「生成发版技能」「写一个发版用的 SKILL.md」「把发版流程沉淀下来」「给这个项目配一套发版流程」「让几个 Agent 都能用的发版技能」。**优化**用于已有的发版技能需要改进：换项目或改业务文件边界、加客户端、补保留清理策略、引擎或模板落后了、上次发版踩的坑要固化、手写的发版技能（没有 `release.config.json` 的那类）要升级成规范形态 —— 用户说「优化/改进/升级一下发版 skill」「发版技能该更新了」「把这个发版流程整理规范」时也归本技能。用户要求压缩流程时更要保持它（「别搞那么复杂」「直接给我写一个 SKILL.md 就行」「别的不用管」）—— 省略的是解释，不是探测与确认那两步；关键参数没给就必须问，问不到就登记成待确认，不许编一个看起来合理的值。⚠️ 本技能生成/优化那个技能，**不代替它执行发版** —— 用户只是说「发版」「上线」「部署」而目标是发这一次版时，不要用本技能。生成 Windows 客户端发版技能时依赖 inno-setup-installer。'
---

# 项目发版技能生成器

**违反规则的字面含义,就是违反规则的精神。**

本技能**不负责替某个项目发版**，它负责**生成那个项目的发版技能**。生成出来的技能自包含，之后每次发版直接调用它，不需要再回到本技能。

## 概述

产出 `<目标项目>/.claude/skills/<slug>-release/`：SKILL.md（本项目命令已实例化）+ `release.config.json`（项目参数，真源）+ `references/` + `scripts/`（引擎副本 + 项目专属包装脚本）。

**两个入口**：从零**生成**（下一条流程），以及**优化已有的**发版技能（见「更新已有的发版技能」）。
后者不是前者的简化版 —— 已有的技能上有项目做过的改动，覆盖它需要先备份、先比对。

**本技能不做什么**（这些是红线，别顺手扩）：

- 不替项目改 CI（读 `.github/workflows/` 只作参考，不写文件）
- 不代管密钥、不生成 SSH 私钥、不把凭据写进任何产物
- 不替项目决定业务文件边界（必须由用户拍板，见第二步）
- 不在目标项目里执行发版（生成 ≠ 发布）

## REQUIRED SUB-SKILLS

**inno-setup-installer**（生成 Windows 客户端安装包时必需）。

若目标项目没有 Windows 客户端，inno-setup-installer 缺失不影响生成 —— 生成物自动省略安装包章节与 `build-installer.ps1`，客户端只保留更新包/全量包。若有 Windows 客户端而它缺失，**先安装再生成**，不要凭记忆手写 `.iss`。

## 生成流程四阶段

```
1 探测      release-probe.mjs 收集事实（只读，不写文件）
2 提问      按 references/interview-checklist.md 逐项确认，写不出答案的不许猜
3 CHECKPOINT 把「将生成什么 + 关键参数」念给用户，等确认
4 渲染      release-scaffold.mjs 生成；再跑自检（无占位符残留、清单可解析）
```

四阶段之间不许跳步。特别是 2 → 3：**没有经过 CHECKPOINT 的生成物一律作废重来**。

### 用户要求缩小范围时（「别的不用管」「直接给我写个 SKILL.md 就行」）

**能省的**：解释、长文档、按栈细分的参考、你替用户做的取舍说明。
**不能省的**：探测（不看项目就写 = 猜路径），以及把无法确定的关键参数摆出来要用户拍板。

前者是**表达**，后者是**正确性**。一个没探测过、参数靠猜的发版技能比没有技能更糟 ——
它会以「规范」的形态把错的东西固化下来，后面每次发版都照着它走。

但产物范围确实可以按用户要求收窄，**代价要说清再让他选**：

| 只给 | 会失去 |
|---|---|
| 一个手写的 SKILL.md | 自检、可执行性冒烟、引擎（打包/清单/版本号/清理都得现写），而且**没法再用 `--adopt` 优化它** —— 它没有配置真源 |
| SKILL.md + `release.config.json` | 少了引擎与脚本，但参数是显式的一份，之后能补齐 |
| 完整技能包（默认） | — |

所以正确的回答既不是照做但留个半成品，也不是无视用户硬上全套：
**把最小集和它的代价讲清楚，让用户挑。** 用户仍然选最小集就照办 ——
但要在技能里写明哪些是假定、以及后续怎么补（补上 `release.config.json` 就能 `--adopt`）。

## 第一步：先探测，再提问

```bash
node <技能目录>/scripts/engine/release-probe.mjs <目标项目根> --json
```

它扫出候选事实：语言/框架、构建线索、compose 文件与服务、迁移目录、版本号来源、CI 配置。每条结论都带证据文件路径。

**探测结果只是候选，不是答案。** 探测不到的东西恰恰是最关键的（业务文件边界、停机窗口、清单托管地址、兼容窗口），必须问。

## 第二步：必问清单

**读 `references/interview-checklist.md`，按里面的三轮制逐项走。** 不要凭记忆提问 —— 那份清单里的每一问都对应生成物里的一个必填字段，漏问就会在渲染时报错（或更糟：生成出一个路径全错的技能）。

三轮的分工：

| 轮次 | 内容 | 处理方式 |
|---|---|---|
| 第一轮 | 语言/框架、构建命令、产物目录、版本号来源、compose 服务、迁移目录 | 自己探测，**不问用户** |
| 第二轮 | 停机窗口、业务/运行时文件边界、清单托管、兼容窗口、归档格式、客户端更新执行方式… | **必须用户拍板**，写进 `release.config.json` |
| 第三轮 | 探测命中某框架才追问（Electron 的 asar、WPF 的单文件与自带运行时、Python 的 venv…） | 条件追问 |

提问要**一次问完**（用 ask-ui 或一次多选题），不要挤牙膏式来回。每个问题给出选项与推荐，让用户只需确认。

### 问不到答案时：挂欠账，不要猜

第二轮的项**问不到就停下来问**，不许填一个「合理默认值」继续跑。如果用户确实不回答（不在场、说「你看着办」），
那就把**每一个**猜的值写进 `release.config.json` 的 `release.pendingConfirmations`，一条一句、
写清「假定是什么、假定错了会怎样」。

这不是可选项，`release-scaffold.mjs` 会校验：配置里**要么**有 `release.confirmedBy`（用户在 CHECKPOINT 确认过），
**要么**有非空的 `release.pendingConfirmations`。两者都没有就直接拒绝生成。

为什么做成硬门禁：这个技能最危险的失败模式不是「不检查」，而是**生成出一个看起来很完整的技能** ——
参数靠猜，但产物和真就绪的技能长得一模一样，事后从生成物上完全看不出来。
实测中出现过：一个没问到任何参数的运行照常产出了 35 个文件、自检全绿，而清单托管地址是编的
（`https://update.example.internal/...`）却以既定事实的口吻写进了 SKILL.md 和脚本。

有 `pendingConfirmations` 时，生成物会自动挂一条「🔴 本技能尚未就绪」横幅 + 一份 `PENDING-CONFIRMATIONS.md`，
首次发版前必须逐条核对。

**没有例外**（这些都是实测里真的出现过的绕法）：

- 不许因为「这个会话没有提问渠道 / 用户不在」就自己填完事 —— 填可以，但**要登记成欠账**；
- 不许「先填个合理值，等用户看到再说」—— 生成物不会告诉你哪些是猜的，除非你登记了；
- 不许自己另写一份「待确认说明」代替 `pendingConfirmations` —— 横幅是生成器按配置挂的，
  手工写的说明文件没有入链，**没人会看到**（实测产物里那份 `PENDING-CONFIRMATIONS.md` 就是孤立的）；
- 不许把 `confirmedBy` 填成自己的名字或「AI」—— 它是「用户确认过」的记录，不是走过场的字段。

## 第三步：🔴 CHECKPOINT

把下面这张表摆给用户，等明确确认后才进入渲染：

| 要念的内容 | 为什么 |
|---|---|
| 生成到哪个目录、技能叫什么名 | 生成位置不可逆地影响后续所有路径 |
| 组件清单与构建矩阵（哪些组件参与发版） | 漏一个组件 = 那个组件永远不更新 |
| **业务文件 glob 与运行时文件 glob** | 划错就是「该更新的没更新」，且无人察觉 |
| 客户端版本号方案与最低支持版本 | 抬错最低支持版本是大面积事故 |
| 更新包 / 全量包的归档格式 | 定死客户端 updater 的实现 |
| 清单托管地址与 channel | 写错则客户端永远读不到更新 |
| 兼容窗口（后端要向后兼容几个客户端版本） | 决定数据库破坏性变更的节奏 |

**没念过就渲染 = 重来。**

## 第四步：渲染生成物

```bash
node <技能目录>/scripts/release-scaffold.mjs --config <release.config.json> --out <目标技能目录>
```

生成后**必须跑自检**（`release-scaffold.mjs` 会自动跑一遍）：

```bash
node <生成物>/scripts/engine/release-sync.mjs --repo <目标项目> --check   # 多 Agent 副本是否一致
node <技能目录>/scripts/self-test.mjs                                    # 引擎逻辑自测
```

生成物的完成判定：**目录里不存在 `{{` 占位符残留**，且 `release.config.json` 每个字段都非空。

## 更新已有的发版技能

这个技能不只在「从零建一个」时有用 —— 更常见的是**已有的那个要跟着改进**：
引擎落后了、模板里踩过的坑还没修、后来才加的能力（保留清理、待确认登记）它没有。

但已有的技能**不能重新生成一遍就完事**：项目在上面做过改动（自己加的脚本、手改过的文档），
硬覆盖会把这些一起冲掉，而且事后无从分辨。按四步走，每步都可逆：

### 1 先看清楚会改什么（不写盘）

```bash
node <技能目录>/scripts/release-scaffold.mjs --config <repo>/release/release.config.json --diff
```

渲染到临时目录，逐文件比出四类，**退出码 2 表示有差异**：

| 类别 | 含义 | 怎么办 |
|---|---|---|
| `新增` | 当前模板会补上的文件（新能力，如 `retention.md`） | 一般是好事，直接采纳 |
| `更新` | 内容会变：模板改过，**或项目在上面手改过** | 逐个人工过一遍，尤其手改过的那些 |
| `仅现有` | 重渲染不会再产出它 | **多半是项目自加的脚本，别删** |
| `一致` | 没变 | — |

外加 `scripts/engine/` 的一份整体指纹（它整块替换，不逐个列）。

### 2 先把配置补齐

老技能可能压根没有 `release.config.json`（手写的那些），或者它还是旧结构。
这一步会直接报「配置里缺少 xxx」—— 那正是要问用户的东西。

按第二步的规矩走：**问不到的写进 `release.pendingConfirmations`，不要猜**。
从手写技能里往回推参数时，**读得出出处的才填**；读不出的不许「按惯例」填一个能跑通的。

### 3 确认后写回

```bash
node <技能目录>/scripts/release-scaffold.mjs --config <repo>/release/release.config.json --adopt
```

`--adopt` 先整体备份现有目录到 `<repo>/release/.skill-backups/<时间戳>-adopt/`，再重渲染。
项目自己加的脚本不会被删（会删 `references/`、`assets/` 的只有 `--force`）。

只想把引擎换新、不动别的：

```bash
node <技能目录>/scripts/release-scaffold.mjs --config <repo>/release/release.config.json --update-engine
```

### 4 把实战问题带进来（这一步最值钱）

「优化」的真正输入往往不是模板更新，而是**这个技能在真实发版里踩过的坑**。
先问用户、或翻发版记录与 `release/history/`：上次发版哪一步出过问题？哪些地方靠人记着？
哪些是当场手工补的？这些是模板覆盖不到的东西。

> **改生成物 = 下次 `--adopt` 就没了；改模板或引擎 = 所有项目都受益。**
> 能固化的要落到 `assets/templates/` 或 `scripts/engine/`，别只修手上这一个。

### 5 收尾

- 备份由 `release-prune.mjs` 按 `release.retention.skillBackups`（默认 2）清理；
- `--adopt` 会自动重跑自检，再照「生成后必须自检」补一次可执行性冒烟；
- 改了真源记得 `release-sync.mjs --check` 同步多 Agent 副本。

## 更新清单契约

清单是**客户端与安装包读同一份**的东西，格式由 Inno 的 Pascal 侧倒逼而来。完整规则见 `references/manifest-contract.md`，五条硬约束先记住：

1. **一行一键、无嵌套数组**；
2. **嵌套块（`full`）必须排在最后一行**；
3. **值里不能有引号**（Pascal 无转义处理）；
4. **所有值都是带引号的字符串**，数字也不能裸写（裸数字会让 Pascal 读到隔壁字段）；
5. **纯 ASCII**，中文一律 `\uXXXX`；安装包直接读的字段（version/type/file/sha256）必须是真 ASCII。

这些不是风格建议，是**实测踩出来的**：`"schema": 1` 会让安装包把 schema 读成 `"channel"`。`scripts/engine/lib/flat-json.mjs` 里有一个用 JS 复刻 Pascal 读法的断言，生成物的清单生成器必须调用它，**通不过就不许发布**。

## 客户端更新协议

完整状态机见 `references/client-update-protocol.md`。三条不可动摇的：

- **先全量、后更新包**：全量完成后重启再从头走一遍状态机（不是同进程续走），任何中断下次启动都能重新推导出下一步；
- **版本只进不退**：比较按段比整数（`26.10.1.1 > 26.9.1.1`）；相等或更低一律跳过，否则就是降级；
- **失败一律回滚**：updater 强制「下载校验 → 备份 → 替换 → 失败还原」，主程序连续三次崩溃也触发还原。

独立 updater 必须放在**被替换目录之外**（`%LOCALAPPDATA%\<App>\updater\`）——Windows 下运行中的 exe/dll 无法就地覆盖。

## 更新包 / 全量包的边界

- **更新包 = 业务文件全集**（不是差分包），任意不低于最低支持版本的客户端一步到位；
- **全量包 = 自包含归档**（含运行时本体，解压即用），给已装客户端自动更新；
- **Inno 安装包 = 只给新用户**（混合形态：内置基线 + 安装时读清单覆盖业务文件）。与全量包角色分开，别混用。

文件分类**不用白名单，用 fail-closed 分类**：构建期列出全量文件、逐文件分类为 business / runtime，**出现未分类文件就让发版失败**。白名单漏一项的症状是客户端长期停在旧业务代码上，没人会发现。

全量触发方向**不能反**：读不到基线时按全量处理 —— 多发一次全量的代价是一次下载，猜成只发更新包可能让客户端启动即崩。

## 多 Agent 落盘

生成物要同时供 Claude Code / Codex / Qoder / pi 使用，各家目录不同。路径表与证据强度见 `assets/multi-agent-paths.md`，同步用：

```bash
node <生成物>/scripts/engine/release-sync.mjs --repo <目标项目>          # 写项目内副本
node <生成物>/scripts/engine/release-sync.mjs --repo <目标项目> --check  # 提交前查漏
node <生成物>/scripts/engine/release-sync.mjs --repo <目标项目> --user   # Codex CLI 与 pi 需要
```

**Codex CLI 与 pi 只在用户级目录发现技能**，要让它们用上必须加 `--user`。默认只写项目内（随 git 走）。别给未经确认的路径写数据。

## 与 inno-setup-installer 的接口契约

生成物的 `build-installer.ps1` 必须这样喂它：

```bash
pwsh -NoProfile -File "<inno技能目录>/scripts/build-installer.ps1" -Script "<项目>/installer/setup.iss"
```

三条不可违反：

- `VersionInfoVersion` 只接受**纯数字四段**，版本号带后缀要先剥离；
- `AppId` 一旦发布过就不能再改（Windows 靠它认「同一个程序」）；
- **安装目录必须可写** —— 用 `PrivilegesRequired=lowest` + `{autopf}`（解析到 `%LOCALAPPDATA%\Programs`）。装到 `Program Files` 会让覆盖式自动更新在写入阶段失败。

## 生成后必须自检

1. 无 `{{` 占位符残留；
2. `release.config.json` 每个必填字段非空；
3. `node <技能目录>/scripts/self-test.mjs` 全绿；
4. **可执行性冒烟**（最容易被跳过、也最有用的一项）：`cd` 进生成物目录，
   照 `SKILL.md` 里**原文照抄**一条命令跑一遍。路径层级必须真的解析得开、脚本必须真的启动。
   > 实测踩过：生成物里所有 `release/` 路径都写成 `../release/`，而正确层级是 `../../../release/`
   > （技能在 `.claude/skills/<slug>-release/` 下，不在仓库根）。自检全绿 —— 因为它们只查字符串，
   > 不查这条命令跑不跑得起来。凡是手抄模板而来的生成物，这一项必挂。
5. 用生成物在假产物上跑一遍 `release-manifest.mjs`（客户端项目），确认清单能过 Pascal 可解析性校验；
6. **对着本机伪源跑一遍 `release-verify.mjs`**（客户端项目）：

   ```bash
   node scripts/engine/mock-update-source.mjs --dir <伪源目录> --port 8099 &
   node scripts/engine/release-verify.mjs --config <repo>/release/release.config.json
   ```

   别跳过这条：它是**纯读远端**的脚本，不像打包那样会被日常构建顺手覆盖，
   最容易带着「从没跑通过」的状态发布出去 —— 实测就抓到过它调用了一个不存在的函数，
   第一行就崩，而所有离线自检全绿。
7. `release-sync.mjs --check` 退出码为 0。

生成物**必须由 `release-scaffold.mjs` 产出**，不要手工替换占位符。手抄出来的东西
会在下一次重渲染（`--adopt` / `--force`）时全部丢失，而且手抄过程本身就会引入上面那类层级错误。

## 引擎脚本一览

`scripts/engine/` 下的东西会被**原样拷进生成物**，所以它们必须技术栈无关、零依赖、可独立运行。
改任一脚本后**必须跑 `node scripts/self-test.mjs`**（里面有反向用例：写错的清单必须被拦住）。

| 脚本 | 干什么 | 关键门禁 |
|---|---|---|
| `lib/flat-json.mjs` | 清单序列化 + **Pascal 可解析性断言** | 唯一允许写清单的地方，别绕过 |
| `lib/version.mjs` | 四段版本号、三源取大、按段比整数 | 比较必须走 `compareVersions` |
| `lib/tree-hash.mjs` | 目录/子集指纹、glob 匹配 | 指纹口径与用户既有的 `Sync-Skills.ps1` 一致 |
| `lib/config.mjs` | 读写 `release.config.json`，字段缺失即报错 | fail-closed，不猜默认值 |
| `lib/cli.mjs` | 参数解析与输出（失败一律走 stderr + 非 0） | 门禁靠退出码，不要打印错误后继续 |
| `release-probe.mjs` | 只读探测项目（只用于**生成**阶段） | 每条结论带证据文件路径 |
| `release-changes.mjs` | 变更检测 → 发版计划 | **代码同步硬门禁**、全量判定 fail-closed |
| `release-version.mjs` | 算版本号 | 严格大于线上，否则报错 |
| `release-package.mjs` | 分类 + 打包 + 删除清单 + 归档对账 | **分类完备**（fail-closed）、归档内容对账 |
| `release-manifest.mjs` | 生成清单 + **发布计划** + 归档 + 更新状态 | 版本单调、同版本禁重发、Pascal 校验 |
| `release-verify.mjs` | 发版后线上体检 | 可达、体积、sha256、缓存头、版本不倒退 |
| `release-sync.mjs` | 多 Agent 落盘同步 | `--check` 漂移检测（退出码 1） |
| `release-prune.mjs` | 清理本地发版残留 | **默认只演算**（要 `--apply`）、业务文件清单至少留 2 份 |
| `mock-update-source.mjs` | 本机伪更新源（验证安装包/客户端用） | 清单 `no-store`、防路径穿越 |

`scripts/release-scaffold.mjs` **不**进生成物（它只在生成时跑一次）。
渲染用的模板在 `assets/templates/`。

## 常见陷阱

- **清单值裸写数字**：Pascal 的 `JsonStr` 取引号对，裸数字会让它读到隔壁字段。所有值一律字符串。
- **嵌套块没排在最后**：`JsonStr` 取第一个匹配键，顺序错了会静默读到 `full` 里的版本号。
- **安装包放 `Program Files`**：覆盖式自动更新写不进去，症状是「点确认更新没反应」。
- **单文件只读挂载换 inode**：nginx.conf 这类单文件挂载改动后必须 `docker compose up -d --force-recreate <svc>`，`up -d` 不会替你检查。
- **包名固定**：CDN 按 URL 缓存，固定名会让新包永远命中旧缓存。文件名必须带每次发布新生成的随机 hash。
- **改了技能忘了同步**：多 Agent 副本会漂移。提交前跑 `release-sync.mjs --check`。
- **每轮漏打 tag**：下一轮的变更检测基准就失效，会退化成"全部重建"甚至漏发。

## 合理化对照表

| 借口 | 现实 |
|---|---|
| 「目录结构很明显，不用探测了」 | 路径猜错的代价是生成出一个全错的技能，而用户要到最后才发现。探测一条命令、几秒钟。 |
| 「业务文件边界我按惯例定就行」 | 边界划错 = 该更新的文件没进包，客户端停在旧代码上，**没有任何报错**。这是最贵的一类错误，必须用户拍板。 |
| 「CHECKPOINT 太啰嗦，直接生成吧」 | 没念过就渲染 = 返工，而且返工的是已经写进目标项目仓库的一堆文件。 |
| 「更新说明先空着，之后再补」 | 空着会被流程拿 git 提交标题兜底（「文档:…」），而那几行字是**用户唯一会看到的**。 |
| 「readme/注释里写了规则，AI 会遵守」 | 规则要写成**机器断言**（`assertPascalParsable`），不是散文。散文拦不住任何东西。 |
| 「全量包和安装包差不多，合并成一个吧」 | 角色不同：全量包给已装客户端自动更新，安装包给新用户。合并后要么新用户装不了，要么老客户端跨基线更新断链。 |
| 「用户没给这些参数，我按惯例填一套能跑通的」 | 填可以，但要**登记成欠账**（`release.pendingConfirmations`）。不登记的假定会被当成事实读，而它多半是错的 —— 最贵的一类失败是「生成物看起来很完整」。 |
| 「模板里那处层级/路径有问题，我在生成物里改一下就行」 | 生成物是模板渲染出来的：改生成物 = 下次重渲染全部丢失。**改模板**（`assets/templates/`），再重跑 `release-scaffold.mjs`。 |
| 「手抄模板填空比跑脚手架快」 | 手抄必然引入层级错误（技能不在仓库根，路径要比直觉多一层），而且不在自检覆盖范围内。`release-scaffold.mjs` 一个命令的事。 |
| 「已有的技能直接 `--force` 重生成一遍最快」 | 那把项目在上面做的改动一起冲掉了，而且事后分不出丢了什么 —— `--diff` 先看一眼是最便宜的保险。 |
| 「这个坑我在生成物里直接改掉就行了」 | 生成物是渲染产物，下次 `--adopt` 就没了。改 `assets/templates/` 或 `scripts/engine/`，所有项目都受益。 |
| 「老技能没有 release.config.json，我照着现在的字段编一套」 | 编出来的值会被当成既定事实读。**读得出出处的才填**，读不出的进 `pendingConfirmations`。 |

## 红旗——停下,重来

- 没有跑 `release-probe.mjs` 就开始写生成物
- 业务文件 glob 是我自己定的，没跟用户确认过
- 没有经过 CHECKPOINT 就渲染了
- 清单里出现了裸数字、嵌套数组，或 `full` 块不在最后
- 更新说明是空的，或直接抄了 git 提交标题
- 生成物里有 `{{` 残留
- 生成物是手抄/手工替换占位符来的，没跑 `release-scaffold.mjs`
- 参数没问到答案，却既没拿到 `confirmedBy` 也没写 `pendingConfirmations`
- `installer.payloadVersionCommand` 里是说明文字而不是能取到版本号的表达式
- 生成物里所有 `release/` 路径都是 `../release/`（少了一层，跑起来必然找不到配置）
- 已有的技能被覆盖了，但没先跑 `--diff`、也没留备份（分不出丢了什么）
- `--adopt` 之后，`仅现有` 那一类里项目自加的脚本被当成垃圾清掉了
- 「优化」只改了生成物，没动模板或引擎（下次 `--adopt` 就没了）
- 给未经确认的 Agent 路径写了数据

**出现任何一条都意味着:停,回到对应阶段重来。**

## 相关 skills

- depends-on: `inno-setup-installer`（Windows 客户端安装包与安装时读清单覆盖）
- contrasts-with: 项目专属的发版技能本身（本技能生成它，不执行它）
- composes-with: `ask-ui`（第二步一次问完）、`grilling`（拿不准的取舍先拷问清楚）

## 参考

- `references/interview-checklist.md` —— 生成前必问清单（三轮制）。**每次生成都要读**，别凭记忆提问。
- `references/manifest-contract.md` —— 清单契约、静态布局、缓存、防回滚。
- `references/versioning.md` —— 版本号规则与三源取大。
- `references/client-update-protocol.md` —— 客户端状态机、独立 updater、失败回滚、兼容窗口。
- `references/payload-rules.md` —— 业务/运行时分类、全量触发、三重断言。
- `references/server-release.md` —— 数据库迁移、docker compose 部署与回滚、前端缓存。
- `references/release-runbook.md` —— 九阶段流程、状态文件、自动判定、回滚剧本。
- `references/multi-agent-layout.md` —— 各 Agent 落盘路径与同步纪律。
- `references/retention.md` —— 保留份数与清理（本地能删什么、服务端什么永远不能删）。
- `references/generator-templates.md` —— 占位符全表与必须逐字保留的段落。
- `assets/inno/pascal-fragment.iss` —— 实测的 Pascal 读清单函数集，生成物的 `.iss` 直接抄。
- `assets/multi-agent-paths.md` —— 路径证据表。
- `assets/templates/` —— 生成物的骨架（`SKILL.md`、`references/*.md`、项目脚本），由 `release-scaffold.mjs` 渲染。
- `assets/manifest.schema.json` —— 清单的字段 schema（描述生成前的逻辑对象，**不是**落盘后的扁平文本）。
- `scripts/self-test.mjs` —— 引擎自测（含反向用例）。改引擎后必跑。