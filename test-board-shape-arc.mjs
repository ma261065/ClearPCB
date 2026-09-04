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
    boardShapeLineWidthMinimum,
    boardShapeArcGeometry,
    boardShapeCopperCuts,
    boardShapeRemovalPathD,
    circleFilledRadius,
    finishLineDraw,
    finishShapeDrawAtPoint,
    resolveBoardShapeGeometry,
    renderBoardShape,
    shapeOutline,
    shapePathD,
    shapeIsFilled,
    shapeSelectionColor,
    shapeDrawClick,
    showBoardShapeProperties,
} = await import('./src/pcb/modules/board-shapes.js');
const { exportGerbers } = await import('./src/pcb/modules/gerber.js');
const { pcbTextPolylines, pcbTextSegments } = await import('./src/pcb/modules/pcb-text.js');
const { pcbLayerSelectionColor } = await import('./src/pcb/modules/layers.js');
const { computeFillPolygons, loadClipper } = await import('./src/pcb/modules/copper-fill-geom.js');

let failures = 0;
function check(name, condition) {
    if (condition) console.log(`PASS ${name}`);
    else {
        console.error(`FAIL ${name}`);
        failures++;
    }
}

const approx = (a, b) => Math.abs(a - b) < 1e-9;
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
check('filled circle reaches the outside of its outline', approx(circleFilledRadius({ ...removalCircle, filled: true }), 3.2));

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
    boardShapeRemovalPathD(removalCircle).includes('M 8.2 5')
    && renderedRemovalShape?.getAttribute('d').includes('M 8.2 5'));
let renderedHoleCircle = null;
const holeCircle = { ...removalCircle, layer: 'hole' };
renderBoardShape({
    boardShapes: [holeCircle],
    _shapeElements: new Map(),
    _pcbSelection: { isSelected() { return false; } },
    _getLayerGroup() { return { appendChild(element) { renderedHoleCircle = element; } }; },
}, holeCircle, { skipCopperUpdate: true });
check('hole-layer circle display reaches the physical cutout edge',
    renderedHoleCircle?.getAttribute('d').includes('M 8.2 5'));
const removalLine = { ...removalRect, kind: 'line', points: removalRect.points.slice(0, 2) };
const removalLinePath = boardShapeRemovalPathD(removalLine);
check('open copper-removal Line has a closed width-aware perimeter', removalLinePath.endsWith('Z'));
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
    resolveBoardShapeGeometry(removalCircle, { filled: true }).circle.radius === 3
    && resolveBoardShapeGeometry(removalCircle, { filled: true }).circle.outerRadius === 3.2);
for (const layer of ['top-mask', 'document', 'hole']) {
    const geometry = resolveBoardShapeGeometry({ ...removalRect, layer, filled: false });
    check(`${layer} area policy is owned by the resolver`, geometry.filled && geometry.areaOutline.length >= 3);
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
    approx(maskDiameter(maskOnlyGerber), 6.4)
    && approx(maskDiameter(copperMaskGerber), 6.4));
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
check('unfilled rectangle mask removal emits a width stroke',
    approx(maskDiameter(strokedRectMask), 0.4) && !strokedRectMask.includes('G36*'));

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