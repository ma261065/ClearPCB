globalThis.document = {
    createElementNS() {
        const attributes = new Map();
        return {
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name) ?? null; },
            removeAttribute(name) { attributes.delete(name); },
            parentNode: null,
        };
    },
    getElementById() { return null; },
    querySelector() { return null; },
};
globalThis.window = { addEventListener() {} };

const {
    applyBoardShapeVertexResize,
    getBoardShapeAnchors,
    moveBoardShapeAnchor,
    cloneShapeGeometry,
    boardShapeLineWidthMinimum,
    boardShapeArcGeometry,
    boardShapeCopperCuts,
    boardShapeFilledRemovalOutlines,
    boardShapeRemovalPathD,
    circleFilledRadius,
    finishLineDraw,
    handleBoardShapeDrag,
    startBoardShapeDrag,
    endBoardShapeDrag,
    finishShapeDrawAtPoint,
    resolveBoardShapeGeometry,
    renderBoardShape,
    shapeOutline,
    shapeHoverColor,
    shapePathD,
    shapeIsFilled,
    shapeSelectionColor,
    shapeDrawClick,
    showBoardShapeProperties,
    updateShapeDrawPreview,
} = await import('../src/pcb/modules/board-shapes.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const { pcbTextPolylines, pcbTextSegments } = await import('../src/pcb/modules/pcb-text.js');
const { pcbLayerSelectionColor } = await import('../src/pcb/modules/layers.js');
const { flattenSvgPath } = await import('../src/pcb/modules/board-geometry.js');
const { Board2D } = await import('../src/pcb/modules/board2d.js');
const { computeFillPolygons, loadClipper } = await import('../src/pcb/modules/copper-fill-geom.js');

let failures = 0;
function check(name, condition) {
    if (condition) console.log(`PASS ${name}`);
    else {
        console.error(`FAIL ${name}`);
        failures++;
    }
}

const approx = (a, b) => Math.abs(a - b) < 1e-9;
const sharpRectangle = {
    id: 'sharp-rectangle', kind: 'rect', layer: 'top-copper', lineWidth: 2,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }],
};
for (const filled of [false, true]) {
    const shape = { ...sharpRectangle, filled };
    const geometry = resolveBoardShapeGeometry(shape);
    check(`filled=${filled} rectangle physical outline has square corners`,
        geometry.physicalContours.length === (filled ? 1 : 2)
        && geometry.physicalContours.every(contour => contour.length === 4)
        && geometry.physicalContours.some(contour => contour.some(point => approx(point.x, -1) && approx(point.y, -1))));
    let element;
    renderBoardShape({
        boardShapes: [shape], _shapeElements: new Map(),
        _getLayerGroup() { return { appendChild(child) { element = child; } }; },
    }, shape);
    check(`filled=${filled} rectangle SVG uses round caps and miter joins`,
        element.getAttribute('stroke-linecap') === 'round'
        && element.getAttribute('stroke-linejoin') === 'miter');
}
check('explicit rectangle corner radius preserves curved geometry',
    resolveBoardShapeGeometry({ ...sharpRectangle, cornerRadius: 2 }).physicalContours.length === 2
    && shapePathD({ ...sharpRectangle, cornerRadius: 2 }).includes(' A 2 2 '));
