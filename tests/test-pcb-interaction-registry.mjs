import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';
import { PcbDocument } from '../src/core/PcbDocument.js';

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
const { dispatchPcbPointerMove, cancelPcbPointerGestures, releasePcbPointerGestures, createPointerMoveDispatch, createPointerGestureFinishers, PCB_RELEASE_OUTCOMES, PCB_INTERACTION_ROUTES } = await import('../src/pcb/modules/pcb-interaction-routing.js');
const { beginPcbPaste, getPcbPaste } = await import('../src/pcb/modules/pcb-paste.js');
const { armBoxSelect, isBoxSelectArmed } = await import('../src/pcb/modules/box-select.js');
const { importSpecifiers } = await import('../tools/check-imports.mjs');

const root = fileURLToPath(new URL('../', import.meta.url));
const keys = PCB_INTERACTIONS.map(entry => entry.key);

// 1. Every interaction-like editor field is registered (or is a persistent refinement selection).
const EXEMPT = new Map([
    ['_trackEdit', 'persistent track refinement selection, not an in-progress gesture'],
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
for (const file of pcbSources) {
    const relative = file.slice(join(root, 'src/pcb/modules').length + 1).replaceAll('\\', '/');
    const basename = relative.split('/').at(-1);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bsetPcbInteraction\(\s*app\s*,\s*['"](_[^'"]+)['"]/g)) {
        const entry = PCB_INTERACTIONS.find(item => item.key === match[1]);
        assert.ok(entry, `${basename} writes unknown interaction ${match[1]}`);
        assert.equal(basename, entry.owner, `${match[1]} may only be written by ${entry.owner}`);
    }
}

// 2. Derived sets reproduce the lists they replaced.
const keysOf = predicate => keys.filter(key => {
    const app = {};
    setPcbInteraction(app, key, {});
    return predicate(app);
});
assert.deepEqual(keysOf(hasPcbGesture).sort(), ['_boardOutlineResize', '_drag', '_groupDrag', '_pasteDrop',
    '_pcbSelectionInteraction', '_refDrag', '_rotationHandleDrag', '_shapeDrag', '_textDrag', '_textEdit',
    '_vertexDrag', '_viaDrag']);
assert.deepEqual(keysOf(isPcbDrawing).sort(), ['_fillDraw', '_shapeDraw', '_trackDraw']);
assert.deepEqual(keysOf(blocksPcbExport).sort(), ['_boardOutlineResize', '_rotationHandleDrag', '_shapeDrag',
    '_textEdit', '_vertexDrag', '_viaDrag']);
for (const predicate of [hasPcbGesture, isPcbDrawing, blocksPcbExport]) {
    assert.equal(predicate({}), false);
    const app = {};
    for (const key of ['_drag', '_trackDraw', '_rotationHandleDrag']) setPcbInteraction(app, key, null);
    assert.equal(predicate(app), false);
}

// 3. Pointer-move priority matches the former mousemove chain.
assert.deepEqual(PCB_INTERACTION_ROUTES.move, ['_boardOutlineResize', '_pasteDrop', '_pcbSelectionInteraction',
    '_drag', '_groupDrag', '_textDrag', '_shapeDrag', '_refDrag', '_vertexDrag', '_viaDrag',
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
        const app = {};
        setPcbInteraction(app, key, true);
        assert.equal(dispatch(app, null), true, `${key} is dispatched`);
        assert.deepEqual(routed, [key]);
        for (const later of order.slice(index + 1)) {
            routed = [];
            const app = {};
            setPcbInteraction(app, key, true);
            setPcbInteraction(app, later, true);
            dispatch(app, null);
            assert.deepEqual(routed, [key], `${key} takes priority over ${later}`);
            declining = key;
            routed = [];
            dispatch(app, null);
            declining = null;
            assert.deepEqual(routed, [key, later], `${later} handles a move ${key} declines`);
        }
    }
    routed = [];
    const withoutMove = keys.filter(key => !order.includes(key));
    assert.deepEqual(withoutMove, ['_textEdit', '_rotationHandleDrag']);
    const app = {};
    for (const key of withoutMove) setPcbInteraction(app, key, true);
    assert.equal(dispatch(app, null), false);
    assert.deepEqual(routed, [], 'Interactions without a move handler fall through to the active tool');
}
const event = { clientX: 0, clientY: 0 };
assert.equal(dispatchPcbPointerMove({ viewport: { svg: { style: {} }, scale: 1 } }, event), false,
    'Idle moves fall through to the active tool');
// The real table: paste outranks a component drag, and interactions without a move handler fall through.
{
    const app = { pcbDocument: new PcbDocument(), _shapeElements: new Map(),
        viewport: { svg: { style: {} }, scale: 1, setCrosshair() {}, hideCrosshair() {} },
        screenToWorld: () => ({ x: 1, y: 1 }), snapToGrid: point => point,
        getLayerGroup: () => ({ querySelectorAll: () => [], appendChild() {} }), syncClipboardButtons() {} };
    beginPcbPaste(app, { shapes: [{ id: 'paste-shape', kind: 'line', layer: 'top-silk',
        points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] });
    setPcbInteraction(app, '_drag', {});
    assert.equal(dispatchPcbPointerMove(app, event), true);
    assert.equal(getPcbPaste(app)?.dx, 0.5, '_pasteDrop+_drag routes to paste');
    const idle = { viewport: { svg: { style: {} }, scale: 1 } };
    setPcbInteraction(idle, '_textEdit', {});
    setPcbInteraction(idle, '_rotationHandleDrag', true);
    assert.equal(dispatchPcbPointerMove(idle, event), false, 'Inline edit and rotation handles leave moves to the tool');
}

// 4. Cancellation covers the selection wrapper first, then each pointer drag.
assert.deepEqual(PCB_INTERACTION_ROUTES.cancel, ['_pcbSelectionInteraction', '_drag', '_groupDrag', '_textDrag',
    '_shapeDrag', '_refDrag', '_vertexDrag', '_viaDrag']);
{
    const ended = [];
    const { cancel } = createPointerGestureFinishers({
        _drag: { cancel: () => ended.push('drag') },
        _textDrag: { cancel: () => ended.push('text') },
        _refDrag: { cancel: () => ended.push('ref') },
    });
    const app = {};
    setPcbInteraction(app, '_refDrag', {});
    setPcbInteraction(app, '_drag', {});
    cancel(app);
    assert.deepEqual(ended, ['drag', 'ref'], 'Only active drags are cancelled, in table order');
    const routing = readFileSync(join(root, 'src/pcb/modules/pcb-interaction-routing.js'), 'utf8');
    const cancels = [...routing.matchAll(/^\s*cancel: app => \{ (.+) \},$/gm)].map(match => match[1]);
    assert.ok(cancels.length >= 6);
    for (const body of cancels) {
        assert.doesNotMatch(body, /\b(?:end|finish)\w*\(app(?:, true)?\)/, `Cancelling never commits: ${body}`);
    }
}

// 5. Primary releases finish gestures in table order; the selection wrapper's own drags are skipped once it finishes.
assert.deepEqual(PCB_INTERACTION_ROUTES.release, ['_boardOutlineResize', '_pcbSelectionInteraction', '_drag',
    '_groupDrag', '_textDrag', '_shapeDrag', '_refDrag', '_vertexDrag', '_viaDrag']);
{
    let released = [];
    let marquee = 0;
    let selectionOutcome;
    const { release } = createPointerGestureFinishers({
        _boardOutlineResize: { release: () => { released.push('outline'); return PCB_RELEASE_OUTCOMES.consumed; } },
        _pcbSelectionInteraction: { release: () => { released.push('selection'); return selectionOutcome; } },
        _drag: { release: (_app, world) => { released.push(['drag', world]); } },
        _shapeDrag: { wrapped: true, release: () => { released.push('shape'); } },
        _refDrag: { release: () => { released.push('ref'); } },
    }, () => { marquee++; });
    const world = { x: 1, y: 2 };
    const app = {};
    setPcbInteraction(app, '_refDrag', {});
    setPcbInteraction(app, '_drag', {});
    release(app, world);
    assert.deepEqual(released, [['drag', world], 'ref'], 'Active drags are committed in table order');
    assert.equal(marquee, 1, 'A pending marquee finishes last');

    released = [];
    const wrapped = {};
    setPcbInteraction(wrapped, '_pcbSelectionInteraction', {});
    setPcbInteraction(wrapped, '_shapeDrag', {});
    selectionOutcome = PCB_RELEASE_OUTCOMES.wrapperFinished;
    release(wrapped, world);
    assert.deepEqual(released, ['selection'], 'A finished selection interaction ends the drag it wraps');
    selectionOutcome = undefined;
    released = [];
    release(wrapped, world);
    assert.deepEqual(released, ['selection', 'shape'], 'A wrapped drag finishes itself when the wrapper did not');

    released = [];
    marquee = 0;
    const resizing = {};
    setPcbInteraction(resizing, '_boardOutlineResize', {});
    setPcbInteraction(resizing, '_drag', {});
    release(resizing, world);
    assert.deepEqual(released, ['outline'], 'The board-outline resize consumes its release');
    assert.equal(marquee, 0);
}
{
    const app = {
        viewport: { svg: { style: {} } },
    };
    armBoxSelect(app, {}, {});
    releasePcbPointerGestures(app, { x: 1, y: 2 });
    assert.equal(isBoxSelectArmed(app), false, 'An armed marquee that never started is disarmed');
}

// 6. The data table stays importable from worker-loaded export code.
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

console.log('PASS PCB interaction registry: field coverage, derived predicates, move priority, release order, cancellation and worker isolation');
