import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { getFillDraw } from '../src/pcb/modules/copper-fill-draw.js';

// The Fill tool has a "New Fill" Properties panel like the other drawing tools: the
// layer, net and corner radius a new pour gets. A pour being drawn follows them.
installFakeDom();
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { showFillToolProperties } = await import('../src/pcb/modules/copper-fill-edit.js');
const { startFillDraw, addFillWaypoint, updateFillDraw, finishFillDraw, fillToolDefaults } =
    await import('../src/pcb/modules/copper-fill-draw.js');

const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
const panels = [];
const shown = [];
const app = pcbEditorFixture({
    getLayerGroup: id => (id === 'selection-overlay' ? overlay : null),
    openPropertyPanel(panel) { panels.push(panel); return true; },
    refreshPropertyPanel(panel) { panels.push(panel); },
    netNames: () => ['GND', 'VCC'],
    // Pour geometry is not under test here.
    refreshFills() {}, _recomputeFillsNow() {}, selectFill() {},
    _showFillProperties(fill) { shown.push(fill); },
});
const panel = () => panels.at(-1);
const field = key => panel().fields.find(item => item.key === key);
const previewPoints = () => overlay.children.find(child => child.tagName === 'polygon')
    ?.getAttribute('points').split(' ').length ?? 0;

showFillToolProperties(app);
assert.equal(panel().title, 'New Fill');
assert.deepEqual(panel().fields.map(item => [item.key, item.id, item.type]), [
    ['layer', 'pcbPropFillToolLayer', 'select'],
    ['net', 'pcbPropFillToolNet', 'net'],
    ['cornerRadius', 'pcbPropFillToolCornerRadius', 'number'],
]);
assert.deepEqual(field('net').nets, ['GND', 'VCC'], 'the Net menu lists the board nets');
assert.deepEqual([field('layer').value, field('net').value, field('cornerRadius').value], ['top-copper', '', 0]);

field('net').commit('GND');
assert.equal(field('net').value, 'GND', 'the panel shows the chosen net');
assert.ok(Number.isNaN(field('cornerRadius').normalize(-1)), 'a negative radius is rejected');

startFillDraw(app, { x: 0, y: 0 });
addFillWaypoint(app, { x: 10, y: 0 });
addFillWaypoint(app, { x: 10, y: 10 });
updateFillDraw(app, { x: 0, y: 10 });
assert.equal(previewPoints(), 4, 'a square corner preview has four points');
field('cornerRadius').preview(2);
assert.equal(fillToolDefaults(app).cornerRadius, 2);
assert.ok(previewPoints() > 4, 'the pour being drawn shows its rounded corners while the radius changes');
field('layer').commit('bottom-copper');
assert.equal(getFillDraw(app).layer, 'bottom-copper', 'the pour being drawn moves to the chosen layer');
assert.equal(panel().fields[0].value, 'bottom-copper');
field('layer').commit('inner-copper');
assert.equal(fillToolDefaults(app).layer, 'bottom-copper', 'only copper layers are accepted');

addFillWaypoint(app, { x: 0, y: 10 });
finishFillDraw(app);
const [fill] = app.pcbDocument.copperFills;
assert.ok(fill, 'finishing commits the pour');
assert.deepEqual([fill.layer, fill.net, fill.cornerRadius], ['bottom-copper', 'GND', 2], 'the new pour takes the tool settings');
assert.deepEqual(shown, [fill], 'and its own Properties replace the tool panel');
assert.equal(app.history.undoStack.length, 1, 'one undo step');
assert.equal(getFillDraw(app), null);
assert.deepEqual(fillToolDefaults(app), { layer: 'bottom-copper', net: 'GND', cornerRadius: 2 }, 'the next pour starts from them too');

console.log('PASS Fill tool Properties: layer, net and corner radius for new pours; live preview; committed pour');
