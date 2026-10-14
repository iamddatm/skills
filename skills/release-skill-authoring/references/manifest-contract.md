# 更新清单契约

清单是**客户端主程序与 Inno 安装包读同一份**的东西。它的格式不是自由选择 —— 是被 Inno 的
Pascal 侧倒逼出来的（那边没有 JSON 解析器，只能做子串匹配）。

## 五条硬约束

| # | 约束 | 违反后的症状 |
|---|---|---|
| 1 | 一行一个键，无嵌套数组 | 解析不了 |
| 2 | 嵌套块（`full`）必须排在**最后一行** | 静默读到 `full` 里的同名值，版本号判断全错 |
| 3 | 值里不能出现引号 | 值被截断，读到半截字符串 |
| 4 | **所有值都是带引号的字符串**，数字也不能裸写 | 读到**隔壁字段**的值（实测：`"schema": 1` 读成 `"channel"`） |
| 5 | 整个文件纯 ASCII，中文一律 `\uXXXX` | 换台按 GBK 读的机器上乱码 |

再加一条推论：**安装包直接读的字段必须是真 ASCII**（不是转义来的）。
Pascal 拿到的是转义后的原文，它**不会**把 `修` 解码回「修」。所以 `version` / `type` /
`file` / `sha256` / `fullFile` / `fullSha256` 里放中文，症状是「明明有新版却永远判断成不更新」。

这六条全部由 `scripts/engine/lib/flat-json.mjs` 的 `assertPascalParsable` 强制，
**通不过就不许发布**。那边还有一个用 JS 复刻的 Pascal `JsonStr` 实现，两边必须同时改。

## 样例

```json
{ "schema": "1" }
{ "channel": "stable" }
{ "releaseId": "2026-10-14.1" }
{ "generatedAt": "2026-10-14T03:38:51Z" }
{ "version": "26.11.10.14" }
{ "type": "payload" }
{ "file": "p/app-payload-a1b2c3d4e5f6.tar.gz" }
{ "sha256": "9d32...a5a1" }
{ "size": "52428800" }
{ "notes": "修复登录后偶发白屏；新增导出 Excel 按钮。" }
{ "seq": "42" }
{ "minVersion": "26.7.0.0" }
{ "fullFile": "f/app-full-b2c3d4e5f6a1.tar.gz" }
{ "fullSha256": "9b71...04" }
{ "fullSize": "524288000" }
{ "reason": "runtime-deps" }
{ "full": { "version": "26.11.10.14" } }
```

> 样例里的 `.tar.gz` 只是示例：扩展名跟随项目定的 `client.archive`（`.zip` / `.tar.gz`）。
> 关键是**两种包用同一种归档格式** —— 客户端解包只实现一套（Windows 上统一走
> `{win}\System32\tar.exe`，它能按扩展名自动选格式），混用等于多维护一条解包路径。

## 字段

| 字段 | 说明 |
|---|---|
| `schema` | 清单结构版本。**只增字段，永不删改** —— 老客户端必须能容忍未知键 |
| `version` | 最新更新包版本 = **客户端对外版本号** |
| `type` | 恒为 `payload`（顶层形态始终是更新包；全量信息放在 `full*` 与 `full` 块里） |
| `file` | 更新包**相对清单所在目录**的路径，如 `p/xxx.tar.gz`。不放绝对 URL —— 换 CDN 域名时清单不用改 |
| `sha256` / `size` | 完整性靠它，**文件名里的 hash 不算数**（那是随机 hash，见下） |
| `notes` | 面客更新说明，用户唯一会看到的那几行字 |
| `seq` | 单调递增的发布序号。客户端拒绝 `<= 本地` 的清单 —— 防静态站被回滚后把客户端「更新」回旧版 |
| `minVersion` | 低于此版本的客户端不得应用更新包，只能走全量/重装 |
| `fullFile` / `fullSha256` / `fullSize` | 全量包（绿色包）信息 |
| `reason` | 为什么必须全量：`runtime-deps` / `structure` / `assets` / `manual` / `unknown-baseline` |
| `full.version` | 当前运行时的基线版本。客户端拿本地 `fullBaseline` 与它比 |
| `databaseVersion` / `databaseIrreversible` | 数据库侧，供运维与审计 |
| `backendVersion` / `backendApiMinClient` / `backendEndpointsRemoved` | 后端能接受的最老客户端版本 —— 兼容窗口的下沿 |
| `generatedAt` | **仅供展示，不参与任何判断**（客户端时钟不可信） |

## 静态托管布局与缓存

```
<base>/<channel>/manifest.json               # Cache-Control: no-store, must-revalidate
<base>/<channel>/p/<slug>-payload-<rand12>.<ext>   # 更新包  immutable
<base>/<channel>/f/<slug>-full-<rand12>.<ext>      # 全量包  immutable
<base>/<channel>/i/<slug>-<rand12>-setup.exe       # 安装包  immutable
<base>/history/<releaseId>.manifest.json     # 归档，永不覆盖
<base>/notes/<version>.md                    # 面客更新说明归档
```

