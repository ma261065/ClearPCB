/**
 * Drawing schematic wires: the drawing session (start, waypoints, finish, cancel), its
 * preview, the pin and junction dots and the snap highlight.
 *
 * Where the cursor lands is wire-snap.js; reconciling wires after an edit (merging,
 * splitting, junctions and connections) is wire-reconcile.js, with the net-name and
 * label rules in wire-labels.js; the snaps wires take while being dragged are
 * wire-drag-snap.js.
 */
import { Wire, COLLINEAR_EPSILON as _SHAPE_COLLINEAR_EPSILON } from '../../shapes/index.js';
import { WIRE_COLOR, WIRE_WIDTH } from '../../shapes/wire.js';
import { pointsMatch, segmentsCollinear } from '../../core/geometry.js';
import { VERTEX_EPSILON } from './wire-constants.js';
import { componentPinElement } from '../render/component-renderer.js';
import { createPreview, getEffectiveStrokeWidth, isSchematicDrawingActive, setSchematicDrawingActive } from './drawing.js';
import { addShapeInternal } from './shape-management.js';
import { getDrawingSnappedPosition, getPinKey } from './wire-snap.js';
import { captureShapeSnapshot } from './wire-labels.js';
import { buildWireDiffBatch, reconcileWires, refreshWireConnections } from './wire-reconcile.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../shapes/wire.js').Wire} WireShape */
/** @typedef {import('../../shapes/net.js').Net} NetShape */
/** @typedef {import('../../core/geometry.js').Point} Point */
/** @typedef {'horizontal'|'vertical'} WireAxis */
/** @typedef {{component: {id: string, type?: string, net?: string, [key: string]: unknown}, pin: {number: string|number, [key: string]: unknown}, pinKey?: string|number|null, worldPos: Point}} SnapPin */
/** @typedef {Point & {pin?: SnapPin|null, _savedX?: number, _savedY?: number}} WirePoint */
/** @typedef {{componentId: string, pinNumber: string|number}} PinConnection */
/** @typedef {Record<string, Point>} GraphNodes */
/** @typedef {Record<string, {from: string, to: string}>} GraphEdges */
/** @typedef {Record<string, PinConnection>} PinConnections */
/** @typedef {{graphNodes: GraphNodes, graphEdges: GraphEdges, pinConnections: PinConnections, color: string, lineWidth: number, net?: string}} NewWireOptions */
/** @typedef {{committedGroup: SVGGElement, dotsGroup: SVGGElement, liveA: SVGLineElement, liveB: SVGLineElement, committedCount: number, dotCount: number}} WirePreviewState */
/** @typedef {SVGGElement & {_wirePreviewState?: WirePreviewState}} WirePreviewElement */
/** @typedef {{x?: number, y?: number, type?: string, pin?: object|null, snapType?: string, snapPin?: object|null, wireDir?: string, wire?: object|null}} SnapHighlightTarget */

const wireEditorState = new WeakMap();

/** @param {SchematicEditor} app */
function stateFor(app) {
    let state = wireEditorState.get(app);
    if (!state) {
        state = {
            axisLock: null,
            junctionData: null,
            junctionDot: null,
        };
        wireEditorState.set(app, state);
    }
    return state;
}

/** @param {SchematicEditor} app */
export function getWireJunctionData(app) {
    return stateFor(app).junctionData;
}

/** @param {SchematicEditor} app */
export function hasWireJunctionDot(app) {
    return !!stateFor(app).junctionDot;
}

/**
 * @param {SchematicEditor} app
 * @param {WireAxis|null} axis
 */
export function setWireAxisLock(app, axis) {
    stateFor(app).axisLock = axis;
}

/** @param {SchematicEditor} app */
export function getWireAxisLock(app) {
    return stateFor(app).axisLock;
}

/** Epsilon for detecting collinear H/V segments (world units). Re-exported from Wire shape. */
export const COLLINEAR_EPSILON = _SHAPE_COLLINEAR_EPSILON;

/** Angle tolerance for general collinearity check (sin of max angle). */
export const ANGLE_TOL = 0.05;

