#!/usr/bin/env node
// 渲染出目标项目的发版技能。零依赖，Node >= 20.12。
//
//   node scripts/release-scaffold.mjs --config <填好的 release.config.json> [--out <技能目录>]
//        [--dry-run] [--diff] [--adopt] [--force] [--update-engine] [--json]
//
// 做什么：
//   · 把 assets/templates/ 下的 .tmpl 用配置渲染成生成物（SKILL.md、references、项目脚本）；
//   · 把引擎（scripts/engine/）与通用契约原样拷过去，生成物因此**自包含**；
//   · 自检：模板里的每个占位符都必须能从配置推导出来，渲染完不许有 `{{` 残留。
//
// 四种用法（目标目录已存在时，前三种才有区别）：
//
//   首次生成                        直接跑，目标目录必须不存在
//   --diff     优化前先看清楚       渲染到临时目录，逐文件比对，只打印不写盘（有差异退出码 2）
//   --adopt    优化已有的技能       先备份现有目录，再按当前模板重渲染
//   --update-engine                 只把 scripts/engine/ 换成当前版本，不动别的
//   --force                         同 --adopt 但**不备份**（明确不要备份时才用）
//
// 两个容易做错的地方，这里都做成了机器保证：
//
//   1. **相对路径**。生成物在 `<repo>/.claude/skills/<slug>-release/`，不在仓库根 ——
//      所以指向 `release/` 的路径是 `../../../release/...` 而不是 `../release/...`。
//      手写层级错了四个模板一起错，所以改成按实际路径算的 {{REPO_REL}}。
//   2. **禁用组件**。声明「没有客户端就自动省略」就得真的省略：模板里用
//      `{{#if CLIENT_ENABLED}}...{{/if}}` 括起来，整篇都在条件里的文件（如 client.md）直接不生成。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRelativeFiles, treeHash } from './engine/lib/tree-hash.mjs';
import { loadConfig } from './engine/lib/config.mjs';
import { dim, fail, green, info, ok, parseArgs, printJson, red, requireFlag, step, warn, yellow } from './engine/lib/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = dirname(HERE);
const TEMPLATES_DIR = join(SKILL_ROOT, 'assets', 'templates');

/** 引擎版本戳。**只在这一个地方改** —— --update-engine 用它标记生成物里的引擎版本。 */
const ENGINE_VERSION = 'release-skill-authoring@0.1.0';

const { flags } = parseArgs(process.argv.slice(2));
const configPath = requireFlag(flags, 'config', '指向填好的 release.config.json。');
const config = loadConfig(configPath);
const dryRun = Boolean(flags['dry-run']);

const client = config.components?.client ?? {};
const database = config.database ?? {};
const frontend = config.frontend ?? {};
const backend = config.backend ?? {};
const deploy = config.deploy ?? {};
const installer = config.installer ?? {};

const hasClient = Boolean(client.enabled !== false);
const hasFrontend = Boolean(config.components?.frontend?.enabled !== false);
const hasDatabase = Boolean(config.components?.database?.enabled !== false);

const outDir = typeof flags.out === 'string'
    ? resolve(flags.out)
    : join(config.__repoRoot, '.claude', 'skills', `${config.project.slug}-release`);

// ---- 清单地址：只在这里推导一次 ----
//
// 之前是「模板各自拼一层 baseUrl + channel」，同时 Pascal 侧又要求 UpdateBase 自带通道
// （它做的是 `UpdateBase + '/manifest.json'`）—— 两边语义相反，结果实测拼出过
// `https://dl.example.com/stable/stable/manifest.json` 这种不存在的地址（用户说
// 「清单放 https://dl.example.com/stable/ 上」时，把整串填进 baseUrl 是很自然的读法）。
//
// 现在统一从这一处推导，两种填法都认：
//   · baseUrl 是站点根（https://dl.example.com）+ channel（stable）→ 拼一层；
//   · baseUrl 已经把通道带上了（.../stable）→ **不再拼**，否则就是上面那个坏地址。
const manifestBase = (config.manifest?.baseUrl ?? '').replace(/\/+$/, '');
const manifestChannel = config.manifest?.channel ?? '';
const explicitManifestUrl = typeof config.version?.onlineManifest === 'string' ? config.version.onlineManifest.trim() : '';
const baseUrlHasChannel = Boolean(manifestChannel) && manifestBase.endsWith(`/${manifestChannel}`);
const manifestUrl = explicitManifestUrl
    || (baseUrlHasChannel ? `${manifestBase}/manifest.json` : `${manifestBase}/${manifestChannel}/manifest.json`);
/** 清单所在目录（= 通道目录）。安装包的 UpdateBase 要的是这个 —— 它自己会再拼 `/manifest.json`。 */
const manifestDir = manifestUrl.replace(/\/[^/]*$/, '');

if (baseUrlHasChannel) {
    warn(
        `manifest.baseUrl 已经带上了通道 /${manifestChannel}，按「站点根」解释会拼成 ` +
            `${manifestBase}/${manifestChannel}/manifest.json。本次按「baseUrl 已含通道」处理（结果 ${manifestUrl}）。\n` +
            `  建议把 baseUrl 改成站点根、channel 单独写 ${manifestChannel}，语义更清楚。`,
    );
}

// ---- 相对路径按实际位置算，不手写层级 ----
const repoRel = relative(outDir, config.__repoRoot).split('\\').join('/') || '.';
const repoRelFromScripts = relative(join(outDir, 'scripts'), config.__repoRoot).split('\\').join('/') || '.';

