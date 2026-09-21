import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
let contextMenu = null;
globalThis.document = {
    getElementById(id) { return id === 'pcbBoardShapeContextMenu' ? contextMenu : null; },
    querySelector() { return null; }, addEventListener() {}, removeEventListener() {},
    body: { appendChild(element) { contextMenu = element; } },
    createElement() { return this.createElementNS(); },
    createElementNS() {
        const attributes = new Map();
        const listeners = new Map();
        return { style: {}, children: [], dataset: {},
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name); }, removeAttribute(name) { attributes.delete(name); },
            addEventListener(name, callback) { listeners.set(name, callback); },
            click() { listeners.get('click')?.(); },
            appendChild(element) { this.children.push(element); },
            remove() { if (contextMenu === this) contextMenu = null; }, querySelectorAll() { return []; } };
    },
};
const { resolveBoardShapeGeometry, getBoardShapeAnchors, boardShapeHitTest,
    boardShapeBounds, serializeBoardShapes, loadBoardShapes, cloneShapeGeometry,
    createBoardShapeSelectionAdapter, startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag,
    showBoardShapeProperties, showBoardShapeContextMenu, setBoardShapeSegmentType, shapePathD } = await import('../src/pcb/modules/board-shapes.js');
const { reconcileRatsnest } = await import('../src/pcb/modules/track-draw.js');
const { cancelPictureCopperRefresh } = await import('../src/pcb/modules/picture-refresh.js');
const { updateSelectionInteraction, finishSelectionInteraction, placeFloatingSelectionInteraction } =
    await import('../src/pcb/modules/selection-interaction.js');

