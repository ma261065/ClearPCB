/**
 * Net names and wire-name labels across wire edits: which label and net name survive a
 * merge, how they are shared out after a split, and where a wire's name label sits.
 */
import { Wire } from '../../shapes/index.js';
import { Text } from '../../shapes/text.js';
import { freeWireLabel, nextWireLabel, bumpWireLabelCounter, freeNetName, bumpNetNameCounter, nextNetName } from '../../shapes/wire.js';
import { attachLabelToTarget, getLabelDropHotspot } from './label-attachment.js';
import { addShapeInternal } from './shape-management.js';

function _syncWireLabelText(wire) {
    const primary = _getPrimaryWireNameLabel(wire);
    if (!primary) return;
    _setPrimaryWireNameLabel(wire, primary);
    primary.text = wire.wireLabel;
    primary.invalidate();
}

function _setPrimaryWireNameLabel(wire, label) {
    if (!wire || !label) return;
    const attached = wire.attachedLabels;
    if (attached instanceof Set) {
        for (const candidate of attached) {
            if (!candidate?.attachment || typeof candidate.attachment !== 'object') continue;
            if (candidate === label) {
                candidate.attachment.wireName = true;
            } else if (candidate.attachment.wireName) {
                delete candidate.attachment.wireName;
            }
        }
    }
    if (!label.attachment || typeof label.attachment !== 'object') {
        label.attachment = {};
    }
    label.attachment.wireName = true;
}

function _getPrimaryWireNameLabel(wire) {
    if (!wire) return null;
    const attached = wire.attachedLabels;
    if (!(attached instanceof Set) || attached.size === 0) return wire.labelText || null;

    const labels = Array.from(attached).filter(l =>
        l?.type === 'text'
        && l.fieldKey === 'label'
        && l.parentComponent === wire
    );
    if (labels.length === 0) return wire.labelText || null;

    const marked = labels.find(l => l?.attachment?.wireName === true) || null;
    if (marked) return marked;

    const matching = labels.find(l => String(l.text || '').toLowerCase() === String(wire.wireLabel || '').toLowerCase()) || null;
    if (matching) {
        _setPrimaryWireNameLabel(wire, matching);
        return matching;
    }

    _setPrimaryWireNameLabel(wire, labels[0]);
    return labels[0] || null;
}

function _ensureWireNameLabel(app, wire, visible = false) {
    let label = _getPrimaryWireNameLabel(wire);
    if (!label && app) {
        const pos = getWireLabelPosition(wire) || wire.getLabelPosition();
        label = new Text(/** @type {any} */ ({
            x: pos.x,
            y: pos.y,
            text: wire.wireLabel,
            fontSize: 1.4,
            fontFamily: 'Arial',
            textAnchor: 'middle',
            color: 'var(--sch-wire-label, #669966)'
        }));
        addShapeInternal(app, label);
        attachLabelToTarget(label, wire, { x: label.x, y: label.y }, { isNewLabel: true });
    }
    if (label) {
        _setPrimaryWireNameLabel(wire, label);
        label.text = wire.wireLabel;
        label.visible = visible;
        label.invalidate?.();
    }
    return label;
}

/**
 * Resolve the live Text shape that backs a wire's name label: the primary
 * attached label if present, otherwise the legacy `wire.labelText`, otherwise
 * null (the label state lives only in the wire's pending-* fields).
 * @returns {Text|null}
 */
function wireLabelTextTarget(wire) {
    return _getPrimaryWireNameLabel(wire) || wire.labelText || null;
}

function _setWireLabelVisibility(wire, visible) {
    const target = wireLabelTextTarget(wire);
    if (target) {
        target.visible = visible;
        target.invalidate();
        return;
    }
    wire._pendingLabelVisible = visible;
}

export function getWireLabelVisibility(wire) {
    const target = wireLabelTextTarget(wire);
    if (target) return !!target.visible;
    if (wire._pendingLabelVisible !== undefined) return wire._pendingLabelVisible;
    return false;
}

