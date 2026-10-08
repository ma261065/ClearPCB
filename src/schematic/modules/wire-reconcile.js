/**
 * Reconciling wires after an edit: merging wires that now touch, splitting wires that
 * no longer do, dropping redundant points, refreshing pin and no-connect connections,
 * and recording the result as one undoable batch.
 */
import { freeNetName, bumpNetNameCounter, nextNetName } from '../../shapes/wire.js';
import { BatchCommand, AddShapeCommand, ModifyShapeCommand, DeleteShapesCommand } from './commands.js';
import { applyStickyConnections } from './sticky-wires.js';
import { VERTEX_EPSILON } from './wire-constants.js';
import { addShapeInternal, removeShapeInternal } from './shape-management.js';
import { findNearbyPin } from './wire-snap.js';
import { applyMergeLabelRules, applySplitLabelRules, applySplitNetRules, captureShapeSnapshot, getWireLabelPosition, getWireLabelVisibility, mergeNetNames, normalizeSnapshot, rehomeAttachedWireLabelsAfterSplit, snapshotChanged, transferAttachedLabelsOnMerge } from './wire-labels.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicShape} Wire */
/** @typedef {import('../../shapes/noconnect.js').NoConnect} NoConnect */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{state: object, signature?: string}} WireSnapshot */

/** Maximum iterations for pairwise merge loop. */
const MAX_MERGE_ITERATIONS = 50;

// --- Wire point cleanup (graph model — handled by Wire.cleanGraph()) ---

/**
 * Collapse redundant collinear points in a wire.
 * Delegates to Wire.cleanGraph() in the graph model.
 * @param {SchematicEditor} app
 * @param {Wire|null|undefined} wire
 */
export function collapseRedundantWirePoints(app, wire) {
    if (wire && wire.cleanGraph) wire.cleanGraph();
}

// --- Junctions (graph model — junctions are degree ≥ 3 nodes, automatic) ---

/**
 * Check whether a point coincides with a node on any non-excluded wire.
 * @param {SchematicEditor} app
 * @param {Point} pt
 * @param {...Wire} excludeWires
 */
export function isTJunctionPoint(app, pt, ...excludeWires) {
    if (!app) return false;
    for (const s of app.shapes) {
        if (s.type !== 'wire') continue;
        if (excludeWires.includes(s)) continue;
        if (s.nodeAt(pt, VERTEX_EPSILON)) return true;
    }
    return false;
}

// --- Sticky wires (requirement 6) ---

/**
 * Refresh a wire's pin connections by checking which nodes coincide
 * with component pins or Net label connection points.
 * Call after anchor or segment drags, or wire reconciliation.
 * @param {SchematicEditor} app
 * @param {Wire|null|undefined} wire
 */
export function refreshWireConnections(app, wire) {
    if (!wire || wire.type !== 'wire' || wire.edges.size === 0) return;
    const tolerance = 0.1;
    const oldNet = wire.net;
    wire.pinConnections.clear();
    let hasNetLabel = false;
    for (const [nodeId, pos] of wire.nodes) {
        const nearPin = findNearbyPin(app.components, pos, tolerance, app.shapes);
        if (nearPin) {
            wire.pinConnections.set(nodeId, {
                componentId: nearPin.component.id,
                pinNumber: nearPin.pin.number
            });
            // If connected to a Net label, propagate its name
            const nearComponent = /** @type {import('../../core/SchematicDocument.js').SchematicShape} */ (nearPin.component);
            if (nearComponent.type === 'net') {
                hasNetLabel = true;
                const netName = nearComponent.net;
                if (netName && wire.net !== netName) {
                    const isDefault = wire.net?.startsWith('Net');
                    if (isDefault) {
                        freeNetName(wire.net);
                        wire.net = netName;
                        bumpNetNameCounter(netName);
                        app.updatePropertiesPanel?.(app.selection?.getSelection?.() || []);
                    }
                }
            }
        }
    }
    // If wire had a non-default net name but no Net label is connected anymore,
    // revert to a fresh generic name — unless another Net with the same name
    // is still connected via a shared wire network.
    if (!hasNetLabel && oldNet && !oldNet.startsWith('Net')) {
        if (!_isNetNameStillConnected(app, wire, oldNet)) {
            freeNetName(wire.net);
            wire.net = nextNetName();
            app.updatePropertiesPanel?.(app.selection?.getSelection?.() || []);
        }
    }
}

/**
 * Check whether any Net label with the given name is still connected
 * to the wire's network (via shared nodes with other wires).
 * @param {SchematicEditor} app
 * @param {Wire} wire
 * @param {string} netName
 */
