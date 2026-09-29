import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PcbDocument } from '../src/core/PcbDocument.js';

const source = readFileSync(new URL('../src/pcb/modules/project-state.js', import.meta.url), 'utf8');
const start = source.indexOf('export function loadPcb(');
const end = source.indexOf('export function applyProjectDesignParams(', start);
assert.ok(start >= 0 && end > start);
const calls = [];
const record = name => () => calls.push(name);
const dependencies = {
    removeTrackElements() {}, removeViaElements() {}, removePadElements() {},
    removeBoardShapeElement() {},
    clearTrackSelection() {},
    resetPcbSelection() {}, syncPcbSelection() {}, clearPcbSelectionAnchors() {},
    resetPanelPreview() {}, renderPanelPreview() {},
    getBoardOutline: app => app.boardShapes.find(shape => shape.layer === 'board-outline'),
    syncBoardOutlineDimensions() {},
    renderTrack: record('track'), renderVia: record('via'), renderPad: record('pad'),
    renderBoardShape(app, shape, options) {
        assert.equal(options?.skipCopperUpdate, true, 'Batch rendering must defer copper clipping');
        calls.push('shape');
    },
    reconcileRatsnest: record('ratsnest'), restoreGridSettings: record('grid'), getSelectedTrack: () => null,
    REF_DEFAULT_SIZE: 0.9, REF_DEFAULT_STROKE: 0.15,
};
const loadPcb = new Function(...Object.keys(dependencies),
    `${source.slice(start, end).replace('export function', 'function')}\nreturn loadPcb;`)(...Object.values(dependencies));
const data = {
    stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
    design: { trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3, units: 'mm', router: 'pathfinder' },
    board: { width: 43, height: 27, radius: 2 }, settings: { gridSize: 0.5 },
    placements: { U1: { x: 3, y: -5, rotation: 90, locked: true } } };
const prepared = {
    tracks: [{ id: 'track' }], vias: [{ id: 'via' }], pads: [{ id: 'pad' }],
    texts: [{ id: 'text' }], shapeIdCounter: 3,
    boardShapes: [{ id: 'image', kind: 'image' }, { id: 'fill', type: 'fill' }],
};
const makeApp = active => {
    const pcbDocument = new PcbDocument();
    const placementState = pcbDocument.placementState;
    return {
    pcbDocument, designSettings: pcbDocument.designSettings,
    _active: active, _stale: false, tracks: pcbDocument.tracks, vias: pcbDocument.vias, pads: pcbDocument.pads,
    boardShapes: pcbDocument.boardShapes, texts: pcbDocument.texts,
    get _shapeIdCounter() { return pcbDocument.shapeIdCounter; },
    set _shapeIdCounter(value) { pcbDocument.shapeIdCounter = value; },
    placements: new Map([['U1', {}]]), _shapeElements: new Map(), _textElements: new Map(),
    placementState, _placementOverrides: placementState.overrides, history: { clear() {} },
    _ensureViewport: record('viewport'), _getLayerGroup: () => null,
    _drawBoardOutline: record('outline'), _applyPlacementOverrides: record('placements'),
    _applyProjectDesignParams(design) { this.designSettings.update(design); },
    _renderText: record('text'), _refreshClearanceHalos: record('clearance'), _refreshFills: record('fills'),
    _updateCopperCuts() { this.cutRefreshes = (this.cutRefreshes || 0) + 1; },
    markSectionClean() { this._isDirty = false; },
    };
};

const hidden = makeApp(false);
const textMap = hidden.pcbDocument.texts;
const oldText = { id: 'old-text' };
hidden.texts.set(oldText.id, oldText);
hidden._textElements.set(oldText.id, {});
hidden._removeTextElement = id => {
    assert.equal(hidden.pcbDocument.texts.get(id), oldText, 'Old text SVG is removed before the model is cleared');
    hidden._textElements.delete(id);
};
loadPcb(hidden, data, prepared);
assert.equal(hidden.texts, textMap, 'Loading preserves the project-owned text map');
assert.equal(textMap.has(oldText.id), false);
assert.deepEqual(calls, ['viewport', 'grid'], 'hidden load does not render objects or compute derived copper');
assert.equal(hidden._stale, true);
assert.equal(hidden._boardOutlineDrawn, true, 'saved dimensions remain available before rendering');
assert.deepEqual([hidden._boardWidth, hidden._boardHeight, hidden._boardRadius], [43, 27, 2]);
assert.deepEqual(hidden.boardShapes, prepared.boardShapes);
assert.deepEqual(hidden.tracks, prepared.tracks);
assert.deepEqual(hidden.vias, prepared.vias);
assert.deepEqual(hidden.pads, prepared.pads);
assert.equal(hidden.texts.get('text'), prepared.texts[0]);
assert.equal(hidden._placementOverrides.get('U1').rotation, 90);
assert.equal(hidden._placementOverrides.get('U1').locked, true);
assert.equal(hidden._isDirty, false);
assert.equal(hidden.cutRefreshes, 1, 'Hidden loading only clears the previous document cuts');

