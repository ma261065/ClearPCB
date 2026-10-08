import assert from 'node:assert/strict';
import { getPcbPaste } from '../../src/pcb/modules/pcb-paste.js';
import { getComponentDrag } from '../../src/pcb/modules/component-selection.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import { isEditorActive, setEditorActive } from '../../src/pcb/modules/pcb-editor-api.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';

const noop = () => {};
const windowListeners = new Map();
installFakeDom();
globalThis.window.addEventListener = (type, listener) => windowListeners.set(type, listener);
globalThis.window.removeEventListener = noop;
globalThis.window.devicePixelRatio = 1;
globalThis.HTMLElement = class HTMLElement {};
globalThis.localStorage.setItem = noop;

const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { PCB_TOOLS } = await import('../../src/pcb/modules/pcb-tools.js');
const { getTrackDraw } = await import('../../src/pcb/modules/track-draw.js');
const { getFillDraw } = await import('../../src/pcb/modules/copper-fill-draw.js');
const { getShapeDraw } = await import('../../src/pcb/modules/board-shape-draw.js');
const { isBoxSelectArmed } = await import('../../src/pcb/modules/box-select.js');
const { cancelPcbDrawingMode } = await import('../../src/pcb/modules/tool-lifecycle.js');

function fixture(tool) {
    const listeners = new Map();
    const calls = [];
    const world = { x: 3, y: -4 };
    const svg = fakeElement('svg');
    svg.addEventListener = (type, listener) => { listeners.set(type, listener); };
    const viewport = {
        svg, scale: 10, shiftHeld: false,
        onInteractionStart: noop, hideCrosshair: () => calls.push(['cursor']), startPan: (x, y) => calls.push(['pan', x, y]),
    };
    const app = Object.assign(Object.create(PCBApp.prototype), {
        currentTool: tool, viewport, history: { execute() {} },
        pcbDocument: { tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map() },
        screenToWorld: () => world,
    });
    app._bindMouseEvents();
    const press = (button, extra = {}) => listeners.get('mousedown')({
        button, clientX: 10, clientY: 20, shiftKey: false, ctrlKey: false, metaKey: false, detail: 1,
        preventDefault: noop, ...extra,
    });
    return { app, calls, press, world };
}

// A primary press reaches the active tool's entry in pcb-tools.js and does what that tool
// does, on a real editor; the other buttons pan instead.
function editor(tool) {
    const listeners = new Map();
    const pans = [];
    const svg = fakeElement('svg');
    svg.addEventListener = (type, listener) => { listeners.set(type, listener); };
    const app = pcbEditorFixture({
        currentTool: tool, activeLayer: 'top-silk',
        viewport: {
            svg, scale: 10, zoom: 1, shiftHeld: false, gridVisible: false, snapToGrid: false, gridSize: 1,
            onInteractionStart: noop, hideCrosshair: noop, setCrosshair: noop, startPan: (x, y) => pans.push([x, y]),
            getSnappedPosition: point => ({ ...point }), screenToWorld: () => ({ x: 3, y: -4 }),
        },
        screenToWorld: () => ({ x: 3, y: -4 }),
        snapToGrid: point => ({ ...point }),
        getRoutingParams: () => ({ viaDiameter: 0.6, viaDrill: 0.3 }),
        selectText: noop, showTextProperties: noop, showPadProperties: noop, selectComponent: noop,
        selectFill: noop, clearProperties: noop,
    });
    app.designSettings = app.pcbDocument.designSettings;
    setEditorActive(app, true);
    app._bindMouseEvents();
    const press = (button, extra = {}) => listeners.get('mousedown')({
        button, clientX: 10, clientY: 20, shiftKey: false, ctrlKey: false, metaKey: false, detail: 1,
        preventDefault: noop, ...extra,
    });
    return { app, pans, press };
}

