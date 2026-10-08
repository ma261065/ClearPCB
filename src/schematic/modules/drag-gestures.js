/**
 * Starting and running schematic drags: anchor (node) drags, wire-segment drags, moving a
 * selection, box selection and a press that becomes a drag once it moves far enough, with
 * the wire and junction updates each drag carries along. drag.js owns the drag slot and
 * commits or cancels the gesture.
 */
import { errorHasName } from '../../core/errors.js';
import { updateSnapHighlight, COLLINEAR_EPSILON, VERTEX_EPSILON } from './wire.js';
import { resolveWireSnapPosition, SNAP_SCREEN_PX, PIN_SNAP_TOL } from './wire-snap.js';
import { computeAnchorCollinearSnap, computeStickyWireSnaps, buildCollinearChain, bridgeCollinearPinEndpoints } from './wire-drag-snap.js';
import { cancelDragGesture, clearDragState, clearPendingAnchorDrag, commitMoveDrag, commitSegmentDrag, getPendingAnchorDrag, getSchematicDrag, resolveAnchorDragOnMouseUp, revertSegmentDragIfNoMove, setPendingAnchorDrag, setSchematicDrag, commitShapeJoin } from './drag.js';
import { ModifyShapeCommand } from './commands.js';
import { collapseRedundantWirePoints } from './wire-reconcile.js';
import { isJoinable } from '../../shapes/shape-join.js';
import { createBoxSelectElement } from '../../shared/ui/box-selection.js';
import { applyShapeState, captureShapeState } from './selection.js';
import { isSchematicLocked } from '../../shapes/lock-owner.js';
import { hasSchematicTextEdit } from './text-edit.js';
import { DRAG_THRESHOLD_PX, getDidSchematicDrag, resolveState, STATE_TABLE } from './draw-states.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicShape} SchematicShape */
/** @typedef {SchematicShape} ShapeModel */
/** @typedef {SchematicShape} WireShape */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {ReturnType<SchematicShape['captureState']>} ShapeState */
/** @typedef {import('./draw-states.js').InteractionState} InteractionState */
/** @typedef {Record<string, any>} Guide */
/** @typedef {{shape: SchematicShape, anchorId: string, screenPos: Point, snapped: Point, preInsertState?: ShapeState}} PendingAnchorDragParams */
/** @typedef {{shape: SchematicShape, anchorId: string, startSnapped: Point, screenPos: Point, preInsertState?: ShapeState}} AnchorDragSessionParams */
/** @typedef {{shape: WireShape, dragEdgeId: string, worldPos: Point, beforeState: ShapeState}} SegmentDragSessionParams */
/** @typedef {{edge: {from: string, to: string}, edgeId?: string, otherNode: string, otherPos?: Point, isPinToPin?: boolean}} IncidentEntry */
/** @typedef {{wire: WireShape, nodeId: string, edge: {from: string, to: string}, pinPos: Point, axis: 'x'|'y', sign: number, isPinToPin?: boolean}} StaggerEntry */

/**
 * Reusable buffers for drag updates, per editor, so pointer moves allocate nothing.
 * @type {WeakMap<SchematicEditor, {propagateNonSelectedWires: SchematicShape[], segmentDragGuides: Guide[], moveDragSnappedTarget: Point}>}
 */
const dragScratch = new WeakMap();

/** @param {SchematicEditor} app */
function scratchFor(app) {
    let scratch = dragScratch.get(app);
    if (!scratch) dragScratch.set(app, scratch = { propagateNonSelectedWires: [], segmentDragGuides: [], moveDragSnappedTarget: { x: 0, y: 0 } });
    return scratch;
}

/** @param {SchematicEditor} app */
function getPropagateNonSelectedWiresScratch(app) {
    const scratch = scratchFor(app).propagateNonSelectedWires;
    scratch.length = 0;
    return scratch;
}

/** @param {SchematicEditor} app */
function getSegmentDragGuidesScratch(app) {
    const scratch = scratchFor(app).segmentDragGuides;
    scratch.length = 0;
    return scratch;
}

/** @param {SchematicEditor} app */
export function getMoveDragSnappedTarget(app) {
    return scratchFor(app).moveDragSnappedTarget;
}

/**
 * The selected items a move drag carries: locked ones stay where they are.
 * @param {SchematicEditor} app
 * @returns {SchematicShape[]}
 */
export function movableSelection(app) {
    return app.selection.getSelection().filter(item => !isSchematicLocked(item));
}

/**
 * Start moving the unlocked part of the selection from a press at `worldPos`.
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {Point} snapped
 */
