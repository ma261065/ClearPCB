/** Headless regression tests for Track-style generic-shape H/V/45 glow. */

globalThis.window = { addEventListener() {} };

function element(tagName) {
    return {
        tagName,
        attributes: new Map(),
        children: [],
        style: {},
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name) || null; },
        removeAttribute(name) { this.attributes.delete(name); },
        appendChild(child) { this.children.push(child); return child; },
        insertBefore(child, reference) {
            const index = this.children.indexOf(reference);
            if (index < 0) this.children.push(child);
            else this.children.splice(index, 0, child);
            return child;
        },
        remove() { this.removed = true; },
        querySelectorAll() { return []; },
        classList: { add() {} },
    };
}

globalThis.document = {
    createElementNS(_namespace, tagName) { return element(tagName); },
    getElementById() { return null; },
    querySelector() { return null; },
};

const { startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag, getBoardShapeAnchors, createBoardShapeSelectionAdapter,
    updateShapeDrawPreview, cancelShapeDraw, finishShapeDraw } = await import('../src/pcb/modules/board-shapes.js');
const { Viewport } = await import('../src/core/Viewport.js');
const { makeAxisGlowHalo } = await import('../src/pcb/modules/axis-glow.js');
const sharedGlow = await import('../src/shapes/axis-glow.js');
const { createLine, createRect } = await import('../src/shapes/polyline.js');
const wireGuides = await import('../src/schematic/modules/wire.js');
const { Arc } = await import('../src/shapes/arc.js');
const { renderShapeAlignment, snapShapePoint, snapShapeBulge, shapeContinuationConstraints, snapShapeDrawingPoint } = await import('../src/schematic/modules/shape-snap.js');
const { resolvePathPoint, pathContinuationConstraints, resolvePathTranslation, pathSegmentConstraints } = await import('../src/shapes/path-snap.js');
const { updatePolylineSegmentDrag } = await import('../src/schematic/modules/polyline-segment-drag.js');
const { clearDragState } = await import('../src/ui/modules/drag.js');
const { updatePreview, cancelDrawing } = await import('../src/ui/modules/drawing.js');
const { renderShapes } = await import('../src/schematic/modules/shape-management.js');

let failures = 0;

function expect(name, condition) {
    if (condition) {
        console.log(`PASS: ${name}`);
        return;
    }
    failures++;
    console.error(`FAIL: ${name}`);
}

function glowFor(point, scale = 1) {
    const overlay = element('g');
    const shape = {
        id: 'line_1',
        kind: 'line',
        layer: 'top-copper',
        lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    };
    const app = {
        boardShapes: [shape],
        viewport: { scale, setCrosshair() {} },
        _snapToGrid(value) { return value; },
        _getLayerGroup() { return overlay; },
        _shapeElements: new Map(),
    };
    startBoardShapeDrag(app, shape, { x: 0, y: 0 }, 0);
    handleBoardShapeDrag(app, point);
    return overlay.children.filter((child) => child.tagName === 'line');
}

function hasTrackStyleGlow(point, dashed) {
    const lines = glowFor(point);
    const halo = lines.find((line) => line.getAttribute('stroke') !== '#ffffff');
    const centerline = lines.find((line) => line.getAttribute('stroke') === '#ffffff');
    return !!halo && !!centerline
        && (dashed ? !!centerline.getAttribute('stroke-dasharray') : !centerline.getAttribute('stroke-dasharray'));
}

expect('horizontal snap shows the Track halo and solid centerline', hasTrackStyleGlow({ x: 0.1, y: 0.1 }, false));
expect('vertical snap shows the Track halo and solid centerline', hasTrackStyleGlow({ x: 10.1, y: 5 }, false));
expect('diagonal snap shows the Track halo and dashed centerline', hasTrackStyleGlow({ x: 5, y: 5.1 }, true));

for (const [name, target, expectedKind, diagonal] of [
    ['rectangle', { x: 0.05, y: 0.05 }, 'rect', false],
    ['horizontal', { x: 2.05, y: 0.05 }, 'polygon', false],
    ['vertical', { x: 0.05, y: 2.05 }, 'polygon', false],
    ['diagonal', { x: 4.05, y: 4.05 }, 'polygon', true],
]) {
    const overlay = element('g');
    const outer = [{ x: 1, y: 1 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }];
    const shape = { id: 'polygon-axis', kind: 'polygon', layer: 'top-copper', lineWidth: 0.4, points: outer };
    const expanded = getBoardShapeAnchors(shape).filter(anchor => !anchor.midpoint);
    shape.points = outer.map((point, index) => ({ x: 2 * point.x - expanded[index].x, y: 2 * point.y - expanded[index].y }));
    const app = {
        boardShapes: [shape], viewport: { scale: 20, snapToGrid: true, setCrosshair() {} },
        _snapToGrid(point) { return { x: Math.round(point.x), y: Math.round(point.y) }; },
        _getLayerGroup() { return overlay; }, _shapeElements: new Map(),
    };
    const anchor = getBoardShapeAnchors(shape)[0];
    startBoardShapeDrag(app, shape, anchor, 0);
    handleBoardShapeDrag(app, target);
    const moved = getBoardShapeAnchors(shape)[0];
    expect(`polygon ${name} alignment keeps the outer handle on grid`,
        Math.abs(moved.x - Math.round(moved.x)) < 1e-6 && Math.abs(moved.y - Math.round(moved.y)) < 1e-6);
    expect(`polygon ${name} alignment normalizes its kind correctly`, shape.kind === expectedKind);
    const lines = overlay.children.filter(child => child.tagName === 'line' && child.getAttribute('stroke') === '#ffffff');
    if (expectedKind === 'rect') {
        expect('rectangle conversion suppresses redundant H/V indicators', lines.length === 0);
    } else {
        expect(`polygon ${name} alignment displays its axis indicator`, lines.some(line =>
            diagonal ? !!line.getAttribute('stroke-dasharray') : !line.getAttribute('stroke-dasharray')));
    }
}

