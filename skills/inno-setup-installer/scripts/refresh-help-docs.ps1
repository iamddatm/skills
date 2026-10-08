#Requires -Version 5.1
<#
.SYNOPSIS
    重建 Inno Setup 帮助的「签名索引」(references/inno-help/api-index.txt)。
.DESCRIPTION
    写 .iss 或 [Code] 段时要查函数签名,而官网帮助是 frameset 结构——curl index.php?topic=x 只会拿到
    框架页,正文在 topic_x.htm,每次都得重新摸一遍;目标环境也不一定随时能上网。

    做法:抓「支撑函数 / 类与方法 / 事件」这三页的正文,抽出签名行,只往仓库里留一份**索引**
    (约一千行,可 grep)。**不留官方页面原文**——那是第三方内容,仓库里没必要背;语义与示例看技能
    自己写的 references/scripting-api.md 与 references/inno-script-cookbook.md,冷门细节按索引末尾
    列的主题名去官网查。

    抓下来的页面只落在 %TEMP%,跑完即清,不进仓库。
.EXAMPLE
    pwsh -File ./scripts/refresh-help-docs.ps1
#>
[CmdletBinding()]
param()

# 输出可能含中文(抓取进度、统计),不设这个 Git Bash 侧会按 GBK 解码成乱码
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 6) {
    throw '请使用 PowerShell 7 运行本脚本：pwsh -File'
}

$helpRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'references/inno-help'
$indexPath = Join-Path $helpRoot 'api-index.txt'
$workDir = Join-Path $env:TEMP 'inno-help-fetch'      # 抓取用的临时目录:跑完就删,仓库里只留索引
$baseUrl = 'https://jrsoftware.org/ishelp'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# 进索引的三页:主题名 → 标题 + 从正文里挑「像签名」的行的正则
$signaturePages = [ordered]@{
    scriptfunctions = @{
        Title   = '支撑函数总表'
        Pattern = '^[ \t]*(function|procedure)[ \t]'
    }
    scriptclasses   = @{
        Title   = '脚本类与方法'
        Pattern = '^[ \t]*([A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*(class|record)|(function|procedure|property|constructor|destructor)[ \t])'
    }
    scriptevents    = @{
        Title   = '事件处理函数'
        Pattern = '^[ \t]*(function|procedure)[ \t]'
    }
}

# 不抓、只在索引末尾当路标列出来的主题(要查就去官网 topic_<名字>.htm)
$otherTopics = [ordered]@{
    filessection          = '[Files] 段的参数与 flag'
    setupsection          = '[Setup] 段的全部指令'
    scriptconstants       = '预定义常量'
    scriptpages           = '自定义向导页'
    scriptinstall         = '安装期可用的脚本辅助函数'
    componentstasksparams = '公共参数(Check / Tasks / BeforeInstall / …)'
    isppoverview          = '预处理器(ISPP)概览'
    isppcc                = '预处理器指令(#define / #include / #if …)'
}

function Convert-HtmlToText([string]$Html) {
    <# 去标签、解实体、压掉连续空行:只为把签名行抽出来,不求排版保真 #>
    $text = $Html -replace '(?s)<(script|style)\b.*?</\1>', ''
    $text = $text -replace '(?s)<[^>]+>', ''
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = $text -replace [char]0x00A0, ' '            # &nbsp; 解出来的是不换行空格
    $lines = @($text -split "`r?`n" | ForEach-Object { $_.TrimEnd() })
    return ($lines -join "`n")
}

New-Item -ItemType Directory -Path $helpRoot -Force | Out-Null
if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

try {
    # ---- 1. 抓三页并抽签名 ----
    $sections = [ordered]@{}
    foreach ($topic in $signaturePages.Keys) {
        $url = "$baseUrl/topic_$topic.htm"
        $htmlPath = Join-Path $workDir "topic_$topic.htm"
        try {
            Invoke-WebRequest -Uri $url -OutFile $htmlPath -TimeoutSec 60
        } catch {
            throw "抓取失败：$url —— $($_.Exception.Message)"
        }
        $html = [System.IO.File]::ReadAllText($htmlPath)
        if ($html.Length -lt 500) { throw "抓回来的页面太小($($html.Length) 字节),可能不是正文：$url" }

        $lines = @((Convert-HtmlToText $html) -split "`n" |
            Where-Object { $_ -match $signaturePages[$topic].Pattern } |
            ForEach-Object { $_.TrimEnd() })
        # 抽不出东西却写下去,等于悄悄毁掉索引(以后还会照着它写代码),宁可报错
        if ($lines.Count -lt 5) { throw "从 $topic 里只抽出 $($lines.Count) 行签名,官网页面结构可能变了：$url" }
        $sections[$topic] = $lines
        Write-Host ("  {0,-16} {1,5} 行签名  {2}" -f $topic, $lines.Count, $signaturePages[$topic].Title)
    }

    # ---- 2. 写索引 ----
    $indexLines = @(
        '# Inno Setup 官方帮助 · 签名索引',
        "# 来源 $baseUrl/ · 抓取 $(Get-Date -Format 'yyyy-MM-dd') · 由 scripts/refresh-help-docs.ps1 生成",
        '# 只列签名行(函数 / 类与方法 / 事件)。参数个数与类型不确定时 grep 这里,别凭记忆写。',
        '# 语义、参数说明与示例:先看 references/scripting-api.md 与 references/inno-script-cookbook.md,',
        '# 没有再按文末列的主题名去官网查(topic_<名字>.htm)。',
        ''
    )
    foreach ($topic in $sections.Keys) {
        $indexLines += "## $topic —— $($signaturePages[$topic].Title)"
        $indexLines += $sections[$topic]
        $indexLines += ''
    }
    $indexLines += '# 不在索引里、要查就去官网的主题:'
    foreach ($topic in $otherTopics.Keys) { $indexLines += "#   $topic —— $($otherTopics[$topic])" }

    [System.IO.File]::WriteAllText($indexPath, ($indexLines -join "`n") + "`n", $utf8NoBom)
    Write-Host ''
    Write-Host ("签名索引已更新：$indexPath（$($indexLines.Count) 行）") -ForegroundColor Green
} finally {
    # 抓下来的页面既不进仓库,也不留在临时目录
    if (Test-Path -LiteralPath $workDir) {
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}