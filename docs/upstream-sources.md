# 上游技能来源与同步记录

本仓库改编类技能的「上游出处 + 抓取快照」集中登记于此。原创技能不上榜。

目的只有一个：上游更新后，能拿登记的 commit 与留存的原始副本做 diff，把改动同步过来，而不是靠记忆猜测。

## 登记表

| 本地技能 | 上游 | 快照 commit | 抓取时间 | 原始副本 |
|---|---|---|---|---|
| [i-have-adhd](../skills/i-have-adhd) | [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) → `skills/i-have-adhd/` | `1ecea19`（2026-10-11） | 2026-10-12 20:21 +08:00 | `docs/upstream-backups/i-have-adhd/` |
| [ask-ui](../skills/ask-ui) | [Angus221/ak.skills_sample](https://github.com/Angus221/ak.skills_sample/tree/main/skills/ask-ui) | 未留存 | 未留存 | — |
| [dotnet-best-practices](../skills/dotnet-best-practices) | [github/awesome-copilot](https://github.com/github/awesome-copilot/tree/main/skills/dotnet-best-practices) | 未留存 | 未留存 | — |
| [grill-with-docs-ui](../skills/grill-with-docs-ui) | [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs) | 未留存 | 未留存 | — |

「未留存」的三项是本次登记前改编的，没有基线快照，diff 只能靠人工比对上游历史。

## 同步流程

1. 查上游当前 commit：

   ```powershell
   # 直连失败（超时 / SSL 报错）时，先加代理前缀
   $env:HTTPS_PROXY = 'http://127.0.0.1:7890'
   Invoke-RestMethod -Uri 'https://api.github.com/repos/ayghri/i-have-adhd/commits/main' -Headers @{'User-Agent'='cc'} |
     Select-Object -ExpandProperty sha
   ```

2. 与登记表里的快照 commit 比对。相同即无需同步。
3. 下载新版上游文件到临时目录，与 `docs/upstream-backups/<技能>/` 下的原始副本做 diff，得到上游这一段的改动。
4. 把上游改动逐条应用到 `skills/<技能>/SKILL.md`，同时保住下面「本地改动」列出的内容——两侧都碰过的地方要手工合并。
5. 用新版覆盖原始副本，并更新登记表的 commit 与抓取时间。

## i-have-adhd

- **上游**：<https://github.com/ayghri/i-have-adhd>，技能目录 `skills/i-have-adhd/`
- **快照 commit**：`1ecea1993b7fce257ffbd686c070948b5e07eda6`（main，2026-10-11）
- **抓取时间**：2026-10-12 20:21 +08:00
- **原始副本**：`docs/upstream-backups/i-have-adhd/`（`SKILL.md` 与上游逐字节一致，SHA256 `88955C01…C7D3`）

### 本地改动

1. **删除「具体时间估计」的全部内容**，因为 AI 给出的评估时间经常不准，反而误导。具体删了三处：
   - frontmatter `description` 里的 `give specific time estimates`
   - 「What ADHD changes about reading」的事实 4（"Time estimates feel uniform…"），标题随之由 "Five facts" 改为 "Four facts"
   - 规则 6「Give specific time estimates」整节，其后规则依次上移一位（原 7–10 变为 6–9）
   - 「When to break the rules」第 6 条里 `point time estimates at whoever executes the steps` 一句

   除此之外与上游逐字相同，未翻译、未改写，便于后续 diff。

2. **未收录 `agents/`**（`gemini.toml`、`openai.yaml`）：那是 Gemini CLI / OpenAI 宿主的专用配置，本仓库面向 Claude Code / Copilot / Cursor，技能只保留 `SKILL.md`。这两个文件仍存在备份副本里，供同步时参考——**注意 `gemini.toml` 内嵌了同一套规则的精简版，其中同样含时间估计条款，上游若改动规则，这里也需要一并核对**。

### 同步要点

上游改动规则编号或增删规则时，本地的「规则 6 已删除」偏移会失效，需重新按语义对齐编号，而不是直接套用上游的序号。