{
    const { rectangleBoardOutline, boardBoundary, validBoardOutline } = await import('../src/pcb/modules/board-outline.js');
    const { openBoardShape, deleteBoardShapeSegment, deleteBoardShapeVertex } = await import('../src/pcb/modules/board-shapes.js');
    const { RemoveBoardShapeCommand, AddBoardShapeCommand, MoveBoardShapeCommand } = await import('../src/pcb/modules/shape-commands.js');
    const { preparePcb } = await import('../src/pcb/modules/project-state.js');
    const { computeFillPolygons, loadClipper } = await import('../src/pcb/modules/copper-fill-geom.js');
    const { pointInPolygon } = await import('../src/core/geometry.js');
    const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
    const shape = rectangleBoardOutline(20, 10, 1);
    const commands = [];
    const app = { boardShapes: [shape], _shapeElements: new Map(), tracks: [], vias: [], placements: new Map(),
        texts: new Map(), viewport: { scale: 20, hideCrosshair() {}, setCrosshair() {} },
        _getLayerGroup() { return null; }, _snapToGrid(point) { return point; },
        history: { execute(command) { commands.push(command); command.execute(); } } };
    assert.equal(validBoardOutline(shape), true);
    assert.equal(openBoardShape(app, shape, 0), false);
    new RemoveBoardShapeCommand(app, shape).execute();
    new AddBoardShapeCommand(app, rectangleBoardOutline(5, 5)).execute();
    assert.deepEqual(app.boardShapes, [shape], 'The board boundary cannot be removed or duplicated');
    const original = cloneShapeGeometry(shape);
    const invalid = { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] };
    new MoveBoardShapeCommand(app, shape, original, invalid).execute();
    assert.deepEqual(cloneShapeGeometry(shape), original, 'Invalid edits restore the prior closed boundary');
    assert.equal(startBoardShapeDrag(app, shape, { x: 10, y: -10 }, 'mid:0'), true);
    handleBoardShapeDrag(app, { x: 10, y: -12 });
    endBoardShapeDrag(app, true);
    assert.equal(shape.kind, 'polygon');
    assert.equal(shape.points.length, 5);
    assert.equal(validBoardOutline(shape), true);
    commands.at(-1).undo();
    assert.equal(shape.kind, 'rect');
    assert.deepEqual(cloneShapeGeometry(shape), original);
    shape.cornerRadius = 0;
    assert.equal(deleteBoardShapeSegment(app, shape, 0), true);
    assert.equal(shape.kind, 'polygon');
    assert.equal(shape.points.length, 3);
    assert.equal(deleteBoardShapeVertex(app, shape, 0), false);
    assert.equal(deleteBoardShapeSegment(app, shape, 0), false);
    assert.equal(validBoardOutline(shape), true);
    commands.at(-1).undo();
    assert.equal(shape.points.length, 4);
    for (const outline of [shape, { id: 'board-outline', layer: 'board-outline', kind: 'circle', x: 40, y: 30, radius: 5 },
        { ...rectangleBoardOutline(20, 10), kind: 'polygon', points: [
            { x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 15 },
            { x: 20, y: 15 }, { x: 20, y: 20 }, { x: 10, y: 20 }] }]) {
        const saved = serializeBoardShapes({ boardShapes: [outline] });
        const loaded = preparePcb({ boardShapes: saved }).boardShapes[0];
        assert.equal(validBoardOutline(loaded), true);
        assert.deepEqual(cloneShapeGeometry(loaded), cloneShapeGeometry(outline));
        const bounds = boardBoundary({ boardShapes: [outline] });
        await loadClipper();
        const poured = computeFillPolygons({ layer: 'top-copper', outline: [
            { x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }] },
        { board: bounds, params: { clearance: 0.2 } });
        assert.ok(poured.length > 0);
        assert.ok(poured.flatMap(region => region.outer).every(point => pointInPolygon(point, bounds.points)));
        const profile = exportGerbers({ placements: new Map(), boardShapes: [outline] }).get('board.gko');
        const first = bounds.points[0];
        if (outline.kind === 'circle') {
            assert.match(profile, /X35000000Y-30000000I5000000J0D01/);
        } else {
            const coordinate = `X${Math.round(first.x * 1e6)}Y${Math.round(-first.y * 1e6)}`;
            assert.ok(profile.includes(`${coordinate}D02*`));
            assert.ok(profile.includes(`${coordinate}D01*`), 'Gerber closes the actual contour');
        }
    }
    assert.throws(() => preparePcb({ boardShapes: [shape, shape] }), /board outline/);
    assert.throws(() => preparePcb({ boardShapes: [{ ...shape, kind: 'line' }] }), /board outline/);
    assert.equal(validBoardOutline({ ...shape, points: shape.points.slice(0, 3) }), false);
    assert.equal(validBoardOutline({ ...shape, points: [null, ...shape.points.slice(1)] }), false);
    assert.equal(validBoardOutline({ ...shape, kind: 'polygon', points: [shape.points[0], ...shape.points] }), false);
    assert.equal(validBoardOutline({ ...shape, kind: 'polygon', points: [
        { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }] }), false);
    cancelPictureCopperRefresh(app);
}