- 清单**必须** `no-store`，客户端再叠 `?t=<unix>` 破除 CDN；
- 包按版本目录/随机文件名长缓存 `immutable`；
- **版本目录一旦发布不得复用内容**，否则 `immutable` 会骗客户端。

### 缓存策略只有两条，按「URL 会不会变」二选一

判据不是文件大不大、也不在哪台服务器，而是**这个 URL 在内容变了之后还会不会是同一个**：

| URL 会随内容变 | 该给的头 | 为什么 |
|---|---|---|
| 会（文件名带随机 hash / 版本号） | `Cache-Control: public, max-age=31536000, immutable` | CDN 只在每个新 URL 上回源一次，之后全走边缘节点。百兆包全靠这条才不发疯 |
| **不会（固定文件名）** | **`Cache-Control: no-store`**（或 `no-cache, must-revalidate`） | 反向的灾难：CDN 认为这个 URL 的内容是永久的，**新包永远命中旧缓存**，而且清都清不干净 —— CDN 上的旧副本不会因为你重传就消失 |

**「固定文件名的包」这一条最容易漏**，因为它在开发时看不出问题（本机没有 CDN 缓存）：

- 给人点的「下载最新版」入口（`/stable/i/latest-setup.exe` 之类）；
- 项目坚持不改名的安装包（构建产物就叫 `setup.exe`，上传时没改名）；
- 反代 / 对象存储上配了「固定路径指向最新」的规则。

这些**必须显式 `no-store`** —— 光靠「上传时覆盖同名文件」是不够的，CDN 边缘的旧副本不会跟着变。

代价要清楚再选：`no-store` 意味着**每次下载都回源**。所以固定名只该用在**小文件**、或**低频的人工入口**上；
真正的载荷包一律走随机 hash + `immutable`。

> 生成物里 `release.config.json` 的 `manifest.fixedNamePaths` 用来登记这类固定名产物，
> `release-verify.mjs` 会挨个验它们的缓存头 —— 声明了就是硬门禁，没声明就没法验。
> 用 CDN 时，这几个路径的缓存策略要在 CDN 侧单独配（源站的头有时会被 CDN 覆盖掉）。

## 包名带随机 hash（不是内容哈希）

CDN 按 URL 缓存，**包名固定会让新包永远命中旧缓存**。所以文件名里带一段**每次发布新生成的随机
hash**（`<slug>-<kind>-<rand12><ext>`）。

⚠️ 它与包内容无关：**不能**用来对账完整性，也**不要**让任何一方按文件名推断哈希。
下载后一律用清单里的 `sha256` 比对。清单生成器（`release-manifest.mjs`）也不对文件名做哈希推断。

> 内容哈希（sha256 前 12 位）也能绕开缓存，但同样的内容重发时 URL 不变、仍会命中旧缓存；
> 随机 hash 保证每次发布都是全新 URL。两者可叠加，本项目采随机 hash。

## 发布计划（`publish-plan.json`）

发布文件名带随机 hash，**只有生成清单那一刻才知道**，上传方不可能自己推出来。所以
`release-manifest.mjs` 会同时产出一份 `publish-plan.json`：

```json
{ "schema": 1, "manifest": "<清单路径>",
  "files": [ { "kind": "payload", "source": "<本地路径>", "published": "p/xxx-<rand>.tar.gz", "sha256": "…", "size": 0 } ] }
```

上传方（或本机伪源）照着 `source → published` 把文件放到清单里写的相对路径上。

**为什么不能各写一份命名规则**：两份实现一旦漂移，就会出现「清单指向 A、服务器上是 B」——
客户端永远更新不了，而且没有任何一边会报错。

## 发布顺序：先包、后清单

**清单是「最新是谁」的唯一指针。** 任何中间态都不该被客户端看到：

1. 上传所有包（更新包 → 全量包 → 安装包）；
2. **最后**上传清单（先用临时名上传，再原子改名）。

反过来做的后果：客户端拉到新清单，但包还没上去 —— 更新失败，而且它会重试、反复失败。

## 防回滚

- `seq` 单调递增，客户端拒绝 `<= 本地`；
- 清单生成器拒绝写出 `version <= 上一版` 的清单（`--allow-rewrite` 只留给调试通道）；
- 同一 `releaseId` 已存在于 `history/` 时拒绝覆盖；
- 全量包**常驻不可删** —— 它是停在旧基线的客户端唯一的升级路径。

## 全量包与安装包的关系

| | 全量包（绿色包） | Inno 安装包 |
|---|---|---|
| 给谁 | 已装客户端自动更新 | 新用户首次安装 |
| 形态 | 自包含归档，解压即用 | `setup.exe`（混合形态：内置基线 + 安装时读清单覆盖业务文件） |
| 何时产出 | `reason` 命中时（与安装包同源） | 同全量包 |

两者版本一致、来源一致，但**角色不能合并**。