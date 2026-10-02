import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const { PCB_INTERACTIONS, hasPcbGesture, isPcbDrawing, blocksPcbExport } = await import('../src/pcb/modules/pcb-interactions.js');
const { dispatchPcbPointerMove, cancelPcbPointerGestures, createPointerMoveDispatch, PCB_INTERACTION_ROUTES } = await import('../src/pcb/modules/pcb-interaction-routing.js');
const { importSpecifiers } = await import('../tools/check-imports.mjs');

const root = fileURLToPath(new URL('../', import.meta.url));
const keys = PCB_INTERACTIONS.map(entry => entry.key);

// 1. Every interaction-like editor field is registered (or is a persistent refinement selection).
const EXEMPT = new Map([
    ['_trackEdit', 'persistent track refinement selection, not an in-progress gesture'],
    ['_fillEdit', 'persistent fill refinement selection, not an in-progress gesture'],
]);
const pcbSources = [
    ...readdirSync(join(root, 'src/pcb/modules')).filter(name => name.endsWith('.js')).map(name => join(root, 'src/pcb/modules', name)),
    join(root, 'src/ui/PCBApp.js'),
];
const assigned = new Set();
for (const file of pcbSources) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:app|this)\.(_[A-Za-z]+(?:Drag|Draw|Drop|Resize|Edit|Interaction))\s*=[^=]/g)) {
        assigned.add(match[1]);
    }
}
const unregistered = [...assigned].filter(key => !keys.includes(key) && !EXEMPT.has(key));
assert.deepEqual(unregistered, [], 'Register new in-progress editor fields in pcb-interactions.js');
assert.equal(new Set(keys).size, keys.length, 'Interaction keys are unique');

// 2. Derived sets reproduce the lists they replaced.
const keysOf = predicate => keys.filter(key => predicate({ [key]: {} }));
assert.deepEqual(keysOf(hasPcbGesture).sort(), ['_boardOutlineResize', '_drag', '_fillDrag', '_groupDrag', '_pasteDrop',
    '_pcbSelectionInteraction', '_refDrag', '_rotationHandleDrag', '_shapeDrag', '_textDrag', '_textEdit',
    '_vertexDrag', '_viaDrag']);
assert.deepEqual(keysOf(isPcbDrawing).sort(), ['_fillDraw', '_shapeDraw', '_trackDraw']);
assert.deepEqual(keysOf(blocksPcbExport).sort(), ['_boardOutlineResize', '_rotationHandleDrag', '_shapeDrag',
    '_textEdit', '_vertexDrag', '_viaDrag']);
for (const predicate of [hasPcbGesture, isPcbDrawing, blocksPcbExport]) {
    assert.equal(predicate({}), false);
    assert.equal(predicate({ _drag: null, _trackDraw: undefined, _rotationHandleDrag: false }), false);
}

// 3. Pointer-move priority matches the former mousemove chain.
assert.deepEqual(PCB_INTERACTION_ROUTES.move, ['_boardOutlineResize', '_pasteDrop', '_pcbSelectionInteraction',
    '_drag', '_groupDrag', '_textDrag', '_shapeDrag', '_refDrag', '_vertexDrag', '_viaDrag', '_fillDrag',
    '_trackDraw', '_fillDraw', '_shapeDraw']);
// The hand-written dispatcher routes exactly that order: every pair, plus declined fall-through.
{
    const order = PCB_INTERACTION_ROUTES.move;
    let routed = [];
    let declining = null;
    const dispatch = createPointerMoveDispatch(Object.fromEntries(order.map(key => [key, { move: () => {
        routed.push(key);
        return key === declining ? false : undefined;
    } }])));
    for (const [index, key] of order.entries()) {
        routed = [];
        assert.equal(dispatch({ [key]: true }, null), true, `${key} is dispatched`);
        assert.deepEqual(routed, [key]);
        for (const later of order.slice(index + 1)) {
            routed = [];
            dispatch({ [key]: true, [later]: true }, null);
            assert.deepEqual(routed, [key], `${key} takes priority over ${later}`);
            declining = key;
            routed = [];
            dispatch({ [key]: true, [later]: true }, null);
            declining = null;
            assert.deepEqual(routed, [key, later], `${later} handles a move ${key} declines`);
        }
    }
    routed = [];
    const withoutMove = keys.filter(key => !order.includes(key));
    assert.deepEqual(withoutMove, ['_textEdit', '_rotationHandleDrag']);
    assert.equal(dispatch(Object.fromEntries(withoutMove.map(key => [key, true])), null), false);
    assert.deepEqual(routed, [], 'Interactions without a move handler fall through to the active tool');
}
const calls = [];
const editor = state => ({
    viewport: { svg: { style: {} }, scale: 1 },
    _screenToWorld: () => ({ x: 0, y: 0 }),
    _updatePasteDrop: () => calls.push('paste'),
    _scheduleDragUpdate: () => calls.push('drag'),
    _handleTextDrag: () => calls.push('text'),
    _handleRefDrag: () => calls.push('ref'),
    _handleFillDrag: () => calls.push('fill'),
    ...state,
});
const event = { clientX: 0, clientY: 0 };
assert.equal(dispatchPcbPointerMove(editor({}), event), false, 'Idle moves fall through to the active tool');
assert.deepEqual(calls, []);
for (const [state, expected] of [
    [{ _drag: {} }, 'drag'], [{ _textDrag: {} }, 'text'], [{ _refDrag: {} }, 'ref'], [{ _fillDrag: {} }, 'fill'],
    [{ _pasteDrop: {}, _drag: {} }, 'paste'],
    [{ _drag: {}, _textDrag: {} }, 'drag'],
    [{ _pcbSelectionInteraction: { mode: 'unrecognised' }, _textDrag: {} }, 'text'],
    [{ _textEdit: {}, _rotationHandleDrag: true, _refDrag: {} }, 'ref'],
]) {
    calls.length = 0;
    assert.equal(dispatchPcbPointerMove(editor(state), event), true);
    assert.deepEqual(calls, [expected], `${Object.keys(state).join('+')} routes to ${expected}`);
}

// 4. Cancellation covers the selection wrapper first, then each pointer drag.
assert.deepEqual(PCB_INTERACTION_ROUTES.cancel, ['_pcbSelectionInteraction', '_drag', '_groupDrag', '_textDrag',
    '_shapeDrag', '_refDrag', '_vertexDrag', '_viaDrag', '_fillDrag']);
const ended = [];
cancelPcbPointerGestures({
    _drag: {}, _refDrag: {}, _textDrag: null,
    _endDrag: commit => ended.push(['drag', commit]),
    _endRefDrag: commit => ended.push(['ref', commit]),
    _endTextDrag: () => ended.push(['text']),
});
assert.deepEqual(ended, [['drag', false], ['ref', false]], 'Only active drags are cancelled, without committing');

// 5. The data table stays importable from worker-loaded export code.
assert.deepEqual(importSpecifiers(readFileSync(join(root, 'src/pcb/modules/pcb-interactions.js'), 'utf8')), []);
const reachable = new Set();
const visit = file => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
    }
};
visit(join(root, 'src/pcb/modules/gerber-worker.js'));
assert.ok(reachable.has(join(root, 'src/pcb/modules/pcb-interactions.js')), 'Export guard uses the shared table');
assert.ok(!reachable.has(join(root, 'src/pcb/modules/pcb-interaction-routing.js')),
    'Interaction handlers must not load into the Gerber worker');

console.log('PASS PCB interaction registry: field coverage, derived predicates, move priority, cancellation and worker isolation');
