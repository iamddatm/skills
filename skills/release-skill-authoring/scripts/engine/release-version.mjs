#!/usr/bin/env node
// 计算本次发版的客户端版本号。零依赖，Node >= 20.12。
//
//   node release-version.mjs --config <release.config.json> [--print] [--base V] [--no-online] [--json]
//   node release-version.mjs --compare <a> <b>          # a > b 时退出码 0，否则 1
//
// 版本号以**线上为准**：基准取「线上清单 / 本地状态里的上一版 / 显式 --base」三者的较大值，
// 再按「年.自增数.月.日」推下一版。本地状态会落后（换机、上次发布失败、别人发的版），
// 只信本地就会发出低于线上的版本号 —— 而客户端只认「版本更高」，那一版等于白发。

import { nextVersion, compareVersions, isVersion, maxVersion } from './lib/version.mjs';
import { loadConfig, releaseFile } from './lib/config.mjs';
import { loadState } from './lib/state.mjs';
import { fail, info, parseArgs, printJson, requireFlag, warn } from './lib/cli.mjs';

const { flags, positionals } = parseArgs(process.argv.slice(2));

// ---- --compare 分支：给其他脚本当门禁用 ----
if (flags.compare) {
    const [a, b] = positionals;
    if (!isVersion(a) || !isVersion(b)) fail(`--compare 需要两个四段版本号，收到：${a} / ${b}`);
    process.exit(compareVersions(a, b) > 0 ? 0 : 1);
}

const configPath = requireFlag(flags, 'config', '指向 <repo>/release/release.config.json。');
const config = loadConfig(configPath);
const statePath = typeof flags.state === 'string' ? flags.state : releaseFile(config, 'release-state.json');
const state = loadState(statePath);

// ---- 收集三个基准来源 ----
const candidates = [];

if (flags.base) {
    if (!isVersion(flags.base)) fail(`--base 不是四段版本号：${flags.base}`);
    candidates.push({ value: flags.base, source: '--base' });
}

const localVersion = state?.versions?.client;
if (isVersion(localVersion)) candidates.push({ value: localVersion, source: '本地状态' });

const onlineUrl = typeof flags['online-url'] === 'string' ? flags['online-url'] : config.version?.onlineManifest;
if (!flags['no-online'] && onlineUrl) {
    try {
        // 叠一个时间戳查询串：清单所在的 CDN 可能按 URL 缓存，不加会一直读到旧版本号
        const url = `${onlineUrl}${onlineUrl.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 1000)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-cache' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const match = /"version"\s*:\s*"([^"]+)"/.exec(text);
        if (match && isVersion(match[1])) {
            candidates.push({ value: match[1], source: '线上清单' });
        } else {
            warn(`线上清单里没读到合法的 version 字段（${onlineUrl}），本次只用本地基准。`);
        }
    } catch (error) {
        warn(`读线上版本失败（${onlineUrl}）：${error.message}`);
    }
}

const best = maxVersion(candidates);
if (best === null) {
    fail(
        '拿不到任何可用基准版本：线上读不到、本地状态里没有、也没给 --base。\n' +
            '本地基准可能已落后线上，别硬发。确认网络，或用 --base 显式指定线上版本。',
    );
}

const version = nextVersion(best.value, new Date());

// **本脚本不写状态**（曾经有个 --write，已移除）。
//
// 它当时写的是 state.versions.client，而那个槽位的含义是「**上次已发布**的版本」——
// release-manifest.mjs 的版本单调守卫正是拿它做比较。把「待发布的候选新号」写进去，
// 阶段 7 就变成拿新号跟新号比，报「同版本禁止重发」，流程自己把自己锁死。
// 这个槽位唯一的写入者是 release-manifest.mjs，在**发布成功**那一刻写。
//
// 取号因此是无副作用的：同样的输入重复跑一定得到同一个号，不需要记在状态里。
if (flags.write) {
    fail(
        'release-version.mjs 不再支持 --write。\n' +
            '它会把「待发布的新版本号」写进 versions.client，而那个槽位是「上次已发布的版本」——\n' +
            '阶段 7 的同版本守卫会因此误报「同版本禁止重发」。\n' +
            '正确做法：--print 取号，把结果用 --version 传给 release-manifest.mjs，落库由发布那一步完成。',
    );
}

if (flags.print) {
    // 裸版本号，供打包脚本直接取用：NEXT=$(node release-version.mjs ... --print --write)
    info(version);
    process.exit(0);
}

if (flags.json) {
    printJson({ version, base: best.value, baseSource: best.source, candidates });
} else {
    info(`本次客户端版本号：${version}`);
    info(`  基准 ${best.value}（来自${best.source}）`);
    for (const candidate of candidates) {
        info(`  候选 ${candidate.value}（${candidate.source}）`);
    }
}