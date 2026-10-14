#!/usr/bin/env node
// 清理发版残留。零依赖，Node >= 20.12。
//
//   node release-prune.mjs --config <release.config.json> [--apply] [--json]
//
// 发版是个反复动作：构建产物、清单归档、业务文件清单会一轮轮堆积。这个脚本按保留份数清理，
// 让「只保留最新版本」成为可执行的一条命令，而不是靠人记得偶尔手动删。
//
// **默认只演算**：要真删必须显式加 --apply。删除不可逆，不该是默认行为 ——
// 而且这个脚本会在「上传还没做完」的时刻被顺手跑一次，那是它最容易造成事故的用法。
//
// 四类东西的安全边界完全不同，所以规则不是一句「只留最新」：
//
//   · 构建产物（dist）    —— 保护最近 N 轮发布计划里点到的文件，其余删
//   · 清单归档（history） —— 保留最近 N 份，体积小
//   · 业务文件清单        —— **至少保留最近 2 份**：下一轮发版要拿上一份算「删除清单」。
//                            删光了，被删掉的业务文件会永远残留在客户端上，且没有任何报错。
//   · 技能备份            —— `--adopt` 重渲染技能前留下的旧目录，留几份（是保险，不是归档）
//   · 数据库备份          —— **不归本脚本管**，它有独立的保留策略（能接受回退多久）。
//
// 服务端不在本脚本范围内：那边要保住「清单当前指向的更新包与全量包」，删错了是线上事故。
// 规则写在 references/retention.md 里。

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, releaseFile } from './lib/config.mjs';
import { dim, fail, info, ok, parseArgs, printJson, requireFlag, step, warn } from './lib/cli.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const config = loadConfig(requireFlag(flags, 'config', '指向 <repo>/release/release.config.json。'));
const apply = Boolean(flags.apply);

const retention = config.release?.retention ?? {};
const keepDistReleases = Number(retention.localDistVersions ?? 1);
const keepHistory = Number(retention.localHistoryVersions ?? 5);
// 业务文件清单不能低于 2：下一轮要用上一份算删除清单
const keepFilelists = Math.max(2, Number(retention.localPayloadFilelists ?? 2));

if (!Number.isInteger(keepDistReleases) || keepDistReleases < 1) {
    fail(`release.retention.localDistVersions 必须是 >= 1 的整数，收到 ${JSON.stringify(retention.localDistVersions)}。`);
}

