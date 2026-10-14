#!/usr/bin/env node
// 引擎自测。零依赖，Node >= 20.12。
//
//   node scripts/self-test.mjs
//
// 只测纯逻辑（版本号、清单序列化与校验、glob 匹配），不需要网络、不需要 git、不写任何文件。
// 重点是**反向用例**：光证明"正常清单能通过"没有意义，要证明"写错的清单一定会被拦住"。

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, isVersion, maxVersion, nextVersion } from './engine/lib/version.mjs';
import { assertPascalParsable, parseManifest, pascalJsonStr, serializeManifest } from './engine/lib/flat-json.mjs';
import { globToRegExp, matchesAny } from './engine/lib/tree-hash.mjs';
import { dim, green, info, red } from './engine/lib/cli.mjs';

const SCAFFOLD = join(dirname(fileURLToPath(import.meta.url)), 'release-scaffold.mjs');
const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0;
const failures = [];

function check(label, fn) {
    try {
        fn();
        passed += 1;
        info(`  ${green('✓')} ${label}`);
    } catch (error) {
        failures.push(`${label}\n      ${error.message}`);
        info(`  ${red('✗')} ${label}`);
    }
}

function assertEqual(actual, expected, hint = '') {
    if (actual !== expected) {
        throw new Error(`期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}。${hint}`);
    }
}

function assertThrows(fn, mustMention) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    if (thrown === null) throw new Error('预期抛异常，但没有抛。');
    if (mustMention && !thrown.message.includes(mustMention)) {
        throw new Error(`异常信息里没有出现 ${JSON.stringify(mustMention)}：\n      ${thrown.message.split('\n')[0]}`);
    }
}

// ---------------------------------------------------------------------------
info('');
info('版本号');
// ---------------------------------------------------------------------------

check('识别四段版本号', () => {
    assertEqual(isVersion('26.10.1.1'), true);
    assertEqual(isVersion('26.10.1'), false, '三段不是合法版本号');
    assertEqual(isVersion('26.10.1.1-beta'), false);
});

check('按段比整数，不是按字符串', () => {
    assertEqual(compareVersions('26.10.1.1', '26.9.1.1'), 1, '按字符串比会判反，这是客户端更新逻辑的核心');
    assertEqual(compareVersions('26.9.1.1', '26.10.1.1'), -1);
    assertEqual(compareVersions('26.10.1.1', '26.10.1.1'), 0);
});

check('同年自增数 +1', () => {
    assertEqual(nextVersion('26.10.1.1', new Date(2026, 9, 14)), '26.11.10.14');
});

check('跨年自增数重置为 1', () => {
    assertEqual(nextVersion('26.99.12.31', new Date(2027, 0, 3)), '27.1.1.3');
});

check('基准非法时自增数从 1 起', () => {
    assertEqual(nextVersion('', new Date(2026, 9, 14)), '26.1.10.14');
    assertEqual(nextVersion('26.10.1', new Date(2026, 9, 14)), '26.1.10.14');
});

check('三源取大', () => {
    const best = maxVersion([
        { value: '26.10.1.1', source: '本地状态' },
        { value: '', source: '线上清单' },
        { value: '26.9.99.99', source: '--base' },
    ]);
    assertEqual(best.value, '26.10.1.1');
    assertEqual(best.source, '本地状态');
});

check('全部候选为空时返回 null（由调用方决定报错）', () => {
    assertEqual(maxVersion([{ value: '', source: 'x' }]), null);
});

// ---------------------------------------------------------------------------
info('');
info('清单：正常路径');
// ---------------------------------------------------------------------------

const sample = () => ({
    schema: 1,
    channel: 'stable',
    version: '26.11.10.14',
    type: 'payload',
    file: 'p/app-payload-a1b2c3d4e5f6.tar.gz',
    sha256: 'a'.repeat(64),
    size: 52428800,
    notes: '修复登录后偶发白屏；新增导出 Excel 按钮。',
    seq: 42,
    minVersion: '26.7.0.0',
    fullFile: 'f/app-full-b2c3d4e5f6a1.zip',
    fullSha256: 'b'.repeat(64),
    fullSize: 524288000,
    reason: 'runtime-deps',
    full: { version: '26.11.10.14' },
});

