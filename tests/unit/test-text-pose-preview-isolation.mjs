import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { createPcbText, TEXT_LAYERS } from '../../src/core/pcb-text.js';
import { pcbTextBounds } from '../../src/pcb/modules/pcb-text.js';
import { createPcbTextSelectionAdapter } from '../../src/pcb/modules/pcb-text-selection.js';
import { getTextPosePreviewTexts, previewTextPose } from '../../src/pcb/modules/text-commands.js';
import { setPcbSelection, getPcbSelection } from '../../src/pcb/modules/selection-registry.js';
import { finishSelectionInteraction } from '../../src/pcb/modules/selection-interaction.js';
import { cancelPictureCopperRefresh } from '../../src/pcb/modules/picture-refresh.js';
import { loadPcb } from '../../src/pcb/modules/project-state.js';
import { getSelectionInteraction } from '../../src/pcb/modules/selection-interaction.js';
import { getTextDrag } from '../../src/pcb/modules/pcb-text-selection.js';
import { isRotationHandleDragActive } from '../../src/pcb/modules/rotation-handle.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import { getTextElement, renderText } from '../../src/pcb/modules/pcb-text-render.js';
import { isEditorActive, setEditorActive } from '../../src/pcb/modules/pcb-editor-api.js';

class Element {
    constructor() { this.attributes = new Map(); this.children = []; this.dataset = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    appendChild(child) { this.children.push(child); child.parentNode = this; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    querySelectorAll(selector) {
        const matches = child => selector.startsWith('.')
            && (child.getAttribute?.('class') || '').split(' ').includes(selector.slice(1));
        return this.children.flatMap(child => [
            ...(matches(child) ? [child] : []),
            ...(child.querySelectorAll?.(selector) || []),
        ]);
    }
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => new Element(), getElementById: () => null,
    documentElement: new Element() };
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

function fixture(layer) {
    const pcbDocument = new PcbDocument();
    const text = createPcbText({ id: 'text', content: 'Preview', x: Math.PI, y: -Math.E,
        rotation: 37.123456789, layer, border: true, size: 1.23456789, strokeWidth: 0.123456789 });
    const unrelated = createPcbText({ id: 'other', x: 100, y: 100, layer });
    pcbDocument.texts.set(text.id, text);
    pcbDocument.texts.set(unrelated.id, unrelated);
    const group = new Element();
    let changes = 0;
    const app = {
        pcbDocument, history: new CommandHistory({ onChanged: () => changes++ }),
        viewport: { svg: { style: {} }, scale: 10, snapToGrid: false, setCrosshair() {}, hideCrosshair() {} },
        placements: new Map(), tracks: [], vias: [], pads: [], boardShapes: [],
        getLayerGroup: id => id === layer ? group : null, _shapeElements: new Map(),
        existingLayerGroups: () => new Map([[layer, group]]),
        _refreshBoardShapeClearance() {}, ensureViewport() {}, markSectionClean() {},
    };
    Object.defineProperty(app, 'texts', Object.getOwnPropertyDescriptor(PCBApp.prototype, 'texts'));
    for (const name of ['snapToGrid', 'refreshText']) app[name] = PCBApp.prototype[name];
    setPcbSelection(app, [{ kind: 'text', object: text }]);
    renderText(app, text);
    renderText(app, unrelated);
    return { app, text, unrelated, group, changes: () => changes,
        adapter: createPcbTextSelectionAdapter(app, text, `text:${text.id}`) };
}

for (const layer of TEXT_LAYERS) for (const gesture of ['move', 'rotate']) {
    for (const finish of ['commit', 'cancel', 'no-op', 'deactivate', 'load', 'failure', 'missing']) {
        const f = fixture(layer), { app, text, unrelated, adapter, group } = f;
        const original = { ...text };
        const canonicalMap = app.pcbDocument.texts;
        const geometry = app.pcbDocument.captureGeometry();
        const serialized = app.pcbDocument.serialize();
        const originalSvg = getTextElement(app, text.id).getAttribute('transform');
        const otherSvg = getTextElement(app, unrelated.id);
        const redo = { execute() {}, undo() {} };
        app.history.execute(redo);
        app.history.undo();
        const changes = f.changes();
        const start = gesture === 'move' ? { x: 0, y: 0 } : { x: text.x + 10, y: text.y };
        const update = step => {
            if (gesture === 'move') adapter.updateMove({ x: 4 + step / 1000, y: 6 - step / 1000 });
            else {
                const angle = (original.rotation - (90 + step)) * Math.PI / 180;
                adapter.updateAnchorDrag({ x: original.x + 10 * Math.cos(angle), y: original.y + 10 * Math.sin(angle) });
            }
        };
        if (gesture === 'move') {
            adapter.beginMove(start);
            setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'move-adapter', entry: adapter });
        } else {
            adapter.beginAnchorDrag('rotate', start);
            setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'anchor', adapter });
        }
        try {
            assert.equal(getTextPosePreviewTexts(app), undefined, 'Pickup does not allocate a projection');
            update(0);
            const texts = app.texts, projected = texts.get(text.id);
            assert.notEqual(texts, canonicalMap);
            assert.notEqual(projected, text);
            assert.equal(texts.get(unrelated.id), unrelated);
            assert.throws(() => previewTextPose(app, unrelated.id, { x: 1 }), /Finish the current text preview/);
            for (let step = 1; step <= 100; step++) {
                update(step);
                assert.equal(app.texts, texts);
                assert.equal(app.texts.get(text.id), projected);
                assert.equal(getPcbSelection(app, 'text')[0], projected, 'Existing selection resolves the current projection');
                assert.deepEqual(adapter.getBounds(), pcbTextBounds(projected));
                assert.equal(group.children.length, 2, 'Preview never duplicates SVG');
            }
            assert.deepEqual(text, original);
            assert.equal(app.pcbDocument.texts, canonicalMap);
            assert.deepEqual(app.pcbDocument.captureGeometry(), geometry);
            assert.deepEqual(app.pcbDocument.serialize(), serialized);
            assert.equal(f.changes(), changes);
            assert.equal(getTextElement(app, unrelated.id), otherSvg);
            const final = { ...projected };
            const previewSvg = getTextElement(app, text.id).getAttribute('transform');
            assert.notEqual(previewSvg, originalSvg);
            if (finish === 'load') {
                setEditorActive(app, false);
                loadPcb(app, null);
                assert.equal(canonicalMap.size, 0);
                assert.equal(group.children.length, 0);
            } else if (finish === 'deactivate') PCBApp.prototype.deactivate.call(app);
            else if (finish === 'failure' || finish === 'missing') {
                if (finish === 'failure') app.history.execute = () => { throw new Error('Injected history failure'); };
                else canonicalMap.delete(text.id);
                assert.throws(() => finishSelectionInteraction(app, true),
                    finish === 'failure' ? /Injected history failure/ : /PCB text is no longer available/);
                assert.equal(getSelectionInteraction(app), null, 'A failed commit cannot leave saving blocked by a stale gesture');
            } else {
                if (finish === 'no-op') {
                    if (gesture === 'move') adapter.updateMove(start);
                    else adapter.updateAnchorDrag({ x: original.x, y: original.y });
                }
                finishSelectionInteraction(app, finish !== 'cancel');
            }
            assert.equal(getTextPosePreviewTexts(app), undefined);
            assert.equal(app.texts, canonicalMap);
            assert.equal(getSelectionInteraction(app), null);
            assert.ok(!getTextDrag(app));
            assert.ok(!isRotationHandleDragActive(app));
            if (finish === 'commit') {
                assert.deepEqual(text, final);
                assert.equal(getTextElement(app, text.id).getAttribute('transform'), previewSvg);
                assert.equal(app.history.undoStack.length, 1);
                assert.equal(app.history.canRedo(), false);
                app.history.undo();
                assert.deepEqual(text, original);
                assert.equal(getTextElement(app, text.id).getAttribute('transform'), originalSvg);
                app.history.redo();
                assert.deepEqual(text, final);
            } else if (finish !== 'load') {
                assert.deepEqual(text, original);
                assert.equal(app.history.canUndo(), false);
                assert.equal(app.history.redoStack[0], redo);
                if (finish === 'missing') {
                    assert.equal(canonicalMap.has(text.id), false);
                    assert.equal(getTextElement(app, text.id), null);
                } else {
                    assert.deepEqual(app.pcbDocument.serialize(), serialized);
                    assert.equal(getTextElement(app, text.id).getAttribute('transform'), originalSvg);
                }
            }
        } finally { cancelPictureCopperRefresh(app); }
    }
}
console.log('PASS text pose isolation across six layers, SVG/selection projections, reuse, history, failure and lifecycle cleanup');
