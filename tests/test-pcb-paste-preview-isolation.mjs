import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { Pad } from '../src/shapes/pad.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { setComputedFill, getComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { beginPcbPaste, cancelPcbPaste, endPcbPaste, preparePcbPaste, updatePcbPaste } from '../src/pcb/modules/pcb-paste.js';
import { renderTrack, renderVia } from '../src/pcb/modules/track-render.js';
import { renderPad } from '../src/pcb/modules/pad.js';
import { getBoardShapeElement, hasBoardShapeElement, renderBoardShape } from '../src/pcb/modules/board-shapes.js';
import { renderCopperFill } from '../src/pcb/modules/copper-fill-render.js';
import { getPcbSelectionEntries, setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { PCB_LAYERS, notifyLayerVisibilityChanged, notifyLayerLockChanged } from '../src/pcb/modules/layers.js';
import { areDragOverlaysDeferred, isBoardViewRefreshSuspended, isFillRefreshSuspended, setBoardViewPanel, setBoardViewRefreshSuspended, setDragOverlaysDeferred, setFillRefreshPending, setFillRefreshSuspended } from '../src/pcb/modules/refresh-state.js';
import { getPcbPaste } from '../src/pcb/modules/pcb-paste.js';
import { getTextElement, renderText } from '../src/pcb/modules/pcb-text-render.js';
import { clearanceOverlayState } from '../src/pcb/modules/clearance-overlay.js';

let allocations = 0;
class Element {
    constructor(tag = 'g') { allocations++; this.tag = tag; this.localName = tag; this.children = []; this.attributes = new Map(); this.dataset = {}; this.style = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    get classList() { return { contains: name => (this.getAttribute('class') || '').split(' ').includes(name), add() {} }; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    insertBefore(child, sibling) {
        if (!sibling) return this.appendChild(child);
        child.remove(); this.children.splice(this.children.indexOf(sibling), 0, child); child.parentNode = this;
    }
    removeChild(child) { child.remove(); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    querySelectorAll(selector) {
        const attribute = /^\[([^=]+)="([^"]+)"\]$/.exec(selector);
        const matches = child => selector.startsWith('.') ? child.classList.contains(selector.slice(1))
            : selector.startsWith('#') ? child.getAttribute('id') === selector.slice(1)
                : !!attribute && child.getAttribute(attribute[1]) === attribute[2];
        return this.children.flatMap(child => [
            ...(matches(child) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    get firstChild() { return this.children[0] || null; }
    addEventListener() {}
}
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { createElementNS: (_, tag) => new Element(tag), getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], documentElement: new Element() };
globalThis.localStorage = { setItem() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { copperCutState } = await import('../src/pcb/modules/copper-cuts.js');

function fixture(deferred = false) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    project.schematicDocument.components.push(new Component({
        name: 'PasteSource', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
        footprintShapes: ['PAD~RECT~2~1~1~1~1~both~1~0~0.5'],
    }, { id: 'original-component' }));
    model.placementState.record('original-component', { x: Math.PI, y: -Math.E, rotation: 0 });
    const placements = project.resolvePcbLayout().placements;
    const origin = placements.get('original-component').pads.get('1');
    const track = new Track({ points: [origin, { x: 10, y: 6 }],
        padConnections: { n0: { componentId: 'original-component', pinNumber: '1' } }, net: 'GND' });
    const via = new Via({ x: Math.PI, y: -Math.E, net: 'GND' });
    const pad = new Pad({ x: 20, y: 20, rotation: 37.123456789, net: 'VCC' });
    const rect = { id: 'source-rect', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: Math.PI, y: 30 }, { x: 8, y: 30 }, { x: 8, y: 36 }, { x: Math.PI, y: 36 }],
        segmentWidths: { 0: 0.234567891 }, nodeCornerRadii: { 2: 0.7 } };
    const circle = { id: 'source-circle', kind: 'circle', layer: 'top-silk', x: 40, y: 40, radius: 3 };
    const arc = { id: 'source-arc', kind: 'arc', layer: 'top-silk', lineWidth: 0.2,
        start: { x: 50, y: 40 }, end: { x: 55, y: 40 }, bulge: { x: 53, y: 43 } };
    const image = { ...structuredClone(rect), id: 'source-image', kind: 'image', filled: true,
        artwork: { width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 4, height: 2 }] } };
    const text = { id: 'source-text', x: 60.123456789, y: 30, content: 'Paste', size: 1, rotation: 12.123456789,
        strokeWidth: 0.12, layer: 'top-silk' };
    const fill = new CopperFill({ outline: [{ x: 70, y: 30 }, { x: 75, y: 30 }, { x: 75, y: 35 }], net: 'GND' });
    const circleFill = new CopperFill({ kind: 'circle', x: 80, y: 40, radius: 4.123456789, net: 'GND' });
    model.tracks.push(track); model.vias.push(via); model.pads.push(pad);
    model.boardShapes.push(rect, circle, arc, image, fill, circleFill); model.texts.set(text.id, text);
    setComputedFill(fill, [{ outer: fill.outline, holes: [] }]);
    const groups = new Map(['top-copper', 'bottom-copper', 'top-fill', 'bottom-fill', 'top-silk', 'hole',
        'selection-overlay', 'clearance-overlay'].map(id => [id, new Element()]));
    let derived = 0, crosshairs = 0;
    const app = { project, pcbDocument: model, history: new CommandHistory(), placements, netlist: [], _active: true,
        _layerGroups: groups, existingLayerGroups: () => groups, _shapeElements: new Map(),
        viewport: { scale: 10, gridVisible: false, svg: new Element('svg'), currentMouseWorld: { x: 10.123456789, y: -12.345678912 },
            setCrosshair() { crosshairs++; }, hideCrosshair() {} },
        getLayerGroup: id => groups.get(id) || null,
        refreshFills() { if (!areDragOverlaysDeferred(this) && !isFillRefreshSuspended(this)) derived++; },
        updateCopperCuts() { derived++; }, refreshClearanceHalos() { derived++; },
        getRoutingParams: () => ({ clearance: 0.25 }),
        syncClipboardButtons() {}, _clearCursorCrosshair() {},
        clearProperties() {}, propertiesItems: () => null, setPropertiesTitle() {}, setPcbStatus() {},
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {}, _refreshPcbSelectionHighlights() {},
        _showPcbMultiSelectionProperties() {}, showTextProperties() {},
    };
    setBoardViewPanel(app, { refresh() { derived++; } });
    setDragOverlaysDeferred(app, deferred);
    setFillRefreshSuspended(app, deferred);
    setBoardViewRefreshSuspended(app, deferred);
    clearanceOverlayState(app).clearancesVisible = true;
    for (const key of ['tracks', 'vias', 'pads', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const method of ['_hasPcbClipboardData', 'pasteSelection',
        '_cancelPosePreviews', 'snapToGrid', 'refreshText',
        'isSectionEditing']) app[method] = PCBApp.prototype[method];
    project.registerView('pcb', app);
    renderTrack(track, app.getLayerGroup); renderVia(via, app.getLayerGroup); renderPad(pad, app.getLayerGroup);
    [rect, circle, arc, image].forEach(shape => renderBoardShape(app, shape));
    renderCopperFill(fill, app.getLayerGroup); renderCopperFill(circleFill, app.getLayerGroup); renderText(app, text);
    const clipboard = { tracks: [track.toJSON()], vias: [via.toJSON()], pads: [pad.toJSON()],
        shapes: [rect, circle, arc, image].map(shape => structuredClone(shape)),
        texts: [{ ...text }], fills: [fill.captureState(), circleFill.captureState()] };
    app._pcbClipboard = clipboard;
    return { app, model, track, fill, clipboard, image, groups, work: () => [allocations, derived, crosshairs] };
}

let cases = 0;
for (const imageOnly of [false, true]) for (const deferred of [false, true]) for (const finish of [
    'commit', 'cancel', 'failure', 'render-failure', 'lock', 'hide', 'load', 'deactivate', 'document',
]) {
    const { app, model, track, fill, clipboard, image, work, groups } = fixture(deferred);
    const geometry = model.captureGeometry(), saved = model.serialize(), counter = model.shapeIdCounter;
    const shapeCount = model.boardShapes.length, derivedBefore = work()[1];
    const clearances = [...clearanceOverlayState(app).boardShapeClearanceCache];
    const bounds = track.getBounds(), graph = track.nodes, computed = getComputedFill(fill);
    const sourcePad = app.placements.get('original-component').pads.get('1'), sourcePadBefore = { ...sourcePad };
    const previous = { execute() {}, undo() {}, description: 'Prior edit' };
    app.history.execute(previous);
    const redo = { execute() {}, undo() {}, description: 'Existing redo' };
    app.history.execute(redo); app.history.undo();
    const oldUndo = [...app.history.undoStack], oldRedo = [...app.history.redoStack];
    const clipboardBefore = structuredClone(clipboard);
    if (imageOnly) beginPcbPaste(app, preparePcbPaste(app, { shapes: [image] }), { select: true });
    else assert.equal(app.pasteSelection(), true);
    const state = getPcbPaste(app), payload = state.payload, projection = state.preview;
    const stagedNodes = payload.tracks[0]?.nodes, stagedOutline = payload.fills[0]?.outline;
    assert.deepEqual(app.history.undoStack, oldUndo);
    assert.deepEqual(app.history.redoStack, oldRedo);
    assert.equal(model.shapeIdCounter, counter);
    for (let i = 0; i < 10; i++) updatePcbPaste(app, { x: 20.123456789 + i, y: -21.234567891 });
    const stagedBounds = payload.tracks[0]?.getBounds();
    const counts = work(), point = { x: 29.123456789, y: -21.234567891 };
    for (let i = 0; i < 100; i++) updatePcbPaste(app, point);
    assert.deepEqual(work(), counts, 'Repeated snapped pointer performs no rendering or derived work');
    assert.equal(getPcbPaste(app).preview, projection);
    assert.equal(payload.tracks[0]?.nodes, stagedNodes);
    assert.equal(payload.tracks[0]?.getBounds(), stagedBounds, 'Unchanged pointers do not invalidate staged graph caches');
    assert.equal(payload.fills[0]?.outline, stagedOutline);
    assert.equal(work()[1], derivedBefore, 'Floating artwork does not refresh settled clearances, copper cuts, pours or 3D');
    assert.deepEqual([...clearanceOverlayState(app).boardShapeClearanceCache.keys()], clearances.map(([key]) => key));
    for (const [key, value] of clearances) assert.equal(clearanceOverlayState(app).boardShapeClearanceCache.get(key), value,
        'Real clearance cache entries remain canonical and unchanged');
    assert.equal(app.tracks, projection.tracks); assert.equal(app.texts, projection.texts);
    assert.deepEqual(model.serialize(), saved);
    assert.deepEqual(model.captureGeometry(), geometry);
    assert.equal(track.nodes, graph); assert.equal(track.getBounds(), bounds);
    assert.equal(app.placements.get('original-component').pads.get('1'), sourcePad);
    assert.deepEqual(sourcePad, sourcePadBefore, 'Source component pads and their attached authored track never follow the paste');
    assert.equal(getComputedFill(fill), computed);
    assert.deepEqual(clipboard, clipboardBefore);
    if (!imageOnly) {
        assert.deepEqual(payload.tracks[0].padConnections, track.padConnections, 'Clipboard component references retain their existing semantics');
        assert.equal(payload.tracks[0].net, track.net);
        assert.notEqual(payload.tracks[0].nodes, track.nodes);
        assert.notEqual(payload.vias[0].id, model.vias[0].id);
        assert.notEqual(payload.pads[0].id, model.pads[0].id);
        assert.notEqual(payload.texts[0].id, 'source-text');
    }
    assert.equal(app.isSectionEditing(), true);
    assert.throws(() => app.project.serialize(), /current edit/i);
    await assert.rejects(prepareFabricationSnapshot(app), /current edit/i);
    const layer = PCB_LAYERS.find(item => item.id === 'top-silk');
    try {
        if (finish === 'commit') {
            const expected = structuredClone(payload.shapes);
            endPcbPaste(app);
            assert.equal(app.history.undoStack.length, oldUndo.length + 1);
            assert.equal(app.history.redoStack.length, 0);
            assert.deepEqual(model.boardShapes.slice(shapeCount, shapeCount + expected.length), expected);
            const after = model.captureGeometry();
            app.history.undo();
            assert.deepEqual(model.captureGeometry(), geometry);
            app.history.redo();
            assert.deepEqual(model.captureGeometry(), after);
            assert.equal(app.history.undoStack[0], previous);
        } else {
            if (finish === 'failure') {
                app.history.execute = () => { throw new Error('Rejected paste command'); };
                assert.throws(() => endPcbPaste(app), /Rejected paste command/);
            } else if (finish === 'render-failure') {
                const get = app.getLayerGroup;
                let fail = true;
                app.getLayerGroup = id => { if (fail) { fail = false; throw new Error('Paste render failed'); } return get(id); };
                assert.throws(() => endPcbPaste(app), /Paste render failed/);
            } else if (finish === 'document') {
                app.pcbDocument = new ProjectDocument().pcbDocument;
                assert.throws(() => endPcbPaste(app), /document is no longer available/);
            } else if (finish === 'load') loadPcb(app, null);
            else if (finish === 'deactivate') PCBApp.prototype.deactivate.call(app);
            else if (finish === 'lock') { layer.locked = true; notifyLayerLockChanged(app, layer.id, true); }
            else if (finish === 'hide') { layer.visible = false; notifyLayerVisibilityChanged(app, layer.id, false); }
            else {
                Object.freeze(model.board); Object.freeze(track.nodes);
                cancelPcbPaste(app);
            }
            if (finish !== 'load') {
                assert.deepEqual(model.captureGeometry(), geometry);
                assert.deepEqual(model.serialize(), saved);
                assert.deepEqual(app.history.undoStack, oldUndo);
                assert.deepEqual(app.history.redoStack, oldRedo, 'Cancel never destroys prior redo');
                assert.equal(model.shapeIdCounter, counter);
            }
        }
        assert.equal(getPcbPaste(app), null);
        assert.equal(areDragOverlaysDeferred(app), deferred);
        assert.equal(isFillRefreshSuspended(app), deferred);
        assert.equal(isBoardViewRefreshSuspended(app), deferred);
        if (finish !== 'commit' && finish !== 'load' && finish !== 'document') {
            for (const shape of payload.shapes) assert.equal(hasBoardShapeElement(app, shape.id), false);
            for (const text of payload.texts) assert.equal(getTextElement(app, text.id), null);
            for (const fill of payload.fills) for (const group of groups.values()) {
                assert.equal(group.querySelectorAll(`[data-fill-id="${fill.id}"]`).length, 0);
            }
        }
        cases++;
    } finally { layer.locked = false; layer.visible = true; }
}
console.log(`PASS ${cases} detached paste cases: mixed/image, exact history, no authored insertion, counters, cache/serialization isolation and lifecycle`);

for (const key of ['tracks', 'vias', 'pads', 'shapes', 'texts', 'fills']) {
    const { app, model, clipboard } = fixture(), before = model.captureGeometry();
    app._pcbClipboard = { [key]: clipboard[key] };
    app.pasteSelection();
    const first = getPcbPaste(app).payload;
    app.pasteSelection();
    assert.notEqual(getPcbPaste(app).payload, first);
    assert.deepEqual(model.captureGeometry(), before, 'Repeated paste replaces only the detached bundle');
    assert.equal(app.history.undoStack.length, 0);
    endPcbPaste(app);
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
}
for (const key of ['Escape', 'Delete', 'z', 'y']) {
    const { app, model } = fixture(), before = model.captureGeometry();
    app.pasteSelection();
    assert.equal(PCBApp.prototype.handleKeyDown.call(app, { key, ctrlKey: ['z', 'y'].includes(key) }), true);
    assert.equal(getPcbPaste(app), null);
    assert.deepEqual(model.captureGeometry(), before);
}
{
    const { app, model } = fixture(), before = model.captureGeometry();
    app.pasteSelection();
    assert.throws(() => updatePcbPaste(app, { x: NaN, y: 2 }), /finite pointer/);
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(getPcbPaste(app), null);
    app.pasteSelection();
    getPcbPaste(app).payload.tracks[0].nodes.delete('n0');
    assert.throws(() => endPcbPaste(app), /track node is no longer available/);
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(getPcbPaste(app), null);
}
console.log('PASS single-kind/repeated paste, keyboard discard, invalid and missing preview cleanup');

{
    const { bindPcbHistoryButtons } = await import('../src/pcb/modules/controls.js');
    for (const action of ['undo', 'redo']) {
        const { app, model } = fixture(), before = model.captureGeometry();
        let callback;
        const button = { addEventListener(name, fn) { callback = fn; } };
        bindPcbHistoryButtons(app, action === 'undo' ? button : null, action === 'redo' ? button : null);
        app.pasteSelection();
        callback();
        assert.equal(getPcbPaste(app), null);
        assert.deepEqual(model.captureGeometry(), before);
        assert.equal(app.history.undoStack.length, 0);
    }
}
{
    const { app, model } = fixture(), before = model.captureGeometry();
    app.pasteSelection();
    PCBApp.prototype.cutSelection.call(app);
    assert.equal(getPcbPaste(app), null);
    assert.deepEqual(model.captureGeometry(), before, 'Cut during floating paste never deletes prior authored selection');
}
{
    const { app, model } = fixture();
    app.pasteSelection();
    const shape = getPcbPaste(app).payload.shapes[0];
    const collision = { ...structuredClone(shape), points: shape.points.map(point => ({ x: point.x + 50, y: point.y })) };
    model.boardShapes.push(collision);
    renderBoardShape(app, collision);
    const before = model.captureGeometry();
    assert.throws(() => endPcbPaste(app), /fresh, unique/);
    assert.deepEqual(model.captureGeometry(), before, 'An intervening authored object is never removed');
    assert.ok(getBoardShapeElement(app, collision.id)?.parentNode, 'Collision cleanup restores canonical artwork');
}
{
    const { app, model } = fixture(), before = model.captureGeometry(), counter = model.shapeIdCounter;
    const set = model.texts.set.bind(model.texts);
    app.pasteSelection();
    model.texts.set = () => { throw new Error('Model insertion failed'); };
    assert.throws(() => endPcbPaste(app), /Model insertion failed/);
    model.texts.set = set;
    assert.equal(getPcbPaste(app), null);
    assert.deepEqual(model.captureGeometry(), before, 'A partly applied bundle rolls back only its own insertions');
    assert.equal(model.shapeIdCounter, counter);
    assert.equal(app.history.undoStack.length, 0);
}
console.log('PASS toolbar undo/redo, cut discard, ID collision ownership and partial-command rollback');

{
    const { app, model, work } = fixture();
    model.boardShapes.push(...Array.from({ length: 1000 }, (_, index) => ({
        id: `unrelated-${index}`, kind: 'circle', layer: 'top-silk', x: index, y: 100, radius: 1,
    })));
    const before = model.captureGeometry();
    app.pasteSelection();
    const projection = getPcbPaste(app).preview, nodes = getPcbPaste(app).payload.tracks[0].nodes, counts = work();
    for (let index = 0; index < 1000; index++) updatePcbPaste(app, app.viewport.currentMouseWorld);
    assert.deepEqual(work(), counts);
    assert.equal(getPcbPaste(app).preview, projection);
    assert.equal(getPcbPaste(app).payload.tracks[0].nodes, nodes);
    assert.equal(app.boardShapes[1005], model.boardShapes[1005]);
    cancelPcbPaste(app);
    assert.deepEqual(model.captureGeometry(), before);
}
{
    const { app } = fixture();
    app._pcbClipboard = { shapes: [{ id: 'cut', kind: 'circle', layer: 'top-copper', x: 10, y: 10,
        radius: 2, lineWidth: 0.2, copperMode: 'remove-copper' }] };
    const defs = new Element('defs');
    defs.setAttribute('data-pcb-defs', '');
    const svg = new Element('svg');
    svg.appendChild(defs);
    app.viewport.svg = svg;
    app.pasteSelection();
    PCBApp.prototype.updateCopperCuts.call(app);
    assert.equal(copperCutState(app).geometry.top.count, 0, 'Cold cut-cache initialization excludes detached pasted cutters');
    endPcbPaste(app);
    PCBApp.prototype.updateCopperCuts.call(app);
    assert.equal(copperCutState(app).geometry.top.count, 1, 'Acceptance publishes the cutter for canonical derived geometry');
}
{
    const { app } = fixture();
    let resumed = 0;
    app.pasteSelection();
    setFillRefreshPending(app, true);
    app.refreshFills = () => { resumed++; };
    cancelPcbPaste(app);
    assert.equal(resumed, 1, 'An unrelated fill refresh deferred while floating is resumed, not lost');
}
console.log('PASS 1000-shape stationary reuse, canonical copper-cut cache seeding and pending-fill resumption');

{
    const { app, model, clipboard } = fixture(), before = model.captureGeometry();
    const payload = preparePcbPaste(app, { vias: clipboard.vias });
    app.viewport.currentMouseWorld = { x: payload.vias[0].x, y: payload.vias[0].y };
    beginPcbPaste(app, payload);
    assert.equal(getPcbPaste(app).dx, 0);
    assert.equal(getPcbPaste(app).dy, 0);
    endPcbPaste(app);
    assert.equal(app.history.undoStack.length, 1, 'An unmoved fresh paste is still an insertion, not a no-op');
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    app._active = false;
    assert.throws(() => app.pasteSelection(), /inactive/);
    assert.equal(getPcbPaste(app), null);
    assert.deepEqual(model.captureGeometry(), before);
}