// ---------------------------------------------------------------------------
// 占位符表
// ---------------------------------------------------------------------------

const json = (value) => JSON.stringify(value ?? []);
/** 空格分隔的 glob 串，直接喂给 `git diff -- <paths>`；JSON 数组塞进去是非法 pathspec。 */
const shellGlobs = (value) => (value ?? []).join(' ');
const text = (value, name) => {
    if (value === undefined || value === null || value === '') {
        fail(`配置里缺少 ${name}（模板要用）。生成前必须先问清楚 —— 见 references/interview-checklist.md。`);
    }
    return String(value);
};
/**
 * 只在有客户端时才要求的占位符。
 *
 * 没有客户端时返回空串而不是报错：这些引用都应当被 `{{#if CLIENT_ENABLED}}` 包着，
 * 包漏了会在下面「禁用组件的模板不该引用它的占位符」自检里暴露，而不是静默留下半截文本。
 */
const clientText = (value) => (value === undefined || value === null ? '' : String(value));

const archiveExt = client.archive === 'zip' ? '.zip' : client.archive === 'tar.gz' ? '.tar.gz' : `.${client.archive ?? 'tar.gz'}`;

// 每个占位符是一个**惰性取值函数**，不是值。理由：模板里大量可选段落是
// `{{#if DATABASE_ENABLED}}...{{/if}}` 包着的，段被丢掉时里面的占位符根本不该有取值。
// 要是提前求值，「没有数据库的项目」会因为 database.strategy 缺失而报错 —— 而它压根用不到这个字段。
// 惰性化之后语义也正好：**只有真正渲染进生成物的占位符才要求配置齐备**。
const placeholders = {
    PROJECT_NAME: () => text(config.project.name, 'project.name'),
    SLUG: () => text(config.project.slug, 'project.slug'),
    REPO_REL: () => repoRel,
    REPO_REL_FROM_SCRIPTS: () => repoRelFromScripts,

    COMPONENT_DATABASE_ENABLED: () => json(hasDatabase),
    COMPONENT_BACKEND_ENABLED: () => json(config.components?.backend?.enabled !== false),
    COMPONENT_FRONTEND_ENABLED: () => json(hasFrontend),
    COMPONENT_CLIENT_ENABLED: () => json(hasClient),
    COMPONENT_DATABASE_GLOBS: () => json(config.components?.database?.globs),
    COMPONENT_BACKEND_GLOBS: () => json(config.components?.backend?.globs),
    COMPONENT_FRONTEND_GLOBS: () => json(config.components?.frontend?.globs),
    COMPONENT_CLIENT_GLOBS: () => json(client.globs),
    // 给 shell 用的空格分隔版本（塞进 git diff / 命令行）
    COMPONENT_DATABASE_GLOBS_SHELL: () => shellGlobs(config.components?.database?.globs),
    COMPONENT_BACKEND_GLOBS_SHELL: () => shellGlobs(config.components?.backend?.globs),
    COMPONENT_FRONTEND_GLOBS_SHELL: () => shellGlobs(config.components?.frontend?.globs),
    COMPONENT_CLIENT_GLOBS_SHELL: () => shellGlobs(client.globs),

    CLIENT_BUSINESS_GLOBS: () => json(client.businessGlobs),
    CLIENT_RUNTIME_GLOBS: () => json(client.runtimeGlobs),
    CLIENT_STRUCTURE_GLOBS: () => json(client.structureGlobs),
    CLIENT_BUILD_OUTPUT_DIR: () => clientText(client.buildOutputDir),
    CLIENT_ARCHIVE: () => clientText(client.archive),
    CLIENT_ARCHIVE_EXT: () => archiveExt,
    CLIENT_EXE_NAME: () => clientText(client.exeName),
    CLIENT_UPDATE_EXECUTOR: () => clientText(client.updateExecutor),

    VERSION_SOURCE: () => text(config.version?.source, 'version.source'),
    // 清单地址一律用这两个（在文件开头推导），**不要在模板里再拼 baseUrl + channel**
    MANIFEST_URL: () => text(manifestUrl, 'manifest.baseUrl/manifest.channel'),
    MANIFEST_DIR: () => text(manifestDir, 'manifest.baseUrl/manifest.channel'),
    MANIFEST_CHANNEL: () => text(manifestChannel, 'manifest.channel'),
    NOTES_SOURCE: () => text(config.manifest?.notesSource, 'manifest.notesSource'),

    RELEASE_BRANCH: () => text(config.release?.branch, 'release.branch'),
    DEFAULT_BRANCH: () => text(config.release?.defaultBranch, 'release.defaultBranch'),
    STOP_WINDOW: () => text(config.release?.stopWindow, 'release.stopWindow'),
    BACKWARD_COMPAT_VERSIONS: () => text(config.release?.backwardCompatVersions, 'release.backwardCompatVersions'),
    BACKWARD_COMPAT_DAYS: () => text(config.release?.backwardCompatDays, 'release.backwardCompatDays'),
    RELEASE_CHECKPOINTS: () => text(config.release?.checkpoints, 'release.checkpoints'),
    KEEP_LOCAL_DIST: () => String(config.release?.retention?.localDistVersions ?? 1),
    KEEP_LOCAL_HISTORY: () => String(config.release?.retention?.localHistoryVersions ?? 5),

    DB_STRATEGY: () => text(database.strategy, 'database.strategy'),
    DB_MIGRATIONS_DIR: () => text(database.migrationsDir, 'database.migrationsDir'),
    DB_BACKUP_DIR: () => text(database.backupDir, 'database.backupDir'),
    DB_CONNECTION_ENV: () => text(database.connectionEnv, 'database.connectionEnv'),
    DB_BACKUP_COMMAND: () => text(database.backupCommand, 'database.backupCommand'),
    DB_EXEC_COMMAND: () => text(database.execCommand, 'database.execCommand'),
    DB_RESTORE_COMMAND: () => text(database.restoreCommand, 'database.restoreCommand'),

    FRONTEND_MODE: () => (hasFrontend ? text(frontend.mode, 'frontend.mode') : 'not-applicable'),
    FRONTEND_BUILD_COMMAND: () => frontend.buildCommand ?? '',
    FRONTEND_OUTPUT_DIR: () => frontend.outputDir ?? '',
    FRONTEND_URL: () => frontend.url ?? '',
    FRONTEND_PUBLISH_TARGET: () => frontend.publishTarget ?? '',

    COMPOSE_FILE: () => text(backend.composeFile, 'backend.composeFile'),
    COMPOSE_SERVICES: () => json(backend.services),
    COMPOSE_SINGLE_FILE_MOUNTS: () => json(backend.singleFileMountServices),
    COMPOSE_PERSISTENT_DIRS: () => json(backend.persistentDirs),

    DEPLOY_HOST_ENV: () => text(deploy.hostEnv, 'deploy.hostEnv'),
    DEPLOY_KEY_ENV: () => text(deploy.keyEnv, 'deploy.keyEnv'),
    DEPLOY_APP_DIR: () => text(deploy.appDir, 'deploy.appDir'),
    HEALTHCHECK_URL: () => text(deploy.healthcheckUrl, 'deploy.healthcheckUrl'),

    INSTALLER_DIR: () => clientText(installer.dir),
    INNO_SKILL_DIR: () => clientText(installer.innoSkillDir),
    INSTALLER_VERSION_COMMAND: () => text(installer.payloadVersionCommand, 'installer.payloadVersionCommand'),

    BUILD_COMMANDS: () => (config.commands?.build ?? []).join('\n'),

    AGENT_REPO_TARGETS: () => json(config.agents?.repoTargets ?? ['agents', 'codex']),
    AGENT_USER_TARGETS: () => json(config.agents?.userTargets ?? []),
    ENGINE_VERSION: () => ENGINE_VERSION,
};

