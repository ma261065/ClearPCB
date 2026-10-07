import assert from 'node:assert/strict';
import { applyRefGeometry } from '../../src/shared/pcb/footprint.js';
import { layoutReferenceText } from '../../src/shared/pcb/reference-text.js';

class Element {
    attributes = new Map();
    children = [];
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(child) { this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    get firstChild() { return this.children[0] || null; }
}
let created = 0;
globalThis.document = { createElementNS: () => { created++; return new Element(); } };
const group = new Element();
const initial = ['R12', 3, -2.8, 1.2, 0.15];
applyRefGeometry(group, ...initial);
const originalGlyphs = [...group.children];
const firstCreated = created;
for (let index = 0; index < 100; index++) applyRefGeometry(group, ...initial);
assert.equal(created, firstCreated, '100 unchanged reference updates must allocate no new SVG glyphs');
assert.deepEqual(group.children, originalGlyphs);
assert.ok(group.children.every((child, index) => child === originalGlyphs[index]));

function verify(inputs) {
    const layout = layoutReferenceText(...inputs);
    assert.deepEqual(group.children.map(child => child.getAttribute('points')),
        layout.polylines.map(poly => poly.map(p => `${p.x},${p.y}`).join(' ')));
    for (const [name, value] of Object.entries({
        'stroke-width': inputs[4], 'data-mx-center': inputs[1], 'data-ref-anchor-y': inputs[2],
        'data-ref-size': inputs[3], 'data-ref-lw': inputs[4],
        'data-ref-bx': layout.box.bx, 'data-ref-by': layout.box.by,
        'data-ref-bw': layout.box.bw, 'data-ref-bh': layout.box.bh, 'data-ref-cy': layout.box.cy,
    })) assert.equal(group.getAttribute(name), String(value));
}

for (const [field, value] of [[0, 'R13'], [1, 4], [2, -3.8], [3, 1.200000001], [4, 0.150000001],
    [0, ''], [0, '   ']]) {
    const inputs = [...initial];
    inputs[field] = value;
    assert.equal(applyRefGeometry(group, ...inputs), true, 'Every changed layout input rebuilds geometry');
    verify(inputs);
    assert.equal(applyRefGeometry(group, ...inputs), false, 'Empty and nonempty layouts both reuse unchanged geometry');
    assert.equal(applyRefGeometry(group, ...initial), true, 'Returning to previous inputs rebuilds the current group');
    verify(initial);
}
const freshGroup = new Element();
assert.equal(applyRefGeometry(freshGroup, ...initial), true, 'A replacement SVG group must build its own glyphs');
assert.ok(freshGroup.children.length > 0);
assert.ok(freshGroup.children.every(child => !group.children.includes(child)));

for (let index = 0; index < 100; index++) {
    const inputs = [...initial];
    inputs[3] += (index + 1) / 1000;
    assert.equal(applyRefGeometry(group, ...inputs), true, 'Every distinct size preview rebuilds immediately');
    verify(inputs);
}

applyRefGeometry(group, ...initial);
const appendChild = group.appendChild;
group.appendChild = () => { throw new Error('Simulated SVG update failure'); };
assert.throws(() => applyRefGeometry(group, 'R13', ...initial.slice(1)), /Simulated SVG update failure/);
group.appendChild = appendChild;
assert.equal(applyRefGeometry(group, ...initial), true, 'A partial failed rebuild cannot reuse the prior cache entry');
verify(initial);

delete globalThis.document;
console.log('PASS reference SVG geometry reuse, full layout invalidation, replacement groups and failure retry');
