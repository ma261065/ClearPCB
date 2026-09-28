import { registerPcbSelectionAdapter, getComponentSelectionHit } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';

function outlineForPlacement(placement) {
    const bounds = placement?.bounds;
    if (!bounds) return [{ x: placement?.x || 0, y: placement?.y || 0 }];
    return [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        { x: bounds.x, y: bounds.y + bounds.height },
    ].map((point) => appLocalToWorld(placement, point));
}

function boundsForPlacement(placement) {
    const points = outlineForPlacement(placement);
    return {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
    };
}

function appLocalToWorld(placement, point) {
    const rad = (Number(placement.rotation) || 0) * Math.PI / 180;
    const mirror = (!!placement.mirror) !== (placement.side === 'bottom') ? -1 : 1;
    const x = point.x * mirror;
    return {
        x: placement.x + x * Math.cos(rad) - point.y * Math.sin(rad),
        y: placement.y + x * Math.sin(rad) + point.y * Math.cos(rad),
    };
}

export function createComponentSelectionAdapter(app, componentId, id) {
    return {
        id,
        kind: 'component',
        object: componentId,
        get visible() { return app.placements?.has(componentId); },
        get locked() { return !!app.placements?.get(componentId)?.locked; },
        getBounds() { return boundsForPlacement(app.placements?.get(componentId)); },
        getLockPosition(pointer, scale) {
            return lockPositionOutsideOutline(
                outlineForPlacement(app.placements?.get(componentId)),
                pointer,
                scale,
            );
        },
        hitTest(point) { return getComponentSelectionHit(app, point) === componentId; },
        getPosition() {
            const placement = app.placements?.get(componentId);
            return { x: placement?.x || 0, y: placement?.y || 0 };
        },
        beginMove(worldPos) { return app._beginComponentDrag(componentId, worldPos); },
        updateMove(worldPos) { app._updateComponentDrag(worldPos); },
        endMove(commit) { if (commit) app._endDrag(); },
        invalidate() { app._updatePcbCulling?.(); },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('component', createComponentSelectionAdapter);