/**
 * 条件段用的开关。名字与 {{#if NAME}} 里的 NAME 对应。
 *
 * PENDING_CONFIRMATIONS 不是项目属性，而是**本次生成的诚实度**：哪些参数是用户在
 * CHECKPOINT 之前没拍板、按假定填的。生成器把这些写进 release.pendingConfirmations，
 * 生成物据此在开头挂一条「尚未就绪」的横幅，并落一份 PENDING-CONFIRMATIONS.md。
 * 少了它，一个「看起来完整但参数是猜的」技能会和真就绪的技能长得一模一样。
 */
const pendingConfirmations = Array.isArray(config.release?.pendingConfirmations)
    ? config.release.pendingConfirmations.filter((item) => typeof item === 'string' && item.trim() !== '')
    : [];

// installer.payloadVersionCommand 必须是**能取到版本号的 PowerShell 表达式**，不是说明文字。
//
// 实测踩过：这一栏被填成「从已构建产物读版本」这样的中文说明句，一路通过所有自检，
// 直到真正打安装包时才在求值处炸掉 —— 而那时已经在发版流程中间了。
// 判据用「含中文」而不是更聪明的语法分析：说明文字几乎必然是中文，而表达式不会。
if (hasClient) {
    const versionCommand = installer.payloadVersionCommand;
    if (typeof versionCommand === 'string' && /[一-鿿]/.test(versionCommand)) {
        fail(
            `installer.payloadVersionCommand 里含中文，看起来是说明文字而不是命令：\n  ${versionCommand}\n` +
                '要写真正能取到版本号的 PowerShell 表达式（构建产物目录用 $payloadFull 引用）。示例见 references/versions.md。',
        );
    }
}

// 硬门禁：必须**显式声明**参数是「用户确认过的」还是「按假定填的」，没有第三种。
//
// 为什么做成机器门禁而不是写在 SKILL.md 里劝：真正的失败模式不是「不检查」，而是
// 「生成出一个看起来完整的技能」—— 参数靠猜、但和真就绪的技能长得一模一样，
// 事后从产物上完全看不出来。所以强制在配置里留下这个判断，让二者不可能混淆。
// 只在真正要生成时校验（--dry-run 不算），否则改模板时会一直被它挡。
if (!dryRun && !config.release?.confirmedBy && pendingConfirmations.length === 0) {
    fail(
        '配置里既没有 release.confirmedBy（用户在 CHECKPOINT 确认过参数），也没有 release.pendingConfirmations（未确认项）。\n' +
            '这两者必须有一个 —— 否则无法区分「参数经过确认」和「参数是猜的」，而这正是生成物最容易骗人的地方。\n' +
            '回第二步：问用户。问了 → 填 confirmedBy；问不到 → 把猜的那些列进 pendingConfirmations，生成物会挂「尚未就绪」横幅。',
    );
}

