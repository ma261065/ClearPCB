import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBoardViewSync } from '../../src/pcb/modules/board-view-sync.js';
import { isFillRefreshPending, isFillRefreshScheduled, isPictureCopperRefreshPending, refreshStatus, setBoardViewRefreshSuspended, setDragOverlaysDeferred, setFillRefreshPending, setFillRefreshScheduled, setFillRefreshSuspended } from '../../src/pcb/modules/refresh-state.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const svgElement = (tag = 'g') => fakeElement(tag);
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
{
    const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
    const { getBoardShapeElement, renderBoardShape } = await import('../../src/pcb/modules/board-shape-render.js');
    const { initializeBoardOutlineState, setBoardOutlineDrawn } = await import('../../src/pcb/modules/board-outline-resize.js');
    const renders = new Map();
    const groups = new Map();
    const board = pcbEditorFixture({
        getLayerGroup(id) {
            if (!groups.has(id)) {
                const group = svgElement(), appendChild = group.appendChild;
                group.appendChild = function (child) {
                    renders.set(id, (renders.get(id) || 0) + 1);
                    return appendChild.call(this, child);
                };
                groups.set(id, group);
            }
            return groups.get(id);
        },
        updateCopperCuts() {}, refreshFills() {}, getRoutingParams: () => ({}),
    });
    initializeBoardOutlineState(board, true);
    const outline = { id: 'board-outline', kind: 'rect', layer: 'board-outline', lineWidth: 0.1,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: -10 }, { x: 0, y: -10 }] };
    const artwork = { id: 'artwork', kind: 'circle', layer: 'top-silk', x: 5, y: -5, radius: 1, lineWidth: 0.2 };
    board.boardShapes.push(outline, artwork);
    // Every element in the outline's layer: an orphaned earlier render of the outline counts too.
    const live = () => groups.get('board-outline')?.children || [];
    for (const renderShapes of [true, false, true]) {
        renders.clear();
        board._renderPersistentObjects({ renderShapes });
        assert.equal(renders.get('board-outline'), 1, 'Each rebuild renders the outline only once');
        assert.equal(renders.get('top-silk') || 0, renderShapes ? 1 : 0);
        assert.equal(live().length, 1,
            'A rebuild must not orphan the outline rendered before the other shapes');
        assert.equal(live()[0], getBoardShapeElement(board, outline.id), 'The visible outline remains registered');
    }
    setBoardOutlineDrawn(board, false);
    renders.clear();
    board._renderPersistentObjects();
    assert.equal(renders.get('board-outline'), 1, 'An outline not drawn by the dedicated path still renders');
    const rectanglePath = live()[0].getAttribute('d');
    outline.kind = 'polygon';
    outline.points.splice(1, 0, { x: 10, y: 2 });
    renderBoardShape(board, outline);
    assert.equal(live().length + live(artwork.id).length, 2,
        'Editing replaces the outline without leaving its old geometry behind');
    assert.notEqual(live()[0].getAttribute('d'), rectanglePath);
}

let sourceRevision = 0;
const seen3D = [], seen2D = [];
const sync = createBoardViewSync({
    refresh3D() { seen3D.push(sourceRevision); },
    refresh2D() { seen2D.push(sourceRevision); },
});
sync.flush('3d');
assert.deepEqual(seen3D, []);
for (let edit = 1; edit <= 10; edit++) {
    sourceRevision = edit;
    sync.invalidate();
    sync.flush(edit % 2 ? 'top' : 'bottom');
}
assert.equal(seen2D.length, 10);
assert.equal(seen2D.at(-1), 10);
assert.deepEqual(seen3D, [], 'Flat-view edits must not rebuild 3D');
sync.flush('3d');
assert.deepEqual(seen3D, [10], 'Switching back catches up once with current data');
sync.flush('3d');
assert.deepEqual(seen3D, [10], 'A pending frame after the switch must not rebuild again');
sourceRevision = 11;
sync.invalidate();
sync.flush('3d');
assert.deepEqual(seen3D, [10, 11]);
assert.equal(seen2D.length, 10, '3D edits must not refresh the hidden flat view');
for (let edit = 12; edit <= 20; edit++) {
    sourceRevision = edit;
    sync.invalidate();
}
sync.flush('3d');
assert.deepEqual(seen3D, [10, 11, 20], 'Hidden or suspended edits coalesce into one catch-up');

let attempts = 0;
const retry = createBoardViewSync({ refresh2D() {}, refresh3D() {
    if (++attempts === 1) throw new Error('refresh failed');
} });
retry.invalidate();
assert.throws(() => retry.flush('3d'), /refresh failed/);
retry.flush('3d');
retry.flush('3d');
assert.equal(attempts, 2);

let reentrantCalls = 0;
const reentrant = createBoardViewSync({ refresh2D() {}, refresh3D() {
    if (++reentrantCalls === 1) reentrant.invalidate();
} });
reentrant.invalidate();
reentrant.flush('3d');
reentrant.flush('3d');
reentrant.flush('3d');
assert.equal(reentrantCalls, 2, 'Invalidation during a refresh must survive for the next pass');

