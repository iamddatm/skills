# AI 编程技能合集（中文版）

**中文** | [English](README.en.md)

[![Awesome](https://awesome.re/badge.svg)](https://github.com/github/awesome-copilot)

面向中文开发者的 AI 编程技能合集——包含上游热门技能的改编，以及原创技能——适用于 Claude Code、GitHub Copilot、Cursor 等各类 AI 编程助手。

---

## 可用技能

| 技能 | 说明 | 类型 | 来源 |
|---|---|---|---|
| [agent-skill-stats](skills/agent-skill-stats) | 统计本机多个 AI Agent（Claude Code / Codex / pi）会话日志中的 Skill 与 MCP 调用，生成单文件离线看板 | 原创 | — |
| [ask-ui](skills/ask-ui) | 将 Agent 工作流中的多个独立问题渲染为本地交互式表单，支持预选推荐、草稿自动保存、每题补充说明 | 改编 | [ask-ui](https://github.com/Angus221/ak.skills_sample/tree/main/skills/ask-ui) |
| [claude-code-native-update](skills/claude-code-native-update) | Windows 受限网络环境下安装、更新或迁移 Claude Code 原生版：本地代理手动下载 + SHA256 校验 + 离线部署 | 原创 | — |
| [dotnet-best-practices](skills/dotnet-best-practices) | .NET/C# 代码最佳实践规范检查 | 改编 | [dotnet-best-practices](https://github.com/github/awesome-copilot/tree/main/skills/dotnet-best-practices) |
| [dotnet-production-debug](skills/dotnet-production-debug) | .NET 生产环境性能故障排查：CPU 飙高、内存泄漏/OOM、死锁/卡死、崩溃、GC 异常与 dump 分析 | 原创 | — |
| [grill-with-docs-ui](skills/grill-with-docs-ui) | 表单模式拷问：grilling 前沿轮次提问经 ask-ui 本地交互式表单进行，沿途产出 ADR 与术语表；依赖 grilling、domain-modeling、ask-ui | 改编 | [grill-with-docs](https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs) |
| [wpf-stylet](skills/wpf-stylet) | WPF + Stylet MVVM 框架开发指南：生命周期、Conductor 导航、弹窗、命令绑定与依赖注入 | 原创 | — |

## 什么是技能？

技能是独立的指令文件（`SKILL.md`），为 AI 编程助手提供特定能力——编码规范、框架模式、审查清单等。不同 AI 工具加载技能的方式各有不同：

| 工具 | 路径 |
|---|---|
| GitHub Copilot | `.github/skills/<name>/SKILL.md` |
| Claude Code | `.claude/skills/<name>/SKILL.md` |
| Cursor | `.cursor/rules/<name>.mdc` |

## 使用方法

### 方式一：npx skills（推荐）

使用 [skills](https://github.com/vercel-labs/skills) CLI 一键安装，自动识别 agent 类型并放入对应目录：

```bash
# 安装本仓库全部技能
npx skills add iamddatm/skills

# 安装指定技能
npx skills add iamddatm/skills --skill dotnet-best-practices

# 指定目标 agent
npx skills add iamddatm/skills --skill dotnet-best-practices -a claude-code

# 全局安装（所有项目可用）
npx skills add iamddatm/skills -g

# 查看仓库中有哪些技能
npx skills add iamddatm/skills --list
```

> 支持的 agent 包括 Claude Code、Cursor、Codex、OpenCode 等。

### 方式二：手动复制

将技能文件夹复制到对应 AI 工具的目录下：

```bash
# GitHub Copilot
cp -r skills/dotnet-best-practices .github/skills/

# Claude Code
cp -r skills/dotnet-best-practices .claude/skills/
```

Cursor 用户需将 `SKILL.md` 重命名为 `.mdc` 后放入 `.cursor/rules/` 目录。

## 贡献

欢迎贡献！两种方式：

### 改编上游技能

1. 复刻本仓库
2. 在 `skills/` 下使用上游技能原名创建文件夹
3. 改编 `SKILL.md`，保留原始结构和代码示例
4. 在 PR 中链接回原始技能

### 创作原创技能

1. 在 `skills/` 下用描述性名称创建技能文件夹
2. 编写 `SKILL.md`，包含正确的 frontmatter
3. 提交 Pull Request

### 编写准则

- 代码标识符、变量名、技术术语保留英文
- 描述性文本和注释使用中文
- 包含 `name` 和 `description` frontmatter 字段

## 致谢

- 上游技能作者和社区
- 所有参与改编和本地化的贡献者

## 许可证

每项技能保留其原始来源的许可证，改编版本遵循相同条款。
