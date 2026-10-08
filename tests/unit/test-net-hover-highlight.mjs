import assert from 'node:assert/strict';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { getNetHoveredShapeIds } from '../../src/pcb/modules/board-shape-state.js';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();

const { setHoverHighlight } = await import('../../src/pcb/modules/copper-halos.js');
const { getBoardShapeElement, shapeHoverColor, shapeSelectionColor } = await import('../../src/pcb/modules/board-shape-render.js');
const { setPcbSelection } = await import('../../src/pcb/modules/selection-registry.js');
const groups = new Map([
    ['vias', fakeElement('g')],
    ['selection-overlay', fakeElement('g')],
    ['top-copper', fakeElement('g')],
    ['bottom-copper', fakeElement('g')],
]);
const viaA = { id: 'via-a', x: 1, y: 1, diameter: 1, net: 'N1' };
const viaB = { id: 'via-b', x: 2, y: 2, diameter: 1, net: 'N1' };
const viaOther = { id: 'via-other', x: 3, y: 3, diameter: 1, net: 'N2' };
const padA = { id: 'pad-a', x: 4, y: 4, shape: 'round', size: 1.5, net: 'N1' };
const padB = { id: 'pad-b', x: 5, y: 5, shape: 'round', size: 1.5, net: 'N1' };
const copperShape = {
    id: 'shape-a',
    kind: 'line',
    layer: 'top-copper',
    copperMode: 'add',
    net: 'N1',
    lineWidth: 0.4,
    points: [{ x: 7, y: 7 }, { x: 9, y: 7 }],
};
const otherShape = { ...copperShape, id: 'shape-other', net: 'N2' };
assert.equal(shapeHoverColor(copperShape), '#ed796d',
    'shape hover matches a 25%-opaque white track hover halo');
assert.equal(shapeSelectionColor(copperShape), '#f3a69e',
    'shape selection matches a 50%-opaque white track selection halo');
const app = { ...pcbEditorStubs(),
    vias: [viaA, viaB, viaOther],
    tracks: [],
    pads: [padA, padB],
    netlist: [{ net: 'N1', pins: [{ componentId: 'U1', pinNumber: 1 }] }],
    placements: new Map([['U1', {
        rotation: 0,
        padOffsets: [{ padId: 1, number: 1, layer: 'top-copper', width: 1, height: 1, shape: 'rect' }],
        pads: new Map([[1, { x: 6, y: 6 }]]),
    }]]),
    boardShapes: [copperShape, otherShape],
    _shapeElements: new Map(),
    texts: new Map(),
    viewport: { scale: 10 },
    _layerGroups: groups, existingLayerGroups: () => groups,
    getLayerGroup(id) { return groups.get(id) || null; },
};

setHoverHighlight(app, { type: 'via', via: viaA });
assert.equal(groups.get('vias').querySelectorAll('.pcb-track-hover').length, 2,
    'hovering a via highlights every via on its net');
assert.equal(groups.get('selection-overlay').querySelectorAll('.pcb-track-hover').length, 2,
    'hovering a via highlights every standalone pad on its net');
assert.equal(groups.get('top-copper').querySelectorAll('.pcb-track-hover').length, 1,
    'numeric component pin identifiers still receive the net highlight');
assert.deepEqual([...getNetHoveredShapeIds(app)], ['shape-a'],
    'net-bearing copper shapes are included in net hover');
assert.equal(getBoardShapeElement(app, 'shape-a').getAttribute('stroke'), shapeHoverColor(copperShape),
    'same-net copper shapes render with their hover color');

setHoverHighlight(app, null);
for (const group of groups.values()) {
    assert.equal(group.querySelectorAll('.pcb-track-hover').length, 0);
}

setPcbSelection(app, [{ kind: 'via', object: viaA }]);
setHoverHighlight(app, { type: 'via', via: viaA });
assert.equal(groups.get('vias').querySelectorAll('.pcb-track-hover').length, 1,
    'hovering a selected via highlights the other vias on its net');
assert.equal(groups.get('selection-overlay').querySelectorAll('.pcb-track-hover').length, 2,
    'hovering with a selection still highlights standalone pads on the net');
assert.equal(groups.get('top-copper').querySelectorAll('.pcb-track-hover').length, 1,
    'hovering with a selection still highlights component pads on the net');

setHoverHighlight(app, { type: 'shape', shape: copperShape });
assert.equal(groups.get('vias').querySelectorAll('.pcb-track-hover').length, 1,
    'hovering a copper shape highlights the unselected vias on its net');
assert.equal(getNetHoveredShapeIds(app).has(copperShape.id), true,
    'hovering a copper shape highlights same-net copper shapes');

console.log('PASS: net hover remains active while an object is selected');