export function beginSelectionMove(app, worldPos, snapped) {
    const movable = movableSelection(app);
    const dragObjectStartPos = movable[0] ? movable[0].getPosition() : { ...snapped };
    beginMoveDragSession(app, worldPos, dragObjectStartPos);
    // Bridge pin-connected wire nodes ONCE so pins can move freely
    bridgeStickyPinNodes(app, collectMovingComponentIds(movable));
    app.viewport.svg.style.cursor = 'move';
    app.renderShapes();
}

/**
 * @param {SchematicShape[]} selection
 * @returns {Set<string>}
 */
export function collectMovingComponentIds(selection) {
    const movingCompIds = new Set();
    for (const shape of selection) {
        if (shape.definition) movingCompIds.add(shape.id);
        if (shape.type === 'wire') movingCompIds.add(shape.id);
        if (shape.type === 'net') movingCompIds.add(shape.id);
    }
    return movingCompIds;
}

/**
 * @param {SchematicEditor} app
 * @param {string} key
 * @returns {Set<any>}
 */
function getReusableSet(app, key) {
    let byKey = reusableSets.get(app);
    if (!byKey) {
        byKey = new Map();
        reusableSets.set(app, byKey);
    }
    let scratch = byKey.get(key);
    if (!scratch) { scratch = new Set(); byKey.set(key, scratch); }
    else scratch.clear();
    return scratch;
}

/**
 * @param {SchematicEditor} app
 * @param {string} key
 * @returns {Point}
 */
export function getReusablePoint(app, key) {
    let byKey = reusablePoints.get(app);
    if (!byKey) {
        byKey = new Map();
        reusablePoints.set(app, byKey);
    }
    let point = byKey.get(key);
    if (!point) { point = { x: 0, y: 0 }; byKey.set(key, point); }
    return point;
}

/**
 * @param {WireShape} wire
 * @param {string} dragEdgeId
 * @param {Set<string>} [reuseSet]
 * @returns {Set<string>}
 */
function getDraggedSegmentEndpointNodeIds(wire, dragEdgeId, reuseSet) {
    const movedNodes = reuseSet || new Set();
    if (reuseSet) movedNodes.clear();
    const edgeNow = wire.edges.get(dragEdgeId);
    if (edgeNow) { movedNodes.add(edgeNow.from); movedNodes.add(edgeNow.to); }
    return movedNodes;
}

/**
 * @param {SchematicShape} shape
 * @param {string} anchorId
 * @returns {boolean}
 */
export function canQueueMidpointAnchorDrag(shape, anchorId) {
    if (!anchorId?.startsWith('mid')) return false;
    return shape.type === 'line' || shape.type === 'polygon' || shape.type === 'wire';
}

/**
 * @param {SchematicEditor} app
 * @param {PendingAnchorDragParams} params
 */
export function queuePendingAnchorDrag(app, params) {
    const { shape, anchorId, screenPos, snapped, preInsertState } = params;
    const pending = /** @type {PendingAnchorDragParams} */ ({ shape, anchorId, screenPos: { ...screenPos }, snapped: { ...snapped } });
    if (preInsertState) pending.preInsertState = preInsertState;
    setPendingAnchorDrag(app, pending);
}

/**
 * @param {SchematicEditor} app
 * @param {{refreshTextEdit?: boolean}} [options]
 */
function finalizeDragInteraction(app, options = {}) {
    // UI cleanup (was previously inside clearDragState)
    updateSnapHighlight(app, null);
    app.hideCrosshair();
    app.removeBoxSelectElement();

    clearDragState(app);
    app.renderShapes(true);
    if (options.refreshTextEdit && hasSchematicTextEdit(app)) app.updateTextEditOverlay();
}

// ─── Drag session setup ────────────────────────────────────────────

/**
 * @param {SchematicEditor} app
 * @param {AnchorDragSessionParams} params
 */
function beginAnchorDragSession(app, params) {
    const { shape, anchorId, startSnapped, screenPos, preInsertState } = params;
    setSchematicDrag(app, {
        mode: 'anchor',
        shape,
        beforeState: preInsertState || captureShapeState(app, /** @type {ShapeModel} */ (shape)),
        start: { ...startSnapped },
        startScreen: { ...screenPos },
        anchorId,
        wireAnchorOriginal: null,
        tjLinks: [],
        wireStates: new Map(),
        excludePin: null,
        ncLinks: [],
        junctionBeforeWireStates: null,
        junctionBeforeLabelTextStates: null
    });
    app.interactionState = 'anchorDrag';
}

