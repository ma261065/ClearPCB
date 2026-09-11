import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFootprint } from '../src/pcb/modules/footprint.js';

globalThis.document = { body: { contains() { return false; } } };
globalThis.window = { addEventListener() {}, dispatchEvent() {} };
globalThis.localStorage = { getItem() { return null; } };
const { PCB_LAYERS } = await import('../src/pcb/modules/layers.js');
const { Board2D } = await import('../src/pcb/modules/board2d.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const { collectCopperSubtractHoles } = await import('../src/pcb/modules/board3d.js');
const { resolveSilk } = await import('../src/pcb/modules/board-geometry.js');

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
const app = { placements, boardShapes, texts, tracks: [], vias: [], fills: [], holes: [], boardWidth: 50, boardHeight: 40 };
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

const source = readFileSync(new URL('../src/pcb/modules/board3d.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const emptyMesh = () => ({ verts: [], faces: [] });
for (const name of ['buildSilkMesh', 'buildTextMesh']) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    const end = source.indexOf('\n}', start) + 2;
    const build = new Function('emptyMesh', 'resolveSilk', `${source.slice(start, end)}; return ${name};`)(emptyMesh, resolveSilk);
    assert.deepEqual(build(app), emptyMesh());
}
assert.ok(!source.includes('documentCutout'));

for (const relativePath of ['../src/pcb/modules/pcb-export.js', '../src/ui/PCBApp.js']) {
    const content = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.ok(!content.includes("'document'"), `${relativePath} must not register a combined document layer`);
    assert.ok(content.includes("'top-document'") && content.includes("'bottom-document'"));
}
const commandSource = readFileSync(new URL('../src/pcb/modules/track-commands.js', import.meta.url), 'utf8');
const flipSource = /const FP_LAYER_FLIP = (\{[\s\S]*?\});/.exec(commandSource)?.[1];
assert.ok(flipSource);
const flip = new Function(`return ${flipSource};`)();
assert.equal(flip['top-document'], 'bottom-document');
assert.equal(flip['bottom-document'], 'top-document');

console.log('PASS document import, distinct layers, side mapping, preview exclusion, and Gerber exclusion');