// 目录指纹与文件哈希。零依赖，Node >= 20.12。
//
// 目录指纹的用途是「判断两次之间真的变了吗」：git 说某个组件目录变过，指纹说它的**内容**变没变。
// 算法与用户的 Sync-Skills.ps1（Get-TreeHash）保持一致：按「相对路径 + 文件 sha256」排序后拼串再取
// sha256 —— 好处是跨平台稳定（路径统一成 /、大小写与排序都由我们来定），且目录搬迁不影响结果。
//
// 注意它**不是**用来做包完整性校验的：那是文件级 sha256（sha256File / sha256Text）的活。

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 文件内容的 sha256（小写 hex）。 */
export function sha256File(filePath) {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** 一段文本/字节的 sha256（小写 hex）。清单与状态文件用它。 */
export function sha256Text(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 递归列出目录下所有文件，返回相对路径（统一 / 分隔）并按字典序排好。 */
export function listFiles(directory) {
    const result = [];
    const walk = (current) => {
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) result.push(full);
        }
    };
    walk(directory);
    return result
        .map((full) => ({ full, relative: relative(directory, full).split('\\').join('/') }))
        .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

/**
 * 目录指纹：相对路径 + 文件 sha256 排序拼串后取 sha256。
 *
 * 目录不存在返回 ''（调用方据此区分「没这个组件」与「组件内容为空」）；
 * 空目录返回 'empty' —— 空目录也是有意义的指纹（源为空则目标也应为空），与 Sync-Skills.ps1 口径一致。
 */
export function treeHash(directory) {
    try {
        if (!statSync(directory).isDirectory()) return '';
    } catch {
        return '';
    }
    const files = listFiles(directory);
    if (files.length === 0) return 'empty';
    const lines = files.map((file) => `${file.relative}=${sha256File(file.full)}`);
    return sha256Text(lines.join('\n'));
}

/**
 * 只按一批 glob 匹配的相对路径算指纹 —— 用于「业务文件集」「运行时文件集」这类子集指纹。
 *
 * @param {string} directory 根目录
 * @param {(relativePath: string) => boolean} match 相对路径谓词
 */
export function subsetHash(directory, match) {
    const files = listFiles(directory).filter((file) => match(file.relative));
    if (files.length === 0) return 'empty';
    const lines = files.map((file) => `${file.relative}=${sha256File(file.full)}`);
    return sha256Text(lines.join('\n'));
}

/** 列出目录下所有文件的相对路径（调用方自己筛）。 */
export function listRelativeFiles(directory) {
    return listFiles(directory).map((file) => file.relative);
}

/** 相对路径是否命中 glob。只支持 `**`、`*`、`?` 三种通配，够用且可预测。 */
export function globToRegExp(glob) {
    let pattern = '';
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                // `**/` 匹配任意层（含零层）；裸 `**` 匹配任意字符
                if (glob[i + 2] === '/') {
                    pattern += '(?:.*/)?';
                    i += 2;
                } else {
                    pattern += '.*';
                    i += 1;
                }
            } else {
                pattern += '[^/]*';
            }
        } else if (ch === '?') {
            pattern += '[^/]';
        } else if ('\\^$.|+()[]{}'.includes(ch)) {
            pattern += `\\${ch}`;
        } else {
            pattern += ch;
        }
    }
    return new RegExp(`^${pattern}$`);
}

/** 相对路径是否命中任一 glob。 */
export function matchesAny(relativePath, globs) {
    return globs.some((glob) => globToRegExp(glob).test(relativePath));
}