/**
 * @param {SchematicEditor} app
 * @param {SegmentDragSessionParams} params
 */
function beginWireSegmentDragSession(app, params) {
    const { shape, dragEdgeId, worldPos, beforeState } = params;
    const wireStates = new Map();
    wireStates.set(shape, beforeState);
    setSchematicDrag(app, {
        mode: 'segment',
        shape,
        edgeId: dragEdgeId,
        axis: null,
        wireStates,
        workingState: null,
        tjLinks: [],
        ncLinks: [],
        labelBefore: null,
        startWorldPos: { ...worldPos },
        totalDx: 0,
        totalDy: 0
    });
    app.interactionState = 'segmentDrag';
}

/**
 * @param {Point} pinPos
 * @param {IncidentEntry[]} incidentEntries
 * @returns {boolean}
 */
function hasStraightThroughIncidentPair(pinPos, incidentEntries) {
    for (let i = 0; i < incidentEntries.length; i++) {
        const aPos = incidentEntries[i]?.otherPos;
        if (!aPos) continue;
        const ax = aPos.x - pinPos.x;
        const ay = aPos.y - pinPos.y;
        const aLen = Math.hypot(ax, ay);
        if (aLen < COLLINEAR_EPSILON) continue;

        for (let j = i + 1; j < incidentEntries.length; j++) {
            const bPos = incidentEntries[j]?.otherPos;
            if (!bPos) continue;
            const bx = bPos.x - pinPos.x;
            const by = bPos.y - pinPos.y;
            const bLen = Math.hypot(bx, by);
            if (bLen < COLLINEAR_EPSILON) continue;

            const cross = Math.abs(ax * by - ay * bx);
            const parallelTol = Math.max(COLLINEAR_EPSILON, 0.01 * aLen * bLen);
            if (cross > parallelTol) continue;

            const dot = ax * bx + ay * by;
            if (dot < 0) return true;
        }
    }
    return false;
}

/**
 * @param {SchematicEditor} app
 * @param {Set<string>} movingCompIds
 */
