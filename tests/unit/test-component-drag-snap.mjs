import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import { Net } from '../../src/shapes/net.js';
import { Wire } from '../../src/shapes/wire.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { resolveDraggingComponentSnap } from '../../src/schematic/modules/component-snap.js';
import { setSchematicDrag, getSchematicDrag } from '../../src/schematic/modules/drag.js';
import { beginSelectionMove } from '../../src/schematic/modules/drag-gestures.js';
import { moveDragState } from '../../src/schematic/modules/draw-states.js';

installFakeDom();
const definition = { name: 'Drag snap probe', symbol: { graphics: [], pins: [
    { number: 1, x: 0, y: 0 }, { number: '2', x: 0, y: 5 },
] } };
function fixture() {
    const component = new Component(definition, { id: 'source' });
    const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: component.id, pinNumber: '1' });
    const app = { components: [component], shapes: [wire],
        wireSnapPin: null,
        viewport: { scale: 20, svg: fakeElement('svg'), layers: new Map(), getSnappedPosition: point => ({ ...point }) },
        selection: { getSelection: () => [component] },
        renderShapes() {}, fileManager: { setDirty() {} },
    };
    setSchematicDrag(app, { netLabels: [] });
    return { app, component, wire };
}

for (const delta of [{ x: 0.3, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 0.3 }, { x: 2, y: 2 }]) {
    const { app, component, wire } = fixture();
    const before = wire.captureState();
    const snap = resolveDraggingComponentSnap(app, component, delta, { x: 0, y: 0 });
    assert.equal(snap.pinSnap, null, 'An attached pin does not highlight its own wire node or segment');
    assert.deepEqual(snap.targetPos, delta, 'Connection magnet does not pull the component back to its old attachment');
    assert.deepEqual(wire.captureState(), before, 'Target resolution does not edit wire geometry');
}

{
    const { app, component } = fixture();
    const destination = new Wire({ points: [{ x: 2, y: 5 }, { x: 12, y: 5 }] });
    app.shapes.push(destination);
    const snap = resolveDraggingComponentSnap(app, component, { x: 2.3, y: 0 }, { x: 0, y: 0 });
    assert.ok(snap.pinSnap, 'A free pin still snaps onto an external wire node');
    assert.deepEqual(snap.targetPos, { x: 2, y: 0 });
    assert.equal(getSchematicDrag(app)._componentSnapState.lockedPinKey, '2');
    assert.equal(snap.pinSnap.snapType, 'endpoint');
}

{
    const { app, component } = fixture();
    const destination = new Component(definition, { id: 'destination', x: 2, y: 0 });
    app.components.push(destination);
    const snap = resolveDraggingComponentSnap(app, component, { x: 2.3, y: 0 }, { x: 0, y: 0 });
    assert.equal(snap.pinSnap?.snapPin?.component, destination, 'Free pins still highlight external component pins');
    assert.deepEqual(snap.targetPos, { x: 2, y: 0 });
    setSchematicDrag(app, { netLabels: [] });
    const moving = resolveDraggingComponentSnap(app, component, { x: 2.3, y: 0 }, { x: 0, y: 0 },
        new Set([component.id, destination.id]));
    assert.equal(moving.pinSnap, null, 'Other components in the moving selection are not stationary pin targets');
}

{
    const { app, component } = fixture();
    const destination = new Wire({ points: [{ x: 2, y: 0 }, { x: 12, y: 0 }] });
    app.shapes.push(destination);
    const snap = resolveDraggingComponentSnap(app, component, { x: 2.3, y: 0 }, { x: 0, y: 0 });
    assert.equal(snap.pinSnap, null, 'An already wired source pin cannot advertise a new external connection');
    app.shapes.length = 0;
    setSchematicDrag(app, { netLabels: [] });
    const detached = resolveDraggingComponentSnap(app, component, { x: 0, y: -4.7 }, { x: 0, y: 0 });
    assert.equal(detached.pinSnap, null, 'The component cannot snap its free pin to another pin of itself');
}

{
    const { app, component, wire } = fixture();
    const label = new Net({ x: 0, y: 0, net: 'Gnd' });
    wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: label.id, pinNumber: 'conn' });
    app.shapes.push(label);
    setSchematicDrag(app, { netLabels: [{ net: label, component, pinX: 0, pinY: 0, offsetX: 0, offsetY: 0 }] });
    const snap = resolveDraggingComponentSnap(app, component, { x: 0.3, y: 0 }, { x: 0, y: 0 });
    assert.equal(snap.pinSnap, null, 'A pin wired through its directly attached NetLabel is already connected');
    assert.deepEqual(snap.targetPos, { x: 0.3, y: 0 });
    setSchematicDrag(app, { netLabels: [] });
    const together = resolveDraggingComponentSnap(app, component, { x: 0.3, y: 0 }, { x: 0, y: 0 },
        new Set([component.id, label.id]));
    assert.equal(together.pinSnap, null, 'Explicitly selected pin labels do not re-enable false wire targets');
}

{
    const { app, component } = fixture();
    beginSelectionMove(app, { x: 0, y: 0 }, { x: 0, y: 0 });
    for (const x of [0.3, 0.7, 1.2, 2, 2.3]) {
        moveDragState.mousemove(app, {}, { worldPos: { x, y: 0 } });
        assert.equal(app.wireSnapPin, null, 'Live sticky-wire/bridge updates do not invent new yellow targets');
        assert.ok(Math.abs(component.x - x) < 1e-9);
        const wire = app.shapes[0], node = wire.nodes.values().next().value;
        assert.deepEqual({ x: node.x, y: node.y }, component.getPinPosition(1),
            'Suppressing connection snaps does not detach the sticky wire');
    }
}

console.log('PASS component drag ignores already-wired pin magnets while preserving free-pin targets and sticky wires');
