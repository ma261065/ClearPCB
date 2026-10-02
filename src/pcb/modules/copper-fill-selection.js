import {
    isCopperFillLocked,
    isCopperFillVisible,
    isLayerLocked,
    unlockPcbCopperFill,
    unlockPcbLayer,
} from './layers.js';
import { renderCopperFill } from './copper-fill-render.js';
import { boundsWithPathNodes, isPcbSelected, registerPcbSelectionAdapter } from './selection-registry.js';
import { getBoardShapeAnchors } from './board-shapes.js';
import { beginFillEdit, updateFillEdit, endFillEdit, fillSegmentAt, fillEditFocus, fillEditPath } from './copper-fill-edit.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { pathMoveInteraction } from './path-edit.js';

export function createCopperFillSelectionAdapter(app, fill, id) {
    if (app._fillDrag?.fill === fill) fill = app._fillDrag.original;
    const current = () => app._fillDrag?.original === fill ? app._fillDrag.fill : fill;
    return {
        id,
        kind: 'fill',
        get object() { return current(); },
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
            return lockPositionOutsideOutline(current().getOutline(), pointer, scale);
        },
        getBounds() { return current().getBounds() || { minX: 0, minY: 0, maxX: 0, maxY: 0 }; },
        getHitBounds() {
            const fill = current();
            const bounds = this.getBounds();
            return isPcbSelected(app, 'fill', fill) ? boundsWithPathNodes(bounds, fill.outline) : bounds;
        },
        hitTest(point, tolerance) {
            const fill = current();
            return fill.distanceToEdge(point.x, point.y) <= Math.max(0.6, tolerance)
                || (isPcbSelected(app, 'fill', fill) && fillSegmentAt(fill, point, tolerance) != null);
        },
        getPosition() {
            const bounds = current().getBounds();
            return bounds ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } : { x: 0, y: 0 };
        },
        getAnchors() {
            const target = current();
            return getBoardShapeAnchors(target).map(anchor => ({ ...anchor,
                selected: anchor.id === fillEditFocus(app, target).node }));
        },
        getEditPath() { return fillEditPath(app, current()); },
        anchorColor: '#3399ff',
        beginAnchorDrag(anchorId, worldPos) { return beginFillEdit(app, fill, worldPos, anchorId); },
        updateAnchorDrag(worldPos) { updateFillEdit(app, worldPos); },
        endAnchorDrag(commit) {
            endFillEdit(app, commit);
        },
        ...pathMoveInteraction({
            segmentAt: point => fillSegmentAt(current(), point, 8 / Math.max(0.01, app.viewport?.scale || 1)),
            selectedSegment: () => fillEditFocus(app, current()).segment ?? null,
            selectSegment: segment => {
                app._fillEdit = { fillId: fill.id, segment };
                app._refreshFillProperties?.(fill);
            },
            begin: (point, segment) => beginFillEdit(app, fill, point, null, segment),
            update: point => updateFillEdit(app, point),
            end: commit => endFillEdit(app, commit),
        }),
        invalidate() {
            renderCopperFill(current(), (layerId) => app.getLayerGroup(layerId), {
                selected: isPcbSelected(app, 'fill', fill),
                outlineOnly: app._fillDrag?.original === fill && app._fillDrag.fill !== fill,
            });
        },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('fill', createCopperFillSelectionAdapter);