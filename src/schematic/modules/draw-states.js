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
 *
 * Starting and running drags is drag-gestures.js, and where a component being placed
 * or dragged lands is component-snap.js.
 */
import { updateStickyWires } from './wire-reconcile.js';
import { updateSnapHighlight, VERTEX_EPSILON } from './wire.js';
import { resolveWireSnapPosition, SNAP_SCREEN_PX, PIN_SNAP_TOL } from './wire-snap.js';
import { computeAnchorCollinearSnap, computeSegmentDragSnap, applyOffGridNeighborSnap } from './wire-drag-snap.js';
import { renderGuideLines } from '../../shapes/axis-glow.js';
import { clearPendingAnchorDrag, getPendingAnchorDrag, getSchematicDrag, setSchematicDrag, captureMoveDragStates } from './drag.js';
import { detectTJunction, showAnchorContextMenu, showSegmentContextMenu, showLabelContextMenu, showComponentContextMenu } from './context-menu.js';
import { hasAny3DModel } from '../../components/model3d-source.js';
import { attachLabelToTarget, refreshLabelAttachmentOffset, getLabelDropHotspot } from './label-attachment.js';
import { findJoinTarget, isJoinable } from '../../shapes/shape-join.js';
import { tryBeginPolylineSegmentDrag, updatePolylineSegmentDrag } from './polyline-segment-drag.js';
import { refreshComponentPose, removeShapeSegmentSelectionElement } from './schematic-view.js';
import { snapShapePoint, snapShapeBulge, renderShapeAlignment, shapeContinuationConstraints } from './shape-snap.js';
import { refinePathSegment } from '../../shapes/path-interaction.js';
import { isCulled } from './schematic-view.js';
import { findInlineEditableHit, isUnmodifiedPrimaryDoublePress } from '../../shared/ui/inline-edit-activation.js';
import { getBoxSelectBounds, updateBoxSelectElement } from '../../shared/ui/box-selection.js';
import { confirmPaste, updatePastePreview } from './clipboard.js';
import { findComponentAt, getPlacingComponent, isComponentCodeTooltipPinned, pinComponentCodeTooltip, placeComponent, updateComponentPreview } from './components.js';
import { captureShapeState } from './selection.js';
import { getShapeSegmentFocus, setShapeNodeFocus, setShapeSegmentFocus } from './shape-focus.js';
import { isSchematicLocked } from '../../shapes/lock-owner.js';
import {
    finishSchematicDrawAtPointer, finishSchematicDrawInPlace, moveSchematicTool, pressSchematicTool,
    pressSchematicToolDrawing, releaseSchematicTool,
} from './schematic-tools.js';
import { getSchematicTextEdit } from './text-edit.js';
import { isPastingClipboard } from './clipboard.js';
import { isSchematicDrawingActive } from './drawing.js';
import { getSchematicInteraction, setSchematicInteraction } from './schematic-interactions.js';
import { applyWireSegmentLabelMovement, applyWireSegmentNodeMovement, beginBoxSelectSession, beginSelectionMove, canQueueMidpointAnchorDrag, collectMovingComponentIds, collectWireSegmentDragGuides, getDragTJunctionWireSet, getMoveDragSnappedTarget, getReusablePoint, handleDragEnd, mergeAnchorTJunctionGuides, movableSelection, promotePendingAnchorDragSession, propagateMovedWireJunctions, propagateWireSegmentLinkedMovement, queuePendingAnchorDrag, resolveMoveDragTarget, syncAnchorDragLinkedNodes, tryBeginWireSegmentDrag } from './drag-gestures.js';
import { resolveDraggingComponentSnap, resolvePinSnapPlacement, resolvePlacingComponentSnap } from './component-snap.js';
import { isComponentItem, isNetItem, isTextItem, isWireItem, isPolylineItem, isGraphItem as isGraphShape } from '../../core/schematic-items.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/Viewport.js').Viewport} Viewport */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {import('../../shapes/net.js').Net} Net */
/** @typedef {import('../../shapes/polyline.js').Polyline} Polyline */
/** @typedef {import('../../shapes/text.js').Text} Text */
/** @typedef {import('../../shapes/wire.js').Wire} Wire */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{screenPos: Point, worldPos: Point, snapped: Point}} EventPositions */
/** @typedef {{shape: Polyline, edgeId: string|null, hadSegment?: boolean}} ShapeSegmentToggle */
/** @typedef {{positions: EventPositions, additive: boolean}} OverlapCyclePress */
/** @typedef {{drawSnapResult: any, pendingShapeSegmentToggle: ShapeSegmentToggle|null, didDrag: boolean, skipClickSelection: boolean}} DrawStateData */
/** @typedef {{mousedown?: (app: SchematicEditor, event: MouseEvent, positions: EventPositions) => void, mousemove?: (app: SchematicEditor, event: MouseEvent, positions: EventPositions) => void, mouseup?: (app: SchematicEditor, event: MouseEvent, positions: EventPositions) => void, click?: (app: SchematicEditor, event: MouseEvent, positions: EventPositions) => void, dblclick?: (app: SchematicEditor, event: MouseEvent, positions: EventPositions) => void, rightclick?: (app: SchematicEditor, event: MouseEvent, positions: EventPositions) => void, contextmenu?: (app: SchematicEditor, event: MouseEvent, positions: EventPositions) => void}} DrawInteractionState */