for (const shape of [
    { kind: 'rect', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] },
    { kind: 'rect', cornerRadius: 2, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] },
    { kind: 'polygon', points: [{ x: 0, y: 8 }, { x: 10, y: 8 }, { x: 10, y: 0 }, { x: 0, y: 0 }] },
    { kind: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { kind: 'arc', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: 5 } },
]) {
    Object.assign(shape, { id: 'centreline-handles', layer: 'top-copper', lineWidth: 2, filled: false });
    const anchors = getBoardShapeAnchors(shape);
    const original = cloneShapeGeometry(shape);
    const handleApp = {
        boardShapes: [shape], _shapeElements: new Map(),
        _snapToGrid(point) { return point; }, _getLayerGroup() { return null; },
    };
    for (const anchor of anchors.filter(anchor => !anchor.midpoint)) {
        moveBoardShapeAnchor(handleApp, shape, anchor.id, anchor);
        const actual = cloneShapeGeometry(shape);
        check(`${shape.kind} rounded=${!!shape.cornerRadius} handle ${anchor.id} does not jump on drag start`,
            JSON.stringify(actual, (_key, value) => typeof value === 'number' ? Number(value.toFixed(8)) : value)
            === JSON.stringify(original));
    }
    if (shape.kind === 'line') {
        check('line endpoint handles sit on the centerline endpoints', approx(anchors[0].x, 0) && approx(anchors[1].x, 10));
        check('line insertion handle sits on the centerline', approx(anchors[2].y, 0));
    } else if (shape.kind === 'arc') {
        check('arc handles sit on the centerline radius', anchors.every(anchor => approx(Math.hypot(anchor.x - 5, anchor.y), 5)));
    } else {
        check(`${shape.kind} rounded=${!!shape.cornerRadius} corner handles follow centreline vertices`,
            anchors.filter(anchor => !anchor.midpoint).every((anchor, index) =>
                approx(anchor.x, shape.points[index].x) && approx(anchor.y, shape.points[index].y)));
        const roundedAnchors = getBoardShapeAnchors({ ...shape, cornerRadius: 3, nodeCornerRadii: { 0: 1 } });
        check(`${shape.kind} corner radius does not move handles`,
            JSON.stringify(roundedAnchors) === JSON.stringify(anchors));
    }
}
for (const layer of ['hole', 'top-copper', 'bottom-copper']) {
    for (const filled of [false, true]) {
        const circle = { kind: 'circle', x: 5, y: -5, radius: 3, lineWidth: 0.4, layer, filled };
        applyBoardShapeVertexResize(circle, { handle: 'radius' }, { x: 8, y: -5 });
        check(`${layer} filled=${filled} dragging at the outer edge does not change radius`, approx(circle.radius, 3));
        applyBoardShapeVertexResize(circle, { handle: 'radius' }, { x: 10, y: -5 });
        check(`${layer} filled=${filled} radius drag places the outer edge at the pointer`,
            approx(circleFilledRadius(circle), 5) && circle.lineWidth === 0.4);
    }
}
const bananaPoints = [
    { x: 0, y: 0 }, { x: 0, y: 12 }, { x: 16, y: 20 },
    { x: -4, y: 20 }, { x: -6, y: 12 },
];
for (const reversed of [false, true]) {
    const banana = {
        kind: 'polygon', layer: 'hole', filled: true, lineWidth: 2,
        points: reversed ? [...bananaPoints].reverse() : bananaPoints,
        nodeCornerRadii: reversed ? { 0: 3, 1: 3 } : { 3: 3, 4: 3 },
    };
    const centerline = shapeOutline(banana);
    const removal = flattenSvgPath(boardShapeRemovalPathD(banana)).flat();
    const previewPoints = [];
    const context = {
        beginPath() {}, closePath() {}, fill() {},
        moveTo(x, y) { previewPoints.push({ x, y }); },
        lineTo(x, y) { previewPoints.push({ x, y }); },
    };
    Board2D.prototype._drawHoles.call({ data: { boardShapes: [banana] } }, context);
    const contours = boardShapeFilledRemovalOutlines(banana).flat();
    check(`2D hole preview uses physical rounded contours (${reversed ? 'reversed' : 'forward'})`,
        JSON.stringify(previewPoints) === JSON.stringify(contours)
        && contours.length >= 3
        && contours.every(point => removal.some(other =>
            Math.hypot(point.x - other.x, point.y - other.y) < 0.0001)));
    const margin = banana.lineWidth / 2 + 0.002;
    const minX = Math.min(...centerline.map(point => point.x)) - margin;
    const maxX = Math.max(...centerline.map(point => point.x)) + margin;
    const minY = Math.min(...centerline.map(point => point.y)) - margin;
    const maxY = Math.max(...centerline.map(point => point.y)) + margin;
    check(`rounded hole polygon has no miter spikes (${reversed ? 'reversed' : 'forward'})`,
        removal.length > centerline.length && removal.every(point =>
            point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY));
    check(`filled copper removal shares the rounded hole outline (${reversed ? 'reversed' : 'forward'})`,
        boardShapeRemovalPathD({ ...banana, layer: 'top-copper', copperMode: 'remove-copper' })
            === boardShapeRemovalPathD(banana));
}
for (const layer of ['hole', 'top-copper', 'top-mask']) {
    const preview = document.createElementNS();
    preview.setAttribute('fill-opacity', '1');
    updateShapeDrawPreview({
        _shapeDraw: { kind: 'line', layer, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], preview },
        _shapeDefaults: { filled: true },
        _snapToGrid: (point) => point,
    }, { x: 10, y: 5 });
    check(`${layer} line preview stays unfilled between its endpoints`,
        preview.getAttribute('fill') === 'none'
        && preview.getAttribute('fill-opacity') === null
        && preview.getAttribute('d') === 'M 0 0 L 10 0 L 10 5');
}
const app = {
    boardShapes: [],
    _shapeDefaults: {},
    activeLayer: 'top-silk',
    _shapeIdCounter: 1,
    _snapToGrid: (point) => ({ x: Math.round(point.x), y: Math.round(point.y) }),
    _getLayerGroup: () => ({ appendChild() {} }),
    history: { execute(command) { app.boardShapes.push(command.shape); } },
    viewport: { scale: 1, setCrosshair() {} },
};

shapeDrawClick(app, 'arc', { x: 0, y: 0 });
check('PCB shape ghost matches schematic preview styling',
    app._shapeDraw.preview.getAttribute('stroke') === 'var(--sch-symbol-outline, #ffffff)'
    && app._shapeDraw.preview.getAttribute('stroke-width') === '1'
    && app._shapeDraw.preview.getAttribute('opacity') === '0.6'
    && app._shapeDraw.preview.getAttribute('stroke-dasharray') === null);
shapeDrawClick(app, 'arc', { x: 10, y: 0 });
shapeDrawClick(app, 'arc', { x: 8, y: 3 });
const drawn = app.boardShapes[0];
check('drawn bulge is projected to the chord bisector', approx(drawn.bulge.x, 5) && approx(drawn.bulge.y, 3));

app.boardShapes = [];
shapeDrawClick(app, 'line', { x: 0, y: 0 });
shapeDrawClick(app, 'line', { x: 10, y: 0 });
app._lastCrosshairWorld = { x: 20, y: 5 };
finishShapeDrawAtPoint(app, app._lastCrosshairWorld);
check('finishing a line commits the current cursor endpoint',
    app.boardShapes.length === 1
    && app.boardShapes[0].points.length === 3
    && approx(app.boardShapes[0].points[2].x, 20)
    && approx(app.boardShapes[0].points[2].y, 5));

