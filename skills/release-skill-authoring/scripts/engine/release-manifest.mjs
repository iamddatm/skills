#!/usr/bin/env node
// 生成并校验更新清单（manifest.json）。零依赖，Node >= 20.12。
//
//   node release-manifest.mjs --config <release.config.json> --artifacts <artifacts.json>
//        [--out <manifest.json>] [--state <release-state.json>] [--version <v>] [--notes <文本>]
//        [--min-version <v>] [--full-reason <runtime-deps|structure|assets|manual>]
//        [--rand <12位hex>] [--history-dir <dir>] [--dry-run]
//
// 三件事按顺序做完才允许发布：
//   1. 给每个包算 sha256/体积，并按「随机 hash」命名（每次发布新 URL，绕开 CDN 旧缓存）；
//   2. 拼出清单，**用 Pascal 算法回读校验**（assertPascalParsable）—— 读不通就别发布；
//   3. 版本单调守卫：拒绝写出不高于上次的版本号（客户端只认「版本更高」，写低了等于白发）。
//
// 清单里的 file / fullFile 是**相对清单所在目录的路径**（如 p/xxx.tar.gz），不是绝对 URL：
// 这样换 CDN 域名时清单本身不用改，客户端与安装包各自把清单 URL 的目录接在前面即可。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { loadConfig, releaseFile } from './lib/config.mjs';
import { emptyState, loadState, saveState } from './lib/state.mjs';
import { sha256File } from './lib/tree-hash.mjs';
import { isVersion, compareVersions } from './lib/version.mjs';
import { assertPascalParsable, parseManifest, serializeManifest } from './lib/flat-json.mjs';
import { fail, info, ok, parseArgs, requireFlag, step, warn } from './lib/cli.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const configPath = requireFlag(flags, 'config', '指向 <repo>/release/release.config.json。');
const artifactsPath = requireFlag(flags, 'artifacts', '打包阶段产出的产物清单（JSON）。');
const config = loadConfig(configPath);
const statePath = typeof flags.state === 'string' ? flags.state : releaseFile(config, 'release-state.json');
const state = loadState(statePath) ?? emptyState();

if (!existsSync(artifactsPath)) fail(`找不到产物清单：${artifactsPath}`);
const artifacts = JSON.parse(readFileSync(artifactsPath, 'utf8'));

/** 每次发布新生成的随机 hash。它只负责「URL 每次都变」以绕开 CDN 缓存，与包内容无关。 */
function makeRandom() {
    if (typeof flags.rand === 'string') {
        if (!/^[0-9a-f]{12}$/.test(flags.rand)) fail(`--rand 必须是 12 位小写 hex，收到 ${flags.rand}`);
        return flags.rand;
    }
    return randomBytes(6).toString('hex');
}
const rand = makeRandom();

const channel = typeof flags.channel === 'string' ? flags.channel : config.manifest.channel;

/**
 * 发布用文件名：<slug>-<kind>-<rand12><ext>。加了随机 hash，CDN 不会命中旧包。
 *
 * 扩展名取 basename 里**第一个点之后**的全部内容：`app-payload.tar.gz` → `.tar.gz`。
 * 用 extname 会得到 `.gz`，发出去的文件就成了「一个 gzip 文件」而不是「一个 tar 包」——
 * 客户端与运维都会误判该怎么解，排障时多绕一圈。
 */
function publishExtension(sourcePath) {
    const name = basename(sourcePath);
    const firstDot = name.indexOf('.');
    if (firstDot < 0) fail(`产物 ${sourcePath} 没有扩展名，无法拼发布文件名。`);
    return name.slice(firstDot);
}

function publishedName(kind, sourcePath) {
    return `${config.project.slug}-${kind}-${rand}${publishExtension(sourcePath)}`;
}

/** 相对清单目录的路径（清单里就写这个）。 */
function publishedPath(kind, sourcePath) {
    const directory = kind === 'full' ? 'f' : kind === 'payload' ? 'p' : 'i';
    return `${directory}/${publishedName(kind, sourcePath)}`;
}

function describe(kind, sourcePath) {
    if (typeof sourcePath !== 'string' || sourcePath === '') fail(`产物 ${kind} 的路径为空。`);
    if (!existsSync(sourcePath)) fail(`产物 ${kind} 不存在：${sourcePath}`);
    return { path: sourcePath, name: basename(sourcePath), sha256: sha256File(sourcePath), size: statSync(sourcePath).size };
}

