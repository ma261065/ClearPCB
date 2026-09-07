import assert from 'node:assert/strict';

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
    removeChild(child) { child.remove(); return child; }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
    }
    querySelectorAll(selector) {
        return this.children.flatMap((child) => [
            ...(child.getAttribute('class')?.split(' ').includes(selector.slice(1)) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
    }
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS() { return new Element(); }, getElementById() { return null; } };

const { Track } = await import('./src/shapes/track.js');
const { setPcbSelection } = await import('./src/pcb/modules/selection-registry.js');
const { beginGroupDrag, updateGroupDrag, endGroupDrag, refreshBoxSelectionHighlights } = await import('./src/pcb/modules/box-select.js');
const { refreshTrackSelectionHalo } = await import('./src/pcb/modules/track-select.js');
const { buildTrackLayerRuns } = await import('./src/pcb/modules/track-render.js');

for (const count of [1, 2]) {
    const tracks = Array.from({ length: count }, (_, index) => new Track({
        points: [{ x: 0, y: index * 2 }, { x: 10, y: index * 2 }],
    }));
    const rectangle = { id: 'rect', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 20, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 5 }, { x: 20, y: 5 }] };
    const layers = new Map(['top-copper', 'bottom-copper', 'top-silk', 'hole'].map((name) => [name, new Element()]));
    const app = {
        tracks, vias: [], boardShapes: [rectangle], placements: new Map(), texts: new Map(),
        _shapeElements: new Map(), _layerGroups: layers,
        _getLayerGroup(name) { return layers.get(name) || null; },
        viewport: { scale: 10 },
        history: { execute(command) { command.execute(); } },
        _updateRatsnest() { if (!this._deferDragOverlays) refreshTrackSelectionHalo(this); },
    };
    setPcbSelection(app, [...tracks.map((object) => ({ kind: 'track', object })), { kind: 'shape', object: rectangle }]);
    refreshBoxSelectionHighlights(app);
    const checkHighlights = () => {
        const primary = layers.get('top-copper').querySelectorAll('.pcb-track-selection');
        const secondary = layers.get('top-copper').querySelectorAll('.pcb-box-track-sel');
        const expected = tracks.flatMap((track) => buildTrackLayerRuns(track)
            .map((run) => run.points.map((point) => `${point.x},${point.y}`).join(' ')));
        assert.deepEqual([...primary, ...secondary].map((element) => element.getAttribute('points')), expected);
    };
    beginGroupDrag(app, { x: 20, y: 0 });
    updateGroupDrag(app, { x: 23, y: 4 });
    checkHighlights();
    endGroupDrag(app);
    checkHighlights();
    beginGroupDrag(app, { x: 23, y: 4 });
    for (const position of [{ x: 25, y: 5 }, { x: 28, y: 7 }]) {
        updateGroupDrag(app, position);
        checkHighlights();
    }
    assert.deepEqual(rectangle.points[0], { x: 28, y: 7 });
    endGroupDrag(app);
    checkHighlights();
}
console.log('PASS: primary and secondary track highlights follow consecutive rectangle-led group drags before drop');