{
    const endpoints = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const shape = { id: 'standalone', kind: 'line', layer: 'top-copper', net: 'GND',
        lineWidth: 0.4, segmentWidths: { 0: 0.7 }, points: structuredClone(endpoints) };
    const remote = { id: 'remote', kind: 'circle', layer: 'top-copper', net: 'GND',
        x: 30, y: 0, radius: 1, filled: true, lineWidth: 0.2 };
    const commands = [];
    let title = '';
    const ratLayer = { children: [], appendChild(element) {
        this.children.push(element);
        element.remove = () => { this.children.splice(this.children.indexOf(element), 1); };
    } };
    const app = {
        boardShapes: [shape, remote], placements: new Map(), tracks: [], vias: [], texts: new Map(), netlist: [],
        _shapeElements: new Map(), viewport: { scale: 20, setCrosshair() {}, hideCrosshair() {} },
        _getLayerGroup(layer) { return layer === 'ratlines' ? ratLayer : null; },
        _pcbPropsItems() { return { innerHTML: '' }; }, _setPcbPropsTitle(value) { title = value; },
        _setActiveRibbonTab() {}, _snapToGrid(point) { return point; },
        _updateRatsnest(options) { reconcileRatsnest(this, options); },
        history: { execute(command) { commands.push(command); command.execute(); } },
    };
    for (const [kind, label] of [['arc', 'Arc'], ['line', 'Line']]) {
        showBoardShapeContextMenu(app, shape, 0, 0, { x: 3, y: 0 });
        assert.equal(contextMenu.children[0].textContent, `Convert to ${label} Segment`);
        contextMenu.children[0].click();
        if (kind === 'arc') {
            assert.equal(app._pcbSelectionInteraction?.mode, 'floating-anchor');
            assert.equal(app._pcbSelectionInteraction.anchorId, 'bulge');
            assert.deepEqual(shape.bulge, { x: 5, y: 1.25 }, 'Conversion begins floating at the actual bulge anchor');
            updateSelectionInteraction(app, { x: 5, y: -2.5 });
            assert.deepEqual(shape.bulge, { x: 5, y: -2.5 }, 'Converted bulge follows the cursor');
            finishSelectionInteraction(app, false);
            assert.equal(app._pcbSelectionInteraction, null);
            assert.equal(shape.kind, 'line', 'Cancelling conversion restores the original line');
            assert.equal(title, 'Line Segment');
            assert.deepEqual(shape.points, endpoints);
            assert.deepEqual(shape.segmentWidths, { 0: 0.7 });
            assert.equal(commands.length, 0, 'Cancelled conversion creates no history entry');
            showBoardShapeContextMenu(app, shape, 0, 0, { x: 3, y: 0 });
            contextMenu.children[0].click();
            assert.equal(placeFloatingSelectionInteraction(app), true);
            assert.equal(commands.length, 1, 'Conversion and placement share one history entry');
        }
        assert.equal(shape.kind, kind);
        assert.equal(title, `${label} Segment`);
        assert.deepEqual(app._selectedBoardShapeSegment, { shapeId: shape.id, segment: 0 });
        assert.equal(shape.net, 'GND');
        assert.equal(shape.lineWidth, 0.7);
        assert.deepEqual(shape.segmentBulges, {});
        assert.deepEqual(shape.segmentWidths, {});
        if (kind === 'arc') {
            assert.deepEqual([shape.start, shape.end], endpoints);
            assert.deepEqual(shape.bulge, { x: 5, y: 1.25 });
            assert.equal(Object.hasOwn(shape, 'points'), false);
        } else {
            assert.deepEqual(shape.points, endpoints);
            for (const field of ['start', 'end', 'bulge']) assert.equal(Object.hasOwn(shape, field), false);
        }
        const saved = serializeBoardShapes({ boardShapes: [shape] });
        const loaded = { boardShapes: [], _shapeIdCounter: 1 };
        loadBoardShapes(loaded, saved, { render: false, strict: true });
        assert.equal(loaded.boardShapes[0].kind, kind);
        assert.deepEqual(cloneShapeGeometry(loaded.boardShapes[0]), cloneShapeGeometry(shape));
        for (const anchor of [null, kind === 'arc' ? 'end' : 1]) {
            const start = anchor == null ? { x: 3, y: 4 } : { ...endpoints[1] };
            startBoardShapeDrag(app, shape, start, anchor);
            app._updateRatsnest({ nets: app._shapeDrag.ratsnestNets });
            assert.equal(app._pictureCopperRefreshPending, true);
            assert.equal(ratLayer.children.length, 1);
            const coordinates = () => ['x1', 'y1', 'x2', 'y2'].map(name => ratLayer.children[0].getAttribute(name));
            const before = coordinates();
            handleBoardShapeDrag(app, { x: start.x + 3, y: start.y });
            assert.notDeepEqual(coordinates(), before, `${label} ratwire moves before drop`);
            endBoardShapeDrag(app, false);
        }
    }
    commands[1].undo();
    assert.equal(shape.kind, 'arc');
    assert.equal(Object.hasOwn(shape, 'points'), false);
    commands[0].undo();
    assert.equal(shape.kind, 'line');
    assert.deepEqual(shape.points, endpoints);
    assert.deepEqual(shape.segmentWidths, { 0: 0.7 });
    commands[0].execute();
    commands[1].execute();
    assert.equal(shape.kind, 'line');
    assert.equal(shape.net, 'GND');
    cancelPictureCopperRefresh(app);
}
console.log('PASS standalone conversion uses native shape kinds, menus, properties, undo, persistence, and live ratwires');

