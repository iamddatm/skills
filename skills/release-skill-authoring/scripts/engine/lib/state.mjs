// 发版状态文件的读写。零依赖，Node >= 20.12。
//
// release-state.json 是**发布流程的唯一记忆**：它记住上次发到哪个 git tag/commit、各组件版本、
// 客户端发布序号与最低支持版本、镜像 digest、以及各组件的内容指纹。
// 「这次哪些组件要重新构建」全靠它对比；它丢了或写坏了，流程会退化成 fail-closed（全部重建），
// 所以写入必须是原子的 —— 中途断电不能留下半截 JSON。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 原子写入：先写同目录的临时文件，再 rename 覆盖。rename 在同分区上是原子的。 */
export function atomicWrite(filePath, text) {
    const directory = dirname(filePath);
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.${Date.now()}-${process.pid}.tmp`);
    writeFileSync(temporary, text, 'utf8');
    try {
        renameSync(temporary, filePath);
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
}

/** 读状态文件；不存在返回 null（调用方据此走 fail-closed 分支）。文件损坏则报错，不要静默当成空。 */
export function loadState(filePath) {
    if (!existsSync(filePath)) return null;
    try {
        return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`发版状态文件损坏，读不了：${filePath}\n${error.message}\n先人工确认它的内容，不要直接删掉重来。`);
    }
}

/** 写状态文件（原子）。 */
export function saveState(filePath, state) {
    atomicWrite(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

/** 状态文件的默认结构。新项目首次发版时用它兜底。 */
export function emptyState() {
    return {
        schema: 1,
        lastReleaseId: '',
        lastReleaseTag: '',
        lastReleaseCommit: '',
        releasedAt: '',
        versions: { client: '', database: '', backend: '', frontend: '' },
        clientSeq: 0,
        clientMinVersion: '',
        clientFullBaseline: '',
        backendImageDigests: {},
        artifacts: [],
        componentFingerprints: {},
    };
}