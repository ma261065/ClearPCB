import { isLayerLocked, isLayerVisible, unlockPcbLayer } from './layers.js';
import { padLayers } from '../../shapes/pad-geometry.js';
import { renderPad, updatePadHighlightGeometry } from './pad.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import {
    ModifyPadCommand, getPadRotationPreview, beginPadRotationPreview, previewPadRotation, finishPadRotationPreview,
} from './pad-commands.js';
import { startPadDrag, updateViaDrag, finishViaDrag, cancelViaDrag } from './track-drag.js';

export function createPadSelectionAdapter(app, pad, id) {
    if (app._viaDrag?.via === pad) pad = app._viaDrag.original;
    if (getPadRotationPreview(app)?.pad === pad) pad = getPadRotationPreview(app).original;
    const current = () => {
        if (app._viaDrag?.original === pad) return app._viaDrag.via;
        const preview = getPadRotationPreview(app);
        return preview?.original === pad ? preview.pad : pad;
    };
    const layers = () => padLayers(pad);
    return {
        id, kind: 'pad', get object() { return current(); },
        get visible() { return pad.visible !== false && layers().some(isLayerVisible); },
        get locked() { return pad.locked || layers().some(isLayerLocked); },
        unlock() { for (const layer of layers()) unlockPcbLayer(app, layer); },
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
            return startPadDrag(app, pad, worldPos);
        },
        updateMove(worldPos) {
            updateViaDrag(app, worldPos);
            updatePadHighlightGeometry(current(), app._getLayerGroup('selection-overlay'));
        },
        endMove(commit) {
            if (commit) finishViaDrag(app);
            else cancelViaDrag(app);
            updatePadHighlightGeometry(pad, app._getLayerGroup('selection-overlay'));
            if (!app._deferDragOverlays) app._refreshClearanceHalos?.();
        },
        beginAnchorDrag(anchorId, worldPos) {
            if (anchorId !== 'rotate') return false;
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
            renderPad(copy, layer => app._getLayerGroup(layer));
            updatePadHighlightGeometry(copy, app._getLayerGroup('selection-overlay'));
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
        invalidate() { renderPad(current(), layer => app._getLayerGroup(layer)); },
    };
}

registerPcbSelectionAdapter('pad', createPadSelectionAdapter);