function _setWireLabelPosition(wire, position) {
    if (!position) return;
    const target = wireLabelTextTarget(wire);
    const rotation = position.rotation
        ?? target?.rotation
        ?? wire._pendingLabelPosition?.rotation
        ?? 0;
    if (target) {
        target.x = position.x;
        target.y = position.y;
        target.rotation = rotation;
        target.invalidate();
        return;
    }
    wire._pendingLabelPosition = {
        x: position.x,
        y: position.y,
        rotation
    };
}

function _resetWireLabelPositionToDefault(wire) {
    const pos = wire.getLabelPosition();
    const target = wireLabelTextTarget(wire);
    const rotation = target?.rotation ?? wire._pendingLabelPosition?.rotation ?? 0;
    if (target) {
        target.x = pos.x;
        target.y = pos.y;
        target.rotation = rotation;
        target.invalidate();
        return;
    }
    wire._pendingLabelPosition = {
        x: pos.x,
        y: pos.y,
        rotation
    };
}

export function getWireLabelPosition(wire) {
    const target = wireLabelTextTarget(wire);
    if (target) {
        return { x: target.x, y: target.y, rotation: target.rotation || 0 };
    }
    if (wire._pendingLabelPosition) {
        return {
            x: wire._pendingLabelPosition.x,
            y: wire._pendingLabelPosition.y,
            rotation: wire._pendingLabelPosition.rotation || 0
        };
    }
    return null;
}

function _distanceToClosest(pos, refs) {
    if (!refs || refs.length === 0) return Infinity;
    let min = Infinity;
    for (const ref of refs) {
        const d = Math.hypot(pos.x - ref.x, pos.y - ref.y);
        if (d < min) min = d;
    }
    return min;
}

function _deoverlapWireLabelPosition(wire, referencePositions) {
    const current = getWireLabelPosition(wire);
    if (!current) return null;
    const refs = Array.isArray(referencePositions) ? referencePositions.filter(Boolean) : [];
    const minDist = 0.9;
    if (_distanceToClosest(current, refs) >= minDist) return current;

    // Place on the opposite side of this wire using the local segment normal.
    // Keep similar offset magnitude, but enforce a minimum clearance based on
    // font size so the label baseline does not sit on the wire.
    const nearest = wire.closestEdge(current);
    if (!nearest || !nearest.point) return null;

    const edge = wire.edges.get(nearest.edgeId);
    if (!edge) return null;
    const a = wire.nodes.get(edge.from);
    const b = wire.nodes.get(edge.to);
    if (!a || !b) return null;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    // Signed normal distance from current label to this wire segment.
    const signedCurrent = (current.x - nearest.point.x) * nx + (current.y - nearest.point.y) * ny;
    // Default to neutral centerline unless a nearby reference label exists.
    let signedReference = 0;
    if (refs.length > 0) {
        const closestRef = refs.reduce((best, ref) => {
            const d = Math.hypot(current.x - ref.x, current.y - ref.y);
            if (!best || d < best.d) return { ref, d };
            return best;
        }, null)?.ref;
        if (closestRef) {
            signedReference = (closestRef.x - nearest.point.x) * nx + (closestRef.y - nearest.point.y) * ny;
        }
    }

    const fontSize = wire.labelText?.fontSize ?? 1.4;
    const minOffset = Math.max(0.95, fontSize * 1.05);

    let targetSigned;
    if (Math.abs(signedCurrent) < 1e-6) {
        // If centered, choose opposite side of the nearest reference when available.
        const refSign = Math.abs(signedReference) < 1e-6 ? 1 : Math.sign(signedReference);
        targetSigned = -refSign * minOffset;
    } else {
        // Otherwise mirror across the wire and preserve/raise clearance.
        targetSigned = -Math.sign(signedCurrent) * Math.max(Math.abs(signedCurrent), minOffset);
    }

    let mirrored = {
        x: nearest.point.x + nx * targetSigned,
        y: nearest.point.y + ny * targetSigned
    };

    // If still too close to another label, push farther on the chosen side.
    if (_distanceToClosest(mirrored, refs) < minDist) {
        const expanded = {
            x: nearest.point.x + nx * targetSigned * 1.35,
            y: nearest.point.y + ny * targetSigned * 1.35
        };
        mirrored = _distanceToClosest(expanded, refs) > _distanceToClosest(mirrored, refs)
            ? expanded
            : mirrored;
    }

    _setWireLabelPosition(wire, { x: mirrored.x, y: mirrored.y, rotation: current.rotation });
    return getWireLabelPosition(wire);
}