const completions = [];
const settled = [];
const delayed = createBoardViewSync({
    refresh2D() {},
    refresh3D(revision) {
        return new Promise(resolve => completions.push({ revision, resolve }));
    },
    on3DSettled(result) { settled.push(result); },
});
delayed.invalidate();
const firstBuild = delayed.flush('3d');
delayed.invalidate();
const latestBuild = delayed.flush('3d');
assert.deepEqual(completions.map(item => item.revision), [1, 2]);
completions[1].resolve(false);
await latestBuild;
assert.equal(delayed.is3DDirty(), true, 'Discarding the newest build keeps its revision pending');
completions[0].resolve(true);
await firstBuild;
assert.equal(delayed.is3DDirty(), true, 'An older completion cannot acknowledge a newer edit');
const retryBuild = delayed.flush('3d');
assert.deepEqual(completions.map(item => item.revision), [1, 2, 2]);
completions[2].resolve(true);
await retryBuild;
assert.equal(delayed.is3DDirty(), false, 'A successful retry acknowledges the latest revision');
assert.deepEqual(settled.map(item => [item.revision, item.applied]), [[2, false], [1, true], [2, true]]);
console.log('PASS: visible-view refresh, deferred 3D catch-up, coalescing, retry, and reentrant invalidation');

const { createBoard3DSyncScheduler } = await import('../../src/pcb/modules/board3d-surfaces.js');
const source = readFileSync(new URL('../../src/pcb/modules/board3d.js', import.meta.url), 'utf8');
assert.match(source, /panel\.closed = true;[\s\S]{0,200}syncScheduler\.cancel\(\);/,
    'Closing the view must cancel the pending animation frame');
const frames = new Map();
const panel = { closed: false, hidden: false, view: '3d' };
const app = {};
let frameCount = 0;
let revision = 0;
const refreshed = [];
const scheduledSync = createBoardViewSync({
    refresh3D() { refreshed.push(revision); },
    refresh2D() {},
});
const builderInvalidations = [];
const { schedule, cancel } = createBoard3DSyncScheduler({
    app, panel, viewSync: scheduledSync,
    surfaceBuilder: { invalidate(options) { builderInvalidations.push(options); } },
    win: {
        requestAnimationFrame(callback) {
            frames.set(++frameCount, callback);
            return frameCount;
        },
        cancelAnimationFrame(frame) { frames.delete(frame); },
    },
});
schedule();
assert.deepEqual(builderInvalidations, [{ cancelActive: true }], 'Committed edits preempt obsolete 3D worker jobs');
cancel();
frameCount = 0;
const fireFrame = () => {
    assert.equal(frames.size, 1);
    const [frame, callback] = frames.entries().next().value;
    frames.delete(frame);
    callback();
};
for (revision = 1; revision <= 10; revision++) schedule();
assert.equal(frameCount, 1, 'A burst must reuse the queued animation frame');
assert.equal(frames.size, 1, 'A burst must queue only one frame');
assert.deepEqual(refreshed, []);
fireFrame();
assert.deepEqual(refreshed, [revision], 'The next frame must refresh the latest state');
app.copperFills = [{}];
const refreshSetters = { _fillRefreshScheduled: setFillRefreshScheduled, _fillRefreshPending: setFillRefreshPending,
    _suspendBoardViewRefresh: setBoardViewRefreshSuspended, _deferDragOverlays: setDragOverlaysDeferred,
    _suspendFillRefresh: setFillRefreshSuspended };
const setFlag = (target, property, value) => {
    if (target === app && refreshSetters[property]) refreshSetters[property](target, value);
    else target[property] = value;
};
for (const [target, property] of [[panel, 'hidden'], [panel, 'closed'],
    ...['_suspendBoardViewRefresh', '_deferDragOverlays', '_suspendFillRefresh',
        '_fillRefreshScheduled', '_fillRefreshPending'].map((property) => [app, property])]) {
    schedule();
    setFlag(target, property, true);
    const refreshCount = refreshed.length;
    fireFrame();
    assert.equal(refreshed.length, refreshCount, 'Visibility and suspension must be rechecked at execution');
    schedule();
    assert.equal(frames.size, 0, 'Hidden or suspended requests must not queue frames');
    setFlag(target, property, false);
    schedule();
    fireFrame();
    assert.equal(refreshed.length, refreshCount + 1);
}
schedule();
setFillRefreshScheduled(app, true);
const beforePour = refreshed.length;
fireFrame();
assert.equal(refreshed.length, beforePour, 'A pour queued before the frame must prevent stale 3D work');
revision++;
setFillRefreshScheduled(app, false);
schedule();
fireFrame();
assert.equal(refreshed.length, beforePour + 1);
assert.equal(refreshed.at(-1), revision);
schedule();
const beforeCancel = refreshed.length;
cancel();
assert.equal(frames.size, 0, 'Close must remove the queued frame');
assert.equal(refreshed.length, beforeCancel, 'Cancellation must not refresh');
schedule();
fireFrame();
assert.equal(refreshed.length, beforeCancel + 1, 'Cancellation must clear the pending frame handle');
console.log('PASS: next-frame coalescing, drag/pour/visibility guards, and cancellation');