/**
 * Context menus and related operations for wire anchors, segments,
 * and T-junctions.
 *
 * Extracted from mouse.js so the menu-building DOM code and the
 * junction / segment deletion logic are co-located and easy to find.
 */

import { ModifyShapeCommand, ModifyPropertyCommand, BatchCommand, AddShapeCommand, DeleteShapesCommand } from '../../core/CommandHistory.js';
import { VERTEX_EPSILON, applySplitLabelRules, applySplitNetRules } from './wire.js';
import { detachLabel } from './label-attachment.js';

/**
 * @typedef {HTMLDivElement & {
 *   _dismissHandlers?: {
 *     dismiss: (e: MouseEvent) => void,
 *     dismissOnKey: (e: KeyboardEvent) => void
 *   }
 * }} AnchorContextMenuEl
 */

/** @param {Element | null} el */
function asAnchorContextMenuEl(el) {
    return /** @type {AnchorContextMenuEl | null} */ (el);
}

/** @param {AnchorContextMenuEl} menu */
function attachDismissHandlers(menu) {
    const dismiss = (e) => {
        if (!menu.contains(/** @type {Node | null} */ (e.target))) dismissAnchorContextMenu();
    };
    const dismissOnKey = (e) => {
        if (e.key === 'Escape') dismissAnchorContextMenu();
    };
    setTimeout(() => {
        document.addEventListener('mousedown', dismiss, { capture: true });
        document.addEventListener('keydown', dismissOnKey, { capture: true });
    }, 0);
    menu._dismissHandlers = { dismiss, dismissOnKey };
}

function getWireSplitLabelMeta(wire) {
    const attached = wire.attachedLabels instanceof Set
        ? Array.from(wire.attachedLabels).filter(label =>
            label?.type === 'text'
            && label.fieldKey === 'label'
            && label.parentComponent === wire
        )
        : [];
    const primary = attached.find(label => label?.attachment?.wireName === true)
        || attached.find(label => String(label?.text || '').toLowerCase() === String(wire.wireLabel || '').toLowerCase())
        || attached[0]
        || null;

    const preSplitVisible = primary?.visible ?? wire.labelText?.visible ?? wire._pendingLabelVisible ?? false;
    const preSplitLabelPosition = primary
        ? { x: primary.x, y: primary.y, rotation: primary.rotation || 0 }
        : (wire.labelText
            ? { x: wire.labelText.x, y: wire.labelText.y, rotation: wire.labelText.rotation }
            : (wire._pendingLabelPosition
                ? {
                    x: wire._pendingLabelPosition.x,
                    y: wire._pendingLabelPosition.y,
                    rotation: wire._pendingLabelPosition.rotation ?? 0
                }
                : null));
    return { preSplitVisible, preSplitLabelPosition };
}

function getWireAnchorPosition(shape, anchorId) {
    if (shape?.type !== 'wire' || !shape.nodes?.has(anchorId)) return null;
    const pos = shape.nodes.get(anchorId);
    return pos ? { x: pos.x, y: pos.y } : null;
}

function findNoConnectsAtPosition(app, pos) {
    if (!pos) return [];
    return app.shapes.filter(s =>
        s.type === 'noconnect' &&
        Math.hypot(s.x - pos.x, s.y - pos.y) < VERTEX_EPSILON
    );
}

// ─── T-junction detection ──────────────────────────────────────────

/**
 * Detect whether an anchor point on a wire is at a T-junction (degree ≥ 3 node).
 * In the graph model, a junction is simply a node with 3+ incident edges.
 * We also check for cross-wire junctions (same position, different graph).
 *
 * Returned object:
 *   junctionWire   – the wire containing the junction node
 *   junctionNodeId – node ID of the junction
 *   wireToDrag     – a wire whose leaf node can be detached and dragged
 *                    (null when multiple connecting wires exist)
 *   dragAnchorId   – anchor id on wireToDrag (the leaf node ID)
 *   allConnecting  – array of { wire, nodeId } for every wire with a node here
 */
