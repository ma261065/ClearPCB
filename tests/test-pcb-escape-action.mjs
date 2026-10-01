import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPropertyPreview } from '../src/shapes/property-preview.js';
import { getPcbSelection, setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { Viewport } from '../src/core/Viewport.js';
import { cancelTrackDraw, finishTrackDraw, popTrackWaypoint } from '../src/pcb/modules/track-draw.js';
import { selectPcbTool, preparePcbRibbonTransition } from '../src/pcb/modules/tool-lifecycle.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture() {
    const events = [];
    const history = new CommandHistory();
    history.execute({ execute() {}, undo() {} });
    history.undo();
    const app = {
        _active: true, currentTool: 'via', history,
        placements: new Map(), tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map(),
        _layerGroups: new Map(), _getLayerGroup: () => null,
        _refreshText() {},
        viewport: { svg: { style: {} }, hideCrosshair() { events.push('hide-crosshair'); } },
        _clearCursorCrosshair() { events.push('clear-crosshair'); },
        _clearProperties() { events.push('clear-properties'); },
        _updateCursorForTool() { events.push('cursor'); },
        _syncPcbHomeToolHighlight() { events.push('highlight'); },
        _setPcbStatus() { events.push('status'); },
        _hideToolOptions() { events.push('hide-options'); },
        _setActiveRibbonTab(tab) { events.push(tab); },
        handleKeyDown: PCBApp.prototype.handleKeyDown,
    };
    return { app, events, escape: target => app.handleKeyDown({ key: 'Escape', target }) };
}

const propertyKeys = ['_boardShapePropertyBinding', '_trackPropertyBinding', '_textPropertyBinding',
    '_padPropertyBinding', '_viaPropertyBinding', '_boardDimensionPropertyBinding'];
for (const key of propertyKeys) {
    const { app, events, escape } = fixture();
    let value = Math.PI;
    const binding = createPropertyPreview({
        capture: () => value, restore: before => { value = before; },
        redraw: phase => events.push(phase),
        commit() { assert.fail('Escape must not commit a property preview'); },
    });
    binding.dispose = () => { binding.cancel(); app[key] = null; };
    app[key] = binding;
    binding.update(() => { value = Math.E; });
    events.length = 0;
    const redo = [...app.history.redoStack];
    assert.equal(escape(), true);
    assert.equal(binding.active, false, `${key}: first Escape ends the property preview`);
    assert.equal(value, Math.PI, `${key}: restore full-precision original value`);
    assert.deepEqual(events, ['cancel'], `${key}: do not clear selection, rebuild Properties or navigate`);
    assert.equal(app.currentTool, 'via');
    assert.equal(app[key], binding, 'Cancellation retains the reusable binding');
    assert.deepEqual(app.history.redoStack, redo);
    assert.equal(app.history.canUndo(), false);
    events.length = 0;
    assert.equal(escape(), true);
    assert.equal(app.currentTool, 'select', 'A later Escape leaves the tool');
    assert.deepEqual(events, ['clear-properties', 'cursor', 'highlight', 'status', 'hide-options', 'pcb-home']);
}

{
    const { app, events, escape } = fixture();
    app.currentTool = 'select';
    const text = { id: 'text', x: 1, y: 2, content: 'Keep selected' };
    app.texts.set(text.id, text);
    setPcbSelection(app, [{ kind: 'text', object: text }]);
    for (const key of propertyKeys) {
        app[key] = { active: true, cancel() { events.push(key); this.active = false; }, dispose() { this.cancel(); } };
    }
    events.length = 0;
    for (const key of propertyKeys) {
        assert.equal(escape(), true);
        assert.equal(events.pop(), key, 'Preserve property priority and cancel only one editor at a time');
        assert.deepEqual(events, []);
        assert.deepEqual(getPcbSelection(app, 'text'), [text], 'Property cancellation retains selection');
    }
    assert.equal(escape(), true);
    assert.deepEqual(getPcbSelection(app), [], 'Next Escape clears the idle selection');
    assert.ok(!events.includes('pcb-home'), 'Selection cancellation must not also navigate');
    events.length = 0;
    assert.equal(escape(), true);
    assert.deepEqual(events, ['pcb-home'], 'Idle Escape returns Home');
}

for (const kind of ['component', 'shape', 'track', 'via', 'pad', 'fill', 'text', 'reftext']) {
    for (const mode of ['cycle', 'anchor', 'floating-anchor', 'move-adapter', 'move']) {
        const { app, events, escape } = fixture();
        const adapter = {
            kind,
            endMove(commit) { assert.equal(commit, false); events.push('end-move'); },
            endAnchorDrag(commit) { assert.equal(commit, false); events.push('end-anchor'); },
        };
        app._pcbSelectionInteraction = { mode, entry: adapter, adapter };
        assert.equal(escape(), true);
        assert.equal(app._pcbSelectionInteraction, null, `${kind}/${mode}: use the shared selection state machine`);
        assert.equal(app.currentTool, 'via', 'Cancelling the gesture does not also exit the tool');
        assert.deepEqual(events, [
            ...(['anchor', 'floating-anchor'].includes(mode) ? ['end-anchor'] : mode === 'move-adapter' ? ['end-move'] : []),
            'clear-crosshair',
        ]);
    }
}

