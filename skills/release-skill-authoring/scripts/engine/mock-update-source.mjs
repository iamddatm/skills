#!/usr/bin/env node
// 本机伪更新源：把一个目录当静态站提供出来，用于端到端验证客户端/安装包的更新逻辑。
// 零依赖，Node >= 20.12。
//
//   node mock-update-source.mjs --dir <目录> [--port 8099] [--quiet]
//
// 为什么不用 PowerShell 的 HttpListener：它在非管理员会话下常需要 URL 预留，
// 在 CI 与受限环境里不可靠。Node 的 http 模块没有这些限制。
//
// 缓存头按真实约定设：清单 no-store（必须每次都是最新），其余长缓存（包按随机文件名天然唯一）。
// 这样验证脚本才能真正验到「客户端不会因为缓存拿到旧清单」。

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fail, info, ok, parseArgs, requireFlag } from './lib/cli.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const root = resolve(requireFlag(flags, 'dir', '要提供出去的目录。'));
const port = typeof flags.port === 'string' ? Number(flags.port) : 8099;

if (!existsSync(root)) fail(`目录不存在：${root}`);

const TYPES = {
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.exe': 'application/octet-stream',
    '.7z': 'application/x-7z-compressed',
};

const server = createServer((request, response) => {
    // 路径穿越防护：解析后必须仍在 root 之下
    const pathOnly = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = resolve(join(root, normalize(pathOnly).replace(/^([/\\])+/, '')));
    if (target !== root && !target.startsWith(root + sep)) {
        response.writeHead(403).end('forbidden');
        return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
        response.writeHead(404).end('not found');
        if (!flags.quiet) info(`  404 ${pathOnly}`);
        return;
    }

    const body = readFileSync(target);
    const isManifest = target.endsWith('manifest.json');
    response.writeHead(200, {
        'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
        'content-length': body.length,
        // 清单必须 no-store，包按随机文件名可以长缓存 —— 与线上约定一致
        'cache-control': isManifest ? 'no-store, no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
    });
    response.end(body);
    if (!flags.quiet) info(`  200 ${pathOnly} (${body.length} 字节)`);
});

server.listen(port, '127.0.0.1', () => {
    // 这一行是给验证脚本等的就绪信号，格式不要改
    ok(`READY http://127.0.0.1:${port}/`);
    info(`伪源根目录：${root}`);
});

process.on('SIGINT', () => {
    server.close(() => process.exit(0));
});