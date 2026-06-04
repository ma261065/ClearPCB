/**
 * Generic label attachment helpers.
 */

import { closestPointOnSegment, distance } from '../../core/geometry.js';

const WIRE_ATTACHED_LABEL_FONT_SIZE = 1.4;
const DEFAULT_WIRE_LABEL_OFFSET = 1.0;

function getShapeCenter(shape) {
    if (!shape?.getBounds) return { x: shape?.x || 0, y: shape?.y || 0 };
    const b = shape.getBounds();
    return {
        x: (b.minX + b.maxX) / 2,
        y: (b.minY + b.maxY) / 2
    };
}

function ensureAttachedLabelsSet(target) {
    if (!target || typeof target !== 'object') return null;
    if (!(target.attachedLabels instanceof Set)) {
        target.attachedLabels = new Set();
    }
    return target.attachedLabels;
}

function addAttachedLabel(target, labelShape) {
    const attached = ensureAttachedLabelsSet(target);
    if (!attached || !labelShape) return;
    attached.add(labelShape);
}

function removeAttachedLabel(target, labelShape) {
    const attached = target?.attachedLabels;
    if (!(attached instanceof Set) || !labelShape) return;
    attached.delete(labelShape);
    if (attached.size === 0) {
        delete target.attachedLabels;
    }
}

function closestPointOnShapeGeometry(target, pt) {
    const type = target?.type;

    // Graph-based shapes (polyline, line, polygon, wire) — use closestEdge API
    if (typeof target?.closestEdge === 'function') {
        const result = target.closestEdge(pt);
        return result?.point || null;
    }

    if (type === 'circle') {
        const dx = pt.x - target.x, dy = pt.y - target.y;
        const dist = Math.hypot(dx, dy);
        if (dist === 0) return { x: target.x + target.radius, y: target.y };
        return { x: target.x + dx / dist * target.radius, y: target.y + dy / dist * target.radius };
    }

    if (type === 'arc') {
        const dx = pt.x - target.x, dy = pt.y - target.y;
        const angle = Math.atan2(dy, dx);
        if (target._isAngleInRange?.(angle)) {
            const dist = Math.hypot(dx, dy);
            if (dist === 0) return target.getStartPoint?.() || null;
            return { x: target.x + dx / dist * target.radius, y: target.y + dy / dist * target.radius };
        }
        const sp = target.getStartPoint?.();
        const ep = target.getEndPoint?.();
        if (sp && ep) {
            const ds = distance(pt, sp), de = distance(pt, ep);
            return ds <= de ? sp : ep;
        }
        return sp || ep || null;
    }

    return null;
}

function getNonWireAnchor(target, referencePoint) {
    // For components (have definition), use center
    if (target?.definition) {
        return getShapeCenter(target);
    }
    // For primitive shapes, find closest point on actual geometry
    if (referencePoint) {
        const cp = closestPointOnShapeGeometry(target, referencePoint);
        if (cp) return cp;
    }
    if (typeof target?.getPosition === 'function') return target.getPosition();
    return getShapeCenter(target);
}

function getWireAnchorFromAttachment(wire, attachment) {
    if (!wire || wire.type !== 'wire' || !attachment) return null;

    const edge = wire.edges?.get(attachment.edgeId);
    if (edge) {
        const from = wire.nodes.get(edge.from);
        const to = wire.nodes.get(edge.to);
        if (from && to) {
            const t = Number.isFinite(attachment.t) ? attachment.t : 0.5;
            return {
                x: from.x + (to.x - from.x) * t,
                y: from.y + (to.y - from.y) * t
            };
        }
    }

    const fallback = wire.closestEdge?.({ x: attachment.anchorX || 0, y: attachment.anchorY || 0 });
    if (!fallback) return null;
    attachment.edgeId = fallback.edgeId;
    attachment.t = fallback.t;
    return { x: fallback.point.x, y: fallback.point.y };
}

