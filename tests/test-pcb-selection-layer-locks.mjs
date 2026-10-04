import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { getTextPosePreviewTexts } from '../src/pcb/modules/text-commands.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import * as layers from '../src/pcb/modules/layers.js';
import { trackIsSelectable } from '../src/pcb/modules/track-select.js';
import { viaBounds } from '../src/shapes/via.js';
import { lockPositionOutsideOutline } from '../src/pcb/modules/selection-anchors.js';
import {
    LOCK_BOUNDS,
    LOCK_MIN_SCREEN_PX,
    LOCK_SCREEN_GAP_PX,
    lockIconMetrics,
} from '../src/core/ui-helpers.js';

const square = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }];
const rightEdgeLock = lockPositionOutsideOutline(square, { x: 20, y: 6 }, 20);
assert.ok(rightEdgeLock.x > 20, 'Outline lock is placed outside the edge nearest the pointer');
assert.ok(rightEdgeLock.x < 20.5, 'Outline lock stays five screen pixels from the selected object');
assert.ok(Math.abs(rightEdgeLock.y - 6) < 1, 'Outline lock follows the pointer along the object edge');
assert.ok(Math.abs(rightEdgeLock.x + LOCK_BOUNDS.minX - 20 - LOCK_SCREEN_GAP_PX / 20) < 1e-9);

const topEdgeLock = lockPositionOutsideOutline(square, { x: 10, y: 0 }, 20);
assert.ok(Math.abs(-(topEdgeLock.y + LOCK_BOUNDS.maxY) - LOCK_SCREEN_GAP_PX / 20) < 1e-9,
    'top and side lock placements have the same visible screen gap');
const lowZoomMetrics = lockIconMetrics(2);
assert.equal(lowZoomMetrics.size * 2, LOCK_MIN_SCREEN_PX,
    'lock body retains its minimum screen width at low zoom');

const diagonal = [{ x: 0, y: 0 }, { x: 20, y: 10 }];
const diagonalLock = lockPositionOutsideOutline(diagonal, { x: 10, y: 5 }, 20, false, 2);
const diagonalOutward = { x: 1 / Math.sqrt(5), y: -2 / Math.sqrt(5) };
const diagonalBoundary = {
    x: 10 + diagonalOutward.x * 2,
    y: 5 + diagonalOutward.y * 2,
};
const diagonalNearestProjection = diagonalOutward.x * LOCK_BOUNDS.minX
    + diagonalOutward.y * LOCK_BOUNDS.maxY;
const diagonalGap = diagonalOutward.x * (diagonalLock.x - diagonalBoundary.x)
    + diagonalOutward.y * (diagonalLock.y - diagonalBoundary.y)
    + diagonalNearestProjection;
assert.ok(
    Math.abs(diagonalGap - LOCK_SCREEN_GAP_PX / 20) < 1e-9,
    'diagonal lock placement keeps the same visible five-pixel gap',
);

const sampledArc = [
    [{ x: -10, y: 0 }, { x: -5, y: -5 }],
    [{ x: -5, y: -5 }, { x: 0, y: -6 }],
    [{ x: 0, y: -6 }, { x: 5, y: -5 }],
    [{ x: 5, y: -5 }, { x: 10, y: 0 }],
];
const sampledArcLock = lockPositionOutsideOutline(
    sampledArc, { x: 0, y: -6 }, 20, false, sampledArc.map(() => 6),
);
assert.ok(sampledArcLock.y + LOCK_BOUNDS.maxY < -6,
    'fat sampled arc uses the nearest centreline segment when painted widths overlap');

