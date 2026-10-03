/** Headless regression tests for board-shape group-drag geometry snapshots. */
import { PcbDocument } from '../src/core/PcbDocument.js';
import { areDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus } from '../src/pcb/modules/board-shape-state.js';

globalThis.window = { addEventListener() {} };
const timers = new Map();
let timerId = 0;
globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
const flushTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
};
globalThis.document = {
    getElementById() { return null; },
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
    cloneShapeGeometry,
    createBoardShapeSelectionAdapter,
    endBoardShapeDrag,
    handleBoardShapeDrag,
    openBoardShape,
    deleteBoardShapeVertex,
    deleteBoardShapeSegment,
    setBoardShapeSegmentType,
    serializeBoardShapes,
    setBoardShapeNodeCornerRadius,
    startBoardShapeDrag,
    translateShapeGeometry,
    getBoardShapePointerPreview,
} = await import('../src/pcb/modules/board-shapes.js');
const { boardShapeNodeCornerRadius, boardShapeSegmentBulge, boardShapeSegmentWidth,
    resolveBoardShapeGeometry, shapeOutline, shapePathD } = await import('../src/shared/pcb/board-shape-geometry.js');
const { beginGroupDrag, updateGroupDrag, endGroupDrag, cancelGroupDrag, getGroupPreview } = await import('../src/pcb/modules/box-select.js');
const { getTextPosePreviewTexts } = await import('../src/pcb/modules/text-commands.js');
const { setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { updateSelectionInteraction, finishSelectionInteraction, placeFloatingSelectionInteraction } =
    await import('../src/pcb/modules/selection-interaction.js');

let failures = 0;

function expect(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    if (pass) console.log(`PASS: ${name}`);
    else {
        failures++;
        console.error(`FAIL: ${name}`);
        console.error(JSON.stringify({ actual, expected }));
    }
}

{
    const text = { id: 'snapped-text', x: 10, y: 20 };
    const pcbDocument = new PcbDocument();
    pcbDocument.texts.set(text.id, text);
    let redraws = 0;
    const app = {
        pcbDocument, placements: new Map(),
        get texts() { return getTextPosePreviewTexts(this) || this.pcbDocument.texts; },
        viewport: { snapToGrid: true, gridVisible: true, gridSize: 1 },
        refreshText() { redraws++; },
    };
    setPcbSelection(app, [{ kind: 'text', object: text }]);
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 0.1, y: 0.2 });
    expect('group drag skips movement inside the starting grid magnet', redraws, 0);
    updateGroupDrag(app, { x: 1.1, y: 2.1 });
    expect('group drag renders a changed snapped position', redraws, 1);
    updateGroupDrag(app, { x: 1.2, y: 2.2 });
    expect('group drag does not redraw an unchanged snapped position', redraws, 1);
    updateGroupDrag(app, { x: 2.1, y: 3.1 });
    expect('group drag continues rendering subsequent movement', [redraws, app.texts.get(text.id).x, app.texts.get(text.id).y], [2, 12, 23]);
    expect('group preview preserves canonical text', [text.x, text.y], [10, 20]);
    cancelGroupDrag(app);
}