export function detectTJunction(app, shape, anchorId) {
    if (shape.type !== 'wire') return null;
    if (!shape.nodes.has(anchorId)) return null;
    const pos = shape.nodes.get(anchorId);

    // Case 1: intra-graph junction — degree ≥ 3 within a single graph
    if (shape.degree(anchorId) >= 3) {
        // Find leaf-node wires that connect here from OTHER graphs
        const crossWires = [];
        for (const other of app.shapes) {
            if (other === shape || other.type !== 'wire') continue;
            const nid = other.nodeAt(pos, VERTEX_EPSILON);
            if (nid && other.degree(nid) === 1) {
                crossWires.push({ wire: other, nodeId: nid });
            }
        }
        return {
            junctionWire: shape,
            junctionNodeId: anchorId,
            wireToDrag: null,   // degree ≥ 3 in same graph — no single wire to drag
            dragAnchorId: null,
            allConnecting: [
                { wire: shape, nodeId: anchorId },
                ...crossWires
            ]
        };
    }

    // Case 2: cross-graph junction — leaf nodes from multiple wires meet at same point
    const connectingHere = [{ wire: shape, nodeId: anchorId }];
    for (const other of app.shapes) {
        if (other === shape || other.type !== 'wire') continue;
        const nid = other.nodeAt(pos, VERTEX_EPSILON);
        if (nid) connectingHere.push({ wire: other, nodeId: nid });
    }
    if (connectingHere.length < 2) return null;

    // Find one wire with a leaf node here to drag
    const leafEntry = connectingHere.find(c => c.wire.degree(c.nodeId) === 1);
    return {
        junctionWire: shape,
        junctionNodeId: anchorId,
        wireToDrag: leafEntry ? leafEntry.wire : null,
        dragAnchorId: leafEntry ? leafEntry.nodeId : null,
        allConnecting: connectingHere
    };
}

// ─── Junction / wire / segment deletion ────────────────────────────

/**
 * Delete a T-junction: split the degree-≥3 node so each branch becomes
 * a separate wire.  Fully undoable.
 */