{
    const shape = { id: 'insert-midpoint', kind: 'rect', layer: 'top-copper', lineWidth: 2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }] };
    const overlay = element('g');
    const app = { boardShapes: [shape], viewport: { scale: 20, setCrosshair() {} },
        _shapeElements: new Map(), _getLayerGroup() { return overlay; }, _snapToGrid(point) { return point; } };
    const midpoint = getBoardShapeAnchors(shape).find(anchor => anchor.id === 'mid:0');
    expect('rectangle plus handle is on the centerline', midpoint.x === 5 && midpoint.y === 0);
    startBoardShapeDrag(app, shape, midpoint, midpoint.id);
    handleBoardShapeDrag(app, midpoint);
    expect('plus insertion has no half-width displacement', Math.abs(shape.points[1].x - 5) < 1e-9 && Math.abs(shape.points[1].y) < 1e-9);
}

{
    const overlay = element('g');
    const shape = {
        id: 'line_segment_drag',
        kind: 'line',
        layer: 'top-copper',
        lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    };
    const app = {
        boardShapes: [shape],
        viewport: { scale: 10, setCrosshair() {} },
        _snapToGrid(value) { return value; },
        _getLayerGroup() { return overlay; },
        _shapeElements: new Map(),
    };
    startBoardShapeDrag(app, shape, { x: 5, y: 0 });
    handleBoardShapeDrag(app, { x: 5, y: 3 });
    expect('translating a horizontal Line segment shows no orientation halo',
        !app._axisGlowHalos?.length && !app._axisGlowTop?.length);
}

for (const commit of [false, true]) {
    const classes = new Set();
    const viewport = {
        setCrosshair: Viewport.prototype.setCrosshair,
        hideCrosshair: Viewport.prototype.hideCrosshair,
        _positionCrosshair: Viewport.prototype._positionCrosshair,
        scale: 20, showRulers: false,
        svg: { classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } } },
        crosshairContainer: { style: {} },
        _crosshairXLine: element('line'), _crosshairYLine: element('line'),
        worldToScreen(point) { return { x: point.x * this.scale + 7, y: point.y * this.scale + 9 }; },
        _getCachedRect() { return { width: 800, height: 600 }; },
    };
    const shape = { id: 'placement-cursor', kind: 'rect', layer: 'top-copper', lineWidth: 2,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }] };
    const app = {
        boardShapes: [shape], viewport, _shapeElements: new Map(), _getLayerGroup() { return null; },
        _snapToGrid(point) { return point; }, history: { execute(command) { command.execute(); } },
    };
    const midpoint = getBoardShapeAnchors(shape).find(anchor => anchor.id === 'mid:0');
    startBoardShapeDrag(app, shape, midpoint, midpoint.id);
    const cursorAtNode = () => {
        const node = getBoardShapeAnchors(shape).find(anchor => anchor.id === 1);
        const screen = viewport.worldToScreen(node);
        return Number(viewport._crosshairYLine.getAttribute('x1')) === screen.x
            && Number(viewport._crosshairXLine.getAttribute('y1')) === screen.y;
    };
    expect('midpoint click retains the native pointer with crosshair on the path node',
        !classes.has('node-placement-cursor') && cursorAtNode());
    handleBoardShapeDrag(app, { x: 10, y: -3 });
    expect('crosshair follows the inserted path node', cursorAtNode());
    viewport.scale = 40;
    viewport._positionCrosshair();
    expect('crosshair follows zoom', cursorAtNode());
    endBoardShapeDrag(app, commit);
    expect(`${commit ? 'placement' : 'cancellation'} keeps native pointer and hides crosshair`,
        !classes.has('node-placement-cursor') && viewport.crosshairContainer.style.display === 'none');
}

for (const reversed of [false, true]) {
    for (let segment = 0; segment < 4; segment++) {
        const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }];
        if (reversed) points.reverse();
        const shape = { id: 'split-fixed-corners', kind: 'rect', layer: 'top-copper', lineWidth: 2, points };
        const originalAnchors = getBoardShapeAnchors(shape).filter(anchor => !anchor.midpoint);
        const midpoint = getBoardShapeAnchors(shape).find(anchor => anchor.id === `mid:${segment}`);
        const app = {
            boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
            viewport: { scale: 20, setCrosshair() {} }, _snapToGrid(point) { return point; },
        };
        startBoardShapeDrag(app, shape, midpoint, midpoint.id);
        for (const displacement of [3, -2, 0]) {
            const target = { x: midpoint.x, y: midpoint.y };
            if (Math.abs(midpoint.x - 10) < 1e-9) target.y += displacement;
            else target.x += displacement;
            handleBoardShapeDrag(app, target);
            const anchors = getBoardShapeAnchors(shape).filter(anchor => !anchor.midpoint);
            expect(`split side ${segment} reversed=${reversed} move=${displacement} fixes existing outer corners`,
                originalAnchors.every((anchor, index) => {
                    const actual = anchors[index > segment ? index + 1 : index];
                    return Math.hypot(actual.x - anchor.x, actual.y - anchor.y) < 1e-8;
                }));
            const inserted = anchors[segment + 1];
            expect(`split side ${segment} reversed=${reversed} move=${displacement} follows pointer exactly`,
                Math.hypot(inserted.x - target.x, inserted.y - target.y) < 1e-8);
        }
    }
}

