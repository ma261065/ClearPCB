import { isLayerVisible } from './layers.js';
import { boardShapeLocked, isPcbObjectLocked } from './object-locks.js';
import { pcbTextBounds, pcbTextHitTest, pcbTextOutline, renderPcbText } from './pcb-text.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { beginRotationHandleDrag, endRotationHandleDrag, rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';
import { EditTextCommand, MoveTextCommand, previewTextPose, finishTextPosePreview } from './text-commands.js';
import { getPropertyEditor } from './property-editors.js';
import { areDragOverlaysDeferred, setDragOverlaysDeferred } from './refresh-state.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';

export function getTextDrag(app) {
    return getPcbInteraction(app, '_textDrag');
}

export function beginTextDrag(app, text, worldPos) {
    getPropertyEditor(app, 'text')?.commit();
    text = text && app.pcbDocument.texts.get(text.id);
    if (!text || !app.texts.has(text.id) || boardShapeLocked(text) || !isLayerVisible(text.layer)) return false;
    setPcbInteraction(app, '_textDrag', {
        textId: text.id,
        startWorld: worldPos,
        startPos: { x: text.x, y: text.y },
        previousDeferDragOverlays: !!areDragOverlaysDeferred(app),
    });
    setDragOverlaysDeferred(app, true);
    app.viewport?.setCrosshair({ x: text.x, y: text.y });
    return true;
}

export function updateTextDrag(app, worldPos) {
    const drag = getTextDrag(app);
    if (!drag) return;
    const text = app.texts.get(drag.textId);
    if (!text || boardShapeLocked(text) || !isLayerVisible(text.layer)) return;
    const raw = {
        x: drag.startPos.x + worldPos.x - drag.startWorld.x,
        y: drag.startPos.y + worldPos.y - drag.startWorld.y,
    };
    const snap = app.snapToGrid(raw);
    if (text.x === snap.x && text.y === snap.y) return;
    previewTextPose(app, text.id, snap);
    app.viewport?.setCrosshair({ x: snap.x, y: snap.y });
    app.refreshText(text.id);
}

export function handleTextDrag(app, e) {
    if (!getTextDrag(app)) return;
    app.viewport.shiftHeld = e.shiftKey;
    updateTextDrag(app, app.screenToWorld(e));
}

export function endTextDrag(app, commit = true) {
    const drag = getTextDrag(app);
    if (!drag) return;
    const { textId, startPos, previousDeferDragOverlays } = drag;
    setPcbInteraction(app, '_textDrag', null);
    setDragOverlaysDeferred(app, previousDeferDragOverlays);
    app.viewport?.hideCrosshair();
    app.viewport.svg.style.cursor = 'default';
    const text = app.texts.get(textId);
    finishTextPosePreview(app, text && commit && !boardShapeLocked(text) && isLayerVisible(text.layer)
        && (text.x !== startPos.x || text.y !== startPos.y)
        ? () => app.history.execute(new MoveTextCommand(app, textId, startPos.x, startPos.y, text.x, text.y))
        : undefined);
}

export function createPcbTextSelectionAdapter(app, text, id) {
    let rotationDrag = null;
    const current = () => app.texts.get(text.id) || text;
    return {
        id,
        kind: 'text',
        get object() { return current(); },
        get visible() { return isLayerVisible(current().layer); },
        get locked() { return isPcbObjectLocked(app, 'text', current()); },
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
            if (anchorId !== 'rotate' || boardShapeLocked(text) || !isLayerVisible(text.layer)) return false;
            rotationDrag = { center: { x: text.x, y: text.y }, start: { ...worldPos }, rotation: text.rotation || 0 };
            beginRotationHandleDrag(app);
            schedulePictureCopperRefresh(app, text);
            return true;
        },
        updateAnchorDrag(worldPos) {
            const text = current();
            if (!rotationDrag || boardShapeLocked(text) || !isLayerVisible(text.layer)) return;
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
            endRotationHandleDrag(app);
            try {
                finishTextPosePreview(app, commit && !boardShapeLocked(text)
                    && isLayerVisible(text.layer) && after !== before
                    ? () => app.history.execute(new EditTextCommand(app, text.id, { rotation: after }))
                    : undefined);
            } finally {
                const canonical = app.pcbDocument.texts.get(text.id);
                schedulePictureCopperRefresh(app, canonical);
                if (canonical) app.showTextProperties?.(canonical);
            }
        },
        beginMove(worldPos) { return beginTextDrag(app, current(), worldPos); },
        updateMove(worldPos) { updateTextDrag(app, worldPos); },
        endMove(commit) { endTextDrag(app, commit); },
        invalidate() { app.refreshText(text.id); },
        render() { renderPcbText(current()); },
    };
}

registerPcbSelectionAdapter('text', createPcbTextSelectionAdapter);