check('序列化后能通过 Pascal 校验', () => {
    const text = serializeManifest(sample());
    assertPascalParsable(text, sample());
});

check('文件是纯 ASCII，中文被转成 \\uXXXX', () => {
    const text = serializeManifest(sample());
    assertEqual(/^[\x20-\x7e\n]*$/.test(text), true);
    assertEqual(text.includes('\\u4fee'), true, '「修」应被转义');
});

check('所有值都带引号（数字也不能裸写）', () => {
    const text = serializeManifest(sample());
    assertEqual(/"size": 52428800/.test(text), false, '裸数字会让 Pascal 读到隔壁字段');
    assertEqual(/"size": "52428800"/.test(text), true);
});

check('嵌套块排在最后一行', () => {
    const lines = serializeManifest(sample()).trimEnd().split('\n');
    assertEqual(lines[lines.length - 1], '{ "full": { "version": "26.11.10.14" } }');
});

check('回读得到解码后的真实中文', () => {
    const parsed = parseManifest(serializeManifest(sample()));
    assertEqual(parsed.notes, '修复登录后偶发白屏；新增导出 Excel 按钮。');
});

check('Pascal 算法读回顶层 version 拿到的是顶层那个，不是 full 里的', () => {
    const text = serializeManifest(sample());
    assertEqual(pascalJsonStr(text.split('\n').join(''), 'version'), '26.11.10.14');
});

// ---------------------------------------------------------------------------
info('');
info('清单：反向用例（写错必须被拦住）');
// ---------------------------------------------------------------------------

check('顶层 version 排在 full 之后 → 拦住', () => {
    // 手工构造一份顺序错误的清单：这正是「不动脑改顺序」会踩的坑
    const bad = [
        '{ "schema": "1" }',
        '{ "full": { "version": "99.0.0.0" } }',
        '{ "version": "26.11.10.14" }',
    ].join('\n') + '\n';
    assertThrows(() => assertPascalParsable(bad, sample()), '嵌套块');
});

check('值里带英文双引号 → 拦住', () => {
    const manifest = { ...sample(), notes: '他说"好了"' };
    assertThrows(() => serializeManifest(manifest), '英文双引号');
});

check('安装包要读的字段里放中文 → 拦住', () => {
    // 这条检查在 assertPascalParsable 里（它是「文本能否被 Pascal 正确读取」的性质，
    // 不是「对象能否序列化」的性质），所以要用完整的两步调用
    const manifest = { ...sample(), version: '26.11.10.14测试' };
    assertThrows(() => assertPascalParsable(serializeManifest(manifest), manifest), '转义');
});

check('数组值 → 拦住', () => {
    assertThrows(() => serializeManifest({ ...sample(), notes: ['a', 'b'] }), '数组');
});

check('未知字段 → 拦住（防止拼错键名被静默丢弃）', () => {
    assertThrows(() => serializeManifest({ ...sample(), fullVerison: 'x' }), '未知字段');
});

check('嵌套块里塞非法字段 → 拦住', () => {
    assertThrows(() => serializeManifest({ ...sample(), full: { version: 'x', extra: 'y' } }), '不允许出现字段');
});

check('非 ASCII 混进清单文本 → 拦住', () => {
    assertThrows(() => assertPascalParsable('{ "notes": "中文" }\n', { notes: '中文' }), '非 ASCII');
});

// ---------------------------------------------------------------------------
info('');
info('glob 匹配');
// ---------------------------------------------------------------------------

check('**/ 匹配任意层（含零层）', () => {
    assertEqual(matchesAny('a.csproj', ['**/*.csproj']), true);
    assertEqual(matchesAny('x/y/a.csproj', ['**/*.csproj']), true);
});

check('* 不跨目录', () => {
    assertEqual(matchesAny('server/a/b.js', ['server/*.js']), false);
    assertEqual(matchesAny('server/a.js', ['server/*.js']), true);
});

