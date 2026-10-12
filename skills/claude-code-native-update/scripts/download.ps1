# 一条龙下载并校验原生二进制：解析版本 -> 取 manifest -> 下载 -> SHA256/size 双校验。
# 末行 VERIFY_OK=True 才可部署。输出为 KEY=VALUE，便于调用方直接读取。
# 用法: pwsh -NoProfile -File download.ps1 -Proxy http://127.0.0.1:7890 [-Version 2.1.296]
param(
    [Parameter(Mandatory = $true)][string]$Proxy,
    [string]$Version,
    [string]$OutDir = $env:TEMP
)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$platform = 'win32-x64'
$base = 'https://downloads.claude.ai/claude-code-releases'

if (-not $Version) {
    $Version = (Invoke-RestMethod "$base/latest" -Proxy $Proxy -TimeoutSec 30).ToString().Trim()
}
$man = Invoke-RestMethod "$base/$Version/manifest.json" -Proxy $Proxy -TimeoutSec 30
$sum = $man.platforms.$platform.checksum.ToString().ToLower()
$size = $man.platforms.$platform.size
$dl = Join-Path $OutDir "claude-$Version.exe"

Write-Output "VERSION=$Version"
Write-Output "EXPECT_SHA256=$sum"
Write-Output "EXPECT_SIZE=$size"
Write-Output "FILE=$dl"

$sw = [System.Diagnostics.Stopwatch]::StartNew()
# TimeoutSec 0 = 不设超时，大文件走代理时不要被默认时限掐断
Invoke-WebRequest "$base/$Version/$platform/claude.exe" -Proxy $Proxy -OutFile $dl -TimeoutSec 0
$sw.Stop()

$actualSum = (Get-FileHash $dl -Algorithm SHA256).Hash.ToLower()
$actualSize = (Get-Item $dl).Length
$shaOk = ($actualSum -eq $sum)
$sizeOk = ($actualSize -eq $size)
$ok = $shaOk -and $sizeOk

Write-Output ("DOWNLOAD_SECONDS=" + [math]::Round($sw.Elapsed.TotalSeconds, 1))
Write-Output "ACTUAL_SHA256=$actualSum"
Write-Output "ACTUAL_SIZE=$actualSize"
Write-Output "VERIFY_SHA256=$shaOk"
Write-Output "VERIFY_SIZE=$sizeOk"
Write-Output "VERIFY_OK=$ok"

if (-not $ok) {
    Write-Output "提示：校验未通过（断点残缺文件装上去会直接崩溃），删除后重下：Remove-Item '$dl'"
    exit 1
}