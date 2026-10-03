import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { Pad } from '../src/shapes/pad.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { setComputedFill, getComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { renderTrack, renderVia } from '../src/pcb/modules/track-render.js';
import { renderPad } from '../src/pcb/modules/pad.js';
import { renderBoardShape, getBoardShapePropertyPreview } from '../src/pcb/modules/board-shapes.js';
import { showBoardShapeProperties } from '../src/pcb/modules/board-shape-properties.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { renderCopperFill } from '../src/pcb/modules/copper-fill-render.js';
import { beginGroupDrag, updateGroupDrag, scheduleGroupDrag, endGroupDrag, cancelGroupDrag, getGroupPreview, deleteBoxSelection } from '../src/pcb/modules/box-select.js';
import { runPcbDeleteAction } from '../src/pcb/modules/editor-actions.js';
import { setPcbSelection, getPcbSelectionEntries, syncPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { PCB_LAYERS, PCB_COPPER_FILLS } from '../src/pcb/modules/layers.js';
import { areDragOverlaysDeferred, isBoardViewRefreshSuspended, setBoardViewRefreshSuspended, setDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';

let allocations = 0;
const trackRenders = new Map();
class Element {
    constructor(tag) { allocations++; this.tag = tag; this.children = []; this.attributes = new Map(); this.dataset = {}; this.style = {}; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener() {}
    get classList() {
        return { contains: name => (this.getAttribute('class') || '').split(' ').includes(name),
            add: name => this.setAttribute('class', `${this.getAttribute('class') || ''} ${name}`) };
    }
    appendChild(child) {
        child.remove(); this.children.push(child); child.parentNode = this;
        if (child.tag === 'polyline' && child.dataset.trackId) {
            trackRenders.set(child.dataset.trackId, (trackRenders.get(child.dataset.trackId) || 0) + 1);
        }
    }
    removeChild(child) { child.remove(); }
    insertBefore(child, before) {
        child.remove(); const index = this.children.indexOf(before);
        this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentNode = this;
    }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    get firstChild() { return this.children[0] || null; }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [
            ...(selector.startsWith('.') && child.classList.contains(selector.slice(1)) ? [child] : []), ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const frames = new Map();
let frameId = 0;
globalThis.window = { addEventListener() {}, requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); } };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.localStorage = { setItem() {} };
globalThis.document = { createElementNS: (_, tag) => new Element(tag), createElement: tag => new Element(tag),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    removeEventListener() {}, body: new Element('body') };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(deferred = false, component = false) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    if (component) project.schematicDocument.components.push(new Component({
        name: 'MixedGroup', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
        footprintShapes: ['PAD~RECT~2~1~1~1~1~both~1~0~0.5'],
    }, { id: 'a' }));
    if (component) model.placementState.record('a', { x: 10, y: -10, rotation: 0 });
    const placements = project.resolvePcbLayout().placements;
    const origin = component ? placements.get('a').pads.get('1') : { x: Math.PI, y: -Math.E };
    const track = new Track({ width: 0.234567891, points: [origin, { x: 12, y: 4 }, { x: 16, y: 4 }],
        padConnections: component ? { n0: { componentId: 'a', pinNumber: '1' } } : {} });
    const attached = component ? new Track({ points: [origin, { x: 22, y: 22 }],
        padConnections: { n0: { componentId: 'a', pinNumber: '1' } } }) : null;
    const via = new Via({ x: Math.PI, y: -Math.E, diameter: 0.8123456789 });
    const pad = new Pad({ x: 4.123456789, y: 6, shape: 'rectangle', size: 1, ratio: 2, rotation: 37.123456789 });
    const shape = { id: 'shape', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 30, y: 10 }, { x: 35, y: 10 }, { x: 35, y: 15 }, { x: 30, y: 15 }] };
    const fill = new CopperFill({ id: 'fill', outline: [{ x: 40, y: 40 }, { x: 50, y: 40 }, { x: 50, y: 50 }, { x: 40, y: 50 }] });
    const text = { id: 'text', x: 60, y: 60, content: 'Group', layer: 'top-silk', size: 1, strokeWidth: 0.15, rotation: 0 };
    model.tracks.push(track, ...(attached ? [attached] : []));
    model.vias.push(via); model.pads.push(pad); model.boardShapes.push(shape, fill); model.texts.set(text.id, text);
    setComputedFill(fill, [{ outer: fill.outline, holes: [] }]);
    const groups = new Map(['top-copper', 'bottom-copper', 'hole', 'top-silk', 'top-fill', 'selection-overlay'].map(id => [id, new Element('g')]));
    let fills = 0, ratsnest = 0, board = 0;
    const app = {};
    setDragOverlaysDeferred(app, deferred);
    setBoardViewRefreshSuspended(app, deferred);
    for (const key of ['tracks', 'vias', 'pads', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    Object.assign(app, { project, pcbDocument: model, placements, placementState: model.placementState,
        netlist: [], history: new CommandHistory(), _active: true, _layerGroups: groups, _shapeElements: new Map(), _textElements: new Map(),
        viewport: { scale: 10, gridVisible: false, svg: new Element('svg'), setCrosshair() {}, hideCrosshair() {} },
        getLayerGroup: id => groups.get(id) || null, refreshText() {}, refreshFills() { fills++; },
        updateRatsnest() { ratsnest++; }, _board3d: { refresh() { board++; } },
        refreshClearanceHalos() {}, _netsForComponent: () => new Set(),
        _cancelPosePreviews: PCBApp.prototype._cancelPosePreviews, isSectionEditing: PCBApp.prototype.isSectionEditing,
        _cancelDrawingMode: () => false, _ensureViewport() {}, markSectionClean() {}, _setActiveRibbonTab() {}, setPcbStatus() {},
        propertiesItems: () => ({ innerHTML: '' }), setPropertiesTitle: PCBApp.prototype.setPropertiesTitle,
        _selectText() {}, _removeTextElement() {}, _renderText() {},
        clearProperties: PCBApp.prototype.clearProperties,
        _onLayerLockChanged: PCBApp.prototype._onLayerLockChanged,
        _onLayerVisibilityChanged: PCBApp.prototype._onLayerVisibilityChanged,
        _onCopperFillLockChanged: PCBApp.prototype._onCopperFillLockChanged,
        _onCopperFillVisibilityChanged: PCBApp.prototype._onCopperFillVisibilityChanged,
    });
    project.registerView('pcb', app);
    for (const item of model.tracks) renderTrack(item, app.getLayerGroup);
    renderVia(via, app.getLayerGroup); renderPad(pad, app.getLayerGroup);
    renderBoardShape(app, shape); renderCopperFill(fill, app.getLayerGroup);
    setPcbSelection(app, [
        ...(component ? [{ kind: 'component', object: 'a' }] : []),
        ...Object.entries({ track, via, pad, shape, fill, text }).map(([kind, object]) => ({ kind, object })),
    ]);
    const artwork = () => [...groups.values()].flatMap(group => group.children)
        .filter(element => element.dataset.trackId === track.id && element.tag === 'polyline');
    return { app, model, project, track, attached, via, pad, shape, fill, text, artwork,
        work: () => [allocations, fills, ratsnest, board] };
}

let cases = 0;
for (const component of [false, true]) for (const deferred of [false, true]) for (const finish of [
    'commit', 'cancel', 'no-op', 'failure', 'missing', 'lock', 'hide', 'deactivate', 'load', 'shared', 'frozen', 'invalid',
]) {
    const f = fixture(deferred, component), { app, model, track, via, pad, shape, fill } = f;
    const before = model.serialize(), geometry = model.captureGeometry();
    const nodes = track.nodes, bounds = track.getBounds(), outline = fill.outline, computed = getComputedFill(fill);
    const retained = getPcbSelectionEntries(app);
    const startBounds = new Map(retained.filter(item => item.kind !== 'component').map(item => [item.id, item.getBounds()]));
    beginGroupDrag(app, { x: 0, y: 0 });
    assert.equal(getGroupPreview(app), undefined);
    const idle = f.work();
    for (let i = 0; i < 100; i++) updateGroupDrag(app, { x: 0, y: 0 }, { snap: false });
    assert.deepEqual(f.work(), idle);
    const renderedBefore = trackRenders.get(track.id);
    updateGroupDrag(app, { x: 3.123456789, y: -4.123456789 }, { snap: false });
    assert.equal(trackRenders.get(track.id), renderedBefore + 1, 'Selected and component-attached track renders once per changed update');
    const preview = getGroupPreview(app), collections = [app.tracks, app.vias, app.pads, app.boardShapes, app.texts];
    const copies = [...preview.copies.values()], copiedNodes = app.tracks[0].nodes, copiedOutline = app.boardShapes[1].outline;
    assert.notEqual(app.tracks[0], track);
    assert.equal(f.artwork().length, 1);
    assert.equal(app.isSectionEditing(), true);
    await assert.rejects(prepareFabricationSnapshot(app), /edit|preview|drag|finish/i);
    for (const adapter of retained.filter(item => item.kind !== 'component')) {
        const initial = startBounds.get(adapter.id), displayed = adapter.getBounds();
        assert.ok(Math.abs(displayed.minX - initial.minX - 3.123456789) < (adapter.kind === 'shape' ? 1e-4 : 1e-8),
            `${adapter.kind}: retained bounds follow group copy (${initial.minX} -> ${displayed.minX})`);
        if (['via', 'pad'].includes(adapter.kind)) {
            assert.equal(adapter.hitTest({ x: adapter.object.x, y: adapter.object.y }), true);
        }
    }
    syncPcbSelection(app);
    const rebuilt = getPcbSelectionEntries(app);
    for (let i = 1; i <= 20; i++) {
        updateGroupDrag(app, { x: 3.123456789 + i / 100, y: -4.123456789 }, { snap: false });
        assert.equal(getGroupPreview(app), preview);
        [app.tracks, app.vias, app.pads, app.boardShapes, app.texts].forEach((value, index) => assert.equal(value, collections[index]));
        assert.deepEqual([...preview.copies.values()], copies);
        assert.equal(app.tracks[0].nodes, copiedNodes); assert.equal(app.boardShapes[1].outline, copiedOutline);
        assert.equal(f.artwork().length, 1);
    }
    const work = f.work();
    assert.equal(trackRenders.get(track.id), renderedBefore + 21);
    for (let i = 0; i < 100; i++) updateGroupDrag(app, { x: 3.323456789, y: -4.123456789 }, { snap: false });
    assert.deepEqual(f.work(), work, 'Same delta does no SVG, derived, or 3D work');
    assert.deepEqual(model.serialize(), before); assert.deepEqual(model.captureGeometry(), geometry);
    assert.equal(track.nodes, nodes); assert.equal(track.getBounds(), bounds);
    assert.equal(fill.outline, outline); assert.equal(getComputedFill(fill), computed);
    if (finish === 'commit') {
        scheduleGroupDrag(app, { x: 7.123456789, y: -8.123456789 });
        endGroupDrag(app);
        assert.equal(app.history.undoStack.length, 1);
        const after = model.serialize(), exact = track.captureState();
        assert.equal(via.x, Math.PI + 7.123456789);
        for (let cycle = 0; cycle < 2; cycle++) {
            app.history.undo(); assert.deepEqual(model.serialize(), before);
            app.history.redo(); assert.deepEqual(model.serialize(), after); assert.deepEqual(track.captureState(), exact);
        }
    } else {
        if (finish === 'no-op') {
            updateGroupDrag(app, { x: 0, y: 0 }, { snap: false }); endGroupDrag(app);
        } else if (finish === 'failure') {
            app.history.execute = () => { throw new Error('rejected'); };
            assert.throws(() => endGroupDrag(app), /rejected/);
        } else if (finish === 'missing') {
            model.vias.splice(0, 1);
            assert.throws(() => endGroupDrag(app), /no longer available/);
            model.vias.push(via);
        } else if (finish === 'lock' || finish === 'hide') {
            const layer = PCB_LAYERS.find(item => item.id === 'top-silk'), field = finish === 'lock' ? 'locked' : 'visible';
            const previous = layer[field]; layer[field] = finish === 'lock';
            try {
                app._pcbSelectionInteraction = { mode: 'move' };
                if (finish === 'lock') app._onLayerLockChanged(layer.id, true);
                else app._onLayerVisibilityChanged(layer.id, false);
            } finally { layer[field] = previous; }
        } else if (finish === 'deactivate' || finish === 'shared') {
            if (finish === 'shared') app._pcbSelectionInteraction = { mode: 'move' };
            app._cancelPosePreviews();
        } else if (finish === 'load') {
            const graph = track.captureState(), padState = pad.captureState(), fillState = fill.captureState();
            loadPcb(app, null);
            assert.deepEqual(track.captureState(), graph);
            assert.deepEqual(pad.captureState(), padState);
            assert.deepEqual(fill.captureState(), fillState);
        } else if (finish === 'frozen') {
            for (const node of track.nodes.values()) Object.freeze(node);
            for (const point of shape.points) Object.freeze(point);
            for (const point of fill.outline) Object.freeze(point);
            Object.freeze(via); Object.freeze(pad); Object.freeze(fill);
            cancelGroupDrag(app);
        } else if (finish === 'invalid') {
            assert.throws(() => updateGroupDrag(app, { x: NaN, y: 1 }), /finite/);
        } else cancelGroupDrag(app);
        assert.equal(app.history.undoStack.length, 0);
        if (finish !== 'load') assert.deepEqual(model.serialize(), before);
    }
    assert.equal(app._groupDrag, null);
    assert.equal(getGroupPreview(app), undefined);
    assert.equal(areDragOverlaysDeferred(app), deferred);
    assert.equal(isBoardViewRefreshSuspended(app), deferred);
    assert.equal(frames.size, 0);
    if (finish !== 'load') {
        assert.equal(f.artwork().length, 1);
        for (const adapter of rebuilt.filter(item => item.kind !== 'component' && item.kind !== 'text')) {
            assert.equal(adapter.object, ({ track, via, pad, shape, fill })[adapter.kind], 'Rebuilt adapters retain canonical target after finish');
        }
    }
    cases++;
}
for (const component of [false, true]) for (const kind of ['track', 'via', 'pad', 'shape', 'fill', 'text']) {
    const f = fixture(false, component), { app, model } = f;
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 2, y: 3 }, { snap: false });
    const object = f[kind];
    const collection = kind === 'track' ? model.tracks : kind === 'via' ? model.vias : kind === 'pad' ? model.pads : model.boardShapes;
    if (kind === 'text') model.texts.delete(object.id);
    else collection.splice(collection.indexOf(object), 1);
    const deleted = model.serialize();
    assert.throws(() => endGroupDrag(app), /no longer available/);
    assert.deepEqual(model.serialize(), deleted, 'Missing target aborts before authoring any other member');
    assert.equal(app._groupDrag, null);
    assert.equal(app.history.undoStack.length, 0);
    if (kind === 'track') assert.equal(f.artwork().length, 0, 'Missing attached graph never reappears during cleanup');
    cases++;
}
{
    const f = fixture(), { app, model } = f, before = model.serialize();
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 2, y: 3 }, { snap: false });
    const execute = app.history.execute.bind(app.history);
    app.history.execute = command => {
        command.commands.at(-1).execute = () => { throw new Error('late rejection'); };
        execute(command);
    };
    assert.throws(() => endGroupDrag(app), /late rejection/);
    assert.deepEqual(model.serialize(), before, 'Compound rollback preserves exact state on late member rejection');
    assert.equal(app.history.undoStack.length, 0);
    assert.equal(f.artwork().length, 1);
    cases++;
}
for (const dispatch of [deleteBoxSelection, runPcbDeleteAction,
    app => PCBApp.prototype.handleKeyDown.call(app, { key: 'Delete' }),
    app => PCBApp.prototype.handleKeyDown.call(app, { key: 'Backspace' })]) {
    const f = fixture(), { app, model } = f, before = model.serialize();
    app._active = true;
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 2, y: 3 }, { snap: false });
    assert.equal(dispatch(app), true);
    assert.equal(app._groupDrag, null);
    assert.equal(model.tracks.length + model.vias.length + model.pads.length + model.boardShapes.length + model.texts.size, 0);
    app.history.undo();
    const restored = model.serialize();
    restored.boardShapes.sort((a, b) => a.id.localeCompare(b.id));
    before.boardShapes.sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(restored, before, 'Delete targets canonical members, never group copies');
    cases++;
}
{
    const f = fixture(), { app, model } = f, before = model.serialize();
    beginGroupDrag(app, { x: 0, y: 0 });
    scheduleGroupDrag(app, { x: 20, y: 20 });
    const oldCallback = frames.values().next().value;
    beginGroupDrag(app, { x: 0, y: 0 });
    oldCallback();
    assert.equal(getGroupPreview(app), undefined);
    assert.deepEqual(model.serialize(), before);
    cancelGroupDrag(app);
    cases++;
}
for (const commit of [false, true]) {
    const f = fixture(), { app, model, shape } = f;
    shape.layer = 'board-outline';
    model.syncBoardOutlineDimensions();
    const before = model.serialize(), board = structuredClone(model.board);
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 3.123456789, y: 4.123456789 }, { snap: false });
    assert.deepEqual(model.board, board, 'Live outline translation cannot author dimensions');
    assert.deepEqual(model.serialize(), before);
    if (commit) {
        endGroupDrag(app);
        assert.equal(shape.points[0].x, 33.123456789);
        app.history.undo();
    } else cancelGroupDrag(app);
    assert.deepEqual(model.serialize(), before);
    cases++;
}
for (const field of ['locked', 'visible']) {
    const { app, model } = fixture(), before = model.serialize();
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 3, y: 4 }, { snap: false });
    const layer = PCB_COPPER_FILLS.find(item => item.id === 'top-copper'), previous = layer[field];
    layer[field] = field === 'locked';
    try {
        if (field === 'locked') app._onCopperFillLockChanged('top-copper', true);
        else app._onCopperFillVisibilityChanged('top-copper', false);
    } finally { layer[field] = previous; }
    assert.equal(app._groupDrag, null);
    assert.deepEqual(model.serialize(), before);
    cases++;
}
{
    const { app, pad } = fixture();
    setPcbSelection(app, [{ kind: 'pad', object: pad }]);
    const bottom = PCB_LAYERS.find(item => item.id === 'bottom-copper'), previous = bottom.visible;
    bottom.visible = false;
    try {
        beginGroupDrag(app, { x: 0, y: 0 });
        updateGroupDrag(app, { x: 3, y: 4 }, { snap: false });
        assert.equal(app.pads[0].x, pad.x + 3, 'A through pad remains movable on its visible side');
        cancelGroupDrag(app);
    } finally { bottom.visible = previous; }
    cases++;
}
for (const commit of [false, true]) {
    const { app, model, shape } = fixture(), before = model.captureGeometry();
    const listeners = new Map();
    const input = {
        value: String(shape.lineWidth),
        get valueAsNumber() { return Number(this.value); },
        addEventListener(name, listener) { listeners.set(name, listener); },
    };
    const getElement = document.getElementById;
    document.getElementById = id => id === 'pcbPropShapeLineWidth' ? input : null;
    try {
        showBoardShapeProperties(app, shape);
        input.value = '0.47';
        listeners.get('input')();
        const copy = getBoardShapePropertyPreview(app).copies[0];
        assert.notEqual(copy, shape);
        assert.equal(getPcbSelectionEntries(app).find(entry => entry.kind === 'shape').object, copy);
        assert.deepEqual(model.captureGeometry(), before);
        beginGroupDrag(app, { x: 0, y: 0 });
        assert.equal(getBoardShapePropertyPreview(app), undefined, 'Group pickup first commits the property projection');
        assert.equal(app.history.undoStack.length, 1);
        assert.equal(shape.lineWidth, 0.47);
        assert.equal(app._groupDrag.shapes[0].shape, shape, 'Group stores the canonical original, never the displayed property copy');
        const afterProperty = model.captureGeometry();
        updateGroupDrag(app, { x: 3, y: 4 }, { snap: false });
        assert.deepEqual(model.captureGeometry(), afterProperty);
        if (commit) {
            endGroupDrag(app);
            const afterMove = model.captureGeometry();
            assert.equal(app.history.undoStack.length, 2);
            app.history.undo();
            assert.deepEqual(model.captureGeometry(), afterProperty);
            app.history.redo();
            assert.deepEqual(model.captureGeometry(), afterMove);
            app.history.undo();
        } else cancelGroupDrag(app);
        assert.deepEqual(model.captureGeometry(), afterProperty);
        app.history.undo();
        assert.deepEqual(model.captureGeometry(), before, 'Property and group edits retain separate exact history');
        cases++;
    } finally {
        document.getElementById = getElement;
        cancelPictureCopperRefresh(app);
    }
}
console.log(`PASS ${cases} mixed-group isolation cases: all entity kinds, components/attached tracks, exact history, copies/caches/SVG, lifecycle and work skips`);
