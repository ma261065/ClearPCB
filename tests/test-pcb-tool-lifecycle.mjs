import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { bindPcbControls } from '../src/pcb/modules/controls.js';
import { PCB_SHAPE_TOOLS, normalizePcbTool, selectPcbTool } from '../src/pcb/modules/tool-lifecycle.js';

const elements = new Map();
globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById: id => elements.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function element(id, dataset = {}) {
    const classes = new Set(), listeners = new Map();
    const el = {
        id, dataset, textContent: '', hidden: true,
        classList: { contains: name => classes.has(name), toggle(name, on) {
            if (on === undefined) on = !classes.has(name);
            if (on) classes.add(name); else classes.delete(name);
        } },
        setAttribute() {}, getAttribute: name => name === 'data-shape' ? dataset.shape : null,
        querySelectorAll: () => [], contains: () => false,
        addEventListener: (name, callback) => listeners.set(name, callback),
        click: () => listeners.get('click')?.({ stopPropagation() {} }),
    };
    elements.set(id, el);
    return el;
}

const tools = ['select', 'track', 'via', 'pad', 'text', 'fill', ...PCB_SHAPE_TOOLS];
function fixture() {
    elements.clear();
    const events = [];
    const buttons = Object.fromEntries(['Select', 'Track', 'Via', 'Pad', 'Hole', 'Text', 'Fill',
        'Shapes', 'ShapesArrow', 'ShapesWrap', 'ShapesMenu'].map(name => [name, element(`pcbTool${name}`)]));
    const shapeItems = Object.fromEntries([...PCB_SHAPE_TOOLS].map(shape => [shape, element(shape, { shape })]));
    buttons.ShapesMenu.querySelectorAll = () => Object.values(shapeItems);
    const tabs = ['pcb-home', 'pcb-properties', 'pcb-design'].map(tab => element(tab, { tab }));
    const panels = tabs.map(tab => element(`${tab.id}-panel`, { panel: tab.id }));
    tabs[0].classList.toggle('active', true);
    panels[0].classList.toggle('active', true);
    const ribbon = {
        querySelectorAll: selector => selector.startsWith('.ribbon-tab') ? tabs : panels,
        querySelector: selector => selector === '.ribbon-tab.active'
            ? tabs.find(tab => tab.classList.contains('active')) : null,
    };
    const app = {
        ribbon, history: new CommandHistory(), currentTool: 'select', activeLayer: 'top-copper', _active: true,
        viewport: { gridSize: 1, getGridOptions: () => [{ value: 1 }] },
        _cancelDrawingMode: PCBApp.prototype._cancelDrawingMode,
        _cancelTrackDraw() { events.push('cancel-track'); this._trackDraw = null; },
        _cancelFillDraw() { events.push('cancel-fill'); this._fillDraw = null; },
        _cancelShapeDraw() { events.push('cancel-shape'); this._shapeDraw = null; },
        _endTextInlineEdit(commit) { assert.equal(commit, false); events.push('cancel-text'); this._textEdit = null; },
        _hoverComponent(value) { assert.equal(value, null); events.push('hover'); },
        _selectRefText(value) { assert.equal(value, null); events.push('reference'); },
        _updateCursorForTool() { events.push(`cursor:${this.currentTool}`); },
        setPcbStatus() { events.push(`status:${this.currentTool}`); },
        _hideToolOptions() { events.push('hide-options'); },
        _showViaToolProperties() { events.push('properties:via'); },
        _showPadToolProperties() { events.push('properties:pad'); },
        _showTrackDrawProperties() { events.push('properties:track'); },
        _showTextToolProperties() { events.push('properties:text'); },
        _showFillToolOptions() { events.push('properties:fill'); },
        _showBoardShapeToolProperties(kind) { events.push(`properties:${kind}`); },
        _scheduleDRC() { events.push('drc'); },
        _getDrcPresentation: PCBApp.prototype._getDrcPresentation,
        setActiveRibbonTab: PCBApp.prototype.setActiveRibbonTab,
    };
    Object.defineProperty(app, '_drcActive', Object.getOwnPropertyDescriptor(PCBApp.prototype, '_drcActive'));
    PCBApp.prototype._bindRibbonTabs.call(app);
    bindPcbControls(app);
    events.length = 0;
    app.history.execute({ execute() {}, undo() {} });
    app.history.undo();
    const history = [app.history.undoStack.slice(), app.history.redoStack.slice()];
    const clickTool = tool => PCB_SHAPE_TOOLS.has(tool) ? shapeItems[tool].click()
        : buttons[tool[0].toUpperCase() + tool.slice(1)].click();
    return { app, buttons, tabs, panels, events, clickTool, history };
}

function startDrawing(app, tool) {
    app.currentTool = tool;
    if (tool === 'track') app._trackDraw = { points: [] };
    else if (tool === 'fill') app._fillDraw = { points: [] };
    else if (PCB_SHAPE_TOOLS.has(tool)) app._shapeDraw = { kind: tool, points: [] };
}

