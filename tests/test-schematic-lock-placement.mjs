import assert from 'node:assert/strict';
import { Polyline } from '../src/shapes/polyline.js';
import { Wire } from '../src/shapes/wire.js';
import { Circle } from '../src/shapes/circle.js';
import { lockIconMetrics } from '../src/core/ui-helpers.js';
import { schematicLockPosition } from '../src/schematic/render/lock-placement.js';
import { lockNoun } from '../src/schematic/modules/locks.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

// A lock icon's world box, from its top-left position.
const scale = 10;
const { bounds } = lockIconMetrics(scale);
const box = position => ({
    minX: position.x + bounds.minX, maxX: position.x + bounds.maxX,
    minY: position.y + bounds.minY, maxY: position.y + bounds.maxY,
});

// A closed rectangle pressed just inside its top edge (grid snapping does this) still gets
// its lock outside, above that edge, not over the shape.
{
    const rect = new Polyline({ points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
        closed: true, isRect: true, lineWidth: 0.2 });
    const lock = box(schematicLockPosition(rect, { x: 10, y: 0.3 }, scale));
    assert.ok(lock.maxY <= -0.1, 'Lock clears the top edge and its stroke');
    assert.ok(lock.minX > 5 && lock.maxX < 15, 'Lock sits beside the pressed part of the edge');
    const side = box(schematicLockPosition(rect, { x: 19.8, y: 5 }, scale));
    assert.ok(side.minX >= 20.1, 'A press near the right edge puts the lock to its right');
}

// An open wire puts the lock on the side of the line the press came from.
{
    const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const below = box(schematicLockPosition(wire, { x: 5, y: 0.5 }, scale));
    assert.ok(below.minY > 0, 'Pressed below the wire, the lock goes below it');
    const above = box(schematicLockPosition(wire, { x: 5, y: -0.5 }, scale));
    assert.ok(above.maxY < 0, 'Pressed above the wire, the lock goes above it');
}

// A circle pressed inside keeps its lock outside the circle.
{
    const circle = new Circle({ x: 0, y: 0, radius: 5 });
    const lock = box(schematicLockPosition(circle, { x: 4.8, y: 0 }, scale));
    assert.ok(lock.minX >= 5, 'Lock sits outside the circle');
}

// Entities placed by their world bounds (components, text) keep the lock outside those bounds,
// whatever the rotation; without a press it sits beside the top-left corner.
{
    const rotated = { getBounds: () => ({ minX: 10, minY: 10, maxX: 14, maxY: 30 }) };
    const lock = box(schematicLockPosition(rotated, { x: 13.5, y: 20 }, scale));
    assert.ok(lock.minX >= 14, 'Lock sits outside the world bounds');
    const fallback = box(schematicLockPosition(rotated, null, scale));
    assert.ok(fallback.maxX <= 10 && fallback.maxY <= 10, 'Without a press the lock sits outside the top-left corner');
}

assert.equal(lockNoun(new Polyline({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true, isRect: true })), 'rectangle');
assert.equal(lockNoun(new Wire({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] })), 'wire');
assert.equal(lockNoun({ definition: {} }), 'component');
assert.equal(lockNoun({ type: 'net' }), 'net label');

// Owned field texts follow their owner's lock, as a PCB reference designator follows its
// component; detachable labels and free texts keep their own.
{
    const { Text } = await import('../src/shapes/text.js');
    const { lockOwner, isSchematicLocked, hasOwnLock } = await import('../src/shapes/lock-owner.js');
    const component = { definition: {}, locked: false };
    const reference = new Text({ x: 0, y: 0, text: 'R1' });
    reference.parentComponent = component;
    reference.fieldKey = 'reference';
    const label = new Text({ x: 0, y: 0, text: 'NET1' });
    label.parentComponent = { type: 'wire', locked: true };
    label.fieldKey = 'label';
    const free = new Text({ x: 0, y: 0, text: 'Note' });

    assert.equal(lockOwner(reference), component);
    assert.equal(hasOwnLock(reference), false, 'A reference text has no lock of its own');
    assert.equal(isSchematicLocked(reference), false);
    component.locked = true;
    assert.equal(isSchematicLocked(reference), true, 'Locking the component locks its reference text');
    reference.locked = false;
    assert.equal(isSchematicLocked(reference), true, 'The text cannot override its owner');
    assert.equal(hasOwnLock(label), true, 'A detachable label keeps its own lock');
    assert.equal(isSchematicLocked(label), false, 'even when attached to a locked wire');
    assert.equal(hasOwnLock(free), true);

    assert.ok(!reference.getPropertyDescriptors().some(desc => desc.key === 'locked'),
        'An owned field text shows no Locked checkbox');
    assert.ok(label.getPropertyDescriptors().some(desc => desc.key === 'locked'));
    assert.ok(free.getPropertyDescriptors().some(desc => desc.key === 'locked'));
    assert.equal(lockNoun(lockOwner(reference)), 'component', 'Its lock icon offers to unlock the component');

    installFakeDom();
    const { mergeDescriptors } = await import('../src/schematic/modules/properties.js');
    const keys = mergeDescriptors([reference, free]).map(desc => desc.key);
    assert.ok(keys.includes('locked'), 'A mixed selection still offers the Locked checkbox');
    assert.equal(keys[0], 'locked', 'Locked stays first');
}

console.log('PASS schematic lock icons sit outside the object beside the press; owned texts follow their owner; unlock nouns');
