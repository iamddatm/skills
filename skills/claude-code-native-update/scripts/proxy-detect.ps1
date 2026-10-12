# 三级代理检测：环境变量 -> Windows 系统代理 -> 常见本地端口，逐个做连通性验证。
# 输出 PROXY_OK=<url> 或 NO_PROXY_FOUND，供调用方直接取用。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$probe = 'https://downloads.claude.ai/claude-code-releases/latest'

$candidates = @()
foreach ($k in @('HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy')) {
    $v = [Environment]::GetEnvironmentVariable($k)
    if ($v) { $candidates += $v; Write-Output "ENV[$k]=$v"; break }
}

$inet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
if ($inet.ProxyEnable -eq 1 -and $inet.ProxyServer) {
    $sys = $inet.ProxyServer
    # ProxyServer 可能是 "host:port"，也可能是 "http=host:port;https=host:port;..."
    if ($sys -match '=') { $sys = ($sys -split ';' | Where-Object { $_ -match '^https?=' } | Select-Object -First 1) -replace '^\w+=', '' }
    if ($sys -notmatch '^https?://') { $sys = "http://$sys" }
    $candidates += $sys
    Write-Output "SYS=$sys"
}

foreach ($port in @(7890, 10809, 1080)) {
    if ((Test-NetConnection 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded) {
        $candidates += "http://127.0.0.1:$port"
        Write-Output "PORT_${port}=open"
    }
}

$candidates = $candidates | Select-Object -Unique
Write-Output "CANDIDATES=$($candidates -join ' | ')"

$proxy = $null
foreach ($c in $candidates) {
    try {
        $null = Invoke-RestMethod $probe -Proxy $c -TimeoutSec 15
        $proxy = $c
        break
    } catch {
        Write-Output "FAIL=$c -> $($_.Exception.Message)"
    }
}

if ($proxy) { Write-Output "PROXY_OK=$proxy" } else { Write-Output 'NO_PROXY_FOUND' }