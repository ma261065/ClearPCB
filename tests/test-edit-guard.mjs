import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { LockedEditError, commandLockTargets, createLockGuard, netOnlyChange } from '../src/core/edit-guard.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { Polyline } from '../src/shapes/polyline.js';
import { Text } from '../src/shapes/text.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElementNS: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
};

const pcbModels = await Promise.all(readdirSync(new URL('../src/core/', import.meta.url))
    .filter(name => /^pcb-.*-commands\.js$/.test(name))
    .map(async name => [name, await import(`../src/core/${name}`)]));
const schematic = await import('../src/schematic/modules/commands.js');
const { isPcbObjectLocked, describeLockedEdit, lockedRoutedCopper } = await import('../src/pcb/modules/object-locks.js');
const { buildCopperObstacles } = await import('../src/pcb/modules/copper-obstacles.js');
const { isSchematicLocked } = await import('../src/shapes/lock-owner.js');

// Ratchet: every model command says what it changes, so none can bypass the gate.
for (const [name, exports] of [...pcbModels, ['schematic/modules/commands.js', schematic]]) {
    for (const [exported, value] of Object.entries(exports)) {
        if (typeof value !== 'function' || !/Command$/.test(exported) || !value.prototype?.execute) continue;
        assert.equal(typeof value.prototype.lockTargets, 'function',
            `${name} ${exported} must declare lockTargets() (core/edit-guard.js)`);
    }
}

// CommandHistory refuses before running, reports, rethrows and records nothing.
{
    let ran = false, refused = null;
    const history = new CommandHistory({
        guard: createLockGuard(({ object }) => object.locked, () => 'This thing is locked'),
        onRefused: error => { refused = error; },
    });
    const command = { lockTargets: () => [{ object: { locked: true } }], execute() { ran = true; }, undo() {} };
    assert.throws(() => history.execute(command), LockedEditError);
    assert.equal(ran, false, 'A refused command never runs');
    assert.equal(refused?.message, 'This thing is locked');
    assert.equal(history.canUndo(), false, 'Nothing is recorded');
    const compound = { commands: [{ lockTargets: () => [] }, command], execute() { ran = true; }, undo() {} };
    assert.equal(commandLockTargets(compound).length, 1, 'Compound commands are checked through their children');
    assert.throws(() => history.execute(compound), LockedEditError);
    assert.equal(ran, false, 'One locked child refuses the whole compound');
}

assert.equal(netOnlyChange({ net: '', width: 1 }, { net: 'GND', width: 1 }), true);
assert.equal(netOnlyChange({ net: '', width: 1 }, { net: 'GND', width: 2 }), false);

// PCB: geometry and existence of locked objects are protected; nets and locks are not.
{
    const model = await import('../src/core/pcb-track-commands.js');
    const vias = await import('../src/core/pcb-via-commands.js');
    const lock = await import('../src/core/pcb-lock-commands.js');
    const document = new PcbDocument();
    const app = { pcbDocument: document, tracks: document.tracks, vias: document.vias, placements: new Map(),
        layerLabel: id => id };
    const locked = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], layer: 'top-copper', net: '' });
    locked.locked = true;
    const free = new Track({ points: [{ x: 0, y: 5 }, { x: 10, y: 5 }], layer: 'top-copper' });
    const lockedVia = new Via({ x: 10, y: 0, diameter: 0.6, drill: 0.3, net: 'GND' });
    lockedVia.locked = true;
    document.tracks.push(locked, free);
    document.vias.push(lockedVia);
    const guard = createLockGuard(target => isPcbObjectLocked(app, target.kind, target.object),
        target => describeLockedEdit(app, target));

    assert.throws(() => guard(new model.RemoveTrackCommand(document, locked)), /This track is locked/);
    assert.throws(() => guard(new model.MoveVertexCommand(locked, 'n0', 0, 0, 1, 1)), LockedEditError);
    const before = locked.captureState();
    assert.throws(() => guard(new model.ModifyTrackGraphCommand(locked, before, { ...before, width: 2 })), LockedEditError);
    assert.doesNotThrow(() => guard(new model.ModifyTrackGraphCommand(locked, before, { ...before, net: 'GND' })),
        'Nets follow connectivity, so routing to locked copper still works');
    assert.doesNotThrow(() => guard(new model.ModifyTrackCommand(locked, { net: '' }, { net: 'GND' })));
    assert.doesNotThrow(() => guard(new lock.SetObjectLockedCommand(document, 'track', locked, false)),
        'Lock changes are never refused');
    assert.doesNotThrow(() => guard(new model.RemoveTrackCommand(document, free)));
    assert.throws(() => guard(new vias.MoveViaCommand(lockedVia, 10, 0, 11, 0)), /This via is locked/);

    // A layer lock reads as such.
    const top = PCB_LAYERS.find(layer => layer.id === 'top-copper');
    const previous = top.locked;
    try {
        top.locked = true;
        assert.throws(() => guard(new model.RemoveTrackCommand(document, free)), /top-copper layer is locked/);
    } finally {
        top.locked = previous;
    }

    // Routing and Clear Routes keep locked copper, which the router sees as fixed copper.
    const kept = lockedRoutedCopper(app);
    assert.deepEqual(kept.tracks, [locked]);
    assert.deepEqual(kept.vias, [lockedVia]);
    assert.doesNotThrow(() => guard(new model.ReplaceRoutesCommand(document, kept.tracks, kept.vias)),
        'Clearing routes that keeps locked copper is allowed');
    assert.throws(() => guard(new model.ReplaceRoutesCommand(document, [], [])), LockedEditError,
        'Replacing routes may not drop locked copper');
    const obstacles = buildCopperObstacles({ ...app, texts: new Map(), boardShapes: [] });
    assert.ok(obstacles.some(item => item.kind === 'segment' && item.layer === 'top' && item.y1 === 0),
        'Locked tracks are fixed obstacles for the router');
    assert.ok(obstacles.some(item => item.kind === 'pad' && item.net === 'GND' && item.x === 10),
        'Locked vias are fixed obstacles for the router');
    assert.ok(!obstacles.some(item => item.kind === 'segment' && item.y1 === 5), 'Unlocked copper is rerouted');
}

// Schematic: direct edits of locked shapes are refused; owned texts follow their owner.
{
    const shape = new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], locked: true });
    const component = { id: 'c1', definition: {}, locked: true, type: 'component' };
    const reference = new Text({ x: 0, y: 0, text: 'R1' });
    reference.parentComponent = component;
    reference.fieldKey = 'reference';
    const app = { shapes: [shape, reference], components: [component] };
    const guard = createLockGuard(target => isSchematicLocked(target.object), () => 'locked');
    assert.throws(() => guard(new schematic.MoveShapesCommand(app, [shape], 1, 0)), LockedEditError);
    assert.throws(() => guard(new schematic.ModifyPropertyCommand(app, [shape], 'lineWidth', 1)), LockedEditError);
    assert.doesNotThrow(() => guard(new schematic.ModifyPropertyCommand(app, [shape], 'locked', false)));
    assert.throws(() => guard(new schematic.ModifyPropertyCommand(app, [reference], 'rotation', 90)), LockedEditError,
        "A locked component's reference text is locked with it");
    assert.throws(() => guard(new schematic.DeleteShapesCommand(app, [shape])), LockedEditError);
    const batch = new schematic.BatchCommand('Batch');
    batch.add(new schematic.MoveShapesCommand(app, [shape], 1, 0));
    assert.throws(() => guard(batch), LockedEditError, 'Batches are checked through their children');
}

console.log('PASS edit guard: commands declare targets, locked objects refused before execution, routing keeps locked copper');
