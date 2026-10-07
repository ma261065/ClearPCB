import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { compactProjectAliases } from '../src/core/project-field-aliases.js';
import { defaultPcbStackup } from '../src/core/project-format.js';
import { SetObjectLockedCommand as ModelSetObjectLockedCommand } from '../src/core/pcb-lock-commands.js';
import { RemoveTextCommand } from '../src/core/pcb-text-commands.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { Pad } from '../src/shapes/pad.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { PCB_COPPER_FILLS, PCB_LAYERS } from '../src/pcb/modules/layers.js';

import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');

const { pcbLockState, isPcbObjectLocked, unlockMenuItems, setPcbObjectsLocked, lockedProperty } =
    await import('../src/pcb/modules/object-locks.js');
const { deleteBoxSelection, selectEnclosed, beginGroupDrag, updateGroupDrag, endGroupDrag } =
    await import('../src/pcb/modules/box-select.js');
const { preparePcbPaste } = await import('../src/pcb/modules/pcb-paste.js');
const { getPcbSelection, setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { multiPropertyCapabilities } = await import('../src/pcb/modules/multi-selection-properties.js');

const layer = id => PCB_LAYERS.find(item => item.id === id);
const withLayerLocks = (ids, run) => {
    const saved = ids.map(id => [layer(id), layer(id).locked]);
    try {
        for (const [item] of saved) item.locked = true;
        run();
    } finally {
        for (const [item, locked] of saved) item.locked = locked;
    }
};

const line = (id, extra = {}) => ({ id, kind: 'line', layer: 'top-silk', lineWidth: 0.2,
    points: [{ x: 0, y: 0 }, { x: 4, y: 0 }], ...extra });
const textData = (id, extra = {}) => ({ id, content: 'Label', x: 1, y: 1, size: 1, rotation: 0,
    layer: 'top-silk', strokeWidth: 0.15, ...extra });

// File format: board shapes and free text save their own lock as `lk`, only when set.
{
    const document = new PcbDocument();
    document.load({ stackup: defaultPcbStackup(), boardShapes: [line('pshape_1', { locked: true }), line('pshape_2')],
        texts: [textData('locked-text', { locked: true }), textData('free-text')] });
    const [lockedShape, freeShape] = document.boardShapes.filter(shape => shape.layer === 'top-silk');
    assert.equal(lockedShape.locked, true, 'A loaded shape keeps its lock');
    assert.equal(!!freeShape.locked, false);
    assert.equal(document.texts.get('locked-text').locked, true, 'A loaded text keeps its lock');
    assert.equal(Object.hasOwn(document.texts.get('free-text'), 'locked'), false,
        'Unlocked text carries no lock field');

    const saved = document.serializeEntities();
    const savedShapes = saved.boardShapes.filter(shape => shape.layer === 'top-silk');
    assert.equal(savedShapes[0].locked, true);
    assert.equal(Object.hasOwn(savedShapes[1], 'locked'), false, 'Unlocked shapes do not write a lock');
    assert.equal(saved.texts[0].locked, true);
    assert.equal(Object.hasOwn(saved.texts[1], 'locked'), false);

    const compact = compactProjectAliases({ pcb: { boardShapes: saved.boardShapes, texts: saved.texts } }).pcb;
    assert.equal(compact.boardShapes.find(shape => shape.id === 'pshape_1').lk, true, 'Shapes compact to lk');
    assert.equal(compact.texts[0].lk, true, 'Texts compact to lk');
    const reloaded = new PcbDocument();
    reloaded.load({ ...compact, stackup: defaultPcbStackup() });
    assert.equal(reloaded.boardShapes.find(shape => shape.id === 'pshape_1').locked, true, 'lk reloads');
    assert.equal(reloaded.texts.get('locked-text').locked, true);
}

// The model command resolves free text by id, so it survives a delete undo recreating the record.
{
    const document = new PcbDocument();
    document.load({ stackup: defaultPcbStackup(), texts: [textData('label')] });
    const lock = new ModelSetObjectLockedCommand(document, 'text', document.texts.get('label'), true);
    lock.execute();
    assert.equal(document.texts.get('label').locked, true);
    const remove = new RemoveTextCommand(document, 'label');
    remove.execute();
    remove.undo();
    lock.undo();
    assert.equal(document.texts.get('label').locked, false, 'Undo reaches the recreated text');
}

/** The real editor prototype and its guarded undo history, with presentation quiet. */
function fixture() {
    return pcbEditorFixture({ _active: true, _shapeElements: new Map(), refreshText() {},
        clearProperties() {}, setActiveRibbonTab() {}, syncClipboardButtons() {} });
}

// Lock state: the object's own lock, the layers holding it, and the unlock menu choices.
{
    const app = fixture();
    const shape = line('pshape_1', { locked: true });
    app.boardShapes.push(shape);
    assert.deepEqual(pcbLockState(app, 'shape', shape), { object: true, layers: [] });
    assert.deepEqual(unlockMenuItems(app, 'shape', shape).map(item => item.text), ['Unlock shape']);

    withLayerLocks(['top-silk'], () => {
        const choices = unlockMenuItems(app, 'shape', shape);
        assert.deepEqual(choices.map(item => item.text), ['Unlock shape', 'Unlock Top Silk layer', 'Unlock both']);
        choices[2].onClick();
        assert.equal(layer('top-silk').locked, false, 'Unlock both lifts the layer lock');
        assert.equal(shape.locked, false, 'Unlock both lifts the object lock');
        app.history.undo();
        assert.equal(shape.locked, true, 'The object unlock is undoable');
        assert.equal(layer('top-silk').locked, false, 'Layer locks are preferences, outside history');
    });

    const hole = line('pshape_h', { layer: 'hole' });
    withLayerLocks(['hole'], () => {
        assert.deepEqual(unlockMenuItems(app, 'shape', hole).map(item => item.text), ['Unlock Hole layer'],
            'Menus use the layer panel names');
    });

    shape.locked = false;
    withLayerLocks(['top-silk'], () => {
        assert.deepEqual(unlockMenuItems(app, 'shape', shape).map(item => item.text), ['Unlock Top Silk layer'],
            'A layer-only lock offers only the layer');
    });

    const track = new Track({ id: 'track_1', layer: 'top-copper' });
    track.nodes.set('a', { x: 0, y: 0 }).set('b', { x: 1, y: 0 }).set('c', { x: 2, y: 0 });
    track.edges.set('e1', { from: 'a', to: 'b' }).set('e2', { from: 'b', to: 'c', layer: 'bottom-copper' });
    withLayerLocks(['top-copper'], () => {
        assert.equal(isPcbObjectLocked(app, 'track', track), false, 'An edge on an unlocked layer keeps a track editable');
    });
    withLayerLocks(['top-copper', 'bottom-copper'], () => {
        assert.deepEqual(pcbLockState(app, 'track', track).layers.map(lock => lock.id), ['top-copper', 'bottom-copper']);
        assert.deepEqual(unlockMenuItems(app, 'track', track).map(item => item.text), ['Unlock Top Copper and Bottom Copper layers']);
    });

    const fill = new CopperFill({ layer: 'top-copper', locked: true,
        outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] });
    const pour = PCB_COPPER_FILLS.find(item => item.id === 'top-copper');
    const pourLocked = pour.locked;
    try {
        pour.locked = true;
        assert.deepEqual(unlockMenuItems(app, 'fill', fill).map(item => item.text),
            ['Unlock fill', 'Unlock Top Copper Fill layer', 'Unlock both']);
    } finally {
        pour.locked = pourLocked;
    }

    const via = new Via({ id: 'via_1', x: 0, y: 0, diameter: 0.6, drill: 0.3, locked: true });
    const pad = new Pad({ id: 'pad_1', x: 0, y: 0, size: 1, drill: 0.5, layers: 'both' });
    assert.equal(isPcbObjectLocked(app, 'via', via), true);
    withLayerLocks(['bottom-copper'], () => assert.equal(isPcbObjectLocked(app, 'pad', pad), true,
        'A through pad is held by either copper layer'));

    app.placements.set('U1', { locked: true, side: 'top' });
    assert.deepEqual(pcbLockState(app, 'component', 'U1'), { object: true, layers: [] });
}