const conditionalFlags = {
    CLIENT_ENABLED: hasClient,
    FRONTEND_ENABLED: hasFrontend,
    DATABASE_ENABLED: hasDatabase,
    PENDING_CONFIRMATIONS: pendingConfirmations.length > 0,
};

/** 落盘配置时剥掉 loadConfig 加的内部字段（绝对路径不该写进项目文件）。 */
function publicConfig(value) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('__')));
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 替换用的占位符：只认「全大写+数字+下划线」的名字。 */
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;
/**
 * 残留检查用的模式：**任何** `{{...}}` 都算残留，不限于合法占位符名。
 *
 * 为什么不能用 PLACEHOLDER 来查残留：它匹配不到 `{{#if X}}` / `{{/if}}`。
 * 条件段一旦配错对（比如把 `{{#if}}` 嵌进另一段里 —— 非贪婪正则会提前收尾），
 * 渲染结果里会漏出一串字面量 `{{#if CLIENT_ENABLED}}`，而自检**照样报「无占位符残留」**。
 * 这正是这个技能最该拦住的失败模式：产物看着干净，实际是坏的。
 *
 * 不会误伤 JSDoc 里的 `{{value: string}[]}`：那里 `{{` 之后到 `}}` 之间夹着 `}`，
 * `[^{}]*` 匹配不到，所以不算残留。
 */
const ANY_MUSTACHE = /\{\{[^{}]*\}\}/g;
// 条件段支持 `{{#if NAME}}` 与 `{{#unless NAME}}`（同一个 {{/if}} 收尾）。
// 加 unless 是因为一批句子在「有客户端」和「没有客户端」下**措辞不同**，而不是「多一句少一句」——
// 例如清理时机：前者是「清单上传成功、线上体检通过之后」，后者只是「本次发版确认成功之后」。
// 只有 if 的话只能二选一：要么两边都写（客户端项目看到重复的两句），要么硬凑一句含混的。
const CONDITIONAL = /\{\{#(if|unless) ([A-Z0-9_]+)\}\}([\s\S]*?)\{\{\/(?:if|unless)\}\}/g;
const unknownPlaceholders = new Set();
const unknownConditions = new Set();

function render(source, templateName) {
    // 条件段先处理：为假时整段丢掉，于是段里的占位符根本不需要有值
    const withoutConditionals = source.replace(CONDITIONAL, (whole, keyword, name, body) => {
        if (!(name in conditionalFlags)) {
            unknownConditions.add(`${name}（出现在 ${templateName}）`);
            return whole;
        }
        const keep = keyword === 'unless' ? !conditionalFlags[name] : conditionalFlags[name];
        return keep ? body : '';
    });

    return withoutConditionals.replace(PLACEHOLDER, (whole, name) => {
        const resolve = placeholders[name];
        if (!resolve) {
            unknownPlaceholders.add(`${name}（出现在 ${templateName}）`);
            return whole;
        }
        return resolve();
    });
}

/** 递归列出目录下的文件（相对 templates 根的路径）。 */
function listTemplateFiles(directory, prefix = '') {
    const result = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) result.push(...listTemplateFiles(join(directory, entry.name), relativePath));
        else result.push(relativePath);
    }
    return result;
}

/**
 * 通用契约：与技术栈无关，原样拷到生成物，让它自包含。
 *
 * 标了 `client: true` 的只服务于客户端更新机制 —— 清单格式、载荷分类、Pascal 读取片段。
 * 没有客户端的项目不发安装包、也不生成清单，拷过去只是「一份读不懂也用不上的文档」，
 * 更糟的是它会让人以为这个项目有客户端。所以按组件过滤，而不是无差别全拷。
 */
const GENERIC_REFERENCES = [
    { name: 'manifest-contract.md', client: true },
    { name: 'payload-rules.md', client: true },
    { name: 'client-update-protocol.md', client: true },
    { name: 'multi-agent-layout.md' },
    { name: 'retention.md' },
];
const GENERIC_ASSETS = [
    { name: 'inno/pascal-fragment.iss', client: true },
    { name: 'multi-agent-paths.md' },
    { name: 'manifest.schema.json', client: true },
];
const wanted = (item) => !item.client || hasClient;
const wantedReferences = GENERIC_REFERENCES.filter(wanted).map((item) => item.name);
const wantedAssets = GENERIC_ASSETS.filter(wanted).map((item) => item.name);

/**
 * 只在有客户端时才生成的模板 —— 没有客户端时不生成，免得留下跑不通的脚本。
 */
const CLIENT_ONLY_TEMPLATES = ['scripts/build-installer.ps1.tmpl', 'scripts/verify-installer.ps1.tmpl', 'references/client.md.tmpl'];
/** 不是模板：是给人/AI 照着填的骨架，不参与渲染（渲染它没有意义，配置是输入）。 */
const NON_TEMPLATE_FILES = ['release.config.json.tmpl'];

