#!/usr/bin/env node
// Autorouter regression gate.
//
// Runs all tests/unit/ regression scripts plus a full clearance check on test-board.json
// and asserts against the documented baseline. Exits 0 if all checks pass,
// nonzero on any regression. Intended to be run before committing autorouter
// changes.
//
// Usage:
//   node tools/regression.mjs
//
// HARD checks (cause exit code 1):
//   - import boundaries match tools/import-baseline.json
//   - PCB editor access matches tools/pcb-editor-access-baseline.json
//   - schematic editor access matches tools/schematic-editor-access-baseline.json
//   - regression suite exits cleanly
//   - check-clearance-full exits cleanly
//   - total connection count matches baseline
//   - routed connection count >= baseline (must not route fewer)
//   - clearance violations == 0
//
// SOFT checks (warn only):
//   - track count == baseline   (routing-output stability indicator)
//   - via count == baseline     (routing-output stability indicator)
//
// Soft checks exist so legitimate quality wins (e.g. fewer tracks for the
// same routed count) don't fail the gate — but any divergence is logged so
// the change author can review whether the routing change was intended.

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Baseline: the committed test-board.json, routed by the maze router. The first
// baseline (65 routed, 239 tracks, 174 vias; fced078) predates the board's commit
// (1743893) and was never reproduced on it: every commit since routes it to exactly
// 74/76 with 288 tracks and 214 vias, on Windows and on the Linux CI runner alike.
// Routing fewer connections is a hard failure; update these numbers deliberately
// (and say why in the commit) when a router change improves them.
// Elapsed ~100-150s; timing is machine-dependent and informational only.
const BASELINE = {
    board: 'test-board.json',
    routed: 74,
    total: 76,
    tracks: 288,
    vias: 214,
    violations: 0,
};

let failures = 0;
let warnings = 0;

function run(cmd, args, capture = false) {
    console.log(`\n$ ${cmd} ${args.join(' ')}`);
    const t0 = Date.now();
    // Only the clearance summary needs capture; the suite can exceed maxBuffer.
    const r = spawnSync(cmd, args, {
        cwd: repoRoot, encoding: 'utf8', shell: false,
        stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    });
    const dt = Date.now() - t0;
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.error) {
        console.error('FAIL  process error:', r.error.message);
        failures++;
        return { code: -1, out: '', dt };
    }
    if (r.signal) console.error(`FAIL  process terminated by signal: ${r.signal}`);
    return { code: r.status, out: r.stdout || '', dt };
}

function hardCheck(cond, msg) {
    if (cond) console.log(`PASS  ${msg}`);
    else { console.log(`FAIL  ${msg}`); failures++; }
}

function softCheck(cond, msg) {
    if (cond) console.log(`OK    ${msg}`);
    else { console.log(`WARN  ${msg}`); warnings++; }
}

console.log('=== ClearPCB Autorouter Regression Gate ===');

// 1. Documented import-direction rules and editor private-member access
console.log('\n--- [1/3] architecture boundaries ---');
{
    const imports = run(process.execPath, ['tools/check-imports.mjs']);
    hardCheck(imports.code === 0, 'import boundaries match tools/import-baseline.json');
    const access = run(process.execPath, ['tools/check-pcb-editor-access.mjs']);
    hardCheck(access.code === 0, 'PCB editor access matches tools/pcb-editor-access-baseline.json');
    const schematicAccess = run(process.execPath, ['tools/check-schematic-editor-access.mjs']);
    hardCheck(schematicAccess.code === 0, 'schematic editor access matches tools/schematic-editor-access-baseline.json');
}

// 2. Isolated regression suite
console.log('\n--- [2/3] isolated regression suite ---');
{
    const r = run(process.execPath, ['tools/test.mjs']);
    hardCheck(r.code === 0, 'regression suite exits cleanly');
}

// 3. Full clearance regression on test-board.json
console.log('\n--- [3/3] full clearance check on test-board.json ---');
{
    const r = run(process.execPath, ['tools/check-clearance-full.mjs', BASELINE.board], true);
    hardCheck(r.code === 0, 'check-clearance-full exits cleanly');

    const routedMatch = r.out.match(/Routed (\d+)\/(\d+) connections, (\d+) tracks, (\d+) vias/);
    const violMatch = r.out.match(/Total violations:\s*(\d+)/);

    if (!routedMatch || !violMatch) {
        console.log('FAIL  could not parse check-clearance-full output');
        failures++;
    } else {
        const routed = parseInt(routedMatch[1], 10);
        const total = parseInt(routedMatch[2], 10);
        const tracks = parseInt(routedMatch[3], 10);
        const vias = parseInt(routedMatch[4], 10);
        const violations = parseInt(violMatch[1], 10);

        hardCheck(total === BASELINE.total,
            `total connections == ${BASELINE.total} (got ${total})`);
        hardCheck(routed >= BASELINE.routed,
            `routed >= ${BASELINE.routed} (got ${routed})`);
        hardCheck(violations === BASELINE.violations,
            `clearance violations == ${BASELINE.violations} (got ${violations})`);
        softCheck(tracks === BASELINE.tracks,
            `tracks == ${BASELINE.tracks} (got ${tracks})`);
        softCheck(vias === BASELINE.vias,
            `vias == ${BASELINE.vias} (got ${vias})`);

        console.log(`INFO  elapsed ${(r.dt / 1000).toFixed(1)}s ` +
            `(typically 100-150s; timing is machine-dependent and informational)`);
    }
}

console.log('\n=== SUMMARY ===');
console.log(`hard failures: ${failures}`);
console.log(`soft warnings: ${warnings}`);
if (failures === 0) {
    console.log(warnings === 0
        ? 'REGRESSION GATE: PASS'
        : 'REGRESSION GATE: PASS (with soft warnings — review routing diff)');
} else {
    console.log('REGRESSION GATE: FAIL');
}
// Let pending stdout/stderr writes drain when CI captures output through pipes.
process.exitCode = failures === 0 ? 0 : 1;
