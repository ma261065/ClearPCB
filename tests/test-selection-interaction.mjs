/** Headless regression tests for shared PCB selection interaction state. */

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById() { return null; }, querySelector() { return null; },
    createElementNS() { return { setAttribute() {}, getAttribute() { return null; }, appendChild() {}, remove() {} }; } };
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };

const {
    finishSelectionInteraction,
    beginSelectionInteraction,
    placeFloatingSelectionInteraction,
    updateSelectionInteraction,
    showPcbSelectionProperties,
} = await import('../src/pcb/modules/selection-interaction.js');
const { createTrackSelectionAdapter } = await import('../src/pcb/modules/track-select.js');
const {
    clearPcbSelection,
    hitTestPcbSelectionEntry,
    registerPcbSelectionAdapter,
    setPcbSelection,
} = await import('../src/pcb/modules/selection-registry.js');
const { Track } = await import('../src/shapes/track.js');

let failures = 0;

function expect(name, condition) {
    if (condition) {
        console.log(`PASS: ${name}`);
        return;
    }
    failures++;
    console.error(`FAIL: ${name}`);
}

{
    registerPcbSelectionAdapter('shape', (_app, object, id) => ({
        id, kind: 'shape', object, visible: true,
        getBounds() { return { minX: 0, minY: 0, maxX: 10, maxY: 10 }; },
        hitTest() { return true; },
        invalidate() {},
    }));
    registerPcbSelectionAdapter('via', (_app, object, id) => ({
        id, kind: 'via', object, visible: true,
        getBounds() { return { minX: 0, minY: 0, maxX: 10, maxY: 10 }; },
        hitTest() { return true; },
        invalidate() {},
    }));
    const hole = { id: 'hole-shape', layer: 'hole' };
    const via = { id: 'overlapping-via' };
    const app = {
        placements: new Map(), tracks: [], vias: [via], boardShapes: [hole], texts: new Map(),
        viewport: { scale: 1 },
    };
    const hit = hitTestPcbSelectionEntry(app, { x: 5, y: 5 }, ['shape', 'via']);
    expect('hole shape owns clicks across its filled hit area', hit?.object === hole);
}

{
    const top = { id: 'top-object' };
    const below = { id: 'below-object' };
    const unrelated = { id: 'unrelated-object' };
    let moves = 0;
    const factory = (_app, object, id) => ({
        id, kind: 'shape', object, visible: true,
        getBounds() { return { minX: 0, minY: 0, maxX: 10, maxY: 10 }; },
        hitTest() { return object !== unrelated; },
        beginMove() { return true; },
        updateMove() { moves++; },
        endMove() {},
        invalidate() {},
    });
    registerPcbSelectionAdapter('shape', factory);
    const app = {
        placements: new Map(), tracks: [], vias: [], boardShapes: [below, top, unrelated], texts: new Map(),
        _shapeElements: new Map(),
        viewport: { scale: 1 },
        _syncClipboardButtons() {}, _setPcbStatus() {},
        _selectComponent() {}, _selectBoardOutline() {}, _selectText() {}, _selectRefText() {}, _selectFill() {},
        _clearProperties() {}, _showPcbMultiSelectionProperties() {},
        _getLayerGroup() { return null; },
    };
    setPcbSelection(app, [{ kind: 'shape', object: top }]);
    expect('Ctrl-click consumes an overlapping PCB selection',
        beginSelectionInteraction(app, { x: 5, y: 5 }, true));
    expect('Ctrl-click removes a selected PCB object', app._pcbSelection.count === 0);
    beginSelectionInteraction(app, { x: 5, y: 5 }, true);
    expect('Ctrl-click adds an unselected PCB object', app._pcbSelection.getSelection()[0]?.object === top);
    beginSelectionInteraction(app, { x: 5, y: 5 }, false, true);
    expect('Shift press leaves selection unchanged', app._pcbSelection.getSelection()[0]?.object === top);
    finishSelectionInteraction(app, true);
    expect('Shift-click cycles to the next overlapping PCB object',
        app._pcbSelection.getSelection()[0]?.object === below);
    beginSelectionInteraction(app, { x: 5, y: 5 }, false, true);
    finishSelectionInteraction(app, true);
    expect('Shift-click wraps the overlap stack', app._pcbSelection.getSelection()[0]?.object === top);
    beginSelectionInteraction(app, { x: 5, y: 5 }, false, true);
    finishSelectionInteraction(app, false);
    expect('Escape cancels pending overlap cycling', app._pcbSelection.getSelection()[0]?.object === top);
    beginSelectionInteraction(app, { x: 5, y: 5 }, false, true);
    updateSelectionInteraction(app, { x: 9, y: 5 });
    expect('Shift-drag promotes normal movement without cycling', moves === 1
        && app._pcbSelection.getSelection()[0]?.object === top);
    finishSelectionInteraction(app, true);
    beginSelectionInteraction(app, { x: 5, y: 5 }, false, true);
    finishSelectionInteraction(app, true, { x: 9, y: 5 });
    expect('A distant release without mousemove becomes a drag, not a cycle', moves === 2
        && app._pcbSelection.getSelection()[0]?.object === top);
    setPcbSelection(app, [{ kind: 'shape', object: top }, { kind: 'shape', object: unrelated }]);
    beginSelectionInteraction(app, { x: 5, y: 5 }, true, true);
    finishSelectionInteraction(app, true);
    const selectedObjects = app._pcbSelection.getSelection().map((item) => item.object);
    expect('Ctrl+Shift cycling preserves unrelated selected objects', selectedObjects.includes(below)
        && selectedObjects.includes(unrelated) && !selectedObjects.includes(top));
}

