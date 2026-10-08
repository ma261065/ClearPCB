import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { Track } from '../../src/shapes/track.js';
import { PCB_LAYERS } from '../../src/pcb/modules/layers.js';
import { armBoxSelect, maybeStartBoxSelect, finishBoxSelect, refreshBoxSelectionHighlights } from '../../src/pcb/modules/box-select.js';
import { getPcbSelection, setPcbSelection } from '../../src/pcb/modules/selection-registry.js';
import { showPcbSelectionProperties } from '../../src/pcb/modules/selection-interaction.js';
import { createTrackSelectionAdapter, selectTrackSegment } from '../../src/pcb/modules/track-select.js';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

class Element {
    attributes = new Map();
    children = [];
    parentNode = null;
    dataset = {};
    style = {};
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    addEventListener() {}
    querySelectorAll(selector) {
        return this.children.flatMap(child => [
            ...(child.getAttribute('class')?.split(' ').includes(selector.slice(1)) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const document = installFakeDom();
document.createElementNS = () => new Element();
document.getElementById = () => null;
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const frames = new Map();
let nextFrame = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const top = PCB_LAYERS.find(layer => layer.id === 'top-copper');
const bottom = PCB_LAYERS.find(layer => layer.id === 'bottom-copper');
const original = [top, bottom].map(layer => ({ visible: layer.visible, locked: layer.locked }));
const makeTrack = (id, y, layer) => new Track({ id, layer,
    points: [{ x: 1, y }, { x: 9, y }], net: 'GND' });
function fixture(tracks) {
    const layers = new Map(['top-copper', 'bottom-copper', 'selection-overlay']
        .map(layer => [layer, new Element()]));
    return {
        ...pcbEditorStubs(),
        tracks, vias: [], pads: [], boardShapes: [], texts: new Map(), placements: new Map(),
        _layerGroups: layers, existingLayerGroups: () => layers, getLayerGroup: id => layers.get(id),
        viewport: { scale: 10, contentLayer: new Element() },
        showMultiSelectionProperties() { refreshBoxSelectionHighlights(this); },
        syncClipboardButtons() {},
    };
}
function drag(app, end = { x: 12, y: 12 }) {
    armBoxSelect(app, { x: 0, y: 0 }, { x: 0, y: 0 });
    assert.equal(maybeStartBoxSelect(app, { clientX: 100, clientY: 100 }, end), true);
}
function release(app) {
    if (finishBoxSelect(app)) showPcbSelectionProperties(app);
    refreshBoxSelectionHighlights(app);
}
const halos = app => app.getLayerGroup('selection-overlay').children
    .filter(element => ['pcb-track-selection', 'pcb-box-track-sel'].includes(element.getAttribute('class')));
try {
    top.locked = bottom.locked = false;
    for (const count of [1, 2]) {
        for (const hidden of [top, bottom]) {
            top.visible = bottom.visible = true;
            hidden.visible = false;
            const app = fixture(Array.from({ length: count }, (_, index) => makeTrack(`t${index}`, index + 1, hidden.id)));
            drag(app);
            assert.deepEqual(getPcbSelection(app, 'track'), [], 'Hidden copper never enters the live marquee selection');
            assert.equal(halos(app).length, 0, 'Hidden secondary tracks do not appear during the drag');
            release(app);
            assert.equal(halos(app).length, 0, 'Hidden primary tracks do not appear on release');
            PCBApp.prototype.selectAll.call(app);
            assert.deepEqual(getPcbSelection(app, 'track'), [], 'Select All also excludes hidden copper');
        }
    }
    top.visible = bottom.visible = true;
    const visible = fixture([makeTrack('first', 1, 'top-copper'), makeTrack('second', 2, 'top-copper')]);
    drag(visible);
    assert.equal(getPcbSelection(visible, 'track').length, 2);
    assert.equal(halos(visible).length, 1, 'Secondary selection remains visible during marquee');
    release(visible);
    assert.equal(halos(visible).length, 2, 'Both visible tracks remain highlighted after release');
    top.visible = false;
    refreshBoxSelectionHighlights(visible);
    assert.equal(halos(visible).length, 0, 'Overlay refresh cannot expose an already-selected hidden track');

    top.visible = true;
    const queued = fixture([makeTrack('queued', 8, 'top-copper')]);
    drag(queued, { x: 2, y: 2 });
    maybeStartBoxSelect(queued, { clientX: 120, clientY: 120 }, { x: 12, y: 12 });
    assert.equal(frames.size, 1);
    top.visible = false;
    release(queued);
    assert.equal(frames.size, 0);
    assert.deepEqual(getPcbSelection(queued, 'track'), [], 'Release-time flush rechecks current visibility');
    assert.equal(halos(queued).length, 0);

    for (const hidden of [top, bottom]) {
        top.visible = bottom.visible = true;
        hidden.visible = false;
        const mixed = new Track({ id: 'mixed', layer: hidden.id,
            points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 9, y: 9 }],
            edgeLayers: { e0: 'top-copper', e1: 'bottom-copper' } });
        const app = fixture([mixed]);
        drag(app);
        assert.deepEqual(getPcbSelection(app, 'track'), [mixed], 'A visible edge keeps a mixed-layer track selectable');
        release(app);
        assert.equal(halos(app).length, 1, 'Only the visible copper run receives an overlay');
        const hiddenEdge = hidden === top ? 'e0' : 'e1';
        const adapter = createTrackSelectionAdapter(app, mixed, mixed.id);
        const anchors = adapter.getAnchors();
        assert.ok(!anchors.some(anchor => anchor.id === `mid:${hiddenEdge}`));
        assert.ok(!anchors.some(anchor => anchor.id === (hidden === top ? 'n0' : 'n2')),
            'Hidden-only nodes do not expose handles on the selection overlay');
        assert.equal(adapter.hitTest(hidden === top ? { x: 2, y: 1 } : { x: 8, y: 7 }, 0.01), false,
            'Hidden runs cannot be hit through the visible side of a mixed-layer track');
        PCBApp.prototype.selectAll.call(app);
        assert.deepEqual(getPcbSelection(app, 'track'), [mixed], 'Select All uses the same per-edge visibility rules');
        selectTrackSegment(app, mixed, hiddenEdge);
        assert.equal(halos(app).length, 0, 'A stale segment selection cannot highlight hidden copper');
        setPcbSelection(app, [{ kind: 'track', object: mixed }]);
        top.visible = bottom.visible = false;
        refreshBoxSelectionHighlights(app);
        assert.equal(halos(app).length, 0);
    }
    top.visible = false;
    bottom.visible = true;
    bottom.locked = true;
    const protectedMixed = fixture([new Track({ layer: 'top-copper',
        points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 9, y: 9 }],
        edgeLayers: { e0: 'top-copper', e1: 'bottom-copper' } })]);
    drag(protectedMixed);
    assert.deepEqual(getPcbSelection(protectedMixed, 'track'), [],
        'A hidden unlocked edge cannot make a locked visible edge marquee-selectable');
    release(protectedMixed);
} finally {
    [top, bottom].forEach((layer, index) => Object.assign(layer, original[index]));
}
console.log('PASS hidden copper stays hidden during marquee, release, queued updates and mixed-layer highlights');
