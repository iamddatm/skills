// 扁平清单的序列化与「Pascal 可解析性」校验。零依赖，Node >= 20.12。
//
// 为什么需要这套东西
// ------------------
// Inno Setup 的 [Code] 段是 Pascal，**没有 JSON 解析器**。安装包在安装时只能
// LoadStringsFromFile + StringJoin 把清单拼成一个长串，再做子串匹配（算法见
// assets/inno/pascal-fragment.iss 的 JsonStr / JsonStrFrom）。于是清单必须满足三条硬约束：
//
//   1. 顶层标量键必须排在嵌套块**之前** —— JsonStr 取的是**第一个**匹配键，
//      顶层 version 与 full.version 同名，顺序错了会静默读到 full 里的值；
//   2. 字符串值里不能出现引号 —— Pascal 侧没有转义处理，\" 会被当成结束引号；
//   3. 每个「键: 值」完整落在一行内，整个文件是纯 ASCII（非 ASCII 一律 \uXXXX）；
//   4. **所有值都是带引号的字符串**，数字也不能裸写 —— JsonStr 只会「找键 → 找冒号 →
//      取引号对」，遇到裸数字 1 会一路往后找到**下一个字段**的引号，读出来的是别人的内容。
//      这条是实测踩出来的：`"schema": 1` 会让安装包把 schema 读成 "channel"。
//
// 本模块把这三条从「靠人记得」变成「机器校验」：assertPascalParsable 用 JS 复刻了 Pascal
// 那两个函数的算法，把生成的清单读一遍再与源对象逐字段比对 —— **Node 侧读得通，安装包就读得通**。
// 这条断言是发版门禁的一部分，不是可选的礼貌检查。

/** 顶层标量键的规范顺序。full 块必须排在所有这些键之后（见文件头约束 1）。 */
export const TOP_LEVEL_ORDER = [
    'schema',
    'channel',
    'releaseId',
    'generatedAt',
    'version',
    'type',
    'file',
    'sha256',
    'size',
    'notes',
    'seq',
    'minVersion',
    'fullFile',
    'fullSha256',
    'fullSize',
    'reason',
    'databaseVersion',
    'databaseIrreversible',
    'backendVersion',
    'backendApiMinClient',
    'backendEndpointsRemoved',
    'frontendVersion',
    'frontendFile',
    'frontendSha256',
];

/** 允许出现的嵌套块名。只允许一个，且必须是清单的最后一行。 */
export const NESTED_BLOCKS = ['full'];

/** 只有这些键允许出现在嵌套块里（清单是给安装包读的，别在这里塞自由结构）。 */
export const NESTED_BLOCK_KEYS = {
    full: ['version'],
};

/**
 * 安装包的 [Code] 段会**直接读**这些键，因此它们必须是纯 ASCII。
 *
 * 原因是 Pascal 侧拿到的是清单里**转义后的原文**：中文写成 修 之后，JsonStr 读回来的就是
 * 六个字符 `修` 本身，它不会解码。于是拿它跟本地版本号比较永远不相等 —— 症状是
 * 「安装包明明读到了清单，却永远判断成不更新」。版本号、文件名、sha256 天然是 ASCII，这里把它钉住。
 */
export const PASCAL_READ_KEYS = ['version', 'type', 'file', 'sha256', 'fullFile', 'fullSha256'];

/** 清单里实际写下的**原文**（已转义、已去引号）—— 这就是 Pascal 的 JsonStr 会读回来的东西。 */
function rawText(value, key) {
    return encodeScalar(value, key).slice(1, -1);
}

/**
 * 把所有值编成**带引号的字符串**（见文件头约束 4）。
 *
 * 数字/布尔一律先 String() 再加引号：客户端与 Node 侧按需自行转换，安装包侧的 Pascal 则一律当字符串读。
 * 数组与对象直接报错 —— 清单只服务「一行一键、可子串匹配」这一种读法。
 */