{
    const locked = { id: 'locked-shape' };
    let beganMove = false;
    registerPcbSelectionAdapter('shape', (_app, object, id) => ({
        id, kind: 'shape', object, visible: true, locked: true,
        getBounds: () => ({ minX: 0, minY: 0, maxX: 10, maxY: 10 }),
        hitTest: () => true,
        beginMove() { beganMove = true; return true; },
        invalidate() {},
    }));
    const app = {
        placements: new Map(), tracks: [], vias: [], boardShapes: [locked], texts: new Map(),
        _shapeElements: new Map(), viewport: { scale: 1 },
        _syncClipboardButtons() {}, _setPcbStatus() {},
        _selectComponent() {}, _selectBoardOutline() {}, _selectText() {}, _selectRefText() {}, _selectFill() {},
        _clearProperties() {}, _getLayerGroup() { return null; },
    };
    expect('Locked object remains directly selectable',
        beginSelectionInteraction(app, { x: 5, y: 5 }, false));
    expect('Locked object does not begin movement', !beganMove && !app._pcbSelectionInteraction);
}

{
    const top = { id: 'priority-via' };
    const below = { id: 'underlying-shape' };
    const moved = [];
    let belowVisible = true;
    const factory = kind => (_app, object, id) => ({
        id, kind, object,
        get visible() { return object !== below || belowVisible; },
        getBounds() { return { minX: 0, minY: 0, maxX: 20, maxY: 10 }; },
        hitTest(point) { return object === top || point.x <= 10; },
        beginMove() { return true; },
        updateMove() { moved.push(object); },
        endMove() {}, invalidate() {},
    });
    registerPcbSelectionAdapter('shape', factory('shape'));
    registerPcbSelectionAdapter('via', factory('via'));
    const app = {
        placements: new Map(), tracks: [], vias: [top], boardShapes: [below], texts: new Map(),
        _shapeElements: new Map(), viewport: { scale: 1 },
        _syncClipboardButtons() {}, _setPcbStatus() {},
        _selectComponent() {}, _selectBoardOutline() {}, _selectText() {}, _selectRefText() {}, _selectFill() {},
        _clearProperties() {}, _getLayerGroup() { return null; },
    };
    for (const shiftDrag of [false, true]) {
        setPcbSelection(app, [{ kind: 'via', object: top }]);
        beginSelectionInteraction(app, { x: 5, y: 5 }, false, true);
        finishSelectionInteraction(app, true);
        expect('Shift-click reaches an object beneath a higher-priority kind',
            app._pcbSelection.getSelection()[0]?.object === below);
        beginSelectionInteraction(app, { x: 5, y: 5 }, false, shiftDrag);
        updateSelectionInteraction(app, { x: 9, y: 5 });
        finishSelectionInteraction(app, true);
        expect(`${shiftDrag ? 'Shift-drag' : 'Normal drag'} moves the cycled underlying object`,
            moved.at(-1) === below && app._pcbSelection.getSelection()[0]?.object === below);
    }
    beginSelectionInteraction(app, { x: 15, y: 5 }, false);
    expect('Clicking outside the selected object still selects the object hit',
        app._pcbSelection.getSelection()[0]?.object === top);
    finishSelectionInteraction(app, true);
    setPcbSelection(app, [{ kind: 'shape', object: below }]);
    belowVisible = false;
    beginSelectionInteraction(app, { x: 5, y: 5 }, false);
    expect('A hidden selected object cannot claim the drag',
        app._pcbSelection.getSelection()[0]?.object === top);
    finishSelectionInteraction(app, true);
}