for (const [kind, placedPoints, finalPoint] of [
    ['rect', [{ x: 0, y: 0 }], { x: 8, y: 4 }],
    ['circle', [{ x: 0, y: 0 }], { x: 3, y: 4 }],
    ['polygon', [{ x: 0, y: 0 }, { x: 8, y: 0 }], { x: 4, y: 5 }],
    ['arc', [{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 8, y: 3 }],
]) {
    app.boardShapes = [];
    app._shapeDraw = null;
    for (const point of placedPoints) shapeDrawClick(app, kind, point);
    const finished = finishShapeDrawAtPoint(app, finalPoint);
    check(`right-click commits current point and finishes ${kind}`, finished && app.boardShapes.length === 1);
}

const arc = {
    id: 'arc_1',
    kind: 'arc',
    start: { x: 0, y: 0 },
    end: { x: 10, y: 0 },
    bulge: { x: 5, y: 2.5 },
    layer: 'top-silk',
    lineWidth: 0.2,
    filled: false,
};
app.boardShapes = [arc];
const beforeEndpointDrag = structuredClone(arc);
applyBoardShapeVertexResize(arc, { before: beforeEndpointDrag, handle: 'start' }, { x: 0, y: 4 });
check('endpoint drag preserves bulge ratio', approx(arc.bulge.x, 6) && approx(arc.bulge.y, 4.5));

const beforeBulgeDrag = structuredClone(arc);
applyBoardShapeVertexResize(arc, { before: beforeBulgeDrag, handle: 'bulge' }, { x: 8, y: 20 });
const midpoint = { x: (arc.start.x + arc.end.x) / 2, y: (arc.start.y + arc.end.y) / 2 };
const chord = { x: arc.end.x - arc.start.x, y: arc.end.y - arc.start.y };
const fromMid = { x: arc.bulge.x - midpoint.x, y: arc.bulge.y - midpoint.y };
check('bulge drag stays on the chord bisector', approx(chord.x * fromMid.x + chord.y * fromMid.y, 0));
check('bulge drag is clamped to a semicircle', Math.hypot(fromMid.x, fromMid.y) <= Math.hypot(chord.x, chord.y) / 2 + 1e-9);

const removalArc = {
    ...arc,
    layer: 'top-copper',
    copperMode: 'remove-copper',
    filled: false,
};
check('unfilled copper-removal arc is not hit-tested as filled', !shapeIsFilled(removalArc));
const cuts = boardShapeCopperCuts({ boardShapes: [removalArc] }, 'top-copper');
check('unfilled copper-removal arc produces a stroked copper cut', cuts.count === 1 && cuts.d.split(' L ').length > 80);
const arcCenterline = shapeOutline(removalArc);
const filledArcOutline = shapeOutline({ ...removalArc, filled: true });
check('filled arc keeps the same outline centerline',
    filledArcOutline.length === arcCenterline.length
    && filledArcOutline.every((point, index) => (
        approx(point.x, arcCenterline[index].x) && approx(point.y, arcCenterline[index].y)
    )));

const removalCircle = {
    id: 'circle_1',
    kind: 'circle',
    x: 5,
    y: 5,
    radius: 3,
    lineWidth: 0.4,
    layer: 'top-copper',
    copperMode: 'remove-copper',
    filled: false,
};
check('unfilled copper-removal circle is not hit-tested as filled', !shapeIsFilled(removalCircle));
const circleCuts = boardShapeCopperCuts({ boardShapes: [removalCircle] }, 'top-copper');
check('unfilled copper-removal circle produces an annular copper cut', circleCuts.count === 1 && circleCuts.d.split(' M ').length === 3);
check('filled circle reaches the outside of its outline', approx(circleFilledRadius({ ...removalCircle, filled: true }), 3));

const removalRect = {
    id: 'rect_1',
    kind: 'rect',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }],
    lineWidth: 0.4,
    layer: 'top-copper',
    copperMode: 'remove-copper',
    filled: false,
};
check('unfilled copper-removal rectangle is not hit-tested as filled', !shapeIsFilled(removalRect));
const rectCuts = boardShapeCopperCuts({ boardShapes: [removalRect] }, 'top-copper');
check('unfilled copper-removal rectangle produces an outline cut', rectCuts.count === 1 && rectCuts.d.split(' M ').length === 3);

const roundedRemovalRect = { ...removalRect, cornerRadius: 2 };
const roundedPath = shapePathD(roundedRemovalRect);
check('rounded rectangle display uses circular arcs', roundedPath.includes(' A 2 2 ') && !roundedPath.includes(' Q '));
const roundedRectCuts = boardShapeCopperCuts({ boardShapes: [roundedRemovalRect] }, 'top-copper');
check('rounded rectangle removal uses concentric outline cuts', roundedRectCuts.count === 1 && roundedRectCuts.d.split(' M ').length === 3);

const propertyItems = { innerHTML: '' };
const propertyTabs = [];
showBoardShapeProperties({
    boardShapes: [roundedRemovalRect],
    placements: new Map(), tracks: [], vias: [], texts: new Map(),
    viewport: { scale: 1 },
    _pcbPropsItems() { return propertyItems; },
    _setPcbPropsTitle() {},
    _setActiveRibbonTab(tab) { propertyTabs.push(tab); },
}, roundedRemovalRect);
check('existing rectangle populates the PCB Properties panel',
    propertyItems.innerHTML.includes('pcbPropShapeLayer')
    && propertyTabs.at(-1) === 'pcb-properties');
let segmentTitle = '';
showBoardShapeProperties({
    boardShapes: [roundedRemovalRect],
    placements: new Map(), tracks: [], vias: [], texts: new Map(),
    viewport: { scale: 1 },
    _selectedBoardShapeSegment: { shapeId: roundedRemovalRect.id, segment: 0 },
    _pcbPropsItems() { return propertyItems; },
    _setPcbPropsTitle(title) { segmentTitle = title; },
    _setActiveRibbonTab() {},
}, roundedRemovalRect);
check('selected PCB segment uses the Segment Properties title', segmentTitle === 'Segment');
const holeLinePropertyItems = { innerHTML: '' };
showBoardShapeProperties({
    boardShapes: [{ ...removalRect, kind: 'line', layer: 'hole', points: removalRect.points.slice(0, 2) }],
    placements: new Map(), tracks: [], vias: [], texts: new Map(),
    viewport: { scale: 1 },
    _pcbPropsItems() { return holeLinePropertyItems; },
    _setPcbPropsTitle() {}, _setActiveRibbonTab() {},
}, { ...removalRect, kind: 'line', layer: 'hole', points: removalRect.points.slice(0, 2) });
check('hole-layer Line properties include line thickness',
    holeLinePropertyItems.innerHTML.includes('pcbPropShapeLineWidth')
    && holeLinePropertyItems.innerHTML.includes('min="0.8"'));
check('hole-layer Line width minimum is 0.8 mm',
    boardShapeLineWidthMinimum({ kind: 'line', layer: 'hole' }) === 0.8
    && boardShapeLineWidthMinimum({ kind: 'line', layer: 'top-copper' }) === 0.05);