calls.length = 0;
const active = makeApp(true);
loadPcb(active, data, prepared);
assert.deepEqual(calls, ['viewport', 'grid', 'outline', 'placements', 'track', 'via', 'pad', 'shape', 'text', 'clearance', 'ratsnest', 'fills'],
    'active loads still render immediately');
assert.equal(active.cutRefreshes, 2, 'Active loading clears old cuts and refreshes once after all shapes');

calls.length = 0;
hidden._board3d = { refresh: record('3d') };
hidden.netlist = [{ net: 'GND' }];
loadPcb(hidden, null, { tracks: [], vias: [], texts: [], boardShapes: [], shapeIdCounter: 1 });
assert.equal(textMap.size, 0, 'New clears authoritative text even in the hidden editor');
assert.equal(hidden.texts, textMap);
assert.deepEqual(calls, ['viewport', '3d']);
assert.equal(hidden._boardOutlineDrawn, false);
assert.deepEqual(hidden.boardShapes, []);
assert.equal(hidden._placementOverrides.size, 0);
assert.equal(hidden.placements.size, 0);
assert.deepEqual(hidden.netlist, []);
console.log('PASS: hidden PCB loading restores models and settings without rendering or derived copper work');

const pcbSource = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
let components = [];
const methodDependencies = {
    ...dependencies, extractComponents: () => components, extractNetlist: () => [],
    getPcbSelection: () => [], refreshBoxSelectionHighlights() {}, updateGridDropdown() {},
    setInlineTextInputActive() {},
};
const method = name => {
    const methodStart = pcbSource.indexOf(`    ${name}(`);
    const methodEnd = pcbSource.indexOf('\n    }', methodStart) + '\n    }'.length;
    assert.ok(methodStart >= 0 && methodEnd > methodStart);
    return new Function(...Object.keys(methodDependencies), `return ({${pcbSource.slice(methodStart, methodEnd)}}).${name};`)
        (...Object.values(methodDependencies));
};
for (const withComponents of [false, true]) {
    components = withComponents ? [{ id: 'U1' }] : [];
    const app = makeApp(false);
    Object.assign(app, {
        project: { schematicDocument: {} },
        activate: method('activate'), preload: method('preload'), _syncFromSchematic: method('_syncFromSchematic'),
        _renderPersistentObjects: method('_renderPersistentObjects'),
        initialize() {}, _updateCursorForTool() {}, _updateViewportStatus() {},
        _retainRibbonHeight: record('ribbon-height'),
        viewport: { _onResize: record('viewport-resize') },
        _setPcbStatus() {}, _setStatus() {}, _fitToPlacedContent() {},
        _clearPCBContent() { this.placements.clear(); calls.push('clear'); },
        _placeFootprints: record('footprints'), _updateRatsnest: record('ratsnest'),
        _showBoardDimensionsDialog: record('dimensions-dialog'),
        _board3d: { refresh: record('3d') },
    });
    Object.defineProperty(app, 'copperFills', { get: () => app.boardShapes.filter(shape => shape.type === 'fill') });
    loadPcb(app, data, prepared);
    calls.length = 0;
    app._syncFromSchematic();
    assert.deepEqual(calls, [], 'a queued sync must not render a hidden board');
    assert.equal(app._stale, true);
    const beforePreloadCuts = app.cutRefreshes;
    assert.equal(app.preload(), true, 'hidden stale PCB can render before first activation');
    assert.equal(app.cutRefreshes, beforePreloadCuts + 1,
        `Preloading clips once after the shape batch (components=${withComponents})`);
    assert.equal(app._active, false, 'preloading does not activate the PCB editor');
    assert.equal(app._stale, false);
    assert.equal(calls.filter(call => call === '3d').length, 1,
        `Preloading refreshes the board viewer when components=${withComponents}`);
    assert.equal(calls.includes('ribbon-height'), false, 'hidden preloading does not measure the ribbon');
    calls.length = 0;
    app.activate();
    assert.deepEqual(calls.slice(0, 3), ['ribbon-height', 'viewport', 'viewport-resize'],
        'first activation measures ribbon height before creating or resizing the viewport');
    for (const name of ['shape', 'track', 'via', 'text', 'outline', 'clearance', 'ratsnest', 'fills']) {
        assert.equal(calls.filter(call => call === name).length, 0, `${name} is already rendered before activation (components=${withComponents})`);
    }
    assert.equal(calls.includes('dimensions-dialog'), false, 'restored board dimensions do not prompt again');
    assert.equal(app._stale, false);
    calls.length = 0;
    app.activate();
    assert.deepEqual(calls.slice(0, 3), ['ribbon-height', 'viewport', 'viewport-resize'],
        'returning to PCB remeasures the visible ribbon before viewport sizing');
    assert.equal(calls.includes('shape'), false, 'repeated activation does not rebuild unchanged images');
}
console.log('PASS: first activation renders each restored image once, with or without schematic components');

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null };
const { preparePcb, serializePcb } = await import('../src/pcb/modules/project-state.js');
const { compactProjectAliases } = await import('../src/core/project-field-aliases.js');
const { pictureShape } = await import('../src/pcb/modules/picture-raster.js');
const { serializeBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const artwork = { width: 20, height: 20, circles: [{ x: Math.PI, y: 5, radius: 1 / 3 }] };
const image = { ...pictureShape(artwork, { widthMm: 12, layer: 'top-silk' }), id: 'pshape_1' };
const saved = { ...data, boardShapes: serializeBoardShapes({ boardShapes: [image] }) };
const restored = makeApp(false);
restored._getRoutingParams = () => ({ trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 });
restored._getRouterMode = () => 'pathfinder';
loadPcb(restored, saved, preparePcb(saved));
const snapshot = serializePcb(restored);
const expectedSaved = compactProjectAliases({ pcb: saved }).pcb;
assert.deepEqual(snapshot.board, expectedSaved.board);
assert.deepEqual(snapshot.boardShapes, expectedSaved.boardShapes, 'saving before activation preserves encoded geometry and pose');
assert.deepEqual(snapshot.placements, expectedSaved.placements);
assert.deepEqual(restored.boardShapes[0].artwork, artwork);
console.log('PASS: image geometry, board dimensions, and placements survive save before first activation');

const { boardShapeCopperCuts } = await import('../src/pcb/modules/board-shapes.js');
function clipNode() {
    return {
        attributes: new Map(), children: [], parent: null,
        setAttribute(name, value) { this.attributes.set(name, value); },
        removeAttribute(name) { this.attributes.delete(name); },
        get firstChild() { return this.children[0]; },
        appendChild(child) { child.parent = this; this.children.push(child); },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; },
        remove() { this.parent?.removeChild(this); },
        querySelector(selector) { return this.children.find(child => `#${child.attributes.get('id')}` === selector); },
    };
}
const clipDefs = clipNode();
let geometryCalls = 0;
const clipDependencies = {
    document: { createElementNS: () => clipNode() },
    boardShapeCopperCuts(app, layer) { geometryCalls++; return boardShapeCopperCuts(app, layer); },
    setCopperFillClip(group, id) { group.clipId = id; },
};
const clipStart = pcbSource.indexOf('    _updateCopperCuts(');
const clipEnd = pcbSource.indexOf('\n    }', clipStart) + '\n    }'.length;
assert.ok(clipStart >= 0 && clipEnd > clipStart);
const updateCuts = new Function(...Object.keys(clipDependencies),
    `return ({${pcbSource.slice(clipStart, clipEnd)}})._updateCopperCuts;`)(...Object.values(clipDependencies));
