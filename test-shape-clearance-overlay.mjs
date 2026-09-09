import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = { addEventListener() {} };
const element = () => ({
    children: [], attributes: new Map(), dataset: {}, style: {},
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    appendChild(child) { this.children.push(child); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    get firstChild() { return this.children[0]; },
    querySelectorAll() { return []; },
});
globalThis.document = { createElementNS: element };
const { boardShapeClearanceOutlines } = await import('./src/pcb/modules/copper-fill-geom.js');
const circle = { id: 'circle', kind: 'circle', layer: 'top-copper', filled: true,
    x: 0, y: 0, radius: 2, lineWidth: 0.2, net: 'GND' };
const rectangle = { id: 'rect', kind: 'rect', layer: 'bottom-copper', filled: false, lineWidth: 0.2,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
const hole = { ...circle, id: 'hole', layer: 'hole' };
const clearance = 0.25;
const radius = Math.max(...boardShapeClearanceOutlines(circle, clearance).flat().map(point => Math.hypot(point.x, point.y)));
assert.ok(Math.abs(radius - 2.35) < 0.01, 'Filled circle clearance includes radius, half stroke, and clearance');
assert.equal(boardShapeClearanceOutlines({ ...circle, filled: false }, clearance).length, 2,
    'Hollow circles preserve inner and outer clearance boundaries');
assert.equal(boardShapeClearanceOutlines(rectangle, clearance).length, 2,
    'Closed strokes merge capsules into inner and outer contours without segment seams');
const line = { id: 'line', kind: 'line', layer: 'top-copper', lineWidth: 0.2,
    segmentWidths: { 0: 1 }, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] };
const lineExtent = Math.max(...boardShapeClearanceOutlines(line, clearance).flat().map(point => point.y));
assert.ok(lineExtent >= 0.75 && lineExtent < 0.78,
    'Segment-width overrides determine the clearance offset, including the conservative fill margin');
const arc = { id: 'arc', kind: 'arc', layer: 'top-copper', lineWidth: 0.2,
    start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: 5 } };
assert.ok(boardShapeClearanceOutlines(arc, clearance).length > 0);
for (const shape of [{ ...circle, layer: 'top-silk' }, { ...circle, copperMode: 'remove-copper' },
    { ...circle, type: 'fill' }]) assert.deepEqual(boardShapeClearanceOutlines(shape, clearance), []);

const source = readFileSync(new URL('./src/ui/PCBApp.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('    showClearances(show) {');
const end = source.indexOf('\n    /*', start);
assert.ok(start >= 0 && end > start);
const showClearances = new Function('boardShapeClearanceOutlines',
    `return ({ ${source.slice(start, end)} }).showClearances;`)(boardShapeClearanceOutlines);
const toggleStart = source.indexOf('    _onOverlayVisibilityChanged(overlayId, visible) {');
const toggleEnd = source.indexOf('\n    _fitToContent()', toggleStart);
assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
const toggle = new Function('saveLayerPrefs',
    `return ({ ${source.slice(toggleStart, toggleEnd)} })._onOverlayVisibilityChanged;`)(() => {});
const groups = new Map(['top-copper', 'bottom-copper', 'hole', 'clearance-overlay'].map(id => [id, element()]));
const app = {
    placements: new Map(), boardShapes: [circle, rectangle, hole, line, arc],
    _layerGroups: groups, _getLayerGroup(id) { return groups.get(id); },
    _getRoutingParams() { return { clearance, trackWidth: 0.2 }; }, showClearances,
};
const overlay = groups.get('clearance-overlay');
const ids = () => new Set(overlay.children.map(child => child.attributes.get('data-shape-id')));
toggle.call(app, 'clearance', true);
assert.deepEqual(ids(), new Set(['circle', 'rect', 'hole', 'line', 'arc']));
assert.equal(overlay.children.find(child => child.attributes.get('data-shape-id') === 'circle').dataset.net, 'GND');
toggle.call(app, 'clearance', false);
assert.equal(overlay.children.length, 0, 'Eye off removes shape halos');
groups.get('hole').style.display = 'none';
groups.get('bottom-copper').style.display = 'none';
toggle.call(app, 'clearance', true);
assert.deepEqual(ids(), new Set(['circle', 'line', 'arc']), 'Copper halos survive hidden hole layer; hidden copper shapes are omitted');
toggle.call(app, 'clearance', true);
assert.equal(overlay.children.filter(child => child.attributes.get('data-shape-id') === 'circle').length, 1,
    'Refreshing replaces old shape halos');
console.log('PASS shape clearance geometry, segment widths, hollow contours, eye toggling, net tags, and layer visibility');