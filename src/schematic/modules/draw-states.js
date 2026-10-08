/**
 * Mouse interaction state handlers.
 *
 * Each state is an object with optional event handler methods:
 *   mousedown(app, event, positions)
 *   mousemove(app, event, positions)
 *   mouseup(app, event, positions)
 *   click(app, event, positions)
 *   dblclick(app, event, positions)
 *   contextmenu(app, event, positions)
 *
 * positions = { screenPos, worldPos, snapped }
 *
 * Handlers set app.interactionState = 'newState' to change state.
 * The dispatcher in mouse.js calls getEventPositions() once per
 * event and routes to the current state's handler.
 */

import { updateStickyWires, updateSnapHighlight, resolveWireSnapPosition, computeAnchorCollinearSnap, computeSegmentDragSnap, computeStickyWireSnaps, applyOffGridNeighborSnap, buildCollinearChain, bridgeCollinearPinEndpoints, SNAP_SCREEN_PX, COLLINEAR_EPSILON, VERTEX_EPSILON, PIN_SNAP_TOL } from './wire.js';
import { renderGuideLines } from '../../shapes/axis-glow.js';
import {
    cancelDragGesture, clearDragState, clearPendingAnchorDrag, commitMoveDrag, commitSegmentDrag, getPendingAnchorDrag,
    getSchematicDrag, resolveAnchorDragOnMouseUp, revertSegmentDragIfNoMove, setPendingAnchorDrag,
    setSchematicDrag, commitShapeJoin, captureMoveDragStates
} from './drag.js';
import { detectTJunction, showAnchorContextMenu, showSegmentContextMenu, showLabelContextMenu, showComponentContextMenu } from './context-menu.js';
import { hasAny3DModel } from '../../components/model3d-source.js';
import { ModifyShapeCommand } from './commands.js';
import { collapseRedundantWirePoints } from './wire.js';
import { attachLabelToTarget, refreshLabelAttachmentOffset, getLabelDropHotspot } from './label-attachment.js';
import { findJoinTarget, isJoinable } from '../../shapes/shape-join.js';
import { tryBeginPolylineSegmentDrag, updatePolylineSegmentDrag } from './polyline-segment-drag.js';
import { refreshComponentPose, removeShapeSegmentSelectionElement } from './schematic-view.js';
import { snapShapePoint, snapShapeBulge, renderShapeAlignment, shapeContinuationConstraints } from './shape-snap.js';
import { refinePathSegment } from '../../shapes/path-interaction.js';
import { isCulled } from './schematic-view.js';
import { findInlineEditableHit, isUnmodifiedPrimaryDoublePress } from '../../shared/ui/inline-edit-activation.js';
import { createBoxSelectElement, getBoxSelectBounds, updateBoxSelectElement } from '../../shared/ui/box-selection.js';
import { confirmPaste, updatePastePreview } from './clipboard.js';
import { findComponentAt, getPlacingComponent, isComponentCodeTooltipPinned, isPlacingComponent, pinComponentCodeTooltip, placeComponent, updateComponentPreview } from './components.js';
import { applyShapeState, captureShapeState } from './selection.js';
import { getShapeSegmentFocus, setShapeNodeFocus, setShapeSegmentFocus } from './shape-focus.js';
import { isSchematicLocked } from '../../shapes/lock-owner.js';
import {
    finishSchematicDrawAtPointer, finishSchematicDrawInPlace, moveSchematicTool, pressSchematicTool,
    pressSchematicToolDrawing, releaseSchematicTool,
} from './schematic-tools.js';
import { getSchematicTextEdit, hasSchematicTextEdit } from './text-edit.js';
import { isPastingClipboard } from './clipboard.js';
import { isSchematicDrawingActive } from './drawing.js';
import { getSchematicInteraction, setSchematicInteraction } from './schematic-interactions.js';
// ─── Constants ─────────────────────────────────────────────────────

const DRAG_THRESHOLD_PX = 3;
const drawStates = new WeakMap();

function stateFor(app) {
    let state = drawStates.get(app);
    if (!state) {
        state = {
            drawSnapResult: null,
            pendingShapeSegmentToggle: null,
            propagateNonSelectedWiresScratch: [],
            segmentDragGuidesScratch: [],
            moveDragSnappedTarget: { x: 0, y: 0 },
            didDrag: false,
            skipClickSelection: false,
        };
        drawStates.set(app, state);
    }
    return state;
}

export function setDrawSnapResult(app, result) {
    stateFor(app).drawSnapResult = result;
}

export function takeDrawSnapResult(app) {
    const state = stateFor(app);
    const result = state.drawSnapResult;
    state.drawSnapResult = null;
    return result;
}

export function clearOverlapCyclePress(app) {
    setSchematicInteraction(app, 'overlapCyclePress', null);
}

export function getOverlapCyclePress(app) {
    return getSchematicInteraction(app, 'overlapCyclePress');
}

export function hasOverlapCyclePress(app) {
    return !!getOverlapCyclePress(app);
}

export function setOverlapCyclePress(app, press) {
    setSchematicInteraction(app, 'overlapCyclePress', press);
}

export function cancelOverlapCyclePress(app) {
    if (app.interactionState !== 'overlapCycle') return false;
    clearOverlapCyclePress(app);
    app.interactionState = 'idle';
    setSkipClickSelection(app, true);
    return true;
}

/** @param {object} app */
export function getDidSchematicDrag(app) {
    return !!stateFor(app).didDrag;
}

/**
 * @param {object} app
 * @param {boolean} value
 */
export function setDidSchematicDrag(app, value) {
    stateFor(app).didDrag = !!value;
}

/** @param {object} app */
export function getSkipClickSelection(app) {
    return !!stateFor(app).skipClickSelection;
}

/**
 * @param {object} app
 * @param {boolean} value
 */
export function setSkipClickSelection(app, value) {
    stateFor(app).skipClickSelection = !!value;
}

export function clearPendingShapeSegmentToggle(app) {
    stateFor(app).pendingShapeSegmentToggle = null;
}

export function hasPendingShapeSegmentToggle(app) {
    return !!stateFor(app).pendingShapeSegmentToggle;
}

export function getPendingShapeSegmentToggle(app) {
    return stateFor(app).pendingShapeSegmentToggle;
}

export function setPendingShapeSegmentToggle(app, toggle) {
    stateFor(app).pendingShapeSegmentToggle = toggle;
}

function getPropagateNonSelectedWiresScratch(app) {
    const scratch = stateFor(app).propagateNonSelectedWiresScratch;
    scratch.length = 0;
    return scratch;
}

function getSegmentDragGuidesScratch(app) {
    const scratch = stateFor(app).segmentDragGuidesScratch;
    scratch.length = 0;
    return scratch;
}

function getMoveDragSnappedTarget(app) {
    return stateFor(app).moveDragSnappedTarget;
}

// ─── State transition ──────────────────────────────────────────────

/**
 * Determine current state from legacy app flags.
 * Used as initialization and safety-net fallback.
 * @param {object} app
 * @returns {string}
 */
export function resolveState(app) {
    if (isPastingClipboard(app)) return 'placing';
    if (getPlacingComponent(app)) return 'placing';
    if (getSchematicDrag(app)) {
        switch (getSchematicDrag(app).mode) {
            case 'anchor': return 'anchorDrag';
            case 'segment': return 'segmentDrag';
            case 'move': return 'moveDrag';
            case 'box': return 'boxSelect';
        }
    }
    if (isSchematicDrawingActive(app)) return 'drawing';
    if (app.currentTool !== 'select') return 'toolActive';
    return 'idle';
}

// ─── Shared helpers ────────────────────────────────────────────────

export function getEventPositions(e, viewport) {
    const rect = viewport._getCachedRect();
    const screenPos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    };
    const worldPos = viewport.screenToWorld(screenPos);
    viewport.shiftHeld = e.shiftKey;
    const snapped = viewport.getSnappedPosition(worldPos);
    return { screenPos, worldPos, snapped };
}

