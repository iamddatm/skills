# 多 Agent 落盘与同步

生成物要同时供 Claude Code / Codex / Qoder / pi 使用，但各家发现技能的目录不同。
**路径表与证据强度以 `assets/multi-agent-paths.md` 为准** —— 那份文档区分了「本机实测存在」
「上游约定」与「未找到证据」三档，改脚本前先读它，不要把推测当事实。

## 同步命令

```bash
node scripts/engine/release-sync.mjs --list                    # 看清每个 Agent 落在哪
node scripts/engine/release-sync.mjs --repo <项目根>            # 写项目内副本（默认）
node scripts/engine/release-sync.mjs --repo <项目根> --check    # 提交前查漏，漂移则退出码 1
node scripts/engine/release-sync.mjs --repo <项目根> --user     # 写用户级目录
node scripts/engine/release-sync.mjs --repo <项目根> --targets agents,codex
```

## 三条纪律

1. **真源只有一份**：`<repo>/.claude/skills/<name>/`。其余目录由脚本**复制**出来，
   不是符号链接 —— 链接怕仓库搬家（路径一变全体断链），复制则各目录自包含、随 git 走。
2. **默认只写项目内**。用户级目录写出去既不入库、换台机器还得再来一遍。
   **唯一例外**：Codex CLI 与 pi **只在用户级目录发现技能** ——
   要让它们用上生成出来的发版技能，必须显式加 `--user`。
3. **先删后拷**。不删的话，真源里删掉的文件会留在目标目录里越积越脏。

## 提交前查漏

多 Agent 副本会漂移（改了真源忘了同步）。把这条挂到提交前检查：

```bash
node scripts/engine/release-sync.mjs --repo <项目根> --check || echo '技能副本未同步，先刷新'
```

`--check` 只比对不写入，漂移时退出码 1，适合放进 pre-commit 或 CI。

## 改了技能之后

生成物的 `SKILL.md` 就是项目发版技能的**真源**。改它之后必须：

1. 提交真源；
2. 跑一次 `release-sync.mjs` 把副本刷出去；
3. 副本随真源一起进 git（它们是被跟踪的文件，不是产物）。

## 与用户已有做法的关系

用户飞马项目的 `scripts/Sync-Skills.ps1` 是这套做法的 PowerShell 版
（只同步 `.agents/` 与 `.codex/`，明确「只同步仓库内，不写用户目录」，带 `-Check`）。
本脚本是它的泛化：补齐 pi 与 Cursor，增加 `--user` 与 `--list`。

> 引擎脚本本身用 Node 写（跨平台、零依赖），但它同步的是**任意文本技能目录**，
> 与项目用什么语言无关。