for (const mode of ['move', 'segment', 'insert']) {
    const shape = { id: `crosshair-${mode}`, kind: 'rect', layer: 'top-copper', lineWidth: 4,
        points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 180 }, { x: 100, y: 180 }] };
    let crosshair = null;
    const app = {
        boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 20, setCrosshair(point) { crosshair = point; } },
        _snapToGrid(point) { return point; },
    };
    const start = mode === 'insert' ? { x: 150, y: 100 } : { x: 130, y: 98 };
    startBoardShapeDrag(app, shape, start, mode === 'insert' ? 'mid:0' : null, { allowSegment: mode === 'segment' });
    expect(`${mode} starts crosshair at grabbed point`, crosshair.x === start.x && crosshair.y === start.y);
    const target = { x: start.x, y: start.y - 5 };
    handleBoardShapeDrag(app, target);
    expect(`${mode} crosshair follows grabbed point`, Math.abs(crosshair.x - target.x) < 1e-9
        && Math.abs(crosshair.y - target.y) < 1e-9);
}

{
    const shape = { id: 'split-past-endpoint', kind: 'rect', layer: 'top-copper', lineWidth: 2,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }] };
    let crosshair;
    const app = {
        boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 1e9, setCrosshair(point) { crosshair = point; } },
        _snapToGrid(point) { return point; },
    };
    startBoardShapeDrag(app, shape, { x: 10, y: 0 }, 'mid:0');
    for (const height of [0, 0.001, -0.001, 1, -1]) {
        let stable = true;
        for (let position = -10; position <= 30; position += 0.5) {
            handleBoardShapeDrag(app, { x: position, y: height });
            stable &&= Math.hypot(crosshair.x - position, crosshair.y - height) < 1e-8
                && Math.hypot(crosshair.x - shape.points[1].x, crosshair.y - shape.points[1].y) < 1e-8
                && shape.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)
                    && Math.abs(point.x) < 100 && Math.abs(point.y) < 100);
        }
        expect(`split past both endpoints remains bounded at height=${height}`, stable);
    }
}

for (const variableWidth of [false, true]) {
    const shape = { id: 'segment-click', kind: 'rect', layer: 'top-copper', lineWidth: variableWidth ? 0.2 : 4,
        points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }],
        ...(variableWidth ? { segmentWidths: { 0: 4 } } : {}) };
    const app = {
        boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 20, setCrosshair() {}, hideCrosshair() {} },
        _snapToGrid(point) { return point; },
    };
    const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
    const startWorld = { x: 30, y: 1.9 };
    adapter.beginMove(startWorld, { alreadySelected: false });
    adapter.endMove(true, { moved: false, startWorld });
    adapter.beginMove(startWorld, { alreadySelected: true });
    adapter.endMove(true, { moved: false, startWorld });
    expect(`second click selects visible thick segment (variable width=${variableWidth})`, app._selectedBoardShapeSegment?.segment === 0);
}

for (const kind of ['arc', 'line']) {
    for (const width of [0.2, 4]) {
        const shape = { id: 'pcb-bulge-guides', kind, layer: 'top-silk', lineWidth: width,
            ...(kind === 'arc'
                ? { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: 2 } }
                : { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }], segmentBulges: { 0: 0.4 } }) };
        const overlay = element('g');
        const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return overlay; },
            viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; } };
        const handle = kind === 'arc' ? 'bulge' : 'bulge:0';
        startBoardShapeDrag(app, shape, { x: 5, y: 2 }, handle);
        handleBoardShapeDrag(app, { x: 5, y: 1 });
        expect('PCB bulge drag suppresses endpoint axis indicators', !app._axisGlowHalos?.length && !app._axisGlowTop?.length);
        handleBoardShapeDrag(app, { x: 5, y: 0.02 });
        expect('PCB near-zero bulge drag reaches exact zero', kind === 'arc' ? shape.bulge.y === 0 : shape.segmentBulges[0] === 0);
        expect('PCB straightening uses blue width-aware halo', app._axisGlowHalos?.[0]?.getAttribute('stroke') === '#0072B2'
            && Math.abs(Number(app._axisGlowHalos[0].getAttribute('stroke-width'))
                - (width + 2 * Math.max(4 / app.viewport.scale, width * 0.25))) < 1e-9);
        const previous = [...app._axisGlowHalos, ...app._axisGlowTop];
        handleBoardShapeDrag(app, { x: 5, y: -1 });
        expect('PCB dragging past straight clears the straightening indicator', !app._axisGlowHalos?.length
            && previous.every(node => node.removed));
        app.viewport.shiftHeld = true;
        handleBoardShapeDrag(app, { x: 5, y: 0.02 });
        expect('PCB Shift disables straightening snap', kind === 'arc' ? shape.bulge.y !== 0 : shape.segmentBulges[0] !== 0);
        endBoardShapeDrag(app, false);
        expect('PCB cancelling restores original curvature', kind === 'arc' ? shape.bulge.y === 2 : shape.segmentBulges[0] === 0.4);
    }
}

function haloForScale(scale) {
    return makeAxisGlowHalo({ viewport: { scale } }, {
        a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, width: 0.2,
    }, '#E69F00');
}

const haloAtScaleOne = haloForScale(100);
const haloAtScaleTwo = haloForScale(200);
expect('halo width is identical regardless of the drag start zoom',
    Math.abs(Number(haloAtScaleOne?.getAttribute('stroke-width')) - 0.3) < 1e-9
    && Math.abs(Number(haloAtScaleTwo?.getAttribute('stroke-width')) - 0.3) < 1e-9);

const haloAtLowZoom = haloForScale(0.5);
const lowZoomRing = (Number(haloAtLowZoom?.getAttribute('stroke-width')) - 0.2) / 2 * 0.5;
expect('halo retains a 4px-per-side floor at low zoom', lowZoomRing >= 3.999);

expect('PCB compatibility export uses the shared indicator renderer', makeAxisGlowHalo === sharedGlow.makeAxisGlowHalo);

