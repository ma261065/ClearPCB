import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as layers from './src/pcb/modules/layers.js';

const source = readFileSync(new URL('./src/ui/PCBApp.js', import.meta.url), 'utf8');
const start = source.indexOf('    _selectAllPcb() {');
const end = source.indexOf('\n    /** Enable/disable PCB ribbon', start);
assert.ok(start >= 0 && end > start);
const marqueeSource = readFileSync(new URL('./src/pcb/modules/box-select.js', import.meta.url), 'utf8');
const marqueeStart = marqueeSource.indexOf('function _computeEnclosed(');
const marqueeEnd = marqueeSource.indexOf('\n/* ', marqueeStart);
assert.ok(marqueeStart >= 0 && marqueeEnd > marqueeStart);
const dependencies = {
    ...layers,
    window: {},
    setPcbSelection(app, selected) { app.selected = selected; },
    refreshBoxSelectionHighlights() {}, showPcbSelectionProperties() {},
    shapeOutline(shape) { return shape.points; }, pcbTextBounds() { return {}; },
};
const selectAll = new Function(...Object.keys(dependencies),
    `return ({ ${source.slice(start, end)} })._selectAllPcb;`)(...Object.values(dependencies));
const marquee = new Function(...Object.keys(dependencies),
    `${marqueeSource.slice(marqueeStart, marqueeEnd)}\nreturn _computeEnclosed;`)(...Object.values(dependencies));
const topLayer = layers.PCB_LAYERS.find(layer => layer.id === 'top-copper');
const topPour = layers.PCB_COPPER_FILLS.find(layer => layer.id === 'top-copper');
const points = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }];
const fill = { type: 'fill', id: 'pour', layer: 'top-copper', outline: points, locked: false, visible: true };
const shape = { kind: 'polygon', id: 'shape', layer: 'top-copper', points };
const app = {
    placements: new Map(), tracks: [], vias: [], texts: new Map(), boardShapes: [fill, shape],
    _syncClipboardButtons() {}, selected: [],
};
for (const select of [() => selectAll.call(app), () => marquee(app, { minX: 0, minY: 0, maxX: 10, maxY: 10 })]) {
    select();
    assert.ok(app.selected.some(entry => entry.object === fill), 'Unlocked pour is selectable');
    for (const [target, property, blocked] of [
        [topPour, 'locked', true], [topPour, 'visible', false],
        [topLayer, 'locked', true], [topLayer, 'visible', false],
        [fill, 'locked', true], [fill, 'visible', false],
    ]) {
        const previous = target[property];
        try {
            target[property] = blocked;
            select();
            assert.ok(!app.selected.some(entry => entry.object === fill), `Excluded pour: ${property}=${blocked}`);
            if (target === topPour) assert.ok(app.selected.some(entry => entry.object === shape),
                'Pour-specific restrictions must not block ordinary copper shapes');
        } finally {
            target[property] = previous;
        }
        select();
        assert.ok(app.selected.some(entry => entry.object === fill), 'Restored pour is selectable again');
    }
}
console.log('PASS Select All and marquee respect pour, copper-layer, and object locks and visibility');

globalThis.window = { addEventListener() {} };
globalThis.document = {};
const { setPcbSelection, getPcbSelectionEntries, getPcbSelection } = await import('./src/pcb/modules/selection-registry.js');
const { beginGroupDrag, updateGroupDrag, endGroupDrag } = await import('./src/pcb/modules/box-select.js');
let pourMoves = 0;
let snapshots = 0;
fill.captureState = () => { snapshots++; return {}; };
fill.applyState = () => {};
fill.move = () => { pourMoves++; };
const movingText = { id: 'moving-text', x: 0, y: 0 };
app.texts.set(movingText.id, movingText);
app.viewport = { scale: 1 };
for (const [target, property, blocked] of [
    [topPour, 'locked', true], [topPour, 'visible', false],
    [topLayer, 'locked', true], [topLayer, 'visible', false],
    [fill, 'locked', true], [fill, 'visible', false],
]) {
    setPcbSelection(app, [{ kind: 'fill', object: fill }, { kind: 'text', object: movingText }]);
    const previous = target[property];
    const textStart = movingText.x;
    try {
        target[property] = blocked;
        beginGroupDrag(app, { x: 0, y: 0 });
        assert.equal(app._groupDrag.fills.length, 0, 'Stale selected locked/hidden pour must not enter a group drag');
        updateGroupDrag(app, { x: 5, y: 5 });
        endGroupDrag(app);
        assert.equal(movingText.x, textStart + 5, 'Other selected objects still move');
        assert.equal(pourMoves, 0, 'Protected pour must not move');
        assert.equal(snapshots, 0, 'Protected pour must not be snapshotted for movement');
    } finally {
        target[property] = previous;
    }
}
console.log('PASS group drag excludes stale selected locked/hidden pours while other objects move');

const lockStart = source.indexOf('    _onCopperFillLockChanged(copperLayerId, locked) {');
const lockEnd = source.indexOf('\n    /** Hit-test a world point', lockStart);
assert.ok(lockStart >= 0 && lockEnd > lockStart);
const lockDependencies = {
    setPcbSelection, getPcbSelectionEntries,
    fillGroupId: layer => layer, saveLayerPrefs() {},
    refreshBoxSelectionHighlights() {}, showPcbSelectionProperties() {},
};
const onLock = new Function(...Object.keys(lockDependencies),
    `return ({ ${source.slice(lockStart, lockEnd)} })._onCopperFillLockChanged;`)(...Object.values(lockDependencies));
const bottomFill = { ...fill, id: 'bottom-pour', layer: 'bottom-copper' };
const secondTopFill = { ...fill, id: 'second-top-pour' };
app.boardShapes.push(bottomFill, secondTopFill);
app._layerGroups = new Map();
setPcbSelection(app, [
    { kind: 'fill', object: bottomFill }, { kind: 'fill', object: fill },
    { kind: 'fill', object: secondTopFill }, { kind: 'text', object: movingText },
]);
onLock.call(app, 'top-copper', true);
assert.deepEqual(getPcbSelection(app, 'fill'), [bottomFill], 'Lock removes all pours on that side, even when the first selected pour is on the other side');
assert.deepEqual(getPcbSelection(app, 'text'), [movingText], 'Lock preserves unrelated selection');
console.log('PASS pour lock changes remove all matching selected pours without clearing other objects');