check('目录通配覆盖子树', () => {
    assertEqual(matchesAny('client/resources/deep/a.js', ['client/resources/**']), true);
    assertEqual(matchesAny('client/other/a.js', ['client/resources/**']), false);
});

check('正则元字符被转义（. 不是通配）', () => {
    assertEqual(globToRegExp('a.b').test('aXb'), false);
});

// ---------------------------------------------------------------------------
info('');
info('生成脚手架（会写临时目录）');
// ---------------------------------------------------------------------------
//
// 这几条测的是**纪律能不能被执行**，而不是「渲染出来的文字好不好」：
// 生成物最容易骗人的地方是「看起来很完整、参数其实是猜的」，而这种失败没法靠读产物发现，
// 只能靠脚手架在生成时就拒绝。所以每条门禁都要有反向用例。

/** 一份字段齐备的配置；各用例按需覆盖单个字段。 */
function baseConfig(overrides = {}) {
    return {
        schema: 1,
        project: { name: '测试项目', slug: 'demo', repoRoot: '..' },
        components: {
            database: { enabled: true, globs: ['db/**'] },
            backend: { enabled: true, globs: ['server/**'] },
            frontend: { enabled: true, globs: ['web/**'] },
            client: {
                enabled: true,
                globs: ['client/**'],
                businessGlobs: ['client/resources/**'],
                runtimeGlobs: ['client/runtime/**', 'client/package.json'],
                structureGlobs: ['client/resources/*'],
                buildOutputDir: 'client/dist',
                archive: 'tar.gz',
                exeName: 'demo.exe',
                updateExecutor: 'updater',
            },
        },
        version: { source: 'client/app.csproj 的 <Version>' },
        manifest: { baseUrl: 'https://dl.example.com/stable', channel: 'stable', notesSource: 'ai-draft-human-confirm' },
        release: {
            branch: 'main',
            defaultBranch: 'main',
            stopWindow: 'accept-downtime',
            backwardCompatVersions: 3,
            backwardCompatDays: 90,
            checkpoints: '用户确认',
            confirmedBy: '测试用户',
        },
        database: {
            strategy: 'updown',
            migrationsDir: 'db/migrations',
            backupDir: 'db/backups',
            connectionEnv: 'DEMO_DB_CONNECTION',
            backupCommand: 'pg_dump --file {out}',
            execCommand: 'psql --file {file}',
            restoreCommand: 'psql --file {out}',
        },
        frontend: { mode: 'static', buildCommand: 'pnpm build', outputDir: 'web/dist', url: '', publishTarget: '' },
        backend: { composeFile: 'deploy/docker-compose.yml', services: ['api'], singleFileMountServices: [], persistentDirs: [] },
        deploy: { hostEnv: 'DEMO_HOST', keyEnv: 'DEMO_KEY', appDir: '/opt/demo', healthcheckUrl: 'http://127.0.0.1:8080/api/health' },
        installer: { dir: 'installer', innoSkillDir: 'D:/skills/inno-setup-installer', payloadVersionCommand: '(Get-Item "$payloadFull/demo.exe").VersionInfo.FileVersion' },
        paths: { releaseDir: 'release', distDir: 'release/dist' },
        commands: { build: ['pnpm build'] },
        agents: { repoTargets: ['agents', 'codex'], userTargets: [] },
        ...overrides,
    };
}

