import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurfaceBuilder } from '../src/pcb/modules/board3d-surface-client.js';
import { buildSurfaceBuffers } from '../src/pcb/modules/board3d-surface-build.js';
import { surfaceInputsEqual } from '../src/pcb/modules/board3d-surface-equality.js';
import { decodeSurfaceInputs } from '../src/pcb/modules/board3d-surface-transfer.js';

const surface = () => ({
    outline: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }],
    parts: [{ mesh: {
        verts: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }],
        faces: [{ idx: [0, 1, 2], color: [64, 128, 192] }],
    }, holes: [{ x: 2, z: 2, r: 0.5 }] }],
});
const previousPart = { mesh: { verts: [{ x: 1 }], faces: [] }, holes: [{ x: 1 }] };
const movedHolePart = { holes: [{ x: 2 }] };
Object.defineProperty(movedHolePart, 'mesh', {
    enumerable: true,
    get() { throw new Error('Mesh must not be traversed after a hole mismatch'); },
});
assert.equal(surfaceInputsEqual(previousPart, movedHolePart), false,
    'Hole changes fail before comparing the surface mesh');
const jobs = [];
const worker = { postMessage(job) { jobs.push({ ...job, surfaces: decodeSurfaceInputs(job.surfaces) }); }, terminate() {} };
const builder = createSurfaceBuilder(() => worker);
const finish = () => {
    const job = jobs.at(-1);
    worker.onmessage({ data: { id: job.id, surfaces: buildSurfaceBuffers(job.surfaces) } });
};
const input = { board: surface(), copper: surface(), silk: surface() };
let pending = builder.build(input);
finish();
let previous = await pending;
assert.deepEqual(previous, buildSurfaceBuffers(input));
const unchanged = await builder.build(structuredClone(input));
assert.equal(jobs.length, 1, 'Equal fresh inputs must not dispatch any worker work');
for (const key of Object.keys(input)) assert.equal(unchanged[key], previous[key]);

for (const change of [
    (value) => { value.parts[0].mesh.verts[0].x += 0.1; },
    (value) => { value.parts[0].mesh.faces[0].idx.reverse(); },
    (value) => { value.parts[0].mesh.faces[0].color[0]++; },
    (value) => { value.parts[0].holes[0].x += 0.1; },
    (value) => { value.parts[0].holes[0].y = 1.6; },
    (value) => { value.parts[0].holes[0].ring = [{ x: 1, z: 1 }, { x: 3, z: 1 }, { x: 2, z: 3 }]; },
    (value) => { value.outline[1].x -= 0.1; },
    (value) => { value.parts.push({ mesh: { verts: [], faces: [] } }); },
]) {
    change(input.copper);
    pending = builder.build(input);
    assert.deepEqual(Object.keys(jobs.at(-1).surfaces), ['copper']);
    finish();
    const result = await pending;
    assert.equal(result.board, previous.board);
    assert.equal(result.silk, previous.silk);
    assert.notEqual(result.copper, previous.copper);
    assert.deepEqual(result, buildSurfaceBuffers(input));
    previous = result;
}

const jobCount = jobs.length;
delete input.silk;
const removed = await builder.build(input);
assert.equal(jobs.length, jobCount, 'Removing a surface needs no geometry rebuild');
assert.equal(Object.hasOwn(removed, 'silk'), false);
input.silk = surface();
pending = builder.build(input);
assert.deepEqual(Object.keys(jobs.at(-1).surfaces), ['silk']);
finish();
previous = await pending;

input.copper.parts[0].mesh.verts[0].x++;
const stale = builder.build(input);
builder.invalidate();
input.copper.parts[0].mesh.verts[0].x++;
const latest = builder.build(input);
finish();
assert.equal(await stale, null);
assert.deepEqual(Object.keys(jobs.at(-1).surfaces), ['copper']);
finish();
const current = await latest;
assert.equal(current.board, previous.board);
assert.deepEqual(current, buildSurfaceBuffers(input));

input.copper.parts[0].mesh.verts[0].x++;
pending = builder.build(input);
const snapshot = structuredClone(input);
input.copper.parts[0].mesh.verts[0].x++;
finish();
assert.deepEqual(await pending, buildSurfaceBuffers(snapshot), 'Input snapshots must not follow subsequent mutation');
pending = builder.build(input);
finish();
assert.deepEqual(await pending, buildSurfaceBuffers(input));
builder.dispose();

