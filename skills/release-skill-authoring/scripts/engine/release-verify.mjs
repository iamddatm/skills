#!/usr/bin/env node
// 发版后的线上体检。零依赖，Node >= 20.12。
//
//   node release-verify.mjs --config <release.config.json> [--manifest <url>]
//        [--check-sha] [--no-cache-check] [--json]
//
// 上传完不等于发版成功。这个脚本回答「用户那边现在能不能正常更新」：
//   1. 清单拉得到、且能被 Pascal 侧正确解析（解析不了 = 所有客户端都更新不了）；
//   2. 清单里点名的每个包都真的能下到，体积与清单一致（可选：实测 sha256）；
//   3. 缓存头对：清单与**固定文件名的产物**必须 no-store；带随机 hash 的包必须长缓存 ——
//      反了就会出现「新包永远命中旧缓存」（固定名）或「每次下载都回源」（随机名）；
//   4. 版本没有倒退。
//
// 全程只读远端，不改任何东西。

import { createHash } from 'node:crypto';
import { loadConfig, releaseFile } from './lib/config.mjs';
import { loadState } from './lib/state.mjs';
import { assertPascalParsable, parseManifest } from './lib/flat-json.mjs';
import { compareVersions } from './lib/version.mjs';
import { fail, info, ok, parseArgs, printJson, warn } from './lib/cli.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const config = loadConfig(typeof flags.config === 'string' ? flags.config : fail('缺少 --config 参数。'));
const state = loadState(typeof flags.state === 'string' ? flags.state : releaseFile(config, 'release-state.json'));

const manifestUrl = typeof flags.manifest === 'string' ? flags.manifest : config.version?.onlineManifest;
if (!manifestUrl) fail('没给 --manifest，配置里也没有 version.onlineManifest。');

/** 清单里的 file 是相对清单所在目录的路径，这里把它拼成完整 URL。 */
function resolvePackageUrl(relative) {
    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    return new URL(relative, base).toString();
}

const problems = [];

/**
 * 记一条**前提性**检查并打印。不通过就当场停。
 *
 * 用 fail() 而不是「收集进 problems 最后汇总」：这里记的是后面一切检查的前提
 * （清单拉得到、解析得了）。前提不成立还继续跑，只会报一串衍生错误，把真正的原因埋掉。
 */
function record(label, passed, detail = '') {
    if (passed) {
        ok(label, detail);
        return;
    }
    fail(`${label} 失败：${detail}`);
}

