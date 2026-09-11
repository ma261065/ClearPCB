import assert from 'node:assert/strict';

let allocations = 0;
function element(tag) {
    return {
        tag, attributes: new Map(), children: [], parentNode: null,
        setAttribute(name, value) { this.attributes.set(name, value); },
        getAttribute(name) { return this.attributes.get(name); },
        removeAttribute(name) { this.attributes.delete(name); },
        appendChild(child) {
            child.remove();
            this.children.push(child);
            child.parentNode = this;
            return child;
        },
        remove() {
            if (this.parentNode) {
                const siblings = this.parentNode.children;
                siblings.splice(siblings.indexOf(this), 1);
                this.parentNode = null;
            }
        },
    };
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS(namespace, tag) { allocations++; return element(tag); } };
const { refreshTrackDrawPreview, toggleTrackLayer, popTrackWaypoint, cancelTrackDraw, finishTrackDraw }
    = await import('../src/pcb/modules/track-draw.js');
const layers = new Map(['top-copper', 'bottom-copper', 'hole'].map((name) => [name, element('g')]));
const context = () => ({ points: [{ x: 0, y: 0 }], edgeLayers: [], currentLayer: 'top-copper',
    width: 0.2, net: '', previewElements: [], snap: { x: 3, y: 1 } });
const app = { _trackDraw: context(), _getLayerGroup: (name) => layers.get(name),
    viewport: { scale: 100, hideCrosshair() {} }, _getRoutingParams: () => ({ viaDiameter: 0.8, viaDrill: 0.4 }),
    _commitTracks() {} };
refreshTrackDrawPreview(app);
const ctx = app._trackDraw;
const first = ctx.previewCache.get('run:0');
const before = allocations;
for (let frame = 0; frame < 100; frame++) {
    ctx.snap = { x: 3 + frame / 100, y: 1 };
    refreshTrackDrawPreview(app);
    assert.equal(ctx.previewCache.get('run:0'), first);
}
assert.equal(allocations, before, 'Unaligned cursor motion must not allocate new preview nodes');
assert.equal(first.getAttribute('points'), '0,0 3.99,1');
ctx.width = 0.7;
refreshTrackDrawPreview(app);
assert.equal(first.getAttribute('stroke-width'), '0.7');
toggleTrackLayer(app);
assert.equal(first.parentNode, layers.get('bottom-copper'));
assert.equal(layers.get('top-copper').children.length, 0);
toggleTrackLayer(app);
ctx.points.push({ x: 3, y: 1 });
ctx.edgeLayers.push('top-copper');
ctx.snap = { x: 6, y: 2 };
toggleTrackLayer(app);
const second = ctx.previewCache.get('run:1');
const ring = ctx.previewCache.get('via:1:ring');
const drill = ctx.previewCache.get('via:1:drill');
assert.equal(ring.getAttribute('r'), '0.4');
assert.equal(drill.getAttribute('r'), '0.2');
const viaAllocations = allocations;
refreshTrackDrawPreview(app);
assert.equal(allocations, viaAllocations);
assert.equal(ctx.previewCache.get('run:1'), second);
assert.deepEqual(layers.get('hole').children, [ring, drill]);
popTrackWaypoint(app);
assert.equal(ctx.previewCache.size, 1);
assert.equal(second.parentNode, null);
assert.equal(ring.parentNode, null);
assert.equal(drill.parentNode, null);
assert.equal(first.parentNode, layers.get('bottom-copper'));

ctx.snap = { x: 6, y: 0 };
refreshTrackDrawPreview(app);
const halo = ctx.previewCache.get('axis:halo');
const centerline = ctx.previewCache.get('axis:centerline');
assert.ok(halo && centerline);
assert.deepEqual(layers.get('bottom-copper').children, [halo, first, centerline]);
const alignedAllocations = allocations;
for (let frame = 0; frame < 100; frame++) {
    ctx.snap = frame % 3 === 0 ? { x: 6, y: 6 } : frame % 3 === 1 ? { x: 0, y: 6 } : { x: 6, y: 0 };
    refreshTrackDrawPreview(app);
    assert.equal(ctx.previewCache.get('axis:halo'), halo);
    assert.equal(ctx.previewCache.get('axis:centerline'), centerline);
    assert.equal(centerline.getAttribute('stroke-dasharray'), frame % 3 === 0 ? '0.08 0.06' : undefined);
    assert.equal(halo.getAttribute('x2'), String(ctx.snap.x));
    assert.equal(halo.getAttribute('y2'), String(ctx.snap.y));
    assert.deepEqual(layers.get('bottom-copper').children, [halo, first, centerline]);
}
assert.equal(allocations, alignedAllocations, 'Aligned cursor motion must reuse both glow lines');
app.viewport.scale = 50;
refreshTrackDrawPreview(app);
assert.equal(layers.get('bottom-copper').children.length, 3);
assert.equal(ctx.previewCache.get('run:0'), first);
assert.equal(centerline.getAttribute('stroke-width'), '0.03');
assert.equal(centerline.getAttribute('stroke-dasharray'), '0.16 0.12');
toggleTrackLayer(app);
assert.deepEqual(layers.get('top-copper').children, [halo, first, centerline]);
assert.equal(layers.get('bottom-copper').children.length, 0);
ctx.snap = { x: 6, y: 2 };
refreshTrackDrawPreview(app);
assert.equal(halo.parentNode, null);
assert.equal(centerline.parentNode, null);
assert.equal(ctx.previewCache.size, 1);
ctx.snap = { x: 6, y: 0 };
refreshTrackDrawPreview(app);
cancelTrackDraw(app);
assert.equal(app._trackDraw, null);
assert.equal(ctx.previewCache.size, 0);
for (const layer of layers.values()) assert.equal(layer.children.length, 0);

app._trackDraw = context();
refreshTrackDrawPreview(app);
app._trackDraw.points.push({ x: 3, y: 1 });
app._trackDraw.edgeLayers.push('top-copper');
finishTrackDraw(app);
assert.equal(app._trackDraw, null);
for (const layer of layers.values()) assert.equal(layer.children.length, 0);
console.log('PASS: preview node reuse, layer/via changes, backspace, glow order, zoom, cancel, and finish');