step('计算产物哈希与体积');
const payload = describe('payload', artifacts.payload);
const full = artifacts.full ? describe('full', artifacts.full) : null;
if (full) info(`  全量包 ${full.name} → ${publishedName('full', full.path)} (${full.sha256.slice(0, 12)})`);
info(`  更新包 ${payload.name} → ${publishedName('payload', payload.path)} (${payload.sha256.slice(0, 12)})`);

// ---- 版本号：必须显式给 ----
//
// 这里**不能**回退到 state.versions.client：那个槽位是「上次已发布的版本」，
// 拿它当本次版本号，下面的同版本守卫就会拿同一个值跟自己比，恒定报「同版本禁止重发」——
// 一条永远走不通的死路。本次版本号只有一个来源：release-version.mjs --print 的输出。
const version = typeof flags.version === 'string' ? flags.version : '';
if (!isVersion(version)) {
    fail(
        `缺少 --version，或不是四段纯数字版本号：${JSON.stringify(version)}。\n` +
            `先取号：NEXT=$(node scripts/engine/release-version.mjs --config <cfg> --print)\n` +
            `再传进来：--version "$NEXT"。`,
    );
}

// ---- 版本单调守卫：只前进，不后退，也不原地踏步 ----
//
// --standalone 会跳过它：那个模式是给「本机伪源验证 / 预览清单长什么样」用的，
// 不写状态、不写归档，所以也不需要发布守卫。**正式发版绝不要加这个参数。**
if (!flags.standalone && isVersion(state.versions?.client)) {
    const delta = compareVersions(version, state.versions.client);
    if (delta === 0 && !flags['allow-rewrite']) {
        fail(
            `版本号 ${version} 与上次发版相同。同版本禁止重发（客户端会认成「没更新」）。\n` +
                `要修内容就抬一下自增数再发；确实要覆盖同版本用 --allow-rewrite（仅限调试）。`,
        );
    }
    if (delta < 0 && !flags['allow-rewrite']) {
        fail(
            `版本号 ${version} 低于上次发版的 ${state.versions.client}。客户端只认「版本更高」，写低了等于白发。\n` +
                `确要回退内容：用更高版本号前滚重发，不要调小版本号。`,
        );
    }
}

const notes = typeof flags.notes === 'string' ? flags.notes : artifacts.notes;
if (typeof notes !== 'string' || notes.trim() === '') {
    fail(
        '缺少本次更新说明（--notes 或产物清单里的 notes 字段）。\n' +
            '它就是要显示在客户端更新卡片上给用户看的文字，不能省略 —— 省略后不少流程会拿 git 提交标题兜底，' +
            '而那通常是「文档:…」这类不该给用户看的内容。',
    );
}

const minVersion = typeof flags['min-version'] === 'string' ? flags['min-version'] : state.clientMinVersion || version;
if (!isVersion(minVersion)) fail(`最低支持版本不是四段号：${JSON.stringify(minVersion)}`);

const manifest = {
    schema: 1,
    channel,
    releaseId: artifacts.releaseId ?? `${new Date().toISOString().slice(0, 10)}.${(state.clientSeq ?? 0) + 1}`,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    version,
    type: 'payload',
    file: publishedPath('payload', payload.path),
    sha256: payload.sha256,
    size: payload.size,
    notes,
    seq: (state.clientSeq ?? 0) + 1,
    minVersion,
};

if (full) {
    manifest.fullFile = publishedPath('full', full.path);
    manifest.fullSha256 = full.sha256;
    manifest.fullSize = full.size;
    manifest.reason = typeof flags['full-reason'] === 'string' ? flags['full-reason'] : (artifacts.fullReason ?? 'manual');
}

const database = artifacts.database;
if (database) {
    manifest.databaseVersion = database.version;
    manifest.databaseIrreversible = Boolean(database.irreversible);
}
const backend = artifacts.backend;
if (backend) {
    manifest.backendVersion = backend.version;
    if (backend.apiMinClient) manifest.backendApiMinClient = backend.apiMinClient;
    manifest.backendEndpointsRemoved = backend.endpointsRemoved ?? '';
}
const frontend = artifacts.frontend;
if (frontend) {
    manifest.frontendVersion = frontend.version ?? version;
    if (frontend.path) {
        const described = describe('frontend', frontend.path);
        manifest.frontendFile = publishedPath('payload', frontend.path);
        manifest.frontendSha256 = described.sha256;
    }
}

// full 块必须排在所有顶层字段之后 —— serializeManifest 会保证顺序，这里只负责在漏写时报错
if (full) manifest.full = { version };

step('生成扁平清单');
const text = serializeManifest(manifest);

