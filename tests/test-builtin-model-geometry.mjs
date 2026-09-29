import assert from 'node:assert/strict';
import { builtInPackageLayouts, getBuiltInModel3D } from '../src/components/BuiltInModels3D.js';
import { parseObjModel } from '../src/shared/3d/model-rendering.js';

const cases = [
    ['Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal', [[-3.81, 0], [3.81, 0]], [8.1, 2.5, 2.9]],
    ['Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm', [[-2.5, 0], [2.5, 0]], [5.5, 2.5, 6]],
    ['Capacitor_THT:CP_Radial_D5.0mm_P2.50mm', [[-1.25, 0], [1.25, 0]], [5, 5, 6.72]],
    ['Inductor_THT:L_Axial_L6.8mm_D2.4mm_P7.62mm_Horizontal_Vertical', [[-3.81, 0], [3.81, 0]], [8.1, 2.4, 2.8]],
    ['Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal', [[-3.81, 0], [3.81, 0]], [8.1, 1.8, 2.2]],
    ['LED_THT:LED_D5.0mm', [[-1.27, 0], [1.27, 0]], [5, 5, 6.3]],
    ['Package_TO_SOT_THT:TO-92_Inline', [[-1.27, 0], [0, 0], [1.27, 0]], [4.6, 3, 5.7]],
    ['Package_DIP:DIP-8_W7.62mm', [-3.81, 3.81].flatMap(x => [-3.81, -1.27, 1.27, 3.81].map(y => [x, y])), [8, 9.4, 3.53]],
    ['Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical', [[0, -1.27], [0, 1.27]], [2.54, 5.08, 8.3]],
    ['Button_Switch_THT:SW_PUSH_6mm', [-3.25, 3.25].flatMap(x => [-2.25, 2.25].map(y => [x, y])), [7.2, 6, 4.8]],
    ['Package_TO_SOT_SMD:SOT-23', [[-0.95, 1.1], [0.95, 1.1], [0, -1.1]], [2.9, 2.8, 1.3]],
];
for (const entry of Object.values(builtInPackageLayouts)) {
    if (cases.some(([footprint]) => footprint === entry.footprint)) continue;
    cases.push([entry.footprint, entry.pads.map(([x, y]) => [x, y]), [
        Math.max(entry.body[0], ...entry.pads.map(([x, , width]) => Math.abs(x) * 2 + width)) + 2,
        Math.max(entry.body[1], ...entry.pads.map(([, y, , height]) => Math.abs(y) * 2 + height)) + 2,
        entry.body[2] + 1,
    ]]);
}
const subtract = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const colors = mesh => new Set(mesh.faces.map(face => face.color.join(',')));
const containsXY = (triangle, x, y) => {
    const signs = triangle.map((a, i) => {
        const b = triangle[(i + 1) % 3];
        return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    });
    return signs.every(value => value >= -1e-8) || signs.every(value => value <= 1e-8);
};
const signatures = new Set();
const meshes = new Map();

