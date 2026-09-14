import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
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
const { startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag, cloneShapeGeometry } = await import('../src/pcb/modules/board-shapes.js');
const { pictureShape } = await import('../src/pcb/modules/picture-raster.js');
const { scheduleFillRefresh } = await import('../src/pcb/modules/fill-refresh.js');
const { reconcileRatsnest } = await import('../src/pcb/modules/track-draw.js');
const fixtures = [
    [{ kind: 'circle', x: 0, y: 0, radius: 2 }, 'radius', { x: 2, y: 0 }],
    [{ kind: 'rect', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] }, 2, { x: 4, y: 3 }],
    [{ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 3 }] }, 2, { x: 2, y: 3 }],
    [{ kind: 'line', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }, 1, { x: 4, y: 0 }],
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
            const halo = { parentNode: { removeChild(child) { child.parentNode = null; } } };
            const app = {
                boardShapes: [shape], tracks: [], vias: [], placements: new Map(), texts: new Map(), copperFills: [],
                history: new CommandHistory(), _shapeElements: new Map(),
                _boardShapeClearanceCache: new Map([[shape.id, { elements: [halo] }]]),
                viewport: { scale: 10, snapToGrid: false, setCrosshair() {}, hideCrosshair() {} },
                _getLayerGroup() { return null; }, _snapToGrid(point) { return point; }, _snapActive() { return false; },
                _refreshFills() { return scheduleFillRefresh(this); },
                _clearFillGroups() { fills++; },
                _refreshBoardShapeClearance() { if (!this._pictureCopperRefreshPending) halos++; },
                _refreshClearanceHalos() { halos++; },
                _updateRatsnest(options) { reconcileRatsnest(this, options); },
            };
            assert.equal(startBoardShapeDrag(app, shape, start, handle), true);
            assert.equal(halo.parentNode, null, 'Handle press hides clearance immediately');
            for (const delta of [1, 2, 3]) {
                handleBoardShapeDrag(app, { x: start.x + delta, y: start.y + delta });
                flush();
                assert.equal(app._pictureCopperRefreshPending, true);
                assert.equal(timers.size, 0, 'No timer runs during a held handle drag');
                assert.equal(halos, 0);
                assert.equal(fills, 0);
            }
            assert.notDeepEqual(cloneShapeGeometry(shape), original, `${shape.kind} updates live`);
            endBoardShapeDrag(app, commit);
            assert.equal(timers.size, 1, 'Release or cancellation starts one debounce');
            assert.equal(halos, 0);
            assert.equal(fills, 0);
            if (!commit) assert.deepEqual(cloneShapeGeometry(shape), original);
            flush();
            assert.equal(app._pictureCopperRefreshPending, false);
            assert.equal(halos, 1);
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
console.log('PASS image, circle, rectangle, polygon, line and arc handle drags defer clearance until release/cancel');