// ─── Constants ─────────────────────────────────────────────────────

export const DRAG_THRESHOLD_PX = 3;
/** @type {WeakMap<SchematicEditor, DrawStateData>} */
const drawStates = new WeakMap();
/** @param {SchematicItem} item @returns {item is Component} */
const isComponentWithPins = item => isComponentItem(item) && Array.isArray(item.symbol?.pins);
/** @param {SchematicEditor} app @returns {DrawStateData} */
function stateFor(app) {
    let state = drawStates.get(app);
    if (!state) {
        state = {
            drawSnapResult: null,
            pendingShapeSegmentToggle: null,
            didDrag: false,
            skipClickSelection: false,
        };
        drawStates.set(app, state);
    }
    return state;
}

/**
 * @param {SchematicEditor} app
 * @param {any} result
 */
export function setDrawSnapResult(app, result) {
    stateFor(app).drawSnapResult = result;
}

/** @param {SchematicEditor} app @returns {any} */
export function takeDrawSnapResult(app) {
    const state = stateFor(app);
    const result = state.drawSnapResult;
    state.drawSnapResult = null;
    return result;
}

/** @param {SchematicEditor} app */
export function clearOverlapCyclePress(app) {
    setSchematicInteraction(app, 'overlapCyclePress', null);
}

/** @param {SchematicEditor} app @returns {OverlapCyclePress|null} */
export function getOverlapCyclePress(app) {
    return getSchematicInteraction(app, 'overlapCyclePress');
}

/** @param {SchematicEditor} app */
export function hasOverlapCyclePress(app) {
    return !!getOverlapCyclePress(app);
}

/**
 * @param {SchematicEditor} app
 * @param {OverlapCyclePress|null} press
 */
export function setOverlapCyclePress(app, press) {
    setSchematicInteraction(app, 'overlapCyclePress', press);
}

/** @param {SchematicEditor} app */
export function cancelOverlapCyclePress(app) {
    if (app.interactionState !== 'overlapCycle') return false;
    clearOverlapCyclePress(app);
    app.interactionState = 'idle';
    setSkipClickSelection(app, true);
    return true;
}

/** @param {SchematicEditor} app */
export function getDidSchematicDrag(app) {
    return !!stateFor(app).didDrag;
}

/**
 * @param {SchematicEditor} app
 * @param {boolean} value
 */
export function setDidSchematicDrag(app, value) {
    stateFor(app).didDrag = !!value;
}

/** @param {SchematicEditor} app */
export function getSkipClickSelection(app) {
    return !!stateFor(app).skipClickSelection;
}

