import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPcbText } from '../src/core/pcb-text.js';
import { EditTextCommand } from '../src/pcb/modules/text-commands.js';
import { CompoundCommand } from '../src/pcb/modules/track-commands.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { getPcbSelectionEntries, setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const lockedLayer = PCB_LAYERS.find(layer => layer.id === 'bottom-silk');
const previousLock = lockedLayer.locked;
const pcbDocument = new PcbDocument();
const first = createPcbText({ id: 'first', content: 'A', layer: 'top-silk' });
const second = createPcbText({ id: 'second', content: 'B', layer: 'top-document' });
pcbDocument.texts.set(first.id, first);
pcbDocument.texts.set(second.id, second);
const items = { innerHTML: '', querySelector: () => null };
const titles = [];
const presentedLayers = [];
const app = {
    pcbDocument, texts: pcbDocument.texts, history: new CommandHistory(),
    propertiesItems: () => items, setPropertiesTitle: title => {
        titles.push(title);
        presentedLayers.push(getPcbSelectionEntries(app).map(entry => entry.object.layer));
    },
    refreshText() {},
};
for (const name of ['_showTextProperties', '_showPcbMultiSelectionProperties',
    '_pcbMultiPropertyCapabilities', '_bindStrokeTextProps', 'layerLabel']) app[name] = PCBApp.prototype[name];
const show = texts => {
    setPcbSelection(app, texts.map(object => ({ kind: 'text', object })));
    if (texts.length === 1) app._showTextProperties(texts[0]);
    else app._showPcbMultiSelectionProperties(getPcbSelectionEntries(app));
};
const verifySingle = (layer, disabled) => {
    assert.equal(titles.at(-1), 'Text');
    assert.match(items.innerHTML, new RegExp(`value="${layer}" selected`), 'Layer field follows model history');
    const size = items.innerHTML.match(/<input[^>]*id="pcbPropTextSize"[^>]*>/)[0];
    assert.equal(size.includes(' disabled'), disabled, 'Text controls follow the current layer lock');
};
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
    assert.match(items.innerHTML, /id="pcbPropIntersection_layer" disabled/);
    assert.match(items.innerHTML, /value="bottom-silk" selected/);
    app.history.undo();
    assert.deepEqual([first.layer, second.layer], originals);
    assert.equal(titles.at(-1), '2 Selected');
    assert.match(items.innerHTML, /<option value="" selected disabled>Mixed<\/option>/);
    assert.doesNotMatch(items.innerHTML, /id="pcbPropIntersection_layer" disabled/);
    app.history.redo();
    assert.match(items.innerHTML, /id="pcbPropIntersection_layer" disabled/);

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