let visibleBounds = { minX: 0, minY: 0, maxX: 30, maxY: 20 };
const removal = { id: 'cut', kind: 'circle', x: 5, y: 5, radius: 2,
    layer: 'top-copper', copperMode: 'remove-copper', filled: true, lineWidth: 0.2 };
const clipApp = {
    boardShapes: [removal], _ensureSvgDefs: () => clipDefs,
    viewport: { getVisibleBounds: () => visibleBounds },
    _layerGroups: new Map(['top-copper', 'bottom-copper', 'top-fill', 'bottom-fill'].map(id => [id, clipNode()])),
};
const currentPath = () => clipDefs.querySelector('#pcb-copper-cut-top')?.firstChild?.attributes.get('d');
updateCuts.call(clipApp, { geometryChanged: false });
assert.equal(geometryCalls, 2, 'A view-only call initializes an empty geometry cache');
const firstPath = currentPath();
const firstGeometry = clipApp._copperCutGeometry.top;
visibleBounds = { minX: -10, minY: -5, maxX: 50, maxY: 35 };
updateCuts.call(clipApp, { geometryChanged: false });
assert.equal(geometryCalls, 2, 'Pan and zoom reuse both sides without resolving geometry');
assert.notEqual(currentPath(), firstPath, 'Viewport clipping bounds still update');
assert.equal(clipApp._copperCutGeometry.top, firstGeometry);
const firstNode = clipDefs.querySelector('#pcb-copper-cut-top').firstChild;
updateCuts.call(clipApp, { geometryChanged: false });
assert.equal(clipDefs.querySelector('#pcb-copper-cut-top').firstChild, firstNode,
    'Unchanged views avoid replacing the clipping path');
