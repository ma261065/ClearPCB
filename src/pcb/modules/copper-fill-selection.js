import { isCopperFillLocked, isCopperFillVisible, isLayerLocked, isLayerVisible } from './layers.js';
import { renderCopperFill } from './copper-fill-render.js';
import { isPcbSelected, registerPcbSelectionAdapter } from './selection-registry.js';

export function createCopperFillSelectionAdapter(app, fill, id) {
    return {
        id,
        kind: 'fill',
        object: fill,
        get visible() {
            return fill.visible !== false && !fill.locked
                && !isLayerLocked(fill.layer) && isLayerVisible(fill.layer)
                && !isCopperFillLocked(fill.layer) && isCopperFillVisible(fill.layer);
        },
        getBounds() { return fill.getBounds() || { minX: 0, minY: 0, maxX: 0, maxY: 0 }; },
        hitTest(point, tolerance) {
            return fill.distanceToEdge(point.x, point.y) <= Math.max(0.6, tolerance);
        },
        getPosition() {
            const bounds = fill.getBounds();
            return bounds ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : { x: 0, y: 0 };
        },
        getAnchors() {
            return fill.outline.map((point, index) => ({ id: String(index), x: point.x, y: point.y }));
        },
        beginAnchorDrag(_anchorId, worldPos) { return app._startFillDrag(fill, worldPos); },
        updateAnchorDrag(worldPos) { app._handleFillDrag(worldPos); },
        endAnchorDrag(commit) { app._endFillDrag(commit); },
        beginMove(worldPos) { return app._startFillDrag(fill, worldPos); },
        updateMove(worldPos) { app._handleFillDrag(worldPos); },
        endMove(commit) { app._endFillDrag(commit); },
        invalidate() {
            renderCopperFill(fill, (layerId) => app._getLayerGroup(layerId), {
                selected: isPcbSelected(app, 'fill', fill),
            });
        },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('fill', createCopperFillSelectionAdapter);