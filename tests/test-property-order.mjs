import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROPERTY_ORDER, propertyRank, sortByPropertyOrder } from '../src/shared/ui/property-order.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null, createElement: () => ({ style: {}, dataset: {} }) };
const { mergeDescriptors } = await import('../src/schematic/modules/properties.js');
const { Circle } = await import('../src/shapes/circle.js');
const { Arc } = await import('../src/shapes/arc.js');
const { createRect, createLine, createPolygon } = await import('../src/shapes/polyline.js');
const { Text } = await import('../src/shapes/text.js');
const { Net } = await import('../src/shapes/net.js');
const { Wire } = await import('../src/shapes/wire.js');
const { NoConnect } = await import('../src/shapes/noconnect.js');

assert.equal(new Set(PROPERTY_ORDER).size, PROPERTY_ORDER.length, 'each property has one place');
assert.ok(Object.isFrozen(PROPERTY_ORDER));
for (const [before, after] of [['locked', 'reference'], ['reference', 'layer'], ['layer', 'copperMode'], ['copperMode', 'net'],
    ['net', 'fill'], ['fill', 'plated'], ['plated', 'width'], ['size', 'drill'], ['diameter', 'drill'], ['drill', 'lineWidth'],
    ['lineWidth', 'outerDiameter'], ['outerDiameter', 'cornerRadius'], ['cornerRadius', 'bulge'], ['bulge', 'rotation'],
    ['rotation', 'flipHorizontal'], ['flipVertical', 'border'], ['border', 'invert']]) {
    assert.ok(propertyRank(before) < propertyRank(after), `${before} comes before ${after}`);
}
assert.equal(propertyRank('unknown'), PROPERTY_ORDER.length, 'unknown keys sort last');
assert.deepEqual(sortByPropertyOrder(['b-unknown', 'net', 'a-unknown', 'locked', 'layer'], key => key),
    ['locked', 'layer', 'net', 'b-unknown', 'a-unknown'], 'sorting is stable and puts unknown keys last');

// Every key a panel uses must be ranked, or it would silently drift to the end.
const sources = ['src/ui/PCBApp.js', 'src/pcb/modules/board-shape-properties.js', 'src/pcb/modules/component-properties.js',
    'src/pcb/modules/copper-fill-edit.js', 'src/pcb/modules/track-select.js', 'src/schematic/modules/properties.js']
    .map(path => [path, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')]);
const ranked = key => PROPERTY_ORDER.includes(key);
for (const [path, source] of sources) {
    for (const [, key] of source.matchAll(/data-prop="(\w+)"/g)) assert.ok(ranked(key), `${path} row key ${key} is in PROPERTY_ORDER`);
    for (const [, key] of source.matchAll(/dataset\.prop = '(\w+)'/g)) assert.ok(ranked(key), `${path} row key ${key} is in PROPERTY_ORDER`);
    for (const [tag] of source.matchAll(/<(?:div|label)[^>]*class="prop-row[^"]*"[^>]*>/g)) {
        assert.match(tag, /data-prop=/, `${path} property row is tagged: ${tag.slice(0, 80)}`);
    }
}
const pcbApp = sources.find(([path]) => path === 'src/ui/PCBApp.js')[1];
for (const [, key] of pcbApp.matchAll(/capabilities\.(\w+)\s*=/g)) assert.ok(ranked(key), `multi-selection key ${key} is ranked`);

const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] });
const field = new Text({ x: 0, y: 0, text: 'R1' });
field.fieldKey = 'reference';
const schematicShapes = [new Circle({ x: 0, y: 0, radius: 2 }),
    new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 4, y: 0 }, bulgePoint: { x: 2, y: 1 } }),
    createRect({ x: 0, y: 0, width: 4, height: 2 }), createLine([{ x: 0, y: 0 }, { x: 4, y: 0 }]),
    createPolygon([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }]), new Text({ x: 0, y: 0, text: 'T' }), field,
    new Net({ x: 0, y: 0, net: 'GND' }), wire, new NoConnect({ x: 0, y: 0 })];
for (const shape of schematicShapes) {
    for (const descriptor of shape.getPropertyDescriptors()) {
        assert.ok(ranked(descriptor.orderKey || descriptor.key), `${shape.type} property ${descriptor.key} is ranked`);
    }
    const keys = mergeDescriptors([shape]).map(descriptor => descriptor.orderKey || descriptor.key);
    assert.deepEqual(keys, sortByPropertyOrder([...keys], key => key), `${shape.type} properties are in canonical order`);
}
const componentSource = readFileSync(new URL('../src/components/Component.js', import.meta.url), 'utf8');
const componentDescriptors = componentSource.slice(componentSource.indexOf('getPropertyDescriptors() {'));
for (const [, key] of componentDescriptors.slice(0, componentDescriptors.indexOf('\n    }\n')).matchAll(/key: '(\w+)'/g)) {
    assert.ok(ranked(key), `component property ${key} is ranked`);
}

assert.deepEqual(mergeDescriptors([new Circle({ x: 0, y: 0, radius: 2 })]).map(descriptor => descriptor.key),
    ['locked', 'fill', 'lineWidth', 'diameter'], 'a circle lists Fill, then Line width, then its outer Diameter');
assert.deepEqual(mergeDescriptors([new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 4, y: 0 }, bulgePoint: { x: 2, y: 1 } }),
    createLine([{ x: 0, y: 0 }, { x: 4, y: 0 }])]).map(descriptor => descriptor.key), ['locked', 'lineWidth'],
    'a mixed selection keeps the shared properties in canonical order');

console.log('PASS one canonical Properties order: every panel key is ranked, rows are tagged and schematic descriptors are sorted');
