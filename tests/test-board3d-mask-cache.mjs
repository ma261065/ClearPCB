import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurfaceBuilder } from '../src/pcb/modules/board3d-surface-client.js';
import { buildSurfaceBuffers } from '../src/pcb/modules/board3d-surface-build.js';
import { decodeSurfaceInputs } from '../src/pcb/modules/board3d-surface-transfer.js';

globalThis.window = { addEventListener() {} };
const { buildMaskFaceMesh, collectMaskOpeningHoles } = await import('../src/pcb/modules/board3d.js');
const source = readFileSync(new URL('../src/pcb/modules/board3d.js', import.meta.url), 'utf8');
const first = source.indexOf("                addSurface('maskCoatTop',");
const last = source.indexOf('\n            }', first);
assert.ok(first >= 0 && last > first);
const addMaskSurfaces = new Function('app', 'outline', 'drilledHoles', 'addSurface',
    'buildMaskFaceMesh', 'collectMaskOpeningHoles', 'Y_TOP', 'Y_BOT', 'COPPER_EPS',
    source.slice(first, last));
const top = 'maskCoatTop', bottom = 'maskCoatBottom';
const both = [top, bottom];
const placement = { x: 3, y: 3, side: 'top', rotation: 0, padOffsets: [
    { dx: 0.4, dy: 0.2, width: 1, height: 0.6, shape: 'rect', layer: 'top', mask: true },
] };
const opening = { kind: 'circle', layer: 'top-mask', x: 6, y: 5, radius: 0.6, filled: true };
const pad = { x: 7, y: 7, layers: 'bottom-copper', shape: 'round', size: 1, drill: 0 };
const app = { placements: new Map([['U1', placement]]), boardShapes: [opening], pads: [pad] };
let outline = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 4 },
    { x: 8, z: 4 }, { x: 8, z: 7 }, { x: 10, z: 7 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
let holes = [{ x: 5, z: 5, r: 0.4 }];
const inputs = () => {
    const surfaces = {};
    addMaskSurfaces(app, structuredClone(outline), structuredClone(holes), (key, parts) => {
        surfaces[key] = { parts, outline: structuredClone(outline) };
    }, buildMaskFaceMesh, collectMaskOpeningHoles, 1.6, 0, 0.01);
    return surfaces;
};
const triangles = buffers => Object.values(buffers).flatMap(surface => {
    const records = [];
    for (let i = 0; i < surface.position.length; i += 9) {
        records.push(['position', 'normal', 'color']
            .flatMap(key => Array.from(surface[key].slice(i, i + 9))).join(','));
    }
    return records;
}).sort();
const jobs = [];
const worker = { postMessage(job) { jobs.push({ ...job, surfaces: decodeSurfaceInputs(job.surfaces) }); }, terminate() {} };
const builder = createSurfaceBuilder(() => worker);
let previous = null;
async function build(expectedKeys) {
    const surfaces = inputs();
    const count = jobs.length;
    const pending = builder.build(surfaces, { takeOwnership: true });
    if (expectedKeys.length) {
        assert.equal(jobs.length, count + 1);
        const job = jobs.at(-1);
        assert.deepEqual(Object.keys(job.surfaces).sort(), [...expectedKeys].sort());
        worker.onmessage({ data: { id: job.id, surfaces: buildSurfaceBuffers(job.surfaces) } });
    } else assert.equal(jobs.length, count, 'No worker work for unchanged mask inputs');
    const result = await pending;
    const combined = buildSurfaceBuffers({ maskCoat: { outline, parts: [
        { mesh: buildMaskFaceMesh(outline, 1.61), holes: holes.concat(collectMaskOpeningHoles(app.boardShapes, 'top', app.placements, app.pads)) },
        { mesh: buildMaskFaceMesh(outline, -0.01, true), holes: holes.concat(collectMaskOpeningHoles(app.boardShapes, 'bottom', app.placements, app.pads)) },
    ] } });
    assert.deepEqual(triangles(result), triangles(combined), 'Split faces preserve geometry, winding, normals, colors and multiplicity');
    for (const key of both) {
        if (previous && !expectedKeys.includes(key)) {
            assert.equal(result[key], previous[key], 'Unchanged face retains its finished buffers');
        }
    }
    previous = result;
    return result;
}

await build(both);
await build([]);
for (const edit of [
    () => { placement.x += 0.5; },
    () => { placement.rotation = 35; },
    () => { placement.mirror = true; },
    () => { placement.padOffsets[0].mask = false; },
    () => { placement.padOffsets[0].mask = true; },
    () => { app.placements.clear(); },
    () => { app.placements.set('U1', placement); },
    () => { opening.radius += 0.2; },
    () => { opening.layer = 'top-silk'; },
    () => { opening.layer = 'top-mask'; },
]) {
    edit();
    await build([top]);
}
placement.side = 'bottom';
placement.padOffsets[0].layer = 'bottom';
await build(both);
placement.x += 0.5;
await build([bottom]);
placement.padOffsets[0].layer = 'both';
await build([top]);
placement.x += 0.25;
await build(both);
placement.padOffsets[0].layer = 'bottom';
await build([top]);
pad.x += 0.5;
await build([bottom]);
pad.layers = 'both';
await build([top]);
pad.size += 0.2;
await build(both);
opening.layer = 'bottom-mask';
await build(both);
app.boardShapes = [];
await build([bottom]);
app.boardShapes = [opening];
await build([bottom]);
for (const edit of [
    () => { holes.push({ x: 3, z: 3, r: 0.3 }); },
    () => { holes[0].x += 0.5; },
    () => { holes[0].r += 0.1; },
    () => { holes.push({ ring: [{ x: 1, z: 1 }, { x: 2, z: 1 }, { x: 2, z: 2 }, { x: 1, z: 2 }] }); },
    () => { holes = []; },
    () => { outline[2].x += 0.5; },
    () => { outline.reverse(); },
]) {
    edit();
    await build(both);
}
const a = buildMaskFaceMesh(outline, 1.61), b = buildMaskFaceMesh(outline, -0.01, true);
assert.notEqual(a.faces[0].color, b.faces[0].color, 'Each face owns a detached palette snapshot');
a.faces[0].color[0] += 1;
assert.notDeepEqual(a.faces[0].color, buildMaskFaceMesh(outline, 1.61).faces[0].color,
    'Retained geometry cannot mutate the source palette');
const recolored = inputs();
for (const key of both) recolored[key].parts[0].mesh.faces[0].color[0] += 1;
const colorUpdate = builder.build(recolored, { takeOwnership: true });
const colorJob = jobs.at(-1);
assert.deepEqual(Object.keys(colorJob.surfaces).sort(), [...both].sort(), 'Color changes invalidate both faces');
worker.onmessage({ data: { id: colorJob.id, surfaces: buildSurfaceBuffers(colorJob.surfaces) } });
await colorUpdate;
await build(both);
const staleInputs = inputs();
staleInputs[top].parts = [];
const stale = builder.build(staleInputs);
const staleJob = jobs.at(-1);
builder.invalidate({ cancelActive: true });
assert.equal(await stale, null, 'Cancelled face builds cannot publish half a mask update');
worker.onmessage({ data: { id: staleJob.id, surfaces: buildSurfaceBuffers(staleJob.surfaces) } });
await build([]);
builder.dispose();
assert.match(source, /maskCoatTop: scene\.maskCoatMaterial, maskCoatBottom: scene\.maskCoatMaterial/);
assert.match(source, /maskCoatTop: 5,\s+maskCoatBottom: 5/);
assert.match(source, /for \(const key of Object\.keys\(surf\)\) swapSurface\(key, result\[key\], materials\[key\]\);\s+if \(syncComponentBodies\) syncBodies\(\);/,
    'All completed faces and component bodies publish together');
console.log('PASS independent mask faces, unchanged buffer reuse, split/combined triangle parity, side/pad/shape/drill/outline/color edits and cancellation');
