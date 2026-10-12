# 为「版本区间归纳」算切段范围：按 '^## <版本>' 定位行号，把 (Old, New] 区间切成 K 段，每段给出可直接喂给 Read 的 offset/limit。
# 区间不含 Old 自身那一节——那是用户已经装上的内容，写进「你更新到了什么」是噪声。
# 末段终点取区间外下一个版本的标题行前一行；若取到文件末尾，会把更早的版本一起读进来。
# 用法: pwsh -NoProfile -File changelog-index.ps1 -File $env:TEMP\cl-changelog-2.1.296.md -Old 2.1.280 -New 2.1.296 -K 4
param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$Old,
    [Parameter(Mandatory = $true)][string]$New,
    [int]$K = 4
)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'

function ToVer([string]$v) { try { [version]$v } catch { $null } }

$lines = Get-Content $File
$heads = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^##\s+(\S+)') { $heads += [pscustomobject]@{ Line = $i + 1; Version = $matches[1] } }
}

$idxNew = $null
for ($i = 0; $i -lt $heads.Count; $i++) {
    if ($heads[$i].Version -eq $New) { $idxNew = $i; break }
}
if ($null -eq $idxNew) { Write-Output "ERROR=CHANGELOG 中找不到新版本 $New"; exit 1 }

$oldV = ToVer $Old
if (-not $oldV) { Write-Output "ERROR=旧版本号无法解析: $Old"; exit 1 }

# 版本号在文件里按降序排列，从新版本往下取，遇到 <= Old 就停
$sel = @()
for ($i = $idxNew; $i -lt $heads.Count; $i++) {
    $v = ToVer $heads[$i].Version
    if (-not $v -or $v -le $oldV) { break }
    $sel += $heads[$i]
}
if ($sel.Count -eq 0) { Write-Output "ERROR=区间 (${Old}, ${New}] 内没有条目，检查是否传反了版本号"; exit 1 }

$stopIdx = $idxNew + $sel.Count
$lastEnd = if ($stopIdx -lt $heads.Count) { $heads[$stopIdx].Line - 1 } else { $lines.Count }

$n = $sel.Count
$k = [Math]::Min($K, $n)
$chunk = [Math]::Ceiling($n / $k)

for ($c = 0; $c -lt $k; $c++) {
    $s = $c * $chunk
    if ($s -ge $n) { break }
    $e = [Math]::Min($s + $chunk, $n) - 1
    $startLine = $sel[$s].Line
    $endLine = if ($e + 1 -lt $n) { $sel[$e + 1].Line - 1 } else { $lastEnd }
    Write-Output "SEGMENT=$($c + 1) VERSIONS=$($sel[$s].Version)..$($sel[$e].Version) OFFSET=$startLine LIMIT=$($endLine - $startLine + 1) COUNT=$($e - $s + 1)"
}

Write-Output "TOTAL_VERSIONS=$n K=$k"
if ($n -le 10) { Write-Output 'HINT=版本数 <=10，主 agent 直读即可，不必开子 agent' }