for (const [name, points, color, pattern] of [
    ['horizontal', [{ x: 0, y: 0 }, { x: 10, y: 0 }], '#E69F00', null],
    ['vertical', [{ x: 0, y: 0 }, { x: 0, y: 10 }], '#E69F00', null],
    ['diagonal', [{ x: 0, y: 0 }, { x: 10, y: 10 }], '#CC79A7', '0.4 0.3'],
    ['collinear', [{ x: 0, y: 0 }, { x: 10, y: 3 }, { x: 20, y: 6 }], '#0072B2', '0.0005 0.3'],
]) {
    const shape = createLine({ points, lineWidth: 0.4 });
    const app = { viewport: { scale: 20, contentLayer: element('g') }, shapes: [], components: [] };
    const nodeIds = shape.getOrderedNodeIds();
    renderShapeAlignment(app, shape, [nodeIds[1]]);
    expect(`schematic ${name} uses shared halo color`, app._axisGlowHalos?.length === points.length - 1
        && app._axisGlowHalos.every(halo => halo.getAttribute('stroke') === color));
    expect(`schematic ${name} uses shared centerline pattern`, app._axisGlowTop?.length > 0
        && app._axisGlowTop.every(line => line.getAttribute('stroke-dasharray') === pattern));
    const previous = [...app._axisGlowHalos, ...app._axisGlowTop];
    const beforeWidth = Number(app._axisGlowHalos[0].getAttribute('stroke-width'));
    app.viewport.scale = 10;
    renderShapes(app);
    expect(`schematic ${name} redraw refreshes indicators`, previous.every(node => node.removed));
    expect(`schematic ${name} halo responds to zoom`, Number(app._axisGlowHalos[0].getAttribute('stroke-width')) > beforeWidth);
    const current = [...app._axisGlowHalos, ...app._axisGlowTop];
    clearDragState(app);
    expect(`schematic ${name} drag cleanup removes indicators`, current.every(node => node.removed)
        && app._axisGlowResolved === null && app._axisGlowTop === null);
}

{
    const shape = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], lineWidth: 0.4 });
    const edgeId = [...shape.edges.keys()][0];
    const app = { viewport: { scale: 20, contentLayer: element('g') } };
    shape.setEdgeAttr(edgeId, 'bulge', 0.5);
    renderShapeAlignment(app, shape, [shape.getOrderedNodeIds()[0]]);
    expect('curved schematic endpoint shows its chord axis', app._axisGlowTop.length === 1
        && app._axisGlowResolved[0].segment.axisKind === 'h');
    shape.setEdgeAttr(edgeId, 'bulge', 0);
    renderShapeAlignment(app, shape, [`bulge_${edgeId}`]);
    expect('straightening a schematic curved edge shows collinear indicator', app._axisGlowHalos[0]?.getAttribute('stroke') === '#0072B2');
    const arc = new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 0 } });
    renderShapeAlignment(app, arc, ['mid']);
    expect('straightening a standalone schematic arc shows collinear indicator', app._axisGlowHalos[0]?.getAttribute('stroke') === '#0072B2');
    for (const width of [0.2, 4]) {
        for (const scale of [1, 100]) {
            arc.lineWidth = width;
            app.viewport.scale = scale;
            renderShapeAlignment(app, arc, ['mid']);
            const haloWidth = Number(app._axisGlowHalos[0].getAttribute('stroke-width'));
            expect('standalone Arc straightening halo uses standard width-aware sizing',
                Math.abs(haloWidth - (width + 2 * Math.max(4 / scale, width * 0.25))) < 1e-9);
        }
    }
}

for (const end of [{ x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }]) {
    const shape = createLine({ points: [{ x: 0, y: 0 }, end, { x: end.x + 3, y: end.y + 7 }], lineWidth: 2 });
    const edgeId = [...shape.edges.keys()][0];
    shape.setEdgeAttr(edgeId, 'bulge', 0.5);
    const app = { viewport: { scale: 20, contentLayer: element('g') } };
    for (const nodeId of shape.getOrderedNodeIds().slice(0, 2)) {
        renderShapeAlignment(app, shape, [nodeId]);
        expect('either curved-segment endpoint shows its H/V/45 chord guide', app._axisGlowHalos.length === 1
            && app._axisGlowResolved[0].segment.axisKind && !app._axisGlowResolved[0].segment.collinear);
    }
    renderShapeAlignment(app, shape, [`bulge_${edgeId}`]);
    expect('curved-segment bulge drag hides endpoint guides', !app._axisGlowHalos.length);
    renderShapeAlignment(app, shape, [shape.getOrderedNodeIds()[0]], [edgeId]);
    expect('excluded curved segments do not show chord guides', !app._axisGlowHalos.length);
}

for (const standalone of [false, true]) {
    for (const scale of [20, 10000]) {
        const start = { x: 0.13, y: 0.27 }, end = { x: 10.13, y: 10.27 };
        const shape = standalone ? new Arc({ startPoint: start, endPoint: end })
            : createLine({ points: [start, end] });
        const handle = standalone ? 'mid' : `bulge_${[...shape.edges.keys()][0]}`;
        const app = { viewport: { scale, gridVisible: false, contentLayer: element('g') }, shapes: [], components: [] };
        const pointer = { x: 5.12, y: 5.28 };
        const snapped = snapShapeBulge(app, shape, handle, pointer);
        expect('near-zero bulge snaps exactly to the off-grid chord midpoint',
            Math.abs(snapped.x - 5.13) < 1e-12 && Math.abs(snapped.y - 5.27) < 1e-12);
        shape.moveAnchor(handle, snapped.x, snapped.y);
        renderShapeAlignment(app, shape, [handle]);
        expect('snapped bulge displays the blue straightening indicator',
            app._axisGlowHalos[0]?.getAttribute('stroke') === '#0072B2');
        const away = { x: 4.13, y: 6.27 };
        const curved = snapShapeBulge(app, shape, handle, away);
        expect('bulge outside straightening tolerance remains curved', curved.x === away.x && curved.y === away.y);
        app.viewport.shiftHeld = true;
        expect('Shift disables straightening snap', snapShapeBulge(app, shape, handle, pointer) === pointer);
    }
}

