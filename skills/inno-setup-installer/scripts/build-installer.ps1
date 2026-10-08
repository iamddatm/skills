#Requires -Version 5.1
<#
.SYNOPSIS
    编译 Inno Setup 脚本，产出安装程序；缺环境时自动安装 Inno Setup。

.DESCRIPTION
    把"备环境 -> 校验 -> 编译 -> 报产物"这条链固定下来，避免每次调用都重推一遍：
      1. 定位 ISCC.exe（PATH -> Inno Setup 6 / 7 的常见安装位置）
      2. 找不到且未指定 -NoAutoInstall 时，用 winget 安装 Inno Setup 6
      3. 从注册表卸载项读取版本并校验 >= 6.7（InnoDependencyInstaller 的硬性要求）
      4. 把 .iss 引用到的随包资源（CodeDependencies.iss、ChineseSimplified.isl）拷到同级目录
      5. 只有编译器低于 6.7.2 时，才给缺少 UTF-8 BOM 的 .iss / .isl 补 BOM（6.7.2 起接受无 BOM，
         补 BOM 会改写文件本身，对入库的 .iss 就是一次莫名的脏改动）
      6. 调用 ISCC 编译，解析输出中的产物路径与体积

.PARAMETER Script
    要编译的 .iss 文件路径。相对路径按当前工作目录解析。

.PARAMETER NoAutoInstall
    找不到 ISCC.exe 时只报错，不自动执行 winget 安装。

.PARAMETER ForceStage
    即使 .iss 没有引用，也把随包资源拷到 .iss 同级目录。

.EXAMPLE
    pwsh -NoProfile -File build-installer.ps1 -Script D:/proj/setup/setup.iss

.EXAMPLE
    pwsh -NoProfile -File build-installer.ps1 -Script setup.iss -NoAutoInstall
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Script,

    [switch]$NoAutoInstall,

    [switch]$ForceStage
)

# 输出可能含中文（编译告警、路径），不设这个 Git Bash 侧会按 GBK 解码成乱码
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'

