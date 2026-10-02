#!/usr/bin/env node
// Dependency-free static server for the app, used by the browser tests.
//
// Usage: node tools/serve.mjs [port]      (default 8770; 0 picks a free port)
// Import startServer() to run it in-process; it resolves to { server, url }.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
    '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/** @param {number} [port] */
export function startServer(port = 8770) {
    const server = createServer(async (request, response) => {
        try {
            const path = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
            let file = normalize(join(root, path));
            if (file !== root.replace(/[\\/]$/, '') && !file.startsWith(root)) throw Object.assign(new Error('outside root'), { code: 'EACCES' });
            if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
            const body = await readFile(file);
            response.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
                'cache-control': 'no-store' });
            response.end(body);
        } catch (error) {
            const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
            response.writeHead(missing ? 404 : error?.code === 'EACCES' ? 403 : 500, { 'content-type': 'text/plain' });
            response.end(missing ? 'Not found' : 'Error');
        }
    });
    return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            const address = server.address();
            const actual = typeof address === 'object' && address ? address.port : port;
            resolvePromise({ server, url: `http://127.0.0.1:${actual}/` });
        });
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { url } = await startServer(Number(process.argv[2] ?? 8770));
    console.log(`Serving ${root.split(sep).join('/')} at ${url}`);
}
