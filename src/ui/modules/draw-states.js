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

import { updateStickyWires, updateSnapHighlight, resolveWireSnapPosition, renderGuideLines, computeAnchorCollinearSnap, computeSegmentDragSnap, computeStickyWireSnaps, applyOffGridNeighborSnap, buildCollinearChain, bridgeCollinearPinEndpoints, SNAP_SCREEN_PX, COLLINEAR_EPSILON, VERTEX_EPSILON, PIN_SNAP_TOL } from './wire.js';
import { commitAnchorDrag, clearDragState, commitMoveDrag, commitSegmentDrag, resolveAnchorDragOnMouseUp, revertSegmentDragIfNoMove, areCapturedStatesEqual } from './drag.js';
import { detectTJunction, showAnchorContextMenu, showSegmentContextMenu, showLabelContextMenu } from './context-menu.js';
import { updateToolGhost } from './tool.js';
import { ModifyShapeCommand } from '../../core/CommandHistory.js';
import { collapseRedundantWirePoints } from './wire.js';
import { Text } from '../../shapes/text.js';
import { attachLabelToTarget, refreshLabelAttachmentOffset, getLabelAttachmentAnchorPoint, getLabelDropHotspot } from './label-attachment.js';

// ─── Constants ─────────────────────────────────────────────────────

const DRAWING_TOOLS = new Set(['line', 'rect', 'circle', 'polygon']);
const CLICK_TO_END_TOOLS = new Set(['rect', 'circle', 'arc']);
const DRAG_THRESHOLD_PX = 3;

// ─── State transition ──────────────────────────────────────────────

/**
 * Determine current state from legacy app flags.
 * Used as initialization and safety-net fallback.
 * @param {object} app
 * @returns {string}
 */
export function resolveState(app) {
    if (app.pastingClipboard) return 'placing';
    if (app.placingComponent) return 'placing';
    if (app.drag) {
        switch (app.drag.mode) {
            case 'anchor': return 'anchorDrag';
            case 'segment': return 'segmentDrag';
            case 'move': return 'moveDrag';
            case 'box': return 'boxSelect';
        }
    }
    if (app.isDrawing) return 'drawing';
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
        app._setActiveRibbonTab?.('home');
    }
}

function selectOnlyShapeAndRender(app, shape) {
    app.selection.clearSelection();
    app.selection.select(shape, false);
    app.renderShapes(true);
}

function selectContextTargetShape(app, shape) {
    if (!shape.selected) {
        selectOnlyShapeAndRender(app, shape);
    }
    shape.selected = true;
}

