/**
 * Selection sync work counts: adapters are reused across syncs (no per-hover rebuild),
 * while adds, removals, in-place geometry edits, selection flags and document resets
 * stay correct. Pad and fill bounds memos follow in-place edits.
 */
import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';

const noop = () => {};
const element = () => ({
    style: {}, dataset: {}, children: [], classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, appendChild: child => child,
    insertBefore: child => child, remove: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
});
globalThis.window = { addEventListener: noop, removeEventListener: noop };
globalThis.document = { createElement: element, createElementNS: element, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

await import('../../src/ui/PCBApp.js');
const registry = await import('../../src/pcb/modules/selection-registry.js');
const { createTrackSelectionAdapter, createViaSelectionAdapter } = await import('../../src/pcb/modules/track-select.js');
const { createPadSelectionAdapter } = await import('../../src/pcb/modules/pad-selection.js');
const { createBoardShapeSelectionAdapter } = await import('../../src/pcb/modules/board-shapes.js');
const { createCopperFillSelectionAdapter } = await import('../../src/pcb/modules/copper-fill-selection.js');
const { Track } = await import('../../src/shapes/track.js');
const { Via } = await import('../../src/shapes/via.js');
const { Pad } = await import('../../src/shapes/pad.js');
const { CopperFill } = await import('../../src/shapes/copper-fill.js');

let created = 0;
for (const [kind, factory] of [['track', createTrackSelectionAdapter], ['via', createViaSelectionAdapter],
    ['pad', createPadSelectionAdapter], ['shape', createBoardShapeSelectionAdapter], ['fill', createCopperFillSelectionAdapter]]) {
    registry.registerPcbSelectionAdapter(kind, (...args) => { created++; return factory(...args); });
}

const pcbDocument = new PcbDocument();
const track = new Track({ layer: 'top-copper', width: 0.3, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
const via = new Via({ x: 20, y: 0, diameter: 1, drill: 0.4 });
const pad = new Pad({ x: 30, y: 0, shape: 'stadium', size: 1, ratio: 2, rotation: 0 });
const shape = { id: 'shape', kind: 'polygon', layer: 'top-silk', lineWidth: 0.2, filled: true,
    points: [{ x: 40, y: -2 }, { x: 44, y: -2 }, { x: 44, y: 2 }, { x: 40, y: 2 }] };
const fill = new CopperFill({ layer: 'bottom-copper', kind: 'polygon', cornerRadius: 1,
    outline: [{ x: 50, y: -3 }, { x: 56, y: -3 }, { x: 56, y: 3 }, { x: 50, y: 3 }] });
pcbDocument.tracks.push(track);
pcbDocument.vias.push(via);
pcbDocument.pads.push(pad);
pcbDocument.boardShapes.push(shape, fill);
const app = { pcbDocument, placements: new Map(), texts: pcbDocument.texts, tracks: pcbDocument.tracks,
    vias: pcbDocument.vias, pads: pcbDocument.pads, boardShapes: pcbDocument.boardShapes,
    viewport: { scale: 10 }, getLayerGroup: () => null, _shapeElements: new Map() };
const kindAt = point => registry.getPcbSelectionHits(app, point).map(hit => hit.kind);

registry.syncPcbSelection(app);
assert.equal(created, 5, 'first sync creates one adapter per entity');
const manager = registry.getPcbSelectionManager(app);
const firstShapes = manager.shapes;
for (let index = 0; index < 100; index++) {
    registry.syncPcbSelection(app);
    registry.hitTestPcbSelection(app, { x: index % 60, y: 0 });
}
assert.equal(created, 5, '100 hover queries create no adapters');
assert.equal(manager.shapes, firstShapes, 'an unchanged model keeps the entry list and id map');

// In-place geometry edits are seen immediately even though nothing is rebuilt.
via.x = 25;
assert.deepEqual(kindAt({ x: 25, y: 0 }), ['via'], 'a via moved in place is hit at its new position');
assert.deepEqual(kindAt({ x: 20, y: 0 }), [], 'and no longer at the old one');
assert.equal(created, 5);

// Additions create exactly one adapter; removals drop the entry and its selection.
const extra = new Via({ x: 70, y: 0, diameter: 1, drill: 0.4 });
pcbDocument.vias.push(extra);
assert.deepEqual(kindAt({ x: 70, y: 0 }), ['via']);
assert.equal(created, 6, 'one new entity creates one adapter');
registry.setPcbSelection(app, [{ kind: 'track', object: track }]);
for (let index = 0; index < 10; index++) registry.syncPcbSelection(app);
assert.deepEqual(registry.getPcbSelection(app, 'track'), [track], 'selection survives repeated syncs');
const trackAdapter = manager.shapes.find(item => item.kind === 'track');
assert.equal(manager.isSelected(trackAdapter), true);
pcbDocument.tracks.splice(0, 1);
registry.syncPcbSelection(app);
assert.deepEqual(registry.getPcbSelection(app), [], 'deleting the selected entity clears it from the selection');
pcbDocument.tracks.push(track);
registry.syncPcbSelection(app);
const restored = manager.shapes.find(item => item.kind === 'track');
assert.equal(restored, trackAdapter, 'undoing the delete reuses the cached adapter');
assert.equal(manager.isSelected(restored), false, 'and it is not shown as selected');
assert.deepEqual(registry.getPcbSelection(app), []);
assert.equal(created, 6);

// A document reset discards every cached adapter.
registry.resetPcbSelection(app);
registry.syncPcbSelection(app);
assert.equal(created, 12, 'a reset rebuilds adapters for the new document');

// Bounds memos follow in-place edits.
const padBefore = pad.getBounds();
pad.rotation = 90;
const padAfter = pad.getBounds();
assert.ok(padAfter.maxY - padAfter.minY > padBefore.maxY - padBefore.minY, 'rotating a pad updates its bounds');
padAfter.minX = -999;
assert.notEqual(pad.getBounds().minX, -999, 'callers get their own pad bounds');
const fillBefore = fill.getBounds();
fill.outline[1].x = 60;
fill.outline[2].x = 60;
assert.equal(fill.getBounds().maxX, 60, 'moving fill nodes in place updates its bounds');
assert.ok(fill.containsPoint(58, 0) && !new CopperFill(fill).containsPoint(70, 0), 'and its hit test');
assert.notEqual(fill.getBounds().maxX, fillBefore.maxX);

console.log('PASS selection sync reuses adapters across hovers; adds, removals, in-place edits, flags, resets and bounds memos stay correct');