/** Tolerance for vertex coincidence checks (world units). */
export { VERTEX_EPSILON };

// ── Appearance ──

export { WIRE_COLOR, WIRE_WIDTH };

/**
 * Build the extra-segments array from in-progress wirePoints for
 * self-join detection.  Skips the last segment (it leads into the
 * current cursor position) and needs ≥ 3 points (≥ 2 segments).
 *
 * @param {Array<{x:number,y:number}>} pts - app.wirePoints
 * @returns {Array<{a: Point, b: Point}>|null}
 */
export function buildDrawingExtraSegments(pts) {
    if (!pts || pts.length < 3) return null;
    const segs = [];
    for (let i = 0, end = pts.length - 2; i < end; i++) {
        segs.push({ a: pts[i], b: pts[i + 1] });
    }
    return segs;
}

// --- Drawing lifecycle ---

/**
 * Begin drawing a new wire from a snapped start position.
 * Sets up app.wirePoints, axis lock, and shows the crosshair.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number, snapPin?: object|null}} snappedData - Start position
 */
export function startWireDrawing(app, snappedData) {
    const snapPin = /** @type {SnapPin|null} */ (snappedData.snapPin || null);
    const startPoint = /** @type {WirePoint} */ ({ x: snappedData.x, y: snappedData.y });
    if (snapPin) startPoint.pin = snapPin;

    app.wirePoints = [startPoint];
    app.wireSnapPin = snapPin;
    app.wireStartPin = snapPin;
    setWireAxisLock(app, null);
    setSchematicDrawingActive(app, true);
    app.interactionState = 'drawing';
    createPreview(app);
    app.showCrosshair();
    app.updateCrosshair(snappedData);
    app.setToolCursor(app.currentTool, app.viewport.svg);
}

/**
 * Update the wire-drawing preview as the cursor moves.
 * Calculates snap target and updates the preview SVG.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number}} worldPos - Raw cursor position in world coords
 */
export function updateWireDrawing(app, worldPos) {
    if (!isSchematicDrawingActive(app) || app.wirePoints.length === 0) return;

    // Calculate snapped target (includes snap detection via resolveWireSnapPosition)
    const target = getDrawingSnappedPosition(app, worldPos);

    updateSnapHighlight(app, /** @type {SnapHighlightTarget} */ (target));

    app.drawCurrent = { x: target.x, y: target.y };
    app.drawCorner = target.corner || null;
    app.lastSnappedData = { x: target.x, y: target.y, snapPin: target.snapPin };

    // When approaching an off-grid pin, shift the last waypoint's
    // constrained coordinate so the segment stays perfectly orthogonal.
    const lastPt = app.wirePoints[app.wirePoints.length - 1];
    _applyDrawAdjustLast(lastPt, target);

    updateWirePreview(app);
}

/**
 * Off-grid orthogonality adjustment for the in-progress drawing tail.
 *
 * When the live segment snaps to an off-grid pin/endpoint, the previous
 * waypoint's *constrained* axis must shift so the segment stays perfectly
 * H/V.  We mutate the waypoint in place (rather than deriving a preview-only
 * value) because the single `app.wirePoints` array feeds all three preview
 * elements at once — the live rubber-band, the last committed segment, and
 * the waypoint dot — so they follow the corner together and stay connected.
 *
 * The pre-adjustment coordinate is stashed on `_savedX`/`_savedY` so moving
 * away from the pin restores it; {@link _lockDrawAdjustLast} bakes it in on
 * commit by discarding the stash.
 *
 * @param {{x:number,y:number,_savedX?:number,_savedY?:number}} lastPt
 * @param {{adjustLastX?:number, adjustLastY?:number}} target
 */
function _applyDrawAdjustLast(lastPt, target) {
    if (target.adjustLastY !== undefined) {
        lastPt._savedY = lastPt._savedY ?? lastPt.y;
        lastPt.y = target.adjustLastY;
    } else if (target.adjustLastX !== undefined) {
        lastPt._savedX = lastPt._savedX ?? lastPt.x;
        lastPt.x = target.adjustLastX;
    } else {
        // Moved away from the pin — restore the original constrained coordinate.
        if (lastPt._savedY !== undefined) { lastPt.y = lastPt._savedY; delete lastPt._savedY; }
        if (lastPt._savedX !== undefined) { lastPt.x = lastPt._savedX; delete lastPt._savedX; }
    }
}

