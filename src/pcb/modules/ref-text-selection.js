import { registerPcbSelectionAdapter, getRefTextSelectionHit } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { isLayerVisible, isLayerLocked } from './layers.js';
import { getPropertyEditor } from './property-editors.js';
import { MoveRefTextCommand, renderPlacementPose } from './track-commands.js';
import { worldToPlacementLocal } from './ref-text-geometry.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';

export function isRefTextLocked(placement) {
    return !!placement && (!!placement.locked
        || isLayerLocked(placement.side === 'bottom' ? 'bottom-silk' : 'top-silk'));
}

export function getRefDrag(app) {
    return getPcbInteraction(app, '_refDrag');
}

export function beginRefTextDrag(app, componentId, worldPos) {
    getPropertyEditor(app, 'component')?.commit();
    const placement = app.placements.get(componentId);
    if (!placement || isRefTextLocked(placement)) return false;
    setPcbInteraction(app, '_refDrag', {
        compId: componentId,
        startWorld: worldPos,
        startDx: placement.refDx || 0,
        startDy: placement.refDy || 0,
    });
    app._drawRefOverlay(componentId, true);
    return true;
}

export function updateRefTextDrag(app, worldPos) {
    const drag = getRefDrag(app);
    if (!drag) return;
    const placement = app.placements.get(drag.compId);
    if (!placement || isRefTextLocked(placement)) return;
    const localNow = worldToPlacementLocal(worldPos, placement);
    const localStart = worldToPlacementLocal(drag.startWorld, placement);
    const raw = {
        x: drag.startDx + localNow.x - localStart.x,
        y: drag.startDy + localNow.y - localStart.y,
    };
    const snap = app.snapToGrid(raw);
    if ((placement.refDx || 0) === snap.x && (placement.refDy || 0) === snap.y) return;
    placement.refDx = snap.x;
    placement.refDy = snap.y;
    renderPlacementPose(app, drag.compId);
    app._drawRefOverlay(drag.compId, true);
}

export function handleRefDrag(app, e) {
    if (!getRefDrag(app)) return;
    app.viewport.shiftHeld = e.shiftKey;
    updateRefTextDrag(app, app.screenToWorld(e));
}

export function endRefDrag(app, commit = true) {
    const drag = getRefDrag(app);
    if (!drag) return;
    const { compId, startDx, startDy } = drag;
    setPcbInteraction(app, '_refDrag', null);
    const placement = app.placements.get(compId);
    app.viewport.svg.style.cursor = 'default';
    if (!placement) { app._drawRefOverlay(null, false); return; }
    if ((placement.refDx || 0) === startDx && (placement.refDy || 0) === startDy) {
        app._drawRefOverlay(compId, false);
        return;
    }
    if (commit && !isRefTextLocked(placement)) {
        app.history.execute(new MoveRefTextCommand(app, compId, startDx, startDy, placement.refDx || 0, placement.refDy || 0));
    } else {
        placement.refDx = startDx;
        placement.refDy = startDy;
        renderPlacementPose(app, compId);
        app._drawRefOverlay(compId, false);
    }
}

function outlineForRefText(app, componentId) {
    const placement = app.placements?.get(componentId);
    const box = app._refBox?.(placement);
    if (!placement || !box) return [];
    const rotation = (placement.refRot || 0) * Math.PI / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const dx = placement.refDx || 0;
    const dy = placement.refDy || 0;
    return [
        [box.bx, box.by],
        [box.bx + box.bw, box.by],
        [box.bx + box.bw, box.by + box.bh],
        [box.bx, box.by + box.bh],
    ].map(([x, y]) => {
        const offsetX = x - box.cx;
        const offsetY = y - box.cy;
        let localX = box.cx + offsetX * cos - offsetY * sin;
        if (placement.mirror) localX = 2 * box.cx - localX;
        return app._placementLocalToWorld(
            placement,
            localX + dx,
            box.cy + offsetX * sin + offsetY * cos + dy,
        );
    });
}

function boundsForRefText(app, componentId) {
    const points = outlineForRefText(app, componentId);
    if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
    };
}

export function createRefTextSelectionAdapter(app, componentId, id) {
    return {
        id,
        kind: 'reftext',
        object: componentId,
        get visible() {
            const placement = app.placements?.get(componentId);
            return !!placement && placement.refVisible !== false
                && isLayerVisible(placement.side === 'bottom' ? 'bottom-silk' : 'top-silk');
        },
        get locked() { return isRefTextLocked(app.placements?.get(componentId)); },
        getBounds() { return boundsForRefText(app, componentId); },
        getLockPosition(pointer, scale) {
            return lockPositionOutsideOutline(
                outlineForRefText(app, componentId),
                pointer,
                scale,
            );
        },
        hitTest(point) { return getRefTextSelectionHit(app, point) === componentId; },
        getPosition() {
            const placement = app.placements?.get(componentId);
            const box = app._refBox?.(placement);
            return placement && box ? app._refCenterWorld(placement, box) : { x: 0, y: 0 };
        },
        beginMove(worldPos) { return beginRefTextDrag(app, componentId, worldPos); },
        updateMove(worldPos) { updateRefTextDrag(app, worldPos); },
        endMove(commit) { endRefDrag(app, commit); },
        invalidate() {
            app._refreshRefHighlight?.(componentId);
            app._drawRefOverlay?.(componentId, false);
        },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('reftext', createRefTextSelectionAdapter);
