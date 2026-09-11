/** Headless regression tests for board-shape group-drag geometry snapshots. */

globalThis.window = { addEventListener() {} };
globalThis.document = {
    createElementNS() {
        const attributes = new Map();
        return {
            appendChild() {},
            getAttribute(name) { return attributes.get(name) || null; },
            setAttribute(name, value) { attributes.set(name, String(value)); },
        };
    },
};

const {
    applyShapeGeometry,
    boardShapeNodeCornerRadius,
    boardShapeSegmentWidth,
    cloneShapeGeometry,
    createBoardShapeSelectionAdapter,
    endBoardShapeDrag,
    handleBoardShapeDrag,
    resolveBoardShapeGeometry,
    serializeBoardShapes,
    setBoardShapeNodeCornerRadius,
    shapeOutline,
    shapePathD,
    startBoardShapeDrag,
    translateShapeGeometry,
} = await import('../src/pcb/modules/board-shapes.js');
const { updateGroupDrag, endGroupDrag, cancelGroupDrag } = await import('../src/pcb/modules/box-select.js');

let failures = 0;

function expect(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    if (pass) console.log(`PASS: ${name}`);
    else {
        failures++;
        console.error(`FAIL: ${name}`);
    }
}

{
    const text = { id: 'snapped-text', x: 10, y: 20 };
    let redraws = 0;
    const app = {
        placements: new Map(), texts: new Map([[text.id, text]]),
        viewport: { snapToGrid: true, gridSize: 1 },
        _refreshText() { redraws++; },
        _groupDrag: {
            startWorld: { x: 0, y: 0 }, lastDx: 0, lastDy: 0,
            comps: [], vias: [], tracks: [], shapes: [], fills: [],
            texts: [{ text, x: text.x, y: text.y }], ratsnestNets: new Set(),
        },
    };
    updateGroupDrag(app, { x: 0.1, y: 0.2 });
    expect('group drag skips movement inside the starting grid cell', redraws, 0);
    updateGroupDrag(app, { x: 1.1, y: 2.1 });
    expect('group drag renders a changed snapped position', redraws, 1);
    updateGroupDrag(app, { x: 1.2, y: 2.2 });
    expect('group drag does not redraw an unchanged snapped position', redraws, 1);
    updateGroupDrag(app, { x: 2.1, y: 3.1 });
    expect('group drag continues rendering subsequent movement', [redraws, text.x, text.y], [2, 12, 23]);
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
    for (const commit of [true, false]) {
        const shape = { ...structuredClone(test.shape), id: `deferred-${test.name}`, layer: 'top-copper' };
        const before = cloneShapeGeometry(shape);
        const refreshes = [];
        const app = {
            boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
            _deferDragOverlays: false, _shapeElements: new Map(), _layerGroups: new Map(),
            _getLayerGroup() { return null; },
            _snapToGrid(point) { return point; },
            _refreshFills() { refreshes.push(this._deferDragOverlays); },
            viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} },
            history: { execute(command) { command.execute(); } },
        };
        startBoardShapeDrag(app, shape, { x: 1, y: 2 });
        handleBoardShapeDrag(app, { x: 6, y: -1 });
        expect(`${test.name} defers fill refresh while moving`, refreshes, []);
        endBoardShapeDrag(app, commit);
        expect(`${test.name} refreshes after ${commit ? 'completion' : 'cancellation'}`, refreshes, [false]);
        expect(`${test.name} finishes with the expected geometry`, cloneShapeGeometry(shape),
            commit ? translateShapeGeometry(before, 5, -3) : before);

        refreshes.length = 0;
        const groupBefore = cloneShapeGeometry(shape);
        app._groupDrag = {
            startWorld: { x: 0, y: 0 }, previousDeferDragOverlays: false,
            comps: [], tracks: [], vias: [], texts: [], fills: [], ratsnestNets: new Set(),
            shapes: [{ shape, before: groupBefore }],
        };
        app._deferDragOverlays = true;
        updateGroupDrag(app, { x: 3, y: 4 });
        expect(`${test.name} group defers fill refresh while moving`, refreshes, []);
        if (commit) endGroupDrag(app);
        else cancelGroupDrag(app);
        expect(`${test.name} group refreshes after ${commit ? 'completion' : 'cancellation'}`, refreshes, [false]);
        expect(`${test.name} group finishes with expected geometry`, cloneShapeGeometry(shape),
            commit ? translateShapeGeometry(groupBefore, 3, 4) : groupBefore);
    }
}

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
        id: 'rounded-segment-width', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        cornerRadius: 2,
        segmentWidths: { 0: 0.7 },
    };
    const thickSegments = resolveBoardShapeGeometry(shape).strokeSegments
        .filter((segment) => segment.lineWidth === 0.7);
    expect('rounded rectangle keeps the overridden width on its straight edge', thickSegments, [{
        start: { x: 2, y: 0 }, end: { x: 8, y: 0 }, lineWidth: 0.7,
    }]);
}

