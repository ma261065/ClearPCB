import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import { Net } from '../../src/shapes/net.js';
import { Text } from '../../src/shapes/text.js';
import { Wire } from '../../src/shapes/wire.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { extractNetlist } from '../../src/core/netlist.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { MoveShapesCommand, TransformComponentCommand, ModifyPropertyCommand, ModifyShapeCommand } from '../../src/schematic/modules/commands.js';
import { beginSelectionMove } from '../../src/schematic/modules/drag-gestures.js';
import { moveDragState } from '../../src/schematic/modules/draw-states.js';
import { cancelDragGesture, commitMoveDrag, getSchematicDrag } from '../../src/schematic/modules/drag.js';

installFakeDom();
globalThis.requestAnimationFrame = () => 0;
const definition = { name: 'sticky-label-test', symbol: { graphics: [], pins: [
    { number: '1', x: -5, y: 0 }, { number: '2', x: 5, y: 0 },
] } };
function fixture(together = false) {
    const component = new Component(definition, { id: 'U1', x: 20, y: 10, reference: 'U1' });
    const label = new Net({ ...component.getPinPosition('1'), net: 'Gnd', style: 'gnd' });
    const text = new Text({ ...label.getTextPosition(), text: label.net });
    label.labelText = text;
    text.parentComponent = label;
    text.fieldKey = 'net';
    const unrelated = new Net({ x: 50, y: 50, net: 'Other' });
    const selected = together ? [component, label, text] : [component];
    const app = { shapes: [label, text, unrelated], components: [component],
        history: new CommandHistory(), interactionState: 'idle',
        viewport: { svg: fakeElement('svg'), layers: new Map(), scale: 20, shiftHeld: true,
            getSnappedPosition: point => ({ ...point }) },
        selection: { getSelection: () => selected, keepSelected() {} },
        renderShapes() {}, hideCrosshair() {}, removeBoxSelectElement() {},
        fileManager: { setDirty() {} }, updatePropertiesPanel() {},
        alert(message) { assert.fail(message); },
    };
    const snapshot = () => [component.captureState(), ...app.shapes.map(shape => shape.captureState())];
    const check = () => {
        const point = component.getPinPosition('1');
        assert.ok(Math.hypot(label.x - point.x, label.y - point.y) < 1e-9, 'Label follows its component pin');
        assert.ok(Math.hypot(text.x - label.getTextPosition().x, text.y - label.getTextPosition().y) < 1e-9,
            'Label text follows exactly once');
        assert.deepEqual(extractNetlist(app).find(net => net.net === 'Gnd')?.pins,
            [{ componentId: component.id, pinNumber: '1' }]);
        assert.deepEqual({ x: unrelated.x, y: unrelated.y }, { x: 50, y: 50 });
    };
    return { app, component, label, text, selected, snapshot, check };
}

for (const together of [false, true]) {
    const f = fixture(together), { app, component, label, selected } = f;
    const original = f.snapshot();
    beginSelectionMove(app, { x: 20, y: 10 }, { x: 20, y: 10 });
    for (const point of [{ x: 23, y: 14 }, { x: 26, y: 17 }, { x: 30, y: 20 }]) {
        moveDragState.mousemove(app, {}, { worldPos: point });
        f.check();
    }
    const preview = f.snapshot();
    cancelDragGesture(app);
    assert.deepEqual(f.snapshot(), original, 'Escape restores component, label and text');
    beginSelectionMove(app, { x: 20, y: 10 }, { x: 20, y: 10 });
    moveDragState.mousemove(app, {}, { worldPos: { x: 30, y: 20 } });
    commitMoveDrag(app, getSchematicDrag(app).totalDx, getSchematicDrag(app).totalDy);
    assert.deepEqual(f.snapshot(), preview, 'Commit retains the live attachment');
    f.check();
    app.history.undo();
    assert.deepEqual(f.snapshot(), original);
    app.history.redo();
    assert.deepEqual(f.snapshot(), preview);
    if (!together) {
        label.move(12, 0);
        const detached = { x: label.x, y: label.y };
        app.history.execute(new MoveShapesCommand(app, selected, 3, 4));
        assert.deepEqual({ x: label.x, y: label.y }, detached, 'A label dragged off its pin no longer follows');
    }
}

for (const transform of ['RotateRight', 'RotateLeft', 'FlipH', 'FlipV']) {
    const f = fixture(), { app, component } = f;
    const before = f.snapshot();
    app.history.execute(new TransformComponentCommand(app, [component], transform));
    f.check();
    const after = f.snapshot();
    app.history.undo();
    assert.deepEqual(f.snapshot(), before);
    app.history.redo();
    assert.deepEqual(f.snapshot(), after);
    f.check();
}
for (const property of ['x', 'y', 'rotation', 'mirror']) {
    const f = fixture(), { app, component } = f;
    const before = f.snapshot();
    app.history.execute(new ModifyPropertyCommand(app, [component], property,
        property === 'mirror' ? true : property === 'rotation' ? 90 : 30));
    f.check();
    const after = f.snapshot();
    app.history.undo();
    assert.deepEqual(f.snapshot(), before);
    app.history.redo();
    assert.deepEqual(f.snapshot(), after);
}
{
    const f = fixture(), { app, component, label } = f;
    const wire = new Wire({ points: [{ x: label.x, y: label.y }, { x: label.x - 10, y: label.y }] });
    wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: label.id, pinNumber: 'conn' });
    app.shapes.push(wire);
    const before = component.captureState();
    app.history.execute(new ModifyShapeCommand(app, component, before, { ...before, x: 30, y: 20 }));
    f.check();
    assert.deepEqual(wire.nodes.values().next().value, { x: label.x, y: label.y },
        'Wire attached via the label follows after the label moves');
    app.history.undo();
    f.check();
}
console.log('PASS direct pin NetLabels follow component drags, transforms/properties, cancellation and exact history');