for (const end of [{ x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }]) {
    const arc = new Arc({ startPoint: { x: 0, y: 0 }, endPoint: end });
    arc.bulge = 0.5;
    const app = { viewport: { scale: 20, contentLayer: element('g') } };
    for (const handle of ['mid', 'bulge']) {
        renderShapeAlignment(app, arc, ['end']);
        expect('endpoint dragging retains its axis indicator', app._axisGlowHalos.length === 1);
        expect('standalone Arc endpoint guide uses normal width-aware sizing',
            Math.abs(Number(app._axisGlowHalos[0].getAttribute('stroke-width'))
                - (arc.lineWidth + 2 * Math.max(4 / app.viewport.scale, arc.lineWidth * 0.25))) < 1e-9);
        const previous = [...app._axisGlowHalos, ...app._axisGlowTop];
        renderShapeAlignment(app, arc, [handle]);
        expect('bulge dragging clears endpoint H/V/45 indicators', !app._axisGlowHalos.length
            && !app._axisGlowTop.length && previous.every(node => node.removed));
    }
}

{
    const shape = createLine({ points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }] });
    const edgeId = shape.getOrderedEdgeChain()[1].edgeId;
    const app = { components: [], shapes: [shape], viewport: { scale: 20, contentLayer: element('g'), gridVisible: false },
        drag: { shape, edgeId, beforeState: shape.captureState(), startWorldPos: { x: 5, y: 10 } } };
    updatePolylineSegmentDrag(app, { x: 5, y: 12 });
    expect('schematic segment dragging renders only adjoining alignment indicators', app._axisGlowResolved.length === 2
        && app._axisGlowResolved.every(({ segment }) => segment.axisKind === 'v'));
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }];
    expect('folded-back edges are not straight-through collinear pairs',
        sharedGlow.pathAlignmentSegments(points, false, [1]).every(segment => !segment.collinear));
}

{
    const app = { currentTool: 'line', isDrawing: true, linePoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        drawStart: { x: 0, y: 0 }, drawCurrent: { x: 20, y: 0 }, previewElement: element('g'),
        viewport: { scale: 20, contentLayer: element('g'), svg: element('svg') },
        toolOptions: { lineWidth: 0.2, color: '#ffffff' }, _hideCrosshair() {}, _setToolCursor() {} };
    updatePreview(app);
    expect('schematic drawing preview displays collinear continuation', app._axisGlowResolved.length === 2
        && app._axisGlowResolved.every(({ segment }) => segment.collinear));
    const previous = [...app._axisGlowHalos, ...app._axisGlowTop];
    cancelDrawing(app);
    expect('ending schematic drawing clears alignment indicators', previous.every(node => node.removed) && app._axisGlowResolved === null);
}

expect('legacy wire guide export delegates to the shared renderer', wireGuides.renderGuideLines === sharedGlow.renderGuideLines);

for (const [name, edge, collinear, axisKind] of [
    ['horizontal', { moving: { x: 0, y: 0.1 }, fixed: { x: 10, y: 0 } }, false, 'h'],
    ['vertical', { moving: { x: 0.1, y: 0 }, fixed: { x: 0, y: 10 } }, false, 'v'],
    ['horizontal collinear', { moving: { x: 0, y: 0.1 }, fixed: { x: 10, y: 0 }, beyond: { x: 20, y: 0 } }, true, undefined],
    ['oblique collinear', { moving: { x: 0, y: 0 }, fixed: { x: 10, y: 3 }, beyond: { x: 20, y: 6 } }, true, undefined],
]) {
    const result = wireGuides.computeMovingSegmentSnaps(0.5, [edge]);
    expect(`wire ${name} retains explicit guide semantics`, result.guides.length === 1
        && !!result.guides[0].collinear === collinear && result.guides[0].axisKind === axisKind);
    const app = { viewport: { scale: 20, contentLayer: element('g') } };
    sharedGlow.renderGuideLines(app, result.guides);
    expect(`wire ${name} uses the consolidated colors and patterns`, app._axisGlowHalos.length === 1
        && app._axisGlowHalos[0].getAttribute('stroke') === (collinear ? '#0072B2' : '#E69F00')
        && app._axisGlowTop[0].getAttribute('stroke-dasharray') === (collinear ? '0.0005 0.3' : null));
    const previous = [...app._axisGlowHalos, ...app._axisGlowTop];
    sharedGlow.renderGuideLines(app, []);
    expect(`wire ${name} clears obsolete guides`, previous.every(node => node.removed) && !app._axisGlowResolved.length);
    expect(`wire ${name} never creates the old guide pool`, !Object.hasOwn(app, '_collinearGuides'));
}

{
    const shape = createRect({ x: 0, y: 0, width: 10, height: 10, cornerRadius: 2 });
    const app = { viewport: { scale: 20, contentLayer: element('g') } };
    const corner = shape.getOrderedNodeIds()[0];
    renderShapeAlignment(app, shape, [corner]);
    expect('square anchor editing uses exactly four shared indicators', app._axisGlowResolved.length === 4
        && app._axisGlowResolved.every(({ segment }) => segment.square));
    expect('square feedback remains blue with a solid centerline', app._axisGlowHalos.every(line => line.getAttribute('stroke') === '#0072B2')
        && app._axisGlowTop.every(line => !line.getAttribute('stroke-dasharray')));
    const previous = [...app._axisGlowHalos, ...app._axisGlowTop];
    shape.moveAnchor(corner, -2, 0);
    renderShapeAlignment(app, shape, [corner]);
    expect('leaving square aspect clears indicators without redundant H/V guides', previous.every(node => node.removed)
        && app._axisGlowResolved.length === 0);
    clearDragState(app);
    expect('square editing cleanup uses the shared lifecycle', app._axisGlowResolved === null);
}

