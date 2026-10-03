import assert from 'node:assert/strict';
import { Circle } from '../src/shapes/circle.js';
import { Arc } from '../src/shapes/arc.js';
import { Polyline } from '../src/shapes/polyline.js';
import { Track } from '../src/shapes/track.js';
import { Text } from '../src/shapes/text.js';
import { MoveVertexCommand, ModifyTrackGraphCommand } from '../src/core/pcb-track-commands.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { SelectionManager } from '../src/core/SelectionManager.js';
import { renderShape } from '../src/schematic/render/shape-renderer.js';
import { viewOf } from '../src/schematic/render/shape-view-state.js';

assert.equal(typeof document, 'undefined');
for (const shape of [
    new Circle({ x: 1.123456, y: 2, radius: 3 }),
    new Arc(),
    new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }),
    new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }),
    new Text({ x: 1, y: 2, text: 'Headless', fontSize: 2 }),
]) {
    const calculate = shape._calculateBounds.bind(shape);
    let calculations = 0;
    shape._calculateBounds = () => { calculations++; return calculate(); };
    const saved = shape.toJSON();
    const state = shape.captureState();
    const bounds = shape.getBounds();
    for (let index = 0; index < 100; index++) assert.equal(shape.getBounds(), bounds);
    assert.equal(calculations, 1, `${shape.type}: headless queries calculate once without an SVG render`);
    assert.equal(shape._dirty, true, 'Reading bounds must not acknowledge pending rendering');
    assert.equal(viewOf(shape), undefined);
    assert.deepEqual(shape.toJSON(), saved);
    shape.move(3.123456, -4.234567);
    const moved = shape.getBounds();
    assert.deepEqual(moved, calculate(), 'Movement invalidates bounds before any render');
    assert.equal(calculations, 2);
    assert.notDeepEqual(moved, bounds);
    assert.equal(shape.getBounds(), moved);
    shape.applyState(state);
    assert.deepEqual(shape.getBounds(), bounds);
    assert.equal(calculations, 3);
    shape.invalidate();
    assert.equal(shape._bounds, null);
    assert.deepEqual(shape.getBounds(), bounds);
    assert.equal(calculations, 4);
}

const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
const initial = track.getBounds();
const history = new CommandHistory();
history.execute(new MoveVertexCommand(track, 'n0', 0, 0, -5.123456, 4));
assert.deepEqual(track.getBounds(), track._calculateBounds());
assert.notDeepEqual(track.getBounds(), initial);
history.undo();
assert.deepEqual(track.getBounds(), initial);
history.redo();
assert.deepEqual(track.getBounds(), track._calculateBounds());
const before = track.captureState();
track.setEdgeAttr('e0', 'bulge', 1);
const curved = track.getBounds();
assert.deepEqual(curved, track._calculateBounds());
const after = track.captureState();
track.applyState(before);
history.execute(new ModifyTrackGraphCommand(track, before, after));
assert.deepEqual(track.getBounds(), curved);
history.undo();
assert.deepEqual(track.getBounds(), track._calculateBounds());
history.redo();
assert.deepEqual(track.getBounds(), curved);
track.splitEdge('e0', { x: 3, y: -2 });
assert.deepEqual(track.getBounds(), track._calculateBounds(), 'Topology edits invalidate cached bounds');

const arc = new Arc();
for (const [key, value] of [['startPoint', { x: -5, y: 1 }], ['endPoint', { x: 20, y: 3 }],
    ['bulgePoint', { x: 6, y: 9 }], ['bulge', -0.5]]) {
    const previous = arc.getBounds();
    arc[key] = value;
    assert.equal(arc._bounds, null, `${key} invalidates bounds as well as arc geometry`);
    assert.deepEqual(arc.getBounds(), arc._calculateBounds());
    assert.notDeepEqual(arc.getBounds(), previous);
}

const circle = new Circle({ radius: 2 });
const selection = new SelectionManager();
selection.setShapes([circle]);
assert.equal(selection.hitTest({ x: 2, y: 0 }), circle);
circle.move(100, 0);
assert.equal(selection.hitTest({ x: 102, y: 0 }), circle, 'Bounds pruning sees headless movement');
assert.equal(selection.hitTest({ x: 2, y: 0 }), null);

class Element {
    children = [];
    style = {};
    attributes = new Map();
    appendChild(child) { this.children.push(child); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getBBox() {
        const text = this.children[1];
        return { x: Number(text.attributes.get('x')), y: Number(text.attributes.get('y')) - 2,
            width: text.textContent.length * 1.7, height: 2 };
    }
}
globalThis.document = { createElementNS: () => new Element() };
const text = new Text({ x: 1, y: 4, text: 'Text' });
const estimate = text.getBounds();
renderShape(text, 10);
assert.equal(text._dirty, false);
assert.deepEqual(text.getBounds(), { minX: 1, minY: 2, maxX: 7.8, maxY: 4 },
    'Text replaces its headless estimate with rendered font measurements');
assert.notDeepEqual(text.getBounds(), estimate);
text.text = 'Longer';
text.invalidate();
text.getBounds();
assert.equal(text._dirty, true);
renderShape(text, 10);
assert.deepEqual(text.getBounds(), { minX: 1, minY: 2, maxX: 11.2, maxY: 4 },
    'A bounds query before rendering cannot preserve stale text metrics');
const beforeRender = circle.getBounds();
renderShape(circle, 10);
assert.equal(circle._dirty, false);
assert.equal(circle.getBounds(), beforeRender, 'SVG rendering does not discard valid geometric bounds');
circle.move(5, 0);
circle.getBounds();
assert.equal(circle._dirty, true);
renderShape(circle, 10);
assert.equal(viewOf(circle).element.attributes.get('cx'), '105', 'Geometry queries never suppress a required SVG update');
console.log('PASS renderer-independent bounds reuse, mutation/history, selection and text measurement refresh');