function getDefaultWireLabelOffset(wire, closest) {
    const edge = closest?.edgeId ? wire?.edges?.get(closest.edgeId) : null;
    const from = edge ? wire.nodes.get(edge.from) : null;
    const to = edge ? wire.nodes.get(edge.to) : null;

    if (!from || !to) {
        return { x: 0, y: -DEFAULT_WIRE_LABEL_OFFSET };
    }

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
        return { x: 0, y: -DEFAULT_WIRE_LABEL_OFFSET };
    }

    let nx = -dy / len;
    let ny = dx / len;

    // Prefer a stable, mostly-upward side when ambiguous.
    if (ny > 0 || (Math.abs(ny) < 1e-6 && nx < 0)) {
        nx = -nx;
        ny = -ny;
    }

    return {
        x: nx * DEFAULT_WIRE_LABEL_OFFSET,
        y: ny * DEFAULT_WIRE_LABEL_OFFSET
    };
}

/**
 * Compute the canonical probe point for label attachment targeting.
 *
 * Contract:
 * - Primary probe is the text bounds bottom-left corner (`minX`, `maxY`).
 * - If bounds are unavailable, fallback is the text anchor (`x`, `y`).
 * - Non-text callers can provide a fallback position.
 *
 * This helper is shared by drag/drop attach and wire split re-home logic,
 * so both paths choose targets with identical geometry semantics.
 */
export function getLabelDropHotspot(labelShape, fallbackPos = null) {
    if (!labelShape || labelShape.type !== 'text') {
        if (fallbackPos) return { x: fallbackPos.x, y: fallbackPos.y };
        return { x: labelShape?.x || 0, y: labelShape?.y || 0 };
    }
    const b = labelShape.getBounds?.();
    if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxY)) {
        return { x: b.minX, y: b.maxY };
    }
    return { x: labelShape.x, y: labelShape.y };
}

export function getLabelAttachmentAnchorPoint(labelShape, referencePoint = null) {
    if (!labelShape || labelShape.type !== 'text') return null;
    const target = labelShape.parentComponent;
    if (!target) return null;
    const att = labelShape.attachment;

    if (target.type === 'wire') {
        if (referencePoint) {
            const closest = target.closestEdge?.(referencePoint);
            if (closest?.point) return { x: closest.point.x, y: closest.point.y };
        }
        if (!att) return null;
        return getWireAnchorFromAttachment(target, att);
    }

    return getNonWireAnchor(target, referencePoint);
}

/**
 * Attach a generic label Text shape to a target shape/component.
 * @param {object} labelShape
 * @param {object} target
 * @param {{x:number,y:number}|null} [snapPos]
 * @param {{isNewLabel?:boolean}} [opts]
 */
export function attachLabelToTarget(labelShape, target, snapPos = null, { isNewLabel = false } = {}) {
    if (!labelShape || labelShape.type !== 'text') return;

    const previousTarget = labelShape.parentComponent || null;
    if (previousTarget) {
        removeAttachedLabel(previousTarget, labelShape);
    }

    if (labelShape.parentComponent?.labelText === labelShape) {
        labelShape.parentComponent.labelText = null;
    }

    labelShape.parentComponent = target;
    labelShape.fieldKey = 'label';

    if (!target) {
        labelShape.attachment = null;
        labelShape.invalidate?.();
        return;
    }

    addAttachedLabel(target, labelShape);

    if (target.type === 'wire') {
        if (labelShape.fontSize !== WIRE_ATTACHED_LABEL_FONT_SIZE) {
            labelShape.fontSize = WIRE_ATTACHED_LABEL_FONT_SIZE;
        }
        const probe = snapPos || { x: labelShape.x, y: labelShape.y };
        const closest = target.closestEdge?.(probe);
        const anchor = closest?.point || probe;
        const t = Number.isFinite(closest?.t) ? closest.t : 0.5;

        let offsetX = labelShape.x - anchor.x;
        let offsetY = labelShape.y - anchor.y;
        if (isNewLabel && Math.hypot(offsetX, offsetY) < 0.01) {
            const defaultOffset = getDefaultWireLabelOffset(target, closest);
            offsetX = defaultOffset.x;
            offsetY = defaultOffset.y;
            labelShape.x = anchor.x + offsetX;
            labelShape.y = anchor.y + offsetY;
        }

        labelShape.attachment = {
            kind: 'wire',
            edgeId: closest?.edgeId || null,
            t,
            anchorX: anchor.x,
            anchorY: anchor.y,
            offsetX,
            offsetY
        };

        if (labelShape.text && labelShape.text !== target.wireLabel) {
            target.wireLabel = labelShape.text;
            target.invalidate?.();
        }
    } else {
        const anchor = getNonWireAnchor(target);
        labelShape.attachment = {
            kind: 'shape',
            offsetX: labelShape.x - anchor.x,
            offsetY: labelShape.y - anchor.y
        };
    }

    labelShape.invalidate?.();
}

