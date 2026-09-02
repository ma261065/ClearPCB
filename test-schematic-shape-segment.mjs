/** Headless regression tests for schematic polyline segment refinement. */

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; },
    createElementNS() {
        return {
            setAttribute() {},
            remove() {},
            classList: { add() {} },
            style: {},
        };
    },
};

const { createLine, createPolygon, createRect } = await import('./src/shapes/polyline.js');
const {
    tryBeginPolylineSegmentDrag,
    updatePolylineSegmentDrag,
} = await import('./src/schematic/modules/polyline-segment-drag.js');
const { clearShapeSegmentSelection } = await import('./src/schematic/modules/shape-management.js');

let failures = 0;
function expect(name, condition) {
    if (condition) console.log(`PASS: ${name}`);
    else {
        failures++;
        console.error(`FAIL: ${name}`);
    }
}

function appFor(shape) {
    const selected = [];
    return {
        interactionState: 'idle',
        shapes: [shape],
        components: [],
        didDrag: false,
        pendingAnchorDrag: null,
        selection: {
            hitTest() { return shape; },
            getSelection() { return selected; },
            select(candidate) {
                selected.splice(0, selected.length, candidate);
                candidate.selected = true;
            },
        },
        viewport: {
            scale: 100,
            gridSize: 1,
            gridVisible: true,
            isPanning: false,
            svg: { style: {} },
            getSnappedPosition(point) {
                return { x: Math.round(point.x), y: Math.round(point.y) };
            },
        },
        _captureShapeState(candidate) { return candidate.captureState(); },
        _updateShapeSelectionTip() {},
    };
}

const cases = [
    ['line', createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] })],
    ['rectangle', createRect({ x: 0, y: 0, width: 10, height: 10 })],
    ['polygon', createPolygon({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }] })],
];

for (const [name, shape] of cases) {
    const app = appFor(shape);
    const worldPos = { x: 3, y: 0 };
    expect(`${name} first click leaves segment refinement disabled`,
        !tryBeginPolylineSegmentDrag(app, shape, worldPos, false, 0.1));
    app.selection.select(shape);
    tryBeginPolylineSegmentDrag(app, shape, worldPos, true, 0.1);
    const edgeId = app.drag?.edgeId;
    const edge = shape.edges.get(edgeId);
    expect(`${name} second click refines the hit segment`, app.drag?.mode === 'segment');
    expect(`${name} stores a stable edge id`, app._selectedShapeSegment?.edgeId === edgeId);

    app.drag = null;
    expect(`${name} selected edge can begin a later segment drag`,
        tryBeginPolylineSegmentDrag(app, shape, worldPos, true, 0.1));
    const otherEdgeId = [...shape.edges.keys()].find((candidate) => candidate !== edgeId);
    if (otherEdgeId) {
        const otherEdge = shape.edges.get(otherEdgeId);
        const otherFrom = shape.nodes.get(otherEdge.from);
        const otherTo = shape.nodes.get(otherEdge.to);
        const otherPoint = { x: (otherFrom.x + otherTo.x) / 2, y: (otherFrom.y + otherTo.y) / 2 };
        app.drag = null;
        expect(`${name} another edge does not inherit segment drag mode`,
            !tryBeginPolylineSegmentDrag(app, shape, otherPoint, true, 0.1));
    }
    app.drag = null;
    tryBeginPolylineSegmentDrag(app, shape, worldPos, true, 0.1);

    const untouchedNodeId = [...shape.nodes.keys()].find((id) => id !== edge.from && id !== edge.to);
    const untouchedBefore = untouchedNodeId ? { ...shape.nodes.get(untouchedNodeId) } : null;
    updatePolylineSegmentDrag(app, { x: 3, y: 2 });
    expect(`${name} segment drag moves both selected edge endpoints`,
        shape.nodes.get(edge.from).y === 2 && shape.nodes.get(edge.to).y === 2);
    expect(`${name} segment drag leaves other vertices fixed`, !untouchedNodeId
        || (shape.nodes.get(untouchedNodeId).x === untouchedBefore.x
            && shape.nodes.get(untouchedNodeId).y === untouchedBefore.y));
    expect(`${name} segment remains refined after movement`, app._selectedShapeSegment?.edgeId === edgeId);
    if (name === 'rectangle') expect('rectangle segment movement converts it to a polygon', !shape.isRect);
}

{
    const shape = createLine({
        lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
    });
    const [selectedEdgeId, otherEdgeId] = [...shape.edges.keys()];
    shape.setEdgeAttr(selectedEdgeId, 'width', 0.6);
    expect('schematic segment width changes only the selected edge',
        shape.getEdgeAttr(selectedEdgeId, 'width') === 0.6
        && shape.getEdgeAttr(otherEdgeId, 'width') === 0.2
        && shape.lineWidth === 0.2);
    expect('schematic segment width is serialized by stable edge id',
        shape.toJSON().ew?.[selectedEdgeId] === 0.6
        && shape.toJSON().ew?.[otherEdgeId] === undefined);
    const clone = shape.clone();
    expect('schematic clone preserves segment width overrides',
        clone.getEdgeAttr(selectedEdgeId, 'width') === 0.6
        && clone.getEdgeAttr(otherEdgeId, 'width') === 0.2);
}

{
    let removed = 0;
    const app = {
        _selectedShapeSegment: { shapeId: 'shape', edgeId: 'edge' },
        _shapeSegmentSelectionElement: { remove() { removed++; } },
    };
    clearShapeSegmentSelection(app);
    expect('schematic shape deselection clears refined segment state', app._selectedShapeSegment === null);
    expect('schematic shape deselection removes refined segment highlight',
        app._shapeSegmentSelectionElement === null && removed === 1);
}

if (failures) process.exitCode = 1;