for (const previous of tools) for (const next of tools) {
    const f = fixture(), { app, events } = f;
    startDrawing(app, previous);
    const drawing = app._trackDraw || app._fillDraw || app._shapeDraw;
    f.clickTool(next);
    assert.equal(app.currentTool, next);
    assert.ok(events.includes(`cursor:${next}`));
    assert.ok(events.includes(`status:${next}`));
    if (drawing) assert.equal(app._trackDraw || app._fillDraw || app._shapeDraw || null,
        previous === next ? drawing : null, `${previous} -> ${next}: preserve only the same tool's drawing`);
    assert.deepEqual(events.filter(event => event.startsWith('properties:')), next === 'select' ? [] : [`properties:${next}`]);
    assert.equal(events.includes('hide-options'), next !== 'fill', 'Fill owns its options presentation');
    const highlighted = PCB_SHAPE_TOOLS.has(next) ? 'Shapes' : next[0].toUpperCase() + next.slice(1);
    assert.equal(f.buttons[highlighted].classList.contains('active'), true);
    assert.deepEqual([app.history.undoStack, app.history.redoStack], f.history, 'Tool selection cannot mutate history');
}

for (const userInitiated of [false, true]) for (const sameTab of [false, true]) for (const tool of tools) {
    const f = fixture(), { app } = f;
    startDrawing(app, tool);
    if (tool === 'text') app._textEdit = {};
    const before = app._trackDraw || app._fillDraw || app._shapeDraw || app._textEdit;
    const target = sameTab ? 'pcb-home' : 'pcb-properties';
    if (userInitiated) f.tabs.find(tab => tab.id === target).click();
    else app.setActiveRibbonTab(target);
    const cancelled = !sameTab && ((userInitiated && tool !== 'select') || PCB_SHAPE_TOOLS.has(tool));
    assert.equal(app.currentTool, cancelled ? 'select' : tool, `${tool}/${userInitiated}/${sameTab}`);
    if (before) assert.equal(app._trackDraw || app._fillDraw || app._shapeDraw || app._textEdit || null,
        cancelled ? null : before);
    assert.equal(f.tabs.find(tab => tab.classList.contains('active')).id, target);
    assert.equal(f.panels.find(panel => panel.classList.contains('active')).dataset.panel, target);
    if (cancelled) assert.equal(f.buttons.Select.classList.contains('active'), true, 'All reset paths synchronize Home tools');
    assert.deepEqual([app.history.undoStack, app.history.redoStack], f.history);
}

{
    const f = fixture();
    f.clickTool('polygon');
    f.clickTool('select');
    f.buttons.Shapes.click();
    assert.equal(f.app.currentTool, 'polygon', 'Shapes remembers the last chosen kind');
    assert.match(f.buttons.Shapes.textContent, /Shapes$/);
    f.buttons.Hole.click();
    assert.equal(f.app.currentTool, 'circle');
    assert.equal(f.app.activeLayer, 'hole', 'Hole is still the circle tool on the hole layer');
    f.app.setActiveRibbonTab('pcb-design');
    assert.equal(f.app._drcActive, true);
    assert.equal(f.events.filter(event => event === 'drc').length, 1);
    f.app.setActiveRibbonTab('pcb-home');
    assert.equal(f.app._drcActive, false);
}
{
    const f = fixture();
    f.app._showTrackDrawProperties = () => f.app.setActiveRibbonTab('pcb-properties');
    startDrawing(f.app, 'track');
    const drawing = f.app._trackDraw;
    f.clickTool('track');
    assert.equal(f.app._trackDraw, drawing, 'A tool opening Properties must not cancel itself');
    f.tabs.find(tab => tab.id === 'pcb-design').click();
    assert.equal(f.app._trackDraw, null, 'Explicit navigation still cancels the tool');
    assert.equal(f.app.currentTool, 'select');
}
for (const boundary of ['tool', 'ribbon', 'cancel']) {
    const f = fixture();
    startDrawing(f.app, 'track');
    const failure = new Error('Fixture drawing cleanup failed');
    f.app._cancelTrackDraw = () => { throw failure; };
    assert.throws(() => {
        if (boundary === 'tool') f.clickTool('pad');
        else if (boundary === 'ribbon') f.tabs[2].click();
        else f.app._cancelDrawingMode();
    }, error => error === failure);
    assert.equal(f.app.currentTool, 'track', 'Do not adopt the new tool after failed cleanup');
    assert.equal(f.tabs[0].classList.contains('active'), true, 'Do not navigate after failed cleanup');
    assert.deepEqual([f.app.history.undoStack, f.app.history.redoStack], f.history);
}
{
    const f = fixture();
    assert.equal(f.app._cancelDrawingMode(), false);
    assert.deepEqual(f.events, [], 'Idle cancellation does no UI work');
    assert.equal(normalizePcbTool('unsupported'), 'select');
    selectPcbTool(f.app, 'unsupported');
    assert.equal(f.app.currentTool, 'select', 'Preserve the existing unsupported-tool fallback');
}
console.log('PASS PCB tool transition matrix, explicit/programmatic ribbon navigation, shared reset, history and failure ordering');