/**
 * Reassign a wire's human-readable label (Wnnnn), freeing the previous
 * label and registering the new one in the allocation pool.  No-op when the
 * value is unchanged.  (Labels have no "default" tier — every label is equal.)
 */
function _adoptWireLabel(wire, label) {
    if (!label || wire.wireLabel === label) return;
    freeWireLabel(wire.wireLabel);
    wire.wireLabel = label;
    bumpWireLabelCounter(label);
}

/**
 * Reassign a wire's net name, freeing the previous name and registering the
 * new one in the allocation pool.  No-op when the value is unchanged.
 */
function _adoptNetName(wire, net) {
    if (!net || wire.net === net) return;
    if (wire.net) freeNetName(wire.net);
    wire.net = net;
    bumpNetNameCounter(net);
}

/** Case-insensitive wireLabel comparator (negative => prefer `a`). */
const _wireLabelTieBreak = (a, b) =>
    String(a.wireLabel).localeCompare(String(b.wireLabel), undefined, { sensitivity: 'base' });

/**
 * Pick the post-split fragment that should retain the pre-split identity.
 * Shared policy for both label and net splits:
 *   1. most segments wins;
 *   2. on a size tie, the pre-split owner (`preferredOnTie` / originalWire) is kept;
 *   3. if neither tied candidate is the preferred owner, the optional `tieBreak`
 *      comparator decides (return < 0 to prefer the candidate).
 *
 * The label and net splits differ ONLY in step 3:
 *   • label split breaks the remaining tie by case-insensitive wireLabel order;
 *   • net split passes no comparator, so the earlier fragment is kept (array order).
 * Everything else is identical, which is why they share this selector.
 * @param {Array<any>} wires
 * @param {any|null} [preferredOnTie]
 * @param {((a:any,b:any)=>number)|null} [tieBreak]
 */
function _selectSurvivor(wires, preferredOnTie = null, tieBreak = null) {
    if (!wires || wires.length === 0) return null;
    let winner = wires[0];
    for (let i = 1; i < wires.length; i++) {
        const candidate = wires[i];
        if (candidate.edges.size > winner.edges.size) {
            winner = candidate;
            continue;
        }
        if (candidate.edges.size === winner.edges.size) {
            if (preferredOnTie && candidate === preferredOnTie) {
                winner = candidate;
                continue;
            }
            if (preferredOnTie && winner === preferredOnTie) continue;
            if (tieBreak && tieBreak(candidate, winner) < 0) {
                winner = candidate;
            }
        }
    }
    return winner;
}

function _shouldUseRemovedLabel(keeperPreSegs, removedPreSegs, keeperVisible, removedVisible, keeperLabel = '', removedLabel = '') {
    if (keeperVisible !== removedVisible) return removedVisible;
    if (removedPreSegs !== keeperPreSegs) return removedPreSegs > keeperPreSegs;
    return String(removedLabel).localeCompare(String(keeperLabel), undefined, { sensitivity: 'base' }) < 0;
}

export function captureShapeSnapshot(shape) {
    const state = shape.captureState();
    return { state, signature: JSON.stringify(state) };
}

export function snapshotChanged(snapshot, afterState) {
    return snapshot.signature !== JSON.stringify(afterState);
}

