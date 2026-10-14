#!/usr/bin/env node
// 只读探测目标项目，为生成发版技能收集事实。零依赖，Node >= 20.12。
//
//   node release-probe.mjs [<项目根>] [--json] [--depth 3]
//
// 探测的每条结论都带**证据文件路径**：生成技能时要把这张表摆给用户过一遍，
// 而不是让 AI 凭目录名猜。猜错的代价是生成出一个路径全错的发版技能。
// 本脚本不写任何文件。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { dim, fail, info, parseArgs, printJson, step, warn } from './lib/cli.mjs';

const { flags, positionals } = parseArgs(process.argv.slice(2));
const root = resolve(positionals[0] ?? '.');

if (!existsSync(root)) fail(`项目根不存在：${root}`);

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor', '.vs', '.idea', '__pycache__', 'packages', 'artifacts']);
const maxDepth = typeof flags.depth === 'string' ? Number(flags.depth) : 3;

/** 广度优先、限深、跳过大目录的遍历。返回相对路径列表。 */
function walk(directory, depth = 0) {
    if (depth > maxDepth) return [];
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
    const files = [];
    const directories = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.codex' && entry.name !== '.claude') continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRECTORIES.has(entry.name)) continue;
            directories.push(full);
        } else if (entry.isFile()) {
            files.push(full);
        }
    }
    for (const child of directories) files.push(...walk(child, depth + 1));
    return files;
}

step(`扫描 ${root}（深度 ≤ ${maxDepth}）`);
const files = walk(root);
const relatives = files.map((file) => relative(root, file).split('\\').join('/'));
const byName = new Map();
for (const file of files) byName.set(relative(root, file).split('\\').join('/'), file);

const find = (pattern) => relatives.filter((name) => pattern.test(name));
const readIfSmall = (relativePath, limit = 200_000) => {
    const full = byName.get(relativePath);
    if (!full) return '';
    try {
        return statSync(full).size > limit ? '' : readFileSync(full, 'utf8');
    } catch {
        return '';
    }
};

// ---------------------------------------------------------------------------
// 逐组件探测
// ---------------------------------------------------------------------------

const FRAMEWORKS = [
    { id: 'dotnet-wpf', match: (source) => /<UseWPF>\s*true\s*<\/UseWPF>/i.test(source) },
    { id: 'dotnet-winforms', match: (source) => /<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(source) },
    { id: 'dotnet', match: () => true }, // 兜底：有 .csproj 就算 .NET
];

const csprojFiles = find(/\.csproj$/i);
const dotnetProjects = csprojFiles.map((path) => {
    const source = readIfSmall(path);
    const framework = FRAMEWORKS.find((candidate) => candidate.match(source))?.id ?? 'dotnet';
    const assemblyName = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/i.exec(source)?.[1];
    const targetFramework = /<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/i.exec(source)?.[1];
    const version = /<Version>\s*([^<]+?)\s*<\/Version>/i.exec(source)?.[1];
    const selfContained = /<SelfContained>\s*true\s*<\/SelfContained>/i.test(source);
    return { path, framework, assemblyName, targetFramework, version, selfContained };
});

const packageJsonFiles = find(/(^|\/)package\.json$/);
const nodeProjects = packageJsonFiles.map((path) => {
    let parsed = {};
    try {
        parsed = JSON.parse(readIfSmall(path) || '{}');
    } catch {
        warn(`package.json 解析失败：${path}`);
    }
    const dependencies = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
    const kinds = [];
    if (dependencies.electron) kinds.push('electron');
    if (dependencies['electron-builder']) kinds.push('electron-builder');
    if (dependencies['@tauri-apps/cli']) kinds.push('tauri');
    if (dependencies.vite) kinds.push('vite');
    if (dependencies.next) kinds.push('next');
    if (dependencies.react) kinds.push('react');
    if (dependencies.vue) kinds.push('vue');
    return { path, version: parsed.version, kinds };
});