const beforeEdit = currentPath();
removal.x += 3;
updateCuts.call(clipApp);
assert.equal(geometryCalls, 4, 'Normal edit calls always refresh both sides');
assert.notEqual(currentPath(), beforeEdit);
removal.x -= 3;
updateCuts.call(clipApp);
assert.equal(currentPath(), beforeEdit, 'Undo-style in-place restoration refreshes geometry');
removal.layer = 'bottom-copper';
updateCuts.call(clipApp);
assert.equal(currentPath(), undefined, 'Changing layer clears the old side');
assert.ok(clipDefs.querySelector('#pcb-copper-cut-bottom'));
assert.equal(clipApp._layerGroups.get('top-fill').clipId, null);
assert.equal(clipApp._layerGroups.get('bottom-fill').clipId, 'pcb-copper-cut-bottom');
removal.layer = 'hole';
updateCuts.call(clipApp);
assert.ok(currentPath(), 'Board holes clip both sides');
assert.ok(clipDefs.querySelector('#pcb-copper-cut-bottom'));
clipDefs.querySelector('#pcb-copper-cut-top').remove();
const beforeRebuild = geometryCalls;
updateCuts.call(clipApp, { geometryChanged: false });
assert.ok(currentPath(), 'Missing SVG clip is restored from cached geometry');
assert.equal(geometryCalls, beforeRebuild);
clipApp.boardShapes.length = 0;
updateCuts.call(clipApp);
assert.equal(clipApp._hasCopperCuts, false, 'Deleting the last cut clears the active flag');
for (const side of ['top', 'bottom']) {
    assert.equal(clipDefs.querySelector(`#pcb-copper-cut-${side}`), undefined);
    assert.equal(clipApp._layerGroups.get(`${side}-copper`).attributes.has('clip-path'), false);
    assert.equal(clipApp._layerGroups.get(`${side}-fill`).clipId, null);
}
const afterDelete = geometryCalls;
updateCuts.call(clipApp, { geometryChanged: false });
assert.equal(geometryCalls, afterDelete, 'Empty cut geometry is cached too');
console.log('PASS: viewport copper-cut cache, edit/undo invalidation, layer changes, SVG rebuild and deletion');