function _isNetNameStillConnected(app, wire, netName) {
    // BFS to find all wires in the same connected network
    const visited = new Set([wire]);
    const queue = [wire];
    while (queue.length > 0) {
        const w = queue.shift();
        if (!w) continue;
        for (const pos of w.nodes.values()) {
            for (const other of app.shapes) {
                if (other.type !== 'wire' || visited.has(other)) continue;
                if (other.nodeAt(pos, VERTEX_EPSILON)) {
                    visited.add(other);
                    queue.push(other);
                }
            }
        }
    }
    // Check if any Net label with this name touches any wire in the network
    for (const shape of app.shapes) {
        if (shape.type !== 'net' || shape.net !== netName) continue;
        for (const w of visited) {
            if (w.nodeAt({ x: shape.x, y: shape.y }, VERTEX_EPSILON)) return true;
        }
    }
    return false;
}

/**
 * Refresh a noconnect's pin connection by checking whether its position
 * coincides with a component pin.  Call after dragging a noconnect.
 * @param {SchematicEditor} app
 * @param {NoConnect|import('../../core/SchematicDocument.js').SchematicShape|null|undefined} nc
 */
export function refreshNoConnectConnection(app, nc) {
    if (!nc || nc.type !== 'noconnect') return;
    const tolerance = 0.1;
    const nearPin = findNearbyPin(app.components, { x: nc.x, y: nc.y }, tolerance);
    if (nearPin) {
        nc.pinConnection = {
            componentId: nearPin.component.id,
            pinNumber: nearPin.pin.number
        };
    } else {
        nc.pinConnection = null;
    }
}

/**
 * Call this after moving components. For every wire node that has a pin
 * connection, update that node to the pin's current world position.
 * @param {SchematicEditor} app
 * @param {{movedIds?: Set<string>}} [options]
 */
export function updateStickyWires(app, options = undefined) {
    applyStickyConnections(app, options);
}

// --- Unified wire reconciliation (graph model) ---

/**
 * Try to merge two wire graphs.  Checks if any node of wireA is near
 * a node or on an edge of wireB (and vice-versa).  If found, absorbs
 * wireB into wireA, merges coincident nodes, and removes wireB from
 * app.shapes.  Returns true if a merge occurred.
 * @param {SchematicEditor} app
 * @param {Wire} wireA
 * @param {Wire} wireB
 * @param {Set<Wire>} affected
 * @param {Set<Wire>} changed
 * @returns {boolean}
 */
function _tryMergeGraphs(app, wireA, wireB, affected, changed) {
    // Capture pre-merge segment counts for label winner determination
    const segsA = wireA.edges.size;
    const segsB = wireB.edges.size;
    const keeperWasChanged = changed.has(wireA);
    const removedWasChanged = changed.has(wireB);

    // Forward: A's nodes → B's nodes/edges
    for (const [nodeId, pos] of wireA.nodes) {
        const match = wireB.nodeAt(pos, VERTEX_EPSILON);
        if (match) {
            const remap = wireA.absorb(wireB);
            wireA.mergeNodes(nodeId, /** @type {string} */ (remap.get(match)));
            _removeMerged(app, wireB, affected, changed, wireA, segsA, segsB, keeperWasChanged, removedWasChanged);
            return true;
        }
        const onEdge = wireB.closestEdge(pos);
        if (onEdge && onEdge.distance < VERTEX_EPSILON) {
            const split = /** @type {{newNodeId: string}} */ (wireB.splitEdge(onEdge.edgeId, pos));
            const remap = wireA.absorb(wireB);
            wireA.mergeNodes(nodeId, /** @type {string} */ (remap.get(split.newNodeId)));
            _removeMerged(app, wireB, affected, changed, wireA, segsA, segsB, keeperWasChanged, removedWasChanged);
            return true;
        }
    }
    // Reverse: B's nodes → A's edges
    for (const [nodeId, pos] of wireB.nodes) {
        if (wireA.nodeAt(pos, VERTEX_EPSILON)) continue;
        const onEdge = wireA.closestEdge(pos);
        if (onEdge && onEdge.distance < VERTEX_EPSILON) {
            const split = /** @type {{newNodeId: string}} */ (wireA.splitEdge(onEdge.edgeId, pos));
            const remap = wireA.absorb(wireB);
            wireA.mergeNodes(split.newNodeId, /** @type {string} */ (remap.get(nodeId)));
            _removeMerged(app, wireB, affected, changed, wireA, segsA, segsB, keeperWasChanged, removedWasChanged);
            return true;
        }
    }
    return false;
}

/**
 * @param {SchematicEditor} app
 * @param {Wire} removed
 * @param {Set<Wire>} affected
 * @param {Set<Wire>} changed
 * @param {Wire} keeper
 * @param {number} keeperPreSegs
 * @param {number} removedPreSegs
 * @param {boolean} [keeperWasChanged]
 * @param {boolean} [removedWasChanged]
 */
