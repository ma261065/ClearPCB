import assert from 'node:assert/strict';

globalThis.localStorage = {
    length: 0,
    key: () => null,
    getItem: () => null,
    removeItem: () => {},
};

const { ComponentLibrary } = await import('../../src/components/ComponentLibrary.js');
const library = new ComponentLibrary();
library.kicadFetcher = {
    async fetchSymbol() {
        return {
            name: 'NE555D',
            properties: {
                Value: 'NE555D',
                Footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm',
            },
            symbol: {
                graphics: [],
                pins: [{ number: '1', name: 'GND', x: 0, y: 0, orientation: 'right', length: 2.54 }],
            },
        };
    },
    async fetchFootprintPreview() {
        return {
            shapes: ['PAD~1~RECT~0~0~1~2~0~~1~0~0~0~0~0'],
            bbox: { x: -2, y: -3, width: 4, height: 6 },
        };
    },
    async checkFootprintAvailability() {
        return { hasFootprint: true, has3d: true, modelUrl: 'https://example.test/ne555.step' };
    },
};

const definition = await library.fetchFromKiCad('Timer', 'NE555D');
assert.equal(definition._source, 'KiCad');
assert.equal(definition.name, 'KiCad_Timer_NE555D');
assert.equal(definition.defaultValue, 'NE555D');
assert.equal(definition.footprintName, 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
assert.equal(definition.footprintShapes.length, 1);
assert.deepEqual(definition.footprintBBox, { x: -2, y: -3, width: 4, height: 6 });
assert.equal(definition.model3dUrl, 'https://example.test/ne555.step');
assert.equal(library.getDefinition(definition.name), definition);

console.log('PASS: component library resolves a complete placeable KiCad definition');
