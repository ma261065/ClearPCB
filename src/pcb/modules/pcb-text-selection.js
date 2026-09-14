import { isLayerLocked, isLayerVisible } from './layers.js';
import { pcbTextBounds, pcbTextHitTest, renderPcbText } from './pcb-text.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';
import { rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';
import { EditTextCommand } from './text-commands.js';

export function createPcbTextSelectionAdapter(app, text, id) {
    let rotationDrag = null;
    return {
        id,
        kind: 'text',
        object: text,
        get visible() { return !isLayerLocked(text.layer) && isLayerVisible(text.layer); },
        getBounds() { return pcbTextBounds(text); },
        hitTest(point) { return pcbTextHitTest(text, point.x, point.y); },
        getPosition() { return { x: text.x, y: text.y }; },
        getAnchors() { return [rotationHandleAnchor(pcbTextBounds(text), app.viewport?.scale)]; },
        beginAnchorDrag(anchorId, worldPos) {
            if (anchorId !== 'rotate') return false;
            rotationDrag = { center: { x: text.x, y: text.y }, start: { ...worldPos }, rotation: text.rotation || 0 };
            app._rotationHandleDrag = true;
            schedulePictureCopperRefresh(app, text);
            return true;
        },
        updateAnchorDrag(worldPos) {
            if (!rotationDrag) return;
            text.rotation = pointerRotation(rotationDrag.center, rotationDrag.start, worldPos, rotationDrag.rotation);
            schedulePictureCopperRefresh(app, text);
            app._refreshText(text.id);
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTextRot'));
            if (input) input.value = String(Math.round(text.rotation) % 360);
        },
        endAnchorDrag(commit) {
            if (!rotationDrag) return;
            const after = text.rotation;
            text.rotation = rotationDrag.rotation;
            rotationDrag = null;
            app._rotationHandleDrag = false;
            schedulePictureCopperRefresh(app, text);
            if (commit && after !== text.rotation) app.history.execute(new EditTextCommand(app, text.id, { rotation: after }));
            else app._refreshText(text.id);
            app._showTextProperties?.(text);
        },
        beginMove(worldPos) { return app._beginTextDrag(text, worldPos); },
        updateMove(worldPos) { app._updateTextDrag(worldPos); },
        endMove(commit) { app._endTextDrag(commit); },
        invalidate() { app._refreshText(text.id); },
        render() { renderPcbText(text); },
    };
}

registerPcbSelectionAdapter('text', createPcbTextSelectionAdapter);