export function deleteJunction(app, junctionInfo) {
    const { junctionWire, junctionNodeId } = junctionInfo;
    if (!junctionWire || !junctionNodeId) return;
    if (!app.shapes.includes(junctionWire)) return;

    const wire = junctionWire;
    const deg = wire.degree(junctionNodeId);
    if (deg < 3) return;

    // Capture true pre-split snapshots so undo can restore the original
    // single-wire junction state (including label visibility ownership).
    const preSplitWireStates = new Map();
    for (const s of app.shapes) {
        if (s.type === 'wire') preSplitWireStates.set(s, s.captureState());
    }
    const preSplitLabelTextStates = new Map();
    for (const [w] of preSplitWireStates) {
        if (w.labelText && app.shapes.includes(w.labelText)) {
            preSplitLabelTextStates.set(w.labelText, w.labelText.captureState());
        }
    }

    const pos = wire.nodes.get(junctionNodeId);
    if (!pos) return;

    // Split the junction node: give each incident edge its own node copy.
    // Pick the branch most perpendicular to the dominant direction to detach.
    const incidents = [...wire.incidentEdges(junctionNodeId)];

    // Compute unit direction vectors for each incident edge
    const dirs = incidents.map(({ otherNode }) => {
        const other = wire.nodes.get(otherNode);
        const dx = other.x - pos.x, dy = other.y - pos.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: dx / len, y: dy / len };
    });

    // Find the dominant direction: the pair of edges most closely forming
    // a straight line (dot product closest to -1 = 180°).
    let bestDot = Infinity;
    let dominantA = -1, dominantB = -1;
    for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
            const dot = dirs[i].x * dirs[j].x + dirs[i].y * dirs[j].y;
            if (dot < bestDot) { bestDot = dot; dominantA = i; dominantB = j; }
        }
    }

    // The drag target is the edge NOT part of the dominant pair
    let dragEdgeIdx;
    if (incidents.length === 3 && dominantA >= 0 && dominantB >= 0) {
        dragEdgeIdx = incidents.findIndex((_, i) => i !== dominantA && i !== dominantB);
    } else {
        // Fallback for 4+ edges: pick the edge most perpendicular to the dominant direction
        const domDir = dirs[dominantA];
        let maxPerp = -Infinity;
        dragEdgeIdx = 0;
        for (let i = 0; i < dirs.length; i++) {
            if (i === dominantA || i === dominantB) continue;
            const perp = Math.abs(domDir.x * dirs[i].y - domDir.y * dirs[i].x); // |cross product|
            if (perp > maxPerp) { maxPerp = perp; dragEdgeIdx = i; }
        }
    }

    let dragNewNodeId = null;
    // Only detach the drag edge — keep the dominant pair connected at the junction.
    // This avoids creating unnecessary fragments that get merged back immediately.
    {
        const dragIncident = incidents[dragEdgeIdx];
        dragNewNodeId = wire.addNode(pos.x, pos.y);
        const edge = wire.edges.get(dragIncident.edgeId);
        if (edge.from === junctionNodeId) edge.from = dragNewNodeId;
        if (edge.to === junctionNodeId) edge.to = dragNewNodeId;
    }

    // Split disconnected components into separate wire objects
    const comps = wire.connectedComponents();
    let dragWire = wire;
    const newFragments = [];
    const preSplitLabel = wire.wireLabel;
    const preSplitNet = wire.net;
    const { preSplitVisible, preSplitLabelPosition } = getWireSplitLabelMeta(wire);
    if (comps.length > 1) {
        comps.sort((a, b) => b.size - a.size);
        for (let i = 1; i < comps.length; i++) {
            const sub = wire.extractSubgraph(comps[i]);
            if (sub.edges.size > 0) {
                app._addShapeInternal(sub);
                newFragments.push(sub);
                // Track which wire owns the drag node
                if (dragNewNodeId && comps[i].has(dragNewNodeId)) {
                    // Node IDs are preserved by extractSubgraph
                    dragWire = sub;
                }
            }
        }
        const keepSet = comps[0];
        for (const nid of [...wire.nodes.keys()]) {
            if (!keepSet.has(nid)) wire.removeNode(nid);
        }

        // ── Split label rules ──
        // Winner = post-split wire with most segments, keeps original label.
        // All post-split wires inherit pre-split visibility.
        applySplitLabelRules(wire, newFragments, preSplitLabel, preSplitVisible, preSplitLabelPosition, app);
        applySplitNetRules(wire, newFragments, preSplitNet);
    }
    wire.invalidate();

    // Capture before-states for the drag wire (and any TJ-linked wires)
    // so commitAnchorDrag can build the undo batch.
    const dragBefore = app._captureShapeState(dragWire);
    const anchorWireStates = new Map();
    // Include the original wire (and any other split-off wires) so
    // commitAnchorDrag snapshots them correctly.
    for (const s of app.shapes) {
        if (s.type === 'wire' && s !== dragWire) {
            anchorWireStates.set(s, s.captureState());
        }
    }

    const pt = { x: pos.x, y: pos.y };

    // Select the freed wire and enter anchor drag mode
    app.selection.clearSelection();
    app.selection.select(dragWire, false);
    dragWire.selected = true;

    app.drag = {
        mode: 'anchor',
        shape: dragWire,
        beforeState: dragBefore,
        start: { ...pt },
        startScreen: null,
        anchorId: dragNewNodeId,
        wireAnchorOriginal: { ...pt },
        tjLinks: [],
        wireStates: anchorWireStates,
        excludePin: null,
        ncLinks: [],
        junctionBeforeWireStates: preSplitWireStates,
        junctionBeforeLabelTextStates: preSplitLabelTextStates
    };
    app.interactionState = 'anchorDrag';
    app.didDrag = false;

    app.renderShapes(true);
    app._showCrosshair();
    app._updateCrosshair(pt);
    app.viewport.svg.style.cursor = 'move';
}

/**
 * Delete a wire segment (edge).  If the wire has only one edge, delete the
 * whole wire.  Otherwise remove the edge and split into connected components,
 * keeping only components with at least one edge.
 */
export function deleteWireSegment(app, wire, edgeId) {
    if (wire.edges.size <= 1) {
        deleteWire(app, wire);
        return;
    }

    const batch = new BatchCommand('Delete segment');

    // Capture before state
    const beforeState = wire.captureState();
    const preSplitLabel = wire.wireLabel;
    const { preSplitVisible, preSplitLabelPosition } = getWireSplitLabelMeta(wire);

    // Remove the edge
    wire.removeEdge(edgeId);

    // Clean up: merge collinear degree-2 nodes, remove isolated nodes, etc.
    wire.cleanGraph();

    // If the wire is now empty, just delete it
    if (wire.edges.size === 0) {
        wire.applyState(beforeState);
        deleteWire(app, wire);
        return;
    }

    // Split into connected components
    const components = wire.connectedComponents();
    if (components.length <= 1) {
        // Still one connected component — just modify in place
        const afterState = wire.captureState();
        wire.applyState(beforeState);
        batch.add(new ModifyShapeCommand(app, wire, beforeState, afterState));
    } else {
        // Multiple components — delete original, create new wires for each component with edges
        batch.add(new DeleteShapesCommand(app, [wire]));
        const fragments = [];
        for (const nodeSet of components) {
            const sub = wire.extractSubgraph(nodeSet);
            if (sub.edges.size > 0) {
                fragments.push(sub);
            }
        }

        if (fragments.length > 0) {
            applySplitLabelRules(fragments[0], fragments.slice(1), preSplitLabel, preSplitVisible, preSplitLabelPosition);
            for (const sub of fragments) {
                batch.add(new AddShapeCommand(app, sub));
            }
        }

        // Restore original for undo
        wire.applyState(beforeState);
    }

    app.history.execute(batch);
}