function getNextCycleHitShape(app, worldPos) {
    const originalTolerance = app.selection.tolerance;
    app.selection.tolerance = 2.0;
    const hits = app.selection.hitTest(worldPos, true);
    app.selection.tolerance = originalTolerance;
    if (!hits || hits.length === 0) return null;
    const selectedIndex = hits.findIndex(shape => shape.selected);
    return hits[(selectedIndex + 1) % hits.length];
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

function updateToolCrosshair(app, snapped, screenPos) {
    app._showCrosshair();
    app._updateCrosshair(snapped, screenPos);
}

function resolvePinSnapPlacement(app, worldPos) {
    const resolved = resolveWireSnapPosition(app, worldPos, { pinTolerance: PIN_SNAP_TOL });
    return { resolved, pos: { x: resolved.x, y: resolved.y } };
}

function handleComponentTooltipContextMenu(app, worldPos, screenPos) {
    if (app.showComponentDebugTooltip === false) return;
    const hitComponent = app._findComponentAt?.(worldPos);
    if (hitComponent) app._pinComponentCodeTooltip?.(hitComponent, screenPos);
    else app._updateComponentCodeTooltip?.(null, null, { forceHide: true });
}

function handleComponentTooltipMouseMove(app, worldPos, screenPos) {
    const canShow = app.showComponentDebugTooltip !== false
        && !app.drag && !app.viewport.isPanning
        && !app.placingComponent && !app._componentCodeTooltipPinned;
    if (canShow) {
        const hit = app._findComponentAt?.(worldPos);
        app._updateComponentCodeTooltip?.(hit, screenPos);
        return;
    }
    if (!app._componentCodeTooltipPinned) {
        app._updateComponentCodeTooltip?.(null, screenPos);
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
    app.pendingAnchorDrag = pending;
}

function finalizeDragInteraction(app, options = {}) {
    // UI cleanup (was previously inside clearDragState)
    updateSnapHighlight(app, null);
    if (app._collinearGuides) {
        for (const line of app._collinearGuides) line.remove();
        app._collinearGuides = null;
    }
    app._hideCrosshair();
    app._removeBoxSelectElement();
    if (app._labelDragGuide) {
        app._labelDragGuide.remove();
        app._labelDragGuide = null;
    }
    app._labelDragHoverTarget = null;

    clearDragState(app);
    app.renderShapes(true);
    if (options.refreshTextEdit && app.textEdit) app._updateTextEditOverlay?.();
}

export function updateLabelDragGuide(app, labelShape) {
    if (!labelShape || labelShape.type !== 'text' || !labelShape.parentComponent) {
        if (app._labelDragGuide) {
            app._labelDragGuide.remove();
            app._labelDragGuide = null;
        }
        return;
    }

    // Guide line endpoint: center of text at baseline, rotated to world space
    let guideEndX, guideEndY;
    {
        const approxWidth = (labelShape.text?.length || 1) * (labelShape.fontSize || 2) * 0.6;
        let localMinX = labelShape.x;
        if (labelShape.textAnchor === 'middle') {
            localMinX = labelShape.x - approxWidth / 2;
        } else if (labelShape.textAnchor === 'end') {
            localMinX = labelShape.x - approxWidth;
        }
        const localCX = localMinX + approxWidth / 2;
        const localBY = labelShape.y;

        if (labelShape.rotation) {
            const rad = (labelShape.rotation * Math.PI) / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const dx = localCX - labelShape.x, dy = localBY - labelShape.y;
            guideEndX = labelShape.x + dx * cos - dy * sin;
            guideEndY = labelShape.y + dx * sin + dy * cos;
        } else {
            guideEndX = localCX;
            guideEndY = localBY;
        }
    }

    const anchor = getLabelAttachmentAnchorPoint(labelShape, { x: guideEndX, y: guideEndY });
    if (!anchor) {
        if (app._labelDragGuide) {
            app._labelDragGuide.remove();
            app._labelDragGuide = null;
        }
        return;
    }

    let guide = app._labelDragGuide;
    if (!guide) {
        guide = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        guide.setAttribute('stroke', 'var(--sch-selection, #3399ff)');
        guide.setAttribute('stroke-width', String(Math.max(0.15, 1.2 / app.viewport.scale)));
        guide.setAttribute('stroke-dasharray', `${Math.max(0.6, 3 / app.viewport.scale)} ${Math.max(0.4, 2 / app.viewport.scale)}`);
        guide.setAttribute('opacity', '0.45');
        guide.setAttribute('pointer-events', 'none');
        app.viewport.contentLayer.appendChild(guide);
        app._labelDragGuide = guide;
    }

    guide.setAttribute('x1', String(anchor.x));
    guide.setAttribute('y1', String(anchor.y));
    guide.setAttribute('x2', String(guideEndX));
    guide.setAttribute('y2', String(guideEndY));
}

// ─── Drag session setup ────────────────────────────────────────────

function beginAnchorDragSession(app, params) {
    const { shape, anchorId, startSnapped, screenPos, preInsertState } = params;
    app.drag = {
        mode: 'anchor',
        shape,
        beforeState: preInsertState || app._captureShapeState(shape),
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
    };
    app.interactionState = 'anchorDrag';
}

function beginWireSegmentDragSession(app, params) {
    const { shape, dragEdgeId, worldPos, beforeState } = params;
    const wireStates = new Map();
    wireStates.set(shape, beforeState);
    app.drag = {
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
    };
    app.interactionState = 'segmentDrag';
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
            // Bridge each non-pin incident edge so the pin can move freely
            for (const { edge: e, otherNode } of [...wire.incidentEdges(nodeId)]) {
                let otherIsPin = false;
                if (wire.pinConnections.has(otherNode)) {
                    const otherConn = wire.pinConnections.get(otherNode);
                    if (otherConn && movingCompIds.has(otherConn.componentId)) continue;
                    otherIsPin = true;
                }
                const otherPos = wire.nodes.get(otherNode);
                const pinPos = wire.nodes.get(nodeId);
                if (!otherPos || !pinPos) continue;
                // Skip if other node is already at pin position (existing bridge)
                if (Math.abs(otherPos.x - pinPos.x) < 0.01 && Math.abs(otherPos.y - pinPos.y) < 0.01) continue;
                const dx = otherPos.x - pinPos.x;
                const dy = otherPos.y - pinPos.y;
                const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
                let sign = axis === 'x' ? Math.sign(dx) : Math.sign(dy);
                if (sign === 0) sign = 1;
                const groupKey = `${conn.componentId}|${axis}|${sign}`;
                addGroupEntry(groupKey, {
                    wire,
                    nodeId,
                    edge: e,
                    pinPos,
                    axis,
                    sign,
                    isPinToPin: otherIsPin
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
    app.drag = {
        mode: 'move',
        objectStartPos: { ...dragObjectStartPos },
        lastSnapped: { ...dragObjectStartPos },
        startWorldPos: { ...worldPos },
        totalDx: 0,
        totalDy: 0
    };
    app.interactionState = 'moveDrag';
}

function beginBoxSelectSession(app, worldPos, additive) {
    app.drag = {
        mode: 'box',
        start: { ...worldPos },
        additive: !!additive
    };
    app.selection.captureBoxSelectBase();
    app._createBoxSelectElement();
    app.interactionState = 'boxSelect';
}

function promotePendingAnchorDragSession(app, screenPos) {
    const pending = app.pendingAnchorDrag;
    if (!pending) return false;

    const dx = screenPos.x - pending.screenPos.x;
    const dy = screenPos.y - pending.screenPos.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return false;

    app.pendingAnchorDrag = null;
    const { shape, anchorId, snapped: startSnapped, preInsertState } = pending;

    beginAnchorDragSession(app, { shape, anchorId, startSnapped, screenPos, preInsertState });

    if (shape.getAnchorSnapMode(anchorId) === 'axis') {
        const anchor = shape.getAnchors().find(a => a.id === anchorId);
        if (anchor) app.drag.wireAnchorOriginal = { x: anchor.x, y: anchor.y };
    }

    app.drag.tjLinks = [];
    app.drag.wireStates = new Map();
    if (shape.type === 'wire' && shape.nodes.has(anchorId)) {
        const pos = shape.nodes.get(anchorId);
        for (const other of app.shapes) {
            if (other === shape || other.type !== 'wire') continue;
            const otherNid = other.nodeAt(pos, VERTEX_EPSILON);
            if (otherNid) {
                app.drag.tjLinks.push({ otherWire: other, otherNodeId: otherNid });
                if (!app.drag.wireStates.has(other))
                    app.drag.wireStates.set(other, app._captureShapeState(other));
            }
        }
    }

    app.drag.ncLinks = [];
    if (shape.type === 'wire' && shape.nodes.has(anchorId)) {
        const nodePos = shape.nodes.get(anchorId);
        for (const s of app.shapes) {
            if (s.type !== 'noconnect') continue;
            if (Math.hypot(s.x - nodePos.x, s.y - nodePos.y) < VERTEX_EPSILON)
                app.drag.ncLinks.push({ nc: s, before: s.captureState() });
        }
    }

    app.drag.excludePin = null;
    if (shape.type === 'wire' && shape.pinConnections.has(anchorId)) {
        const conn = shape.pinConnections.get(anchorId);
        const nodePos = shape.nodes.get(anchorId);
        app.drag.excludePin = {
            component: { id: conn.componentId },
            pin: { number: conn.pinNumber },
            worldPos: nodePos ? { x: nodePos.x, y: nodePos.y } : null
        };
    }

    app._showCrosshair();
    app._updateCrosshair(startSnapped);
    return true;
}

// ─── Drag commit helpers ───────────────────────────────────────────

function commitPendingMidpointAfterDrag(app) {
    const pending = app.pendingAnchorDrag;
    if (!pending?.preInsertState) return;
    const { shape, preInsertState } = pending;
    if (shape.type === 'wire') collapseRedundantWirePoints(app, shape);
    const afterState = app._captureShapeState(shape);
    if (!areCapturedStatesEqual(preInsertState, afterState)) {
        app._applyShapeState(shape, preInsertState);
        const command = new ModifyShapeCommand(app, shape, preInsertState, afterState);
        app.history.execute(command);
    }
    shape.selected = true;
}

function handleDragEnd(app) {
    if (!app.drag) return;

    if (app.didDrag && app.drag.mode === 'move') {
        commitMoveDrag(app, app.drag.totalDx, app.drag.totalDy);
        // Clean up redundant collinear nodes left by bridge insertion
        for (const wire of app.shapes) {
            if (wire.type === 'wire') collapseRedundantWirePoints(app, wire);
        }
    } else if (app.drag.mode === 'segment' && app.drag.wireStates) {
        if (app.didDrag) commitSegmentDrag(app, app.drag.shape, app.drag.wireStates, app.drag.ncLinks, app.drag.labelBefore);
        else revertSegmentDragIfNoMove(app, app.drag.wireStates);
    } else if (app.drag.shape) {
        resolveAnchorDragOnMouseUp(app, app.drag.shape, app.drag.beforeState, app.didDrag, app.drag.wireStates, app.drag.ncLinks, app.drag.junctionBeforeWireStates, app.drag.junctionBeforeLabelTextStates);
    }

    commitPendingMidpointAfterDrag(app);
    finalizeDragInteraction(app, { refreshTextEdit: true });
    app.interactionState = resolveState(app);
}

// ─── Context menu helpers ──────────────────────────────────────────

function handleAnchorContextMenu(app, worldPos, clientX, clientY) {
    const selectedShapes = app.selection.getSelection();
    for (const shape of selectedShapes) {
        if (shape.locked) continue;
        const anchorId = shape.hitTestAnchor(worldPos, app.viewport.scale);
        if (anchorId && !anchorId.startsWith('mid')) {
            let canDeletePoint = false;
            if (shape.type === 'wire') {
                canDeletePoint = shape.nodes.has(anchorId) && shape.edges.size > 1;
            } else {
                const minPoints = shape.type === 'polygon' ? 4 : 3;
                canDeletePoint = typeof shape.deleteAnchor === 'function' &&
                    shape.points && shape.points.length >= minPoints;
            }
            const junctionInfo = detectTJunction(app, shape, anchorId);
            if (junctionInfo && shape.type === 'wire') canDeletePoint = false;
            if (canDeletePoint || junctionInfo) {
                showAnchorContextMenu(app, shape, anchorId, clientX, clientY, canDeletePoint, junctionInfo);
                return true;
            }
        }
    }

    const junctionTol = Math.max(0.5, 3 / app.viewport.scale);
    for (const wire of app.shapes) {
        if (wire.type !== 'wire' || wire.locked) continue;
        const nid = wire.nodeAt(worldPos, junctionTol);
        if (!nid) continue;
        const junctionInfo = detectTJunction(app, wire, nid);
        if (junctionInfo) {
            selectContextTargetShape(app, wire);
            showAnchorContextMenu(app, wire, nid, clientX, clientY, false, junctionInfo);
            return true;
        }
    }
    return false;
}

function handleSegmentContextMenu(app, worldPos, clientX, clientY) {
    const segTolerance = SNAP_SCREEN_PX / app.viewport.scale;
    for (const shape of app.shapes) {
        if (shape.locked || shape.type !== 'wire') continue;
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
    if (hit?.type === 'text' && hit.parentComponent && hit.fieldKey === 'label') {
        selectContextTargetShape(app, hit);
        showLabelContextMenu(app, hit, clientX, clientY);
        return true;
    }
    if (handleAnchorContextMenu(app, worldPos, clientX, clientY)) return true;
    return handleSegmentContextMenu(app, worldPos, clientX, clientY);
}

function resolveLabelAttachTarget(app, probePos, excludeShape = null) {
    // Also exclude the label's current parent so the snap dot doesn't show for it
    const excludeParent = excludeShape?.parentComponent || null;

    const hitComponent = app._findComponentAt?.(probePos);
    if (hitComponent && hitComponent !== excludeShape && hitComponent !== excludeParent) {
        return {
            target: hitComponent,
            snapPos: { x: probePos.x, y: probePos.y }
        };
    }

    const wireTolerance = SNAP_SCREEN_PX / app.viewport.scale;
    for (let i = app.shapes.length - 1; i >= 0; i--) {
        const shape = app.shapes[i];
        if (!shape || shape === excludeShape || shape === excludeParent || shape.type !== 'wire' || shape._culled || !shape.visible) continue;
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
        beforeState: app._captureShapeState(hitShape)
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
            if (sDy < COLLINEAR_EPSILON && sDx > COLLINEAR_EPSILON) app.drag.axis = 'vertical';
            else if (sDx < COLLINEAR_EPSILON && sDy > COLLINEAR_EPSILON) app.drag.axis = 'horizontal';
            else app.drag.axis = null;
        } else {
            app.drag.axis = null;
        }
    }

    // Bridge pin-connected nodes reachable through the collinear chain
    {
        const chainState = app._captureShapeState(hitShape);
        const chain = buildCollinearChain(hitShape, dragEdgeId, chainState);
        bridgeCollinearPinEndpoints(hitShape, chain);
    }

    app.drag.workingState = app._captureShapeState(hitShape);
    app.drag.tjLinks = [];
    for (const [nid, pos] of hitShape.nodes) {
        for (const other of app.shapes) {
            if (other === hitShape || other.type !== 'wire') continue;
            const otherNid = other.nodeAt(pos, VERTEX_EPSILON);
            if (otherNid) {
                app.drag.tjLinks.push({ wireNodeId: nid, otherWire: other, otherNodeId: otherNid });
                if (!app.drag.wireStates.has(other))
                    app.drag.wireStates.set(other, app._captureShapeState(other));
            }
        }
    }
    app.drag.ncLinks = [];
    for (const [nid, pos] of hitShape.nodes) {
        for (const shape of app.shapes) {
            if (shape.type !== 'noconnect') continue;
            if (Math.hypot(shape.x - pos.x, shape.y - pos.y) < VERTEX_EPSILON)
                app.drag.ncLinks.push({ wireNodeId: nid, nc: shape, before: shape.captureState() });
        }
    }
    app.drag.labelBefore = hitShape.labelText
        ? app._captureShapeState(hitShape.labelText) : null;
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
    const nonSelectedWires = app._propagateNonSelectedWiresScratch || (app._propagateNonSelectedWiresScratch = []);
    nonSelectedWires.length = 0;
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
        const proposedDx = snappedTargetOut.x - app.drag.lastSnapped.x;
        const proposedDy = snappedTargetOut.y - app.drag.lastSnapped.y;
        const stickySnap = computeStickyWireSnaps(app, movingCompIds, proposedDx, proposedDy);
        snappedTargetOut.x += stickySnap.adjustX;
        snappedTargetOut.y += stickySnap.adjustY;
        stickyGuides = stickySnap.guides;
    }
    return stickyGuides;
}

// ─── Per-state anchor-drag helpers ─────────────────────────────────

function mergeAnchorTJunctionGuides(app, anchorPos, anchorGuides) {
    if (!(app.drag.tjLinks && app.drag.tjLinks.length > 0)) return anchorPos;
    let mergedAnchorPos = anchorPos;
    for (const link of app.drag.tjLinks) {
        const tjResult = computeAnchorCollinearSnap(app, link.otherWire, link.otherNodeId, mergedAnchorPos);
        if (tjResult.anchorPos.x !== mergedAnchorPos.x || tjResult.anchorPos.y !== mergedAnchorPos.y)
            mergedAnchorPos = tjResult.anchorPos;
        if (tjResult.guides.length > 0) anchorGuides.push(...tjResult.guides);
    }
    return mergedAnchorPos;
}

function syncAnchorDragLinkedNodes(app, anchorPos) {
    if (app.drag.tjLinks) {
        for (const link of app.drag.tjLinks) {
            const p = link.otherWire.nodes.get(link.otherNodeId);
            if (p) { p.x = anchorPos.x; p.y = anchorPos.y; link.otherWire.invalidate(); }
        }
    }
    if (app.drag.ncLinks) {
        for (const link of app.drag.ncLinks) {
            link.nc.x = anchorPos.x; link.nc.y = anchorPos.y; link.nc.invalidate();
        }
    }
}

// ─── Per-state segment-drag helpers ────────────────────────────────

function getDragTJunctionWireSet(app) {
    const wires = getReusableSet(app, '_dragTJunctionWireSetScratch');
    if (app.drag.tjLinks) {
        for (const link of app.drag.tjLinks) wires.add(link.otherWire);
    }
    return wires;
}

function collectWireSegmentDragGuides(app, wire, dragEdgeId, snappedTarget, baseGuides) {
    const allGuides = app._segmentDragGuidesScratch || (app._segmentDragGuidesScratch = []);
    allGuides.length = 0;
    if (baseGuides && baseGuides.length > 0) allGuides.push(...baseGuides);
    if (!app.drag.tjLinks) return allGuides;
    const edge = wire.edges.get(dragEdgeId);
    if (!edge) return allGuides;
    const fromPos = wire.nodes.get(edge.from);
    if (!fromPos) return allGuides;
    for (const link of app.drag.tjLinks) {
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
    if (app.drag.tjLinks) {
        for (const link of app.drag.tjLinks) {
            if (!movedNodes.has(link.wireNodeId)) continue;
            const sp = link.otherWire.nodes.get(link.otherNodeId);
            if (sp) { sp.x += dx; sp.y += dy; link.otherWire.invalidate(); }
        }
    }
    if (app.drag.ncLinks) {
        for (const link of app.drag.ncLinks) {
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
export const idleState = {
    mousedown(app, event, { screenPos, worldPos, snapped }) {
        if (event.button !== 0) return;

        activateHomeTabIfFileTabOpen(app);

        // Commit lingering anchor drag from a previous interaction
        if (app.drag && app.drag.mode === 'anchor' && app.drag.beforeState
            && (app.didDrag || (app.drag.wireStates && app.drag.wireStates.size > 0))) {
            commitAnchorDrag(app, app.drag.shape, app.drag.beforeState, app.drag.wireStates, app.drag.ncLinks, app.drag.junctionBeforeWireStates, app.drag.junctionBeforeLabelTextStates);
            finalizeDragInteraction(app);
            app.didDrag = true;
            event.preventDefault();
            return;
        }

        app.didDrag = false;
        if (app.pendingAnchorDrag && !app.drag) app.pendingAnchorDrag = null;

        // Anchor drag on selected shapes
        const selectedShapes = app.selection.getSelection();
        for (const shape of selectedShapes) {
            if (shape.locked) continue;
            const anchorId = shape.hitTestAnchor(worldPos, app.viewport.scale);
            if (!anchorId) continue;

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
                const beforeState = app._captureShapeState(shape);
                const newAnchorId = shape.moveAnchor(anchorId, snapped.x, snapped.y);
                app.renderShapes(true);
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
            // Ctrl/Cmd: add to selection if unselected, cycle stacked if already selected
            if (isAdditiveSelectionModifier(event)) {
                if (hitShape.selected) {
                    const nextShape = getNextCycleHitShape(app, worldPos);
                    if (nextShape) selectOnlyShapeAndRender(app, nextShape);
                } else {
                    app.selection.toggle(hitShape);
                    app.renderShapes(true);
                }
                app.skipClickSelection = true;
                event.preventDefault();
                return;
            }

            if (!hitShape.selected) {
                app.selection.select(hitShape, false);
                app.renderShapes(true);
            }

            if (hitShape.locked) { event.preventDefault(); return; }

            // Wire segment drag
            if (tryBeginWireSegmentDrag(app, hitShape, worldPos)) {
                event.preventDefault();
                return;
            }

            // Move drag
            const firstShape = app.selection.getSelection()[0];
            const dragObjectStartPos = firstShape ? firstShape.getPosition() : { ...snapped };
            beginMoveDragSession(app, worldPos, dragObjectStartPos);
            // Bridge pin-connected wire nodes ONCE so pins can move freely
            bridgeStickyPinNodes(app, collectMovingComponentIds(app.selection.getSelection()));
            app.viewport.svg.style.cursor = 'move';
            app.renderShapes(true);
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
        if (app.pendingAnchorDrag && !app.drag) {
            if (promotePendingAnchorDragSession(app, screenPos)) return;
        }
    },

    mouseup(app, event, { worldPos, snapped }) {
        if (event.button !== 0) return;
    },

    click(app, event, { worldPos }) {
        if (app.viewport.isPanning) return;
        if (app.skipClickSelection) { app.skipClickSelection = false; return; }
        if (app.didDrag) { app.didDrag = false; return; }

        // If a non-Home ribbon tab is showing, switch back to Home
        const activeTab = (document.getElementById('ribbonSchematic') || document).querySelector('.ribbon-tab.active');
        if (activeTab instanceof HTMLElement && activeTab.dataset.tab !== 'home') {
            app._setActiveRibbonTab('home');
        }

        const hit = app.selection.hitTest(worldPos);
        if (app.textEdit) {
            if (!hit || hit !== app.textEdit.shape) app._endTextEdit(true);
        }
        app.selection.handleClick(worldPos, isAdditiveSelectionModifier(event));
        app.renderShapes(true);
    },

    dblclick(app, event, { screenPos, worldPos }) {
        const hit = app.selection.hitTest(worldPos);
        if (hit && hit.supportsInlineEdit) {
            app.selection.select(hit, false);
            app.renderShapes(true);
            app.pendingAnchorDrag = null;
            app._startTextEdit(hit);
            app._setTextEditCaretFromScreen(screenPos);
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
        app.didDrag = false;

        // Paste/component placement
        if (app.pastingClipboard) {
            app._confirmPaste(snapped);
            event.preventDefault();
            return;
        }
        if (app.placingComponent) {
            app._placeComponent(snapped);
            event.preventDefault();
            return;
        }

        const tool = app.currentTool;

        if (tool === 'wire') {
            // Deselect everything
            for (const shape of app.shapes) { if (shape.selected) { shape.selected = false; shape.invalidate(); } }
            for (const component of app.components) { if (component.selected) { component.selected = false; component.invalidate(); } }
            app.selection.clearSelection();
            app.renderShapes(true);
            const snap = resolveWireSnapPosition(app, worldPos, { pinTolerance: 0.5 });
            app._startWireDrawing({ x: snap.x, y: snap.y, snapPin: snap.snapPin || null });
            app.interactionState = 'drawing';
            event.preventDefault();
            return;
        }

        if (tool === 'line') {
            if (!app.isDrawing) { app._startDrawing(snapped); app.interactionState = 'drawing'; }
            else app._addLinePoint(snapped);
            return;
        }

        if (tool === 'polygon') {
            if (!app.isDrawing) { app._startDrawing(snapped); app.interactionState = 'drawing'; }
            else app._addPolygonPoint(snapped);
            return;
        }

        if (tool === 'arc') {
            if (!app.isDrawing) {
                app._startDrawing(snapped);
                app.interactionState = 'drawing';
            } else if (!app.arcEndpoint) {
                app.arcEndpoint = { x: snapped.x, y: snapped.y };
                app.drawCurrent = { x: snapped.x, y: snapped.y };
                app._updateDrawing(app.drawCurrent);
            } else {
                app._updateDrawing(worldPos);
                app._finishDrawing(worldPos);
                app._setToolCursor(app.currentTool, app.viewport.svg);
                app.interactionState = 'toolActive';
            }
            return;
        }

        if (tool === 'rect' || tool === 'circle') {
            if (!app.isDrawing) { app._startDrawing(snapped); app.interactionState = 'drawing'; }
            else { app._finishDrawing(snapped); app.interactionState = 'toolActive'; }
            return;
        }

        if (tool === 'noconnect' || tool === 'net') {
            const { resolved, pos } = resolvePinSnapPlacement(app, worldPos);
            app._drawSnapResult = resolved;
            if (!app.isDrawing) { app._startDrawing(pos); }
            else { app._finishDrawing(pos); }
            updateToolGhost(app, pos);
            return;
        }

        if (tool === 'text') {
            const attach = resolveLabelAttachTarget(app, worldPos);
            const placePos = attach ? attach.snapPos : snapped;
            const shape = new Text({
                x: placePos.x,
                y: placePos.y,
                text: '',
                fontSize: app.toolOptions.fontSize || 2.0,
                color: app.toolOptions.textColor,
                fillColor: app.toolOptions.textColor
            });
            attachLabelToTarget(shape, attach?.target || null, attach?.snapPos || null, { isNewLabel: true });
            app.addShape(shape);
            app._startTextEdit?.(shape);
            app.interactionState = 'toolActive';
            app.renderShapes(true);
            event.preventDefault();
            return;
        }

        // Default fallback
        if (!app.isDrawing) { app._startDrawing(snapped); app.interactionState = 'drawing'; }
        else { app._finishDrawing(snapped); app.interactionState = 'toolActive'; }
    },

    mousemove(app, event, { screenPos, worldPos, snapped }) {
        handleComponentTooltipMouseMove(app, worldPos, screenPos);

        // Placement previews
        if (app.pastingClipboard) app._updatePastePreview(snapped);
        if (app.placingComponent) app._updateComponentPreview(snapped);

        const tool = app.currentTool;

        // Wire tool hover (not drawing)
        if (tool === 'wire') {
            updateSnapHighlight(app, resolveWireSnapPosition(app, worldPos, { pinTolerance: 0.5 }));
            updateToolCrosshair(app, snapped, screenPos);
            return;
        }

        // Pin-snap tool hover
        if (tool === 'noconnect' || tool === 'net') {
            const { resolved, pos } = resolvePinSnapPlacement(app, worldPos);
            updateSnapHighlight(app, resolved);
            updateToolGhost(app, pos);
        }

        if (tool === 'component' && !app.placingComponent) {
            app._hideCrosshair();
            return;
        }

        if (tool === 'text') {
            const attach = resolveLabelAttachTarget(app, worldPos);
            updateSnapHighlight(app, attach ? { x: attach.snapPos.x, y: attach.snapPos.y, type: 'attach' } : null);
        }

        updateToolCrosshair(app, snapped, screenPos);
    },

    mouseup(app, event, { worldPos, snapped }) {
        if (event.button !== 0) return;
    },

    rightclick(app, event, { screenPos, worldPos }) {
        handleComponentTooltipContextMenu(app, worldPos, screenPos);
        app._setToolCursor(app.currentTool, app.viewport.svg);
    }
};

/**
 * drawing — actively drawing a shape (wire/line/rect/circle/arc/polygon).
 */
export const drawingState = {
    mousedown(app, event, { screenPos, worldPos, snapped }) {
        if (event.button !== 0) return;

        activateHomeTabIfFileTabOpen(app);

        const tool = app.currentTool;

        if (tool === 'wire') {
            if (!app.drawCurrent) return;
            let waypointPos = { x: app.drawCurrent.x, y: app.drawCurrent.y };
            if (app._wireJunctionDot && app._wireJunctionData) {
                waypointPos = { x: app._wireJunctionData.x, y: app._wireJunctionData.y };
                app.drawCurrent = { ...waypointPos };
            }
            if (app.drawCorner) {
                app._addWireWaypoint({ x: app.drawCorner.x, y: app.drawCorner.y, snapPin: null });
            }
            app._addWireWaypoint({ ...waypointPos, snapPin: app.lastSnappedData?.snapPin || null });
            if (app.wirePoints.length >= 2 && (app.lastSnappedData?.snapPin || app._wireJunctionDot)) {
                app._finishWireDrawing(app.lastSnappedData);
                app.interactionState = 'toolActive';
            }
            event.preventDefault();
            return;
        }

        if (tool === 'line') { app._addLinePoint(snapped); return; }
        if (tool === 'polygon') { app._addPolygonPoint(snapped); return; }

        if (tool === 'arc') {
            if (!app.arcEndpoint) {
                app.arcEndpoint = { x: snapped.x, y: snapped.y };
                app.drawCurrent = { x: snapped.x, y: snapped.y };
                app._updateDrawing(app.drawCurrent);
            } else {
                app._updateDrawing(worldPos);
                app._finishDrawing(worldPos);
                app._setToolCursor(app.currentTool, app.viewport.svg);
                app.interactionState = 'toolActive';
            }
            return;
        }

        if (tool === 'rect' || tool === 'circle') {
            app._finishDrawing(snapped);
            app.interactionState = 'toolActive';
            return;
        }

        if (tool === 'noconnect' || tool === 'net') {
            const { resolved, pos } = resolvePinSnapPlacement(app, worldPos);
            app._drawSnapResult = resolved;
            app._finishDrawing(pos);
            updateToolGhost(app, pos);
            // Stay in toolActive — these are click-to-place
            app.interactionState = 'toolActive';
            return;
        }

        // Default: finish drawing
        app._finishDrawing(snapped);
        app.interactionState = 'toolActive';
    },

    mousemove(app, event, { screenPos, worldPos, snapped }) {
        handleComponentTooltipMouseMove(app, worldPos, screenPos);

        if (app.pastingClipboard) app._updatePastePreview(snapped);
        if (app.placingComponent) app._updateComponentPreview(snapped);

        const tool = app.currentTool;

        if (tool === 'wire') {
            app._updateWireDrawing(worldPos);
            updateToolCrosshair(app, snapped, screenPos);
            return;
        }

        if (tool === 'noconnect' || tool === 'net') {
            const { resolved, pos } = resolvePinSnapPlacement(app, worldPos);
            updateSnapHighlight(app, resolved);
            updateToolGhost(app, pos);
        }

        if (tool === 'arc') {
            app._updateDrawing(app.arcEndpoint ? worldPos : snapped);
        } else if (DRAWING_TOOLS.has(tool)) {
            app._updateDrawing(snapped);
        }

        updateToolCrosshair(app, snapped, screenPos);
    },

    /**
     * Right-click in place (no pan) — finish multi-point drawing tools.
     * Dispatched by mouse.js via contextmenu when movement < threshold.
     */
    rightclick(app, event, { worldPos, snapped }) {
        const tool = app.currentTool;
        let handled = false;
        if (tool === 'wire' && app.wirePoints?.length >= 1) {
            app._finishWireDrawing(app.drawCurrent || worldPos);
            handled = true;
        } else if (tool === 'arc' && app.arcEndpoint) {
            app._updateDrawing(worldPos);
            app._finishDrawing(worldPos);
            handled = true;
        } else if (tool === 'line') {
            app._addLinePoint(snapped);
            app._finishLine();
            handled = true;
        } else if (tool === 'polygon') {
            app._addPolygonPoint(snapped);
            app._finishPolygon();
            handled = true;
        } else if (tool === 'rect' || tool === 'circle') {
            app._finishDrawing(snapped);
            handled = true;
        }
        if (handled) {
            app._setToolCursor(app.currentTool, app.viewport.svg);
            app.interactionState = 'toolActive';
        }
    },

    mouseup(app, event, { worldPos, snapped }) {
        if (event.button !== 0) return;

        const tool = app.currentTool;
        // Don't auto-finish multi-click tools on mouseup
        if (tool === 'line' || tool === 'polygon' || tool === 'wire' || CLICK_TO_END_TOOLS.has(tool)) return;

        if (app.isDrawing) {
            app._finishDrawing(snapped);
            app.interactionState = 'toolActive';
        }
    },

    dblclick(app, event, pos) {
        const tool = app.currentTool;
        let handled = false;
        if (tool === 'wire' && app.wirePoints?.length >= 1) {
            app._finishWireDrawing(app.drawCurrent);
            handled = true;
        } else if (tool === 'line') {
            app._finishLine();
            handled = true;
        } else if (tool === 'polygon') {
            app._finishPolygon();
            handled = true;
        } else if (app.isDrawing && app.drawCurrent) {
            app._finishDrawing(app.drawCurrent);
            handled = true;
        }
        if (handled) app.interactionState = 'toolActive';
    },

    // Note: drawing state's rightclick handler (for finishing) is defined above.
    // This is the tooltip handler for drawing state right-click.
};

/**
 * moveDrag — dragging selected shapes.
 */
export const moveDragState = {
    mousemove(app, event, { worldPos }) {
        if (app.viewport.isPanning) return;

        const selNow = app.selection.getSelection();
        const isDraggingText = selNow.length === 1 && selNow[0]?.type === 'text';
        const isGenericLabel = isDraggingText && selNow[0].fieldKey === 'label';
        if (isGenericLabel) {
            const labelShape = selNow[0];
            const hotspot = getLabelDropHotspot(labelShape, worldPos);
            const attach = resolveLabelAttachTarget(app, hotspot, labelShape);
            updateSnapHighlight(app, attach ? { x: attach.snapPos.x, y: attach.snapPos.y, type: 'attach' } : null);
            updateLabelDragGuide(app, labelShape);

            // Track hover target for invalidation
            const newTarget = attach?.target || null;
            const oldTarget = app._labelDragHoverTarget || null;
            if (newTarget !== oldTarget) {
                if (oldTarget) oldTarget.invalidate?.();
                if (labelShape.parentComponent && labelShape.parentComponent !== oldTarget) labelShape.parentComponent.invalidate?.();
                if (newTarget) newTarget.invalidate?.();
                app._labelDragHoverTarget = newTarget;
            }
        } else if (isDraggingText && selNow[0].parentComponent) {
            // Ref/value fields: show guide line but no attachment re-targeting
            updateLabelDragGuide(app, selNow[0]);
        } else {
            updateLabelDragGuide(app, null);
            app._labelDragHoverTarget = null;
        }

        const mouseDelta = { x: worldPos.x - app.drag.startWorldPos.x, y: worldPos.y - app.drag.startWorldPos.y };
        const targetPos = { x: app.drag.objectStartPos.x + mouseDelta.x, y: app.drag.objectStartPos.y + mouseDelta.y };
        const sel = app.selection.getSelection();
        const movingCompIds = collectMovingComponentIds(sel);
        const snappedTarget = app._moveDragSnappedTarget || (app._moveDragSnappedTarget = { x: 0, y: 0 });
        const stickyGuides = resolveMoveDragTarget(app, targetPos, sel, movingCompIds, snappedTarget);

        const dx = snappedTarget.x - app.drag.lastSnapped.x;
        const dy = snappedTarget.y - app.drag.lastSnapped.y;

        if (dx !== 0 || dy !== 0) {
            app.didDrag = true;
            app.drag.totalDx += dx;
            app.drag.totalDy += dy;

            for (const shape of sel) {
                if (shape.locked) continue;
                if (shape.parentComponent && movingCompIds.has(shape.parentComponent.id)) continue;
                shape.move(dx, dy);

                for (const maybeLabel of app.shapes) {
                    if (maybeLabel?.type !== 'text') continue;
                    if (maybeLabel.parentComponent !== shape || maybeLabel.fieldKey !== 'label') continue;
                    maybeLabel.move(dx, dy);
                }
            }
            if (movingCompIds.size > 0) {
                updateStickyWires(app);
                renderGuideLines(app, stickyGuides);
            }
            propagateMovedWireJunctions(app, sel, dx, dy);
            app.drag.lastSnapped.x = snappedTarget.x;
            app.drag.lastSnapped.y = snappedTarget.y;
            app.renderShapes(false);
            if (app.textEdit) app._updateTextEditOverlay?.();
            app.fileManager.setDirty(true);
        }
    },

    mouseup(app, event, { worldPos }) {
        if (event.button !== 0) return;

        const sel = app.selection.getSelection();
        const isGenericLabel = sel.length === 1 && sel[0]?.type === 'text' && sel[0].fieldKey === 'label';
        if (isGenericLabel) {
            const labelShape = sel[0];
            const oldParent = labelShape.parentComponent;
            const hotspot = getLabelDropHotspot(labelShape, worldPos);
            const attach = resolveLabelAttachTarget(app, hotspot, labelShape);
            if (attach?.target) {
                attachLabelToTarget(labelShape, attach.target, attach.snapPos || null, { isNewLabel: false });
            } else if (labelShape.parentComponent && labelShape.fieldKey === 'label') {
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
    mousemove(app, event, { worldPos, snapped }) {
        if (app.viewport.isPanning) return;

        app.didDrag = true;
        app.drag.shape.selected = true;

        const snapMode = app.drag.shape.getAnchorSnapMode(app.drag.anchorId);
        let anchorPos = snapMode === 'none' ? worldPos : snapped;

        if (app.drag.shape.type === 'noconnect') {
            const snap = resolveWireSnapPosition(app, worldPos, { pinTolerance: PIN_SNAP_TOL });
            updateSnapHighlight(app, snap);
            anchorPos = { x: snap.x, y: snap.y };
        }

        let anchorGuides = [];
        if (app.drag.shape.type === 'wire') {
            const isLeaf = app.drag.shape.nodes.has(app.drag.anchorId) && app.drag.shape.degree(app.drag.anchorId) <= 1;

            if (app.drag.excludePin?.worldPos) {
                const excludedPin = app.drag.excludePin.worldPos;
                if (Math.hypot(worldPos.x - excludedPin.x, worldPos.y - excludedPin.y) > PIN_SNAP_TOL)
                    app.drag.excludePin = null;
            }

            let snappedToTarget = false;
            if (isLeaf) {
                const snap = resolveWireSnapPosition(app, worldPos, {
                    excludeNode: { wire: app.drag.shape, nodeId: app.drag.anchorId },
                    excludePin: app.drag.excludePin || null,
                    pinTolerance: PIN_SNAP_TOL
                });
                anchorPos = { x: snap.x, y: snap.y };
                snappedToTarget = snap.snapType === 'pin' || snap.snapType === 'endpoint' || snap.snapType === 'segment';
                if (snappedToTarget) updateSnapHighlight(app, snap);
            }

            if (!snappedToTarget) {
                updateSnapHighlight(app, null);
                const neighbors = app.drag.shape.neighborNodes(app.drag.anchorId)
                    .map(nid => app.drag.shape.nodes.get(nid)).filter(Boolean);
                applyOffGridNeighborSnap(worldPos, anchorPos, neighbors, app.viewport.gridSize || 1.0);
                const collinearSnap = computeAnchorCollinearSnap(app, app.drag.shape, app.drag.anchorId, anchorPos);
                anchorPos = collinearSnap.anchorPos;
                anchorGuides = collinearSnap.guides;
            }
        }

        app._updateCrosshair(anchorPos);
        anchorPos = mergeAnchorTJunctionGuides(app, anchorPos, anchorGuides);
        renderGuideLines(app, anchorGuides);

        const newAnchorId = app.drag.shape.moveAnchor(app.drag.anchorId, anchorPos.x, anchorPos.y);
        if (newAnchorId && newAnchorId !== app.drag.anchorId) app.drag.anchorId = newAnchorId;
        syncAnchorDragLinkedNodes(app, anchorPos);
        app.renderShapes(false);
        if (app.textEdit) app._updateTextEditOverlay?.();
        app.fileManager.setDirty(true);
    },

    mouseup(app, event) {
        if (event.button !== 0) return;
        handleDragEnd(app);
    }
};

/**
 * segmentDrag — dragging a wire segment.
 */
export const segmentDragState = {
    mousemove(app, event, { worldPos }) {
        if (app.viewport.isPanning) return;

        const wire = app.drag.shape;
        const dragEdgeId = app.drag.edgeId;

        const mouseDelta = getReusablePoint(app, '_dragSegmentMouseDeltaScratch');
        mouseDelta.x = worldPos.x - app.drag.startWorldPos.x;
        mouseDelta.y = worldPos.y - app.drag.startWorldPos.y;
        if (app.drag.axis === 'vertical') mouseDelta.x = 0;
        else if (app.drag.axis === 'horizontal') mouseDelta.y = 0;

        const origState = app.drag.workingState || app.drag.wireStates.get(wire);
        const origEdge = origState.edges[dragEdgeId];
        const refPt = origEdge ? origState.nodes[origEdge.from] : null;
        if (!refPt) return;

        const target = getReusablePoint(app, '_dragSegmentTargetScratch');
        target.x = refPt.x + mouseDelta.x;
        target.y = refPt.y + mouseDelta.y;

        const tJunctionWires = getDragTJunctionWireSet(app);
        const { snappedTarget, guides: segGuides, highlight: segHighlight } =
            computeSegmentDragSnap(app, wire, dragEdgeId, origState, target, app.drag.axis, tJunctionWires);
        updateSnapHighlight(app, segHighlight);

        const allSegGuides = collectWireSegmentDragGuides(app, wire, dragEdgeId, snappedTarget, segGuides);
        renderGuideLines(app, allSegGuides);

        const curFromPos = wire.nodes.get(origEdge.from);
        const dx = snappedTarget.x - (curFromPos ? curFromPos.x : refPt.x);
        const dy = snappedTarget.y - (curFromPos ? curFromPos.y : refPt.y);

        if (dx !== 0 || dy !== 0) {
            app.didDrag = true;
            app.drag.totalDx += dx;
            app.drag.totalDy += dy;
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
        app.didDrag = true;
        app._updateBoxSelectElement(worldPos);
        const bounds = app._getBoxSelectBounds(worldPos);
        app.selection.syncBoxSelection(bounds, !!app.drag.additive, 'contain');
        app.renderShapes(false);
    },

    mouseup(app, event, { worldPos }) {
        if (event.button !== 0) return;

        const bounds = app._getBoxSelectBounds(worldPos);
        app._removeBoxSelectElement();
        if (app.didDrag) {
            app.selection.syncBoxSelection(bounds, !!app.drag?.additive, 'contain');
            app.selection._notifySelectionChanged();
            app.renderShapes(true);
        }

        app.drag = null;
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

        if (app.pastingClipboard) {
            app._confirmPaste(snapped);
            event.preventDefault();
            return;
        }
        if (app.placingComponent) {
            app._placeComponent(snapped);
            event.preventDefault();
            return;
        }
    },

    mousemove(app, event, { screenPos, worldPos, snapped }) {
        if (app.pastingClipboard) app._updatePastePreview(snapped);
        if (app.placingComponent) app._updateComponentPreview(snapped);
        updateToolCrosshair(app, snapped, screenPos);
    }
};

// ─── State table ───────────────────────────────────────────────────

export const STATE_TABLE = {
    idle: idleState,
    toolActive: toolActiveState,
    drawing: drawingState,
    moveDrag: moveDragState,
    anchorDrag: anchorDragState,
    segmentDrag: segmentDragState,
    boxSelect: boxSelectState,
    placing: placingState
};
