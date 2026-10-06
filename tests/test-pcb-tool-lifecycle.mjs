import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { bindPcbControls } from '../src/pcb/modules/controls.js';
import { PCB_SHAPE_TOOLS, normalizePcbTool, preparePcbRibbonTransition, selectPcbTool } from '../src/pcb/modules/tool-lifecycle.js';
import { getTrackDraw } from '../src/pcb/modules/track-draw.js';
import { getFillDraw } from '../src/pcb/modules/copper-fill-draw.js';
import { getShapeDraw } from '../src/pcb/modules/board-shapes.js';
import { activeTextInlineEdit } from '../src/pcb/modules/text-inline-edit.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';
import { getDrcPresentation } from '../src/pcb/modules/drc-state.js';
import { getHoveredComponent, hoverComponent } from '../src/pcb/modules/component-selection.js';
import { selectRefText } from '../src/pcb/modules/ref-text-selection.js';
import { getPcbSelection } from '../src/pcb/modules/selection-registry.js';

const elements = new Map();
globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById: id => elements.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    createElementNS: () => ({ setAttribute() {}, appendChild() {}, remove() {} }),
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
        placements: new Map([['hovered', { bounds: { x: 0, y: 0, width: 1, height: 1 },
            elements: [{ appendChild() {}, querySelector: () => ({ remove() {} }) }] }]]),
        viewport: { gridSize: 1, getGridOptions: () => [{ value: 1 }], svg: { style: {} }, hideCrosshair() {} },
        getLayerGroup: () => null,
        refreshText() {},
        selectText() {},
        clearProperties() {},
        _cancelDrawingMode: PCBApp.prototype._cancelDrawingMode,
        _cancelTrackDraw() { events.push('cancel-track'); setPcbInteraction(this, '_trackDraw', null); },
        _cancelFillDraw() { events.push('cancel-fill'); setPcbInteraction(this, '_fillDraw', null); },
        _cancelShapeDraw() { events.push('cancel-shape'); setPcbInteraction(this, '_shapeDraw', null); },
        _endTextInlineEdit(commit) { assert.equal(commit, false); events.push('cancel-text'); setPcbInteraction(this, '_textEdit', null); },
        _drawRefOverlay() { events.push('reference'); },
        _clearCursorCrosshair() {},
        setPcbStatus() { events.push(`status:${this.currentTool}`); },
        netNames: () => [],
        layerLabel: layer => layer === 'bottom-silk' ? 'Bottom Silk' : layer === 'top-silk' ? 'Top Silk'
            : layer === 'bottom-copper' ? 'Bottom Copper' : layer === 'top-copper' ? 'Top Copper' : layer,
        openPropertyPanel(panel) {
            const names = {
                'New Fill': 'fill', 'New Via': 'via', 'New Pad': 'pad',
                'New Track': 'track', 'New Text': 'text',
                'New Line': 'line', 'New Rectangle': 'rect', 'New Circle': 'circle',
                'New Polygon': 'polygon', 'New Arc': 'arc',
            };
            events.push(`properties:${names[panel.title] || String(panel.title).replace(/^New /, '').toLowerCase()}`);
            return true;
        },
        _syncPcbHomeToolHighlight() {
            for (const button of Object.values(buttons)) button.classList.toggle('active', false);
            buttons.Select.classList.toggle('active', this.currentTool === 'select');
        },
        setActiveRibbonTab: PCBApp.prototype.setActiveRibbonTab,
    };
    PCBApp.prototype._bindRibbonTabs.call(app);
    bindPcbControls(app);
    events.length = 0;
    app.history.execute({ execute() {}, undo() {} });
    app.history.undo();
    const history = [app.history.undoStack.slice(), app.history.redoStack.slice()];
    const clickTool = tool => selectPcbTool(app, tool);
    return { app, buttons, tabs, panels, events, clickTool, history };
}

function startDrawing(app, tool) {
    app.currentTool = tool;
    if (tool === 'track') setPcbInteraction(app, '_trackDraw', { points: [] });
    else if (tool === 'fill') setPcbInteraction(app, '_fillDraw', { points: [] });
    else if (PCB_SHAPE_TOOLS.has(tool)) setPcbInteraction(app, '_shapeDraw', { kind: tool, points: [] });
}