{
    const shape = { id: 'curved-line', kind: 'line', layer: 'top-silk', lineWidth: 0.4,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] };
    const commands = [];
    let title = '';
    const overlay = {
        children: [],
        appendChild(element) {
            this.children.push(element);
            element.remove = () => { this.children = this.children.filter(child => child !== element); };
        },
        querySelectorAll(selector) {
            return this.children.filter(element => element.getAttribute('class') === selector.slice(1));
        },
    };
    const selectedPath = () => {
        const elements = overlay.querySelectorAll('.pcb-shape-segment-selection');
        assert.equal(elements.length, 1, 'Exactly one current segment highlight is rendered');
        return elements[0].getAttribute('d');
    };
    const app = {
        boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _shapeElements: new Map(), viewport: { scale: 20, setCrosshair() {}, hideCrosshair() {} },
        _getLayerGroup(layer) { return layer === 'selection-overlay' ? overlay : null; },
        _pcbPropsItems() { return { innerHTML: '' }; }, _setPcbPropsTitle(value) { title = value; },
        _setActiveRibbonTab() {}, history: { execute(command) { commands.push(command); command.execute(); } },
    };
    assert.equal(setBoardShapeSegmentType(app, shape, 0, 'arc'), true);
    assert.equal(shape.segmentBulges[0], 0.25);
    assert.match(shapePathD(shape), / A /);
    assert.equal(boardShapeHitTest(shape, { x: 5, y: 1.25 }, 0.1), true);
    assert.ok(boardShapeBounds(shape).maxY > 1);
    assert.ok(resolveBoardShapeGeometry(shape).strokeSegments.length > 1);
    assert.ok(getBoardShapeAnchors(shape).some(anchor => anchor.id === 'bulge:0'));
    assert.ok(!getBoardShapeAnchors(shape).some(anchor => anchor.id === 'mid:0'));
    assert.equal(title, 'Arc Segment');
    assert.equal(startBoardShapeDrag(app, shape, { x: 5, y: 1.25 }, 'bulge:0'), true);
    handleBoardShapeDrag(app, { x: 5, y: -2.5 });
    assert.equal(shape.segmentBulges[0], -0.5);
    endBoardShapeDrag(app, false);
    assert.equal(shape.segmentBulges[0], 0.25);
    commands[0].undo();
    assert.deepEqual(shape.segmentBulges, {});
    commands[0].execute();
    assert.equal(shape.segmentBulges[0], 0.25);
    const saved = serializeBoardShapes({ boardShapes: [shape] });
    const loaded = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(loaded, saved, { render: false, strict: true });
    assert.deepEqual(loaded.boardShapes[0].segmentBulges, { 0: 0.25 });
    assert.equal(setBoardShapeSegmentType(app, shape, 0, 'line'), true);
    assert.equal(shape.segmentBulges[0], undefined);
    assert.equal(title, 'Line Segment');

    shape.segmentBulges = { 1: 0.4 };
    assert.equal(startBoardShapeDrag(app, shape, { x: 5, y: 0 }, 'mid:0'), true);
    assert.deepEqual(shape.segmentBulges, { 2: 0.4 });
    endBoardShapeDrag(app, false);
    for (const [kind, layer] of [['line', 'top-silk'], ['polygon', 'top-silk'], ['rect', 'board-outline']]) {
        shape.kind = kind;
        shape.layer = layer;
        shape.points = kind === 'rect'
            ? [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
            : [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }];
        shape.segmentBulges = {};
        const original = cloneShapeGeometry(shape);
        const historyDepth = commands.length;
        showBoardShapeContextMenu(app, shape, 0, 0, { x: 3, y: 0 });
        const linePath = selectedPath();
        assert.equal(contextMenu.children[0].textContent, 'Convert to Arc Segment');
        contextMenu.children[0].click();
        assert.equal(commands.length, historyDepth, 'Floating conversion has not committed yet');
        assert.equal(app._pcbSelectionInteraction?.mode, 'floating-anchor');
        assert.equal(app._pcbSelectionInteraction.anchorId, 'bulge:0');
        updateSelectionInteraction(app, { x: 5, y: -2.5 });
        assert.equal(shape.segmentBulges[0], -0.5);
        assert.equal(placeFloatingSelectionInteraction(app), true);
        assert.equal(app._pcbSelectionInteraction, null);
        assert.equal(app._shapeDrag, null);
        assert.equal(shape.segmentBulges[0], -0.5);
        assert.equal(title, layer === 'board-outline' ? 'Board Outline Segment' : 'Arc Segment');
        assert.equal(commands.length, historyDepth + 1);
        const arcPath = selectedPath();
        assert.notEqual(arcPath, linePath);
        commands.at(-1).undo();
        assert.equal(shape.kind, kind, 'One undo restores the pre-conversion shape kind');
        assert.deepEqual(cloneShapeGeometry(shape), original);
        assert.deepEqual(shape.segmentBulges, {});
        assert.equal(selectedPath(), linePath, 'Undo replaces the stale arc highlight with the original line');
        commands.at(-1).execute();
        assert.equal(shape.segmentBulges[0], -0.5, 'Redo restores the placed arc, not the initial floating arc');
        assert.equal(selectedPath(), arcPath, 'Redo leaves no stale straight segment overlay');
    }
    cancelPictureCopperRefresh(app);
}
console.log('PASS line and polygon segments support undoable curved geometry and persistence');