/**
 * Lock in any pending off-grid adjustment on a waypoint by discarding the
 * restore stash, making the current (possibly adjusted) coordinate permanent.
 * @param {{_savedX?:number,_savedY?:number}} pt
 */
function _lockDrawAdjustLast(pt) {
    delete pt._savedX;
    delete pt._savedY;
}

/**
 * Add a waypoint (corner) to the wire being drawn.
 * Collinear points are collapsed automatically.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number, snapPin?: object|null}} waypointData
 */
export function addWireWaypoint(app, waypointData) {
    if (app.wirePoints.length === 0) return;

    const point = /** @type {WirePoint} */ ({ x: waypointData.x, y: waypointData.y });
    if (waypointData.snapPin) point.pin = /** @type {SnapPin} */ (waypointData.snapPin);

    // Don't add duplicate point
    const last = app.wirePoints[app.wirePoints.length - 1];
    if (pointsMatch(last, point)) return;

    // Lock in any pin-adjusted coordinate on the previous waypoint
    _lockDrawAdjustLast(last);

    app.wirePoints.push(point);
    setWireAxisLock(app, null);   // Reset axis lock for new segment

    // Remove redundant collinear midpoint: if the last 3 points are on a
    // straight line, the middle one is unnecessary.
    const n = app.wirePoints.length;
    if (n >= 3) {
        const a = app.wirePoints[n - 3];
        const b = app.wirePoints[n - 2];
        const c = app.wirePoints[n - 1];
        if (segmentsCollinear({ a, b }, { a: b, b: c })) {
            app.wirePoints.splice(n - 2, 1);
        }
    }

    updateWirePreview(app);
}

/**
 * Scan all surviving wires for a net conflict: a single wire whose connected
 * Net-label shapes carry two or more different net names. Returns the first
 * offending wire with the two clashing names (sorted), or null if none.
 * @param {SchematicEditor} app
 * @returns {{ wire: WireShape, names: string[] } | null}
 */
function _findWireNetConflict(app) {
    for (const w of app.shapes) {
        if (w.type !== 'wire') continue;
        const wireShape = /** @type {WireShape} */ (w);
        const netNames = new Set();
        for (const [, conn] of wireShape.pinConnections) {
            const ns = app.shapes.find(/** @returns {s is NetShape} */ s => s.id === conn.componentId && s.type === 'net');
            if (ns?.net) netNames.add(ns.net);
        }
        if (netNames.size > 1) {
            return { wire: wireShape, names: [...netNames].sort() };
        }
    }
    return null;
}

/**
 * Finish the current wire drawing: create a Wire shape from the
 * accumulated waypoints, run reconciliation (merge, overlap,
 * junctions), and push an undo batch.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number, snapPin?: object}|null} [worldPos] - Final endpoint (unused: the last cursor position is app.drawCurrent)
 */
