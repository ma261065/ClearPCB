import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../../src/core/PcbPlacementState.js';
import { PCB_LAYERS, notifyLayerLockChanged } from '../../src/pcb/modules/layers.js';
import { beginRefTextDrag, createRefTextSelectionAdapter, handleRefDrag } from '../../src/pcb/modules/ref-text-selection.js';
import { beginSelectionInteraction } from '../../src/pcb/modules/selection-interaction.js';
import { getPcbSelection, setPcbSelection } from '../../src/pcb/modules/selection-registry.js';
import { SetPlacementLockedCommand } from '../../src/pcb/modules/track-commands.js';
import { renderPcbSelectionAnchors } from '../../src/pcb/modules/selection-anchors.js';
import { unlockMenuItems } from '../../src/pcb/modules/object-locks.js';
import { attachPropertyPanelHarness } from './helpers/property-panel-controls.mjs';
import { getSelectionInteraction } from '../../src/pcb/modules/selection-interaction.js';
import { getRefDrag } from '../../src/pcb/modules/ref-text-selection.js';
import { activeTextInlineEdit } from '../../src/pcb/modules/text-inline-edit.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import { setRefTextGeometryCache } from '../../src/pcb/modules/ref-text-geometry.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
const element = (tagName = 'g') => fakeElement(tagName);
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