/** Whether the tool acted on the press. */
const acted = {
    select: app => isBoxSelectArmed(app),
    track: app => !!getTrackDraw(app),
    fill: app => !!getFillDraw(app),
    via: app => app.pcbDocument.vias.length === 1,
    pad: app => app.pcbDocument.pads.length === 1,
    text: app => app.pcbDocument.texts.size === 1,
};
for (const shape of ['line', 'circle', 'arc', 'rect', 'polygon']) acted[shape] = app => getShapeDraw(app)?.kind === shape;
assert.deepEqual(Object.keys(acted).sort(), Object.keys(PCB_TOOLS).sort(), 'every tool is checked');

for (const tool of Object.keys(PCB_TOOLS)) {
    const { app, press } = editor(tool);
    press(0);
    assert.ok(acted[tool](app), `${tool}: a primary press does what the tool does`);
    // Leave the editor idle: end the draw or text edit the press began.
    cancelPcbDrawingMode(app);
    setEditorActive(app, false);
    for (const button of [1, 2]) {
        const other = editor(tool);
        other.press(button);
        assert.deepEqual(other.pans, [[10, 20]], `${tool}: button ${button} pans`);
        assert.ok(!acted[tool](other.app), `${tool}: button ${button} does not press the tool`);
    }
}

{
    const { app, press } = editor('track');
    setPcbInteraction(app, '_pasteDrop', {
        model: app.pcbDocument,
        payload: { tracks: [], vias: [], pads: [], shapes: [], texts: [], fills: [] },
        tracks: [], terminals: [], shapes: [], fills: [], selection: [], flags: {},
        suspensions: { fill: false }, fillPending: false,
    });
    press(0);
    assert.ok(!acted.track(app), 'A floating paste consumes the press before any tool');
    assert.equal(getPcbPaste(app), null);
}
{
    const { press } = editor('measure');
    assert.doesNotThrow(() => press(0), 'Unknown tools ignore primary presses');
}
{
    const { app, press } = editor('select');
    setEditorActive(app, false);
    press(0);
    assert.ok(!acted.select(app), 'Inactive editors ignore presses');
}

// Releases: a right-drag pan ends without a context menu; a primary release finishes the active drag.
{
    const { app, calls, press } = fixture('select');
    const mouseup = windowListeners.get('mouseup');
    const contextmenu = windowListeners.get('contextmenu');
    const viewport = Object.assign(app.viewport, {
        isPanning: false,
        startPan(x, y) { calls.push(['pan', x, y]); this.isPanning = true; },
        endPan() { calls.push(['endPan']); this.isPanning = false; },
    });
    app._clearCursorCrosshair = () => calls.push(['cursor']);
    app.placements = new Map([['part', { x: 0, y: 0 }]]);
    app.refreshClearanceHalos = () => calls.push(['endDrag']);
    app.updateRatsnest = noop;
    const release = (button, clientX) => mouseup({ button, clientX, clientY: 20 });
    const menu = () => {
        let prevented = false;
        contextmenu({ preventDefault: () => { prevented = true; }, stopImmediatePropagation: noop });
        return prevented;
    };

    press(2);
    release(2, 30);
    assert.deepEqual(calls, [['pan', 10, 20], ['endPan'], ['cursor']], 'A right release ends the pan');
    assert.equal(menu(), true, 'A right-drag pan suppresses the browser context menu');
    assert.equal(menu(), false, 'Only the menu that follows the pan is suppressed');

    calls.length = 0;
    press(2);
    release(2, 12);
    assert.equal(menu(), false, 'A stationary right-click keeps its context menu');

    calls.length = 0;
    setPcbInteraction(app, '_drag', { compId: 'part', startPos: { x: 0, y: 0 }, startWorld: { x: 0, y: 0 } });
    release(2, 10);
    assert.deepEqual(calls, [], 'Right releases leave drags running');
    release(0, 10);
    assert.deepEqual(calls, [['cursor'], ['endDrag']], 'A primary release finishes the active drag');
    assert.equal(viewport.isPanning, false);
}

console.log('PASS PCB pointer press: every tool acts on a primary press, pan buttons, paste drop, unknown tools, inactive editor and releases');
