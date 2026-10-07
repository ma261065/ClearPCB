import assert from 'node:assert/strict';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { renderPropertyFields } = await import('../../src/shared/ui/property-fields.js');
const { startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag,
    cloneShapeGeometry } = await import('../../src/pcb/modules/board-shapes.js');
const { showBoardShapeProperties } = await import('../../src/pcb/modules/board-shape-properties.js');
const { setPcbSelection } = await import('../../src/pcb/modules/selection-registry.js');
const { cancelPictureCopperRefresh } = await import('../../src/pcb/modules/picture-refresh.js');

for (const offset of [-0.5, 0, 0.5]) {
    const shape = { id: 'arc-history', kind: 'arc', layer: 'top-silk', lineWidth: 0.2,
        start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: -2.5 } };
    let title = '';
    let rebuilds = 0;
    document.body.children = [];
    const items = document.body.appendChild(document.createElement('div'));
    const input = () => document.getElementById('pcbPropShapeBulge');
    const renderPanel = panel => {
        rebuilds++;
        title = panel.title;
        renderPropertyFields(items, panel.fields);
    };
    const app = { boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _shapeElements: new Map(), getLayerGroup() { return null; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, snapToGrid(point) { return point; },
        openPropertyPanel(panel) { renderPanel(panel); return true; },
        refreshPropertyPanel: renderPanel,
        history: new CommandHistory() };
    try {
        setPcbSelection(app, [{ kind: 'shape', object: shape }]);
        showBoardShapeProperties(app, shape);
        const original = cloneShapeGeometry(shape);
        assert.equal(Number(input().value), -0.5);

        for (const commit of [false, true]) {
            assert.equal(startBoardShapeDrag(app, shape, shape.bulge, 'bulge'), true);
            const field = input();
            handleBoardShapeDrag(app, { x: 5, y: offset });
            assert.equal(input(), field, 'Dragging preserves the active Properties input');
            assert.equal(Number(input().value), offset / 5, 'The live control follows the bulge');
            endBoardShapeDrag(app, commit);
            await Promise.resolve();
            if (!commit) {
                assert.deepEqual(cloneShapeGeometry(shape), original);
                assert.equal(Number(input().value), -0.5, 'Cancel restores the control');
                assert.equal(app.history.undoStack.length, 0);
                continue;
            }
            const finalKind = offset === 0 ? 'line' : 'arc';
            const finalGeometry = cloneShapeGeometry(shape);
            assert.equal(shape.kind, finalKind);
            assert.equal(title, offset === 0 ? 'Line' : 'Arc');
            assert.equal(app.history.undoStack.length, 1, 'The drag creates one history entry');
            for (let repeat = 0; repeat < 2; repeat++) {
                app.history.undo();
                await Promise.resolve();
                assert.equal(shape.kind, 'arc');
                assert.deepEqual(cloneShapeGeometry(shape), original);
                assert.equal(title, 'Arc');
                assert.equal(Number(input()?.value), -0.5, 'Undo restores geometry and its displayed bulge');
                app.history.redo();
                await Promise.resolve();
                assert.equal(shape.kind, finalKind);
                assert.deepEqual(cloneShapeGeometry(shape), finalGeometry);
                assert.equal(title, offset === 0 ? 'Line' : 'Arc');
                if (offset === 0) assert.equal(input(), null, 'A straightened arc has no bulge control');
                else assert.equal(Number(input()?.value), offset / 5, 'Redo restores the displayed bulge');
                assert.equal(app.history.undoStack.length, 1, 'Panel blur does not create extra history');
            }
        }
    } finally {
        cancelPictureCopperRefresh(app);
    }
}
console.log('PASS arc bulge drag, cancel, undo/redo and straightening keep Properties synchronized');
