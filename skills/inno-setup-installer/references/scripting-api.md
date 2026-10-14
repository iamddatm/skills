# Inno Pascal 速查（写 `[Code]` 段用）

`[Setup]` / `[Files]` 那类配置段写错，编译器会直白地点出段名与行号；`[Code]` 段是 Pascal，坑多且报错常指向别处。写 `[Code]` 之前过一遍这份，比对着报错猜快得多。

## 查签名：先翻技能自带的索引

`references/inno-help/api-index.txt` 是官方帮助里**支撑函数 / 类与方法 / 事件**的签名行（约一千行）。**参数个数与类型不确定时先 grep 它**，别凭记忆写——`Invalid number of parameters` 这类报错全是记忆造成的。

语义、参数说明与示例看本页下面的「常用签名」与「坑」，以及 `inno-script-cookbook.md`；冷门细节再去官网（索引末尾列了常用主题名）。索引怎么重建见 `references/inno-help/README.md`。

官网帮助是 **frameset**：`https://jrsoftware.org/ishelp/index.php?topic=xxx` 用 `curl` 抓只会得到框架页，正文在 `https://jrsoftware.org/ishelp/topic_xxx.htm`（浏览器里走 `index.php` 正常，frames 由浏览器组装）；主题名即文件名，全部主题名在 `contents.htm` 里。

## 常用签名（Inno Setup 6.7.x）

```pascal
// 裸下载（**下大文件请用下面的下载页** —— 这个函数下载期间不处理消息，界面会假死）。
// 文件落在 {tmp}\<BaseName>（BaseName 只接受文件名，不能带路径）；返回字节数。
// 第 3 个参数传 SHA-256 就自动校验，内容对不上直接抛异常（这是清单驱动下载最省事的校验方式）。
// 没有自定义请求头/超时参数。
function DownloadTemporaryFile(const Url, BaseName, RequiredSHA256OfFile: String;
  const OnDownloadProgress: TOnDownloadProgress): Int64;
// 下载进度回调；返回 False 会中止下载，所以正常总是 True。
// function(const Url, Filename: String; const Progress, ProgressMax: Int64): Boolean;

function DownloadTemporaryFileSize(const Url: String): Int64;   // 下载前先探大小
function DownloadTemporaryFileDate(const Url: String): String;  // 下载前先探改动时间
function GetSHA256OfFile(const Filename: String): String;

// 进度页：只有 Show / Hide / SetText / SetProgress，没有 Visible —— 自己拿个 Boolean 记状态。
function CreateOutputProgressPage(const ACaption, ADescription: String): TOutputProgressWizardPage;
//   procedure Show;  procedure Hide;
//   procedure SetText(const Msg1, Msg2: String);
//   procedure SetProgress(const Position, Max: Longint);

// ★ 下载页（6.3+）。**下大文件优先用它**：自带进度条 / 速度 / 剩余时间 / 中止按钮，
//   且 Download 在处理消息循环里跑 —— 界面不假死。第 3 个参数是进度回调，不需要就传 nil。
function CreateDownloadPage(const ACaption, ADescription: String;
  const OnDownloadProgress: TOnDownloadProgress): TDownloadWizardPage;
// TDownloadWizardPage 继承 TOutputProgressWizardPage（上面那四个方法都有），另有：
//   function Add(const Url, BaseName, RequiredSHA256OfFile: String): NativeInt;
//     // BaseName 只接受文件名（不能带路径），文件落在 {tmp}\<BaseName>
//     // RequiredSHA256OfFile 传 SHA-256 就自动校验、对不上直接抛异常；传空串即不校验
//   function AddEx(const Url, BaseName, RequiredSHA256OfFile, UserName, Password: String): NativeInt;
//     // 需要认证的源站用这个
//   function AddWithISSigVerify(const Url, ISSigUrl, BaseName: String;
//     const AllowedKeysRuntimeIDs: TStringList): NativeInt;   // 签名会变时用，配 [ISSigKeys]
//   procedure Clear;                         // 清空下载队列
//   function Download: Int64;                // 下队列里的全部文件；返回字节数
//   property AbortedByUser: Boolean; read;   // Download 返回后查它，区分「用户中止」与「真出错」
//   property AbortButton: TNewButton; read;
//   property ShowBaseNameInsteadOfUrl: Boolean; read write;

// 解压（依赖 [Setup] 的 ArchiveExtraction，至少要 enhanced/nopassword；full 才支持 7z.dll 认得的那批格式）。
// 本技能没实测过它对 .tar.gz 的行为 —— 上游给 tar.gz 时走系统 tar.exe（见 cookbook §11）。
procedure ExtractArchive(const ArchiveFileName, DestDir, Password: String;
  const FullPaths: Boolean; const OnExtractionProgress: TOnExtractionProgress);
procedure MapArchiveExtensions(const DestExt, SourceExt: String);

// 读文本：注意没有 String 版，见坑 2。
function LoadStringsFromFile(const FileName: String; var S: TArrayOfString): Boolean;
function StringJoin(const Separator: String; const Values: TArrayOfString): String;

function Copy(S: AnyString; Index, Count: Integer): String;   // 参数是 AnyString，比 Pos 宽容
function Pos(SubStr, S: AnyString): Integer;
function Exec(const Filename, Params, WorkingDir: String; const ShowCmd: Integer;
  const Wait: TExecWait; var ResultCode: Integer): Boolean;

function Format(const Format: String; const Args: array of const): String;
function StrToIntDef(const S: String; const Default: Integer): Integer;
function GetExceptionMessage: String;
function WizardSilent: Boolean;          // /SILENT 或 /VERYSILENT
function ExpandConstant(const S: String): String;
procedure Log(const S: String);          // 写进 /LOG 的日志，排障全靠它
```

