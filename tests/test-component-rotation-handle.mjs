import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import { updatePlacementPadPositions } from '../src/core/pcb-placement-geometry.js';
import { createComponentSelectionAdapter } from '../src/pcb/modules/component-selection.js';
import { getPcbSelectionEntries, setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { renderPcbSelectionAnchors, hitTestPcbSelectionAnchor } from '../src/pcb/modules/selection-anchors.js';
import { beginSelectionInteraction, updateSelectionInteraction, finishSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { ROTATION_CURSOR } from '../src/pcb/modules/rotation-handle.js';
import { attachPropertyPanelHarness } from './helpers/property-panel-controls.mjs';
import { getSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { isRotationHandleDragActive } from '../src/pcb/modules/rotation-handle.js';

const ids = new Map(), frames = new Map();
let frameId = 0;
function element(tag = 'g') {
    return {
        tag, children: [], attributes: new Map(), style: {}, dataset: {}, listeners: new Map(),
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name); },
        hasAttribute(name) { return this.attributes.has(name); },
        removeAttribute(name) { this.attributes.delete(name); },
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
        remove() { this.parentNode?.removeChild(this); },
        querySelectorAll(selector) {
            return this.children.filter(child => selector.startsWith('.')
                ? (child.getAttribute('class') || '').split(' ').includes(selector.slice(1)) : child.tag === selector);
        },
        querySelector(selector) { return selector.startsWith('#') ? ids.get(selector.slice(1)) : this.querySelectorAll(selector)[0]; },
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        },
        fire(type) { for (const listener of this.listeners.get(type) || []) listener({ type }); },
        set innerHTML(html) {
            this.html = html;
            this.children = [];
            for (const match of html.matchAll(/<(input|button|select)[^>]*id="([^"]+)"([^>]*)>/g)) {
                const child = element(match[1]);
                child.value = match[3].match(/value="([^"]*)"/)?.[1] || '';
                child.disabled = match[3].includes('disabled');
                child.checked = match[3].includes('checked');
                ids.set(match[2], child);
                this.appendChild(child);
            }
        },
        get innerHTML() { return this.html || ''; },
    };
}
globalThis.document = { createElement: element, createElementNS: (ns, tag) => element(tag),
    getElementById: id => ids.get(id) || null, querySelector: () => null };
globalThis.window = { addEventListener() {} };
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function assertPose(actual, expected) {
    assert.ok(Math.abs(actual.rotation - expected.rotation) < 1e-12, 'History preserves fractional angles through normalization');
    assert.deepEqual({ ...actual, rotation: expected.rotation }, expected);
}

