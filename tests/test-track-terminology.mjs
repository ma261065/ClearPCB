import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('index.html');
const ribbon = read('src/pcb/modules/ribbon-description.js');
const uiText = `${html}\n${ribbon}`;
assert.doesNotMatch(uiText, /\btraces?\b/i, 'PCB help and tooltips consistently say track');
assert.match(uiText, /Clear all tracks and restore ratlines/);
assert.match(uiText, /Tracks and vias will appear/);

// Drive the real SES import: file picker -> FileReader -> parser -> status line.
let picker;
globalThis.window = { addEventListener() {} };
globalThis.document = {
    createElement: () => (picker = { files: [], listeners: {}, clicked: 0, click() { this.clicked++; }, addEventListener(name, fn) { this.listeners[name] = fn; } }),
    createElementNS: () => ({}), body: {}, documentElement: { getAttribute: () => 'dark' }, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.FileReader = class { readAsText(text) { this.result = text; this.onload(); } };
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
let displayed, rendered;
const editor = pcbEditorFixture({
    setStatus: message => { displayed = message; }, _cancelAutoRoute() {},
    _renderRouteResult: result => { rendered = result; },
});
const quietLog = console.log;
console.log = () => {};
try {
    editor.importSES();
    assert.equal(picker.clicked, 1, 'Import opens the file picker');
    picker.files = [`(session fixture (routes (resolution mm 1000) (network_out (net N1
        (wire (path F.Cu 200 0 0 1000 0)) (wire (path B.Cu 200 1000 0 1000 1000)) (via via_default 1000 0)))))`];
    picker.listeners.change();
} finally {
    console.log = quietLog;
}
assert.equal(rendered.tracks.length, 2);
assert.equal(displayed, 'Imported 2 track(s), 1 via(s) from SES');

const { routingSummary } = await import('../tools/routing-summary.mjs');
const routedSummary = routingSummary({ tracks: Array(288), vias: Array(214), totalConnectionCount: 76 }, 74);
assert.equal(routedSummary, 'Routed 74/76 connections, 288 tracks, 214 vias');
for (const name of ['check-clearance', 'check-clearance-full', 'check-clearance-pathfinder']) {
    const source = read(`tools/${name}.mjs`);
    assert.match(source, /console\.log\((?:`\\n\$\{)?routingSummary\(result, routed\)/,
        'Each clearance tool prints the shared summary the gate parses');
    assert.doesNotMatch(source, /addVio\('(?:trace|via↔trace)/);
}

// Exercise the real gate parser/checks without rerunning the router for a label change.
const gate = read('tools/regression.mjs')
    .replace(/^#!.*\n/, '')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/import\.meta\.url/g, "'fixture'");
for (const [summary, violations, expectedExit] of [
    [routedSummary, 0, 0], [routedSummary, 1, 1], ['unrecognized output', 0, 1],
]) {
    const output = [];
    let calls = 0;
    const gateProcess = { execPath: 'node', stdout: { write() {} }, stderr: { write() {} }, exitCode: undefined };
    runInNewContext(gate, {
        fileURLToPath: value => value, dirname: () => '.', join: (...parts) => parts.join('\\'),
        console: { log: message => output.push(message), error: message => output.push(message) },
        spawnSync(_cmd, args) {
            calls++;
            const clearance = args[0] === 'tools/check-clearance-full.mjs';
            return { status: 0, stdout: clearance ? `${summary}\nTotal violations: ${violations}\n` : '', stderr: '' };
        },
        process: gateProcess,
    });
    assert.equal(calls, 5, 'The three boundary checks, the regression suite and the clearance check each run once');
    assert.equal(gateProcess.exitCode, expectedExit, 'Terminology must not bypass gate failures');
    if (expectedExit === 0) {
        assert.ok(output.includes('WARN  tracks == 239 (got 288)'), 'Keep the original count threshold');
        assert.ok(output.includes('WARN  vias == 174 (got 214)'));
    }
}
assert.match(read('src/pcb/modules/dsn.js'), /Imported \$\{tracks.length\} track segments/);
assert.match(read('tools/compare-routers.mjs'), /tracks=\$\{result.tracks.length\}/);
console.log('PASS track UI terminology, SES status, routing summaries and unchanged regression gate thresholds');
