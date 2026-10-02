import assert from 'node:assert/strict';
import { Pad, PAD_SHAPES } from '../src/shapes/pad.js';
import { ModifyPadCommand, MovePadCommand } from '../src/core/pcb-pad-commands.js';
import { CommandHistory } from '../src/core/CommandHistory.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const rectangle = new Pad({ x: 10, y: 20, shape: 'rectangle', size: 2, ratio: 3, rotation: 90 });
assert.deepEqual(rectangle.getBounds(), { minX: 9, minY: 17, maxX: 11, maxY: 23 });
assert.equal(rectangle.hitTest({ x: 10.9, y: 22.9 }), true);
assert.equal(rectangle.hitTest({ x: 11.1, y: 20 }), false);
const ellipse = new Pad({ shape: 'oval', size: 2, ratio: 3 });
const stadium = new Pad({ shape: 'stadium', size: 2, ratio: 3 });
assert.equal(ellipse.hitTest({ x: 2, y: 0.9 }), false);
assert.equal(stadium.hitTest({ x: 2, y: 0.9 }), true, 'Stadium and ellipse retain distinct geometry');

const { padOutline, padBounds, padHitTest, padLayers, padFlash } = await import('../src/pcb/modules/pad.js');
const { padFlashOutline } = await import('../src/shared/pcb/board-geometry.js');
const { resolveCopperPads } = await import('../src/pcb/modules/copper-model.js');
const { createPadSelectionAdapter } = await import('../src/pcb/modules/pad-selection.js');
const { PCB_LAYERS } = await import('../src/pcb/modules/layers.js');
for (const shape of PAD_SHAPES) for (const rotation of [0, 37.123456, 90, 180, 270]) {
    for (const layers of ['top-copper', 'bottom-copper', 'both']) {
        const pad = new Pad({ x: 3.123456, y: -4.234567, shape, size: 2, ratio: 3,
            rotation, layers, drill: 1, net: 'GND' });
        const saved = pad.toJSON(), state = pad.captureState();
        const outline = pad.getOutline();
        assert.deepEqual(outline, padOutline(pad));
        assert.deepEqual(pad.getBounds(), padBounds(pad));
        assert.equal(pad.hitTest({ x: pad.x, y: pad.y }), true, 'The drill centre remains selectable');
        assert.equal(pad.hitTest({ x: pad.x + 100, y: pad.y + 100 }), false);
        for (const point of outline) assert.equal(pad.hitTest(point), padHitTest(pad, point));
        assert.deepEqual(padLayers(pad), layers === 'both' ? ['top-copper', 'bottom-copper'] : [layers]);
        const plain = structuredClone(state);
        assert.deepEqual(padFlash(plain), padFlash(pad), 'Detached fabrication data needs no model getters');
        assert.deepEqual(padOutline(plain), outline);
        const [copper] = resolveCopperPads({ pads: [plain] });
        assert.deepEqual(copper.outline, outline);
        const [physical] = resolveCopperPads({ pads: [plain] }, { physical: true });
        assert.deepEqual(physical.outline, padFlashOutline(padFlash(pad), 1e-4),
            'Physical copper retains its finer sampling tolerance');
        const adapter = createPadSelectionAdapter({}, pad, pad.id);
        assert.deepEqual(adapter.getBounds(), pad.getBounds());
        assert.equal(adapter.hitTest({ x: pad.x, y: pad.y }), pad.hitTest({ x: pad.x, y: pad.y }));
        Object.freeze(pad);
        assert.deepEqual(pad.getOutline(), outline, 'Queries do not write caches into authored pads');
        assert.deepEqual(pad.getBounds(), padBounds(pad));
        assert.deepEqual(pad.toJSON(), saved);
        assert.deepEqual(pad.captureState(), state);
        outline[0].x += 100;
        assert.notDeepEqual(pad.getOutline(), outline, 'Returned geometry is detached');
    }
}

const history = new CommandHistory();
const original = rectangle.captureState(), bounds = rectangle.getBounds();
history.execute(new ModifyPadCommand(rectangle, original, { ...original, shape: 'oval', size: 4, rotation: 37 }));
assert.deepEqual(rectangle.getBounds(), padBounds(rectangle));
assert.notDeepEqual(rectangle.getBounds(), bounds);
history.undo();
assert.deepEqual(rectangle.getBounds(), bounds);
history.redo();
const changed = rectangle.getBounds();
history.execute(new MovePadCommand(rectangle, rectangle, { x: rectangle.x + 7, y: rectangle.y - 3 }));
for (const key of ['minX', 'maxX']) assert.ok(Math.abs(rectangle.getBounds()[key] - changed[key] - 7) < 1e-12);
for (const key of ['minY', 'maxY']) assert.ok(Math.abs(rectangle.getBounds()[key] - changed[key] + 3) < 1e-12);
history.undo();
assert.deepEqual(rectangle.getBounds(), changed);
rectangle.rotation = 270;
rectangle.size = 1.5;
assert.deepEqual(rectangle.getBounds(), padBounds(rectangle), 'Direct previews cannot leave stale geometry');
rectangle.move(2.123456, -4.234567);
assert.deepEqual(rectangle.getBounds(), padBounds(rectangle));

const top = PCB_LAYERS.find(layer => layer.id === 'top-copper');
const visible = top.visible;
try {
    const hidden = new Pad({ x: 0, y: 0, layers: 'top-copper' });
    const adapter = createPadSelectionAdapter({}, hidden, hidden.id);
    const geometry = hidden.getOutline();
    top.visible = false;
    assert.equal(adapter.visible, false);
    assert.equal(hidden.hitTest({ x: 0, y: 0 }), true);
    assert.deepEqual(hidden.getOutline(), geometry, 'View preferences do not change model geometry');
} finally {
    top.visible = visible;
}
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS headless pad geometry, frozen data, snapshot parity, sampling, selection and history');
