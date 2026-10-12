import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { Track } from '../../src/shapes/track.js';
import { Via } from '../../src/shapes/via.js';
import { startTrackDraw, addTrackWaypoint, getTrackDraw, setTrackToolLayer, cancelTrackDraw } from '../../src/pcb/modules/track-draw.js';
import { collectBondedCopper } from '../../src/pcb/modules/track-connections.js';
import { buildDrawnTrackCommands } from '../../src/pcb/modules/track-commit.js';
import { PCB_LAYERS } from '../../src/pcb/modules/layers.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
function fixture(layer = 'top-copper', targetNet = 'SIGNAL') {
    const pcbDocument = new PcbDocument();
    pcbDocument.designSettings.update({ viaDiameter: 0.8, viaDrill: 0.4 });
    const targetLayer = layer === 'top-copper' ? 'bottom-copper' : 'top-copper';
    const target = new Track({ id: 'target', net: targetNet, layer: targetLayer,
        points: [{ x: 10, y: 0 }, { x: 20, y: 0 }] });
    pcbDocument.tracks.push(target);
    const svg = fakeElement('svg');
    svg.getBoundingClientRect = () => ({ left: 100, top: 100 });
    const app = { ...pcbEditorStubs(), pcbDocument, history: new CommandHistory(),
        placements: new Map([['U1', { x: 0, y: 0, side: layer === 'top-copper' ? 'top' : 'bottom',
            pads: new Map([['19', { x: 0, y: 0, width: 1, height: 1, number: '19' }]]),
            padOffsets: [{ padId: '19', number: '19', dx: 0, dy: 0, width: 1, height: 1, shape: 'rect', layer: layer === 'top-copper' ? 'top' : 'bottom' }],
        }]]),
        netlist: [{ net: 'SIGNAL', pins: [{ componentId: 'U1', pinNumber: '19' }] }],
        _shapeElements: new Map(), alerts: [], messages: [],
        alert(message) { this.alerts.push(message); }, setStatus(message) { this.messages.push(message); },
        getLayerGroup: () => null, refreshFills() {}, refreshClearanceHalos() {},
        getRoutingParams: () => pcbDocument.designSettings.getRoutingParams(),
        viewport: { svg, scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {},
            worldToScreen: point => ({ x: point.x * 100, y: point.y * 100 }) },
    };
    for (const key of ['tracks', 'vias', 'pads', 'texts', 'boardShapes']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    setTrackToolLayer(app, layer);
    return { app, target, model: pcbDocument };
}

for (const layer of ['top-copper', 'bottom-copper']) {
    for (const reverse of [false, true]) {
        for (const existingVia of [false, true]) {
            const { app, target, model } = fixture(layer);
            if (existingVia) model.vias.push(new Via({ x: 10, y: 0, diameter: 0.8, drill: 0.4, net: 'SIGNAL' }));
            const before = model.captureGeometry(), targetBefore = target.captureState();
            const draw = startTrackDraw(app, { x: reverse ? 10 : 0, y: 0 });
            assert.ok(draw);
            addTrackWaypoint(app, { x: 5, y: -3 });
            addTrackWaypoint(app, { x: reverse ? 0 : 10.03, y: reverse ? 0 : 0.02 });
            assert.equal(getTrackDraw(app), null, 'Click on yellow target finishes drawing');
            assert.equal(model.vias.length, 1, 'Opposite-layer node connection creates or reuses exactly one Via');
            assert.equal(model.vias[0].x, 10);
            assert.equal(model.vias[0].y, 0);
            assert.equal(model.vias[0].diameter, 0.8);
            assert.equal(model.vias[0].drill, 0.4);
            assert.equal(model.vias[0].net, 'SIGNAL');
            assert.equal(model.tracks.length, 2, 'Opposite-layer graphs are not fused');
            assert.deepEqual(target.captureState(), targetBefore);
            const drawn = model.tracks.find(track => track !== target);
            assert.equal(drawn.net, 'SIGNAL');
            assert.ok(collectBondedCopper(app, { track: drawn }).tracks.has(target), 'Via electrically bonds both layer nodes');
            assert.equal(app.history.undoStack.length, 1);
            const after = model.captureGeometry();
            app.history.undo();
            assert.deepEqual(model.captureGeometry(), before);
            app.history.redo();
            assert.deepEqual(model.captureGeometry(), after);
        }
    }
}

for (const blocked of ['locked', 'hidden']) {
    const layer = PCB_LAYERS.find(layer => layer.id === 'vias');
    const before = { locked: layer.locked, visible: layer.visible };
    try {
        if (blocked === 'locked') layer.locked = true;
        else layer.visible = false;
        const { app, model } = fixture();
        const draw = startTrackDraw(app, { x: 0, y: 0 });
        addTrackWaypoint(app, { x: 5, y: -3 });
        const points = structuredClone(draw.points), saved = model.captureGeometry();
        addTrackWaypoint(app, { x: 10, y: 0 });
        assert.equal(getTrackDraw(app), draw, `A ${blocked} Via layer cannot finish a cross-layer connection`);
        assert.deepEqual(draw.points, points, 'Rejected finish does not accept the target waypoint');
        assert.deepEqual(model.captureGeometry(), saved);
        assert.equal(app.history.undoStack.length, 0);
        assert.ok(app.messages.some(message => message.includes(blocked)));
        cancelTrackDraw(app);
    } finally {
        Object.assign(layer, before);
    }
}

{
    const { app, model, target } = fixture('top-copper', '');
    startTrackDraw(app, { x: 0, y: 0 });
    addTrackWaypoint(app, { x: 10, y: 0 });
    assert.equal(target.net, 'SIGNAL', 'Unassigned opposite-layer target adopts the connected net');
    assert.equal(model.vias[0].net, 'SIGNAL');
    app.history.undo();
    assert.equal(target.net, '', 'Target net adoption undoes with the draw and Via');
}
{
    const { app, model } = fixture('top-copper', 'OTHER');
    const before = model.captureGeometry();
    const drawn = new Track({ net: 'SIGNAL', layer: 'top-copper', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    assert.equal(buildDrawnTrackCommands(app, drawn), false, 'Command boundary rejects different-net transition');
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(app.alerts.length, 1);
}

console.log('PASS drawn track joins across copper sides: pin 19, exact Via, adoption, reuse, layer gates and atomic undo');
