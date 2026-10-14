#!/usr/bin/env node
// 按 business / runtime 分类打客户端包。零依赖，Node >= 20.12。
//
//   node release-package.mjs --config <release.config.json> --source <已构建目录>
//        --kind payload|full --out <归档路径>
//        [--artifacts <artifacts.json>] [--json] [--allow-unclassified]
//
// 这是「更新包只包含业务相关的文件」这句话的可执行定义：
//
//   1. 列出已构建目录里的**全部**文件（不是挑出来的）；
//   2. 逐个分类为 business / runtime，**出现未分类的文件就让发版失败**（fail-closed）；
//   3. payload = business 集合；full = 全部；
//   4. payload 还要产出**删除清单** —— 全集覆盖式解决不了「被删掉的文件」，
//      旧客户端上它还在，可能被加载执行；
//   5. 打完包把归档内容列出来，与预期集合逐条对账（防止归档器多收/少收）。
//
// 为什么不用白名单：白名单漏一项的症状是「某个文件该更新却没进包」，客户端长期停在旧业务代码上，
// **没有任何报错**，直到某个功能行为不一致才被发现。fail-closed 让这种漏项在发版时就炸出来。
//
// 归档用系统的 tar（Windows 10 1803 起自带 bsdtar，可写 tar.gz 与 zip；与客户端解包的
// `{win}\System32\tar.exe` 同一套工具，格式与路径行为一致）。Node 没有内置归档能力，
// 引第三方库会破坏「零依赖」这条底线。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { loadConfig, normalizeGlobs, releaseFile } from './lib/config.mjs';
import { loadState } from './lib/state.mjs';
import { listRelativeFiles, matchesAny, sha256File, sha256Text } from './lib/tree-hash.mjs';
import { fail, info, ok, parseArgs, printJson, requireFlag, step, warn } from './lib/cli.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const configPath = requireFlag(flags, 'config', '指向 <repo>/release/release.config.json。');
const source = resolve(requireFlag(flags, 'source', '指向已构建好的客户端产物目录。'));
const kind = requireFlag(flags, 'kind', 'payload 或 full。');
const outPath = resolve(requireFlag(flags, 'out', '归档输出路径（扩展名决定格式）。'));

if (!['payload', 'full'].includes(kind)) fail(`--kind 只能是 payload 或 full，收到 ${kind}`);
if (!existsSync(source)) fail(`已构建目录不存在：${source}`);

const config = loadConfig(configPath);
const client = config.components?.client;
if (!client || client.enabled === false) fail('配置里没有启用 components.client。');

const businessGlobs = normalizeGlobs(client.businessGlobs);
const runtimeGlobs = normalizeGlobs(client.runtimeGlobs ?? []);
const repoRoot = config.__repoRoot;

/**
 * 归档工具：Windows 上优先用系统自带的 bsdtar（`%SystemRoot%\System32\tar.exe`）。
 *
 * 两个原因：
 *   1. **zip** —— GNU tar 不能创建 zip，bsdtar 可以（`-a` 按扩展名自动选格式）；
 *   2. **盘符** —— Git Bash 的 PATH 里通常是 MSYS 的 GNU tar，它会把 `C:/...` 当成远端主机
 *      （报 `Cannot connect to C: resolve failed`）。
 *
 * 客户端解包用的也是系统 `{win}\System32\tar.exe`，两边同一套工具，路径与格式行为一致。
 */
function tarExecutable() {
    if (process.platform === 'win32' && process.env.SystemRoot) {
        const systemTar = join(process.env.SystemRoot, 'System32', 'tar.exe');
        if (existsSync(systemTar)) return systemTar;
    }
    return 'tar';
}
const tar = tarExecutable();

step(`扫描 ${source}`);
const allFiles = listRelativeFiles(source).sort();
if (allFiles.length === 0) fail(`目录是空的：${source}。先构建再打包。`);

