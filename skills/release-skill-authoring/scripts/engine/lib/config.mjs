// release.config.json 的加载与校验。零依赖，Node >= 20.12。
//
// release.config.json 是「项目事实」而不是技能附件：它记着这个项目的组件划分、构建命令、
// 业务/运行时文件边界、清单托管地址、分支与发布纪律。生成的发版技能里所有脚本都从它读参数，
// 脚本本身不硬编码任何项目路径 —— 这也是换项目时唯一需要重写的东西（由 release-scaffold 生成）。
//
// 校验一律 fail-closed：字段缺失或类型不对就报错退出，不要猜默认值。
// 发版脚本静默用了错误的路径，后果是发出一个内容不全的包，而这在用户投诉前不会被发现。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fail } from './cli.mjs';

/** 读取并校验配置文件。返回的对象带 `__configPath` / `__repoRoot` 两个解析后的绝对路径。 */
export function loadConfig(configPath) {
    if (!existsSync(configPath)) fail(`找不到配置文件：${configPath}`);
    let config;
    try {
        config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
        fail(`配置文件不是合法 JSON：${configPath}\n${error.message}`);
    }

    if (config.schema !== 1) {
        fail(`配置文件的 schema 必须是 1，当前是 ${JSON.stringify(config.schema)}。`);
    }

    const requireObject = (value, path) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            fail(`配置项 ${path} 缺失或不是对象。`);
        }
        return value;
    };
    const requireString = (value, path) => {
        if (typeof value !== 'string' || value === '') fail(`配置项 ${path} 缺失或不是非空字符串。`);
        return value;
    };
    const requireArray = (value, path) => {
        if (!Array.isArray(value) || value.length === 0) fail(`配置项 ${path} 缺失或不是非空数组。`);
        return value;
    };

    const project = requireObject(config.project, 'project');
    requireString(project.name, 'project.name');
    requireString(project.slug, 'project.slug');

    // 仓库根：默认是配置文件所在目录的上一级（配置在 <repo>/release/ 下）
    const configDir = dirname(resolve(configPath));
    const repoRoot = project.repoRoot
        ? isAbsolute(project.repoRoot)
            ? project.repoRoot
            : resolve(configDir, project.repoRoot)
        : dirname(configDir);
    if (!existsSync(repoRoot)) fail(`project.repoRoot 解析出的目录不存在：${repoRoot}`);

    const components = requireObject(config.components, 'components');
    for (const name of ['database', 'backend', 'frontend', 'client']) {
        const component = components[name];
        if (component === undefined || component === null) continue;
        requireObject(component, `components.${name}`);
        if (component.enabled === false) continue;
        requireArray(component.globs, `components.${name}.globs`);
        if (name === 'client') {
            // 客户端必须把「业务文件」与「运行时文件」划清：这是决定更新包能不能覆盖的前提。
            // 两个都为空等于没划，直接拒绝 —— 白名单漏项会导致「该更新的没更新」且无人察觉。
            if (!Array.isArray(component.businessGlobs) || component.businessGlobs.length === 0) {
                fail('components.client.businessGlobs 缺失或为空：必须显式声明哪些文件算「业务相关」。');
            }
        }
    }

    const release = requireObject(config.release, 'release');
    requireString(release.branch, 'release.branch');

    // 清单是**客户端更新机制**的一部分。没有客户端的项目（纯后端 / 纯前端）压根没有清单，
    // 硬要求这两个字段只会逼人填一个假值 —— 实测：一个纯后端项目被迫写了 .invalid 占位地址
    // 才过得了校验，而那个地址在生成物里会跟真的一起出现。
    if (components.client?.enabled !== false) {
        const manifest = requireObject(config.manifest, 'manifest');
        requireString(manifest.baseUrl, 'manifest.baseUrl');
        requireString(manifest.channel, 'manifest.channel');
    }

    return { ...config, __configPath: resolve(configPath), __repoRoot: repoRoot };
}

/** 配置目录（<repo>/release/）——状态文件、历史归档、更新说明都落在这里。 */
export function configDirOf(config) {
    return dirname(config.__configPath);
}

/** 发版目录下的某个文件。 */
export function releaseFile(config, name) {
    return join(configDirOf(config), name);
}

/** 把 glob 里的反斜杠统一成正斜杠，避免 Windows 下手写的配置在 git 侧匹配不上。 */
export function normalizeGlobs(globs) {
    return globs.map((glob) => glob.replace(/\\/g, '/'));
}