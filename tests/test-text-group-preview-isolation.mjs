import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPcbText } from '../src/core/pcb-text.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import { setPcbSelection, getPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { beginGroupDrag, updateGroupDrag, scheduleGroupDrag } from '../src/pcb/modules/box-select.js';
import { finishSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { getPlacementPreviewTracks } from '../src/pcb/modules/track-commands.js';
import { getTextPosePreviewTexts, previewTextPoses } from '../src/pcb/modules/text-commands.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { areDragOverlaysDeferred, setDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';
import { getSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { getGroupDrag } from '../src/pcb/modules/box-select.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

class Element {
    constructor() { this.attributes = new Map(); this.children = []; this.dataset = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    appendChild(child) { child.parentNode?.removeChild(child); this.children.push(child); child.parentNode = this; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
}
const frames = new Map();
let nextFrame = 0;
globalThis.window = { addEventListener() {},
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); } };
globalThis.document = { createElementNS: () => new Element(), getElementById: () => null,
    documentElement: new Element() };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(mixed) {
    const project = new ProjectDocument();
    project.schematicDocument.components.push(new Component({
        name: 'Group', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
        footprintShapes: ['PAD~RECT~2~1~1~1~1~both~1~0~0.5'],
    }, { id: 'part' }));
    project.pcbDocument.placementState.record('part', { x: Math.PI, y: -Math.E, rotation: 37.123456789 });
    const placements = project.resolvePcbLayout().placements;
    const pad = placements.get('part').pads.get('1');
    const track = new Track({ points: [{ x: pad.x, y: pad.y }, { x: 30, y: 40 }],
        padConnections: { n0: { componentId: 'part', pinNumber: '1' } } });
    project.pcbDocument.tracks.push(track);
    const texts = ['top-silk', 'bottom-copper', 'bottom-document'].map((layer, index) =>
        createPcbText({ id: `text${index}`, content: `Group ${index}`, layer, border: true,
            x: 10 * index + Math.PI, y: 3 * index - Math.E, rotation: 37.123456789,
            size: 1.23456789, strokeWidth: 0.123456789 }));
    for (const text of texts) project.pcbDocument.texts.set(text.id, text);
    const groups = new Map(['top-silk', 'bottom-copper', 'bottom-document', 'top-copper'].map(id => [id, new Element()]));
    let renders = 0;
    const app = {
        project, pcbDocument: project.pcbDocument, placementState: project.pcbDocument.placementState,
        placements, history: new CommandHistory(), vias: [], pads: [], boardShapes: [],
        viewport: { svg: { style: {} }, scale: 10, snapToGrid: true, gridVisible: true, gridSize: 1 },
        _textElements: new Map(), _shapeElements: new Map(),
        getLayerGroup: id => groups.get(id) || null,
        _refreshBoardShapeClearance() {}, _ensureViewport() {}, markSectionClean() {}, _cancelDrawingMode() {},
        _cancelPosePreviews: PCBApp.prototype._cancelPosePreviews,
        refreshText: PCBApp.prototype.refreshText, _removeTextElement: PCBApp.prototype._removeTextElement,
        _renderText(text) { renders++; PCBApp.prototype._renderText.call(this, text); },
    };
    for (const key of ['texts', 'tracks']) Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    setPcbSelection(app, [...texts.slice(0, 2).map(object => ({ kind: 'text', object })),
        ...(mixed ? [{ kind: 'component', object: 'part' }] : [])]);
    for (const text of texts) app._renderText(text);
    renders = 0;
    return { app, track, texts, groups, renders: () => renders };
}

for (const mixed of [false, true]) for (const deferred of [false, true]) {
    for (const finish of ['commit', 'cancel', 'no-op', 'deactivate', 'load', 'missing-text', ...(mixed ? ['missing-part'] : [])]) {
        const f = fixture(mixed), { app, texts, track, groups } = f;
        const before = texts.map(text => ({ ...text }));
        const pose = capturePlacementOverride(app.placements.get('part'));
        const graph = track.captureState(), bounds = track.getBounds();
        let geometry = app.pcbDocument.captureGeometry(), serialized = app.pcbDocument.serialize();
        const otherSvg = app._textElements.get(texts[2].id);
        const redo = { execute() {}, undo() {} };
        app.history.execute(redo);
        app.history.undo();
        setDragOverlaysDeferred(app, deferred);
        beginGroupDrag(app, { x: 0, y: 0 });
        setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'move' });
        assert.equal(getGroupDrag(app).posePreview, true);
        try {
            updateGroupDrag(app, { x: 0.1, y: -0.1 });
            assert.equal(getTextPosePreviewTexts(app), undefined, 'Starting grid magnet does not allocate copies');
            for (let index = 0; index < 100; index++) scheduleGroupDrag(app, { x: 3 + index / 1000, y: -4 });
            assert.equal(frames.size, 1, 'Group pointer events coalesce into one frame');
            const [id, callback] = frames.entries().next().value;
            frames.delete(id);
            callback();
            assert.equal(f.renders(), 2, 'Each changed selected text renders only once per frame');
            const projectedMap = app.texts, projectedTexts = [...app.texts.values()];
            assert.notEqual(projectedMap, app.pcbDocument.texts);
            assert.notEqual(projectedTexts[0], texts[0]);
            assert.notEqual(projectedTexts[1], texts[1]);
            assert.equal(projectedTexts[2], texts[2]);
            assert.equal(app.tracks[0] === track, !mixed);
            assert.throws(() => previewTextPoses(app, new Map([[texts[0].id, { x: 1 }]])),
                /Finish the current text preview/, 'A different participant set cannot replace the group projection');
            for (let index = 0; index < 100; index++) {
                updateGroupDrag(app, { x: 4 + index / 1000, y: 6 - index / 1000 }, { snap: false });
                assert.equal(app.texts, projectedMap);
                assert.deepEqual(getPcbSelection(app, 'text'), projectedTexts.slice(0, 2));
                assert.equal(app.texts.get(texts[0].id), projectedTexts[0]);
                assert.equal(app.texts.get(texts[1].id), projectedTexts[1]);
            }
            assert.equal(f.renders(), 202, 'Distinct positions render each selected text once, without highlight duplication');
            assert.deepEqual(texts, before);
            assert.deepEqual(app.pcbDocument.captureGeometry(), geometry);
            assert.deepEqual(app.pcbDocument.serialize(), serialized);
            assert.deepEqual(track.captureState(), graph);
            assert.equal(track._bounds, bounds);
            assert.equal(app._textElements.get(texts[2].id), otherSvg);
            for (const text of texts) assert.equal(groups.get(text.layer).children.length, 1);
            if (finish === 'commit') {
                app.viewport.snapToGrid = false;
                scheduleGroupDrag(app, { x: 7.123456789, y: -8.123456789 });
                finishSelectionInteraction(app, true);
                assert.equal(app.history.undoStack.length, 1);
                const committed = texts.map(text => ({ ...text }));
                for (let index = 0; index < 2; index++) {
                    assert.equal(texts[index].x, before[index].x + 7.123456789);
                    assert.equal(texts[index].y, before[index].y - 8.123456789);
                }
                assert.equal(app.placements.get('part').x, pose.x + (mixed ? 7.123456789 : 0));
                for (let cycle = 0; cycle < 2; cycle++) {
                    app.history.undo();
                    assert.deepEqual(texts, before);
                    assert.deepEqual(track.captureState(), graph);
                    assert.deepEqual(capturePlacementOverride(app.placements.get('part')), pose);
                    app.history.redo();
                    assert.deepEqual(texts, committed);
                }
            } else if (finish === 'load') {
                app._active = false;
                loadPcb(app, null);
                assert.equal(app.pcbDocument.texts.size, 0);
                assert.equal(app._textElements.size, 0);
                assert.equal(app.placements.size, 0);
            } else {
                if (finish === 'missing-text' || finish === 'missing-part') {
                    if (finish === 'missing-text') app.pcbDocument.texts.delete(texts[1].id);
                    else app.project.schematicDocument.components.length = 0;
                    geometry = app.pcbDocument.captureGeometry();
                    serialized = app.pcbDocument.serialize();
                    assert.throws(() => finishSelectionInteraction(app, true),
                        finish === 'missing-text' ? /PCB text is no longer available: text1/ : /PCB footprint is no longer available: part/);
                } else if (finish === 'deactivate') PCBApp.prototype.deactivate.call(app);
                else {
                    if (finish === 'no-op') updateGroupDrag(app, { x: 0.1, y: 0.1 });
                    else scheduleGroupDrag(app, { x: 50, y: 50 });
                    finishSelectionInteraction(app, finish === 'no-op');
                }
                assert.deepEqual(texts, before, 'Cancellation/failure never writes back into any authored text');
                assert.deepEqual(app.pcbDocument.captureGeometry(), geometry);
                assert.deepEqual(app.pcbDocument.serialize(), serialized);
                assert.deepEqual(capturePlacementOverride(app.placements.get('part')), pose);
                assert.equal(app.history.canUndo(), false);
                assert.equal(app.history.redoStack[0], redo);
                if (finish === 'missing-text') assert.equal(app._textElements.has(texts[1].id), false);
            }
            assert.equal(getTextPosePreviewTexts(app), undefined);
            assert.equal(getPlacementPreviewTracks(app), undefined);
            assert.equal(app.texts, app.pcbDocument.texts);
            assert.equal(getGroupDrag(app), null);
            assert.equal(getSelectionInteraction(app), null);
            assert.equal(areDragOverlaysDeferred(app), deferred);
            assert.equal(frames.size, 0);
        } finally { cancelPictureCopperRefresh(app); }
    }
}
{
    const { app, texts } = fixture(false);
    const before = app.pcbDocument.serialize();
    assert.throws(() => previewTextPoses(app, new Map([
        [texts[0].id, { x: 50 }], ['missing', { x: 60 }],
    ])), /PCB text is no longer available: missing/);
    assert.equal(getTextPosePreviewTexts(app), undefined, 'Failed initialization does not publish a partial projection');
    assert.equal(app.texts, app.pcbDocument.texts);
    assert.deepEqual(app.pcbDocument.serialize(), before);
}
console.log('PASS text-only and component/text group isolation, coalescing, one-render updates, history, preflight and lifecycle cleanup');
