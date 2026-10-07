#!/usr/bin/env node
// Measures PCB mousemove routing cost: the real PCBApp listener with its gesture
// handlers stubbed, so only the dispatch between gestures is timed.
//
// Usage: node tools/bench-pointer-dispatch.mjs [iterations]
// Compare medians before and after interaction-routing changes on the same machine.

const noop = () => {};
const element = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, appendChild: child => child, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
});
globalThis.window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1 };
globalThis.requestAnimationFrame = () => 1;
globalThis.document = {
    body: element(), documentElement: { getAttribute: () => 'dark' },
    createElement: element, createElementNS: element,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const { default: PCBApp } = await import('../src/ui/PCBApp.js');

const listeners = new Map();
const svg = { ...element(), addEventListener(type, listener) { listeners.set(type, listener); } };
const viewport = {
    svg, isPanning: false, shiftHeld: false, scale: 10,
    trackMouse: noop, updatePan: noop, onInteractionStart: noop, hideCrosshair: noop,
};
const world = { x: 1, y: 2 };
let handled = 0;
const count = () => { handled++; };
const app = Object.assign(Object.create(PCBApp.prototype), {
    currentTool: 'select', viewport,
    _screenToWorld: () => world, _updateDebugTooltip: noop,
    _scheduleDragUpdate: count, _handleTextDrag: count,
    _handleRefDrag: count, _handleFillDrag: count, _updateCursorCrosshair: noop,
});
app._bindMouseEvents();
const move = listeners.get('mousemove');
if (!move) throw new Error('PCBApp did not bind a mousemove listener.');

const CLEARED = ['_drag', '_textDrag', '_refDrag', '_fillDrag', '_pcbSelectionInteraction',
    '_boardOutlineResize', '_pasteDrop', '_groupDrag', '_shapeDrag', '_vertexDrag', '_viaDrag',
    '_trackDraw', '_fillDraw', '_shapeDraw', '_boxSelectArm', '_boxSelectActive'];
const scenarios = {
    'idle hover (full chain)': {},
    'component drag': { _drag: {} },
    'text drag': { _textDrag: {} },
    'reference drag': { _refDrag: {} },
    'fill drag (late in chain)': { _fillDrag: {} },
    'panning': { panning: true },
};

const iterations = Number(process.argv[2]) || 2_000_000;
const event = { clientX: 10, clientY: 20, shiftKey: false };
const results = [];
for (const [name, state] of Object.entries(scenarios)) {
    for (const key of CLEARED) app[key] = null;
    viewport.isPanning = !!state.panning;
    for (const [key, value] of Object.entries(state)) if (key !== 'panning') app[key] = value;
    for (let i = 0; i < iterations / 10; i++) move(event);
    const samples = [];
    for (let run = 0; run < 7; run++) {
        handled = 0;
        const start = process.hrtime.bigint();
        for (let i = 0; i < iterations; i++) move(event);
        samples.push(Number(process.hrtime.bigint() - start) / iterations);
    }
    if (!state.panning && name !== 'idle hover (full chain)' && handled !== iterations) {
        throw new Error(`${name}: expected ${iterations} handler calls, got ${handled}.`);
    }
    samples.sort((a, b) => a - b);
    results.push({ scenario: name, 'median ns/event': samples[3].toFixed(1), 'min ns/event': samples[0].toFixed(1) });
}
console.table(results);
