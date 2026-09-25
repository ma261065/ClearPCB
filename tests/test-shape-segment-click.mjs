import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; }, querySelector() { return null; },
    createElementNS() {
        const attributes = new Map();
        return { style: {}, children: [], setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name) ?? null; }, removeAttribute(name) { attributes.delete(name); },
            appendChild(child) { this.children.push(child); }, remove() {}, querySelectorAll() { return []; } };
    },
};
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
const { beginSelectionInteraction, updateSelectionInteraction, finishSelectionInteraction,
    placeFloatingSelectionInteraction } = await import('../src/pcb/modules/selection-interaction.js');
const { boardShapeHitTest } = await import('../src/pcb/modules/board-shape-geometry.js');
const { createBoardShapeSelectionAdapter, getBoardShapeAnchors,
    renderBoardShapeSegmentSelection, selectBoardShape, showBoardShapeProperties,
    startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag, openBoardShape } = await import('../src/pcb/modules/board-shapes.js');
const { renderPcbSelectionAnchors } = await import('../src/pcb/modules/selection-anchors.js');
const { Track } = await import('../src/shapes/track.js');
const { selectTrackOrVia, selectTrackNode, drawTrackHalo, createTrackSelectionAdapter } = await import('../src/pcb/modules/track-select.js');
const { cancelPictureCopperRefresh } = await import('../src/pcb/modules/picture-refresh.js');
const { splitTrackNodeAndDrag } = await import('../src/pcb/modules/track-drag.js');
const { getPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { redrawPropertyPreview, createPropertyPreview } = await import('../src/shapes/property-preview.js');

{
    const first = { id: 'first' }, second = { id: 'second' };
    const events = [];
    const renderer = {
        prepare(target) { events.push(`prepare:${target.id}`); },
        render(targets) { events.push(`render:${targets.map(target => target.id).join(',')}`); },
        refreshSelection() { events.push('selection'); },
        refreshDerived() { events.push('derived'); },
    };
    redrawPropertyPreview([first, second, first], renderer);
    assert.deepEqual(events, ['prepare:first', 'prepare:second', 'render:first,second', 'selection', 'derived'],
        'Preview prepares all targets before rendering, then refreshes selection and derived views once');
    events.length = 0;
    redrawPropertyPreview([], renderer);
    assert.deepEqual(events, [], 'Empty previews do not refresh the editor');
    redrawPropertyPreview([first], { renderScene() { events.push('full-scene'); } });
    assert.deepEqual(events, ['full-scene'], 'Full-scene adapters may render geometry and selection together');
    assert.throws(() => redrawPropertyPreview([first], { render() {} }), TypeError,
        'Incremental adapters must declare every redraw stage');
}

{
    let values = [0.2, 0.4];
    const commands = [];
    const phases = [];
    const preview = createPropertyPreview({
        capture: () => [...values],
        restore: before => { values = [...before]; },
        redraw: phase => phases.push(phase),
        commit: (before, after) => {
            assert.deepEqual(values, before, 'Original values are restored before history captures them');
            commands.push({ before, after });
            values = [...after];
        },
    });
    preview.update(() => { values = [1, 1]; });
    preview.update(() => { values = [2, 2]; });
    assert.equal(commands.length, 0);
    assert.equal(preview.commit(), true);
    assert.deepEqual(commands, [{ before: [0.2, 0.4], after: [2, 2] }]);
    assert.deepEqual(phases, ['preview', 'preview', 'commit']);
    assert.equal(preview.commit(), false, 'Repeated change/blur does not duplicate history');
    preview.update(() => { values = [3, 3]; });
    assert.equal(preview.cancel(), true);
    assert.deepEqual(values, [2, 2]);
    assert.equal(phases.at(-1), 'cancel');
    preview.update(() => { values = [4, 4]; });
    preview.update(() => { values = [2, 2]; });
    assert.equal(preview.commit(), false, 'Returning to the original values creates no history');
    assert.equal(commands.length, 1);
}

for (const commit of [true, false]) {
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], edgeBulges: { e0: 0.25 } });
    const before = track.captureState();
    const refreshes = { clearance: 0, fills: 0, board: 0 };
    const commands = [];
    const app = { tracks: [track], boardShapes: [], vias: [], placements: new Map(), texts: new Map(),
        _getLayerGroup() { return null; }, viewport: { scale: 100, shiftHeld: true },
        _refreshClearanceHalos() { refreshes.clearance++; },
        _refreshFills() { refreshes.fills++; },
        _board3d: { refresh() { refreshes.board++; } },
        history: { execute(command) { commands.push(command); command.execute(); } } };
    selectTrackOrVia(app, { type: 'track', track });
    const adapter = createTrackSelectionAdapter(app, track, track.id);
    assert.ok(adapter.beginAnchorDrag('bulge:e0', { x: 5, y: 1.25 }));
    const initialRefreshes = { ...refreshes };
    assert.equal(app._deferDragOverlays, true);
    assert.equal(app._suspendBoardViewRefresh, true);
    adapter.updateAnchorDrag({ x: 5, y: 2 });
    adapter.updateAnchorDrag({ x: 5, y: 3 });
    assert.notDeepEqual(track.captureState(), before, 'Bulge geometry updates immediately');
    assert.deepEqual(refreshes, initialRefreshes, 'Bulge motion does not request expensive derived refreshes');
    adapter.endAnchorDrag(commit);
    assert.equal(app._deferDragOverlays, false);
    assert.equal(app._suspendBoardViewRefresh, false);
    for (const key of Object.keys(refreshes)) assert.ok(refreshes[key] > initialRefreshes[key]);
    assert.equal(commands.length, commit ? 1 : 0);
    if (commit) commands[0].undo();
    assert.deepEqual(track.captureState(), before, 'Cancel and undo restore the original arc');
}

