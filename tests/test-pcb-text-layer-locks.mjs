import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPcbText, TEXT_LAYERS } from '../src/core/pcb-text.js';
import { PCB_LAYERS, notifyLayerLockChanged } from '../src/pcb/modules/layers.js';
import { createPcbTextSelectionAdapter, handleTextDrag } from '../src/pcb/modules/pcb-text-selection.js';
import { setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { beginTextContentPreview } from '../src/pcb/modules/text-commands.js';
import { areDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';
import { unlockMenuItems } from '../src/pcb/modules/object-locks.js';
import { attachPropertyPanelHarness } from './helpers/property-panel-controls.mjs';
import { getSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { getTextDrag } from '../src/pcb/modules/pcb-text-selection.js';
import { activeTextInlineEdit } from '../src/pcb/modules/text-inline-edit.js';
import { isRotationHandleDragActive } from '../src/pcb/modules/rotation-handle.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [],
    createElement() { assert.fail('Locked text must not create an inline editor'); },
};
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

for (const layerId of TEXT_LAYERS) {
    const layer = PCB_LAYERS.find(item => item.id === layerId);
    const originalLock = layer.locked;
    const originalVisibility = layer.visible;
    const text = createPcbText({ id: 'label', content: 'Original', layer: layerId,
        x: Math.PI, y: -Math.E, rotation: 37.123456 });
    const original = { ...text };
    const pcbDocument = new PcbDocument();
    pcbDocument.texts.set(text.id, text);
    const controls = new Map();
    let propertyShows = 0, cleared = 0;
    const app = {
        pcbDocument, history: new CommandHistory(),
        viewport: { svg: { style: {} }, scale: 10, snapToGrid: false, setCrosshair() {}, hideCrosshair() {} },
        placements: new Map(), tracks: [], vias: [], boardShapes: [], _layerGroups: new Map(), existingLayerGroups() { return this._layerGroups; },
        getLayerGroup: () => null, refreshText() {},
        setPropertiesTitle: () => propertyShows++,
        layerLabel: PCBApp.prototype.layerLabel, clearProperties: () => cleared++, setActiveRibbonTab() {},
        screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
        _insertInlineTextSymbol: () => false,
    };
    attachPropertyPanelHarness(app, { controls });
    Object.defineProperty(app, 'texts', Object.getOwnPropertyDescriptor(PCBApp.prototype, 'texts'));
    for (const name of [
        'snapToGrid', 'selectText', 'showTextProperties', '_bindStrokeTextProps',
        '_pcbMultiPropertyCapabilities', '_startTextInlineEdit',
        '_endTextInlineEdit', '_deleteSelectedText']) app[name] = PCBApp.prototype[name];
    const adapter = createPcbTextSelectionAdapter(app, text, `text:${text.id}`);
    try {
        layer.locked = true;
        setPcbSelection(app, [{ kind: 'text', object: text }]);
        app.showTextProperties(text);
        for (const id of ['pcbPropTextLayer', 'pcbPropTextSize', 'pcbPropTextRot', 'pcbPropTextLW', 'pcbPropTextBorder']) {
            assert.equal(controls.get(id).disabled, true, 'Locked text properties must remain read-only');
        }
        const { locked: ownLock, ...edits } = app._pcbMultiPropertyCapabilities({ kind: 'text', object: text });
        assert.ok(Object.values(edits).every(capability => capability.disabled),
            'Multi-selection must not bypass a text layer lock');
        assert.equal(ownLock.disabled, false, 'The object lock stays editable under a layer lock');
        assert.equal(controls.get('pcbPropObjectLocked').disabled, false);
        setPcbInteraction(app, '_textEdit', { text });
        app.showTextProperties(text);
        assert.equal(controls.get('pcbPropTextInsert').disabled, true);
        setPcbInteraction(app, '_textEdit', null);
        assert.equal(adapter.beginMove({ x: 0, y: 0 }), false);
        assert.equal(adapter.beginAnchorDrag('rotate', { x: text.x + 1, y: text.y }), false);
        app._startTextInlineEdit(text);
        assert.equal(activeTextInlineEdit(app), null);
        assert.equal(app._deleteSelectedText(), false);
        assert.deepEqual(text, original);
        assert.equal(app.history.canUndo(), false);

        const beforeUnlock = propertyShows;
        const choices = unlockMenuItems(app, 'text', text);
        assert.deepEqual(choices.map(item => item.text), [`Unlock ${layer.name} layer`]);
        choices[0].onClick();
        assert.equal(layer.locked, false);
        assert.ok(propertyShows > beforeUnlock, 'Layer unlock refreshes selected text controls');
        assert.equal(controls.get('pcbPropTextRot').disabled, false);
        assert.equal(adapter.beginMove({ x: 0, y: 0 }), true);
        adapter.updateMove({ x: 3, y: 4 });
        const preview = { ...adapter.object };
        layer.locked = true;
        adapter.updateMove({ x: 7, y: 8 });
        handleTextDrag(app, { clientX: 9, clientY: 10, shiftKey: false });
        assert.deepEqual(adapter.object, preview, 'Locking stops updates through both pointer paths');
        assert.deepEqual(text, original, 'Locking never requires an authored rollback');
        adapter.endMove(true);
        assert.deepEqual(text, original, 'A now-locked drag restores its original position on drop');
        assert.equal(app.history.canUndo(), false);
        assert.equal(areDragOverlaysDeferred(app), false);

        layer.locked = false;
        adapter.beginMove({ x: 0, y: 0 });
        adapter.updateMove({ x: 1, y: 2 });
        setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'move-adapter', entry: adapter });
        layer.locked = true;
        notifyLayerLockChanged(app, layerId, true);
        assert.equal(getTextDrag(app), null);
        assert.equal(getSelectionInteraction(app), null);
        assert.deepEqual(text, original);

        for (const notify of [false, true]) {
            layer.locked = false;
            assert.equal(adapter.beginAnchorDrag('rotate', { x: text.x + 1, y: text.y }), true);
            adapter.updateAnchorDrag({ x: text.x, y: text.y + 1 });
            assert.notEqual(adapter.object.rotation, original.rotation);
            const rotationPreview = adapter.object.rotation;
            layer.locked = true;
            adapter.updateAnchorDrag({ x: text.x - 1, y: text.y });
            assert.equal(adapter.object.rotation, rotationPreview, 'Locked rotation stops following the pointer');
            if (notify) {
                setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'anchor', adapter });
                notifyLayerLockChanged(app, layerId, true);
                assert.equal(getSelectionInteraction(app), null);
            } else adapter.endAnchorDrag(true);
            assert.deepEqual(text, original);
            assert.equal(isRotationHandleDragActive(app), false);
            assert.equal(app.history.canUndo(), false);
        }

        const contentPreview = beginTextContentPreview(app, text.id);
        contentPreview.content = 'Preview';
        setPcbInteraction(app, '_textEdit', { text: contentPreview, originalContent: original.content, input: { value: 'Preview' }, options: {} });
        notifyLayerLockChanged(app, layerId, true);
        assert.equal(activeTextInlineEdit(app), null, 'Locking cancels a standalone inline preview too');
        assert.deepEqual(text, original);
        assert.equal(cleared, 1);
        assert.equal(app.history.canUndo(), false);

        layer.locked = false;
        layer.visible = false;
        assert.equal(adapter.beginMove({ x: 0, y: 0 }), false);
        assert.equal(adapter.beginAnchorDrag('rotate', { x: text.x + 1, y: text.y }), false);
        app._startTextInlineEdit(text);
        assert.equal(activeTextInlineEdit(app), null);
        setPcbSelection(app, [{ kind: 'text', object: text }]);
        assert.equal(app._deleteSelectedText(), false, 'A stale hidden selection must not bypass visibility');
        layer.visible = true;
        adapter.beginMove({ x: 0, y: 0 });
        adapter.updateMove({ x: 2, y: 3 });
        layer.visible = false;
        adapter.endMove(true);
        assert.deepEqual(text, original, 'Hiding a dragged label prevents committing its preview');
        assert.equal(app.history.canUndo(), false);
        layer.visible = true;
        adapter.beginAnchorDrag('rotate', { x: text.x + 1, y: text.y });
        adapter.updateAnchorDrag({ x: text.x, y: text.y + 1 });
        adapter.endAnchorDrag(true);
        assert.equal(app.history.undoStack.length, 1, 'Unlocked rotation still commits normally');
        app.history.undo();
        assert.deepEqual(text, original);
    } finally {
        layer.locked = originalLock;
        layer.visible = originalVisibility;
        cancelPictureCopperRefresh(app);
    }
}

delete globalThis.requestAnimationFrame;
delete globalThis.document;
delete globalThis.window;
console.log('PASS standalone text layer locks for properties, dragging, rotation, deletion and inline editing');