{
    let removed = 0;
    const shape = { id: 'shape-segment' };
    registerPcbSelectionAdapter('shape', (_app, object, id) => ({
        id, kind: 'shape', object, visible: true,
        getBounds() { return { minX: 0, minY: 0, maxX: 1, maxY: 1 }; },
        hitTest() { return false; },
        invalidate() {},
    }));
    const app = {
        placements: new Map(), tracks: [], vias: [], boardShapes: [shape], texts: new Map(),
        viewport: { scale: 1 },
        _getLayerGroup() {
            return { querySelectorAll() { return [{ remove() { removed++; } }]; } };
        },
        _setPcbStatus() {},
    };
    setPcbSelection(app, [{ kind: 'shape', object: shape }]);
    app._selectedBoardShapeSegment = { shapeId: shape.id, segment: 0 };
    clearPcbSelection(app);
    expect('PCB shape deselection clears refined segment state', app._selectedBoardShapeSegment === null);
    expect('PCB shape deselection removes refined segment highlight', removed === 1);
}

{
    const endCalls = [];
    let updates = 0;
    const app = {
        viewport: { scale: 1 },
        _pcbSelectionInteraction: {
            mode: 'anchor',
            startWorld: { x: 0, y: 0 },
            moved: false,
            adapter: {
                updateAnchorDrag() { updates++; },
                endAnchorDrag(_commit, options) {
                    endCalls.push(options);
                    return options.place ? undefined : { floating: true };
                },
            },
        },
    };

    expect('anchor update is consumed', updateSelectionInteraction(app, { x: 4, y: 0 }));
    expect('anchor movement crosses the shared threshold', app._pcbSelectionInteraction.moved);
    expect('adapter receives floating update', updates === 1);
    expect('click-release is consumed', finishSelectionInteraction(app, true));
    expect('adapter can retain a floating interaction', app._pcbSelectionInteraction?.mode === 'floating-anchor');
    expect('placement click is consumed', placeFloatingSelectionInteraction(app));
    expect('placement clears the shared interaction', app._pcbSelectionInteraction === null);
    expect('placement reaches the adapter', endCalls[1]?.place === true);
}

{
    let endOptions = null;
    const app = {
        viewport: { scale: 10 },
        _pcbSelectionInteraction: {
            mode: 'move-adapter',
            startWorld: { x: 0, y: 0 },
            moved: false,
            entry: {
                updateMove() {},
                endMove(_commit, options) { endOptions = options; },
            },
        },
    };
    updateSelectionInteraction(app, { x: 1, y: 0 });
    finishSelectionInteraction(app, true);
    expect('PCB move adapter receives movement threshold result', endOptions?.moved === true);
}

