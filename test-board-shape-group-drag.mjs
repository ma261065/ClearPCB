/** Headless regression tests for board-shape group-drag geometry snapshots. */

globalThis.window = { addEventListener() {} };

const {
    applyShapeGeometry,
    cloneShapeGeometry,
    startBoardShapeDrag,
    translateShapeGeometry,
} = await import('./src/pcb/modules/board-shapes.js');

let failures = 0;

function expect(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    if (pass) console.log(`PASS: ${name}`);
    else {
        failures++;
        console.error(`FAIL: ${name}`);
    }
}

const cases = [
    {
        name: 'Line',
        shape: { kind: 'line', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
        expected: { points: [{ x: 6, y: -1 }, { x: 8, y: 1 }] },
    },
    {
        name: 'Rectangle',
        shape: { kind: 'rect', points: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }] },
        expected: { points: [{ x: 6, y: -1 }, { x: 8, y: -1 }, { x: 8, y: 1 }, { x: 6, y: 1 }] },
    },
    {
        name: 'Polygon',
        shape: { kind: 'polygon', points: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 4 }] },
        expected: { points: [{ x: 6, y: -1 }, { x: 8, y: -1 }, { x: 7, y: 1 }] },
    },
    {
        name: 'Circle',
        shape: { kind: 'circle', x: 1, y: 2, radius: 3 },
        expected: { x: 6, y: -1, radius: 3 },
    },
    {
        name: 'Arc',
        shape: { kind: 'arc', start: { x: 1, y: 2 }, end: { x: 3, y: 2 }, bulge: { x: 2, y: 4 } },
        expected: { start: { x: 6, y: -1 }, end: { x: 8, y: -1 }, bulge: { x: 7, y: 1 } },
    },
];

for (const test of cases) {
    const snapshot = cloneShapeGeometry(test.shape);
    const translated = translateShapeGeometry(snapshot, 5, -3);
    expect(`${test.name} snapshot translates`, translated, test.expected);
    applyShapeGeometry(test.shape, translated);
    expect(`${test.name} shape applies translated geometry`, cloneShapeGeometry(test.shape), test.expected);
}

const additiveShape = {
    id: 'additive', kind: 'rect', layer: 'bottom-copper', copperMode: 'add', net: 'GND',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
};
const dragApp = {
    _deferDragOverlays: false,
    viewport: { scale: 1, setCrosshair() {} },
};
startBoardShapeDrag(dragApp, additiveShape, { x: 5, y: 5 });
expect('additive copper drag defers derived overlays', dragApp._deferDragOverlays, true);
expect('additive copper drag restricts ratsnest to its net',
    [...dragApp._shapeDrag.ratsnestNets], ['GND']);

const removalShape = { ...additiveShape, id: 'removal', copperMode: 'remove-copper' };
startBoardShapeDrag(dragApp, removalShape, { x: 5, y: 5 });
expect('removal copper drag skips ratsnest reconciliation', dragApp._shapeDrag.ratsnestNets, null);

if (failures) process.exitCode = 1;