// ---- 分类（fail-closed）----
//
// glob 一律按**仓库相对路径**匹配 —— 与 release-changes.mjs 的变更检测、以及
// release.config.json 里写的 glob 保持同一套语义。否则「变更检测说这里是业务文件、
// 打包脚本说它不是」这种分叉会静默地漏掉文件。
//
// 归档里的条目则用**产物目录相对路径**（客户端就是解到应用目录里，路径必须是那个口径）。
const business = [];
const runtime = [];
const unclassified = [];
const outsideRepo = [];
for (const file of allFiles) {
    const repoPath = relative(repoRoot, join(source, file)).split('\\').join('/');
    if (repoPath.startsWith('../')) {
        outsideRepo.push(file);
        continue;
    }
    // runtime 优先：一个文件同时命中两侧时按运行时处理更安全（宁可走全量，也不要漏更新运行时）
    if (matchesAny(repoPath, runtimeGlobs)) runtime.push(file);
    else if (matchesAny(repoPath, businessGlobs)) business.push(file);
    else unclassified.push(file);
}

if (outsideRepo.length > 0) {
    fail(
        `有 ${outsideRepo.length} 个文件不在仓库内（${source} 不是仓库的子目录），无法用配置里的 glob 分类：\n` +
            `    ${outsideRepo.slice(0, 10).join('\n    ')}\n` +
            `把 --source 指向仓库内的构建产物目录（构到仓库外再拷回来也行）。`,
    );
}

info(`  业务文件 ${business.length} 个，运行时文件 ${runtime.length} 个`);

if (unclassified.length > 0) {
    const preview = unclassified.slice(0, 20).map((file) => `    ${file}`).join('\n');
    const message =
        `有 ${unclassified.length} 个文件既不属于业务文件、也不属于运行时文件：\n${preview}` +
        (unclassified.length > 20 ? `\n    …另有 ${unclassified.length - 20} 个` : '');
    if (!flags['allow-unclassified']) {
        fail(
            `${message}\n\n` +
                '这是 fail-closed 设计：分类不全意味着「某些文件永远不会被更新」，而它不会报错、只会静默发生。\n' +
                '先把它们归到 businessGlobs 或 runtimeGlobs；确要临时放行用 --allow-unclassified（会在产物里留记录）。',
        );
    }
    warn(`${message}\n  已用 --allow-unclassified 放行；这些文件不会进入更新包。`);
}

const included = kind === 'payload' ? business : allFiles;
if (included.length === 0) fail(`本次要打包的文件是 0 个（kind=${kind}）。这几乎一定是配置错了。`);

// ---- 打归档 ----
step(`打包（${kind}，${included.length} 个文件）`);
mkdirSync(dirname(outPath), { recursive: true });
const listPath = `${outPath}.filelist.txt`;
writeFileSync(listPath, `${included.join('\n')}\n`, 'utf8');

// 以输出目录为工作目录、参数里只出现相对路径：盘符一旦进了 tar 的参数，
// MSYS 的 GNU tar 会把它当成远端主机名（`Cannot connect to C: resolve failed`）
const outDir = dirname(outPath);
const sourceRelativeToOut = relative(outDir, source).split('\\').join('/') || '.';
try {
    // bsdtar 按扩展名自动选格式：.zip → zip，.tar.gz → gzip'd tar
    execFileSync(tar, ['-a', '-cf', basename(outPath), '-C', sourceRelativeToOut, '--files-from', basename(listPath)], {
        cwd: outDir,
        stdio: 'pipe',
    });
} catch (error) {
    fail(
        `打包失败：${error.stderr?.toString().trim() || error.message}\n` +
            `用的归档工具是 ${tar}。\n` +
            `要打 .zip 就必须有 bsdtar（Windows 10 1803+ 自带 System32\\tar.exe）；\n` +
            `非 Windows 环境打 zip 需要另装 bsdtar 或改用 .tar.gz。`,
    );
}

