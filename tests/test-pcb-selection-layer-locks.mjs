import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as layers from '../src/pcb/modules/layers.js';

const source = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
const start = source.indexOf('    _selectAllPcb() {');
const end = source.indexOf('\n    /** Enable/disable PCB ribbon', start);
assert.ok(start >= 0 && end > start);
const marqueeSource = readFileSync(new URL('../src/pcb/modules/box-select.js', import.meta.url), 'utf8');
const marqueeStart = marqueeSource.indexOf('function _computeEnclosed(');
const marqueeEnd = marqueeSource.indexOf('\n/* ', marqueeStart);
assert.ok(marqueeStart >= 0 && marqueeEnd > marqueeStart);
const dependencies = {
    ...layers,
    window: {},
    setPcbSelection(app, selected) { app.selected = selected; },
    refreshBoxSelectionHighlights() {}, showPcbSelectionProperties() {},
    shapeOutline(shape) { return shape.points; }, pcbTextBounds() { return {}; },
};
const selectAll = new Function(...Object.keys(dependencies),
    `return ({ ${source.slice(start, end)} })._selectAllPcb;`)(...Object.values(dependencies));
const marquee = new Function(...Object.keys(dependencies),
    `${marqueeSource.slice(marqueeStart, marqueeEnd)}\nreturn _computeEnclosed;`)(...Object.values(dependencies));
const topLayer = layers.PCB_LAYERS.find(layer => layer.id === 'top-copper');
const topPour = layers.PCB_COPPER_FILLS.find(layer => layer.id === 'top-copper');
const points = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }];
const fill = { type: 'fill', id: 'pour', layer: 'top-copper', outline: points, locked: false, visible: true };
const shape = { kind: 'polygon', id: 'shape', layer: 'top-copper', points };
const app = {
    placements: new Map(), tracks: [], vias: [], texts: new Map(), boardShapes: [fill, shape],
    _syncClipboardButtons() {}, selected: [],
};
for (const select of [() => selectAll.call(app), () => marquee(app, { minX: 0, minY: 0, maxX: 10, maxY: 10 })]) {
    select();
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

globalThis.window = { addEventListener() {} };
globalThis.document = {};
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

const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { createCopperFillSelectionAdapter } = await import('../src/pcb/modules/copper-fill-selection.js');
const { hitTestPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const hitStart = source.indexOf('    _hitTestFill(worldPos) {');
const hitEnd = source.indexOf('\n    /** Select (or clear)', hitStart);
assert.ok(hitStart >= 0 && hitEnd > hitStart);
const hitFill = new Function(...Object.keys(layers),
    `return ({ ${source.slice(hitStart, hitEnd)} })._hitTestFill;`)(...Object.values(layers));
const visibleFill = new CopperFill({ outline: points, layer: 'top-copper' });
const fillApp = { boardShapes: [visibleFill], copperFills: [visibleFill], viewport: { scale: 10 } };
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
            assert.equal(hitTestPcbSelection(fillApp, points[0], 'fill'), null);
        } finally {
            target[property] = previous;
        }
    }
} finally {
    topLayer.visible = previousVisibility;
}
console.log('PASS visible fill selection and dragging are independent of copper visibility');

const visibilityStart = source.indexOf('    _onLayerVisibilityChanged(layerId, visible) {');
const visibilityEnd = source.indexOf('\n    /**', visibilityStart);
assert.ok(visibilityStart >= 0 && visibilityEnd > visibilityStart);
const visibilityDependencies = {
    ...layers, getPcbSelection, saveLayerPrefs() {},
    getSelectedTrack() { return null; }, getSelectedVia() { return null; },
    hasBoxSelection() { return false; }, setHoverHighlight() {},
};
const onVisibility = new Function(...Object.keys(visibilityDependencies),
    `return ({ ${source.slice(visibilityStart, visibilityEnd)} })._onLayerVisibilityChanged;`)(...Object.values(visibilityDependencies));
fillApp._layerGroups = new Map();
let hatchRedraws = 0;
fillApp._scheduleRemovalHatchRender = () => { hatchRedraws++; };
fillApp._selectFill = () => { throw new Error('Copper visibility must not clear a visible fill'); };
fillApp._clearProperties = () => { throw new Error('Visible fill properties must remain available'); };
onVisibility.call(fillApp, 'top-copper', false);
assert.equal(hatchRedraws, 1, 'Hiding top copper invalidates the separate hatch canvas');
assert.deepEqual(getPcbSelection(fillApp, 'fill'), [visibleFill]);
onVisibility.call(fillApp, 'top-copper', true);
onVisibility.call(fillApp, 'bottom-copper', false);
onVisibility.call(fillApp, 'bottom-copper', true);
assert.equal(hatchRedraws, 4, 'Showing and hiding either copper side refreshes hatching');
onVisibility.call(fillApp, 'top-silk', true);
assert.equal(hatchRedraws, 4, 'Unrelated layer visibility does not redraw copper hatching');

const lockStart = source.indexOf('    _onCopperFillLockChanged(copperLayerId, locked) {');
const lockEnd = source.indexOf('\n    /** Hit-test a world point', lockStart);
assert.ok(lockStart >= 0 && lockEnd > lockStart);
const lockDependencies = {
    setPcbSelection, getPcbSelectionEntries,
    fillGroupId: layer => layer, saveLayerPrefs() {},
    refreshBoxSelectionHighlights() {}, showPcbSelectionProperties() {},
};
const onLock = new Function(...Object.keys(lockDependencies),
    `return ({ ${source.slice(lockStart, lockEnd)} })._onCopperFillLockChanged;`)(...Object.values(lockDependencies));
const bottomFill = { ...fill, id: 'bottom-pour', layer: 'bottom-copper' };
const secondTopFill = { ...fill, id: 'second-top-pour' };
app.boardShapes.push(bottomFill, secondTopFill);
app._layerGroups = new Map();
setPcbSelection(app, [
    { kind: 'fill', object: bottomFill }, { kind: 'fill', object: fill },
    { kind: 'fill', object: secondTopFill }, { kind: 'text', object: movingText },
]);
onLock.call(app, 'top-copper', true);
assert.deepEqual(getPcbSelection(app, 'fill'), [bottomFill], 'Lock removes all pours on that side, even when the first selected pour is on the other side');
assert.deepEqual(getPcbSelection(app, 'text'), [movingText], 'Lock preserves unrelated selection');
console.log('PASS pour lock changes remove all matching selected pours without clearing other objects');

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
    visibleFill._computed = [{ outer: points, holes: [] }];
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
    overlappingFill._computed = visibleFill._computed;
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