export function normalizeSnapshot(snapshotOrState) {
    if (snapshotOrState && typeof snapshotOrState === 'object' && 'state' in snapshotOrState && 'signature' in snapshotOrState) {
        return snapshotOrState;
    }
    return {
        state: snapshotOrState,
        signature: JSON.stringify(snapshotOrState)
    };
}

export function rehomeAttachedWireLabelsAfterSplit(originalWire, postSplitWires) {
    const attached = originalWire?.attachedLabels;
    if (!(attached instanceof Set) || attached.size === 0) return;

    const protectedNameLabel = _getPrimaryWireNameLabel(originalWire);

    const candidates = (postSplitWires || []).filter(w => w?.type === 'wire' && w.edges?.size > 0);
    if (candidates.length === 0) return;

    const labels = Array.from(attached).filter(label =>
        label?.type === 'text'
        && label.fieldKey === 'label'
        && label.parentComponent === originalWire
        && label !== protectedNameLabel
    );

    for (const label of labels) {
        const probe = getLabelDropHotspot(label);
        let best = null;
        for (const wire of candidates) {
            const nearest = typeof wire.closestEdge === 'function' ? wire.closestEdge(probe) : null;
            if (!nearest?.point) continue;
            if (!best || nearest.distance < best.distance) {
                best = { wire, nearest, distance: nearest.distance };
            }
        }
        if (!best) continue;

        const targetWire = best.wire;
        if (targetWire !== originalWire) {
            attached.delete(label);
            if (attached.size === 0) delete originalWire.attachedLabels;
            if (!(targetWire.attachedLabels instanceof Set)) {
                targetWire.attachedLabels = new Set();
            }
            targetWire.attachedLabels.add(label);
            if (label.parentComponent?.labelText === label) {
                label.parentComponent.labelText = null;
            }
            label.parentComponent = targetWire;
        }

        const nearest = best.nearest;
        const anchor = nearest.point || probe;
        if (!label.attachment || typeof label.attachment !== 'object') {
            label.attachment = {};
        }
        label.attachment.kind = 'wire';
        label.attachment.edgeId = nearest.edgeId || null;
        label.attachment.t = Number.isFinite(nearest.t) ? nearest.t : 0.5;
        label.attachment.anchorX = anchor.x;
        label.attachment.anchorY = anchor.y;
        label.attachment.offsetX = label.x - anchor.x;
        label.attachment.offsetY = label.y - anchor.y;

        label.invalidate?.();
        targetWire.invalidate?.();
    }
}

// Wire label rules (implemented behavior):
// 1) Joining:
//    - If only one pre-join wire is visible, that wire's label wins.
//    - If both pre-join wires share visibility (both on or both off), the wire
//      with more pre-join segments wins.
//    - Tie-break is deterministic by label name (case-insensitive lexical order).
//    - Post-join visibility is OR of the two pre-join visibilities.
//
// 2) Splitting:
//    - Winner is the post-split wire with the most segments; it keeps the
//      pre-split label.
//    - Tie-break prefers the current owner of the pre-split label; if still tied,
//      uses deterministic label-name order.
//    - All post-split wires inherit pre-split visibility.
//    - Winner label position is preserved.
//    - Non-winner labels are placed from each wire's default label position,
//      then flipped/de-overlapped against already placed labels.
//
// 3) Hidden/visible consistency:
//    - Positioning logic is shared for visible labelText and pending hidden-label
//      position state so behavior matches in both modes.