function fixture(saved = true, side = 'top', mirror = false) {
    ids.clear();
    frames.clear();
    const project = new ProjectDocument();
    project.schematicDocument.components.push(new Component({
        name: 'RotationFixture', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
        footprintShapes: ['PAD~RECT~-2~1~1~1~1~both~1~0~0.5', 'PAD~RECT~2~-1~1~1~1~both~1~0~0.5'],
    }, { id: 'part' }));
    const footprint = project.getPcbFootprint('part');
    const placement = { x: Math.PI, y: -Math.E, rotation: 37.123456, side, mirror, reference: 'R1',
        refDx: 1.23456789, refRot: 23.456789, bounds: { x: -3, y: -2, width: 6, height: 4 },
        padOffsets: footprint.padOffsets, pasteOffsets: footprint.pasteOffsets, pads: new Map() };
    Object.assign(placement, capturePlacementOverride(placement));
    updatePlacementPadPositions(placement);
    const [first, last] = placement.pads.values();
    const track = new Track({ points: [{ x: first.x, y: first.y }, { x: 40, y: 50 }, { x: last.x, y: last.y }],
        padConnections: { n0: { componentId: 'part', pinNumber: '1' }, n2: { componentId: 'part', pinNumber: '1#2' } } });
    const unrelated = new Track({ points: [{ x: 90, y: 90 }, { x: 100, y: 100 }] });
    project.pcbDocument.tracks.push(track, unrelated);
    if (saved) project.pcbDocument.placementState.record('part', placement);
    const copper = element(), overlay = element(), panel = element(), items = element();
    ids.set('pcbPropertiesPanel', panel);
    let renders = 0, dirty = 0, fills = 0, views3d = 0;
    const footprintElement = element();
    footprintElement.setAttribute = (name, value) => {
        footprintElement.attributes.set(name, String(value));
        if (name === 'transform') renders++;
    };
    placement.elements = [footprintElement];
    const app = {
        project, pcbDocument: project.pcbDocument, placementState: project.pcbDocument.placementState,
        get tracks() { return Object.getOwnPropertyDescriptor(PCBApp.prototype, 'tracks').get.call(this); },
        vias: [], texts: new Map(), boardShapes: [],
        placements: new Map([['part', placement]]), history: new CommandHistory(),
        viewport: { scale: 10, svg: element('svg'), hideCrosshair() {} }, _active: true, currentTool: 'select',
        getLayerGroup: id => id === 'selection-overlay' ? overlay : id === 'top-copper' ? copper : null,
        propertiesItems: () => items, setPropertiesTitle() {}, _hoverComponent() {}, _hideNetTooltip() {},
        _netsForComponent: () => new Set(['N1']), updateRatsnest: PCBApp.prototype.updateRatsnest, refreshClearanceHalos() {},
        _markDirty: () => dirty++, refreshFills: () => fills++, _board3d: { refresh: () => views3d++ },
    };
    attachPropertyPanelHarness(app, { controls: ids });
    for (const method of ['showComponentProperties', '_syncComponentRotationInput', 'handleKeyDown', '_clearCursorCrosshair']) {
        app[method] = PCBApp.prototype[method];
    }
    setPcbSelection(app, [{ kind: 'component', object: 'part' }]);
    app.showComponentProperties('part');
    const adapter = getPcbSelectionEntries(app)[0];
    const original = capturePlacementOverride(placement);
    const center = { x: placement.x, y: placement.y };
    const anchor = () => adapter.getAnchors()[0];
    const pointFor = (angle, start = anchor(), initial = original.rotation) => {
        const radians = Math.atan2(start.y - center.y, start.x - center.x) + (angle - initial) * Math.PI / 180;
        return { x: center.x + 10 * Math.cos(radians), y: center.y + 10 * Math.sin(radians) };
    };
    const verifyBonds = () => {
        const displayedTrack = app.tracks.find(item => item.id === track.id);
        for (const [nodeId, pin] of [['n0', '1'], ['n2', '1#2']]) {
            const node = displayedTrack.nodes.get(nodeId), pad = placement.pads.get(pin);
            assert.equal(node.x, pad.x);
            assert.equal(node.y, pad.y);
        }
        assert.equal(track.nodes.get('n1').x, 40);
        assert.equal(track.nodes.get('n1').y, 50);
        const line = copper.children.find(child => child.tag === 'polyline');
        if (line) {
            const points = line.getAttribute('points').split(' ');
            for (const id of ['n0', 'n2']) {
                const node = displayedTrack.nodes.get(id);
                assert.ok(points.includes(`${node.x},${node.y}`), 'Rendered wire ends follow the component pads');
            }
        }
    };
    const visibleHandles = () => overlay.children.flatMap(group => group.children)
        .filter(child => child.getAttribute('data-anchor-id') === 'rotate');
    return { app, placement, adapter, track, unrelated, original, center, anchor, pointFor, verifyBonds,
        overlay, items, visibleHandles, renders: () => renders, dirty: () => dirty, fills: () => fills, views3d: () => views3d };
}

