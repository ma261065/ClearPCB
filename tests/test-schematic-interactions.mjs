import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const noop = () => {};
globalThis.window = { addEventListener: noop, removeEventListener: noop };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
globalThis.document = { getElementById: () => null, createElementNS: () => ({ setAttribute: noop, remove: noop, style: {} }) };

const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const {
    SCHEMATIC_INTERACTIONS, hasSchematicGesture, isSchematicDrawing, hasSchematicInteraction, blocksSchematicSnapshot,
    activeSchematicInteraction,
} = await import('../src/schematic/modules/schematic-interactions.js');
const {
    SCHEMATIC_CANCEL_ROUTES, SCHEMATIC_POINTER_GESTURES, SCHEMATIC_MODAL_GESTURES, cancelSchematicInteraction,
    cancelSchematicInteractions,
} = await import('../src/schematic/modules/schematic-interaction-routing.js');
const { canRunSchematicSelectionAction, runSchematicDeleteAction } = await import('../src/schematic/modules/editor-actions.js');
const { captureMoveDragStates } = await import('../src/schematic/modules/drag.js');
const { resolveState } = await import('../src/schematic/modules/draw-states.js');
const { importSpecifiers } = await import('../tools/check-imports.mjs');
const { createRect } = await import('../src/shapes/polyline.js');
const { Wire } = await import('../src/shapes/wire.js');
const { Text } = await import('../src/shapes/text.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');

const keys = SCHEMATIC_INTERACTIONS.map(entry => entry.key);

// The table: unique keys, PCB's two categories, import-free like pcb-interactions.js.
assert.equal(new Set(keys).size, keys.length);
for (const entry of SCHEMATIC_INTERACTIONS) {
    assert.ok(['gesture', 'drawing'].includes(entry.category), `${entry.key} has a PCB category`);
    assert.equal(typeof entry.blocksSnapshot, 'boolean');
}
assert.deepEqual(importSpecifiers(readFileSync(new URL('../src/schematic/modules/schematic-interactions.js', import.meta.url), 'utf8')), []);

// Every interaction has a cancel route; history groups partition the table.
assert.deepEqual([...SCHEMATIC_CANCEL_ROUTES], keys, 'Each table entry has a cancel handler, in table order');
const drawing = SCHEMATIC_INTERACTIONS.filter(entry => entry.category === 'drawing').map(entry => entry.key);
assert.deepEqual([...SCHEMATIC_POINTER_GESTURES, ...SCHEMATIC_MODAL_GESTURES, ...drawing].sort(), [...keys].sort());
assert.equal(SCHEMATIC_POINTER_GESTURES.filter(key => SCHEMATIC_MODAL_GESTURES.includes(key)).length, 0);

// interactionState is derived from the same fields.
const stateFor = fields => resolveState({ currentTool: 'select', ...fields });
assert.equal(stateFor({ pastingClipboard: true }), 'placing');
assert.equal(stateFor({ placingComponent: {} }), 'placing');
assert.equal(stateFor({ isDrawing: true }), 'drawing');
for (const [mode, state] of [['anchor', 'anchorDrag'], ['segment', 'segmentDrag'], ['move', 'moveDrag'], ['box', 'boxSelect']]) {
    assert.equal(stateFor({ drag: { mode } }), state);
}

// Every guard derives from the table: snapshots, selection actions, drawing.
const stateOf = { drag: 'moveDrag', isDrawing: 'drawing', pastingClipboard: 'placing', placingComponent: 'placing', _overlapCyclePress: 'overlapCycle' };
for (const entry of SCHEMATIC_INTERACTIONS) {
    const app = Object.create(SchematicApp.prototype);
    app[entry.key] = entry.key === 'drag' ? { mode: 'move' } : {};
    app.interactionState = stateOf[entry.key] || 'idle';
    assert.equal(app.isSectionEditing(), entry.blocksSnapshot, `${entry.key}: save guard`);
    assert.equal(blocksSchematicSnapshot(app), entry.blocksSnapshot);
    assert.equal(canRunSchematicSelectionAction(app), false, `${entry.key}: selection actions wait`);
    assert.equal(hasSchematicInteraction(app), true);
    assert.equal(hasSchematicGesture(app), entry.category === 'gesture');
    assert.equal(isSchematicDrawing(app), entry.category === 'drawing');
    assert.equal(activeSchematicInteraction(app), entry.key);
}
{
    const idle = Object.create(SchematicApp.prototype);
    assert.equal(idle.isSectionEditing(), false);
    assert.equal(canRunSchematicSelectionAction(idle), true);
    assert.equal(activeSchematicInteraction(idle), null);
}

function moveDragFixture() {
    const rect = createRect({ x: 0, y: 0, width: 10, height: 6 });
    const label = new Text({ x: 2, y: -2, text: 'R1' });
    label.parentComponent = rect;
    const wire = new Wire({ points: [{ x: 10, y: 3 }, { x: 20, y: 3 }] });
    const other = new Text({ x: 50, y: 50, text: 'untouched' });
    let renders = 0;
    const app = {
        shapes: [rect, label, wire, other], components: [], history: new CommandHistory(),
        interactionState: 'moveDrag', drag: { mode: 'move', totalDx: 0, totalDy: 0 }, didDrag: true,
        viewport: { svg: { style: {} } }, removeBoxSelectElement: noop, renderShapes: () => { renders++; },
        selection: { getSelection: () => [rect] },
    };
    return { app, rect, label, wire, other, renders: () => renders };
}
const snapshot = shapes => JSON.stringify(shapes.map(shape => shape.captureState()));

// A cancelled move drag restores what it moved, sticky wires included, without history.
for (const route of ['one', 'all']) {
    const { app, rect, label, wire, other, renders } = moveDragFixture();
    const before = snapshot(app.shapes);
    app.drag.restoreStates = captureMoveDragStates(app, [rect]);
    assert.ok(app.drag.restoreStates.has(label) && app.drag.restoreStates.has(wire), 'Snapshot covers labels and wires');
    assert.equal(app.drag.restoreStates.has(other), false, 'Unrelated shapes are not copied');
    rect.move(5, 4); label.move(5, 4);
    wire.nodes.get([...wire.nodes.keys()][0]).x += 5;
    assert.notEqual(snapshot(app.shapes), before);
    const cancelled = route === 'one' ? cancelSchematicInteraction(app) : cancelSchematicInteractions(app);
    assert.deepEqual(route === 'one' ? [cancelled] : cancelled, ['drag']);
    assert.equal(snapshot(app.shapes), before, `${route}: authored shapes are back where they were`);
    assert.equal(app.history.undoStack.length, 0);
    assert.equal(app.drag, null);
    assert.equal(app.interactionState, 'idle');
    assert.equal(renders(), 1, 'One redraw for the whole restore');
}

// Delete waits while a drag is in progress, like the PCB editor's selection actions.
{
    const { app, rect } = moveDragFixture();
    Object.assign(app, {
        selection: { getSelection: () => [rect], clearSelection: noop, notifyChanged: noop },
        commandDeleteShapes(items) { this.shapes = this.shapes.filter(shape => !items.includes(shape)); },
        commandRestoreShapes: noop,
    });
    runSchematicDeleteAction(app);
    assert.equal(app.shapes.includes(rect), true, 'Delete during a move drag leaves the shape');
    assert.equal(app.history.undoStack.length, 0);
}

console.log('PASS schematic interactions: one table, cancel routes, derived guards, move-drag restore');