globalThis.window = { addEventListener() {} };
Object.defineProperty(window, 'app', {
    get() { assert.fail('PCB synchronization must not read the global schematic'); },
});
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
globalThis.HTMLElement = class {};
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');
const project = new ProjectDocument();
let syncs = 0, placed = [];
const pcb = Object.assign(Object.create(PCBApp.prototype), {
    pcbDocument: project.pcbDocument,
    project: null, _active: true, _stale: true, boardShapes: [],
    _ensureViewport() { syncs++; }, _clearPCBContent() {}, _renderPersistentObjects() {},
    _placeFootprints(items) { placed = items; }, _getLayerGroup: () => null,
    _refreshClearanceHalos() {}, _updateRatsnest() {}, _fitToPlacedContent() {}, _setStatus() {},
});
pcb._syncFromSchematic();
assert.equal(pcb._stale, true, 'Missing project must not acknowledge a pending sync');
assert.equal(syncs, 0);
const notifications = [];
project.schematicDocument.components = [{ id: 'owned', reference: 'U1', definition: { name: 'Part' } }];
project.schematicDocument.shapes = [{ type: 'wire', net: 'OWNED', pinConnections: new Map([
    ['node', { componentId: 'owned', pinNumber: '1' }],
]) }];
pcb.project = project;
project.registerView('pcb', pcb);
Object.defineProperty(project, 'schematic', {
    get() { assert.fail('PCB sync must not discover or inspect the schematic editor'); },
});
pcb._syncFromSchematic();
assert.equal(placed[0].reference, 'U1', 'Model synchronization works without a schematic view');
assert.equal(pcb._stale, false);
syncs = 0;
const schematic = Object.assign(Object.create(SchematicApp.prototype), {
    project, document: project.schematicDocument,
    _updateUndoRedoButtons: () => notifications.push('history'),
    _updateTitle: () => notifications.push('title'),
});
schematic.history = new CommandHistory({ onChanged: () => schematic._onHistoryChanged() });
project.fileManager.onDirtyChanged = () => schematic._onDirtyChanged();
project.registerView('schematic', schematic);
const historyListener = schematic.history.onChanged, dirtyListener = project.fileManager.onDirtyChanged;
const timers = new Map();
let timerId = 0;
const originalTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
try {
    globalThis.setTimeout = (callback, delay) => {
        assert.equal(delay, 300, 'Preserve the schematic sync debounce');
        timers.set(++timerId, callback);
        return timerId;
    };
    globalThis.clearTimeout = id => timers.delete(id);
    const flush = () => { const work = [...timers.values()]; timers.clear(); work.forEach(callback => callback()); };
    pcb._active = false;
    pcb._stale = false;
    schematic.history.execute({ execute() {}, undo() {} });
    assert.equal(pcb._stale, true);
    assert.equal(timers.size, 0);
    pcb._active = true;
    schematic.history.undo();
    schematic.history.redo();
    project.fileManager.setDirty(true);
    assert.deepEqual(notifications, ['history', 'history', 'history', 'title'], 'Owning editor UI callbacks run exactly once');
    assert.equal(timers.size, 1, 'Active changes coalesce into one pending sync');
    project.schematicDocument.components[0].reference = 'U2';
    flush();
    assert.equal(syncs, 1);
    assert.equal(placed[0].reference, 'U2', 'Sync consumes the latest project model data');
    assert.equal(pcb.netlist[0].net, 'OWNED');
    assert.equal(pcb._stale, false);
    project.fileManager.setDirty(false);
    assert.equal(notifications.at(-1), 'title', 'Dirty resets still update the editor title');
    pcb._active = false;
    flush();
    assert.equal(syncs, 1, 'A queued rebuild must not render after the PCB is hidden');
    assert.equal(pcb._stale, true);
    pcb._active = true;
    pcb._syncFromSchematic();
    assert.equal(syncs, 2);
    assert.equal(pcb._stale, false);
    const revision = project.fileManager.revision;
    pcb.onDocumentChanged();
    assert.equal(project.fileManager.revision, revision + 1);
    assert.equal(project.fileManager.isDirty, false, 'PCB-only edits do not raise schematic dirty events');
    assert.equal(pcb._stale, false);
    assert.equal(timers.size, 0, 'PCB-only edits must not schedule a schematic-driven rebuild');
    new ProjectDocument().notifySchematicChanged();
    assert.equal(timers.size, 0, 'Other projects cannot notify this PCB');
    assert.equal(schematic.history.onChanged, historyListener, 'PCB never replaces the history callback');
    assert.equal(project.fileManager.onDirtyChanged, dirtyListener, 'PCB never replaces the dirty callback');
} finally {
    Object.assign(globalThis, originalTimers);
}
console.log('PASS: model-driven PCB sync, explicit project notifications, debounce, hidden deferral and PCB-only edit isolation');