// ---- 对账：归档里实际装了什么，必须与预期集合逐条相等 ----
const listed = execFileSync(tar, ['-tf', basename(outPath)], { cwd: outDir, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().replace(/\/$/, ''))
    .filter((line) => line !== '' && !line.endsWith('/'))
    .map((line) => line.replace(/^\.\//, ''))
    .sort();

const expected = [...included].sort();
const missing = expected.filter((file) => !listed.includes(file));
const extra = listed.filter((file) => !expected.includes(file));
if (missing.length > 0 || extra.length > 0) {
    fail(
        `归档内容与预期不一致：缺 ${missing.length} 个、多 ${extra.length} 个。\n` +
            `  缺：${missing.slice(0, 10).join(', ')}\n  多：${extra.slice(0, 10).join(', ')}`,
    );
}
ok(`归档内容对账通过（${listed.length} 个文件）`);

// ---- 删除清单（仅 payload）----
let deleteList = null;
if (kind === 'payload') {
    const filelistDir = releaseFile(config, '.payload-filelists');
    mkdirSync(filelistDir, { recursive: true });

    // 上一版业务文件清单：用来算删除清单。没有就是首次发版，删除清单为空。
    const latestPointer = join(filelistDir, 'latest.txt');
    let previousFiles = null;
    if (existsSync(latestPointer)) {
        const previousStamp = readFileSync(latestPointer, 'utf8').trim();
        const previousPath = join(filelistDir, `${previousStamp}.json`);
        if (previousStamp && existsSync(previousPath)) {
            previousFiles = new Set(JSON.parse(readFileSync(previousPath, 'utf8')));
        }
    }

    if (previousFiles) {
        deleteList = [...previousFiles].filter((file) => !business.includes(file)).sort();
    } else {
        warn('没有上一版业务文件清单可比对，删除清单为空（首次发版属正常）。');
        deleteList = [];
    }

    // 清单文件名用本次版本号；版本号还没写（阶段 3 之前）就退回时间戳，不影响比对逻辑
    const state = loadState(releaseFile(config, 'release-state.json'));
    const stamp = state?.versions?.client || `unknown-${Date.now()}`;
    writeFileSync(join(filelistDir, `${stamp}.json`), `${JSON.stringify([...business].sort(), null, 2)}\n`, 'utf8');
    writeFileSync(latestPointer, stamp, 'utf8');
    ok(`业务文件清单已记录（${stamp}，${business.length} 个）`);
}

// ---- 产出 ----
const sha256 = sha256File(outPath);
const size = statSync(outPath).size;
const deletePath = deleteList === null ? null : `${outPath}.delete.json`;
if (deletePath) writeFileSync(deletePath, `${JSON.stringify(deleteList, null, 2)}\n`, 'utf8');

const result = {
    schema: 1,
    kind,
    source,
    archive: outPath,
    sha256,
    size,
    fileCount: listed.length,
    business: business.length,
    runtime: runtime.length,
    unclassified: unclassified.length,
    deleteList: deleteList ?? [],
    classificationHash: sha256Text(JSON.stringify({ business, runtime, unclassified })),
};

rmSync(listPath, { force: true });

if (typeof flags.artifacts === 'string') {
    const artifacts = existsSync(flags.artifacts) ? JSON.parse(readFileSync(flags.artifacts, 'utf8')) : {};
    if (kind === 'full') artifacts.full = outPath;
    else {
        artifacts.payload = outPath;
        artifacts.deleteList = deleteList;
    }
    writeFileSync(flags.artifacts, `${JSON.stringify(artifacts, null, 2)}\n`, 'utf8');
    ok(`产物信息已写入 ${flags.artifacts}`);
}

if (flags.json) printJson(result);
info('');
ok(`${kind} 包就绪：${outPath}`);
info(`  ${sha256}  ${(size / 1024 / 1024).toFixed(1)} MB  ${listed.length} 个文件`);
if (deleteList && deleteList.length > 0) info(`  删除清单 ${deleteList.length} 项 → ${deletePath}`);
if (unclassified.length > 0) warn(`有 ${unclassified.length} 个未分类文件未被打进包（--allow-unclassified 放行）。`);