{
    const shape = { id: 'native-arc-highlight', kind: 'arc', layer: 'top-silk', lineWidth: 0.2,
        start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bulge: { x: 50, y: 25 } };
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; } };
    selectBoardShape(app, shape);
    const overlay = document.createElementNS('', 'g');
    app._getLayerGroup = () => overlay;
    app._selectedBoardShapeSegment = { shapeId: shape.id, segment: 0 };
    renderBoardShapeSegmentSelection(app);
    const path = overlay.children.at(-1).getAttribute('d');
    assert.match(path, /A/i, 'Arc selection uses a native SVG arc');
    assert.equal((path.match(/M/g) || []).length, 1, 'Arc selection does not rebuild sampled segment caps');
}

for (const kind of ['line', 'track']) {
    for (const action of ['place', 'cancel']) {
        const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
        const object = kind === 'track' ? new Track({ points, edgeBulges: { e1: 0.5 }, edgeWidths: { e1: 0.4 } })
            : { id: `split-focus-${action}`, kind, layer: 'top-silk', lineWidth: 0.2, points,
                segmentBulges: { 1: 0.5 }, segmentWidths: { 1: 0.4 } };
        const before = kind === 'track' ? object.captureState() : structuredClone(object);
        const commands = [];
        let title = '';
        const items = { innerHTML: '' };
        const app = { boardShapes: kind === 'track' ? [] : [object], tracks: kind === 'track' ? [object] : [],
            vias: [], placements: new Map(), texts: new Map(), _shapeElements: new Map(), _shapeIdCounter: 1,
            _getLayerGroup() { return null; }, _snapToGrid(point) { return point; },
            _pcbPropsItems() { return items; }, _setPcbPropsTitle(value) { title = value; },
            viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} },
            history: { execute(command) { commands.push(command); command.execute(); } } };
        if (kind === 'track') {
            selectTrackOrVia(app, { type: 'track', track: object });
            selectTrackNode(app, object, 'n1');
            assert.ok(splitTrackNodeAndDrag(app, object, 'n1'));
        } else {
            selectBoardShape(app, object);
            app._selectedBoardShapeNode = { shapeId: object.id, index: 1 };
            assert.ok(openBoardShape(app, object, 1));
        }
        const state = app._pcbSelectionInteraction;
        assert.equal(state.mode, 'floating-anchor', `${kind}: Split still floats the endpoint`);
        assert.ok(!state.adapter.getAnchors().some(anchor => anchor.selected), `${kind}: Split has no node selection ring`);
        assert.ok(!title.includes('Node'), `${kind}: Split shows parent properties`);
        updateSelectionInteraction(app, { x: 12, y: 3 });
        if (action === 'place') placeFloatingSelectionInteraction(app);
        else finishSelectionInteraction(app, false);
        assert.equal(app._pcbSelectionInteraction, null);
        assert.ok(!state.adapter.getAnchors().some(anchor => anchor.selected), `${kind}: ${action} does not select a node`);
        assert.ok(!title.includes('Node'), `${kind}: ${action} retains parent properties`);
        const pieces = kind === 'track' ? app.tracks : app.boardShapes;
        assert.equal(pieces.length, action === 'place' ? 2 : 1, `${kind}: placed Split creates independent objects`);
        if (action === 'place') {
            assert.equal(commands.length, 1, `${kind}: Split is one undo step`);
            const arc = pieces.find(piece => kind === 'track'
                ? [...piece.edges.values()].some(edge => edge.bulge === 0.5)
                : Object.values(piece.segmentBulges || {}).includes(0.5));
            const straight = pieces.find(piece => piece !== arc);
            assert.ok(arc);
            assert.notEqual(arc.id, straight.id);
            if (kind === 'track') {
                assert.equal(arc.edges.size, 1);
                assert.equal(straight.edges.size, 1);
                assert.equal([...arc.edges.values()][0].width, 0.4);
                selectTrackOrVia(app, { type: 'track', track: arc });
            } else {
                assert.equal(arc.points.length, 2);
                assert.equal(arc.segmentWidths[0], 0.4);
                selectBoardShape(app, arc);
            }
            assert.deepEqual(getPcbSelection(app), [arc], `${kind}: selecting the arc excludes the original line`);
            commands[0].undo();
            assert.equal(pieces.length, 1);
            if (kind === 'track') {
                assert.deepEqual(object.captureState(), before);
                assert.deepEqual(getPcbSelection(app), [], 'Undo Split deselects the removed arc');
                assert.equal(app._trackEdit, null, 'Undo Split clears removed track edit state');
            }
            else assert.deepEqual(object.points, before.points);
            commands[0].execute();
            assert.equal(pieces.length, 2, `${kind}: redo restores independent pieces`);
        }
    }
}

