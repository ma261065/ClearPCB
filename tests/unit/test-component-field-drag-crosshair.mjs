import assert from 'node:assert/strict';
import { Text } from '../../src/shapes/text.js';
import { beginSelectionMove, draggedTextForCrosshair } from '../../src/schematic/modules/drag-gestures.js';
import { moveDragState } from '../../src/schematic/modules/draw-states.js';
import { cancelDragGesture } from '../../src/schematic/modules/drag.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();

const reference = new Text({ x: 4, y: 6, text: 'R1' });
reference.parentComponent = { id: 'component-1', locked: false };
reference.fieldKey = 'reference';
const value = new Text({ x: 4, y: 8, text: '10k' });
value.parentComponent = reference.parentComponent;
value.fieldKey = 'value';
const ordinary = new Text({ x: 4, y: 10, text: 'Note' });

assert.equal(draggedTextForCrosshair([reference]), reference);
assert.equal(draggedTextForCrosshair([value]), value);
assert.equal(draggedTextForCrosshair([ordinary]), ordinary);
assert.equal(draggedTextForCrosshair([reference, value]), null);

const crosshairs = [];
const app = {
    components: [],
    shapes: [reference],
    interactionState: 'idle',
    viewport: {
        svg: fakeElement('svg'),
        getSnappedPosition: point => ({ x: Math.round(point.x), y: Math.round(point.y) }),
    },
    selection: {
        getSelection: () => [reference],
        keepSelected() {},
    },
    showCrosshair() { crosshairs.push('show'); },
    updateCrosshair(point) { crosshairs.push({ ...point }); },
    hideCrosshair() { crosshairs.push('hide'); },
    renderShapes() {},
    removeBoxSelectElement() {},
    fileManager: { setDirty() {} },
};

beginSelectionMove(app, { x: 4, y: 6 }, { x: 4, y: 6 });
assert.deepEqual(crosshairs, ['show', { x: 5.2, y: 6 }]);

moveDragState.mousemove(app, {}, { worldPos: { x: 7.4, y: 9.6 } });
assert.deepEqual(crosshairs.at(-1), { x: 9, y: 10 },
    'normal text snaps its horizontally centred crosshair on both grid axes');

cancelDragGesture(app);
assert.equal(crosshairs.at(-1), 'hide');
assert.deepEqual(reference.getPosition(), { x: 4, y: 6 });

app.selection.getSelection = () => [ordinary];
app.shapes = [ordinary];
crosshairs.length = 0;
beginSelectionMove(app, { x: 4, y: 10 }, { x: 4, y: 10 });
assert.deepEqual(crosshairs, ['show', { x: 6.4, y: 10 }],
    'ordinary schematic Text uses the same horizontal-centre and baseline crosshair');
cancelDragGesture(app);

console.log('PASS: all schematic Text drags use horizontal-centre X and baseline Y');
