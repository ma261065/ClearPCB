import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { Track } from '../../src/shapes/track.js';
import { Pad } from '../../src/shapes/pad.js';
import { Via } from '../../src/shapes/via.js';
import { sampleArcEdge } from '../../src/shapes/arc-edge.js';
import { getTrackDraw, setTrackToolNet } from '../../src/pcb/modules/track-draw.js';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { startVertexDrag, updateVertexDrag, finishVertexDrag } = await import('../../src/pcb/modules/track-drag.js');
const { buildDrawnTrackCommands } = await import('../../src/pcb/modules/track-commit.js');
const { startTrackDraw, addTrackWaypoint, cancelTrackDraw } = await import('../../src/pcb/modules/track-draw.js');
const { collectBondedCopper, collectNodeConnections } = await import('../../src/pcb/modules/track-connections.js');
const { applyNetToBondedCopper } = await import('../../src/pcb/modules/track-properties.js');
const { runDRC } = await import('../../src/pcb/modules/drc.js');

const track = (points, net = 'A', extra = {}) => new Track({ points, net, width: 0.4, ...extra });
function fixture() {
    const app = { ...pcbEditorStubs(), pcbDocument: new PcbDocument(), placements: new Map(), netlist: [], copperFills: [],
        history: new CommandHistory(), _shapeElements: new Map(), 
        getLayerGroup: () => null, refreshClearanceHalos() {}, refreshFills: () => false,
        getRoutingParams: () => ({ trackWidth: 0.4, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }),
        viewport: { scale: 100, gridVisible: false, shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
        alert(message) { this.alerts.push(message); }, alerts: [],
    };
    for (const key of ['tracks', 'vias', 'pads', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    return app;
}
function dragEnd(app, source, to) {
    const nodeId = [...source.nodes.keys()].at(-1), from = source.nodes.get(nodeId);
    assert.equal(startVertexDrag(app, source, from, { nodeId }), true);
    updateVertexDrag(app, to);
    finishVertexDrag(app);
}
const rectangle = (net = 'B') => ({
    id: 'crossing-artwork', kind: 'rect', net, filled: true, layer: 'top-copper',
    copperMode: 'add', lineWidth: 0.2, points: [
        { x: 4, y: -4 }, { x: 6, y: -4 }, { x: 6, y: 4 }, { x: 4, y: 4 },
    ],
});
function assertUndo(app, before, after) {
    const ordered = state => ({ ...state, tracks: [...state.tracks].sort((a, b) => a.id.localeCompare(b.id)) });
    app.history.undo();
    assert.deepEqual(ordered(app.pcbDocument.captureGeometry()), ordered(before));
    app.history.redo();
    assert.deepEqual(ordered(app.pcbDocument.captureGeometry()), ordered(after));
}

{
    const app = fixture();
    const source = track([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    const crossing = track([{ x: 5, y: -5 }, { x: 5, y: 5 }], 'B');
    app.tracks.push(source, crossing);
    const physical = collectBondedCopper(app, { track: source }, { includeShapes: true });
    assert.ok(physical.tracks.has(crossing), 'physical connectivity still includes crossings');
    const dropped = collectNodeConnections(app, new Map([[source, new Set(source.nodes.keys())]]));
    assert.deepEqual([...dropped.tracks], [source], 'node targets are independent of physical crossing detection');
    const via = new Via({ x: 10, y: 0, net: 'A' });
    app.vias.push(via);
    const connected = collectNodeConnections(app, new Map([[source, new Set(source.nodes.keys())]]));
    assert.deepEqual([...connected.vias], [via], 'a drop onto the terminal centre is a connection');
}

for (const kind of ['track', 'shape', 'via', 'pad']) {
    for (const net of ['B', '']) {
        const app = fixture();
        const source = track([{ x: 0, y: 0 }, { x: 10, y: -8 }]);
        const target = track([{ x: 12, y: 0 }, { x: 20, y: 0 }]);
        app.tracks.push(source, target);
        const crossing = kind === 'track' ? track([{ x: 5, y: -5 }, { x: 5, y: 5 }], net)
            : kind === 'shape' ? rectangle(net)
                : kind === 'via' ? new Via({ x: 5, y: 0, net })
                    : new Pad({ x: 5, y: 0, net });
        app[kind === 'track' ? 'tracks' : kind === 'shape' ? 'boardShapes' : `${kind}s`].push(crossing);
        const before = app.pcbDocument.captureGeometry();
        dragEnd(app, source, { x: 12, y: 0 });
        assert.equal(app.alerts.length, 0, `${kind}: same-net drop is not rejected by a remote crossing`);
        assert.equal(app.history.undoStack.length, 1);
        assert.equal(crossing.net, net, `${kind}: incidental crossing never adopts or changes a Net`);
        assert.ok(app.tracks.some(item => [...item.nodes.values()].some(node => node.x === 20)));
        if (net) {
            assert.ok(runDRC(app, { clearance: 0.2 }).violations.some(v => /short|clearance/i.test(v.rule)),
                `${kind}: allowed crossing remains a real DRC error`);
        }
        assertUndo(app, before, app.pcbDocument.captureGeometry());
    }
}

for (const kind of ['segment', 'arc', 'pad', 'via', 'shape']) {
    const app = fixture();
    const source = track([{ x: 0, y: 0 }, { x: 3, y: 0 }]);
    app.tracks.push(source);
    let destination = { x: 10, y: 0 };
    if (kind === 'segment' || kind === 'arc') {
        const target = track([{ x: 10, y: -5 }, { x: 10, y: 5 }], 'B');
        if (kind === 'arc') {
            target.edges.values().next().value.bulge = 1;
            destination = sampleArcEdge({ x: 10, y: -5 }, { x: 10, y: 5 }, 1, 2)[1];
        }
        app.tracks.push(target);
    } else if (kind === 'pad') app.pads.push(new Pad({ ...destination, net: 'B' }));
    else if (kind === 'via') app.vias.push(new Via({ ...destination, net: 'B' }));
    else { app.boardShapes.push(rectangle()); destination = { x: 5, y: 0 }; }
    const before = app.pcbDocument.captureGeometry();
    dragEnd(app, source, destination);
    assert.equal(app.history.undoStack.length, 0, `${kind}: direct incompatible node drop is rejected`);
    assert.equal(app.alerts.length, 1, `${kind}: direct conflict is surfaced`);
    assert.deepEqual(app.pcbDocument.captureGeometry(), before);
}

{
    const app = fixture();
    const first = track([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    const second = track([{ x: 5, y: -5 }, { x: 5, y: 5 }]);
    app.tracks.push(first, second);
    assert.equal(applyNetToBondedCopper(app, { track: second }, 'B'), true);
    assert.equal(first.net, 'A');
    assert.equal(second.net, 'B');
    for (const item of [first, second]) {
        const point = [...item.nodes.values()].at(-1);
        dragEnd(app, item, { x: point.x + 0.5, y: point.y + 0.2 });
    }
    assert.equal(app.alerts.length, 0, 'Net dropdown followed by node jiggles does not invoke unrelated crossing warnings');
    assert.equal(app.history.undoStack.length, 3);
    assert.ok(runDRC(app, { clearance: 0.2 }).violations.some(v => /short|clearance/i.test(v.rule)));
}

for (const kind of ['track', 'shape']) for (const net of ['', 'B']) {
    const app = fixture();
    app.viewport.shiftHeld = false;
    const crossing = kind === 'track' ? track([{ x: 5, y: -5 }, { x: 5, y: 5 }], net)
        : rectangle(net);
    app[kind === 'track' ? 'tracks' : 'boardShapes'].push(crossing);
    app.pads.push(new Pad({ x: 0, y: 0, net: 'A' }), new Pad({ x: 10, y: 0, net: 'A' }));
    const before = app.pcbDocument.captureGeometry();
    startTrackDraw(app, { x: 0, y: 0 });
    addTrackWaypoint(app, { x: 10, y: 0 });
    assert.equal(app.alerts.length, 0);
    assert.equal(app.history.undoStack.length, 1);
    assert.equal(crossing.net, net, 'drawing never labels unrelated crossing copper');
    if (net) assert.ok(runDRC(app, { clearance: 0.2 }).violations.some(v => /short|clearance/i.test(v.rule)));
    assertUndo(app, before, app.pcbDocument.captureGeometry());
}

for (const net of ['', 'B']) {
    const app = fixture();
    const source = track([{ x: 0, y: 0 }, { x: 12, y: -5 }]);
    const crossing = track([{ x: 5, y: 0 }, { x: 5, y: 5 }], net);
    app.tracks.push(source, crossing);
    dragEnd(app, source, { x: 12, y: 0 });
    assert.equal(app.alerts.length, 0, 'sweeping a segment over a stationary endpoint is not a direct node drop');
    assert.equal(crossing.net, net);
}

for (const kind of ['segment', 'shape']) {
    const app = fixture();
    const source = track([{ x: 0, y: 0 }, { x: 3, y: 0 }]);
    const destination = kind === 'segment' ? track([{ x: 10, y: -5 }, { x: 10, y: 5 }], '')
        : { ...rectangle(''), points: rectangle('').points.map(p => ({ x: p.x + 5, y: p.y })) };
    const unrelated = track([{ x: 5, y: -5 }, { x: 5, y: 5 }], '');
    app.tracks.push(source, unrelated);
    app[kind === 'segment' ? 'tracks' : 'boardShapes'].push(destination);
    const before = app.pcbDocument.captureGeometry();
    dragEnd(app, source, { x: 10, y: 0 });
    assert.equal(app.alerts.length, 0);
    assert.equal(destination.net, 'A', 'directly contacted unassigned copper still adopts the source Net');
    assert.equal(unrelated.net, '', 'adoption does not spread along crossing-only copper');
    assertUndo(app, before, app.pcbDocument.captureGeometry());
}

for (const merge of [false, true]) {
    const app = fixture();
    const source = track(merge
        ? [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: -5 }]
        : [{ x: 0, y: 0 }, { x: 5, y: -5 }, { x: 10, y: 0 }]);
    const destination = rectangle('');
    app.tracks.push(source);
    app.boardShapes.push(destination);
    const before = app.pcbDocument.captureGeometry();
    const nodeId = [...source.nodes.keys()][merge ? 2 : 1];
    startVertexDrag(app, source, source.nodes.get(nodeId), { nodeId });
    updateVertexDrag(app, { x: 5, y: 0 });
    finishVertexDrag(app);
    assert.equal(app.alerts.length, 0);
    assert.equal(source.nodes.has(nodeId), false, 'final topology removes the dropped node');
    assert.equal(destination.net, 'A', 'validated adoption survives node merge/collinear cleanup');
    assertUndo(app, before, app.pcbDocument.captureGeometry());
}

{
    const app = fixture();
    const source = track([{ x: 0, y: 0 }, { x: 3, y: 0 }]);
    const target = track([{ x: 10, y: -5 }, { x: 10, y: 5 }], 'B', { layer: 'bottom-copper' });
    app.tracks.push(source, target);
    dragEnd(app, source, { x: 10, y: 0 });
    assert.equal(app.alerts.length, 0, 'same coordinates on separate copper layers do not connect');
    assert.equal(app.history.undoStack.length, 1);
    assert.equal(target.net, 'B');
}

{
    const app = fixture();
    app.tracks.push(track([{ x: 10, y: -5 }, { x: 10, y: 5 }], 'B'));
    const drawn = track([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    assert.equal(buildDrawnTrackCommands(app, [drawn]), false, 'direct segment destination is guarded at command boundary');
    setTrackToolNet(app, 'A');
    startTrackDraw(app, { x: 0, y: 0 });
    addTrackWaypoint(app, { x: 10, y: 0 });
    assert.equal(getTrackDraw(app).points.length, 1, 'incompatible segment click is rejected before accepting a waypoint');
    cancelTrackDraw(app);
}
console.log('PASS direct-node connection policy, remote crossings as DRC, adoption isolation, dropdown/jiggle parity and exact undo');
