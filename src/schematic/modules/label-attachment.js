/**
 * Generic label attachment helpers.
 */

import {
    closestPointOnSegment,
    connectBoxOutlines,
    connectPointToBoxOutline,
    distance,
} from '../../core/geometry.js';
import { getTextEditBoxWorldCorners } from '../../core/text-edit-geometry.js';
import { applyTextConnectionGuide } from '../../shared/ui/inline-text-overlay.js';
import { getSchematicDrag } from './drag.js';
import { getSchematicTextEdit } from './text-edit.js';
import { isTextItem as isTextShape, isWireItem as isWireShape, isComponentItem as isComponentShape, isCircleItem as isCircleShape, isArcItem as isArcShape } from '../../core/schematic-items.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {import('../../shapes/arc.js').Arc} Arc */
/** @typedef {import('../../shapes/circle.js').Circle} Circle */
/** @typedef {import('../../shapes/text.js').Text} Text */
/** @typedef {import('../../shapes/wire.js').Wire} Wire */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{kind?: string, edgeId?: string|null, t?: number, anchorX?: number, anchorY?: number, offsetX?: number, offsetY?: number}} LabelAttachment */
/** @typedef {{edgeId?: string|null, t?: number, point?: Point}} ClosestEdge */
/** @typedef {{from: string, to: string}} GraphEdge */
/** @typedef {{minX: number, minY: number, maxX: number, maxY: number}} Bounds */
/** @typedef {SchematicItem & {attachedLabels?: Set<Text>|null}} LabelAttachable */
/** @typedef {SchematicItem & {getPosition: () => Point}} PositionReadable */
/** @typedef {SchematicItem & {closestEdge: (point: Point) => ClosestEdge|null|undefined}} EdgeQueryable */
/** @typedef {{x: number, y: number, rotation?: number, refText?: Text|null, valueText?: Text|null, _getLocalBounds: () => Bounds}} ComponentGuideTarget */

const WIRE_ATTACHED_LABEL_FONT_SIZE = 1.4;
const DEFAULT_WIRE_LABEL_OFFSET = 1.0;
/** @type {WeakMap<SchematicEditor, SVGLineElement>} */
const labelGuides = new WeakMap();

/**
 * @param {SchematicItem|null|undefined} shape
 * @returns {shape is Wire|import('../../shapes/net.js').Net}
 */
function hasLabelText(shape) {
    return shape?.type === 'wire' || shape?.type === 'net';
}

/**
 * @param {SchematicItem|null|undefined} shape
 * @returns {shape is PositionReadable}
 */
function hasPositionGetter(shape) {
    return typeof shape?.getPosition === 'function';
}

/**
 * @param {SchematicItem|null|undefined} shape
 * @returns {shape is EdgeQueryable}
 */
function hasClosestEdge(shape) {
    return !!shape && 'closestEdge' in shape && typeof shape.closestEdge === 'function';
}

/**
 * @param {unknown} target
 * @param {Text} label
 * @returns {target is ComponentGuideTarget}
 */
function isComponentFieldTextTarget(target, label) {
    if (!target || typeof target !== 'object') return false;
    const candidate = /** @type {Partial<ComponentGuideTarget>} */ (target);
    return (candidate.refText === label || candidate.valueText === label)
        && typeof candidate._getLocalBounds === 'function'
        && typeof candidate.x === 'number'
        && typeof candidate.y === 'number';
}

/**
 * @param {SchematicItem|null|undefined} shape
 * @returns {Point}
 */
function getShapePosition(shape) {
    if (shape && 'x' in shape && 'y' in shape
        && typeof shape.x === 'number' && typeof shape.y === 'number') {
        return { x: shape.x, y: shape.y };
    }
    return { x: 0, y: 0 };
}

/** @param {SchematicEditor} app */
export function getLabelGuideElement(app) {
    return labelGuides.get(app) || null;
}

/** @param {SchematicEditor} app @param {SVGLineElement|null} guide */
function setLabelGuideElement(app, guide) {
    if (guide) labelGuides.set(app, guide);
    else labelGuides.delete(app);
}

/**
 * @param {SchematicItem|null|undefined} shape
 * @returns {Point}
 */
function getShapeCenter(shape) {
    if (!shape?.getBounds) return getShapePosition(shape);
    const b = /** @type {{minX: number, minY: number, maxX: number, maxY: number}} */ (shape.getBounds());
    return {
        x: (b.minX + b.maxX) / 2,
        y: (b.minY + b.maxY) / 2
    };
}

/**
 * @param {SchematicItem|null|undefined} target
 * @returns {Set<SchematicItem>|null}
 */
function ensureAttachedLabelsSet(target) {
    if (!target || typeof target !== 'object') return null;
    // Label attachment owns this runtime registry for all attachable target kinds.
    const attachable = /** @type {LabelAttachable} */ (target);
    if (!(attachable.attachedLabels instanceof Set)) {
        attachable.attachedLabels = new Set();
    }
    return attachable.attachedLabels;
}

