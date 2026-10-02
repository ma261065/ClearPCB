import { isLayerLocked, isLayerVisible, unlockPcbLayer } from './layers.js';
import { pcbTextBounds, pcbTextHitTest, pcbTextOutline, renderPcbText } from './pcb-text.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';
import { EditTextCommand, previewTextPose, finishTextPosePreview } from './text-commands.js';
import { getPropertyEditor } from './property-editors.js';

export function createPcbTextSelectionAdapter(app, text, id) {
    let rotationDrag = null;
    const current = () => app.texts.get(text.id) || text;
    return {
        id,
        kind: 'text',
        get object() { return current(); },
        get visible() { return isLayerVisible(current().layer); },
        get locked() { return isLayerLocked(current().layer); },
        unlock() { unlockPcbLayer(app, current().layer); },
        getBounds() { return pcbTextBounds(current()); },
        getLockPosition(pointer, scale) {
            const text = current();
            return lockPositionOutsideOutline(
                pcbTextOutline(text, false),
                pointer || { x: text.x, y: text.y },
                scale,
                true,
                Math.max(0, Number(text.strokeWidth) || 0) / 2,
            );
        },
        hitTest(point) { return pcbTextHitTest(current(), point.x, point.y); },
        getPosition() { const text = current(); return { x: text.x, y: text.y }; },
        getAnchors() { return [rotationHandleAnchor(pcbTextBounds(current()), app.viewport?.scale)]; },
        beginAnchorDrag(anchorId, worldPos) {
            getPropertyEditor(app, 'text')?.commit();
            const text = current();
            if (anchorId !== 'rotate' || isLayerLocked(text.layer) || !isLayerVisible(text.layer)) return false;
            rotationDrag = { center: { x: text.x, y: text.y }, start: { ...worldPos }, rotation: text.rotation || 0 };
            app._rotationHandleDrag = true;
            schedulePictureCopperRefresh(app, text);
            return true;
        },
        updateAnchorDrag(worldPos) {
            const text = current();
            if (!rotationDrag || isLayerLocked(text.layer) || !isLayerVisible(text.layer)) return;
            const rotation = pointerRotation(rotationDrag.center, rotationDrag.start, worldPos, rotationDrag.rotation);
            if (text.rotation === rotation) return;
            previewTextPose(app, text.id, { rotation });
            schedulePictureCopperRefresh(app, current());
            app.refreshText(text.id);
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTextRot'));
            if (input) input.value = String(Math.round(rotation) % 360);
        },
        endAnchorDrag(commit) {
            if (!rotationDrag) return;
            const text = current();
            const after = text.rotation;
            const before = rotationDrag.rotation;
            rotationDrag = null;
            app._rotationHandleDrag = false;
            try {
                finishTextPosePreview(app, commit && !isLayerLocked(text.layer)
                    && isLayerVisible(text.layer) && after !== before
                    ? () => app.history.execute(new EditTextCommand(app, text.id, { rotation: after }))
                    : undefined);
            } finally {
                const canonical = app.pcbDocument.texts.get(text.id);
                schedulePictureCopperRefresh(app, canonical);
                if (canonical) app._showTextProperties?.(canonical);
            }
        },
        beginMove(worldPos) { return app._beginTextDrag(current(), worldPos); },
        updateMove(worldPos) { app._updateTextDrag(worldPos); },
        endMove(commit) { app._endTextDrag(commit); },
        invalidate() { app.refreshText(text.id); },
        render() { renderPcbText(current()); },
    };
}

registerPcbSelectionAdapter('text', createPcbTextSelectionAdapter);
