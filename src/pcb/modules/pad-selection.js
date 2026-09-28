import { isLayerLocked, isLayerVisible, unlockPcbLayer } from './layers.js';
import { padBounds, padHitTest, padLayers, padOutline, renderPad, updatePadHighlightGeometry } from './pad.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import { ModifyPadCommand } from './pad-commands.js';

export function createPadSelectionAdapter(app, pad, id) {
    let rotationDrag = null;
    let moveDrag = null;
    const layers = () => padLayers(pad);
    return {
        id, kind: 'pad', object: pad,
        get visible() { return pad.visible !== false && layers().some(isLayerVisible); },
        get locked() { return pad.locked || layers().some(isLayerLocked); },
        unlock() { for (const layer of layers()) unlockPcbLayer(app, layer); },
        getBounds() { return padBounds(pad); },
        getLockPosition(pointer, scale) {
            return lockPositionOutsideOutline(
                padOutline(pad),
                pointer || { x: pad.x, y: pad.y },
                scale,
            );
        },
        hitTest(point) { return padHitTest(pad, point); },
        getPosition() { return { x: pad.x, y: pad.y }; },
        getAnchors() {
            return pad.shape === 'round'
                ? [] : [rotationHandleAnchor(padBounds(pad), app.viewport?.scale)];
        },
        beginMove(worldPos) {
            moveDrag = {
                before: pad.captureState(),
                grab: { ...worldPos },
                previousDeferDragOverlays: !!app._deferDragOverlays,
            };
            app._deferDragOverlays = true;
            app.viewport?.setCrosshair({ x: pad.x, y: pad.y });
            return true;
        },
        updateMove(worldPos) {
            if (!moveDrag) return;
            const target = {
                x: moveDrag.before.x + worldPos.x - moveDrag.grab.x,
                y: moveDrag.before.y + worldPos.y - moveDrag.grab.y,
            };
            const position = app.viewport?.getSnappedPosition?.(target) || target;
            pad.x = position.x;
            pad.y = position.y;
            app.viewport?.setCrosshair(position);
            renderPad(pad, layer => app._getLayerGroup(layer));
            updatePadHighlightGeometry(pad, app._getLayerGroup('selection-overlay'));
            if (pad.net) app._updateRatsnest?.({ nets: new Set([pad.net]) });
        },
        endMove(commit) {
            if (!moveDrag) return;
            const drag = moveDrag;
            moveDrag = null;
            app._deferDragOverlays = drag.previousDeferDragOverlays;
            app.viewport?.hideCrosshair();
            const after = pad.captureState();
            const moved = after.x !== drag.before.x || after.y !== drag.before.y;
            if (commit && moved) {
                pad.applyState(drag.before);
                app.history.execute(new ModifyPadCommand(app, pad, drag.before, after));
            } else if (!commit && moved) {
                pad.applyState(drag.before);
                renderPad(pad, layer => app._getLayerGroup(layer));
                updatePadHighlightGeometry(pad, app._getLayerGroup('selection-overlay'));
                if (pad.net) app._updateRatsnest?.({ nets: new Set([pad.net]) });
            }
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