export function finishWireDrawing(app, worldPos) {
    // Add final point if different from last waypoint
    if (app.drawCurrent) {
        const last = app.wirePoints[app.wirePoints.length - 1];
        if (!pointsMatch(last, app.drawCurrent)) {
            addWireWaypoint(app, {
                x: app.drawCurrent.x,
                y: app.drawCurrent.y,
                snapPin: app.lastSnappedData?.snapPin || null
            });
        }
    }

    if (app.wirePoints.length < 2) {
        cancelWireDrawing(app);
        return;
    }

    updateSnapHighlight(app, null);

    // Build graph nodes/edges from the drawn points
    /** @type {GraphNodes} */
    const graphNodes = {};
    /** @type {GraphEdges} */
    const graphEdges = {};
    /** @type {PinConnections} */
    const pinConns = {};
    let nc = 0, ec = 0;
    const pts = app.wirePoints;
    let prevId = null;
    for (const pt of pts) {
        const nid = `n${nc++}`;
        graphNodes[nid] = { x: pt.x, y: pt.y };
        if (prevId !== null) {
            const eid = `e${ec++}`;
            graphEdges[eid] = { from: prevId, to: nid };
        }
        prevId = nid;
    }
    const firstPt = pts[0], lastPt = pts[pts.length - 1];
    if (firstPt.pin)
        pinConns['n0'] = { componentId: firstPt.pin.component.id, pinNumber: firstPt.pin.pin.number };
    if (lastPt.pin)
        pinConns[`n${nc - 1}`] = { componentId: lastPt.pin.component.id, pinNumber: lastPt.pin.pin.number };

    // Determine wire net name from connected Net labels (via pin snap)
    /** @type {string|null} */
    let wireNetName = null;
    let netConflict = false;
    for (const pt of pts) {
        if (pt.pin?.component?.type === 'net') {
            const proposedNet = pt.pin.component.net || null;
            if (wireNetName && wireNetName !== proposedNet) {
                netConflict = true;
                break;
            }
            wireNetName = proposedNet;
        }
    }

    if (netConflict) {
        if (app.alert) {
            app.alert('Cannot connect wires with different net names.\nThe nets on each end of this wire are different.', { title: 'Net Conflict' });
        }
        cancelWireDrawing(app);
        return;
    }

    /** @type {NewWireOptions} */
    const wireOpts = {
        graphNodes, graphEdges, pinConnections: pinConns,
        color: WIRE_COLOR, lineWidth: WIRE_WIDTH,
    };
    const toolOptions = /** @type {{wireNet?: string|number|null}|undefined} */ (app.toolOptions);
    const toolNetName = String(toolOptions?.wireNet || '').trim();
    if (wireNetName) wireOpts.net = wireNetName;
    else if (toolNetName) wireOpts.net = toolNetName;
    const wire = new Wire(wireOpts);

    // Snapshot all existing wires before any mutations
    const existingWires = app.shapes.filter(/** @returns {s is WireShape} */ s => s.type === 'wire');
    const beforeStates = new Map();
    for (const w of existingWires) beforeStates.set(w, captureShapeSnapshot(w));

    // Snapshot label texts before mutations
    const labelTextBefore = new Map();
    for (const w of existingWires) {
        if (w.labelText && app.shapes.includes(w.labelText)) {
            labelTextBefore.set(w.labelText, captureShapeSnapshot(w.labelText));
        }
    }

    // Add wire without creating a standalone undo entry
    addShapeInternal(app, wire);

    // Unified reconciliation: overlap trim, merge, collapse, junctions
    reconcileWires(app, [wire]);

    // Refresh pin connections on ALL surviving wires so pinConnections
    // are up to date after merges/absorbs
    for (const w of app.shapes) {
        if (w.type === 'wire') refreshWireConnections(app, w);
    }

    // If the wire was fully absorbed (e.g. redundant), revert and cancel
    if (!app.shapes.includes(wire) && wire.edges.size === 0) {
        for (const [w, beforeSnapshot] of beforeStates) {
            const before = beforeSnapshot.state;
            if (!app.shapes.includes(w)) {
                w.applyState(before);
                addShapeInternal(app, w);
            } else {
                w.applyState(before);
            }
        }
        // Revert label text states
        for (const [lt, beforeSnapshot] of labelTextBefore) {
            if (app.shapes.includes(lt)) lt.applyState(beforeSnapshot.state);
        }
        cancelWireDrawing(app);
        return;
    }

    // Build undo batch (pure snapshot, no revert/replay)
    const batch = buildWireDiffBatch(app, beforeStates, 'Draw wire', [wire], labelTextBefore);

    // Post-commit check: does any surviving wire now have two or more
    // connected Net shapes with different names?  If so, warn and roll back.
    const netConflictResult = _findWireNetConflict(app);
    if (netConflictResult) {
        const [n0, n1] = netConflictResult.names;
        app.alert(
            `Cannot merge wire segments with different net names: "${n0}" and "${n1}".`,
            { title: 'Net Conflict' }
        );
        // Revert the reconciliation directly via the diff batch. This is the
        // same reversion history.undo() would perform, but without ever
        // recording the batch — so a rejected draw leaves no undo/redo trace
        // (and doesn't clobber the existing redo stack).
        batch?.undo();
        cancelWireDrawing(app);
        app.renderShapes(true);
        app.updatePropertiesPanel(app.selection?.getSelection?.() || []);
        return;
    }

    if (batch) {
        // Record to undo stack without executing — state is already correct
        app.history.record(batch);
    }

    cancelWireDrawing(app);
    app.renderShapes(true);
    app.updatePropertiesPanel(app.selection?.getSelection?.() || []);
}

