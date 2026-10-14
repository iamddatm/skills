# 各 Agent 的技能落盘路径

`scripts/engine/release-sync.mjs` 的目标目录表就是照这份文档写的。改脚本前先看这里。

**证据强度分三档，不要混为一谈**：

- **实存** —— 本机用户目录（`~`）下该目录真实存在且能确认用途；
- **约定** —— 没有直接证据，但上游工具/社区文档把它当项目级约定，且用户项目里在用；
- **未找到** —— 查过但没有证据。**不要把它写成事实**，也不要在脚本里给未经确认的路径写数据。

| Agent | 项目级 | 用户级 | 证据 |
|---|---|---|---|
| **Claude Code** | `<repo>/.claude/skills/<name>/` | `~/.claude/skills/<name>/` | 实存（含符号链接与 `ask-ui/`、`browser-skill/`）；仓库 README 路径表 |
| **Codex** | `<repo>/.codex/skills/<name>/` | `~/.codex/skills/<name>/` | 用户级实存（含 `.system/`）；**Codex CLI 只在用户级发现技能**，项目级那份是备用目录 |
| **Qoder**（QoderWork） | `<repo>/.agents/skills/<name>/` | `~/.qoderwork/skills/<name>/` | 用户级实存（10 个技能目录）；`.agents` 是 Qoder 等采用的跨工具约定（也是 `npx skills -g` 的全局目标） |
| **pi** | 未找到 | `~/.pi/agent/skills/<name>/` | 用户级实存。**配置根是 `~/.pi`，不是 `~/.config/pi`**（后者不存在） |
| Cursor | `<repo>/.cursor/skills/<name>/` | `~/.cursor/skills/<name>/` | 实存；`~/.cursor/skills-cursor/` 是 Cursor 内置技能目录，**禁止写入** |
| GitHub Copilot | `<repo>/.github/skills/<name>/` | 未找到（`~/.copilot/` 下没有 `skills/`） | 仓库 README 路径表 |
| 其它 Qoder 目录 | — | `~/.qoder/skills/`、`~/.qoder-cn/skills/` 存在但**为空** | 只有目录名有证据，文件格式无法确认，故未列入默认目标 |

## 设计取舍

**真源只有一份**：`<repo>/.claude/skills/<name>/`，其余目录由脚本复制。

**为什么复制而不是符号链接**：链接怕仓库搬家（路径一变全体断链），复制则各目录自包含、随 git 走。代价是改完技能要重跑同步脚本 —— 所以脚本提供 `--check`，把「忘了同步」暴露成退出码 1，可以挂在提交前检查里。

**为什么默认不写用户目录**：机器级目录各家工具版本各管各的，写出去既不入库、换台机器还得再来一遍。但 **Codex CLI 与 pi 只在用户级目录发现技能**——要让它们用上生成出来的发版技能，必须显式加 `--user`。这是唯一需要写用户目录的场景，脚本里用 `--user` 明示而不是默认打开。

**先删后拷**：不删的话，真源里删掉的文件会留在目标目录里越积越脏。

## 与 feima 项目的关系

用户飞马项目的 `scripts/Sync-Skills.ps1` 是这套做法的 PowerShell 版（只同步 `.agents/` 与 `.codex/`，且明确「只同步仓库内，不写用户目录」）。本脚本是它的泛化：补齐了 pi 与 Cursor，增加了 `--user`，并加了 `--list` 让人一眼看清每个 Agent 到底落在哪。