const cases = [
    {
        name: 'Line',
        // A copper cut-out line: an additive copper line would be a Track.
        shape: { kind: 'line', copperMode: 'remove-copper', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
        expected: { points: [{ x: 6, y: -1 }, { x: 8, y: 1 }] },
    },
    {
        name: 'Rectangle',
        shape: { kind: 'rect', filled: true, points: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }] },
        expected: { points: [{ x: 6, y: -1 }, { x: 8, y: -1 }, { x: 8, y: 1 }, { x: 6, y: 1 }] },
    },
    {
        name: 'Polygon',
        shape: { kind: 'polygon', filled: true, points: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 4 }] },
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
        const crosshairs = [];
        const app = Object.assign(topologyApp([shape]), { _shapeElements: new Map(), _layerGroups: new Map(),
            getLayerGroup() { return null; },
            _snapToGrid(point) { return point; },
            refreshFills() { refreshes.push(areDragOverlaysDeferred(this)); },
            viewport: { scale: 100, setCrosshair(point) { crosshairs.push(point); }, hideCrosshair() {} },
            history: { execute(command) { command.execute(); } },
        });
        startBoardShapeDrag(app, shape, { x: 2, y: 3 });
        expect(`${test.name} fixture starts a whole-shape move`, app._shapeDrag.mode, 'move');
        const origin = before.points ? before.points[0] : before.start || { x: before.x, y: before.y };
        expect(`${test.name} whole-shape crosshair starts at the shape origin`, crosshairs.at(-1), origin);
        handleBoardShapeDrag(app, { x: 7, y: 0 });
        expect(`${test.name} whole-shape crosshair follows the moved origin`, crosshairs.at(-1),
            { x: origin.x + 5, y: origin.y - 3 });
        expect(`${test.name} defers fill refresh while moving`, refreshes, []);
        endBoardShapeDrag(app, commit);
        flushTimers();
        expect(`${test.name} refreshes only after authored completion`, refreshes, commit ? [false] : []);
        expect(`${test.name} finishes with the expected geometry`, cloneShapeGeometry(shape),
            commit ? translateShapeGeometry(before, 5, -3) : before);

        refreshes.length = 0;
        const groupBefore = cloneShapeGeometry(shape);
        setPcbSelection(app, [{ kind: 'shape', object: shape }]);
        beginGroupDrag(app, { x: 0, y: 0 });
        updateGroupDrag(app, { x: 3, y: 4 });
        expect(`${test.name} group preview leaves canonical geometry untouched`, cloneShapeGeometry(shape), groupBefore);
        expect(`${test.name} group display follows translated geometry`, cloneShapeGeometry(getGroupPreview(app).copies.get(shape)),
            translateShapeGeometry(groupBefore, 3, 4));
        expect(`${test.name} group defers fill refresh while moving`, refreshes, []);
        if (commit) endGroupDrag(app);
        else cancelGroupDrag(app);
        flushTimers();
        expect(`${test.name} group refreshes only after authored completion`, refreshes, commit ? [false] : []);
        expect(`${test.name} group finishes with expected geometry`, cloneShapeGeometry(shape),
            commit ? translateShapeGeometry(groupBefore, 3, 4) : groupBefore);
        if (test.name === 'Line') {
            refreshes.length = 0;
            const vertexBefore = cloneShapeGeometry(shape);
            const start = shape.points[0];
            startBoardShapeDrag(app, shape, start, 0);
            handleBoardShapeDrag(app, { x: start.x + 2, y: start.y + 1 });
            endBoardShapeDrag(app, false);
            flushTimers();
            expect('cancelled vertex preview requires no repour', refreshes, []);
            expect('cancelled vertex drag restores its geometry', cloneShapeGeometry(shape), vertexBefore);
        }
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
    boardShapes: [additiveShape], _shapeElements: new Map(), _layerGroups: new Map(),
    getLayerGroup() { return null; },
    viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} },
};
startBoardShapeDrag(dragApp, additiveShape, { x: 5, y: 5 });
expect('additive copper drag defers derived overlays', areDragOverlaysDeferred(dragApp), true);
expect('additive copper drag restricts ratsnest to its net',
    [...dragApp._shapeDrag.ratsnestNets], ['GND']);
endBoardShapeDrag(dragApp, false);

const removalShape = { ...additiveShape, id: 'removal', copperMode: 'remove-copper' };
dragApp.boardShapes = [removalShape];
startBoardShapeDrag(dragApp, removalShape, { x: 5, y: 5 });
expect('removal copper drag skips ratsnest reconciliation', dragApp._shapeDrag.ratsnestNets, null);
endBoardShapeDrag(dragApp, false);

