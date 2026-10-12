import assert from 'node:assert/strict';
import { generateFootprint } from '../../src/shared/pcb/footprint.js';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
const { PCB_LAYERS } = await import('../../src/pcb/modules/layers.js');
const { createPcbLayerGroups } = await import('../../src/pcb/modules/layer-groups.js');
const { Board2D } = await import('../../src/pcb/modules/board2d.js');
const { exportGerbers } = await import('../../src/pcb/modules/gerber.js');
const { collectCopperSubtractHoles, buildSilkMesh, buildTextMesh, createSilkArtworkMeshCache } = await import('../../src/pcb/modules/board3d-layers.js');
const { boardSurfaceFrame, buildBoardSurfaceInputs } = await import('../../src/pcb/modules/board3d-surfaces.js');
const { resolveSilk } = await import('../../src/shared/pcb/board-geometry.js');

const fixtures = [
    layer => `TRACK~1~${layer}~~10 20 30 40~id~0`,
    layer => `CIRCLE~10~20~3~1~${layer}~id`,
    layer => `ARC~1~${layer}~~M 10 20 A 3 3 0 0 1 13 23~id`,
    layer => `RECT~10~20~3~4~${layer}~id`,
    layer => `SOLIDREGION~${layer}~~M 10 20 L 13 20 L 13 24 Z~solid~id`,
];
for (const fixture of fixtures) {
    const parse = code => generateFootprint('', [], [fixture(code)], null, 'EasyEDA').silks;
    const both = parse(12), top = parse(13), bottom = parse(14), silk = parse(3);
    assert.equal(both.length, top.length * 2);
    assert.equal(bottom.length, top.length);
    assert.equal(silk.length, top.length);
    assert.ok(top.every(shape => shape.layer === 'top-document'));
    assert.ok(bottom.every(shape => shape.layer === 'bottom-document'));
    assert.ok(silk.every(shape => shape.layer === 'top-silk'));
    assert.deepEqual(both.filter(shape => shape.layer === 'top-document'), top);
    assert.deepEqual(both.filter(shape => shape.layer === 'bottom-document'), bottom);
    assert.notEqual(both[0], both[1]);
}

assert.deepEqual(PCB_LAYERS.filter(layer => layer.id.includes('document')).map(layer => layer.id),
    ['top-document', 'bottom-document']);

const boardShapes = ['top-document', 'bottom-document'].flatMap(layer => [
    { kind: 'circle', layer, x: 10, y: -10, radius: 3, lineWidth: 0.2, filled: true },
    { kind: 'rect', layer, points: [{ x: 5, y: -5 }, { x: 8, y: -5 }, { x: 8, y: -8 }, { x: 5, y: -8 }], lineWidth: 0.2, filled: true },
]);
const texts = new Map(['top-document', 'bottom-document'].map(layer => [layer,
    { layer, content: 'Reference only', x: 10, y: -10, size: 1, strokeWidth: 0.15 }]));
const silks = generateFootprint('', [], fixtures.map(fixture => fixture(12)), null, 'EasyEDA').silks;
const placements = new Map([['part', { x: 10, y: -10, silks, padOffsets: [], refVisible: false }]]);
const app = { ...pcbEditorStubs(), placements, boardShapes, texts, tracks: [], vias: [], fills: [], holes: [], boardWidth: 50, boardHeight: 40 };
assert.deepEqual(resolveSilk(placements), []);
assert.deepEqual(collectCopperSubtractHoles(boardShapes), []);
assert.deepEqual(exportGerbers(app), exportGerbers({ ...app, placements: new Map(), boardShapes: [], texts: new Map() }));

const preview = Object.create(Board2D.prototype);
preview.data = app;
const context = {
    save() {}, restore() {}, beginPath() {},
    fill() { assert.fail('Document graphics must not paint a fabricated board'); },
    stroke() { assert.fail('Document graphics must not paint a fabricated board'); },
};
for (const side of ['top', 'bottom']) {
    preview.side = side;
    preview._drawMaskOpenings(context);
    preview._drawSilk(context);
}
assert.equal(preview._drawDocumentCutouts, undefined);

for (const build of [buildSilkMesh, buildTextMesh]) {
    assert.deepEqual(build(app), { verts: [], faces: [] });
}
const surfaceFaces = shapes => {
    const board = { ...app, boardShapes: shapes, pads: [], copperFills: [], texts: new Map(),
        board: { width: 50, height: 40 , radius: 0 }};
    const surfaces = buildBoardSurfaceInputs(board, boardSurfaceFrame(board), createSilkArtworkMeshCache());
    return Object.fromEntries(Object.entries(surfaces).map(([key, surface]) =>
        [key, surface.parts.reduce((count, part) => count + part.mesh.faces.length, 0)]));
};
assert.deepEqual(surfaceFaces(boardShapes), surfaceFaces([]),
    'Document graphics add no geometry to any 3D surface (no board cutouts, mask openings or artwork)');

const { listArtworkLayers } = await import('../../src/pcb/modules/pcb-export.js');
const exportIds = listArtworkLayers({ ...pcbEditorStubs(), _layerGroups: new Map(), existingLayerGroups() { return this._layerGroups; } }).map(layer => layer.id);
globalThis.document.createElementNS = () => ({ setAttribute() {} });
globalThis.document.getElementById = () => null;
globalThis.document.querySelector = () => null;
globalThis.document.querySelectorAll = () => [];
globalThis.document.documentElement = { getAttribute: () => 'dark' };
globalThis.document.addEventListener = () => {};
const editorGroups = { groups: new Map(), viewport: { addContent() {} }, existingLayerGroups() { return this.groups; } };
createPcbLayerGroups(editorGroups);
for (const [owner, ids] of [['PDF/print export', exportIds], ['editor', [...editorGroups.groups.keys()]]]) {
    assert.ok(!ids.includes('document'), `The ${owner} must not register a combined document layer`);
    assert.ok(ids.includes('top-document') && ids.includes('bottom-document'), `The ${owner} has both document layers`);
}
const { renderPlacementSide } = await import('../../src/pcb/modules/track-commands.js');
const groups = new Map(['top-document', 'bottom-document'].map(id => [id, {
    id, appendChild(el) { el.parentNode = this; },
}]));
const artwork = ['top-document', 'bottom-document'].map(layer => ({
    parentNode: null, getAttribute: name => (name === 'data-fp-layer' ? layer : null),
}));
const sideApp = { ...pcbEditorStubs(), placements: new Map([['part', { elements: artwork }]]), getLayerGroup: id => groups.get(id) };
renderPlacementSide(sideApp, 'part', 'bottom');
assert.deepEqual(artwork.map(el => el.parentNode.id), ['bottom-document', 'top-document'],
    'Flipping a footprint swaps its document layers');
renderPlacementSide(sideApp, 'part', 'top');
assert.deepEqual(artwork.map(el => el.parentNode.id), ['top-document', 'bottom-document']);

console.log('PASS document import, distinct layers, side mapping, preview exclusion, and Gerber exclusion');