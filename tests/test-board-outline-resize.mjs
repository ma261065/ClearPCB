import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PcbDocument } from '../src/core/PcbDocument.js';
globalThis.window = { addEventListener() {} };
const inputs = new Map([
    ['pcbPropBoardW', { value: '100' }], ['pcbPropBoardH', { value: '80' }],
]);
globalThis.document = { getElementById: id => inputs.get(id) || null };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const dimensionPrototype = Object.create(null, Object.fromEntries(['_boardWidth', '_boardHeight', '_boardRadius']
    .map(key => [key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key)])));
const { boardOutlineHandles, renderBoardOutlineHandles, beginBoardOutlineResize, updateBoardOutlineResize, endBoardOutlineResize } =
    await import('../src/pcb/modules/board-outline-resize.js');
const { PCB_LAYERS } = await import('../src/pcb/modules/layers.js');
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const commands = [];
const source = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
const syncStart = source.indexOf('    _syncBoardOutlineInputs() {');
const syncEnd = source.indexOf('\n    /**', syncStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart);
const syncInputs = new Function(`return ({ ${source.slice(syncStart, syncEnd)} })._syncBoardOutlineInputs;`)();
{
    const { boardBoundary } = await import('../src/pcb/modules/board-outline.js');
    const fitStart = source.indexOf('    _fitToContent() {');
    const fitEnd = source.indexOf('\n    _bindRibbonTabs()', fitStart);
    assert.ok(fitStart >= 0 && fitEnd > fitStart);
    const fit = new Function('boardBoundary',
        `return ({ ${source.slice(fitStart, fitEnd)} })._fitToContent;`)(boardBoundary);
    const helper = { childNodes: [{}], getBBox() { return { x: -10000, y: -10000, width: 20000, height: 20000 }; } };
    const outlines = [
        { kind: 'rect', points: [{ x: 120, y: 40 }, { x: 180, y: 40 }, { x: 180, y: 70 }, { x: 120, y: 70 }] },
        { kind: 'circle', x: -30, y: 20, radius: 15 },
        { kind: 'polygon', points: [{ x: 0, y: -80 }, { x: 100, y: -80 }, { x: 100, y: 0 }, { x: 0, y: 0 }],
            segmentBulges: { 1: -0.5 } },
    ];
    for (const geometry of outlines) {
        const calls = [];
        let unculled = 0;
        const board = {
            boardShapes: [{ id: 'board-outline', layer: 'board-outline', ...geometry }],
            _boardOutlineDrawn: true, _boardWidth: 100, _boardHeight: 80,
            _ensureViewport() {}, _uncullAllPlacements() { unculled++; },
            viewport: { fitToBounds(...bounds) { calls.push(bounds); } },
            _layerGroups: new Map([
                ['selection-overlay', helper], ['clearance', helper], ['ratlines', helper], ['drc-overlay', helper],
                ['board-outline', { childNodes: [{}], getBBox() { throw new Error('Use the outline model, not its SVG bounds'); } }],
            ]),
        };
        const bounds = boardBoundary(board);
        const expectedFit = [
            Math.min(0, bounds.x) - 10,
            Math.min(0, bounds.y),
            Math.max(0, bounds.x + bounds.w),
            Math.max(0, bounds.y + bounds.h) + 10,
            0, 'bottom-left',
        ];
        fit.call(board);
        assert.deepEqual(calls.at(-1), expectedFit,
            `${geometry.kind}: helpers must not affect board framing`);
        assert.equal(unculled, 0, 'Fitting the outline does not need to reveal culled artwork');
        board._layerGroups.set('top-silk', { childNodes: [{}], getBBox() {
            return { x: bounds.x - 20, y: bounds.y, width: 5, height: 5 };
        } });
        fit.call(board);
        assert.deepEqual(calls.at(-1), expectedFit,
            'Off-board artwork must not affect board framing');
    }
    const legacy = { _boardOutlineDrawn: true, _boardWidth: 40, _boardHeight: 30, boardShapes: [],
        _ensureViewport() {}, _uncullAllPlacements() {}, _layerGroups: new Map([['selection-overlay', helper]]),
        viewport: { fitToBounds(...bounds) { assert.deepEqual(bounds, [-10, -30, 40, 10, 0, 'bottom-left']); } } };
    fit.call(legacy);
}
let redraws = 0;
let fills = 0;
const fillDimensions = [];
const app = Object.assign(Object.create(dimensionPrototype), {
    pcbDocument: new PcbDocument(),
    _shapeElements: new Map(),
    _boardOutlineSelected: true, _boardOutlineDrawn: true,
    _boardWidth: 100, _boardHeight: 80, _boardRadius: 3,
    viewport: { scale: 10, snapToGrid: true, gridVisible: true, gridSize: 1 },
    _drawBoardOutline() { redraws++; },
    _refreshFills() {
        fills++;
        fillDimensions.push([this._boardWidth, this._boardHeight, this._boardRadius]);
    },
    _syncBoardOutlineInputs: syncInputs,
    history: { execute(command) { commands.push(command); command.execute(); } },
});
assert.equal(boardOutlineHandles(app).length, 3);
assert.ok(beginBoardOutlineResize(app, { x: 100, y: -80 }));
updateBoardOutlineResize(app, { x: 110.2, y: -85.2 });
assert.deepEqual([app._boardWidth, app._boardHeight, app._boardRadius], [110, 85, 3]);
assert.deepEqual(app.pcbDocument.board, { width: 100, height: 80, radius: 3 },
    'Live resize preserves the project model until committing');