const holeRectPropertyItems = { innerHTML: '' };
const holeRect = { ...removalRect, layer: 'hole' };
showBoardShapeProperties({
    boardShapes: [holeRect], placements: new Map(), tracks: [], vias: [], texts: new Map(),
    viewport: { scale: 1 },
    _pcbPropsItems() { return holeRectPropertyItems; },
    _setPcbPropsTitle() {}, _setActiveRibbonTab() {},
}, holeRect);
check('other hole-layer shape properties omit line thickness',
    !holeRectPropertyItems.innerHTML.includes('pcbPropShapeLineWidth'));

const circlePropertyShape = { ...removalCircle, layer: 'hole', radius: 14.8, lineWidth: 0.4 };
showBoardShapeProperties({
    boardShapes: [circlePropertyShape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
    viewport: { scale: 1 },
    _pcbPropsItems() { return propertyItems; },
    _setPcbPropsTitle() {}, _setActiveRibbonTab() {},
}, circlePropertyShape);
check('circle diameter property displays the physical outside size',
    propertyItems.innerHTML.includes('pcbPropShapeDiameter')
    && propertyItems.innerHTML.includes('value="29.60"'));
check('circle diameter spinner uses 0.05 mm increments',
    /id="pcbPropShapeDiameter"[^>]*step="0\.05"/.test(propertyItems.innerHTML));

function propertyInput(value) {
    const listeners = new Map();
    return {
        value: String(value),
        get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); },
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        fire(type, event = {}) { for (const listener of listeners.get(type) || []) listener(event); },
    };
}
const originalGetElementById = document.getElementById;
for (const kind of ['rect', 'polygon']) {
for (const reversed of [false, true]) {
    for (let corner = 0; corner < 4; corner++) {
        const points = sharpRectangle.points.map(point => ({ x: point.x + 0.13, y: point.y + 0.17 }));
        const shape = { ...sharpRectangle, kind, lineWidth: 0.4, points: reversed ? points.reverse() : points };
        const anchor = getBoardShapeAnchors(shape)[corner];
        const expected = { x: Math.round(anchor.x), y: Math.round(anchor.y) };
        const dragApp = {
            boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
            _shapeElements: new Map(), viewport: { scale: 20, setCrosshair() {} },
            _getLayerGroup() { return null; },
            _snapToGrid(point) { return { x: Math.round(point.x), y: Math.round(point.y) }; },
        };
        startBoardShapeDrag(dragApp, shape, anchor, corner);
        handleBoardShapeDrag(dragApp, expected);
        const actual = getBoardShapeAnchors(shape).find(handle => handle.id === corner);
        check(`existing ${kind} reversed=${reversed} corner=${corner} snaps its centreline handle to grid`,
            approx(actual.x, expected.x) && approx(actual.y, expected.y));
    }
}
    }
{
    const shape = { ...sharpRectangle, cornerRadius: 2, lineWidth: 0.4, filled: false };
    const widthInput = propertyInput(0.4);
    document.getElementById = (id) => id === 'pcbPropShapeLineWidth' ? widthInput : null;
    showBoardShapeProperties({
        boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _shapeElements: new Map(), viewport: { scale: 1 },
        _getLayerGroup() { return null; }, _pcbPropsItems() { return propertyItems; },
        history: { execute(command) { command.execute(); } },
    }, shape);
    for (const width of [2, 0.1, 100]) {
        widthInput.value = String(width);
        widthInput.fire('input');
        check(`rounded rectangle width=${width} keeps its corner radius and centreline geometry`,
            approx(shape.cornerRadius, 2)
            && approx(shape.points[0].x + shape.cornerRadius, 2)
            && approx(shape.points[0].y + shape.cornerRadius, 2));
    }
    widthInput.fire('change');
}
for (const kind of ['rect', 'polygon']) {
    for (const reversed of [false, true]) {
        const shape = { ...sharpRectangle, kind, lineWidth: 0.4, filled: false,
            points: reversed ? [...sharpRectangle.points].reverse() : [...sharpRectangle.points] };
        const initial = structuredClone(shape);
        const initialAnchors = getBoardShapeAnchors(shape).filter(anchor => !anchor.midpoint);
        const widthInput = propertyInput(0.4);
        document.getElementById = (id) => id === 'pcbPropShapeLineWidth' ? widthInput : null;
        const commands = [];
        const widthApp = {
            boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
            _shapeElements: new Map(), viewport: { scale: 1 },
            _getLayerGroup() { return null; }, _pcbPropsItems() { return propertyItems; },
            history: { execute(command) { commands.push(command); command.execute(); } },
        };
        showBoardShapeProperties(widthApp, shape);
        for (const width of [2, 0.1, 1]) {
            widthInput.value = String(width);
            widthInput.fire('input');
            const outline = boardShapeFilledRemovalOutlines(shape).flat();
            check(`${kind} reversed=${reversed} width=${width} expands by half width`,
                approx(Math.min(...outline.map(point => point.x)), -width / 2)
                && approx(Math.max(...outline.map(point => point.x)), 10 + width / 2)
                && approx(Math.min(...outline.map(point => point.y)), -width / 2)
                && approx(Math.max(...outline.map(point => point.y)), 8 + width / 2));
            const anchors = getBoardShapeAnchors(shape).filter(anchor => !anchor.midpoint);
            check(`${kind} reversed=${reversed} width=${width} keeps handles fixed`, anchors.every((anchor, index) =>
                Math.hypot(anchor.x - initialAnchors[index].x, anchor.y - initialAnchors[index].y) < 1e-9));
            check(`${kind} width=${width} insertion handles follow centerline midpoints`,
                getBoardShapeAnchors(shape).filter(anchor => anchor.midpoint).every((anchor, index) => {
                    const next = shape.points[(index + 1) % shape.points.length];
                    return approx(anchor.x, (shape.points[index].x + next.x) / 2)
                        && approx(anchor.y, (shape.points[index].y + next.y) / 2);
                }));
        }
        widthInput.fire('change');
        check(`${kind} thickness preview commits as one undo step`, commands.length === 1);
        commands[0].undo();
        check(`${kind} thickness undo restores original geometry`,
            JSON.stringify(shape.points) === JSON.stringify(initial.points) && shape.lineWidth === initial.lineWidth);
        commands[0].execute();
        check(`${kind} thickness redo preserves the centreline`,
            JSON.stringify(shape.points) === JSON.stringify(initial.points) && shape.lineWidth === 1);
        widthInput.value = '100';
        widthInput.fire('input');
        widthInput.fire('change');
        check(`${kind} excessive thickness fills across the centreline`, shape.lineWidth === 100
            && resolveBoardShapeGeometry(shape).physicalContours.length === 1
            && JSON.stringify(shape.points) === JSON.stringify(initial.points)
            && approx(Math.min(...boardShapeFilledRemovalOutlines(shape).flat().map(point => point.x)), -50));
    }
}
for (const layer of ['hole', 'top-copper', 'bottom-copper']) {
    for (const filled of [false, true]) {
        const editableCircle = { ...circlePropertyShape, layer, filled, copperMode: 'add', radius: 3 };
        const diameterInput = propertyInput(6.4);
        const widthInput = propertyInput(0.4);
        document.getElementById = (id) => id === 'pcbPropShapeDiameter' ? diameterInput
            : id === 'pcbPropShapeLineWidth' && layer !== 'hole' ? widthInput : null;
        const commands = [];
        let fillRefreshes = 0;
        const diameterApp = {
            boardShapes: [editableCircle], placements: new Map(), tracks: [], vias: [], texts: new Map(),
            viewport: { scale: 1 }, _shapeElements: new Map(),
            _getLayerGroup() { return null; },
            _pcbPropsItems() { return propertyItems; },
            _setPcbPropsTitle() {}, _setActiveRibbonTab() {},
            _refreshFills() { fillRefreshes++; },
            _refreshPcbSelectionHighlights() { throw new Error('Diameter preview must not rebuild the properties panel'); },
            history: { execute(command) { commands.push(command); command.execute(); } },
        };
        showBoardShapeProperties(diameterApp, editableCircle);
        if (layer !== 'hole') {
            check(`${layer} filled=${filled} diameter follows line thickness in properties`,
                propertyItems.innerHTML.indexOf('id="pcbPropShapeDiameter"')
                > propertyItems.innerHTML.indexOf('id="pcbPropShapeLineWidth"'));
        }
        diameterInput.value = '20';
        diameterInput.fire('input');
        diameterInput.value = '29.999999999999996';
        diameterInput.fire('input');
        check(`${layer} filled=${filled} diameter preview preserves input text`,
            diameterInput.value === '29.999999999999996');
        check(`${layer} filled=${filled} diameter previews exact outside size`,
            approx(editableCircle.radius, 15)
            && approx(circleFilledRadius(editableCircle) * 2, 30)
            && editableCircle.x === circlePropertyShape.x && editableCircle.y === circlePropertyShape.y
            && editableCircle.lineWidth === 0.4 && editableCircle.filled === filled
            && commands.length === 0 && fillRefreshes >= 2);
        delete diameterApp._refreshPcbSelectionHighlights;
        diameterInput.fire('change');
        check(`${layer} filled=${filled} committed diameter removes floating-point tails`,
            diameterInput.value === '30.00');
        check(`${layer} filled=${filled} diameter edits create one undo command`, commands.length === 1);
        commands[0].undo();
        check(`${layer} filled=${filled} diameter undo restores original radius`, approx(editableCircle.radius, 3));
        commands[0].execute();
        check(`${layer} filled=${filled} diameter redo restores 30 mm`, approx(circleFilledRadius(editableCircle) * 2, 30));
        diameterInput.value = '0';
        diameterInput.fire('input');
        check(`${layer} filled=${filled} partial diameter is not clamped while typing`,
            diameterInput.value === '0' && approx(editableCircle.radius, 15));
        diameterInput.value = '';
        diameterInput.fire('input');
        diameterInput.fire('pointerdown');
        check(`${layer} filled=${filled} backspace can leave diameter empty`, diameterInput.value === '');
        diameterInput.fire('pointerup');
        diameterInput.fire('change');
        check(`${layer} filled=${filled} empty diameter is ignored`,
            approx(editableCircle.radius, 15) && commands.length === 1);
        if (layer !== 'hole') {
            widthInput.value = '0.8';
            widthInput.fire('input');
            check(`${layer} filled=${filled} thicker stroke preserves outer diameter`,
                approx(diameterInput.valueAsNumber, 30) && approx(editableCircle.radius, 15));
            widthInput.value = '0.1';
            widthInput.fire('input');
            check(`${layer} filled=${filled} narrower stroke moves inward from fixed outer edge`,
                approx(diameterInput.valueAsNumber, 30) && approx(editableCircle.radius, 15)
                && approx(circleFilledRadius(editableCircle) * 2, 30));
            widthInput.fire('change');
            commands.at(-1).undo();
            check(`${layer} filled=${filled} thickness undo restores width and radius`,
                approx(editableCircle.lineWidth, 0.4) && approx(editableCircle.radius, 15));
            commands.at(-1).execute();
            check(`${layer} filled=${filled} thickness redo preserves outer diameter`,
                approx(editableCircle.lineWidth, 0.1) && approx(circleFilledRadius(editableCircle) * 2, 30));
            widthInput.value = '40';
            widthInput.fire('input');
            widthInput.fire('change');
            check(`${layer} filled=${filled} oversized thickness cannot enlarge circle`,
                approx(circleFilledRadius(editableCircle) * 2, 30)
                && approx(editableCircle.radius, 15) && approx(widthInput.valueAsNumber, 15));
        }
        editableCircle.lineWidth = 4.75;
        const radiusBeforeShrink = editableCircle.radius;
        diameterInput.value = '1';
        diameterInput.fire('input');
        check(`${layer} filled=${filled} 1 mm diameter fits a previously thick stroke`,
            diameterInput.value === '1' && approx(circleFilledRadius(editableCircle) * 2, 1));
        diameterInput.value = '10';
        diameterInput.fire('input');
        check(`${layer} filled=${filled} intermediate small input does not permanently shrink width`,
            approx(editableCircle.lineWidth, 4.75));
        diameterInput.value = '1';
        diameterInput.fire('input');
        diameterInput.fire('change');
        check(`${layer} filled=${filled} 1 mm diameter stays 1 mm on commit`,
            diameterInput.value === '1.00' && approx(circleFilledRadius(editableCircle) * 2, 1));
        commands.at(-1).undo();
        check(`${layer} filled=${filled} diameter undo restores radius and thick stroke`,
            approx(editableCircle.radius, radiusBeforeShrink) && approx(editableCircle.lineWidth, 4.75));
        commands.at(-1).execute();
        check(`${layer} filled=${filled} diameter redo restores 1 mm`,
            approx(circleFilledRadius(editableCircle) * 2, 1));
        diameterInput.value = '-1';
        diameterInput.fire('input');
        diameterInput.fire('change');
        check(`${layer} filled=${filled} diameter clamps to minimum radius`,
            approx(editableCircle.radius, 0.075)
            && approx(diameterInput.valueAsNumber, editableCircle.radius * 2));
        const beforeDrag = commands.at(-1).after;
        diameterApp._snapToGrid = (point) => point;
        diameterApp.viewport.setCrosshair = () => {};
        diameterApp.viewport.hideCrosshair = () => {};
        diameterApp._shapeDrag = {
            id: editableCircle.id, mode: 'vertex', handle: 'radius',
            before: beforeDrag.geom, beforeState: beforeDrag,
        };
        let dragPanelRebuilds = 0;
        diameterApp._pcbPropsItems = () => { dragPanelRebuilds++; return propertyItems; };
        handleBoardShapeDrag(diameterApp, { x: editableCircle.x + 5, y: editableCircle.y });
        check(`${layer} filled=${filled} diameter spinner follows handle drag without panel rebuild`,
            diameterInput.value === '10.00' && dragPanelRebuilds === 0);
        endBoardShapeDrag(diameterApp, false);
        check(`${layer} filled=${filled} cancelled diameter drag restores spinner`,
            approx(diameterInput.valueAsNumber, circleFilledRadius(editableCircle) * 2)
            && approx(editableCircle.radius, beforeDrag.geom.radius));
        diameterApp._shapeDrag = {
            id: editableCircle.id, mode: 'vertex', handle: 'radius',
            before: beforeDrag.geom, beforeState: beforeDrag,
        };
        handleBoardShapeDrag(diameterApp, { x: editableCircle.x + 3, y: editableCircle.y });
        endBoardShapeDrag(diameterApp, true);
        check(`${layer} filled=${filled} committed diameter drag keeps spinner synchronized`,
            diameterInput.value === '6.00' && approx(circleFilledRadius(editableCircle) * 2, 6));
        diameterInput.value = '7.55';
        diameterInput.fire('pointerdown');
        diameterInput.value = '7.5';
        diameterInput.fire('input');
        check(`${layer} filled=${filled} pressed spinner keeps two decimal places`,
            diameterInput.value === '7.50');
        diameterInput.fire('pointerup');
        diameterInput.fire('change');
        diameterInput.fire('keydown', { key: 'ArrowDown' });
        diameterInput.value = '7.4';
        diameterInput.fire('input');
        check(`${layer} filled=${filled} arrow-key stepping keeps two decimal places`,
            diameterInput.value === '7.40');
        diameterInput.fire('keyup');
        diameterInput.fire('keydown', { key: 'Backspace' });
        diameterInput.value = '7.';
        diameterInput.fire('input');
        check(`${layer} filled=${filled} typing after stepping stays unformatted`,
            diameterInput.value === '7.');
        if (layer !== 'hole') {
            widthInput.fire('pointerdown');
            widthInput.value = '0.5';
            widthInput.fire('input');
            check(`${layer} filled=${filled} pressed thickness spinner keeps two decimals`, widthInput.value === '0.50');
            widthInput.fire('pointerup');
            widthInput.fire('change');
            widthInput.fire('keydown', { key: 'ArrowDown' });
            widthInput.value = '0.4';
            widthInput.fire('input');
            check(`${layer} filled=${filled} thickness arrow key keeps two decimals`, widthInput.value === '0.40');
            widthInput.fire('keyup');
            widthInput.fire('keydown', { key: 'Backspace' });
            widthInput.value = '0.';
            widthInput.value = '';
            widthInput.fire('input');
            check(`${layer} filled=${filled} thickness backspace can clear the field`, widthInput.value === '');
            widthInput.value = '0.3';
            widthInput.fire('input');
            check(`${layer} filled=${filled} typed thickness is not reformatted`, widthInput.value === '0.3');
            widthInput.fire('change');
            check(`${layer} filled=${filled} committed thickness has two decimals`, widthInput.value === '0.30');
        }
    }
}
document.getElementById = originalGetElementById;

