#!/usr/bin/env node
// 把发版技能同步到各 AI Agent 的技能目录。零依赖，Node >= 20.12。
//
//   node release-sync.mjs [--repo <仓库根>] [--name <技能名>] [--check] [--user]
//                         [--targets claude-agents,codex] [--list] [--json]
//
// 真源只有一份：<仓库根>/.claude/skills/<技能名>/。其余目录由本脚本**复制**出来。
//   · 为什么复制而不是符号链接：链接怕仓库搬家（路径一变全体断链），复制则各目录自包含，
//     随 git 走，谁拉下来谁能用。代价是改完技能要重跑本脚本 —— 所以有 --check。
//   · 为什么默认不写用户目录：机器级目录各家工具版本各管各的，写出去既不入库、换台机器还得再来一遍。
//     但 **Codex CLI 与 pi 只在用户级目录发现技能**，要让它们用上就必须加 --user。
//
// ⚠️ 路径证据强度不同，改这里之前先看 assets/multi-agent-paths.md：
//      .claude/skills（项目级）、~/.claude/skills、~/.codex/skills、~/.pi/agent/skills、
//      ~/.qoderwork/skills、~/.cursor/skills 均为本机实测存在；
//      .agents/skills 是 Qoder 等采用的跨工具约定（也是 npx skills -g 的全局目标）；
//      Qoder 项目级目录、pi 的项目级目录**没有找到证据**，因此未列入默认目标。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { sha256File, sha256Text, listFiles } from './lib/tree-hash.mjs';
import { dim, fail, green, info, ok, parseArgs, printJson, warn, yellow } from './lib/cli.mjs';

const { flags } = parseArgs(process.argv.slice(2));

/** 项目内的目标目录（随 git 走）。 */
const REPO_TARGETS = [
    { id: 'claude', label: 'Claude Code', relative: '.claude/skills', source: true },
    { id: 'agents', label: '跨工具约定（Qoder 等）', relative: '.agents/skills' },
    { id: 'codex', label: 'Codex', relative: '.codex/skills' },
    { id: 'copilot', label: 'GitHub Copilot', relative: '.github/skills' },
    { id: 'cursor', label: 'Cursor', relative: '.cursor/skills' },
];

/** 用户级目标目录（不随 git 走，需 --user 才写）。 */
const USER_TARGETS = [
    { id: 'claude-user', label: 'Claude Code（用户级）', home: '.claude/skills' },
    { id: 'codex-user', label: 'Codex CLI（只读这里）', home: '.codex/skills' },
    { id: 'pi-user', label: 'pi（配置根是 ~/.pi，不是 ~/.config/pi）', home: '.pi/agent/skills' },
    { id: 'qoderwork-user', label: 'QoderWork（用户级）', home: '.qoderwork/skills' },
    { id: 'cursor-user', label: 'Cursor（用户级）', home: '.cursor/skills' },
];

/** 目录指纹：相对路径 + 文件 sha256 排序后拼串再取 sha256。与 Sync-Skills.ps1 的 Get-TreeHash 同口径。 */
function treeFingerprint(directory) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return '';
    const files = listFiles(directory);
    if (files.length === 0) return 'empty';
    return sha256Text(files.map((file) => `${file.relative}=${sha256File(file.full)}`).join('\n'));
}

const repoRoot = resolve(typeof flags.repo === 'string' ? flags.repo : process.cwd());
const sourceRoot = join(repoRoot, '.claude', 'skills');

if (flags.list) {
    const repoDeclared = declaredTargets('repoTargets');
    const userDeclared = declaredTargets('userTargets');
    const scope = repoDeclared ? `（配置里声明了 ${[...repoDeclared].join('、')}，只列这些）` : '（全部）';
    info(`项目内目标${scope}：`);
    for (const target of REPO_TARGETS) {
        const skipped = repoDeclared && !repoDeclared.has(target.id) ? dim('  ← 配置未声明，跳过') : '';
        info(`  ${target.id.padEnd(12)} ${target.label.padEnd(24)} ${dim(join(repoRoot, target.relative))}${skipped}`);
    }
    const userScope = userDeclared ? `（配置里声明了 ${[...userDeclared].join('、')}）` : '';
    info(`用户级目标（需 --user；Codex CLI 与 pi 只从这里发现技能）${userScope}：`);
    for (const target of USER_TARGETS) {
        const skipped = userDeclared && !userDeclared.has(target.id) ? dim('  ← 配置未声明，跳过') : '';
        info(`  ${target.id.padEnd(12)} ${target.label.padEnd(24)} ${dim(join(homedir(), target.home))}${skipped}`);
    }
    process.exit(0);
}

