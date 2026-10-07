import assert from 'node:assert/strict';
import { Track } from '../../src/shapes/track.js';
import { resolveTrackEdgePaths, resolveTrackSegments } from '../../src/shared/pcb/board-geometry.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { ModifyTrackGraphCommand } from '../../src/core/pcb-track-commands.js';
import { SelectionManager } from '../../src/core/SelectionManager.js';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { SetPlacementSideCommand } from '../../src/core/pcb-placement-commands.js';

assert.equal(typeof document, 'undefined');
const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
const wide = new Track({ points, width: 2, edgeWidths: { e1: 4 }, lineWidth: 0.05 });
assert.deepEqual(wide.getBounds(), { minX: -1, minY: -2, maxX: 12, maxY: 12 },
    'Model bounds include each copper edge width, not the schematic line width');
assert.equal(wide.hitTest({ x: 5, y: 0.9 }, 0), true);
assert.equal(wide.hitTest({ x: 5, y: 1.1 }, 0), false);
assert.equal(wide.hitTest({ x: 11.9, y: 5 }, 0), true);
assert.equal(wide.hitTest({ x: 12.1, y: 5 }, 0), false);
assert.equal(wide.hitTest({ x: -0.9, y: 0 }, 0), true, 'Round end caps count as copper');
assert.equal(wide.distanceTo({ x: 5, y: 0.9 }), 0.9, 'Distance remains centreline distance');

const rounded = new Track({ points, width: 0.2, cornerRadius: 4 });
assert.equal(rounded.hitTest(points[1], 0), false, 'Rounded copper does not occupy the old sharp vertex');
assert.ok(rounded.distanceTo(points[1]) > 0.5, 'Distance follows the rounded path');
const bend = resolveTrackEdgePaths(rounded).get('e0').at(-1);
assert.equal(rounded.hitTest(bend, 0), true);
assert.ok(rounded.distanceTo(bend) < 1e-12);

function assertResolvedBounds(track) {
    const expected = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const { start, end, width } of resolveTrackSegments(track)) {
        for (const point of [start, end]) {
            expected.minX = Math.min(expected.minX, point.x - width / 2);
            expected.minY = Math.min(expected.minY, point.y - width / 2);
            expected.maxX = Math.max(expected.maxX, point.x + width / 2);
            expected.maxY = Math.max(expected.maxY, point.y + width / 2);
            assert.equal(track.hitTest(point, 0), true);
        }
    }
    assert.deepEqual(track.getBounds(), expected);
    assert.equal(track.getBounds(), track.getBounds(), 'Unchanged model geometry still reuses bounds');
}
for (const bulge of [-1, -0.35, 0.35, 1]) {
    const arc = new Track({ points: points.slice(0, 2), width: 1.6, edgeBulges: { e0: bulge } });
    assertResolvedBounds(arc);
    assert.equal(arc.hitTest({ x: 5, y: 0 }, 0), false, 'Arc queries do not hit the chord');
}
for (const options of [
    { edgeLayers: { e1: 'bottom-copper' } },
    { padConnections: { n1: { componentId: 'U1', pinNumber: '1' } } },
    { nodeCornerRadii: { n1: 0 } },
]) {
    const sharp = new Track({ points, width: 0.2, cornerRadius: 4, ...options });
    assert.equal(sharp.hitTest(points[1], 0), true, 'Layer transitions, pad bonds and overrides retain sharp corners');
    assert.equal(sharp.distanceTo(points[1]), 0);
    assertResolvedBounds(sharp);
}
const junction = new Track({ points, width: 0.2, cornerRadius: 4 });
const node = junction.addNode(20, 0);
junction.addEdge('n1', node);
assert.equal(junction.hitTest(points[1], 0), true, 'Junctions retain their unrounded copper');
assertResolvedBounds(junction);
assertResolvedBounds(wide);
assertResolvedBounds(rounded);

const saved = rounded.toJSON();
const before = rounded.captureState();
const originalBounds = rounded.getBounds();
rounded.setEdgeAttr('e0', 'width', 3);
rounded.move(2.123456, -3.234567);
const after = rounded.captureState();
rounded.applyState(before);
const history = new CommandHistory();
history.execute(new ModifyTrackGraphCommand(rounded, before, after));
assertResolvedBounds(rounded);
assert.notDeepEqual(rounded.getBounds(), originalBounds);
history.undo();
assert.deepEqual(rounded.toJSON(), saved);
assert.deepEqual(rounded.getBounds(), originalBounds);
history.redo();
assertResolvedBounds(rounded);
assert.equal(Object.hasOwn(rounded, 'element'), false);
assert.equal(rounded._dirty, true, 'Queries do not acknowledge rendering');