globalThis.window = { addEventListener() {} };
const domElement = () => ({
    style: {}, children: [], attributes: new Map(), classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    insertBefore(child) { return this.appendChild(child); },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(el => el !== this); },
    querySelector: () => null, querySelectorAll: () => [],
});
globalThis.document = {
    createElement: domElement, createElementNS: domElement, body: domElement(),
    documentElement: { getAttribute: () => 'dark' }, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { selectEnclosed } = await import('../src/pcb/modules/box-select.js');
const { getPcbSelectionEntries: selectionEntries } = await import('../src/pcb/modules/selection-registry.js');
const topLayer = layers.PCB_LAYERS.find(layer => layer.id === 'top-copper');
const topPour = layers.PCB_COPPER_FILLS.find(layer => layer.id === 'top-copper');
const points = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }];
const fill = { type: 'fill', id: 'pour', layer: 'top-copper', outline: points, locked: false, visible: true };
const shape = { kind: 'polygon', id: 'shape', layer: 'top-copper', points };
const lockedPlacement = { id: 'locked-component', x: 3, y: 4, locked: true,
    pads: new Map([['1', { x: 1, y: 1 }]]) };
const app = {
    placements: new Map([[lockedPlacement.id, lockedPlacement]]),
    pcbDocument: new PcbDocument(), history: new CommandHistory(),
    get texts() { return getTextPosePreviewTexts(this) || this.pcbDocument.texts; },
    tracks: [], vias: [], boardShapes: [fill, shape], refreshText() {},
    syncClipboardButtons() {}, getLayerGroup() { return null; }, _shapeElements: new Map(),
    get selected() { return selectionEntries(this); },
};
for (const select of [() => PCBApp.prototype.selectAll.call(app),
    () => selectEnclosed(app, { minX: 0, minY: 0, maxX: 10, maxY: 10 })]) {
    select();
    assert.ok(!app.selected.some(entry => entry.object === lockedPlacement.id),
        'Locked component is excluded from bulk selection');
    assert.ok(app.selected.some(entry => entry.object === fill), 'Unlocked pour is selectable');
    for (const [target, property, blocked] of [
        [topPour, 'locked', true], [topPour, 'visible', false],
        [topLayer, 'locked', true],
        [fill, 'locked', true], [fill, 'visible', false],
    ]) {
        const previous = target[property];
        try {
            target[property] = blocked;
            select();
            assert.ok(!app.selected.some(entry => entry.object === fill), `Excluded pour: ${property}=${blocked}`);
            if (target === topPour) assert.ok(app.selected.some(entry => entry.object === shape),
                'Pour-specific restrictions must not block ordinary copper shapes');
        } finally {
            target[property] = previous;
        }
        select();
        assert.ok(app.selected.some(entry => entry.object === fill), 'Restored pour is selectable again');
    }
    const previousVisibility = topLayer.visible;
    try {
        topLayer.visible = false;
        select();
        assert.ok(app.selected.some(entry => entry.object === fill),
            'Visible pours remain selectable when ordinary copper is hidden');
    } finally {
        topLayer.visible = previousVisibility;
    }
}
console.log('PASS Select All and marquee respect pour, copper-layer, and object locks and visibility');