await assert.rejects(prepareFabricationSnapshot(app, { computeFills: false }),
    /Finish the current edit before exporting/, 'Export must not capture uncommitted model dimensions');
assert.deepEqual([...inputs.values()].map(input => input.value), ['110.00', '85.00'], 'Spinners update before mouse-up');
assert.equal(commands.length, 0, 'Updating spinners must not commit the active drag');
assert.equal(app._suspendBoardViewRefresh, true);
assert.equal(fills, 0);
updateBoardOutlineResize(app, { x: 110.3, y: -85.3 });
assert.equal(redraws, 1);
endBoardOutlineResize(app);
assert.equal(commands.length, 1);
assert.equal(fills, 1);
assert.deepEqual(fillDimensions, [[110, 85, 3]], 'Commit refreshes pours once with the new dimensions');
assert.equal(app._suspendBoardViewRefresh, false);
commands[0].undo();
assert.equal(fills, 2, 'Undo refreshes pours once');
assert.deepEqual(fillDimensions.at(-1), [100, 80, 3], 'Undo refresh uses the restored dimensions');
assert.deepEqual([app._boardWidth, app._boardHeight], [100, 80]);
assert.deepEqual(app.pcbDocument.serializeBoardDimensions(), { width: 100, height: 80, radius: 3 });
assert.deepEqual([...inputs.values()].map(input => input.value), ['100.00', '80.00'], 'Undo updates the dimension spinners');
commands[0].execute();
assert.equal(fills, 3, 'Redo refreshes pours once');
assert.deepEqual(fillDimensions.at(-1), [110, 85, 3], 'Redo refresh uses the reapplied dimensions');
assert.deepEqual([app._boardWidth, app._boardHeight], [110, 85]);
assert.deepEqual([...inputs.values()].map(input => input.value), ['110.00', '85.00'], 'Redo updates the dimension spinners');
assert.ok(beginBoardOutlineResize(app, { x: 110, y: -42.5 }));
updateBoardOutlineResize(app, { x: -10, y: -60 });
assert.deepEqual([app._boardWidth, app._boardHeight], [5, 85]);
assert.deepEqual([...inputs.values()].map(input => input.value), ['5.00', '85.00'], 'Spinners reflect minimum size and the unchanged axis');
endBoardOutlineResize(app, false);
assert.deepEqual([app._boardWidth, app._boardHeight], [110, 85]);
assert.equal(fills, 3, 'Cancelled preview does not trigger another pour rebuild');
assert.equal(commands.length, 1);
assert.ok(beginBoardOutlineResize(app, { x: 55, y: -85 }));
updateBoardOutlineResize(app, { x: 90, y: -95 });
assert.deepEqual([app._boardWidth, app._boardHeight], [110, 95]);
endBoardOutlineResize(app);
app.viewport.snapToGrid = false;
assert.ok(beginBoardOutlineResize(app, { x: 110, y: -95 }));
updateBoardOutlineResize(app, { x: 110.12345, y: -95.98765 });
assert.deepEqual([...inputs.values()].map(input => input.value), ['110.12', '95.99'], 'Unsnapped dimensions display two decimal places');
assert.deepEqual([app._boardWidth, app._boardHeight], [110.12345, 95.98765], 'Display formatting preserves geometry precision');
assert.deepEqual(app.pcbDocument.serializeBoardDimensions(), { width: 110, height: 95, radius: 3 },
    'Serialization excludes the live resize');
