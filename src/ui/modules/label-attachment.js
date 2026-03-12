/**
 * Generic label attachment helpers.
 */

const WIRE_ATTACHED_LABEL_FONT_SIZE = 1.4;

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

function getNonWireAnchor(target) {
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
        if (!att) return null;
        return getWireAnchorFromAttachment(target, att);
    }

    if (target.type === 'circle' && typeof target.getAnchors === 'function') {
        const anchors = target.getAnchors();
        const radiusAnchor = anchors.find(a => a.id === 'radius')
            || anchors.find(a => a.id !== 'center')
            || null;
        if (radiusAnchor && Number.isFinite(radiusAnchor.x) && Number.isFinite(radiusAnchor.y)) {
            return { x: radiusAnchor.x, y: radiusAnchor.y };
        }
    }

    return getNonWireAnchor(target);
}

/**
 * Attach a generic label Text shape to a target shape/component.
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

        labelShape.attachment = {
            kind: 'wire',
            edgeId: closest?.edgeId || null,
            t,
            anchorX: anchor.x,
            anchorY: anchor.y,
            offsetX: labelShape.x - anchor.x,
            offsetY: labelShape.y - anchor.y,
            followRotation: false
        };

        if (isNewLabel) {
            labelShape.text = target.wireLabel || '';
        }
        if (target.wireLabel && labelShape.text !== target.wireLabel) {
            target.wireLabel = labelShape.text;
            target.invalidate?.();
        }
    } else {
        const anchor = getNonWireAnchor(target);
        labelShape.attachment = {
            kind: 'shape',
            offsetX: labelShape.x - anchor.x,
            offsetY: labelShape.y - anchor.y,
            followRotation: true
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
    labelShape.fieldKey = null;
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
        if (att.followRotation == null) att.followRotation = false;
        return;
    }

    const anchor = getNonWireAnchor(target);
    att.kind = 'shape';
    att.offsetX = labelShape.x - anchor.x;
    att.offsetY = labelShape.y - anchor.y;
    if (att.followRotation == null) att.followRotation = true;
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
