# 依赖安装（InnoDependencyInstaller）

用 [DomGries/InnoDependencyInstaller](https://github.com/DomGries/InnoDependencyInstaller) 的 `CodeDependencies.iss` 让安装程序在装主程序之前，自动补齐目标机缺失的运行库。它的设计是"一行一个依赖"：每个函数先检测，已装就跳过，缺失才从厂商官方地址下载安装。

技能自带的副本在 `assets/CodeDependencies.iss`（MIT，构建脚本会自动拷到 `.iss` 同级目录，`.iss` 里用 `#include "CodeDependencies.iss"` 引入）。

## 前提条件

| 条件 | 原因 |
| --- | --- |
| Inno Setup ≥ 6.7 | 库使用了 6.7 才有的脚本能力；构建脚本会拦截过旧版本。 |
| `PrivilegesRequired=admin` | 依赖是给全机安装的，需要管理员权限。 |
| `ArchitecturesInstallIn64BitMode=x64compatible or arm64` | 在 x64 / ARM64 Windows 上装 64 位依赖。（程序与依赖都是纯 32 位时删掉这行。） |
| 目标机可联网 | 默认从厂商官方地址在线下载依赖。离线场景见下文"离线捆绑"。 |

## 基本用法

```iss
[Code]
#include "CodeDependencies.iss"

function InitializeSetup: Boolean;
begin
  Dependency_AddDotNet100Desktop; // 只保留真正需要的那几行
  Dependency_AddVC14;
  Result := True;
end;
```

脚本里已经有 `InitializeSetup` 时，把这些调用并进现有函数即可，不要重复定义。

## 常用依赖函数

完整清单 60+ 项，见上游 README 的 Supported dependencies 表。这里列常见选型：

### .NET

| 依赖 | 函数 |
| --- | --- |
| .NET Framework 3.5 SP1 | `Dependency_AddDotNet35` |
| .NET Framework 4.6.2 / 4.7.2 / 4.8 / 4.8.1 | `Dependency_AddDotNet46` / `AddDotNet47` / `AddDotNet48` / `AddDotNet481` |
| .NET Runtime 8 / 9 / 10 | `Dependency_AddDotNet80` / `DotNet90` / `DotNet100` |
| ASP.NET Core Runtime 8 / 9 / 10 | `Dependency_AddDotNet80Asp` / `DotNet90Asp` / `DotNet100Asp` |
| **.NET Desktop Runtime 8 / 9 / 10** | `Dependency_AddDotNet80Desktop` / `DotNet90Desktop` / `DotNet100Desktop` |
| ASP.NET Core Hosting Bundle（给 IIS 部署用） | `Dependency_AddDotNet80Hosting` / `DotNet90Hosting` / `DotNet100Hosting` |

**选型规则：跟着应用的 `TargetFramework` 走。**

- WPF / WinForms → 用 `*Desktop` 那个（桌面运行时包含自包含的 WindowsDesktop 组件；只装 `DotNetXX` 会启动失败）。
- 控制台 / 类库宿主 / 服务 → `DotNetXX`。
- Web 应用部署到 IIS → `DotNetXXHosting`。
- 如果项目是**自包含发布**（self-contained），压根不需要装运行时，别加。

版本号要对齐：应用面向 `net10.0-windows` 就必须装 .NET 10 Desktop Runtime，装 8.0 不解决问题。

### Visual C++

| 依赖 | 函数 |
| --- | --- |
| VC++ 2015–2026（即 v14 系列） | `Dependency_AddVC14` |
| VC++ 2013 / 2012 / 2010 / 2008 / 2005 | `Dependency_AddVC2013` / `VC2012` / `VC2010` / `VC2008` / `VC2005` |

C++ 程序按使用的工具集选；带原生依赖（如某些 SQLite / OpenCV / Qt 封装）时 `Dependency_AddVC14` 覆盖绝大多数现代场景。

### 其它常见

| 依赖 | 函数 |
| --- | --- |
| WebView2 Runtime | `Dependency_AddWebView2` |
| Windows App SDK Runtime 1.6–2（WinUI 3） | `Dependency_AddWinAppRuntime16` / `17` / `18` / `2` |
| SQL Server Express 2019 / 2022 / 2025 | `Dependency_AddSql2019Express` / `Sql2022Express` / `Sql2025Express` |
| OLE DB Driver 19 / ODBC Driver 18 | `Dependency_AddSqlOleDb19` / `AddSqlOdbc18` |
| Access Database Engine 2016 | `Dependency_AddAccessDatabaseEngine2016` |
| DirectX End-User Runtime | `Dependency_AddDirectX` |
| OpenJDK 8 / 11 / 17 / 21 / 25 | `Dependency_AddJava8` / `Java11` / `Java17` / `Java21` / `Java25` |
| Python 3.13 / 3.14 | `Dependency_AddPython313` / `Python314` |
| PowerShell 7 | `Dependency_AddPowerShell7` |

WPF 程序**不要**加 `Dependency_AddWebView2`——WebView2 只在用了 `WebView2` 控件（如 WebView2、某些 HTML 渲染的 UI 框架）时才需要。

## 进阶用法

### 自定义依赖

任何能静默运行的安装程序都能接进来：

```iss
Dependency_AddIfMissing(not RegKeyExists(HKLM, 'SOFTWARE\MyRuntime'),
  'myruntime.exe',                     // 文件名（会下载到 {tmp}）或本机已有程序的完整路径
  '/quiet /norestart',                 // 静默安装参数
  'My Runtime 1.0',                    // 展示给用户的名字
  'https://example.com/myruntime.exe', // 下载地址
  '',                                  // SHA-256 校验值，留空则不校验
  False,                               // ForceSuccess：把所有退出码都当成功
  False);                              // RestartAfter：装完重启 Windows
```

第一个参数是"是否缺失"的判断。`Dependency_Add` 是同名函数的简化版，省掉第一个参数、无条件加入。传本机已有程序的完整路径时不下载，直接执行——内置的 .NET Framework 3.5 就是这么用 `dism.exe` 启用系统功能的。

### 按架构取不同地址

```iss
const
  UrlX86   = 'https://example.com/app-x86.exe';
  UrlX64   = 'https://example.com/app-x64.exe';
  UrlArm64 = '';
begin
  Dependency_AddIfMissing(..., Dependency_String(UrlX86, UrlX64, UrlArm64), ...);
```

`Dependency_String` 按 Setup 自身的架构取值，`Dependency_StringWin` 按 Windows 的架构取值；传空串表示该架构不提供，库会跳过并记录日志。

### 强制 32 / 64 位

```iss
Dependency_ForceX86 := True;   // 接下来加入的依赖按 32 位装
Dependency_AddVC2013;
Dependency_ForceX86 := False;

Dependency_ForceX64 := True;   // 反向同理
```

对 SQL Server、OLE DB、ODBC、WebView2、OpenJDK、PowerShell 无效——它们跟随 Windows 的架构。

### 让依赖只在用户勾选某组件时才装

```iss
Dependency_Components := 'advanced';  // 接下来加入的依赖挂在 advanced 组件下
Dependency_AddDotNet100;
Dependency_Components := '';         // 恢复
```

`[Components]` 段里定义 `advanced`，用户没勾就整体跳过下载。

### 离线捆绑

目标机不能上网时，把安装程序塞进安装包，库发现 `{tmp}` 里已经有同名文件就不再下载：

```iss
[Files]
Source: "dependencies\dxwebsetup.exe"; Flags: dontcopy noencryption

[Code]
function InitializeSetup: Boolean;
begin
  ExtractTemporaryFile('dxwebsetup.exe');  // 必须写在 Dependency_AddDirectX 之前
  Dependency_AddDirectX;
  Result := True;
end;
```

注意：捆绑的文件**不做校验和检查**；且有些安装程序（如 DirectX 网络安装器）自己还会联网下载，捆绑不等于完全离线。

### 调优 define

所有 define 必须写在 `#include` 之前：

```iss
[Code]
#define Dependency_DownloadRetryCount 5
#include "CodeDependencies.iss"
```

| Define | 作用 |
| --- | --- |
| `Dependency_DownloadRetryCount` | 下载失败的重试次数，默认 `3`。 |
| `Dependency_DownloadRetryBackoffMs` | 首次重试前的等待毫秒数，默认 `2000`（第 n 次等待 n 倍）。 |
| `Dependency_InstallBusyRetryCount` / `...DelayMs` | 遇到"另一个安装正在进行"时的重试次数与间隔，默认 30 次 × 10000ms。 |
| `Dependency_NoUpdateReadyMemo` | 脚本自己有 `UpdateReadyMemo` 时用，避免冲突。 |
| `Dependency_CustomExecute` | 用自定义函数代替 `ShellExec` 运行安装程序。 |

## 排错

### 日志

安装程序加 `/LOG="D:\tmp\install.log"`，库会把每个判断写进日志：

| 日志条目 | 含义 |
| --- | --- |
| `Dependency already installed: X` | 已安装，跳过。 |
| `Dependency queued for download: X` | 缺失，待下载。 |
| `Dependency queued (already present): X` | 缺失，但安装程序已在 `{tmp}` 或是本机已有程序，不下载。 |
| `Dependency not available for this architecture: X` | 该架构没有对应安装程序。 |
| `Dependency skipped (component not selected): X` | 所属组件未被选中。 |
| `Dependency skipped after failed download: X` | 下载失败且用户选择忽略。 |
| `Dependency exit code N: X` | 安装程序退出码为 N。 |

### 退出码处理

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功。 |
| `1638` | 成功（已装了更新的版本）。 |
| `3010` | 成功，需要重启；Setup 在结束时询问。 |
| `1641` | 成功，安装程序已发起重启；重启后 Setup 继续。 |
| `1618` | 另一个安装正在进行——等待后重试，超过次数才算错误。 |
| 其它 | 错误：用户可选择中止 / 重试 / 忽略。设了 `ForceSuccess` 则一律算成功。 |

重启后继续安装：库会把 Setup 自己写进 `RunOnce`，用原参数加 `/restart=1` 重新拉起。脚本可以用 `ParamStr` 检测 `/restart=1` 来做差异化处理。

### 静默安装

`/SILENT` 或 `/VERYSILENT` 下依赖安装程序静默运行；再加 `/SUPPRESSMSGBOXES` 则不询问用户，重试后仍失败就直接中止安装。

## 版本固定与更新

技能自带的是上游某个时间点的快照（对应上游提交 `4f0d025`，含 WebView2 154 更新）。**快照把具体补丁版本和哈希都固化进去了**——例如 .NET 10 桌面运行时写死为 `windowsdesktop-runtime-10.0.12`，并配了 x86/x64/arm64 三份 SHA-256。影响是双向的：目标机版本低于 10.0.12 才会触发下载（装的是 10.0.12 而不是最新补丁），而目标机版本高于它则判定为"已装"直接跳过。要一直用最新补丁版就得定期刷新这个副本。

上游会持续新增依赖（新的 .NET 版本等），需要刷新时：

```bash
gh api repos/DomGries/InnoDependencyInstaller/contents/CodeDependencies.iss --jq '.content' \
  | base64 -d > <skill-dir>/assets/CodeDependencies.iss
```

**不要**在每次打包时都去拉最新版：库的行为会变（重试策略、依赖 URL），固定一份经过验证的副本能让构建可复现。真要升级就升一次、跑一遍安装验证，再提交。

用户项目里已经存在 `CodeDependencies.iss` 时，构建脚本**不会覆盖**它，只提示两者不一致——那是用户自己维护的版本，尊重它。