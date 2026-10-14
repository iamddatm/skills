# 更新包 / 全量包的边界与文件分类

## 两种包的分工

| | 更新包（payload） | 全量包（full） |
|---|---|---|
| 内容 | **业务文件全集** | 整个程序目录（运行时本体 + 业务文件） |
| 形态 | 归档（zip / tar.gz，按栈定） | 自包含绿色包，解压即用 |
| 给谁 | 已装客户端自动更新 | 已装客户端跨基线更新 + 首次安装的兜底 |
| 何时发 | 几乎每次（有业务变更时） | 运行时/依赖变更、目录结构变更、人工强制 |

**「全集」不是「差分」**：任何 ≥ `minVersion` 的客户端都能一步升到最新，不依赖中间版本。
代价是包略大，换来的是升级路径永远不会断。

## 分类：不用白名单，用 fail-closed

**白名单是错的解法**：漏一项的症状是——某个文件该更新却没进包，客户端长期停在旧业务代码上，
**没有任何报错**，直到某个功能行为不一致才被用户发现。这类错误极贵。

正确做法：

1. 构建期列出**全量包的全部文件**（不是"挑出来的"）；
2. 逐文件分类为 `business` 或 `runtime`；
3. **出现未分类的文件 → 发版失败**（fail-closed）；
4. 更新包 = 全集去掉 `runtime` 之后的集合。

配置里必须显式声明两侧的 glob（`components.client.businessGlobs` / `runtimeGlobs`）。
`runtimeGlobs` 为空时，`release-changes.mjs` 会警告：换运行时将无法自动识别为全量，只能靠 `--force-full`。

## 典型分类

| 类别 | 归到 | 例 |
|---|---|---|
| 页面、脚本、样式、模板、业务数据文件 | business | `resources/**`、`*.xaml`、`*.js` |
| 运行时本体 | runtime | `*.dll`、`*.node`、`jre/**`、`runtime/**`、`python/**` |
| 依赖清单 | runtime | `package-lock.json`、`pnpm-lock.yaml`、`go.sum`、`Directory.Packages.props` |
| 项目文件的依赖声明 | runtime | `*.csproj`、`requirements.txt`、`pyproject.toml` |
| 大体积资源（字体、图标、语言包） | 按项目定，通常 runtime | `fonts/**`、`locales/**`、`*.ico` |

> 资源类归属要**逐项与用户确认**：有些资源被程序集内嵌引用，替换不生效；有些需要整体替换才安全。

## 全量触发条件

| 触发 | 判据 | `reason` |
|---|---|---|
| 运行时/第三方依赖变更 | 改动命中 `runtimeGlobs` | `runtime-deps` |
| 目录结构变更 | `businessGlobs` 覆盖范围内**新增了目录** | `structure` |
| 资源变更 | 命中 `structureGlobs` | `assets` |
| **基线不可知** | 状态里没有 `clientFullBaseline` | `unknown-baseline` |
| 人工强制 | `--force-full` | `manual` |
| 跨 `minVersion` | 客户端低于最低支持版本 | （客户端侧判定，不是发布侧触发） |

### 方向不能反

读不到线上基线、状态文件缺失、解析失败时，**一律按全量处理**：

> 全量对客户端永远安全（代价是一次性下载），猜成只发更新包可能让客户端启动即崩。

## 更新包必须带删除清单

「全集覆盖式」解决不了**被删文件**：新版删掉了某个业务文件，旧客户端上它还在，
可能被加载执行。所以更新包必须携带 `delete` 清单（相对路径列表），客户端解包后按清单删除。

Inno 安装包侧同理：在线覆盖解出来的文件**不在 Inno 的安装清单里**，卸载不会自动清，
必须用 `[UninstallDelete]` 显式删除（见 `assets/inno/pascal-fragment.iss` 的说明）。

## 三重完整性断言（发版阶段 6 的门禁）

1. **分类完备**：全量包文件清单 ⊆ business ∪ runtime，**无第三类**；
2. **内容等价**：把更新包解到一个全量包副本上，断言其 business 子树逐文件哈希
   == 全新构建的 business 子树；
3. **差异可见**：与上一版更新包对比，打印新增/修改/删除文件数；
   **文件数为 0 但计划说「客户端有变更」时失败** —— 这说明探测与打包对不上，
   两者之一错了，必须先查清再发。

## 归档格式

| 格式 | 优点 | 注意 |
|---|---|---|
| `zip` | .NET 客户端 `System.IO.Compression` 原生解压；Inno 的 `extractarchive` 原生支持 | 非 Windows 客户端会丢 unix 权限位 |
| `tar.gz` | 跨平台语义好、保留权限（可禁用符号链接） | Inno 侧要走系统 `{win}\System32\tar.exe`（`extractarchive` 不认 tar.gz） |

选哪种由用户在生成时拍板，写进 `release.config.json` 的 `client.archive`。

## 包名与完整性

- 包名带**每次发布新生成的随机 hash**：`<slug>-<kind>-<rand12><ext>`，躲开 CDN 旧缓存；
- 随机 hash **与内容无关**，完整性一律靠清单里的 `sha256`；
- 安装包把清单里的 `sha256` 交给 `DownloadTemporaryFile` 的第 3 个参数自动校验，
  内容对不上会抛异常，由外层 `try..except` 兜住并降级。