endBoardOutlineResize(app, false);
assert.deepEqual(app.pcbDocument.board, { width: 110, height: 95, radius: 3 },
    'Cancelling the preview restores the authoritative dimensions');
app.viewport.snapToGrid = true;
const layer = PCB_LAYERS.find(layer => layer.id === 'board-outline');
layer.locked = true;
assert.deepEqual(boardOutlineHandles(app), []);
assert.equal(beginBoardOutlineResize(app, { x: 110, y: -95 }), false);
layer.locked = false;
app._boardOutlineSelected = false;
assert.deepEqual(boardOutlineHandles(app), []);
const makeElement = () => ({
    attributes: new Map(), children: [], style: {}, parent: null,
    setAttribute(name, value) { this.attributes.set(name, value); },
    appendChild(child) { child.parent = this; this.children.push(child); },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
    querySelectorAll() { return [...this.children]; },
});
globalThis.document = { createElementNS: makeElement, getElementById: id => inputs.get(id) || null };
const overlay = makeElement();
app._getLayerGroup = () => overlay;
app._boardOutlineSelected = true;
for (const scale of [10, 20]) {
    app.viewport.scale = scale;
    renderBoardOutlineHandles(app);
    assert.equal(overlay.children.length, 1, 'Redraw replaces old handles');
    assert.equal(overlay.children[0].children.length, 3);
    for (const handle of overlay.children[0].children) {
        assert.equal(Number(handle.attributes.get('width')) * scale, 8, 'Handles remain 8 screen pixels');
    }
}
layer.visible = false;
renderBoardOutlineHandles(app);
assert.equal(overlay.children.length, 0);
assert.equal(beginBoardOutlineResize(app, { x: 110, y: -95 }), false);
layer.visible = true;
renderBoardOutlineHandles(app);
app._boardOutlineSelected = false;
renderBoardOutlineHandles(app);
assert.equal(overlay.children.length, 0);
app._boardOutlineSelected = true;
assert.ok(beginBoardOutlineResize(app, { x: 110, y: -95 }));
updateBoardOutlineResize(app, { x: 120, y: -100 });
layer.locked = true;
updateBoardOutlineResize(app, { x: 125, y: -105 });
assert.equal(app._boardOutlineResize, null);
assert.deepEqual([app._boardWidth, app._boardHeight], [110, 95], 'Locking during a drag restores original dimensions');
layer.locked = false;
console.log('PASS board resize handles, snapping, minimum dimensions, undo/redo, cancellation, and locks');