const writes = [];
for (const relativePath of listTemplateFiles(TEMPLATES_DIR)) {
    if (NON_TEMPLATE_FILES.includes(relativePath)) continue;
    if (extname(relativePath) !== '.tmpl') continue;
    if (!hasClient && CLIENT_ONLY_TEMPLATES.includes(relativePath)) continue;
    if (!hasFrontend && relativePath === 'references/frontend.md.tmpl') continue;
    if (!hasDatabase && relativePath === 'references/database.md.tmpl') continue;
    writes.push({ relative: relativePath, target: relativePath.replace(/\.tmpl$/, '') });
}
if (!hasClient) warn('配置里未启用客户端：已跳过安装包、端到端验证与客户端相关的生成物。');
// 固定文件名的产物（「下载最新版」入口、不改名的安装包…）必须 no-store，否则 CDN 会让新包永远
// 命中旧缓存。哪些算固定名只有项目自己知道，所以**必须显式声明**（没有就写 `[]`）——
// 缺这个字段时 release-verify 会静默跳过这项检查，而「漏了这条」恰好是它存在的意义。
if (hasClient && !Array.isArray(config.manifest?.fixedNamePaths)) {
    warn(
        '配置里没有 manifest.fixedNamePaths —— 用 CDN 时，固定文件名的产物必须设 no-store，' +
            '没声明就没法在发版后验它。确认本项目确实没有这类产物后，显式写成 "fixedNamePaths": []。',
    );
}
if (!hasFrontend) warn('配置里未启用前端：已跳过前端相关生成物。');

const plan = {
    mode: existsSync(outDir) ? (flags.diff ? 'diff' : flags.force ? 'force' : 'adopt') : 'create',
    outDir,
    repoRel,
    repoRelFromScripts,
    render: writes.map((write) => write.target),
    copy: [...wantedReferences.map((name) => `references/${name}`), ...wantedAssets.map((name) => `assets/${name}`), 'scripts/engine/**'],
};

if (flags.json) printJson(plan);

if (dryRun) {
    info(`将写入 ${outDir}（仓库相对路径 {{REPO_REL}} = ${repoRel}）`);
    for (const write of writes) info(`  ${green('render')} ${write.target}`);
    for (const file of plan.copy) info(`  ${dim('copy')}   ${file}`);
    warn('--dry-run：没有写任何文件。');
    process.exit(0);
}

// ---------------------------------------------------------------------------
// 模式：生成 / 优化已有的 / 只比对
// ---------------------------------------------------------------------------
//
// 这个技能不只在「从零建一个发版技能」时有用 —— 更常见的场景是**已有的那个技能需要跟着改进**：
// 引擎落后了、模板里踩过的坑还没修、后来才加的能力（保留清理、待确认登记）它没有。
//
// 但「已有的技能」恰恰不能一把梭覆盖：项目在上面做过手改（脚本、文档、额外脚本），
// 而 `--force` 会连 `references/`、`assets/` 一起删。所以把这件事拆成三步，每步都可逆：
//
//   --diff   渲染到临时目录，逐文件比对，**只打印不写盘**（先看清楚会改什么）
//   --adopt  先备份现有目录，再按当前模板重渲染（默认路径，改错了还能找回来）
//   --force  同样的重渲染，但不备份（明确知道自己不要备份时用）
const diffMode = Boolean(flags.diff);
const staging = diffMode ? mkdtempSync(join(tmpdir(), 'rsa-diff-')) : null;
/** 这一轮真正写到哪里：比对模式写临时目录，其余写技能目录。 */
const target = staging ?? outDir;
const existsAlready = existsSync(outDir);

if (diffMode && !existsAlready) {
    fail(`--diff 要拿一个已经存在的技能目录来对比，但 ${outDir} 不存在。首次生成直接跑（不加 --diff）。`);
}
if (existsAlready && !diffMode && !flags.force && !flags.adopt && !flags['update-engine']) {
    fail(
        `${outDir} 已存在。想干什么挑一个：\n` +
            `  --diff          只比对：渲染到临时目录，逐文件告诉你会改什么，不写盘\n` +
            `  --adopt         优化它：先备份现有目录，再按当前模板重渲染\n` +
            `  --update-engine 只把 scripts/engine/ 换成当前版本，不动别的\n` +
            `  --force         同上但**不备份**（现有目录里的手改会丢）`,
    );
}

// --update-engine 只刷引擎：单独走掉，免得下面把项目定制一起覆盖
if (flags['update-engine']) {
    if (!existsAlready) fail(`--update-engine 需要 ${outDir} 已存在。`);
    cpSync(join(SKILL_ROOT, 'scripts', 'engine'), join(outDir, 'scripts', 'engine'), { recursive: true });
    ok('引擎已就位 scripts/engine/');
    const outConfigPath = join(outDir, 'release.config.json');
    if (existsSync(outConfigPath)) {
        const outConfig = JSON.parse(readFileSync(outConfigPath, 'utf8'));
        outConfig.engineVersion = ENGINE_VERSION;
        writeFileSync(outConfigPath, `${JSON.stringify(outConfig, null, 2)}\n`, 'utf8');
        ok(`已更新引擎版本戳 → ${ENGINE_VERSION}`);
    } else {
        warn('生成物里没有 release.config.json，跳过了版本戳更新。');
    }
    process.exit(0);
}

step(diffMode ? '渲染到临时目录做比对（不写盘）' : `写入 ${target}`);

// 重渲染会覆盖 references/assets 与模板产出的脚本。旧目录可能是这条流程唯一的记录 ——
// 备份是让「重渲染」可逆的最小代价。备份落在 release/.skill-backups/，由 release-prune.mjs 按份数一起清。
if (!diffMode && existsAlready) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const backupDir = join(config.__repoRoot, 'release', '.skill-backups', `${stamp}-${flags.adopt ? 'adopt' : 'force'}`);
    mkdirSync(dirname(backupDir), { recursive: true });
    cpSync(outDir, backupDir, { recursive: true });
    ok(`已备份现有技能 → ${relative(config.__repoRoot, backupDir).split('\\').join('/')}`);
}