const empty = new Track();
assert.deepEqual(empty.getBounds(), { minX: 0, minY: 0, maxX: 0, maxY: 0 });
assert.equal(empty.hitTest({ x: 0, y: 0 }), false);
assert.equal(empty.distanceTo({ x: 0, y: 0 }), Infinity);

const bonded = new Track({ points: [{ x: -10, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 10 }],
    cornerRadius: 4, padConnections: { n1: { componentId: 'part', pinNumber: '1' } } });
const board = new PcbDocument();
board.tracks.push(bonded);
const project = { pcbDocument: board,
    getPcbFootprint: () => ({ padOffsets: [{ padId: '1', number: '1', dx: 0, dy: 0, layer: 'top' }], pasteOffsets: [] }) };
const sideHistory = new CommandHistory();
const sharpBounds = bonded.getBounds();
sideHistory.execute(new SetPlacementSideCommand(project, 'part', 'bottom', { x: 0, y: 0, side: 'top' }));
assert.equal(bonded.padConnections.size, 0);
assertResolvedBounds(bonded);
assert.ok(bonded.getBounds().minY > sharpBounds.minY, 'Disconnecting the stationary apex enables rounding');
sideHistory.undo();
assert.deepEqual(bonded.getBounds(), sharpBounds, 'Restoring a bond invalidates bounds without node movement');
sideHistory.redo();
assertResolvedBounds(bonded);

const { createTrackSelectionAdapter, selectTrackOrVia } = await import('../../src/pcb/modules/track-select.js');
const { PCB_LAYERS } = await import('../../src/pcb/modules/layers.js');
const layer = PCB_LAYERS.find(item => item.id === 'top-copper');
const originalVisible = layer.visible;
try {
    layer.visible = true;
    const adapter = createTrackSelectionAdapter({}, wide, wide.id);
    assert.deepEqual(adapter.getBounds(), wide.getBounds(), 'Editor pruning uses model copper bounds');
    const selection = new SelectionManager({ tolerance: 0.01 });
    selection.setShapes([adapter]);
    assert.equal(selection.hitTest({ x: 11.9, y: 5 }), adapter,
        'Bounds pruning must not reject clicks inside wide copper');
    layer.visible = false;
    assert.equal(wide.hitTest({ x: 11.9, y: 5 }, 0), true, 'Model geometry ignores view preferences');
    assert.equal(adapter.hitTest({ x: 11.9, y: 5 }, 0), false, 'Editor retains its layer visibility filter');
} finally {
    layer.visible = originalVisible;
}
const previewTrack = new Track({ points: [{ x: -10, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 10 }] });
const controls = new Map();
const syncPanel = panel => {
    controls.clear();
    for (const field of panel.fields || []) {
        const id = field.id || field.key;
        controls.set(id, {
            value: field.mixed ? '' : String(field.value ?? ''),
            field,
            fire(type, value) {
                if (value !== undefined) this.value = String(value);
                if (field.type !== 'number' || !['input', 'change'].includes(type)) return;
                let parsed = field.parse ? field.parse(this.value) : (this.value.trim() === '' ? NaN : Number(this.value));
                if (Number.isFinite(parsed) && field.normalize) {
                    parsed = field.normalize(parsed);
                    this.value = String(parsed);
                }
                if (Number.isFinite(parsed)) {
                    field.preview?.(parsed);
                    if (type === 'change') field.commit?.(parsed);
                }
            },
        });
    }
};
const previewApp = { tracks: [previewTrack], vias: [], pads: [], boardShapes: [], texts: new Map(), placements: new Map(),
    pcbDocument: { tracks: [previewTrack] },
    viewport: { scale: 10 }, propertiesItems: () => ({}), getLayerGroup: () => null,
    openPropertyPanel(panel) { syncPanel(panel); return true; }, refreshPropertyPanel: syncPanel };
selectTrackOrVia(previewApp, { type: 'track', track: previewTrack });
const previewBefore = previewTrack.getBounds();
controls.get('pcbPropTrackCornerRadius').fire('input', 4);
const previewAdapter = createTrackSelectionAdapter(previewApp, previewTrack, previewTrack.id);
assertResolvedBounds(previewAdapter.object);
assert.ok(previewAdapter.getBounds().minY > previewBefore.minY, 'Whole-track radius preview invalidates display bounds');
assert.equal(previewTrack.getBounds(), previewBefore, 'Property preview preserves canonical cached bounds');
console.log('PASS headless copper widths, rounded paths, arcs, topology, history and selection bounds');
