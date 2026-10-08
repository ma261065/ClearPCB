/** Segment refinement and live movement for schematic line/rect/polygon shapes. */
import { snapShapeTranslation, renderShapeAlignment } from './shape-snap.js';
import { pathSegmentConstraints } from '../../shapes/path-snap.js';
import { captureShapeState } from './selection.js';
import { getShapeSegmentFocus, setShapeSegmentFocus } from './shape-focus.js';
import { getDidSchematicDrag, setDidSchematicDrag } from './draw-states.js';
import { getSchematicDrag, setSchematicDrag } from './drag.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../shapes/polyline.js').Polyline} Polyline */
/** @typedef {{x: number, y: number}} Point */

/**
 * @param {SchematicEditor} app
 * @param {import('../../core/SchematicDocument.js').SchematicShape|null|undefined} shape
 * @param {Point} worldPos
 * @param {boolean} allowSegment
 * @param {number} tolerance
 * @returns {boolean}
 */
export function tryBeginPolylineSegmentDrag(app, shape, worldPos, allowSegment, tolerance) {
    if (!allowSegment || shape?.type !== 'polyline'
        || app.selection.getSelection().length !== 1) return false;
    const polyline = /** @type {Polyline} */ (shape);
    const edgeId = polyline.hitTestEdge(worldPos, tolerance);
    if (!edgeId) return false;
    const selectedSegment = getShapeSegmentFocus(app);
    if (selectedSegment?.shapeId === polyline.id && selectedSegment.edgeId !== edgeId) return false;
    setShapeSegmentFocus(app, { shapeId: polyline.id, edgeId });
    app.updateShapeSelectionTip?.();
    setSchematicDrag(app, {
        mode: 'segment',
        shape: polyline,
        edgeId,
        beforeState: captureShapeState(app, polyline),
        startWorldPos: { ...worldPos },
    });
    app.interactionState = 'segmentDrag';
    return true;
}

/**
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @returns {boolean}
 */
export function updatePolylineSegmentDrag(app, worldPos) {
    const drag = getSchematicDrag(app);
    const shape = drag?.shape;
    const edgeId = drag?.edgeId;
    const originalEdge = drag?.beforeState?.edges?.[edgeId];
    const first = originalEdge ? drag.beforeState.nodes?.[originalEdge.from] : null;
    const second = originalEdge ? drag.beforeState.nodes?.[originalEdge.to] : null;
    if (!shape || shape.type !== 'polyline' || !first || !second) return false;
    const nodeIds = [originalEdge.from, originalEdge.to];
    const path = shape.toEditablePath();
    const segment = path ? Object.values(path.edgeIds).indexOf(edgeId) : -1;
    const constraints = path ? pathSegmentConstraints(
        Object.values(path.nodeIds).map(id => drag.beforeState.nodes[id]), shape.closed,
        segment, path.segmentBulges).map(constraint => ({ ...constraint,
            index: nodeIds.indexOf(path.nodeIds[(segment + constraint.index) % path.points.length]),
        }))
        : nodeIds.map((nodeId, index) => ({ index,
        neighbours: Object.entries(drag.beforeState.edges).filter(([id, edge]) => id !== edgeId
            && (edge.from === nodeId || edge.to === nodeId)).map(([, edge]) =>
            drag.beforeState.nodes[edge.from === nodeId ? edge.to : edge.from]),
        continuations: [],
    }));
    const delta = snapShapeTranslation(app, [first, second], {
        x: worldPos.x - drag.startWorldPos.x, y: worldPos.y - drag.startWorldPos.y,
    }, [], constraints);
    const dx = delta.x;
    const dy = delta.y;
    const firstNode = shape.nodes.get(originalEdge.from);
    const secondNode = shape.nodes.get(originalEdge.to);
    if (!firstNode || !secondNode) return false;
    firstNode.x = first.x + dx;
    firstNode.y = first.y + dy;
    secondNode.x = second.x + dx;
    secondNode.y = second.y + dy;
    shape.isRect = shape.isAxisAlignedRect();
    shape.invalidate();
    renderShapeAlignment(app, shape, nodeIds, [edgeId]);
    setDidSchematicDrag(app, dx !== 0 || dy !== 0);
    return getDidSchematicDrag(app);
}