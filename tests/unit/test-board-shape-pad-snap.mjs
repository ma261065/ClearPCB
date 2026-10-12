/** Board-shape moves and node edits use grid/alignment magnets only; Track moves still lock onto Pads. */
import assert from 'node:assert/strict';
import { getBoardShapeDrag } from '../../src/pcb/modules/board-shape-drag.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
const element = (tagName) => fakeElement(tagName);

const { startBoardShapeDrag, handleBoardShapeDrag } = await import('../../src/pcb/modules/board-shape-drag.js');
const { snapPathTranslation } = await import('../../src/pcb/modules/path-edit.js');
const { Pad } = await import('../../src/shapes/pad.js');

const SCALE = 10;
const MAGNET = 8 / SCALE;
// A row of 3 mm-pitch stadium Pads, 3 mm long, rotated 45 degrees (as in the reported board).
const pads = [9, 12, 15, 18].map(x => new Pad({ x, y: -69, shape: 'stadium', size: 1.5, ratio: 2, rotation: 45 }));

function fixture() {
    const overlay = element('g');
    const shape = {
        id: 'hole_1', kind: 'polygon', layer: 'hole', lineWidth: 0.2, filled: true,
        points: [{ x: -6.2848, y: -47.8597 }, { x: 9, y: -69 }, { x: 18, y: -31 }],
    };
    const app = { ...pcbEditorStubs(),
        boardShapes: [shape], pads, placements: new Map(), _shapeElements: new Map(),
        viewport: { scale: SCALE, gridSize: 1, gridVisible: true, setCrosshair() {}, getEffectiveGridSize: () => 1 },
        getLayerGroup() { return overlay; },
    };
    return { app, shape };
}
const preview = app => getBoardShapeDrag(app).shape;

{
    const { app, shape } = fixture();
    const start = { ...shape.points[0] };
    assert.ok(startBoardShapeDrag(app, shape, start, null, { whole: true }));
    let previous = null;
    for (let step = 0; step <= 1200; step++) {
        const pointer = { x: start.x + step * 0.01, y: start.y + 0.05 };
        handleBoardShapeDrag(app, pointer);
        const moved = preview(app).points;
        const dx = moved[0].x - pointer.x;
        const dy = moved[0].y - pointer.y;
        assert.ok(Math.abs(dx) <= MAGNET + 1e-9 && Math.abs(dy) <= MAGNET + 1e-9,
            `move at ${pointer.x.toFixed(2)} stays within the magnet radius (offset ${dx.toFixed(3)}, ${dy.toFixed(3)})`);
        if (previous) {
            assert.ok(Math.abs(moved[0].x - previous.x) <= 1 + 1e-9,
                `move at ${pointer.x.toFixed(2)} does not jump (${previous.x.toFixed(3)} -> ${moved[0].x.toFixed(3)})`);
        }
        previous = { ...moved[0] };
    }
}

{
    const { app, shape } = fixture();
    const start = { ...shape.points[0] };
    startBoardShapeDrag(app, shape, start, null, { whole: true });
    // Raw move puts the Pad-row vertex 0.5 mm from the next Pad centre; it formerly jumped there.
    handleBoardShapeDrag(app, { x: start.x + 2.5, y: start.y });
    const moved = preview(app).points;
    assert.deepEqual(moved[0], { x: -4, y: -47.8597 }, 'whole-shape move snaps its anchor to the grid');
    assert.notEqual(moved[1].x, 12, 'whole-shape move does not lock a vertex onto a Pad');
}

{
    const { app, shape } = fixture();
    startBoardShapeDrag(app, shape, { ...shape.points[1] }, 1);
    handleBoardShapeDrag(app, { x: 11.3, y: -69.05 });
    assert.deepEqual(preview(app).points[1], { x: 11, y: -69 }, 'node drag snaps to the grid, not to the Pad at x=12');
}

{
    const app = fixture().app;
    const delta = snapPathTranslation(app, [{ x: 9, y: -69 }], { x: 2.5, y: 0 }, [], [], true);
    assert.deepEqual([delta.x, delta.y], [3, 0], 'Track moves still lock onto Pads');
    const shapeDelta = snapPathTranslation(app, [{ x: 9, y: -69 }], { x: 2.5, y: 0 });
    assert.notDeepEqual([shapeDelta.x, shapeDelta.y], [3, 0], 'Pad targeting is opt-in');
}

console.log('PASS board shapes snap to grid/alignment only; Track moves still lock onto Pads');