/**
 * Cancel the current wire drawing, cleaning up preview and state.
 * @param {SchematicEditor} app
 */
export function cancelWireDrawing(app) {
    app.wirePoints = [];
    setWireAxisLock(app, null);
    updateSnapHighlight(app, null);
    app.wireSnapPin = null;
    app.wireStartPin = null;
    setSchematicDrawingActive(app, false);
    app.interactionState = app.currentTool === 'select' ? 'idle' : 'toolActive';

    if (app.previewElement) {
        app.previewElement.remove();
        app.previewElement = null;
    }
    app.hideCrosshair();
    app.setToolCursor(app.currentTool, app.viewport.svg);
}

// --- Wire preview ---

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Lazily build the persistent preview DOM structure: a <g> for committed
 * segments, a <g> for waypoint dots, and two reusable rubber-band lines
 * (`liveA`/`liveB`) for the segment(s) from the last waypoint to the cursor.
 * Returns the per-preview state object stored on the previewElement itself
 * so it dies automatically when cancelWireDrawing() removes the element.
 */
/**
 * @param {WirePreviewElement} previewElement
 * @returns {WirePreviewState}
 */
function _ensurePreviewState(previewElement) {
    if (previewElement._wirePreviewState) return previewElement._wirePreviewState;

    const committedGroup = document.createElementNS(SVG_NS, 'g');
    const dotsGroup = document.createElementNS(SVG_NS, 'g');
    const liveA = document.createElementNS(SVG_NS, 'line');
    const liveB = document.createElementNS(SVG_NS, 'line');
    for (const ln of [liveA, liveB]) {
        ln.setAttribute('stroke', WIRE_COLOR);
        ln.setAttribute('stroke-linecap', 'round');
        ln.setAttribute('stroke-opacity', '0.6');
        ln.setAttribute('display', 'none');
    }
    previewElement.appendChild(committedGroup);
    previewElement.appendChild(dotsGroup);
    previewElement.appendChild(liveA);
    previewElement.appendChild(liveB);

    const state = {
        committedGroup,
        dotsGroup,
        liveA,
        liveB,
        committedCount: 0, // number of <line>s currently in committedGroup
        dotCount: 0,       // number of <circle>s currently in dotsGroup
    };
    previewElement._wirePreviewState = state;
    return state;
}

/**
 * Redraw the wire-drawing preview SVG from app.wirePoints
 * plus the current cursor position (app.drawCurrent).
 *
 * Uses persistent DOM nodes and only mutates what actually changed:
 *   - committed segments / waypoint dots are appended once and never touched again
 *   - the live rubber-band segment(s) are two reused <line> nodes whose endpoint
 *     attributes are the only thing updated on each mousemove
 * This avoids the O(N) innerHTML re-parse-and-recreate that the previous
 * implementation did on every cursor move.
 *
 * @param {SchematicEditor} app
 */
