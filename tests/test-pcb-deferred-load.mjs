import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/pcb/modules/project-state.js', import.meta.url), 'utf8');
const start = source.indexOf('export function loadPcb(');
const end = source.indexOf('export function applyProjectDesignParams(', start);
assert.ok(start >= 0 && end > start);
const calls = [];
const record = name => () => calls.push(name);
const dependencies = {
    removeTrackElements() {}, removeViaElements() {}, resetViaIdCounter() {}, removeBoardShapeElement() {},
    clearTrackSelection() {}, updateViaIdCounter() {}, updateFillIdCounter() {},
    resetPanelPreview() {}, renderPanelPreview() {},
    getBoardOutline: app => app.boardShapes.find(shape => shape.layer === 'board-outline'),
    syncBoardOutlineDimensions() {},
    renderTrack: record('track'), renderVia: record('via'),
    renderBoardShape(app, shape, options) {
        assert.equal(options?.skipCopperUpdate, true, 'Batch rendering must defer copper clipping');
        calls.push('shape');
    },
    reconcileRatsnest: record('ratsnest'), restoreGridSettings: record('grid'), getSelectedTrack: () => null,
    REF_DEFAULT_SIZE: 0.9, REF_DEFAULT_STROKE: 0.15,
};
const loadPcb = new Function(...Object.keys(dependencies),
    `${source.slice(start, end).replace('export function', 'function')}\nreturn loadPcb;`)(...Object.values(dependencies));
const data = { board: { width: 43, height: 27, radius: 2 }, settings: { gridSize: 0.5 },
    placements: { U1: { x: 3, y: -5, rotation: 90 } } };
const prepared = {
    tracks: [{ id: 'track' }], vias: [{ id: 'via' }], texts: [{ id: 'text' }], shapeIdCounter: 3,
    boardShapes: [{ id: 'image', kind: 'image' }, { id: 'fill', type: 'fill' }],
};
const makeApp = active => ({
    _active: active, _stale: false, tracks: [], vias: [], boardShapes: [], texts: new Map(),
    placements: new Map([['U1', {}]]), _shapeElements: new Map(), _textElements: new Map(),
    _placementOverrides: new Map(), history: { clear() {} },
    _ensureViewport: record('viewport'), _getLayerGroup: () => null,
    _drawBoardOutline: record('outline'), _applyPlacementOverrides: record('placements'),
    _renderText: record('text'), _refreshClearanceHalos: record('clearance'), _refreshFills: record('fills'),
    _updateCopperCuts() { this.cutRefreshes = (this.cutRefreshes || 0) + 1; },
    markSectionClean() { this._isDirty = false; },
});

const hidden = makeApp(false);
loadPcb(hidden, data, prepared);
assert.deepEqual(calls, ['viewport', 'grid'], 'hidden load does not render objects or compute derived copper');
assert.equal(hidden._stale, true);
assert.equal(hidden._boardOutlineDrawn, true, 'saved dimensions remain available before rendering');
assert.deepEqual([hidden._boardWidth, hidden._boardHeight, hidden._boardRadius], [43, 27, 2]);
assert.deepEqual(hidden.boardShapes, prepared.boardShapes);
assert.deepEqual(hidden.tracks, prepared.tracks);
assert.deepEqual(hidden.vias, prepared.vias);
assert.equal(hidden.texts.get('text'), prepared.texts[0]);
assert.equal(hidden._placementOverrides.get('U1').rotation, 90);
assert.equal(hidden._isDirty, false);
assert.equal(hidden.cutRefreshes, 1, 'Hidden loading only clears the previous document cuts');

calls.length = 0;
const active = makeApp(true);
loadPcb(active, data, prepared);
assert.deepEqual(calls, ['viewport', 'grid', 'outline', 'placements', 'track', 'via', 'shape', 'text', 'clearance', 'ratsnest', 'fills'],
    'active loads still render immediately');
assert.equal(active.cutRefreshes, 2, 'Active loading clears old cuts and refreshes once after all shapes');

calls.length = 0;
loadPcb(hidden, null, { tracks: [], vias: [], texts: [], boardShapes: [], shapeIdCounter: 1 });
assert.deepEqual(calls, ['viewport']);
assert.equal(hidden._boardOutlineDrawn, false);
assert.deepEqual(hidden.boardShapes, []);
assert.equal(hidden._placementOverrides.size, 0);
console.log('PASS: hidden PCB loading restores models and settings without rendering or derived copper work');

const pcbSource = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
let components = [];
const methodDependencies = {
    ...dependencies, window: { app: {} }, extractComponents: () => components, extractNetlist: () => [],
    getPcbSelection: () => [], refreshBoxSelectionHighlights() {}, updateGridDropdown() {},
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
        activate: method('activate'), preload: method('preload'), _syncFromSchematic: method('_syncFromSchematic'),
        _renderPersistentObjects: method('_renderPersistentObjects'),
        initialize() {}, _hookSchematicChanges() {}, _updateCursorForTool() {}, _updateViewportStatus() {},
        _setPcbStatus() {}, _setStatus() {}, _fitToPlacedContent() {},
        _clearPCBContent() { this.placements.clear(); calls.push('clear'); },
        _placeFootprints: record('footprints'), _updateRatsnest: record('ratsnest'),
        _showBoardDimensionsDialog: record('dimensions-dialog'),
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
    calls.length = 0;
    app.activate();
    for (const name of ['shape', 'track', 'via', 'text', 'outline', 'clearance', 'ratsnest', 'fills']) {
        assert.equal(calls.filter(call => call === name).length, 0, `${name} is already rendered before activation (components=${withComponents})`);
    }
    assert.equal(calls.includes('dimensions-dialog'), false, 'restored board dimensions do not prompt again');
    assert.equal(app._stale, false);
    calls.length = 0;
    app.activate();
    assert.equal(calls.includes('shape'), false, 'repeated activation does not rebuild unchanged images');
}
console.log('PASS: first activation renders each restored image once, with or without schematic components');

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null };
const { preparePcb, serializePcb } = await import('../src/pcb/modules/project-state.js');
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
assert.deepEqual(snapshot.board, data.board);
assert.deepEqual(snapshot.boardShapes, saved.boardShapes, 'saving before activation preserves encoded geometry and pose');
assert.deepEqual(snapshot.placements, data.placements);
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