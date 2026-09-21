import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import * as THREE from '../assets/vendor/three.module.js';
import { buildSurfaceBuffers } from '../src/pcb/modules/board3d-surface-build.js';
import { createSurfaceBuilder } from '../src/pcb/modules/board3d-surface-client.js';
import { encodeSurfaceInputs, decodeSurfaceInputs } from '../src/pcb/modules/board3d-surface-transfer.js';
import { clipMeshToOutline, punchHolesInFlatMesh } from '../src/pcb/modules/board3d-mesh-ops.js';
import { meshToGeometry } from '../src/shared/3d/model-rendering.js';

const mesh = {
    verts: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }],
    faces: Array.from({ length: 100 }, () => ({ idx: [0, 1, 2], color: [64, 128, 192] })),
};
const surfaces = {
    copper: {
        outline: [{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 8, z: 8 }, { x: 0, z: 8 }],
        parts: [{ mesh, holes: [{ x: 2, z: 2, r: 1 }] },
            { mesh: { ...mesh, verts: mesh.verts.map((point) => ({ ...point, y: 1.6 })) } }],
    },
    empty: { parts: [] },
};
const expected = buildSurfaceBuffers(surfaces);
const originalSetRGB = THREE.Color.prototype.setRGB;
let colorConversions = 0;
THREE.Color.prototype.setRGB = function (...args) {
    colorConversions++;
    return originalSetRGB.apply(this, args);
};
try {
    const sameColor = meshToGeometry(mesh);
    assert.equal(colorConversions, 1, 'Repeated face colors need only one sRGB conversion');
    sameColor.dispose();
    colorConversions = 0;
    const mixed = meshToGeometry({ verts: mesh.verts, faces: [
        { idx: [0, 1, 2], color: [64, 128, 192] },
        { idx: [0, 1, 2], color: [64, 128, 192] },
        { idx: [0, 1, 2], color: [255, 0, 0] },
        { idx: [0, 1, 2], color: [64, 128, 192] },
    ] });
    assert.equal(colorConversions, 3, 'Color changes must recompute even when a previous color returns');
    const linear = new THREE.Color().setRGB(64 / 255, 128 / 255, 192 / 255, THREE.SRGBColorSpace);
    const expectedColors = new Float32Array(
        [linear, linear, { r: 1, g: 0, b: 0 }, linear]
            .flatMap(color => Array.from({ length: 3 }, () => [color.r, color.g, color.b]).flat()));
    assert.deepEqual(mixed.getAttribute('color').array, expectedColors);
    mixed.dispose();
} finally { THREE.Color.prototype.setRGB = originalSetRGB; }
const preciseMesh = {
    verts: [{ x: 1 / 3, y: -0, z: 1e-12 }, { x: 2, y: 1.6, z: 0 },
        { x: 2, y: 1.6, z: 2 }, { x: 0, y: 1.6, z: 2 }],
    faces: [{ idx: [0, 1, 2, 3], color: [12.5, 128, 255] }, { idx: [0, 2, 3] }],
};
const preciseInput = { test: { parts: [{ mesh: preciseMesh }, { mesh: preciseMesh }] } };
const encodedInput = encodeSurfaceInputs(preciseInput);
assert.equal(encodedInput.transfer.length, 1, 'Shared meshes are packed and transferred once');
const transported = structuredClone(encodedInput.surfaces, { transfer: encodedInput.transfer });
assert.equal(encodedInput.transfer[0].byteLength, 0, 'Only packed buffers are detached');
const decoded = decodeSurfaceInputs(transported);
assert.deepEqual(decoded, preciseInput, 'Transport preserves double precision, polygons, and optional colors');
assert.equal(decoded.test.parts[0].mesh, decoded.test.parts[1].mesh);
assert.equal(preciseMesh.verts[0].x, 1 / 3, 'Original cache geometry stays intact');
const combined = { verts: [], faces: [] };
for (const part of surfaces.copper.parts) {
    const cut = punchHolesInFlatMesh(part.mesh, part.holes || []);
    const offset = combined.verts.length;
    combined.verts.push(...cut.verts);
    combined.faces.push(...cut.faces.map((face) => ({
        ...face, idx: face.idx.map((index) => index + offset),
    })));
}
const legacy = meshToGeometry(clipMeshToOutline(combined, surfaces.copper.outline));
for (const attribute of ['position', 'normal', 'color']) {
    assert.deepEqual(expected.copper[attribute], legacy.getAttribute(attribute).array);
    assert.equal(expected.empty[attribute].length, 0);
}
legacy.dispose();
const viewerSource = readFileSync(new URL('../src/pcb/modules/board3d.js', import.meta.url), 'utf8');
const geometryStart = viewerSource.indexOf('    const surfaceGeometry = (data) => {');
const geometryEnd = viewerSource.indexOf('    let hasSurfaces', geometryStart);
assert.ok(geometryStart >= 0 && geometryEnd > geometryStart);
const surfaceGeometry = new Function('THREE',
    `${viewerSource.slice(geometryStart, geometryEnd)}\nreturn surfaceGeometry;`)(THREE);