export function detachLabel(labelShape) {
    if (!labelShape || labelShape.type !== 'text') return;
    removeAttachedLabel(labelShape.parentComponent, labelShape);
    if (labelShape.parentComponent?.labelText === labelShape) {
        labelShape.parentComponent.labelText = null;
    }
    labelShape.parentComponent = null;
    // Keep fieldKey='label' so the shape remains identifiable as a label
    // and can be reattached via context menu or drag-drop.
    labelShape.attachment = null;
    labelShape.invalidate?.();
}

export function refreshLabelAttachmentOffset(labelShape) {
    if (!labelShape || labelShape.type !== 'text') return;
    const target = labelShape.parentComponent;
    const att = labelShape.attachment;
    if (!target || !att) return;

    if (target.type === 'wire') {
        const closest = target.closestEdge?.({ x: labelShape.x, y: labelShape.y });
        if (!closest?.point) return;
        att.kind = 'wire';
        att.edgeId = closest.edgeId || null;
        att.t = Number.isFinite(closest.t) ? closest.t : 0.5;
        att.anchorX = closest.point.x;
        att.anchorY = closest.point.y;
        att.offsetX = labelShape.x - closest.point.x;
        att.offsetY = labelShape.y - closest.point.y;
        return;
    }

    const anchor = getNonWireAnchor(target);
    att.kind = 'shape';
    att.offsetX = labelShape.x - anchor.x;
    att.offsetY = labelShape.y - anchor.y;
}

/**
 * Keep attached labels aligned with their parent target.
 */
export function syncAttachedLabels(app) {
    const isDraggingLabel = app.drag?.mode === 'move'
        && app.selection?.getSelection?.().length === 1
        && app.selection.getSelection()[0]?.type === 'text';

    for (const shape of app.shapes) {
        if (shape?.type !== 'text') continue;
        if (shape.fieldKey !== 'label' || !shape.parentComponent) continue;
        if (isDraggingLabel && shape.selected) continue;

        const target = shape.parentComponent;
        addAttachedLabel(target, shape);
        const att = shape.attachment || { kind: target.type === 'wire' ? 'wire' : 'shape', offsetX: 0, offsetY: 0 };
        shape.attachment = att;

        let anchor = null;
        if (target.type === 'wire') {
            if (shape.fontSize !== WIRE_ATTACHED_LABEL_FONT_SIZE) {
                shape.fontSize = WIRE_ATTACHED_LABEL_FONT_SIZE;
                shape.invalidate?.();
            }
            anchor = getWireAnchorFromAttachment(target, att);
        } else {
            anchor = getNonWireAnchor(target);
            // Labels manage their own rotation (via Space toggle).
            // Don't force-sync rotation from the parent shape.
        }
        if (!anchor) continue;

        if (!Number.isFinite(att.offsetX)) att.offsetX = 0;
        if (!Number.isFinite(att.offsetY)) att.offsetY = 0;

        const nextX = anchor.x + att.offsetX;
        const nextY = anchor.y + att.offsetY;

        if (Math.abs(shape.x - nextX) > 1e-6 || Math.abs(shape.y - nextY) > 1e-6) {
            shape.x = nextX;
            shape.y = nextY;
            shape.invalidate?.();
        }
    }
}
