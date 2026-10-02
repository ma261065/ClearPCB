import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('index.html');
assert.doesNotMatch(html, /\btraces?\b/i, 'PCB help and tooltips consistently say track');
assert.match(html, /Clear all tracks and restore ratlines/);
assert.match(html, /Tracks and vias will appear/);

const pcb = read('src/ui/PCBApp.js');
const status = pcb.split('\n').find(line => line.includes('this.setStatus(`Imported ${result.tracks.length}'));
assert.ok(status);
let displayed;
new Function('result', status).call({ setStatus: message => { displayed = message; } },
    { tracks: [1, 2], vias: [1] });
assert.equal(displayed, 'Imported 2 track(s), 1 via(s) from SES');

const summaries = [];
for (const name of ['check-clearance', 'check-clearance-full', 'check-clearance-pathfinder']) {
    const source = read(`tools/${name}.mjs`);
    const line = source.split('\n').find(line => line.startsWith('console.log(`') && line.includes('Routed ${routed}'));
    assert.ok(line);
    let summary;
    new Function('console', 'result', 'routed', line)(
        { log: message => { summary = message; } },
        { tracks: Array(288), vias: Array(214), totalConnectionCount: 76 }, 74);
    assert.equal(summary.trim(), 'Routed 74/76 connections, 288 tracks, 214 vias');
    assert.doesNotMatch(source, /addVio\('(?:trace|via↔trace)/);
    summaries.push(summary);
}

// Exercise the real gate parser/checks without rerunning the router for a label change.
const gate = read('tools/regression.mjs')
    .replace(/^#!.*\n/, '')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/import\.meta\.url/g, "'fixture'");
for (const [summary, violations, expectedExit] of [
    [summaries[1], 0, 0], [summaries[1], 1, 1], ['unrecognized output', 0, 1],
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
    assert.equal(calls, 4, 'Both boundary checks, the regression suite and the clearance check each run once');
    assert.equal(gateProcess.exitCode, expectedExit, 'Terminology must not bypass gate failures');
    if (expectedExit === 0) {
        assert.ok(output.includes('WARN  tracks == 239 (got 288)'), 'Keep the original count threshold');
        assert.ok(output.includes('WARN  vias == 174 (got 214)'));
    }
}
assert.match(read('src/pcb/modules/dsn.js'), /Imported \$\{tracks.length\} track segments/);
assert.match(read('tools/compare-routers.mjs'), /tracks=\$\{result.tracks.length\}/);
console.log('PASS track UI terminology, SES status, routing summaries and unchanged regression gate thresholds');