for (const saved of [false, true]) for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
    const f = fixture(saved, side, mirror);
    const { app, placement, original, adapter } = f;
    const savedBefore = structuredClone(app.placementState.overrides), bonds = structuredClone(f.track.padConnections);
    const unrelated = f.unrelated.captureState();
    renderPcbSelectionAnchors(app);
    assert.equal(f.visibleHandles().length, 1, 'One component exposes one rotation handle');
    assert.equal(ids.get('pcbPropCompRot').field.step, 1);
    const start = f.anchor();
    assert.equal(hitTestPcbSelectionAnchor(app, start)?.anchorId, 'rotate');
    assert.equal(beginSelectionInteraction(app, start, false), true);
    assert.equal(getSelectionInteraction(app).mode, 'anchor');
    assert.equal(f.visibleHandles().length, 0, 'The rotation icon is hidden during a gesture');
    assert.equal(app.viewport.svg.style.cursor, ROTATION_CURSOR);
    updateSelectionInteraction(app, f.pointFor(90, start));
    for (let index = 1; index < 100; index++) adapter.updateAnchorDrag(f.pointFor(90 + index / 1000, start));
    assert.equal(placement.rotation, 90);
    assert.equal(ids.get('pcbPropCompRot').value, '90');
    assert.equal(f.renders(), 1, '100 pointer events at one angle render once');
    for (let angle = 91; angle <= 190; angle++) {
        adapter.updateAnchorDrag(f.pointFor(angle, start));
        assert.equal(placement.rotation, angle);
        assert.equal(ids.get('pcbPropCompRot').value, String(angle));
        f.verifyBonds();
    }
    assert.equal(f.renders(), 101, 'Every distinct one-degree rotation renders immediately');
    assert.deepEqual(app.placementState.overrides, savedBefore, 'Previews do not save an automatic or authored pose');
    assert.equal(f.dirty(), 0);
    assert.equal(f.fills(), 0);
    assert.equal(f.views3d(), 0);
    assert.equal(app.history.canUndo(), false);
    finishSelectionInteraction(app, true, f.pointFor(191, start));
    assert.equal(placement.rotation, 191, 'Mouse-up applies the final angle without requiring another move');
    assert.equal(ids.get('pcbPropCompRot').value, '191');
    assert.equal(f.visibleHandles().length, 1);
    assert.equal(isRotationHandleDragActive(app), false);
    assert.equal(getSelectionInteraction(app), null);
    assert.equal(app.history.undoStack.length, 1);
    assert.equal(f.dirty(), 1);
    assert.ok(f.fills() > 0, 'Commit requests derived pour updates through the existing command adapter');
    assert.equal(f.views3d(), 1);
    f.verifyBonds();
    const committed = capturePlacementOverride(placement);
    app.history.undo();
    assertPose(capturePlacementOverride(placement), original);
    assertPose(app.placementState.overrides.get('part'), original);
    assert.equal(ids.get('pcbPropCompRot').value, '37');
    f.verifyBonds();
    app.history.redo();
    assert.deepEqual(capturePlacementOverride(placement), committed);
    assert.equal(ids.get('pcbPropCompRot').value, '191');
    f.verifyBonds();
    assert.deepEqual(f.track.padConnections, bonds);
    assert.deepEqual(f.unrelated.captureState(), unrelated);
}

for (const saved of [false, true]) {
    const f = fixture(saved);
    const { app, placement } = f;
    const beforeGraph = f.track.captureState(), savedBefore = structuredClone(app.placementState.overrides);
    let prior = 0;
    app.history.execute({ execute() { prior = 1; }, undo() { prior = 0; } });
    app.history.undo();
    const start = f.anchor();
    beginSelectionInteraction(app, start, false);
    updateSelectionInteraction(app, f.pointFor(359.6, start));
    assert.equal(placement.rotation, 0, 'Component rotation wraps in whole degrees');
    assert.equal(app.handleKeyDown({ key: 'Escape' }), true);
    assert.deepEqual(capturePlacementOverride(placement), f.original);
    assert.deepEqual(f.track.captureState(), beforeGraph, 'Escape restores the bonded track graph exactly');
    assert.deepEqual(app.placementState.overrides, savedBefore);
    assert.equal(ids.get('pcbPropCompRot').value, '37');
    assert.equal(app.history.undoStack.length, 0);
    assert.equal(app.history.canRedo(), true);
    assert.equal(prior, 0);
    beginSelectionInteraction(app, f.anchor(), false);
    updateSelectionInteraction(app, f.pointFor(90));
    updateSelectionInteraction(app, f.center);
    assert.equal(placement.rotation, f.original.rotation, 'Centre fallback preserves the fractional starting angle');
    finishSelectionInteraction(app, true);
    assert.equal(app.history.undoStack.length, 0);
    assert.equal(app.history.canRedo(), true);
    assert.deepEqual(app.placementState.overrides, savedBefore);
}

