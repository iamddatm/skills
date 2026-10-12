# 拉官方 CHANGELOG 到 %TEMP%\cl-changelog-<版本>.md：先直连，失败再走代理。
# 同日已有缓存则直接复用（重跑免下载）；未指定 -Proxy 且直连失败时，自动调用同目录 proxy-detect.ps1 取代理。
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Proxy,
    [string]$OutDir = $env:TEMP,
    [switch]$Force
)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$url = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'
$out = Join-Path $OutDir "cl-changelog-$Version.md"

function Report([string]$route) {
    Write-Output "ROUTE=$route"
    Write-Output "CHANGELOG_FILE=$out"
    Write-Output "CHANGELOG_LINES=$((Get-Content $out).Count)"
    Write-Output 'CHANGELOG_OK=True'
}

if ((Test-Path $out) -and -not $Force) {
    $age = (Get-Date) - (Get-Item $out).LastWriteTime
    if ($age.TotalHours -lt 24) {
        Write-Output 'CACHE_HIT=True'
        Report 'cache'
        exit 0
    }
}

$ok = $false
try {
    Invoke-WebRequest $url -OutFile $out -TimeoutSec 60
    $ok = $true
} catch {
    Write-Output "DIRECT_FAIL=$($_.Exception.Message)"
}

if (-not $ok -and -not $Proxy) {
    $pd = Join-Path $PSScriptRoot 'proxy-detect.ps1'
    if (Test-Path $pd) {
        $hit = & $pd | Where-Object { $_ -like 'PROXY_OK=*' } | Select-Object -First 1
        if ($hit) { $Proxy = $hit.Substring('PROXY_OK='.Length) }
    }
}

if (-not $ok -and $Proxy) {
    try {
        Invoke-WebRequest $url -OutFile $out -Proxy $Proxy -TimeoutSec 120
        $ok = $true
    } catch {
        Write-Output "PROXY_FAIL=$($_.Exception.Message)"
    }
}

if (-not $ok) { Write-Output 'CHANGELOG_OK=False'; exit 1 }

Write-Output 'CACHE_HIT=False'
Report $(if ($Proxy) { 'proxy' } else { 'direct' })