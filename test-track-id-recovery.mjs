import assert from 'node:assert/strict';
import { repairDuplicateTrackIds, validateProject } from './src/core/project-format.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => ({ setAttribute() {}, appendChild() {} }) };
const { Shape, resetIdCounter } = await import('./src/shapes/shape.js');
const { Track } = await import('./src/shapes/track.js');
const { createShape } = await import('./src/shapes/index.js');

resetIdCounter();
const loaded = createShape({ type: 'track', id: 'shape_66',
    nd: { n0: [0, 0], n1: [10, 0] }, ed: { e0: ['n0', 'n1'] } });
assert.ok(loaded instanceof Track);
const fresh = Array.from({ length: 100 }, () => new Track());
assert.ok(fresh.every((track) => Number(track.id.slice(6)) > 66));
assert.equal(new Set([loaded.id, ...fresh.map((track) => track.id)]).size, 101);
new Shape({ id: 'shape_1000' });
assert.ok(Number(new Track().id.slice(6)) > 1000);

const track = (id, offset) => ({ type: 'track', id, n: 'GND',
    nd: { n0: [offset, 0], n1: [offset + 10, 0] }, ed: { e0: ['n0', 'n1'] },
    pdc: { n0: { componentId: 'U1', pinNumber: '1' } } });
const source = { type: 'clearpcb-project', version: '2.0',
    schematic: { shapes: [{ id: 'shape_1' }], components: [] },
    pcb: { tracks: [track('shape_66', 0), track('shape_66', 20), track('shape_2', 40), track('shape_66', 60)] } };
const before = structuredClone(source);
assert.throws(() => validateProject(source), /Duplicate tracks id/);
const repaired = repairDuplicateTrackIds(source);
assert.equal(repaired.count, 2);
assert.deepEqual(source, before);
assert.equal(repaired.data.pcb.tracks.length, 4);
assert.equal(repaired.data.pcb.tracks[0].id, 'shape_66');
assert.equal(repaired.data.pcb.tracks[2].id, 'shape_2');
const ids = repaired.data.pcb.tracks.map((item) => item.id);
assert.equal(new Set(ids).size, 4);
assert.ok(!ids.includes('shape_1'));
repaired.data.pcb.tracks.forEach((item, index) => {
    assert.deepEqual({ ...item, id: source.pcb.tracks[index].id }, source.pcb.tracks[index]);
});
assert.doesNotThrow(() => validateProject(repaired.data));
assert.deepEqual(repairDuplicateTrackIds(repaired.data), { data: repaired.data, count: 0 });
repaired.data.pcb.tracks[0].ed.e0[1] = 'missing';
assert.throws(() => validateProject(repairDuplicateTrackIds(repaired.data).data), /Dangling/);

console.log('Track ID allocation and autosave repair regressions passed.');