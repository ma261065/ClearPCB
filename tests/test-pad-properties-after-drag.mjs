import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById() { return null; } };
let frameId = 0;
globalThis.requestAnimationFrame = () => ++frameId;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { Pad } = await import('../src/shapes/pad.js');
const { setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { beginGroupDrag, updateGroupDrag, endGroupDrag } = await import('../src/pcb/modules/box-select.js');

function fixture(count) {
    const controls = new Map();
    for (const name of ['Shape', 'Layers', 'Net', 'Size', 'Ratio', 'Drill', 'Rotation']) {
        controls.set(`#pcbPropPad${name}`, {
            value: '', listeners: new Map(),
            addEventListener(type, listener) { this.listeners.set(type, listener); },
            emit(type) { this.listeners.get(type)?.({ target: this }); },
        });
    }
    const app = Object.create(PCBApp.prototype);
    Object.assign(app, {
        pads: Array.from({ length: count }, (_, index) => new Pad({
            x: index * 3, y: index % 2, shape: 'rectangle', layers: 'both', rotation: index * 10,
        })),
        tracks: [], vias: [], boardShapes: [], placements: new Map(), netlist: [], texts: new Map(),
        _getLayerGroup() { return null; },
        viewport: { setCrosshair() {}, hideCrosshair() {} },
        _pcbPropsItems: () => ({ innerHTML: '', querySelector: selector => controls.get(selector) }),
        _setPcbPropsTitle() {}, _setActiveRibbonTab() {}, _setPcbStatus() {}, _refreshFills() {},
        _bindToolNetControl(items, id, apply) {
            items.querySelector(`#${id}`).addEventListener('change', event => apply(event.target.value));
        },
    });
    const commands = [];
    app.history = { execute(command) { commands.push(command); command.execute(); } };
    setPcbSelection(app, app.pads.map(object => ({ kind: 'pad', object })));
    app._showPadEditor(app.pads[0]);
    return { app, commands, controls };
}

for (const count of [1, 6]) {
    for (const [name, property, value, numeric] of [
        ['Layers', 'layers', 'top-copper', false],
        ['Net', 'net', 'SIGNAL', false],
        ['Shape', 'shape', 'oval', false],
        ['Rotation', 'rotation', 90, true],
        ['Size', 'size', 0.5, true],
        ['Ratio', 'ratio', 3, true],
        ['Drill', 'drill', 0.4, true],
    ]) {
        const { app, commands, controls } = fixture(count);
        const initial = app.pads.map(pad => pad.captureState());
        beginGroupDrag(app, { x: 0, y: 0 });
        updateGroupDrag(app, { x: 20, y: -30 }, { snap: false });
        endGroupDrag(app);
        const moved = app.pads.map(pad => pad.captureState());
        assert.equal(commands.length, 1);
        assert.deepEqual(moved.map(pad => [pad.x, pad.y]), initial.map(pad => [pad.x + 20, pad.y - 30]));

        const input = controls.get(`#pcbPropPad${name}`);
        input.value = String(value);
        if (numeric) input.emit('input');
        input.emit('change');
        const expected = moved.map(pad => ({
            ...pad, [property]: value,
            ...(property === 'size' ? { drill: Math.min(pad.drill, value) } : {}),
        }));
        assert.deepEqual(app.pads.map(pad => pad.captureState()), expected,
            `${name} must preserve the dragged positions of all ${count} Pads`);
        assert.equal(commands.length, 2);
        commands[1].undo();
        assert.deepEqual(app.pads.map(pad => pad.captureState()), moved, `${name} Undo must not undo the move`);
        commands[0].undo();
        assert.deepEqual(app.pads.map(pad => pad.captureState()), initial);
        commands[0].execute();
        commands[1].execute();
        assert.deepEqual(app.pads.map(pad => pad.captureState()), expected);

        if (numeric) {
            commands[1].undo();
            input.value = property === 'rotation' ? '180' : String(Number(value) + 0.1);
            input.emit('input');
            input.value = String(value);
            input.emit('input');
            input.emit('change');
            commands[2].undo();
            assert.deepEqual(app.pads.map(pad => pad.captureState()), moved,
                'a new live edit after Undo captures current state only once');
        }
    }
}

{
    const { app, commands, controls } = fixture(6);
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 20, y: -30 }, { snap: false });
    endGroupDrag(app);
    controls.get('#pcbPropPadRotation').emit('change');
    assert.equal(commands.length, 1, 'an untouched field must not record the preceding drag as a property edit');
}

console.log('PASS Pad properties after dragging: live edits, layers, Net, geometry and independent Undo/Redo');
