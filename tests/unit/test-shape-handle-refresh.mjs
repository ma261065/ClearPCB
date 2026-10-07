import assert from 'node:assert/strict';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { isPictureCopperRefreshPending } from '../../src/pcb/modules/refresh-state.js';
import { getBoardShapeDrag } from '../../src/pcb/modules/board-shapes.js';
import { clearanceOverlayState, getBoardShapeClearance } from '../../src/pcb/modules/clearance-overlay.js';
globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; },
    createElementNS() {
        const attributes = new Map();
        return { style: {}, setAttribute(name, value) { attributes.set(name, value); },
            getAttribute(name) { return attributes.get(name); }, removeAttribute(name) { attributes.delete(name); },
            appendChild() {}, remove() {}, querySelectorAll() { return []; } };
    },
};
const { startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag, cloneShapeGeometry } = await import('../../src/pcb/modules/board-shapes.js');
const { pictureShape } = await import('../../src/shared/pcb/picture-raster.js');
const { scheduleFillRefresh } = await import('../../src/pcb/modules/fill-refresh.js');
const { reconcileRatsnest } = await import('../../src/pcb/modules/track-draw.js');
const { loadClipper, boardShapeClearanceOutlines } = await import('../../src/pcb/modules/copper-fill-geom.js');
// The real clearance refresh runs during the drag, as in the app, where the geometry engine is loaded.
await loadClipper();
// Copper paths are Tracks, so the board-shape fixtures are copper areas and cut-outs.
const fixtures = [
    [{ kind: 'circle', x: 0, y: 0, radius: 2 }, 'radius', { x: 2, y: 0 }],
    [{ kind: 'rect', filled: true, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] }, 2, { x: 4, y: 3 }],
    [{ kind: 'polygon', filled: true, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 3 }] }, 2, { x: 2, y: 3 }],
    [{ kind: 'line', copperMode: 'remove-copper', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }, 1, { x: 4, y: 0 }],
    [{ kind: 'arc', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, bulge: { x: 2, y: 2 } }, 'end', { x: 4, y: 0 }],
    [pictureShape({ width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 4, height: 2 }] },
        { widthMm: 4, layer: 'top-copper' }), 2, { x: 2, y: 1 }],
];
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let timerId = 0;
try {
    globalThis.setTimeout = (callback, delay) => {
        assert.equal(delay, 100);
        timers.set(++timerId, callback);
        return timerId;
    };
    globalThis.clearTimeout = id => { timers.delete(id); };
    const flush = () => {
        const callbacks = [...timers.values()];
        timers.clear();
        callbacks.forEach(callback => callback());
    };
    for (const [fixture, handle, start] of fixtures) {
        for (const commit of [true, false]) {
            const shape = { ...structuredClone(fixture), id: 'shape', layer: 'top-copper', net: '', lineWidth: 0.2 };
            const original = cloneShapeGeometry(shape);
            let halos = 0;
            let fills = 0;
            const overlay = { children: [], appendChild(child) { child.parentNode = this; this.children.push(child); },
                removeChild(child) { child.parentNode = null; this.children = this.children.filter(element => element !== child); } };
            const shapeLayer = { style: {}, get firstChild() { return null; }, appendChild() {}, insertBefore() {} };
            const halo = { parentNode: overlay };
            const topFill = { get firstChild() { fills++; return null; } };
            const bottomFill = { get firstChild() { return null; } };
            const fillGroups = new Map([['top-fill', topFill], ['bottom-fill', bottomFill],
                ['clearance-overlay', overlay], [shape.layer, shapeLayer]]);
            const app = {
                boardShapes: [shape], tracks: [], vias: [], placements: new Map(), texts: new Map(), copperFills: [],
                history: new CommandHistory(), _shapeElements: new Map(),
                viewport: { scale: 10, snapToGrid: false, setCrosshair() {}, hideCrosshair() {} },
                getLayerGroup(id) {
                    if (id === 'clearance-overlay' && new Error().stack.includes('refreshBoardShapeClearance')
                        && !isPictureCopperRefreshPending(this)) halos++;
                    return fillGroups.get(id) || null;
                },
                existingLayerGroups() { return fillGroups; },
                snapToGrid(point) { return point; }, _snapActive() { return false; },
                refreshFills() { return scheduleFillRefresh(this); },
                getRoutingParams() { return { clearance: 0.25 }; },
                refreshClearanceHalos() { halos++; },
                updateRatsnest(options) { reconcileRatsnest(this, options); },
            };
            clearanceOverlayState(app).clearancesVisible = true;
            clearanceOverlayState(app).boardShapeClearanceCache.set(shape.id, { elements: [halo] });
            const realOutlines = boardShapeClearanceOutlines(shape, 0.25).length;
            const assertClearanceVisible = message => {
                if (shape.kind === 'image') {
                    assert.equal(halo.parentNode, null, message);
                } else if (halo.parentNode !== overlay) {
                    // Refreshed live: the shape shows exactly its real clearance (none for a cut-out).
                    const elements = getBoardShapeClearance(app, shape.id).elements;
                    assert.equal(elements.length, realOutlines, message);
                    assert.ok(elements.every(element => element.parentNode === overlay), message);
                }
            };
            assert.equal(startBoardShapeDrag(app, shape, start, handle), true);
            assertClearanceVisible(`${shape.kind}: handle press defers image clearance but retains ordinary shape clearance`);
            for (const delta of [1, 2, 3]) {
                handleBoardShapeDrag(app, { x: start.x + delta, y: start.y + delta });
                flush();
                assertClearanceVisible(`${shape.kind}: clearance visibility is preserved throughout the drag`);
                assert.equal(isPictureCopperRefreshPending(app), true);
                assert.equal(timers.size, 0, 'No timer runs during a held handle drag');
                assert.equal(halos, 0);
                assert.equal(fills, 0);
            }
            assert.notDeepEqual(cloneShapeGeometry(getBoardShapeDrag(app).shape), original, `${shape.kind} updates live`);
            assert.deepEqual(cloneShapeGeometry(shape), original, 'Canonical geometry is unchanged during preview');
            endBoardShapeDrag(app, commit);
            if (commit) {
                assert.equal(timers.size, 1, 'A committed release starts one debounce');
                assert.equal(halos, 0);
                assert.equal(fills, 0);
            } else {
                assert.deepEqual(cloneShapeGeometry(shape), original, 'Cancel restores geometry immediately');
                assert.equal(isPictureCopperRefreshPending(app), false);
                assert.equal(timers.size, 0, 'Cancellation leaves no deferred refresh');
                assert.equal(halos, 1, 'Cancel restores clearance immediately');
                assert.equal(fills, 0, 'Cancel retains unchanged settled fills');
            }
            flush();
            assert.equal(isPictureCopperRefreshPending(app), false);
            assert.equal(halos, 1);
            assert.equal(fills, commit ? 1 : 0, 'Only committed geometry refreshes fills');
            if (commit) {
                app.history.undo();
                assert.deepEqual(cloneShapeGeometry(shape), original);
                flush();
            }
        }
    }
} finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
}
console.log('PASS shape handle drags retain ordinary clearance, defer image clearance and committed refreshes, and restore cancelled geometry/clearance/fills immediately');