mkdirSync(target, { recursive: true });

// 引擎
cpSync(join(SKILL_ROOT, 'scripts', 'engine'), join(target, 'scripts', 'engine'), { recursive: true });
ok('引擎已就位 scripts/engine/');

if (flags.force && !diffMode && existsSync(target)) {
    // 只清会被重写的部分，保留项目自己加的脚本
    for (const directory of ['references', 'assets']) {
        rmSync(join(target, directory), { recursive: true, force: true });
    }
}

// ---- 通用契约原样拷贝 ----
for (const name of wantedReferences) {
    const source = join(SKILL_ROOT, 'references', name);
    if (!existsSync(source)) fail(`通用契约缺失：${source}`);
    mkdirSync(join(target, 'references'), { recursive: true });
    cpSync(source, join(target, 'references', name));
}
for (const name of wantedAssets) {
    const source = join(SKILL_ROOT, 'assets', name);
    if (!existsSync(source)) continue;
    const dest = join(target, 'assets', name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest);
}
ok('通用契约与资产已拷贝');

// ---- 渲染模板 ----
const skippedBlank = [];
for (const write of writes) {
    const source = join(TEMPLATES_DIR, write.relative);
    const rendered = render(readFileSync(source, 'utf8'), write.relative);
    // 整篇都在为假的条件段里的文件（例如 server-only 项目的前端参考），渲染出来是空的 —— 不生成它
    if (rendered.trim() === '') {
        skippedBlank.push(write.target);
        continue;
    }
    const targetPath = join(target, write.target);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, rendered, 'utf8');
}
ok(`已渲染 ${writes.length - skippedBlank.length} 个文件`);
if (skippedBlank.length > 0) info(dim(`  跳过 ${skippedBlank.length} 个（内容全在未启用的组件段里）：${skippedBlank.join('、')}`));

// ---- 待确认清单：生成时没拍板的参数，落成一份显式的欠账 ----
// 没有它，「按假定填的」和「用户确认过的」在生成物里长得一模一样 ——
// 而两者的区别是「发出去可能有偏差」与「发出去就是预期的」。
if (pendingConfirmations.length > 0) {
    const lines = [
        `# 待确认参数（${config.project.name}）`,
        '',
        '生成这份发版技能时，下面这些参数**没有**得到用户拍板，是按假定填进 `release.config.json` 的。',
        '假定可能不成立 —— **首次发版前必须逐条核对**，改完再删掉对应条目。',
        '',
        ...pendingConfirmations.map((item, index) => `${index + 1}. ${item}`),
        '',
        '核对方式：确认的写进 `release.config.json`（真源只有那一份），然后把本条目删掉。',
        '全部清空后，本文件可以删除。',
        '',
    ];
    writeFileSync(join(target, 'PENDING-CONFIRMATIONS.md'), lines.join('\n'), 'utf8');
    warn(`有 ${pendingConfirmations.length} 项待确认参数 —— 已写入 PENDING-CONFIRMATIONS.md，首次发版前必须核对。`);
}

if (unknownPlaceholders.size > 0) {
    fail(
        `模板里有配置推不出来的占位符：\n  ${[...unknownPlaceholders].join('\n  ')}\n\n` +
            `要么在 release.config.json 里补上对应字段，要么在 release-scaffold.mjs 的占位符表里加映射。\n` +
            `**不要**手工把生成物里的 {{...}} 替换掉 —— 下次重渲染就没了。`,
    );
}
if (unknownConditions.size > 0) {
    fail(`模板里用了没定义的 {{#if ...}} 开关：\n  ${[...unknownConditions].join('\n  ')}`);
}

// ---- 写配置（原样落盘，作为项目真源）----
writeFileSync(join(target, 'release.config.json'), `${JSON.stringify(publicConfig(config), null, 2)}\n`, 'utf8');
if (!diffMode) {
    mkdirSync(join(config.__repoRoot, 'release'), { recursive: true });
    writeFileSync(
        join(config.__repoRoot, 'release', 'release.config.json'),
        `${JSON.stringify(publicConfig(config), null, 2)}\n`,
        'utf8',
    );
}
ok('release.config.json 已落盘（技能目录 + release/ 各一份）');

// ---- 自检 ----
step('自检');
const residue = [];
const featureLeaks = [];
/**
 * 禁用组件不该出现在生成物里的特征串：声明「自动省略」就得真的省略。
 *
 * 客户端那一行必须**同时**覆盖「文档」与「脚本」两类：漏掉文档文件名时，
 * SKILL.md 里会留下指向三份根本没被拷贝的契约文档的悬空引用 ——
 * 实测就是这么漏过去的（判据只查了 `.ps1` 与「更新包/全量包」两个词）。
 */
const disabledMarkers = [
    ...(hasClient
        ? []
        : [
              [
                  'CLIENT',
                  /build-installer\.ps1|verify-installer\.ps1|TDownloadWizardPage|release-verify|更新包|全量包|manifest-contract\.md|payload-rules\.md|client-update-protocol\.md|pascal-fragment\.iss|references\/client\.md/,
              ],
          ]),
    ...(hasFrontend ? [] : [['FRONTEND', /frontend\.md/]]),
];
/**
 * 原样拷贝的通用契约：它们按设计在所有项目里内容相同（引擎同理），
 * 讲「更新包/全量包」是在讲**客户端项目该怎么处理它们**，不是本项目的组件泄漏。
 * 特征串检查针对的是**模板** —— 模板里漏了 {{#if}} 才是 bug。
 */