{
    const makeApp = shape => ({
        boardShapes: [shape], _shapeElements: new Map(), tracks: [], vias: [], placements: new Map(), texts: new Map(),
        viewport: { scale: 20, shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
        _getLayerGroup() { return null; },
        history: { commands: [], execute(command) { this.commands.push(command); command.execute(); } },
    });
    const notch = [{ x: 0, y: -80 }, { x: 100, y: -80 }, { x: 100, y: -65 },
        { x: 110, y: -25 }, { x: 100, y: 0 }, { x: 0, y: 0 }];
    for (const reversed of [false, true]) {
        for (const offset of [0, 3]) {
            let points = structuredClone(notch);
            if (reversed) points.reverse();
            points = [...points.slice(offset), ...points.slice(0, offset)];
            const arcStart = points.findIndex(point => reversed ? point.x === 110 : point.y === -65);
            const node = points.findIndex(point => point.x === 110);
            const shape = { id: 'notched-outline', kind: 'polygon', layer: 'board-outline', lineWidth: 0.2,
                points, segmentBulges: { [arcStart]: reversed ? -0.4 : 0.4 } };
            const app = makeApp(shape);
            const before = serializeBoardShapes(app);
            startBoardShapeDrag(app, shape, points[node], node);
            handleBoardShapeDrag(app, { x: 100, y: -25 });
            endBoardShapeDrag(app, true);
            assert.equal(shape.points.length, 6, 'Aligned arc endpoints must not collapse into straight board sides');
            assert.deepEqual(shape.points[node], { x: 100, y: -25 });
            assert.deepEqual(shape.segmentBulges, { [arcStart]: reversed ? -0.4 : 0.4 });
            assert.equal(shape.points[arcStart].x, 100);
            assert.equal(shape.points[(arcStart + 1) % points.length].x, 100, 'The arc remains on the right side');
            const after = serializeBoardShapes(app);
            assert.equal(app.history.commands.length, 1);
            app.history.commands[0].undo();
            assert.deepEqual(serializeBoardShapes(app), before);
            app.history.commands[0].execute();
            assert.deepEqual(serializeBoardShapes(app), after);
            cancelPictureCopperRefresh(app);
        }
    }
    for (const offset of [0, 1]) {
        let points = [notch[0], { x: 50, y: -85 }, ...notch.slice(1)].map(point => ({ ...point }));
        points = [...points.slice(offset), ...points.slice(0, offset)];
        const arcStart = 3 - offset;
        const node = 1 - offset;
        const shape = { id: 'notched-outline', kind: 'polygon', layer: 'board-outline', lineWidth: 0.2,
            points, segmentBulges: { [arcStart]: 0.4 }, segmentWidths: { [arcStart]: 0.6 },
            nodeCornerRadii: { [arcStart + 1]: 0 } };
        const app = makeApp(shape);
        const before = serializeBoardShapes(app);
        startBoardShapeDrag(app, shape, points[node], node);
        handleBoardShapeDrag(app, { x: 50, y: -80 });
        endBoardShapeDrag(app, true);
        assert.equal(shape.points.length, 6, 'A redundant straight node can still be removed');
        assert.deepEqual(shape.segmentBulges, { [arcStart - 1]: 0.4 }, 'The surviving arc index follows its endpoints');
        assert.deepEqual(shape.segmentWidths, { [arcStart - 1]: 0.6 });
        assert.deepEqual(shape.nodeCornerRadii, { [arcStart]: 0 });
        const after = serializeBoardShapes(app);
        app.history.commands[0].undo();
        assert.deepEqual(serializeBoardShapes(app), before, 'Undo restores points and their indexed metadata together');
        app.history.commands[0].execute();
        assert.deepEqual(serializeBoardShapes(app), after);
        cancelPictureCopperRefresh(app);
    }
}
console.log('PASS aligned arc endpoints and indexed metadata survive node cleanup and undo/redo');

for (const kind of ['rect', 'polygon']) {
    for (const reversed of [false, true]) {
        const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }];
        if (reversed) points.reverse();
        for (const filled of [false, true]) {
            const shape = { kind, points, filled, lineWidth: 2, layer: 'top-copper' };
            const contours = resolveBoardShapeGeometry(shape).physicalContours;
            assert.equal(contours.length, filled ? 1 : 2);
            assert.ok(contours.flat().every(point => point.x >= -1 && point.x <= 21 && point.y >= -1 && point.y <= 17));
            const outerCorner = contours.flat().filter(point => point.x < 0 && point.y < 0);
            assert.ok(outerCorner.length > 5);
            assert.ok(outerCorner.every(point => Math.abs(Math.hypot(point.x, point.y) - 1) < 0.003));
            if (!filled) assert.ok(contours.some(contour => contour.some(point => point.x === 1 && point.y === 1)));
            assert.deepEqual(boardShapeBounds(shape), { minX: -1, minY: -1, maxX: 21, maxY: 17 });
        }
    }
}
console.log('PASS rectangle and polygon strokes centred on editable paths');

