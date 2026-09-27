import { isLayerLocked, isLayerVisible, unlockPcbLayer } from './layers.js';
import { padBounds, padHitTest, padLayers, renderPad, updatePadHighlightGeometry } from './pad.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';
import { rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import { ModifyPadCommand } from './pad-commands.js';

export function createPadSelectionAdapter(app, pad, id) {
    let rotationDrag = null;
    const layers = () => padLayers(pad);
    return {
        id, kind: 'pad', object: pad,
        get visible() { return pad.visible !== false && layers().some(isLayerVisible); },
        get locked() { return pad.locked || layers().some(isLayerLocked); },
        unlock() { for (const layer of layers()) unlockPcbLayer(app, layer); },
        getBounds() { return padBounds(pad); },
        hitTest(point) { return padHitTest(pad, point); },
        getPosition() { return { x: pad.x, y: pad.y }; },
        getAnchors() {
            return pad.shape === 'round'
                ? [] : [rotationHandleAnchor(padBounds(pad), app.viewport?.scale)];
        },
        beginAnchorDrag(anchorId, worldPos) {
            if (anchorId !== 'rotate') return false;
            rotationDrag = { start: { ...worldPos }, rotation: pad.rotation };
            app._rotationHandleDrag = true;
            return true;
        },
        updateAnchorDrag(worldPos) {
            if (!rotationDrag) return;
            pad.rotation = pointerRotation(
                { x: pad.x, y: pad.y }, rotationDrag.start, worldPos, rotationDrag.rotation,
            );
            renderPad(pad, layer => app._getLayerGroup(layer));
            updatePadHighlightGeometry(pad, app._getLayerGroup('selection-overlay'));
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropPadRotation'));
            if (input) input.value = String(Math.round(pad.rotation) % 360);
        },
        endAnchorDrag(commit) {
            if (!rotationDrag) return;
            const before = pad.captureState();
            const rotation = pad.rotation;
            before.rotation = rotationDrag.rotation;
            rotationDrag = null;
            app._rotationHandleDrag = false;
            if (commit && rotation !== before.rotation) {
                app.history.execute(new ModifyPadCommand(app, pad, before, { ...before, rotation }));
            } else {
                pad.rotation = before.rotation;
                renderPad(pad, layer => app._getLayerGroup(layer));
            }
        },
        invalidate() { renderPad(pad, layer => app._getLayerGroup(layer)); },
    };
}

registerPcbSelectionAdapter('pad', createPadSelectionAdapter);