{
    const app = { currentTool: 'rect', isDrawing: true, drawStart: { x: 0, y: 0 }, drawCurrent: { x: 10, y: 10 },
        previewElement: element('g'), viewport: { scale: 20, contentLayer: element('g'), svg: element('svg') },
        toolOptions: { lineWidth: 0.2, color: '#ffffff' }, _hideCrosshair() {}, _setToolCursor() {} };
    updatePreview(app);
    expect('square preview uses one shared outline', app._axisGlowResolved.length === 4
        && app._axisGlowResolved.every(({ segment }) => segment.square));
    app.drawCurrent = { x: 12, y: 10 };
    updatePreview(app);
    expect('non-square preview suppresses redundant H/V indicators', app._axisGlowResolved.length === 0);
    cancelDrawing(app);
    expect('rectangle preview cancellation clears consolidated guides', app._axisGlowResolved === null);
}

for (const commit of [false, true]) {
    const layer = element('g');
    const app = {
        viewport: { scale: 20, shiftHeld: true }, activeLayer: 'top-silk',
        _shapeDefaults: { lineWidth: 0.4 }, _shapeIdCounter: 0,
        _getLayerGroup() { return layer; }, history: { execute() {} },
        _shapeDraw: { kind: 'rect', layer: 'top-silk', points: [{ x: 0, y: 0 }], preview: element('path') },
    };
    updateShapeDrawPreview(app, { x: 10, y: 10 });
    expect('PCB square drawing displays all four sides on the correct layer', app._axisGlowResolved.length === 4
        && app._axisGlowResolved.every(({ segment }) => segment.square && segment.layerId === 'top-silk'));
    expect('PCB square drawing uses the shared blue solid style', app._axisGlowHalos.every(line => line.getAttribute('stroke') === '#0072B2')
        && app._axisGlowTop.every(line => !line.getAttribute('stroke-dasharray')));
    updateShapeDrawPreview(app, { x: -10, y: -10 });
    expect('PCB square preview handles reversed corners', app._axisGlowResolved.length === 4);
    updateShapeDrawPreview(app, { x: 10, y: 10 + Number.EPSILON * 10 });
    expect('PCB square preview tolerates floating-point roundoff', app._axisGlowResolved.length === 4);
    const squareOutline = [...app._axisGlowHalos, ...app._axisGlowTop];
    updateShapeDrawPreview(app, { x: 10, y: 10.000001 });
    expect('PCB nearly square preview clears indicators without H/V guides', !app._axisGlowResolved.length
        && squareOutline.every(node => node.removed));
    updateShapeDrawPreview(app, { x: -10, y: -10.049 });
    expect('PCB square preview rejects the former visual tolerance', !app._axisGlowResolved.length);
    updateShapeDrawPreview(app, { x: 0, y: 0 });
    expect('PCB degenerate preview has no square indicator', !app._axisGlowResolved.length);
    updateShapeDrawPreview(app, { x: 10, y: 10 });
    const previous = [...app._axisGlowHalos, ...app._axisGlowTop];
    if (commit) {
        app._shapeDraw.points.push({ x: 10, y: 10 });
        finishShapeDraw(app);
    } else cancelShapeDraw(app);
    expect(`PCB rectangle drawing ${commit ? 'completion' : 'cancellation'} clears the indicator`,
        app._axisGlowResolved === null && app._shapeDraw === null && previous.every(node => node.removed));
}

for (const mode of ['corner', 'segment', 'move']) {
    for (const commit of [false, true]) {
        const height = mode === 'move' ? 10 : 8;
        const shape = { id: `square-${mode}`, kind: 'rect', layer: 'top-copper', lineWidth: 0.4,
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: height }, { x: 0, y: height }] };
        const layer = element('g');
        const app = {
            boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return layer; },
            viewport: { scale: 20, shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
            _snapToGrid(point) { return point; }, history: { execute() {} },
        };
        const start = mode === 'corner' ? { x: 0, y: 0 } : mode === 'segment' ? { x: 5, y: 0 } : { x: 3, y: 3 };
        const target = mode === 'corner' ? { x: 0, y: -2 } : mode === 'segment' ? { x: 5, y: -2 } : { x: 4, y: 4 };
        startBoardShapeDrag(app, shape, start, mode === 'corner' ? 0 : null,
            { whole: mode !== 'corner', allowSegment: mode === 'segment' });
        handleBoardShapeDrag(app, target);
        expect(`PCB ${mode} drag shows the full square indicator`, app._axisGlowResolved.length === 4
            && app._axisGlowResolved.every(({ segment }) => segment.square));
        if (mode !== 'move') {
            handleBoardShapeDrag(app, { x: target.x, y: target.y - 1 });
            expect(`PCB ${mode} drag suppresses indicators outside square aspect`, !app._axisGlowResolved.length);
            handleBoardShapeDrag(app, target);
        }
        const previous = [...app._axisGlowHalos, ...app._axisGlowTop];
        endBoardShapeDrag(app, commit);
        expect(`PCB ${mode} drag ${commit ? 'completion' : 'cancellation'} clears square indicators`,
            app._axisGlowResolved === null && previous.every(node => node.removed));
    }
}

