import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { setPictureCopperRefreshPending } from '../../src/pcb/modules/refresh-state.js';
import { endTextDrag, getTextDrag } from '../../src/pcb/modules/pcb-text-selection.js';
import { getBoardShapeDrag } from '../../src/pcb/modules/board-shape-drag.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import { getDrcPresentation } from '../../src/pcb/modules/drc-state.js';
import { getNetTooltipElement, updateNetTooltip } from '../../src/pcb/modules/net-tooltip.js';
import {
    clearanceOverlayState,
    getBoardShapeClearance,
    refreshBoardShapeClearance,
    showClearances as showClearanceOverlay,
} from '../../src/pcb/modules/clearance-overlay.js';
import { isShapeClearancePending, pictureRefreshState } from '../../src/pcb/modules/picture-refresh.js';
import { notifyOverlayVisibilityChanged } from '../../src/pcb/modules/layers.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const document = installFakeDom();
const element = (tag = 'g') => {
    const node = fakeElement(tag);
    node.attributes = new Map();
    const setAttribute = node.setAttribute.bind(node);
    const getAttribute = node.getAttribute.bind(node);
    const removeAttribute = node.removeAttribute.bind(node);
    const removeChild = node.removeChild.bind(node);
    node.setAttribute = (name, value) => { node.attributes.set(name, String(value)); setAttribute(name, value); };
    node.getAttribute = name => node.attributes.get(name) ?? getAttribute(name);
    node.removeAttribute = name => { node.attributes.delete(name); removeAttribute(name); };
    node.removeChild = child => {
        assert.ok(node.children.includes(child));
        child.removals = (child.removals || 0) + 1;
        return removeChild(child);
    };
    return node;
};
document.createElementNS = (_namespace, tag) => element(tag);
document.createElement = tag => element(tag);
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { boardShapeClearanceOutlines } = await import('../../src/pcb/modules/copper-fill-geom.js');
const { beginDragSession } = await import('../../src/pcb/modules/drag-session.js');
const { resolveBoardShapeGeometry, boardShapeRemovalPathD } = await import('../../src/shared/pcb/board-shape-geometry.js');
const { getBoardShapeAnchors } = await import('../../src/pcb/modules/board-shapes.js');
const { renderBoardShape } = await import('../../src/pcb/modules/board-shape-render.js');

let outlineCalls = 0;
let textOutlineCalls = 0;

function wrapClearanceCounter(targetApp, countShape = () => outlineCalls++, countText = () => textOutlineCalls++) {
    const cache = clearanceOverlayState(targetApp).boardShapeClearanceCache;
    const set = cache.set.bind(cache);
    cache.set = (id, value) => {
        if (value?.elements?.length) {
            const shape = targetApp.texts?.get(id) || targetApp.boardShapes?.find(item => item.id === id);
            if (typeof shape?.content === 'string') countText();
            else countShape();
        }
        return set(id, value);
    };
    return cache;
}