for (const kind of ['line', 'polygon', 'rect', 'track']) {
    const points = kind === 'line' || kind === 'track'
        ? [{ x: 0, y: 0 }, { x: 10, y: 0 }]
        : [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const object = kind === 'track' ? new Track({ points })
        : { id: `node-gesture-${kind}`, kind, layer: 'top-silk', lineWidth: 0.2, points };
    const app = { boardShapes: kind === 'track' ? [] : [object], tracks: kind === 'track' ? [object] : [],
        vias: [], placements: new Map(), texts: new Map(), _shapeElements: new Map(),
        _getLayerGroup() { return null; }, _snapToGrid(point) { return point; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} },
        history: { execute(command) { command.execute(); } } };
    const focusedNode = () => kind === 'track' ? app._trackEdit?.nodeId : app._selectedBoardShapeNode?.index;
    const nodePosition = () => kind === 'track' ? object.nodes.get('n0') : object.points[0];
    if (kind === 'track') selectTrackOrVia(app, { type: 'track', track: object });
    else selectBoardShape(app, object);
    assert.ok(beginSelectionInteraction(app, { ...nodePosition() }, false));
    assert.equal(focusedNode(), undefined, `${kind}: pressing a node does not refine selection`);
    updateSelectionInteraction(app, { x: 1, y: 2 });
    finishSelectionInteraction(app, true);
    assert.deepEqual(nodePosition(), { x: 1, y: 2 }, `${kind}: dragging still moves the node`);
    assert.equal(focusedNode(), undefined, `${kind}: dragging a node does not count as the refinement click`);
    assert.ok(beginSelectionInteraction(app, { ...nodePosition() }, false));
    finishSelectionInteraction(app, true);
    assert.equal(focusedNode(), kind === 'track' ? 'n0' : 0, `${kind}: a stationary click selects the node`);
    assert.ok(beginSelectionInteraction(app, { ...nodePosition() }, false));
    updateSelectionInteraction(app, { x: 2, y: 3 });
    finishSelectionInteraction(app, true);
    assert.equal(focusedNode(), kind === 'track' ? 'n0' : 0, `${kind}: dragging an already focused node keeps its selection`);
}

for (const kind of ['line', 'track']) {
    for (const action of ['place', 'cancel', 'drag']) {
        const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
        const object = kind === 'track' ? new Track({ points })
            : { id: `midpoint-${action}`, kind, layer: 'top-silk', lineWidth: 0.2, points };
        const commands = [];
        const app = { boardShapes: kind === 'track' ? [] : [object], tracks: kind === 'track' ? [object] : [],
            vias: [], placements: new Map(), texts: new Map(), _shapeElements: new Map(),
            _getLayerGroup() { return null; }, _snapToGrid(point) { return point; },
            viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} },
            history: { execute(command) { commands.push(command); command.execute(); } } };
        const positions = () => kind === 'track' ? [...object.nodes.values()] : object.points;
        if (kind === 'track') selectTrackOrVia(app, { type: 'track', track: object });
        else selectBoardShape(app, object);
        assert.ok(beginSelectionInteraction(app, { x: 5, y: 0 }, false));
        assert.ok(String(app._pcbSelectionInteraction.anchorId).startsWith('mid:'));
        assert.equal(positions().length, 3, `${kind}: pressing (+) inserts a provisional node`);
        if (action !== 'drag') {
            finishSelectionInteraction(app, true);
            assert.equal(app._pcbSelectionInteraction?.mode, 'floating-anchor', `${kind}: (+) click keeps the new node attached`);
            assert.equal(commands.length, 0, `${kind}: insertion is not committed on mouse-up`);
        }
        updateSelectionInteraction(app, { x: 5, y: 2 });
        assert.ok(positions().some(point => point.x === 5 && point.y === 2), `${kind}: inserted node follows the cursor`);
        if (action === 'cancel') {
            finishSelectionInteraction(app, false);
            assert.equal(commands.length, 0);
        } else {
            if (action === 'drag') finishSelectionInteraction(app, true);
            else assert.ok(placeFloatingSelectionInteraction(app));
            assert.equal(commands.length, 1, `${kind}: insertion and movement form one undo step`);
            commands[0].undo();
        }
        assert.deepEqual(positions(), [{ x: 0, y: 0 }, { x: 10, y: 0 }], `${kind}: cancel or undo removes the inserted node`);
        assert.equal(app._pcbSelectionInteraction, null);
    }
}

for (const kind of ['line', 'polygon', 'rect', 'arc', 'circle', 'track']) {
    const points = kind === 'line' || kind === 'track' ? [{ x: 0, y: 0 }, { x: 10, y: 0 }]
        : [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const object = kind === 'track' ? new Track({ points }) : kind === 'arc'
        ? { id: 'magnet-arc', kind, layer: 'top-silk', lineWidth: 0.2,
            start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: 2 } }
        : kind === 'circle' ? { id: 'magnet-circle', kind, layer: 'top-silk', lineWidth: 0.2, x: 0, y: 0, radius: 5 }
        : { id: `magnet-${kind}`, kind, layer: 'top-silk', lineWidth: 0.2, points };
    const app = { boardShapes: kind === 'track' ? [] : [object], tracks: kind === 'track' ? [object] : [],
        vias: [], placements: new Map(), texts: new Map(), _shapeElements: new Map(),
        _getLayerGroup() { return null; },
        viewport: { scale: 100, gridSize: 1, gridVisible: true, snapToGrid: true, shiftHeld: false,
            setCrosshair() {}, hideCrosshair() {} },
        _snapToGrid: point => ({ x: Math.round(point.x), y: Math.round(point.y) }),
        history: { execute(command) { command.execute(); } } };
    const adapter = kind === 'track' ? createTrackSelectionAdapter(app, object, object.id)
        : createBoardShapeSelectionAdapter(app, object, object.id);
    const anchorId = kind === 'track' ? 'n0' : kind === 'arc' ? 'start' : kind === 'circle' ? 'center' : 0;
    const position = () => adapter.getAnchors().find(anchor => anchor.id === anchorId);
    assert.ok(adapter.beginAnchorDrag(anchorId, { x: 0, y: 0 }));
    for (const [cursor, expected, shift] of [
        [{ x: 2.3, y: 3.4 }, { x: 2.3, y: 3.4 }, false],
        [{ x: 2.03, y: 3.4 }, { x: 2, y: 3.4 }, false],
        [{ x: 2.03, y: 3.04 }, { x: 2.03, y: 3.04 }, true],
        [{ x: 2.03, y: 3.04 }, { x: 2, y: 3 }, false],
    ]) {
        app.viewport.shiftHeld = shift;
        adapter.updateAnchorDrag(cursor);
        assert.deepEqual({ x: position().x, y: position().y }, expected, `${kind}: proximity magnet and Shift override`);
    }
    adapter.endAnchorDrag(false, { moved: true });
}