function isAdditiveSelectionModifier(event) {
    return !!(event?.ctrlKey || event?.metaKey);
}

function activateHomeTabIfFileTabOpen(app) {
    const ribbonEl = document.getElementById('ribbonSchematic');
    const activeTab = ribbonEl?.querySelector('.ribbon-tab.active') || document.querySelector('.ribbon-tab.active');
    if (activeTab instanceof HTMLElement && activeTab.dataset?.tab === 'file') {
        app.setActiveRibbonTab?.('home');
    }
}

function selectOnlyShapeAndRender(app, shape) {
    app.selection.clearSelection();
    app.selection.select(shape, false);
    app.renderShapes(true);
}

function selectContextTargetShape(app, shape) {
    if (!app.selection.isSelected(shape)) {
        selectOnlyShapeAndRender(app, shape);
    }
    app.selection.keepSelected(shape);
}

/** The selected items a move drag carries: locked ones stay where they are. */
function movableSelection(app) {
    return app.selection.getSelection().filter(item => !isSchematicLocked(item));
}

/** Start moving the unlocked part of the selection from a press at `worldPos`. */
function beginSelectionMove(app, worldPos, snapped) {
    const movable = movableSelection(app);
    const dragObjectStartPos = movable[0] ? movable[0].getPosition() : { ...snapped };
    beginMoveDragSession(app, worldPos, dragObjectStartPos);
    // Bridge pin-connected wire nodes ONCE so pins can move freely
    bridgeStickyPinNodes(app, collectMovingComponentIds(movable));
    app.viewport.svg.style.cursor = 'move';
    app.renderShapes();
}

function collectMovingComponentIds(selection) {
    const movingCompIds = new Set();
    for (const shape of selection) {
        if (shape.definition) movingCompIds.add(shape.id);
        if (shape.type === 'wire') movingCompIds.add(shape.id);
        if (shape.type === 'net') movingCompIds.add(shape.id);
    }
    return movingCompIds;
}

function getReusableSet(app, key) {
    let scratch = app[key];
    if (!scratch) { scratch = new Set(); app[key] = scratch; }
    else scratch.clear();
    return scratch;
}

function getReusablePoint(app, key) {
    let point = app[key];
    if (!point) { point = { x: 0, y: 0 }; app[key] = point; }
    return point;
}

function getDraggedSegmentEndpointNodeIds(wire, dragEdgeId, reuseSet) {
    const movedNodes = reuseSet || new Set();
    if (reuseSet) movedNodes.clear();
    const edgeNow = wire.edges.get(dragEdgeId);
    if (edgeNow) { movedNodes.add(edgeNow.from); movedNodes.add(edgeNow.to); }
    return movedNodes;
}

export function updateToolCrosshair(app, snapped, screenPos) {
    app.showCrosshair();
    app.updateCrosshair(snapped, screenPos);
}

export function resolvePinSnapPlacement(app, worldPos, options = {}) {
    const resolved = resolveWireSnapPosition(app, worldPos, {
        pinTolerance: PIN_SNAP_TOL,
        ...options
    });
    return { resolved, pos: { x: resolved.x, y: resolved.y } };
}

function getPinIdentityKey(pin) {
    return pin?._key || pin?._id || pin?.number || null;
}

function getPinWorldWithTransform(pin, baseX, baseY, rotationDeg, mirror) {
    const lx = Number(pin?.x) || 0;
    const ly = Number(pin?.y) || 0;
    const mx = mirror ? -lx : lx;
    const rad = (rotationDeg || 0) * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        x: baseX + (mx * cos - ly * sin),
        y: baseY + (mx * sin + ly * cos)
    };
}

function resolvePlacingComponentSnap(app, placePos) {
    const def = getPlacingComponent(app);
    if (!def?.symbol?.pins?.length) return { placePos, pinSnap: null };

    const rotation = app.componentRotation || 0;
    const mirror = !!app.componentMirror;
    let best = null;

    for (const pin of def.symbol.pins) {
        const pinWorld = getPinWorldWithTransform(pin, placePos.x, placePos.y, rotation, mirror);
        const { resolved } = resolvePinSnapPlacement(app, pinWorld);
        if (!resolved || resolved.snapType === 'grid') continue;
        const d = Math.hypot(resolved.x - pinWorld.x, resolved.y - pinWorld.y);
        if (!best || d < best.distance) {
            best = { pinWorld, resolved, distance: d };
        }
    }

    if (!best) return { placePos, pinSnap: null };

    return {
        placePos: {
            x: placePos.x + (best.resolved.x - best.pinWorld.x),
            y: placePos.y + (best.resolved.y - best.pinWorld.y)
        },
        pinSnap: best.resolved
    };
}

function resolveDraggingComponentSnap(app, comp, snappedTarget, lastSnapped) {
    const pins = comp.symbol?.pins || [];
    if (pins.length === 0) return { targetPos: snappedTarget, pinSnap: null };

    const SNAP_LOCK_ENGAGE_DISTANCE = 0.55;
    const SNAP_LOCK_RELEASE_DISTANCE = 0.9;

    const previewDx = snappedTarget.x - lastSnapped.x;
    const previewDy = snappedTarget.y - lastSnapped.y;
    const projectedX = comp.x + previewDx;
    const projectedY = comp.y + previewDy;

    if (!getSchematicDrag(app)._componentSnapState || getSchematicDrag(app)._componentSnapState.componentId !== comp.id) {
        getSchematicDrag(app)._componentSnapState = {
            componentId: comp.id,
            lockedPinKey: null,
            lastResult: null
        };
    }
    const snapState = getSchematicDrag(app)._componentSnapState;

    const evaluatePin = (pin) => {
        const pinWorld = getPinWorldWithTransform(pin, projectedX, projectedY, comp.rotation || 0, !!comp.mirror);
        const { resolved } = resolvePinSnapPlacement(app, pinWorld, {
            excludePin: {
                component: comp,
                pin,
                pinKey: getPinIdentityKey(pin)
            }
        });
        if (!resolved || resolved.snapType === 'grid') return null;
        const distance = Math.hypot(resolved.x - pinWorld.x, resolved.y - pinWorld.y);
        return { pin, pinWorld, resolved, distance };
    };

    const makeResult = (candidate) => {
        if (!candidate) return { targetPos: snappedTarget, pinSnap: null };
        return {
            targetPos: {
                x: snappedTarget.x + (candidate.resolved.x - candidate.pinWorld.x),
                y: snappedTarget.y + (candidate.resolved.y - candidate.pinWorld.y)
            },
            pinSnap: candidate.resolved
        };
    };

    // Keep a stable snap owner while it remains valid to prevent yellow-dot flicker.
    if (snapState.lockedPinKey) {
        const lockedPin = pins.find(pin => getPinIdentityKey(pin) === snapState.lockedPinKey) || null;
        if (lockedPin) {
            const lockedCandidate = evaluatePin(lockedPin);
            if (lockedCandidate && lockedCandidate.distance <= SNAP_LOCK_RELEASE_DISTANCE) {
                const lockedResult = makeResult(lockedCandidate);
                snapState.lastResult = lockedResult;
                return lockedResult;
            }
        }
        snapState.lockedPinKey = null;
    }

    let best = null;
    for (const pin of pins) {
        const candidate = evaluatePin(pin);
        if (!candidate) continue;
        if (!best || candidate.distance < best.distance) best = candidate;
    }

    if (!best) {
        const empty = { targetPos: snappedTarget, pinSnap: null };
        snapState.lastResult = empty;
        return empty;
    }

    // Avoid snap/no-snap chatter at boundary distances while dragging slowly.
    if (best.distance > SNAP_LOCK_ENGAGE_DISTANCE) {
        const empty = { targetPos: snappedTarget, pinSnap: null };
        snapState.lastResult = empty;
        return empty;
    }

    snapState.lockedPinKey = getPinIdentityKey(best.pin);
    const result = makeResult(best);
    snapState.lastResult = result;
    return result;
}

