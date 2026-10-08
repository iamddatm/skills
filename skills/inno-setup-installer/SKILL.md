---
name: inno-setup-installer
description: '把 Windows 应用打包成简体中文安装程序：生成 Inno Setup 的 .iss 脚本、备好编译环境（必要时自动 winget 安装 Inno Setup）、调用 ISCC 编译出 setup.exe，默认勾选创建桌面快捷方式，支持「安装包联网下载最新文件覆盖安装」的在线安装包，并用 InnoDependencyInstaller 自动补齐 .NET / VC++ 运行库等依赖。用户提到生成/制作/打个安装包、安装程序、setup.exe、Inno Setup、.iss 脚本、安装向导、桌面快捷方式、安装时自动装运行库或 .NET 运行时、在线安装包/覆盖式安装、给程序加卸载入口等场景时使用本技能；即使没点名 Inno Setup，只要要把构建好的 Windows 程序做成安装包，也应使用本技能。'
---

# Inno Setup 安装包制作

把已经构建好的 Windows 程序打包成简体中文安装程序。技能负责三件事：写 `.iss` 脚本、把编译环境备齐（没有 Inno Setup 就自动装）、调用 ISCC 编译出 `setup.exe` 并验证产物真的出来了。

官网 https://jrsoftware.org/ ，下载页 https://jrsoftware.org/isdl.php 。

## 先摸清需求，再动笔

安装包的形态差异很大，猜错一次就要返工。**能从项目里读出来的自己读**（发布目录、主程序 exe 名、版本号往往在 `.csproj` / `package.json` / 构建脚本里），把提问留给真正要用户拍板的事：

1. **载荷从哪来** —— 应用构建好了吗？发布目录是哪个？有没有需要排除的文件（`*.pdb`、`appsettings.Development.json`）？
2. **离线还是在线** —— 载荷打进安装包（离线，默认）？还是安装包运行联网下载最新文件覆盖安装（在线）？用户说"安装包自己去网上拉最新版"就是后者，见下文对应章节。
3. **装给谁** —— 全机安装（`{autopf}`，需要管理员）还是只装当前用户（`{localappdata}`）？
4. **要不要装运行库** —— 目标机缺 .NET Desktop Runtime / VC++ / WebView2 吗？缺的话交给 CodeDependencies 处理，别让用户手动装。
5. **杂项** —— 主程序 exe 名、程序图标、编译出的安装包放哪、要不要开机自启、要不要写注册表或做文件关联。

## 环境：先确保 ISCC 可用

Inno Setup 的编译器是 `ISCC.exe`。本机常常没装，而 InnoDependencyInstaller 又硬性要求 **Inno Setup ≥ 6.7**，所以备环境和编译都交给技能自带的构建脚本 `scripts/build-installer.ps1`——它就在本技能目录下、与 SKILL.md 同级，先确认它存在，不要凭印象认为缺失：

```bash
# <skill> = 本技能所在目录（即 SKILL.md 所在目录）
pwsh -NoProfile -File "<skill>/scripts/build-installer.ps1" -Script "D:/path/to/setup.iss"
```

脚本按固定顺序做事，失败时会告诉你是哪一步：

1. 依次在 PATH、`C:\Program Files (x86)\Inno Setup 6\`、`%LOCALAPPDATA%\Programs\Inno Setup 6\`、Inno Setup 7 的目录里找 `ISCC.exe`（Inno Setup 6 是 32 位程序，即使在 64 位 Windows 上也装在 `Program Files (x86)`）。
2. 找不到就 `winget install --id JRSoftware.InnoSetup -e`（装的是 Inno Setup 6，当前 winget 源里是 6.7.3）。加 `-NoAutoInstall` 可以改成只报错不动机器。
3. 校验版本号 ≥ 6.7（InnoDependencyInstaller 的硬性要求）。版本号从注册表卸载项读——`ISCC.exe` 自身的版本资源是 `0.0.0.0`，别指望从它或命令行输出里拿到版本。
4. 把 `.iss` 用到的随包资源拷到它同级目录，相对路径即可引用：`CodeDependencies.iss`（依赖库）和 `ChineseSimplified.isl`（中文界面）。
5. 给缺少 BOM 的 `.iss` / `.isl` 补上 UTF-8 BOM（中文的坑，见"常见陷阱"）。
6. 编译，并从 ISCC 输出里解析出产物的真实路径和体积打印出来。

自己动手排查时，`ISCC.exe <路径>` 也能直接跑；退出码 0 是成功，非 0 时把 stdout 原样读一遍，Inno 的报错信息通常直接指出是第几行哪个指令写错了。

## 写 .iss：中文界面 + 默认勾选桌面快捷方式

这是骨架，按项目实际改。**`{cm:...}` 是语言文件里的消息键**，写它而不是写死中文，界面才会跟着语言走：

```iss
; 这些值优先从项目里读，不要凭空编
#define MyAppName "我的程序"
#define MyAppVersion "1.2.3"
#define MyAppPublisher "某某公司"
#define MyAppURL "https://example.com/"
#define MyAppExeName "MyApp.exe"

