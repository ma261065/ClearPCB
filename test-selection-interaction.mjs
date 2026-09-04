/** Headless regression tests for shared PCB selection interaction state. */

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById() { return null; } };
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };

const {
    finishSelectionInteraction,
    beginSelectionInteraction,
    placeFloatingSelectionInteraction,
    updateSelectionInteraction,
} = await import('./src/pcb/modules/selection-interaction.js');
const { createTrackSelectionAdapter } = await import('./src/pcb/modules/track-select.js');
const {
    clearPcbSelection,
    hitTestPcbSelectionEntry,
    registerPcbSelectionAdapter,
    setPcbSelection,
} = await import('./src/pcb/modules/selection-registry.js');
const { Track } = await import('./src/shapes/track.js');

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
    const factory = (_app, object, id) => ({
        id, kind: 'shape', object, visible: true,
        getBounds() { return { minX: 0, minY: 0, maxX: 10, maxY: 10 }; },
        hitTest() { return true; },
        invalidate() {},
    });
    registerPcbSelectionAdapter('shape', factory);
    const app = {
        placements: new Map(), tracks: [], vias: [], boardShapes: [below, top], texts: new Map(),
        viewport: { scale: 1 },
        _syncClipboardButtons() {}, _setPcbStatus() {},
        _selectComponent() {}, _selectBoardOutline() {}, _selectText() {}, _selectRefText() {}, _selectFill() {},
        _clearProperties() {}, _showPcbMultiSelectionProperties() {},
        _getLayerGroup() { return null; },
    };
    setPcbSelection(app, [{ kind: 'shape', object: top }]);
    expect('Ctrl-click consumes an overlapping PCB selection',
        beginSelectionInteraction(app, { x: 5, y: 5 }, true));
    expect('Ctrl-click cycles to the next overlapping PCB object',
        app._pcbSelection.getSelection()[0]?.object === below);
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
}

if (failures) process.exitCode = 1;