/**
 * Delete an entire wire (with undo).
 */
export function deleteWire(app, wire) {
    const batch = new BatchCommand('Delete wire');
    batch.add(new DeleteShapesCommand(app, [wire]));
    app.history.execute(batch);
    app.selection.clear();
    app.renderShapes(true);
}

// ─── Context menu UI ───────────────────────────────────────────────

/**
 * Show a lightweight context menu for anchor point operations.
 */
export function showAnchorContextMenu(app, shape, anchorId, clientX, clientY, canDeletePoint = true, junctionInfo = null) {
    // Remove any existing anchor context menu
    dismissAnchorContextMenu();

    const menu = /** @type {AnchorContextMenuEl} */ (document.createElement('div'));
    menu.className = 'anchor-context-menu';
    menu.style.cssText = `
        position: fixed; left: ${clientX}px; top: ${clientY}px; z-index: 10000;
        background: #2b2b2b; border: 1px solid #555; border-radius: 4px;
        padding: 2px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.4); min-width: 120px;
    `;

    if (canDeletePoint) {
        const item = document.createElement('div');
        item.textContent = 'Delete point';
        item.style.cssText = `
            padding: 6px 16px; color: #eee; cursor: pointer; font: 13px/1.4 system-ui, sans-serif;
            white-space: nowrap;
        `;
        item.addEventListener('mouseenter', () => item.style.background = '#3a3a3a');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => {
            dismissAnchorContextMenu();
            const beforeState = app._captureShapeState(shape);
            const anchorPos = getWireAnchorPosition(shape, anchorId);
            const attachedNCs = findNoConnectsAtPosition(app, anchorPos);
            if (shape.deleteAnchor(anchorId)) {
                const afterState = app._captureShapeState(shape);
                app._applyShapeState(shape, beforeState);
                const batch = new BatchCommand('Delete point');
                batch.add(new ModifyShapeCommand(app, shape, beforeState, afterState));
                if (attachedNCs.length > 0) {
                    batch.add(new DeleteShapesCommand(app, attachedNCs));
                }
                app.history.execute(batch);
                shape.selected = true;
                // Command's execute() already calls renderShapes(true)
            }
        });
        menu.appendChild(item);
    }

    if (junctionInfo) {
        const jItem = document.createElement('div');
        jItem.textContent = 'Split junction';
        jItem.style.cssText = `
            padding: 6px 16px; color: #eee; cursor: pointer; font: 13px/1.4 system-ui, sans-serif;
            white-space: nowrap;
        `;
        jItem.addEventListener('mouseenter', () => jItem.style.background = '#3a3a3a');
        jItem.addEventListener('mouseleave', () => jItem.style.background = '');
        jItem.addEventListener('click', () => {
            dismissAnchorContextMenu();
            deleteJunction(app, junctionInfo);
        });
        menu.appendChild(jItem);
    }

    document.body.appendChild(menu);

    attachDismissHandlers(menu);
}

/**
 * Remove the currently visible anchor/segment context menu and its
 * global event listeners. Safe to call when no menu is open.
 */
export function dismissAnchorContextMenu() {
    const existing = asAnchorContextMenuEl(document.querySelector('.anchor-context-menu'));
    if (existing) {
        if (existing._dismissHandlers) {
            document.removeEventListener('mousedown', existing._dismissHandlers.dismiss, { capture: true });
            document.removeEventListener('keydown', existing._dismissHandlers.dismissOnKey, { capture: true });
        }
        existing.remove();
    }
}

/**
 * Show a context menu for wire segment operations (delete segment).
 */
