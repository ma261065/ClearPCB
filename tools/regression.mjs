#!/usr/bin/env node
// Autorouter regression gate.
//
// Runs the geometry smoke test plus a full clearance check on test-board.json
// and asserts against the documented baseline. Exits 0 if all checks pass,
// nonzero on any regression. Intended to be run before committing autorouter
// changes.
//
// Usage:
//   node tools/regression.mjs
//
// HARD checks (cause exit code 1):
//   - geometry primitive test exits cleanly
//   - check-clearance-full exits cleanly
//   - total connection count matches baseline
//   - routed connection count >= baseline (must not route fewer)
//   - clearance violations == 0
//
// SOFT checks (warn only):
//   - trace count == baseline   (routing-output stability indicator)
//   - via count == baseline     (routing-output stability indicator)
//
// Soft checks exist so legitimate quality wins (e.g. fewer traces for the
// same routed count) don't fail the gate — but any divergence is logged so
// the change author can review whether the routing change was intended.

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Baseline locked after commit `fced078` (numeric A* keys).
// Mean elapsed ~110s on a typical dev machine; timing is informational only.
const BASELINE = {
    board: 'test-board.json',
    routed: 65,
    total: 76,
    traces: 239,
    vias: 174,
    violations: 0,
};

let failures = 0;
let warnings = 0;

function run(cmd, args) {
    console.log(`\n$ ${cmd} ${args.join(' ')}`);
    const t0 = Date.now();
    const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', shell: false });
    const dt = Date.now() - t0;
    if (r.error) {
        console.error('FAIL  process error:', r.error.message);
        failures++;
        return { code: -1, out: '', dt };
    }
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return { code: r.status, out: r.stdout, dt };
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

// 1. Geometry primitive smoke test
console.log('\n--- [1/2] geometry primitive smoke (test-aabb.mjs) ---');
{
    const r = run(process.execPath, ['test-aabb.mjs']);
    hardCheck(r.code === 0, 'test-aabb.mjs exits cleanly');
}

// 2. Full clearance regression on test-board.json
console.log('\n--- [2/2] full clearance check on test-board.json ---');
{
    const r = run(process.execPath, ['tools/check-clearance-full.mjs', BASELINE.board]);
    hardCheck(r.code === 0, 'check-clearance-full exits cleanly');

    const routedMatch = r.out.match(/Routed (\d+)\/(\d+) connections, (\d+) traces, (\d+) vias/);
    const violMatch = r.out.match(/Total violations:\s*(\d+)/);

    if (!routedMatch || !violMatch) {
        console.log('FAIL  could not parse check-clearance-full output');
        failures++;
    } else {
        const routed = parseInt(routedMatch[1], 10);
        const total = parseInt(routedMatch[2], 10);
        const traces = parseInt(routedMatch[3], 10);
        const vias = parseInt(routedMatch[4], 10);
        const violations = parseInt(violMatch[1], 10);

        hardCheck(total === BASELINE.total,
            `total connections == ${BASELINE.total} (got ${total})`);
        hardCheck(routed >= BASELINE.routed,
            `routed >= ${BASELINE.routed} (got ${routed})`);
        hardCheck(violations === BASELINE.violations,
            `clearance violations == ${BASELINE.violations} (got ${violations})`);
        softCheck(traces === BASELINE.traces,
            `traces == ${BASELINE.traces} (got ${traces})`);
        softCheck(vias === BASELINE.vias,
            `vias == ${BASELINE.vias} (got ${vias})`);

        console.log(`INFO  elapsed ${(r.dt / 1000).toFixed(1)}s ` +
            `(baseline ~110s; timing is machine-dependent and informational)`);
    }
}

console.log('\n=== SUMMARY ===');
console.log(`hard failures: ${failures}`);
console.log(`soft warnings: ${warnings}`);
if (failures === 0) {
    console.log(warnings === 0
        ? 'REGRESSION GATE: PASS'
        : 'REGRESSION GATE: PASS (with soft warnings — review routing diff)');
    process.exit(0);
} else {
    console.log('REGRESSION GATE: FAIL');
    process.exit(1);
}