for (const layer of ['top-silk', 'board-outline']) {
    for (const horizontal of [false, true]) {
        for (const fixed of [10, 10.2]) {
            const orient = point => horizontal ? { x: point.y, y: point.x } : { ...point };
            const shape = { id: 'aligned-arc-end', kind: 'polygon', layer, lineWidth: 0.2,
                points: [{ x: 0, y: 0 }, { x: fixed, y: 0 }, { x: fixed + 2, y: 5 },
                    { x: fixed, y: 10 }, { x: 0, y: 10 }].map(orient),
                segmentBulges: { 1: 0.25 } };
            const app = { boardShapes: [shape], tracks: [], vias: [], placements: new Map(), texts: new Map(),
                _shapeElements: new Map(), _getLayerGroup() { return null; },
                viewport: { scale: 100, gridSize: 1, gridVisible: true, shiftHeld: false,
                    setCrosshair() {}, hideCrosshair() {} } };
            const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
            const original = structuredClone(shape.points);
            assert.ok(adapter.beginAnchorDrag(2, shape.points[2]));
            for (const [free, snappedFree, gridVisible, shiftHeld] of [
                [7.04, 7, true, false],
                [7.35, 7.35, true, false],
                [7.04, 7.04, false, false],
                [7.04, 7.04, true, true],
            ]) {
                app.viewport.gridVisible = gridVisible;
                app.viewport.shiftHeld = shiftHeld;
                const cursor = orient({ x: fixed + 0.03, y: free });
                adapter.updateAnchorDrag(cursor);
                assert.deepEqual(shape.points[2], shiftHeld ? cursor : orient({ x: fixed, y: snappedFree }),
                    `${layer}: ${horizontal ? 'horizontal' : 'vertical'} alignment preserves the free-axis grid magnet`);
                assert.equal(shape.segmentBulges[1], 0.25, 'Endpoint snapping keeps the arc curvature');
            }
            adapter.endAnchorDrag(false, { moved: true });
            assert.deepEqual(shape.points, original);
        }
    }
}

function propertyInput(value) {
    const listeners = new Map();
    return {
        value: String(value),
        get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); },
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        fire(type, details = {}) {
            for (const listener of listeners.get(type) || []) listener({ type, preventDefault() {}, stopPropagation() {}, ...details });
        },
    };
}

for (const bulge of [0, 0.25]) {
    const shape = { id: 'live-segment-width', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 10 }], segmentBulges: { 0: bulge } };
    const commands = [];
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 100 }, _pcbPropsItems() { return { innerHTML: '' }; },
        history: { execute(command) { commands.push(command); command.execute(); } } };
    selectBoardShape(app, shape);
    app._selectedBoardShapeSegment = { shapeId: shape.id, segment: 0 };
    const overlay = document.createElementNS('', 'g');
    overlay.querySelectorAll = selector => overlay.children.filter(
        child => (child.getAttribute('class') || '').split(' ').includes(selector.slice(1)));
    overlay.appendChild = child => {
        overlay.children.push(child);
        child.remove = () => {
            const index = overlay.children.indexOf(child);
            if (index !== -1) overlay.children.splice(index, 1);
        };
    };
    app._getLayerGroup = layer => layer === 'selection-overlay' ? overlay : null;
    const width = propertyInput(0.2);
    document.getElementById = id => id === 'pcbPropShapeLineWidth' ? width : null;
    showBoardShapeProperties(app, shape);
    renderBoardShapeSegmentSelection(app);
    for (const value of [4, 1, 3, 0.2]) {
        const previous = overlay.querySelectorAll('.pcb-shape-segment-selection')[0];
        width.value = String(value);
        width.fire('input');
        const highlights = overlay.querySelectorAll('.pcb-shape-segment-selection');
        assert.equal(highlights.length, 1, 'Live width changes retain exactly one segment highlight');
        assert.notEqual(highlights[0], previous, 'The old highlight is replaced before committing');
        assert.equal(highlights[0].getAttribute('stroke-width'), String(value),
            `${bulge ? 'Curved' : 'Straight'} segment highlight grows and shrinks during input`);
        assert.equal(shape.segmentWidths[0] ?? shape.lineWidth, value);
        assert.equal(commands.length, 0, 'Live width preview does not create undo entries');
    }
    width.fire('change');
    assert.equal(commands.length, 0, 'Returning to the original width leaves no undo entry');
    width.value = '2';
    width.fire('input');
    width.fire('keydown', { key: 'Escape' });
    assert.equal(shape.segmentWidths[0] ?? shape.lineWidth, 0.2, 'Escape restores the original segment width');
    assert.equal(commands.length, 0, 'Escape does not create history');
    for (const [id, values] of [
        ...(!bulge ? [['pcbPropShapeCornerRadius', [2, 0.5]]] : []),
        ['pcbPropShapeBulge', [0.5, 0.1]],
    ]) {
        const input = propertyInput(0);
        document.getElementById = key => key === id ? input : null;
        showBoardShapeProperties(app, shape);
        for (const value of values) {
            const previous = overlay.querySelectorAll('.pcb-shape-segment-selection')[0];
            const beforePath = previous.getAttribute('d');
            input.value = String(value);
            input.fire('input');
            const highlights = overlay.querySelectorAll('.pcb-shape-segment-selection');
            assert.equal(highlights.length, 1, `${id}: preview retains one segment overlay`);
            assert.notEqual(highlights[0], previous, `${id}: preview replaces stale selection`);
            assert.notEqual(highlights[0].getAttribute('d'), beforePath, `${id}: selection follows live geometry`);
            assert.equal(overlay.querySelectorAll('.pcb-selection-anchors').length, 1,
                `${id}: preview retains one current anchor group`);
            assert.equal(commands.length, 0, `${id}: preview does not commit history`);
        }
    }
    document.getElementById = () => null;
}