function bridgeStickyPinNodes(app, movingCompIds) {
    if (movingCompIds.size === 0) return;
    const staggerStep = app.viewport?.gridVisible ? (app.viewport.gridSize || 2.54) : 2.54;
    /** @type {Map<string, StaggerEntry[]>} */
    const staggerGroups = new Map();

    /**
     * @param {string} key
     * @param {StaggerEntry} entry
     */
    const addGroupEntry = (key, entry) => {
        const group = staggerGroups.get(key);
        if (group) group.push(entry);
        else staggerGroups.set(key, [entry]);
    };

    for (const wire of app.shapes) {
        if (wire.type !== 'wire') continue;
        // Bridge component pin connections
        for (const [nodeId, conn] of wire.pinConnections) {
            if (!movingCompIds.has(conn.componentId)) continue;
            const pinPos = wire.nodes.get(nodeId);
            if (!pinPos) continue;

            const incidentEntries = [];
            for (const { edge: e, otherNode } of [...wire.incidentEdges(nodeId)]) {
                let otherIsPin = false;
                if (wire.pinConnections.has(otherNode)) {
                    const otherConn = wire.pinConnections.get(otherNode);
                    if (otherConn && movingCompIds.has(otherConn.componentId)) continue;
                    otherIsPin = true;
                }

                const otherPos = wire.nodes.get(otherNode);
                if (!otherPos) continue;
                if (Math.abs(otherPos.x - pinPos.x) < 0.01 && Math.abs(otherPos.y - pinPos.y) < 0.01) continue;

                incidentEntries.push({
                    wire,
                    nodeId,
                    edge: e,
                    pinPos,
                    otherNode,
                    otherPos,
                    isPinToPin: otherIsPin
                });
            }

            // Mid-segment pin detach: keep the through-wire on a fixed
            // junction node and add a single spur to the moving pin node.
            // This avoids creating a U-bridge when pulling away from the
            // middle of an existing segment.
            if (incidentEntries.length >= 2 && hasStraightThroughIncidentPair(pinPos, incidentEntries)) {
                const junctionId = wire.addNode(pinPos.x, pinPos.y);
                const junctionPos = wire.nodes.get(junctionId);
                if (junctionPos) junctionPos._pinDetachJunction = true;
                for (const entry of incidentEntries) {
                    if (entry.edge.from === nodeId) entry.edge.from = junctionId;
                    else if (entry.edge.to === nodeId) entry.edge.to = junctionId;
                }
                wire.addEdge(nodeId, junctionId);
                wire.invalidate();
                continue;
            }

            // Bridge each non-pin incident edge so the pin can move freely
            for (const entry of incidentEntries) {
                const { edge: e, otherPos, pinPos } = entry;
                const dx = otherPos.x - pinPos.x;
                const dy = otherPos.y - pinPos.y;
                const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
                let sign = axis === 'x' ? Math.sign(dx) : Math.sign(dy);
                if (sign === 0) sign = 1;
                const groupKey = `${conn.componentId}|${axis}|${sign}`;
                addGroupEntry(groupKey, {
                    wire,
                    nodeId: entry.nodeId,
                    edge: e,
                    pinPos,
                    axis,
                    sign,
                    isPinToPin: entry.isPinToPin
                });
            }
            wire.invalidate();
        }
    }

    for (const group of staggerGroups.values()) {
        if (group.length === 0) continue;
        group.sort((a, b) => {
            return a.axis === 'x'
                ? (a.pinPos.y - b.pinPos.y)
                : (a.pinPos.x - b.pinPos.x);
        });
        const useZeroOffset = group.length === 1 && group[0]?.isPinToPin;
        group.forEach((entry, index) => {
            const stepIndex = useZeroOffset ? 0 : (index + 1);
            const offset = entry.sign * staggerStep * stepIndex;
            const bridgeId = entry.wire.addNode(entry.pinPos.x, entry.pinPos.y);
            const bridgePos = entry.wire.nodes.get(bridgeId);
            if (bridgePos) {
                if (entry.axis === 'x') bridgePos.x += offset;
                else bridgePos.y += offset;
                bridgePos._stickyBridge = true;
                bridgePos._stickyOwnerCompId = entry.wire.pinConnections.get(entry.nodeId)?.componentId || null;
                bridgePos._staggerAxis = entry.axis;
                bridgePos._staggerOffset = offset;
            }

            const wireNeighborId = entry.edge.from === entry.nodeId ? entry.edge.to : entry.edge.from;
            const otherPos = entry.wire.nodes.get(wireNeighborId);
            const bendId = entry.wire.addNode(
                entry.axis === 'x' ? (bridgePos?.x ?? entry.pinPos.x) : (otherPos?.x ?? entry.pinPos.x),
                entry.axis === 'x' ? (otherPos?.y ?? entry.pinPos.y) : (bridgePos?.y ?? entry.pinPos.y)
            );
            const bendPos = entry.wire.nodes.get(bendId);
            if (bendPos) {
                bendPos._stickyBridgeBend = true;
                bendPos._stickyOwnerCompId = bridgePos?._stickyOwnerCompId || null;
                bendPos._staggerBend = true;
                bendPos._staggerAxis = entry.axis;
                bendPos._staggerWireNeighbor = wireNeighborId;
            }
            if (bridgePos) bridgePos._staggerBendId = bendId;
            if (entry.edge.from === entry.nodeId) entry.edge.from = bendId;
            else entry.edge.to = bendId;
            entry.wire.addEdge(bridgeId, bendId);

            entry.wire.addEdge(entry.nodeId, bridgeId);
            entry.wire.invalidate();
        });
    }
}

/**
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {Point} dragObjectStartPos
 */
function beginMoveDragSession(app, worldPos, dragObjectStartPos) {
    setSchematicDrag(app, {
        mode: 'move',
        objectStartPos: { ...dragObjectStartPos },
        lastSnapped: { ...dragObjectStartPos },
        startWorldPos: { ...worldPos },
        totalDx: 0,
        totalDy: 0
    });
    app.interactionState = 'moveDrag';
}

/**
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {boolean} additive
 */
export function beginBoxSelectSession(app, worldPos, additive) {
    setSchematicDrag(app, {
        mode: 'box',
        start: { ...worldPos },
        additive: !!additive
    });
    app.selection.captureBoxSelectBase();
    createBoxSelectElement(app, worldPos);
    app.interactionState = 'boxSelect';
}

/**
 * @param {SchematicEditor} app
 * @param {Point} screenPos
 * @param {boolean} [midpointPickup]
 * @returns {boolean}
 */
