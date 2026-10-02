import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurfaceBuilder } from '../src/pcb/modules/board3d-surface-client.js';
import { buildSurfaceBuffers } from '../src/pcb/modules/board3d-surface-build.js';
import { decodeSurfaceInputs } from '../src/pcb/modules/board3d-surface-transfer.js';
import { pictureShape } from '../src/shared/pcb/picture-raster.js';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, dispatchEvent() {} };
globalThis.document = { body: { contains: () => false } };
const { buildSilkMesh, createSilkArtworkMeshCache, buildBoardSurfaceInputs, getLayerStylesAppearance, setLayerStylesAppearance } =
    await import('../src/pcb/modules/board3d.js');
const source = readFileSync(new URL('../src/pcb/modules/board3d.js', import.meta.url), 'utf8');
const artworkMesh = createSilkArtworkMeshCache();
const placement = { x: 5, y: 5, rotation: 0, side: 'top', silks: [
    { layer: 'top-silk', type: 'line', x1: -2, y1: 0, x2: 2, y2: 0, strokeWidth: 0.3 },
    { layer: 'top-silk', type: 'circle', cx: 0, cy: 1, r: 0.5, strokeWidth: 0.1 },
] };
const image = pictureShape({ width: 3, height: 3, rectangles: [
    { x: 0, y: 0, width: 3, height: 1 }, { x: 0, y: 1, width: 1, height: 2 },
] }, { widthMm: 6, layer: 'top-silk', center: { x: 5, y: 5 } });
const bottom = { kind: 'circle', layer: 'bottom-silk', x: 3, y: 4, radius: 1, lineWidth: 0.2, filled: false };
const app = { placements: new Map([['U1', placement]]), boardShapes: [image, bottom],
    tracks: [], vias: [], pads: [], copperFills: [], texts: new Map() };
let outline = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 4 },
    { x: 8, z: 4 }, { x: 8, z: 7 }, { x: 10, z: 7 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
let holes = [{ x: 5, z: 5, r: 0.4 }];
const inputs = () => {
    const { silk, silkArtwork } = buildBoardSurfaceInputs(app, {
        outline: structuredClone(outline), drilledHoles: structuredClone(holes), boardHoles: [], crossingRings: [],
    }, artworkMesh);
    return { silk, silkArtwork };
};
const triangles = buffers => {
    const result = [];
    for (const surface of Object.values(buffers)) {
        for (let i = 0; i < surface.position.length; i += 9) {
            result.push(['position', 'normal', 'color'].flatMap(key => Array.from(surface[key].slice(i, i + 9))).join(','));
        }
    }
    return result.sort();
};
const jobs = [];
const worker = { postMessage(job) { jobs.push({ ...job, surfaces: decodeSurfaceInputs(job.surfaces) }); }, terminate() {} };
const builder = createSurfaceBuilder(() => worker);
async function build(expectedKeys) {
    const count = jobs.length;
    const pending = builder.build(inputs(), { takeOwnership: true });
    if (expectedKeys.length) {
        assert.equal(jobs.length, count + 1);
        const job = jobs.at(-1);
        assert.deepEqual(Object.keys(job.surfaces).sort(), expectedKeys.sort());
        worker.onmessage({ data: { id: job.id, surfaces: buildSurfaceBuffers(job.surfaces) } });
    } else assert.equal(jobs.length, count, 'Unchanged inputs dispatch no worker work');
    const result = await pending;
    const combined = buildSurfaceBuffers({ silk: { outline, parts: [{ mesh: buildSilkMesh(app), holes }] } });
    assert.deepEqual(triangles(result), triangles(combined), 'Partitioning retains every triangle, normal, color and overlap');
    return result;
}

let previous = await build(['silk', 'silkArtwork']);
let cachedMesh = artworkMesh(app.boardShapes);
assert.equal(artworkMesh(structuredClone(app.boardShapes)), cachedMesh, 'Equal replacement data reuses the expanded mesh');
for (const edit of [
    () => { placement.x += 1; },
    () => { placement.rotation = 47; },
    () => { placement.mirror = true; },
    () => { placement.side = 'bottom'; },
    () => { app.placements.clear(); },
    () => { app.placements.set('U1', placement); },
]) {
    edit();
    const result = await build(['silk']);
    assert.equal(result.silkArtwork, previous.silkArtwork, 'Component edits reuse finished artwork buffers');
    assert.equal(artworkMesh(app.boardShapes), cachedMesh, 'Component edits do not rebuild source artwork');
    previous = result;
}
await build([]);
for (const edit of [
    () => { image.points.forEach(point => { point.x += 0.25; }); },
    () => { image.artwork = { ...image.artwork, flipHorizontal: true }; },
    () => { image.layer = 'bottom-silk'; },
    () => { image.layer = 'top-document'; },
    () => { image.layer = 'top-silk'; },
    () => { bottom.lineWidth += 0.1; },
    () => { app.boardShapes.splice(1, 1); },
    () => { app.boardShapes.push(bottom); },
]) {
    edit();
    const result = await build(['silkArtwork']);
    assert.notEqual(artworkMesh(app.boardShapes), cachedMesh, 'Artwork edits invalidate the expanded mesh');
    cachedMesh = artworkMesh(app.boardShapes);
    assert.equal(result.silk, previous.silk);
    previous = result;
}
for (const edit of [
    () => { holes = [...holes, { x: 4, z: 4, r: 0.3 }]; },
    () => { holes[0].x += 0.5; },
    () => { holes = []; },
    () => { outline = outline.map(p => ({ ...p, x: p.x + 0.5 })); },
]) {
    edit();
    await build(['silk', 'silkArtwork']);
    assert.equal(artworkMesh(app.boardShapes), cachedMesh, 'Outline/drill edits reclip without retriangulating artwork');
}
const paletteCache = createSilkArtworkMeshCache();
const beforePalette = paletteCache(app.boardShapes);
const silkStyle = getLayerStylesAppearance().silkscreen;
try {
    setLayerStylesAppearance({ silkscreen: { v: silkStyle.v / 2 } });
    assert.notEqual(paletteCache(app.boardShapes), beforePalette, 'In-place palette changes invalidate source mesh reuse');
} finally {
    setLayerStylesAppearance({ silkscreen: silkStyle });
}
assert.notEqual(beforePalette.faces[0].color, cachedMesh.faces[0].color,
    'Each generated silk mesh owns its color snapshot rather than sharing a mutable palette');
const saved = structuredClone(app.boardShapes);
app.boardShapes = [];
const removed = await build(['silkArtwork']);
assert.equal(removed.silkArtwork.position.length, 0, 'Deleting all artwork removes its rendered surface');
app.boardShapes = saved;
await build(['silkArtwork']);

const stale = builder.build({ ...inputs(), silkArtwork: { parts: [], outline } });
builder.invalidate({ cancelActive: true });
assert.equal(await stale, null, 'Cancelled geometry cannot publish a partial artwork update');
await build([]);
builder.dispose();
assert.notEqual(createSilkArtworkMeshCache()(saved), artworkMesh(saved), 'Reopened viewers own fresh caches');
assert.match(source, /silkArtwork: scene\.silkMaterial/, 'Both silk partitions share opacity/depth material');
assert.match(source, /silkArtwork: 7/, 'Artwork retains the silk layer order');
console.log('PASS cached source artwork, changed-only worker jobs, split/combined geometry parity, edits, layers, holes, outline, palette, deletion, restoration and cancellation');