for (const kind of ['line', 'polygon', 'rect', 'arc']) {
    for (const overall of [2, 3]) {
        const shape = { id: `override-${kind}`, kind, layer: 'top-silk', lineWidth: 2,
            segmentWidths: { 0: 4 }, cornerRadius: 2, nodeCornerRadii: { 1: 0, 2: 1 },
            points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
            start: { x: 0, y: 0 }, end: { x: 20, y: 0 }, bulge: { x: 10, y: -5 } };
        const commands = [];
        const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
            _pcbPropsItems() { return { innerHTML: '' }; },
            history: { execute(command) { commands.push(command); command.execute(); } } };
        const width = propertyInput(overall);
        document.getElementById = id => id === 'pcbPropShapeLineWidth' ? width : null;
        showBoardShapeProperties(app, shape);
        width.fire('input');
        width.fire('change');
        assert.equal(shape.lineWidth, overall);
        assert.deepEqual(shape.segmentWidths, {}, `${kind}: overall width clears segment overrides`);
        commands.at(-1).undo();
        assert.equal(shape.lineWidth, 2);
        assert.deepEqual(shape.segmentWidths, { 0: 4 });
        if (kind !== 'arc') {
            const radius = propertyInput(overall);
            document.getElementById = id => id === 'pcbPropShapeCornerRadius' ? radius : null;
            showBoardShapeProperties(app, shape);
            radius.fire('input');
            radius.fire('change');
            assert.equal(shape.cornerRadius, overall);
            assert.deepEqual(shape.nodeCornerRadii, {}, `${kind}: overall radius clears node overrides`);
            const overallCommand = commands.at(-1);
            overallCommand.undo();
            assert.equal(shape.cornerRadius, 2);
            assert.deepEqual(shape.nodeCornerRadii, { 1: 0, 2: 1 });
            overallCommand.execute();
            const nodeRadius = propertyInput(1);
            app._selectedBoardShapeNode = { shapeId: shape.id, index: 1 };
            document.getElementById = id => id === 'pcbPropShapeNodeCornerRadius' ? nodeRadius : null;
            showBoardShapeProperties(app, shape);
            nodeRadius.fire('input');
            nodeRadius.fire('change');
            assert.equal(shape.cornerRadius, overall);
            assert.deepEqual(shape.nodeCornerRadii, { 1: 1 }, `${kind}: later node edit changes only that corner`);
        }
        document.getElementById = () => null;
    }
}

for (const overall of [2, 3]) {
    const track = new Track({ width: 2, cornerRadius: 2,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }] });
    const nodeId = [...track.nodes.keys()][1];
    const edgeId = track.edges.keys().next().value;
    track.setNodeCornerRadius(nodeId, 0);
    track.setEdgeAttr(edgeId, 'width', 4);
    const commands = [];
    const app = { tracks: [track], vias: [], boardShapes: [], placements: new Map(), texts: new Map(),
        viewport: { scale: 100 }, _getLayerGroup() { return null; },
        _pcbPropsItems() { return { innerHTML: '' }; },
        history: { execute(command) { commands.push(command); command.execute(); } } };
    const radius = propertyInput(overall);
    const width = propertyInput(overall);
    document.getElementById = id => id === 'pcbPropTrackCornerRadius' ? radius
        : id === 'pcbPropTrackWidth' ? width : null;
    selectTrackOrVia(app, { type: 'track', track });
    radius.fire('blur');
    assert.deepEqual(track.nodeCornerRadii, { [nodeId]: 0 }, 'Focusing and leaving the input preserves overrides');
    radius.fire('input');
    radius.fire('change');
    assert.equal(track.cornerRadius, overall);
    assert.deepEqual(track.nodeCornerRadii, {});
    const radiusCommand = commands.at(-1);
    radiusCommand.undo();
    assert.equal(track.cornerRadius, 2);
    assert.deepEqual(track.nodeCornerRadii, { [nodeId]: 0 });
    radiusCommand.execute();
    width.fire('input');
    width.fire('change');
    await Promise.resolve();
    assert.equal(track.width, overall);
    assert.ok([...track.edges.keys()].every(id => track.getEdgeWidth(id) === overall));
    commands.at(-1).undo();
    assert.equal(track.width, 2);
    assert.equal(track.getEdgeWidth(edgeId), 4, 'Undo restores the original local width');
    radius.value = '1';
    selectTrackNode(app, track, nodeId);
    radius.fire('input');
    radius.fire('change');
    assert.equal(track.cornerRadius, overall);
    assert.deepEqual(track.nodeCornerRadii, { [nodeId]: 1 });
    document.getElementById = () => null;
}