/**
 * @param {SchematicEditor} app
 * @param {boolean} value
 */
export function setSkipClickSelection(app, value) {
    stateFor(app).skipClickSelection = !!value;
}

/** @param {SchematicEditor} app */
export function clearPendingShapeSegmentToggle(app) {
    stateFor(app).pendingShapeSegmentToggle = null;
}

/** @param {SchematicEditor} app */
export function hasPendingShapeSegmentToggle(app) {
    return !!stateFor(app).pendingShapeSegmentToggle;
}

/** @param {SchematicEditor} app @returns {ShapeSegmentToggle|null} */
export function getPendingShapeSegmentToggle(app) {
    return stateFor(app).pendingShapeSegmentToggle;
}

/**
 * @param {SchematicEditor} app
 * @param {ShapeSegmentToggle|null} toggle
 */
export function setPendingShapeSegmentToggle(app, toggle) {
    stateFor(app).pendingShapeSegmentToggle = toggle;
}

// ─── State transition ──────────────────────────────────────────────

/**
 * Determine current state from legacy app flags.
 * Used as initialization and safety-net fallback.
 * @param {SchematicEditor} app
 * @returns {InteractionState}
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

/**
 * @param {MouseEvent} e
 * @param {Viewport} viewport
 * @returns {EventPositions}
 */
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

/** @param {MouseEvent} event */
function isAdditiveSelectionModifier(event) {
    return !!(event?.ctrlKey || event?.metaKey);
}

/** @param {SchematicEditor} app */
function activateHomeTabIfFileTabOpen(app) {
    const ribbonEl = document.getElementById('ribbonSchematic');
    const activeTab = ribbonEl?.querySelector('.ribbon-tab.active') || document.querySelector('.ribbon-tab.active');
    if (activeTab instanceof HTMLElement && activeTab.dataset?.tab === 'file') {
        app.setActiveRibbonTab('home');
    }
}

/**
 * @param {SchematicEditor} app
 * @param {SchematicItem} shape
 */
function selectOnlyShapeAndRender(app, shape) {
    app.selection.clearSelection();
    app.selection.select(shape, false);
    app.renderShapes(true);
}

/**
 * @param {SchematicEditor} app
 * @param {SchematicItem} shape
 */
function selectContextTargetShape(app, shape) {
    if (!app.selection.isSelected(shape)) {
        selectOnlyShapeAndRender(app, shape);
    }
    app.selection.keepSelected(shape);
}

/**
 * @param {SchematicEditor} app
 * @param {Point} snapped
 * @param {Point} screenPos
 */
export function updateToolCrosshair(app, snapped, screenPos) {
    app.showCrosshair();
    /** @type {(snapped: Point, screenPos: Point) => void} */ (app.updateCrosshair)(snapped, screenPos);
}

/**
 * @param {SchematicEditor} app
 * @param {Point} point
 * @param {EventTarget|null} eventTarget
 * @returns {SchematicItem|null}
 */
function findSchematicInlineEditableHit(app, point, eventTarget) {
    return /** @type {SchematicItem|null} */ (
        (/** @type {(selection: typeof app.selection, point: Point, eventTarget: EventTarget|null) => unknown} */ (findInlineEditableHit))
            (app.selection, point, eventTarget)
    );
}

/**
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {Point} screenPos
 */
function handleComponentTooltipContextMenu(app, worldPos, screenPos) {
    if (app.showComponentDebugTooltip === false) return;
    const hitComponent = findComponentAt(app, worldPos);
    if (hitComponent) pinComponentCodeTooltip(app, hitComponent, screenPos);
    else app.updateComponentCodeTooltip(null, null, { forceHide: true });
}

/**
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {Point} screenPos
 */