const skillNames = typeof flags.name === 'string'
    ? [flags.name]
    : readdirSync(sourceRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .filter((name) => existsSync(join(sourceRoot, name, 'SKILL.md')));

if (skillNames.length === 0) fail(`${sourceRoot} 下没有含 SKILL.md 的技能。`);

const selected = typeof flags.targets === 'string' ? new Set(flags.targets.split(',').map((id) => id.trim())) : null;

/**
 * 项目声明了要同步给哪些 Agent，就只同步那些。
 *
 * 少了这一步，`release-state` 侧声明 `agents.repoTargets: ["agents","codex"]` 的项目，
 * `--check` 会照样报「4 处未同步」并在退出码上判失败 —— 门禁要求同步到项目根本没声明、
 * 也不想维护的目录（Copilot / Cursor），于是这条门禁要么被无视，要么逼人建一堆空目录。
 * 配置里没有这项时才退回「全都同步」。
 */
function declaredTargets(key) {
    const configPath = join(repoRoot, 'release', 'release.config.json');
    if (!existsSync(configPath)) return null;
    try {
        const declared = JSON.parse(readFileSync(configPath, 'utf8')).agents?.[key];
        return Array.isArray(declared) && declared.length > 0 ? new Set(declared) : null;
    } catch {
        warn(`${configPath} 读不了（不是合法 JSON？），本次按默认目标同步。`);
        return null;
    }
}

const declaredRepo = declaredTargets('repoTargets');
const declaredUser = declaredTargets('userTargets');
const includeTarget = (target, declared) => (selected ? selected.has(target.id) : !declared || declared.has(target.id));

const destinations = [];
for (const target of REPO_TARGETS) {
    if (target.source || !includeTarget(target, declaredRepo)) continue;
    destinations.push({ id: target.id, label: target.label, path: join(repoRoot, target.relative) });
}
if (flags.user) {
    for (const target of USER_TARGETS) {
        if (!includeTarget(target, declaredUser)) continue;
        destinations.push({ id: target.id, label: target.label, path: join(homedir(), target.home) });
    }
}

const report = { repoRoot, skills: [], drifted: 0, synced: 0 };

for (const name of skillNames) {
    const source = join(sourceRoot, name);
    if (!existsSync(join(source, 'SKILL.md'))) fail(`技能不存在或缺 SKILL.md：${source}`);
    const sourceFingerprint = treeFingerprint(source);
    info(`${name}  ${dim(`真源 ${sourceFingerprint.slice(0, 12)}`)}`);
    const skillReport = { name, source, fingerprint: sourceFingerprint, targets: [] };

    for (const destination of destinations) {
        const targetPath = join(destination.path, name);
        const targetFingerprint = treeFingerprint(targetPath);

        if (targetFingerprint === sourceFingerprint) {
            info(`  ${dim('=')} ${destination.label}：已一致`);
            skillReport.targets.push({ id: destination.id, state: 'same', path: targetPath });
            continue;
        }

        const state = targetFingerprint === '' ? 'missing' : 'drifted';
        if (flags.check) {
            const detail = targetFingerprint === '' ? '缺失' : `内容不一致（${targetFingerprint.slice(0, 12)}）`;
            info(`  ${yellow('!')} ${destination.label}：${detail}`);
            report.drifted += 1;
            skillReport.targets.push({ id: destination.id, state, path: targetPath });
            continue;
        }

        // 先删后拷：不删的话真源里删掉的文件会留在目标目录里，越积越脏
        if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
        mkdirSync(targetPath, { recursive: true });
        cpSync(source, targetPath, { recursive: true });
        info(`  ${green('+')} ${destination.label}：${targetPath}`);
        report.synced += 1;
        skillReport.targets.push({ id: destination.id, state: 'synced', path: targetPath });
    }
    report.skills.push(skillReport);
}

if (flags.json) printJson(report);

if (flags.check) {
    if (report.drifted > 0) {
        warn(`有 ${report.drifted} 处未同步。跑一次 release-sync.mjs 刷新（改完技能别忘了）。`);
        process.exit(1);
    }
    ok('所有目标与真源一致。');
    process.exit(0);
}

if (report.synced === 0) info(dim('没有需要刷新的目标。'));
else ok(`已刷新 ${report.synced} 处。真源改动记得提交（副本随真源一起进 git）。`);
if (!flags.user && destinations.some((d) => d.path.startsWith(homedir() + sep)) === false) {
    info(dim('注：Codex CLI 与 pi 只从用户级目录发现技能；要让它们用上，加 --user。'));
}