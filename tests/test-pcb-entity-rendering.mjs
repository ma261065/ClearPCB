import assert from 'node:assert/strict';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { Pad } from '../src/shapes/pad.js';
import { renderTrack, renderVia, removeTrackElements, removeViaElements } from '../src/pcb/modules/track-render.js';
import { renderPad, removePadElements } from '../src/pcb/modules/pad.js';
import { selectTrackOrVia, clearTrackSelection } from '../src/pcb/modules/track-select.js';

class Element {
    attributes = new Map();
    children = [];
    parentNode = null;
    dataset = {};
    style = {};
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
}
globalThis.document = { createElementNS: () => new Element(), getElementById: () => null };
const groups = () => new Map(['top-copper', 'bottom-copper', 'top-copper-track-labels',
    'bottom-copper-track-labels', 'top-copper-pad-drills', 'bottom-copper-pad-drills', 'vias']
    .map(layer => [layer, new Element()]));
const children = layers => [...layers.values()].flatMap(group => group.children);
const makeTrack = () => new Track({ id: 'same-id', net: 'GND',
    points: [{ x: 1.123456, y: 2 }, { x: 12, y: 2 }, { x: 12, y: 14 }],
    edgeLayers: { e1: 'bottom-copper' }, width: 0.234567 });

for (const [create, render, remove] of [
    [makeTrack, renderTrack, removeTrackElements],
    [() => new Via({ id: 'same-id', x: 3.123456, y: 4, net: 'GND' }), renderVia, removeViaElements],
    [() => new Pad({ id: 'same-id', x: 5, y: 6.123456, layers: 'both', drill: 0.4 }), renderPad, removePadElements],
]) {
    const entity = create();
    const saved = entity.toJSON();
    const state = entity.captureState();
    const keys = Reflect.ownKeys(entity);
    Object.freeze(entity);
    const layers = groups(), otherLayers = groups();
    const getLayer = id => layers.get(id);
    remove(entity);
    render(entity, getLayer);
    const first = children(layers);
    assert.ok(first.length >= 2, 'Render includes copper and label/drill artwork');
    const expected = first.map(element => [...element.attributes]);
    render(entity, getLayer);
    assert.deepEqual(children(layers).map(element => [...element.attributes]), expected);
    assert.ok(first.every(element => element.parentNode === null), 'Redraw removes all prior artwork');

    const duplicate = Object.freeze(create());
    render(duplicate, id => otherLayers.get(id));
    const duplicateElements = children(otherLayers);
    remove(entity);
    remove(entity);
    assert.equal(children(layers).length, 0, 'Repeated cleanup is safe on a frozen entity');
    assert.deepEqual(children(otherLayers), duplicateElements, 'Equal IDs do not share render ownership');
    render(entity, getLayer);
    render(entity, () => null);
    assert.equal(children(layers).length, 0, 'Missing target layers still remove the old artwork');
    render(entity, getLayer);
    assert.deepEqual(children(layers).map(element => [...element.attributes]), expected);
    remove(entity);
    remove(duplicate);
    assert.equal(children(otherLayers).length, 0);
    assert.deepEqual(Reflect.ownKeys(entity), keys, 'Rendering and removal never add entity fields');
    assert.equal('_svgElements' in entity, false);
    assert.deepEqual(entity.captureState(), state);
    assert.deepEqual(entity.toJSON(), saved, 'Rendering preserves serialized data and precision');
}

{
    const layers = groups();
    const getLayer = id => layers.get(id);
    const track = makeTrack();
    renderTrack(track, getLayer);
    track.edges.clear();
    renderTrack(track, getLayer);
    assert.equal(children(layers).length, 0, 'An emptied track removes its previous copper and labels');
    const pad = new Pad({ layers: 'both', drill: 0.4 });
    renderPad(pad, getLayer);
    pad.visible = false;
    renderPad(pad, getLayer);
    assert.equal(children(layers).length, 0, 'Hiding a pad removes both copper and drill artwork');
    pad.visible = true;
    renderPad(pad, getLayer);
    pad.layers = 'top-copper';
    renderPad(pad, getLayer);
    assert.equal(layers.get('bottom-copper').children.length, 0);
    assert.equal(layers.get('bottom-copper-pad-drills').children.length, 0);
    removePadElements(pad);
}

{
    const track = makeTrack();
    const layers = groups();
    const app = { tracks: [track], vias: [], pads: [], boardShapes: [], texts: new Map(),
        placements: new Map(), _getLayerGroup: id => layers.get(id) };
    const labels = () => children(layers).filter(element => element.getAttribute('class') === 'pcb-track-label');
    renderTrack(track, app._getLayerGroup);
    assert.ok(labels().length > 0);
    selectTrackOrVia(app, { type: 'track', track });
    const original = labels();
    assert.ok(original.length > 0);
    assert.ok(labels().every(element => element.style.display === 'none'));
    clearTrackSelection(app);
    assert.deepEqual(labels(), original, 'Deselection restores existing labels without rebuilding artwork');
    assert.ok(labels().every(element => element.style.display === ''));
    selectTrackOrVia(app, { type: 'track', track });
    renderTrack(track, app._getLayerGroup, { hideNetLabel: true });
    assert.equal(labels().length, 0);
    clearTrackSelection(app);
    assert.equal(labels().length, original.length, 'Deselection rebuilds labels omitted during a selected redraw');
    assert.ok(original.every(element => element.parentNode === null));
    assert.equal('_svgElements' in track, false);
    removeTrackElements(track);
    assert.equal(children(layers).length, 0);
}
console.log('PASS renderer-owned PCB SVG, frozen entities, identity isolation, cleanup and selection labels');
