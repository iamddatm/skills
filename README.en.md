# Awesome AI Coding Skills (Chinese Edition)

[中文](README.md) | **English**

[![Awesome](https://awesome.re/badge.svg)](https://github.com/github/awesome-copilot)

A collection of AI coding skills for Chinese-speaking developers — including adaptations of popular upstream skills and original skills — compatible with Claude Code, GitHub Copilot, Cursor, and other AI-powered development tools.

---

## Available Skills

| Skill | Description | Type | Source |
|---|---|---|---|
| [agent-skill-stats](skills/agent-skill-stats) | Count Skill and MCP invocations across local AI agents (Claude Code / Codex / pi) from their session logs and generate a single-file offline dashboard | Original | — |
| [ask-ui](skills/ask-ui) | Render multiple independent questions from an Agent workflow as a local interactive form with preselected recommendations, auto-saved drafts, and per-question notes | Adapted | [ask-ui](https://github.com/Angus221/ak.skills_sample/tree/main/skills/ask-ui) |
| [claude-code-native-update](skills/claude-code-native-update) | Install, update, or migrate to the native Claude Code on Windows in restricted network environments: manual download via local proxy + SHA256 verification + offline deployment | Original | — |
| [dotnet-best-practices](skills/dotnet-best-practices) | Best-practice convention checks for .NET/C# code | Adapted | [dotnet-best-practices](https://github.com/github/awesome-copilot/tree/main/skills/dotnet-best-practices) |
| [dotnet-production-debug](skills/dotnet-production-debug) | .NET production performance troubleshooting: CPU spikes, memory leaks/OOM, deadlocks/hangs, crashes, GC anomalies and dump analysis | Original | — |
| [grill-with-docs-ui](skills/grill-with-docs-ui) | Form-mode grill-with-docs: grilling's frontier rounds are asked through an ask-ui local interactive form, producing ADRs and a glossary along the way; requires grilling, domain-modeling and ask-ui | Adapted | [grill-with-docs](https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs) |
| [wpf-stylet](skills/wpf-stylet) | WPF + Stylet MVVM framework guide: lifecycle, Conductor navigation, dialogs, command binding and dependency injection | Original | — |

## What Are Skills?

Skills are self-contained instruction sets (`SKILL.md`) that give AI coding assistants specific capabilities — coding standards, framework patterns, review checklists, and more. Each AI tool has its own convention for loading skills:

| Tool | Path |
|---|---|
| GitHub Copilot | `.github/skills/<name>/SKILL.md` |
| Claude Code | `.claude/skills/<name>/SKILL.md` |
| Cursor | `.cursor/rules/<name>.mdc` |

## Usage

### Option 1: npx skills (Recommended)

Install skills with one command using the [skills](https://github.com/vercel-labs/skills) CLI — it auto-detects your AI agent and places files in the right directory:

```bash
# Install all skills from this repo
npx skills add iamddatm/skills

# Install a specific skill
npx skills add iamddatm/skills --skill dotnet-best-practices

# Target a specific agent
npx skills add iamddatm/skills --skill dotnet-best-practices -a claude-code

# Install globally (available in all projects)
npx skills add iamddatm/skills -g

# List available skills
npx skills add iamddatm/skills --list
```

> Supported agents include Claude Code, Cursor, Codex, OpenCode, and more.

### Option 2: Manual Copy

Copy the skill folder into the corresponding directory for your AI tool:

```bash
# GitHub Copilot
cp -r skills/dotnet-best-practices .github/skills/

# Claude Code
cp -r skills/dotnet-best-practices .claude/skills/
```

For Cursor, rename `SKILL.md` to `.mdc` and place it under `.cursor/rules/`.

## Contributing

Contributions are welcome! Two ways to contribute:

### Adapt an Upstream Skill

1. Fork this repo
2. Create a skill folder under `skills/` using the original skill name
3. Adapt `SKILL.md` while preserving the original structure and code examples
4. Link back to the original skill in the PR

### Create an Original Skill

1. Create a skill folder under `skills/` with a descriptive name
2. Write `SKILL.md` with proper frontmatter (`name`, `description`)
3. Submit a Pull Request

### Writing Guidelines

- Keep code identifiers, variable names, and technical terms in English
- Write prose descriptions and comments in Chinese
- Include frontmatter with `name` and `description` fields

## Acknowledgements

- Upstream skill authors and communities
- All contributors who help adapt and localize skills

## License

Each skill retains the license of its original source. Adaptations are provided under the same terms.