{
    const shape = { id: 'line-node', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    const items = { innerHTML: '' };
    let title = '';
    const app = { boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        _pcbPropsItems() { return items; }, _setPcbPropsTitle(value) { title = value; },
        history: { execute(command) { command.execute(); } } };
    selectBoardShape(app, shape);
    assert.ok(beginSelectionInteraction(app, shape.points[0], false));
    finishSelectionInteraction(app, true);
    assert.deepEqual(app._selectedBoardShapeNode, { shapeId: shape.id, index: 0 });
    assert.equal(app._pcbSelectionInteraction, null, 'A node click selects without starting floating placement');
    assert.equal(title, 'Line Node');
    assert.ok(items.innerHTML.includes('pcbPropShapeNodeX'));
    assert.ok(items.innerHTML.includes('pcbPropShapeNodeY'));
    assert.ok(items.innerHTML.includes('Corner Radius'));
    const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
    assert.equal(adapter.getEditPath(), '', 'Node focus hides the parent editing path');
    assert.equal(adapter.getAnchors().filter(anchor => anchor.selected).length, 1);
    const overlay = document.createElementNS();
    app._getLayerGroup = layer => layer === 'selection-overlay' ? overlay : null;
    renderPcbSelectionAnchors(app);
    const ring = overlay.children.at(-1).children.find(child => child.getAttribute('class') === 'pcb-node-selection-ring');
    assert.ok(ring, 'A selected line node has a circular selection ring');
    assert.equal(ring.getAttribute('cx'), '0');
    assert.equal(ring.getAttribute('cy'), '0');
    assert.equal(ring.getAttribute('fill'), 'none');
    assert.equal(ring.getAttribute('vector-effect'), 'non-scaling-stroke');
    const radius = Number(ring.getAttribute('r'));
    app.viewport.scale /= 2;
    renderPcbSelectionAnchors(app);
    const zoomedRing = overlay.children.at(-1).children.find(child => child.getAttribute('class') === 'pcb-node-selection-ring');
    assert.equal(Number(zoomedRing.getAttribute('r')), radius * 2, 'Ring keeps its screen size across zoom');
    for (const scale of [1, 50, 500]) {
        app.viewport.scale = scale;
        renderPcbSelectionAnchors(app);
        const group = overlay.children.at(-1);
        const handles = group.children.filter(child => child.getAttribute('data-anchor-id') != null);
        assert.ok(handles.length >= 3, 'Both endpoint and midpoint handles are present');
        for (const handle of handles) {
            assert.equal(handle.getAttribute('vector-effect'), 'non-scaling-stroke');
            assert.equal(Number(handle.getAttribute('stroke-width')), 1,
                'Non-scaling handle borders keep a one-pixel width at every zoom');
            assert.equal(handle.getAttribute('fill'), '#ffffff', 'Handles obscure the path beneath them');
        }
    }
    app._getLayerGroup = () => null;
    finishSelectionInteraction(app, false);
    assert.deepEqual(shape.points, [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const app = { tracks: [track], vias: [], boardShapes: [], placements: new Map(), texts: new Map(),
        viewport: { scale: 100 }, _getLayerGroup() { return null; } };
    selectTrackOrVia(app, { type: 'track', track });
    const overlay = document.createElementNS();
    const copper = document.createElementNS();
    app._getLayerGroup = layer => layer === 'selection-overlay' ? overlay : copper;
    const nodeId = track.nodes.keys().next().value;
    selectTrackNode(app, track, nodeId);
    drawTrackHalo(app, track, 'pcb-box-track-sel');
    assert.equal(copper.children.length, 0, 'Node focus suppresses whole-track halos, including shared selection refreshes');
    const rings = overlay.children.at(-1).children.filter(child => child.getAttribute('class') === 'pcb-node-selection-ring');
    assert.equal(rings.length, 1, 'Track nodes use the same circular selection ring');
}

for (const guideClick of [false, true]) {
    const shape = { id: 'rounded-segment', kind: 'rect', layer: 'top-copper', lineWidth: 0.2, cornerRadius: 8,
        points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }] };
    const app = { boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        history: { execute(command) { command.execute(); } } };
    const first = { x: 12, y: 0 };
    const second = guideClick ? { x: 2, y: 0 } : first;
    assert.ok(beginSelectionInteraction(app, first, false));
    finishSelectionInteraction(app, true);
    const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
    const guide = 'M 0 0 L 40 0 L 40 30 L 0 30 Z';
    assert.equal(adapter.getEditPath(), guide, 'Selection guide follows raw nodes despite the radius');
    if (guideClick) assert.equal(boardShapeHitTest(shape, second, 0.1), false, 'Guide sample is outside the physical rounded stroke');
    assert.ok(beginSelectionInteraction(app, second, false), 'Second click on stroke or guide is consumed');
    finishSelectionInteraction(app, true);
    assert.equal(app._selectedBoardShapeSegment?.segment, 0, 'Second click selects the segment');
    assert.equal(adapter.getEditPath(), guide, 'Segment selection retains the complete straight node guide');
    const overlay = document.createElementNS();
    app._getLayerGroup = layer => layer === 'selection-overlay' ? overlay : null;
    renderPcbSelectionAnchors(app);
    renderBoardShapeSegmentSelection(app);
    const guidePath = overlay.children[0].children[0];
    assert.equal(guidePath.getAttribute('d'), guide);
    assert.equal(guidePath.getAttribute('stroke-width'), '1');
    assert.equal(guidePath.getAttribute('vector-effect'), 'non-scaling-stroke');
    const highlight = overlay.children.find(child => child.getAttribute('class') === 'pcb-shape-segment-selection');
    assert.equal(highlight.getAttribute('d'), 'M 8 0 L 32 0');
    assert.equal(highlight.getAttribute('stroke-width'), String(shape.lineWidth));
    assert.equal(highlight.getAttribute('vector-effect'), null, 'Segment highlight scales with the physical stroke');
}

for (const kind of ['line', 'polygon']) {
    for (const commit of [true, false]) {
        const shape = { id: 'curved-segment', kind, layer: 'top-silk', lineWidth: 0.2,
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }], segmentBulges: { 0: 0.25 } };
        let title = '';
        const app = { boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
            _shapeElements: new Map(), _getLayerGroup() { return null; },
            viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
            _pcbPropsItems() { return { innerHTML: '' }; }, _setPcbPropsTitle(value) { title = value; },
            history: { execute(command) { command.execute(); } } };
        selectBoardShape(app, shape);
        app._selectedBoardShapeSegment = { shapeId: shape.id, segment: 0 };
        showBoardShapeProperties(app, shape);
        assert.equal(title, 'Arc Segment');
        const overlay = document.createElementNS();
        overlay.querySelectorAll = selector => overlay.children.filter(
            child => (child.getAttribute('class') || '').split(' ').includes(selector.slice(1)));
        overlay.appendChild = child => {
            overlay.children.push(child);
            child.remove = () => {
                const index = overlay.children.indexOf(child);
                if (index !== -1) overlay.children.splice(index, 1);
            };
        };
        app._getLayerGroup = layer => layer === 'selection-overlay' ? overlay : null;
        const segmentHighlights = () => overlay.querySelectorAll('.pcb-shape-segment-selection');
        const handle = getBoardShapeAnchors(shape).find(anchor => anchor.id === 'bulge:0');
        assert.ok(beginSelectionInteraction(app, handle, false), 'Rendered bulge handle starts a selection interaction');
        assert.equal(app._pcbSelectionInteraction?.mode, 'anchor');
        assert.deepEqual(app._selectedBoardShapeSegment, { shapeId: shape.id, segment: 0 });
        assert.equal(title, 'Arc Segment', 'Grabbing the bulge keeps segment properties');
        assert.equal(segmentHighlights().length, 1);
        const originalHighlight = segmentHighlights()[0];
        const originalPath = originalHighlight.getAttribute('d');
        updateSelectionInteraction(app, { x: 5, y: -2.5 });
        assert.equal(shape.segmentBulges[0], -0.5, 'Dragging the rendered handle changes the segment curvature');
        assert.equal(segmentHighlights().length, 1, 'Dragging retains exactly one segment highlight');
        assert.ok(!overlay.children.includes(originalHighlight), 'The original curve highlight is removed during drag');
        const draggedPath = segmentHighlights()[0].getAttribute('d');
        assert.notEqual(draggedPath, originalPath, 'The segment highlight follows the edited curve before drop');
        showBoardShapeProperties(app, shape);
        assert.equal(title, 'Arc Segment', 'Refreshing properties during the drag keeps the segment');
        finishSelectionInteraction(app, commit);
        assert.deepEqual(app._selectedBoardShapeSegment, { shapeId: shape.id, segment: 0 });
        showBoardShapeProperties(app, shape);
        assert.equal(title, 'Arc Segment', 'Dropping or cancelling keeps segment properties');
        assert.equal(shape.segmentBulges[0], commit ? -0.5 : 0.25);
        assert.equal(segmentHighlights().length, 1);
        assert.equal(segmentHighlights()[0].getAttribute('d'), commit ? draggedPath : originalPath);
    }
}
console.log('PASS real second-click segment selection on rounded strokes and straight guides');

