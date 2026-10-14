#!/usr/bin/env node
// 变更检测与发版计划。零依赖，Node >= 20.12。
//
//   node release-changes.mjs --config <release.config.json> [--base <git-ref>] [--fetch]
//                            [--force <c1,c2>] [--force-full] [--with-installer]
//                            [--force-stale] [--require-clean] [--json] [--out plan.json]
//
// 它回答两个问题：**这次哪些组件要重新构建**、**客户端要不要出全量包**。
//
// 判定是两段式的：git 说「可能变了」，内容指纹说「真的变了」。只看 git 会把「改了又改回来」
// 也当成变更（白白重出一次全量包），只看指纹则发现不了「同名文件内容没变但语义依赖它」的情况。
// 两段都过才算变更。
//
// 阶段 0 的**代码同步门禁**也在本脚本里：本地落在上游之后就直接拒绝继续。

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { loadConfig, normalizeGlobs, releaseFile } from './lib/config.mjs';
import { loadState } from './lib/state.mjs';
import { matchesAny, sha256Text, subsetHash } from './lib/tree-hash.mjs';
import { dim, fail, green, info, ok, parseArgs, printJson, requireFlag, step, warn, yellow } from './lib/cli.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const configPath = requireFlag(flags, 'config', '指向 <repo>/release/release.config.json。');
const config = loadConfig(configPath);
const repoRoot = config.__repoRoot;

/** 内容指纹要跳过的目录：第三方依赖与构建产物，体量大且不属于「源」。 */
const EXCLUDED_PREFIXES = ['node_modules/', 'bin/', 'obj/', 'dist/', 'build/', 'out/', '.git/', '.vs/', '__pycache__/', 'target/'];

function isSourcePath(relativePath) {
    return !EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix) || relativePath.includes(`/${prefix}`));
}

function git(args, { allowFailure = false } = {}) {
    try {
        return execFileSync('git', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            // stderr 收进来，不让 git 自己的话直接漏到终端：allowFailure 的那些调用失败是**预期内**的
            // （无上游、还没打过 tag），git 会打出 `fatal: no upstream configured`，
            // 紧贴在我们「跳过落后检测」的提示上面，看着像出了事。真正的失败仍会带着 stderr 报出去。
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        if (allowFailure) return '';
        fail(`git ${args.join(' ')} 执行失败：${error.stderr?.toString().trim() || error.message}`);
    }
}

// ---------------------------------------------------------------------------
// 阶段 0：代码同步门禁
// ---------------------------------------------------------------------------

/**
 * 发版前必须同步代码 —— 别的机器/同事刚推的提交不在本地时，**发出去的就是一个漏了改动的包**，
 * 而收到这个包的用户此后不会再收到那批改动（版本号已经前进）。所以本地落在上游之后就直接拒绝。
 *
 * --no-fetch 跳过拉取（离线环境），--force-stale 强行放行（会在输出里留下显式警告）。
 */
function checkSyncGate() {
    // 不是 git 仓库就到此为止。整个发版流程都建立在「tag 基准 + 提交区间」上 ——
    // 在这里降级成「首次发版」会产出一份看着正常、实则没有任何基准可比的计划，
    // 而后面每个阶段的 diff 都无从做起。宁可现在停。
    if (!git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).trim()) {
        fail('当前目录不是 git 仓库。发版要用 tag 与提交区间做变更检测，先在项目里 git init 并提交一次。');
    }

    if (!flags['no-fetch']) {
        step('拉取远端（git fetch --all --prune）');
        git(['fetch', '--all', '--prune'], { allowFailure: true });
    }

    let upstream = '';
    let behind = 0;
    let ahead = 0;
    let checked = true;
    // rev-parse/rev-list 必须带 allowFailure：git() 失败时是直接 fail() 退进程，而不是抛异常，
    // 裸调会让下面的 catch 兜底永远轮不到 —— 实测：无上游的仓库（首次发版、或 release 分支
    // 还没 push）会在阶段 1 直接挂掉，设计好的「跳过落后检测 + 警告」一次也不会出现。
    try {
        upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true }).trim();
        if (!upstream || upstream === '@{u}') throw new Error('no upstream');
        behind = Number(git(['rev-list', '--count', `HEAD..${upstream}`], { allowFailure: true }).trim());
        ahead = Number(git(['rev-list', '--count', `${upstream}..HEAD`], { allowFailure: true }).trim());
        if (!Number.isFinite(behind) || !Number.isFinite(ahead)) throw new Error('behind/ahead 解析失败');
    } catch {
        checked = false;
        warn('当前分支没有配置上游，跳过「是否落后」检测。发版前请自行确认代码已同步。');
    }

    const dirty = git(['status', '--porcelain']).split('\n').filter((line) => line.trim() !== '');

    if (checked && behind > 0 && !flags['force-stale']) {
        const commits = git(['log', '--oneline', `HEAD..${upstream}`]).trim();
        fail(
            `本地落后 ${upstream} ${behind} 个提交，拒绝继续发版。\n` +
                `带着旧代码发版 = 发出一个漏了改动的包，而收到它的用户不会再收到那批改动。\n\n` +
                `${commits}\n\n先合并远端改动（逐段合并双方意图，别整文件覆盖队友），再重跑本脚本。\n` +
                `确实要跳过：加 --force-stale（会在报告里留下警告）。`,
        );
    }

    if (dirty.length > 0) {
        const message = `工作区有 ${dirty.length} 处未提交改动。`;
        if (flags['require-clean']) fail(`${message}\n--require-clean 下不允许发版。先提交或暂存。`);
        warn(`${message} 发版前先核对范围并备份，不要把队友的无关改动混进本次发布。`);
    }

    return { upstream, behind, ahead, checked, dirty: dirty.length > 0, dirtyFiles: dirty.slice(0, 50) };
}