for (const cornerRadius of [0, 2]) {
    const shape = { id: 'boundary', kind: 'polygon', layer: 'top-copper', filled: false, cornerRadius,
        lineWidth: 1, segmentWidths: { 0: 3 },
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }] };
    const anchors = getBoardShapeAnchors(shape);
    assert.deepEqual(anchors.slice(0, 4).map(({ x, y }) => ({ x, y })), shape.points);
    assert.deepEqual(anchors.slice(4).map(({ x, y }) => ({ x, y })),
        [{ x: 10, y: 0 }, { x: 20, y: 8 }, { x: 10, y: 16 }, { x: 0, y: 8 }]);
    assert.ok(boardShapeHitTest(shape, { x: 10, y: 1.4 }));
    assert.ok(boardShapeHitTest(shape, { x: 10, y: -1.4 }));
    assert.ok(!boardShapeHitTest(shape, { x: 10, y: 1.6 }));
    assert.ok(!boardShapeHitTest(shape, { x: 10, y: -1.6 }));
    assert.ok(!boardShapeHitTest(shape, { x: 10, y: 8 }));
    const bounds = boardShapeBounds(shape);
    assert.equal(bounds.minY, -1.5);
    assert.equal(bounds.maxY, 16.5);
    const before = cloneShapeGeometry(shape);
    const listeners = new Map();
    const input = { value: '5', valueAsNumber: 5, addEventListener(type, listener) { listeners.set(type, listener); } };
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        _pcbPropsItems() { return { innerHTML: '' }; } };
    document.getElementById = id => id === 'pcbPropShapeLineWidth' ? input : null;
    showBoardShapeProperties(app, shape);
    listeners.get('input')();
    assert.deepEqual(cloneShapeGeometry(shape), before);
    assert.equal(shape.cornerRadius, cornerRadius);
    assert.deepEqual(getBoardShapeAnchors(shape), anchors);
    assert.equal(shape.lineWidth, 5);
    document.getElementById = () => null;
    const serialized = serializeBoardShapes(app);
    assert.equal(serialized[0].geometryVersion, 1);
    const loaded = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(loaded, serialized, { render: false });
    assert.deepEqual(serializeBoardShapes(loaded), serialized);
    assert.equal(createBoardShapeSelectionAdapter(app, shape, shape.id).getEditPath(), 'M 0 0 L 20 0 L 20 16 L 0 16 Z');
}

