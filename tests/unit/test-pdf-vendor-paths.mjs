import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './helpers/fake-dom.mjs';

// The vector PDF loader injects the vendored jsPDF and svg2pdf scripts. Their URLs
// must resolve to the real files whichever page or module location loads them.
const requested = [];
const document = installFakeDom();
document.scripts = [];
document.head = {
    appendChild(script) {
        requested.push(script.src);
        if (script.src.endsWith('jspdf.umd.min.js')) globalThis.window.jspdf = { jsPDF: function jsPDF() {} };
        if (script.src.endsWith('svg2pdf.umd.min.js')) globalThis.window.svg2pdf = { svg2pdf() {} };
        queueMicrotask(() => script.onload());
    },
};

const { loadVectorPdfLibs } = await import('../../src/shared/ui/export.js');
const jsPDF = await loadVectorPdfLibs({});

assert.equal(typeof jsPDF, 'function');
assert.equal(requested.length, 2);
for (const src of requested) {
    const url = new URL(src);
    assert.equal(url.protocol, 'file:', `absolute module-relative URL expected, got ${src}`);
    assert.ok(existsSync(fileURLToPath(url)), `vendored script missing at ${src}`);
}
console.log('PASS: vector PDF loader requests the vendored scripts that exist');
