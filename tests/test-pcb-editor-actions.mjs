import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { bindPcbControls, bindPcbHistoryButtons } from '../src/pcb/modules/controls.js';
import { savePcbProject } from '../src/pcb/modules/editor-actions.js';
import { setPropertyEditor } from '../src/pcb/modules/property-editors.js';
import { getBoardOutlineResize } from '../src/pcb/modules/board-outline-resize.js';
import { getPcbPaste } from '../src/pcb/modules/pcb-paste.js';
import { getComponentDrag } from '../src/pcb/modules/component-selection.js';
import { getGroupDrag } from '../src/pcb/modules/box-select.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

const elements = new Map();
globalThis.window = { addEventListener() {}, setTimeout(callback) { callback(); } };
globalThis.document = {
    getElementById: id => elements.get(id) || null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, remove() {} }),
    body: { appendChild(element) { elements.get('events')?.push(element.textContent); } },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function button(id) {
    const handlers = new Map();
    const element = { addEventListener: (name, callback) => handlers.set(name, callback),
        click: () => handlers.get('click')() };
    elements.set(id, element);
    return element;
}

function fixture() {
    elements.clear();
    const buttons = Object.fromEntries(['UndoBtn', 'RedoBtn', 'RibbonSave', 'RibbonSaveAs']
        .map(name => [name, button(`pcb${name}`)]));
    const events = [];
    elements.set('events', events);
    const docTitle = { getBoundingClientRect: () => ({ left: 0, width: 10, top: 0 }) };
    let value = 0;
    const history = new CommandHistory();
    for (const next of [1, 2]) {
        const before = value;
        history.execute({ execute() { value = next; events.push('execute'); },
            undo() { value = before; events.push('undo'); } });
    }
    history.undo();
    events.length = 0;
    const app = {
        _active: true, currentTool: 'select', history,
        placements: new Map(), tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map(),
        getLayerGroup: () => null, _layerGroups: new Map(),
        viewport: { gridSize: 1, getGridOptions: () => [{ value: 1, label: '1 mm' }],
            hideCrosshair() { events.push('crosshair'); } },
        status: { docTitle },
        _clearCursorCrosshair() { events.push('cursor'); },
        _cancelPasteDrop() { events.push('cancel-paste'); setPcbInteraction(this, '_pasteDrop', null); },
        _cancelPosePreviews: PCBApp.prototype._cancelPosePreviews,
        handleKeyDown: PCBApp.prototype.handleKeyDown,
    };
    bindPcbControls(app);
    bindPcbHistoryButtons(app, buttons.UndoBtn, buttons.RedoBtn);
    buttons.RibbonSave.addEventListener('click', () => savePcbProject(app));
    buttons.RibbonSaveAs.addEventListener('click', () => savePcbProject(app, true));
    const invoke = (source, action) => source === 'ribbon'
        ? buttons[action === 'undo' ? 'UndoBtn' : 'RedoBtn'].click()
        : app.handleKeyDown({ key: action === 'undo' ? 'z' : 'y', ctrlKey: true });
    return { app, buttons, events, invoke, value: () => value };
}

for (const source of ['keyboard', 'ribbon']) for (const action of ['undo', 'redo']) {
    for (const preview of ['paste', 'dimensions', 'group', 'track-draw', 'fill-draw', 'shape-draw']) {
        const f = fixture(), { app } = f;
        const beforeUndo = [...app.history.undoStack], beforeRedo = [...app.history.redoStack];
        if (preview === 'paste') setPcbInteraction(app, '_pasteDrop', {
            model: app,
            payload: { tracks: [], vias: [], pads: [], shapes: [], texts: [], fills: [] },
            selection: [], flags: {}, suspensions: { overlays: false, fill: false, boardView: false },
            fillPending: false,
        });
        else if (preview === 'dimensions') {
            setPcbInteraction(app, '_boardOutlineResize', { previousSuspend: false });
            setPropertyEditor(app, 'boardDimension', { cancel() { f.events.push('cancel-dimensions'); } });
        } else if (preview === 'group') {
            setPcbInteraction(app, '_groupDrag', { posePreview: true, tracks: [], vias: [], pads: [], shapes: [], fills: [],
                previousDeferDragOverlays: false, previousSuspendBoardViewRefresh: false });
        } else if (preview === 'track-draw') {
            setPcbInteraction(app, '_trackDraw', { previewElements: [] });
        } else if (preview === 'fill-draw') {
            setPcbInteraction(app, '_fillDraw', { points: [], snap: null });
        } else if (preview === 'shape-draw') {
            setPcbInteraction(app, '_shapeDraw', { preview: { parentNode: null } });
        }
        f.invoke(source, action);
        assert.deepEqual(app.history.undoStack, beforeUndo, `${source}/${action}/${preview}: do not undo below an unfinished edit`);
        assert.deepEqual(app.history.redoStack, beforeRedo, `${source}/${action}/${preview}: retain redo`);
        assert.equal(f.value(), 1);
        if (preview === 'paste') assert.equal(getPcbPaste(app), null);
        if (preview === 'dimensions') assert.equal(getBoardOutlineResize(app), null);
        if (preview === 'group') assert.equal(getGroupDrag(app), null);
    }
    const idle = fixture();
    idle.invoke(source, action);
    assert.equal(idle.value(), action === 'undo' ? 0 : 2, `${source}/${action}: idle history still works`);
}

