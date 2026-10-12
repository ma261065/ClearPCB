import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { setHoverHighlight } = await import('../../src/pcb/modules/copper-halos.js');
const { getNetHoveredShapeIds } = await import('../../src/pcb/modules/board-shape-state.js');
const { hasBoardShapeElement } = await import('../../src/pcb/modules/board-shape-render.js');
const { CopperFill } = await import('../../src/shapes/copper-fill.js');
const { Pad } = await import('../../src/shapes/pad.js');

// Hovering copper highlights the board shapes on its net. Pours share the board-shape
// collection but draw themselves: drawn as a board shape on net hover, a circular pour
// got a solid ring that stayed behind when the pour moved.
const app = pcbEditorFixture();
const pour = new CopperFill({ kind: 'circle', x: 0, y: 0, radius: 7, net: 'GND', layer: 'top-copper' });
const ring = { id: 'gnd-ring', kind: 'circle', x: 20, y: 0, radius: 3, layer: 'top-copper', net: 'GND', lineWidth: 0.2 };
const pad = new Pad({ x: 40, y: 0, net: 'GND', layers: 'both' });
app.pcbDocument.boardShapes.push(pour, ring);
app.pcbDocument.pads.push(pad);

setHoverHighlight(app, { type: 'standalone-pad', pad });
assert.deepEqual([...getNetHoveredShapeIds(app)], ['gnd-ring'], 'Net hover highlights the board shapes on the net, not its pours');
assert.equal(hasBoardShapeElement(app, pour.id), false, 'A pour is never drawn as a board shape');
assert.equal(hasBoardShapeElement(app, 'gnd-ring'), true);

setHoverHighlight(app, null);
assert.deepEqual([...getNetHoveredShapeIds(app)], []);
assert.equal(hasBoardShapeElement(app, pour.id), false, 'Ending the hover leaves no board-shape drawing of the pour');

console.log('PASS net hover highlights board shapes on the net and leaves pours to draw themselves');