{
    const f = fixture();
    const { app, placement } = f;
    app.placements.set('other', { ...placement, x: 30 });
    for (const selected of [
        [{ kind: 'component', object: 'part' }, { kind: 'component', object: 'other' }],
        [{ kind: 'component', object: 'part' }, { kind: 'track', object: f.track }],
    ]) {
        setPcbSelection(app, selected);
        renderPcbSelectionAnchors(app);
        assert.equal(f.visibleHandles().length, 0, 'Mixed and component-only multi-selections hide rotation');
        assert.equal(hitTestPcbSelectionAnchor(app, f.anchor(), ['component']), null);
    }
    setPcbSelection(app, [{ kind: 'component', object: 'part' }]);
    placement.locked = true;
    app.showComponentProperties('part');
    assert.equal(ids.get('pcbPropCompRot').disabled, true);
    assert.equal(f.adapter.beginAnchorDrag('rotate', f.anchor()), false);
    placement.locked = false;
    beginSelectionInteraction(app, f.anchor(), false);
    updateSelectionInteraction(app, f.pointFor(90));
    placement.locked = true;
    finishSelectionInteraction(app, true);
    assert.equal(placement.rotation, f.original.rotation, 'A protected drop rolls back the preview');
    f.verifyBonds();
    assert.equal(app.history.canUndo(), false);
    assert.equal(createComponentSelectionAdapter(app, 'missing', 'component:missing').beginAnchorDrag('rotate', f.center), false);
}

{
    const f = fixture();
    const { app, placement } = f;
    const input = ids.get('pcbPropCompRot');
    input.value = '-15';
    input.fire('change');
    assert.equal(ids.get('pcbPropCompRot'), input, 'Spinner edits keep the input mounted for successive steps');
    assert.equal(placement.rotation, 345, 'Typed angles normalize on commit');
    assert.equal(ids.get('pcbPropCompRot').value, '345');
    f.verifyBonds();
    app.history.undo();
    assertPose(capturePlacementOverride(placement), f.original);
    assert.equal(ids.get('pcbPropCompRot').value, '37');
    app.history.redo();
    const next = ids.get('pcbPropCompRot');
    next.value = '346';
    next.fire('change');
    assert.equal(placement.rotation, 346, 'Spinner supports one-degree changes');
    f.verifyBonds();
}

{
    const f = fixture(false);
    const { app, placement } = f;
    let prior = 0;
    app.history.execute({ execute() { prior = 1; }, undo() { prior = 0; } });
    beginSelectionInteraction(app, f.anchor(), false);
    updateSelectionInteraction(app, f.pointFor(90));
    app.handleKeyDown({ key: 'z', ctrlKey: true });
    assert.deepEqual(capturePlacementOverride(placement), f.original, 'Undo first cancels a live component rotation');
    assert.equal(prior, 0);
    assert.equal(isRotationHandleDragActive(app), false);
    assert.equal(getSelectionInteraction(app), null);
    f.verifyBonds();
    beginSelectionInteraction(app, f.anchor(), false);
    updateSelectionInteraction(app, f.pointFor(90));
    const locked = ids.get('pcbPropCompLocked');
    locked.checked = true;
    locked.fire('change');
    assert.equal(placement.rotation, f.original.rotation, 'Locking from the properties panel cancels rotation first');
    assert.equal(placement.locked, true);
    assert.equal(app.placementState.overrides.get('part').rotation, f.original.rotation,
        'Locking must not save the automatic placement at its preview angle');
    assert.equal(getSelectionInteraction(app), null);
    assert.equal(ids.get('pcbPropCompRot').disabled, true);
    app.history.undo();
    assert.equal(placement.locked, false);
    assert.equal(ids.get('pcbPropCompRot').disabled, false);
    f.verifyBonds();
}

{
    const f = fixture(false);
    delete f.placement.rotation;
    f.adapter.beginAnchorDrag('rotate', f.anchor());
    f.adapter.updateAnchorDrag(f.center);
    f.adapter.endAnchorDrag(true);
    assert.equal(f.app.history.canUndo(), false, 'An implicit zero angle needs no no-op command');
    assert.equal(f.app.placementState.overrides.size, 0);
}
{
    const f = fixture();
    const original = f.track.captureState();
    f.app._cancelPosePreviews = PCBApp.prototype._cancelPosePreviews;
    f.app._cancelDrawingMode = () => false;
    beginSelectionInteraction(f.app, f.anchor(), false);
    updateSelectionInteraction(f.app, f.pointFor(90));
    assert.deepEqual(f.track.captureState(), original, 'Rotation never edits authored copper');
    PCBApp.prototype.deactivate.call(f.app);
    assertPose(capturePlacementOverride(f.placement), f.original);
    assert.equal(f.app.tracks, f.app.pcbDocument.tracks);
    assert.equal(isRotationHandleDragActive(f.app), false);
    assert.equal(f.app.history.canUndo(), false);
}
console.log('PASS singleton component rotation, live one-degree spinner, bonded tracks, mirrored sides, history and cancellation');