$MinInnoVersion = [version]'6.7'
$InnoDownloadPage = 'https://jrsoftware.org/isdl.php'

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-ComparableHash([string]$Path) {
    <#
        内容哈希，忽略开头的 UTF-8 BOM。
        本脚本会给暂存的资源补 BOM，若把 BOM 算进哈希，第二次运行就会把
        "我们自己改的副本"误判成"用户提供的另一个版本"。
    #>
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $bytes = if ($bytes.Length -gt 3) { $bytes[3..($bytes.Length - 1)] } else { @() }
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

function Get-IsccPath {
    <# 返回 ISCC.exe 的完整路径，找不到返回 $null #>
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # Inno Setup 6 是 32 位程序，即使在 64 位 Windows 上也装在 Program Files (x86)；
    # winget 在无管理员权限时可能装到用户目录（本机实测就是这一种）
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 7\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Get-InnoVersion([string]$IsccPath) {
    <#
        从注册表卸载项里取版本号，取不到返回 $null。
        ISCC.exe 自身的版本资源是 0.0.0.0，命令行输出也不带版本号，只有注册表可靠。
    #>
    $installDir = (Split-Path -Parent $IsccPath).TrimEnd('\')
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )

    $entries = @()
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $entries += @(Get-ItemProperty -Path (Join-Path $root '*') -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like 'Inno Setup*' })
    }
    if ($entries.Count -eq 0) { return $null }

    # 6 和 7 可能并存，优先选安装目录与 ISCC.exe 所在目录一致的那条
    $entry = $entries | Where-Object {
        $_.InstallLocation -and ($_.InstallLocation.TrimEnd('\') -ieq $installDir)
    } | Select-Object -First 1
    if (-not $entry) { $entry = $entries | Select-Object -First 1 }

    $match = [regex]::Match([string]$entry.DisplayVersion, '^(\d+)\.(\d+)(?:\.(\d+))?')
    if (-not $match.Success) { return $null }
    $patch = if ($match.Groups[3].Success) { [int]$match.Groups[3].Value } else { 0 }
    return [version]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, $patch)
}

function Install-InnoSetup {
    <# 用 winget 安装 Inno Setup 6（当前源里是 6.7.3）；失败时由调用方统一报错 #>
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "未找到 winget，无法自动安装 Inno Setup。请手动安装：$InnoDownloadPage"
    }
    Write-Host '    winget install --id JRSoftware.InnoSetup -e -s winget'
    & winget.exe install --id JRSoftware.InnoSetup -e -s winget `
        --accept-package-agreements --accept-source-agreements --disable-interactivity
}

function Copy-AssetIfNeeded([string]$AssetName, [string]$TargetDir) {
    <# 把技能自带的资源拷到目标目录；已存在则不覆盖（用户可能维护了自己的版本）#>
    $source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\assets\$AssetName")).Path
    $target = Join-Path $TargetDir $AssetName

    if (Test-Path -LiteralPath $target) {
        if ((Get-ComparableHash $target) -eq (Get-ComparableHash $source)) {
            Write-Host "    $AssetName 已存在且与技能自带版本一致"
        } else {
            Write-Warning "$target 已存在但与技能自带版本不同，保留现有文件（如需替换请自行处理）"
        }
        return
    }
    Copy-Item -LiteralPath $source -Destination $target
    Write-Host "    已写入 $target"
}

function Add-Utf8Bom([string]$Path) {
    <# 无 BOM 的 UTF-8 文件补上 BOM；返回是否做了修改。
       Inno Setup 6.7.2 起才接受无 BOM 的 .iss/.isl，补 BOM 能兼容 6.7.0/6.7.1。
       注意这是在改用户/项目自己的文件：只在老编译器上调用（见第 5 步）。#>
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    if ($hasBom) { return $false }

    $withBom = New-Object byte[] ($bytes.Length + 3)
    $withBom[0] = 0xEF; $withBom[1] = 0xBB; $withBom[2] = 0xBF
    [Array]::Copy($bytes, 0, $withBom, 3, $bytes.Length)
    [System.IO.File]::WriteAllBytes($Path, $withBom)
    return $true
}

# ---- 1. 校验目标脚本 ----
$scriptPath = (Resolve-Path -LiteralPath $Script).Path
if ([System.IO.Path]::GetExtension($scriptPath) -ne '.iss') {
    throw "目标不是 .iss 文件：$scriptPath"
}
$scriptDir = Split-Path -Parent $scriptPath
$scriptText = [System.IO.File]::ReadAllText($scriptPath)

# ---- 2. 定位编译器，必要时自动安装 ----
Write-Step '定位 ISCC.exe'
$iscc = Get-IsccPath
if (-not $iscc) {
    if ($NoAutoInstall) {
        throw "未找到 ISCC.exe，且指定了 -NoAutoInstall。请手动安装 Inno Setup（$InnoDownloadPage）后重试。"
    }
    Write-Step '本机没有 Inno Setup，尝试自动安装'
    Install-InnoSetup
    $iscc = Get-IsccPath
    if (-not $iscc) {
        throw "winget 安装后仍未找到 ISCC.exe（安装可能被取消或需要另行提权）。请手动安装：$InnoDownloadPage"
    }
}
Write-Host "    $iscc"

# ---- 3. 校验版本 ----
$version = Get-InnoVersion $iscc
if ($version) {
    Write-Host "    Inno Setup $version"
    if ($version -lt $MinInnoVersion) {
        throw "Inno Setup $version 过旧：CodeDependencies.iss 要求 >= $MinInnoVersion。请升级：$InnoDownloadPage"
    }
} else {
    Write-Warning "无法确定 ISCC 版本，跳过版本校验（要求 >= $MinInnoVersion）"
}

# ---- 4. 把 .iss 引用到的随包资源拷到同级目录 ----
# 中文语言文件不在 Inno Setup 的安装包里（6.7.3 的 Languages 目录只有 29 种官方语言，
# 简体中文的 .isl 属于 Unofficial），所以必须随包提供，放在 .iss 同级目录即可被
# MessagesFile 的相对路径找到
$needsDependencies = $scriptText -match 'CodeDependencies\.iss'
$needsChinese = $scriptText -match 'ChineseSimplified\.isl'
if ($needsDependencies -or $needsChinese -or $ForceStage) {
    Write-Step '准备随包资源'
    if ($needsDependencies -or $ForceStage) { Copy-AssetIfNeeded 'CodeDependencies.iss' $scriptDir }
    if ($needsChinese -or $ForceStage) { Copy-AssetIfNeeded 'ChineseSimplified.isl' $scriptDir }
}

# ---- 5. 补 UTF-8 BOM（只在老编译器上需要）----
# 补 BOM 是「改文件」而不是「改参数」：对入库的 .iss 会造成一次莫名的脏工作区（下次 git status
# 里冒出来的那种）。6.7.2 起编译器已接受无 BOM 的 UTF-8，所以只在更老的版本上补。
# 版本读不到时保守补上 —— 宁可改文件，也不能让编译因为编码挂掉。
$needsBom = (-not $version) -or ($version -lt [version]'6.7.2')
if ($needsBom) {
    $bomFixed = @()
    if (Add-Utf8Bom $scriptPath) { $bomFixed += (Split-Path -Leaf $scriptPath) }
    foreach ($assetName in @('ChineseSimplified.isl')) {
        $staged = Join-Path $scriptDir $assetName
        if ((Test-Path -LiteralPath $staged) -and (Add-Utf8Bom $staged)) { $bomFixed += $assetName }
    }
    if ($bomFixed.Count -gt 0) {
        Write-Step "补 UTF-8 BOM：$($bomFixed -join '、')"
    }
} else {
    Write-Host "    Inno Setup $version 接受无 BOM 的 UTF-8，跳过补 BOM（不改动源文件）"
}

# ---- 6. 编译 ----
Write-Step "编译 $([System.IO.Path]::GetFileName($scriptPath))"
$output = & $iscc $scriptPath 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = $LASTEXITCODE
$output | ForEach-Object { Write-Host "    $_" }

if ($exitCode -ne 0) {
    throw "编译失败（ISCC 退出码 $exitCode）。上面是编译器的原始输出。"
}

# ISCC 成功时的输出形如：
#   Successful compile (1.23 sec). Resulting Setup program filename is:
#   C:\proj\setup\Output\MyApp-1.2.3-setup.exe
$text = $output -join "`n"
$match = [regex]::Match($text, 'Resulting Setup program filename is:\s*(.+)')
if ($match.Success) {
    $artifact = $match.Groups[1].Value.Trim()
    if (Test-Path -LiteralPath $artifact) {
        $sizeMb = [math]::Round((Get-Item -LiteralPath $artifact).Length / 1MB, 2)
        Write-Host ''
        Write-Host "产物：$artifact" -ForegroundColor Green
        Write-Host "体积：$sizeMb MB" -ForegroundColor Green
    } else {
        Write-Warning "编译器报告产物在 $artifact，但该文件不存在"
    }
} else {
    Write-Warning '编译成功，但未能从输出中解析出产物路径，请按 .iss 里的 OutputDir / OutputBaseFilename 自行查找'
}