for (const filled of [false, true]) {
    const shape = { kind: 'circle', x: 0, y: 0, radius: 5, lineWidth: 2, layer: 'top-copper', filled };
    const geometry = resolveBoardShapeGeometry(shape);
    assert.equal(geometry.circle.outerRadius, 5);
    assert.equal(geometry.circle.radius, 4);
    assert.ok(boardShapeHitTest(shape, { x: 4.9, y: 0 }));
    assert.ok(!boardShapeHitTest(shape, { x: 5.1, y: 0 }));
    assert.equal(boardShapeHitTest(shape, { x: 0, y: 0 }), filled);
}

for (const shape of [
    { kind: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { kind: 'arc', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: -5 } },
]) {
    Object.assign(shape, { id: shape.kind, layer: 'top-copper', lineWidth: 2, filled: false });
    const geometry = resolveBoardShapeGeometry(shape);
    assert.equal(geometry.physicalContours, null);
    assert.equal(geometry.lineWidth, 2);
    const anchors = getBoardShapeAnchors(shape);
    const expected = shape.kind === 'line' ? shape.points : [shape.start, shape.end, shape.bulge];
    assert.deepEqual(anchors.filter(anchor => !anchor.midpoint).map(({ x, y }) => ({ x, y })), expected);
}

const legacy = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(legacy, [
    { id: 'legacy-rect', kind: 'rect', lineWidth: 2, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }] },
    { id: 'legacy-circle', kind: 'circle', x: 0, y: 0, radius: 5, lineWidth: 2 },
    { id: 'legacy-line', kind: 'line', lineWidth: 2, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
], { render: false });
assert.deepEqual(legacy.boardShapes[0].points[0], { x: 0, y: 0 });
assert.equal(legacy.boardShapes[1].radius, 6);
assert.deepEqual(legacy.boardShapes[2].points, [{ x: 0, y: 0 }, { x: 20, y: 0 }]);
const migrated = serializeBoardShapes(legacy);
const reloaded = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(reloaded, migrated, { render: false });
assert.deepEqual(serializeBoardShapes(reloaded), migrated);