for (const [footprint, pads, maxSize] of cases) {
    const obj = getBuiltInModel3D(footprint);
    assert.equal(getBuiltInModel3D(footprint), obj, `${footprint}: cache is stable`);
    assert.ok(obj.length < 100_000, `${footprint}: small OBJ`);
    assert.doesNotMatch(obj, /newmtl m_\d+_\d+_\d+/);
    const mesh = parseObjModel(obj);
    assert.ok(mesh);
    meshes.set(footprint, mesh);
    assert.equal(mesh.source, 'easyeda', 'No unintended KiCad rotation');
    assert.ok(mesh.vertices.length < 800 && mesh.faces.length < 1200, `${footprint}: modest mesh`);
    assert.ok(mesh.vertices.every(vertex => Object.values(vertex).every(Number.isFinite)));
    assert.ok(colors(mesh).size >= 2, `${footprint}: body and lead colours`);
    assert.ok(colors(mesh).has('180,188,198') || colors(mesh).has('211,166,57'), 'Metal leads');
    const bounds = ['x', 'y', 'z'].map(axis => [
        Math.min(...mesh.vertices.map(vertex => vertex[axis])),
        Math.max(...mesh.vertices.map(vertex => vertex[axis])),
    ]);
    assert.equal(bounds[2][0], 0, `${footprint}: on board surface`);
    for (let axis = 0; axis < 3; axis++) {
        const [min, max] = bounds[axis];
        assert.ok(max - min > 0 && max - min <= maxSize[axis] + 1e-6, `${footprint}: mm size bounds`);
        if (axis < 2) assert.ok(Math.abs(min + max) < 1e-6, `${footprint}: centred XY`);
    }

    // Find individual closed convex solids from their shared vertex indices.
    const parents = mesh.vertices.map((_, i) => i);
    const root = i => parents[i] === i ? i : (parents[i] = root(parents[i]));
    for (const face of mesh.faces) {
        assert.equal(face.idx.length, 3);
        assert.ok(face.idx.every(i => Number.isInteger(i) && i >= 0 && i < mesh.vertices.length));
        for (const i of face.idx) parents[root(i)] = root(face.idx[0]);
    }
    const solids = new Map();
    mesh.vertices.forEach((vertex, i) => {
        const id = root(i);
        if (!solids.has(id)) solids.set(id, []);
        solids.get(id).push(vertex);
    });
    const centres = new Map([...solids].map(([id, vertices]) => [id,
        Object.fromEntries(['x', 'y', 'z'].map(axis => [
            axis, vertices.reduce((sum, vertex) => sum + vertex[axis], 0) / vertices.length,
        ])),
    ]));
    const edges = new Map();
    for (const face of mesh.faces) {
        const [a, b, c] = face.idx.map(i => mesh.vertices[i]);
        const normal = cross(subtract(b, a), subtract(c, a));
        assert.ok(Math.hypot(...normal) > 1e-8, `${footprint}: non-degenerate triangles`);
        assert.ok(dot(normal, subtract(a, centres.get(root(face.idx[0])))) > 1e-9,
            `${footprint}: outward winding, including reflected Y`);
        assert.ok(face.color.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255));
        for (let i = 0; i < 3; i++) {
            const a = face.idx[i], b = face.idx[(i + 1) % 3];
            const key = `${Math.min(a, b)},${Math.max(a, b)}`;
            const edge = edges.get(key) || { count: 0, direction: 0 };
            edge.count++;
            edge.direction += a < b ? 1 : -1;
            edges.set(key, edge);
        }
    }
    assert.ok([...edges.values()].every(edge => edge.count === 2 && edge.direction === 0),
        `${footprint}: closed consistently wound solids`);
    const contacts = mesh.faces.filter(face => face.idx.every(i => mesh.vertices[i].z === 0));
    for (const [x, boardY] of pads) {
        assert.ok(contacts.some(face =>
            ['180,188,198', '211,166,57'].includes(face.color.join(',')) &&
            containsXY(face.idx.map(i => mesh.vertices[i]), x, -boardY)),
        `${footprint}: metallic lead at pad (${x}, ${boardY}) on board surface`);
    }
    for (const face of contacts) {
        const triangle = face.idx.map(i => mesh.vertices[i]);
        const cx = triangle.reduce((sum, vertex) => sum + vertex.x, 0) / 3;
        const cy = triangle.reduce((sum, vertex) => sum + vertex.y, 0) / 3;
        assert.ok(pads.some(([x, y]) => Math.hypot(cx - x, cy + y) < 0.6),
            `${footprint}: no extra board-surface contacts`);
    }
    signatures.add(JSON.stringify([bounds, mesh.vertices.length, mesh.faces.length, [...colors(mesh)].sort()]));
    console.log(`PASS ${footprint}: ${mesh.vertices.length} vertices, ${mesh.faces.length} triangles`);
}
assert.equal(signatures.size, cases.length, 'Every package has distinguishable geometry');
for (const entry of Object.values(builtInPackageLayouts)) {
    const mesh = meshes.get(entry.footprint);
    if (!['diode', 'can', 'led', 'ic'].includes(entry.kind)) continue;
    const markerColor = ['can', 'led'].includes(entry.kind) ? '35,38,43' : '216,218,205';
    const markers = mesh.faces.filter(face => face.color.join(',') === markerColor
        && face.idx.every(i => mesh.vertices[i].z >= entry.body[2]));
    assert.ok(markers.length, `${entry.footprint}: top polarity / pin-1 marker`);
    assert.ok(markers.every(face => face.idx.every(i => entry.kind === 'ic'
        ? mesh.vertices[i].x < 0 && mesh.vertices[i].y > 0
        : mesh.vertices[i].x > 0)), `${entry.footprint}: correct marker side`);
}

const dip = meshes.get('Package_DIP:DIP-8_W7.62mm');
assert.ok(dip.faces.some(face => face.color.join(',') === '216,218,205' &&
    face.idx.every(i => dip.vertices[i].x < -1 && dip.vertices[i].y > 3)),
'DIP pin-1 marker is left/top after renderer Y reflection');
const diode = meshes.get('Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal');
assert.ok(diode.faces.filter(face => face.color.join(',') === '35,38,43')
    .every(face => face.idx.every(i => diode.vertices[i].x > 1)), 'Diode cathode stripe is right');
const capacitor = meshes.get('Capacitor_THT:CP_Radial_D5.0mm_P2.50mm');
assert.ok(capacitor.faces.filter(face => face.color.join(',') === '216,218,205')
    .every(face => face.idx.every(i => capacitor.vertices[i].x > 1)), 'Capacitor negative stripe is right');
const led = meshes.get('LED_THT:LED_D5.0mm');
assert.ok(led.faces.filter(face => face.color.join(',') === '216,218,205')
    .every(face => face.idx.every(i => led.vertices[i].x > 2)), 'LED cathode indicator is right');
assert.ok(new Set(led.vertices.map(vertex => vertex.z)).size >= 6,
    'LED has a multi-level dome');
for (const invalid of ['', 'missing', 'toString', '__proto__', null, undefined]) {
    assert.throws(() => getBuiltInModel3D(invalid), /Unsupported built-in 3D footprint/);
}
// A fresh module instance regenerates byte-identical geometry without browser state.
const fresh = await import('../src/components/BuiltInModels3D.js?determinism');
for (const [footprint] of cases) assert.equal(fresh.getBuiltInModel3D(footprint), getBuiltInModel3D(footprint));
console.log('PASS deterministic procedural models, materials, orientation, closed solids and pad alignment');