function encodeScalar(value, key) {
    if (typeof value === 'string') return encodeString(value, key);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`清单字段 ${key} 不是有限数字：${value}`);
        if (!Number.isInteger(value)) throw new Error(`清单字段 ${key} 只接受整数：${value}`);
        return encodeString(String(value), key);
    }
    if (typeof value === 'boolean') return encodeString(value ? 'true' : 'false', key);
    if (Array.isArray(value)) {
        throw new Error(
            `清单字段 ${key} 是数组 —— 清单里不允许出现数组（Pascal 侧只做子串匹配，读不了）。` +
                `要表达多条内容就合成一条字符串（如 notes 用「；」分隔）。`,
        );
    }
    throw new Error(`清单字段 ${key} 是 ${typeof value} —— 清单只接受字符串/整数/布尔。`);
}

/**
 * 把字符串编成「纯 ASCII 且不含裸引号」的 JSON 字面量。
 *
 * 两个坑：
 *   · 裸引号必须直接报错，不能偷偷替换 —— notes 是给用户看的文案，静默改写比报错更糟；
 *   · 非 ASCII 一律转 \uXXXX：既满足「文件纯 ASCII」（避免不同工具按 GBK 读成乱码），
 *     也让 Pascal 侧的子串匹配天然安全（转义后的值里不会冒出引号）。
 */
function encodeString(value, key) {
    if (value.includes('"')) {
        throw new Error(
            `清单字段 ${key} 的值里有英文双引号，Pascal 侧没有转义处理会被截断：${value}\n` +
                `改成中文引号「」或直角引号，或干脆去掉引号。`,
        );
    }
    let out = '';
    for (const ch of value) {
        const code = ch.codePointAt(0);
        if (ch === '\\') {
            // 反斜杠自己也要转义，否则会和下面生成的 \uXXXX 混淆
            out += '\\\\';
        } else if (code < 0x20) {
            out += '\\u' + code.toString(16).padStart(4, '0');
        } else if (code > 0x7e) {
            if (code > 0xffff) {
                // 增补平面字符（emoji 等）拆成代理对，与 JSON 的处理一致
                const hi = Math.floor((code - 0x10000) / 0x400) + 0xd800;
                const lo = ((code - 0x10000) % 0x400) + 0xdc00;
                out += '\\u' + hi.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0');
            } else {
                out += '\\u' + code.toString(16).padStart(4, '0');
            }
        } else {
            out += ch;
        }
    }
    return `"${out}"`;
}

/**
 * 把清单对象序列化成扁平清单文本（一行一个键）。
 *
 * 顶层标量按 TOP_LEVEL_ORDER 排列，嵌套块永远排在最后 —— 顺序不是审美，是文件头约束 1 的要求。
 *
 * @param {object} manifest 清单对象；未知键直接报错（防止拼错键名后被静默丢弃）
 * @returns {string} 以 \n 结尾的清单文本，纯 ASCII
 */