{
    const endCalls = [];
    const app = {
        viewport: { scale: 1 },
        _pcbSelectionInteraction: {
            mode: 'floating-anchor',
            adapter: { endAnchorDrag(commit) { endCalls.push(commit); } },
        },
    };

    finishSelectionInteraction(app, false);
    expect('Escape cancels a floating interaction', endCalls[0] === false && app._pcbSelectionInteraction === null);
}

{
    const floatingShapeAdapter = {
        endAnchorDrag(commit, options) {
            return commit && !options.moved && !options.place ? { floating: true } : undefined;
        },
    };
    const app = {
        viewport: { scale: 1 },
        _pcbSelectionInteraction: {
            mode: 'anchor',
            startWorld: { x: 0, y: 0 },
            moved: false,
            adapter: floatingShapeAdapter,
        },
    };

    finishSelectionInteraction(app, true);
    expect('an untouched generic shape anchor becomes floating', app._pcbSelectionInteraction?.mode === 'floating-anchor');
}

{
    let committed = false;
    const fillAdapter = {
        endAnchorDrag(commit, options) {
            if (commit && !options.moved && !options.place) return { floating: true };
            committed = commit;
        },
    };
    const app = {
        viewport: { scale: 1 },
        _pcbSelectionInteraction: {
            mode: 'anchor',
            startWorld: { x: 0, y: 0 },
            moved: true,
            adapter: fillAdapter,
        },
    };

    finishSelectionInteraction(app, true);
    expect('a dragged fill anchor commits on mouse-up', committed && app._pcbSelectionInteraction === null);
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const edgeId = track.edges.keys().next().value;
    const app = {
        tracks: [track],
        vias: [],
        placements: new Map(),
        boardShapes: [],
        texts: new Map(),
        viewport: {
            scale: 10,
            setCrosshair() {},
            hideCrosshair() {},
        },
        _layerGroups: new Map(),
        _getLayerGroup() { return null; },
        _pcbPropsItems() { return null; },
    };
    const adapter = createTrackSelectionAdapter(app, track, `track:${track.id}`);
    const segmentPoint = { x: 2.5, y: 0 };

    expect('first Track click starts the segment interaction',
        adapter.beginMove(segmentPoint, { alreadySelected: false }));
    adapter.endMove(true);
    expect('first Track click retains whole-track selection', !app._trackEdit);

    expect('second Track click starts the segment interaction',
        adapter.beginMove(segmentPoint, { alreadySelected: true }));
    adapter.endMove(true);
    expect('second Track click refines to the clicked segment', app._trackEdit?.edgeId === edgeId);

    const items = { innerHTML: '' };
    let title = '';
    app._pcbPropsItems = () => items;
    app._setPcbPropsTitle = value => { title = value; };
    const nodeId = track.nodes.keys().next().value;
    const node = track.nodes.get(nodeId);
    expect('clicking a Track node starts an anchor interaction', beginSelectionInteraction(app, node, false));
    finishSelectionInteraction(app, true);
    expect('click-release focuses the Track node', app._trackEdit?.nodeId === nodeId);
    expect('focused Track node does not float', app._pcbSelectionInteraction === null && app._vertexDrag === null);
    showPcbSelectionProperties(app);
    expect('property refresh preserves Track node focus', app._trackEdit?.nodeId === nodeId && title === 'Track Node');
    expect('Track node properties include corner radius', items.innerHTML.includes('pcbPropTrackCornerRadius'));
    expect('Track node properties display coordinates', items.innerHTML.includes('pcbPropTrackNodeX')
        && items.innerHTML.includes('pcbPropTrackNodeY'));
    finishSelectionInteraction(app, false);
    expect('cancelling the pickup preserves existing Track node focus', app._trackEdit?.nodeId === nodeId
        && app._vertexDrag === null && title === 'Track Node');
}