step('Pascal 可解析性校验（模拟安装包侧的读法）');
try {
    assertPascalParsable(text, manifest);
} catch (error) {
    fail(`清单通不过 Pascal 可解析性校验，**不要发布**：\n${error.message}`);
}
ok('清单可被安装包的 Pascal 代码正确读取');

if (flags['dry-run']) {
    info('');
    info(text);
    warn('--dry-run：清单只打印，不写文件、不改状态、不发布。');
    process.exit(0);
}

const outPath = typeof flags.out === 'string' ? flags.out : releaseFile(config, 'manifest.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, text, 'utf8');
ok(`清单已写入 ${outPath}`);

// 发布计划：把「本地产物 → 发布后的相对路径」这本账交出去。
//
// 为什么必须有它：发布文件名（带随机 hash）是**在这里**才定下来的，上传方与伪源不可能自己推出来。
// 少了这本账，上传时就得靠猜或复刻命名规则 —— 而两份实现一旦漂移，就会出现
// 「清单指向 A、服务器上是 B」这种客户端永远更新不了的事故。
const publishPlan = [
    { kind: 'payload', source: resolve(payload.path), published: manifest.file, sha256: payload.sha256, size: payload.size },
];
if (full) {
    publishPlan.push({ kind: 'full', source: resolve(full.path), published: manifest.fullFile, sha256: full.sha256, size: full.size });
}
for (const [kind, relative] of [['installer', artifacts.installer], ['frontend', artifacts.frontend?.path]]) {
    if (typeof relative === 'string' && relative) {
        const described = describe(kind, relative);
        publishPlan.push({ kind, source: resolve(relative), published: publishedPath(kind, relative), sha256: described.sha256, size: described.size });
    }
}
const planPath = typeof flags['publish-plan'] === 'string'
    ? flags['publish-plan']
    : join(dirname(outPath), 'publish-plan.json');
mkdirSync(dirname(planPath), { recursive: true });
writeFileSync(planPath, `${JSON.stringify({ schema: 1, manifest: outPath, files: publishPlan }, null, 2)}\n`, 'utf8');
ok(`发布计划已写入 ${planPath}（上传方按它把本地文件放到清单里写的路径上）`);

if (flags.standalone) {
    warn('--standalone：只写了清单文件，没有改发版状态、没有写归档、跳过了发布守卫。别拿这个模式发版。');
} else {
    // 历史归档：永不覆盖，供回滚与审计
    const historyDir = typeof flags['history-dir'] === 'string' ? flags['history-dir'] : releaseFile(config, 'history');
    if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true });
    const historyPath = join(historyDir, `${manifest.releaseId}.manifest.json`);
    if (existsSync(historyPath) && !flags['allow-rewrite']) {
        fail(`历史归档里已有 ${manifest.releaseId}，拒绝覆盖（同名发布说明这次撞上了上次的版本）。`);
    }
    writeFileSync(historyPath, text, 'utf8');

    // 发布计划也要归档 —— `release-prune` 靠它判断「哪些构建产物还要用」，
    // 而历史清单本身**不含文件名清单**（文件名带随机 hash，只有计划里记着）。
    // 只归档清单的话，清理那一步永远找不到计划，于是 dist 永不清理 ——
    // 而且脚本会打印「没有可用的发布计划」然后什么都不做，看着完全像正常。
    const historyPlanPath = join(historyDir, `${manifest.releaseId}.publish-plan.json`);
    writeFileSync(
        historyPlanPath,
        `${JSON.stringify({ schema: 1, manifest: historyPath, files: publishPlan }, null, 2)}\n`,
        'utf8',
    );

    state.lastReleaseId = manifest.releaseId;
    state.releasedAt = manifest.generatedAt;
    state.versions = { ...state.versions, client: version };
    state.clientSeq = manifest.seq;
    state.clientMinVersion = minVersion;
    if (full) state.clientFullBaseline = version;
    state.artifacts = Object.entries({ payload, full, ...(artifacts.installer ? { installer: describe('installer', artifacts.installer) } : {}) })
        .filter(([, value]) => value)
        .map(([kind, value]) => ({ kind, path: publishedPath(kind, value.path), sha256: value.sha256, size: value.size, source: value.path }));
    saveState(statePath, state);
    ok(`发版状态已更新（seq=${manifest.seq}，客户端版本 ${version}${full ? `，全量基线 ${version}` : ''}）`);
}

// 把清单读回来一遍，确认写出去的东西能被自己读回（防止「写对了但序列化有坑」）
const reread = parseManifest(text);
if (reread.version !== version) fail(`清单回读得到 version=${reread.version}，与预期 ${version} 不一致。`);