const composeFiles = find(/(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/i);
const composeServices = [];
for (const path of composeFiles) {
    const source = readIfSmall(path);
    // 只认行首两格缩进的服务名，够用且不会被 image: 里的东西误伤
    for (const match of source.matchAll(/^\s{2}([a-zA-Z0-9._-]+):\s*$/gm)) {
        if (!['services', 'volumes', 'networks', 'configs', 'secrets'].includes(match[1])) composeServices.push(match[1]);
    }
}

const migrationDirs = [...new Set(relatives
    .filter((name) => /(^|\/)(migrations|Migrations)(\/[^/]+)?$/.test(name) || /(^|\/)(flyway|alembic|liquibase)(\.conf|\.ini|\.toml|\.properties)?$/i.test(name))
    .map((name) => name.split('/').slice(0, -1).join('/') || name))].filter((value) => value !== '');
const migrationFiles = relatives.filter((name) => /(^|\/)migrations?\//i.test(name));
const hasDownScripts = migrationFiles.some((name) => /\.down\.(sql|js|ts|py)$|down\.sql$/i.test(name));

const versionFiles = relatives.filter((name) => /(^|\/)(VERSION|version\.txt|version\.json)$/i.test(name) || /(^|\/)\.version-counter$/.test(name));
const ciFiles = relatives.filter((name) => name.startsWith('.github/workflows/') || ['azure-pipelines.yml', 'Jenkinsfile', '.gitlab-ci.yml'].includes(name));

const result = {
    repoRoot: root,
    scannedFiles: relatives.length,
    dotnet: { projects: dotnetProjects, hasSolution: relatives.some((name) => /\.slnx?$/i.test(name)) },
    node: { projects: nodeProjects },
    otherStacks: {
        go: relatives.filter((name) => /(^|\/)go\.mod$/.test(name)),
        python: relatives.filter((name) => /(^|\/)(pyproject\.toml|requirements[\w.-]*\.txt)$/.test(name)),
        java: relatives.filter((name) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(name)),
        rust: relatives.filter((name) => /(^|\/)Cargo\.toml$/.test(name)),
    },
    compose: { files: composeFiles, services: [...new Set(composeServices)] },
    database: { migrationDirs: [...new Set(migrationDirs)], migrationFileCount: migrationFiles.length, hasDownScripts },
    versionFiles,
    ciFiles,
    publishDirs: relatives.filter((name) => /(^|\/)(publish|win-unpacked|resources)(\/|$)/.test(name)).map((name) => name.split('/').slice(0, 2).join('/')),
};

if (flags.json) {
    printJson(result);
    process.exit(0);
}

const line = (label, value) => info(`  ${label.padEnd(16)} ${value || dim('（未探测到）')}`);

info('');
info('语言与框架');
line('.NET 项目', dotnetProjects.map((project) => `${project.path}${project.framework !== 'dotnet' ? ` [${project.framework}]` : ''}${project.targetFramework ? ` (${project.targetFramework})` : ''}`).join('\n                   '));
line('Node 项目', nodeProjects.map((project) => `${project.path}${project.kinds.length ? ` [${project.kinds.join(', ')}]` : ''}`).join('\n                   '));
for (const [stack, paths] of Object.entries(result.otherStacks)) {
    if (paths.length > 0) line(stack, paths.join(', '));
}
info('');
info('部署与数据');
line('compose 文件', composeFiles.join(', '));
line('compose 服务', composeServices.join(', '));
line('迁移目录', [...new Set(migrationDirs)].join(', ') + (hasDownScripts ? '（有 down 脚本）' : '（没找到 down 脚本）'));
info('');
info('版本号与构建线索');
line('版本文件', versionFiles.join(', '));
line('.NET 版本来源', dotnetProjects.filter((project) => project.version).map((project) => `${project.path} 的 <Version> = ${project.version}`).join('; '));
line('Node 版本来源', nodeProjects.filter((project) => project.version).map((project) => `${project.path} 的 version = ${project.version}`).join('; '));
line('CI 配置', ciFiles.join(', '));
info('');
warn('以上只是候选事实。生成发版技能时要逐条与用户确认，不要直接采用 —— 探测不到的项（业务文件边界、停机窗口、托管地址）必须问。');