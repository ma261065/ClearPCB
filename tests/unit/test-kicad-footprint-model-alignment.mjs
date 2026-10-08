import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
document.body.contains = () => false;
const { KiCadFetcher } = await import('../../src/components/KiCadFetcher.js');
const { generateFootprint } = await import('../../src/shared/pcb/footprint.js');
const { parseObjModel } = await import('../../src/shared/3d/model-rendering.js');
const { objModelToMesh } = await import('../../src/pcb/modules/board3d-parts.js');
const { resolveObjFromModelUrl } = await import('../../src/components/model3d-source.js');

// A KiCad footprint (Y-down, origin at pin 1) with an asymmetric pad set and a
// pin-1 notch above the pads, as in Package_DIP.
const pins = [['1', 0, 0], ['2', 0, 2.54], ['3', 0, 5.08], ['4', 7.62, 5.08], ['5', 7.62, 0]];
const kicadMod = `(footprint "Asymmetric"
    (fp_arc (start 4.81 -1.33) (mid 3.81 -0.33) (end 2.81 -1.33) (stroke (width 0.12)) (layer "F.SilkS"))
${pins.map(([n, x, y]) => `    (pad "${n}" thru_hole circle (at ${x} ${y}) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask"))`).join('\n')}
)`;
const parsed = new KiCadFetcher()._parseFootprintPreview(kicadMod);
const footprint = generateFootprint('', [], parsed.shapes, parsed.bbox, 'KiCad');
const pad = number => footprint.pads.find(candidate => candidate.number === number);
assert.ok(pad('2').y > pad('1').y, 'Pin 2 stays below pin 1, as in the KiCad file');
assert.ok(pad('5').x > pad('1').x);
const notch = footprint.silks.find(shape => shape.type === 'path');
const [, , notchY, , , controlY] = notch.d.trim().split(/\s+/).map(Number);
assert.ok(notchY < pad('1').y, 'The pin-1 notch stays above the pins (the footprint is not mirrored)');
assert.ok(Math.abs((controlY - notchY) - 2) < 1e-9,
    'The notch arc bulges down towards the pins through its KiCad midpoint (y = -0.33)');

// A KiCad 3D model in KiCad's convention: millimetres, Y up (model y = -footprint y),
// the model origin at the footprint origin (pin 1) and z = 0 on the board surface.
// Leads run from 3 mm below the board to the body, which starts 0.5 mm above it.
function box(out, [x0, y0, z0], [x1, y1, z1], material) {
    const base = out.vertices.length + 1;
    for (const z of [z0, z1]) for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) out.vertices.push(`v ${x} ${y} ${z}`);
    out.faces.push(`usemtl ${material}`);
    for (const quad of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
        out.faces.push(`f ${quad.map(index => base + index).join(' ')}`);
    }
}
const obj = { vertices: [], faces: [] };
for (const [, x, y] of pins) box(obj, [x - 0.25, -y - 0.25, -3], [x + 0.25, -y + 0.25, 0.5], 'm_200_200_200');
box(obj, [-0.5, 0.5, 0.5], [8.1, -5.6, 3.5], 'm_30_30_30');
const model = parseObjModel(['newmtl m_200_200_200', 'Kd 0.8 0.8 0.8', 'newmtl m_30_30_30', 'Kd 0.1 0.1 0.1',
    ...obj.vertices, ...obj.faces].join('\n'));
assert.equal(model.source, 'kicad');

const BOARD_TOP = 1.6;
for (const rotation of [0, 90]) {
    const placement = { x: 40, y: -25, rotation, side: 'top', model3dPlacement: footprint.model3d };
    const mesh = objModelToMesh(model, placement);
    const section = height => {
        const points = [];
        for (const face of mesh.faces) {
            const vertices = face.idx.map(index => mesh.verts[index]);
            for (let index = 0; index < vertices.length; index++) {
                const a = vertices[index], b = vertices[(index + 1) % vertices.length];
                if ((a.y - height) * (b.y - height) >= 0) continue;
                const t = (height - a.y) / (b.y - a.y);
                points.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) });
            }
        }
        return points;
    };
    const leadPoints = section(BOARD_TOP - 1);
    const angle = rotation * Math.PI / 180;
    for (const [number] of pins) {
        const { x, y } = pad(number);
        const expected = { x: placement.x + x * Math.cos(angle) - y * Math.sin(angle),
            z: placement.y + x * Math.sin(angle) + y * Math.cos(angle) };
        const near = leadPoints.filter(point => Math.hypot(point.x - expected.x, point.z - expected.z) < 0.4);
        assert.ok(near.length, `Pin ${number} lead passes through its pad at ${rotation}°`);
        const centre = near.reduce((sum, point) => ({ x: sum.x + point.x / near.length, z: sum.z + point.z / near.length }), { x: 0, z: 0 });
        assert.ok(Math.hypot(centre.x - expected.x, centre.z - expected.z) < 1e-6, `Pin ${number} lead is centred on its pad`);
    }
    const lowest = Math.min(...mesh.verts.map(vertex => vertex.y));
    assert.ok(Math.abs(lowest - (BOARD_TOP - 3)) < 1e-9, 'KiCad z = 0 is the board surface: leads go through the board');
    const bodyVertices = mesh.faces.filter(face => face.color[0] < 50).flatMap(face => face.idx.map(index => mesh.verts[index]));
    assert.ok(Math.abs(Math.min(...bodyVertices.map(vertex => vertex.y)) - (BOARD_TOP + 0.5)) < 1e-9,
        'The body keeps its authored 0.5 mm stand-off instead of being lifted onto the lead tips');
}

// KiCad VRML models are in 0.1-inch units; the converter returns millimetres.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, text: async () => `#VRML V2.0 utf8
Shape { appearance Appearance { material Material { diffuseColor 0.5 0.5 0.5 } }
geometry IndexedFaceSet { coord Coordinate { point [ 0 0 0, 3 0 0, 3 -1 0, 0 0 1 ] } coordIndex [ 0, 1, 2, -1, 0, 1, 3, -1 ] } }` });
try {
    const vrml = parseObjModel(await resolveObjFromModelUrl('https://example.invalid/Package.3dshapes/Part.wrl'));
    assert.deepEqual(vrml.vertices.map(vertex => [vertex.x, vertex.y, vertex.z].map(value => Math.round(value * 1000) / 1000)),
        [[0, 0, 0], [7.62, 0, 0], [7.62, -2.54, 0], [0, 0, 2.54]]);
    assert.equal(vrml.source, 'kicad');
} finally {
    globalThis.fetch = originalFetch;
}
console.log('PASS KiCad footprints keep their Y-down orientation and KiCad 3D models seat on their pads at board level');