/** 按修改时间倒序列出目录里的文件（目录不存在则空）。 */
function listByTimeDescending(directory, filter = () => true) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && filter(entry.name))
        .map((entry) => {
            const full = join(directory, entry.name);
            const stat = statSync(full);
            return { name: entry.name, path: full, mtime: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

/** 目录版的按时间倒序列表（技能备份是一堆目录，不是文件）。 */
function listDirsByTimeDescending(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const full = join(directory, entry.name);
            return { name: entry.name, path: full, mtime: statSync(full).mtimeMs, size: directorySize(full) };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

/** 目录总字节数（报告里要说清「释放了多少」，不然清理是个看不见的动作）。 */
function directorySize(directory) {
    let total = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        total += entry.isDirectory() ? directorySize(full) : statSync(full).size;
    }
    return total;
}

const plan = [];
const scheduleDelete = (entry, why, recursive = false) => plan.push({ path: entry.path, size: entry.size, why, recursive });

// ---------------------------------------------------------------------------
// 1 清单归档：保留最近 N 份清单 + 配套的发布计划
// ---------------------------------------------------------------------------
const historyDir = releaseFile(config, 'history');
const historyManifests = listByTimeDescending(historyDir, (name) => name.endsWith('.manifest.json'));
const historyPlans = listByTimeDescending(historyDir, (name) => name.endsWith('.publish-plan.json'));

// 保留集合按清单归档的 releaseId 定，发布计划跟着它走 —— 两者是一轮的产物，不能只留一个
const keptReleaseIds = new Set(historyManifests.slice(0, keepHistory).map((entry) => entry.name.replace('.manifest.json', '')));
for (const entry of historyManifests.slice(keepHistory)) scheduleDelete(entry, `清单归档，只保留最近 ${keepHistory} 份`);
for (const entry of historyPlans) {
    if (!keptReleaseIds.has(entry.name.replace('.publish-plan.json', ''))) {
        scheduleDelete(entry, `发布计划，随清单归档一起清理（保留最近 ${keepHistory} 份）`);
    }
}

// ---------------------------------------------------------------------------
// 2 业务文件清单：**至少保留 2 份**（下一轮算删除清单要用）
// ---------------------------------------------------------------------------
const filelistDir = releaseFile(config, '.payload-filelists');
for (const entry of listByTimeDescending(filelistDir, (name) => name.endsWith('.json')).slice(keepFilelists)) {
    scheduleDelete(entry, `业务文件清单，至少保留 ${keepFilelists} 份（下一轮要用上一份算删除清单）`);
}

// ---------------------------------------------------------------------------
// 3 构建产物：保护「最近 N 轮发布计划里点到的文件」，其余删
// ---------------------------------------------------------------------------
//
// 为什么用发布计划而不是「按时间留最新 N 个」：产物文件名带随机 hash，同一轮里有多个 kind
// （payload / full / installer / frontend），按时间取最新 N 个会把同一轮的不同 kind 拆散 ——
// 留下一个用不上的安装包、删掉还要补发的更新包。发布计划记着「这一轮到底产出了什么」。
const distDir = resolve(config.__repoRoot, config.paths?.distDir ?? 'release/dist');
const protectedPaths = new Set();
for (const entry of historyPlans.slice(0, keepDistReleases)) {
    try {
        const planJson = JSON.parse(readFileSync(entry.path, 'utf8'));
        for (const file of planJson.files ?? []) protectedPaths.add(resolve(file.source));
    } catch (error) {
        warn(`发布计划读不了，跳过：${entry.name}（${error.message}）`);
    }
}
if (protectedPaths.size === 0) {
    warn('没有可用的发布计划，无法判断哪些产物还要用 —— 本轮**不动** dist。先确认清单生成器有产出 publish-plan。');
} else {
    for (const entry of listByTimeDescending(distDir)) {
        if (!protectedPaths.has(resolve(entry.path))) {
            scheduleDelete(entry, `构建产物，只保留最近 ${keepDistReleases} 轮发布用到的`);
        }
    }
}

// ---------------------------------------------------------------------------
// 4 技能备份：--adopt / --force 重渲染前留下的旧技能目录
// ---------------------------------------------------------------------------
//
// 它们是「改错了还能找回来」的保险，而不是归档。留几份就够 —— 不清理的话，
// 每优化一次技能就多一份完整拷贝（引擎就有几十个文件），很快比技能本身还占地方。
const skillBackupDir = releaseFile(config, '.skill-backups');
const keepSkillBackups = Math.max(0, Number(retention.skillBackups ?? 2));
for (const entry of listDirsByTimeDescending(skillBackupDir).slice(keepSkillBackups)) {
    scheduleDelete(entry, `技能备份，保留最近 ${keepSkillBackups} 份`, true);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const totalBytes = plan.reduce((sum, item) => sum + item.size, 0);
const result = {
    schema: 1,
    applied: apply,
    keep: { distReleases: keepDistReleases, history: keepHistory, payloadFilelists: keepFilelists, skillBackups: keepSkillBackups },
    deletions: plan.map((item) => ({ path: item.path, size: item.size, why: item.why })),
    freedBytes: totalBytes,
};

if (plan.length === 0) {
    ok('没有需要清理的东西。');
    if (flags.json) printJson(result);
    process.exit(0);
}

info(`将删除 ${plan.length} 项，释放约 ${(totalBytes / 1024 / 1024).toFixed(1)} MB：`);
for (const item of plan) {
    info(`  ${(item.size / 1024).toFixed(0).padStart(8)} KB  ${item.path}`);
    info(`              ${item.why}`);
}

if (!apply) {
    info('');
    warn('这是演算，什么都没删。确认无误后加 --apply 真删。');
    if (flags.json) printJson(result);
    process.exit(0);
}

step('执行删除');
let failed = 0;
for (const item of plan) {
    try {
        rmSync(item.path, { force: true, recursive: item.recursive });
    } catch (error) {
        failed += 1;
        warn(`删不掉：${item.path}（${error.message}）`);
    }
}
if (failed > 0) fail(`${failed} 项删除失败，其余已删除。`);

ok(`已删除 ${plan.length} 项，释放约 ${(totalBytes / 1024 / 1024).toFixed(1)} MB。`);
info(dim('提醒：**不要**把这次清理的结论套到服务器上 —— 线上「清单当前指向的更新包与全量包」永远不能删。'));
if (flags.json) printJson(result);