const filledRoundedRect = { ...roundedRemovalRect, filled: true };
const filledRectOutline = shapeOutline(filledRoundedRect);
check('filled rounded rectangle keeps the same outline centerline',
    Math.min(...filledRectOutline.map((point) => point.x)) === 0
    && Math.max(...filledRectOutline.map((point) => point.x)) === 10);
let renderedFilledShape = null;
const selectedFilledRect = { ...filledRoundedRect, copperMode: 'add' };
renderBoardShape({
    boardShapes: [selectedFilledRect],
    _shapeElements: new Map(),
    _pcbSelection: { isSelected() { return true; } },
    _getLayerGroup() { return { appendChild(element) { renderedFilledShape = element; } }; },
}, selectedFilledRect, { skipCopperUpdate: true });
check('selected filled shape changes its interior color',
    renderedFilledShape?.getAttribute('fill') === shapeSelectionColor(selectedFilledRect));
check('filled shape interior matches outline opacity',
    renderedFilledShape?.getAttribute('fill-opacity') === '1');
check('filled shape keeps its configured visible outline width',
    renderedFilledShape?.getAttribute('stroke-width') === String(selectedFilledRect.lineWidth));

let renderedRemovalShape = null;
renderBoardShape({
    boardShapes: [removalCircle],
    _shapeElements: new Map(),
    _getLayerGroup() { return { appendChild(element) { renderedRemovalShape = element; } }; },
}, removalCircle, { skipCopperUpdate: true });
check('copper-removal shape uses a thin outline independent of line width',
    renderedRemovalShape?.getAttribute('stroke-width') === '1'
    && renderedRemovalShape?.getAttribute('vector-effect') === 'non-scaling-stroke');