function handleComponentTooltipMouseMove(app, worldPos, screenPos) {
    const canShow = app.showComponentDebugTooltip !== false
        && !getSchematicDrag(app) && !app.viewport.isPanning
        && !getPlacingComponent(app) && !isComponentCodeTooltipPinned(app);
    if (canShow) {
        const hit = findComponentAt(app, worldPos);
        app.updateComponentCodeTooltip(hit, screenPos);
        return;
    }
    if (!isComponentCodeTooltipPinned(app)) {
        app.updateComponentCodeTooltip(null, screenPos);
    }
}

// ─── Context menu helpers ──────────────────────────────────────────

/**
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {number} clientX
 * @param {number} clientY
 */
function handleAnchorContextMenu(app, worldPos, clientX, clientY) {
    const selectedShapes = app.selection.getSelection();
    for (const shape of selectedShapes) {
        if (isSchematicLocked(shape)) continue;
        const anchorId = shape.hitTestAnchor(worldPos, app.viewport.scale);
        if (anchorId && !anchorId.startsWith('mid')) {
            let canDeletePoint = false;
            if (isGraphShape(shape)) {
                // Graph-based shape (wire, line, polygon, rect)
                canDeletePoint = shape.nodes.has(anchorId) && (shape.type === 'polyline' || shape.edges.size > 1);
            }
            const junctionInfo = isWireItem(shape) ? detectTJunction(app, shape, anchorId) : null;
            const canDisconnectPin = isWireItem(shape) && shape.pinConnections.has(anchorId);
            if (junctionInfo && isWireItem(shape)) canDeletePoint = false;
            if (canDeletePoint || junctionInfo || canDisconnectPin) {
                (/** @type {(app: SchematicEditor, shape: SchematicItem, anchorId: string, clientX: number, clientY: number, canDeletePoint: boolean, junctionInfo: unknown) => void} */ (showAnchorContextMenu))
                    (app, shape, anchorId, clientX, clientY, canDeletePoint, junctionInfo);
                return true;
            }
        }
    }

    // Also check unselected wires for anchor context menus
    const anchorTol = Math.max(0.5, 3 / app.viewport.scale);
    for (const wire of app.shapes) {
        if (!isWireItem(wire) || wire.locked) continue;
        const nid = wire.nodeAt(worldPos, anchorTol);
        if (!nid) continue;

        const junctionInfo = detectTJunction(app, wire, nid);
        let canDeletePoint = wire.nodes.has(nid) && wire.edges.size > 1;
        const canDisconnectPin = wire.pinConnections.has(nid);
        if (junctionInfo) canDeletePoint = false;

        if (canDeletePoint || junctionInfo || canDisconnectPin) {
            selectContextTargetShape(app, wire);
            (/** @type {(app: SchematicEditor, shape: SchematicItem, anchorId: string, clientX: number, clientY: number, canDeletePoint: boolean, junctionInfo: unknown) => void} */ (showAnchorContextMenu))
                (app, wire, nid, clientX, clientY, canDeletePoint, junctionInfo);
            return true;
        }
    }
    return false;
}

/**
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {number} clientX
 * @param {number} clientY
 */
function handleSegmentContextMenu(app, worldPos, clientX, clientY) {
    const segTolerance = SNAP_SCREEN_PX / app.viewport.scale;
    for (const shape of app.shapes) {
        if (!shape.locked && shape.type === 'arc' && shape.hitTest(worldPos, segTolerance)) {
            selectContextTargetShape(app, shape);
            showSegmentContextMenu(app, shape, '', clientX, clientY);
            return true;
        }
        if (shape.locked || !isGraphShape(shape)) continue;
        const edgeId = shape.hitTestEdge(worldPos, segTolerance);
        if (!edgeId) continue;
        selectContextTargetShape(app, shape);
        showSegmentContextMenu(app, shape, edgeId, clientX, clientY);
        return true;
    }
    return false;
}

/**
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {number} clientX
 * @param {number} clientY
 */