for (const height of [8, 10]) {
    const shape = { id: 'rectangle-square-snap', kind: 'rect', layer: 'top-copper', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: height }, { x: 0, y: height }] };
    const layer = element('g');
    const app = {
        boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return layer; },
        viewport: { scale: 20, shiftHeld: false, snapToGrid: false, setCrosshair() {}, hideCrosshair() {} },
        _snapToGrid(point) { return point; }, history: { execute() {} },
    };
    startBoardShapeDrag(app, shape, { x: 0, y: 0 }, 0);
    const target = { x: 0.1, y: height - 9.8 };
    handleBoardShapeDrag(app, target);
    const width = Math.abs(shape.points[2].x - shape.points[0].x);
    const actualHeight = Math.abs(shape.points[2].y - shape.points[0].y);
    expect(`PCB corner snaps ${height === 10 ? 'an existing square' : 'a rectangle'} to exact square geometry`,
        Math.abs(width - actualHeight) < 1e-9 && Math.abs(shape.points[0].x - 0.1) < 1e-9
        && app._axisGlowResolved.length === 4);
    expect('square snapping preserves the fixed opposite corner', shape.points[2].x === 10 && shape.points[2].y === height);
    handleBoardShapeDrag(app, { x: 0.1, y: height - 9.3 });
    expect('PCB corner releases square snapping beyond the alignment threshold', !app._axisGlowResolved.length
        && Math.abs(shape.points[0].y - (height - 9.3)) < 1e-9);
    app.viewport.shiftHeld = true;
    handleBoardShapeDrag(app, target);
    expect('Shift bypasses square snapping and removes the square indicator', shape.points[0].x === target.x
        && shape.points[0].y === target.y && !app._axisGlowResolved.length);
    endBoardShapeDrag(app, false);
}

for (const index of [0, 2]) {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 3 }, { x: 20, y: 6 }];
    const segments = sharedGlow.pathAlignmentSegments(points, false, [index]);
    expect(`endpoint ${index} detects collinearity at its neighboring junction`, segments.length === 2
        && segments.every(segment => segment.collinear));
    const curved = sharedGlow.pathAlignmentSegments(points, false, [index], [], [0.5, 0]);
    expect(`endpoint ${index} does not report a curved neighbor as collinear`, !curved.some(segment => segment.collinear));
    const folded = sharedGlow.pathAlignmentSegments([points[0], points[1], points[0]], false, [index]);
    expect(`endpoint ${index} does not report folded-back segments as collinear`, !folded.some(segment => segment.collinear));
    const excluded = sharedGlow.pathAlignmentSegments(points, false, [index], [], [], [0]);
    expect(`endpoint ${index} preserves segment exclusions`, excluded.length === 1 && excluded[0].collinear
        && excluded[0].a === points[1]);

    const schematic = createLine({ points, lineWidth: 0.4 });
    const schematicApp = { viewport: { scale: 20, contentLayer: element('g'), gridVisible: false } };
    const nodeId = schematic.getOrderedNodeIds()[index];
    const cursor = { x: points[index].x, y: points[index].y + 0.15 };
    const snapped = snapShapePoint(schematicApp, cursor, [points[1]], shapeContinuationConstraints(schematic, nodeId));
    expect(`schematic endpoint ${index} snaps to an oblique continuation`, Math.abs(snapped.y * 10 - snapped.x * 3) < 1e-9);
    schematic.moveAnchor(nodeId, snapped.x, snapped.y);
    renderShapeAlignment(schematicApp, schematic, [schematic.getOrderedNodeIds()[index]]);
    expect(`schematic endpoint ${index} shows blue dotted collinear feedback`, schematicApp._axisGlowResolved.length === 2
        && schematicApp._axisGlowResolved.every(({ dashKind }) => dashKind === 'dotted')
        && schematicApp._axisGlowHalos.every(halo => halo.getAttribute('stroke') === '#0072B2'));

    const shape = { id: 'collinear-endpoint', kind: 'line', layer: 'top-copper', lineWidth: 0.4,
        points: points.map(point => ({ ...point })) };
    shape.points[index].y += 1;
    const layer = element('g');
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return layer; },
        viewport: { scale: 20, shiftHeld: false, snapToGrid: false, setCrosshair() {}, hideCrosshair() {} },
        _snapToGrid(point) { return point; },
        history: { execute() {} } };
    startBoardShapeDrag(app, shape, shape.points[index], index);
    handleBoardShapeDrag(app, cursor);
    expect(`PCB endpoint ${index} snaps to exact oblique geometry`, Math.abs(shape.points[index].y * 10 - shape.points[index].x * 3) < 1e-9);
    expect(`PCB endpoint ${index} shows both collinear segments`, app._axisGlowResolved.length === 2
        && app._axisGlowResolved.every(({ segment, dashKind }) => segment.collinear && dashKind === 'dotted'));
    handleBoardShapeDrag(app, { x: points[index].x, y: points[index].y + 1 });
    expect(`PCB endpoint ${index} clears feedback when no longer aligned`, !app._axisGlowResolved.length);
    endBoardShapeDrag(app, false);
}

{
    const layer = element('g');
    const app = { viewport: { scale: 20, shiftHeld: false, snapToGrid: false }, _shapeDefaults: { lineWidth: 0.4 },
        _snapToGrid(point) { return point; },
        _getLayerGroup() { return layer; },
        _shapeDraw: { kind: 'line', layer: 'top-copper', points: [{ x: 0, y: 0 }, { x: 10, y: 3 }], preview: element('path') } };
    updateShapeDrawPreview(app, { x: 20, y: 6.15 });
    expect('PCB drawing preview shows collinear continuation', app._axisGlowResolved.length === 2
        && app._axisGlowResolved.every(({ segment, dashKind }) => segment.collinear && dashKind === 'dotted'));
    updateShapeDrawPreview(app, { x: 20, y: 7 });
    expect('PCB drawing preview clears collinear feedback off alignment', !app._axisGlowResolved.length);
    cancelShapeDraw(app);
    expect('PCB line drawing cancellation clears alignment feedback', app._axisGlowResolved === null);
}