function _removeMerged(app, removed, affected, changed, keeper, keeperPreSegs, removedPreSegs, keeperWasChanged = false, removedWasChanged = false) {
    const removedLabelMeta = {
        visible: getWireLabelVisibility(removed),
        position: getWireLabelPosition(removed)
    };

    // Transfer generic attached labels to the keeper before the wire is removed
    transferAttachedLabelsOnMerge(keeper, removed);

    // Merge net names before removing the wire
    mergeNetNames(keeper, removed, keeperWasChanged, removedWasChanged);

    // Remove the absorbed wire first (this frees its wireLabel from the tracking set)
    removeShapeInternal(app, removed, { preserveWireLabelRef: true });
    affected.delete(removed);
    changed.delete(removed);
    if (!changed.has(keeper)) changed.add(keeper);

    // Now apply label rules on the keeper
    applyMergeLabelRules(keeper, removed, keeperPreSegs, removedPreSegs, removedLabelMeta, keeperWasChanged, removedWasChanged);
}

/**
 * Unified wire reconciliation (graph model).
 *
 * Given one or more wires that just changed (drawn, moved, dragged),
 * performs 3 sequential passes:
 *
 *   1. Graph merge — absorb touching wires into one graph
 *   2. Clean graph — deduplicate edges, remove collinear degree-2 nodes
 *   3. Split disconnected components into separate Wire objects
 *
 * Discovers affected partner wires automatically by geometric proximity.
 * Modifies wires in place (nodes, edges).  May remove wires from app.shapes.
 *
 * @param {SchematicEditor} app
 * @param {Wire[]} changedWires - the wires that just changed
 * @param {Set<Wire>|null} [skipSet] - wires to skip pairwise checks against
 */
export function reconcileWires(app, changedWires, skipSet = null) {
    const changed = new Set(changedWires.filter(w => app.shapes.includes(w)));
    if (changed.size === 0) return;

    // Discover affected wires (any wire whose nodes/edges are near a changed wire)
    const affected = new Set(changed);
    for (const cw of changed) {
        for (const other of app.shapes) {
            if (other.type !== 'wire' || affected.has(other)) continue;
            if (skipSet && skipSet.has(other)) continue;
            // Forward: changed wire's nodes near other wire's edges
            let found = false;
            for (const pos of cw.nodes.values()) {
                if (other.distanceTo(pos) < VERTEX_EPSILON * 2) {
                    found = true; break;
                }
            }
            // Reverse: other wire's nodes near changed wire's edges
            if (!found) {
                for (const pos of other.nodes.values()) {
                    if (cw.distanceTo(pos) < VERTEX_EPSILON * 2) {
                        found = true; break;
                    }
                }
            }
            if (found) affected.add(other);
        }
    }

    // ── Pass 1: Merge touching graphs ──
    let stable = false;
    let iterations = 0;
    while (!stable && iterations < MAX_MERGE_ITERATIONS) {
        stable = true;
        iterations++;
        for (const wireA of [...affected]) {
            if (!app.shapes.includes(wireA)) continue;
            for (const wireB of [...affected]) {
                if (wireB === wireA || !app.shapes.includes(wireB)) continue;
                if (_tryMergeGraphs(app, wireA, wireB, affected, changed)) {
                    stable = false;
                    break;
                }
            }
            if (!stable) break;
        }
    }

    // ── Pass 2: Clean graphs ──
    for (const w of affected) {
        if (!app.shapes.includes(w)) continue;
        w.cleanGraph();
        if (w.edges.size === 0) removeShapeInternal(app, w, { preserveWireLabelRef: true });
    }

    // ── Pass 3: Split disconnected components ──
    for (const w of [...affected]) {
        if (!app.shapes.includes(w)) continue;
        const comps = w.connectedComponents();
        if (comps.length <= 1) continue;

        // Capture pre-split label state
        const preSplitLabel = w.wireLabel;
        const preSplitVisible = getWireLabelVisibility(w);
        const preSplitLabelPosition = getWireLabelPosition(w);
        const preSplitNet = w.net;

        // Keep the largest component in the original wire
        comps.sort((/** @type {Set<string>} */ a, /** @type {Set<string>} */ b) => b.size - a.size);
        const keepSet = comps[0];

        const newFragments = [];
        for (let i = 1; i < comps.length; i++) {
            const sub = /** @type {Wire} */ (w.extractSubgraph(comps[i]));
            if (sub.edges.size > 0) {
                addShapeInternal(app, sub);
                changed.add(sub);
                newFragments.push(sub);
            }
        }
        // Trim original to keep only the largest component
        for (const nid of [...w.nodes.keys()]) {
            if (!keepSet.has(nid)) w.removeNode(nid);
        }
        w.invalidate();
        if (w.edges.size === 0) { removeShapeInternal(app, w, { preserveWireLabelRef: true }); continue; }

        // ── Split label rules ──
        applySplitLabelRules(w, newFragments, preSplitLabel, preSplitVisible, preSplitLabelPosition, app);

        // ── Split net rules ──
        applySplitNetRules(w, newFragments, preSplitNet);

        // Re-home generic attached labels to the nearest post-split fragment
        rehomeAttachedWireLabelsAfterSplit(w, [w, ...newFragments]);
    }
}