export function updateWirePreview(app) {
    if (!app.previewElement) return;

    const state = _ensurePreviewState(app.previewElement);
    const strokeWidth = getEffectiveStrokeWidth(app, 0.2);
    const pts = app.wirePoints;

    // If pts shrank (collinear-merge splice, backspace, …) or the most
    // recently committed segment no longer matches the underlying points,
    // discard cached nodes and rebuild. This is rare enough to be cheap.
    const segCount = Math.max(0, pts.length - 1);
    let needsReset = state.committedCount > segCount || state.dotCount > pts.length;
    if (!needsReset && state.committedCount > 0) {
        const lastLine = /** @type {SVGLineElement|null} */ (state.committedGroup.lastChild);
        const expectedEnd = pts[state.committedCount];
        if (!lastLine
            || lastLine.getAttribute('x2') !== String(expectedEnd.x)
            || lastLine.getAttribute('y2') !== String(expectedEnd.y)) {
            needsReset = true;
        }
    }
    if (needsReset) {
        while (state.committedGroup.firstChild) state.committedGroup.removeChild(state.committedGroup.firstChild);
        while (state.dotsGroup.firstChild) state.dotsGroup.removeChild(state.dotsGroup.firstChild);
        state.committedCount = 0;
        state.dotCount = 0;
    }

    // Append any newly committed segments (between consecutive waypoints).
    while (state.committedCount < pts.length - 1) {
        const i = state.committedCount;
        const ln = document.createElementNS(SVG_NS, 'line');
        ln.setAttribute('x1', String(pts[i].x));
        ln.setAttribute('y1', String(pts[i].y));
        ln.setAttribute('x2', String(pts[i + 1].x));
        ln.setAttribute('y2', String(pts[i + 1].y));
        ln.setAttribute('stroke', WIRE_COLOR);
        ln.setAttribute('stroke-width', String(strokeWidth));
        ln.setAttribute('stroke-linecap', 'round');
        state.committedGroup.appendChild(ln);
        state.committedCount++;
    }

    // Append any new waypoint dots.
    const dotR = String(2 / app.viewport.scale);
    while (state.dotCount < pts.length) {
        const i = state.dotCount;
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', String(pts[i].x));
        c.setAttribute('cy', String(pts[i].y));
        c.setAttribute('r', dotR);
        c.setAttribute('fill', WIRE_COLOR);
        state.dotsGroup.appendChild(c);
        state.dotCount++;
    }

    // Update live rubber-band segment(s). This is the hot path.
    if (app.drawCurrent && pts.length > 0) {
        const last = pts[pts.length - 1];
        const { liveA, liveB } = state;
        if (app.drawCorner) {
            const c = app.drawCorner;
            liveA.setAttribute('x1', String(last.x));
            liveA.setAttribute('y1', String(last.y));
            liveA.setAttribute('x2', String(c.x));
            liveA.setAttribute('y2', String(c.y));
            liveA.setAttribute('stroke-width', String(strokeWidth));
            liveA.setAttribute('display', '');
            liveB.setAttribute('x1', String(c.x));
            liveB.setAttribute('y1', String(c.y));
            liveB.setAttribute('x2', String(app.drawCurrent.x));
            liveB.setAttribute('y2', String(app.drawCurrent.y));
            liveB.setAttribute('stroke-width', String(strokeWidth));
            liveB.setAttribute('display', '');
        } else {
            liveA.setAttribute('x1', String(last.x));
            liveA.setAttribute('y1', String(last.y));
            liveA.setAttribute('x2', String(app.drawCurrent.x));
            liveA.setAttribute('y2', String(app.drawCurrent.y));
            liveA.setAttribute('stroke-width', String(strokeWidth));
            liveA.setAttribute('display', '');
            liveB.setAttribute('display', 'none');
        }
    } else {
        state.liveA.setAttribute('display', 'none');
        state.liveB.setAttribute('display', 'none');
    }
}

// --- Snap highlight (unified pin + wire junction) ---

/**
 * Low-level: show yellow dot on a component pin.
 * @param {SchematicEditor} app
 * @param {SnapPin} snapPin
 */
function _showPinDot(app, snapPin) {
    const pinGroup = componentPinElement(snapPin.component, getPinKey(snapPin));
    if (pinGroup) {
        const dot = pinGroup.querySelector('circle');
        if (dot) {
            if (!dot.dataset.originalFill) dot.dataset.originalFill = dot.getAttribute('fill') || '';
            dot.setAttribute('fill', '#ffff00');
            dot.setAttribute('display', '');
        }
    }

    // Always render an overlay dot at the snap point so visibility is
    // consistent even when pin circles are tiny or covered by anchors.
    _showWireJunctionDot(app, { x: snapPin.worldPos.x, y: snapPin.worldPos.y, type: 'pin' });
}