const gate = checkSyncGate();

// ---------------------------------------------------------------------------
// 基准 tag
// ---------------------------------------------------------------------------

const statePath = typeof flags.state === 'string' ? flags.state : releaseFile(config, 'release-state.json');
const state = loadState(statePath);

function resolveBase() {
    if (typeof flags.base === 'string') return { ref: flags.base, source: '--base' };
    if (state?.lastReleaseTag) return { ref: state.lastReleaseTag, source: '发版状态' };
    const described = git(['describe', '--tags', '--abbrev=0'], { allowFailure: true }).trim();
    if (described) return { ref: described, source: 'git describe' };
    return { ref: '', source: '没有基准' };
}

const base = resolveBase();
const head = git(['rev-parse', '--short', 'HEAD']).trim();

// 没有基准 = 首次发版（或标签丢了）：全部当成需要产出，fail-closed。
const firstRelease = base.ref === '';
if (firstRelease) {
    warn('找不到上次发版的标签/状态，按「首次发版」处理：所有组件都视为需要产出。');
} else {
    // 确认基准 ref 真的存在，否则 git diff 会静默退化成「全部文件都算变更」
    const exists = git(['rev-parse', '--verify', '--quiet', `${base.ref}^{commit}`], { allowFailure: true }).trim();
    if (!exists) fail(`基准 ${base.ref}（来自${base.source}）在本地不存在，先 git fetch --tags 补齐。`);
}

const changedFiles = firstRelease ? null : git(['diff', '--name-only', `${base.ref}..HEAD`]).split('\n').filter((line) => line !== '');
const addedFiles = firstRelease ? null : git(['diff', '--diff-filter=A', '--name-only', `${base.ref}..HEAD`]).split('\n').filter((line) => line !== '');
const filesAtBase = firstRelease ? new Set() : new Set(git(['ls-tree', '-r', '--name-only', base.ref]).split('\n').filter((line) => line !== ''));

/** 新增目录：在 HEAD 里有、在基准里没人用过的目录。目录结构变化会让增量覆盖解不全，必须转全量。 */
function newDirectories() {
    if (firstRelease) return [];
    const knownDirectories = new Set();
    for (const file of filesAtBase) {
        const parts = file.split('/');
        for (let i = 1; i < parts.length; i += 1) knownDirectories.add(parts.slice(0, i).join('/'));
    }
    const result = new Set();
    for (const file of addedFiles) {
        const parts = file.split('/');
        for (let i = 1; i < parts.length; i += 1) {
            const directory = parts.slice(0, i).join('/');
            if (!knownDirectories.has(directory)) result.add(directory);
        }
    }
    return [...result].sort();
}

const newDirs = newDirectories();

// ---------------------------------------------------------------------------
// 逐组件判定
// ---------------------------------------------------------------------------

const COMPONENTS = ['database', 'backend', 'frontend', 'client'];
const forced = typeof flags.force === 'string' ? flags.force.split(',').map((name) => name.trim()) : [];

const components = {};
for (const name of COMPONENTS) {
    const component = config.components?.[name];
    if (!component || component.enabled === false) {
        components[name] = { enabled: false, changed: false };
        continue;
    }
    const globs = normalizeGlobs(component.globs);
    const hits = firstRelease ? [] : changedFiles.filter((file) => matchesAny(file, globs));

    // 内容指纹：与上次发版时记下的比。git 说变了但指纹一样 = 改了又改回来，不必重出。
    const fingerprint = subsetHash(repoRoot, (file) => matchesAny(file, globs) && isSourcePath(file));
    const previousFingerprint = state?.componentFingerprints?.[name];
    const fingerprintChanged = previousFingerprint === undefined ? true : previousFingerprint !== fingerprint;

    const forcedByName = forced.includes(name) || flags.force === true;
    components[name] = {
        enabled: true,
        changed: firstRelease || forcedByName || (hits.length > 0 && fingerprintChanged),
        changedFiles: hits.length,
        fingerprintChanged,
        fingerprint,
        forced: forcedByName,
        sample: hits.slice(0, 20),
    };
    if (hits.length > 0 && !fingerprintChanged) {
        warn(`组件 ${name}：git 显示 ${hits.length} 个文件变过，但内容指纹与上次发版一致（改动被回退过），本次不重建。`);
    }
}

// ---- 客户端更新包 / 全量包 / 安装包 ----
const clientConfig = config.components?.client;
let client = { payload: { needed: false }, full: { needed: false, reason: '', evidence: [] }, installer: { needed: false } };