/** @param {SchematicItem|null|undefined} target @param {Text|null|undefined} labelShape */
function addAttachedLabel(target, labelShape) {
    const attached = ensureAttachedLabelsSet(target);
    if (!attached || !labelShape) return;
    attached.add(labelShape);
}

/** @param {SchematicItem|null|undefined} target @param {Text|null|undefined} labelShape */
function removeAttachedLabel(target, labelShape) {
    if (!target) return;
    // Label attachment owns this runtime registry for all attachable target kinds.
    const attachable = /** @type {LabelAttachable} */ (target);
    const attached = attachable.attachedLabels;
    if (!(attached instanceof Set) || !labelShape) return;
    attached.delete(labelShape);
    if (attached.size === 0) {
        delete attachable.attachedLabels;
    }
}

/**
 * @param {SchematicItem|null|undefined} target
 * @param {Point} pt
 * @returns {Point|null}
 */
function closestPointOnShapeGeometry(target, pt) {
    if (!target) return null;

    // Graph-based shapes (polyline, line, polygon, wire) — use closestEdge API
    if (hasClosestEdge(target)) {
        const result = target.closestEdge(pt);
        return result?.point || null;
    }

    if (isCircleShape(target)) {
        const dx = pt.x - target.x, dy = pt.y - target.y;
        const dist = Math.hypot(dx, dy);
        if (dist === 0) return { x: target.x + target.radius, y: target.y };
        return { x: target.x + dx / dist * target.radius, y: target.y + dy / dist * target.radius };
    }

    if (isArcShape(target)) {
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

/**
 * @param {SchematicItem} target
 * @param {Point|null} [referencePoint]
 * @returns {Point}
 */
function getNonWireAnchor(target, referencePoint = null) {
    // For components (have definition), use center
    if (isComponentShape(target)) {
        return getShapeCenter(target);
    }
    // For primitive shapes, find closest point on actual geometry
    if (referencePoint) {
        const cp = closestPointOnShapeGeometry(target, referencePoint);
        if (cp) return cp;
    }
    if (hasPositionGetter(target)) return target.getPosition();
    return getShapeCenter(target);
}

/**
 * @param {Wire|null|undefined} wire
 * @param {LabelAttachment|null|undefined} attachment
 * @returns {Point|null}
 */
function getWireAnchorFromAttachment(wire, attachment) {
    if (!wire || !attachment) return null;

    const edge = typeof attachment.edgeId === 'string' ? wire.edges.get(attachment.edgeId) : null;
    if (edge) {
        const from = wire.nodes.get(edge.from);
        const to = wire.nodes.get(edge.to);
        if (from && to) {
            const t = Number.isFinite(attachment.t) ? /** @type {number} */ (attachment.t) : 0.5;
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
 * @param {Wire|null|undefined} wire
 * @param {ClosestEdge|null|undefined} closest
 * @returns {Point}
 */
function getDefaultWireLabelOffset(wire, closest) {
    if (!wire) return { x: 0, y: -DEFAULT_WIRE_LABEL_OFFSET };
    const edge = closest?.edgeId ? /** @type {GraphEdge|null|undefined} */ (wire.edges.get(closest.edgeId)) : null;
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
 * @param {SchematicItem|null|undefined} labelShape
 * @param {Point|null} [fallbackPos]
 * @returns {Point}
 */
export function getLabelDropHotspot(labelShape, fallbackPos = null) {
    if (!isTextShape(labelShape)) {
        if (fallbackPos) return { x: fallbackPos.x, y: fallbackPos.y };
        return getShapePosition(labelShape);
    }
    const b = labelShape.getBounds?.();
    if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxY)) {
        return { x: b.minX, y: b.maxY };
    }
    return { x: labelShape.x, y: labelShape.y };
}

/**
 * @param {SchematicItem|null|undefined} labelShape
 * @param {Point|null} [referencePoint]
 * @returns {Point|null}
 */
export function getLabelAttachmentAnchorPoint(labelShape, referencePoint = null) {
    if (!isTextShape(labelShape)) return null;
    // Generic labels store schematic targets in Text.parentComponent.
    const target = /** @type {SchematicItem|null} */ (labelShape.parentComponent);
    if (!target) return null;
    const att = labelShape.attachment;

    if (isWireShape(target)) {
        if (referencePoint) {
            const closest = target.closestEdge?.(referencePoint);
            if (closest?.point) return { x: closest.point.x, y: closest.point.y };
        }
        if (!att) return null;
        return getWireAnchorFromAttachment(target, att);
    }

    return getNonWireAnchor(target, referencePoint);
}

/** @param {SchematicEditor} app */
export function updateLabelGuide(app) {
    const selection = app.selection?.getSelection?.() || [];
    const label = getSchematicTextEdit(app)?.shape || (selection.length === 1 ? selection[0] : null);
    const textLabel = isTextShape(label) ? label : null;
    const target = textLabel && textLabel.visible !== false ? textLabel.parentComponent : null;
    let anchor = null;
    let endpoint = null;
    if (target && textLabel) {
        const textBox = getTextEditBoxWorldCorners(textLabel);
        if (!textBox) return;
        // A component's field texts (reference and value) lead from its box outline.
        if (isComponentFieldTextTarget(target, textLabel)) {
            const local = target._getLocalBounds();
            const angle = (target.rotation || 0) * Math.PI / 180;
            const cosine = Math.cos(angle), sine = Math.sin(angle);
            const componentBox = [
                [local.minX - 0.5, local.minY - 0.5], [local.maxX + 0.5, local.minY - 0.5],
                [local.maxX + 0.5, local.maxY + 0.5], [local.minX - 0.5, local.maxY + 0.5],
            ].map(([x, y]) => ({ x: target.x + x * cosine - y * sine, y: target.y + x * sine + y * cosine }));
            const connection = connectBoxOutlines(componentBox, textBox);
            anchor = connection?.start || null;
            endpoint = connection?.end || null;
        } else {
            const textCenter = {
                x: (textBox[0].x + textBox[2].x) / 2,
                y: (textBox[0].y + textBox[2].y) / 2,
            };
            const connection = connectPointToBoxOutline(
                getLabelAttachmentAnchorPoint(textLabel, textCenter),
                textBox,
            );
            anchor = connection?.start || null;
            endpoint = connection?.end || null;
        }
    }
    if (!anchor) {
        const guide = getLabelGuideElement(app);
        if (guide) guide.remove();
        setLabelGuideElement(app, null);
        return;
    }
    let guide = getLabelGuideElement(app);
    if (!guide) {
        guide = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        guide.setAttribute('class', 'label-connection-guide');
        setLabelGuideElement(app, guide);
    }
    applyTextConnectionGuide(guide, { start: anchor, end: endpoint }, 'var(--sch-selection, #3399ff)');
    app.viewport.contentLayer.appendChild(guide);
}

/**
 * Attach a generic label Text shape to a target shape/component.
 * @param {SchematicItem|null|undefined} labelShape
 * @param {SchematicItem|null} target - null attaches to nothing
 * @param {Point|null} [snapPos]
 * @param {{isNewLabel?:boolean}} [opts]
 */
export function attachLabelToTarget(labelShape, target, snapPos = null, { isNewLabel = false } = {}) {
    if (!isTextShape(labelShape)) return;

    // Generic labels store schematic targets in Text.parentComponent.
    const previousTarget = /** @type {SchematicItem|null} */ (labelShape.parentComponent || null);
    if (previousTarget) {
        removeAttachedLabel(previousTarget, labelShape);
    }

    if (hasLabelText(labelShape.parentComponent) && labelShape.parentComponent.labelText === labelShape) {
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

    if (isWireShape(target)) {
        if (labelShape.fontSize !== WIRE_ATTACHED_LABEL_FONT_SIZE) {
            labelShape.fontSize = WIRE_ATTACHED_LABEL_FONT_SIZE;
        }
        const probe = snapPos || { x: labelShape.x, y: labelShape.y };
        const closest = target.closestEdge?.(probe);
        const anchor = closest?.point || probe;
        const closestT = closest?.t;
        const t = Number.isFinite(closestT) ? /** @type {number} */ (closestT) : 0.5;

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

/** @param {SchematicItem|null|undefined} labelShape */
export function detachLabel(labelShape) {
    if (!isTextShape(labelShape)) return;
    // Generic labels store schematic targets in Text.parentComponent.
    removeAttachedLabel(/** @type {SchematicItem|null} */ (labelShape.parentComponent), labelShape);
    if (hasLabelText(labelShape.parentComponent) && labelShape.parentComponent.labelText === labelShape) {
        labelShape.parentComponent.labelText = null;
    }
    labelShape.parentComponent = null;
    // Keep fieldKey='label' so the shape remains identifiable as a label
    // and can be reattached via context menu or drag-drop.
    labelShape.attachment = null;
    labelShape.invalidate?.();
}

/** @param {SchematicItem|null|undefined} labelShape */
export function refreshLabelAttachmentOffset(labelShape) {
    if (!isTextShape(labelShape)) return;
    // Generic labels store schematic targets in Text.parentComponent.
    const target = /** @type {SchematicItem|null} */ (labelShape.parentComponent);
    const att = labelShape.attachment;
    if (!target || !att) return;

    if (isWireShape(target)) {
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
 * @param {SchematicEditor} app
 */
export function syncAttachedLabels(app) {
    const isDraggingLabel = getSchematicDrag(app)?.mode === 'move'
        && app.selection?.getSelection?.().length === 1
        && app.selection.getSelection()[0]?.type === 'text';

    for (const shape of app.shapes) {
        if (!isTextShape(shape)) continue;
        if (shape.fieldKey !== 'label' || !shape.parentComponent) continue;
        if (isDraggingLabel && app.selection.isSelected(shape)) continue;

        // Generic labels store schematic targets in Text.parentComponent.
        const target = /** @type {SchematicItem} */ (shape.parentComponent);
        addAttachedLabel(target, shape);
        const att = shape.attachment || { kind: target.type === 'wire' ? 'wire' : 'shape', offsetX: 0, offsetY: 0 };
        shape.attachment = att;

        let anchor = null;
        if (isWireShape(target)) {
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
