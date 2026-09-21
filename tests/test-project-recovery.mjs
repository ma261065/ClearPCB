import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { repairDuplicateTrackIds, validateProject } from '../src/core/project-format.js';
import { Track } from '../src/shapes/track.js';
import { resetIdCounter } from '../src/shapes/shape.js';

const project = () => ({ type: 'clearpcb-project', version: '2.0', schematic: { shapes: [], components: [] } });
const owner = new ProjectDocument();
let current = project();
const view = {
    serializeSection: () => structuredClone(current),
    prepareSection: () => ({}),
    loadSection(data) { current = structuredClone(data); },
};
owner.registerView('schematic', view);
await owner.load(project());
assert.equal(owner.fileManager.loading, false);
assert.equal(owner.fileManager.isDirty, false);
owner.fileManager.setDirty(true);
assert.equal(owner.fileManager.isDirty, true);
const loadedRevision = owner.fileManager.revision;
view.onDocumentChanged();
view.onDocumentChanged();
assert.equal(owner.fileManager.revision, loadedRevision + 2);
owner.fileManager.setDirty(false);
assert.equal(owner.fileManager.revision, loadedRevision + 2);
assert.equal(owner.isDirty, false);
view.prepareSection = () => { throw new Error('Invalid recovered project'); };
await assert.rejects(owner.load(project()), /Invalid recovered project/);
assert.equal(owner.fileManager.loading, false);
assert.equal(owner.isDirty, false);
assert.deepEqual(current, project());

resetIdCounter();
const restoredTrack = new Track({ id: 'shape_65', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
const newTracks = Array.from({ length: 70 }, () => new Track());
assert.ok(newTracks.every(track => track.id !== restoredTrack.id), 'Loaded track IDs are reserved before creating new tracks');
assert.equal(new Set(newTracks.map(track => track.id)).size, newTracks.length);

const damaged = project();
damaged.schematic.shapes.push({ id: 'shape_1', type: 'circle', x: 0, y: 0, r: 1 });
damaged.pcb = { tracks: [restoredTrack.toJSON(), { ...restoredTrack.toJSON(), n: 'GND', bg: { e0: 0.25 } }] };
const original = structuredClone(damaged);
assert.throws(() => validateProject(damaged), /Duplicate tracks id: shape_65/);
const repaired = repairDuplicateTrackIds(damaged);
assert.equal(repaired.count, 1);
assert.deepEqual(damaged, original, 'Recovery does not mutate the stored autosave');
assert.equal(repaired.data.pcb.tracks[0].id, 'shape_65');
assert.notEqual(repaired.data.pcb.tracks[1].id, 'shape_1');
assert.notEqual(repaired.data.pcb.tracks[1].id, 'shape_65');
assert.deepEqual({ ...repaired.data.pcb.tracks[1], id: 'shape_65' }, damaged.pcb.tracks[1],
    'Repair preserves every track field except the duplicate ID');
view.prepareSection = () => ({});
await owner.load(repaired.data);
assert.deepEqual(current, repaired.data);
assert.equal(repairDuplicateTrackIds(repaired.data).count, 0, 'Recovery repair is idempotent');
console.log('PASS document recovery, change notifications, revisions and failed-load cleanup');