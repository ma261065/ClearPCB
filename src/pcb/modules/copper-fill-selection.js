import { createBoardShapeSelectionAdapter } from './board-shapes.js';
import { fillEditProfile } from './copper-fill-edit.js';
import { isCopperFillLocked, isCopperFillVisible, isLayerLocked } from './layers.js';
import { registerPcbSelectionAdapter } from './selection-registry.js';

export function createCopperFillSelectionAdapter(app, fill, id) {
    return createBoardShapeSelectionAdapter(app, fill, id, fillEditProfile());
}

/** Hit-test a world point against any pour region outline. */
export function hitTestFill(app, worldPos) {
    if (!app.copperFills) return null;
    // Topmost (last drawn) first.
    for (let i = app.copperFills.length - 1; i >= 0; i--) {
        const fill = app.copperFills[i];
        if (fill.visible === false || fill.locked) continue;
        if (isLayerLocked(fill.layer)) continue;
        if (isCopperFillLocked(fill.layer) || !isCopperFillVisible(fill.layer)) continue;
        // Only the outline edge (and its vertex nodes) selects a pour —
        // clicking the flooded interior must not, or every board click
        // would grab the fill.
        if (fill.distanceToEdge(worldPos.x, worldPos.y) < 0.6) {
            return fill;
        }
    }
    return null;
}

registerPcbSelectionAdapter('fill', createCopperFillSelectionAdapter);