function handleSelectContextMenu(app, worldPos, clientX, clientY) {
    const hit = app.selection.hitTest(worldPos);
    if (hit && isTextItem(hit) && hit.fieldKey === 'label') {
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
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {number} clientX
 * @param {number} clientY
 * @returns {boolean}
 */
function handleComponentContextMenu(app, worldPos, clientX, clientY) {
    const comp = /** @type {Component|null} */ (findComponentAt(app, worldPos));
    if (!hasAny3DModel(comp?.definition)) return false;
    if (!comp) return false;
    showComponentContextMenu(app, comp, clientX, clientY);
    return true;
}

/**
 * @param {SchematicEditor} app
 * @param {Point} probePos
 * @param {SchematicItem|null} [excludeShape]
 * @returns {{target: SchematicItem|Component, snapPos: Point}|null}
 */
export function resolveLabelAttachTarget(app, probePos, excludeShape = null) {
    // Also exclude the label's current parent so the snap dot doesn't show for it
    const excludeParent = /** @type {SchematicItem|Component|null} */ (excludeShape && isTextItem(excludeShape) ? excludeShape.parentComponent : null);

    const hitComponent = /** @type {Component|null} */ (findComponentAt(app, probePos));
    if (hitComponent && hitComponent !== excludeShape && hitComponent !== excludeParent) {
        return {
            target: hitComponent,
            snapPos: { x: probePos.x, y: probePos.y }
        };
    }

    const wireTolerance = SNAP_SCREEN_PX / app.viewport.scale;
    for (let i = app.shapes.length - 1; i >= 0; i--) {
        const shape = app.shapes[i];
        if (!shape || shape === excludeShape || shape === excludeParent || !isWireItem(shape) || isCulled(shape) || !shape.visible) continue;
        const edgeId = shape.hitTestEdge(probePos, wireTolerance);
        if (!edgeId) continue;
        const nearest = shape.closestEdge(probePos);
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

    if (isWireItem(hit) && typeof hit.closestEdge === 'function') {
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

// ════════════════════════════════════════════════════════════════════
// STATE HANDLERS
// ════════════════════════════════════════════════════════════════════

/**
 * idle — select tool, nothing active.
 */
/** @type {DrawInteractionState} */
export const overlapCycleState = {
    /** @param {SchematicEditor} app */
    mousemove(app, event, positions) {
        const press = getOverlapCyclePress(app);
        if (!press || Math.hypot(positions.screenPos.x - press.positions.screenPos.x,
            positions.screenPos.y - press.positions.screenPos.y) <= DRAG_THRESHOLD_PX) return;
        clearOverlapCyclePress(app);
        app.interactionState = 'idle';
        setSkipClickSelection(app, false);
        idleState.mousedown?.(app, /** @type {MouseEvent} */ ({ button: 0, shiftKey: false, ctrlKey: false, metaKey: false,
            preventDefault() {} }), press.positions);
        STATE_TABLE[app.interactionState]?.mousemove?.(app, event, positions);
    },
    /** @param {SchematicEditor} app */
    mouseup(app, event, positions) {
        if (event.button !== 0) return;
        overlapCycleState.mousemove?.(app, event, positions);
        const press = getOverlapCyclePress(app);
        if (!press) {
            if (app.interactionState) STATE_TABLE[app.interactionState]?.mouseup?.(app, event, positions);
            return;
        }
        clearOverlapCyclePress(app);
        app.interactionState = 'idle';
        const hits = app.selection.hitTest(press.positions.worldPos, true);
        const selected = app.selection.getSelection();
        const index = hits.findIndex(shape => selected.includes(shape));
        const next = hits.length > 0 ? hits[(index + 1) % hits.length] : null;
        if (next) {
            const keep = press.additive ? selected.filter(shape => !hits.includes(shape)) : [];
            app.selection.selectMultiple([...keep, next]);
            app.renderShapes();
        }
        setSkipClickSelection(app, true);
        event.preventDefault();
    },
};

/** @type {DrawInteractionState} */
export const idleState = {
    /** @param {SchematicEditor} app */
    mousedown(app, event, { screenPos, worldPos, snapped }) {
        if (event.button !== 0) return;

        activateHomeTabIfFileTabOpen(app);

        if (!getSchematicTextEdit(app) && isUnmodifiedPrimaryDoublePress(event)) {
            const textHit = findSchematicInlineEditableHit(app, worldPos, event.target);
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
            if (isSchematicLocked(shape) || isComponentItem(shape)) continue;
            const anchorId = shape.hitTestAnchor(worldPos, app.viewport.scale);
            if (!anchorId) continue;

            setShapeSegmentFocus(app, null);
            app.updateShapeSelectionTip();

            if (isWireItem(shape) && shape.edges.size <= 1 && shape.nodes.has(anchorId)) {
                const pos = /** @type {Point} */ (shape.nodes.get(anchorId));
                let atJunction = false;
                for (const other of app.shapes) {
                    if (other === shape || !isWireItem(other)) continue;
                    if (other.nodeAt(pos, VERTEX_EPSILON)) { atJunction = true; break; }
                }
                if (atJunction) break;
            }

            if (canQueueMidpointAnchorDrag(/** @type {any} */ (shape), anchorId)) {
                const beforeState = captureShapeState(app, /** @type {any} */ (shape));
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
            const hitSegmentEdgeId = isPolylineItem(hitShape)
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
                    && canQueueMidpointAnchorDrag(/** @type {any} */ (hitShape), justSelectedAnchor)) {
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
            setPendingShapeSegmentToggle(app, wasSelected && isPolylineItem(hitShape)
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
            app.updateShapeSelectionTip();

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

    /** @param {SchematicEditor} app */
    mousemove(app, event, { screenPos, worldPos, snapped }) {
        handleComponentTooltipMouseMove(app, worldPos, screenPos);

        // Try to promote pending anchor drag
        if (getPendingAnchorDrag(app) && !getSchematicDrag(app)) {
            if (promotePendingAnchorDragSession(app, screenPos)) return;
        }
    },

    /** @param {SchematicEditor} app */
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
            app.updateShapeSelectionTip();
            app.updatePropertiesPanel(app.selection.getSelection());
            app.setActiveRibbonTab('properties');
            setSkipClickSelection(app, true);
            event.preventDefault();
        }
    },

    /** @param {SchematicEditor} app */
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
            app.updateShapeSelectionTip();
            app.updatePropertiesPanel(app.selection.getSelection());
            app.setActiveRibbonTab('properties');
            event.preventDefault();
            return;
        }

        // If a non-Home ribbon tab is showing, switch back to Home
        const activeTab = (document.getElementById('ribbonSchematic') || document).querySelector('.ribbon-tab.active');
        if (activeTab instanceof HTMLElement && activeTab.dataset.tab !== 'home') {
            app.setActiveRibbonTab('home');
        }

        const hit = app.selection.hitTest(worldPos);
        const textEdit = getSchematicTextEdit(app);
        if (textEdit) {
            if (!hit || hit !== textEdit.shape) app.endTextEdit(true);
        }
        app.selection.handleClick(worldPos, isAdditiveSelectionModifier(event));
        app.renderShapes(true);
    },

    /** @param {SchematicEditor} app */
    dblclick(app, event, { screenPos, worldPos }) {
        if (getSchematicTextEdit(app)) return;
        const hit = findSchematicInlineEditableHit(app, worldPos, event.target)
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

    /** @param {SchematicEditor} app */
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
/** @type {DrawInteractionState} */
export const toolActiveState = {
    /** @param {SchematicEditor} app */
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

    /** @param {SchematicEditor} app */
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

    /** @param {SchematicEditor} app */
    mouseup(app, event, { worldPos, snapped }) {
        if (event.button !== 0) return;
    },

    /** @param {SchematicEditor} app */
    rightclick(app, event, { screenPos, worldPos }) {
        handleComponentTooltipContextMenu(app, worldPos, screenPos);
        app.setToolCursor(app.currentTool, app.viewport.svg);
    }
};

/**
 * drawing — actively drawing a shape (wire/line/rect/circle/arc/polygon).
 */
/** @type {DrawInteractionState} */
export const drawingState = {
    /** @param {SchematicEditor} app */
    mousedown(app, event, { screenPos, worldPos, snapped }) {
        if (event.button !== 0) return;

        activateHomeTabIfFileTabOpen(app);

        pressSchematicToolDrawing(app, event, { screenPos, worldPos, snapped });
    },

    /** @param {SchematicEditor} app */
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
     * @param {SchematicEditor} app
     */
    rightclick(app, event, { screenPos, worldPos, snapped }) {
        if (finishSchematicDrawAtPointer(app, { screenPos, worldPos, snapped })) {
            app.setToolCursor(app.currentTool, app.viewport.svg);
            app.interactionState = 'toolActive';
        }
    },

    /** @param {SchematicEditor} app */
    mouseup(app, event, { screenPos, worldPos, snapped }) {
        if (event.button !== 0) return;
        releaseSchematicTool(app, { screenPos, worldPos, snapped });
    },

    /** @param {SchematicEditor} app */
    dblclick(app) {
        if (finishSchematicDrawInPlace(app)) app.interactionState = 'toolActive';
    },
};

/**
 * moveDrag — dragging selected shapes.
 */
/** @type {DrawInteractionState} */
export const moveDragState = {
    /** @param {SchematicEditor} app */
    mousemove(app, event, { worldPos }) {
        if (app.viewport.isPanning) return;

        const selNow = movableSelection(app);
        const labelShape = selNow.length === 1 && isTextItem(selNow[0]) ? selNow[0] : null;
        const isGenericLabel = labelShape?.fieldKey === 'label';
        if (isGenericLabel && labelShape) {
            const hotspot = (/** @type {(labelShape: SchematicItem, fallbackPos: Point|null) => Point} */ (getLabelDropHotspot))
                (labelShape, worldPos);
            const attach = resolveLabelAttachTarget(app, hotspot, labelShape);
            (/** @type {(app: SchematicEditor, target: unknown) => void} */ (updateSnapHighlight))
                (app, attach ? { x: attach.snapPos.x, y: attach.snapPos.y, type: 'attach' } : null);
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
        const dragNet = selNow.length === 1 && isNetItem(selNow[0]) ? selNow[0] : null;
        let deferredNetSnap = null;
        if (dragNet) {
            const alreadyConnected = dragNet.id && app.shapes.some(s =>
                isWireItem(s) && [...s.pinConnections.values()].some(c => c.componentId === dragNet.id)
            );
            if (!alreadyConnected) {
                const previewDx = snappedTarget.x - getSchematicDrag(app).lastSnapped.x;
                const previewDy = snappedTarget.y - getSchematicDrag(app).lastSnapped.y;
                const pinProbe = {
                    x: dragNet.x + previewDx,
                    y: dragNet.y + previewDy
                };
                const netPin = dragNet.symbol?.pins?.[0] || null;
                const netPinKey = netPin
                    ? (/** @type {{_key?: string|number, _id?: string|number, number: string|number}} */ (netPin))._key
                        || (/** @type {{_key?: string|number, _id?: string|number, number: string|number}} */ (netPin))._id
                        || netPin.number
                    : undefined;
                const { resolved } = resolvePinSnapPlacement(app, pinProbe, {
                    excludePin: netPin ? { component: dragNet, pin: netPin, pinKey: netPinKey } : undefined
                });
                deferredNetSnap = resolved;
            }
        }

        // Component drag: show snap highlight when an unconnected pin would
        // land on a wire node after this frame's snapped movement.
        const dragComp = selNow.find(isComponentWithPins);
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
                if (isTextItem(shape) && shape.parentComponent
                    && movingCompIds.has(/** @type {string} */ (shape.parentComponent.id))) continue;
                shape.move(dx, dy);
                if (isComponentItem(shape)) refreshComponentPose(shape);

                for (const maybeLabel of app.shapes) {
                    if (!isTextItem(maybeLabel)) continue;
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
            if (getSchematicTextEdit(app)) app.updateTextEditOverlay();
            app.fileManager.setDirty(true);
        }

        if (dragComp) {
            updateSnapHighlight(app, deferredComponentSnap);
        } else if (dragNet) {
            updateSnapHighlight(app, deferredNetSnap);
        }
    },

    /** @param {SchematicEditor} app */
    mouseup(app, event, { worldPos }) {
        if (event.button !== 0) return;

        const sel = movableSelection(app);
        const labelShape = sel.length === 1 && isTextItem(sel[0]) ? sel[0] : null;
        const isGenericLabel = labelShape?.fieldKey === 'label';
        if (isGenericLabel && labelShape) {
            const oldParent = labelShape.parentComponent;
            const hotspot = (/** @type {(labelShape: SchematicItem, fallbackPos: Point|null) => Point} */ (getLabelDropHotspot))
                (labelShape, worldPos);
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
/** @type {DrawInteractionState} */
export const anchorDragState = {
    /** @param {SchematicEditor} app */
    mousedown(app, event, positions) {
        if (event.button !== 0 || !getSchematicDrag(app).midpointPlacement) return;
        anchorDragState.mousemove?.(app, event, positions);
        handleDragEnd(app);
        setSkipClickSelection(app, true);
        app.viewport.svg.style.cursor = '';
        event.preventDefault();
    },

    /** @param {SchematicEditor} app */
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

        /** @type {any[]} */
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
                    const neighbourIds = /** @type {string[]} */ (getSchematicDrag(app).shape.isRect
                        ? (cornerIndex >= 0 ? [nodeIds[(cornerIndex + 2) % 4]] : [])
                        : getSchematicDrag(app).shape.neighborNodes(getSchematicDrag(app).anchorId));
                    const neighbours = neighbourIds
                        .map(id => getSchematicDrag(app).shape.nodes.get(id)).filter(Boolean);
                    anchorPos = snapShapePoint(app, worldPos, neighbours,
                        shapeContinuationConstraints(getSchematicDrag(app).shape, getSchematicDrag(app).anchorId));
                } else if (!getSchematicDrag(app).shape.isRect) {
                    const neighbors = /** @type {string[]} */ (getSchematicDrag(app).shape.neighborNodes(getSchematicDrag(app).anchorId))
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
        if (getSchematicTextEdit(app)) app.updateTextEditOverlay();
        app.fileManager.setDirty(true);
    },

    /** @param {SchematicEditor} app */
    mouseup(app, event) {
        if (event.button !== 0) return;
        if (getSchematicDrag(app).midpointPlacement) return;
        handleDragEnd(app);
    }
};

/**
 * segmentDrag — dragging a wire segment.
 */
/** @type {DrawInteractionState} */
export const segmentDragState = {
    /** @param {SchematicEditor} app */
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

    /** @param {SchematicEditor} app */
    mouseup(app, event) {
        if (event.button !== 0) return;
        handleDragEnd(app);
    }
};

/**
 * boxSelect — rubber-band selection.
 */
/** @type {DrawInteractionState} */
export const boxSelectState = {
    /** @param {SchematicEditor} app */
    mousemove(app, event, { worldPos }) {
        if (app.viewport.isPanning) return;
        setDidSchematicDrag(app, true);
        updateBoxSelectElement(app, worldPos);
        const bounds = getBoxSelectBounds(app, worldPos);
        app.selection.syncBoxSelection(bounds, !!getSchematicDrag(app).additive, 'contain');
        app.renderShapes(false);
    },

    /** @param {SchematicEditor} app */
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
/** @type {DrawInteractionState} */
export const placingState = {
    /** @param {SchematicEditor} app */
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

    /** @param {SchematicEditor} app */
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

/** @typedef {'overlapCycle'|'idle'|'toolActive'|'drawing'|'moveDrag'|'anchorDrag'|'segmentDrag'|'boxSelect'|'placing'} InteractionState */
/** @satisfies {Record<InteractionState, DrawInteractionState>} */
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