{
    const { SetBoardOutlineCommand } = await import('../src/pcb/modules/track-commands.js');
    const { getBoardOutline, rectangleBoardOutline, boardBoundary } = await import('../src/pcb/modules/board-outline.js');
    const makeOutlineElement = () => ({
        attributes: new Map(), children: [], style: {},
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name); },
        removeAttribute(name) { this.attributes.delete(name); },
        appendChild(child) { child.parentNode = this; this.children.push(child); },
        removeChild(child) {
            this.children = this.children.filter(element => element !== child);
            child.parentNode = null;
            return child;
        },
        remove() { this.parentNode?.removeChild(this); },
        querySelector(selector) { return this.children.find(child => child.getAttribute('class') === selector.slice(1)) || null; },
        querySelectorAll() { return []; },
    });
    document.createElementNS = makeOutlineElement;
    for (const geometry of [null, { id: 'board-outline', kind: 'circle', layer: 'board-outline',
        x: 35, y: -20, radius: 8 }]) {
        const pcbDocument = new PcbDocument();
        if (geometry) pcbDocument.setBoardOutline(geometry);
        const original = structuredClone(geometry);
        const originalDimensions = { ...pcbDocument.board };
        const outlineLayer = makeOutlineElement();
        const fitCalls = [], stages = [];
        const view = Object.assign(Object.create(dimensionPrototype), {
            pcbDocument, boardShapes: pcbDocument.boardShapes, _shapeElements: new Map(),
            _boardOutlineDrawn: !!geometry,
            viewport: { fitToBounds(...args) { fitCalls.push(args); } },
            _getLayerGroup(id) { return id === 'board-outline' ? outlineLayer : null; },
            _drawBoardOutline() {
                assert.ok(getBoardOutline(pcbDocument), 'The model has adopted the outline before the command invokes rendering');
                stages.push('draw');
                PCBApp.prototype._drawBoardOutline.call(this);
            },
            _syncBoardOutlineInputs() { stages.push('inputs'); syncInputs.call(this); },
            _refreshFills() { stages.push('fills'); },
        });
        const command = new SetBoardOutlineCommand(view, originalDimensions, { width: 40, height: 30, radius: 2 });
        command.execute();
        const outline = getBoardOutline(pcbDocument);
        assert.deepEqual(outline, rectangleBoardOutline(40, 30, 2));
        assert.deepEqual(stages, ['draw', 'inputs', 'fills']);
        assert.equal(outlineLayer.children.length, 1);
        assert.equal(fitCalls.length, geometry ? 0 : 1, 'Only the initial draw fits the viewport');
        assert.deepEqual(pcbDocument.board, { width: 40, height: 30, radius: 2 });
        command.undo();
        assert.deepEqual(outline, original || rectangleBoardOutline(
            originalDimensions.width, originalDimensions.height, originalDimensions.radius));
        command.execute();
        assert.equal(getBoardOutline(pcbDocument), outline);
        assert.equal(outlineLayer.children.length, 1, 'History replaces outline SVG without duplicating it');
        assert.deepEqual(stages, ['draw', 'inputs', 'fills', 'draw', 'inputs', 'fills', 'draw', 'inputs', 'fills']);
        assert.equal(fitCalls.length, geometry ? 0 : 1);
        assert.equal(view._shapeElements.get(outline.id), outlineLayer.children[0]);
    }
    const pcbDocument = new PcbDocument();
    Object.assign(pcbDocument.board, { width: 47.123456, height: 29.234567, radius: 0 });
    const outlineLayer = makeOutlineElement();
    const fitCalls = [];
    const view = Object.assign(Object.create(dimensionPrototype), {
        pcbDocument, boardShapes: pcbDocument.boardShapes, _shapeElements: new Map(),
        _boardOutlineDrawn: false, viewport: { fitToBounds(...args) { fitCalls.push(args); } },
        _getLayerGroup(id) { return id === 'board-outline' ? outlineLayer : null; },
    });
    PCBApp.prototype._drawBoardOutline.call(view);
    assert.equal(getBoardOutline(pcbDocument), null, 'Drawing an empty model must not create authored geometry');
    assert.equal(outlineLayer.children.length, 0);
    assert.equal(view._boardOutlineDrawn, false);
    assert.equal(fitCalls.length, 0);
    const outline = pcbDocument.ensureBoardOutline();
    assert.deepEqual(outline, rectangleBoardOutline(47.123456, 29.234567));
    pcbDocument.ensureBoardOutline = () => assert.fail('Rendering must not invoke model initialization');
    PCBApp.prototype._drawBoardOutline.call(view);
    const bounds = boardBoundary(pcbDocument);
    assert.deepEqual(fitCalls, [[bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h, 5]]);
    const saved = pcbDocument.serialize();
    Object.freeze(pcbDocument.board);
    PCBApp.prototype._drawBoardOutline.call(view);
    assert.deepEqual(pcbDocument.serialize(), saved, 'Dedicated redraw does not write model geometry or dimensions');
    assert.equal(pcbDocument.boardShapes.length, 1);
    assert.equal(outlineLayer.children.length, 1);
    assert.equal(fitCalls.length, 1, 'Explicit initialization and subsequent redraw remain idempotent');
}
console.log('PASS model-owned outline setup, actual draw/undo/redo, viewport fitting and read-only outline lookup');