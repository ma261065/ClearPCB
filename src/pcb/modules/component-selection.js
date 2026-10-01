import { registerPcbSelectionAdapter, getComponentSelectionHits } from './selection-registry.js';
import { lockPositionOutsideOutline } from './selection-anchors.js';
import { rotationHandleAnchor, pointerRotation } from './rotation-handle.js';
import { previewPlacementPose, restorePlacementPosePreview, finishPlacementPreview, RotatePlacementCommand } from './track-commands.js';

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
    if (!placement?.bounds) {
        const pads = (placement?.padOffsets || []).flatMap(off => {
            const pos = placement.pads?.get(off.padId);
            if (!pos) return [];
            const halfWidth = (off.width || 1.2) / 2 + 0.5;
            const halfHeight = (off.height || 1.2) / 2 + 0.5;
            return [{ x: pos.x - halfWidth, y: pos.y - halfHeight },
                { x: pos.x + halfWidth, y: pos.y + halfHeight }];
        });
        if (pads.length) return {
            minX: Math.min(...pads.map(point => point.x)),
            minY: Math.min(...pads.map(point => point.y)),
            maxX: Math.max(...pads.map(point => point.x)),
            maxY: Math.max(...pads.map(point => point.y)),
        };
    }
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
    let rotationDrag = null;
    return {
        id,
        kind: 'component',
        object: componentId,
        get visible() { return app.placements?.has(componentId); },
        get locked() { return !!app.placements?.get(componentId)?.locked; },
        getBounds() { return boundsForPlacement(app.placements?.get(componentId)); },
        getAnchors() {
            const placement = app.placements?.get(componentId);
            return placement ? [rotationHandleAnchor(boundsForPlacement(placement), app.viewport?.scale)] : [];
        },
        getLockPosition(pointer, scale) {
            return lockPositionOutsideOutline(
                outlineForPlacement(app.placements?.get(componentId)),
                pointer,
                scale,
            );
        },
        hitTest(point) { return getComponentSelectionHits(app, point).has(componentId); },
        getPosition() {
            const placement = app.placements?.get(componentId);
            return { x: placement?.x || 0, y: placement?.y || 0 };
        },
        beginMove(worldPos) { return app._beginComponentDrag(componentId, worldPos); },
        updateMove(worldPos) { app._updateComponentDrag(worldPos); },
        endMove(commit) { app._endDrag(commit); },
        beginAnchorDrag(anchorId, worldPos) {
            const placement = app.placements?.get(componentId);
            if (anchorId !== 'rotate' || !placement || placement.locked) return false;
            rotationDrag = {
                center: { x: placement.x, y: placement.y }, start: { ...worldPos },
                rotation: placement.rotation || 0, nets: app._netsForComponent?.(componentId),
            };
            app._rotationHandleDrag = true;
            app._hoverComponent?.(null);
            app._hideNetTooltip?.();
            return true;
        },
        updateAnchorDrag(worldPos) {
            const placement = app.placements?.get(componentId);
            if (!rotationDrag || !placement || placement.locked) return;
            // Footprint transforms use SVG's clockwise-positive angles.
            const rotation = pointerRotation(rotationDrag.center, rotationDrag.start, worldPos, rotationDrag.rotation, true);
            if ((placement.rotation || 0) === rotation) return;
            previewPlacementPose(app, componentId, { rotation });
            app._updateRatsnest?.({ nets: rotationDrag.nets, skipFillRefresh: true });
        },
        endAnchorDrag(commit) {
            if (!rotationDrag) return;
            const placement = app.placements?.get(componentId);
            const before = rotationDrag.rotation;
            rotationDrag = null;
            app._rotationHandleDrag = false;
            if (!placement) {
                finishPlacementPreview(app);
                return;
            }
            const after = placement.rotation || 0;
            if (commit && !placement.locked && after !== before) {
                // Seed automatic-placement history from the original pose, without repainting it.
                placement.rotation = before;
                finishPlacementPreview(app, () => app.history.execute(new RotatePlacementCommand(app, componentId, before, after)));
            } else if (after !== before) {
                placement.rotation = before;
                restorePlacementPosePreview(app);
                app._updateRatsnest?.();
            } else if (finishPlacementPreview(app)) {
                app._updateRatsnest?.();
            }
        },
        invalidate() { app._updatePcbCulling?.(); },
        render() { this.invalidate(); },
    };
}

registerPcbSelectionAdapter('component', createComponentSelectionAdapter);