{
    const shape = {
        id: 'rounded-segment-drag', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        cornerRadius: 2,
    };
    const app = {
        boardShapes: [shape],
        _deferDragOverlays: false,
        _shapeElements: new Map(),
        _getLayerGroup() { return null; },
        _snapToGrid(point) { return point; },
        viewport: { scale: 100, setCrosshair() {} },
    };
    startBoardShapeDrag(app, shape, { x: 5, y: 0 }, null, { allowSegment: true });
    handleBoardShapeDrag(app, { x: 5, y: 2 });
    expect('rounded rectangle segment drag preserves its geometry type and radius', {
        kind: shape.kind,
        cornerRadius: shape.cornerRadius,
        points: shape.points,
    }, {
        kind: 'rect',
        cornerRadius: 2,
        points: [{ x: 0, y: 2 }, { x: 10, y: 2 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    });
}

{
    const shape = {
        id: 'rounded-polygon', kind: 'polygon', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 8, y: 8 }, { x: 1, y: 10 }],
        cornerRadius: 2,
    };
    expect('polygon radius rounds every rendered corner',
        (shapePathD(shape).match(/ Q /g) || []).length, shape.points.length);
    expect('polygon radius is sampled into resolved geometry',
        shapeOutline(shape).length > shape.points.length, true);
    expect('polygon radius is serialized',
        serializeBoardShapes({ boardShapes: [shape] })[0].cornerRadius, 2);
}

{
    const shape = {
        id: 'single-rounded-node', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        cornerRadius: 0,
    };
    setBoardShapeNodeCornerRadius(shape, 1, 2);
    expect('PCB node radius changes only the selected node',
        shape.points.map((_, index) => boardShapeNodeCornerRadius(shape, index)), [0, 2, 0, 0]);
    expect('PCB node radius rounds only one rendered corner',
        (shapePathD(shape).match(/ Q /g) || []).length, 1);
    expect('PCB node radius is serialized by vertex index',
        serializeBoardShapes({ boardShapes: [shape] })[0].nodeCornerRadii, { 1: 2 });
}

{
    const shape = {
        id: 'floating-node-properties', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        cornerRadius: 0,
    };
    const app = {
        boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _deferDragOverlays: false,
        _shapeElements: new Map(),
        _getLayerGroup() { return null; },
        _snapToGrid(point) { return point; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} },
    };
    const adapter = createBoardShapeSelectionAdapter(app, shape, `shape:${shape.id}`);
    adapter.beginAnchorDrag(0, shape.points[0]);
    const result = adapter.endAnchorDrag(true, { moved: false });
    expect('PCB Node properties preserve click-release floating movement', {
        floating: result?.floating,
        selectedNode: app._selectedBoardShapeNode,
        dragActive: !!app._shapeDrag,
    }, {
        floating: true,
        selectedNode: { shapeId: shape.id, index: 0 },
        dragActive: true,
    });
    adapter.endAnchorDrag(false, { moved: true });
}

{
    const shape = {
        id: 'rounded-skew-drag', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        cornerRadius: 2,
    };
    const app = {
        boardShapes: [shape],
        _deferDragOverlays: false,
        _shapeElements: new Map(),
        _getLayerGroup() { return null; },
        _snapToGrid(point) { return point; },
        viewport: { scale: 100, setCrosshair() {} },
    };
    startBoardShapeDrag(app, shape, { x: 5, y: 0 }, null, { allowSegment: true });
    handleBoardShapeDrag(app, { x: 6, y: 2 });
    expect('skewed rounded rectangle becomes a rounded polygon', {
        kind: shape.kind,
        cornerRadius: shape.cornerRadius,
        roundedCorners: (shapePathD(shape).match(/ Q /g) || []).length,
    }, { kind: 'polygon', cornerRadius: 2, roundedCorners: 4 });
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