const copiedGeneric = new Set([
    ...wantedReferences.map((name) => join(target, 'references', name)),
    ...wantedAssets.map((name) => join(target, 'assets', name)),
]);

(function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
            // 引擎是通用代码，按设计同时服务有/无客户端的项目，不参与特征串检查
            if (entry.name !== 'engine') scan(full);
            continue;
        }
        // 待确认清单是自由文本（用户/生成者写的欠账描述），里头出现 {{...}} 是正常的引用，不参与残留检查
        if (entry.name === 'PENDING-CONFIRMATIONS.md') continue;
        if (!['.md', '.json', '.mjs', '.ps1', '.tmpl', '.iss'].includes(extname(entry.name))) continue;
        const content = readFileSync(full, 'utf8');
        // 用 ANY_MUSTACHE 而不是 PLACEHOLDER：`{{#if}}` 这类条件段残留也必须被拦住（理由见其定义处）
        for (const match of content.matchAll(ANY_MUSTACHE)) residue.push(`${full.slice(target.length + 1)} → ${match[0]}`);
        if (copiedGeneric.has(full)) continue;
        for (const [label, pattern] of disabledMarkers) {
            if (pattern.test(content)) featureLeaks.push(`${full.slice(target.length + 1)} 提到 ${label} 的内容，但该组件未启用`);
        }
    }
})(target);

if (residue.length > 0) {
    fail(
        `生成物里有未替换的模板标记：\n  ${residue.join('\n  ')}\n\n` +
            `出现 {{#if ...}} / {{/if}} 通常是**条件段配错了对**：渲染用的正则非贪婪，` +
            `一段里嵌另一段会在第一个 {{/if}} 处提前收尾，剩下的原样漏进产物。` +
            `模板里不要嵌套条件段 —— 把内层写成单行、或者拆成两个开关。`,
    );
}
ok('无模板标记残留');

if (featureLeaks.length > 0) {
    warn(`声明了「未启用就不出现」，但生成物里仍有相关字样：\n  ${featureLeaks.join('\n  ')}\n  检查模板里是否漏了 {{#if ...}} 条件段。`);
} else {
    ok('未启用的组件没有泄漏到生成物里');
}

// 客户端项目的关键文件多两份：清单契约与清理脚本用到的发布计划格式都写在里面
const criticals = ['SKILL.md', 'release.config.json', 'scripts/engine/release-manifest.mjs'];
if (hasClient) criticals.push('references/manifest-contract.md');
for (const check of criticals) {
    if (!existsSync(join(target, check))) fail(`生成物缺少 ${check}。`);
}
ok('关键文件齐全');

// ---- 悬空引用：生成物里指向的 references/ 与 assets/ 必须真的存在 ----
//
// 这是「模板没随组件收敛」最典型的症状，而且比关键词扫描准得多：它不看措辞，只看引用有没有落点。
// 危害在于**没有任何脚本会因此报错** —— 读者照着引用去翻，翻不到（实测：无客户端的项目，
// 生成物的 SKILL.md 里留着三份根本没被拷贝的契约文档；一份数据库文档里还留着「与客户端的关系」一节）。
/** 生成物会产出的 references 文件名 —— 从模板清单推导，不是手写名单（少一个就会漏判）。 */
const generatedReferenceNames = new Set([
    ...writes.map((write) => write.target).filter((target) => target.startsWith('references/')).map((target) => target.split('/').pop()),
    ...wantedReferences,
]);

const referenced = new Set();
(function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'engine') collect(full);
            continue;
        }
        if (!['.md', '.ps1', '.mjs', '.json'].includes(extname(entry.name))) continue;
        const content = readFileSync(full, 'utf8');
        for (const match of content.matchAll(/\breferences\/[A-Za-z0-9._-]+\.md/g)) referenced.add(match[0]);
        for (const match of content.matchAll(/\bassets\/[A-Za-z0-9._/-]+\.(?:md|iss|json)/g)) referenced.add(match[0]);
        // 光写文件名（`` `client.md` ``）的引用也要算 —— 实测有文档就是**裸文件名**引用了一份
        // 没被拷贝的文档，只查 `references/xxx.md` 的写法没抓住它。
        for (const match of content.matchAll(/`([A-Za-z0-9._-]+\.md)`/g)) {
            if (generatedReferenceNames.has(match[1])) referenced.add(`references/${match[1]}`);
        }
    }
})(target);

const dangling = [...referenced].filter((relativePath) => !existsSync(join(target, relativePath)));
if (dangling.length > 0) {
    fail(
        `生成物里有指向不存在文件的引用（模板漏了 {{#if ...}} 条件段）：\n  ${dangling.join('\n  ')}\n\n` +
            `多半是某个组件被禁用后，它的文档没被拷贝，但别处的引用还在。` +
            `把那段引用也放进对应的条件段里。`,
    );
}
ok(`引用的文档与资产都真实存在（${referenced.size} 处引用）`);

