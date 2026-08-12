import { registerPcbSelectionAdapter } from './selection-registry.js';

function boundsForPlacement(placement) {
    const bounds = placement?.bounds;
    if (!bounds) return { minX: placement?.x || 0, minY: placement?.y || 0, maxX: placement?.x || 0, maxY: placement?.y || 0 };
    const points = [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        { x: bounds.x, y: bounds.y + bounds.height },
    ].map((point) => appLocalToWorld(placement, point));
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
        getBounds() { return boundsForPlacement(app.placements?.get(componentId)); },
        hitTest(point) { return app._hitTestComponent(point) === componentId; },
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
