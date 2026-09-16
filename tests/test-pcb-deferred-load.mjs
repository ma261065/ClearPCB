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
    renderTrack: record('track'), renderVia: record('via'), renderBoardShape: record('shape'),
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

calls.length = 0;
const active = makeApp(true);
loadPcb(active, data, prepared);
assert.deepEqual(calls, ['viewport', 'grid', 'outline', 'placements', 'track', 'via', 'shape', 'text', 'clearance', 'ratsnest', 'fills'],
    'active loads still render immediately');

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
        activate: method('activate'), _syncFromSchematic: method('_syncFromSchematic'),
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
    app.activate();
    for (const name of ['shape', 'track', 'via', 'text', 'outline', 'clearance', 'ratsnest', 'fills']) {
        assert.equal(calls.filter(call => call === name).length, 1, `${name} runs once on activation (components=${withComponents})`);
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