function handleComponentTooltipContextMenu(app, worldPos, screenPos) {
    if (app.showComponentDebugTooltip === false) return;
    const hitComponent = findComponentAt(app, worldPos);
    if (hitComponent) pinComponentCodeTooltip(app, hitComponent, screenPos);
    else app.updateComponentCodeTooltip?.(null, null, { forceHide: true });
}

function handleComponentTooltipMouseMove(app, worldPos, screenPos) {
    const canShow = app.showComponentDebugTooltip !== false
        && !getSchematicDrag(app) && !app.viewport.isPanning
        && !getPlacingComponent(app) && !isComponentCodeTooltipPinned(app);
    if (canShow) {
        const hit = findComponentAt(app, worldPos);
        app.updateComponentCodeTooltip?.(hit, screenPos);
        return;
    }
    if (!isComponentCodeTooltipPinned(app)) {
        app.updateComponentCodeTooltip?.(null, screenPos);
    }
}

function canQueueMidpointAnchorDrag(shape, anchorId) {
    if (!anchorId?.startsWith('mid')) return false;
    return shape.type === 'line' || shape.type === 'polygon' || shape.type === 'wire';
}

function queuePendingAnchorDrag(app, params) {
    const { shape, anchorId, screenPos, snapped, preInsertState } = params;
    const pending = { shape, anchorId, screenPos: { ...screenPos }, snapped: { ...snapped } };
    if (preInsertState) pending.preInsertState = preInsertState;
    setPendingAnchorDrag(app, pending);
}

function finalizeDragInteraction(app, options = {}) {
    // UI cleanup (was previously inside clearDragState)
    updateSnapHighlight(app, null);
    app.hideCrosshair();
    app.removeBoxSelectElement();

    clearDragState(app);
    app.renderShapes(true);
    if (options.refreshTextEdit && hasSchematicTextEdit(app)) app.updateTextEditOverlay?.();
}

// ─── Drag session setup ────────────────────────────────────────────

