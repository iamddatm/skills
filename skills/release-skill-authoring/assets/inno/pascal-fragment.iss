; ============================================================================
; 安装包 [Code] 段读写更新清单的实测函数集
;
; 来源：用户飞马项目里已上线运行的 scripts/inno/fmtb-inno-setup.iss（2026-10 实测可用），
; 抽掉了项目专有常量与业务判断，只留与清单格式有关的纯函数。
;
; 为什么不用 JSON 解析器：Inno Pascal 没有内置的，为一个几字段的清单引第三方不划算。
; 「找键 → 找冒号 → 取引号对」就够了 —— 前提是清单遵守 scripts/engine/lib/flat-json.mjs 里
; 写死的那四条约束（顶层字段先于嵌套块、值里无引号、一行一键、纯 ASCII、所有值带引号）。
;
; ⚠️ 改清单结构前先读 flat-json.mjs 的文件头（它列出了那几条硬约束），
; 那里有一个用 JS 复刻了下面 JsonStr 的断言，两边必须同时改 ——
; 改完在元技能 release-skill-authoring 里跑一次 `node scripts/self-test.mjs` 验证（本技能目录里没有那个脚本）。
; ============================================================================

// ---------------------------------------------------------------------------
// 从清单文本里取一个字符串字段
// ---------------------------------------------------------------------------
// 清单由发版脚本写成「一行一个键」的扁平文本，键序固定（冒号后带一个空格），
// 故「找键 -> 找冒号 -> 取引号对」足够。
//
// ⚠️ 两个前提，改清单结构或改这个函数前必须确认：
//   1) 它取的是**第一个**匹配的键。清单顶层与嵌套块（full）里都有 version，能正常工作
//      只是因为发版脚本把嵌套块排在最后 —— 一旦有顶层键被排到它后面，这里会静默读到 full 里的值。
//      要读 full 里的字段，用下面带起始位置的 JsonStrFrom。
//   2) 没有转义处理：值里出现引号会被截断。发版脚本侧的 encodeString 会**直接拒绝**含引号的
//      值，所以正常流程不会产生这种清单。
//
// 另外：它只认带引号的字符串。清单里所有值都是字符串（包括数字，见 flat-json.mjs 约束 4）——
// 裸写数字 1 会让它一路往后找到下一个字段的引号，读出别人的内容。
function JsonStr(const Source, Key: String): String;
var
  Rest: String;
  P, Q: Integer;
begin
  Result := '';
  P := Pos('"' + Key + '"', Source);
  if P = 0 then Exit;
  Rest := Copy(Source, P + Length(Key) + 2, Length(Source));
  P := Pos(':', Rest);
  if P = 0 then Exit;
  Rest := Copy(Rest, P + 1, Length(Rest));
  P := Pos('"', Rest);
  if P = 0 then Exit;
  Rest := Copy(Rest, P + 1, Length(Rest));
  Q := Pos('"', Rest);
  if Q = 0 then Exit;
  Result := Copy(Rest, 1, Q - 1);
end;

// 从 StartPos 之后取第一个 Key 字段，专给嵌套块用：清单里的 full 块与顶层有同名字段
// （version），只会「取第一个匹配键」的 JsonStr 分不清是哪一个 —— 先定位到 "full" 的起点，
// 再把后面那截交给 JsonStr。StartPos 传 0（没找到）时返回空串。
function JsonStrFrom(const Source: String; StartPos: Integer; const Key: String): String;
begin
  Result := '';
  if (StartPos < 1) or (StartPos > Length(Source)) then Exit;
  Result := JsonStr(Copy(Source, StartPos, Length(Source)), Key);
end;

// ---------------------------------------------------------------------------
// 版本号比较
// ---------------------------------------------------------------------------
// 取版本号第 Index 段（从 1 起）的整数值；段缺失或非数字按 0。
function VersionPart(const Ver: String; Index: Integer): Integer;
var
  S: String;
  I, Dot: Integer;
