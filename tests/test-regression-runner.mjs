import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = mkdtempSync(join(root, '.regression-runner-'));
const bytes = 2 * 1024 * 1024;

function runGate({ suiteExit = 0, clearanceExit = 0, importsExit = 0, summary = 'Routed 65/76 connections, 239 tracks, 174 vias', violations = 0 } = {}) {
    writeFileSync(join(fixture, 'tools', 'check-imports.mjs'), `
        console.log('Import boundaries: stub');
        process.exitCode = ${importsExit};
    `);
    writeFileSync(join(fixture, 'tests', 'test-output.mjs'), `
        process.stdout.write('o'.repeat(${bytes}));
        console.log('SUITE-STDOUT-END');
        process.stderr.write('e'.repeat(${bytes}));
        console.error('SUITE-STDERR-END');
        process.exitCode = ${suiteExit};
    `);
    writeFileSync(join(fixture, 'tools', 'check-clearance-full.mjs'), `
        console.log(${JSON.stringify(summary)});
        console.log('Total violations: ${violations}');
        console.error('CLEARANCE-STDERR-END');
        process.exitCode = ${clearanceExit};
    `);
    return spawnSync(process.execPath, [join(fixture, 'tools', 'regression.mjs')], {
        cwd: fixture, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
    });
}

try {
    mkdirSync(join(fixture, 'tools'));
    mkdirSync(join(fixture, 'tests'));
    for (const file of ['regression.mjs', 'test.mjs']) {
        copyFileSync(join(root, 'tools', file), join(fixture, 'tools', file));
    }

    const pass = runGate();
    assert.ifError(pass.error);
    assert.equal(pass.status, 0, 'Verbose passing children must not overflow the gate buffer');
    assert.ok(pass.stdout.includes('o'.repeat(bytes) + 'SUITE-STDOUT-END'));
    assert.ok(pass.stderr.includes('e'.repeat(bytes) + 'SUITE-STDERR-END'));
    assert.match(pass.stdout, /1\/1 regression files passed/);
    assert.match(pass.stdout, /REGRESSION GATE: PASS\s*$/);
    assert.match(pass.stderr, /CLEARANCE-STDERR-END/);

    const failed = runGate({ suiteExit: 7 });
    assert.ifError(failed.error);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /FAIL  regression suite exits cleanly/);
    assert.match(failed.stderr, /Failed: test-output\.mjs/);
    assert.match(failed.stdout, /PASS  check-clearance-full exits cleanly/);
    assert.match(failed.stdout, /REGRESSION GATE: FAIL\s*$/);

    for (const options of [{ clearanceExit: 3 }, { summary: 'unparseable' }, { violations: 1 }]) {
        const result = runGate(options);
        assert.ifError(result.error);
        assert.equal(result.status, 1, 'Clearance failures must remain hard failures');
        assert.match(result.stdout, /REGRESSION GATE: FAIL\s*$/);
    }

    const boundaries = runGate({ importsExit: 1 });
    assert.ifError(boundaries.error);
    assert.equal(boundaries.status, 1, 'Import-boundary failures are hard failures');
    assert.match(boundaries.stdout, /FAIL  import boundaries match tools\/import-baseline\.json/);
    assert.match(boundaries.stdout, /PASS  regression suite exits cleanly/, 'Later checks still run');
    assert.match(boundaries.stdout, /REGRESSION GATE: FAIL\s*$/);

    const warning = runGate({ summary: 'Routed 65/76 connections, 238 tracks, 173 vias' });
    assert.ifError(warning.error);
    assert.equal(warning.status, 0);
    assert.match(warning.stdout, /soft warnings: 2/);
    assert.match(warning.stdout, /REGRESSION GATE: PASS \(with soft warnings/);
    console.log('PASS regression runner streams verbose children, preserves diagnostics and gate exit policy');
} finally {
    rmSync(fixture, { recursive: true, force: true });
}
