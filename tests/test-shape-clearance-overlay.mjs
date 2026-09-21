import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = { addEventListener() {} };
const element = () => ({
    children: [], attributes: new Map(), dataset: {}, style: {},
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    appendChild(child) {
        child.parentNode?.removeChild(child);
        this.children.push(child);
        child.parentNode = this;
    },
    removeChild(child) {
        assert.ok(this.children.includes(child));
        child.removals = (child.removals || 0) + 1;
        this.children.splice(this.children.indexOf(child), 1);
        child.parentNode = null;
    },
    get firstChild() { return this.children[0]; },
    querySelectorAll() { return []; },
});
globalThis.document = { createElementNS: element, getElementById() { return null; } };
const { boardShapeClearanceOutlines, pcbTextClearanceOutlines } = await import('../src/pcb/modules/copper-fill-geom.js');
const { getBoardShapeAnchors, resolveBoardShapeGeometry, renderBoardShape, boardShapeRemovalPathD } = await import('../src/pcb/modules/board-shapes.js');
for (const filled of [false, true]) {
    const polygon = { id: 'acute', kind: 'polygon', layer: 'top-copper', lineWidth: 2, cornerRadius: 0, filled,
        points: [{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }] };
    const tip = getBoardShapeAnchors(polygon)[0];
    const contours = resolveBoardShapeGeometry(polygon).physicalContours;
    assert.deepEqual({ x: tip.x, y: tip.y }, polygon.points[0], 'Acute corner handle stays on the centreline');
    const physicalTip = Math.min(...contours.flat().map(point => point.y));
    assert.ok(physicalTip < tip.y - polygon.lineWidth / 2, 'Sharp miter extends beyond the centreline corner');
    const clearanceTip = Math.min(...boardShapeClearanceOutlines(polygon, 0.25).flat().map(point => point.y));
    assert.ok(physicalTip - clearanceTip >= 0.24 && physicalTip - clearanceTip < 0.29,
        'Clearance extends by the requested distance beyond the actual acute tip');
    let rendered;
    renderBoardShape({ _shapeElements: new Map(), _getLayerGroup() { return { appendChild(child) { rendered = child; } }; } }, polygon);
    assert.equal(rendered.attributes.get('d'), boardShapeRemovalPathD(polygon),
        'SVG uses the same physical contour as clearance and exports');
    assert.equal(rendered.attributes.get('stroke'), 'none', 'Physical contour is not stroked a second time');
}
const circle = { id: 'circle', kind: 'circle', layer: 'top-copper', filled: true,
    x: 0, y: 0, radius: 2, lineWidth: 0.2, net: 'GND' };
const rectangle = { id: 'rect', kind: 'rect', layer: 'bottom-copper', filled: false, lineWidth: 0.2,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
const hole = { ...circle, id: 'hole', layer: 'hole' };
const clearance = 0.25;
const radius = Math.max(...boardShapeClearanceOutlines(circle, clearance).flat().map(point => Math.hypot(point.x, point.y)));
assert.ok(Math.abs(radius - 2.25) < 0.01, 'Filled circle clearance offsets the outer radius without adding stroke width');
assert.equal(boardShapeClearanceOutlines({ ...circle, filled: false }, clearance).length, 2,
    'Hollow circles preserve inner and outer clearance boundaries');
assert.equal(boardShapeClearanceOutlines(rectangle, clearance).length, 2,
    'Closed strokes merge capsules into inner and outer contours without segment seams');
const line = { id: 'line', kind: 'line', layer: 'top-copper', lineWidth: 0.2,
    segmentWidths: { 0: 1 }, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] };
const lineExtent = Math.max(...boardShapeClearanceOutlines(line, clearance).flat().map(point => point.y));
assert.ok(lineExtent >= 0.75 && lineExtent < 0.78,
    'Segment-width overrides determine the clearance offset, including the conservative fill margin');
const arc = { id: 'arc', kind: 'arc', layer: 'top-copper', lineWidth: 0.2,
    start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: 5 } };
assert.ok(boardShapeClearanceOutlines(arc, clearance).length > 0);
for (const shape of [{ ...circle, layer: 'top-silk' }, { ...circle, copperMode: 'remove-copper' },
    { ...circle, type: 'fill' }]) assert.deepEqual(boardShapeClearanceOutlines(shape, clearance), []);

