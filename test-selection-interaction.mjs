/** Headless regression tests for shared PCB selection interaction state. */

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById() { return null; } };
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };

const {
    finishSelectionInteraction,
    placeFloatingSelectionInteraction,
    updateSelectionInteraction,
} = await import('./src/pcb/modules/selection-interaction.js');
const { createTrackSelectionAdapter } = await import('./src/pcb/modules/track-select.js');
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