// 客户端版本号的规则与比较。零依赖，Node >= 20.12。
//
// 版本号是四段「年.自增数.月.日」（如 26.10.1.1）：
//   两位年号 + 年内自增数（同一自然年内每次发布 +1，跨年重置为 1）+ 发布当天的月、日。
// 排序语义是 年 > 自增数 > 月 > 日，而自增数每次发布必增，所以新版本号**严格大于**上一版。
//
// 为什么不用 semver、也不靠 PowerShell 的 [version]：见 compareVersions 的注释。

/** 版本号必须是四段纯数字。用显式正则而不是框架强转 —— [version] 会接受 2~4 段，挡不住三段号。 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

/** 是否为合法版本号（四段纯数字）。 */
export function isVersion(value) {
    return typeof value === 'string' && VERSION_PATTERN.test(value);
}

/** 拆成整数段；段数不足补 0。非法版本号抛异常（调用方要先 isVersion）。 */
export function versionParts(value) {
    if (!isVersion(value)) throw new Error(`不是四段版本号：${JSON.stringify(value)}`);
    return value.split('.').map((part) => Number.parseInt(part, 10));
}

/**
 * 逐段按**整数**比较：a 大返回 1，相等 0，小返回 -1。
 *
 * 不能按字符串比 —— "26.10.1.1" 按字符串会小于 "26.9.1.1"，而自增数是每次发版必增的那一段。
 * 也正因如此，客户端判断「要不要更新」绝不能拿字符串比大小（Inno 的 Pascal 侧同样按段比整数，
 * 见 assets/inno/pascal-fragment.iss 的 CompareVersions）。
 */
export function compareVersions(a, b) {
    if (!isVersion(a) || !isVersion(b)) {
        throw new Error(`版本号比较只接受四段纯数字：${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    const left = versionParts(a);
    const right = versionParts(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        const x = left[i] ?? 0;
        const y = right[i] ?? 0;
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

/** a 是否严格大于 b。 */
export function isGreater(a, b) {
    return compareVersions(a, b) > 0;
}

/**
 * 由基准版本和当前日期算出本次版本号。
 *
 * 基准非法、或基准的年号与今天不同 → 自增数从 1 起（跨年重置）。
 * 基准的年号是两位数字符串比较，与 FourSegment 的排序语义一致。
 *
 * @param {string} base 基准版本（取线上/本地/显式三者的较大者，见 maxVersion）
 * @param {Date} [now] 用于取年/月/日，默认当前时间
 */
export function nextVersion(base, now = new Date()) {
    const year = String(now.getFullYear() % 100).padStart(2, '0');
    let increment = 1;
    if (isVersion(base)) {
        const [baseYear, baseIncrement] = versionParts(base);
        if (String(baseYear).padStart(2, '0') === year) increment = baseIncrement + 1;
    }
    // 月、日不补零：与线上已有的版本号（如 26.10.1.1）保持同一写法
    return `${year}.${increment}.${now.getMonth() + 1}.${now.getDate()}`;
}

/**
 * 从若干候选里取**严格最大**的合法版本号，并记录它来自哪个来源。
 *
 * 这就是「版本号以线上为准」的实现：本地计数器会落后（换机、上次发布失败、别人发的版），
 * 只信本地就会发出低于线上的版本号 —— 而客户端只认「版本更高」，那一版等于白发。
 *
 * @param {{value?: string, source: string}[]} candidates 候选（value 为空/非法时自动跳过）
 * @returns {{value: string, source: string} | null} 全空时返回 null，由调用方决定报错还是靠显式基准继续
 */
export function maxVersion(candidates) {
    let best = null;
    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined) continue;
        if (!isVersion(candidate.value)) continue;
        if (best === null || compareVersions(candidate.value, best.value) > 0) {
            best = { value: candidate.value, source: candidate.source };
        }
    }
    return best;
}