// ---- 1. 清单拉取与解析 ----
const bust = `${manifestUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
let response;
try {
    response = await fetch(`${manifestUrl}${bust}`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
} catch (error) {
    fail(`清单拉不到：${manifestUrl}\n${error.message}`);
}
record('清单可达', response.ok, `HTTP ${response.status}`);

const manifestText = await response.text();

let manifest;
try {
    manifest = parseManifest(manifestText);
} catch (error) {
    fail(`清单拉到了但读不了（一行一键的扁平结构被破坏？）：\n${error.message}`);
}
try {
    // 线上这份是别人（可能是别的机器）生成的，同样按 Pascal 的读法验一遍
    assertPascalParsable(`${manifestText.trimEnd()}\n`, manifest);
    ok('清单可被 Pascal 侧解析');
} catch (error) {
    fail(`清单通不过 Pascal 可解析性校验 —— 所有客户端都会更新失败：\n${error.message}`);
}

// ---- 2. 缓存头 ----
if (!flags['no-cache-check']) {
    const cacheControl = (response.headers.get('cache-control') ?? '').toLowerCase();
    const noStore = cacheControl.includes('no-store') || cacheControl.includes('no-cache') || cacheControl.includes('must-revalidate');
    if (!noStore) {
        warn(`清单的 Cache-Control 是 ${JSON.stringify(cacheControl || '(缺失)')}，不是 no-store —— 客户端可能一直读到旧清单。`);
        problems.push('清单缓存头不对');
    } else {
        ok('清单缓存头正确（no-store/no-cache）');
    }
}

// ---- 3. 清单里点名的包都能下、体积与哈希对得上 ----
const packages = [['更新包', manifest.file, manifest.sha256, manifest.size]];
if (manifest.fullFile) packages.push(['全量包', manifest.fullFile, manifest.fullSha256, manifest.fullSize]);

for (const [label, relative, expectedSha, expectedSize] of packages) {
    if (!relative) {
        warn(`${label}：清单里没有 ${label} 的路径字段，跳过。`);
        continue;
    }
    const url = resolvePackageUrl(relative);
    let head;
    try {
        head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    } catch (error) {
        fail(`${label} 取不到：${url}\n${error.message}`);
    }
    if (!head.ok) fail(`${label} 返回 HTTP ${head.status}：${url}（清单点了名却下不到，客户端会卡住）`);

    // 清单里所有值都是字符串（见 lib/flat-json.mjs 约束 4），比较前要转成数字
    const length = Number(head.headers.get('content-length'));
    const declared = Number(expectedSize);
    if (Number.isFinite(length) && Number.isFinite(declared) && length !== declared) {
        fail(`${label} 体积对不上：远端 ${length}，清单写 ${declared}。多半是上传了别的版本，或清单与包不配套。`);
    }
    ok(`${label} 可下载`, `${url.split('/').pop()} (${length || declared} 字节)`);

    // 包的缓存头：清单里的包名带随机 hash，URL 随内容变，长缓存才是对的。
    // 反过来（包被缓存成 no-store）会让每个客户端都回源 —— 不是正确性问题，是成本问题，
    // 但百兆级的包上这个成本很实在，所以值得报出来。
    if (!flags['no-cache-check']) {
        const header = (head.headers.get('cache-control') ?? '').toLowerCase();
        if (/(no-store|no-cache)/.test(header)) {
            warn(`${label} 的 Cache-Control 是 ${JSON.stringify(header)} —— 包名带随机 hash，本该长缓存；每个客户端都会回源。`);
            problems.push(`${label} 未长缓存`);
        }
    }

    if (flags['check-sha']) {
        const body = await (await fetch(url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer();
        const actual = createHash('sha256').update(Buffer.from(body)).digest('hex');
        if (actual !== expectedSha) fail(`${label} sha256 对不上：实测 ${actual}，清单写 ${expectedSha}`);
        ok(`${label} sha256 一致`);
    }
}

// ---- 3.5 固定文件名的产物必须 no-store ----
//
// 清单里的包名带随机 hash，URL 随内容变，长缓存是对的。**不带 hash 的那些不是** ——
// 固定 URL 会被 CDN 当成永久资源，新包永远命中旧缓存，而且重传同名文件也不会让边缘节点上的
// 旧副本消失。这类产物在本地开发时完全看不出问题，所以只能靠发版后来验。
//
// 哪些算固定名，只有项目自己知道（给人点的「下载最新版」入口、不改名的安装包…），
// 所以由 release.config.json 的 manifest.fixedNamePaths 声明。**没声明就没法验。**
const fixedNamePaths = config.manifest?.fixedNamePaths ?? [];
for (const relative of fixedNamePaths) {
    if (typeof relative !== 'string' || relative.trim() === '') continue;
    const url = resolvePackageUrl(relative);
    let head;
    try {
        head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    } catch (error) {
        fail(`固定名产物取不到：${url}\n${error.message}（声明了就得能下到）`);
    }
    if (!head.ok) fail(`固定名产物返回 HTTP ${head.status}：${url}`);

    const header = (head.headers.get('cache-control') ?? '').toLowerCase();
    const safe = /(no-store|no-cache|must-revalidate)/.test(header);
    if (!safe) {
        fail(
            `固定名产物 ${relative} 的 Cache-Control 是 ${JSON.stringify(header || '(缺失)')}，必须是 no-store。\n` +
                `它是固定 URL，CDN 会把它当永久资源 —— 新包永远命中旧缓存，重传同名文件也清不掉边缘副本。\n` +
                `注意：用了 CDN 时源站的头可能被 CDN 覆盖，要在 CDN 侧单独给这几个路径配 no-store 规则。`,
        );
    }
    ok(`固定名产物缓存头正确`, `${relative} → ${header}`);
}

// ---- 4. 版本不回退 ----
const onlineVersion = manifest.version;
if (state?.versions?.client && compareVersions(onlineVersion, state.versions.client) < 0) {
    fail(`线上版本 ${onlineVersion} 低于本地状态记的 ${state.versions.client} —— 清单像是被旧版本覆盖了。`);
}
ok(`线上版本 ${onlineVersion}`, `seq ${manifest.seq}`);

if (flags.json) printJson({ ok: problems.length === 0, problems, manifest });
info('');
ok(problems.length === 0 ? '线上体检通过。' : `体检通过但有 ${problems.length} 处警告：${problems.join('；')}`);