export function promotePendingAnchorDragSession(app, screenPos, midpointPickup = false) {
    const pending = getPendingAnchorDrag(app);
    if (!pending) return false;

    const dx = screenPos.x - pending.screenPos.x;
    const dy = screenPos.y - pending.screenPos.y;
    if (!midpointPickup && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return false;

    clearPendingAnchorDrag(app);
    const { shape, anchorId, snapped: startSnapped, preInsertState } = pending;

    beginAnchorDragSession(app, { shape, anchorId, startSnapped, screenPos, preInsertState });
    getSchematicDrag(app).midpointPlacement = midpointPickup;

    if (shape.getAnchorSnapMode(anchorId) === 'axis') {
        const anchor = shape.getAnchors().find(/** @param {{id: string, x: number, y: number}} a */ a => a.id === anchorId);
        if (anchor) getSchematicDrag(app).wireAnchorOriginal = { x: anchor.x, y: anchor.y };
    }

    getSchematicDrag(app).tjLinks = [];
    getSchematicDrag(app).wireStates = new Map();
    if (shape.type === 'wire' && shape.nodes.has(anchorId)) {
        const pos = shape.nodes.get(anchorId);
        for (const other of app.shapes) {
            if (other === shape || other.type !== 'wire') continue;
            const otherNid = other.nodeAt(pos, VERTEX_EPSILON);
            if (otherNid) {
                getSchematicDrag(app).tjLinks.push({ otherWire: other, otherNodeId: otherNid });
                if (!getSchematicDrag(app).wireStates.has(other))
                    getSchematicDrag(app).wireStates.set(other, captureShapeState(app, other));
            }
        }
    }

    getSchematicDrag(app).ncLinks = [];
    if (shape.type === 'wire' && shape.nodes.has(anchorId)) {
        const nodePos = shape.nodes.get(anchorId);
        for (const s of app.shapes) {
            if (s.type !== 'noconnect') continue;
            if (Math.hypot(s.x - nodePos.x, s.y - nodePos.y) < VERTEX_EPSILON)
                getSchematicDrag(app).ncLinks.push({ nc: s, before: s.captureState() });
        }
    }

    getSchematicDrag(app).excludePin = null;
    if (shape.type === 'wire' && shape.pinConnections.has(anchorId)) {
        const conn = shape.pinConnections.get(anchorId);
        const nodePos = shape.nodes.get(anchorId);
        getSchematicDrag(app).excludePin = {
            component: { id: conn.componentId },
            pin: { number: conn.pinNumber },
            worldPos: nodePos ? { x: nodePos.x, y: nodePos.y } : null
        };
    }

    app.showCrosshair();
    app.updateCrosshair(startSnapped);
    return true;
}

// ─── Drag commit helpers ───────────────────────────────────────────

/** @param {SchematicEditor} app */
export function handleDragEnd(app) {
    if (!getSchematicDrag(app)) return;
    const lastRecorded = app.history?.undoStack?.at(-1);
    try {
        commitDragGesture(app);
    } catch (error) {
        if (!errorHasName(error, 'LockedEditError')) throw error;
        // The lock gate refused the commit before anything ran (the editor already
        // showed why): restore the live preview, as Escape would.
        if (app.history?.undoStack?.at(-1) === lastRecorded) {
            cancelDragGesture(app);
            return;
        }
    }
    finalizeDragInteraction(app, { refreshTextEdit: true });
    app.interactionState = resolveState(app);
}

/** @param {SchematicEditor} app */
function commitDragGesture(app) {
    if (getDidSchematicDrag(app) && getSchematicDrag(app).mode === 'move') {
        commitMoveDrag(app, getSchematicDrag(app).totalDx, getSchematicDrag(app).totalDy);
        // Clean up redundant collinear nodes left by bridge insertion
        for (const wire of app.shapes) {
            if (wire.type === 'wire') collapseRedundantWirePoints(app, wire);
        }
    } else if (getSchematicDrag(app).mode === 'segment' && getSchematicDrag(app).shape?.type === 'polyline') {
        if (getDidSchematicDrag(app)) {
            const shape = getSchematicDrag(app).shape;
            const before = getSchematicDrag(app).beforeState;
            const after = captureShapeState(app, shape);
            applyShapeState(app, shape, before);
            app.history.execute(new ModifyShapeCommand(app, shape, before, after));
        }
    } else if (getSchematicDrag(app).mode === 'segment' && getSchematicDrag(app).wireStates) {
        if (getDidSchematicDrag(app)) commitSegmentDrag(app, getSchematicDrag(app).shape, getSchematicDrag(app).wireStates, getSchematicDrag(app).ncLinks, getSchematicDrag(app).labelBefore);
        else revertSegmentDragIfNoMove(app, getSchematicDrag(app).wireStates);
    } else if (getSchematicDrag(app).shape) {
        if (getDidSchematicDrag(app) && getSchematicDrag(app).joinTarget && isJoinable(getSchematicDrag(app).shape)) {
            commitShapeJoin(app, getSchematicDrag(app).shape, getSchematicDrag(app).anchorId, getSchematicDrag(app).joinTarget, getSchematicDrag(app).beforeState);
        } else {
            resolveAnchorDragOnMouseUp(app, getSchematicDrag(app).shape, getSchematicDrag(app).beforeState, getDidSchematicDrag(app), getSchematicDrag(app).wireStates, getSchematicDrag(app).ncLinks, getSchematicDrag(app).junctionBeforeWireStates, getSchematicDrag(app).junctionBeforeLabelTextStates);
        }
    }
}

// ─── Wire segment drag helpers ─────────────────────────────────────

/**
 * @param {SchematicEditor} app
 * @param {SchematicShape} hitShape
 * @param {Point} worldPos
 * @returns {boolean}
 */
export function tryBeginWireSegmentDrag(app, hitShape, worldPos) {
    if (!(hitShape?.type === 'wire' && app.selection.getSelection().length === 1)) return false;
    const hitWire = /** @type {WireShape} */ (hitShape);
    const dragEdgeId = hitWire.hitTestEdge(worldPos, SNAP_SCREEN_PX / app.viewport.scale);
    if (!dragEdgeId) return false;

    beginWireSegmentDragSession(app, {
        shape: hitWire, dragEdgeId, worldPos,
        beforeState: captureShapeState(app, hitWire)
    });

    const preBridgeEdgeCount = hitWire.edges.size;
    {
        const edge_ = hitWire.edges.get(dragEdgeId);
        if (hitWire.pinConnections.has(edge_.from)) {
            const pinPos = hitWire.nodes.get(edge_.from);
            const newId = hitWire.addNode(pinPos.x, pinPos.y);
            hitWire.addEdge(edge_.from, newId);
            edge_.from = newId;
        }
        const edge2_ = hitWire.edges.get(dragEdgeId);
        if (edge2_ && hitWire.pinConnections.has(edge2_.to)) {
            const pinPos = hitWire.nodes.get(edge2_.to);
            const newId = hitWire.addNode(pinPos.x, pinPos.y);
            hitWire.addEdge(edge2_.to, newId);
            edge2_.to = newId;
        }
    }
    {
        const edgeLock = hitWire.edges.get(dragEdgeId);
        if (preBridgeEdgeCount > 1 && edgeLock) {
            const pA = hitWire.nodes.get(edgeLock.from), pB = hitWire.nodes.get(edgeLock.to);
            const sDx = Math.abs(pB.x - pA.x), sDy = Math.abs(pB.y - pA.y);
            if (sDy < COLLINEAR_EPSILON && sDx > COLLINEAR_EPSILON) getSchematicDrag(app).axis = 'vertical';
            else if (sDx < COLLINEAR_EPSILON && sDy > COLLINEAR_EPSILON) getSchematicDrag(app).axis = 'horizontal';
            else getSchematicDrag(app).axis = null;
        } else {
            getSchematicDrag(app).axis = null;
        }
    }

    // Bridge pin-connected nodes reachable through the collinear chain
    {
        // hitWire is a graph wire, whose captureState owns the nodes/edges shape.
        const chainState = /** @type {import('./wire-drag-snap.js').WireGraphState} */ (captureShapeState(app, hitWire));
        const chain = buildCollinearChain(hitWire, dragEdgeId, chainState);
        bridgeCollinearPinEndpoints(hitWire, chain);
    }

    getSchematicDrag(app).workingState = captureShapeState(app, hitWire);
    getSchematicDrag(app).tjLinks = [];
    for (const [nid, pos] of hitWire.nodes) {
        for (const other of app.shapes) {
            if (other === hitWire || other.type !== 'wire') continue;
            const otherNid = other.nodeAt(pos, VERTEX_EPSILON);
            if (otherNid) {
                getSchematicDrag(app).tjLinks.push({ wireNodeId: nid, otherWire: other, otherNodeId: otherNid });
                if (!getSchematicDrag(app).wireStates.has(other))
                    getSchematicDrag(app).wireStates.set(other, captureShapeState(app, other));
            }
        }
    }
    getSchematicDrag(app).ncLinks = [];
    for (const [nid, pos] of hitWire.nodes) {
        for (const shape of app.shapes) {
            if (shape.type !== 'noconnect') continue;
            if (Math.hypot(shape.x - pos.x, shape.y - pos.y) < VERTEX_EPSILON)
                getSchematicDrag(app).ncLinks.push({ wireNodeId: nid, nc: shape, before: shape.captureState() });
        }
    }
    getSchematicDrag(app).labelBefore = hitWire.labelText
        ? captureShapeState(app, hitWire.labelText) : null;
    app.viewport.svg.style.cursor = 'move';
    return true;
}

// ─── Per-state move-drag helpers ───────────────────────────────────

/**
 * @param {SchematicEditor} app
 * @param {SchematicShape[]} selection
 * @param {number} dx
 * @param {number} dy
 */
export function propagateMovedWireJunctions(app, selection, dx, dy) {
    let hasMovedWire = false;
    for (const shape of selection) { if (shape.type === 'wire') { hasMovedWire = true; break; } }
    if (!hasMovedWire) return;

    const selectedSet = getReusableSet(app, '_propagateSelectedSetScratch');
    for (const shape of selection) selectedSet.add(shape);
    const nonSelectedWires = getPropagateNonSelectedWiresScratch(app);
    for (const shape of app.shapes) {
        if (shape.type !== 'wire' || selectedSet.has(shape)) continue;
        nonSelectedWires.push(shape);
    }
    for (const movedWire of selection) {
        if (movedWire.type !== 'wire') continue;
        for (const pos of movedWire.nodes.values()) {
            const prevX = pos.x - dx, prevY = pos.y - dy;
            for (const shape of nonSelectedWires) {
                for (const shapePos of shape.nodes.values()) {
                    if (Math.abs(shapePos.x - prevX) < VERTEX_EPSILON && Math.abs(shapePos.y - prevY) < VERTEX_EPSILON) {
                        shapePos.x += dx; shapePos.y += dy; shape.invalidate();
                    }
                }
            }
        }
    }
}

/**
 * @param {SchematicEditor} app
 * @param {Point} targetPos
 * @param {SchematicShape[]} selection
 * @param {Set<string>} movingCompIds
 * @param {Point} snappedTargetOut
 * @returns {Guide[]|undefined}
 */
export function resolveMoveDragTarget(app, targetPos, selection, movingCompIds, snappedTargetOut) {
    const snappedTarget = app.viewport.getSnappedPosition(targetPos);
    snappedTargetOut.x = snappedTarget.x;
    snappedTargetOut.y = snappedTarget.y;

    const soloNoConnect = selection.length === 1 && selection[0].type === 'noconnect' ? selection[0] : null;
    if (soloNoConnect) {
        const snap = resolveWireSnapPosition(app, targetPos, { pinTolerance: PIN_SNAP_TOL });
        snappedTargetOut.x = snap.x; snappedTargetOut.y = snap.y;
        updateSnapHighlight(app, snap);
    }

    let stickyGuides;
    if (movingCompIds.size > 0) {
        const proposedDx = snappedTargetOut.x - getSchematicDrag(app).lastSnapped.x;
        const proposedDy = snappedTargetOut.y - getSchematicDrag(app).lastSnapped.y;
        const stickySnap = computeStickyWireSnaps(app, movingCompIds, proposedDx, proposedDy);
        snappedTargetOut.x += stickySnap.adjustX;
        snappedTargetOut.y += stickySnap.adjustY;
        stickyGuides = stickySnap.guides;
    }
    return stickyGuides;
}

// ─── Per-state anchor-drag helpers ─────────────────────────────────

/**
 * @param {SchematicEditor} app
 * @param {Point} anchorPos
 * @param {Guide[]} anchorGuides
 * @returns {Point}
 */
export function mergeAnchorTJunctionGuides(app, anchorPos, anchorGuides) {
    if (!(getSchematicDrag(app).tjLinks && getSchematicDrag(app).tjLinks.length > 0)) return anchorPos;
    let mergedAnchorPos = anchorPos;
    for (const link of getSchematicDrag(app).tjLinks) {
        const tjResult = computeAnchorCollinearSnap(app, link.otherWire, link.otherNodeId, mergedAnchorPos);
        if (tjResult.anchorPos.x !== mergedAnchorPos.x || tjResult.anchorPos.y !== mergedAnchorPos.y)
            mergedAnchorPos = tjResult.anchorPos;
        if (tjResult.guides.length > 0) anchorGuides.push(...tjResult.guides);
    }
    return mergedAnchorPos;
}

/**
 * @param {SchematicEditor} app
 * @param {Point} anchorPos
 */
export function syncAnchorDragLinkedNodes(app, anchorPos) {
    if (getSchematicDrag(app).tjLinks) {
        for (const link of getSchematicDrag(app).tjLinks) {
            const p = link.otherWire.nodes.get(link.otherNodeId);
            if (p) { p.x = anchorPos.x; p.y = anchorPos.y; link.otherWire.invalidate(); }
        }
    }
    if (getSchematicDrag(app).ncLinks) {
        for (const link of getSchematicDrag(app).ncLinks) {
            link.nc.x = anchorPos.x; link.nc.y = anchorPos.y; link.nc.invalidate();
        }
    }
}

// ─── Per-state segment-drag helpers ────────────────────────────────

/**
 * @param {SchematicEditor} app
 * @returns {Set<any>}
 */
export function getDragTJunctionWireSet(app) {
    const wires = getReusableSet(app, '_dragTJunctionWireSetScratch');
    if (getSchematicDrag(app).tjLinks) {
        for (const link of getSchematicDrag(app).tjLinks) wires.add(link.otherWire);
    }
    return wires;
}

/**
 * @param {SchematicEditor} app
 * @param {WireShape} wire
 * @param {string} dragEdgeId
 * @param {Point} snappedTarget
 * @param {Guide[]} baseGuides
 * @returns {Guide[]}
 */
export function collectWireSegmentDragGuides(app, wire, dragEdgeId, snappedTarget, baseGuides) {
    const allGuides = getSegmentDragGuidesScratch(app);
    if (baseGuides && baseGuides.length > 0) allGuides.push(...baseGuides);
    if (!getSchematicDrag(app).tjLinks) return allGuides;
    const edge = wire.edges.get(dragEdgeId);
    if (!edge) return allGuides;
    const fromPos = wire.nodes.get(edge.from);
    if (!fromPos) return allGuides;
    for (const link of getSchematicDrag(app).tjLinks) {
        if (link.wireNodeId !== edge.from && link.wireNodeId !== edge.to) continue;
        const ow = link.otherWire;
        const otherPos = ow.nodes.get(link.otherNodeId);
        if (!otherPos) continue;
        const tjPos = { x: otherPos.x + (snappedTarget.x - fromPos.x), y: otherPos.y + (snappedTarget.y - fromPos.y) };
        const tjResult = computeAnchorCollinearSnap(app, ow, link.otherNodeId, tjPos);
        if (tjResult.guides.length > 0) allGuides.push(...tjResult.guides);
    }
    return allGuides;
}

/**
 * @param {SchematicEditor} app
 * @param {WireShape} wire
 * @param {string} dragEdgeId
 * @param {import('./wire-drag-snap.js').WireGraphState} origState
 * @param {number} dx
 * @param {number} dy
 * @returns {Set<string>|null}
 */
export function applyWireSegmentNodeMovement(app, wire, dragEdgeId, origState, dx, dy) {
    const edge = wire.edges.get(dragEdgeId);
    if (!edge) return null;
    const nodesToMove = buildCollinearChain(wire, dragEdgeId, origState);
    for (const nid of nodesToMove) {
        if (wire.pinConnections.has(nid)) continue;
        const p = wire.nodes.get(nid);
        if (p) { p.x += dx; p.y += dy; }
    }
    wire.invalidate();
    return getDraggedSegmentEndpointNodeIds(wire, dragEdgeId, getReusableSet(app, '_dragSegmentMovedNodesScratch'));
}

/**
 * @param {SchematicEditor} app
 * @param {Set<string>|null} movedNodes
 * @param {number} dx
 * @param {number} dy
 */
export function propagateWireSegmentLinkedMovement(app, movedNodes, dx, dy) {
    if (!movedNodes) return;
    if (getSchematicDrag(app).tjLinks) {
        for (const link of getSchematicDrag(app).tjLinks) {
            if (!movedNodes.has(link.wireNodeId)) continue;
            const sp = link.otherWire.nodes.get(link.otherNodeId);
            if (sp) { sp.x += dx; sp.y += dy; link.otherWire.invalidate(); }
        }
    }
    if (getSchematicDrag(app).ncLinks) {
        for (const link of getSchematicDrag(app).ncLinks) {
            if (!movedNodes.has(link.wireNodeId)) continue;
            link.nc.x += dx; link.nc.y += dy; link.nc.invalidate();
        }
    }
}

/**
 * @param {WireShape} wire
 * @param {number} dx
 * @param {number} dy
 */
export function applyWireSegmentLabelMovement(wire, dx, dy) {
    if (!wire.labelText) return;
    wire.labelText.x += dx; wire.labelText.y += dy; wire.labelText.invalidate();
}
/** @type {WeakMap<SchematicEditor, Map<string, Set<any>>>} */
const reusableSets = new WeakMap();
/** @type {WeakMap<SchematicEditor, Map<string, Point>>} */
const reusablePoints = new WeakMap();
