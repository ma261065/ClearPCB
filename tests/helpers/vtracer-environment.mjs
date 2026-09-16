import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export function installVTracerEnvironment({ failures = 0 } = {}) {
    let loads = 0;
    globalThis.fetch = async url => {
        assert.equal(url.href, new URL('../../assets/vendor/vtracer_wasm_bg.wasm', import.meta.url).href);
        loads++;
        if (loads <= failures) return { ok: false, status: 503 };
        const bytes = await readFile(url);
        return { ok: true, async arrayBuffer() { return bytes; } };
    };
    globalThis.DOMParser = class {
        parseFromString(svg, mime) {
            assert.equal(mime, 'image/svg+xml');
            assert.match(svg, /^<\?xml[\s\S]*<svg[\s\S]*<\/svg>\s*$/);
            const paths = [...svg.matchAll(/<path\s+([^>]+)\/>/g)].map(match => {
                const attributes = new Map([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(item => [item[1], item[2]]));
                return { getAttribute(name) { return attributes.get(name) ?? null; }, hasAttribute(name) { return attributes.has(name); } };
            });
            return { querySelector() { return null; }, querySelectorAll(name) { assert.equal(name, 'path'); return paths; } };
        }
    };
    return { get loads() { return loads; } };
}