export function applyMergeLabelRules(keeper, removed, keeperPreSegs, removedPreSegs, removedLabelMeta, keeperWasChanged = false, removedWasChanged = false) {
    const keeperVis = getWireLabelVisibility(keeper);
    const removedVis = removedLabelMeta.visible;
    const postVisible = keeperVis || removedVis;

    // Join behavior: when a newly drawn wire merges into an existing wire,
    // preserve the existing wire's label identity.
    if (keeperWasChanged && !removedWasChanged) {
        if (removed.wireLabel && removed.wireLabel !== keeper.wireLabel) {
            _adoptWireLabel(keeper, removed.wireLabel);
            _syncWireLabelText(keeper);
            _setWireLabelPosition(keeper, removedLabelMeta.position);
        }
        _setWireLabelVisibility(keeper, postVisible);
        return;
    }

    // Labels have no auto/custom tier (unlike net names), so the winner is
    // chosen purely by visibility, then segment count, then lexical order.
    const useRemovedLabel = _shouldUseRemovedLabel(
        keeperPreSegs,
        removedPreSegs,
        keeperVis,
        removedVis,
        keeper.wireLabel,
        removed.wireLabel
    );

    if (useRemovedLabel) {
        _adoptWireLabel(keeper, removed.wireLabel);
        _syncWireLabelText(keeper);

        _setWireLabelPosition(keeper, removedLabelMeta.position);
    }

    _setWireLabelVisibility(keeper, postVisible);
}

/**
 * @param {Wire} originalWire
 * @param {Wire[]} newFragments
 * @param {string} preSplitLabel
 * @param {boolean} preSplitVisible
 * @param {{x:number,y:number,rotation?:number}|null} [preSplitLabelPosition]
 * @param {object|null} [app]
 */
export function applySplitLabelRules(originalWire, newFragments, preSplitLabel, preSplitVisible, preSplitLabelPosition = null, app = null) {
    const allPostWires = [originalWire, ...newFragments];
    const originalPrimaryLabel = _getPrimaryWireNameLabel(originalWire);
    const currentOwner = allPostWires.find(w => w.wireLabel === preSplitLabel) || null;
    const winner = _selectSurvivor(allPostWires, currentOwner, _wireLabelTieBreak);
    if (!winner) return;

    if (currentOwner !== winner) {
        _adoptWireLabel(winner, preSplitLabel);
        _syncWireLabelText(winner);
        _setWireLabelPosition(winner, preSplitLabelPosition);

        if (currentOwner) {
            // The pre-split label now belongs to the winner; give the previous
            // owner a fresh name WITHOUT freeing the old one (the winner uses it).
            currentOwner.wireLabel = nextWireLabel();
            _syncWireLabelText(currentOwner);
            _resetWireLabelPositionToDefault(currentOwner);
        }
    }

    for (const wire of allPostWires) {
        _setWireLabelVisibility(wire, preSplitVisible);
    }

    if (preSplitVisible && app) {
        if (originalPrimaryLabel) {
            if (originalPrimaryLabel.parentComponent !== originalWire) {
                attachLabelToTarget(originalPrimaryLabel, originalWire, { x: originalPrimaryLabel.x, y: originalPrimaryLabel.y });
            }
            _setPrimaryWireNameLabel(originalWire, originalPrimaryLabel);
            originalPrimaryLabel.text = originalWire.wireLabel;
            originalPrimaryLabel.visible = true;
            originalPrimaryLabel.invalidate?.();
        }
        for (const wire of allPostWires) {
            if (wire === originalWire && originalPrimaryLabel) continue;
            _ensureWireNameLabel(app, wire, true);
        }
    }

    for (const wire of allPostWires) {
        if (wire !== winner) {
            _resetWireLabelPositionToDefault(wire);
        }
    }

    const placedPositions = [];
    const winnerPos = getWireLabelPosition(winner);
    if (winnerPos) placedPositions.push(winnerPos);

    for (const wire of allPostWires) {
        if (wire !== winner) {
            const placed = _deoverlapWireLabelPosition(wire, placedPositions);
            if (placed) placedPositions.push(placed);
        }
    }
}