/**
 * Diff wire states before/after mutation and build an undo batch.
 * Reverts all wires to their before-state so batch.execute() replays correctly.
 *
 * @param {SchematicEditor} app
 * @param {Map<Wire, WireSnapshot | object>} beforeStates - captured states before mutation
 * @param {string} label - undo command label
 * @param {Wire[]} [extraAdds] - additional new wires to include as AddShapeCommand
 * @param {Map<any,any>|null} [labelTextBefore] - captured label-text states before mutation
 * @returns {BatchCommand|null} - batch or null if nothing changed
 */
export function buildWireDiffBatch(app, beforeStates, label, extraAdds = [], labelTextBefore = null) {
    const batch = new BatchCommand(label);
    let anyChanges = false;

    // --- Wire diffs (snapshot-based, no revert/replay) ---
    for (const [w, beforeEntry] of beforeStates) {
        const beforeSnapshot = normalizeSnapshot(beforeEntry);
        const before = beforeSnapshot.state;
        if (!app.shapes.includes(w)) {
            // The removed wire object may have been mutated during merge
            // (e.g. temporary split node inserted before absorb). Restore
            // its pre-mutation state so undo re-adds the canonical geometry.
            w.applyState(before);
            // Wire was removed during reconciliation (absorbed) → record deletion.
            // Store a snapshot command that can re-add on undo and re-delete on redo.
            batch.add(new DeleteShapesCommand(app, [w]));
            anyChanges = true;
        } else {
            const after = w.captureState();
            if (snapshotChanged(beforeSnapshot, after)) {
                batch.add(new ModifyShapeCommand(app, w, before, after));
                anyChanges = true;
            }
        }
    }

    // New wires (from splits) — not in beforeStates
    const extraSet = new Set(extraAdds);
    for (const s of [...app.shapes]) {
        if (s.type === 'wire' && !beforeStates.has(s) && !extraSet.has(s)) {
            batch.add(new AddShapeCommand(app, s));
            anyChanges = true;
        }
    }
    // Additional new wires (e.g. the drawn wire in finishWireDrawing)
    for (const w of extraAdds) {
        batch.add(new AddShapeCommand(app, w));
        anyChanges = true;
    }

    // --- Label text diffs ---
    if (labelTextBefore) {
        for (const [lt, beforeEntry] of labelTextBefore) {
            const beforeSnapshot = normalizeSnapshot(beforeEntry);
            const before = beforeSnapshot.state;
            if (!app.shapes.includes(lt)) continue;
            const after = lt.captureState();
            if (snapshotChanged(beforeSnapshot, after)) {
                batch.add(new ModifyShapeCommand(app, lt, before, after));
                anyChanges = true;
            }
        }
    }

    return anyChanges ? batch : null;
}

/**
 * Build undo commands for wire reconciliation.  Snapshots all wire state
 * before reconciliation, runs it, then diffs to create the undo batch.
 *
 * @param {SchematicEditor} app
 * @param {Wire[]} changedWires
 * @param {Set<Wire>|null} [skipSet]
 * @returns {BatchCommand|null} - batch command or null if nothing changed
 */
export function reconcileWiresWithUndo(app, changedWires, skipSet = null) {
    // Snapshot all wires BEFORE
    const allWires = app.shapes.filter(s => s.type === 'wire');
    const beforeStates = new Map(allWires.map(w => [w, captureShapeSnapshot(w)]));

    // Snapshot all wire label texts BEFORE
    const labelTextBefore = new Map();
    for (const w of allWires) {
        if (w.labelText && app.shapes.includes(w.labelText)) {
            labelTextBefore.set(w.labelText, captureShapeSnapshot(w.labelText));
        }
    }

    // Run reconciliation
    reconcileWires(app, changedWires, skipSet);

    // Refresh pin connections for all surviving changed wires
    for (const cw of changedWires) {
        if (app.shapes.includes(cw)) refreshWireConnections(app, cw);
    }

    // Diff and build undo batch (pure snapshot, no revert/replay)
    const batch = buildWireDiffBatch(app, beforeStates, 'Wire reconciliation', [], labelTextBefore);
    if (!batch) return null;

    // Record to undo stack without executing — state is already correct
    app.history.record(batch);
    return batch;
}