check('copper-removal display outline does not change physical cut width',
    resolveBoardShapeGeometry(removalCircle).lineWidth === removalCircle.lineWidth);
check('copper-removal outline follows the outside of its configured width',
    approx(Math.max(...flattenSvgPath(boardShapeRemovalPathD(removalCircle)).flat().map(point => point.x)), 8)
    && renderedRemovalShape?.getAttribute('d') === boardShapeRemovalPathD(removalCircle));
let renderedHoleCircle = null;
const holeCircle = { ...removalCircle, layer: 'hole' };
renderBoardShape({
    boardShapes: [holeCircle],
    _shapeElements: new Map(),
    _pcbSelection: { isSelected() { return false; } },
    _getLayerGroup() { return { appendChild(element) { renderedHoleCircle = element; } }; },
}, holeCircle, { skipCopperUpdate: true });
check('hole-layer circle display reaches the physical cutout edge',
    renderedHoleCircle?.getAttribute('d').includes('M 8 5'));
const removalLine = { ...removalRect, kind: 'line', points: removalRect.points.slice(0, 2) };
const removalLinePath = boardShapeRemovalPathD(removalLine);
check('open copper-removal Line has a closed width-aware perimeter', removalLinePath.endsWith('Z'));
let renderedHoleLine = null;
const holeLine = { ...removalLine, layer: 'hole' };
renderBoardShape({
    boardShapes: [holeLine],
    _shapeElements: new Map(),
    _pcbSelection: { isSelected() { return false; } },
    _getLayerGroup() { return { appendChild(element) { renderedHoleLine = element; } }; },
}, holeLine, { skipCopperUpdate: true });
check('hole-layer line fills its slot with the canvas background like other cutouts',
    renderedHoleLine?.getAttribute('fill') === 'var(--bg-canvas, #000000)'
    && renderedHoleLine?.getAttribute('fill') === renderedHoleCircle?.getAttribute('fill')
    && renderedHoleLine?.getAttribute('fill-opacity') === '1');