for (const previous of tools) for (const next of tools) {
    const f = fixture(), { app, events } = f;
    startDrawing(app, previous);
    const drawing = getTrackDraw(app) || getFillDraw(app) || getShapeDraw(app);
    hoverComponent(app, 'hovered');
    selectRefText(app, 'ref');
    f.clickTool(next);
    assert.equal(app.currentTool, next);
    assert.ok(events.includes(`status:${next}`));
    if (next === 'select') assert.equal(app.viewport.svg.style.cursor, 'default');
    else assert.match(app.viewport.svg.style.cursor, /crosshair/);
    if (next !== 'select') {
        assert.equal(getHoveredComponent(app), null, `${previous} -> ${next}: tool switch clears component hover`);
        assert.equal(getPcbSelection(app, 'reftext').length, 0, `${previous} -> ${next}: tool switch clears reference text`);
    }
    if (drawing) assert.equal(getTrackDraw(app) || getFillDraw(app) || getShapeDraw(app) || null,
        previous === next ? drawing : null, `${previous} -> ${next}: preserve only the same tool's drawing`);
    assert.deepEqual(events.filter(event => event.startsWith('properties:')), next === 'select' ? [] : [`properties:${next}`]);
    assert.equal(normalizePcbTool(app.currentTool), normalizePcbTool(next));
    assert.deepEqual([app.history.undoStack, app.history.redoStack], f.history, 'Tool selection cannot mutate history');
}

for (const userInitiated of [false, true]) for (const sameTab of [false, true]) for (const tool of tools) {
    const f = fixture(), { app } = f;
    startDrawing(app, tool);
    if (tool === 'text') setPcbInteraction(app, '_textEdit', {
        text: { id: 'text', content: 'x' }, originalContent: 'x', input: { value: 'x' }, overlay: { destroy() {} }, options: {},
    });
    const before = getTrackDraw(app) || getFillDraw(app) || getShapeDraw(app) || activeTextInlineEdit(app);
    const target = sameTab ? 'pcb-home' : 'pcb-properties';
    preparePcbRibbonTransition(app, 'pcb-home', target, userInitiated);
    f.tabs.forEach(tab => tab.classList.toggle('active', tab.id === target));
    f.panels.forEach(panel => panel.classList.toggle('active', panel.dataset.panel === target));
    const cancelled = !sameTab && ((userInitiated && tool !== 'select') || PCB_SHAPE_TOOLS.has(tool));
    assert.equal(app.currentTool, cancelled ? 'select' : tool, `${tool}/${userInitiated}/${sameTab}`);
    if (before) assert.equal(getTrackDraw(app) || getFillDraw(app) || getShapeDraw(app) || activeTextInlineEdit(app) || null,
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
    f.clickTool('polygon');
    assert.equal(f.app.currentTool, 'polygon', 'Shapes remembers the last chosen kind');
    f.app.activeLayer = 'hole';
    selectPcbTool(f.app, 'circle');
    assert.equal(f.app.currentTool, 'circle');
    assert.equal(f.app.activeLayer, 'hole', 'Hole is still the circle tool on the hole layer');
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => { f.events.push('drc'); return f.events.length; };
    const drc = getDrcPresentation(f.app);
    try {
        drc.setDesignActive(true);
        assert.equal(drc.designActive, true);
        assert.equal(f.events.filter(event => event === 'drc').length, 1);
        drc.setDesignActive(false);
        assert.equal(drc.designActive, false);
    } finally {
        if (originalRequestAnimationFrame) globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        else delete globalThis.requestAnimationFrame;
    }
}
{
    const f = fixture();
    f.app.openPropertyPanel = () => { f.app.setActiveRibbonTab('pcb-properties'); return true; };
    startDrawing(f.app, 'track');
    const drawing = getTrackDraw(f.app);
    f.clickTool('track');
    assert.equal(getTrackDraw(f.app), drawing, 'A tool opening Properties must not cancel itself');
    preparePcbRibbonTransition(f.app, 'pcb-home', 'pcb-design', true);
    assert.equal(getTrackDraw(f.app), null, 'Explicit navigation still cancels the tool');
    assert.equal(f.app.currentTool, 'select');
}
for (const boundary of ['tool', 'ribbon', 'cancel']) {
    const f = fixture();
    startDrawing(f.app, 'track');
    const failure = new Error('Fixture drawing cleanup failed');
    f.app._cancelTrackDraw = () => { throw failure; };
    assert.throws(() => {
        if (boundary === 'tool') f.clickTool('pad');
        else if (boundary === 'ribbon') preparePcbRibbonTransition(f.app, 'pcb-home', 'pcb-design', true);
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
