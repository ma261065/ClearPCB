import assert from 'node:assert/strict';
import {
    prepareCopperRegionContact, validateCopperRegionContact, installCopperRegionContact,
    copperRegionShape, resolveTrackContactGeometry, copperContactsTouch,
} from '../src/pcb/modules/track-contact-geometry.js';

const ring = (radius, count, x = 0) => Array.from({ length: count }, (_, index) => ({
    x: x + radius * Math.cos(index * 2 * Math.PI / count), y: radius * Math.sin(index * 2 * Math.PI / count),
}));
const source = { outer: ring(10, 512), holes: [ring(8, 256)] };
const cold = resolveTrackContactGeometry(copperRegionShape(source));
const prepared = structuredClone(prepareCopperRegionContact(source));
const region = prepared.region;
validateCopperRegionContact(region, prepared);
installCopperRegionContact(region, prepared);
const shape = copperRegionShape(region), contact = resolveTrackContactGeometry(shape);
assert.equal(Object.isFrozen(shape), true, 'Only the derived immutable wrapper is frozen');
assert.equal(Object.isFrozen(region), false, 'Registration does not mutate or freeze supplied geometry');
assert.deepEqual(contact.bounds, cold.bounds);
assert.equal(contact.geometry.centerline, region.outer);
assert.equal(contact.geometry.areaOutline, region.outer);
for (let x = -12; x <= 12; x += 2) for (let y = -12; y <= 12; y += 2) {
    for (const object of [
        { kind: 'circle', x, y, radius: 0.2, filled: true, lineWidth: 0.001 },
        { kind: 'line', points: [{ x, y }, { x: x + 2.1, y: y + 0.1 }], lineWidth: 0.0001 },
    ]) {
        const probe = resolveTrackContactGeometry(object);
        assert.equal(copperContactsTouch(contact, probe), copperContactsTouch(cold, probe));
        assert.equal(copperContactsTouch(probe, contact), copperContactsTouch(probe, cold));
    }
}
for (const radius of [1, 7.7, 8, 9, 10, 12]) {
    const other = resolveTrackContactGeometry(copperRegionShape({ outer: ring(radius, 32), holes: [] }));
    assert.equal(copperContactsTouch(contact, other), copperContactsTouch(cold, other),
        'Region/region contacts, holes and touching boundaries retain exact semantics');
}

const clone = globalThis.structuredClone, every = Array.prototype.every;
let snapshots = 0, contourChecks = 0;
try {
    globalThis.structuredClone = value => { snapshots++; return clone(value); };
    Array.prototype.every = function (...args) {
        if (this === region.outer) contourChecks++;
        return every.apply(this, args);
    };
    for (let index = 0; index < 1000; index++) {
        assert.equal(resolveTrackContactGeometry(copperRegionShape(region)), contact);
    }
    assert.equal(snapshots, 0, 'Known immutable contacts take no authored-state snapshots');
    assert.equal(contourChecks, 0, 'Known immutable regions bypass per-pass contour normalization/validation');
    const authored = { ...shape, points: region.outer.map(point => ({ ...point })), preparedContact: prepared };
    const first = resolveTrackContactGeometry(authored);
    assert.equal(snapshots, 1, 'Unrelated metadata cannot bypass authored-shape validation');
    authored.points[0].x += 100;
    const second = resolveTrackContactGeometry(authored);
    assert.notEqual(first, second);
    assert.equal(snapshots, 2);
    assert.notDeepEqual(first.bounds, second.bounds);
} finally {
    globalThis.structuredClone = clone;
    Array.prototype.every = every;
}

assert.throws(() => installCopperRegionContact(structuredClone(region), prepared), /different region/);
for (const change of [
    entry => { entry.indices = [0, 1, 2]; },
    entry => { entry.indices = new Uint32Array([0, 1]); },
    entry => { entry.indices[0] = 1000000; },
    entry => { entry.bounds[0] = NaN; },
    entry => { entry.triangleBounds[0] = Infinity; },
    entry => { entry.triangleBounds = new Float64Array(0); },
]) {
    const invalid = structuredClone(prepared);
    change(invalid);
    assert.throws(() => installCopperRegionContact(invalid.region, invalid), /Invalid prepared/);
}
const replacement = { outer: ring(1, 32), holes: [] };
const newContact = resolveTrackContactGeometry(copperRegionShape(replacement));
assert.notEqual(newContact, contact);
assert.equal(newContact.bounds.maxX, 1, 'Replacement results cannot reuse another region identity');
const lazy = { outer: ring(2, 32), holes: [ring(1, 16)] };
const lazyContact = resolveTrackContactGeometry(copperRegionShape(lazy));
assert.equal(copperContactsTouch(lazyContact, resolveTrackContactGeometry({
    kind: 'circle', x: 0, y: 0, radius: 0.1, filled: true,
})), false, 'Unprepared synchronous regions still triangulate lazily and retain holes');
console.log('PASS prepared region contacts: exact narrow phases, zero immutable snapshots/scans, mutable validation and identity rejection');
