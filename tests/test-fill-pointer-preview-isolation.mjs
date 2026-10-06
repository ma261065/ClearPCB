import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { beginFillEdit, updateFillEdit, endFillEdit } from '../src/pcb/modules/copper-fill-edit.js';
import { createCopperFillSelectionAdapter } from '../src/pcb/modules/copper-fill-selection.js';
import { renderCopperFill } from '../src/pcb/modules/copper-fill-render.js';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { setPcbSelection, syncPcbSelection, getPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { beginPcbAnchorInteraction, finishSelectionInteraction, updateSelectionInteraction,
    placeFloatingSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { refreshBoxSelectionHighlights } from '../src/pcb/modules/box-select.js';
import { areDragOverlaysDeferred, setDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';
import { getSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { getBoardShapeDrag } from '../src/pcb/modules/board-shapes.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

let allocations = 0;
class Element {
    constructor() { allocations++; this.attributes = new Map(); this.children = []; this.style = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    insertBefore(child, before) {
        child.remove();
        const index = this.children.indexOf(before);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        child.parentNode = this;
    }
    get firstChild() { return this.children[0] || null; }
    cloneNode() { return new Element(); }
    remove() {
        if (!this.parentNode) return;
        this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
    matches(selector) {
        if (selector.startsWith('.')) return (this.getAttribute('class') || '').split(' ').includes(selector.slice(1));
        const attribute = /^\[([^=]+)="([^"]+)"\]$/.exec(selector);
        return !!attribute && this.getAttribute(attribute[1]) === attribute[2];
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
            .filter(child => selector === '*' || child.matches(selector));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => new Element(), getElementById() { return null; } };
const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(mode, deferred) {
    const model = new PcbDocument();
    const fill = new CopperFill({
        outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        kind: ['center', 'radius'].includes(mode) ? 'circle' : mode === 'bulge' ? 'polygon' : 'rect',
        x: 5, y: 5, radius: 3,
        segmentBulges: mode === 'bulge' ? { 0: 0.15 } : {},
    });
    model.boardShapes.push(fill);
    const layer = new Element();
    const poured = [{ outer: fill.getOutline(), holes: [] }];
    setComputedFill(fill, poured);
    const app = {
        pcbDocument: model, boardShapes: model.boardShapes, tracks: [], vias: [], pads: [], texts: model.texts,
        placements: new Map(), history: new CommandHistory(),
        viewport: { scale: 100, shiftHeld: true, svg: { style: {} }, setCrosshair() {}, hideCrosshair() {} },
        getLayerGroup: id => id === 'top-fill' ? layer : null,
        get copperFills() { return model.copperFills; },
        existingLayerGroups() { return this._layerGroups; },
        _layerGroups: new Map([['top-fill', layer]]),
        _cancelPosePreviews: PCBApp.prototype._cancelPosePreviews,
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
        _shapeElements: new Map(),
    };
    setDragOverlaysDeferred(app, deferred);
    const adapter = createCopperFillSelectionAdapter(app, fill, `fill:${fill.id}`);
    setPcbSelection(app, [{ kind: 'fill', object: fill }]);
    renderCopperFill(fill, app.getLayerGroup);
    const anchor = { vertex: 0, midpoint: 'mid:0', bulge: 'bulge:0', center: 'center', radius: 'radius' }[mode] ?? null;
    const start = mode === 'bulge' ? adapter.getAnchors().find(item => item.id === anchor)
        : mode === 'radius' ? { x: 8, y: 5 }
        : mode === 'center' ? { x: 5, y: 5 }
            : mode === 'vertex' ? { x: 0, y: 0 } : { x: 5, y: 0 };
    const target = mode === 'radius' ? { x: 10, y: 5 }
        : mode === 'center' ? { x: 6, y: 6 }
            : mode === 'vertex' ? { x: -1, y: -1 } : { x: 5, y: -2 };
    return { app, model, fill, layer, poured, adapter, anchor, start, target };
}

let cases = 0;
for (const mode of ['move', 'segment', 'vertex', 'midpoint', 'bulge', 'center', 'radius']) {
    for (const deferred of [false, true]) for (const finish of ['commit', 'cancel', 'no-op', 'deactivate', 'load', 'failure', 'missing']) {
        if (mode === 'midpoint' && finish === 'no-op') continue;
        const f = fixture(mode, deferred), { app, model, fill, layer, poured, adapter, anchor, start, target } = f;
        const before = fill.captureState(), geometry = model.captureGeometry(), serialized = model.serialize();
        const outline = fill.outline, bulges = fill.segmentBulges, radii = fill.nodeCornerRadii;
        const redo = { execute() {}, undo() {} };
        app.history.redoStack.push(redo);
        beginFillEdit(app, fill, start, anchor, mode === 'segment' ? 0 : null);
        assert.deepEqual(fill.captureState(), before, 'Pickup, including midpoint insertion, is read-only');
        if (mode !== 'midpoint') assert.equal(adapter.object, fill, 'Ordinary pickup displays the canonical fill');
        updateFillEdit(app, target);
        refreshBoxSelectionHighlights(app);
        const copy = adapter.object;
        assert.notEqual(copy, fill);
        assert.equal(copy.id, fill.id);
        for (let step = 1; step <= 20; step++) {
            updateFillEdit(app, { x: target.x + step / 1000, y: target.y });
            assert.equal(adapter.object, copy, 'Changed pointer positions reuse the displayed fill object');
            assert.equal(layer.querySelectorAll('.pcb-fill-outline').length, 1);
        }
        const allocated = allocations;
        for (let i = 0; i < 100; i++) updateFillEdit(app, { x: target.x + 20 / 1000, y: target.y });
        assert.equal(allocations, allocated, 'Identical pointer positions do no SVG work');
        assert.equal(getComputedFill(fill), poured, 'Settled pour cache stays owned by the canonical fill');
        assert.equal(model.boardShapes[0], fill);
        assert.deepEqual(model.captureGeometry(), geometry);
        assert.deepEqual(model.serialize(), serialized);
        assert.equal(fill.outline, outline);
        assert.equal(fill.segmentBulges, bulges);
        assert.equal(fill.nodeCornerRadii, radii);
        assert.equal(getPcbSelection(app, 'fill')[0], copy);
        assert.deepEqual(adapter.getBounds(), copy.getBounds());
        syncPcbSelection(app);
        assert.equal(getPcbSelection(app, 'fill')[0], copy);
        const rebuilt = createCopperFillSelectionAdapter(app, copy, adapter.id);
        assert.equal(rebuilt.object, copy);
        setPcbInteraction(app, '_pcbSelectionInteraction', anchor == null
            ? { mode: 'move-adapter', entry: adapter, moved: true }
            : { mode: 'anchor', adapter, anchorId: anchor, moved: true });
        if (finish === 'commit') {
            finishSelectionInteraction(app, true);
            assert.equal(app.history.undoStack.length, 1);
            const after = fill.captureState();
            assert.notDeepEqual(after, before);
            app.history.undo();
            assert.deepEqual(fill.captureState(), before);
            app.history.redo();
            assert.deepEqual(fill.captureState(), after);
        } else {
            if (finish === 'no-op') {
                updateFillEdit(app, start);
                finishSelectionInteraction(app, true);
            } else if (finish === 'deactivate') {
                PCBApp.prototype.deactivate.call(app);
            } else if (finish === 'load') {
                loadPcb(app, null);
            } else if (finish === 'failure') {
                app.history.execute = () => { throw new Error('Fill command rejected'); };
                assert.throws(() => finishSelectionInteraction(app, true), /Fill command rejected/);
            } else if (finish === 'missing') {
                model.boardShapes.length = 0;
                assert.throws(() => finishSelectionInteraction(app, true), /missing copper fill/);
            } else {
                Object.freeze(fill);
                for (const point of fill.outline) Object.freeze(point);
                finishSelectionInteraction(app, false);
            }
            assert.equal(app.history.canUndo(), false, `${mode}/${finish}/${deferred}: no authored history`);
            assert.deepEqual(fill.captureState(), before);
            if (finish !== 'load') {
                assert.equal(getComputedFill(fill), poured);
                assert.equal(app.history.redoStack[0], redo);
                assert.equal(getComputedFill(fill), poured, 'Discarding a preview keeps the settled pour cache');
            }
        }
        assert.equal(getBoardShapeDrag(app), null);
        assert.equal(getSelectionInteraction(app), null);
        assert.equal(frames.size, 0);
        assert.equal(areDragOverlaysDeferred(app), deferred);
        assert.equal(rebuilt.object, fill);
        assert.equal(layer.querySelectorAll('.pcb-fill-outline').length, ['missing', 'load'].includes(finish) ? 0 : 1);
        cases++;
    }
}
for (const reason of ['invalid', 'locked']) {
    const { app, fill, start, target } = fixture('move', false);
    const before = fill.captureState();
    beginFillEdit(app, fill, start);
    updateFillEdit(app, target);
    if (reason === 'invalid') getBoardShapeDrag(app).shape.outline = [];
    else fill.locked = true;
    endFillEdit(app, true);
    assert.deepEqual(fill.captureState(), { ...before, locked: reason === 'locked' });
    assert.equal(app.history.canUndo(), false);
    assert.equal(getBoardShapeDrag(app), null);
    cases++;
}
for (const action of ['place', 'cancel', 'drag']) {
    const { app, fill, adapter, start, target } = fixture('midpoint', false);
    const before = fill.captureState();
    assert.equal(beginPcbAnchorInteraction(app, adapter, { id: 'mid:0', ...start }, start), true);
    if (action !== 'drag') {
        finishSelectionInteraction(app, true);
        assert.equal(getSelectionInteraction(app).mode, 'floating-anchor');
    }
    assert.deepEqual(fill.captureState(), before, 'Midpoint pickup remains a preview');
    assert.equal(app.history.undoStack.length, 0);
    updateSelectionInteraction(app, target);
    assert.deepEqual(fill.captureState(), before, 'Movement does not author the preview until placed');
    if (action === 'cancel') {
        finishSelectionInteraction(app, false);
        assert.deepEqual(fill.captureState(), before);
        assert.equal(app.history.undoStack.length, 0);
        assert.equal(getBoardShapeDrag(app), null);
        assert.equal(getSelectionInteraction(app), null);
        cases++;
        continue;
    }
    if (action === 'place') placeFloatingSelectionInteraction(app);
    else finishSelectionInteraction(app, true);
    assert.equal(fill.outline.length, 5);
    assert.equal(app.history.undoStack.length, 1);
    assert.equal(getBoardShapeDrag(app), null);
    assert.equal(getSelectionInteraction(app), null);
    app.history.undo();
    assert.deepEqual(fill.captureState(), before);
    cases++;
}
console.log(`PASS ${cases} fill pointer cases: canonical/cache isolation, reusable copies, SVG cleanup, topology, history and lifecycle`);
