import { isLayerVisible } from './layers.js';
import { isPcbObjectLocked } from './object-locks.js';
import { padLayers } from '../../shapes/pad-geometry.js';
import { renderPad, updatePadHighlightGeometry } from './pad.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import {
    ModifyPadCommand, getPadRotationPreview, beginPadRotationPreview, previewPadRotation, finishPadRotationPreview,
    canonicalPad, displayedPad,
} from './pad-commands.js';
import { startPadDrag, updateViaDrag, finishViaDrag, cancelViaDrag } from './track-drag.js';
import { getPropertyEditor } from './property-editors.js';
import { areDragOverlaysDeferred } from './refresh-state.js';

export function createPadSelectionAdapter(app, pad, id) {
    pad = canonicalPad(app, pad);
    const current = () => displayedPad(app, pad);
    const layers = () => padLayers(pad);
    return {
        id, kind: 'pad', get object() { return current(); },
        get visible() { return pad.visible !== false && layers().some(isLayerVisible); },
        get locked() { return isPcbObjectLocked(app, 'pad', pad); },
        getBounds() { return current().getBounds(); },
        getLockPosition(pointer, scale) {
            const pad = current();
            return lockPositionOutsideOutline(
                pad.getOutline(),
                pointer || { x: pad.x, y: pad.y },
                scale,
            );
        },
        hitTest(point) { return current().hitTest(point); },
        getPosition() { const pad = current(); return { x: pad.x, y: pad.y }; },
        getAnchors() {
            const pad = current();
            return pad.shape === 'round'
                ? [] : [rotationHandleAnchor(pad.getBounds(), app.viewport?.scale)];
        },
        beginMove(worldPos) {
            getPropertyEditor(app, 'pad')?.commit();
            return startPadDrag(app, pad, worldPos);
        },
        updateMove(worldPos) {
            updateViaDrag(app, worldPos);
            updatePadHighlightGeometry(current(), app.getLayerGroup('selection-overlay'));
        },
        endMove(commit) {
            if (commit) finishViaDrag(app);
            else cancelViaDrag(app);
            updatePadHighlightGeometry(pad, app.getLayerGroup('selection-overlay'));
            if (!areDragOverlaysDeferred(app)) app.refreshClearanceHalos?.();
        },
        beginAnchorDrag(anchorId, worldPos) {
            if (anchorId !== 'rotate') return false;
            getPropertyEditor(app, 'pad')?.commit();
            beginPadRotationPreview(app, pad, worldPos);
            return true;
        },
        updateAnchorDrag(worldPos) {
            const rotationDrag = getPadRotationPreview(app);
            if (rotationDrag?.original !== pad) return;
            const rotation = pointerRotation(
                { x: pad.x, y: pad.y }, rotationDrag.start, worldPos, rotationDrag.rotation,
            );
            if (current().rotation === rotation) return;
            const copy = previewPadRotation(app, pad, rotation);
            renderPad(copy, layer => app.getLayerGroup(layer));
            updatePadHighlightGeometry(copy, app.getLayerGroup('selection-overlay'));
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropPadRotation'));
            if (input) input.value = String(Math.round(rotation) % 360);
        },
        endAnchorDrag(commit) {
            if (getPadRotationPreview(app)?.original !== pad) return;
            const before = pad.captureState();
            const rotation = current().rotation;
            finishPadRotationPreview(app, commit && rotation !== before.rotation
                ? () => app.history.execute(new ModifyPadCommand(app, pad, before, { ...before, rotation }))
                : undefined);
        },
        invalidate() { renderPad(current(), layer => app.getLayerGroup(layer)); },
    };
}

registerPcbSelectionAdapter('pad', createPadSelectionAdapter);