if (clientConfig && clientConfig.enabled !== false) {
    const businessGlobs = normalizeGlobs(clientConfig.businessGlobs);
    const runtimeGlobs = normalizeGlobs(clientConfig.runtimeGlobs ?? []);
    const structureGlobs = normalizeGlobs(clientConfig.structureGlobs ?? []);

    // 更新包 = 业务文件全集，每次发版都要跟着走（否则客户端停在旧业务代码上）
    const payloadHits = firstRelease ? [] : changedFiles.filter((file) => matchesAny(file, businessGlobs));
    const payloadNeeded = components.client.changed;

    // 全量包的三个触发条件 + 人工开关。**方向不能反**：读不到基线时按全量处理 ——
    // 全量对客户端永远安全（代价是一次性下载），猜成只发更新包可能让客户端启动即崩。
    const evidence = [];
    let fullNeeded = false;
    let reason = '';

    const runtimeHits = firstRelease ? [] : changedFiles.filter((file) => matchesAny(file, runtimeGlobs));
    const structureHits = firstRelease ? [] : changedFiles.filter((file) => matchesAny(file, structureGlobs));
    const clientGlobs = normalizeGlobs(clientConfig.globs);
    const newBusinessDirs = newDirs.filter((directory) => matchesAny(`${directory}/x`, clientGlobs));

    if (runtimeHits.length > 0) {
        fullNeeded = true;
        reason = 'runtime-deps';
        evidence.push(...runtimeHits.slice(0, 20));
    } else if (structureHits.length > 0) {
        fullNeeded = true;
        reason = 'structure';
        evidence.push(...structureHits.slice(0, 20));
    } else if (newBusinessDirs.length > 0) {
        fullNeeded = true;
        reason = 'structure';
        evidence.push(...newBusinessDirs.map((directory) => `${directory}/（新增目录）`));
    } else if (!state?.clientFullBaseline && !firstRelease) {
        // 基线不可知：宁可多发一次全量，也不要猜
        fullNeeded = true;
        reason = 'unknown-baseline';
        evidence.push('发版状态里没有 clientFullBaseline，无法确认客户端基线');
    } else if (flags['force-full']) {
        fullNeeded = true;
        reason = 'manual';
        evidence.push('命令行 --force-full');
    }

    client = {
        payload: { needed: payloadNeeded, changedFiles: payloadHits.length, sample: payloadHits.slice(0, 20) },
        full: { needed: fullNeeded, reason, evidence: evidence.slice(0, 40) },
        // 安装包与全量包同源（都含运行时基线），全量时一并重出；--with-installer 可强制
        installer: { needed: fullNeeded || Boolean(flags['with-installer']) },
    };
    if (!clientConfig.runtimeGlobs?.length) {
        warn('components.client.runtimeGlobs 是空的：换运行时/依赖的变更将无法自动识别为全量，只能靠 --force-full。');
    }
}

// ---------------------------------------------------------------------------
// 计划输出
// ---------------------------------------------------------------------------

const buildMatrix = [];
for (const name of ['database', 'backend', 'frontend']) {
    if (components[name]?.changed) buildMatrix.push(name);
}
if (components.client?.changed) buildMatrix.push('client-payload');
if (client.full.needed) buildMatrix.push('client-full');
if (client.installer.needed) buildMatrix.push('client-installer');

const plan = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    repoRoot,
    base: base.ref,
    baseSource: base.source,
    head,
    firstRelease,
    gate,
    components,
    client,
    buildMatrix,
    inputFingerprint: sha256Text(JSON.stringify({ base: base.ref, head, buildMatrix })),
};

if (typeof flags.out === 'string') {
    writeFileSync(flags.out, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    ok(`发版计划已写入 ${flags.out}`);
}

if (flags.json) {
    printJson(plan);
    process.exit(0);
}

info(`基准 ${base.ref || '（无）'}（${base.source}） → HEAD ${head}`);
info('');
for (const name of COMPONENTS) {
    const component = components[name];
    if (!component?.enabled) continue;
    const verdict = component.changed ? green('需要') : dim('不变');
    const note = component.forced ? dim('（--force）') : dim(`${component.changedFiles} 个文件命中`);
    info(`  ${name.padEnd(10)} ${verdict}  ${note}`);
}
info('');
if (components.client?.enabled) {
    info(`  客户端更新包  ${client.payload.needed ? green('需要') : dim('不变')}`);
    const fullVerdict = client.full.needed ? yellow('需要（全量）') : dim('不需要');
    info(`  客户端全量包  ${fullVerdict}${client.full.reason ? dim(`  原因 ${client.full.reason}`) : ''}`);
    info(`  客户端安装包  ${client.installer.needed ? green('需要') : dim('不重出')}`);
    if (client.full.needed) {
        for (const line of client.full.evidence.slice(0, 10)) info(`      ${dim('触发')} ${line}`);
    }
}
info('');
ok(`构建矩阵：${buildMatrix.length > 0 ? buildMatrix.join(', ') : '（本次无需构建任何组件）'}`);