// Properties: one Locked row for the own lock; it stays editable when a layer lock disables the rest.
{
    const app = fixture();
    const a = line('pshape_1', { locked: true }), b = line('pshape_2');
    app.boardShapes.push(a, b);
    const both = [{ kind: 'shape', object: a }, { kind: 'shape', object: b }];
    const mixedLock = lockedProperty(app, both);
    assert.deepEqual([mixedLock.field.id, mixedLock.field.mixed], ['pcbPropObjectLocked', true], 'Mixed locks show indeterminate');
    assert.equal(mixedLock.readOnly, true, 'a selection with a locked member is read-only');
    const ownLock = lockedProperty(app, [both[0]]);
    assert.deepEqual([ownLock.field.value, ownLock.field.mixed], [true, false]);
    assert.equal(lockedProperty(app, [both[1]]).readOnly, false);

    assert.equal(setPcbObjectsLocked(app, both, true), true);
    assert.equal(a.locked && b.locked, true);
    assert.equal(app.history.undoStack.length, 1, 'Locking a selection is one undo step');
    assert.equal(setPcbObjectsLocked(app, both, true), false, 'Already-locked objects add no history');
    app.history.undo();
    assert.equal(a.locked, true, 'Undo restores each object\'s previous lock');
    assert.equal(b.locked, false);

    const capabilities = multiPropertyCapabilities(app, both[0]);
    assert.equal(capabilities.locked.disabled, false);
    assert.ok(Object.entries(capabilities).filter(([key]) => key !== 'locked')
        .every(([, capability]) => capability.disabled), 'A locked shape\'s other properties are read-only');
    assert.equal(capabilities.locked.command(false).description, 'Unlock');
    assert.equal(multiPropertyCapabilities(app, both[1]).lineWidth.disabled, false);
}

