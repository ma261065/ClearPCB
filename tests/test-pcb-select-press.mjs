/** PCB select-tool press: phase priority chain, and component presses through the shared drag start. */
import assert from 'node:assert/strict';

const noop = () => {};
const element = () => ({
    style: {}, dataset: {}, children: [], classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, appendChild: child => child,
    insertBefore: child => child, remove: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
});
globalThis.window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1 };
globalThis.document = { body: element(), documentElement: { getAttribute: () => 'dark' }, createElement: element,
    createElementNS: element, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop };
globalThis.HTMLElement = class HTMLElement {};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { PcbDocument } = await import('../src/core/PcbDocument.js');
const { areDragOverlaysDeferred } = await import('../src/pcb/modules/refresh-state.js');

const PHASES = ['_pressSelectionInteraction', '_pressToggleShape', '_pressBoxSelection',
    '_pressCurrentSelection', '_pressNewTarget'];
const press = (extra = {}) => ({ button: 0, clientX: 5, clientY: 6, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

// Phases run in priority order and stop at the first that handles the press.
for (let handledAt = 0; handledAt < PHASES.length; handledAt++) {
    const calls = [];
    const app = Object.create(PCBApp.prototype);
    PHASES.forEach((name, index) => {
        app[name] = (...args) => { calls.push([name, ...args]); return index === handledAt; };
    });
    const world = { x: 1, y: 2 };
    app._pressSelectTool(press({ metaKey: true }), world, 'group-hit');
    assert.deepEqual(calls.map(([name]) => name), PHASES.slice(0, handledAt + 1),
        `${PHASES[handledAt]} ends the chain`);
    assert.equal(calls[0][3], true, 'Cmd/Ctrl makes the press additive');
    if (handledAt >= 2) assert.equal(calls[2][2], 'group-hit', 'box phase receives the group hit');
}

// A press on a component selects it and starts the shared drag, unless the placement is locked.
for (const locked of [false, true]) {
    const pcbDocument = new PcbDocument();
    const svg = element();
    const placement = { x: 10, y: 20, locked };
    const app = Object.assign(Object.create(PCBApp.prototype), {
        pcbDocument, viewport: { svg, scale: 10 }, _layerGroups: new Map(), _clearancesVisible: false,
        placements: new Map([['U1', placement]]),
        getLayerGroup: () => null,
    });
    for (const name of ['tracks', 'vias', 'pads', 'boardShapes', 'texts']) {
        const descriptor = Object.getOwnPropertyDescriptor(PCBApp.prototype, name);
        if (descriptor) Object.defineProperty(app, name, { ...descriptor, configurable: true });
    }
    const selected = [];
    Object.assign(app, {
        _hitTestText: () => null, _hitTestRefText: () => null, _hitTestComponent: () => 'U1',
        _selectComponent: id => selected.push(id), _selectBoardOutline: noop, selectText: noop, _selectRefText: noop,
        _showComponentProperties: noop, _hoverComponent: noop, _hideNetTooltip: noop,
        _netsForComponent: () => new Set(['N1']), selectFill: noop,
    });
    app._pressNewTarget(press(), { x: 10, y: 20 });
    assert.equal(selected.at(-1), 'U1', `${locked ? 'locked' : 'unlocked'} component is selected`);
    if (locked) {
        assert.equal(app._drag, undefined, 'a locked component does not enter drag state');
        assert.notEqual(svg.style.cursor, 'grabbing');
        assert.equal(areDragOverlaysDeferred(app), false, 'and overlays are not deferred');
    } else {
        assert.deepEqual(app._drag, { compId: 'U1', startWorld: { x: 10, y: 20 }, startPos: { x: 10, y: 20 }, nets: new Set(['N1']) });
        assert.equal(svg.style.cursor, 'grabbing');
        assert.equal(areDragOverlaysDeferred(app), true, 'drag defers pours and halos');
    }
}

console.log('PASS select-tool press: phase priority, additive flag, component drag start and locked placements');
