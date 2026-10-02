import assert from 'node:assert/strict';
import { Via } from '../src/shapes/via.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { MoveViaCommand, ModifyViaCommand } from '../src/core/pcb-via-commands.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const via = new Via({ x: 3, y: -4, diameter: 2, drill: 1 });
assert.deepEqual(via.getBounds(), { minX: 2, minY: -5, maxX: 4, maxY: -3 });
assert.equal(via.hitTest({ x: 3, y: -4 }), true, 'Drill centre remains part of the selectable area');
assert.equal(via.hitTest({ x: 4, y: -4 }), true);
assert.equal(via.hitTest({ x: 4.01, y: -4 }), false, 'Model queries add no pixel tolerance');
assert.equal(via.hitTest({ x: 4.01, y: -4 }, 0.02), true);
const { viaBounds, viaHitTest } = await import('../src/shapes/via.js');
for (const diameter of [0.05, 0.678912, 2, 10]) {
    const target = new Via({ x: Math.PI, y: -Math.E, diameter, drill: diameter / 2,
        visible: false, locked: true, net: 'GND' });
    const saved = target.toJSON(), state = target.captureState();
    const plain = structuredClone(state);
    const bounds = target.getBounds();
    assert.deepEqual(bounds, viaBounds(plain), 'Plain snapshots share physical bounds');
    assert.ok(Math.abs(bounds.maxX - bounds.minX - diameter) < 1e-12);
    for (const tolerance of [0, 0.01, 0.5]) for (const angle of [0, 0.37, 1, 2, 3]) {
        for (const offset of [-1e-6, 1e-6]) {
            const radius = diameter / 2 + tolerance + offset;
            const point = { x: target.x + Math.cos(angle) * radius, y: target.y + Math.sin(angle) * radius };
            assert.equal(target.hitTest(point, tolerance), offset < 0);
            assert.equal(viaHitTest(plain, point, tolerance), offset < 0);
        }
    }
    Object.freeze(target);
    assert.deepEqual(target.getBounds(), bounds, 'Read-only queries work with frozen entities');
    assert.equal(target.hitTest(target), true, 'Object visibility/lock does not alter physical geometry');
    bounds.minX = 999;
    assert.notDeepEqual(target.getBounds(), bounds, 'Returned bounds are detached');
    assert.deepEqual(target.captureState(), state);
    assert.deepEqual(target.toJSON(), saved);
}
const history = new CommandHistory();
const before = via.captureState(), bounds = via.getBounds();
history.execute(new ModifyViaCommand(via, before, { ...before, diameter: 4.123456, drill: 2 }));
assert.deepEqual(via.getBounds(), viaBounds(via));
assert.notDeepEqual(via.getBounds(), bounds);
history.execute(new MoveViaCommand(via, via.x, via.y, 10.123456, -20.234567));
assert.deepEqual(via.getBounds(), viaBounds(via));
history.undo();
history.undo();
assert.deepEqual(via.getBounds(), bounds);
history.redo();
history.redo();
assert.equal(via.hitTest({ x: 10.123456, y: -20.234567 }), true);
via.move(2, 3);
via.diameter = 0.8;
assert.deepEqual(via.getBounds(), viaBounds(via), 'Direct previews need no rendering or cache invalidation');

const { createViaSelectionAdapter, hitTestTrack, hitTestLockedTrack } = await import('../src/pcb/modules/track-select.js');
const { pointInBoxSelection, armBoxSelect, maybeStartBoxSelect, finishBoxSelect } = await import('../src/pcb/modules/box-select.js');
const { setPcbSelection, getPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { startViaDrag, cancelViaDrag } = await import('../src/pcb/modules/track-drag.js');
const { PCB_LAYERS } = await import('../src/pcb/modules/layers.js');
const viaLayer = PCB_LAYERS.find(layer => layer.id === 'vias');
const layerState = { visible: viaLayer.visible, locked: viaLayer.locked };
globalThis.document = { getElementById: () => null,
    createElementNS: () => ({ style: {}, setAttribute() {}, remove() {} }) };
try {
    viaLayer.visible = true;
    viaLayer.locked = false;
    const target = new Via({ x: 0, y: 0, diameter: 1 });
    for (const scale of [1, 10, 100]) {
        const app = { tracks: [], vias: [target], pads: [], boardShapes: [], texts: new Map(),
            placements: new Map(), netlist: [], _layerGroups: new Map(), getLayerGroup: () => null,
            viewport: { scale, gridVisible: false, hideCrosshair() {}, setCrosshair() {} } };
        const tolerance = 6 / scale;
        const inside = { x: 0.5 + tolerance - 1e-6, y: 0 };
        const outside = { x: 0.5 + tolerance + 1e-6, y: 0 };
        const adapter = createViaSelectionAdapter(app, target, target.id);
        assert.deepEqual(adapter.getBounds(), target.getBounds());
        const plainAdapter = createViaSelectionAdapter(app, target.captureState(), 'snapshot');
        assert.deepEqual(plainAdapter.getBounds(), target.getBounds());
        assert.equal(plainAdapter.hitTest(inside, tolerance), true, 'Plain-data adapters retain support');
        assert.equal(adapter.hitTest(inside, tolerance), true);
        assert.equal(adapter.hitTest(outside, tolerance), false);
        assert.equal(hitTestTrack(app, inside)?.via, target);
        assert.equal(hitTestTrack(app, outside), null);
        setPcbSelection(app, [{ kind: 'via', object: target }]);
        assert.equal(pointInBoxSelection(app, inside), true);
        assert.equal(pointInBoxSelection(app, outside), false);
        assert.equal(startViaDrag(app, target, outside), false);
        assert.equal(startViaDrag(app, target, inside), true);
        cancelViaDrag(app);
        viaLayer.locked = true;
        assert.equal(hitTestTrack(app, inside), null);
        assert.equal(hitTestLockedTrack(app, inside)?.type, 'via');
        assert.equal(hitTestLockedTrack(app, outside), null);
        viaLayer.visible = false;
        assert.equal(adapter.visible, false);
        assert.equal(hitTestLockedTrack(app, inside), null);
        assert.equal(target.hitTest(inside, tolerance), true, 'Layer policy remains outside the model');
        viaLayer.locked = false;
        viaLayer.visible = true;
    }
    for (const [offset, expectedCount] of [[-1e-6, 0], [0, 1], [1e-6, 1]]) {
        const target = new Via({ x: 10, y: 10, diameter: 1 });
        const app = { tracks: [], vias: [target], pads: [], boardShapes: [], texts: new Map(),
            placements: new Map(), _layerGroups: new Map(), getLayerGroup: () => null,
            viewport: { scale: 10, contentLayer: { appendChild() {} } } };
        armBoxSelect(app, { x: 0, y: 0 }, { x: 0, y: 0 });
        assert.equal(maybeStartBoxSelect(app, { clientX: 100, clientY: 100 },
            { x: 10.5 + offset, y: 20 }), true);
        assert.equal(getPcbSelection(app, 'via').length, expectedCount,
            'Marquee containment includes the entire via radius without hit-test tolerance');
        finishBoxSelect(app);
        assert.equal(getPcbSelection(app, 'via').length, expectedCount);
    }
} finally {
    Object.assign(viaLayer, layerState);
    delete globalThis.document;
}
console.log('PASS physical via queries, frozen/plain data, history and consistent six-pixel interaction thresholds');
