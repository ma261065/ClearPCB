import assert from 'node:assert/strict';

const noop = () => {};
const element = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, appendChild: child => child, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
});
globalThis.window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1 };
globalThis.document = {
    body: element(), documentElement: { getAttribute: () => 'dark' },
    createElement: element, createElementNS: element,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
};
globalThis.HTMLElement = class HTMLElement {};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { PCB_CROSSHAIR_TOOLS } = await import('../src/pcb/modules/tool-lifecycle.js');

const PRESS_METHODS = ['_pressSelectTool', '_pressTrackTool', '_pressFillTool', '_pressViaTool',
    '_pressPadTool', '_pressShapeTool', '_pressTextTool'];
for (const name of PRESS_METHODS) assert.equal(typeof PCBApp.prototype[name], 'function', `PCBApp.${name}`);

function fixture(tool) {
    const listeners = new Map();
    const calls = [];
    const world = { x: 3, y: -4 };
    const svg = { ...element(), addEventListener(type, listener) { listeners.set(type, listener); } };
    const viewport = {
        svg, scale: 10, shiftHeld: false,
        onInteractionStart: noop, hideCrosshair: noop, startPan: (x, y) => calls.push(['pan', x, y]),
    };
    const app = Object.assign(Object.create(PCBApp.prototype), {
        _active: true, currentTool: tool, viewport,
        _screenToWorld: () => world,
        _endPasteDrop: () => calls.push(['endPasteDrop']),
    });
    for (const name of PRESS_METHODS) app[name] = (...args) => calls.push([name, ...args]);
    app._bindMouseEvents();
    const press = (button, extra = {}) => listeners.get('mousedown')({
        button, clientX: 10, clientY: 20, shiftKey: false, ctrlKey: false, metaKey: false, detail: 1,
        preventDefault: noop, ...extra,
    });
    return { app, calls, press, world };
}

const expected = {
    select: '_pressSelectTool', track: '_pressTrackTool', fill: '_pressFillTool', via: '_pressViaTool',
    pad: '_pressPadTool', line: '_pressShapeTool', circle: '_pressShapeTool', rect: '_pressShapeTool',
    polygon: '_pressShapeTool', arc: '_pressShapeTool', text: '_pressTextTool',
};
// Every selectable tool handles a primary press, so a new tool cannot silently ignore clicks.
for (const tool of ['select', ...PCB_CROSSHAIR_TOOLS]) {
    assert.ok(expected[tool], `${tool} has an expected press handler`);
}

for (const [tool, method] of Object.entries(expected)) {
    const { calls, press, world } = fixture(tool);
    press(0);
    assert.equal(calls.length, 1, `${tool}: one handler per primary press`);
    const [name, event, worldPos] = calls[0];
    assert.equal(name, method, `${tool} routes to ${method}`);
    assert.equal(event.button, 0);
    // Only the select tool receives the pre-computed select-mode world position.
    assert.equal(worldPos, tool === 'select' ? world : null);

    for (const button of [1, 2]) {
        const other = fixture(tool);
        other.press(button);
        assert.deepEqual(other.calls, [['pan', 10, 20]], `${tool}: button ${button} pans instead of pressing`);
    }
}

{
    const { app, calls, press } = fixture('track');
    app._pasteDrop = {};
    press(0);
    assert.deepEqual(calls, [['endPasteDrop']], 'A floating paste consumes the press before any tool');
}
{
    const { calls, press } = fixture('measure');
    assert.doesNotThrow(() => press(0));
    assert.deepEqual(calls, [], 'Unknown tools ignore primary presses');
}
{
    const { app, calls, press } = fixture('select');
    app._active = false;
    press(0);
    assert.deepEqual(calls, [], 'Inactive editors ignore presses');
}

console.log('PASS PCB pointer press: per-tool dispatch, pan buttons, paste drop, unknown tools and inactive editor');
