import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import { Net } from '../../src/shapes/net.js';
import { Wire } from '../../src/shapes/wire.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import {
    getDrawingSnappedPosition,
    PIN_PICKUP_SNAP_TOL,
    resolveWireSnapPosition,
    WIRE_PIN_SNAP_MAX_TOL,
    WIRE_PIN_SNAP_MIN_TOL,
    wirePinSnapTolerance,
} from '../../src/schematic/modules/wire-snap.js';
import { resolvePinSnapPlacement } from '../../src/schematic/modules/component-snap.js';
import { SCHEMATIC_TOOLS } from '../../src/schematic/modules/schematic-tools.js';
import { moveDragState, anchorDragState } from '../../src/schematic/modules/draw-states.js';
import { setSchematicDrag } from '../../src/schematic/modules/drag.js';

installFakeDom();
const definition = { name: 'Snap test', symbol: { graphics: [], pins: [
    { number: '1', x: 0, y: 0 }, { number: '2', x: 5, y: 0 },
] } };
const target = new Component(definition, { id: 'target', x: 10, y: 20 });
const label = new Net({ x: 9, y: 20, net: 'Gnd' });
const app = { components: [target], shapes: [label],
    viewport: { getSnappedPosition: point => ({ ...point }) } };
const excludePin = { component: label, pin: label.symbol.pins[0], pinKey: 'conn' };
const snap = resolvePinSnapPlacement(app, { x: 9, y: 20 }, { excludePin }).resolved;
assert.equal(snap.snapType, 'pin', 'Excluded self-pin must not mask a valid nearby component pin');
assert.equal(snap.snapPin.component, target);
assert.deepEqual({ x: snap.x, y: snap.y }, { x: 10, y: 20 });
const noTarget = resolveWireSnapPosition({ ...app, components: [] }, { x: 9, y: 20 }, { excludePin });
assert.equal(noTarget.snapType, 'grid', 'Label cannot snap onto its own virtual pin');
assert.equal(WIRE_PIN_SNAP_MAX_TOL, PIN_PICKUP_SNAP_TOL,
    'Normal-zoom routing uses the deliberate pin-pickup radius');
assert.equal(wirePinSnapTolerance({ zoom: 10 }), 0.5);
assert.equal(wirePinSnapTolerance({ zoom: 30 }), 0.375);
assert.equal(wirePinSnapTolerance({ zoom: 50 }), 0.25);
assert.equal(wirePinSnapTolerance({ zoom: 100 }), WIRE_PIN_SNAP_MIN_TOL);
const highZoomTolerance = wirePinSnapTolerance({ zoom: 50 });
for (const offset of [highZoomTolerance - 0.01, highZoomTolerance + 0.01, WIRE_PIN_SNAP_MAX_TOL]) {
    const routingApp = {
        components: [target],
        shapes: [],
        wirePoints: [],
        viewport: { zoom: 50, getSnappedPosition: point => ({ ...point }) },
    };
    const routed = getDrawingSnappedPosition(routingApp,
        { x: target.x + offset, y: target.y });
    assert.equal(routed.snapType === 'pin', offset < highZoomTolerance,
        `5000% wire routing ${offset < highZoomTolerance ? 'accepts' : 'rejects'} ${offset.toFixed(2)} mm pin approach`);
}

for (const rotation of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
        target.rotation = rotation;
        target.mirror = mirror;
        const pin = target.getPinPosition('2');
        for (const offset of [0.05, 0.3, PIN_PICKUP_SNAP_TOL - 0.01, PIN_PICKUP_SNAP_TOL, 0.8, 1.4]) {
            label.x = pin.x - 4; label.y = pin.y - 3;
            const start = { x: label.x, y: label.y };
            const svg = fakeElement('svg');
            Object.assign(app, {
                viewport: { svg, getSnappedPosition: point => ({
                    x: Math.round(point.x / 2.54) * 2.54, y: Math.round(point.y / 2.54) * 2.54,
                }) },
                selection: { getSelection: () => [label], keepSelected() {} },
                renderShapes() {}, updateCrosshair() {}, fileManager: { setDirty() {} },
            });
            setSchematicDrag(app, { startWorldPos: { x: 0, y: 0 }, objectStartPos: start,
                lastSnapped: { ...start }, totalDx: 0, totalDy: 0 });
            const raw = { x: pin.x + offset, y: pin.y };
            const placement = resolvePinSnapPlacement(app, raw, { excludePin, pinTolerance: PIN_PICKUP_SNAP_TOL }).resolved;
            SCHEMATIC_TOOLS.wire.hover(app, {}, { worldPos: raw });
            const wireTarget = app.wireSnapPin?.component || null;
            const positions = { worldPos: { x: raw.x - start.x, y: raw.y - start.y } };
            moveDragState.mousemove(app, {}, positions);
            if (offset < PIN_PICKUP_SNAP_TOL) {
                assert.equal(placement.snapType, 'pin');
                assert.deepEqual({ x: label.x, y: label.y }, { x: placement.x, y: placement.y },
                    'Dragged label moves exactly onto the same pin as placement, not just a highlight');
                assert.equal(app.wireSnapPin?.component, target);
                assert.equal(app.wireSnapPin?.component, wireTarget, 'Label drag and wire pickup share pin range');
                moveDragState.mousemove(app, {}, positions);
                assert.deepEqual({ x: label.x, y: label.y }, pin, 'A stationary pointer keeps snap and highlight stable');
                label.x = start.x; label.y = start.y;
                setSchematicDrag(app, { shape: label, anchorId: 'pos' });
                anchorDragState.mousemove(app, {}, { worldPos: raw, snapped: app.viewport.getSnappedPosition(raw) });
                assert.deepEqual({ x: label.x, y: label.y }, pin, 'Connection-anchor drag shares placement pin targeting');
            } else {
                assert.equal(wireTarget, null, 'Wire pickup rejects the same outside-range positions');
                assert.equal(app.wireSnapPin, null, 'Outside placement tolerance there is no pin highlight');
                assert.notDeepEqual({ x: label.x, y: label.y }, pin);
            }
        }
    }
}

{
    label.x = 0; label.y = 0;
    const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] });
    wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: label.id, pinNumber: 'conn' });
    app.shapes = [label, wire];
    setSchematicDrag(app, { startWorldPos: { x: 0, y: 0 }, objectStartPos: { x: 0, y: 0 },
        lastSnapped: { x: 0, y: 0 }, totalDx: 0, totalDy: 0 });
    moveDragState.mousemove(app, {}, { worldPos: { x: 0, y: 0 } });
    assert.equal(app.wireSnapPin, null, 'Wire-connected labels retain their sticky drag policy');
}
console.log('PASS 0.5 mm NetLabel/wire pickup pin snap parity, self exclusion, grid priority, pose and stable highlights');
