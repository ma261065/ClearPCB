import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import { NoConnect } from '../../src/shapes/noconnect.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { SCHEMATIC_TOOLS } from '../../src/schematic/modules/schematic-tools.js';
import { anchorDragState } from '../../src/schematic/modules/draw-states.js';
import { resolveMoveDragTarget } from '../../src/schematic/modules/drag-gestures.js';
import { setSchematicDrag } from '../../src/schematic/modules/drag.js';
import { wirePinSnapTolerance, getDrawingSnappedPosition } from '../../src/schematic/modules/wire-snap.js';

installFakeDom();
const component = new Component({ name: 'Snap test', symbol: { graphics: [], pins: [
    { number: '1', x: 2, y: 0 },
] } }, { x: 10, y: 20 });
const marker = new NoConnect({ x: 0, y: 0 });
const app = {
    components: [component], shapes: [marker], wirePoints: [],
    viewport: { svg: fakeElement('svg'), zoom: 1, scale: 10,
        getSnappedPosition: point => ({
            x: Math.round(point.x / 2.54) * 2.54,
            y: Math.round(point.y / 2.54) * 2.54,
        }) },
    selection: { keepSelected() {} },
    renderShapes() {}, updateCrosshair() {}, fileManager: { setDirty() {} },
};

for (const rotation of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
        component.rotation = rotation;
        component.mirror = mirror;
        const pin = component.getPinPosition('1');
        for (const offset of [0.49, 0.51, 0.9, 1.4]) {
            const worldPos = { x: pin.x + offset, y: pin.y };
            SCHEMATIC_TOOLS.wire.hover(app, {}, { worldPos });
            const wirePin = app.wireSnapPin;
            SCHEMATIC_TOOLS.noconnect.hover(app, {}, { worldPos });
            assert.equal(app.wireSnapPin?.component || null, wirePin?.component || null,
                'No Connect preview and wire pickup have the same pin magnetism');
            assert.equal(!!app.wireSnapPin, offset < 0.5);
        }
        for (const zoom of [1, 10, 30, 50, 100]) {
            app.viewport.zoom = zoom;
            const tolerance = wirePinSnapTolerance(app.viewport);
            for (const offset of [tolerance - 0.01, tolerance + 0.01, 0.9, 1.4]) {
                const worldPos = { x: pin.x + offset, y: pin.y };
                const wire = getDrawingSnappedPosition(app, worldPos);
                const expected = wire.snapType === 'pin' ? pin : app.viewport.getSnappedPosition(worldPos);
                const moved = {};
                resolveMoveDragTarget(app, worldPos, [marker], new Set(), moved);
                assert.equal(!!app.wireSnapPin, offset < tolerance);
                assert.deepEqual(moved, expected, `Whole-marker drag matches wire radius at zoom ${zoom}`);
                marker.x = 0; marker.y = 0;
                setSchematicDrag(app, { shape: marker, anchorId: 'pos' });
                anchorDragState.mousemove(app, {}, {
                    worldPos, snapped: app.viewport.getSnappedPosition(worldPos),
                });
                assert.equal(!!app.wireSnapPin, offset < tolerance);
                assert.deepEqual({ x: marker.x, y: marker.y }, expected,
                    `Marker anchor drag matches wire radius at zoom ${zoom}`);
            }
        }
    }
}
console.log('PASS No Connect/wire pin magnetism parity for preview, body and anchor drags across zoom and pose');
