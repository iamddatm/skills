# openai-image-gen: text-to-image (gen) / image-to-image (edit) via any
# OpenAI-compatible /v1/images gateway (new-api / sub2api / OpenAI direct).
# Windows PowerShell 5.1 / PowerShell 7, no dependency.
# Config priority: params > env vars > <skill-dir>/.env
# Usage:
#   pwsh -NoProfile -File OpenAI-Image-Gen.ps1 gen  -Prompt "..." [-Model m] [-Size 1024x1024] [-Quality high] [-N 1] [-Out f.png | -OutDir DIR]
#   pwsh -NoProfile -File OpenAI-Image-Gen.ps1 edit -Prompt "..." -Image a.png,b.png [-Mask m.png] [same model/size/out flags]
param(
  [Parameter(Position = 0)][string]$Command,
  [string]$Prompt,
  [string[]]$Image = @(),
  [string]$Mask,
  [string]$Model,
  [string]$Size,
  [string]$Quality,
  [int]$N = 0,
  [string]$Out,
  [string]$OutDir,
  [string]$BaseUrl,
  [string]$ApiKey
)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Fail([string]$msg) { [Console]::Error.WriteLine($msg); exit 1 }

# 配置优先级:命令行参数 > 进程环境变量 > 技能目录 .env
$envFile = Join-Path (Split-Path -Parent $PSCommandPath) '..\.env'
$envMap = @{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile -Encoding UTF8) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#') -or -not $t.Contains('=')) { continue }
    $i = $t.IndexOf('=')
    $envMap[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"')
  }
}
function Pick($cli, [string]$name, [string]$default = '') {
  if ($cli) { return $cli }
  $v = [Environment]::GetEnvironmentVariable($name)
  if ($v) { return $v }
  if ($envMap.ContainsKey($name)) { return $envMap[$name] }
  return $default
}

# -File 传参一律是字符串:"a.png,b.png" 不会自动成数组,这里统一按逗号拆开(重复 -Image 的绑定结果也走同一路径)
$Image = @($Image | ForEach-Object { $_ -split ',' } | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
if ($Command -notin @('gen', 'edit')) { Fail "unknown command: '$Command' (gen|edit)" }
if (-not $Prompt) { Fail 'missing -Prompt' }
$baseUrl = (Pick $BaseUrl 'IMGAPI_BASE_URL').TrimEnd('/')
$apiKey = Pick $ApiKey 'IMGAPI_API_KEY'
$model = Pick $Model 'IMGAPI_MODEL' 'gpt-image-2'
if (-not $baseUrl -or -not $apiKey) { Fail "IMGAPI_BASE_URL / IMGAPI_API_KEY missing: set -BaseUrl/-ApiKey or env vars, or write $envFile" }

$mimeMap = @{ '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.webp' = 'image/webp'; '.gif' = 'image/gif' }
function Get-ImageRef([string]$spec, [string]$label) {
  # local file -> data URL (OpenAI edits JSON accepts image_url only)
  if ($spec -match '^(https?|data):') { return @{ image_url = $spec } }
  if (-not (Test-Path $spec -PathType Leaf)) { Fail "$label file not found: $spec" }
  $abs = (Resolve-Path $spec).Path
  $ext = [IO.Path]::GetExtension($abs).ToLower()
  if (-not $mimeMap.ContainsKey($ext)) { Fail "$label unsupported extension (png/jpg/jpeg/webp/gif): $abs" }
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($abs))
  return @{ image_url = "data:$($mimeMap[$ext]);base64,$b64" }
}

$endpoint = if ($Command -eq 'gen') { '/v1/images/generations' } else { '/v1/images/edits' }
$payload = [ordered]@{ model = $model; prompt = $Prompt }
if ($Size) { $payload.size = $Size }
if ($Quality) { $payload.quality = $Quality }
if ($N -gt 0) { $payload.n = $N }
if ($Command -eq 'edit') {
  if ($Image.Count -eq 0) { Fail 'edit requires at least one -Image (local path or http(s) URL)' }
  $payload.images = @($Image | ForEach-Object { Get-ImageRef $_ '-Image' })
  if ($Mask) { $payload.mask = Get-ImageRef $Mask '-Mask' }
}

# 中文提示词须以 UTF-8 字节发送:5.1 的 Invoke-RestMethod 对 string Body 编码不可靠,统一转字节
# 用 ConvertTo-Json -InputObject 而非管道:5.1 管道会把 OrderedDictionary 拆成键值对导致输出为空
$json = ConvertTo-Json -InputObject $payload -Depth 6 -Compress
$bodyBytes = [Text.Encoding]::UTF8.GetBytes($json)
try {
  # 超时交由 agent 侧终端控制:高质量大图可能数分钟
  $resp = Invoke-RestMethod -Method Post -Uri "$baseUrl$endpoint" `
    -Headers @{ Authorization = "Bearer $apiKey" } `
    -ContentType 'application/json; charset=utf-8' `
    -Body $bodyBytes -TimeoutSec 3600
} catch {
  $detail = $_.ErrorDetails.Message
  if (-not $detail -and $_.Exception.Response) {
    try { $sr = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream()); $detail = $sr.ReadToEnd() } catch { }
  }
  Fail "HTTP request failed: $($_.Exception.Message)`n$detail"
}

$data = @($resp.data)
if ($data.Count -eq 0 -or -not $data[0]) { Fail 'response data[] is empty' }
if ($Out -and $data.Count -gt 1) { Fail '-Out fits a single image only; use -OutDir for multiple' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$prefix = if ($Command -eq 'gen') { 't2i' } else { 'i2i' }
if ($Out) { $outFullPath = [IO.Path]::GetFullPath($Out); $outDirFull = Split-Path -Parent $outFullPath }
else { $outDirFull = if ($OutDir) { $OutDir } else { (Get-Location).Path } }
New-Item -ItemType Directory -Force -Path $outDirFull | Out-Null

$i = 0
foreach ($item in $data) {
  $i++
  $ext = 'png'
  if ($item.url -and $item.url -match '\.(png|jpe?g|webp|gif)(\?|$)') { $ext = $Matches[1].ToLower() -replace 'jpeg', 'jpg' }
  $suffix = if ($data.Count -gt 1) { "-$i" } else { '' }
  $file = if ($Out) { $outFullPath } else { Join-Path $outDirFull "$prefix-$stamp$suffix.$ext" }
  if ($item.b64_json) {
    $bytes = [Convert]::FromBase64String($item.b64_json)
    [IO.File]::WriteAllBytes($file, $bytes)
  } elseif ($item.url) {
    try { Invoke-WebRequest -Uri $item.url -OutFile $file -TimeoutSec 300 -UseBasicParsing }
    catch { Fail "failed to download result image: $($_.Exception.Message)" }
    $bytes = [IO.File]::ReadAllBytes($file)
  } else {
    Fail 'response contains neither b64_json nor url'
  }
  Write-Output "SAVED $file ($($bytes.Length) bytes, model=$model)"
}