for (const key of propertyKeys) {
    const { app, events, escape } = fixture();
    const failure = new Error('Fixture cancellation failed');
    app[key] = { active: true, cancel() { throw failure; } };
    assert.throws(() => escape(), error => error === failure);
    assert.equal(app.currentTool, 'via');
    assert.equal(app[key].active, true);
    assert.deepEqual(events, [], 'Failed cancellation must not fall through to selection or navigation');
}

for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
    const { app, events, escape } = fixture();
    app._trackPropertyBinding = { active: true, cancel() { assert.fail('Input owns Escape'); } };
    assert.equal(escape(target), false);
    assert.deepEqual(events, []);
}
{
    const { app, events, escape } = fixture();
    app._active = false;
    assert.equal(escape(), false);
    assert.deepEqual(events, []);
}
function drawingFixture(tool) {
    const f = fixture(), { app } = f;
    const line = () => ({ attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
    Object.assign(app.viewport, {
        crosshairContainer: { style: {} }, _crosshairXLine: line(), _crosshairYLine: line(),
        worldToScreen: point => ({ x: point.x * 10 + 100, y: point.y * 10 + 100 }),
        _getCachedRect: () => ({ width: 800, height: 600 }),
        setCrosshair: Viewport.prototype.setCrosshair,
        hideCrosshair: Viewport.prototype.hideCrosshair,
        _positionCrosshair: Viewport.prototype._positionCrosshair,
    });
    for (const name of ['_updateCursorForTool', '_clearCursorCrosshair', '_clearViaRing', '_clearPadPreview',
        '_cancelDrawingMode', '_cancelTrackDraw', '_cancelFillDraw', '_cancelShapeDraw']) {
        app[name] = PCBApp.prototype[name];
    }
    const preview = { removed: false, remove() { this.removed = true; } };
    preview.parentNode = { removeChild: () => preview.remove() };
    app.currentTool = tool;
    const key = tool === 'track' ? '_trackDraw' : tool === 'fill' ? '_fillDraw' : '_shapeDraw';
    app[key] = { kind: tool, points: [{ x: 1, y: 2 }], preview, previewElements: [preview] };
    if (tool === 'fill') app._getLayerGroup = id => id === 'selection-overlay'
        ? { querySelectorAll: () => [preview] } : null;
    app._lastCrosshairWorld = { x: Math.PI, y: -Math.E };
    app.viewport.setCrosshair(app._lastCrosshairWorld);
    return { ...f, key, preview };
}

for (const tool of ['track', 'fill', 'line', 'rect', 'polygon', 'circle', 'arc']) {
    for (const visible of [true, false]) {
        const { app, key, preview, escape } = drawingFixture(tool);
        if (!visible) app.viewport.hideCrosshair();
        const before = structuredClone([app.viewport._crosshairXLine.attributes, app.viewport._crosshairYLine.attributes]);
        const redo = [...app.history.redoStack];
        assert.equal(escape(), true);
        assert.equal(app[key], null);
        assert.equal(preview.removed, true, `${tool}: drawing artwork is removed`);
        assert.equal(app.currentTool, tool);
        assert.equal(app.viewport.crosshairContainer.style.display, visible ? 'block' : 'none',
            `${tool}: first Escape preserves crosshair visibility without a mousemove`);
        assert.deepEqual([app.viewport._crosshairXLine.attributes, app.viewport._crosshairYLine.attributes], before);
        assert.deepEqual(app.history.redoStack, redo);
        assert.equal(escape(), true);
        assert.equal(app.currentTool, 'select');
        assert.equal(app.viewport.crosshairContainer.style.display, 'none', 'Second Escape hides the crosshair');
        assert.equal(app._lastCrosshairWorld, null);
    }
}
for (const finish of [cancelTrackDraw, finishTrackDraw, popTrackWaypoint]) {
    const { app } = drawingFixture('track');
    finish(app);
    assert.equal(app._trackDraw, null);
    assert.equal(app.viewport.crosshairContainer.style.display, 'block', 'Track teardown retains the selected tool crosshair');
}
{
    const { app } = drawingFixture('track');
    app._trackDraw.points.push({ x: 5, y: 2 });
    app._trackDraw.edgeLayers = ['top-copper'];
    app._commitTracks = tracks => app.tracks.push(...tracks);
    finishTrackDraw(app);
    assert.equal(app.tracks.length, 1, 'Successful completion still commits the track');
    assert.equal(app._trackDraw, null);
    assert.equal(app.viewport.crosshairContainer.style.display, 'block', 'Completion also retains the selected tool crosshair');
}
for (const leave of [
    app => selectPcbTool(app, 'select'),
    app => preparePcbRibbonTransition(app, 'pcb-properties', 'pcb-home', true),
    app => app._cancelDrawingMode(),
]) {
    const { app } = drawingFixture('track');
    leave(app);
    assert.equal(app._trackDraw, null);
    assert.equal(app.currentTool, 'select');
    assert.equal(app.viewport.crosshairContainer.style.display, 'none', 'Leaving drawing mode still clears the crosshair');
}
{
    const { app } = drawingFixture('track');
    app.currentTool = 'select';
    cancelTrackDraw(app);
    assert.equal(app.viewport.crosshairContainer.style.display, 'none', 'Teardown without the track tool still hides the crosshair');
}
console.log('PASS staged PCB Escape: preview rollback, gesture/tool handoff, stationary crosshair, history and native input ownership');