for (const shape of [
    { id: 'line-select', kind: 'line', layer: 'top-silk', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { id: 'rect-select', kind: 'rect', layer: 'top-silk', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] },
    { id: 'polygon-select', kind: 'polygon', layer: 'top-silk', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }] },
]) {
    dragApp.boardShapes = [shape];
    startBoardShapeDrag(dragApp, shape, { x: 5, y: 0 });
    expect(`${shape.kind} first-click drag moves the whole shape`, dragApp._shapeDrag.mode, 'move');
    endBoardShapeDrag(dragApp, false);
    startBoardShapeDrag(dragApp, shape, { x: 5, y: 0 }, null, { allowSegment: true });
    expect(`${shape.kind} second-click drag selects its segment`, dragApp._shapeDrag.mode, 'segment');
    expect(`${shape.kind} stores the refined segment`, getBoardShapeSegmentFocus(dragApp),
        { shapeId: shape.id, segment: 0 });
    endBoardShapeDrag(dragApp, false);
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
    const segments = resolveBoardShapeGeometry(shape).strokeSegments;
    const thickSegments = segments.filter((segment) => segment.lineWidth === 0.7);
    expect('rounded rectangle keeps the overridden width on its straight edge', thickSegments.filter(
        (segment) => segment.start.y === 0 && segment.end.y === 0), [{
        start: { x: 2, y: 0 }, end: { x: 8, y: 0 }, lineWidth: 0.7,
    }]);
    // Each half of a rounded corner takes its segment's width: only the halves beside the top side widen.
    const cornerSag = 2 * (1 - Math.SQRT1_2);
    expect('the overridden width reaches only the adjacent corner halves', [
        thickSegments.length > 1,
        thickSegments.every((segment) => Math.max(segment.start.y, segment.end.y) <= cornerSag + 0.05),
        segments.filter((segment) => Math.min(segment.start.y, segment.end.y) > cornerSag + 1e-9)
            .every((segment) => segment.lineWidth === 0.2),
    ], [true, true, true]);
}

{
    const shape = {
        id: 'rounded-segment-drag', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        cornerRadius: 2,
    };
    const app = {
        boardShapes: [shape],
        _shapeElements: new Map(),
        getLayerGroup() { return null; },
        _snapToGrid(point) { return point; },
        viewport: { scale: 100, setCrosshair() {} },
    };
    startBoardShapeDrag(app, shape, { x: 5, y: 0 }, null, { allowSegment: true });
    handleBoardShapeDrag(app, { x: 5, y: 2 });
    const displayed = app._shapeDrag.shape;
    expect('rounded rectangle segment drag preserves its geometry type and radius', {
        kind: displayed.kind,
        cornerRadius: displayed.cornerRadius,
        points: displayed.points,
    }, {
        kind: 'rect',
        cornerRadius: 2,
        points: [{ x: 0, y: 2 }, { x: 10, y: 2 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    });
    expect('rounded rectangle canonical points stay settled', shape.points[0], { x: 0, y: 0 });
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
        _shapeElements: new Map(),
        getLayerGroup() { return null; },
        _snapToGrid(point) { return point; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} },
    };
    const adapter = createBoardShapeSelectionAdapter(app, shape, `shape:${shape.id}`);
    adapter.beginAnchorDrag(0, shape.points[0]);
    const result = adapter.endAnchorDrag(true, { moved: false });
    expect('PCB node click refines selection without floating movement', {
        floating: !!result?.floating,
        selectedNode: getBoardShapeNodeFocus(app),
        dragActive: !!app._shapeDrag,
    }, {
        floating: false,
        selectedNode: { shapeId: shape.id, index: 0 },
        dragActive: false,
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
        _shapeElements: new Map(),
        getLayerGroup() { return null; },
        _snapToGrid(point) { return point; },
        viewport: { scale: 100, setCrosshair() {} },
    };
    startBoardShapeDrag(app, shape, { x: 5, y: 0 }, null, { allowSegment: true });
    handleBoardShapeDrag(app, { x: 6, y: 2 });
    const displayed = app._shapeDrag.shape;
    expect('skewed rounded rectangle becomes a rounded polygon', {
        kind: displayed.kind,
        cornerRadius: displayed.cornerRadius,
        roundedCorners: (shapePathD(displayed).match(/ Q /g) || []).length,
    }, { kind: 'polygon', cornerRadius: 2, roundedCorners: 4 });
    expect('skewed preview leaves canonical rectangle intact', [shape.kind, shape.points[0]], ['rect', { x: 0, y: 0 }]);
}

{
    const shape = {
        id: 'insert-before-width', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
        segmentWidths: { 1: 0.7 },
    };
    const app = topologyApp([shape]);
    startBoardShapeDrag(app, shape, { x: 5, y: 0 }, 'mid:0');
    const displayed = app._shapeDrag.shape;
    expect('midpoint insertion keeps a later width on the same physical segment',
        [boardShapeSegmentWidth(displayed, 0), boardShapeSegmentWidth(displayed, 1), boardShapeSegmentWidth(displayed, 2)],
        [0.2, 0.2, 0.7]);
    expect('midpoint insertion is not authored before drop', shape.points.length, 3);
    endBoardShapeDrag(app, false);
}

{
    const shape = {
        id: 'split-width', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
        segmentWidths: { 1: 0.7 },
    };
    const app = topologyApp([shape]);
    startBoardShapeDrag(app, shape, { x: 15, y: 0 }, 'mid:1');
    const displayed = app._shapeDrag.shape;
    expect('splitting an overridden segment gives both halves its width',
        [boardShapeSegmentWidth(displayed, 0), boardShapeSegmentWidth(displayed, 1), boardShapeSegmentWidth(displayed, 2)],
        [0.2, 0.7, 0.7]);
    endBoardShapeDrag(app, false);
}

function topologyApp(shapes) {
    const pcbDocument = new PcbDocument();
    pcbDocument.boardShapes.push(...shapes);
    return {
        pcbDocument,
        get boardShapes() { return getGroupPreview(this)?.boardShapes || getBoardShapePointerPreview(this)?.boardShapes || pcbDocument.boardShapes; },
        placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _shapeElements: new Map(), _shapeIdCounter: 1,
        getLayerGroup() { return null; }, _snapToGrid(point) { return point; },
        viewport: { scale: 100, snapToGrid: false, setCrosshair() {}, hideCrosshair() {} },
        history: { execute(command) { command.execute(); } },
    };
}

{
    const shape = { id: 'close-curves', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        segmentBulges: { 0: 0.3, 1: 0.4, 2: 0.5 } };
    const app = topologyApp([shape]);
    startBoardShapeDrag(app, shape, shape.points[0], 0);
    handleBoardShapeDrag(app, { x: 0, y: 10 });
    endBoardShapeDrag(app, true);
    expect('closing from the first endpoint rotates curves without reversing edge direction',
        [shape.kind, boardShapeSegmentBulge(shape, 0), boardShapeSegmentBulge(shape, 1), boardShapeSegmentBulge(shape, 2)],
        ['polygon', 0.4, 0.5, 0.3]);
}

{
    const first = { id: 'join-first', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], segmentBulges: { 0: 0.2 } };
    const second = { id: 'join-second', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 0, y: 10 }], segmentBulges: { 0: 0.3 } };
    const app = topologyApp([first, second]);
    startBoardShapeDrag(app, first, first.points[0], 0);
    handleBoardShapeDrag(app, { x: -1, y: 0 });
    handleBoardShapeDrag(app, first.points[0]);
    endBoardShapeDrag(app, true);
    expect('joining reverses only the line whose point order changes',
        [app.boardShapes.length, boardShapeSegmentBulge(app.boardShapes[0], 0), boardShapeSegmentBulge(app.boardShapes[0], 1)],
        [1, -0.2, 0.3]);
}