const source = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
{
    const overlay = element();
    const halo = element();
    overlay.appendChild(halo);
    let tooltipHides = 0;
    const app = { viewport: {}, _active: true, _clearancesVisible: true,
        _layerGroups: new Map([['clearance-overlay', overlay]]),
        _hideNetTooltip() { tooltipHides++; } };
    const panStart = source.indexOf('        this.viewport.onPanStart = () => {');
    const panEnd = source.indexOf('        // Bind mouse events for panning', panStart);
    assert.ok(panStart >= 0 && panEnd > panStart);
    new Function(source.slice(panStart, panEnd)).call(app);
    app.viewport.onPanStart();
    assert.notEqual(overlay.style.display, 'none', 'Panning keeps clearance visible throughout the gesture');
    app.viewport.onPanEnd?.();
    assert.notEqual(overlay.style.display, 'none', 'Clearance stays visible after pan release');
    assert.deepEqual(overlay.children, [halo], 'Panning retains existing clearance geometry');
    assert.equal(halo.removals || 0, 0, 'Panning never detaches clearance lines');
    assert.equal(tooltipHides, 1, 'Panning still dismisses the net tooltip');
}
const start = source.indexOf('    showClearances(show) {');
const end = source.indexOf('\n    /*', start);
assert.ok(start >= 0 && end > start);
const showClearances = new Function('boardShapeClearanceOutlines',
    `return ({ ${source.slice(start, end)} }).showClearances;`)(boardShapeClearanceOutlines);
const refreshStart = source.indexOf('    _refreshBoardShapeClearance(shape) {');
const refreshEnd = source.indexOf('\n    _refreshClearanceHalos()', refreshStart);
let outlineCalls = 0;
let textOutlineCalls = 0;
const refreshShape = new Function('boardShapeClearanceOutlines', 'pcbTextClearanceOutlines',
    `return ({ ${source.slice(refreshStart, refreshEnd)} })._refreshBoardShapeClearance;`)((...args) => {
        outlineCalls++;
        return boardShapeClearanceOutlines(...args);
    }, (...args) => {
        textOutlineCalls++;
        return pcbTextClearanceOutlines(...args);
    });
const toggleStart = source.indexOf('    _onOverlayVisibilityChanged(overlayId, visible) {');
const toggleEnd = source.indexOf('\n    _fitToContent()', toggleStart);
assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
const toggle = new Function('saveLayerPrefs',
    `return ({ ${source.slice(toggleStart, toggleEnd)} })._onOverlayVisibilityChanged;`)(() => {});
const groups = new Map(['top-copper', 'bottom-copper', 'hole', 'clearance-overlay'].map(id => [id, element()]));
const app = {
    placements: new Map(), boardShapes: [circle, rectangle, hole, line, arc],
    _layerGroups: groups, _getLayerGroup(id) { return groups.get(id); },
    _getRoutingParams() { return { clearance, trackWidth: 0.2 }; }, showClearances,
    _refreshBoardShapeClearance: refreshShape, _shapeElements: new Map(),
};
let hatchSchedules = 0;
app._scheduleRemovalHatchRender = () => { hatchSchedules++; };
app._pictureCopperRefreshPending = true;
for (const copperMode of ['remove-copper', 'remove-solder-mask', 'remove-copper-mask']) {
    const removal = { ...circle, id: `pending-${copperMode}`, copperMode };
    renderBoardShape(app, removal, { liveDrag: true });
}
assert.equal(hatchSchedules, 3, 'Every removal mode redraws its hatch during a pending node drag');
renderBoardShape(app, { ...circle, id: 'pending-add', copperMode: 'add' }, { liveDrag: true });
assert.equal(hatchSchedules, 3, 'Additive copper does not redraw removal hatches during a live drag');
app._pictureCopperRefreshPending = false;
const overlay = groups.get('clearance-overlay');
const ids = () => new Set(overlay.children.map(child => child.attributes.get('data-shape-id')));
toggle.call(app, 'clearance', true);
assert.deepEqual(ids(), new Set(['circle', 'rect', 'hole', 'line', 'arc']));
assert.equal(overlay.children.find(child => child.attributes.get('data-shape-id') === 'circle').dataset.net, 'GND');
toggle.call(app, 'clearance', false);
assert.equal(overlay.children.length, 0, 'Eye off removes shape halos');
groups.get('hole').style.display = 'none';
groups.get('bottom-copper').style.display = 'none';
toggle.call(app, 'clearance', true);
assert.deepEqual(ids(), new Set(['circle', 'line', 'arc']), 'Copper halos survive hidden hole layer; hidden copper shapes are omitted');
toggle.call(app, 'clearance', true);
assert.equal(overlay.children.filter(child => child.attributes.get('data-shape-id') === 'circle').length, 1,
    'Refreshing replaces old shape halos');
