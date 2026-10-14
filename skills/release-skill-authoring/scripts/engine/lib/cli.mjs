// 极简参数解析与统一输出。零依赖，Node >= 20.12。
//
// 只支持三种形式：--flag、--key value、--key=value，外加位置参数。
// 不引第三方 CLI 库：这些脚本会被 vendor 进目标项目长期运行，零依赖才不会被供应链和版本漂移咬到。

/** 是否给输出上色。重定向到文件时自动关掉，免得日志里全是转义码。 */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

export const dim = paint('90');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const cyan = paint('36');

/** 普通信息，走 stdout。 */
export function info(message = '') {
    process.stdout.write(`${message}\n`);
}

/** 步骤标题，走 stdout。 */
export function step(message) {
    process.stdout.write(`${cyan('▸')} ${message}\n`);
}

/**
 * 成功，走 stdout。
 *
 * `detail` 是可选的补充信息（远端体积、HTTP 状态码、命中的文件…），以暗色跟在后面。
 * 它存在的理由是**检查类脚本要能一眼看出「凭什么算通过」** —— 只打一行「✓ 清单可达」
 * 没法区分「真验过了」和「跳过了」，而这两者在发版体检里差别很大。
 */
export function ok(message, detail = '') {
    process.stdout.write(`${green('✓')} ${message}${detail ? `  ${dim(detail)}` : ''}\n`);
}

/** 警告，走 stderr（不改变退出码）。 */
export function warn(message) {
    process.stderr.write(`${yellow('!')} ${message}\n`);
}

/**
 * 次要提示，走 **stderr**。
 *
 * 用在「stdout 要被 shell 捕获」的场景：`NEXT=$(node release-version.mjs --print)`
 * 只该拿到裸版本号，任何状态提示走 stdout 都会被一起捕获，把变量弄脏。
 */
export function note(message) {
    process.stderr.write(`${dim(message)}\n`);
}

/**
 * 失败并退出。**一律走 stderr 且退出码非 0** —— 发版流程靠退出码做门禁，
 * 不要用 info 打印错误再继续（那会让门禁形同虚设）。
 */
export function fail(message, code = 1) {
    process.stderr.write(`${red('✗')} ${message}\n`);
    process.exit(code);
}

/** 解析 argv（已去掉 node 与脚本路径）。 */
export function parseArgs(argv) {
    const flags = {};
    const positionals = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            positionals.push(arg);
            continue;
        }
        const equals = arg.indexOf('=');
        if (equals >= 0) {
            flags[arg.slice(2, equals)] = arg.slice(equals + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags[arg.slice(2)] = next;
            i += 1;
        } else {
            flags[arg.slice(2)] = true;
        }
    }
    return { flags, positionals };
}

/** 取必填字符串参数，缺失就退出。 */
export function requireFlag(flags, name, hint) {
    const value = flags[name];
    if (typeof value !== 'string' || value === '') {
        fail(`缺少 --${name} 参数。${hint ?? ''}`);
    }
    return value;
}

/** 输出 JSON（人读时用 2 空格缩进；机器读时用 --json 走紧凑或缩进都行，这里统一缩进）。 */
export function printJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}