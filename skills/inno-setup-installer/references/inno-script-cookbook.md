# Inno Setup 脚本手册

SKILL.md 里的骨架模板之外的补充：各段落常用写法、目录常量、在线安装包的完整例子，以及编译调试手段。

## 目录

- [1. `[Setup]` 常用指令](#1-setup-常用指令)
- [2. 目录与系统常量](#2-目录与系统常量)
- [3. `[Languages]`：语言与中文界面](#3-languages语言与中文界面)
- [4. `[Tasks]`：可选项与默认勾选](#4-tasks可选项与默认勾选)
- [5. `[Icons]`：开始菜单与桌面快捷方式](#5-icons开始菜单与桌面快捷方式)
- [6. `[Files]`：打包载荷](#6-files打包载荷)
- [7. 覆盖安装的镜像语义](#7-覆盖安装的镜像语义)
- [8. `[Registry]`：注册表、开机自启、文件关联](#8-registry注册表开机自启文件关联)
- [9. `[Run]` 与 `[UninstallRun]`](#9-run-与-uninstallrun)
- [10. `[Code]` 常用 Pascal 片段](#10-code-常用-pascal-片段)
- [11. 在线安装包完整示例](#11-在线安装包完整示例)
- [12. 调试与排错](#12-调试与排错)

## 1. `[Setup]` 常用指令

| 指令 | 说明 |
| --- | --- |
| `AppId` | 应用的唯一标识，**发布后不可更改**。省略时 Inno 会用 `AppName` 自动生成，改 AppName 就会变成另一个程序。显式写 `{{GUID}`（注意只一个结尾花括号）。 |
| `DefaultDirName` | 默认安装目录，配 `DisableDirPage=auto` 可跳过选择目录页。 |
| `DisableProgramGroupPage` | 是否跳过开始菜单文件夹选择页。`AllowNoIcons=yes` 配合可让用户取消开始菜单项。 |
| `PrivilegesRequired` | `admin` / `poweruser` / `lowest`。装到 `{autopf}`、装运行库、写 `HKLM` 都需要 `admin`。 |
| `ArchitecturesAllowed` | 允许在哪些架构上安装，如 `x64compatible`、`arm64`。 |
| `ArchitecturesInstallIn64BitMode` | 安装模式按 64 位走（`{app}` 落到 `Program Files`）。**32 位程序不要写。** |
| `Compression` | `lzma2/max` 体积最小、编译最慢；追求编译速度用 `lzma/fast` 或 `zip`。 |
| `SolidCompression` | `yes` 进一步压缩，代价是单文件解压慢。 |
| `WizardStyle` | `modern`（默认）/ `classic` / `modern dynamic`。 |
| `OutputDir` | 产物目录，相对 `.iss` 所在目录；默认 `Output`。 |
| `OutputBaseFilename` | 产物文件名（不含扩展名）。**保持 ASCII。** |
| `VersionInfoVersion` | 产物 exe 的版本资源，**只接受纯数字四段**。 |
| `SetupIconFile` | 安装程序自身的图标。 |
| `UninstallDisplayIcon` | 控制面板"程序和功能"里显示的图标，通常指 `{app}` 里的主程序。 |
| `LicenseFile` / `InfoBeforeFile` / `InfoAfterFile` | 许可协议页 / 安装前 / 安装后说明页，文件须为 UTF-8。 |
| `UsePreviousAppDir` | 默认 `yes`：重复安装时沿用上次的目录，这是"覆盖安装"能装回原处的前提。 |
| `CloseApplications` | 默认 `yes`。用 Windows Restart Manager 检测占用待更新文件的程序，提示关闭并在装完后重启。通常不用显式写。 |
| `AppMutex` | 主程序持有同名互斥体时，安装程序能更准地识别"程序正在运行"。 |

## 2. 目录与系统常量

| 常量 | 全机安装（admin）时 | 当前用户安装时 |
| --- | --- | --- |
| `{autopf}` | `C:\Program Files` | `%LOCALAPPDATA%\Programs` |
| `{autoprograms}` | 所有用户的开始菜单 | 当前用户开始菜单 |
| `{autodesktop}` | 公共桌面 | 当前用户桌面 |
| `{autostartup}` | 公共启动文件夹 | 当前用户启动文件夹 |

其它常用：`{app}`（安装目录）、`{tmp}`（临时目录）、`{userdocs}`、`{localappdata}`、`{commonappdata}`、`{win}`、`{sys}`。

用 `auto*` 系列而不要写死 `{pf}` / `{commondesktop}` / `{userdesktop}`——安装范围一变，写死的常量就指错地方。

## 3. `[Languages]`：语言与中文界面

```iss
[Languages]
Name: chinesesimplified; MessagesFile: "ChineseSimplified.isl"
```

- **路径解析规则**：`MessagesFile` 的相对路径以**脚本所在目录**（安装源的 source directory）为基准；`compiler:` 前缀则解析到 Inno Setup 自己的安装目录。
- **简体中文不在 Inno Setup 的安装包里**。6.7.3 的 `Languages\` 只有 29 种官方语言（阿拉伯语、日语、韩语等），简体中文的 `.isl` 位于源码库的 `Files\Languages\Unofficial\`，不随安装包发布——本机实测 `Languages\` 下确实没有 `ChineseSimplified.isl`。所以**只能自带**，写成 `compiler:Languages\ChineseSimplified.isl` 会编译失败。
- 技能自带的 `assets/ChineseSimplified.isl` 取自 issrc `is-6_7_3` 标签（消息格式 6.5.0+，与 6.7.x 编译器配套），构建脚本负责拷到 `.iss` 同级目录；`ChineseSimplified.isl` 里已定义 `CreateDesktopIcon`（创建桌面快捷方式(&D)）、`AdditionalIcons`、`LaunchProgram`、`UninstallProgram` 等消息键，模板用 `{cm:...}` 引用。
- 要多语言就多写几行，**第一行是初始语言**，用户可在向导首页切换；官方语言用 `compiler:Languages\Dutch.isl` 这类路径，中文用相对路径。
- 想升级中文翻译时，从 <https://jrsoftware.org/files/istrans/> 或 kira-96 的翻译仓库取新的 `.isl` 替换掉 `assets/` 里的副本。

## 4. `[Tasks]`：可选项与默认勾选

```iss
[Tasks]
; 无 Flags -> 默认勾选（这就是"默认选中创建桌面快捷方式"的实现方式）
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

; 想让用户默认不勾，加 unchecked
Name: "startupicon"; Description: "开机自动启动"; GroupDescription: "其它："; Flags: unchecked
```

| Flags | 效果 |
| --- | --- |
| （不写） | 默认勾选。 |
| `unchecked` | 默认不勾选。 |
| `checkedonce` | **首次安装**默认勾选；检测到本程序已装过时默认不勾（`UsePreviousTasks=yes` 时生效）。适合"尊重用户上次的选择"。 |
| `exclusive` | 同一组内互斥（配合多条目单选）。 |

子任务用 `\` 分层，如 `Name: "desktopicon\user"`。

## 5. `[Icons]`：开始菜单与桌面快捷方式

```iss
[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
```

- `Tasks: desktopicon` 把图标的创建与任务勾选绑定，取消勾选就不创建。
- 卸载入口一般不用手写，Inno 会自动加，想控制位置时用 `{cm:UninstallProgram,{#MyAppName}}` 作 Name。

## 6. `[Files]`：打包载荷

```iss
[Files]
Source: "publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.pdb,*.xml,appsettings.Development.json"
```

- `Source` 的相对路径**以 `.iss` 所在目录为基准**，不是 shell 的当前目录——写错就打包出 0 个文件。
- `recursesubdirs createallsubdirs` 递归打包并创建子目录，打包整个发布目录时几乎总要带。
- `Excludes` 是逗号分隔的通配符列表，用于剔除符号文件和开发配置。
- 从构建机打包时用 `Flags: ignoreversion` 通常是对的（覆盖安装要替换文件）；共享系统文件才需要版本比较。

## 7. 覆盖安装的镜像语义

安装程序**只覆盖同名文件，从不删除**它不知道的文件。新版删掉了某个 DLL，旧版装过的那个 DLL 会一直留在 `{app}` 里，可能导致加载到过期组件。要真正镜像新版内容，显式声明删除：

```iss
[InstallDelete]
; 安装开始时（文件拷贝前）清掉旧内容
Type: filesandordirs; Name: "{app}\plugins"
Type: files; Name: "{app}\legacy.dll"

[UninstallDelete]
; 卸载时清掉运行期生成的目录（Inno 不会自动删安装后新增的文件）
Type: filesandordirs; Name: "{app}\cache"
```

`[InstallDelete]` 执行时机是"安装开始"或"安装结束"（`RunOnceId`/时机由条目顺序决定），删目录用 `filesandordirs`。删 `{app}` 整个目录要谨慎——用户可能把数据存在里面。

## 8. `[Registry]`：注册表、开机自启、文件关联

```iss
[Registry]
; 开机自启（当前用户，不需要管理员）
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "{#MyAppName}"; ValueData: """{app}\{#MyAppExeName}"""; \
  Flags: uninsdeletevalue; Tasks: startupicon

; 文件关联
Root: HKCR; Subkey: ".myext"; ValueType: string; ValueName: ""; \
  ValueData: "{#MyAppName}.Document"; Flags: uninsdeletevalue
Root: HKCR; Subkey: "{#MyAppName}.Document\DefaultIcon"; ValueType: string; \
  ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"
```

- `Flags: uninsdeletevalue` / `uninsdeletekey` 让卸载时清掉，否则会在注册表里留垃圾。
- 注册表字符串里嵌 `"` 要写成 `""` 转义（上面 `ValueData` 就是这么写的）。
- 只有确实需要时才写注册表——很多"程序记不住设置"其实用 `{localappdata}` 的配置文件更好。

## 9. `[Run]` 与 `[UninstallRun]`

```iss
[Run]
; postinstall + skipifsilent：正常安装结束后在完成页给一个"运行程序"勾选，静默安装时跳过
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--unregister"; Flags: runhidden
```

## 10. `[Code]` 常用 Pascal 片段

`[Code]` 里是 Pascal，注释一律用 `//` 或 `(* *)`；写成 `;` 会被当成语句分隔符，编译报 `'BEGIN' expected`（报错行号还指向函数开头，极具迷惑性）。

```iss
[Code]
// 目标机是否已装过本程序（用于差异化升级提示）
function IsUpgrade: Boolean;
begin
  Result := RegKeyExists(HKLM, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#MyAppId}_is1');
end;

// 安装前检查主程序是否存在，缺失就警告
function InitializeSetup: Boolean;
begin
  Result := True;
  if not FileExists(ExpandConstant('{app}\{#MyAppExeName}')) then
    MsgBox('未检测到主程序，将继续安装。', mbInformation, MB_OK);
end;
```

`InitializeSetup` 是全局唯一的初始化入口——用了 CodeDependencies 时，依赖函数也要写在这里面（见 `references/dependencies.md`）。想加自定义向导页用 `CreateInputOptionPage` / `CreateInputDirPage`。

## 11. 在线安装包完整示例

载荷不进安装包，安装时联网拉最新更新包并覆盖安装：

```iss
[Setup]
AppId={{8D3B2F1A-6C4E-4A7B-9F21-0E5D3C8A1B47}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible or arm64
OutputDir=Output
OutputBaseFilename={#MyAppName}-{#MyAppVersion}-setup
VersionInfoVersion=1.2.3.0
; 解压 .zip 必须显式设 full；只解 .7z 用默认 auto 即可
ArchiveExtraction=full

[Languages]
Name: chinesesimplified; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; 更新包从线上拉，解压到 {app} 覆盖同名文件
Source: "{#PayloadUrl}"; DestName: "client.zip"; DestDir: "{app}"; \
  ExternalSize: {#PayloadSize}; \
  Flags: external download extractarchive recursesubdirs createallsubdirs ignoreversion

[InstallDelete]
; 覆盖安装不会删旧文件，先清掉旧程序目录再解压，才是真正的"镜像最新版"
Type: filesandordirs; Name: "{app}"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
```

编译时传参：`ISCC /DPayloadUrl=https://... /DPayloadSize=52428800 setup.iss`。要点回顾：

- `download` 必须与 `external`、`ignoreversion` 同用，且必须给 `DestName` 和 `ExternalSize`。
- `ExternalSize` 只影响进度显示，但不可省；取真实值：`Invoke-WebRequest -Method Head <url> | Select -Expand Headers` 里的 `Content-Length`。
- 不能用 `comparetimestamp` / `skipifsourcedoesntexist`。
- 支持 HTTPS（证书须有效）、跟随重定向、走系统代理。
- 完整性校验二选一：固定版本身份用 `Hash: "<sha256>"`；滑动 `latest` 用 `issigverify` + `[ISSigKeys]`，或明确接受不校验。
- 电脑需要联网才能装；目标环境不能上网就改用离线方案（载荷 `Source` 指向本地目录）。

## 12. 调试与排错

- **看编译输出**：ISCC 会对未知的 `[Setup]` 指令、缺失的消息键、匹配不到文件的 `Source` 发出 warning。**警告不要略过**——`Source` 匹配不到文件时编译照样"成功"，但装出来是空壳。
- **看安装日志**：安装程序加 `/LOG="D:\tmp\install.log"`（或只写 `/LOG`，日志落到 `%TEMP%`）。日志里记录了每条依赖的判断结果、每个文件的去向。
- **静默安装验证**：`setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=...`，装完核对 `{app}` 内容再用 `/VERYSILENT` 跑卸载程序清理。
- **中文乱码**：`.iss` 存成 UTF-8；Inno Setup 5.3.5~6.7.1 只认带 BOM 的 UTF-8，6.7.2 起才支持无 BOM。
- **产物太小**：九成是 `[Files]` 的 `Source` 相对路径写错（相对 `.iss` 目录），或 `Excludes` 把所有文件都排除了。