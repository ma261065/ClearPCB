globalThis.document = {
    createElementNS() {
        return {
            setAttribute() {},
            removeAttribute() {},
            parentNode: null,
        };
    },
};
globalThis.window = { addEventListener() {} };

const {
    applyBoardShapeVertexResize,
    boardShapeArcGeometry,
    boardShapeCopperCuts,
    circleFilledRadius,
    shapeOutline,
    shapePathD,
    shapeIsFilled,
    shapeDrawClick,
} = await import('./src/pcb/modules/board-shapes.js');

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
shapeDrawClick(app, 'arc', { x: 10, y: 0 });
shapeDrawClick(app, 'arc', { x: 8, y: 3 });
const drawn = app.boardShapes[0];
check('drawn bulge is projected to the chord bisector', approx(drawn.bulge.x, 5) && approx(drawn.bulge.y, 3));

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
const filledArcGeometry = boardShapeArcGeometry(removalArc);
check('filled arc reaches outside its curved outline',
    Math.min(...filledArcOutline.map((point) => point.x)) < Math.min(...arcCenterline.map((point) => point.x))
    || Math.max(...filledArcOutline.map((point) => point.x)) > Math.max(...arcCenterline.map((point) => point.x))
    || Math.min(...filledArcOutline.map((point) => point.y)) < Math.min(...arcCenterline.map((point) => point.y))
    || Math.max(...filledArcOutline.map((point) => point.y)) > Math.max(...arcCenterline.map((point) => point.y)));
check('filled arc uses one concentric curve without chord jogs',
    filledArcOutline.length === 49
    && filledArcGeometry
    && approx(Math.hypot(
        filledArcOutline[0].x - filledArcGeometry.cx,
        filledArcOutline[0].y - filledArcGeometry.cy,
    ), filledArcGeometry.radius + removalArc.lineWidth / 2)
    && approx(Math.hypot(
        filledArcOutline.at(-1).x - filledArcGeometry.cx,
        filledArcOutline.at(-1).y - filledArcGeometry.cy,
    ), filledArcGeometry.radius + removalArc.lineWidth / 2));

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

const filledRoundedRect = { ...roundedRemovalRect, filled: true };
const filledRectOutline = shapeOutline(filledRoundedRect);
check('filled rounded rectangle reaches outside its outline',
    Math.min(...filledRectOutline.map((point) => point.x)) < -0.199
    && Math.max(...filledRectOutline.map((point) => point.x)) > 10.199);

const filledPolygon = { ...removalRect, kind: 'polygon', filled: true };
const filledPolygonOutline = shapeOutline(filledPolygon);
check('filled polygon reaches outside its outline',
    Math.min(...filledPolygonOutline.map((point) => point.x)) < -0.199
    && Math.max(...filledPolygonOutline.map((point) => point.x)) > 10.199);

if (failures) process.exit(1);