// Bulk selection takes individually locked objects (so they can be unlocked together) but not
// layer-locked ones; moves, delete and cut leave locked members alone; pasted copies start unlocked.
{
    const app = fixture();
    const locked = line('pshape_1', { locked: true }), free = line('pshape_2');
    app.boardShapes.push(locked, free);
    const document = new PcbDocument();
    document.load({ stackup: defaultPcbStackup(), texts: [textData('locked-text', { locked: true })] });
    app.texts.set('locked-text', document.texts.get('locked-text'));

    const everything = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
    selectEnclosed(app, everything);
    assert.deepEqual(getPcbSelection(app).map(item => item.id).sort(), ['locked-text', 'pshape_1', 'pshape_2'],
        'Marquee selection takes individually locked shapes and text');
    withLayerLocks(['top-silk'], () => {
        selectEnclosed(app, everything);
        assert.deepEqual(getPcbSelection(app), [], 'Marquee selection skips objects on a locked layer');
    });

    app.viewport = { scale: 1, snapToGrid: false, setCrosshair() {}, hideCrosshair() {} };
    setPcbSelection(app, [{ kind: 'shape', object: locked }, { kind: 'shape', object: free }]);
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 3, y: 0 }, { snap: false });
    endGroupDrag(app);
    assert.deepEqual(locked.points[0], { x: 0, y: 0 }, 'A group move leaves the locked member in place');
    assert.deepEqual(free.points[0], { x: 3, y: 0 }, 'The unlocked member moves');
    app.history.undo();
    assert.deepEqual(free.points[0], { x: 0, y: 0 });

    const { default: PCBApp } = await import('../src/ui/PCBApp.js');
    const cut = PCBApp.prototype._capturePcbClipboardSelection.call(app, { unlockedOnly: true });
    assert.deepEqual(cut.shapes.map(shape => shape.id), ['pshape_2'], 'Cut copies only what it can remove');
    const copy = PCBApp.prototype._capturePcbClipboardSelection.call(app);
    assert.equal(copy.shapes.length, 2, 'Copy still takes locked objects');

    setPcbSelection(app, [{ kind: 'shape', object: locked }, { kind: 'shape', object: free }]);
    assert.equal(deleteBoxSelection(app), true);
    assert.deepEqual(app.boardShapes.map(shape => shape.id), ['pshape_1'], 'Delete leaves a locked object in place');

    const payload = preparePcbPaste(app, { shapes: [line('pshape_9', { locked: true })],
        texts: [textData('copy', { locked: true })] });
    assert.equal(payload.shapes[0].locked, false, 'A pasted shape starts unlocked');
    assert.equal(payload.texts[0].locked, false, 'A pasted text starts unlocked');
}

// Joins: a track drawn onto a locked track's endpoint is added on its own instead of
// absorbing (and rewriting) the locked track.
{
    globalThis.requestAnimationFrame ??= () => 0;
    const { default: PCBApp } = await import('../src/ui/PCBApp.js');
    const { buildDrawnTrackCommands } = await import('../src/pcb/modules/track-drag.js');
    const copper = Object.create(null, Object.fromEntries(['tracks', 'vias', 'pads', 'boardShapes']
        .map(key => [key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key)])));
    const app = Object.assign(Object.create(copper), {
        pcbDocument: new PcbDocument(), tracks: [], vias: [], pads: [], boardShapes: [], copperFills: [],
        netlist: [], placements: new Map(),
        getLayerGroup() { return null; }, _shapeElements: new Map(), alert() {},
        viewport: { scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
        history: { execute(command) { command.execute(); } },
    });
    const segment = (x1, x2) => new Track({ points: [{ x: x1, y: 0 }, { x: x2, y: 0 }], layer: 'top-copper' });
    const locked = segment(0, 10);
    locked.locked = true;
    app.tracks.push(locked);
    const before = locked.captureState();
    const command = buildDrawnTrackCommands(app, [segment(10, 20)]);
    command.execute();
    assert.deepEqual(locked.captureState(), before, 'A locked track is not absorbed by a drawn track');
    assert.equal(app.tracks.length, 2, 'The drawn track is added separately');
    assert.ok(app.tracks.includes(locked));

    const free = segment(0, 10);
    const control = Object.assign(Object.create(copper), { ...app, pcbDocument: new PcbDocument(),
        tracks: [free], vias: [], pads: [], boardShapes: [] });
    buildDrawnTrackCommands(control, [segment(10, 20)]).execute();
    assert.equal(control.tracks.length, 1, 'An unlocked track still absorbs the drawn track');
}

console.log('PASS PCB object locks: file format, undoable lock command, unlock menu, Properties and enforcement');