export function serializeManifest(manifest) {
    const known = new Set([...TOP_LEVEL_ORDER, ...NESTED_BLOCKS]);
    for (const key of Object.keys(manifest)) {
        if (!known.has(key)) {
            throw new Error(`清单里有未知字段 ${key}。要加字段请同时更新 lib/flat-json.mjs 的 TOP_LEVEL_ORDER 与清单契约文档。`);
        }
    }

    const lines = [];
    for (const key of TOP_LEVEL_ORDER) {
        const value = manifest[key];
        if (value === undefined || value === null) continue;
        lines.push(`{ ${encodeString(key, key)}: ${encodeScalar(value, key)} }`);
    }

    for (const block of NESTED_BLOCKS) {
        const value = manifest[block];
        if (value === undefined || value === null) continue;
        const allowed = NESTED_BLOCK_KEYS[block];
        for (const key of Object.keys(value)) {
            if (!allowed.includes(key)) {
                throw new Error(`嵌套块 ${block} 里不允许出现字段 ${key}（只允许：${allowed.join(', ')}）。`);
            }
        }
        const inner = allowed
            .filter((key) => value[key] !== undefined && value[key] !== null)
            .map((key) => `${encodeString(key, key)}: ${encodeScalar(value[key], key)}`)
            .join(', ');
        // 嵌套块拼成一行：Pascal 侧用 JsonStrFrom 先定位 "full" 再往后找键
        lines.push(`{ ${encodeString(block, block)}: { ${inner} } }`);
    }

    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Pascal 侧的算法复刻（assets/inno/pascal-fragment.iss 里 JsonStr / JsonStrFrom 的等价实现）
// ---------------------------------------------------------------------------

/** Pascal 的 Pos()：返回 1 起始的位置，找不到返回 0。 */
export function pascalPos(needle, source) {
    const index = source.indexOf(needle);
    return index < 0 ? 0 : index + 1;
}

/**
 * 复刻 Pascal 的 JsonStr(Source, Key)：找键 → 找冒号 → 取引号对。
 * 找不到一律返回空串（与 Pascal 版一致）。
 */
export function pascalJsonStr(source, key) {
    const needle = `"${key}"`;
    const found = source.indexOf(needle);
    if (found < 0) return '';
    let rest = source.slice(found + needle.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return '';
    rest = rest.slice(colon + 1);
    const open = rest.indexOf('"');
    if (open < 0) return '';
    rest = rest.slice(open + 1);
    const close = rest.indexOf('"');
    if (close < 0) return '';
    return rest.slice(0, close);
}

/** 复刻 Pascal 的 JsonStrFrom(Source, StartPos, Key)；StartPos 是 1 起始位置。 */
export function pascalJsonStrFrom(source, startPos, key) {
    if (startPos < 1 || startPos > source.length) return '';
    return pascalJsonStr(source.slice(startPos - 1), key);
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 把一行 `{ "k": v }` 解成 [key, value]；解不出返回 null（交给结构校验去报错）。 */
function decodeLine(line) {
    const match = /^\{\s*"([A-Za-z][A-Za-z0-9]*)"\s*:\s*(.+?)\s*\}$/.exec(line);
    if (!match) return null;
    try {
        return [match[1], JSON.parse(match[2])];
    } catch {
        return null;
    }
}

/**
 * 校验清单文本能被 Pascal 侧正确读取。**不通过就抛异常** —— 这是发版门禁，调用方不要 try/catch 吞掉。
 *
 * 做四件事：
 *   1. 纯 ASCII 断言（含中文就说明转义漏了，换台按 GBK 读的机器会乱码）；
 *   2. 行结构断言：一行一键、嵌套块只能有一个且必须是最后一行；
 *   3. **算法级回读**：用复刻的 pascalJsonStr 把每个顶层字段读回来与源对象比对；
 *   4. 嵌套块回读：模拟 Pascal 侧「先 Pos('"full"') 再 JsonStrFrom」的读法。
 *
 * 第 3 步是真正的价值所在：它把「顶层 version 排在 full 之前」这条纪律变成了一次实读验证，
 * 顺序写反会在这里直接暴露，而不是等到用户装包时静默读到错误的版本号。
 *
 * @param {string} text serializeManifest 的产物
 * @param {object} manifest 生成它的源对象（用来逐字段对账）
 */
export function assertPascalParsable(text, manifest) {
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) > 0x7e) {
            throw new Error(`清单第 ${text.slice(0, i).split('\n').length} 行含有非 ASCII 字符 ${JSON.stringify(text[i])}，转义漏了。`);
        }
    }

    const lines = text.split('\n').filter((line) => line !== '');
    if (lines.length === 0) throw new Error('清单是空的。');

    const decoded = new Map();
    const nestedSeen = [];
    lines.forEach((line, index) => {
        const isNestedLine = NESTED_BLOCKS.some((block) => line.startsWith(`{ "${block}": {`));
        const parsed = decodeLine(line);
        if (isNestedLine) {
            const block = NESTED_BLOCKS.find((name) => line.startsWith(`{ "${name}": {`));
            if (index !== lines.length - 1) {
                throw new Error(`嵌套块 ${block} 不是最后一行（第 ${index + 1} 行）—— JsonStr 会先撞上顶层同名字段，必须把嵌套块放到最后。`);
            }
            nestedSeen.push(block);
            return;
        }
        if (!parsed) throw new Error(`清单第 ${index + 1} 行不是合法的「一个键一行」结构：${line}`);
        if (NESTED_BLOCKS.includes(parsed[0])) {
            throw new Error(`清单第 ${index + 1} 行把嵌套块 ${parsed[0]} 写成了标量。`);
        }
        if (decoded.has(parsed[0])) throw new Error(`清单里字段 ${parsed[0]} 重复了。`);
        decoded.set(parsed[0], line);
    });

    const joined = lines.join('');
    for (const [key] of decoded) {
        const actual = pascalJsonStr(joined, key);
        // 比对的是**清单原文**（转义后、未解码）—— Pascal 的 JsonStr 读回来的就是它
        const expected = rawText(manifest[key], key);
        if (actual !== expected) {
            throw new Error(
                `Pascal 侧读字段 ${key} 会得到 ${JSON.stringify(actual)}，但清单里是 ${JSON.stringify(expected)}。\n` +
                    `最常见的原因：这个键名在嵌套块里也出现过，而它的顶层行排在嵌套块之后。`,
            );
        }
    }

    // 安装包会直接读的字段必须是纯 ASCII：Pascal 不解码 \uXXXX，中文值会被读成转义串本身
    for (const key of PASCAL_READ_KEYS) {
        if (manifest[key] === undefined || manifest[key] === null) continue;
        const raw = rawText(manifest[key], key);
        if (raw !== String(manifest[key])) {
            throw new Error(
                `安装包会直接读字段 ${key}，但它的值里有需要转义的字符（非 ASCII、引号或反斜杠）。\n` +
                    `Pascal 侧读到的是转义后的原文而不是真实值，比较会永远不相等 —— 症状是「明明有新版却不更新」。`,
            );
        }
    }

    for (const block of NESTED_BLOCKS) {
        const value = manifest[block];
        if (value === undefined || value === null) continue;
        if (!nestedSeen.includes(block)) {
            throw new Error(`清单对象里有 ${block} 块，但文本里没写出来。`);
        }
        const startPos = pascalPos(`"${block}"`, joined);
        for (const [key, expected] of Object.entries(value)) {
            const actual = pascalJsonStrFrom(joined, startPos, key);
            if (actual !== rawText(expected, key)) {
                throw new Error(
                    `Pascal 侧从 "${block}" 之后读 ${key} 会得到 ${JSON.stringify(actual)}，但清单里是 ${JSON.stringify(rawText(expected, key))}。`,
                );
            }
        }
    }
}

/**
 * 把扁平清单文本读回对象（Node 侧自用：合并旧清单、校验单调性、线上体检）。
 * 只认扁平行，读不出的行直接报错 —— 与 assertPascalParsable 的口径保持一致。
 */
export function parseManifest(text) {
    const result = {};
    for (const line of text.split('\n')) {
        if (line === '') continue;
        const block = NESTED_BLOCKS.find((name) => line.startsWith(`{ "${name}": {`));
        if (block) {
            const match = /^\{\s*"[A-Za-z]+"\s*:\s*\{(.*)\}\s*\}$/.exec(line);
            const inner = {};
            for (const pair of match[1].split(',')) {
                const parsed = decodeLine(`{ ${pair.trim()} }`);
                if (!parsed) throw new Error(`清单的 ${block} 块读不了：${line}`);
                inner[parsed[0]] = parsed[1];
            }
            result[block] = inner;
            continue;
        }
        const parsed = decodeLine(line);
        if (!parsed) throw new Error(`清单行读不了：${line}`);
        result[parsed[0]] = parsed[1];
    }
    return result;
}