{
    const { pathMoveInteraction, pathContextActions, snapPathPoint, snapPathTranslation } =
        await import('../src/pcb/modules/path-edit.js');
    let focused = null;
    let moving = null;
    const interaction = pathMoveInteraction({ segmentAt: () => 2, selectedSegment: () => focused,
        selectSegment: segment => { focused = segment; },
        begin: (point, segment) => { moving = segment; return true; }, update() {}, end() {} });
    interaction.beginMove({ x: 0, y: 0 }, { alreadySelected: false });
    interaction.endMove(true);
    expect('shared first click selects the parent', moving === null && focused === null);
    interaction.beginMove({ x: 0, y: 0 }, { alreadySelected: true });
    interaction.endMove(true);
    expect('shared second click selects the segment', focused === 2);
    interaction.beginMove({ x: 0, y: 0 }, { alreadySelected: true, selectedSegment: 2 });
    interaction.endMove(true, { moved: true });
    expect('shared segment drag targets the selected segment', moving === 2 && focused === 2);
    interaction.beginMove({ x: 0, y: 0 }, { alreadySelected: true, selectedSegment: 2 });
    interaction.endMove(true);
    expect('repeated segment click retains refinement', focused === 2);
    const action = () => {};
    expect('shared node menu has Split and Delete node', pathContextActions({ node: true, split: action, deleteNode: action })
        .map(item => item.text).join(',') === 'Split,Delete node');
    expect('shared segment menu has conversion and targeted deletion', pathContextActions({ segment: true, curved: false,
        convert: action, deleteSegment: action }).map(item => item.text).join(',') === 'Convert to Arc Segment,Delete segment');
    const app = { placements: new Map(), viewport: { scale: 100, gridSize: 1, gridVisible: true },
        _snapToGrid: point => ({ x: Math.round(point.x), y: Math.round(point.y) }) };
    const free = snapPathPoint(app, { x: 2.3, y: 4.4 });
    expect('shared point snap is free outside the grid magnet band', free.x === 2.3 && free.y === 4.4);
    const grid = snapPathPoint(app, { x: 2.03, y: 4.4 });
    expect('shared point snap attracts only the nearby grid axis', grid.x === 2 && grid.y === 4.4);
    const horizontal = snapPathPoint(app, { x: 2.3, y: 0.03 }, [{ x: 0, y: 0 }]);
    expect('shared point snap leaves the unaligned axis free', horizontal.x === 2.3 && horizontal.y === 0);
    const diagonal = snapPathPoint(app, { x: 2, y: 2.03 }, [{ x: 0, y: 0 }]);
    expect('shared point snap aligns to 45 degrees', Math.abs(diagonal.x - diagonal.y) < 1e-9);
    app.placements.set('R1', { pads: new Map([['1', { x: 10.02, y: 3.04 }]]) });
    const delta = snapPathTranslation(app, [{ x: 0, y: 0 }, { x: 8, y: 0 }], { x: 2, y: 3 });
    expect('translation snaps any moving endpoint to a pad', Math.abs(delta.x - 2.02) < 1e-9
        && Math.abs(delta.y - 3.04) < 1e-9);
    app.viewport.shiftHeld = true;
    const override = snapPathPoint(app, { x: 10.03, y: 3.03 }, [{ x: 10, y: 3 }], true);
    expect('Shift disables pad, grid and axis magnets', override.x === 10.03 && override.y === 3.03);
    const freeDelta = snapPathTranslation(app, [{ x: 0, y: 0 }], { x: 10.03, y: 3.03 });
    expect('Shift disables translation magnets', freeDelta.x === 10.03 && freeDelta.y === 3.03);
    app.viewport.shiftHeld = false;
    app.viewport.getEffectiveGridSize = () => 5;
    const adaptive = snapPathPoint(app, { x: 3.03, y: 4.97 });
    expect('grid magnets follow displayed grid spacing', adaptive.x === 3.03 && adaptive.y === 5);
    app.viewport.gridVisible = false;
    const hidden = snapPathPoint(app, { x: 3.03, y: 4.97 });
    expect('hidden grid has no magnets', hidden.x === 3.03 && hidden.y === 4.97);
}

if (failures) process.exitCode = 1;