## 下载：先分清「下载页」与「裸下载函数」

| | `CreateDownloadPage`（下载页，6.3+） | `DownloadTemporaryFile`（裸函数） |
|---|---|---|
| 进度条 / 速度 / 剩余时间 | **自带** | 无，得自己用 `CreateOutputProgressPage` 画 |
| 中止按钮 | **自带**（配 `AbortedByUser` 判断） | 无，只能靠进度回调返回 False |
| 下载期间界面 | **保持响应**（跑在处理消息循环里） | 不处理消息，大包会**假死** |
| 多文件 / 队列 | `Add` 排队，一次 `Download` 全下 | 自己写循环 |
| 什么时候用 | **几十 MB 以上的载荷** | 单个小文件、已有自己的进度页、纯静默调用 |

判断标准就是**包的大小**：几百 KB 用哪个都行，几十上百 MB 必须用下载页 ——
否则用户看到的是一个点了没反应的安装程序，然后去点关闭。

> 曾有说法认为 `TDownloadWizardPage` 是「6.3 之前手搭向导页的老办法」，那是把它和自己
> `CreateCustomPage` 加控件、手工算进度混为一谈了 —— **手搭的是后者，不是 `CreateDownloadPage`**。
> 后者是官方 API，本技能捆绑的 `assets/CodeDependencies.iss` 下依赖用的就是它。

### 能过编译的样例（本技能实测：ISCC 退出码 0）

下载页在**向导存在时**建（`InitializeWizard`）；`Download` 在哪调取决于流程 ——
交互路径挂 `NextButtonClick`，静默安装也要跑的路径挂 `CurStepChanged(ssInstall)`。两种都能过编译。

```pascal
var
  DownloadPage: TDownloadWizardPage;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage('正在下载更新', '请稍候，正在获取最新版本…', nil);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;
end;

// 路径一：交互式向导里下（用户点了「下一步」）
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpReady then
  begin
    // 哈希来自清单，不要写死
    DownloadPage.Add('https://dl.example.com/p/payload-3f2ac9b1d0e4.tar.gz', 'payload.tar.gz', ExpectedSHA256);
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
      except
        if DownloadPage.AbortedByUser then
          Log('用户中止了下载。')
        else
          SuppressibleMsgBox(AddPeriod(GetExceptionMessage), mbCriticalError, MB_OK, IDOK);
        Result := False;
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;

// 路径二：静默安装也要跑的路径（清单驱动，见 cookbook §11-B）
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    DownloadPage.Add(PayloadUrl, 'payload.tar.gz', ExpectedSHA256);   // 可以排队多个
    DownloadPage.Show;
    try
      DownloadPage.Download;
    except
      Log('下载失败，降级装基线版：' + GetExceptionMessage);
    end;
    DownloadPage.Hide;
  end;
end;
```