begin
  S := Ver;
  Result := 0;
  for I := 1 to Index do
  begin
    Dot := Pos('.', S);
    if Dot > 0 then
    begin
      Result := StrToIntDef(Copy(S, 1, Dot - 1), 0);
      S := Copy(S, Dot + 1, Length(S));
    end
    else
    begin
      Result := StrToIntDef(S, 0);
      S := '';
    end;
  end;
end;

// 逐段按整数比较：a 大返回 1，相等 0，小返回 -1。
// **不能按字符串比** —— "26.10.1.1" 会小于 "26.9.1.1"，而自增数是每次发版必增的那一段，
// 比反了客户端就会把新版判成旧版、永远不更新。
function CompareVersions(const A, B: String): Integer;
var
  I, PA, PB: Integer;
begin
  Result := 0;
  for I := 1 to 4 do
  begin
    PA := VersionPart(A, I);
    PB := VersionPart(B, I);
    if PA <> PB then
    begin
      if PA > PB then Result := 1 else Result := -1;
      Exit;
    end;
  end;
end;

// ---------------------------------------------------------------------------
// 读清单的骨架（按项目补全 URL、文件名与业务判断）
// ---------------------------------------------------------------------------
// 要点：
//   · 读清单走 LoadStringsFromFile + StringJoin 拼成一个长串，**不要用 LoadStringFromFile** ——
//     后者的 var 参数是 AnsiString，而本段全是 Unicode String；且清单是按行组织的，按行拼更稳。
//   · 下载用 DownloadTemporaryFile，第 3 个参数传清单里的 sha256，内容对不上会直接抛异常，
//     由外层 try..except 兜住并降级。
//   · 任何一步失败都只降级（装基线版）+ 写日志，绝不阻断安装。
function DoFetchLatest(): String;
var
  ManifestPath, Manifest, OnlineVersion, FullVersion: String;
  Lines: TArrayOfString;
begin
  Result := '已安装 v{#AppVersion}（未检查更新）';
  ManifestPath := ExpandConstant('{tmp}') + '\\' + ManifestName;
  DownloadTemporaryFile(UpdateBase + '/' + ManifestName, ManifestName, '', @OnDownloadProgress);
  if not LoadStringsFromFile(ManifestPath, Lines) then
  begin
    Log('更新清单读取失败:' + ManifestPath);
    Result := '未能读取更新清单,已安装 v{#AppVersion}';
    Exit;
  end;
  Manifest := StringJoin('', Lines);

  OnlineVersion := JsonStr(Manifest, 'version');
  if (OnlineVersion = '') or (CompareVersions(OnlineVersion, '{#AppVersion}') <= 0) then
  begin
    Log('线上版本不高于基线,跳过覆盖');
    Result := '已是最新版 v{#AppVersion}';
    Exit;
  end;

  // full 块 = 最近一次完整基线。基线比它旧时，只含业务文件的更新包覆盖不上去，只能等完整包。
  // 读嵌套块必须先定位到 "full"，否则 JsonStr 会撞上顶层的同名字段。
  FullVersion := JsonStrFrom(Manifest, Pos('"full"', Manifest), 'version');
  if (FullVersion <> '') and (CompareVersions(FullVersion, '{#AppVersion}') > 0) then
  begin
    Log('基线早于最近一次完整包 v' + FullVersion + ',跳过覆盖');
    Result := '线上已换基线 v' + FullVersion + ',已安装 v{#AppVersion}(客户端会提示升级)';
    Exit;
  end;
  Result := '已是最新版 v{#AppVersion}';
  // 此处接：取 file/sha256 下载更新包 -> 校验 -> 在 ssPostInstall 里解包覆盖业务目录
end;

// 钩子与顺序（两者在 /VERYSILENT 下都实测触发；NextButtonClick 在静默模式下不保证触发）：
//   CurStepChanged(ssInstall)      —— 文件拷贝**之前**，用来读清单与下载
//   CurStepChanged(ssPostInstall)  —— 文件拷贝**之后**，用来解包覆盖
// 反了的话，基线里的旧业务文件会把刚解出来的新版盖回去。