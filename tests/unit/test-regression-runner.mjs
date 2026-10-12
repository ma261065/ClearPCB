import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = mkdtempSync(join(root, '.regression-runner-'));
const bytes = 2 * 1024 * 1024;

function runGate({ suiteExit = 0, clearanceExit = 0, importsExit = 0, accessExit = 0, schematicAccessExit = 0, sharedAccessExit = 0, docsExit = 0, summary = 'Routed 74/76 connections, 288 tracks, 214 vias', violations = 0 } = {}) {
    writeFileSync(join(fixture, 'tools', 'check-imports.mjs'), `
        console.log('Import boundaries: stub');
        process.exitCode = ${importsExit};
    `);
    writeFileSync(join(fixture, 'tools', 'check-pcb-editor-access.mjs'), `
        console.log('PCB editor access: stub');
        process.exitCode = ${accessExit};
    `);
    writeFileSync(join(fixture, 'tools', 'check-schematic-editor-access.mjs'), `
        console.log('Schematic editor access: stub');
        process.exitCode = ${schematicAccessExit};
    `);
    writeFileSync(join(fixture, 'tools', 'check-shared-editor-access.mjs'), `
        console.log('Shared editor access: stub');
        process.exitCode = ${sharedAccessExit};
    `);
    writeFileSync(join(fixture, 'tools', 'check-doc-references.mjs'), `
        console.log('Doc references: stub');
        process.exitCode = ${docsExit};
    `);
    writeFileSync(join(fixture, 'tests', 'unit', 'test-output.mjs'), `
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
    mkdirSync(join(fixture, 'tests', 'unit'), { recursive: true });
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

    for (const options of [{ clearanceExit: 3 }, { summary: 'unparseable' }, { violations: 1 },
        { summary: 'Routed 73/76 connections, 288 tracks, 214 vias' }]) {
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

    const access = runGate({ accessExit: 1 });
    assert.ifError(access.error);
    assert.equal(access.status, 1, 'PCB editor access failures are hard failures');
    assert.match(access.stdout, /PASS  import boundaries match/);
    assert.match(access.stdout, /FAIL  PCB editor access matches tools\/pcb-editor-access-baseline\.json/);
    assert.match(access.stdout, /REGRESSION GATE: FAIL\s*$/);

    const schematicAccess = runGate({ schematicAccessExit: 1 });
    assert.ifError(schematicAccess.error);
    assert.equal(schematicAccess.status, 1, 'Schematic editor access failures are hard failures');
    assert.match(schematicAccess.stdout, /PASS  PCB editor access matches/);
    assert.match(schematicAccess.stdout, /FAIL  schematic editor access matches tools\/schematic-editor-access-baseline\.json/);
    assert.match(schematicAccess.stdout, /REGRESSION GATE: FAIL\s*$/);

    const sharedAccess = runGate({ sharedAccessExit: 1 });
    assert.ifError(sharedAccess.error);
    assert.equal(sharedAccess.status, 1, 'Shared editor access failures are hard failures');
    assert.match(sharedAccess.stdout, /PASS  schematic editor access matches/);
    assert.match(sharedAccess.stdout, /FAIL  shared editor access matches tools\/shared-editor-access-baseline\.json/);
    assert.match(sharedAccess.stdout, /REGRESSION GATE: FAIL\s*$/);

    const docs = runGate({ docsExit: 1 });
    assert.ifError(docs.error);
    assert.equal(docs.status, 1, 'Unresolved doc references are hard failures');
    assert.match(docs.stdout, /FAIL  doc references to tests, files and pages resolve/);
    assert.match(docs.stdout, /PASS  regression suite exits cleanly/, 'Later checks still run');
    assert.match(docs.stdout, /REGRESSION GATE: FAIL\s*$/);

    const warning = runGate({ summary: 'Routed 74/76 connections, 287 tracks, 213 vias' });
    assert.ifError(warning.error);
    assert.equal(warning.status, 0);
    assert.match(warning.stdout, /soft warnings: 2/);
    assert.match(warning.stdout, /REGRESSION GATE: PASS \(with soft warnings/);
    console.log('PASS regression runner streams verbose children, preserves diagnostics and gate exit policy');
} finally {
    rmSync(fixture, { recursive: true, force: true });
}
