# Awesome AI Coding Skills (Chinese Edition) / AI 编程技能合集（中文版）

[![Awesome](https://awesome.re/badge.svg)](https://github.com/github/awesome-copilot)

A collection of AI coding skills for Chinese-speaking developers — including translated adaptations of popular upstream skills and original skills — compatible with Claude Code, GitHub Copilot, Cursor, and other AI-powered development tools.

面向中文开发者的 AI 编程技能合集——包含上游热门技能的中文翻译与改编，以及原创技能——适用于 Claude Code、GitHub Copilot、Cursor 等各类 AI 编程助手。

---

## Available Skills / 可用技能

| Skill / 技能 | Description / 说明 | Type / 类型 | Source / 来源 |
|---|---|---|---|
| [claude-code-native-update](skills/claude-code-native-update) | Windows 受限网络环境下安装、更新或迁移 Claude Code 原生版：本地代理手动下载 + SHA256 校验 + 离线部署 | 原创 | — |
| [dotnet-best-practices](skills/dotnet-best-practices) | .NET/C# 代码最佳实践规范检查 | 翻译 | [dotnet-best-practices](https://github.com/github/awesome-copilot/tree/main/skills/dotnet-best-practices) |
| [dotnet-production-debug](skills/dotnet-production-debug) | .NET 生产环境性能故障排查：CPU 飙高、内存泄漏/OOM、死锁/卡死、崩溃、GC 异常与 dump 分析 | 原创 | — |
| [wpf-stylet](skills/wpf-stylet) | WPF + Stylet MVVM 框架开发指南：生命周期、Conductor 导航、弹窗、命令绑定与依赖注入 | 原创 | — |

## What Are Skills? / 什么是技能？

Skills are self-contained instruction sets (`SKILL.md`) that give AI coding assistants specific capabilities — coding standards, framework patterns, review checklists, and more. Each AI tool has its own convention for loading skills:

技能是独立的指令文件（`SKILL.md`），为 AI 编程助手提供特定能力——编码规范、框架模式、审查清单等。不同 AI 工具加载技能的方式各有不同：

| Tool / 工具 | Path / 路径 |
|---|---|
| GitHub Copilot | `.github/skills/<name>/SKILL.md` |
| Claude Code | `.claude/skills/<name>/SKILL.md` |
| Cursor | `.cursor/rules/<name>.mdc` |

## Usage / 使用方法

### Option 1: npx skills（推荐 / Recommended）

使用 [skills](https://github.com/vercel-labs/skills) CLI 一键安装，自动识别 agent 类型并放入对应目录：

Install skills with one command — auto-detects your AI agent and places files in the right directory:

```bash
# 安装本仓库全部技能 / Install all skills from this repo
npx skills add iamddatm/skills

# 安装指定技能 / Install a specific skill
npx skills add iamddatm/skills --skill dotnet-best-practices

# 指定目标 agent / Target a specific agent
npx skills add iamddatm/skills --skill dotnet-best-practices -a claude-code

# 全局安装（所有项目可用）/ Install globally (available in all projects)
npx skills add iamddatm/skills -g

# 查看仓库中有哪些技能 / List available skills
npx skills add iamddatm/skills --list
```

> 支持的 agent 包括 Claude Code、Cursor、Codex、OpenCode 等。
>
> Supported agents include Claude Code, Cursor, Codex, OpenCode, and more.

### Option 2: 手动复制 / Manual Copy

将技能文件夹复制到对应 AI 工具的目录下：

Copy the skill folder into the corresponding directory for your AI tool:

```bash
# GitHub Copilot
cp -r skills/dotnet-best-practices .github/skills/

# Claude Code
cp -r skills/dotnet-best-practices .claude/skills/
```

Cursor 用户需将 `SKILL.md` 重命名为 `.mdc` 后放入 `.cursor/rules/` 目录。

For Cursor, rename `SKILL.md` to `.mdc` and place it under `.cursor/rules/`.

## Contributing / 贡献

Contributions are welcome! Two ways to contribute:

欢迎贡献！两种方式：

### Translate an Upstream Skill / 翻译上游技能

1. Fork this repo / 复刻本仓库
2. Create a skill folder under `skills/` using the original skill name / 在 `skills/` 下使用上游技能原名创建文件夹
3. Translate `SKILL.md` while preserving the original structure and code examples / 翻译 `SKILL.md`，保留原始结构和代码示例
4. Link back to the original skill in the PR / 在 PR 中链接回原始技能

### Create an Original Skill / 创作原创技能

1. Create a skill folder under `skills/` with a descriptive name / 在 `skills/` 下用描述性名称创建技能文件夹
2. Write `SKILL.md` with proper frontmatter (`name`, `description`) / 编写 `SKILL.md`，包含正确的 frontmatter
3. Submit a Pull Request / 提交 Pull Request

### Writing Guidelines / 编写准则

- Keep code identifiers, variable names, and technical terms in English / 代码标识符、变量名、技术术语保留英文
- Write prose descriptions and comments in Chinese / 描述性文本和注释使用中文
- Include frontmatter with `name` and `description` fields / 包含 `name` 和 `description` frontmatter 字段

## Acknowledgements / 致谢

- Upstream skill authors and communities / 上游技能作者和社区
- All contributors who help translate and localize skills / 所有参与翻译和本地化的贡献者

## License / 许可证

Each skill retains the license of its original source. Translations are provided under the same terms.

每项技能保留其原始来源的许可证，翻译版本遵循相同条款。