for (const filled of [false, true]) {
    const polygon = { id: 'acute', kind: 'polygon', layer: 'top-copper', lineWidth: 2, cornerRadius: 0, filled,
        points: [{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }] };
    const tip = getBoardShapeAnchors(polygon)[0];
    const contours = resolveBoardShapeGeometry(polygon).physicalContours;
    assert.deepEqual({ x: tip.x, y: tip.y }, polygon.points[0], 'Acute corner handle stays on the centreline');
    const physicalTip = Math.min(...contours.flat().map(point => point.y));
    assert.ok(Math.abs(physicalTip - (tip.y - polygon.lineWidth / 2)) < 0.003,
        'Round join extends only half the stroke width beyond the centreline corner');
    const clearanceTip = Math.min(...boardShapeClearanceOutlines(polygon, 0.25).flat().map(point => point.y));
    assert.ok(physicalTip - clearanceTip >= 0.24 && physicalTip - clearanceTip < 0.29,
        'Clearance extends by the requested distance beyond the actual acute tip');
    let rendered;
    renderBoardShape({ _shapeElements: new Map(), getLayerGroup() { return { appendChild(child) { rendered = child; } }; } }, polygon);
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

{
    const overlay = element();
    const halo = element();
    overlay.appendChild(halo);
    const app = { viewport: {},
        _layerGroups: new Map([['clearance-overlay', overlay]]), existingLayerGroups() { return this._layerGroups; } };
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = callback => { callback(); return 1; };
    updateNetTooltip(app, { clientX: 0, clientY: 0 }, { type: 'via', via: { net: 'N1' } });
    globalThis.setTimeout = nativeSetTimeout;
    PCBApp.prototype._bindViewportPanHooks.call(app);
    app.viewport.onPanStart();
    assert.notEqual(overlay.style.display, 'none', 'Panning keeps clearance visible throughout the gesture');
    app.viewport.onPanEnd?.();
    assert.notEqual(overlay.style.display, 'none', 'Clearance stays visible after pan release');
    assert.deepEqual(overlay.children, [halo], 'Panning retains existing clearance geometry');
    assert.equal(halo.removals || 0, 0, 'Panning never detaches clearance lines');
    assert.equal(getNetTooltipElement(app).style.display, 'none', 'Panning still dismisses the net tooltip');
}
// The real clearance methods, run against this test's editor.
const showClearances = PCBApp.prototype.showClearances;
const refreshVia = PCBApp.prototype._refreshViaClearance;
const groups = new Map(['top-copper', 'bottom-copper', 'hole', 'vias', 'clearance-overlay'].map(id => [id, element()]));
const pcbDocument = new PcbDocument();
pcbDocument.boardShapes.push(circle, rectangle, hole, line, arc);
const app = {
    pcbDocument, texts: pcbDocument.texts,
    placements: new Map(), boardShapes: pcbDocument.boardShapes,
    _layerGroups: groups, existingLayerGroups: () => groups, getLayerGroup(id) { return groups.get(id); },
    getRoutingParams() { return { clearance, trackWidth: 0.2 }; }, showClearances, _refreshViaClearance: refreshVia,
    _shapeElements: new Map(),
};
wrapClearanceCounter(app);
setPictureCopperRefreshPending(app, true);
for (const copperMode of ['remove-copper', 'remove-solder-mask', 'remove-copper-mask', 'add']) {
    const shape = { ...circle, id: `pending-${copperMode}`, copperMode };
    assert.doesNotThrow(() => renderBoardShape(app, shape, { liveDrag: true }), `${copperMode} renders during a pending node drag`);
}
setPictureCopperRefreshPending(app, false);
const overlay = groups.get('clearance-overlay');
const ids = () => new Set(overlay.children.map(child => child.attributes.get('data-shape-id')));
notifyOverlayVisibilityChanged(app, 'clearance', true);
assert.deepEqual(ids(), new Set(['circle', 'rect', 'hole', 'line', 'arc']));
assert.equal(overlay.children.find(child => child.attributes.get('data-shape-id') === 'circle').dataset.net, 'GND');
notifyOverlayVisibilityChanged(app, 'clearance', false);
assert.equal(overlay.children.length, 0, 'Eye off removes shape halos');
groups.get('hole').style.display = 'none';
groups.get('bottom-copper').style.display = 'none';
notifyOverlayVisibilityChanged(app, 'clearance', true);
assert.deepEqual(ids(), new Set(['circle', 'line', 'arc']), 'Copper halos survive hidden hole layer; hidden copper shapes are omitted');
notifyOverlayVisibilityChanged(app, 'clearance', true);
assert.equal(overlay.children.filter(child => child.attributes.get('data-shape-id') === 'circle').length, 1,
    'Refreshing replaces old shape halos');
console.log('PASS shape clearance geometry, segment widths, hollow contours, eye toggling, net tags, and layer visibility');
const circleHalo = overlay.children.find(child => child.attributes.get('data-shape-id') === 'circle');
const circleCacheBeforeMove = getBoardShapeClearance(app, circle.id);
const callsBeforeMove = outlineCalls;
circle.x += 5;
circle.y += 3;
renderBoardShape(app, circle, { liveDrag: true });
assert.equal(circleHalo.attributes.get('transform'), 'translate(5 3)');
assert.equal(outlineCalls, callsBeforeMove, 'Translation reuses clearance geometry');
assert.equal(getBoardShapeClearance(app, circle.id), circleCacheBeforeMove, 'Translation reuses clearance geometry');
circle.x -= 5;
circle.y -= 3;
renderBoardShape(app, circle);
assert.equal(circleHalo.attributes.get('transform'), 'translate(0 0)', 'Cancel/undo restores the halo');
circle.radius = 3;
renderBoardShape(app, circle, { liveDrag: true });
assert.equal(outlineCalls, callsBeforeMove + 1, 'Resize recalculates only the edited shape');
assert.notEqual(getBoardShapeClearance(app, circle.id), circleCacheBeforeMove, 'Resize recalculates only the edited shape');
assert.ok(!overlay.children.includes(circleHalo));
console.log('PASS live shape clearance translation, resize and cancellation');
const { pictureShape } = await import('../../src/shared/pcb/picture-raster.js');
const image = { ...pictureShape({ width: 3, height: 1, rectangles: [{ x: 0, y: 0, width: 3, height: 1 }] },
    { widthMm: 3, layer: 'top-copper' }), id: 'image' };
app.boardShapes.push(image);
renderBoardShape(app, image);
const imageHalo = overlay.children.find(child => child.attributes.get('data-shape-id') === 'image');
const imageCacheBeforeMove = getBoardShapeClearance(app, image.id);
const callsBeforeImageMove = outlineCalls;
image.points = image.points.map(point => ({ x: point.x + 7, y: point.y - 2 }));
renderBoardShape(app, image, { liveDrag: true });
assert.equal(imageHalo.attributes.get('transform'), 'translate(7 -2)');
assert.equal(outlineCalls, callsBeforeImageMove, 'Unassigned image drags reuse the clearance outline');
assert.equal(getBoardShapeClearance(app, image.id), imageCacheBeforeMove, 'Unassigned image drags reuse the clearance outline');
showClearances.call(app, true);
assert.equal(outlineCalls, callsBeforeImageMove, 'Global refresh reuses unchanged shape outlines');
assert.equal(getBoardShapeClearance(app, image.id), imageCacheBeforeMove, 'Global refresh reuses unchanged shape outlines');
assert.ok(overlay.children.includes(imageHalo), 'Global refresh reattaches cached halo elements');
image.points = image.points.map(point => ({ x: point.x * 1.1, y: point.y * 1.1 }));
showClearances.call(app, true);
const imageCacheAfterResize = getBoardShapeClearance(app, image.id);
assert.equal(outlineCalls, callsBeforeImageMove + 1, 'Only the resized image is recalculated');
assert.notEqual(imageCacheAfterResize, imageCacheBeforeMove, 'Only the resized image is recalculated');
showClearances.call(app, true);
assert.equal(outlineCalls, callsBeforeImageMove + 1, 'Repeated reconciliation does not repeat image offset calculations');
assert.equal(getBoardShapeClearance(app, image.id), imageCacheAfterResize, 'Repeated reconciliation does not repeat image offset calculations');
const cacheBeforeHide = getBoardShapeClearance(app, image.id);
const callsBeforeHide = outlineCalls;
setPictureCopperRefreshPending(app, true);
pictureRefreshState(app).pendingShapeClearances = new Map([[image.id, image]]);
const heldHalo = overlay.children.find(child => child.attributes.get('data-shape-id') === 'image');
const heldPoints = heldHalo.attributes.get('points');
const heldTransform = heldHalo.attributes.get('transform');
image.points = image.points.map(point => ({ x: -point.y, y: point.x }));
renderBoardShape(app, image);
showClearances.call(app, true);
assert.equal(outlineCalls, callsBeforeHide, 'Other render paths cannot bypass the pending debounce');
assert.equal(getBoardShapeClearance(app, image.id), cacheBeforeHide, 'Other render paths cannot bypass the pending debounce');
assert.ok(!overlay.children.includes(heldHalo), 'Pending edits hide stale image halos');
assert.equal(heldHalo.attributes.get('points'), heldPoints);
assert.equal(heldHalo.attributes.get('transform'), heldTransform, 'Halo remains at its pre-edit orientation');
setPictureCopperRefreshPending(app, false);
showClearances.call(app, true);
assert.equal(outlineCalls, callsBeforeHide + 1, 'Halo catches up once the debounce expires');
assert.notEqual(getBoardShapeClearance(app, image.id), cacheBeforeHide, 'Halo catches up once the debounce expires');
assert.ok(overlay.children.some(child => child.attributes.get('data-shape-id') === 'image'),
    'Updated image halo becomes visible after the debounce');
notifyOverlayVisibilityChanged(app, 'clearance', false);
renderBoardShape(app, image, { liveDrag: true });
assert.equal(outlineCalls, callsBeforeHide + 1, 'Hidden clearance does no geometry work');
assert.equal(overlay.children.length, 0, 'Hidden clearance does no geometry work');
assert.equal(overlay.children.length, 0);
console.log('PASS unassigned image clearance follows dragging without recomputing outlines');
const text = { id: 'text-clearance', content: 'O', x: 3, y: 4, size: 5, strokeWidth: 0.2, rotation: 0, layer: 'top-copper' };
app.texts.set(text.id, text);
showClearances.call(app, true);
const textHalos = () => overlay.children.filter(child => child.attributes.get('data-shape-id') === text.id);
assert.ok(textHalos().length >= 2, 'Text clearance follows glyphs and preserves holes');
const originalTextHalo = textHalos()[0];
text.x += 2;
refreshBoardShapeClearance(app, text);
assert.equal(originalTextHalo.attributes.get('transform'), 'translate(2 0)');
setPictureCopperRefreshPending(app, true);
pictureRefreshState(app).pendingShapeClearances = new Map([[text.id, text]]);
text.rotation = 90;
showClearances.call(app, true);
assert.equal(textHalos().length, 0, 'Text clearance is hidden while the shared refresh is pending');
setPictureCopperRefreshPending(app, false);
showClearances.call(app, true);
assert.ok(textHalos().length >= 2);
assert.ok(!overlay.children.includes(originalTextHalo), 'Rotation invalidates cached glyph clearance');
app.texts.delete(text.id);
showClearances.call(app, true);
assert.equal(textHalos().length, 0);
assert.equal(getBoardShapeClearance(app, text.id), undefined);
console.log('PASS text clearance rendering, translation cache, deferred rotation and deletion');
const { schedulePictureCopperRefresh } = await import('../../src/pcb/modules/picture-refresh.js');
const { startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag } = await import('../../src/pcb/modules/board-shape-drag.js');
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let deferred;
try {
    globalThis.setTimeout = callback => { deferred = callback; return 1; };
    globalThis.clearTimeout = () => { deferred = null; };
    pictureRefreshState(app).pendingShapeClearances = null;
    app.refreshFills = () => false;
    app.updateRatsnest = options => {
        assert.deepEqual(options, { skipFillRefresh: true }, 'No clearance flags are needed for connectivity');
    };
    app.texts.set(text.id, text);
    app.refreshText = id => refreshBoardShapeClearance(app, app.texts.get(id));
    app.viewport = { svg: { style: {} }, hideCrosshair() {} };
    const commands = [];
    app.history = { execute(command) { commands.push(command); command.execute(); } };
    refreshBoardShapeClearance(app, text);
    const cachedTextHalos = textHalos().map(child => ({ child, removals: child.removals || 0 }));
    const textCacheBeforeDrop = getBoardShapeClearance(app, text.id);
    const calculationsBeforeDrop = textOutlineCalls;
    const startPos = { x: text.x, y: text.y };
    setPcbInteraction(app, '_textDrag', { textId: text.id, startPos, session: beginDragSession(app) });
    text.x += 7;
    text.y -= 2;
    app.refreshText(text.id);
    const assertTextHaloRetained = transform => {
        assert.equal(textOutlineCalls, calculationsBeforeDrop, 'Text movement never recalculates clearance geometry');
        assert.equal(getBoardShapeClearance(app, text.id), textCacheBeforeDrop, 'Text movement never recalculates clearance geometry');
        for (const { child, removals } of cachedTextHalos) {
            assert.equal(child.parentNode, overlay, 'Moved text halo remains attached');
            assert.equal(child.removals || 0, removals, 'Moved text halo is never temporarily removed');
            assert.equal(child.attributes.get('transform'), transform);
        }
    };
    endTextDrag(app);
    assert.equal(commands.length, 1);
    assert.equal(isShapeClearancePending(app, text), false, 'Drop does not invalidate translated text clearance');
    assertTextHaloRetained('translate(7 -2)');
    commands[0].undo();
    assertTextHaloRetained('translate(0 0)');
    commands[0].execute();
    assertTextHaloRetained('translate(7 -2)');
    let movedTextPourRefreshes = 0;
    let drcRefreshes = 0;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = callback => { drcRefreshes++; callback(); return drcRefreshes; };
    getDrcPresentation(app).shouldRun = () => true;
    app.refreshFills = () => { movedTextPourRefreshes++; return false; };
    deferred();
    assert.equal(movedTextPourRefreshes, 1, 'Moved text still refreshes copper pours after the debounce');
    assert.equal(drcRefreshes, 1, 'Moved text schedules DRC even without pours');
    assertTextHaloRetained('translate(7 -2)');
    console.log('PASS text drop, undo, redo and deferred pour refresh retain translated clearance without recalculation');
    const polygon = { ...rectangle, kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 2, y: 4 }] };
    app.viewport.scale = 10;
    app.viewport.setCrosshair = () => {};
    app.snapToGrid = point => point;
    // Copper lines and unfilled outlines are Tracks; board-shape copper is areas, arcs and artwork.
    for (const fixture of [circle, rectangle, polygon, arc, image]) {
        for (const pourQueued of [false, true]) {
            const shape = { ...structuredClone(fixture), id: `move-${fixture.kind}-${pourQueued}`, layer: 'top-copper', net: '',
                ...(['rect', 'polygon'].includes(fixture.kind) ? { filled: true } : {}) };
            app.boardShapes.push(shape);
            renderBoardShape(app, shape);
            const cached = getBoardShapeClearance(app, shape.id);
            assert.ok(cached.elements.length, `${shape.kind} has a visible halo`);
            const haloStates = cached.elements.map(child => ({ child, removals: child.removals || 0 }));
            const outlineCount = outlineCalls;
            const historyCount = commands.length;
            let pours = 0;
            drcRefreshes = 0;
            app.refreshFills = () => { pours++; return pourQueued; };
            deferred = null;
            startBoardShapeDrag(app, shape, { x: 1000, y: 1000 });
            assert.equal(getBoardShapeDrag(app).mode, 'move');
            handleBoardShapeDrag(app, { x: 1007, y: 998 });
            const assertTranslatedHalo = transform => {
                assert.equal(outlineCalls, outlineCount, `${shape.kind} translation does not recalculate clearance`);
                assert.equal(getBoardShapeClearance(app, shape.id), cached, `${shape.kind} translation does not recalculate clearance`);
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
    if (originalRequestAnimationFrame) globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    else delete globalThis.requestAnimationFrame;
    console.log('PASS all board-shape translations retain halos through drag/drop and undo/redo, with pour/DRC release updates');
    for (const mode of ['vertex', 'segment', 'midpoint', 'bulge']) for (const commit of [false, true]) {
        const shape = { id: `live-line-${mode}-${commit}`, kind: 'polygon', filled: true, layer: 'top-copper', lineWidth: 0.4,
            points: [{ x: 30, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 50 }],
            segmentWidths: { 1: 0.8 }, segmentBulges: mode === 'bulge' ? { 0: 0.2 } : {} };
        app.boardShapes.push(shape);
        renderBoardShape(app, shape);
        const saved = structuredClone(shape);
        const cached = getBoardShapeClearance(app, shape.id);
        const beforePoints = cached.elements.map(child => child.getAttribute('points'));
        const stationary = [...getBoardShapeClearance(app, circle.id).elements];
        const handle = mode === 'vertex' ? 0 : mode === 'midpoint' ? 'mid:0' : mode === 'bulge' ? 'bulge:0' : null;
        const start = mode === 'segment' || mode === 'midpoint' ? { x: 35, y: 40 }
            : mode === 'bulge' ? getBoardShapeAnchors(shape).find(anchor => anchor.id === handle) : shape.points[0];
        startBoardShapeDrag(app, shape, start, handle, { allowSegment: mode === 'segment' });
        assert.ok(cached.elements.every(child => child.parentNode === overlay), `${mode}: pickup keeps clearance visible`);
        handleBoardShapeDrag(app, { x: start.x + 2, y: start.y + 3 });
        const preview = getBoardShapeDrag(app).shape;
        const actual = () => getBoardShapeClearance(app, shape.id).elements;
        const expected = boardShapeClearanceOutlines(preview, clearance)
            .map(contour => contour.map(point => `${point.x},${point.y}`).join(' '));
        assert.ok(actual().length && actual().every(child => child.parentNode === overlay), `${mode}: live clearance is visible`);
        assert.deepEqual(actual().map(child => child.getAttribute('points')), expected, `${mode}: exact preview offset`);
        assert.notDeepEqual(expected, beforePoints, `${mode}: outline changes with the edit`);
        assert.deepEqual(shape, saved, 'clearance does not mutate the authored line');
        assert.ok(stationary.every(child => child.parentNode === overlay), 'unrelated outlines stay attached');
        clearanceOverlayState(app).clearancesVisible = false;
        while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
        handleBoardShapeDrag(app, { x: start.x + 3, y: start.y + 4 });
        assert.equal(overlay.children.length, 0, 'editing cannot resurrect disabled clearance');
        clearanceOverlayState(app).clearancesVisible = true;
        refreshBoardShapeClearance(app, getBoardShapeDrag(app).shape);
        endBoardShapeDrag(app, commit);
        assert.ok(actual().length && actual().every(child => child.parentNode === overlay), 'drop/cancel retains clearance');
        if (!commit) assert.deepEqual(actual().map(child => child.getAttribute('points')), beforePoints);
        else {
            const command = commands.at(-1);
            command.undo();
            assert.deepEqual(actual().map(child => child.getAttribute('points')), beforePoints, 'undo restores outline');
            command.execute();
            assert.ok(actual().every(child => child.parentNode === overlay), 'redo retains outline');
        }
        if (deferred) deferred();
        showClearances.call(app, true);
    }
    console.log('PASS line vertex/segment/midpoint/bulge drags retain live clearance through drop, cancel and history');
    const trackHalo = element();
    overlay.appendChild(trackHalo);
    const untouched = overlay.children.filter(child => child.attributes.get('data-shape-id') !== image.id)
        .map(child => ({ child, removals: child.removals || 0 }));
    const imageCacheBeforeEdit = getBoardShapeClearance(app, image.id);
    const beforeEdit = outlineCalls;
    schedulePictureCopperRefresh(app, image);
    image.points = image.points.map(point => ({ x: point.x * 1.1, y: point.y * 1.1 }));
    refreshBoardShapeClearance(app, circle);
    for (const { child, removals } of untouched) {
        assert.equal(child.parentNode, overlay, 'Unrelated halos remain visible during editing');
        assert.equal(child.removals || 0, removals);
    }
    deferred();
    assert.equal(outlineCalls, beforeEdit + 1, 'Only the edited image clearance is calculated');
    assert.notEqual(getBoardShapeClearance(app, image.id), imageCacheBeforeEdit, 'Only the edited image clearance is calculated');
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

for (const [kind, filled] of [['line', false], ['polygon', false], ['polygon', true]]) {
    for (const layer of ['top-copper', 'bottom-copper', 'hole']) {
        const shape = { id: 'curved-clearance', kind, filled, layer, lineWidth: 0.4,
            segmentBulges: { 0: 0.2 }, points: kind === 'line'
                ? [{ x: 0, y: 0 }, { x: 10, y: 0 }]
                : [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
        const layers = new Map([layer, 'clearance-overlay'].map(id => [id, element()]));
        const curveApp = { _shapeElements: new Map(), _layerGroups: layers, existingLayerGroups: () => layers,
            getLayerGroup: id => layers.get(id), getRoutingParams: () => ({ clearance }) };
        clearanceOverlayState(curveApp).clearancesVisible = true;
        wrapClearanceCounter(curveApp);
        const haloPoints = () => getBoardShapeClearance(curveApp, shape.id).elements
            .map(child => child.getAttribute('points'));
        renderBoardShape(curveApp, shape);
        for (const bulge of [0.65, -0.45, undefined, 0.2]) {
            const previousPoints = haloPoints();
            const previousElements = [...getBoardShapeClearance(curveApp, shape.id).elements];
            const before = getBoardShapeClearance(curveApp, shape.id);
            const callsBeforeCurve = outlineCalls;
            if (bulge === undefined) delete shape.segmentBulges[0];
            else shape.segmentBulges[0] = bulge;
            const expected = boardShapeClearanceOutlines(shape, clearance)
                .map(contour => contour.map(point => `${point.x},${point.y}`).join(' '));
            assert.notDeepEqual(expected, previousPoints, 'Changing curvature changes physical clearance geometry');
            renderBoardShape(curveApp, shape, { liveDrag: true });
            assert.deepEqual(haloPoints(), expected, `${kind}/${layer}: clearance follows segment curvature changes`);
            assert.equal(outlineCalls, callsBeforeCurve + 1, 'Curvature invalidates the cached outline exactly once');
            assert.notEqual(getBoardShapeClearance(curveApp, shape.id), before, 'Curvature invalidates the cached outline exactly once');
            assert.ok(previousElements.every(child => child.parentNode === null), 'Stale halo elements are removed');
            const refreshed = getBoardShapeClearance(curveApp, shape.id);
            renderBoardShape(curveApp, shape);
            assert.equal(outlineCalls, callsBeforeCurve + 1, 'Unchanged curvature retains the geometry cache');
            assert.equal(getBoardShapeClearance(curveApp, shape.id), refreshed, 'Unchanged curvature retains the geometry cache');
        }
        const cached = getBoardShapeClearance(curveApp, shape.id);
        const beforeMove = outlineCalls;
        shape.points = shape.points.map(point => ({ x: point.x + 7, y: point.y - 2 }));
        renderBoardShape(curveApp, shape, { liveDrag: true });
        assert.equal(outlineCalls, beforeMove, 'Curved-shape translation still avoids clearance recalculation');
        assert.equal(getBoardShapeClearance(curveApp, shape.id), cached, 'Curved-shape translation still avoids clearance recalculation');
        for (const child of cached.elements) {
            assert.equal(child.parentNode, layers.get('clearance-overlay'));
            assert.equal(child.getAttribute('transform'), 'translate(7 -2)');
        }
    }
}
console.log('PASS curved line/polygon clearance invalidation, straightening, restoration and translation reuse');