/** 在临时目录里造一个假项目 + 配置，跑脚手架。返回 {repo, outDir, code, stdout, stderr}。 */
function runScaffold(name, config, extraArgs = []) {
    const repo = mkdtempSync(join(tmpdir(), `rsa-selftest-${name}-`));
    mkdirSync(join(repo, 'release'), { recursive: true });
    writeFileSync(join(repo, 'release', 'release.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return { repo, outDir: join(repo, 'out'), ...runScaffoldInto(repo, extraArgs) };
}

/** 对已经建好的假项目再跑一次脚手架（--diff / --adopt 这类「已有技能」的路径要用）。 */
function runScaffoldInto(repo, extraArgs = []) {
    const result = spawnSync(
        process.execPath,
        [SCAFFOLD, '--config', join(repo, 'release', 'release.config.json'), '--out', join(repo, 'out'), ...extraArgs],
        { encoding: 'utf8' },
    );
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 读生成物里的文件；不存在就返回空串（断言里更好读）。 */
function readOutput(outDir, relative) {
    const path = join(outDir, relative);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

check('字段齐备时渲染成功，且没有占位符残留', () => {
    const run = runScaffold('ok', baseConfig());
    try {
        assertEqual(run.code, 0, run.stderr);
        assertEqual(existsSync(join(run.outDir, 'SKILL.md')), true);
        assertEqual(existsSync(join(run.outDir, 'release.config.json')), true);
        // 引擎必须跟着走，生成物才自包含
        assertEqual(existsSync(join(run.outDir, 'scripts', 'engine', 'release-manifest.mjs')), true);
        const skill = readOutput(run.outDir, 'SKILL.md');
        assertEqual(/\{\{[A-Z0-9_]+\}\}/.test(skill), false, 'SKILL.md 里有未替换的占位符');
        // REPO_REL 要按实际落盘位置算：--out 在仓库根外一层，所以是 ../
        assertEqual(skill.includes('../release/'), true, 'REPO_REL 不该是空的');

        // 整棵产物树里不许出现任何 `{{`：条件段配错对时会漏出字面量 `{{#if X}}`，
        // 而只查 `{{NAME}}` 的正则看不见它 —— 这条断言就是用来堵这个洞的
        const leaked = [];
        (function walk(directory) {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    if (entry.name !== 'engine') walk(join(directory, entry.name));
                    continue;
                }
                if (!['.md', '.json', '.mjs', '.ps1', '.iss'].includes(extname(entry.name))) continue;
                const text = readFileSync(join(directory, entry.name), 'utf8');
                for (const match of text.matchAll(/\{\{[^{}]*\}\}/g)) {
                    leaked.push(`${entry.name} → ${match[0]}`);
                }
            }
        })(join(run.repo, 'out'));
        assertEqual(leaked.length, 0, `产物里漏出了模板标记：${leaked.slice(0, 5).join('、')}`);
    } finally {
        rmSync(run.repo, { recursive: true, force: true });
    }
});

check('未声明确认状态（既没 confirmedBy 也没 pendingConfirmations）→ 拒绝生成', () => {
    const config = baseConfig();
    delete config.release.confirmedBy;
    const run = runScaffold('noconfirm', config);
    try {
        assertEqual(run.code === 0, false, '这种配置不该生成成功');
        assertEqual(/confirmedBy|pendingConfirmations/.test(run.stderr), true, run.stderr);
    } finally {
        rmSync(run.repo, { recursive: true, force: true });
    }
});

check('有 pendingConfirmations → 挂「尚未就绪」横幅并落 PENDING-CONFIRMATIONS.md', () => {
    const config = baseConfig();
    delete config.release.confirmedBy;
    config.release.pendingConfirmations = ['清单托管地址是猜的：https://update.example.internal/demo'];
    const run = runScaffold('pending', config);
    try {
        assertEqual(run.code, 0, run.stderr);
        assertEqual(readOutput(run.outDir, 'SKILL.md').includes('尚未「就绪」'), true, 'SKILL.md 必须挂横幅');
        const pending = readOutput(run.outDir, 'PENDING-CONFIRMATIONS.md');
        assertEqual(pending.includes('https://update.example.internal/demo'), true);
    } finally {
        rmSync(run.repo, { recursive: true, force: true });
    }
});

check('payloadVersionCommand 是中文说明句 → 拒绝生成', () => {
    const config = baseConfig();
    config.installer.payloadVersionCommand = '从已构建产物读版本号';
    const run = runScaffold('prose', config);
    try {
        assertEqual(run.code === 0, false, '说明文字不该被当成命令放行');
        assertEqual(/payloadVersionCommand/.test(run.stderr), true, run.stderr);
    } finally {
        rmSync(run.repo, { recursive: true, force: true });
    }
});

check('--diff 只报告不写盘：一致时退出码 0，有差异时 2', () => {
    const run = runScaffold('diff', baseConfig());
    try {
        assertEqual(run.code, 0, run.stderr);
        const skillDir = join(run.repo, 'out');
        const before = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');

        // 一致 → 0
        const same = runScaffoldInto(run.repo, ['--diff']);
        assertEqual(same.code, 0, `刚渲染完再 --diff 应该没有差异：${same.stdout}${same.stderr}`);

        // 动一个文件 + 加一个项目自写脚本 → 2，且原目录不被改
        writeFileSync(join(skillDir, 'SKILL.md'), `${before}\n项目手改\n`, 'utf8');
        writeFileSync(join(skillDir, 'scripts', 'notify-slack.ps1'), '# 项目自写\n', 'utf8');
        const changed = runScaffoldInto(run.repo, ['--diff']);
        assertEqual(changed.code, 2, '有差异时 --diff 应该退出码 2');
        assertEqual(changed.stdout.includes('更新'), true, '要报出被改动的文件');
        assertEqual(changed.stdout.includes('notify-slack.ps1'), true, '要报出项目自加的脚本');
        assertEqual(readFileSync(join(skillDir, 'SKILL.md'), 'utf8').endsWith('项目手改\n'), true, '--diff 不许改动现有目录');
        assertEqual(existsSync(join(skillDir, 'scripts', 'notify-slack.ps1')), true, '--diff 不许删现有目录里的东西');
    } finally {
        rmSync(run.repo, { recursive: true, force: true });
    }
});

check('--adopt 先备份再重渲染，且保住项目自加的脚本', () => {
    const run = runScaffold('adopt', baseConfig());
    try {
        assertEqual(run.code, 0, run.stderr);
        const skillDir = join(run.repo, 'out');
        writeFileSync(join(skillDir, 'SKILL.md'), '被项目整篇改过了\n', 'utf8');
        writeFileSync(join(skillDir, 'scripts', 'notify-slack.ps1'), '# 项目自写\n', 'utf8');

        const adopted = runScaffoldInto(run.repo, ['--adopt']);
        assertEqual(adopted.code, 0, adopted.stderr);

        // 备份：旧目录仍在 .skill-backups/ 里，手改可找回
        const backups = readdirSync(join(run.repo, 'release', '.skill-backups'));
        assertEqual(backups.length, 1, '--adopt 必须留一份备份');
        const backupSkill = join(run.repo, 'release', '.skill-backups', backups[0], 'SKILL.md');
        assertEqual(readFileSync(backupSkill, 'utf8'), '被项目整篇改过了\n', '备份里要是改动前的样子');

        // 重渲染：模板产出的文件被刷新，项目自加的脚本留下
        assertEqual(/^---\nname: demo-release/.test(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')), true);
        assertEqual(existsSync(join(skillDir, 'scripts', 'notify-slack.ps1')), true, '项目自加的脚本不该被删');
    } finally {
        rmSync(run.repo, { recursive: true, force: true });
    }
});

check('版本号只有一个来源：取号不写状态，清单必须显式收号', () => {
    // 这条钉住的是一个真实存在过的自相矛盾：release-version 的 --write 把「待发布版本号」
    // 写进 state.versions.client，而那个槽位是「上次已发布版本」，清单的同版本守卫正是拿它比较 ——
    // 于是按手册跑完阶段 3 之后，阶段 7 恒报「同版本禁止重发」，流程把自己锁死。
    const run = runScaffold('version', baseConfig());
    try {
        const engine = join(run.outDir, 'scripts', 'engine');
        const cfg = join(run.repo, 'release', 'release.config.json');
        const runNode = (script, args) =>
            spawnSync(process.execPath, [join(engine, script), '--config', cfg, ...args], { encoding: 'utf8' });

        // --write 必须响亮失败，而不是被静默忽略
        const wrote = runNode('release-version.mjs', ['--print', '--write', '--no-online', '--base', '26.10.1.1']);
        assertEqual(wrote.status === 0, false, '--write 已移除，不该再成功');
        assertEqual(/不再支持 --write/.test(wrote.stderr), true, wrote.stderr);

        // --print 仍然干净可用：stdout 只有裸版本号
        const printed = runNode('release-version.mjs', ['--print', '--no-online', '--base', '26.10.1.1']);
        assertEqual(printed.status, 0, printed.stderr);
        assertEqual(/^\d+\.\d+\.\d+\.\d+$/.test(printed.stdout.trim()), true, `stdout 该只有裸版本号：${printed.stdout}`);

        // 清单缺 --version 必须失败，而且不能再把人指去 --write
        const payloadPath = join(run.repo, 'fake-payload.tar.gz');
        writeFileSync(payloadPath, '假装是个包');
        writeFileSync(join(run.repo, 'artifacts.json'), `${JSON.stringify({ payload: payloadPath })}\n`, 'utf8');
        const noVersion = runNode('release-manifest.mjs', [
            '--artifacts', join(run.repo, 'artifacts.json'),
            '--out', join(run.repo, 'manifest.json'),
        ]);
        assertEqual(noVersion.status === 0, false, '缺 --version 不该成功');
        assertEqual(/缺少 --version/.test(noVersion.stderr), true, noVersion.stderr);
        assertEqual(/--write/.test(noVersion.stderr), false, `错误提示不该再让人去跑 --write：${noVersion.stderr}`);
    } finally {
        rmSync(run.repo, { recursive: true, force: true });
    }
});

check('清单地址只推导一次：baseUrl 带不带通道都不拼成 .../stable/stable/', () => {
    // 用户说「清单放 https://dl.example.com/stable/ 上」时，把整串填进 baseUrl 是最自然的读法。
    // 模板若再各拼一层 channel，就得到 .../stable/stable/manifest.json —— 一个不存在的地址，
    // 而且**没有任何脚本会因此报错**，只有照文档实现 updater 的人会打到 404。
    const withChannel = runScaffold('manifesturl-a', baseConfig());
    try {
        const skill = readOutput(withChannel.outDir, 'SKILL.md');
        assertEqual(skill.includes('https://dl.example.com/stable/manifest.json'), true, skill.match(/https?:\/\/\S+/)?.[0] ?? '(没找到 URL)');
        assertEqual(/stable\/stable/.test(skill), false, '不能拼出双通道');
        // 安装包侧要的是**通道目录**（它自己会拼 /manifest.json）
        assertEqual(readOutput(withChannel.outDir, 'scripts/build-installer.ps1').includes("'https://dl.example.com/stable'"), true);
    } finally {
        rmSync(withChannel.repo, { recursive: true, force: true });
    }

    // 另一种自然填法：baseUrl 是站点根，通道单独给 —— 结果必须一样
    const siteRoot = baseConfig();
    siteRoot.manifest.baseUrl = 'https://dl.example.com';
    const rootRun = runScaffold('manifesturl-b', siteRoot);
    try {
        assertEqual(readOutput(rootRun.outDir, 'SKILL.md').includes('https://dl.example.com/stable/manifest.json'), true);
    } finally {
        rmSync(rootRun.repo, { recursive: true, force: true });
    }
});

check('发布计划归档到 history，清理时认得出「还要用的产物」', () => {
    // 这条钉住的是一个「守门永远不会触发」的 bug：清单生成器把发布计划写在 release/ 根，
    // 而清理脚本去 history/ 找 —— 结果 dist 从来没被清过，脚本还会打印
    // 「没有可用的发布计划」然后什么都不做，看着完全像正常。
    const run = runScaffold('prune', baseConfig());
    try {
        const engine = join(run.outDir, 'scripts', 'engine');
        const cfg = join(run.repo, 'release', 'release.config.json');
        const dist = join(run.repo, 'release', 'dist');
        mkdirSync(dist, { recursive: true });
        const planned = join(dist, 'demo-payload-abcdef123456.tar.gz');
        writeFileSync(planned, Buffer.alloc(2048, 1));
        const orphan = join(dist, 'orphan-old-build.tar.gz');
        writeFileSync(orphan, Buffer.alloc(1024, 2));
        const artifacts = join(run.repo, 'release', 'artifacts.json');
        writeFileSync(artifacts, JSON.stringify({ payload: planned, notes: '自测用。' }), 'utf8');

        const manifest = spawnSync(
            process.execPath,
            [join(engine, 'release-manifest.mjs'), '--config', cfg, '--artifacts', artifacts, '--version', '26.99.1.1'],
            { encoding: 'utf8' },
        );
        assertEqual(manifest.status, 0, `${manifest.stdout}${manifest.stderr}`);

        const historyDir = join(run.repo, 'release', 'history');
        const archivedPlans = readdirSync(historyDir).filter((name) => name.endsWith('.publish-plan.json'));
        assertEqual(archivedPlans.length, 1, `发布计划必须归档到 history/：${readdirSync(historyDir).join('、')}`);

        const prune = spawnSync(process.execPath, [join(engine, 'release-prune.mjs'), '--config', cfg], { encoding: 'utf8' });
        const output = `${prune.stdout ?? ''}${prune.stderr ?? ''}`;
        assertEqual(/没有可用的发布计划/.test(output), false, `清理应当找得到计划：\n${output}`);
        assertEqual(output.includes('orphan-old-build.tar.gz'), true, `没被计划点到的产物该列进删除：\n${output}`);
        assertEqual(output.includes('demo-payload-abcdef123456.tar.gz'), false, `计划点到的产物不该被删：\n${output}`);
    } finally {
        rmSync(run.repo, { recursive: true, force: true });
    }
});

check('release-sync 只统计配置里声明过的 Agent 目标', () => {
    // 这条不能用 runScaffold：release-sync 的真源固定是 <repo>/.claude/skills/，
    // 所以这里不传 --out，让脚手架落到默认位置
    const repo = mkdtempSync(join(tmpdir(), 'rsa-selftest-sync-'));
    try {
        mkdirSync(join(repo, 'release'), { recursive: true });
        const configPath = join(repo, 'release', 'release.config.json');
        writeFileSync(configPath, `${JSON.stringify(baseConfig(), null, 2)}\n`, 'utf8');
        const scaffolded = spawnSync(process.execPath, [SCAFFOLD, '--config', configPath], { encoding: 'utf8' });
        assertEqual(scaffolded.status, 0, scaffolded.stderr);

        const sync = join(repo, '.claude', 'skills', 'demo-release', 'scripts', 'engine', 'release-sync.mjs');
        const result = spawnSync(process.execPath, [sync, '--repo', repo, '--check'], { encoding: 'utf8' });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        // 配置声明的是 agents + codex，那就只该统计这两个 —— 否则门禁会逼人同步到
        // 项目根本没声明、也不想维护的目录，结果就是这条门禁被无视
        assertEqual(/有 2 处未同步/.test(output), true, `应只统计声明过的两个目标：\n${output}`);
        assertEqual(/GitHub Copilot|Cursor/.test(output), false, `未声明的目标不该出现在检查结果里：\n${output}`);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

check('{{#unless}} 生效：同一句话在两个形态下措辞不同', () => {
    // 加 unless 的原因是「有客户端」和「没有客户端」下**措辞不同**，而不是多一句少一句。
    // 只有 if 的话只能两边都写，客户端项目会看到重复的两句。
    const withClient = runScaffold('unless-a', baseConfig());
    const noClient = (() => {
        const config = baseConfig();
        config.components.client.enabled = false;
        config.components.frontend.enabled = false;
        return runScaffold('unless-b', config);
    })();
    try {
        const clientSkill = readOutput(withClient.outDir, 'SKILL.md');
        const bareSkill = readOutput(noClient.outDir, 'SKILL.md');

        assertEqual(/清单上传成功、线上体检通过之后/.test(clientSkill), true, '客户端形态该用客户端措辞');
        assertEqual(/本次发版确认成功之后/.test(clientSkill), false, '客户端形态不该同时出现无客户端的那句');
        assertEqual(/本次发版确认成功之后/.test(bareSkill), true, '无客户端形态该用通用措辞');
        assertEqual(/线上体检通过之后/.test(bareSkill), false, '无客户端形态不该提线上体检');
        // 客户端专属的红线不该漏进无客户端产物
        assertEqual(/release-verify/.test(bareSkill), false, '无客户端的红线里不该出现 release-verify');
    } finally {
        rmSync(withClient.repo, { recursive: true, force: true });
        rmSync(noClient.repo, { recursive: true, force: true });
    }
});

check('没有客户端的项目：不生成客户端专属的脚本、文档与资产', () => {
    const config = baseConfig();
    config.components.client.enabled = false;
    const run = runScaffold('serveronly', config);
    try {
        assertEqual(run.code, 0, run.stderr);
        for (const absent of [
            'references/client.md',
            'references/manifest-contract.md',
            'references/payload-rules.md',
            'references/client-update-protocol.md',
            'scripts/build-installer.ps1',
            'scripts/verify-installer.ps1',
            'assets/inno/pascal-fragment.iss',
        ]) {
            assertEqual(existsSync(join(run.outDir, absent)), false, `${absent} 不该出现在无客户端的项目里`);
        }
        // 与组件无关的那几份仍然要在
        assertEqual(existsSync(join(run.outDir, 'references', 'retention.md')), true);
        assertEqual(existsSync(join(run.outDir, 'references', 'multi-agent-layout.md')), true);
    } finally {
        rmSync(run.repo, { recursive: true, force: true });
    }
});

check('模板引用了一个不会生成的脚本 → 渲染直接失败，而不是留个死引用', () => {
    // 「生成物里的引用有没有落点」这条自检，光证明正常模板能过没有意义 —— 要证明**引用落空时真的会拦**。
    // 这个仓库已经栽过三次「门禁从没跑过」：函数未定义、正则漏了 `{{#if}}`、清理由错目录读计划。
    // 做法：把元技能整个拷到临时目录，塞一个指向不存在脚本的模板进去，再渲染。
    const skillCopy = mkdtempSync(join(tmpdir(), 'rsa-selftest-dangling-'));
    cpSync(SKILL_ROOT, skillCopy, { recursive: true });
    writeFileSync(
        join(skillCopy, 'assets', 'templates', 'references', 'probe.md.tmpl'),
        '先跑 `node scripts/not-generated.mjs`，再跑 `node scripts/engine/does-not-exist.mjs`。\n',
        'utf8',
    );
    const repo = mkdtempSync(join(tmpdir(), 'rsa-selftest-dangling-repo-'));
    mkdirSync(join(repo, 'release'), { recursive: true });
    writeFileSync(join(repo, 'release', 'release.config.json'), `${JSON.stringify(baseConfig(), null, 2)}\n`, 'utf8');
    try {
        const result = spawnSync(
            process.execPath,
            [join(skillCopy, 'scripts', 'release-scaffold.mjs'), '--config', join(repo, 'release', 'release.config.json'), '--out', join(repo, 'out')],
            { encoding: 'utf8' },
        );
        assertEqual(result.status === 0, false, '引用落空时必须失败');
        assertEqual(result.stderr.includes('not-generated.mjs'), true, result.stderr);
        // 引擎引用按元技能目录判：元技能里也没有的引擎文件，落地后同样不会有
        assertEqual(result.stderr.includes('does-not-exist.mjs'), true, result.stderr);
    } finally {
        rmSync(skillCopy, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------

info('');
if (failures.length > 0) {
    info(red(`✗ ${failures.length} 项失败，${passed} 项通过：`));
    for (const failure of failures) info(`  - ${failure}`);
    process.exit(1);
}
info(green(`✓ 全部 ${passed} 项通过。`));
info(dim('  集成用例（git 落后门禁、变更判定、端到端更新）见 SKILL.md 的验收一节。'));