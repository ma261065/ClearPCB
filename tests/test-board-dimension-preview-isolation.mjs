import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { setComputedFill, getComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { getBoardOutline, rectangleBoardOutline, boardBoundary, boardDimensions } from '../src/shared/pcb/board-outline.js';
import { getBoardDimensionPreview, previewBoardDimensions, finishBoardDimensionPreview,
    bindBoardDimensionProperties, beginBoardOutlineResize, updateBoardOutlineResize,
    endBoardOutlineResize, boardOutlineHandles, boardDimensionsDialog, drawBoardOutline,
    initializeBoardOutlineState, setBoardOutlineSelected } from '../src/pcb/modules/board-outline-resize.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { getBoardShapeElement } from '../src/pcb/modules/board-shapes.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { getPropertyEditor } from '../src/pcb/modules/property-editors.js';
import { areDragOverlaysDeferred, isBoardViewRefreshSuspended, setBoardViewPanel, setBoardViewRefreshSuspended, setDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';
import { bindSettledChange, flushSettledChanges } from '../src/shared/ui/settled-input.js';
import { getBoardOutlineResize } from '../src/pcb/modules/board-outline-resize.js';

let allocations = 0;
class Element {
    constructor() { allocations++; this.children = []; this.attributes = new Map(); this.style = {}; this.dataset = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    removeChild(child) { child.remove(); }
    remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
    querySelectorAll(selector) {
        return this.children.filter(child => (child.getAttribute('class') || '').split(' ').includes(selector.slice(1)));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Input {
    constructor(value) { this.value = value; this.listeners = new Map(); this.validity = ''; this.isConnected = true; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    setCustomValidity(message) { this.validity = message; }
    reportValidity() { this.reportedValidity = this.validity; return !this.validity; }
    emit(name, event = {}) { this.listeners.get(name)?.({ preventDefault() {}, stopPropagation() {}, ...event }); }
}
let currentInputs = new Map();
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { createElementNS: () => new Element(), getElementById: id => currentInputs.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [] };
globalThis.localStorage = { setItem() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const layer = PCB_LAYERS.find(item => item.id === 'board-outline');
const fields = { width: 'pcbPropBoardW', height: 'pcbPropBoardH', radius: 'pcbPropBoardR' };

function fixture(existing = true, deferred = false) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const initial = { width: 40.123456789, height: 30.234567891, radius: 2.345678912 };
    Object.assign(model.board, initial);
    if (existing) model.setBoardOutline(rectangleBoardOutline(initial.width, initial.height, initial.radius));
    const fill = new CopperFill({ outline: [{ x: 1, y: -1 }, { x: 10, y: -1 }, { x: 10, y: -10 }] });
    model.boardShapes.push(fill);
    setComputedFill(fill, [{ outer: fill.outline, holes: [] }]);
    const group = new Element();
    let draws = 0, pours = 0, fits = 0, refresh3d = 0;
    const app = {
        project, pcbDocument: model, history: new CommandHistory(), placements: new Map(), netlist: [],
        _active: true, _shapeElements: new Map(), _layerGroups: new Map(), existingLayerGroups() { return this._layerGroups; },
        viewport: { scale: 100, snapToGrid: false, svg: new Element(), fitToBounds() { fits++; },
            hideCrosshair() {} },
        getLayerGroup(id) { if (id === 'board-outline') draws++; return id === 'board-outline' ? group : null; },
        refreshFills() { assert.equal(areDragOverlaysDeferred(this), deferred); pours++; },
        propertiesItems: () => null,
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
        _refreshPcbSelectionHighlights() {},
    };
    setBoardViewPanel(app, { refresh() { refresh3d++; } });
    setDragOverlaysDeferred(app, deferred);
    setBoardViewRefreshSuspended(app, deferred);
    for (const key of ['boardShapes', 'tracks', 'vias', 'pads', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['_cancelPosePreviews', 'isSectionEditing',
        '_onLayerLockChanged', '_onLayerVisibilityChanged', 'clearProperties', 'setPropertiesTitle']) {
        app[key] = PCBApp.prototype[key];
    }
    initializeBoardOutlineState(app, existing);
    setBoardOutlineSelected(app, true);
    project.registerView('pcb', app);
    drawBoardOutline(app);
    const inputs = new Map(Object.entries(fields).map(([key, id]) => [id, new Input(model.board[key].toFixed(2))]));
    currentInputs = inputs;
    const bind = () => {
        const binding = bindBoardDimensionProperties(app, () => {});
        for (const [key, id] of Object.entries(fields)) {
            const input = inputs.get(id);
            input.addEventListener('input', () => {
                const value = parseFloat(input.value);
                binding.setValid(key, Number.isFinite(value));
                if (Number.isFinite(value)) binding.preview(key, value);
            });
            bindSettledChange(input, () => {
                const value = parseFloat(input.value);
                binding.setValid(key, Number.isFinite(value));
                if (Number.isFinite(value)) binding.commit();
                else {
                    binding.cancel();
                    input.value = String(model.board[key]);
                }
            });
            input.addEventListener('keydown', event => {
                if (event.key !== 'Escape') return;
                binding.cancel();
                event.preventDefault();
                event.stopPropagation();
            });
        }
        return binding;
    };
    return { app, model, fill, group, inputs, bind, draws: () => draws, pours: () => pours,
        fits: () => fits, refresh3d: () => refresh3d };
}

let cases = 0;
for (const mode of ['width', 'height', 'both', 'property-width', 'property-height', 'property-radius']) {
    for (const deferred of [false, true]) for (const finish of ['commit', 'cancel', 'failure', 'replace', 'lock', 'hide', 'load', 'deactivate']) {
        const numeric = mode.startsWith('property-');
        const { app, model, fill, group, inputs, bind, draws, pours, fits } = fixture(!numeric, deferred);
        const geometry = model.captureGeometry(), serialized = model.serialize(), board = { ...model.board };
        const canonical = getBoardOutline(model), originalShapes = model.boardShapes, computed = getComputedFill(fill);
        const corners = canonical?.points, field = mode.slice('property-'.length);
        const binding = numeric ? bind() : null;
        let update;
        if (numeric) {
            const input = inputs.get(fields[field]);
            update = () => { input.value = String(board[field] + 5.123456789); input.emit('input'); };
        } else {
            const start = boardOutlineHandles(app).find(handle => handle.id === mode);
            assert.equal(beginBoardOutlineResize(app, start), true);
            updateBoardOutlineResize(app, start);
            assert.equal(getBoardDimensionPreview(app), undefined, 'Unchanged pickup creates no copy');
            update = () => updateBoardOutlineResize(app, { x: start.x + 5.123456789, y: start.y - 7.234567891 });
        }
        update();
        const preview = getBoardDimensionPreview(app), shape = preview.outline, collection = app.boardShapes;
        const points = shape.points, firstPoint = points[0], work = allocations, drawCount = draws();
        const expected = { ...preview.board };
        for (let index = 0; index < 100; index++) update();
        assert.equal(allocations, work);
        assert.equal(draws(), drawCount, 'Repeated unchanged dimensions do no SVG work');
        assert.equal(getBoardDimensionPreview(app).outline, shape);
        assert.equal(app.boardShapes, collection);
        assert.equal(shape.points, points);
        assert.equal(shape.points[0], firstPoint);
        assert.deepEqual(model.captureGeometry(), geometry);
        assert.deepEqual(model.serialize(), serialized);
        assert.deepEqual(model.board, board);
        assert.equal(model.boardShapes, originalShapes);
        assert.equal(canonical?.points, corners);
        assert.equal(getComputedFill(fill), computed);
        assert.equal(pours(), 0);
        assert.equal(fits(), 0, 'Live preview never fits the viewport');
        assert.equal(group.children.length, 1, 'Exactly one outline SVG');
        assert.equal(getBoardShapeElement(app, shape.id), group.children[0]);
        assert.equal(boardBoundary(app).w, expected.width);
        assert.equal(boardBoundary(app).h, expected.height);
        assert.equal(app.isSectionEditing(), true);
        await assert.rejects(prepareFabricationSnapshot(app), /current edit/i);
        const complete = commit => numeric ? (commit ? binding.commit() : binding.cancel()) : endBoardOutlineResize(app, commit);
        try {
            if (finish === 'commit') {
                const execute = app.history.execute.bind(app.history);
                app.history.execute = command => {
                    assert.equal(getBoardDimensionPreview(app), undefined);
                    assert.equal(app.boardShapes, model.boardShapes);
                    assert.deepEqual(model.captureGeometry(), geometry);
                    execute(command);
                };
                complete(true);
                assert.deepEqual(model.board, expected);
                assert.equal(pours(), 1);
                assert.equal(app.history.undoStack.length, 1);
                const after = model.captureGeometry();
                app.history.undo();
                assert.deepEqual(model.board, board);
                if (canonical) assert.deepEqual(model.captureGeometry(), geometry);
                else assert.deepEqual(getBoardOutline(model), rectangleBoardOutline(board.width, board.height, board.radius),
                    'Existing SetBoardOutlineCommand undo semantics create the previous rectangle');
                app.history.redo();
                assert.deepEqual(model.captureGeometry(), after);
                assert.equal(group.children.length, 1);
            } else {
                if (finish === 'failure') {
                    app.history.execute = () => { throw new Error('Rejected board dimensions'); };
                    assert.throws(() => complete(true), /Rejected board dimensions/);
                } else if (finish === 'replace') {
                    if (canonical) model.boardShapes[model.boardShapes.indexOf(canonical)] = structuredClone(canonical);
                    else model.setBoardOutline(rectangleBoardOutline(board.width, board.height, board.radius));
                    assert.throws(() => complete(true), /no longer available/);
                } else if (finish === 'load') loadPcb(app, null);
                else if (finish === 'deactivate') PCBApp.prototype.deactivate.call(app);
                else if (finish === 'lock') { layer.locked = true; app._onLayerLockChanged(layer.id, true); }
                else if (finish === 'hide') { layer.visible = false; app._onLayerVisibilityChanged(layer.id, false); }
                else {
                    if (canonical) { canonical.points.forEach(Object.freeze); Object.freeze(canonical.points); Object.freeze(canonical); }
                    Object.freeze(model.board);
                    complete(false);
                }
                if (finish !== 'load' && finish !== 'replace') {
                    assert.deepEqual(model.captureGeometry(), geometry);
                    assert.deepEqual(model.serialize(), serialized);
                    assert.equal(getComputedFill(fill), computed);
                }
                assert.equal(app.history.undoStack.length, 0);
                assert.equal(pours(), 0, 'Discard does not rebuild settled fills');
            }
            assert.equal(getBoardDimensionPreview(app), undefined);
            assert.equal(getBoardOutlineResize(app) ?? null, null);
            assert.equal(areDragOverlaysDeferred(app), deferred);
            assert.equal(isBoardViewRefreshSuspended(app), deferred);
            assert.equal(app.boardShapes, model.boardShapes);
            if (finish !== 'load') assert.equal(group.children.length, getBoardOutline(model) ? 1 : 0,
                'Discard/commit leaves only current canonical artwork');
            cases++;
        } finally { layer.locked = false; layer.visible = true; }
    }
}
console.log(`PASS ${cases} generic dimension isolation cases: numeric/resize, serialization, geometry, caches, SVG, precision, work skips and lifecycle`);

{
    const { app, model, inputs, bind, draws } = fixture(false);
    const binding = bind(), before = { ...model.board }, input = inputs.get(fields.width);
    input.emit('change');
    flushSettledChanges();
    assert.equal(app.history.undoStack.length, 0, 'Rounded untouched display does not author dimensions');
    const work = draws();
    input.value = String(before.width + 3);
    input.emit('input');
    const preview = getBoardDimensionPreview(app), point = preview.outline.points[0], shapes = app.boardShapes;
    input.value = String(before.width + 4);
    input.emit('input');
    assert.equal(getBoardDimensionPreview(app), preview);
    assert.equal(preview.outline.points[0], point);
    assert.equal(app.boardShapes, shapes);
    assert.equal(preview.board.height, before.height, 'Untouched height retains full precision');
    assert.equal(preview.board.radius, before.radius, 'Untouched radius retains full precision');
    input.value = String(before.width);
    input.emit('change');
    assert.equal(app.history.undoStack.length, 0, 'Returning to the original dimensions creates no command');
    binding.cancel();
    flushSettledChanges();
    assert.ok(draws() > work);
    input.value = '55.123456789'; input.emit('input');
    input.emit('keydown', { key: 'Escape' });
    input.emit('change');
    flushSettledChanges();
    assert.deepEqual(model.board, before);
    assert.equal(app.history.undoStack.length, 0, 'Escape suppresses the following native change');
    input.value = '56'; input.emit('input');
    input.value = ''; input.emit('change');
    flushSettledChanges();
    assert.equal(input.value, String(before.width));
    assert.equal(binding.active, false, 'Invalid completion cancels an earlier preview');
    binding.cancel();
    input.value = '57'; input.emit('input');
    app.setPropertiesTitle('Other');
    input.value = '58'; input.emit('change');
    flushSettledChanges();
    assert.equal(getBoardDimensionPreview(app), undefined);
    assert.deepEqual(model.board, before, 'Disposed callbacks cannot reauthor the model');
}

for (const numeric of [false, true]) {
    const { app, model, inputs, bind } = fixture();
    const before = model.captureGeometry(), getLayerGroup = app.getLayerGroup;
    app.getLayerGroup = function (id) {
        if (getBoardDimensionPreview(this)) throw new Error('Preview renderer failed');
        return getLayerGroup.call(this, id);
    };
    if (numeric) {
        bind(); inputs.get(fields.width).value = '55';
        assert.throws(() => inputs.get(fields.width).emit('input'), /Preview renderer failed/);
    } else {
        const start = boardOutlineHandles(app).find(handle => handle.id === 'both');
        beginBoardOutlineResize(app, start);
        assert.throws(() => updateBoardOutlineResize(app, { x: start.x + 1, y: start.y }), /Preview renderer failed/);
    }
    assert.equal(getBoardDimensionPreview(app), undefined);
    assert.equal(getBoardOutlineResize(app) ?? null, null);
    assert.equal(areDragOverlaysDeferred(app), false);
    assert.equal(isBoardViewRefreshSuspended(app), false);
    assert.deepEqual(model.captureGeometry(), before);
}
{
    const { app, model } = fixture();
    const before = model.captureGeometry();
    for (const dimensions of [{}, { width: Infinity, height: 10, radius: 0 }, { width: 0, height: 10, radius: 0 }]) {
        assert.throws(() => previewBoardDimensions(app, dimensions), /dimensions/);
    }
    assert.equal(getBoardDimensionPreview(app), undefined);
    assert.deepEqual(model.captureGeometry(), before);
    finishBoardDimensionPreview(app);
}
console.log('PASS precision/no-op/native event sequencing, disposed callbacks, input validation and renderer failure cleanup');

for (const value of ['', '-', 'Infinity', '56']) for (const handoff of ['change', 'commit', 'resize']) {
    const { app, model, inputs, bind } = fixture();
    const before = model.captureGeometry(), binding = bind(), input = inputs.get(fields.width);
    const redo = { execute() {}, undo() {} };
    app.history.redoStack.push(redo);
    input.value = '56'; input.emit('input');
    input.value = value;
    input.emit('input');
    if (handoff === 'change') { input.emit('change'); flushSettledChanges(); }
    else if (handoff === 'commit') {
        if (Number.isFinite(parseFloat(input.value))) binding.commit();
        else {
            binding.cancel();
            input.value = String(model.board.width);
        }
    }
    else {
        const start = boardOutlineHandles(app).find(handle => handle.id === 'width');
        const began = beginBoardOutlineResize(app, start);
        if (began) endBoardOutlineResize(app, false);
    }
    assert.equal(binding.active, false);
    if (value === '56') {
        assert.equal(model.board.width, 56);
        assert.equal(app.history.undoStack.length, 1);
        app.history.undo();
        assert.deepEqual(model.captureGeometry(), before);
    } else {
        assert.deepEqual(model.captureGeometry(), before, `${handoff}: invalid text never authorizes the previous preview`);
        assert.equal(app.history.undoStack.length, 0);
        assert.deepEqual(app.history.redoStack, [redo]);
        if (!Number.isFinite(parseFloat(input.value))) input.value = String(model.board.width);
        assert.equal(input.value, String(model.board.width));
        input.emit('change');
        flushSettledChanges();
        assert.equal(app.history.undoStack.length, 0, 'Following native change cannot revive the cancelled preview');
    }
}

for (const key of [{ key: 'Escape' }, { key: 'z', ctrlKey: true }, { key: 'y', ctrlKey: true },
    { key: 'z', ctrlKey: true, shiftKey: true }]) {
    for (const numeric of [false, true]) {
        const { app, model, inputs, bind } = fixture();
        const before = model.captureGeometry();
        if (numeric) {
            bind(); inputs.get(fields.width).value = '55'; inputs.get(fields.width).emit('input');
        } else {
            const start = boardOutlineHandles(app).find(handle => handle.id === 'both');
            beginBoardOutlineResize(app, start);
            updateBoardOutlineResize(app, { x: start.x + 2, y: start.y });
        }
        app.history.undo = () => assert.fail('Do not undo beneath a preview');
        app.history.redo = () => assert.fail('Do not redo beneath a preview');
        assert.equal(PCBApp.prototype.handleKeyDown.call(app, key), true);
        assert.deepEqual(model.captureGeometry(), before);
        assert.equal(getBoardDimensionPreview(app), undefined);
        assert.equal(isBoardViewRefreshSuspended(app), false);
        if (numeric) {
            inputs.get(fields.width).value = '56'; inputs.get(fields.width).emit('input');
            assert.ok(getBoardDimensionPreview(app), 'Keyboard cancellation leaves the visible panel editable');
            getPropertyEditor(app, 'boardDimension').cancel();
        }
    }
}
{
    const { app, model, draws } = fixture();
    model.boardShapes.push(...Array.from({ length: 1000 }, (_, index) => ({
        id: `unrelated-${index}`, kind: 'circle', layer: 'top-silk', x: index, y: 10, radius: 1,
    })));
    const start = boardOutlineHandles(app).find(handle => handle.id === 'both'), work = draws();
    beginBoardOutlineResize(app, start);
    for (let index = 0; index < 100; index++) updateBoardOutlineResize(app, start);
    assert.equal(getBoardDimensionPreview(app), undefined);
    assert.equal(draws(), work, 'Large stationary pickup does not redraw or project the collection');
    updateBoardOutlineResize(app, { x: start.x + 1, y: start.y });
    assert.equal(app.boardShapes[1001], model.boardShapes[1001], 'Unrelated shapes are not copied');
    updateBoardOutlineResize(app, start);
    endBoardOutlineResize(app);
    assert.equal(app.history.undoStack.length, 0, 'Resize returning to the starting dimensions is a no-op');
}
for (const mode of ['rectangle', 'default-rectangle', 'circle', 'same-size-circle']) {
    const { app, model } = fixture(false);
    if (mode === 'same-size-circle') Object.assign(model.board, { width: 30, height: 30, radius: 0 });
    const before = model.captureGeometry(), originalDimensions = { ...model.board };
    const overlay = new Element(), controls = new Map([
        ['#boardDlgShape', new Input('rect')],
        ['#boardDlgRectangleSizes', new Element()],
        ['#boardDlgCircleSizes', new Element()],
        ['#boardDlgDiameter', new Input(String(Math.min(model.board.width, model.board.height)))],
        ['#boardDlgWidth', new Input(String(model.board.width))],
        ['#boardDlgHeight', new Input(String(model.board.height))],
        ['#boardDlgRadius', new Input(String(model.board.radius))],
        ['#boardDlgOk', new Input('')],
    ]);
    overlay.querySelector = selector => controls.get(selector);
    const listeners = new Map();
    overlay.addEventListener = (name, listener) => listeners.set(name, listener);
    document.createElement = () => overlay;
    document.body = new Element();
    let dirty = 0;
    app._markDirty = () => { dirty++; };
    PCBApp.prototype._showBoardDimensionsDialog.call(app);
    assert.ok(overlay.innerHTML.includes('Tip: Edit the board outline after creation for more complex shapes'));
    const shape = controls.get('#boardDlgShape');
    shape.value = 'circle'; shape.emit('change');
    assert.equal(controls.get('#boardDlgRectangleSizes').style.display, 'none');
    assert.equal(controls.get('#boardDlgCircleSizes').style.display, 'block');
    shape.value = 'rect'; shape.emit('change');
    assert.equal(controls.get('#boardDlgRectangleSizes').style.display, 'flex');
    assert.equal(controls.get('#boardDlgCircleSizes').style.display, 'none');
    const circle = mode.endsWith('circle');
    if (circle) {
        shape.value = 'circle'; shape.emit('change');
        const diameter = controls.get('#boardDlgDiameter'), initialDiameter = diameter.value;
        for (const invalid of ['', '0', '-10', '4', 'Infinity']) {
            diameter.value = invalid; diameter.emit('input');
            controls.get('#boardDlgOk').emit('click');
            assert.equal(diameter.reportedValidity, 'Enter a diameter of at least 5 mm.');
            assert.equal(boardDimensionsDialog(app), overlay);
            assert.equal(app.history.undoStack.length, 0);
            assert.deepEqual(model.captureGeometry(), before);
        }
        diameter.value = initialDiameter;
        if (mode === 'circle') controls.get('#boardDlgDiameter').value = '66.123456789';
        controls.get('#boardDlgDiameter').emit('input');
        assert.equal(diameter.validity, '');
        controls.get('#boardDlgWidth').value = '999';
        controls.get('#boardDlgHeight').value = '999';
        controls.get('#boardDlgRadius').value = '20';
    } else if (mode === 'rectangle') {
        controls.get('#boardDlgWidth').value = '66.123456789';
        controls.get('#boardDlgWidth').emit('input');
    }
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(getBoardDimensionPreview(app), undefined, 'Dimensions dialog remains command-only');
    if (circle) listeners.get('keydown')({ key: 'Enter' });
    else controls.get('#boardDlgOk').emit('click');
    const expectedWidth = mode === 'same-size-circle' ? 30
        : mode === 'default-rectangle' ? originalDimensions.width : 66.123456789;
    assert.equal(model.board.width, expectedWidth);
    const outline = getBoardOutline(model);
    assert.equal(outline.kind, circle ? 'circle' : 'rect');
    if (circle) {
        assert.equal(model.board.height, expectedWidth);
        assert.equal(model.board.radius, 0);
        assert.equal(outline.radius, expectedWidth / 2);
        assert.equal(outline.x, expectedWidth / 2);
        assert.equal(outline.y, -expectedWidth / 2);
    } else {
        assert.equal(model.board.height, originalDimensions.height);
        assert.equal(model.board.radius, originalDimensions.radius);
    }
    assert.equal(app.history.undoStack.length, mode === 'default-rectangle' ? 0 : 1);
    assert.equal(dirty, mode === 'default-rectangle' ? 1 : 0);
    assert.equal(boardDimensionsDialog(app), null);
    const saved = model.serialize();
    const copy = new ProjectDocument().pcbDocument;
    copy.load(saved);
    assert.deepEqual(copy.serialize().boardShapes, saved.boardShapes, 'The selected outline survives save/load');
    assert.equal(getBoardOutline(copy).kind, circle ? 'circle' : 'rect');
    assert.ok(Math.abs(copy.board.width - expectedWidth) <= 0.0001,
        'Reloaded dimensions reflect geometry rounded to the file format precision');
    if (mode !== 'default-rectangle') {
        const created = structuredClone(outline);
        app.history.undo();
        assert.deepEqual(getBoardOutline(model), rectangleBoardOutline(
            originalDimensions.width, originalDimensions.height, originalDimensions.radius));
        app.history.redo();
        assert.deepEqual(getBoardOutline(model), created);
    }
    controls.get('#boardDlgOk').emit('click');
    assert.equal(app.history.undoStack.length, mode === 'default-rectangle' ? 0 : 1,
        'Closed dialog controls cannot create another outline');
}
console.log('PASS Escape/undo/redo cancellation, large-board stationary pickup and command-only dimensions dialog');

{
    const { app, model } = fixture();
    model.setBoardOutline(rectangleBoardOutline(20, 3));
    const start = boardOutlineHandles(app).find(handle => handle.id === 'width');
    beginBoardOutlineResize(app, start);
    updateBoardOutlineResize(app, { x: start.x + 1, y: start.y });
    assert.equal(boardDimensions(app).height, 3, 'An untouched pre-existing small dimension is preserved');
    endBoardOutlineResize(app);
    assert.deepEqual(model.board, { width: 21, height: 3, radius: 0 });
}