for (const side of ['top', 'bottom']) {
    const layer = PCB_LAYERS.find(item => item.id === `${side}-silk`);
    const other = PCB_LAYERS.find(item => item.id === `${side === 'top' ? 'bottom' : 'top'}-silk`);
    const previous = layer.locked, otherPrevious = other.locked;
    const refElement = { isConnected: true, setAttribute() {}, getAttribute: name => ({
        'data-ref-anchor-y': '0', 'data-ref-cy': '0',
    })[name] ?? null };
    const placement = { x: 0, y: 0, side, refDx: 0, refDy: 0, refRot: 0, refSize: 1.2,
        refStrokeWidth: 0.15, reference: 'R1', elements: [],
    };
    setRefTextGeometryCache(placement, refElement, { bx: -1, by: -1, bw: 2, bh: 2, cx: 0, cy: 0 });
    const pcbDocument = new PcbDocument();
    pcbDocument.placementState.record('part', placement);
    const controls = new Map();
    let propertyShows = 0;
    const app = { ...pcbEditorStubs(),
        pcbDocument, placementState: pcbDocument.placementState,
        placements: new Map([['part', placement]]), history: new CommandHistory(),
        viewport: { scale: 10, svg: { style: {} }, snapToGrid: false, addContent() {} },
        tracks: [], vias: [], boardShapes: [], texts: new Map(), _layerGroups: new Map(), existingLayerGroups() { return this._layerGroups; },
        getLayerGroup: () => null, drawRefOverlay() {}, markDirty() {},
        setPropertiesTitle: () => propertyShows++,
        layerLabel: PCBApp.prototype.layerLabel, screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
    };
    attachPropertyPanelHarness(app, { controls });
    for (const name of ['rotateRefText', '_worldToPlacementLocal',
        'snapToGrid', 'showRefProperties', '_bindStrokeTextProps', '_pcbMultiPropertyCapabilities',
        '_endTextInlineEdit']) app[name] = PCBApp.prototype[name];
    const adapter = createRefTextSelectionAdapter(app, 'part', 'reftext:part');
    const original = capturePlacementOverride(placement);
    try {
        other.locked = true;
        layer.locked = false;
        assert.equal(adapter.locked, false, 'Opposite-side silk lock does not lock this reference');
        layer.locked = true;
        assert.equal(adapter.locked, true, 'Reference adapter must honor its silk-layer lock');
        assert.equal(adapter.visible, true, 'Locked labels remain visible for inspection');
        assert.equal(adapter.hitTest({ x: 0, y: 0 }), true);
        assert.equal(beginSelectionInteraction(app, { x: 0, y: 0 }, false), true);
        assert.deepEqual(getPcbSelection(app, 'reftext'), ['part']);
        assert.equal(getSelectionInteraction(app), null, 'Locked selection must not arm a drag');
        assert.equal(getRefDrag(app), null);
        assert.equal(beginRefTextDrag(app, 'part', { x: 0, y: 0 }), false);
        app.rotateRefText('part');
        assert.deepEqual(capturePlacementOverride(placement), original);
        assert.equal(app.history.canUndo(), false);
        for (const id of ['pcbPropRefSize', 'pcbPropRefRot', 'pcbPropRefLW']) {
            assert.equal(controls.get(id).disabled, true, 'Single-reference properties are read-only');
        }
        const capabilities = app._pcbMultiPropertyCapabilities({ kind: 'reftext', object: 'part' });
        assert.ok(Object.values(capabilities).every(capability => capability.disabled),
            'Mixed-selection properties must also honor the reference layer lock');
        const overlay = element();
        let lockOwner;
        overlay.dispatchEvent = event => { lockOwner = event.detail.shape; };
        app.getLayerGroup = () => overlay;
        renderPcbSelectionAnchors(app);
        overlay.children[0].listeners.get('click')[0]({ stopPropagation() {} });
        assert.equal(lockOwner.kind, 'reftext');
        assert.equal(lockOwner.object, 'part', 'Reference lock icons retain the owning component for the unlock menu');
        assert.deepEqual(unlockMenuItems(app, 'reftext', 'part').map(item => item.text), [`Unlock ${layer.name} layer`],
            'A silk-only lock offers just the layer unlock');
        app.getLayerGroup = () => null;

        const beforeUnlockProperties = propertyShows;
        unlockMenuItems(app, 'reftext', 'part')[0].onClick();
        assert.equal(layer.locked, false);
        assert.equal(other.locked, true, 'Unlock only the reference side');
        assert.ok(propertyShows > beforeUnlockProperties, 'Layer unlock refreshes selected-reference controls');
        assert.equal(controls.get('pcbPropRefRot').disabled, false);
        app.rotateRefText('part');
        assert.equal(placement.refRot, 90);
        app.history.undo();
        assert.equal(placement.refRot, 0, 'Unlocked reference rotation retains undo');
        assert.equal(adapter.beginMove({ x: 0, y: 0 }), true);
        adapter.updateMove({ x: 4, y: 5 });
        assert.notEqual(placement.refDx, 0);
        layer.locked = true;
        const preview = capturePlacementOverride(placement);
        adapter.updateMove({ x: 8, y: 9 });
        handleRefDrag(app, { clientX: 10, clientY: 11, shiftKey: false });
        assert.deepEqual(capturePlacementOverride(placement), preview, 'Both pointer paths stop updating after a lock');
        adapter.endMove(true);
        assert.deepEqual(capturePlacementOverride(placement), original, 'A locked drag drops by restoring its preview, not committing');
        assert.equal(app.history.canUndo(), false);
        assert.deepEqual(app.placementState.overrides.get('part'), original);

        layer.locked = false;
        adapter.beginMove({ x: 0, y: 0 });
        adapter.updateMove({ x: 2, y: 3 });
        setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'move-adapter', entry: adapter });
        layer.locked = true;
        notifyLayerLockChanged(app, layer.id, true);
        assert.equal(getRefDrag(app), null, 'The layer-panel callback cancels an active reference preview');
        assert.equal(getSelectionInteraction(app), null);
        assert.deepEqual(capturePlacementOverride(placement), original);

        let inlineCommit;
        placement.reference = 'Preview';
        setPcbInteraction(app, '_textEdit', {
            text: { content: 'Preview' }, originalContent: 'R1', input: { value: 'Preview' },
            options: { componentId: 'part', finish(value, commit) {
                inlineCommit = commit;
                placement.reference = value;
            } },
        });
        notifyLayerLockChanged(app, other.id, true);
        assert.ok(activeTextInlineEdit(app), 'Locking the opposite side does not interrupt inline reference editing');
        notifyLayerLockChanged(app, layer.id, true);
        assert.equal(activeTextInlineEdit(app), null);
        assert.equal(inlineCommit, false, 'Locking the reference layer cancels its active inline preview');
        assert.equal(placement.reference, 'R1');
        assert.equal(app.history.canUndo(), false);

        placement.locked = true;
        app.placementState.record('part', placement);
        const choices = unlockMenuItems(app, 'reftext', 'part');
        assert.deepEqual(choices.map(item => item.text), ['Unlock component', `Unlock ${layer.name} layer`, 'Unlock both']);
        choices[1].onClick();
        assert.equal(adapter.locked, true, 'Unlocking silk must not bypass a separate component lock');
        setPcbSelection(app, [{ kind: 'reftext', object: 'part' }]);
        const beforePlacementUnlock = propertyShows;
        app.history.execute(new SetPlacementLockedCommand(app, 'part', false));
        assert.equal(adapter.locked, false);
        assert.ok(propertyShows > beforePlacementUnlock, 'Placement unlock refreshes selected-reference properties');
        app.history.undo();
        assert.equal(adapter.locked, true, 'Placement lock history remains independent of silk-layer preferences');
    } finally {
        layer.locked = previous;
        other.locked = otherPrevious;
    }
}

delete globalThis.requestAnimationFrame;
delete globalThis.document;
delete globalThis.window;
console.log('PASS reference silk locks, read-only selection/properties, protected drags, layer unlock and placement locks');
