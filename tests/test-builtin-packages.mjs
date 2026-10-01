import assert from 'node:assert/strict';
import { BuiltInComponents } from '../src/components/BuiltInComponents.js';
import { getBuiltInPackageOptions, withBuiltInPackage } from '../src/components/BuiltInPackages.js';
import { getBuiltInModel3D } from '../src/components/BuiltInModels3D.js';
import { generateFootprint } from '../src/pcb/modules/footprint.js';
import { parseObjModel } from '../src/shared/3d/model-rendering.js';

const canonical = new Map(BuiltInComponents.map(definition => [definition.name, definition]));
const before = JSON.stringify(BuiltInComponents);
const expectedCounts = {
    Resistor: 8, Resistor_IEC: 8, Capacitor: 8, Capacitor_Polarized: 4, Inductor: 5,
    Diode: 5, LED: 5, NPN: 3, PNP: 3, NMOS: 3, PMOS: 3,
    OpAmp: 3, IC_DIP8: 3, Conn_01x02: 3, SW_Push: 2,
};
assert.deepEqual([...canonical.keys()].sort(), Object.keys(expectedCounts).sort(), 'All built-in types have choices');
const pointInTriangle = (vertices, x, y) => {
    const sides = vertices.map((a, i) => {
        const b = vertices[(i + 1) % 3];
        return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    });
    return sides.every(side => side >= -1e-8) || sides.every(side => side <= 1e-8);
};
const expectedLabels = (name, id, original) => {
    if (id === 'default') return original.footprintShapes.filter(shape => shape.startsWith('PAD~'))
        .map(shape => shape.split('~')[6]);
    if (name === 'NPN') return id === 'to92' ? ['B', 'C', 'E'] : ['B', 'E', 'C'];
    if (name === 'PNP') return ['B', 'E', 'C'];
    if (name === 'NMOS' || name === 'PMOS') return id === 'to92' ? ['G', 'D', 'S'] : ['G', 'S', 'D'];
    if (name === 'OpAmp') return ['+', '-', 'OUT', '4', '5', '6', '7', '8'];
    if (name === 'IC_DIP8') return ['1', '2', '3', '4', '5', '6', '7', '8'];
    if (name === 'SW_Push') return ['1', '2', '1', '2'];
    if (name === 'Capacitor_Polarized') return ['+', '-'];
    if (name === 'Diode' || name === 'LED') return ['A', 'K'];
    return ['1', '2'];
};
let checked = 0;
const modelIds = new Set();
for (const [name, original] of canonical) {
    const input = { ...original, _source: 'Built-in', custom: { retained: true } };
    const options = getBuiltInPackageOptions(input);
    assert.deepEqual(getBuiltInPackageOptions({ name, _source: 'Built-in' }), options,
        `${name}: options depend on canonical identity, not input geometry`);
    assert.equal(options.length, expectedCounts[name], `${name}: bounded catalogue`);
    assert.equal(options[0].value, 'default');
    assert.equal(new Set(options.map(option => option.value)).size, options.length);
    for (const option of options) {
        assert.equal(typeof option.label, 'string');
        const result = withBuiltInPackage(input, option.value);
        assert.notEqual(result, input);
        assert.notEqual(result.symbol, input.symbol);
        assert.deepEqual(result.symbol, input.symbol, `${name}: symbol retained`);
        assert.equal(result.name, name);
        assert.equal(result._source, 'Built-in');
        assert.equal(result.packageId, option.value);
        assert.equal(result.hasFootprint, true);
        assert.equal(result.has3d, true);
        assert.equal(result.model3dUrl, null, 'No network source');
        assert.equal(typeof Object.getOwnPropertyDescriptor(result, 'model3dObj').get, 'function', 'Lazy OBJ getter');
        assert.equal(result.model3dObj, getBuiltInModel3D(result.footprint));
        assert.equal(result.model3dName, result.footprintName);
        modelIds.add(result.footprint);
        if (option.value === 'default') {
            assert.equal(result.footprint, original.footprint, 'Canonical last duplicate wins');
            assert.deepEqual(result.footprintShapes, original.footprintShapes);
            assert.deepEqual(result.footprintBBox, original.footprintBBox);
            assert.notEqual(result.footprintShapes, original.footprintShapes);
            assert.notEqual(result.footprintBBox, original.footprintBBox);
        }
        const fp = generateFootprint(result.footprintName, result.symbol.pins,
            result.footprintShapes, result.footprintBBox, result._source);
        assert.deepEqual(fp.pads.map(pad => pad.number), expectedLabels(name, option.value, original),
            `${name}/${option.value}: semantic pad identifiers and duplicates`);
        const th = option.value === 'default' ? name !== 'PMOS'
            : ['to92', 'do41', 'th-3mm', 'terminal-5.08'].includes(option.value);
        for (const pad of fp.pads) {
            assert.equal(pad.layer, th ? 'both' : 'top', `${name}/${option.value}: copper layer`);
            assert.equal(pad.mask, true);
            assert.equal(pad.paste, !th);
            assert.ok(th ? pad.drill > 0 : pad.drill === 0, `${name}/${option.value}: drill`);
            if (th) assert.equal(pad.drill, name === 'Conn_01x02' && option.value === 'default' ? 1 : 0.8);
            assert.ok(pad.drill < Math.min(pad.width, pad.height), 'Annular ring or SMT pad');
            assert.ok([pad.x, pad.y, pad.width, pad.height].every(Number.isFinite));
        }
        const mesh = parseObjModel(result.model3dObj);
        assert.ok(mesh.vertices.length < 800 && mesh.faces.length < 1200);
        assert.ok(mesh.vertices.every(vertex => Object.values(vertex).every(Number.isFinite)));
        assert.equal(mesh.source, 'builtin');
        const bounds = ['x', 'y', 'z'].map(axis => [
            Math.min(...mesh.vertices.map(vertex => vertex[axis])),
            Math.max(...mesh.vertices.map(vertex => vertex[axis])),
        ]);
        assert.equal(bounds[2][0], th ? -2.1 : 0);
        assert.ok(Math.abs(bounds[0][0] + bounds[0][1]) < 1e-6);
        assert.ok(Math.abs(bounds[1][0] + bounds[1][1]) < 1e-6);
        for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
            const min = Math.min(...fp.pads.map(pad => pad[axis] - pad[size] / 2));
            const max = Math.max(...fp.pads.map(pad => pad[axis] + pad[size] / 2));
            assert.ok(Math.abs(min + max) < 1e-6, 'Real footprint parser centres the copper bbox');
        }
        const contacts = mesh.faces.filter(face =>
            face.idx.every(i => mesh.vertices[i].z === bounds[2][0])
            && ['180,188,198', '211,166,57'].includes(face.color.join(',')));
        for (const pad of fp.pads) {
            assert.ok(contacts.some(face =>
                pointInTriangle(face.idx.map(i => mesh.vertices[i]), pad.x, -pad.y)),
            `${name}/${option.value}: metallic contact at ${pad.number} (${pad.x},${pad.y})`);
        }
        if (th) {
            for (const face of contacts) {
                assert.ok(fp.pads.some(pad => face.idx.every(i => {
                    const vertex = mesh.vertices[i];
                    return Math.hypot(vertex.x - pad.x, vertex.y + pad.y) <= pad.drill / 2 + 1e-6;
                })), `${name}/${option.value}: complete lead cross-section fits its plated hole`);
            }
        }
        assert.ok(new Set(mesh.faces.map(face => face.color.join(','))).size >= 2);
        for (const face of mesh.faces) {
            assert.ok(face.idx.every(i => Number.isInteger(i) && mesh.vertices[i]));
            const [a, b, c] = face.idx.map(i => mesh.vertices[i]);
            const cross = [
                (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y),
                (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z),
                (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x),
            ];
            assert.ok(Math.hypot(...cross) > 1e-8);
        }
        result.symbol.pins[0].name = 'changed in clone';
        result.footprintShapes[0] = 'changed in clone';
        result.custom.retained = false;
        assert.equal(input.custom.retained, true);
        assert.deepEqual(input.symbol, original.symbol);
        const restored = withBuiltInPackage(result, 'default');
        assert.equal(restored.footprint, original.footprint);
        assert.deepEqual(restored.footprintShapes, original.footprintShapes);
        checked++;
    }
    options[0].label = 'mutated';
    options.push({ value: 'invented', label: 'invented' });
    assert.equal(getBuiltInPackageOptions(input).length, expectedCounts[name]);
    assert.notEqual(getBuiltInPackageOptions(input)[0].label, 'mutated');
    for (const invalid of ['', 'unknown', '__proto__', null, undefined, 42]) {
        assert.throws(() => withBuiltInPackage(input, invalid), /Unsupported built-in package/);
    }
    const stale = {
        ...input, footprintRotation: 90, footprintShapes: [], hasFootprint: false,
        model3dUrl: 'https://invalid.example/model', model3dRotation: [0, 0, 90],
        model3dName: 'old', has3d: false,
        get model3dObj() { throw new Error('Old model must never be evaluated'); },
    };
    const clean = withBuiltInPackage(stale, options[1].value);
    assert.equal('footprintRotation' in clean, false);
    assert.equal('model3dRotation' in clean, false);
    assert.equal(clean.model3dUrl, null);
    assert.ok(clean.model3dObj);
    console.log(`PASS ${name}: ${expectedCounts[name]} package options`);
}
for (const input of [null, undefined, {}, { name: 'Resistor' }, { _source: 'KiCad', name: 'Resistor' },
    { _source: 'Built-in', name: 'unknown' }, { _source: 'Built-in', name: '__proto__' }]) {
    assert.deepEqual(getBuiltInPackageOptions(input), []);
    assert.throws(() => withBuiltInPackage(input, 'default'), /Unsupported built-in component/);
}
assert.equal(JSON.stringify(BuiltInComponents), before, 'Library definitions were not mutated');
assert.equal(checked, 66);
assert.equal(modelIds.size, 45);
console.log(`PASS ${checked} package selections, ${modelIds.size} models, semantic pins, real pad generation and cloning`);
