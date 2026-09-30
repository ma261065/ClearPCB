import { isLayerLocked, isLayerVisible, unlockPcbLayer } from './layers.js';
import { padLayers } from '../../shapes/pad-geometry.js';
import { renderPad, updatePadHighlightGeometry } from './pad.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import { ModifyPadCommand } from './pad-commands.js';
import { startPadDrag, updateViaDrag, finishViaDrag, cancelViaDrag } from './track-drag.js';

export function createPadSelectionAdapter(app, pad, id) {
    let rotationDrag = null;
    const layers = () => padLayers(pad);
    return {
        id, kind: 'pad', object: pad,
        get visible() { return pad.visible !== false && layers().some(isLayerVisible); },
        get locked() { return pad.locked || layers().some(isLayerLocked); },
        unlock() { for (const layer of layers()) unlockPcbLayer(app, layer); },
        getBounds() { return pad.getBounds(); },
        getLockPosition(pointer, scale) {
            return lockPositionOutsideOutline(
                pad.getOutline(),
                pointer || { x: pad.x, y: pad.y },
                scale,
            );
        },
        hitTest(point) { return pad.hitTest(point); },
        getPosition() { return { x: pad.x, y: pad.y }; },
        getAnchors() {
            return pad.shape === 'round'
                ? [] : [rotationHandleAnchor(pad.getBounds(), app.viewport?.scale)];
        },
        beginMove(worldPos) {
            return startPadDrag(app, pad, worldPos);
        },
        updateMove(worldPos) {
            updateViaDrag(app, worldPos);
            updatePadHighlightGeometry(pad, app._getLayerGroup('selection-overlay'));
        },
        endMove(commit) {
            if (commit) finishViaDrag(app);
            else cancelViaDrag(app);
            updatePadHighlightGeometry(pad, app._getLayerGroup('selection-overlay'));
            if (!app._deferDragOverlays) app._refreshClearanceHalos?.();
        },
        beginAnchorDrag(anchorId, worldPos) {
            if (anchorId !== 'rotate') return false;
            rotationDrag = { start: { ...worldPos }, rotation: pad.rotation };
            app._rotationHandleDrag = true;
            return true;
        },
        updateAnchorDrag(worldPos) {
            if (!rotationDrag) return;
            const rotation = pointerRotation(
                { x: pad.x, y: pad.y }, rotationDrag.start, worldPos, rotationDrag.rotation,
            );
            if (pad.rotation === rotation) return;
            pad.rotation = rotation;
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
