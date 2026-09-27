import {
    isCopperFillLocked,
    isCopperFillVisible,
    isLayerLocked,
    unlockPcbCopperFill,
    unlockPcbLayer,
} from './layers.js';
import { renderCopperFill } from './copper-fill-render.js';
import { isPcbSelected, registerPcbSelectionAdapter } from './selection-registry.js';
import { getBoardShapeAnchors } from './board-shapes.js';
import { beginFillEdit, updateFillEdit, endFillEdit, fillSegmentAt, fillEditFocus, fillEditPath } from './copper-fill-edit.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { pathMoveInteraction } from './path-edit.js';

export function createCopperFillSelectionAdapter(app, fill, id) {
    return {
        id,
        kind: 'fill',
        object: fill,
        get visible() {
            return fill.visible !== false && isCopperFillVisible(fill.layer);
        },
        get locked() {
            return !!fill.locked || isLayerLocked(fill.layer) || isCopperFillLocked(fill.layer);
        },
        unlock() {
            if (fill.locked) fill.locked = false;
            if (isLayerLocked(fill.layer)) unlockPcbLayer(app, fill.layer);
            if (isCopperFillLocked(fill.layer)) unlockPcbCopperFill(app, fill.layer);
            this.invalidate();
        },
        getLockPosition(pointer, scale) {
            return lockPositionOutsideOutline(fill.getOutline(), pointer, scale);
        },
        getBounds() { return fill.getBounds() || { minX: 0, minY: 0, maxX: 0, maxY: 0 }; },
        hitTest(point, tolerance) {
            return fill.distanceToEdge(point.x, point.y) <= Math.max(0.6, tolerance)
                || (isPcbSelected(app, 'fill', fill) && fillSegmentAt(fill, point, tolerance) != null);
        },
        getPosition() {
            const bounds = fill.getBounds();
            return bounds ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : { x: 0, y: 0 };
        },
        getAnchors() {
            return getBoardShapeAnchors(fill).map(anchor => ({ ...anchor,
                selected: anchor.id === fillEditFocus(app, fill).node }));
        },
        getEditPath() { return fillEditPath(app, fill); },
        anchorColor: '#3399ff',
        beginAnchorDrag(anchorId, worldPos) { return beginFillEdit(app, fill, worldPos, anchorId); },
        updateAnchorDrag(worldPos) { updateFillEdit(app, worldPos); },
        endAnchorDrag(commit) {
            endFillEdit(app, commit);
        },
        ...pathMoveInteraction({
            segmentAt: point => fillSegmentAt(fill, point, 8 / Math.max(0.01, app.viewport?.scale || 1)),
            selectedSegment: () => fillEditFocus(app, fill).segment ?? null,
            selectSegment: segment => {
                app._fillEdit = { fillId: fill.id, segment };
                app._refreshFillProperties?.(fill);
            },
            begin: (point, segment) => beginFillEdit(app, fill, point, null, segment),
            update: point => updateFillEdit(app, point),
            end: commit => endFillEdit(app, commit),
        }),
        invalidate() {
            renderCopperFill(fill, (layerId) => app._getLayerGroup(layerId), {
                selected: isPcbSelected(app, 'fill', fill),
            });
        },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('fill', createCopperFillSelectionAdapter);