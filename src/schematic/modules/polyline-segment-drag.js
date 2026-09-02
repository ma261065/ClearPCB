/** Segment refinement and live movement for schematic line/rect/polygon shapes. */

export function tryBeginPolylineSegmentDrag(app, shape, worldPos, allowSegment, tolerance) {
    if (!allowSegment || shape?.type !== 'polyline'
        || app.selection.getSelection().length !== 1) return false;
    const edgeId = shape.hitTestEdge(worldPos, tolerance);
    if (!edgeId) return false;
    const selectedSegment = app._selectedShapeSegment;
    if (selectedSegment?.shapeId === shape.id && selectedSegment.edgeId !== edgeId) return false;
    app._selectedShapeSegment = { shapeId: shape.id, edgeId };
    app._updateShapeSelectionTip?.();
    app.drag = {
        mode: 'segment',
        shape,
        edgeId,
        beforeState: app._captureShapeState(shape),
        startWorldPos: { ...worldPos },
    };
    app.interactionState = 'segmentDrag';
    return true;
}

export function updatePolylineSegmentDrag(app, worldPos) {
    const shape = app.drag?.shape;
    const edgeId = app.drag?.edgeId;
    const originalEdge = app.drag?.beforeState?.edges?.[edgeId];
    const first = originalEdge ? app.drag.beforeState.nodes?.[originalEdge.from] : null;
    const second = originalEdge ? app.drag.beforeState.nodes?.[originalEdge.to] : null;
    if (!shape || shape.type !== 'polyline' || !first || !second) return false;
    const target = app.viewport.getSnappedPosition({
        x: first.x + worldPos.x - app.drag.startWorldPos.x,
        y: first.y + worldPos.y - app.drag.startWorldPos.y,
    });
    const dx = target.x - first.x;
    const dy = target.y - first.y;
    const firstNode = shape.nodes.get(originalEdge.from);
    const secondNode = shape.nodes.get(originalEdge.to);
    if (!firstNode || !secondNode) return false;
    firstNode.x = first.x + dx;
    firstNode.y = first.y + dy;
    secondNode.x = second.x + dx;
    secondNode.y = second.y + dy;
    if (shape.isRect && (dx !== 0 || dy !== 0) && !shape.isAxisAlignedRect()) shape.isRect = false;
    shape.invalidate();
    app.didDrag = dx !== 0 || dy !== 0;
    return app.didDrag;
}