function beginAnchorDragSession(app, params) {
    const { shape, anchorId, startSnapped, screenPos, preInsertState } = params;
    setSchematicDrag(app, {
        mode: 'anchor',
        shape,
        beforeState: preInsertState || captureShapeState(app, shape),
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

function bridgeStickyPinNodes(app, movingCompIds) {
    if (movingCompIds.size === 0) return;
    const staggerStep = app.viewport?.gridVisible ? (app.viewport.gridSize || 2.54) : 2.54;
    const staggerGroups = new Map();

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

function beginBoxSelectSession(app, worldPos, additive) {
    setSchematicDrag(app, {
        mode: 'box',
        start: { ...worldPos },
        additive: !!additive
    });
    app.selection.captureBoxSelectBase();
    createBoxSelectElement(app, worldPos);
    app.interactionState = 'boxSelect';
}

function promotePendingAnchorDragSession(app, screenPos, midpointPickup = false) {
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
        const anchor = shape.getAnchors().find(a => a.id === anchorId);
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

function handleDragEnd(app) {
    if (!getSchematicDrag(app)) return;
    const lastRecorded = app.history?.undoStack?.at(-1);
    try {
        commitDragGesture(app);
    } catch (error) {
        if (error?.name !== 'LockedEditError') throw error;
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

// ─── Context menu helpers ──────────────────────────────────────────

function handleAnchorContextMenu(app, worldPos, clientX, clientY) {
    const selectedShapes = app.selection.getSelection();
    for (const shape of selectedShapes) {
        if (isSchematicLocked(shape)) continue;
        const anchorId = shape.hitTestAnchor(worldPos, app.viewport.scale);
        if (anchorId && !anchorId.startsWith('mid')) {
            let canDeletePoint = false;
            if (shape.nodes && shape.edges) {
                // Graph-based shape (wire, line, polygon, rect)
                canDeletePoint = shape.nodes.has(anchorId) && (shape.type === 'polyline' || shape.edges.size > 1);
            }
            const junctionInfo = shape.type === 'wire' ? detectTJunction(app, shape, anchorId) : null;
            const canDisconnectPin = shape.type === 'wire' && shape.pinConnections?.has(anchorId);
            if (junctionInfo && shape.type === 'wire') canDeletePoint = false;
            if (canDeletePoint || junctionInfo || canDisconnectPin) {
                showAnchorContextMenu(app, shape, anchorId, clientX, clientY, canDeletePoint, junctionInfo);
                return true;
            }
        }
    }

    // Also check unselected wires for anchor context menus
    const anchorTol = Math.max(0.5, 3 / app.viewport.scale);
    for (const wire of app.shapes) {
        if (wire.type !== 'wire' || wire.locked) continue;
        const nid = wire.nodeAt(worldPos, anchorTol);
        if (!nid) continue;

        const junctionInfo = detectTJunction(app, wire, nid);
        let canDeletePoint = wire.nodes.has(nid) && wire.edges.size > 1;
        const canDisconnectPin = wire.pinConnections.has(nid);
        if (junctionInfo) canDeletePoint = false;

        if (canDeletePoint || junctionInfo || canDisconnectPin) {
            selectContextTargetShape(app, wire);
            showAnchorContextMenu(app, wire, nid, clientX, clientY, canDeletePoint, junctionInfo);
            return true;
        }
    }
    return false;
}

function handleSegmentContextMenu(app, worldPos, clientX, clientY) {
    const segTolerance = SNAP_SCREEN_PX / app.viewport.scale;
    for (const shape of app.shapes) {
        if (!shape.locked && shape.type === 'arc' && shape.hitTest(worldPos, segTolerance)) {
            selectContextTargetShape(app, shape);
            showSegmentContextMenu(app, shape, null, clientX, clientY);
            return true;
        }
        if (shape.locked || !shape.hitTestEdge) continue;
        const edgeId = shape.hitTestEdge(worldPos, segTolerance);
        if (!edgeId) continue;
        selectContextTargetShape(app, shape);
        showSegmentContextMenu(app, shape, edgeId, clientX, clientY);
        return true;
    }
    return false;
}

function handleSelectContextMenu(app, worldPos, clientX, clientY) {
    const hit = app.selection.hitTest(worldPos);
    if (hit?.type === 'text' && hit.fieldKey === 'label') {
        selectContextTargetShape(app, hit);
        showLabelContextMenu(app, hit, clientX, clientY);
        return true;
    }
    if (handleAnchorContextMenu(app, worldPos, clientX, clientY)) return true;
    if (handleSegmentContextMenu(app, worldPos, clientX, clientY)) return true;
    return handleComponentContextMenu(app, worldPos, clientX, clientY);
}

/**
 * Show the component context menu ("Show 3D") when the right-click lands on a
 * placed component that carries a 3D OBJ model. Returns false otherwise so the
 * caller falls through to the debug-tooltip behaviour.
 */
function handleComponentContextMenu(app, worldPos, clientX, clientY) {
    const comp = findComponentAt(app, worldPos);
    if (!hasAny3DModel(comp?.definition)) return false;
    showComponentContextMenu(app, comp, clientX, clientY);
    return true;
}

export function resolveLabelAttachTarget(app, probePos, excludeShape = null) {
    // Also exclude the label's current parent so the snap dot doesn't show for it
    const excludeParent = excludeShape?.parentComponent || null;

    const hitComponent = findComponentAt(app, probePos);
    if (hitComponent && hitComponent !== excludeShape && hitComponent !== excludeParent) {
        return {
            target: hitComponent,
            snapPos: { x: probePos.x, y: probePos.y }
        };
    }

    const wireTolerance = SNAP_SCREEN_PX / app.viewport.scale;
    for (let i = app.shapes.length - 1; i >= 0; i--) {
        const shape = app.shapes[i];
        if (!shape || shape === excludeShape || shape === excludeParent || shape.type !== 'wire' || isCulled(shape) || !shape.visible) continue;
        const edgeId = shape.hitTestEdge?.(probePos, wireTolerance);
        if (!edgeId) continue;
        const nearest = shape.closestEdge?.(probePos);
        return {
            target: shape,
            snapPos: nearest?.point ? { x: nearest.point.x, y: nearest.point.y } : { x: probePos.x, y: probePos.y }
        };
    }

    const hits = app.selection.hitTest(probePos, true);
    const hit = Array.isArray(hits)
        ? hits.find(s => s && s !== excludeShape && s !== excludeParent && s.type !== 'text')
        : null;
    if (!hit) return null;

    if (hit.type === 'wire' && typeof hit.closestEdge === 'function') {
        const nearest = hit.closestEdge(probePos);
        if (nearest?.point) {
            return {
                target: hit,
                snapPos: { x: nearest.point.x, y: nearest.point.y }
            };
        }
    }

    return {
        target: hit,
        snapPos: { x: probePos.x, y: probePos.y }
    };
}

// ─── Wire segment drag helpers ─────────────────────────────────────

function tryBeginWireSegmentDrag(app, hitShape, worldPos) {
    if (!(hitShape?.type === 'wire' && app.selection.getSelection().length === 1)) return false;
    const dragEdgeId = hitShape.hitTestEdge(worldPos, SNAP_SCREEN_PX / app.viewport.scale);
    if (!dragEdgeId) return false;

    beginWireSegmentDragSession(app, {
        shape: hitShape, dragEdgeId, worldPos,
        beforeState: captureShapeState(app, hitShape)
    });

    const preBridgeEdgeCount = hitShape.edges.size;
    {
        const edge_ = hitShape.edges.get(dragEdgeId);
        if (hitShape.pinConnections.has(edge_.from)) {
            const pinPos = hitShape.nodes.get(edge_.from);
            const newId = hitShape.addNode(pinPos.x, pinPos.y);
            hitShape.addEdge(edge_.from, newId);
            edge_.from = newId;
        }
        const edge2_ = hitShape.edges.get(dragEdgeId);
        if (edge2_ && hitShape.pinConnections.has(edge2_.to)) {
            const pinPos = hitShape.nodes.get(edge2_.to);
            const newId = hitShape.addNode(pinPos.x, pinPos.y);
            hitShape.addEdge(edge2_.to, newId);
            edge2_.to = newId;
        }
    }
    {
        const edgeLock = hitShape.edges.get(dragEdgeId);
        if (preBridgeEdgeCount > 1 && edgeLock) {
            const pA = hitShape.nodes.get(edgeLock.from), pB = hitShape.nodes.get(edgeLock.to);
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
        const chainState = captureShapeState(app, hitShape);
        const chain = buildCollinearChain(hitShape, dragEdgeId, chainState);
        bridgeCollinearPinEndpoints(hitShape, chain);
    }

    getSchematicDrag(app).workingState = captureShapeState(app, hitShape);
    getSchematicDrag(app).tjLinks = [];
    for (const [nid, pos] of hitShape.nodes) {
        for (const other of app.shapes) {
            if (other === hitShape || other.type !== 'wire') continue;
            const otherNid = other.nodeAt(pos, VERTEX_EPSILON);
            if (otherNid) {
                getSchematicDrag(app).tjLinks.push({ wireNodeId: nid, otherWire: other, otherNodeId: otherNid });
                if (!getSchematicDrag(app).wireStates.has(other))
                    getSchematicDrag(app).wireStates.set(other, captureShapeState(app, other));
            }
        }
    }
    getSchematicDrag(app).ncLinks = [];
    for (const [nid, pos] of hitShape.nodes) {
        for (const shape of app.shapes) {
            if (shape.type !== 'noconnect') continue;
            if (Math.hypot(shape.x - pos.x, shape.y - pos.y) < VERTEX_EPSILON)
                getSchematicDrag(app).ncLinks.push({ wireNodeId: nid, nc: shape, before: shape.captureState() });
        }
    }
    getSchematicDrag(app).labelBefore = hitShape.labelText
        ? captureShapeState(app, hitShape.labelText) : null;
    app.viewport.svg.style.cursor = 'move';
    return true;
}

// ─── Per-state move-drag helpers ───────────────────────────────────

function propagateMovedWireJunctions(app, selection, dx, dy) {
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

function resolveMoveDragTarget(app, targetPos, selection, movingCompIds, snappedTargetOut) {
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

function mergeAnchorTJunctionGuides(app, anchorPos, anchorGuides) {
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

function syncAnchorDragLinkedNodes(app, anchorPos) {
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

function getDragTJunctionWireSet(app) {
    const wires = getReusableSet(app, '_dragTJunctionWireSetScratch');
    if (getSchematicDrag(app).tjLinks) {
        for (const link of getSchematicDrag(app).tjLinks) wires.add(link.otherWire);
    }
    return wires;
}

function collectWireSegmentDragGuides(app, wire, dragEdgeId, snappedTarget, baseGuides) {
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

function applyWireSegmentNodeMovement(app, wire, dragEdgeId, origState, dx, dy) {
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

function propagateWireSegmentLinkedMovement(app, movedNodes, dx, dy) {
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

function applyWireSegmentLabelMovement(wire, dx, dy) {
    if (!wire.labelText) return;
    wire.labelText.x += dx; wire.labelText.y += dy; wire.labelText.invalidate();
}

// ════════════════════════════════════════════════════════════════════
// STATE HANDLERS
// ════════════════════════════════════════════════════════════════════

/**
 * idle — select tool, nothing active.
 */
export const overlapCycleState = {
    mousemove(app, event, positions) {
        const press = getOverlapCyclePress(app);
        if (!press || Math.hypot(positions.screenPos.x - press.positions.screenPos.x,
            positions.screenPos.y - press.positions.screenPos.y) <= DRAG_THRESHOLD_PX) return;
        clearOverlapCyclePress(app);
        app.interactionState = 'idle';
        setSkipClickSelection(app, false);
        idleState.mousedown(app, { button: 0, shiftKey: false, ctrlKey: false, metaKey: false,
            preventDefault() {} }, press.positions);
        STATE_TABLE[app.interactionState]?.mousemove?.(app, event, positions);
    },
    mouseup(app, event, positions) {
        if (event.button !== 0) return;
        overlapCycleState.mousemove(app, event, positions);
        const press = getOverlapCyclePress(app);
        if (!press) {
            STATE_TABLE[app.interactionState]?.mouseup?.(app, event, positions);
            return;
        }
        clearOverlapCyclePress(app);
        app.interactionState = 'idle';
        const hits = app.selection.hitTest(press.positions.worldPos, true);
        const selected = app.selection.getSelection();
        const index = hits.findIndex(shape => selected.includes(shape));
        const next = hits[(index + 1) % hits.length];
        if (next) {
            const keep = press.additive ? selected.filter(shape => !hits.includes(shape)) : [];
            app.selection.selectMultiple([...keep, next]);
            app.renderShapes();
        }
        setSkipClickSelection(app, true);
        event.preventDefault();
    },
};

export const idleState = {
    mousedown(app, event, { screenPos, worldPos, snapped }) {
        if (event.button !== 0) return;

        activateHomeTabIfFileTabOpen(app);

        if (!getSchematicTextEdit(app) && isUnmodifiedPrimaryDoublePress(event)) {
            const textHit = findInlineEditableHit(app.selection, worldPos, event.target);
            if (textHit) {
                app.selection.select(textHit, false);
                app.renderShapes();
                clearPendingAnchorDrag(app);
                app.startTextEdit(textHit);
                app.setTextEditCaretFromScreen(screenPos);
                event.preventDefault();
                return;
            }
        }

        setDidSchematicDrag(app, false);
        if (getPendingAnchorDrag(app) && !getSchematicDrag(app)) clearPendingAnchorDrag(app);

        if (event.shiftKey) {
            setOverlapCyclePress(app, {
                positions: { screenPos, worldPos, snapped },
                additive: isAdditiveSelectionModifier(event)
            });
            app.interactionState = 'overlapCycle';
            setSkipClickSelection(app, true);
            event.preventDefault();
            return;
        }
        if (isAdditiveSelectionModifier(event)) {
            const hit = app.selection.hitTest(worldPos);
            if (hit) {
                app.selection.toggle(hit);
                app.renderShapes();
                setSkipClickSelection(app, true);
                event.preventDefault();
                return;
            }
        }

        // Anchor drag on selected shapes
        const selectedShapes = app.selection.getSelection();
        for (const shape of selectedShapes) {
            if (isSchematicLocked(shape)) continue;
            const anchorId = shape.hitTestAnchor(worldPos, app.viewport.scale);
            if (!anchorId) continue;

            setShapeSegmentFocus(app, null);
            app.updateShapeSelectionTip?.();

            if (shape.type === 'wire' && shape.edges.size <= 1 && shape.nodes.has(anchorId)) {
                const pos = shape.nodes.get(anchorId);
                let atJunction = false;
                for (const other of app.shapes) {
                    if (other === shape || other.type !== 'wire') continue;
                    if (other.nodeAt(pos, VERTEX_EPSILON)) { atJunction = true; break; }
                }
                if (atJunction) break;
            }

            if (canQueueMidpointAnchorDrag(shape, anchorId)) {
                const beforeState = captureShapeState(app, shape);
                const newAnchorId = shape.moveAnchor(anchorId, snapped.x, snapped.y);
                app.renderShapes();
                app.viewport.svg.style.cursor = 'move';
                queuePendingAnchorDrag(app, { shape, anchorId: newAnchorId || anchorId, screenPos, snapped, preInsertState: beforeState });
            } else {
                queuePendingAnchorDrag(app, { shape, anchorId, screenPos, snapped });
            }
            event.preventDefault();
            return;
        }

        // Hit test for shape selection/drag
        let hitShape = app.selection.hitTest(worldPos);

        if (hitShape) {
            const wasSelected = app.selection.isSelected(hitShape);
            const segmentTolerance = SNAP_SCREEN_PX / app.viewport.scale;
            const hitSegmentEdgeId = hitShape.type === 'polyline'
                ? hitShape.hitTestEdge(worldPos, segmentTolerance)
                : null;
            if (!wasSelected) {
                app.selection.select(hitShape, false);
                app.renderShapes();
                // The "+" insertion handles only appear once the shape is
                // selected. If this selecting click happened to land on one,
                // don't arm a move/segment drag — just select and show the
                // insert affordance. A deliberate second click on the "+"
                // starts the split (matches the PCB track behaviour).
                const justSelectedAnchor = hitShape.hitTestAnchor?.(worldPos, app.viewport.scale);
                if (justSelectedAnchor && String(justSelectedAnchor).startsWith('mid')
                    && canQueueMidpointAnchorDrag(hitShape, justSelectedAnchor)) {
                    app.viewport.svg.style.cursor = 'copy';
                    event.preventDefault();
                    return;
                }
            }

            // A locked object never moves itself, but grabbing a locked member of a
            // selection moves the unlocked rest, as in the PCB editor.
            if (isSchematicLocked(hitShape)) {
                if (wasSelected && movableSelection(app).length) beginSelectionMove(app, worldPos, snapped);
                event.preventDefault();
                return;
            }

            const selectedShapeSegment = getShapeSegmentFocus(app)?.shapeId === hitShape.id
                ? { ...getShapeSegmentFocus(app) }
                : null;
            setShapeNodeFocus(app, null);
            setPendingShapeSegmentToggle(app, wasSelected && hitShape.type === 'polyline'
                ? {
                    shape: hitShape,
                    edgeId: hitSegmentEdgeId,
                    hadSegment: selectedShapeSegment?.edgeId === hitSegmentEdgeId,
                }
                : null);

            if (selectedShapeSegment && tryBeginPolylineSegmentDrag(app, hitShape, worldPos, true,
                segmentTolerance)) {
                app.viewport.svg.style.cursor = 'move';
                app.renderShapes();
                event.preventDefault();
                return;
            }

            setShapeSegmentFocus(app, null);
            app.updateShapeSelectionTip?.();

            // Wire segment drag
            if (tryBeginWireSegmentDrag(app, hitShape, worldPos)) {
                event.preventDefault();
                return;
            }

            // Move drag
            beginSelectionMove(app, worldPos, snapped);
            event.preventDefault();
            return;
        }

        // Box select
        beginBoxSelectSession(app, worldPos, isAdditiveSelectionModifier(event));
        event.preventDefault();
    },

    mousemove(app, event, { screenPos, worldPos, snapped }) {
        handleComponentTooltipMouseMove(app, worldPos, screenPos);

        // Try to promote pending anchor drag
        if (getPendingAnchorDrag(app) && !getSchematicDrag(app)) {
            if (promotePendingAnchorDragSession(app, screenPos)) return;
        }
    },

    mouseup(app, event, { worldPos, snapped }) {
        if (event.button !== 0) return;
        const pendingNode = getPendingAnchorDrag(app);
        if (pendingNode && (pendingNode.preInsertState
            || pendingNode.shape.type === 'polyline' && pendingNode.anchorId?.startsWith('mid_'))) {
            promotePendingAnchorDragSession(app, pendingNode.screenPos, true);
            app.viewport.svg.style.cursor = 'move';
            return;
        }
        clearPendingAnchorDrag(app);
        if (pendingNode?.shape?.type === 'polyline'
            && pendingNode.shape.nodes?.has(pendingNode.anchorId)
            && app.selection.getSelection().length === 1
            && app.selection.getSelection()[0] === pendingNode.shape) {
            setShapeSegmentFocus(app, null);
            setShapeNodeFocus(app, { shapeId: pendingNode.shape.id, nodeId: pendingNode.anchorId });
            app.renderShapes(true);
            app.updateShapeSelectionTip?.();
            app.updatePropertiesPanel?.(app.selection.getSelection());
            app.setActiveRibbonTab?.('properties');
            setSkipClickSelection(app, true);
            event.preventDefault();
        }
    },

    click(app, event, { worldPos }) {
        const pendingSegmentToggle = getPendingShapeSegmentToggle(app);
        clearPendingShapeSegmentToggle(app);
        if (app.viewport.isPanning) return;
        if (getSkipClickSelection(app)) { setSkipClickSelection(app, false); return; }
        if (getDidSchematicDrag(app)) { setDidSchematicDrag(app, false); return; }

        if (pendingSegmentToggle
            && app.selection.getSelection().length === 1
            && app.selection.getSelection()[0] === pendingSegmentToggle.shape) {
            removeShapeSegmentSelectionElement(app);
            const edgeId = refinePathSegment(pendingSegmentToggle.edgeId, true);
            setShapeSegmentFocus(app, edgeId == null ? null : { shapeId: pendingSegmentToggle.shape.id, edgeId });
            setShapeNodeFocus(app, null);
            app.renderShapes(true);
            app.updateShapeSelectionTip?.();
            app.updatePropertiesPanel?.(app.selection.getSelection());
            app.setActiveRibbonTab?.('properties');
            event.preventDefault();
            return;
        }

        // If a non-Home ribbon tab is showing, switch back to Home
        const activeTab = (document.getElementById('ribbonSchematic') || document).querySelector('.ribbon-tab.active');
        if (activeTab instanceof HTMLElement && activeTab.dataset.tab !== 'home') {
            app.setActiveRibbonTab('home');
        }

        const hit = app.selection.hitTest(worldPos);
        if (getSchematicTextEdit(app)) {
            if (!hit || hit !== getSchematicTextEdit(app).shape) app.endTextEdit(true);
        }
        app.selection.handleClick(worldPos, isAdditiveSelectionModifier(event));
        app.renderShapes(true);
    },

    dblclick(app, event, { screenPos, worldPos }) {
        if (getSchematicTextEdit(app)) return;
        const hit = findInlineEditableHit(app.selection, worldPos, event.target)
            || app.selection.hitTest(worldPos);
        if (hit && hit.supportsInlineEdit) {
            app.selection.select(hit, false);
            app.renderShapes(true);
            clearPendingAnchorDrag(app);
            app.startTextEdit(hit);
            app.setTextEditCaretFromScreen(screenPos);
            return;
        }
        if (!hit) app.viewport._onTitleBlockDblClick(worldPos);
    },

    rightclick(app, event, { screenPos, worldPos }) {
        if (handleSelectContextMenu(app, worldPos, event.clientX, event.clientY)) {
            return;
        }
        handleComponentTooltipContextMenu(app, worldPos, screenPos);
    }
};

/**
 * toolActive — non-select tool, not yet drawing.
 */
export const toolActiveState = {
    mousedown(app, event, { screenPos, worldPos, snapped }) {
        if (event.button !== 0) return;

        activateHomeTabIfFileTabOpen(app);
        setDidSchematicDrag(app, false);

        // Paste/component placement
        if (isPastingClipboard(app)) {
            confirmPaste(app, snapped);
            event.preventDefault();
            return;
        }
        if (getPlacingComponent(app)) {
            const placement = resolvePlacingComponentSnap(app, snapped);
            placeComponent(app, placement.placePos);
            event.preventDefault();
            return;
        }

        pressSchematicTool(app, event, { screenPos, worldPos, snapped });
    },

    mousemove(app, event, { screenPos, worldPos, snapped }) {
        handleComponentTooltipMouseMove(app, worldPos, screenPos);

        // Placement previews
        if (isPastingClipboard(app)) updatePastePreview(app, snapped);
        if (getPlacingComponent(app)) {
            const placement = resolvePlacingComponentSnap(app, snapped);
            updateComponentPreview(app, placement.placePos);
            updateSnapHighlight(app, placement.pinSnap);
        }

        moveSchematicTool(app, event, { screenPos, worldPos, snapped }, false);
    },

    mouseup(app, event, { worldPos, snapped }) {
        if (event.button !== 0) return;
    },

    rightclick(app, event, { screenPos, worldPos }) {
        handleComponentTooltipContextMenu(app, worldPos, screenPos);
        app.setToolCursor(app.currentTool, app.viewport.svg);
    }
};

/**
 * drawing — actively drawing a shape (wire/line/rect/circle/arc/polygon).
 */
export const drawingState = {
    mousedown(app, event, { screenPos, worldPos, snapped }) {
        if (event.button !== 0) return;

        activateHomeTabIfFileTabOpen(app);

        pressSchematicToolDrawing(app, event, { screenPos, worldPos, snapped });
    },

    mousemove(app, event, { screenPos, worldPos, snapped }) {
        handleComponentTooltipMouseMove(app, worldPos, screenPos);

        if (isPastingClipboard(app)) updatePastePreview(app, snapped);
        if (getPlacingComponent(app)) {
            const placement = resolvePlacingComponentSnap(app, snapped);
            updateComponentPreview(app, placement.placePos);
            updateSnapHighlight(app, placement.pinSnap);
        }

        moveSchematicTool(app, event, { screenPos, worldPos, snapped }, true);
    },

    /**
     * Right-click in place (no pan) — finish multi-point drawing tools.
     * Dispatched by mouse.js via contextmenu when movement < threshold.
     */
    rightclick(app, event, { screenPos, worldPos, snapped }) {
        if (finishSchematicDrawAtPointer(app, { screenPos, worldPos, snapped })) {
            app.setToolCursor(app.currentTool, app.viewport.svg);
            app.interactionState = 'toolActive';
        }
    },

    mouseup(app, event, { screenPos, worldPos, snapped }) {
        if (event.button !== 0) return;
        releaseSchematicTool(app, { screenPos, worldPos, snapped });
    },

    dblclick(app) {
        if (finishSchematicDrawInPlace(app)) app.interactionState = 'toolActive';
    },
};

/**
 * moveDrag — dragging selected shapes.
 */
export const moveDragState = {
    mousemove(app, event, { worldPos }) {
        if (app.viewport.isPanning) return;

        const selNow = movableSelection(app);
        const isDraggingText = selNow.length === 1 && selNow[0]?.type === 'text';
        const isGenericLabel = isDraggingText && selNow[0].fieldKey === 'label';
        if (isGenericLabel) {
            const labelShape = selNow[0];
            const hotspot = getLabelDropHotspot(labelShape, worldPos);
            const attach = resolveLabelAttachTarget(app, hotspot, labelShape);
            updateSnapHighlight(app, attach ? { x: attach.snapPos.x, y: attach.snapPos.y, type: 'attach' } : null);
            // Track hover target for invalidation
            const newTarget = attach?.target || null;
            const oldTarget = getSchematicDrag(app).labelHoverTarget || null;
            if (newTarget !== oldTarget) {
                if (oldTarget) oldTarget.invalidate?.();
                if (labelShape.parentComponent && labelShape.parentComponent !== oldTarget) labelShape.parentComponent.invalidate?.();
                if (newTarget) newTarget.invalidate?.();
                getSchematicDrag(app).labelHoverTarget = newTarget;
            }
        } else {
            getSchematicDrag(app).labelHoverTarget = null;
        }

        const mouseDelta = { x: worldPos.x - getSchematicDrag(app).startWorldPos.x, y: worldPos.y - getSchematicDrag(app).startWorldPos.y };
        const targetPos = { x: getSchematicDrag(app).objectStartPos.x + mouseDelta.x, y: getSchematicDrag(app).objectStartPos.y + mouseDelta.y };
        const sel = selNow;
        const movingCompIds = collectMovingComponentIds(sel);
        const snappedTarget = getMoveDragSnappedTarget(app);
        const stickyGuides = resolveMoveDragTarget(app, targetPos, sel, movingCompIds, snappedTarget);

        // Net drag highlight should follow projected snapped shape position,
        // not raw mouse movement, to avoid flicker when shape is stationary.
        const dragNet = selNow.length === 1 && selNow[0]?.type === 'net' ? selNow[0] : null;
        let deferredNetSnap = null;
        if (dragNet) {
            const alreadyConnected = dragNet.id && app.shapes.some(s =>
                s.type === 'wire' && [...s.pinConnections.values()].some(c => c.componentId === dragNet.id)
            );
            if (!alreadyConnected) {
                const previewDx = snappedTarget.x - getSchematicDrag(app).lastSnapped.x;
                const previewDy = snappedTarget.y - getSchematicDrag(app).lastSnapped.y;
                const pinProbe = {
                    x: dragNet.x + previewDx,
                    y: dragNet.y + previewDy
                };
                const netPin = dragNet.symbol?.pins?.[0] || null;
                const { resolved } = resolvePinSnapPlacement(app, pinProbe, {
                    excludePin: netPin
                        ? { component: dragNet, pin: netPin, pinKey: netPin._key || netPin._id || netPin.number }
                        : null
                });
                deferredNetSnap = resolved;
            }
        }

        // Component drag: show snap highlight when an unconnected pin would
        // land on a wire node after this frame's snapped movement.
        const dragComp = selNow.find(s => s.definition && s.symbol?.pins);
        let deferredComponentSnap = null;
        if (dragComp) {
            const compSnap = resolveDraggingComponentSnap(app, dragComp, snappedTarget, getSchematicDrag(app).lastSnapped);
            snappedTarget.x = compSnap.targetPos.x;
            snappedTarget.y = compSnap.targetPos.y;
            deferredComponentSnap = compSnap.pinSnap;
        }

        const dx = snappedTarget.x - getSchematicDrag(app).lastSnapped.x;
        const dy = snappedTarget.y - getSchematicDrag(app).lastSnapped.y;

        if (dx !== 0 || dy !== 0) {
            setDidSchematicDrag(app, true);
            getSchematicDrag(app).restoreStates ??= captureMoveDragStates(app, sel);
            getSchematicDrag(app).totalDx += dx;
            getSchematicDrag(app).totalDy += dy;

            for (const shape of sel) {
                if (shape.parentComponent && movingCompIds.has(shape.parentComponent.id)) continue;
                shape.move(dx, dy);
                if (shape.definition) refreshComponentPose(shape);

                for (const maybeLabel of app.shapes) {
                    if (maybeLabel?.type !== 'text') continue;
                    if (maybeLabel.parentComponent !== shape || maybeLabel.fieldKey !== 'label') continue;
                    maybeLabel.move(dx, dy);
                }
            }
            if (movingCompIds.size > 0) {
                updateStickyWires(app, { movedIds: movingCompIds });
                renderGuideLines(app, stickyGuides);
            }
            propagateMovedWireJunctions(app, sel, dx, dy);
            getSchematicDrag(app).lastSnapped.x = snappedTarget.x;
            getSchematicDrag(app).lastSnapped.y = snappedTarget.y;
            app.renderShapes(false);
            if (getSchematicTextEdit(app)) app.updateTextEditOverlay?.();
            app.fileManager.setDirty(true);
        }

        if (dragComp) {
            updateSnapHighlight(app, deferredComponentSnap);
        } else if (dragNet) {
            updateSnapHighlight(app, deferredNetSnap);
        }
    },

    mouseup(app, event, { worldPos }) {
        if (event.button !== 0) return;

        const sel = movableSelection(app);
        const isGenericLabel = sel.length === 1 && sel[0]?.type === 'text' && sel[0].fieldKey === 'label';
        if (isGenericLabel) {
            const labelShape = sel[0];
            const oldParent = labelShape.parentComponent;
            const hotspot = getLabelDropHotspot(labelShape, worldPos);
            const attach = resolveLabelAttachTarget(app, hotspot, labelShape);
            if (attach?.target) {
                attachLabelToTarget(labelShape, attach.target, attach.snapPos || null, { isNewLabel: false });
            } else if (labelShape.parentComponent) {
                // Dropped in empty space — keep attached, update offset
                refreshLabelAttachmentOffset(labelShape);
            }
            // Clear blue tint on old owner if ownership changed
            if (oldParent && oldParent !== labelShape.parentComponent) {
                oldParent.invalidate?.();
            }
            // Ensure new owner picks up blue tint
            if (labelShape.parentComponent) {
                labelShape.parentComponent.invalidate?.();
            }
        }

        handleDragEnd(app);
    }
};

/**
 * anchorDrag — dragging an anchor point.
 */
export const anchorDragState = {
    mousedown(app, event, positions) {
        if (event.button !== 0 || !getSchematicDrag(app).midpointPlacement) return;
        anchorDragState.mousemove(app, event, positions);
        handleDragEnd(app);
        setSkipClickSelection(app, true);
        app.viewport.svg.style.cursor = '';
        event.preventDefault();
    },

    mousemove(app, event, { worldPos, snapped }) {
        if (app.viewport.isPanning) return;

        setDidSchematicDrag(app, true);
        app.selection.keepSelected(getSchematicDrag(app).shape);

        const snapMode = getSchematicDrag(app).shape.getAnchorSnapMode(getSchematicDrag(app).anchorId);
        let anchorPos = snapMode === 'none' ? worldPos : snapped;

        if (getSchematicDrag(app).shape.type === 'noconnect') {
            const snap = resolveWireSnapPosition(app, worldPos, { pinTolerance: PIN_SNAP_TOL });
            updateSnapHighlight(app, snap);
            anchorPos = { x: snap.x, y: snap.y };
        }

        let anchorGuides = [];
        const isBulgeHandle = typeof getSchematicDrag(app).anchorId === 'string' && getSchematicDrag(app).anchorId.startsWith('bulge_');
        const isGraphShape = !isBulgeHandle && !!(getSchematicDrag(app).shape.nodes && getSchematicDrag(app).shape.edges);
        if (isGraphShape) {
            const isLeaf = getSchematicDrag(app).shape.nodes.has(getSchematicDrag(app).anchorId) && getSchematicDrag(app).shape.degree(getSchematicDrag(app).anchorId) <= 1;

            if (getSchematicDrag(app).excludePin?.worldPos) {
                const excludedPin = getSchematicDrag(app).excludePin.worldPos;
                if (Math.hypot(worldPos.x - excludedPin.x, worldPos.y - excludedPin.y) > PIN_SNAP_TOL)
                    getSchematicDrag(app).excludePin = null;
            }

            let snappedToTarget = false;
            if (isLeaf && getSchematicDrag(app).shape.type === 'wire') {
                const snap = resolveWireSnapPosition(app, worldPos, {
                    excludeNode: { wire: getSchematicDrag(app).shape, nodeId: getSchematicDrag(app).anchorId },
                    excludePin: getSchematicDrag(app).excludePin || null,
                    pinTolerance: PIN_SNAP_TOL
                });
                anchorPos = { x: snap.x, y: snap.y };
                snappedToTarget = snap.snapType === 'pin' || snap.snapType === 'endpoint' || snap.snapType === 'segment';
                if (snappedToTarget) updateSnapHighlight(app, snap);
            }

            if (!snappedToTarget) {
                updateSnapHighlight(app, null);
                if (getSchematicDrag(app).shape.type === 'polyline') {
                    const nodeIds = getSchematicDrag(app).shape.isRect ? getSchematicDrag(app).shape.getOrderedNodeIds() : [];
                    const cornerIndex = nodeIds.indexOf(getSchematicDrag(app).anchorId);
                    const neighbourIds = getSchematicDrag(app).shape.isRect
                        ? (cornerIndex >= 0 ? [nodeIds[(cornerIndex + 2) % 4]] : [])
                        : getSchematicDrag(app).shape.neighborNodes(getSchematicDrag(app).anchorId);
                    const neighbours = neighbourIds
                        .map(id => getSchematicDrag(app).shape.nodes.get(id)).filter(Boolean);
                    anchorPos = snapShapePoint(app, worldPos, neighbours,
                        shapeContinuationConstraints(getSchematicDrag(app).shape, getSchematicDrag(app).anchorId));
                } else if (!getSchematicDrag(app).shape.isRect) {
                    const neighbors = getSchematicDrag(app).shape.neighborNodes(getSchematicDrag(app).anchorId)
                        .map(nid => getSchematicDrag(app).shape.nodes.get(nid)).filter(Boolean);
                    applyOffGridNeighborSnap(worldPos, anchorPos, neighbors, app.viewport.gridSize || 1.0);
                    const collinearSnap = computeAnchorCollinearSnap(app, getSchematicDrag(app).shape, getSchematicDrag(app).anchorId, anchorPos);
                    anchorPos = collinearSnap.anchorPos;
                    anchorGuides = collinearSnap.guides;
                }
            }
        }

        if (getSchematicDrag(app).shape.type === 'polyline' && isBulgeHandle
            || getSchematicDrag(app).shape.type === 'arc' && getSchematicDrag(app).anchorId === 'mid') {
            anchorPos = snapShapeBulge(app, getSchematicDrag(app).shape, getSchematicDrag(app).anchorId, worldPos);
        }
        app.updateCrosshair(anchorPos);
        if (getSchematicDrag(app).shape.type === 'wire') anchorPos = mergeAnchorTJunctionGuides(app, anchorPos, anchorGuides);
        if (getSchematicDrag(app).shape.type !== 'polyline' && getSchematicDrag(app).shape.type !== 'arc') renderGuideLines(app, anchorGuides);

        // Cross-shape join snap: dragging a polyline/arc endpoint onto another
        // joinable shape's endpoint fuses them on drop. Show the snap dot (the
        // "yellow circle") and record the target. Shared with PCB drawing tools
        // via shapes/shape-join.js (no schematic-only assumptions).
        getSchematicDrag(app).joinTarget = null;
        if (!getSchematicDrag(app).pathSplit && !app.viewport.shiftHeld && isJoinable(getSchematicDrag(app).shape)) {
            const isJoinSource = getSchematicDrag(app).shape.type === 'arc'
                ? (getSchematicDrag(app).anchorId === 'start' || getSchematicDrag(app).anchorId === 'end')
                : !!(getSchematicDrag(app).shape.nodes?.has(getSchematicDrag(app).anchorId) && getSchematicDrag(app).shape.degree(getSchematicDrag(app).anchorId) === 1);
            if (isJoinSource) {
                const joinTol = SNAP_SCREEN_PX / app.viewport.scale;
                const jt = findJoinTarget(app.shapes, anchorPos, joinTol, getSchematicDrag(app).shape, getSchematicDrag(app).anchorId);
                if (jt) {
                    anchorPos = { x: jt.x, y: jt.y };
                    getSchematicDrag(app).joinTarget = jt;
                    updateSnapHighlight(app, { x: jt.x, y: jt.y, type: 'endpoint' });
                } else if (getSchematicDrag(app).shape.type === 'arc') {
                    updateSnapHighlight(app, null);
                }
            }
        }

        const newAnchorId = getSchematicDrag(app).shape.moveAnchor(getSchematicDrag(app).anchorId, anchorPos.x, anchorPos.y);
        if (newAnchorId && newAnchorId !== getSchematicDrag(app).anchorId) getSchematicDrag(app).anchorId = newAnchorId;

        const draggedShape = getSchematicDrag(app).shape;
        const selectedSegment = getShapeSegmentFocus(app);
        const bulge = draggedShape.type === 'arc' ? draggedShape.bulge
            : draggedShape.type === 'polyline' && selectedSegment?.shapeId === draggedShape.id
                ? draggedShape.getEdgeAttr(selectedSegment.edgeId, 'bulge') : null;
        if (Number.isFinite(bulge)) {
            const bulgeInput = /** @type {HTMLInputElement|null} */ (document.getElementById('prop_bulge'));
            if (bulgeInput) bulgeInput.value = bulge.toFixed(2);
        }

        syncAnchorDragLinkedNodes(app, anchorPos);
        if (getSchematicDrag(app).shape.type === 'polyline' || getSchematicDrag(app).shape.type === 'arc') {
            renderShapeAlignment(app, getSchematicDrag(app).shape, [getSchematicDrag(app).anchorId]);
        }
        app.renderShapes(false);
        if (getSchematicTextEdit(app)) app.updateTextEditOverlay?.();
        app.fileManager.setDirty(true);
    },

    mouseup(app, event) {
        if (event.button !== 0) return;
        if (getSchematicDrag(app).midpointPlacement) return;
        handleDragEnd(app);
    }
};

/**
 * segmentDrag — dragging a wire segment.
 */
export const segmentDragState = {
    mousemove(app, event, { worldPos }) {
        if (app.viewport.isPanning) return;

        const wire = getSchematicDrag(app).shape;
        const dragEdgeId = getSchematicDrag(app).edgeId;

        if (wire.type === 'polyline') {
            updatePolylineSegmentDrag(app, worldPos);
            app.renderShapes(false);
            if (getDidSchematicDrag(app)) app.fileManager.setDirty(true);
            return;
        }

        const mouseDelta = getReusablePoint(app, '_dragSegmentMouseDeltaScratch');
        mouseDelta.x = worldPos.x - getSchematicDrag(app).startWorldPos.x;
        mouseDelta.y = worldPos.y - getSchematicDrag(app).startWorldPos.y;
        if (getSchematicDrag(app).axis === 'vertical') mouseDelta.x = 0;
        else if (getSchematicDrag(app).axis === 'horizontal') mouseDelta.y = 0;

        const origState = getSchematicDrag(app).workingState || getSchematicDrag(app).wireStates.get(wire);
        const origEdge = origState.edges[dragEdgeId];
        const refPt = origEdge ? origState.nodes[origEdge.from] : null;
        if (!refPt) return;

        const target = getReusablePoint(app, '_dragSegmentTargetScratch');
        target.x = refPt.x + mouseDelta.x;
        target.y = refPt.y + mouseDelta.y;

        const tJunctionWires = getDragTJunctionWireSet(app);
        const { snappedTarget, guides: segGuides, highlight: segHighlight } =
            computeSegmentDragSnap(app, wire, dragEdgeId, origState, target, getSchematicDrag(app).axis, tJunctionWires);
        updateSnapHighlight(app, segHighlight);

        const allSegGuides = collectWireSegmentDragGuides(app, wire, dragEdgeId, snappedTarget, segGuides);
        renderGuideLines(app, allSegGuides);

        const curFromPos = wire.nodes.get(origEdge.from);
        const dx = snappedTarget.x - (curFromPos ? curFromPos.x : refPt.x);
        const dy = snappedTarget.y - (curFromPos ? curFromPos.y : refPt.y);

        if (dx !== 0 || dy !== 0) {
            setDidSchematicDrag(app, true);
            getSchematicDrag(app).totalDx += dx;
            getSchematicDrag(app).totalDy += dy;
            const movedNodes = applyWireSegmentNodeMovement(app, wire, dragEdgeId, origState, dx, dy);
            propagateWireSegmentLinkedMovement(app, movedNodes, dx, dy);
            applyWireSegmentLabelMovement(wire, dx, dy);
            app.renderShapes(false);
            app.fileManager.setDirty(true);
        }
    },

    mouseup(app, event) {
        if (event.button !== 0) return;
        handleDragEnd(app);
    }
};

/**
 * boxSelect — rubber-band selection.
 */
export const boxSelectState = {
    mousemove(app, event, { worldPos }) {
        if (app.viewport.isPanning) return;
        setDidSchematicDrag(app, true);
        updateBoxSelectElement(app, worldPos);
        const bounds = getBoxSelectBounds(app, worldPos);
        app.selection.syncBoxSelection(bounds, !!getSchematicDrag(app).additive, 'contain');
        app.renderShapes(false);
    },

    mouseup(app, event, { worldPos }) {
        if (event.button !== 0) return;

        const bounds = getBoxSelectBounds(app, worldPos);
        app.removeBoxSelectElement();
        if (getDidSchematicDrag(app)) {
            app.selection.syncBoxSelection(bounds, !!getSchematicDrag(app)?.additive, 'contain');
            app.selection.notifyChanged();
            app.renderShapes(true);
        }

        setSchematicDrag(app, null);
        app.interactionState = 'idle';
    }
};

/**
 * placing — paste preview or component placement active.
 */
export const placingState = {
    mousedown(app, event, { snapped }) {
        if (event.button !== 0 || app.viewport.isPanning) return;
        activateHomeTabIfFileTabOpen(app);

        if (isPastingClipboard(app)) {
            confirmPaste(app, snapped);
            event.preventDefault();
            return;
        }
        if (getPlacingComponent(app)) {
            const placement = resolvePlacingComponentSnap(app, snapped);
            placeComponent(app, placement.placePos);
            event.preventDefault();
            return;
        }
    },

    mousemove(app, event, { screenPos, worldPos, snapped }) {
        if (isPastingClipboard(app)) updatePastePreview(app, snapped);
        if (getPlacingComponent(app)) {
            const placement = resolvePlacingComponentSnap(app, snapped);
            updateComponentPreview(app, placement.placePos);
            updateSnapHighlight(app, placement.pinSnap);
        }

        updateToolCrosshair(app, snapped, screenPos);
    }
};

// ─── State table ───────────────────────────────────────────────────

export const STATE_TABLE = {
    overlapCycle: overlapCycleState,
    idle: idleState,
    toolActive: toolActiveState,
    drawing: drawingState,
    moveDrag: moveDragState,
    anchorDrag: anchorDragState,
    segmentDrag: segmentDragState,
    boxSelect: boxSelectState,
    placing: placingState
};