check('hole-layer line retains its width-aware perimeter and thin border',
    renderedHoleLine?.getAttribute('d') === boardShapeRemovalPathD(holeLine)
    && renderedHoleLine?.getAttribute('stroke-width') === renderedHoleCircle?.getAttribute('stroke-width'));
const removalLineCuts = boardShapeCopperCuts({ boardShapes: [removalLine] }, 'top-copper');
check('open copper-removal Line clip uses its width-aware perimeter',
    removalLineCuts.count === 1 && removalLineCuts.d.includes(removalLinePath));

const filledPolygon = { ...removalRect, kind: 'polygon', filled: true };
const filledPolygonOutline = shapeOutline(filledPolygon);
check('filled polygon keeps the same outline centerline',
    Math.min(...filledPolygonOutline.map((point) => point.x)) === 0
    && Math.max(...filledPolygonOutline.map((point) => point.x)) === 10);

for (const shape of [
    { ...removalRect, kind: 'line', points: removalRect.points.slice(0, 2) },
    removalRect,
    { ...removalRect, kind: 'polygon' },
    removalArc,
    removalCircle,
]) {
    const stroke = resolveBoardShapeGeometry(shape);
    const area = resolveBoardShapeGeometry(shape, { filled: true });
    check(`${shape.kind} resolver owns width and mode`,
        stroke.lineWidth === shape.lineWidth && stroke.copperMode === 'remove-copper');
    check(`${shape.kind} resolver separates centerline and area`,
        stroke.areaOutline === null
        && (shape.kind === 'line' ? area.areaOutline === null : area.areaOutline.length >= 3));
}
check('circle resolver exposes centerline and outer radii',
    resolveBoardShapeGeometry(removalCircle, { filled: true }).circle.radius === 2.8
    && resolveBoardShapeGeometry(removalCircle, { filled: true }).circle.outerRadius === 3);
for (const layer of ['top-mask', 'hole']) {
    const geometry = resolveBoardShapeGeometry({ ...removalRect, layer, filled: false });
    check(`${layer} area policy is owned by the resolver`, geometry.filled && geometry.areaOutline.length >= 3);
}
for (const layer of ['top-document', 'bottom-document']) {
    const outline = resolveBoardShapeGeometry({ ...removalRect, layer, filled: false });
    const filled = resolveBoardShapeGeometry({ ...removalRect, layer, filled: true });
    check(`${layer} honors the graphic fill setting`, !outline.filled && outline.areaOutline === null
        && filled.filled && filled.areaOutline.length >= 3);
}

const maskGerber = (shape) => exportGerbers({
    placements: new Map(),
    tracks: [],
    vias: [],
    boardWidth: 50,
    boardHeight: 40,
    boardShapes: [shape],
}).get('board.gts');
const maskDiameter = (gerber) => Number(/%ADD\d+C,([\d.]+)\*%/.exec(gerber)?.[1]);
const filledMaskCircle = { ...removalCircle, y: -5, filled: true, copperMode: 'remove-solder-mask' };
const filledCopperMaskCircle = { ...filledMaskCircle, copperMode: 'remove-copper-mask' };
const maskOnlyGerber = maskGerber(filledMaskCircle);
const copperMaskGerber = maskGerber(filledCopperMaskCircle);
check('filled mask-removal modes emit the same outer circle diameter',
    approx(maskDiameter(maskOnlyGerber), 6)
    && approx(maskDiameter(copperMaskGerber), 6));
