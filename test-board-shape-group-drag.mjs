/** Headless regression tests for board-shape group-drag geometry snapshots. */

globalThis.window = { addEventListener() {} };

const {
    applyShapeGeometry,
    boardShapeSegmentWidth,
    cloneShapeGeometry,
    resolveBoardShapeGeometry,
    serializeBoardShapes,
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
    viewport: { scale: 100, setCrosshair() {} },
};
startBoardShapeDrag(dragApp, additiveShape, { x: 5, y: 5 });
expect('additive copper drag defers derived overlays', dragApp._deferDragOverlays, true);
expect('additive copper drag restricts ratsnest to its net',
    [...dragApp._shapeDrag.ratsnestNets], ['GND']);

const removalShape = { ...additiveShape, id: 'removal', copperMode: 'remove-copper' };
startBoardShapeDrag(dragApp, removalShape, { x: 5, y: 5 });
expect('removal copper drag skips ratsnest reconciliation', dragApp._shapeDrag.ratsnestNets, null);

for (const shape of [
    { id: 'line-select', kind: 'line', layer: 'top-silk', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { id: 'rect-select', kind: 'rect', layer: 'top-silk', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] },
    { id: 'polygon-select', kind: 'polygon', layer: 'top-silk', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }] },
]) {
    dragApp.boardShapes = [shape];
    startBoardShapeDrag(dragApp, shape, { x: 5, y: 0 });
    expect(`${shape.kind} first-click drag moves the whole shape`, dragApp._shapeDrag.mode, 'move');
    startBoardShapeDrag(dragApp, shape, { x: 5, y: 0 }, null, { allowSegment: true });
    expect(`${shape.kind} second-click drag selects its segment`, dragApp._shapeDrag.mode, 'segment');
    expect(`${shape.kind} stores the refined segment`, dragApp._selectedBoardShapeSegment,
        { shapeId: shape.id, segment: 0 });
}

{
    const shape = {
        id: 'segment-width', kind: 'polygon', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }],
        segmentWidths: { 1: 0.7 },
    };
    expect('PCB selected segment width leaves other segments unchanged',
        [boardShapeSegmentWidth(shape, 0), boardShapeSegmentWidth(shape, 1), boardShapeSegmentWidth(shape, 2)],
        [0.2, 0.7, 0.2]);
    expect('PCB geometry exposes per-segment manufacturing widths',
        resolveBoardShapeGeometry(shape).strokeSegments.map((segment) => segment.lineWidth),
        [0.2, 0.7, 0.2]);
    expect('PCB segment widths are serialized',
        serializeBoardShapes({ boardShapes: [shape] })[0].segmentWidths,
        { 1: 0.7 });
}

{
    const shape = {
        id: 'insert-before-width', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
        segmentWidths: { 1: 0.7 },
    };
    startBoardShapeDrag(dragApp, shape, { x: 5, y: 0 }, 'mid:0');
    expect('midpoint insertion keeps a later width on the same physical segment',
        [boardShapeSegmentWidth(shape, 0), boardShapeSegmentWidth(shape, 1), boardShapeSegmentWidth(shape, 2)],
        [0.2, 0.2, 0.7]);
}

{
    const shape = {
        id: 'split-width', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
        segmentWidths: { 1: 0.7 },
    };
    startBoardShapeDrag(dragApp, shape, { x: 15, y: 0 }, 'mid:1');
    expect('splitting an overridden segment gives both halves its width',
        [boardShapeSegmentWidth(shape, 0), boardShapeSegmentWidth(shape, 1), boardShapeSegmentWidth(shape, 2)],
        [0.2, 0.7, 0.7]);
}

if (failures) process.exitCode = 1;