// ---- 悬空引用（脚本侧）：渲染出的命令里点名的 scripts/ 必须真的落在生成物里 ----
//
// 与上一条是同一个故障的两半：模板漏了 {{#if}} 时，文档的引用指着不存在的文档，
// **命令**的引用则指着不存在的脚本 —— 后者更糟，读者照着敲只会得到「找不到文件」，
// 而文档里那句「本技能目录里没有那个脚本」的免责说明救不了命令。
//
// 只查**渲染产物**：references/*.md 与 assets/*.iss 是原样拷贝过来的，里面提到的
// feima 的 Publish-Release.ps1 / Sync-Skills.ps1 是**来源出处**，不是给本技能读者的命令，
// 拿它们判悬空只会逼着大家把出处删掉。
// 引擎引用按 SKILL_ROOT 判 —— 它是整块拷过去的，模板里写 scripts/engine/xxx
// 只要在元技能里存在，落地后必然也在（--update-engine 除外，那条路径不渲染）。
const danglingScripts = [];
for (const write of writes) {
    const content = readFileSync(join(target, write.target), 'utf8');
    for (const match of content.matchAll(/\bscripts\/[A-Za-z0-9._/-]+\.(?:mjs|ps1|py|cmd|iss)/g)) {
        const ref = match[0];
        const landed = ref.startsWith('scripts/engine/') ? join(SKILL_ROOT, ref) : join(target, ref);
        if (!existsSync(landed)) danglingScripts.push(`${write.target} → ${ref}`);
    }
}
if (danglingScripts.length > 0) {
    fail(
        `生成物里的命令指向不存在的脚本（模板漏了 {{#if ...}} 条件段）：\n  ${danglingScripts.join('\n  ')}\n\n` +
            `多半是某个组件被禁用后它的脚本没生成，而别处的命令还在。把那条命令也放进对应的条件段里。`,
    );
}
ok(`渲染出的命令引用的脚本都存在（${writes.length} 个模板文件）`);

// ---- 比对模式：渲染结果 vs 现有技能，只报告不落盘 ----
if (diffMode) {
    const differences = reportDiff(outDir, staging);
    rmSync(staging, { recursive: true, force: true });
    info('');
    if (differences === 0) {
        ok('现有技能与当前模板渲染的结果一致，没有要改的。');
        process.exit(0);
    }
    warn(`共 ${differences} 处差异。要按当前模板重渲染：加 --adopt（会先备份现有目录）。`);
    info(dim('  只升级引擎不动别的：--update-engine'));
    process.exit(2); // 非 0：调用方（脚本/CI）据此知道「有差异需要处理」
}

info('');
ok(existsAlready ? `已更新：${outDir}` : `已生成：${outDir}`);
info(`  下一步：node ${join(outDir, 'scripts', 'engine', 'release-sync.mjs')} --repo ${config.__repoRoot} --check`);

/**
 * 逐文件比对「现有技能」与「刚渲染出来的结果」，返回差异处数。
 *
 * 为什么不直接整体覆盖：优化已有的技能时，真正要保住的恰恰是**项目在上面做过的改动** ——
 * 自己加的脚本、手改过的文档。`--force` 一把梭会把这些一起冲掉，而且事后无从分辨。
 * 所以先把差异摆出来（新增 / 更新 / 仅现有），再由人决定要不要写回去。
 *
 * `scripts/engine/` 不逐个列：它整块由本技能维护，生成物里明确写了「不要手改」，
 * 所以只报一份整体指纹就够。
 */
function reportDiff(existingDir, freshDir) {
    const list = (root) =>
        listRelativeFiles(root).filter((relativePath) => !relativePath.startsWith('scripts/engine/'));
    const bytes = (root, relativePath) => {
        try {
            return readFileSync(join(root, relativePath));
        } catch {
            return null;
        }
    };

    const existing = list(existingDir);
    const fresh = list(freshDir);
    const existingSet = new Set(existing);
    const freshSet = new Set(fresh);

    const added = fresh.filter((relativePath) => !existingSet.has(relativePath));
    const onlyExisting = existing.filter((relativePath) => !freshSet.has(relativePath));
    const changed = [];
    let same = 0;
    for (const relativePath of fresh) {
        if (!existingSet.has(relativePath)) continue;
        const before = bytes(existingDir, relativePath);
        const after = bytes(freshDir, relativePath);
        if (before && after && before.equals(after)) same += 1;
        else changed.push(relativePath);
    }

    const engineBefore = treeHash(join(existingDir, 'scripts', 'engine'));
    const engineAfter = treeHash(join(freshDir, 'scripts', 'engine'));

    step('差异（现有技能 → 当前模板渲染的结果）');
    for (const relativePath of added) info(`  ${green('新增')}    ${relativePath}`);
    for (const relativePath of changed) info(`  ${yellow('更新')}    ${relativePath}`);
    for (const relativePath of onlyExisting) {
        info(`  ${red('仅现有')}  ${relativePath}  ← 重渲染不会再产出它，确认是不是项目自加的`);
    }
    info(`  ${dim(`一致`)}    ${same} 个文件内容没变`);
    if (engineBefore === engineAfter) {
        info(`  ${dim('一致')}    scripts/engine/`);
    } else {
        info(`  ${yellow('更新')}    scripts/engine/（整块替换：${engineBefore.slice(0, 12)} → ${engineAfter.slice(0, 12)}）`);
    }
    return added.length + changed.length + onlyExisting.length + (engineBefore === engineAfter ? 0 : 1);
}