export function applySplitNetRules(originalWire, newFragments, preSplitNet = '') {
    const allPostWires = [originalWire, ...newFragments].filter(w => w?.type === 'wire');
    if (allPostWires.length <= 1) return;

    // Keep the original net on the largest post-split wire; tie-break prefers
    // originalWire (no further fallback — earlier fragment wins on a deeper tie).
    const winner = _selectSurvivor(allPostWires, originalWire);
    if (!winner) return;

    const winnerNet = preSplitNet || winner.net || nextNetName();
    _adoptNetName(winner, winnerNet);

    for (const wire of allPostWires) {
        if (wire === winner) continue;
        const oldNet = wire.net;
        wire.net = nextNetName();
        // Free the old net only if it is not still in use by the winner
        // (preSplitNet / winnerNet) or already reused as this wire's fresh name.
        if (oldNet && oldNet !== preSplitNet && oldNet !== winnerNet && oldNet !== wire.net) {
            freeNetName(oldNet);
        }
        wire.invalidate?.();
    }

    winner.invalidate?.();
}

/**
 * Transfer all generic attached labels (fieldKey === 'label') from the
 * absorbed wire to the keeper after a graph merge.  Each label's hotspot
 * (bottom-left bounds corner) is probed against the keeper to compute fresh
 * attachment metadata so the label follows the keeper correctly.
 */
export function transferAttachedLabelsOnMerge(keeper, removed) {
    const set = removed?.attachedLabels;
    if (!(set instanceof Set) || set.size === 0) return;

    for (const label of Array.from(set)) {
        if (!label || label.type !== 'text' || label.fieldKey !== 'label') continue;
        if (label.parentComponent !== removed) continue;

        // Move label from removed → keeper sets
        set.delete(label);
        if (!(keeper.attachedLabels instanceof Set)) {
            keeper.attachedLabels = new Set();
        }
        keeper.attachedLabels.add(label);

        // Update ownership
        label.parentComponent = keeper;

        // Compute fresh attachment metadata on the keeper
        const probe = getLabelDropHotspot(label);
        const nearest = typeof keeper.closestEdge === 'function' ? keeper.closestEdge(probe) : null;
        const anchor = nearest?.point ?? probe;
        if (!label.attachment || typeof label.attachment !== 'object') {
            label.attachment = {};
        }
        label.attachment.kind   = 'wire';
        label.attachment.edgeId = nearest?.edgeId ?? null;
        label.attachment.t      = Number.isFinite(nearest?.t) ? nearest.t : 0.5;
        label.attachment.anchorX  = anchor.x;
        label.attachment.anchorY  = anchor.y;
        label.attachment.offsetX  = label.x - anchor.x;
        label.attachment.offsetY  = label.y - anchor.y;

        label.invalidate?.();
    }

    // Invalidate the keeper so ownership tint refreshes
    keeper.invalidate?.();

    // Clean up empty set on removed
    if (set.size === 0) delete removed.attachedLabels;
}

/**
 * Merge net names when two wires are combined.
 *
 * Unlike wire labels, net names have an auto/custom TIER: an auto-assigned
 * name (Net0001, Net0002, …) is a placeholder, while a user-assigned name
 * (VCC, GND, …) carries intent.  So the merge winner is chosen by that tier —
 * a custom name always beats a default one — which is why this policy differs
 * from the label merge (labels fall back to visibility/segments/lexical).
 */
export function mergeNetNames(keeper, removed, keeperWasChanged = false, removedWasChanged = false) {
    if (!removed.net) return;

    // Join behavior: when a newly drawn wire merges into an existing wire,
    // preserve the existing wire's net identity.
    const preferRemovedNet = keeperWasChanged && !removedWasChanged;
    if (preferRemovedNet && removed.net) {
        _adoptNetName(keeper, removed.net);
        return;
    }

    const keeperIsDefault = keeper.net?.startsWith('Net');
    const removedIsDefault = removed.net?.startsWith('Net');

    if (!keeperIsDefault && removedIsDefault) {
        // Keeper has custom net, removed is default → keep keeper's net, free the default
        freeNetName(removed.net);
    } else if (keeperIsDefault && !removedIsDefault) {
        // Keeper has default, removed has custom → adopt the custom, free the default
        _adoptNetName(keeper, removed.net);
    } else {
        // Both custom or both default → free the removed one (keeper keeps its net)
        freeNetName(removed.net);
    }
}