export function showSegmentContextMenu(app, wire, edgeId, clientX, clientY) {
    dismissAnchorContextMenu();

    const menu = /** @type {AnchorContextMenuEl} */ (document.createElement('div'));
    menu.className = 'anchor-context-menu';
    menu.style.cssText = `
        position: fixed; left: ${clientX}px; top: ${clientY}px; z-index: 10000;
        background: #2b2b2b; border: 1px solid #555; border-radius: 4px;
        padding: 2px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.4); min-width: 120px;
    `;

    const itemStyle = `
        padding: 6px 16px; color: #eee; cursor: pointer; font: 13px/1.4 system-ui, sans-serif;
        white-space: nowrap;
    `;

    // Only show Delete Segment for multi-edge wires
    if (wire.edges.size > 1) {
        const segItem = document.createElement('div');
        segItem.textContent = 'Delete Segment';
        segItem.style.cssText = itemStyle;
        segItem.addEventListener('mouseenter', () => segItem.style.background = '#3a3a3a');
        segItem.addEventListener('mouseleave', () => segItem.style.background = '');
        segItem.addEventListener('click', () => {
            dismissAnchorContextMenu();
            deleteWireSegment(app, wire, edgeId);
        });
        menu.appendChild(segItem);
    }

    const wireItem = document.createElement('div');
    wireItem.textContent = 'Delete Wire';
    wireItem.style.cssText = itemStyle;
    wireItem.addEventListener('mouseenter', () => wireItem.style.background = '#3a3a3a');
    wireItem.addEventListener('mouseleave', () => wireItem.style.background = '');
    wireItem.addEventListener('click', () => {
        dismissAnchorContextMenu();
        deleteWire(app, wire);
    });
    menu.appendChild(wireItem);

    document.body.appendChild(menu);

    attachDismissHandlers(menu);
}

/**
 * Show a context menu for attached labels.
 */
export function showLabelContextMenu(app, labelShape, clientX, clientY) {
    dismissAnchorContextMenu();

    const menu = /** @type {AnchorContextMenuEl} */ (document.createElement('div'));
    menu.className = 'anchor-context-menu';
    menu.style.cssText = `
        position: fixed; left: ${clientX}px; top: ${clientY}px; z-index: 10000;
        background: #2b2b2b; border: 1px solid #555; border-radius: 4px;
        padding: 2px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.4); min-width: 120px;
    `;

    const canToggleFollowRotation = !!(labelShape?.parentComponent && labelShape.parentComponent.type !== 'wire');
    if (canToggleFollowRotation) {
        const followItem = document.createElement('div');
        const checked = !!labelShape.followRotation;
        followItem.textContent = `${checked ? '✓ ' : ''}Follow Rotation`;
        followItem.style.cssText = `
            padding: 6px 16px; color: #eee; cursor: pointer; font: 13px/1.4 system-ui, sans-serif;
            white-space: nowrap;
        `;
        followItem.addEventListener('mouseenter', () => followItem.style.background = '#3a3a3a');
        followItem.addEventListener('mouseleave', () => followItem.style.background = '');
        followItem.addEventListener('click', () => {
            dismissAnchorContextMenu();
            const command = new ModifyPropertyCommand(app, [labelShape], 'followRotation', !checked);
            app.history.execute(command);
            app.selection.select(labelShape, false);
            app.fileManager.setDirty(true);
        });
        menu.appendChild(followItem);
    }

    const item = document.createElement('div');
    item.textContent = 'Detach Label';
    item.style.cssText = `
        padding: 6px 16px; color: #eee; cursor: pointer; font: 13px/1.4 system-ui, sans-serif;
        white-space: nowrap;
    `;
    item.addEventListener('mouseenter', () => item.style.background = '#3a3a3a');
    item.addEventListener('mouseleave', () => item.style.background = '');
    item.addEventListener('click', () => {
        dismissAnchorContextMenu();
        detachLabel(labelShape);
        app.selection.select(labelShape, false);

        const rect = app.viewport._getCachedRect();
        const screenPos = {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
        const worldPos = app.viewport.screenToWorld(screenPos);

        app.drag = {
            mode: 'move',
            objectStartPos: { x: labelShape.x, y: labelShape.y },
            lastSnapped: { x: labelShape.x, y: labelShape.y },
            startWorldPos: { x: worldPos.x, y: worldPos.y },
            totalDx: 0,
            totalDy: 0
        };
        app.interactionState = 'moveDrag';
        app.didDrag = false;
        if (app.viewport?.svg) app.viewport.svg.style.cursor = 'move';

        app.renderShapes(true);
        app.fileManager.setDirty(true);
    });
    menu.appendChild(item);

    document.body.appendChild(menu);
    attachDismissHandlers(menu);
}
