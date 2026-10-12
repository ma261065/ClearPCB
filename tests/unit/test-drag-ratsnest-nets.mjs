import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = { addEventListener() {} };
installFakeDom();
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { setEditorActive } = await import('../../src/pcb/modules/pcb-editor-api.js');
const { reconcileRatsnest } = await import('../../src/pcb/modules/ratsnest.js');
const { storedDrcRatlines } = await import('../../src/pcb/modules/drc-state.js');
const { setDragOverlaysDeferred } = await import('../../src/pcb/modules/refresh-state.js');
const { startVertexDrag, updateVertexDrag, cancelVertexDrag } = await import('../../src/pcb/modules/track-drag.js');
const { startViaDrag, startPadDrag, updateViaDrag, cancelViaDrag } = await import('../../src/pcb/modules/terminal-drag.js');
const { Track } = await import('../../src/shapes/track.js');
const { Via } = await import('../../src/shapes/via.js');
const { Pad } = await import('../../src/shapes/pad.js');

// Live track, via and pad drags redo only the dragged copper's nets. The ratlines must
// match a full rebuild after every move, and other nets' ratline elements are untouched.

/** Three nets, each split into pieces so it has ratlines, plus copper with no net. */
function board() {
    const groups = new Map();
    const app = pcbEditorFixture({
        getLayerGroup(id) {
            if (!groups.has(id)) groups.set(id, document.createElementNS('http://www.w3.org/2000/svg', 'g'));
            return groups.get(id);
        },
        existingLayerGroups: () => groups,
        _layerGroups: groups,
        viewport: { scale: 10, svg: document.createElementNS('http://www.w3.org/2000/svg', 'svg'), gridVisible: false,
            snapToGrid: false, shiftHeld: false,
            setCrosshair() {}, hideCrosshair() {}, getSnappedPosition: point => ({ x: point.x, y: point.y }) },
    });
    app.designSettings = app.pcbDocument.designSettings;
    setEditorActive(app, true);
    setDragOverlaysDeferred(app, true);
    const doc = app.pcbDocument;
    const line = (net, x, y, layer = 'top-copper') => new Track({ net, layer, width: 0.25,
        points: [{ x, y }, { x: x + 4, y }, { x: x + 4, y: y + 3 }] });
    doc.tracks.push(line('A', 0, 0), line('A', 20, 0), line('B', 0, 10), line('B', 20, 10, 'bottom-copper'),
        line('C', 0, 20), line('', 10, 20), line('A', 40, 0),
        new Track({ net: 'A', layer: 'top-copper', width: 0.25, points: [{ x: 26, y: 30 }, { x: 30, y: 30 }] }));
    doc.vias.push(new Via({ x: 24, y: 3, diameter: 0.6, drill: 0.3, net: 'A' }),
        new Via({ x: 12, y: 13, diameter: 0.6, drill: 0.3, net: 'B' }),
        new Via({ x: 30, y: 30, diameter: 0.6, drill: 0.3, net: '' }));
    doc.pads.push(new Pad({ x: 8, y: 23, shape: 'round', size: 1.2, drill: 0.6, net: 'C' }),
        new Pad({ x: 30, y: 20, shape: 'round', size: 1.2, drill: 0.6, net: 'C' }));
    reconcileRatsnest(app);
    return app;
}

const key = line => `${line.net}:${[[line.x1, line.y1], [line.x2, line.y2]].map(point => point.map(v => v.toFixed(6)).join(',')).sort().join('|')}`;
const ratlines = app => storedDrcRatlines(app).map(key).sort();
const drawn = app => app.getLayerGroup('ratlines').children.map(el => key({ net: el.dataset.net,
    x1: Number(el.getAttribute('x1')), y1: Number(el.getAttribute('y1')),
    x2: Number(el.getAttribute('x2')), y2: Number(el.getAttribute('y2')) })).sort();
const elementsOf = (app, nets) => app.getLayerGroup('ratlines').children.filter(el => nets.has(el.dataset.net));