check('filled mask-removal circles emit one area without a ring command',
    !maskOnlyGerber.includes('G03*') && !copperMaskGerber.includes('G03*'));
check('filled rectangle mask removal emits an area region',
    maskGerber({
        ...removalRect,
        points: removalRect.points.map((point) => ({ x: point.x, y: point.y - 10 })),
        filled: true,
        copperMode: 'remove-solder-mask',
    }).includes('G36*'));
const strokedRectMask = maskGerber({
    ...removalRect,
    points: removalRect.points.map((point) => ({ x: point.x, y: point.y - 10 })),
    copperMode: 'remove-solder-mask',
});
check('unfilled rectangle mask removal emits a sharp region with an inner opening',
    strokedRectMask.includes('G36*')
    && (strokedRectMask.match(/G36\*([\s\S]*?)G37\*/)?.[1].match(/D02\*/g) || []).length === 2);

const copperText = {
    id: 'text_1',
    content: 'I',
    x: 10,
    y: -10,
    size: 2,
    rotation: 0,
    layer: 'top-copper',
    strokeWidth: 0.3,
};
const topTextPoints = pcbTextPolylines(copperText).flat();
const bottomTextPoints = pcbTextPolylines({ ...copperText, layer: 'bottom-copper' }).flat();
check('shared PCB text geometry mirrors bottom copper only',
    topTextPoints.length === bottomTextPoints.length
    && approx(topTextPoints[0].x - copperText.x, -(bottomTextPoints[0].x - copperText.x)));
check('shared PCB text segments feed output backends', pcbTextSegments(copperText).length > 0);
const copperTextGerber = exportGerbers({
    placements: new Map(),
    tracks: [],
    vias: [],
    boardWidth: 50,
    boardHeight: 40,
    texts: [copperText],
}).get('board.gtl');
check('top-copper text is emitted as copper', copperTextGerber.includes('C,0.3*%'));
const holeSlotFiles = exportGerbers({
    placements: new Map(), tracks: [], vias: [],
    boardWidth: 50, boardHeight: 40,
    boardShapes: [{
        kind: 'line', layer: 'hole', lineWidth: 0.8,
        points: [{ x: 5, y: -5 }, { x: 15, y: -5 }],
    }],
});
const holeSlotDrill = holeSlotFiles.get('board-NPTH.drl') || '';
check('hole-layer line emits a non-plated routed slot',
    holeSlotDrill.includes('T1C0.800')
    && holeSlotDrill.includes('X5.000Y5.000G85X15.000Y5.000'));
check('selected PCB objects share their layer-derived color',
    shapeSelectionColor({ layer: 'top-copper' }) === pcbLayerSelectionColor('top-copper')
    && shapeSelectionColor(copperText) === pcbLayerSelectionColor('top-copper'));
check('hole hover and selection use distinct muted colors',
    shapeHoverColor({ layer: 'hole' }) === '#54948b'
    && shapeSelectionColor({ layer: 'hole' }) === '#78aba3');

const clipper = await loadClipper();
const testFill = {
    layer: 'top-copper',
    net: 'GND',
    outline: [{ x: -10, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 10 }, { x: -10, y: 10 }],
};
const fillHoles = (context) => computeFillPolygons(testFill, {
    tracks: [], vias: [], pads: [], boardShapes: [], texts: [], fills: [],
    params: { clearance: 0.5 }, board: null,
    ...context,
}, clipper).reduce((count, polygon) => count + polygon.holes.length, 0);
const pointInPath = (point, path) => {
    let inside = false;
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const a = path[i], b = path[j];
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
};
const fillContains = (polygons, point) => polygons.some((polygon) => (
    pointInPath(point, polygon.outer)
    && !polygon.holes.some((hole) => pointInPath(point, hole))
));
const copperRect = {
    ...removalRect,
    points: removalRect.points.map((point) => ({ x: point.x, y: point.y - 10 })),
    filled: true,
    copperMode: 'add',
};
check('unassigned copper shapes receive fill clearance', fillHoles({ boardShapes: [copperRect] }) > 0);
check('foreign-net copper shapes receive fill clearance',
    fillHoles({ boardShapes: [{ ...copperRect, net: 'VCC' }] }) > 0);
check('same-net copper shapes merge into the fill',
    fillHoles({ boardShapes: [{ ...copperRect, net: 'GND' }] }) === 0);
const unfilledCopperCircle = {
    ...removalCircle,
    y: -5,
    copperMode: 'add',
};
const circleFill = computeFillPolygons(testFill, {
    tracks: [], vias: [], pads: [], boardShapes: [unfilledCopperCircle], texts: [], fills: [],
    params: { clearance: 0.5 }, board: null,
}, clipper);
check('unfilled additive circle preserves pour inside its ring',
    fillContains(circleFill, { x: 5, y: -5 }));
check('unfilled additive circle clears the pour around its stroke',
    !fillContains(circleFill, { x: 8, y: -5 }));
check('copper-removal shapes are not copper clearance obstacles',
    fillHoles({ boardShapes: [{ ...copperRect, copperMode: 'remove-copper' }] }) === 0);
check('copper text receives fill clearance', fillHoles({ texts: [copperText] }) > 0);
const overlappingFill = {
    type: 'fill', layer: 'top-copper', net: 'VCC',
    outline: [{ x: 0, y: -15 }, { x: 10, y: -15 }, { x: 10, y: -5 }, { x: 0, y: -5 }],
};
check('foreign-net copper fills receive fill clearance', fillHoles({ fills: [overlappingFill] }) > 0);
check('same-net copper fills merge', fillHoles({ fills: [{ ...overlappingFill, net: 'GND' }] }) === 0);

if (failures) process.exit(1);