for (const [kind, zeroOffset] of ['arc', 'line', 'polygon'].flatMap(kind =>
    [0, 0.0001, 0.02, -0.02, 0.5, -0.5].map(zeroOffset => [kind, zeroOffset]))) {
    const shape = { id: 'bulge-properties', kind, layer: 'top-silk', lineWidth: 0.2,
        ...(kind === 'arc'
            ? { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: 1.25 } }
            : { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }], segmentBulges: { 0: 0.25 } }) };
    let input = null;
    let title = '';
    const commands = [];
    let replacingProperties = false;
    let propertyRebuilds = 0;
    const items = {
        set innerHTML(html) {
            assert.equal(replacingProperties, false, 'Blur must not rebuild a panel during its replacement');
            replacingProperties = true;
            propertyRebuilds++;
            try { input?.fire('blur'); } finally { replacingProperties = false; }
            const match = /id="pcbPropShapeBulge"[^>]*value="([^"]+)"/.exec(html);
            if (!match) { input = null; return; }
            const listeners = new Map();
            input = {
                value: match[1],
                dataset: {}, matches(selector) { return selector === 'input[type="number"]'; },
                get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); },
                addEventListener(name, callback) {
                    if (!listeners.has(name)) listeners.set(name, []);
                    listeners.get(name).push(callback);
                },
                fire(name) { for (const callback of listeners.get(name) || []) callback({}); },
            };
        },
    };
    const originalGetElementById = document.getElementById;
    document.getElementById = id => id === 'pcbPropShapeBulge' ? input : null;
    const app = { boardShapes: [shape], placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        _pcbPropsItems() { return items; }, _setPcbPropsTitle(value) { title = value; },
        history: { execute(command) { commands.push(command); command.execute(); } } };
    try {
        selectBoardShape(app, shape);
        if (kind !== 'arc') app._selectedBoardShapeSegment = { shapeId: shape.id, segment: 0 };
        showBoardShapeProperties(app, shape);
        assert.equal(input.value, '0.25');
        const initialRebuilds = propertyRebuilds;
        input.fire('blur');
        await Promise.resolve();
        assert.equal(propertyRebuilds, initialRebuilds, 'Unchanged blur does not rebuild properties');
        assert.equal(commands.length, 0, 'Unchanged blur does not create history');
        input.value = '';
        input.fire('input');
        assert.equal(commands.length, 0, 'Partial typing does not commit');
        input.value = '-0.5';
        input.fire('input');
        assert.equal(kind === 'arc' ? shape.bulge.y : shape.segmentBulges[0], kind === 'arc' ? -2.5 : -0.5);
        input.fire('change');
        assert.equal(commands.length, 1, 'Typed bulge makes one undoable edit');
        await Promise.resolve();
        assert.equal(commands.length, 1, 'Blur caused by the command refresh does not repeat the edit');
        assert.equal(propertyRebuilds, initialRebuilds + 1, 'The command owns the single properties refresh');
        const handle = kind === 'arc' ? 'bulge' : 'bulge:0';
        startBoardShapeDrag(app, shape, { x: 5, y: -2.5 }, handle);
        handleBoardShapeDrag(app, { x: 5, y: 0 });
        assert.equal(Number(input.value), 0, 'Spinner follows a drag to zero');
        handleBoardShapeDrag(app, { x: 5, y: 2.5 });
        assert.equal(Number(input.value), 0.5, 'Dragging can cross zero without losing the bulge handle');
        endBoardShapeDrag(app, false);
        assert.equal(Number(input.value), -0.5, 'Cancelling restores the live spinner');
        startBoardShapeDrag(app, shape, { x: 5, y: -2.5 }, handle);
        handleBoardShapeDrag(app, { x: 5, y: zeroOffset });
        const straight = Math.abs(zeroOffset) <= 8 / app.viewport.scale
            || Number((zeroOffset * 2 / 10).toFixed(2)) === 0;
        endBoardShapeDrag(app, true);
        assert.equal(shape.kind, kind === 'arc' && straight ? 'line' : kind);
        assert.equal(title, kind === 'arc' ? (straight ? 'Line' : 'Arc') : (straight ? 'Line Segment' : 'Arc Segment'));
        if (kind !== 'arc') assert.equal(Object.hasOwn(shape.segmentBulges, 0), !straight);
        if (!straight) assert.ok(Math.abs(Number(input.value)) >= 0.0001, 'Small nonzero curves remain editable');
        commands.at(-1).undo();
        assert.equal(shape.kind, kind);
        assert.equal(Number(input.value), -0.5, 'Undo restores the arc and its bulge control');
        commands.at(-1).execute();
        assert.equal(shape.kind, kind === 'arc' && straight ? 'line' : kind, 'Redo restores the drag result');
        commands.at(-1).undo();
        input.value = '0.001';
        input.fire('input');
        input.fire('change');
        assert.equal(shape.kind, kind === 'arc' ? 'line' : kind, 'A typed rounded-zero bulge straightens the shape');
        assert.equal(input, null, 'Straightened shapes no longer show the bulge input');
        commands.at(-1).undo();
        input.value = '0';
        input.fire('input');
        input.fire('change');
        assert.equal(shape.kind, kind === 'arc' ? 'line' : kind);
        assert.equal(title, kind === 'arc' ? 'Line' : 'Line Segment');
        assert.equal(input, null, 'Straight shapes no longer show arc properties');
        commands.at(-1).undo();
        assert.equal(Number(input.value), -0.5);
        if (kind === 'arc') shape.bulge = { x: 5, y: 0 };
        else shape.segmentBulges[0] = 0;
        input.value = '0.00';
        input.fire('change');
        assert.equal(shape.kind, kind === 'arc' ? 'line' : kind);
        if (kind !== 'arc') assert.equal(Object.hasOwn(shape.segmentBulges, 0), false);
        commands.at(-1).undo();
        const beforeBlurCommands = commands.length;
        const beforeBlurValue = input.value;
        input.value = '0.75';
        input.fire('input');
        items.innerHTML = '';
        assert.equal(commands.length, beforeBlurCommands, 'Panel removal defers a pending blur commit');
        await Promise.resolve();
        assert.equal(commands.length, beforeBlurCommands + 1, 'Pending preview is committed after panel removal');
        assert.equal(input.value, '0.75');
        await Promise.resolve();
        assert.equal(commands.length, beforeBlurCommands + 1, 'Deferred blur creates only one history entry');
        commands.at(-1).undo();
        assert.equal(input.value, beforeBlurValue, 'The deferred edit retains the original undo snapshot');
    } finally {
        cancelPictureCopperRefresh(app);
        document.getElementById = originalGetElementById;
    }
}
console.log('PASS bulge properties, live drag values, zero conversion, cancellation, and undo');