/**
 * Run one drag on two identical boards: the live board as the editor does it, the
 * reference board with a full rebuild after every move. They must agree throughout.
 */
function compare(name, { start, update, cancel, nets, steps }) {
    const live = board(), reference = board();
    assert.ok(storedDrcRatlines(live).length >= 3, `${name}: the board has ratlines to compare`);
    const others = new Set(['A', 'B', 'C'].filter(net => !nets.includes(net)));
    const untouched = elementsOf(live, others);
    assert.ok(untouched.length, `${name}: other nets have ratlines`);
    assert.ok(start(live) && start(reference), `${name}: the drag starts`);
    let changed = false;
    for (const point of steps) {
        const before = ratlines(live).join();
        update(live, point);
        update(reference, point);
        reconcileRatsnest(reference);
        assert.deepEqual(ratlines(live), ratlines(reference), `${name} at ${point.x},${point.y}: same ratlines as a full rebuild`);
        assert.deepEqual(drawn(live), ratlines(live), `${name}: the drawn ratlines are the stored ones`);
        changed ||= ratlines(live).join() !== before;
        const now = elementsOf(live, others);
        assert.ok(now.length === untouched.length && now.every((el, index) => el === untouched[index]),
            `${name}: other nets' ratline elements are left alone`);
    }
    assert.ok(changed || !nets.length, `${name}: the drag moved copper its ratlines follow`);
    cancel(live);
    cancel(reference);
    assert.deepEqual(ratlines(live), ratlines(reference), `${name}: cancelling restores the same ratlines`);
}

const path = (from, count, dx, dy) => Array.from({ length: count }, (_, i) => ({ x: from.x + dx * (i + 1), y: from.y + dy * (i + 1) }));
const track = (app, index) => app.pcbDocument.tracks[index];
compare('track node drag', {
    start: app => startVertexDrag(app, track(app, 0), { x: 4, y: 3 }, { nodeId: [...track(app, 0).nodes.keys()][2] }),
    update: updateVertexDrag, cancel: cancelVertexDrag, nets: ['A'], steps: path({ x: 4, y: 3 }, 6, 2.5, 1.5),
});
compare('track segment drag', {
    start: app => startVertexDrag(app, track(app, 2), { x: 1, y: 10 },
        { edgeId: [...track(app, 2).edges.keys()][0], allowMidpointInsert: false }),
    update: updateVertexDrag, cancel: cancelVertexDrag, nets: ['B'], steps: path({ x: 1, y: 10 }, 6, 1.5, 2),
});
compare('whole track drag', {
    start: app => startVertexDrag(app, track(app, 4), { x: 2, y: 20 }, { whole: true }),
    update: updateVertexDrag, cancel: cancelVertexDrag, nets: ['C'], steps: path({ x: 2, y: 20 }, 6, 3, -1),
});
compare('unnamed track drag', {
    start: app => startVertexDrag(app, track(app, 5), { x: 12, y: 20 }, { whole: true }),
    update: updateVertexDrag, cancel: cancelVertexDrag, nets: [], steps: path({ x: 12, y: 20 }, 4, 2, 2),
});
compare('via drag with an attached track', {
    start: app => startViaDrag(app, app.pcbDocument.vias[0], { x: 24, y: 3 }),
    update: updateViaDrag, cancel: cancelViaDrag, nets: ['A'], steps: path({ x: 24, y: 3 }, 6, -2, 2),
});
compare('unnamed via drag carrying a named track', {
    start: app => startViaDrag(app, app.pcbDocument.vias[2], { x: 30, y: 30 }),
    update: updateViaDrag, cancel: cancelViaDrag, nets: ['A'], steps: path({ x: 30, y: 30 }, 6, 2, -2),
});
compare('standalone pad drag', {
    start: app => startPadDrag(app, app.pcbDocument.pads[1], { x: 30, y: 20 }),
    update: updateViaDrag, cancel: cancelViaDrag, nets: ['C'], steps: path({ x: 30, y: 20 }, 6, -3, 1),
});
console.log('PASS live track, via and pad drags redo only their nets, matching a full ratsnest rebuild');
