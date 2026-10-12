import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { PcbDocument } = await import('../../src/core/PcbDocument.js');
const { CommandHistory } = await import('../../src/core/CommandHistory.js');
const { createPcbText } = await import('../../src/core/pcb-text.js');
const { EditTextCommand } = await import('../../src/pcb/modules/text-commands.js');
const { CompoundCommand } = await import('../../src/pcb/modules/track-commands.js');
const { PCB_LAYERS } = await import('../../src/pcb/modules/layers.js');
const { getPcbSelectionEntries, setPcbSelection } = await import('../../src/pcb/modules/selection-registry.js');
const { cancelPictureCopperRefresh } = await import('../../src/pcb/modules/picture-refresh.js');
const lockedLayer = PCB_LAYERS.find(layer => layer.id === 'bottom-silk');
const previousLock = lockedLayer.locked;
const pcbDocument = new PcbDocument();
const first = createPcbText({ id: 'first', content: 'A', layer: 'top-silk' });
const second = createPcbText({ id: 'second', content: 'B', layer: 'top-document' });
pcbDocument.texts.set(first.id, first);
pcbDocument.texts.set(second.id, second);
const panel = document.createElement('div');
panel.id = 'pcbPropertiesPanel';
const items = document.createElement('div');
items.id = 'pcbPropsItems';
panel.appendChild(items);
document.body.appendChild(panel);
const titles = [];
const presentedLayers = [];
const app = { ...pcbEditorStubs(),
    pcbDocument, texts: pcbDocument.texts, history: new CommandHistory(),
    propertiesItems: () => items, setPropertiesTitle: title => {
        titles.push(title);
        presentedLayers.push(getPcbSelectionEntries(app).map(entry => entry.object.layer));
    },
    refreshText() {},
};
for (const name of ['showTextProperties', 'showMultiSelectionProperties', 'openPropertyPanel', 'refreshPropertyPanel',
    '_pcbMultiPropertyCapabilities', '_bindStrokeTextProps', 'layerLabel']) app[name] = PCBApp.prototype[name];
const show = texts => {
    setPcbSelection(app, texts.map(object => ({ kind: 'text', object })));
    if (texts.length === 1) app.showTextProperties(texts[0]);
    else app.showMultiSelectionProperties(getPcbSelectionEntries(app));
};
const verifySingle = (layer, disabled) => {
    assert.equal(titles.at(-1), 'Text');
    assert.equal(control('pcbPropTextLayer').value, layer, 'Layer field follows model history');
    assert.equal(control('pcbPropTextSize').disabled, disabled, 'Text controls follow the current layer lock');
};
const control = id => document.getElementById(id);
const selectedOption = select => select.children.find(option => option.value === select.value);
try {
    lockedLayer.locked = true;
    show([first]);
    app.history.execute(new EditTextCommand(app, first.id, { layer: 'bottom-silk' }));
    verifySingle('bottom-silk', true);
    app.history.undo();
    verifySingle('top-silk', false);
    app.history.redo();
    verifySingle('bottom-silk', true);
    app.history.undo();
    const beforeStyle = titles.length;
    app.history.execute(new EditTextCommand(app, first.id, { size: 2 }));
    assert.equal(titles.length, beforeStyle, 'Non-layer edits must not rebuild the active property form');

    show([first, second]);
    const originals = [first.layer, second.layer];
    const beforeBatch = titles.length;
    app.history.execute(new CompoundCommand([first, second].map(text =>
        new EditTextCommand(app, text.id, { layer: 'bottom-silk' }))));
    assert.equal(titles.length - beforeBatch, 1, 'Compound layer commands refresh properties once, not once per text');
    assert.equal(titles.at(-1), '2 Selected', 'Layer history must not collapse the multi-selection panel');
    assert.equal(control('pcbPropIntersection_layer').disabled, true);
    assert.equal(control('pcbPropIntersection_layer').value, 'bottom-silk');
    app.history.undo();
    assert.deepEqual([first.layer, second.layer], originals);
    assert.equal(titles.at(-1), '2 Selected');
    assert.equal(selectedOption(control('pcbPropIntersection_layer')).textContent, 'Mixed');
    assert.equal(selectedOption(control('pcbPropIntersection_layer')).disabled, true);
    assert.equal(control('pcbPropIntersection_layer').disabled, false);
    app.history.redo();
    assert.equal(control('pcbPropIntersection_layer').disabled, true);

    setPcbSelection(app, []);
    const beforeUnselected = titles.length;
    app.history.undo();
    assert.equal(titles.length, beforeUnselected, 'Unselected text history must not replace another property panel');
    assert.equal(app.texts.get(first.id), first);
    assert.equal(app.texts.get(second.id), second);

    const many = Array.from({ length: 100 }, (_, index) => createPcbText({
        id: `batch-${index}`, layer: index % 2 ? 'top-silk' : 'top-document',
    }));
    for (const text of many) app.texts.set(text.id, text);
    show(many);
    const startingLayers = many.map(text => text.layer);
    const edits = many.map(text => new EditTextCommand(app, text.id, { layer: 'bottom-silk' }));
    let commandStart = titles.length;
    const checkDeferred = () => assert.equal(titles.length, commandStart,
        'Nested commands must not display intermediate layer states');
    const batch = new CompoundCommand([
        new CompoundCommand(edits.slice(0, 50)),
        { execute: checkDeferred, undo: checkDeferred },
        new CompoundCommand(edits.slice(50)),
    ]);
    for (const [operation, expected] of [
        [() => app.history.execute(batch), many.map(() => 'bottom-silk')],
        [() => app.history.undo(), startingLayers],
        [() => app.history.redo(), many.map(() => 'bottom-silk')],
    ]) {
        commandStart = titles.length;
        operation();
        assert.equal(titles.length - commandStart, 1, '100 nested layer edits need one property projection per history operation');
        assert.deepEqual(presentedLayers.at(-1), expected, 'The panel sees only the complete resulting state');
    }

    const beforeFailure = titles.length;
    const undoBeforeFailure = [...app.history.undoStack];
    const redoBeforeFailure = [...app.history.redoStack];
    const stateBeforeFailure = many.map(text => text.layer);
    assert.throws(() => app.history.execute(new CompoundCommand([
        new EditTextCommand(app, many[0].id, { layer: 'top-silk' }),
        { execute() { throw new Error('Simulated command failure'); }, undo() {} },
    ])), /Simulated command failure/);
    assert.equal(titles.length - beforeFailure, 1, 'Failed batches refresh once after rollback');
    assert.deepEqual(presentedLayers.at(-1), stateBeforeFailure);
    assert.deepEqual(app.history.undoStack, undoBeforeFailure);
    assert.deepEqual(app.history.redoStack, redoBeforeFailure);

    const beforeSelectionChange = titles.length;
    app.history.execute(new CompoundCommand([
        new EditTextCommand(app, many[0].id, { layer: 'top-silk' }),
        { execute() { setPcbSelection(app, []); }, undo() {} },
    ]));
    assert.equal(titles.length, beforeSelectionChange, 'Deferred refresh must recheck the current selection');
} finally {
    cancelPictureCopperRefresh(app);
    lockedLayer.locked = previousLock;
    delete globalThis.document;
    delete globalThis.window;
}
console.log('PASS text layer property projection across execute/undo/redo, locks and single/multiple selections');
