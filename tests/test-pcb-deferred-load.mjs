import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { PANEL_DEFAULTS } from '../src/core/pcb-panelization.js';
import { setBoardViewPanel } from '../src/pcb/modules/refresh-state.js';

// Real renderers run against this minimal SVG DOM. Each layer group reports what
// lands in it, so render order is observed where the editor's DOM receives it.
function svgElement(tagName = 'g') {
    return {
        tagName, attributes: new Map(), children: [], parentNode: null, style: {}, dataset: {}, textContent: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        removeAttribute(name) { this.attributes.delete(name); },
        hasAttribute(name) { return this.attributes.has(name); },
        appendChild(child) {
            child.parentNode?.removeChild(child);
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        insertBefore(child) { return this.appendChild(child); },
        removeChild(child) {
            this.children = this.children.filter(other => other !== child);
            child.parentNode = null;
            return child;
        },
        remove() { this.parentNode?.removeChild(this); },
        get firstChild() { return this.children[0] || null; },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        querySelectorAll(selector) {
            const matches = child => selector.startsWith('#')
                ? child.getAttribute('id') === selector.slice(1)
                : selector.startsWith('.') && (child.getAttribute('class') || '').split(' ').includes(selector.slice(1));
            return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
        },
    };
}
const storage = new Map();
let onDesignDefaultsSaved = null;
globalThis.window = { addEventListener() {}, dispatchEvent() {} };
globalThis.document = {
    createElementNS: (namespace, tagName) => svgElement(tagName), createElement: tagName => svgElement(tagName),
    body: svgElement('body'), documentElement: { getAttribute: () => 'dark' }, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
};
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) {
        storage.set(key, value);
        if (key === 'clearpcb_pcb_design_params') onDesignDefaultsSaved?.(JSON.parse(value));
    },
    removeItem: key => storage.delete(key),
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.HTMLElement = class {};

