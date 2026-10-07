import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    isFillRefreshPending, setFillRefreshPending, isFillRefreshScheduled, setFillRefreshScheduled,
    fillRefreshError, setFillRefreshError, isPictureCopperRefreshPending, setPictureCopperRefreshPending, refreshStatus,
    onRefreshSuspended, areDragOverlaysDeferred, setDragOverlaysDeferred, isFillRefreshSuspended, setFillRefreshSuspended,
    isBoardViewRefreshSuspended, setBoardViewRefreshSuspended,
} from '../../src/pcb/modules/refresh-state.js';
import { collectDrcInputs } from '../../src/pcb/modules/drc.js';
import { importSpecifiers } from '../../tools/check-imports.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Defaults, per-editor isolation and normalisation.
const app = {}, other = {};
assert.deepEqual([isFillRefreshPending(app), isFillRefreshScheduled(app), fillRefreshError(app),
    isPictureCopperRefreshPending(app)], [false, false, null, false]);
setFillRefreshPending(app, 1);
setFillRefreshScheduled(app, 'yes');
setPictureCopperRefreshPending(app, true);
const failure = new Error('pour failed');
setFillRefreshError(app, failure);
assert.deepEqual([isFillRefreshPending(app), isFillRefreshScheduled(app), fillRefreshError(app),
    isPictureCopperRefreshPending(app)], [true, true, failure, true]);
assert.deepEqual([isFillRefreshPending(other), isFillRefreshScheduled(other), fillRefreshError(other),
    isPictureCopperRefreshPending(other)], [false, false, null, false], 'Editors do not share status');
setFillRefreshError(app, undefined);
assert.equal(fillRefreshError(app), null);

// One-lookup status view: live for a known editor, frozen idle defaults otherwise.
const status = refreshStatus(app);
assert.deepEqual({ ...status }, { fillPending: true, fillScheduled: true, fillError: null, pictureCopperPending: true,
    overlaysDeferred: false, fillSuspended: false, boardViewSuspended: false });
setPictureCopperRefreshPending(app, false);
assert.equal(refreshStatus(app).pictureCopperPending, false);
const idle = refreshStatus({});
assert.deepEqual({ ...idle }, { fillPending: false, fillScheduled: false, fillError: null, pictureCopperPending: false,
    overlaysDeferred: false, fillSuspended: false, boardViewSuspended: false });
assert.ok(Object.isFrozen(idle), 'Unknown editors share an immutable idle status');

// Suspensions keep save/set/restore semantics; raising one notifies before it is observable.
{
    const editor = {}, events = [];
    onRefreshSuspended('overlays', target => {
        if (target === editor) events.push(['overlays', areDragOverlaysDeferred(target)]);
    });
    onRefreshSuspended('fill', target => {
        if (target === editor) events.push(['fill', isFillRefreshSuspended(target)]);
    });
    const saved = areDragOverlaysDeferred(editor);
    setDragOverlaysDeferred(editor, true);
    setDragOverlaysDeferred(editor, {});
    setFillRefreshSuspended(editor, true);
    setBoardViewRefreshSuspended(editor, true);
    assert.deepEqual(events, [['overlays', false], ['fill', false]], 'Only a rising edge notifies, before the value is stored');
    assert.deepEqual([areDragOverlaysDeferred(editor), isFillRefreshSuspended(editor), isBoardViewRefreshSuspended(editor)],
        [true, true, true]);
    setDragOverlaysDeferred(editor, saved);
    setFillRefreshSuspended(editor, null);
    setBoardViewRefreshSuspended(editor, false);
    assert.deepEqual([areDragOverlaysDeferred(editor), isFillRefreshSuspended(editor), isBoardViewRefreshSuspended(editor)],
        [false, false, false]);
    assert.equal(events.length, 2, 'Restoring does not notify');
    assert.deepEqual([areDragOverlaysDeferred(other), isFillRefreshSuspended(other), isBoardViewRefreshSuspended(other)],
        [false, false, false]);
}

// DRC reads the editor's pour status by default; detached snapshots pass it explicitly.
setFillRefreshPending(app, true);
assert.equal(collectDrcInputs(app).fillPending, true);
assert.equal(collectDrcInputs({}).fillPending, false);
const detached = collectDrcInputs({}, {}, { pending: true, error: failure });
assert.deepEqual([detached.fillPending, detached.fillFailed], [true, true]);

// Import-free, so the DRC worker can load it without editor modules.
const file = join(root, 'src/pcb/modules/refresh-state.js');
assert.deepEqual(importSpecifiers(readFileSync(file, 'utf8')), []);
const reachable = entry => {
    const seen = new Set();
    const visit = path => {
        if (seen.has(path)) return;
        seen.add(path);
        for (const spec of importSpecifiers(readFileSync(path, 'utf8'))) {
            if (spec.startsWith('.')) visit(resolve(dirname(path), spec));
        }
    };
    visit(join(root, entry));
    return seen;
};
for (const worker of ['src/pcb/modules/drc-worker.js', 'src/pcb/modules/gerber-worker.js']) {
    const graph = reachable(worker);
    assert.ok(!graph.has(join(root, 'src/pcb/modules/fill-refresh.js')), `${worker} must not load fill refresh`);
    assert.ok(!graph.has(join(root, 'src/pcb/modules/picture-refresh.js')), `${worker} must not load picture refresh`);
}
assert.ok(reachable('src/pcb/modules/drc-worker.js').has(file), 'DRC reads pour status from the shared state');

// The former editor fields cannot reappear.
const listJs = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? listJs(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
const legacy = /\b_(?:fillRefreshPending|fillRefreshError|fillRefreshScheduled|pictureCopperRefreshPending|deferDragOverlays|suspendFillRefresh|suspendBoardViewRefresh|fillOverlayDeferred|drcFillSuspended)\b/;
for (const source of listJs(join(root, 'src'))) {
    assert.doesNotMatch(readFileSync(source, 'utf8'), legacy, `${source} uses refresh-state.js instead of editor fields`);
}

console.log('PASS PCB refresh state: defaults, isolation, DRC snapshot status, worker-safe imports, no legacy fields');
