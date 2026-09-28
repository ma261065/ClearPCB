import { registerPcbSelectionAdapter, getRefTextSelectionHit } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';

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
        return app._placementLocalToWorld(
            placement,
            box.cx + offsetX * cos - offsetY * sin + dx,
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
        get visible() { return app.placements?.get(componentId)?.refVisible !== false; },
        get locked() { return !!app.placements?.get(componentId)?.locked; },
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
        beginMove(worldPos) { return app._beginRefTextDrag(componentId, worldPos); },
        updateMove(worldPos) { app._updateRefTextDrag(worldPos); },
        endMove(commit) { if (commit) app._endRefDrag(); },
        invalidate() {
            app._refreshRefHighlight?.(componentId);
            app._drawRefOverlay?.(componentId, false);
        },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('reftext', createRefTextSelectionAdapter);