{
    const points = [{ x: 0, y: 0 }, { x: 10, y: 3 }, { x: 20, y: 6.15 }];
    const constraints = pathContinuationConstraints(points, false, 2);
    const target = { x: 20.1, y: 6.2 };
    const resolved = resolvePathPoint(points[2], [points[1]], points[2], 0.4, target, constraints);
    expect('connection target wins over collinear continuation', resolved.x === target.x && resolved.y === target.y);
    expect('curved preceding segments are not continuation snap targets',
        !pathContinuationConstraints(points, false, 2, [0.5, 0]).length);
    expect('curved moving segments are not continuation snap targets',
        !pathContinuationConstraints(points, false, 2, [0, 0.5]).length);
    const folded = { x: 5, y: 1.65 };
    const noFold = resolvePathPoint(folded, [points[1]], folded, 0.4, null, constraints);
    expect('continuation snapping does not fold an edge back over its neighbor', noFold.x === folded.x && noFold.y === folded.y);
    for (const kind of ['line', 'polygon']) {
        const app = { currentTool: kind, isDrawing: true, linePoints: points.slice(0, 2), polygonPoints: points.slice(0, 2),
            viewport: { scale: 20, shiftHeld: false, gridVisible: false } };
        const snapped = snapShapeDrawingPoint(app, points[2]);
        expect(`schematic ${kind} drawing snaps to an oblique continuation`, Math.abs(snapped.y * 10 - snapped.x * 3) < 1e-9);
        app.viewport.shiftHeld = true;
        const free = snapShapeDrawingPoint(app, points[2]);
        expect(`Shift bypasses schematic ${kind} continuation snapping`, free.x === points[2].x && free.y === points[2].y);
    }
}

{
    const points = [{ x: 0, y: 0 }, { x: 10, y: 3 }, { x: 20, y: 6 }, { x: 28, y: 15 }];
    const delta = { x: 0, y: 0.05 };
    const constraints = pathSegmentConstraints(points, false, 2);
    const snapped = resolvePathTranslation(points.slice(2), delta, [], constraints, 0.08, () => null, point => point);
    const onContinuation = point => Math.abs(point.y * 10 - point.x * 3) < 1e-9;
    expect('segment translation snaps onto an oblique continuation', onContinuation({ x: 20 + snapped.x, y: 6 + snapped.y }));
    expect('curved outer edge excludes a continuation', pathSegmentConstraints(points, false, 2, [0.3])[0].continuations.length === 0);
    const curved = pathSegmentConstraints(points, false, 2, [0, 0.3]);
    expect('curved adjacent edge excludes both axis and continuation constraints', !curved[0].neighbours.length && !curved[0].continuations.length);
    expect('closed triangle does not use another moving endpoint as a fixed continuation',
        pathSegmentConstraints(points.slice(0, 3), true, 0).every(constraint => constraint.continuations.length === 0));
    const connected = resolvePathTranslation(points.slice(2), delta, [], constraints, 0.08,
        point => ({ x: point.x + 0.02, y: point.y + 0.02 }), point => point);
    expect('connection snaps take priority during segment translation', Math.abs(connected.x - 0.02) < 1e-9 && Math.abs(connected.y - 0.07) < 1e-9);
    const competing = [...constraints, { index: 1, neighbours: [{ x: 28, y: 50 }], continuations: [] }];
    const priority = resolvePathTranslation(points.slice(2), delta, [], competing, 0.08, () => null, point => point);
    expect('continuation beats an exact axis match at the other endpoint', onContinuation({ x: 20 + priority.x, y: 6 + priority.y }));
    for (const reversed of [false, true]) {
        const shape = createLine({ points });
        const edgeId = [...shape.edges.keys()][2];
        const edge = shape.edges.get(edgeId);
        if (reversed) [edge.from, edge.to] = [edge.to, edge.from];
        const app = { shapes: [shape], components: [], contentLayer: element('g'),
            viewport: { scale: 100, gridVisible: false },
            drag: { shape, edgeId, beforeState: shape.captureState(), startWorldPos: { x: 24, y: 10.5 } } };
        updatePolylineSegmentDrag(app, { x: 24, y: 10.55 });
        expect(`schematic segment continuation handles reversed=${reversed}`, onContinuation(shape.nodes.get('n2')));
        app.viewport.shiftHeld = true;
        updatePolylineSegmentDrag(app, { x: 24, y: 10.55 });
        expect('Shift bypasses schematic segment continuation snapping', Math.abs(shape.nodes.get('n2').y - 6.05) < 1e-9);
        app.viewport.shiftHeld = false;
        updatePolylineSegmentDrag(app, { x: 24, y: 12.5 });
        expect('schematic segment releases the continuation outside the snap band', Math.abs(shape.nodes.get('n2').y - 8) < 1e-9);
    }
    const shape = { id: 'segment-continuation', kind: 'line', layer: 'top-silk', lineWidth: 0.2, points: points.map(point => ({ ...point })) };
    const app = { boardShapes: [shape], viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} },
        _getLayerGroup() { return null; }, _snapToGrid(point) { return point; }, _shapeElements: new Map() };
    startBoardShapeDrag(app, shape, { x: 24, y: 10.5 }, null, { allowSegment: true });
    handleBoardShapeDrag(app, { x: 24, y: 10.55 });
    expect('PCB segment uses the same oblique continuation snap', onContinuation(shape.points[2]));
    app.viewport.shiftHeld = true;
    handleBoardShapeDrag(app, { x: 24, y: 10.55 });
    expect('Shift bypasses PCB segment continuation snapping', Math.abs(shape.points[2].y - 6.05) < 1e-9);
    endBoardShapeDrag(app, false);
    expect('cancelling PCB segment movement restores its original points', JSON.stringify(shape.points) === JSON.stringify(points));
}

if (failures) process.exitCode = 1;