[Setup]
; AppId 一旦发布过就不能再改：Windows 靠它认"同一个程序"。
; 注意只有结尾一个花括号——双花括号是转义，写成 {{GUID} 才是对的
AppId={{8D3B2F1A-6C4E-4A7B-9F21-0E5D3C8A1B47}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=Output
OutputBaseFilename={#MyAppName}-{#MyAppVersion}-setup
; VersionInfoVersion 只吃纯数字四段，"1.2.3-beta" 这类要先剥掉后缀
VersionInfoVersion=1.2.3.0
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 装到 Program Files 和安装运行库都需要管理员
PrivilegesRequired=admin
; 仅当程序是 64 位（或发布的是 x64/arm64 产物）时才写这行；
; 32 位程序写了它，{app} 会解析到 64 位 Program Files，而它本该装进 Program Files (x86)
ArchitecturesInstallIn64BitMode=x64compatible or arm64

[Languages]
; 相对路径以 .iss 所在目录为基准；构建脚本会把技能自带的中文语言文件放到那里
Name: chinesesimplified; MessagesFile: "ChineseSimplified.isl"

[Tasks]
; [Tasks] 默认就是勾选状态（写了 unchecked 才反过来），所以这一行就实现了"默认选中创建桌面快捷方式"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
; 只有勾了 desktopicon 任务才创建，取消勾选就跳过——这就是上面那个 Tasks 的作用
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[Code]
#include "CodeDependencies.iss"

function InitializeSetup: Boolean;
begin
  Result := True;
end;
```

`{autopf}` / `{autoprograms}` / `{autodesktop}` 是自适应常量：`PrivilegesRequired=admin` 时解析到全机目录，装当前用户时解析到用户目录。别写死 `{pf}` / `{commondesktop}`，换安装范围时会出错。

更多段落（`[Registry]`、文件关联、开机自启、许可证页、自定义向导页）、以及图标和许可文件的写法，见 `references/inno-script-cookbook.md`。

## 依赖：让安装包自己补齐运行库

目标机缺 .NET / VC++ / WebView2 是安装后闪退的头号原因。技能自带 `assets/CodeDependencies.iss`（来自 DomGries/InnoDependencyInstaller，MIT），上面骨架已经 `#include` 好了，你只需要在 `InitializeSetup` 里一行一个地列出依赖：

```iss
[Code]
#include "CodeDependencies.iss"

function InitializeSetup: Boolean;
begin
  Dependency_AddDotNet100Desktop; // .NET 10 桌面运行时（WPF / WinForms 用这个）
  Dependency_AddVC14;             // Visual C++ 2015-2026 运行库
  Result := True;
end;
```

- 每个函数**先检测再安装**，已装的直接跳过，用户看不到多余步骤。
- 依赖在"准备安装"页面列出，安装时从厂商官方地址下载，**默认带 SHA-256 校验**，下载失败会自动重试。
- 已实现的依赖有 60 多个（.NET Framework 3.5~4.8.1、.NET Core/.NET 5~10 的各种运行时、VC++ 2005~2026、SQL Server Express、WebView2、Windows App SDK、OpenJDK、Python、PowerShell 7……）。完整函数名和常见选型见 `references/dependencies.md`。
- 选哪个版本要跟应用的 `TargetFramework` 对齐，**猜错会导致依赖装了但程序仍跑不起来**——从 `.csproj` 读，读不到就问用户。
- 目标机不能上网时，把安装程序打进包里离线使用；用法同样在 `references/dependencies.md`。

`PrivilegesRequired=admin` 和 `ArchitecturesInstallIn64BitMode` 是这套依赖机制的前提，骨架里已经有，别删。

## 变体：安装包联网下载最新文件覆盖安装

用户要的是"安装包自己上网拉最新的更新包，覆盖装上去"，而不是把载荷打进安装包时，用 Inno Setup 6 的**原生下载 + 解压**能力，不需要写 Pascal 脚本、也不需要第三方下载插件：

```iss
[Setup]
; 解压 .zip 必须显式设 full；只解 .7z 的话默认的 auto 就够
ArchiveExtraction=full
; 覆盖安装要替换正在运行的程序文件，CloseApplications 默认就是 yes，
; 它会用 Windows Restart Manager 提示用户关掉占用的程序并在装完后重启，通常不用显式写

[Files]
Source: "https://download.example.com/client-latest.zip"; \
  DestName: "client.zip"; DestDir: "{app}"; \
  ExternalSize: 52428800; \
  Flags: external download extractarchive recursesubdirs createallsubdirs ignoreversion
```

几个必须知道的点：

- `download` **必须**和 `external`、`ignoreversion` 一起用，并且要提供 `DestName` 和 `ExternalSize`。`ExternalSize` 只用于显示进度条，但要填，真实值用 `Invoke-WebRequest -Method Head <url>` 取 `Content-Length`。
- `download` 不能和 `comparetimestamp`、`skipifsourcedoesntexist` 同时用。
- 支持 HTTPS（证书必须有效，自签名不行）、自动跟随重定向、自动走系统代理。
- 怎么校验下载物：目标是**固定版本 URL** 时用 `Hash: "<sha256>"`；目标是 `latest` 这种会变的 URL 时哈希必然失效，要么改用 `issigverify`（配 `[ISSigKeys]`，脚本不用随文件更新而改动），要么接受不校验——不校验要在交付时讲明白这个风险。
- **覆盖不等于同步**：安装只会覆盖同名文件，旧版有、新版删掉的文件会残留在 `{app}` 里。要真正镜像新版内容，得先加 `[InstallDelete]` 清掉旧目录（详见 cookbook）。这一条是"覆盖式升级"最常见的翻车点。
- URL 建议用 `#define` 抽出来（`Source: "{#PayloadUrl}"`），或在命令行用 `ISCC /DPayloadUrl=...` 传入，方便换环境。

也能用 Pascal 脚本自己搭个下载页（`TDownloadWizardPage`）把包下到 `{tmp}` 再解压——那是 6.3 有原生下载之前的老办法，函数签名繁琐、很容易写出 `Invalid number of parameters`，除非确实需要自定义下载逻辑（多点回退、断点续传），否则别绕这条路。

## 编译与验收

编译走构建脚本。**"编译成功"不等于"安装包能用"**，报告结果前至少确认：

1. ISCC 退出码为 0，输出里有 `Successful compile`，并拿到了产物的真实路径。
2. 产物文件存在且体积合理（明显偏小说明 `[Files]` 的 `Source` 路径没匹配上——注意 `Source` 是相对 `.iss` 所在目录，不是当前工作目录）。
3. `.iss` 里 `[Languages]` 挂的是中文文件、`[Tasks]` 那行没有 `unchecked`。

想更稳妥，可以在临时目录静默装一遍验证（会真的安装到系统，测试完记得卸载）：

```bash
pwsh -NoProfile -c "Start-Process -Wait -FilePath 'D:/path/setup.exe' -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LOG=D:/tmp/install.log'"
```

装完看日志和 `{app}` 目录里的文件是不是齐的；用 `/LOG` 时日志会记录每条依赖的判断结果（`Dependency already installed:` / `Dependency queued for download:`）。

**交付前顺带确认授权**：Inno Setup 6.7+ 的编译器每次都会打印 `Non-commercial use only`。官方授权页的原文是"we request that all commercial users of Inno Setup purchase licenses, regardless of the version being used"（<https://jrsoftware.org/isorder.php>）。如果这个安装包要用在商业产品上分发，把这条告诉用户，由他决定是否采购授权——别替他默认。

## 常见陷阱

- **中文语言文件要自带**：Inno Setup 的安装包**不含**简体中文——6.7.3 的 `Languages\` 目录里只有 29 种官方语言，`ChineseSimplified.isl` 归在源码库的 `Unofficial\` 下、不随安装包发布。所以别写 `compiler:Languages\ChineseSimplified.isl`，那会直接编译失败"找不到文件"。用技能自带的 `ChineseSimplified.isl`（构建脚本负责放到 `.iss` 同级目录）。
- **中文乱码**：`.iss` / `.isl` 里的中文必须存成 UTF-8；Inno Setup 6.7.2 起才接受**无 BOM** 的 UTF-8，更早的版本只认带 BOM 的。构建脚本会自动补 BOM，用编辑工具直接写就行；手动编译报"行内出现非法字符"时先查编码。
- **`AppId={{GUID}`**：双花括号是转义，结尾只有一个 `}`。写成 `{{GUID}}` 会在卸载列表里留下多余的花括号。
- **`VersionInfoVersion`**：只接受纯数字四段；带 `-beta` 的语义化版本号必须先剥后缀，否则编译期报错。
- **`OutputBaseFilename` 用 ASCII**：界面是中文就够了，安装包文件名保持纯英文，避免在别人的下载工具、邮件网关、老 FAT 分区上出岔子。
- **`[Code]` 段的注释是 `//` 不是 `;`**：`[Setup]` / `[Files]` 这类配置段里 `;` 是注释，但 `[Code]` 是 Pascal，`;` 是语句分隔符。在 `[Code]` 里用 `;` 写中文注释会报 `Error on line N: 'BEGIN' expected`，而且报错行号指向函数开头，很难联想到是注释写法的问题。
- **`Source` 的相对路径基准是 `.iss` 所在目录**，不是你的 shell 当前目录。
- **`ArchitecturesInstallIn64BitMode` 只给 64 位程序写**：32 位程序写了它，`{app}` 会解析到 `Program Files` 而非 `Program Files (x86)`。
- **装当前用户（`PrivilegesRequired=lowest`）就别指望装运行库**：`{autopf}` 这类自适应常量会跟着解析到用户目录，不会出错，但 CodeDependencies 要把运行库装到全机、写 `HKLM`，没有管理员权限做不到。要装依赖就必须 admin。

需要更细的段落写法、常量表、在线安装包的完整例子时，读 `references/inno-script-cookbook.md`；需要挑依赖函数时读 `references/dependencies.md`。