console.log('PASS shape clearance geometry, segment widths, hollow contours, eye toggling, net tags, and layer visibility');
const circleHalo = overlay.children.find(child => child.attributes.get('data-shape-id') === 'circle');
const callsBeforeMove = outlineCalls;
circle.x += 5;
circle.y += 3;
renderBoardShape(app, circle, { liveDrag: true });
assert.equal(circleHalo.attributes.get('transform'), 'translate(5 3)');
assert.equal(outlineCalls, callsBeforeMove, 'Translation reuses clearance geometry');
circle.x -= 5;
circle.y -= 3;
renderBoardShape(app, circle);
assert.equal(circleHalo.attributes.get('transform'), 'translate(0 0)', 'Cancel/undo restores the halo');
circle.radius = 3;
renderBoardShape(app, circle, { liveDrag: true });
assert.equal(outlineCalls, callsBeforeMove + 1, 'Resize recalculates only the edited shape');
assert.ok(!overlay.children.includes(circleHalo));
console.log('PASS live shape clearance translation, resize and cancellation');
const { pictureShape } = await import('../src/pcb/modules/picture-raster.js');
const image = { ...pictureShape({ width: 3, height: 1, rectangles: [{ x: 0, y: 0, width: 3, height: 1 }] },
    { widthMm: 3, layer: 'top-copper' }), id: 'image' };
app.boardShapes.push(image);
renderBoardShape(app, image);
const imageHalo = overlay.children.find(child => child.attributes.get('data-shape-id') === 'image');
const callsBeforeImageMove = outlineCalls;
image.points = image.points.map(point => ({ x: point.x + 7, y: point.y - 2 }));
renderBoardShape(app, image, { liveDrag: true });
assert.equal(imageHalo.attributes.get('transform'), 'translate(7 -2)');
assert.equal(outlineCalls, callsBeforeImageMove, 'Unassigned image drags reuse the clearance outline');
showClearances.call(app, true);
assert.equal(outlineCalls, callsBeforeImageMove, 'Global refresh reuses unchanged shape outlines');
assert.ok(overlay.children.includes(imageHalo), 'Global refresh reattaches cached halo elements');
image.points = image.points.map(point => ({ x: point.x * 1.1, y: point.y * 1.1 }));
showClearances.call(app, true);
assert.equal(outlineCalls, callsBeforeImageMove + 1, 'Only the resized image is recalculated');
showClearances.call(app, true);
assert.equal(outlineCalls, callsBeforeImageMove + 1, 'Repeated reconciliation does not repeat image offset calculations');
const callsBeforeHide = outlineCalls;
app._pictureCopperRefreshPending = true;
app._pendingShapeClearances = new Map([[image.id, image]]);
const heldHalo = overlay.children.find(child => child.attributes.get('data-shape-id') === 'image');
const heldPoints = heldHalo.attributes.get('points');
const heldTransform = heldHalo.attributes.get('transform');
image.points = image.points.map(point => ({ x: -point.y, y: point.x }));
renderBoardShape(app, image);
showClearances.call(app, true);
assert.equal(outlineCalls, callsBeforeHide, 'Other render paths cannot bypass the pending debounce');
assert.ok(!overlay.children.includes(heldHalo), 'Pending edits hide stale image halos');
assert.equal(heldHalo.attributes.get('points'), heldPoints);
assert.equal(heldHalo.attributes.get('transform'), heldTransform, 'Halo remains at its pre-edit orientation');
app._pictureCopperRefreshPending = false;
showClearances.call(app, true);
assert.equal(outlineCalls, callsBeforeHide + 1, 'Halo catches up once the debounce expires');
assert.ok(overlay.children.some(child => child.attributes.get('data-shape-id') === 'image'),
    'Updated image halo becomes visible after the debounce');