const { loadPcb, preparePcb, serializePcb } = await import('../src/pcb/modules/project-state.js');
const { getBoardOutline } = await import('../src/shared/pcb/board-outline.js');
const { initializeBoardOutlineState, isBoardOutlineDrawn } = await import('../src/pcb/modules/board-outline-resize.js');
const { renderText } = await import('../src/pcb/modules/pcb-text-render.js');
const { Track } = await import('../src/shapes/track.js');
const { Via } = await import('../src/shapes/via.js');
const { Pad } = await import('../src/shapes/pad.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { createPcbText } = await import('../src/core/pcb-text.js');
const { pictureShape } = await import('../src/shared/pcb/picture-raster.js');
const { serializeBoardShapes } = await import('../src/pcb/modules/board-shapes.js');

const calls = [];
const previews = [];
const record = name => () => calls.push(name);
/** Consecutive duplicates collapse: one entity may append several elements to its group. */
const events = () => calls.filter((call, index) => call !== calls[index - 1]);
// Which entity an append into each group represents (the fixture keeps them on distinct layers).
const GROUP_EVENTS = {
    'bottom-copper': 'track', vias: 'via', 'top-copper': 'pad',
    'top-silk': 'shape', 'top-document': 'text', hole: 'shape', 'board-outline': 'outline',
};
function layerGroups() {
    const groups = new Map();
    return id => {
        // The ratsnest reconcile draws into this group; asking for it is the observable step.
        if (id === 'ratlines') calls.push('ratsnest');
        if (!groups.has(id)) {
            const group = svgElement('g');
            const append = group.appendChild;
            group.appendChild = function (child) {
                if (GROUP_EVENTS[id]) calls.push(GROUP_EVENTS[id]);
                return append.call(this, child);
            };
            groups.set(id, group);
        }
        return groups.get(id);
    };
}
const viewportStub = (extra = {}) => ({
    units: 'mm', gridSize: 1, gridStyle: 'lines', gridVisible: true, snapToGrid: true,
    setUnits(units) { this.units = units; }, setGridStyle(style) { this.gridStyle = style; },
    setGridVisible(visible) { this.gridVisible = visible; },
    setGridSize(size) { this.gridSize = size; calls.push('grid'); },
    fitToBounds() {},
    getGridOptions: () => [{ value: 0.5, label: '0.5 mm' }, { value: 1, label: '1 mm' }],
    ...extra,
});

const pictureArt = { ...pictureShape({ width: 3, height: 3, rectangles: [{ x: 0, y: 0, width: 3, height: 1 }] },
    { widthMm: 6, layer: 'top-silk', center: { x: 20, y: -12 } }), id: 'image' };
// A board hole affects copper cuts, so rendering it without the batch flag would refresh cuts early.
const boardHole = { id: 'board-hole', kind: 'circle', layer: 'hole', x: 30, y: -15, radius: 1, lineWidth: 0.1, filled: true };
const authored = new PcbDocument();
authored.tracks.push(new Track({ net: 'N', layer: 'bottom-copper', points: [{ x: 2, y: -2 }, { x: 8, y: -2 }] }));
authored.vias.push(new Via({ x: 8, y: -2 }));
authored.pads.push(new Pad({ x: 12, y: -4, layers: 'top-copper' }));
authored.texts.set('text', createPcbText({ id: 'text', content: 'T', x: 3, y: -6, layer: 'top-document' }));
authored.boardShapes.push(pictureArt, boardHole,
    new CopperFill({ id: 'fill_1', layer: 'top-copper', outline: [{ x: 1, y: -1 }, { x: 10, y: -1 }, { x: 10, y: -10 }] }));
const data = {
    ...authored.serialize(),
    stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
    design: { trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3, units: 'mm', router: 'pathfinder' },
    board: { width: 43, height: 27, radius: 2 }, settings: { gridSize: 0.5 },
    placements: { U1: { x: 3, y: -5, rotation: 90, locked: true } } };
const prepared = PcbDocument.prepare(data);
const makeApp = active => {
    const pcbDocument = new PcbDocument();
    const placementState = pcbDocument.placementState;
    const app = {
        pcbDocument, designSettings: pcbDocument.designSettings,
        // renderPanelPreview(app) reads this as its default argument at the moment it renders.
        get panelization() {
            previews.push({ app: this, settings: pcbDocument.serializePanelization() });
            return pcbDocument.panelization;
        },
        set panelization(value) { pcbDocument.loadPanelization(value); },
        _active: active, _stale: false, tracks: pcbDocument.tracks, vias: pcbDocument.vias, pads: pcbDocument.pads,
        boardShapes: pcbDocument.boardShapes, texts: pcbDocument.texts,
        get _shapeIdCounter() { return pcbDocument.shapeIdCounter; },
        set _shapeIdCounter(value) { pcbDocument.shapeIdCounter = value; },
        get _boardWidth() { return pcbDocument.board.width; },
        set _boardWidth(value) { pcbDocument.board.width = value; },
        get _boardHeight() { return pcbDocument.board.height; },
        set _boardHeight(value) { pcbDocument.board.height = value; },
        get _boardRadius() { return pcbDocument.board.radius; },
        set _boardRadius(value) { pcbDocument.board.radius = value; },
        placements: new Map([['U1', {}]]), _shapeElements: new Map(),
        placementState, _placementOverrides: placementState.overrides, history: { clear() {} },
        viewport: viewportStub(),
        _ensureViewport: record('viewport'), getLayerGroup: layerGroups(), getRoutingParams: () => ({}),
        _applyPlacementOverrides: record('placements'),
        refreshClearanceHalos: record('clearance'), refreshFills: record('fills'),
        updateCopperCuts() { this.cutRefreshes = (this.cutRefreshes || 0) + 1; },
        markSectionClean() { this._isDirty = false; },
    };
    initializeBoardOutlineState(app, false);
    return app;
};
// Design settings presentation saves the adopted values as defaults. Its storage errors are
// caught and logged, so snapshots are recorded here and checked once loading returns.
let designApp = null;
const designSaves = [];
onDesignDefaultsSaved = values => designSaves.push({
    values, rotation: designApp?._placementOverrides.get('U1')?.rotation,
});
const load = (app, loaded, ...rest) => {
    designApp = app;
    designSaves.length = 0;
    try { loadPcb(app, loaded, ...rest); } finally { designApp = null; }
    assert.equal(designSaves.length, loaded?.design ? 1 : 0, 'Loaded design settings are presented once');
    for (const save of designSaves) {
        assert.deepEqual(save.values, loaded.design, 'Presentation reads settings already adopted by the model');
        assert.equal(save.rotation, 90, 'Content adoption includes saved placements');
    }
};

const hidden = makeApp(false);
let cancelledComponentPreview = false;
hidden._cancelPosePreviews = () => { cancelledComponentPreview = true; };
const textMap = hidden.pcbDocument.texts;
const oldText = createPcbText({ id: 'old-text', content: 'Old', x: 0, y: 0, layer: 'top-document' });
hidden.texts.set(oldText.id, oldText);
const oldTextLayer = hidden.getLayerGroup('top-document');
renderText(hidden, oldText);
assert.equal(oldTextLayer.children.length, 1);
calls.length = 0;
load(hidden, data, prepared);
assert.equal(oldTextLayer.children.length, 0, 'Old text SVG is removed before the model is cleared');
assert.equal(cancelledComponentPreview, true, 'Loading ends component projections before replacing their model');
assert.equal(hidden.texts, textMap, 'Loading preserves the project-owned text map');
assert.equal(textMap.has(oldText.id), false);
assert.deepEqual(events(), ['viewport', 'grid'], 'hidden load does not render objects or compute derived copper');
assert.equal(hidden._stale, true);
assert.equal(isBoardOutlineDrawn(hidden), true, 'saved dimensions remain available before rendering');
assert.deepEqual([hidden._boardWidth, hidden._boardHeight, hidden._boardRadius], [43, 27, 2]);
assert.deepEqual(hidden.boardShapes, prepared.boardShapes);
assert.deepEqual(hidden.tracks, prepared.tracks);
assert.deepEqual(hidden.vias, prepared.vias);
assert.deepEqual(hidden.pads, prepared.pads);
assert.equal(hidden.texts.get('text'), prepared.texts[0]);
assert.equal(hidden._placementOverrides.get('U1').rotation, 90);
assert.equal(hidden._placementOverrides.get('U1').locked, true);
assert.equal(hidden._isDirty, false);
assert.deepEqual(hidden.designSettings.values, data.design);
assert.equal(hidden.cutRefreshes, 1, 'Hidden loading only clears the previous document cuts');

calls.length = 0;
const active = makeApp(true);
load(active, data, PcbDocument.prepare(data));
assert.deepEqual(events(), ['viewport', 'grid', 'outline', 'placements', 'track', 'via', 'pad', 'shape', 'text',
    'clearance', 'fills', 'ratsnest', 'fills'], 'active loads still render immediately');
assert.equal(active.cutRefreshes, 2, 'Active loading clears old cuts and refreshes once after all shapes');

{
    const saved = { stackup: data.stackup, boardShapes: [
        { id: 'outline', kind: 'circle', layer: 'board-outline', x: 30, y: -20, radius: 10 },
    ] };
    calls.length = 0;
    load(makeApp(true), saved, PcbDocument.prepare(saved));
    assert.equal(calls.filter(call => call === 'outline').length, 1);
    assert.equal(calls.includes('outline-shape'), false, 'Active loading must not render the saved outline twice');
}

for (const active of [true, false]) {
    const paneApp = makeApp(active);
    // Without a viewport the preview stops after reading its settings (no panel raster).
    paneApp.viewport = null;
    const panelization = { ...PANEL_DEFAULTS, rows: 3, noteCreated: true };
    const stages = [];
    const stage = name => {
        if (name === 'refreshFills' || stages.at(-1) !== name) stages.push(name);
    };
    const getLayerGroup = paneApp.getLayerGroup;
    paneApp.getLayerGroup = function (id) {
        assert.equal(this.pcbDocument.panelization, null, 'Panel settings stay absent while artwork is restored');
        if (active && id === 'board-outline') stage('drawBoardOutline');
        if (active && id === 'top-document') stage('renderText');
        return getLayerGroup.call(this, id);
    };
    const refreshFills = paneApp.refreshFills;
    paneApp.refreshFills = function (...args) {
        assert.equal(this.pcbDocument.panelization, null, 'Panel settings stay absent while pours are restored');
        stage('refreshFills');
        return refreshFills.apply(this, args);
    };
    const count = previews.length;
    load(paneApp, { ...data, panelization }, { ...PcbDocument.prepare(data), panelization });
    assert.deepEqual(paneApp.pcbDocument.panelization, panelization);
    assert.notEqual(paneApp.pcbDocument.panelization, panelization, 'Loaded settings do not alias their prepared snapshot');
    // The ratsnest reconcile refreshes pours first, then loading refreshes them once more.
    assert.deepEqual(stages, active ? ['drawBoardOutline', 'renderText', 'refreshFills', 'refreshFills'] : []);
    assert.equal(previews.length, count + (active ? 2 : 0));
    if (active) {
        assert.deepEqual(previews.at(-2), { app: paneApp, settings: null },
            'Artwork restoration sees no panel settings yet');
        assert.deepEqual(previews.at(-1), { app: paneApp, settings: panelization },
            'The final preview sees restored model settings');
    }
    load(paneApp, null, { tracks: [], vias: [], pads: [], texts: [], boardShapes: [], shapeIdCounter: 1 });
    assert.equal(paneApp.pcbDocument.panelization, null, 'New removes saved panelization in active and hidden editors');
    assert.deepEqual(paneApp.designSettings.values, data.design, 'New retains last-used design settings');
    assert.equal(paneApp._placementOverrides.size, 0);
}

calls.length = 0;
setBoardViewPanel(hidden, { refresh: record('3d') });
hidden.netlist = [{ net: 'GND' }];
load(hidden, null, { tracks: [], vias: [], texts: [], boardShapes: [], shapeIdCounter: 1 });
assert.equal(textMap.size, 0, 'New clears authoritative text even in the hidden editor');
assert.equal(hidden.texts, textMap);
assert.deepEqual(calls, ['viewport', '3d']);
assert.equal(isBoardOutlineDrawn(hidden), false);
assert.deepEqual(hidden.boardShapes, []);
assert.equal(hidden._placementOverrides.size, 0);
assert.equal(hidden.placements.size, 0);
assert.deepEqual(hidden.netlist, []);
console.log('PASS: hidden PCB loading restores models and settings without rendering or derived copper work');

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { copperCutState, hasCopperCuts } = await import('../src/pcb/modules/copper-cuts.js');
let components = [];
for (const withComponents of [false, true]) {
    components = withComponents ? [{ id: 'U1' }] : [];
    const app = makeApp(false);
    Object.assign(app, {
        project: { schematicDocument: {},
            synchronizePcbLayout: () => ({ placements: new Map(components.map(component => [component.id, component])), netlist: [] }) },
        activate: PCBApp.prototype.activate, preload: PCBApp.prototype.preload,
        _syncFromSchematic: PCBApp.prototype._syncFromSchematic,
        _renderPersistentObjects: PCBApp.prototype._renderPersistentObjects,
        initialize() {}, _updateViewportStatus() {},
        _retainRibbonHeight: record('ribbon-height'),
        viewport: viewportStub({ _onResize: record('viewport-resize') }),
        setPcbStatus() {}, setStatus() {}, _fitToPlacedContent() {},
        _clearPCBContent() { this.placements.clear(); calls.push('clear'); },
        _placeFootprints: record('footprints'), updateRatsnest: record('ratsnest'),
        _showBoardDimensionsDialog: record('dimensions-dialog'),
    });
    setBoardViewPanel(app, { refresh: record('3d') });
    Object.defineProperty(app, 'copperFills', { get: () => app.boardShapes.filter(shape => shape.type === 'fill') });
    load(app, data, PcbDocument.prepare(data));
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
    if (withComponents) assert.ok(calls.indexOf('footprints') < calls.indexOf('shape'),
        'Free-standing artwork renders after footprint artwork');
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

for (const pcb of [
    null,
    { settings: { units: 'mm', gridSize: 0.5 } },
    { board: { width: 43, height: 27, radius: 2 } },
    { boardShapes: [{ id: 'round-board', kind: 'circle', layer: 'board-outline', x: 30, y: -20, radius: 10 }] },
    { boardShapes: [{ id: 'polygon-board', kind: 'polygon', layer: 'board-outline',
        points: [{ x: 10, y: -20 }, { x: 40, y: -20 }, { x: 30, y: -5 }] }] },
]) {
    for (const [preload, withComponents] of [[false, false], [false, true], [true, false], [true, true]]) {
        const pcbDocument = new PcbDocument();
        if (pcb) pcbDocument.load({ ...pcb, stackup: data.stackup });
        const before = pcbDocument.serializeSection();
        const outline = getBoardOutline(pcbDocument);
        const app = new PCBApp({ pcbDocument, schematicDocument: {},
            synchronizePcbLayout: () => ({ placements: new Map(components.map(component => [component.id, component])), netlist: [] }) });
        assert.equal(app.isBoardOutlineDrawn(), !!outline, 'Editor attachment recognizes an existing model outline');
        components = withComponents ? [{ id: 'U1' }] : [];
        Object.assign(app, {
            initialize() {}, _ensureViewport() {}, _retainRibbonHeight() {},
            _syncPcbHomeToolHighlight() {}, _updateViewportStatus() {},
            setPcbStatus() {}, setStatus() {}, _clearPCBContent() {},
            getLayerGroup: layerGroups(),
            _placeFootprints: record('footprints'), _fitToPlacedContent() {},
            refreshClearanceHalos() {}, updateRatsnest() {}, updateCopperCuts() {},
            _showBoardDimensionsDialog: record('dimensions-dialog'),
            viewport: viewportStub({ _onResize() {} }),
        });
        calls.length = 0;
        if (preload) {
            assert.equal(app.preload(), true);
            assert.equal(app._active, false);
        }
        app.activate();
        assert.equal(calls.filter(call => call === 'outline').length, outline ? 1 : 0,
            'Existing outlines are restored exactly once, including hidden preload');
        assert.equal(calls.includes('outline-shape'), false, 'Rebuilds must not render the outline again with other artwork');
        assert.equal(calls.includes('dimensions-dialog'), !outline,
            'Only boards without an outline need the dimensions prompt');
        assert.equal(getBoardOutline(pcbDocument), outline, 'Attachment preserves outline identity');
        assert.deepEqual(pcbDocument.serializeSection(), before, 'Attachment and activation do not edit authored data');
        assert.equal(app.isSectionDirty(), false);
    }
}
const { compactProjectAliases } = await import('../src/core/project-field-aliases.js');
const artwork = { width: 20, height: 20, circles: [{ x: Math.PI, y: 5, radius: 1 / 3 }] };
const image = { ...pictureShape(artwork, { widthMm: 12, layer: 'top-silk' }), id: 'pshape_1' };
const saved = { ...data, boardShapes: serializeBoardShapes({ boardShapes: [image] }) };
const restored = makeApp(false);
restored.getRoutingParams = () => ({ trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 });
restored._getRouterMode = () => 'pathfinder';
load(restored, saved, preparePcb(saved));
const snapshot = serializePcb(restored);
const expectedSaved = compactProjectAliases({ pcb: saved }).pcb;
assert.deepEqual(snapshot.board, expectedSaved.board);
assert.deepEqual(snapshot.boardShapes.slice(0, -1), expectedSaved.boardShapes, 'saving before activation preserves existing encoded artwork');
assert.equal(restored.boardShapes.at(-1).layer, 'board-outline', 'Legacy dimensions acquire model geometry before activation');
assert.deepEqual(snapshot.placements, expectedSaved.placements);
assert.deepEqual(restored.boardShapes[0].artwork, artwork);
console.log('PASS: image geometry, board dimensions, and placements survive save before first activation');

const clipDefs = svgElement('defs');
let geometryCalls = 0;
const updateCuts = PCBApp.prototype.updateCopperCuts;
let visibleBounds = { minX: 0, minY: 0, maxX: 30, maxY: 20 };
const removal = { id: 'cut', kind: 'circle', x: 5, y: 5, radius: 2,
    layer: 'top-copper', copperMode: 'remove-copper', filled: true, lineWidth: 0.2 };
const cutShapes = [removal];
const clipApp = {
    // Resolving one side's cut geometry reads the board shapes exactly once.
    get boardShapes() { geometryCalls++; return cutShapes; },
    _ensureSvgDefs: () => clipDefs,
    viewport: { getVisibleBounds: () => visibleBounds },
    _layerGroups: new Map(['top-copper', 'bottom-copper', 'top-fill', 'bottom-fill'].map(id => [id, svgElement('g')])),
    existingLayerGroups() { return this._layerGroups; },
};
const currentPath = () => clipDefs.querySelector('#pcb-copper-cut-top')?.firstChild?.attributes.get('d');
updateCuts.call(clipApp, { geometryChanged: false });
assert.equal(geometryCalls, 2, 'A view-only call initializes an empty geometry cache');
const firstPath = currentPath();
const firstGeometry = copperCutState(clipApp).geometry.top;
visibleBounds = { minX: -10, minY: -5, maxX: 50, maxY: 35 };
updateCuts.call(clipApp, { geometryChanged: false });
assert.equal(geometryCalls, 2, 'Pan and zoom reuse both sides without resolving geometry');
assert.notEqual(currentPath(), firstPath, 'Viewport clipping bounds still update');
assert.equal(copperCutState(clipApp).geometry.top, firstGeometry);
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
assert.equal(clipApp._layerGroups.get('top-fill').getAttribute('data-copper-cut'), null);
assert.equal(clipApp._layerGroups.get('bottom-fill').getAttribute('data-copper-cut'), 'pcb-copper-cut-bottom');
removal.layer = 'hole';
updateCuts.call(clipApp);
assert.ok(currentPath(), 'Board holes clip both sides');
assert.ok(clipDefs.querySelector('#pcb-copper-cut-bottom'));
clipDefs.querySelector('#pcb-copper-cut-top').remove();
const beforeRebuild = geometryCalls;
updateCuts.call(clipApp, { geometryChanged: false });
assert.ok(currentPath(), 'Missing SVG clip is restored from cached geometry');
assert.equal(geometryCalls, beforeRebuild);
cutShapes.length = 0;
updateCuts.call(clipApp);
assert.equal(hasCopperCuts(clipApp), false, 'Deleting the last cut clears the active flag');
for (const side of ['top', 'bottom']) {
    assert.equal(clipDefs.querySelector(`#pcb-copper-cut-${side}`), null);
    assert.equal(clipApp._layerGroups.get(`${side}-copper`).attributes.has('clip-path'), false);
    assert.equal(clipApp._layerGroups.get(`${side}-fill`).getAttribute('data-copper-cut'), null);
}
const afterDelete = geometryCalls;
updateCuts.call(clipApp, { geometryChanged: false });
assert.equal(geometryCalls, afterDelete, 'Empty cut geometry is cached too');
console.log('PASS: viewport copper-cut cache, edit/undo invalidation, layer changes, SVG rebuild and deletion');

globalThis.window = { addEventListener() {} };
Object.defineProperty(window, 'app', {
    get() { assert.fail('PCB synchronization must not read the global schematic'); },
});
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
globalThis.HTMLElement = class {};
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');
const project = new ProjectDocument();
let syncs = 0, placed = new Map();
const pcb = Object.assign(Object.create(PCBApp.prototype), {
    pcbDocument: project.pcbDocument,
    project: null, _active: true, _stale: true, boardShapes: [],
    _ensureViewport() { syncs++; }, _clearPCBContent() {}, _renderPersistentObjects() {},
    _placeFootprints(items) { placed = items; }, getLayerGroup: () => null,
    refreshClearanceHalos() {}, updateRatsnest() {}, _fitToPlacedContent() {}, setStatus() {},
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
assert.equal(placed.get('owned').reference, 'U1', 'Model synchronization works without a schematic view');
assert.equal(pcb._stale, false);
syncs = 0;
const schematic = Object.assign(Object.create(SchematicApp.prototype), {
    project, document: project.schematicDocument, fileManager: project.fileManager,
    ui: { docTitle: {
        set textContent(value) { notifications.push('title'); this.value = value; },
        get textContent() { return this.value || ''; },
        title: '',
    } },
    _updateUndoRedoButtons: () => notifications.push('history'),
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
    assert.equal(placed.get('owned').reference, 'U2', 'Sync consumes the latest project model data');
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