for (const commit of [false, true]) {
    const shape = { id: 'split', kind: 'rect', layer: 'top-copper', lineWidth: 3,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }] };
    const before = cloneShapeGeometry(shape);
    const commands = [];
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        history: { execute(command) { commands.push(command); command.execute(); } } };
    startBoardShapeDrag(app, shape, { x: 10, y: 0 }, 'mid:0');
    handleBoardShapeDrag(app, { x: -4, y: -3 });
    assert.deepEqual(shape.points[1], { x: -4, y: -3 });
    assert.deepEqual(shape.points.filter((_point, index) => index !== 1), before.points);
    endBoardShapeDrag(app, commit);
    if (commit) {
        assert.equal(commands.length, 1);
        assert.equal(shape.kind, 'polygon');
        commands[0].undo();
        assert.equal(shape.kind, 'rect');
        assert.deepEqual(cloneShapeGeometry(shape), before);
        commands[0].execute();
        assert.deepEqual(shape.points[1], { x: -4, y: -3 });
    } else assert.deepEqual(cloneShapeGeometry(shape), before);
}
console.log('PASS centreline editing, symmetric hit tests, unchanged circles, migration and undo');

const { pointInPolygon } = await import('../src/core/geometry.js');
const crossedPoints = [{ x: 0, y: 0 }, { x: 0, y: 16 }, { x: 20, y: 16 },
    { x: 20, y: 0 }, { x: 10, y: 21 }];
const contains = (contours, point) => contours.reduce((inside, contour) =>
    inside !== pointInPolygon(point, contour), false);
for (const reversed of [false, true]) {
    for (const filled of [false, true]) {
        for (const lineWidth of [0.2, 1, 4]) {
            const shape = { kind: 'polygon', layer: 'top-copper', filled, lineWidth,
                points: reversed ? [...crossedPoints].reverse() : crossedPoints };
            const before = structuredClone(shape.points);
            const actual = resolveBoardShapeGeometry(shape).physicalContours;
            assert.ok(contains(actual, { x: 10, y: 16 - lineWidth / 4 }));
            assert.ok(contains(actual, { x: 10, y: 16 + lineWidth / 4 }));
            const expected = resolveBoardShapeGeometry({ ...shape, points: [...shape.points].reverse() }).physicalContours;
            for (let horizontal = -1; horizontal < 22; horizontal += 0.37) {
                for (let vertical = -1; vertical < 23; vertical += 0.41) {
                    const point = { x: horizontal, y: vertical };
                    assert.equal(contains(actual, point), contains(expected, point), 'Stroke is winding-independent');
                }
            }
            assert.deepEqual(shape.points, before, 'Resolving crossings never mutates editable nodes');
        }
    }
}
for (const reversed of [false, true]) {
    const points = [{ x: 0, y: 0 }, { x: 0, y: 16 }, { x: 20, y: 16 }, { x: 20, y: 0 }];
    if (reversed) points.reverse();
    const shape = { id: 'crossing-direction', kind: 'rect', layer: 'top-copper', lineWidth: 1, points };
    const commands = [];
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        history: { execute(command) { commands.push(command); command.execute(); } } };
    const midpoint = getBoardShapeAnchors(shape).find(anchor => anchor.midpoint && anchor.y === 0);
    startBoardShapeDrag(app, shape, midpoint, midpoint.id);
    for (const height of [21, 40, 60, 21]) {
        handleBoardShapeDrag(app, { x: 10, y: height });
        const contours = resolveBoardShapeGeometry(shape).physicalContours;
        assert.ok(contains(contours, { x: 10, y: 15.6 }));
        assert.ok(contains(contours, { x: 10, y: 16.4 }));
    }
    endBoardShapeDrag(app, true);
    commands[0].undo();
    commands[0].execute();
    const saved = serializeBoardShapes(app);
    const restored = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(restored, saved, { render: false });
    assert.ok(!('strokeSide' in saved[0]));
    assert.deepEqual(resolveBoardShapeGeometry(restored.boardShapes[0]).physicalContours,
        resolveBoardShapeGeometry(shape).physicalContours);
}
console.log('PASS centred crossings through dragging, undo and reload');