几条必须知道的：

- **哈希从清单里读**传给 `Add` 第 3 个参数，别写死在脚本里 —— 写死 = 包一更新安装包就失效。
  不需要校验时传空串（但要明白这是在放弃完整性校验，交付时讲清楚）。
- `BaseName` **只能给文件名**（不能带路径），文件落在 `{tmp}\<BaseName>`。
  想让进度条显示 URL 而不是文件名，设 `ShowBaseNameInsteadOfUrl := False`。
- `Add` 只是排队，**不调 `Download` 不会下载** —— 跳过某次下载（比如已是最新版）就是不调它。
- **静默安装下页面不显示，但 `Download` 照常执行**。别把关键逻辑挂在页面的可见性上。

## 事件与触发时机

| 事件 | 时机 | 静默安装（/VERYSILENT）下 |
| --- | --- | --- |
| `InitializeSetup` | 解析完命令行、界面还没建 | 触发 |
| `InitializeWizard` | 建向导页 | 未验证（页面本身不显示） |
| `NextButtonClick` | 点「下一步」/「安装」 | **没验证过，设计上不要赌它** |
| `CurStepChanged(ssInstall)` | 文件拷贝**之前** | **实测触发** |
| `CurStepChanged(ssPostInstall)` | 文件拷贝**之后** | **实测触发** |
| `CurPageChanged` | 切页 | 未验证 |

结论很实用：**要在静默安装下也生效的动作，一律挂 `CurStepChanged`**（实测坐实），别挂 `NextButtonClick`。顺序同理 —— 覆盖已被 `[Files]` 拷进去的文件必须放在 `ssPostInstall`，放早了会被随后的 `[Files]` 拷贝盖回去。

## 坑（都是实测踩出来的）

1. **`[Code]` 段注释必须用 `//`**。`;` 在 Pascal 里是语句分隔符：写在 `const` / `var` 声明里报 `Identifier expected`，写在语句位置报 `'BEGIN' expected`，而且行号常指向函数开头——很难联想到是注释写法。写完 `[Code]` 扫一遍自己敲的每个 `;`。
2. **读文本文件别用 `LoadStringFromFile`**：它的 `var` 参数是 `AnsiString`，传 `String` 变量编译期就报 `Type mismatch`（6.x 一直如此，没跟上 Unicode）。用 `LoadStringsFromFile` + `StringJoin('', Lines)`：读自己可控的扁平清单/JSON 时，按行拼回一个长串再做子串查找完全够用。
3. **别拿 Pascal 内置名当变量名**：`Text`、`String`、`File`、`Result`……`var Text: String` 会报 `Type mismatch`，报错行还指向后面用到它的那行，看着完全对不上。
4. **`Exit` 在 `try..except` 里会跳出整个过程**，`except` 之后的收尾代码（例如 `ProgressPage.Hide`）不会执行 —— 进度页就这么留在屏幕上。写法是把主体拆成一个「返回结果」的函数，外层统一 `try` + 收尾。
5. **Int64 与 Longint**：进度回调给你的 `Progress` / `ProgressMax` 是 `Int64`，而 `SetProgress` 要 `Longint`，直传报 `Type mismatch`；转换前确认一下量级（下载包大小远小于 2³¹，随手转不会溢出）。
6. **没有内置 JSON 解析器**。要读一份自己后端生成、键序固定且无嵌套的清单，`Pos` + `Copy` 手撸十来行就够，别为它引第三方 Pascal 库。
7. **在线动作一律 `try..except` 降级**：失败只 `Log` + 在完成页给用户一句话结论，不要中断安装——装个基线版总比装不上强，何况应用自身往往还有自动更新兜底。