import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindPictureRefreshHold, schedulePictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';

const eventTarget = () => {
    const listeners = new Map();
    return {
        value: '',
        addEventListener(name, handler) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(handler);
        },
        removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
        fire(type, details = {}) { for (const handler of [...(listeners.get(type) || [])]) handler({ type, ...details }); },
    };
};
globalThis.window = eventTarget();
globalThis.document = { createElementNS() {
    const attributes = new Map();
    return { style: {}, setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name); }, appendChild() {}, remove() {} };
} };
const { ModifyBoardShapeCommand } = await import('../src/pcb/modules/shape-commands.js');
const { cloneShapeGeometry } = await import('../src/pcb/modules/board-shapes.js');
const { EditTextCommand, AddTextCommand, RemoveTextCommand } = await import('../src/pcb/modules/text-commands.js');
const source = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
const start = source.indexOf('    _bindStrokeTextProps(items, model, spec) {');
const end = source.indexOf('\n    /**', start);
const bindText = new Function('bindPictureRefreshHold', 'schedulePictureCopperRefresh',
    `return ({ ${source.slice(start, end)} })._bindStrokeTextProps;`)(bindPictureRefreshHold, schedulePictureCopperRefresh);
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let timerId = 0;
let refreshes = 0;
const app = {
    boardShapes: [], texts: new Map(), placements: new Map(), tracks: [], vias: [],
    _shapeElements: new Map(), _boardShapeClearanceCache: new Map(),
    _getLayerGroup() { return null; },
    _refreshFills() { refreshes++; return false; },
    _updateRatsnest() {}, _renderText() {}, _removeTextElement() {}, _selectText() {},
    _refreshText() { assert.equal(this._pictureCopperRefreshPending, true); },
};
const snapshot = shape => ({ kind: shape.kind, geom: cloneShapeGeometry(shape), layer: shape.layer,
    net: shape.net || '', lineWidth: shape.lineWidth, filled: shape.filled, copperMode: 'add' });
try {
    globalThis.setTimeout = (callback, delay) => {
        assert.equal(delay, 100);
        timers.set(++timerId, callback);
        return timerId;
    };
    globalThis.clearTimeout = id => { timers.delete(id); };
    const flush = () => {
        const callbacks = [...timers.values()];
        timers.clear();
        callbacks.forEach(callback => callback());
    };
    for (const shape of [
        { kind: 'circle', x: 0, y: 0, radius: 3 },
        { kind: 'rect', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }] },
        { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 3 }] },
        { kind: 'line', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] },
        { kind: 'arc', start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, bulge: { x: 2, y: 2 } },
    ]) {
        Object.assign(shape, { id: shape.kind, layer: 'top-copper', lineWidth: 0.2, filled: false });
        app.boardShapes = [shape];
        const before = snapshot(shape);
        const after = { ...before, lineWidth: 0.4 };
        const command = new ModifyBoardShapeCommand(app, shape, before, after);
        const count = refreshes;
        command.execute();
        assert.equal(shape.lineWidth, 0.4);
        command.undo();
        assert.equal(shape.lineWidth, 0.2);
        command.execute();
        assert.equal(refreshes, count, `${shape.kind} does not rebuild copper synchronously`);
        assert.equal(timers.size, 1);
        flush();
        assert.equal(refreshes, count + 1);
    }

    const text = { id: 'text-1', content: 'O', layer: 'top-copper', size: 1, rotation: 0, strokeWidth: 0.2, x: 0, y: 0 };
    app.texts.set(text.id, text);
    for (const field of ['size', 'rotation', 'strokeWidth']) {
        const input = eventTarget();
        let command;
        bindText.call(app, { querySelector() { return input; } }, text, {
            fields: [{ id: 'test', field, parse: value => Number(value), wrap: field === 'rotation' }],
            preview(model) { app._refreshText(model.id); },
            commit(model, before) {
                const after = { [field]: model[field] };
                Object.assign(model, before);
                command = new EditTextCommand(app, model.id, after);
                command.execute();
            },
        });
        const original = text[field];
        const count = refreshes;
        input.fire('pointerdown', { button: 0, pointerId: 7 });
        for (const value of [2, 3, 4]) {
            input.value = String(value);
            input.fire('input');
            assert.equal(text[field], value);
            assert.equal(timers.size, 0, 'Text spinner hold does not start a refresh timer');
        }
        input.fire('change');
        assert.equal(refreshes, count);
        window.fire('pointerup', { pointerId: 7 });
        assert.equal(timers.size, 1);
        flush();
        assert.equal(refreshes, count + 1);
        command.undo();
        assert.equal(text[field], original);
        flush();
    }
    const remove = new RemoveTextCommand(app, text.id);
    remove.execute();
    assert.equal(app.texts.has(text.id), false);
    remove.undo();
    assert.equal(app.texts.has(text.id), true);
    const added = { ...text, id: 'text-2' };
    const add = new AddTextCommand(app, added);
    add.execute();
    add.undo();
    assert.equal(app.texts.has(added.id), false);
    assert.equal(timers.size, 1);
    flush();
} finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
}
console.log('PASS all board-shape kinds and text property holds share deferred updates, undo and lifecycle refreshes');