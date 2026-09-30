import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { createRefTextSelectionAdapter } from '../src/pcb/modules/ref-text-selection.js';
import { beginSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { getPcbSelection, setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { SetPlacementLockedCommand } from '../src/pcb/modules/track-commands.js';
import { renderPcbSelectionAnchors } from '../src/pcb/modules/selection-anchors.js';

function element() {
    return {
        style: {}, children: [], listeners: new Map(),
        setAttribute() {}, querySelectorAll: () => [],
        appendChild(child) { this.children.push(child); },
        addEventListener(name, listener) { this.listeners.set(name, listener); },
    };
}

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null, querySelector: () => null, createElementNS: element };
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

for (const side of ['top', 'bottom']) {
    const layer = PCB_LAYERS.find(item => item.id === `${side}-silk`);
    const other = PCB_LAYERS.find(item => item.id === `${side === 'top' ? 'bottom' : 'top'}-silk`);
    const previous = layer.locked, otherPrevious = other.locked;
    const placement = { x: 0, y: 0, side, refDx: 0, refDy: 0, refRot: 0, refSize: 1.2,
        refStrokeWidth: 0.15, reference: 'R1', elements: [] };
    const pcbDocument = new PcbDocument();
    pcbDocument.placementState.record('part', placement);
    const items = { innerHTML: '', querySelector: () => ({ addEventListener() {} }) };
    let propertyShows = 0;
    const app = {
        pcbDocument, placementState: pcbDocument.placementState,
        placements: new Map([['part', placement]]), history: new CommandHistory(),
        viewport: { scale: 10, svg: { style: {} }, snapToGrid: false },
        tracks: [], vias: [], boardShapes: [], texts: new Map(), _layerGroups: new Map(),
        _getLayerGroup: () => null, _drawRefOverlay() {}, _refreshRefHighlight() {},
        _refBox: () => ({ bx: -1, by: -1, bw: 2, bh: 2, cx: 0, cy: 0 }),
        _pcbPropsItems: () => items, _setPcbPropsTitle: () => propertyShows++,
        _layerLabel: value => value, _screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
    };
    for (const name of ['_beginRefTextDrag', '_updateRefTextDrag', '_handleRefDrag', '_endRefDrag',
        '_rotateRefText', '_hitTestRefText', '_worldToPlacementLocal', '_placementLocalToWorld',
        '_snapToGrid', '_showRefProperties', '_bindStrokeTextProps', '_pcbMultiPropertyCapabilities',
        '_onLayerLockChanged', '_endTextInlineEdit']) app[name] = PCBApp.prototype[name];
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
        assert.equal(app._pcbSelectionInteraction, null, 'Locked selection must not arm a drag');
        assert.equal(app._refDrag, undefined);
        assert.equal(app._beginRefTextDrag('part', { x: 0, y: 0 }), false);
        app._rotateRefText('part');
        assert.deepEqual(capturePlacementOverride(placement), original);
        assert.equal(app.history.canUndo(), false);
        for (const id of ['pcbPropRefSize', 'pcbPropRefRot', 'pcbPropRefLW']) {
            assert.match(items.innerHTML, new RegExp(`id="${id}"[^>]* disabled`), 'Single-reference properties are read-only');
        }
        const capabilities = app._pcbMultiPropertyCapabilities({ kind: 'reftext', object: 'part' });
        assert.ok(Object.values(capabilities).every(capability => capability.disabled),
            'Mixed-selection properties must also honor the reference layer lock');
        const overlay = element();
        let lockOwner;
        overlay.dispatchEvent = event => { lockOwner = event.detail.shape; };
        app._getLayerGroup = () => overlay;
        renderPcbSelectionAnchors(app);
        overlay.children[0].listeners.get('click')({ stopPropagation() {} });
        assert.equal(lockOwner.componentId, 'part', 'Reference lock icons retain the owning component for object unlock');
        assert.equal(typeof lockOwner.unlock, 'function', 'Reference lock icons also support independent layer unlock');
        app._getLayerGroup = () => null;

        const beforeUnlockProperties = propertyShows;
        adapter.unlock();
        assert.equal(layer.locked, false);
        assert.equal(other.locked, true, 'Unlock only the reference side');
        assert.ok(propertyShows > beforeUnlockProperties, 'Layer unlock refreshes selected-reference controls');
        assert.doesNotMatch(items.innerHTML, /id="pcbPropRefRot"[^>]* disabled/);
        app._rotateRefText('part');
        assert.equal(placement.refRot, 90);
        app.history.undo();
        assert.equal(placement.refRot, 0, 'Unlocked reference rotation retains undo');
        assert.equal(adapter.beginMove({ x: 0, y: 0 }), true);
        adapter.updateMove({ x: 4, y: 5 });
        assert.notEqual(placement.refDx, 0);
        layer.locked = true;
        const preview = capturePlacementOverride(placement);
        adapter.updateMove({ x: 8, y: 9 });
        app._handleRefDrag({ clientX: 10, clientY: 11, shiftKey: false });
        assert.deepEqual(capturePlacementOverride(placement), preview, 'Both pointer paths stop updating after a lock');
        adapter.endMove(true);
        assert.deepEqual(capturePlacementOverride(placement), original, 'A locked drag drops by restoring its preview, not committing');
        assert.equal(app.history.canUndo(), false);
        assert.deepEqual(app.placementState.overrides.get('part'), original);

        layer.locked = false;
        adapter.beginMove({ x: 0, y: 0 });
        adapter.updateMove({ x: 2, y: 3 });
        app._pcbSelectionInteraction = { mode: 'move-adapter', entry: adapter };
        layer.locked = true;
        app._onLayerLockChanged(layer.id, true);
        assert.equal(app._refDrag, null, 'The layer-panel callback cancels an active reference preview');
        assert.equal(app._pcbSelectionInteraction, null);
        assert.deepEqual(capturePlacementOverride(placement), original);

        let inlineCommit;
        placement.reference = 'Preview';
        app._textEdit = {
            text: { content: 'Preview' }, originalContent: 'R1', input: { value: 'Preview' },
            options: { componentId: 'part', finish(value, commit) {
                inlineCommit = commit;
                placement.reference = value;
            } },
        };
        app._onLayerLockChanged(other.id, true);
        assert.ok(app._textEdit, 'Locking the opposite side does not interrupt inline reference editing');
        app._onLayerLockChanged(layer.id, true);
        assert.equal(app._textEdit, null);
        assert.equal(inlineCommit, false, 'Locking the reference layer cancels its active inline preview');
        assert.equal(placement.reference, 'R1');
        assert.equal(app.history.canUndo(), false);

        placement.locked = true;
        app.placementState.record('part', placement);
        adapter.unlock();
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