const sharedJobs = [];
const sharedWorker = { postMessage(job) { sharedJobs.push({ ...job, surfaces: decodeSurfaceInputs(job.surfaces) }); }, terminate() {} };
const sharedBuilder = createSurfaceBuilder(() => sharedWorker);
const sharedInput = { copper: surface(), silk: surface() };
sharedInput.silk.parts[0].holes = sharedInput.copper.parts[0].holes;
const sharedBuild = sharedBuilder.build(sharedInput);
assert.equal(sharedJobs[0].surfaces.copper.parts[0].holes, sharedJobs[0].surfaces.silk.parts[0].holes,
    'Changed surface snapshots preserve shared drill geometry');
sharedWorker.onmessage({ data: { id: sharedJobs[0].id, surfaces: buildSurfaceBuffers(sharedJobs[0].surfaces) } });
await sharedBuild;
sharedInput.copper.parts[0].holes[0].x += 0.25;
const sharedMutation = sharedBuilder.build(sharedInput);
assert.deepEqual(Object.keys(sharedJobs[1].surfaces).sort(), ['copper', 'silk'],
    'A shared drill mutation invalidates every affected surface');
sharedWorker.onmessage({ data: { id: sharedJobs[1].id, surfaces: buildSurfaceBuffers(sharedJobs[1].surfaces) } });
await sharedMutation;
sharedBuilder.dispose();

const ownedJobs = [];
const ownedWorker = { postMessage(job) { ownedJobs.push({ ...job, surfaces: decodeSurfaceInputs(job.surfaces) }); }, terminate() {} };
const ownedBuilder = createSurfaceBuilder(() => ownedWorker);
const ownedInput = { copper: surface(), silk: surface() };
ownedInput.silk.parts[0].holes = ownedInput.copper.parts[0].holes;
const ownedBuild = ownedBuilder.build(ownedInput, { takeOwnership: true });
assert.deepEqual(ownedJobs[0].surfaces.copper, ownedInput.copper,
    'Owned geometry survives numeric transport without changes');
const ownedExpected = buildSurfaceBuffers(ownedJobs[0].surfaces);
ownedWorker.onmessage({ data: { id: ownedJobs[0].id, surfaces: ownedExpected } });
assert.deepEqual(await ownedBuild, ownedExpected);
const ownedReuse = await ownedBuilder.build(structuredClone(ownedInput), { takeOwnership: true });
assert.equal(ownedJobs.length, 1, 'Equal fresh owned geometry reuses the previous buffers');
assert.equal(ownedReuse.copper, ownedExpected.copper);
const nextOwnedInput = structuredClone(ownedInput);
nextOwnedInput.copper.parts[0].holes[0].x += 0.25;
const nextOwnedBuild = ownedBuilder.build(nextOwnedInput, { takeOwnership: true });
assert.deepEqual(Object.keys(ownedJobs[1].surfaces).sort(), ['copper', 'silk']);
assert.equal(ownedInput.copper.parts[0].holes[0].x, 2,
    'A fresh rebuild leaves the previous owned geometry unchanged');
const nextOwnedExpected = buildSurfaceBuffers(nextOwnedInput);
ownedWorker.onmessage({ data: { id: ownedJobs[1].id, surfaces: nextOwnedExpected } });
assert.deepEqual(await nextOwnedBuild, nextOwnedExpected);
ownedBuilder.dispose();

const source = readFileSync(new URL('../src/pcb/modules/board3d.js', import.meta.url), 'utf8');
assert.ok(source.includes('surfaceBuilder.build(surfaces, { takeOwnership: true })'),
    'The viewer hands its freshly generated geometry to the builder');
const start = source.indexOf('    const appliedSurfaceBuffers = new Map();');
const end = source.indexOf('    const surfaceGeometry =', start);
assert.ok(start >= 0 && end > start);
let added = 0;
let removedMeshes = 0;
const scene = { removeMesh() { removedMeshes++; }, addMesh() { added++; return {}; } };
const surf = { copper: null };
const swap = new Function('scene', 'surf', 'surfaceGeometry', 'SURFACE_ORDER',
    `${source.slice(start, end)}\nreturn swapSurface;`)(scene, surf, (data) => data, { copper: 2 });
swap('copper', current.copper, {});
const originalMesh = surf.copper;
swap('copper', current.copper, {});
assert.equal(added, 1);
assert.equal(removedMeshes, 1);
assert.equal(surf.copper, originalMesh, 'Unchanged buffers must preserve the GPU mesh');
swap('copper', previous.copper, {});
assert.equal(added, 2);
swap('copper', undefined, {});
assert.equal(surf.copper, null);
const removalCount = removedMeshes;
swap('copper', undefined, {});
assert.equal(removedMeshes, removalCount);
console.log('PASS: exact surface reuse, changed-only jobs, mutation snapshots, removal, stale builds, and GPU mesh retention');