toggle.call(app, 'clearance', false);
renderBoardShape(app, image, { liveDrag: true });
assert.equal(outlineCalls, callsBeforeHide + 1, 'Hidden clearance does no geometry work');
assert.equal(overlay.children.length, 0);
console.log('PASS unassigned image clearance follows dragging without recomputing outlines');
const text = { id: 'text-clearance', content: 'O', x: 3, y: 4, size: 5, strokeWidth: 0.2, rotation: 0, layer: 'top-copper' };
app.texts = new Map([[text.id, text]]);
showClearances.call(app, true);
const textHalos = () => overlay.children.filter(child => child.attributes.get('data-shape-id') === text.id);
assert.ok(textHalos().length >= 2, 'Text clearance follows glyphs and preserves holes');
const originalTextHalo = textHalos()[0];
text.x += 2;
refreshShape.call(app, text);
assert.equal(originalTextHalo.attributes.get('transform'), 'translate(2 0)');
app._pictureCopperRefreshPending = true;
app._pendingShapeClearances = new Map([[text.id, text]]);
text.rotation = 90;
showClearances.call(app, true);
assert.equal(textHalos().length, 0, 'Text clearance is hidden while the shared refresh is pending');
app._pictureCopperRefreshPending = false;
showClearances.call(app, true);
assert.ok(textHalos().length >= 2);
assert.ok(!overlay.children.includes(originalTextHalo), 'Rotation invalidates cached glyph clearance');
app.texts.delete(text.id);
showClearances.call(app, true);
assert.equal(textHalos().length, 0);
assert.equal(app._boardShapeClearanceCache.has(text.id), false);
console.log('PASS text clearance rendering, translation cache, deferred rotation and deletion');
const { schedulePictureCopperRefresh } = await import('../src/pcb/modules/picture-refresh.js');
const { MoveTextCommand } = await import('../src/pcb/modules/text-commands.js');
const { startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag } = await import('../src/pcb/modules/board-shapes.js');
const dropStart = source.indexOf('    _endTextDrag(commit = true) {');
const dropEnd = source.indexOf('\n    //', dropStart);
assert.ok(dropStart >= 0 && dropEnd > dropStart);
const endTextDrag = new Function('MoveTextCommand',
    `return ({ ${source.slice(dropStart, dropEnd)} })._endTextDrag;`)(MoveTextCommand);
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let deferred;
try {
    globalThis.setTimeout = callback => { deferred = callback; return 1; };
    globalThis.clearTimeout = () => { deferred = null; };
    app._pendingShapeClearances = null;
    app._refreshFills = () => false;
    app._updateRatsnest = options => {
        assert.deepEqual(options, { skipFillRefresh: true }, 'No clearance flags are needed for connectivity');
    };
    app.texts.set(text.id, text);
    app._refreshText = id => refreshShape.call(app, app.texts.get(id));
    app.viewport = { svg: { style: {} }, hideCrosshair() {} };
    const commands = [];
    app.history = { execute(command) { commands.push(command); command.execute(); } };
    refreshShape.call(app, text);
    const cachedTextHalos = textHalos().map(child => ({ child, removals: child.removals || 0 }));
    const calculationsBeforeDrop = textOutlineCalls;
    const startPos = { x: text.x, y: text.y };
    app._textDrag = { textId: text.id, startPos, previousDeferDragOverlays: false };
    app._deferDragOverlays = true;
    text.x += 7;
    text.y -= 2;
    app._refreshText(text.id);
    const assertTextHaloRetained = transform => {
        assert.equal(textOutlineCalls, calculationsBeforeDrop, 'Text movement never recalculates clearance geometry');
        for (const { child, removals } of cachedTextHalos) {
            assert.equal(child.parentNode, overlay, 'Moved text halo remains attached');
            assert.equal(child.removals || 0, removals, 'Moved text halo is never temporarily removed');
            assert.equal(child.attributes.get('transform'), transform);
        }
    };
    endTextDrag.call(app);
    assert.equal(commands.length, 1);
    assert.equal(app._pendingShapeClearances?.has(text.id) || false, false, 'Drop does not invalidate translated text clearance');
    assertTextHaloRetained('translate(7 -2)');
    commands[0].undo();
    assertTextHaloRetained('translate(0 0)');
    commands[0].execute();
    assertTextHaloRetained('translate(7 -2)');
    let movedTextPourRefreshes = 0;
    let drcRefreshes = 0;
    app._drcShouldRun = () => true;
    app._scheduleDRC = () => { drcRefreshes++; };
    app._refreshFills = () => { movedTextPourRefreshes++; return false; };
    deferred();
    assert.equal(movedTextPourRefreshes, 1, 'Moved text still refreshes copper pours after the debounce');
    assert.equal(drcRefreshes, 1, 'Moved text schedules DRC even without pours');
    assertTextHaloRetained('translate(7 -2)');
    console.log('PASS text drop, undo, redo and deferred pour refresh retain translated clearance without recalculation');
    const polygon = { ...rectangle, kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 2, y: 4 }] };
    app.viewport.scale = 10;
    app.viewport.setCrosshair = () => {};
    app._snapToGrid = point => point;
    for (const fixture of [circle, line, rectangle, polygon, arc, image]) {
        for (const pourQueued of [false, true]) {
            const shape = { ...structuredClone(fixture), id: `move-${fixture.kind}-${pourQueued}`, layer: 'top-copper', net: '' };
            app.boardShapes.push(shape);
            renderBoardShape(app, shape);
            const cached = app._boardShapeClearanceCache.get(shape.id);
            assert.ok(cached.elements.length, `${shape.kind} has a visible halo`);
            const haloStates = cached.elements.map(child => ({ child, removals: child.removals || 0 }));
            const outlineCount = outlineCalls;
            const historyCount = commands.length;
            let pours = 0;
            drcRefreshes = 0;
            app._refreshFills = () => { pours++; return pourQueued; };
            deferred = null;
            startBoardShapeDrag(app, shape, { x: 1000, y: 1000 });
            assert.equal(app._shapeDrag.mode, 'move');
            handleBoardShapeDrag(app, { x: 1007, y: 998 });
            const assertTranslatedHalo = transform => {
                assert.equal(outlineCalls, outlineCount, `${shape.kind} translation does not recalculate clearance`);
                assert.equal(app._boardShapeClearanceCache.get(shape.id), cached);
                for (const { child, removals } of haloStates) {
                    assert.equal(child.parentNode, overlay);
                    assert.equal(child.removals || 0, removals, `${shape.kind} never detaches its halo`);
                    assert.equal(child.attributes.get('transform'), transform);
                }
            };
            assertTranslatedHalo('translate(7 -2)');
            assert.equal(deferred, null, 'Moving does not schedule geometry recalculation');
            endBoardShapeDrag(app, true);
            assert.equal(commands.length, historyCount + 1);
            assertTranslatedHalo('translate(7 -2)');
            const command = commands.at(-1);
            command.undo();
            assertTranslatedHalo('translate(0 0)');
            command.execute();
            assertTranslatedHalo('translate(7 -2)');
            assert.equal(pours, 0, 'Release work is coalesced');
            deferred();
            assert.equal(pours, 1, 'Release/undo/redo coalesce to one pour refresh');
            assert.equal(drcRefreshes, pourQueued ? 0 : 1,
                'DRC runs without pours; queued pours own the DRC check after recomputation');
            assertTranslatedHalo('translate(7 -2)');
        }
    }
    console.log('PASS all board-shape translations retain halos through drag/drop and undo/redo, with pour/DRC release updates');
    const trackHalo = element();
    overlay.appendChild(trackHalo);
    const untouched = overlay.children.filter(child => child.attributes.get('data-shape-id') !== image.id)
        .map(child => ({ child, removals: child.removals || 0 }));
    const beforeEdit = outlineCalls;
    schedulePictureCopperRefresh(app, image);
    image.points = image.points.map(point => ({ x: point.x * 1.1, y: point.y * 1.1 }));
    refreshShape.call(app, circle);
    for (const { child, removals } of untouched) {
        assert.equal(child.parentNode, overlay, 'Unrelated halos remain visible during editing');
        assert.equal(child.removals || 0, removals);
    }
    deferred();
    assert.equal(outlineCalls, beforeEdit + 1, 'Only the edited image clearance is calculated');
    for (const { child, removals } of untouched) {
        assert.equal(child.parentNode, overlay, 'Unrelated halos remain attached after release');
        assert.equal(child.removals || 0, removals, 'Unrelated halo DOM was never removed');
    }
    assert.ok(overlay.children.some(child => child.attributes.get('data-shape-id') === image.id));
} finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
}
console.log('PASS deferred image edit updates only its halo without detaching unrelated clearance');