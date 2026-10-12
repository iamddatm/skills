# 本地侦察：版本 / PATH 解析 / 原生二进制 / installMethod / settings 键位 / MCP 服务器分类。
# 只输出键名与结构，绝不输出任何凭证值（settings.json 的 env 值、tokens 等一律不打印）。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Continue'

$homeDir = $env:USERPROFILE

Write-Output '=== 版本 ==='
Write-Output "CLAUDE_VERSION=$((& claude --version 2>&1) -join ' ')"

Write-Output '=== PATH 解析（第一行应为 .local\bin\claude.exe） ==='
(& where.exe claude 2>&1) | ForEach-Object { Write-Output "  $_" }

Write-Output '=== 原生二进制 ==='
$exe = Join-Path $homeDir '.local\bin\claude.exe'
if (Test-Path $exe) { Write-Output "  size=$((Get-Item $exe).Length)  $exe" } else { Write-Output "  不存在: $exe" }

Write-Output '=== .claude.json（只读） ==='
$cj = Join-Path $homeDir '.claude.json'
if (Test-Path $cj) {
    $bytes = [System.IO.File]::ReadAllBytes($cj)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    Write-Output "  size=$($bytes.Length)  BOM=$hasBom"
    $raw = [System.IO.File]::ReadAllText($cj)
    Write-Output "  installMethod 出现次数 = $(([regex]::Matches($raw, '"installMethod"')).Count)"

    # 空对象直接取 .PSObject.Properties.Name 会得到 $null，包成数组后是 1 个空元素，必须先过滤
    function Get-Names($o) { @($o.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { $_ }) }

    function Show-Mcp($table, $label) {
        $names = Get-Names $table
        if ($names.Count -eq 0) { return }
        Write-Output "  --- mcpServers $label ---"
        foreach ($n in $names) {
            $s = $table.$n
            # command 存在 = stdio 传输；url 存在 = http/sse。2.1.292 起协议协商规则有变，stdio 服务器更新后需复验
            $kind = if ($s.command) { 'stdio' } elseif ($s.url) { 'http/sse' } else { '未知' }
            Write-Output "    $n  [$kind]"
        }
    }

    try {
        $j = $raw | ConvertFrom-Json
        if ($j.PSObject.Properties.Name -contains 'installMethod') {
            Write-Output "  installMethod=$($j.installMethod)"
        } else {
            Write-Output '  installMethod=<缺失，claude doctor 会报 issue>'
        }
        if ($j.mcpServers) { Show-Mcp $j.mcpServers '（顶层）' }
        foreach ($p in Get-Names $j.projects) {
            if ($j.projects.$p.mcpServers) { Show-Mcp $j.projects.$p.mcpServers "（项目 $p）" }
        }
    } catch {
        Write-Output "  JSON 解析失败（不影响后续步骤）: $($_.Exception.Message)"
    }
} else {
    Write-Output '  不存在'
}

Write-Output '=== settings.json（只输出键名） ==='
$st = Join-Path $homeDir '.claude\settings.json'
if (Test-Path $st) {
    try {
        $s = (Get-Content $st -Raw) | ConvertFrom-Json
        Write-Output "  顶层键: $((Get-Names $s) -join ', ')"
        if ($s.env) { Write-Output "  env 键名: $((Get-Names $s.env) -join ', ')" }
        $auto = if ($s.env) { $s.env.DISABLE_AUTOUPDATER } else { $null }
        Write-Output "  DISABLE_AUTOUPDATER = $(if ($auto) { $auto } else { '<未设置>' })"
        if ($s.hooks) { Write-Output "  hooks 事件: $((Get-Names $s.hooks) -join ', ')" }
        if ($s.permissions) { Write-Output "  permissions 键: $((Get-Names $s.permissions) -join ', ')" }
    } catch {
        Write-Output "  解析失败: $($_.Exception.Message)"
    }
} else {
    Write-Output '  不存在'
}

Write-Output '=== 全局指令文件 ==='
foreach ($p in @((Join-Path $homeDir '.claude\CLAUDE.md'), (Join-Path $homeDir '.claude\AGENTS.md'))) {
    $state = if (Test-Path $p) { "存在 ($((Get-Item $p).Length) B)" } else { '不存在' }
    Write-Output "  $state  $p"
}