/**
 * Low-level: restore a previously highlighted pin dot.
 * @param {SchematicEditor} app
 */
function _hidePinDot(app) {
    if (!app.wireSnapPin?.pin) return;
    const pinGroup = componentPinElement(app.wireSnapPin.component, getPinKey(app.wireSnapPin));
    if (pinGroup) {
        const dot = pinGroup.querySelector('circle');
        if (dot) {
            dot.setAttribute('fill', dot.dataset.originalFill || 'var(--sch-pin, #aa0000)');
            if (!app.selection.isSelected(app.wireSnapPin.component)) {
                dot.setAttribute('display', 'none');
            }
        }
    }
}

/**
 * Low-level: show a temporary yellow SVG circle at a wire junction point.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number, type?: string}} pos
 */
function _showWireJunctionDot(app, pos) {
    _hideWireJunctionDot(app);
    const state = stateFor(app);
    state.junctionData = { x: pos.x, y: pos.y, type: pos.type };
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    // Keep the snap dot clearly visible over anchor handles at low zoom,
    // but let it scale up naturally when zoomed in.
    const minScreenRadiusPx = 6.5;
    const minWorldRadius = 0.36;
    dot.setAttribute('cx', String(pos.x));
    dot.setAttribute('cy', String(pos.y));
    dot.setAttribute('r', String(Math.max(minWorldRadius, minScreenRadiusPx / app.viewport.scale)));
    dot.setAttribute('fill', '#ffff00');
    dot.setAttribute('stroke', 'none');
    dot.setAttribute('pointer-events', 'none');
    dot.classList.add('wire-junction-highlight');
    // Attach to root SVG so the highlight always paints above content/component layers.
    app.viewport.svg.appendChild(dot);
    state.junctionDot = dot;
}

/**
 * Low-level: remove the temporary wire junction dot.
 * @param {SchematicEditor} app
 */
function _hideWireJunctionDot(app) {
    const state = stateFor(app);
    if (state.junctionDot) {
        state.junctionDot.remove();
        state.junctionDot = null;
    }
    state.junctionData = null;
}

/**
 * Unified snap highlight: show a yellow dot for a pin, wire junction,
 * or Net label connection point, automatically cleaning up any previous
 * highlight of either type.
 *
 * Accepts three input forms:
 *   - A snap result (has .snapType): automatically converted
 *   - A pin snap object (has .pin): show pin dot
 *   - A wire junction {x, y, type} (no .pin): show junction dot
 *   - null: clear all highlights
 * @param {SchematicEditor} app
 * @param {SnapHighlightTarget|null} target
 */
export function updateSnapHighlight(app, target) {
    // Accept snap resolver results directly — convert to highlight format
    if (target?.snapType) {
        if (target.snapType === 'pin' && target.snapPin) {
            target = /** @type {SnapHighlightTarget} */ (target.snapPin);
        } else if (target.snapType === 'endpoint' || target.snapType === 'segment') {
            target = { x: target.x, y: target.y, type: target.snapType };
        } else {
            target = null;
        }
    }

    const isPin = target?.pin != null;
    const isWireJunction = target && !isPin;
    const prevPin = app.wireSnapPin;
    const sameTarget = isPin && target === prevPin;

    // Nothing changed
    if (sameTarget) return;

    // Clear previous highlights
    if (prevPin) {
        _hidePinDot(app);
        app.wireSnapPin = null;
    }
    _hideWireJunctionDot(app);

    // Show new highlight
    if (isPin) {
        app.wireSnapPin = /** @type {SnapPin} */ (target);
        _showPinDot(app, /** @type {SnapPin} */ (target));
    } else if (isWireJunction) {
        _showWireJunctionDot(app, /** @type {{x: number, y: number, type?: string}} */ (target));
    }
}