{
    const shape = { id: 'open-curves', kind: 'polygon', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        segmentBulges: { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4 } };
    const app = topologyApp([shape]);
    openBoardShape(app, shape, 2);
    expect('splitting a polygon rotates all segment curves without dropping an edge',
        app._shapeDrag.shape.segmentBulges, { 0: 0.3, 1: 0.4, 2: 0.1, 3: 0.2 });
    expect('floating split keeps canonical polygon closed', shape.kind, 'polygon');
    updateSelectionInteraction(app, { x: 12, y: 13 });
    placeFloatingSelectionInteraction(app);
    deleteBoardShapeVertex(app, shape, 1);
    expect('deleting a vertex drops the two curves merged at that vertex', shape.segmentBulges, { 1: 0.1, 2: 0.2 });
}

for (const kind of ['polygon', 'rect']) {
    for (const action of ['place', 'cancel', 'in-place']) {
        const shape = { id: `split-${kind}`, kind, layer: 'top-silk', lineWidth: 0.2, filled: true,
            cornerRadius: 2, nodeCornerRadii: { 1: 0.5, 2: 1 }, segmentWidths: { 0: 0.4, 3: 0.7 },
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
        const app = topologyApp([shape]);
        const commands = [];
        app.history.execute = command => { commands.push(command); command.execute(); };
        const original = serializeBoardShapes(app);
        expect(`${kind} split starts`, openBoardShape(app, shape, 2), true);
        const displayed = app._shapeDrag.shape;
        expect(`${kind} split floats the endpoint without node selection`,
            [app._pcbSelectionInteraction?.mode, getBoardShapeNodeFocus(app)], ['floating-anchor', null]);
        expect(`${kind} split preserves every original segment`, displayed.points,
            [{ x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
        expect(`${kind} split preserves widths`, displayed.segmentWidths, { 1: 0.7, 2: 0.4 });
        expect(`${kind} split remaps node radii onto both endpoints`, displayed.nodeCornerRadii, { 0: 1, 3: 0.5, 4: 1 });
        expect(`${kind} split keeps the overall radius`, displayed.cornerRadius, 2);
        expect(`${kind} split leaves the canonical closed shape unchanged`, serializeBoardShapes(app.pcbDocument), original);
        expect(`${kind} split is provisional`, commands.length, 0);
        if (action !== 'in-place') {
            updateSelectionInteraction(app, { x: 12, y: 13 });
            expect(`${kind} only the detached endpoint follows the cursor`,
                [displayed.points[0], displayed.points.at(-1)], [{ x: 12, y: 13 }, { x: 10, y: 10 }]);
        }
        if (action === 'cancel') finishSelectionInteraction(app, false);
        else placeFloatingSelectionInteraction(app);
        if (action !== 'place') {
            expect(`${kind} ${action} restores the closed shape and all metadata`, serializeBoardShapes(app), original);
            expect(`${kind} ${action} leaves history unchanged`, commands.length, 0);
        } else {
            expect(`${kind} split and move commits once`, commands.length, 1);
            expect(`${kind} split result is an unfilled open line`, [shape.kind, shape.filled, shape.points.length], ['line', false, 5]);
            const placed = serializeBoardShapes(app);
            commands[0].undo();
            expect(`${kind} split undo restores the original shape`, serializeBoardShapes(app), original);
            commands[0].execute();
            expect(`${kind} split redo restores placement`, serializeBoardShapes(app), placed);
        }
        expect(`${kind} ${action} clears floating state`, [app._shapeDrag, app._pcbSelectionInteraction], [null, null]);
    }
}

for (const action of ['place', 'cancel', 'in-place']) {
    const shape = { id: 'open-line-split', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
        segmentWidths: { 1: 0.6 }, segmentBulges: { 0: 0.25 }, nodeCornerRadii: { 1: 2 } };
    const app = topologyApp([shape]);
    const commands = [];
    app.history.execute = command => { commands.push(command); command.execute(); };
    const original = serializeBoardShapes(app);
    expect(`line ${action}: split begins`, openBoardShape(app, shape, 1), true);
    expect(`line ${action}: both pieces retain their edges`, app.boardShapes.map(part => part.points.length), [2, 2]);
    expect(`line ${action}: both pieces remain provisional`, serializeBoardShapes(app.pcbDocument), original);
    if (action !== 'in-place') updateSelectionInteraction(app, { x: 12, y: 3 });
    if (action === 'cancel') finishSelectionInteraction(app, false);
    else placeFloatingSelectionInteraction(app);
    if (action === 'place') {
        expect('line split and placement commit atomically', commands.length, 1);
        expect('line split preserves segment metadata', [shape.segmentWidths, app.boardShapes[1].segmentBulges], [{ 0: 0.6 }, { 0: 0.25 }]);
        commands[0].undo();
    } else expect(`line ${action}: no history entry`, commands.length, 0);
    expect(`line ${action}: original is recoverable`, serializeBoardShapes(app), original);
}

{
    const rectangle = { id: 'rect-arc', kind: 'rect', layer: 'top-silk', lineWidth: 0.3,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
    const app = topologyApp([rectangle]);
    setBoardShapeSegmentType(app, rectangle, 1, 'arc');
    expect('curving a rectangle side promotes it to a polygon', [rectangle.kind, rectangle.segmentBulges[1]], ['polygon', 0.25]);
    deleteBoardShapeSegment(app, rectangle, 0);
    expect('deleting a closed edge retains the other edges', [app.boardShapes[0].kind, app.boardShapes[0].points.length], ['line', 4]);
    expect('surviving arc metadata follows its edge', app.boardShapes[0].segmentBulges, { 0: 0.25 });
}

{
    const shape = { id: 'delete-middle', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 15, y: 0 }] };
    const app = topologyApp([shape]);
    deleteBoardShapeSegment(app, shape, 1);
    expect('deleting a middle segment leaves two independent lines', app.boardShapes.map(part => part.points),
        [[{ x: 0, y: 0 }, { x: 5, y: 0 }], [{ x: 10, y: 0 }, { x: 15, y: 0 }]]);
}

if (failures) process.exitCode = 1;