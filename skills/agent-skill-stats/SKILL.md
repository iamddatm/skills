---
name: agent-skill-stats
description: '统计本机多个 AI Agent（Claude Code / Codex / pi）的 Skill 与 MCP 调用次数，生成/刷新单文件离线看板。用户提到「统计skill调用」「skill stats」「看看我用了哪些 skill」「技能使用频率」「刷新调用统计快照」等时使用本技能；只要想了解技能或 MCP 工具的实际使用情况，即使没明说「统计」二字也应使用。'
---

# agent-skill-stats

扫描本机三个 agent 的会话日志——Claude Code（`~/.claude/projects`）、Codex（`~/.codex/sessions`）、pi（`~/.pi/agent/sessions`）——按源统计 Skill 与 MCP 调用，并把结果渲染成数据内联的单文件 HTML 看板，双击即开、离线可用。本技能可在任何能执行 shell 命令的 runtime 中运行，唯一依赖 Node ≥ 20.12。

## 怎么跑

在本技能目录下执行：

```bash
node scripts/skill-stats.mjs
```

- 默认输出系统临时目录下的 `skill-stats.html`，可用 `--out <path>` 改（如 `--out D:/1vault/x/tools/skill-stats.html` 覆盖更新旧看板）。
- 三个源目录默认取各 agent 约定位置，可用 `--projects-dir` / `--codex-dir` / `--pi-dir` 单独改；某源目录不存在时跳过并提示，全部缺失才报错。
- 脚本在 stdout 打印各渠道数量、按源分解、合计、范围、输出路径——**直接把这些数字报告给用户**，不要自己再去解析日志。
- 汇报固定结构：① 照读 stdout 的各渠道数量、合计、按源分解、范围、输出路径；② 主动附上「报告时的口径说明」一节各条口径；③ 不对数字做任何自行估算或解读。
- 全程只读取日志、只写一个 HTML 文件，无其他副作用；无需安装依赖（Node ≥ 20.12）。

## 跑失败时

| 症状 | 一线修复 | 仍失败兜底 |
|---|---|---|
| `node: command not found`，或报 `parentPath` 未定义 | `node --version` 检查；< 20.12 时告知用户升级 Node | 不要自行改写脚本迁就旧版本，也不要改用手工解析日志 |
| 所有源目录缺失并报错退出 | 与用户确认本机各 agent 会话日志实际位置 | 用 `--projects-dir` / `--codex-dir` / `--pi-dir` 逐个指定后重跑 |
| 提示某个源缺失但未退出 | 正常现象：该 agent 本机未安装或无会话 | 如实说明，不当作错误处理 |
| 打印「未知参数」并退出 | 只支持 `--out` / `--projects-dir` / `--codex-dir` / `--pi-dir` 四个参数，检查拼写后重跑 | — |
| 跑通但合计为 0 条 | 检查目录参数是否指错 | 如实告知用户范围内无数据，不编造数字 |
| 其他报错 | 把报错原文展示给用户 | 绝不改用 grep 或手工解析日志兜底——那会违反口径红线 |

## 报告时的口径说明（主动说，别等用户质疑）

1. **跨源跨项目统计**：扫描三个 agent 的全部会话，结果里出现其他仓库专属的 skill / server 是正常的，汇报时主动提一句。
2. **自计数**：正在生成快照的会话本身也会被计入（通常 ≤2 条），页脚已注明。
3. **数据范围**：各会话日志只保留近期会话，不是全量历史；页头有起止日期。
4. **子代理**：Claude Code `subagents/` 下的子代理轨迹计入统计，与主会话同一去重规则。
5. **源间口径差异**：Codex 的 skill 调用以加载签名识别（read_mcp_resource 或读文件命令命中 `skills/<name>/SKILL.md`），同一次调用同时计为一条 MCP 调用（同一动作的两个切面）；pi 的手动触发以 harness 注入的 `<skill name>` 展开识别；shell_command / bash 等通用工具调用在任何源都不计入。

## 🔴 CHECKPOINT · 口径红线（改前必须与用户确认）

脚本头部注释记录了完整口径，以下是不可擅自更改的部分——它们是踩坑后与用户逐条确认的结论：

- **逐行 `JSON.parse`，绝不用 grep 计数**。日志正文里会出现技能名、命令字样（包括统计会话自己的输出），grep 会自我污染、漏计参数序列化差异。
- Claude Code 手动触发**只认以 `<command-message>` 开头的真实命令展开**，并剔除内置命令（clear / model / mcp / compact / handoff / init）。放宽这条会把正文里引用的 `/X`、`/xxx` 等占位文本误计进来。
- **通用工具调用不计入 skill 调用**——统计对象只有 skill 与 MCP；把 shell_command / bash 计进来会让数字失去意义。
- Codex skill 加载**只认读文件形态**（read_mcp_resource / exec_command / shell_command 命中 `skills/<name>/SKILL.md`），同一 turn 去重；不扩大到无关命令形态。
- MCP **只按 server 汇总**，**看板任何位置都不出现具体工具名**（用户明确选择）。
- 每条调用按源内唯一 id 去重——轨迹可能被镜像到多个文件；去重键命名空间分隔（`fc:` / `mcp:` / `st:`），防同一调用的两种日志形态互相误判重复。

用户要求改口径（比如剔除子代理、改输出位置、加维度、接入新 agent 源）时，先确认意图再改脚本，并同步更新页脚口径说明文字。

## 看板改版注意

- 单文件、零外部依赖、数据内联（`var DATA = [...]`），保持双击即开。
- 记录带来源字段；看板有来源筛选与明细来源列；Skill 分布图按名称聚合（跨源同名 skill 合并同一柱条，可用来源筛选切片）。
- 配色为三系列：`--s-model` 蓝 / `--s-slash` 橙 / `--s-mcp` 绿，各有深浅两套（CSS 变量 + `data-theme` + `prefers-color-scheme`）。改配色要两套模式一起改，并保证对各自背景的对比度 ≥ 3:1。
- 图表均为原生 DOM + CSS（无图表库）；明细表全部用 `textContent` 填充，数据经 `JSON.stringify` 注入时已转义 `<`，勿改回 `innerHTML` 直插数据。