for (const source of ['keyboard', 'ribbon']) {
    const f = fixture();
    f.app.placements.set('part', { x: 0, y: 0 });
    f.app.viewport.svg = { style: {} };
    f.app.refreshClearanceHalos = () => f.events.push('cancel-drag');
    f.app.updateRatsnest = () => {};
    setPcbInteraction(f.app, '_drag', { compId: 'part', startPos: { x: 0, y: 0 }, startWorld: { x: 0, y: 0 } });
    f.invoke(source, 'undo');
    assert.deepEqual(f.events, ['crosshair', 'cancel-drag', 'undo'], `${source}: cancel the pointer before history`);
    assert.equal(getComponentDrag(f.app), null, `${source}: the drag ends`);
    assert.equal(f.value(), 0, `${source}: the drag is cancelled, not committed, so Undo reverts the earlier edit`);
    assert.deepEqual(f.app.placements.get('part'), { x: 0, y: 0 });
    const failing = fixture();
    const failure = new Error('Fixture cancellation failed');
    failing.app.placements.set('part', { x: 0, y: 0 });
    failing.app.viewport.svg = { style: {} };
    failing.app.refreshClearanceHalos = () => { throw failure; };
    setPcbInteraction(failing.app, '_drag', { compId: 'part', startPos: { x: 0, y: 0 }, startWorld: { x: 0, y: 0 } });
    assert.throws(() => failing.invoke(source, 'undo'), error => error === failure);
    assert.equal(failing.value(), 1, 'Failed cleanup must not advance history');
}

for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
    const f = fixture();
    for (const key of ['z', 'y', 's']) assert.equal(f.app.handleKeyDown({ key, ctrlKey: true, target }), false);
    assert.equal(f.value(), 1, 'Text controls retain native shortcuts');
}

for (const event of [{ key: 'Z', metaKey: true }, { key: 'z', ctrlKey: true, shiftKey: true },
    { key: 'Z', metaKey: true, shiftKey: true }, { key: 'Y', metaKey: true }]) {
    const f = fixture();
    assert.equal(f.app.handleKeyDown(event), true);
    assert.equal(f.value(), event.key.toLowerCase() === 'z' && !event.shiftKey ? 0 : 2);
}

for (const source of ['keyboard', 'ribbon']) for (const saveAs of [false, true]) {
    for (const success of [false, true]) {
        const f = fixture();
        const ownCalls = [];
        let foreignCalls = 0, release;
        const pending = new Promise(resolve => { release = resolve; });
        window.bootstrap = { project: {
            save() { foreignCalls++; return { success: true }; },
            saveAs() { foreignCalls++; return { success: true }; },
        } };
        const project = {
            save() { assert.equal(this, project); ownCalls.push('save'); return pending; },
            saveAs() { assert.equal(this, project); ownCalls.push('saveAs'); return pending; },
        };
        f.app.project = project;
        if (source === 'keyboard') assert.equal(f.app.handleKeyDown({ key: 's', ctrlKey: true, altKey: saveAs }), true);
        else f.buttons[saveAs ? 'RibbonSaveAs' : 'RibbonSave'].click();
        assert.deepEqual(ownCalls, [saveAs ? 'saveAs' : 'save'], `${source}: dispatch the right operation to the editor's project`);
        assert.equal(foreignCalls, 0, 'Never discover a different project through the global bootstrap');
        assert.deepEqual(f.events, [], 'Do not show Saved while I/O is pending');
        release({ success });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.events, success ? ['Saved'] : [], 'Only successful saves show the toast');
    }
}
delete window.bootstrap;

for (const source of ['keyboard', 'ribbon']) {
    const f = fixture();
    f.app._active = false;
    f.invoke(source, 'undo');
    f.invoke(source, 'redo');
    assert.equal(f.value(), 1, 'Inactive-editor history actions cannot mutate its document');
}
for (const saveAs of [false, true]) {
    const f = fixture();
    const failure = new Error('Fixture save failed');
    f.app.project = { save: async () => { throw failure; }, saveAs: async () => { throw failure; } };
    await assert.rejects(f.buttons[saveAs ? 'RibbonSaveAs' : 'RibbonSave'].click(), error => error === failure);
    assert.deepEqual(f.events, [], 'Unexpected save failure propagates without a Saved toast');
}
{
    const f = fixture();
    await assert.rejects(savePcbProject(f.app), /without its project/);
    let called = 0;
    f.app.project = { async save() { called++; return { success: true }; } };
    await f.buttons.RibbonSave.click();
    assert.equal(called, 1, 'Control bindings resolve the owner at invocation, not binding time');
    assert.deepEqual(f.events, ['Saved']);
}
console.log('PASS shared PCB keyboard/ribbon history policy, input guards, cancellation failures and project-scoped asynchronous saves');