const { setPcbSelection, getPcbSelectionEntries, getPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { beginGroupDrag, updateGroupDrag, endGroupDrag } = await import('../src/pcb/modules/box-select.js');
let pourMoves = 0;
let snapshots = 0;
fill.captureState = () => { snapshots++; return {}; };
fill.applyState = () => {};
fill.move = () => { pourMoves++; };
const movingText = { id: 'moving-text', x: 0, y: 0 };
app.texts.set(movingText.id, movingText);
app.viewport = { scale: 1 };
for (const [target, property, blocked] of [
    [topPour, 'locked', true], [topPour, 'visible', false],
    [topLayer, 'locked', true],
    [fill, 'locked', true], [fill, 'visible', false],
]) {
    setPcbSelection(app, [{ kind: 'fill', object: fill }, { kind: 'text', object: movingText }]);
    const previous = target[property];
    const textStart = movingText.x;
    try {
        target[property] = blocked;
        beginGroupDrag(app, { x: 0, y: 0 });
        assert.equal(app._groupDrag.fills.length, 0, 'Stale selected locked/hidden pour must not enter a group drag');
        updateGroupDrag(app, { x: 5, y: 5 });
        endGroupDrag(app);
        assert.equal(movingText.x, textStart + 5, 'Other selected objects still move');
        assert.equal(pourMoves, 0, 'Protected pour must not move');
        assert.equal(snapshots, 0, 'Protected pour must not be snapshotted for movement');
    } finally {
        target[property] = previous;
    }
}
console.log('PASS group drag excludes stale selected locked/hidden pours while other objects move');

setPcbSelection(app, [
    { kind: 'component', object: lockedPlacement.id },
    { kind: 'text', object: movingText },
]);
const lockedStart = { x: lockedPlacement.x, y: lockedPlacement.y };
const textStart = movingText.x;
beginGroupDrag(app, { x: 0, y: 0 });
assert.equal(app._groupDrag.comps.length, 0, 'Locked component must not enter a group drag');
updateGroupDrag(app, { x: 5, y: 5 });
endGroupDrag(app);
assert.deepEqual({ x: lockedPlacement.x, y: lockedPlacement.y }, lockedStart);
assert.equal(movingText.x, textStart + 5, 'Unlocked selection members still move');
cancelPictureCopperRefresh(app);

const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { createCopperFillSelectionAdapter } = await import('../src/pcb/modules/copper-fill-selection.js');
const { hitTestPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const hitFill = PCBApp.prototype._hitTestFill;
const visibleFill = new CopperFill({ outline: points, layer: 'top-copper' });
const fillApp = {
    boardShapes: [visibleFill], copperFills: [visibleFill], viewport: { scale: 10 },
    getLayerGroup() { return null; },
};
const previousVisibility = topLayer.visible;
try {
    topLayer.visible = false;
    assert.equal(createCopperFillSelectionAdapter(fillApp, visibleFill, visibleFill.id).visible, true);
    assert.equal(hitFill.call(fillApp, points[0]), visibleFill, 'Legacy click hits the visible fill');
    assert.equal(hitTestPcbSelection(fillApp, points[0], 'fill'), visibleFill,
        'Shared selection hits the visible fill with copper hidden');
    setPcbSelection(fillApp, [{ kind: 'fill', object: visibleFill }]);
    beginGroupDrag(fillApp, points[0]);
    assert.equal(fillApp._groupDrag.fills[0]?.fill, visibleFill,
        'The selected visible fill can enter group dragging with copper hidden');
    for (const [target, property, blocked] of [
        [topPour, 'visible', false], [topPour, 'locked', true],
        [topLayer, 'locked', true], [visibleFill, 'locked', true], [visibleFill, 'visible', false],
    ]) {
        const previous = target[property];
        try {
            target[property] = blocked;
            assert.equal(hitFill.call(fillApp, points[0]), null);
            const locked = property === 'locked';
            assert.equal(hitTestPcbSelection(fillApp, points[0], 'fill'), locked ? visibleFill : null,
                locked ? 'Shared selection can select a locked fill for its unlock affordance'
                    : 'Hidden fills remain unselectable');
        } finally {
            target[property] = previous;
        }
    }
} finally {
    topLayer.visible = previousVisibility;
}
console.log('PASS visible fill selection and dragging are independent of copper visibility');

const onVisibility = PCBApp.prototype._onLayerVisibilityChanged;
fillApp._layerGroups = new Map();

fillApp.existingLayerGroups = function () { return this._layerGroups; };
let selectionRefreshes = 0;
fillApp._refreshPcbSelectionHighlights = () => { selectionRefreshes++; };
fillApp.selectFill = () => { throw new Error('Copper visibility must not clear a visible fill'); };
fillApp.clearProperties = () => { throw new Error('Visible fill properties must remain available'); };
onVisibility.call(fillApp, 'top-copper', false);
assert.equal(selectionRefreshes, 1, 'Hiding an outline layer removes its selection lock overlay');
assert.deepEqual(getPcbSelection(fillApp, 'fill'), [visibleFill]);
onVisibility.call(fillApp, 'top-copper', true);
onVisibility.call(fillApp, 'bottom-copper', false);
onVisibility.call(fillApp, 'bottom-copper', true);
onVisibility.call(fillApp, 'top-silk', true);
assert.equal(selectionRefreshes, 5, 'Every layer eye change refreshes selection affordances');
{
    const copperShape = { kind: 'polygon', id: 'hidden-copper-shape', layer: 'top-copper', points };
    const silkShape = { kind: 'polygon', id: 'kept-silk-shape', layer: 'top-silk', points };
    const keptVia = { id: 'kept-via', x: 5, y: 5, diameter: 0.6, drill: 0.3 };
    let shownProperties = null;
    const layerApp = {
        placements: new Map(), pcbDocument: new PcbDocument(), tracks: [], vias: [keptVia], pads: [],
        boardShapes: [copperShape, silkShape], _layerGroups: new Map(), existingLayerGroups() { return this._layerGroups; }, _shapeElements: new Map(),
        viewport: { scale: 10 }, getLayerGroup() { return null; }, refreshText() {}, syncClipboardButtons() {},
        clearProperties() {},
        _showPcbMultiSelectionProperties(selected) { shownProperties = new Set(selected.map(entry => entry.object)); },
        get texts() { return this.pcbDocument.texts; },
    };
    setPcbSelection(layerApp, [
        { kind: 'shape', object: copperShape }, { kind: 'shape', object: silkShape }, { kind: 'via', object: keptVia },
    ]);
    const previous = topLayer.visible;
    try {
        topLayer.visible = false;
        onVisibility.call(layerApp, 'top-copper', false);
    } finally {
        topLayer.visible = previous;
    }
    assert.deepEqual(new Set(getPcbSelection(layerApp)), new Set([silkShape, keptVia]),
        'Hiding a layer deselects only its objects; selections on visible layers are kept');
    assert.deepEqual(shownProperties, new Set([silkShape, keptVia]), 'Properties follow the remaining selection');
}
console.log('PASS hiding a layer deselects only the objects it hides');

const onFillVisibility = PCBApp.prototype._onCopperFillVisibilityChanged;
fillApp._cancelPosePreviews = function () { this._groupDrag = null; };
onFillVisibility.call(fillApp, 'top-copper', false);
assert.equal(fillApp._groupDrag, null, 'Hiding a pour discards an active mixed-group preview');
assert.equal(selectionRefreshes, 6, 'Hiding copper-fill outlines removes their selection lock overlay');

const onLock = PCBApp.prototype._onCopperFillLockChanged;
const bottomFill = { ...fill, id: 'bottom-pour', layer: 'bottom-copper' };
const secondTopFill = { ...fill, id: 'second-top-pour' };
app.boardShapes.push(bottomFill, secondTopFill);
app._layerGroups = new Map();

app.existingLayerGroups = function () { return this._layerGroups; };
setPcbSelection(app, [
    { kind: 'fill', object: bottomFill }, { kind: 'fill', object: fill },
    { kind: 'fill', object: secondTopFill }, { kind: 'text', object: movingText },
]);
onLock.call(app, 'top-copper', true);
assert.deepEqual(getPcbSelection(app, 'fill'), [bottomFill, fill, secondTopFill],
    'Lock preserves selected pours so their unlock affordance remains available');
assert.deepEqual(getPcbSelection(app, 'text'), [movingText], 'Lock preserves unrelated selection');
console.log('PASS pour lock changes preserve selected objects for their unlock affordance');

const { renderCopperFill, setCopperFillClip, removeCopperFillElements } = await import('../src/pcb/modules/copper-fill-render.js');
function svgElement() {
    const attributes = new Map();
    return {
        children: [], parentNode: null,
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        appendChild(child) { child.parentNode = this; this.children.push(child); },
        get firstChild() { return this.children[0] || null; },
        insertBefore(child, reference) {
            child.parentNode = this;
            const index = this.children.indexOf(reference);
            this.children.splice(index < 0 ? this.children.length : index, 0, child);
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        remove() {
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        },
        querySelectorAll(selector) {
            const matches = child => selector.startsWith('.')
                ? child.getAttribute('class') === selector.slice(1)
                : selector === `[data-fill-id="${child.getAttribute('data-fill-id')}"]`;
            return this.children.flatMap(child => [
                ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector),
            ]);
        },
    };
}
const originalCreateElementNS = document.createElementNS;
document.createElementNS = () => svgElement();
try {
    const group = svgElement();
    const getGroup = id => id === 'top-fill' ? group : null;
    setComputedFill(visibleFill, [{ outer: points, holes: [] }]);
    renderCopperFill(visibleFill, getGroup);
    group.setAttribute('clip-path', 'url(#old-group-clip)');
    setCopperFillClip(group, 'pcb-copper-cut-top');
    const checkClip = expected => {
        assert.equal(group.getAttribute('clip-path'), null, 'The fill layer never clips editing guides');
        assert.equal(group.children.length, 2);
        assert.equal(group.children[0].getAttribute('clip-path'), null);
        assert.equal(group.querySelectorAll('.pcb-fill-copper')[0].getAttribute('clip-path'), expected);
        assert.equal(group.querySelectorAll('.pcb-fill-outline')[0].getAttribute('clip-path'), null,
            'Dashed region boundary stays visible across copper cutouts');
    };
    checkClip('url(#pcb-copper-cut-top)');
    renderCopperFill(visibleFill, getGroup, { selected: true });
    checkClip('url(#pcb-copper-cut-top)');
    setCopperFillClip(group, null);
    checkClip(null);
    renderCopperFill(visibleFill, getGroup);
    checkClip(null);
    const overlappingFill = new CopperFill({ outline: points });
    setComputedFill(overlappingFill, getComputedFill(visibleFill));
    renderCopperFill(overlappingFill, getGroup);
    const copper = group.querySelector('.pcb-fill-copper-layer');
    assert.equal(group.querySelectorAll('.pcb-fill-copper-layer').length, 1);
    assert.equal(group.firstChild, copper, 'Copper stays behind editable boundaries');
    assert.equal(copper.getAttribute('opacity'), '0.45', 'Opacity is applied once to the combined copper');
    assert.equal(copper.children.length, 2);
    for (const path of copper.children) {
        assert.equal(path.getAttribute('fill-opacity'), null, 'Individual fills are opaque within the shared group');
        assert.equal(path.getAttribute('opacity'), null);
    }
    renderCopperFill(overlappingFill, getGroup, { selected: true });
    assert.equal(copper.children.length, 2, 'Re-render replaces only the affected fill');
    setCopperFillClip(group, 'shared-cut');
    for (const path of copper.children) assert.equal(path.getAttribute('clip-path'), 'url(#shared-cut)');
    overlappingFill.visible = false;
    renderCopperFill(overlappingFill, getGroup);
    assert.equal(copper.querySelector(`[data-fill-id="${overlappingFill.id}"]`).getAttribute('display'), 'none');
    assert.equal(copper.querySelector(`[data-fill-id="${visibleFill.id}"]`).getAttribute('display'), null);
    removeCopperFillElements(overlappingFill, getGroup);
    assert.equal(copper.children.length, 1);
    assert.equal(group.querySelectorAll('.pcb-fill-outline').length, 1);
    renderCopperFill(visibleFill, getGroup, { outlineOnly: true });
    assert.equal(copper.children.length, 0, 'Live outline edits remove only the edited copper path');
    assert.equal(group.querySelectorAll('.pcb-fill-outline').length, 1);
} finally {
    if (originalCreateElementNS) document.createElementNS = originalCreateElementNS;
    else delete document.createElementNS;
}
console.log('PASS copper cutouts clip poured paths without clipping the editable fill boundary');