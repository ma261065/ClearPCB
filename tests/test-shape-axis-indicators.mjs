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
        remove() {},
        querySelectorAll() { return []; },
        classList: { add() {} },
    };
}

globalThis.document = {
    createElementNS(_namespace, tagName) { return element(tagName); },
    getElementById() { return null; },
    querySelector() { return null; },
};

const { startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag, getBoardShapeAnchors, createBoardShapeSelectionAdapter } = await import('../src/pcb/modules/board-shapes.js');
const { Viewport } = await import('../src/core/Viewport.js');
const { makeAxisGlowHalo } = await import('../src/pcb/modules/axis-glow.js');

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
    expect(`polygon ${name} alignment displays its axis indicator`, lines.some(line =>
        diagonal ? !!line.getAttribute('stroke-dasharray') : !line.getAttribute('stroke-dasharray')));
    if (expectedKind === 'rect') {
        expect('rectangle conversion displays both adjacent edge indicators', lines.length === 2);
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

if (failures) process.exitCode = 1;