const reconstructed = surfaceGeometry(expected.copper);
for (const attribute of ['position', 'normal', 'color']) {
    assert.deepEqual(reconstructed.getAttribute(attribute).array, expected.copper[attribute]);
}
reconstructed.dispose();
const workerUrl = new URL('../src/pcb/modules/board3d-surface-worker.js?v=7', import.meta.url).href;
const thread = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = (data, options) => parentPort.postMessage(data, options?.transfer);
    import(${JSON.stringify(workerUrl)}).then(() => {
        parentPort.on('message', data => globalThis.onmessage({ data }));
        parentPort.postMessage({ ready: true });
    });
`, { eval: true });
try {
    await new Promise((resolve, reject) => { thread.once('message', resolve); thread.once('error', reject); });
    let mainThreadTicks = 0;
    const interval = setInterval(() => mainThreadTicks++, 0);
    let response;
    try {
        response = await new Promise((resolve, reject) => {
            thread.once('message', resolve);
            thread.once('error', reject);
            thread.postMessage({ id: 7, surfaces });
        });
    } finally { clearInterval(interval); }
    assert.equal(response.id, 7);
    assert.deepEqual(response.surfaces, expected);
    assert.ok(mainThreadTicks > 0, 'Main-thread tasks must run while geometry is built in the worker');
    const encoded = encodeSurfaceInputs(surfaces);
    const packedResponse = await new Promise((resolve, reject) => {
        thread.once('message', resolve);
        thread.once('error', reject);
        thread.postMessage({ id: 8, surfaces: encoded.surfaces }, encoded.transfer);
    });
    assert.deepEqual(packedResponse.surfaces, expected, 'Transferred meshes produce byte-identical worker output');
} finally { await thread.terminate(); }

const sent = [];
let terminated = false;
const fakeWorker = { postMessage(job) { sent.push(job); }, terminate() { terminated = true; } };
const builder = createSurfaceBuilder(() => fakeWorker);
const first = builder.build(surfaces);
builder.invalidate();
const second = builder.build(surfaces);
const third = builder.build(surfaces);
assert.equal(await second, null);
assert.equal(sent.length, 1, 'Only one job may be in flight');
fakeWorker.onmessage({ data: { id: sent[0].id, surfaces: expected } });
assert.equal(await first, null, 'Old edits must not replace the visible board');
assert.equal(sent.length, 2, 'Only the latest pending job should be sent');
fakeWorker.onmessage({ data: { id: sent[1].id, surfaces: expected } });
assert.deepEqual(await third, expected);
const closingSurfaces = structuredClone(surfaces);
closingSurfaces.copper.parts[0].mesh.verts[0].x += 1;
const closing = builder.build(closingSurfaces);
builder.dispose();
assert.equal(await closing, null);
assert.ok(terminated);
assert.equal(await builder.build(surfaces), null);
const failureWorker = { postMessage() {}, terminate() {} };
const failures = createSurfaceBuilder(() => failureWorker);
const failing = failures.build(surfaces);
const rejection = assert.rejects(failing, /worker failed/);
failureWorker.onerror({ message: 'worker failed' });
await rejection;
const retry = failures.build(surfaces);
failures.invalidate();
failureWorker.onmessage({ data: { id: 2, surfaces: expected } });
assert.equal(await retry, null);
failures.dispose();

const preemptWorkers = [];
const preemptJobs = [];
const preempting = createSurfaceBuilder(() => {
    const instance = {
        terminated: false,
        postMessage(job) { preemptJobs.push({ instance, job }); },
        terminate() { this.terminated = true; },
    };
    preemptWorkers.push(instance);
    return instance;
});
const obsolete = preempting.build(surfaces);
preempting.invalidate({ cancelActive: true });
assert.equal(await obsolete, null, 'Preempting resolves the obsolete build immediately');
assert.equal(preemptWorkers[0].terminated, true, 'Preempting terminates the obsolete worker');
const currentBuild = preempting.build(surfaces);
assert.equal(preemptWorkers.length, 2, 'The latest build starts on a fresh worker immediately');
preemptWorkers[1].onmessage({ data: { id: preemptJobs.at(-1).job.id, surfaces: expected } });
assert.deepEqual(await currentBuild, expected);
preempting.dispose();
console.log('PASS: real worker geometry parity, responsive main thread, latest-only jobs, disposal, and failures');