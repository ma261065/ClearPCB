import { Shape } from '../../shapes/shape.js';
import { PolylineGraph } from '../../shapes/polyline-graph.js';
import { Wire } from '../../shapes/wire.js';
import { Text, setTextMeasurer } from '../../shapes/text.js';
import { Net, buildNetGroundBarsPath } from '../../shapes/net.js';
import { Arc } from '../../shapes/arc.js';
import { Circle } from '../../shapes/circle.js';
import { NoConnect } from '../../shapes/noconnect.js';
import { NO_SELECTION } from '../../shapes/selection-view.js';
import { arcEdgeContinuation, arcEdgePathD } from '../../shapes/arc-edge.js';
import { roundedPathData, roundedCornerContinuation } from '../../shapes/rounded-path.js';
import { primitiveShapePath } from '../../shapes/shape-drawing.js';
import { circleOuterRadius } from '../../shapes/path-geometry.js';
import { getTextEditBoxGeometry, measureTextGlyphBBox, setTextEditElementProvider } from '../../core/text-edit-geometry.js';
import { createLockIcon, buildPointAnchorsGroup } from '../../core/ui-helpers.js';
import { ensureView, viewOf } from './shape-view-state.js';
import { schematicLockPosition } from './lock-placement.js';
import { isSchematicLocked } from '../../shapes/lock-owner.js';

/** @typedef {import('../../core/SchematicDocument.js').SchematicDrawable} SchematicDrawable */
/** @typedef {import('../../shapes/selection-view.js').SelectionView} SelectionView */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {ReturnType<Shape['getAnchors']>[number] & {hidden?: boolean, bulge?: boolean}} RenderAnchor */
/** @typedef {SVGElement & {setAttribute(name: string, value: unknown): void}} SvgRenderElement */
/** @typedef {{selection?: SelectionView, suppressSelection?: boolean}} RenderShapeOptions */
/** @typedef {SchematicDrawable & {attachedLabels?: Set<SchematicDrawable>|null}} ShapeWithAttachedLabels */

const NS = 'http://www.w3.org/2000/svg';
const MIN_STROKE_PIXELS = 1;
const ANCHOR_SIZE_PIXELS = 8;
const MIN_JUNCTION_RADIUS = 0.4;
const JUNCTION_SCREEN_PX = 2.5;
const NC_HALF = 0.8;

/** @param {string|number} color */
function colorToCSS(color) {
    if (typeof color === 'string') return color;
    return '#' + color.toString(16).padStart(6, '0');
}

/**
 * @param {Shape} shape
 * @param {number} scale
 */
export function effectiveStrokeWidth(shape, scale) {
    if (shape instanceof Text || shape instanceof Net) return 0;
    if (shape instanceof NoConnect) return Math.max(shape.lineWidth, 1.5 / scale);
    const minWorldWidth = MIN_STROKE_PIXELS / scale;
    return Math.max(shape.lineWidth, minWorldWidth);
}

setTextMeasurer((shape) => {
    const element = viewOf(shape)?.element;
    if (!element) return null;
    const glyphs = element.children[1];
    if (shape.border) {
        const border = element.children[0];
        const x = Number(border.getAttribute('x')), y = Number(border.getAttribute('y'));
        const width = Number(border.getAttribute('width')), height = Number(border.getAttribute('height'));
        if ([x, y, width, height].every(Number.isFinite) && width >= 0 && height > 0) {
            return { x, y, width, height };
        }
    }
    return measureTextGlyphBBox(shape, /** @type {SVGGraphicsElement} */ (glyphs));
});

setTextEditElementProvider(/** @param {SchematicDrawable} shape */ (shape) => viewOf(shape)?.element || null);

/** @param {SchematicDrawable} shape */
function createShapeElement(shape) {
    if (shape instanceof Circle) {
        const group = document.createElementNS(NS, 'g');
        group.appendChild(document.createElementNS(NS, 'circle'));
        group.appendChild(document.createElementNS(NS, 'circle'));
        return group;
    }
    if (shape instanceof Text) return createTextElement();
    return document.createElementNS(NS, 'g');
}

function createTextElement() {
    const group = document.createElementNS(NS, 'g');
    group.appendChild(document.createElementNS(NS, 'rect'));
    group.appendChild(document.createElementNS(NS, 'text'));
    return group;
}

/**
 * @param {SchematicDrawable} shape
 * @param {number} scale
 * @param {RenderShapeOptions} [options]
 */
export function renderShape(shape, scale, options = {}) {
    const viewState = ensureView(shape);
    if (!viewState.element) {
        viewState.element = createShapeElement(shape);
        /** @type {SVGElement & {__shape?: SchematicDrawable}} */ (viewState.element).__shape = shape;
    }

    const element = viewState.element;
    if (!shape.visible) {
        element.style.display = 'none';
        return element;
    }

    element.style.display = '';

    const baseShape = /** @type {Shape} */ (shape);
    let strokeColor = colorToCSS(baseShape.color);
    const shapeWithFill = /** @type {{fillColor?: string|number|null}} */ (shape);
    const baseFillColor = colorToCSS(shapeWithFill.fillColor ?? baseShape.color);
    let fillColor = baseFillColor;
    const attachedLabels = /** @type {ShapeWithAttachedLabels} */ (shape).attachedLabels;
    const view = options.selection || NO_SELECTION;
    const attachedActive = attachedLabels instanceof Set
        && Array.from(attachedLabels).some(label => label && (view.isSelected(label) || view.isHovered(label)));
    const visuallySelected = view.isSelected(shape) && !options.suppressSelection;
    const visuallyHovered = view.isHovered(shape) && !options.suppressSelection;

    if (visuallySelected) {
        strokeColor = '#e94560';
        fillColor = '#e94560';

        if (element.parentNode && element.nextSibling) {
            element.parentNode.appendChild(element);
        }
    } else if (visuallyHovered) {
        strokeColor = 'var(--sch-selection, #3399ff)';
        fillColor = shape.type === 'text'
            ? 'var(--sch-selection, #3399ff)'
            : 'var(--sch-hover-fill, #9999aa)';
    } else if (attachedActive) {
        strokeColor = 'var(--sch-selection, #3399ff)';
        fillColor = 'var(--sch-selection, #3399ff)';
    }

    updateShapeElement(shape, element, strokeColor, fillColor, scale, view);
    if (visuallyHovered && !visuallySelected) {
        element.setAttribute('stroke-opacity', '0.35');
        if (shape.type === 'text') {
            element.setAttribute('fill-opacity', '0.35');
        }
    } else {
        element.removeAttribute('stroke-opacity');
        if (shape.type === 'text') {
            element.removeAttribute('fill-opacity');
        }
    }

    updateShapeAnchors(shape, scale, visuallySelected, null, view);

    shape._dirty = false;
    viewState.lastScale = scale;
    return element;
}

/**
 * @param {SchematicDrawable} shape
 * @param {SvgRenderElement} element
 * @param {string} strokeColor
 * @param {string} fillColor
 * @param {number} scale
 * @param {SelectionView} view
 */
function updateShapeElement(shape, element, strokeColor, fillColor, scale, view) {
    if (shape instanceof Wire) return updateWireElement(shape, element, strokeColor, fillColor, scale, view);
    if (shape instanceof Text) return updateTextElement(shape, element, strokeColor, fillColor, scale, view);
    if (shape instanceof Net) return updateNetElement(shape, element, strokeColor, fillColor, scale, view);
    if (shape instanceof Arc) return updateArcElement(shape, element, strokeColor, fillColor, scale);
    if (shape instanceof Circle) return updateCircleElement(shape, element, strokeColor, fillColor, scale);
    if (shape instanceof NoConnect) return updateNoConnectElement(shape, element, strokeColor, fillColor, scale);
    if (shape instanceof PolylineGraph) return updatePolylineGraphElement(shape, element, strokeColor, fillColor, scale, view);
}

/**
 * @param {SchematicDrawable} shape
 * @param {number} scale
 * @param {boolean} [visuallySelected]
 * @param {string|null} [selectedNodeId]
 * @param {SelectionView} [view] its `lockPointer` places a lock icon
 */
export function updateShapeAnchors(shape, scale, visuallySelected = false, selectedNodeId = null, view = NO_SELECTION) {
    if (visuallySelected && isSchematicLocked(shape)) return showLockOnly(shape, scale, view.lockPointer);
    if (shape instanceof PolylineGraph) return updatePolylineGraphAnchors(shape, scale, visuallySelected, selectedNodeId);
    return updateBaseAnchors(shape, scale, visuallySelected);
}

/** A selected locked shape shows its lock instead of edit handles, as in the PCB editor. */
/**
 * @param {SchematicDrawable} shape
 * @param {number} scale
 * @param {Point|null|undefined} pointer
 */
function showLockOnly(shape, scale, pointer) {
    const viewState = ensureView(shape);
    viewState.anchorsGroup?.remove();
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', 'shape-anchors');
    const position = schematicLockPosition(shape, pointer, scale);
    if (position) group.appendChild(createLockIcon(position.x, position.y, shape, 'lock-icon', scale));
    viewState.anchorsGroup = group;
    viewState.anchorRects = null;
    viewState.anchorsHaveLock = true;
    const element = viewState.element;
    if (element?.parentNode) element.parentNode.insertBefore(group, element.nextSibling);
}

/**
 * @param {SchematicDrawable} shape
 * @param {number} scale
 * @param {boolean} [visuallySelected]
 */
function updateBaseAnchors(shape, scale, visuallySelected = false) {
    const viewState = ensureView(shape);
    const element = viewState.element;
    if (!visuallySelected) {
        if (viewState.anchorsGroup) {
            viewState.anchorsGroup.remove();
            viewState.anchorsGroup = null;
            viewState.anchorRects = null;
        }
        return;
    }

    const anchors = /** @type {RenderAnchor[]} */ (shape.getAnchors());
    const visibleAnchors = anchors.filter(anchor => !anchor.hidden);
    if (visibleAnchors.length === 0) {
        if (viewState.anchorsGroup) {
            viewState.anchorsGroup.remove();
            viewState.anchorsGroup = null;
            viewState.anchorRects = null;
        }
        return;
    }

    const size = ANCHOR_SIZE_PIXELS / scale;
    const strokeW = 1 / scale;

    if (viewState.anchorsGroup && viewState.anchorRects && viewState.anchorRects.length === visibleAnchors.length
        && !viewState.anchorsHaveLock) {
        for (let i = 0; i < visibleAnchors.length; i++) {
            const anchor = visibleAnchors[i];
            const rect = viewState.anchorRects[i];
            if (anchor.bulge) {
                rect.setAttribute('cx', String(anchor.x));
                rect.setAttribute('cy', String(anchor.y));
                rect.setAttribute('r', String(size / 2));
            } else {
                rect.setAttribute('x', String(anchor.x - size / 2));
                rect.setAttribute('y', String(anchor.y - size / 2));
                rect.setAttribute('width', String(size));
                rect.setAttribute('height', String(size));
            }
            rect.setAttribute('stroke-width', String(strokeW));
        }
        if (element?.parentNode && viewState.anchorsGroup.previousSibling !== element) {
            element.parentNode.insertBefore(viewState.anchorsGroup, element.nextSibling);
        }
        return;
    }

    if (viewState.anchorsGroup) {
        viewState.anchorsGroup.remove();
    }

    viewState.anchorsGroup = document.createElementNS(NS, 'g');
    viewState.anchorsGroup.setAttribute('class', 'shape-anchors');
    viewState.anchorRects = [];
    viewState.anchorsHaveLock = false;

    for (const anchor of visibleAnchors) {
        const rect = document.createElementNS(NS, anchor.bulge ? 'circle' : 'rect');
        if (anchor.bulge) {
            rect.setAttribute('cx', String(anchor.x));
            rect.setAttribute('cy', String(anchor.y));
            rect.setAttribute('r', String(size / 2));
        } else {
            rect.setAttribute('x', String(anchor.x - size / 2));
            rect.setAttribute('y', String(anchor.y - size / 2));
            rect.setAttribute('width', String(size));
            rect.setAttribute('height', String(size));
        }
        rect.setAttribute('fill', anchor.bulge ? '#33dd77' : '#fff');
        rect.setAttribute('stroke', anchor.bulge ? '#2e7d32' : '#e94560');
        rect.setAttribute('stroke-width', String(1 / scale));
        rect.setAttribute('data-anchor-id', anchor.id);
        viewState.anchorsGroup.appendChild(rect);
        viewState.anchorRects.push(rect);
    }

    if (element?.parentNode) {
        element.parentNode.insertBefore(viewState.anchorsGroup, element.nextSibling);
    }
}

/**
 * @param {PolylineGraph & SchematicDrawable} shape
 * @param {SvgRenderElement} el
 * @param {string} strokeColor
 * @param {string} fillColor
 * @param {number} scale
 * @param {SelectionView} [_view]
 */
export function updatePolylineGraphElement(shape, el, strokeColor, fillColor, scale, _view = NO_SELECTION) {
    el.textContent = '';

    const sw = effectiveStrokeWidth(shape, scale);
    const hasEdgeWidths = [...shape.edges.keys()].some(
        (edgeId) => shape.getEdgeAttr(edgeId, 'width') !== shape.lineWidth,
    );
    const r = Math.max(shape.cornerRadius || 0,
        ...Object.values(shape.nodeCornerRadii || {}).map(Number).filter(Number.isFinite));

    if (r > 0) {
        const pts = shape.getOrderedPoints();
        const hasBranches = shape.getJunctionNodes().length > 0;
        if (pts && pts.length >= 3 && pts.length === shape.nodes.size && !hasBranches) {
            const nodeIds = shape.getOrderedNodeIds();
            const corners = shape._pathCorners(nodeIds);
            const chain = shape.getOrderedEdgeChain();
            const pathData = roundedPathData(corners, shape.closed, chain.map(edge => edge.bulge));

            if (shape.fill) {
                const fillPath = document.createElementNS(NS, 'path');
                fillPath.setAttribute('d', pathData);
                fillPath.setAttribute('fill', fillColor);
                fillPath.setAttribute('fill-opacity', String(shape.fillAlpha));
                fillPath.setAttribute('stroke', 'none');
                el.appendChild(fillPath);
            }

            const strokes = hasEdgeWidths
                ? [
                    ...corners.filter(corner => corner.rounded).map(corner => ({
                        path: `M ${corner.entry.x} ${corner.entry.y} ${roundedCornerContinuation(corner)}`,
                        width: sw,
                    })),
                    ...chain.map((edge, index) => ({
                        path: `M ${corners[index].exit.x} ${corners[index].exit.y} `
                            + arcEdgeContinuation(corners[index].exit, corners[(index + 1) % corners.length].entry, edge.bulge),
                        width: Math.max(Number(shape.getEdgeAttr(edge.edgeId, 'width')) || shape.lineWidth, 1 / scale),
                    })),
                ]
                : [{ path: pathData, width: sw }];
            for (const { path, width } of strokes) {
                const strokePath = document.createElementNS(NS, 'path');
                strokePath.setAttribute('d', path);
                strokePath.setAttribute('stroke', strokeColor);
                strokePath.setAttribute('stroke-width', String(width));
                strokePath.setAttribute('stroke-linejoin', 'round');
                strokePath.setAttribute('stroke-linecap', 'round');
                strokePath.setAttribute('fill', 'none');
                el.appendChild(strokePath);
            }

            const jr = Math.max(MIN_JUNCTION_RADIUS, JUNCTION_SCREEN_PX / scale);
            for (const [nid, pos] of shape.nodes) {
                if (shape.degree(nid) >= 3) {
                    const c = document.createElementNS(NS, 'circle');
                    c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y);
                    c.setAttribute('r', String(jr));
                    c.setAttribute('fill', strokeColor);
                    c.setAttribute('stroke', 'none');
                    c.classList.add('junction-dot');
                    el.appendChild(c);
                }
            }
            return;
        }
    }

    if (shape.fill) {
        if (shape._hasBulgedEdges()) {
            const d = shape._buildOutlinePathD(true);
            if (d) {
                const fillPath = document.createElementNS(NS, 'path');
                fillPath.setAttribute('d', d);
                fillPath.setAttribute('fill', fillColor);
                fillPath.setAttribute('fill-opacity', String(shape.fillAlpha));
                fillPath.setAttribute('stroke', 'none');
                el.appendChild(fillPath);
            }
        } else {
            const pts = shape.getOrderedPoints();
            if (pts && pts.length >= 3) {
                const poly = document.createElementNS(NS, 'polygon');
                poly.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
                poly.setAttribute('fill', fillColor);
                poly.setAttribute('fill-opacity', String(shape.fillAlpha));
                poly.setAttribute('stroke', 'none');
                el.appendChild(poly);
            }
        }
    }

    for (const [eid, e] of shape.edges) {
        const a = shape.nodes.get(e.from), b = shape.nodes.get(e.to);
        if (!a || !b) continue;
        const bulge = shape.getEdgeAttr(eid, 'bulge') || 0;
        const edgeWidth = Math.max(Number(shape.getEdgeAttr(eid, 'width')) || shape.lineWidth,
            1 / scale);
        if (bulge) {
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', arcEdgePathD(a, b, bulge));
            path.setAttribute('stroke', strokeColor);
            path.setAttribute('stroke-width', String(edgeWidth));
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('fill', 'none');
            el.appendChild(path);
        } else {
            const ln = document.createElementNS(NS, 'line');
            ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y);
            ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y);
            ln.setAttribute('stroke', strokeColor);
            ln.setAttribute('stroke-width', String(edgeWidth));
            ln.setAttribute('stroke-linecap', 'round');
            ln.setAttribute('fill', 'none');
            el.appendChild(ln);
        }
    }

    if (shape.type === 'wire') {
        const jr = Math.max(MIN_JUNCTION_RADIUS, JUNCTION_SCREEN_PX / scale);
        for (const [nid, pos] of shape.nodes) {
            if (shape.degree(nid) >= 3) {
                const c = document.createElementNS(NS, 'circle');
                c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y);
                c.setAttribute('r', String(jr));
                c.setAttribute('fill', strokeColor);
                c.setAttribute('stroke', 'none');
                c.classList.add('junction-dot');
                el.appendChild(c);
            }
        }
    }
}

/**
 * @param {PolylineGraph & SchematicDrawable} shape
 * @param {number} scale
 * @param {boolean} [visuallySelected]
 * @param {string|null} [selectedNodeId]
 */
function updatePolylineGraphAnchors(shape, scale, visuallySelected = false, selectedNodeId = null) {
    const viewState = ensureView(shape);
    const element = viewState.element;
    if (!visuallySelected) {
        if (viewState.anchorsGroup) {
            viewState.anchorsGroup.remove();
            viewState.anchorsGroup = null;
            viewState.anchorRects = null;
        }
        return;
    }
    if (viewState.anchorsGroup) viewState.anchorsGroup.remove();
    const { group, rects } = buildPointAnchorsGroup(shape, scale);
    if (selectedNodeId == null && shape.type !== 'wire') {
        const editPath = shape._buildOutlinePathD(shape.closed);
        if (editPath) {
            const guide = document.createElementNS(NS, 'path');
            guide.setAttribute('class', 'shape-edit-guide');
            guide.setAttribute('d', editPath);
            guide.setAttribute('fill', 'none');
            guide.setAttribute('stroke', '#e94560');
            guide.setAttribute('stroke-width', '1');
            guide.setAttribute('vector-effect', 'non-scaling-stroke');
            guide.setAttribute('pointer-events', 'none');
            group.insertBefore(guide, group.firstChild);
        }
    }
    const selectedNode = selectedNodeId == null ? null : shape.nodes.get(selectedNodeId);
    if (selectedNode) {
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('class', 'schematic-node-selection-ring');
        ring.setAttribute('cx', String(selectedNode.x));
        ring.setAttribute('cy', String(selectedNode.y));
        ring.setAttribute('r', String(8 / scale));
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', '#3399ff');
        ring.setAttribute('stroke-width', '2');
        ring.setAttribute('vector-effect', 'non-scaling-stroke');
        ring.setAttribute('pointer-events', 'none');
        group.appendChild(ring);
    }
    viewState.anchorsGroup = group;
    viewState.anchorRects = rects;
    if (element?.parentNode)
        element.parentNode.insertBefore(viewState.anchorsGroup, element.nextSibling);
}

/**
 * @param {Wire} shape
 * @param {SvgRenderElement} el
 * @param {string} strokeColor
 * @param {string} fillColor
 * @param {number} scale
 * @param {SelectionView} [view]
 */
export function updateWireElement(shape, el, strokeColor, fillColor, scale, view = NO_SELECTION) {
    const attachedSelected = shape.attachedLabels instanceof Set
        && Array.from(shape.attachedLabels).some(label => label && view.isSelected(label));
    const labelSelected = !!shape.labelText && view.isSelected(shape.labelText);
    if (!view.isSelected(shape) && !view.isHovered(shape) && (labelSelected || attachedSelected)) {
        strokeColor = 'var(--sch-selection, #3399ff)';
    }
    updatePolylineGraphElement(shape, el, strokeColor, fillColor, scale, view);
    if (shape.pinConnections && shape.pinConnections.size > 0) {
        const r = Math.max(0.4, 2.5 / scale);
        for (const nid of shape.pinConnections.keys()) {
            const pos = shape.nodes.get(nid);
            if (!pos) continue;
            const c = document.createElementNS(NS, 'circle');
            c.setAttribute('cx', pos.x);
            c.setAttribute('cy', pos.y);
            c.setAttribute('r', String(r));
            c.setAttribute('fill', strokeColor);
            c.setAttribute('stroke', 'none');
            c.classList.add('pin-connection-dot');
            el.appendChild(c);
        }
    }
    if (shape.labelText) shape.labelText.invalidate();
}

/**
 * @param {Text} shape
 * @param {SvgRenderElement} el
 * @param {string} _strokeColor
 * @param {string} fillColor
 * @param {number} scale
 * @param {SelectionView} [view]
 */
export function updateTextElement(shape, el, _strokeColor, fillColor, scale, view = NO_SELECTION) {
    const borderEl = /** @type {SvgRenderElement} */ (el.children[0]);
    const textEl = /** @type {SvgRenderElement} */ (el.children[1]);
    textEl.setAttribute('x', shape.x);
    textEl.setAttribute('y', shape.y);
    if (shape.parentComponent && view.isSelected(shape.parentComponent) && !view.isSelected(shape) && !view.isHovered(shape)) {
        fillColor = 'var(--sch-selection, #3399ff)';
    }
    textEl.setAttribute('fill', fillColor);
    textEl.setAttribute('font-size', shape.fontSize);
    textEl.setAttribute('font-family', shape.fontFamily);
    textEl.setAttribute('text-anchor', shape.textAnchor);
    textEl.setAttribute('dominant-baseline', 'alphabetic');
    textEl.setAttribute('alignment-baseline', 'alphabetic');
    textEl.setAttribute('text-rendering', 'geometricPrecision');
    textEl.setAttribute('xml:space', 'preserve');
    textEl.style.whiteSpace = 'pre';
    textEl.textContent = typeof shape.text === 'string' ? shape.text : '';
    textEl.setAttribute('stroke', 'none');
    textEl.removeAttribute('stroke-width');

    // Edge can leave descender trails when dragging upward unless the glyph group
    // includes its padded ink area. Keep that rectangle transparent when unbordered.
    const box = getTextEditBoxGeometry(shape, textEl);
    if (box) {
        const borderWidth = Math.max(shape.lineWidth, 1 / scale);
        borderEl.setAttribute('x', String(box.x + box.originX));
        borderEl.setAttribute('y', String(box.y + box.originY));
        borderEl.setAttribute('width', String(box.width));
        borderEl.setAttribute('height', String(box.height));
        borderEl.setAttribute('fill', shape.border ? 'none' : 'transparent');
        borderEl.setAttribute('stroke', shape.border ? fillColor : 'none');
        if (shape.border) borderEl.setAttribute('stroke-width', String(borderWidth));
        else borderEl.removeAttribute('stroke-width');
        borderEl.setAttribute('pointer-events', 'none');
        borderEl.removeAttribute('display');
    } else {
        borderEl.setAttribute('display', 'none');
    }
    if (shape.rotation) {
        el.setAttribute('transform', `rotate(${shape.rotation}, ${shape.x}, ${shape.y})`);
    } else {
        el.removeAttribute('transform');
    }
    shape._bounds = null;
}

/**
 * @param {Net} shape
 * @param {SvgRenderElement} el
 * @param {string} strokeColor
 * @param {string} _fillColor
 * @param {number} scale
 * @param {SelectionView} [view]
 */
export function updateNetElement(shape, el, strokeColor, _fillColor, scale, view = NO_SELECTION) {
    const geo = shape._getGeometry();

    if (!el.children.length || el.children.length < 2) {
        while (el.firstChild) el.removeChild(el.firstChild);
        const path = document.createElementNS(NS, 'path');
        const detailPath = document.createElementNS(NS, 'path');
        el.appendChild(path);
        el.appendChild(detailPath);
    }

    const path = /** @type {SvgRenderElement} */ (el.children[0]);
    const detailPath = /** @type {SvgRenderElement} */ (el.children[1]);
    const baseStrokeWidth = Math.max(shape.lineWidth, 1 / scale);
    const selectionColor = 'var(--sch-selection, #3399ff)';
    let symbolStroke = strokeColor;

    const attachedLabels = shape.attachedLabels;
    const attachedActive = attachedLabels instanceof Set
        && Array.from(attachedLabels).some(label => label && (view.isSelected(label) || view.isHovered(label)));
    const labelActive = !!shape.labelText && (view.isSelected(shape.labelText) || view.isHovered(shape.labelText));
    if (!view.isSelected(shape) && !view.isHovered(shape) && (labelActive || attachedActive)) {
        symbolStroke = selectionColor;
    }

    path.setAttribute('d', geo.symbolPath);
    path.setAttribute('stroke', symbolStroke);
    path.setAttribute('stroke-width', baseStrokeWidth);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');

    if (shape.style === 'gnd') {
        detailPath.setAttribute('d', buildNetGroundBarsPath(shape.orientation, { x: shape.x, y: shape.y }));
        detailPath.setAttribute('stroke', symbolStroke);
        detailPath.setAttribute('stroke-width', Math.max(baseStrokeWidth * 0.32, 0.18 / scale));
        detailPath.setAttribute('fill', 'none');
        detailPath.setAttribute('stroke-linejoin', 'round');
        detailPath.setAttribute('stroke-linecap', 'round');
        detailPath.removeAttribute('display');
    } else {
        detailPath.setAttribute('d', '');
        detailPath.setAttribute('display', 'none');
    }

    el.removeAttribute('transform');
}

/**
 * @param {Arc} shape
 * @param {SvgRenderElement} el
 * @param {string} strokeColor
 * @param {string} fillColor
 * @param {number} scale
 */
export function updateArcElement(shape, el, strokeColor, fillColor, scale) {
    el.textContent = '';

    const arcPath = primitiveShapePath(/** @type {Parameters<typeof primitiveShapePath>[0]} */ (shape._controlArc()));
    const sw = effectiveStrokeWidth(shape, scale);

    if (shape.fill) {
        const fillEl = document.createElementNS(NS, 'path');
        fillEl.setAttribute('d', `${arcPath} Z`);
        fillEl.setAttribute('fill', fillColor);
        fillEl.setAttribute('fill-opacity', String(shape.fillAlpha));
        fillEl.setAttribute('stroke', 'none');
        el.appendChild(fillEl);
    }

    const strokeEl = document.createElementNS(NS, 'path');
    strokeEl.setAttribute('d', arcPath);
    strokeEl.setAttribute('stroke', strokeColor);
    strokeEl.setAttribute('stroke-width', String(sw));
    strokeEl.setAttribute('stroke-linecap', 'round');
    strokeEl.setAttribute('fill', 'none');
    el.appendChild(strokeEl);
}

/**
 * @param {Circle} shape
 * @param {SvgRenderElement} el
 * @param {string} strokeColor
 * @param {string} fillColor
 * @param {number} scale
 */
export function updateCircleElement(shape, el, strokeColor, fillColor, scale) {
    const fill = /** @type {SvgRenderElement} */ (el.children[0]);
    const stroke = /** @type {SvgRenderElement} */ (el.children[1]);
    const radius = circleOuterRadius(shape);
    const width = Math.min(effectiveStrokeWidth(shape, scale), radius);
    for (const circle of [fill, stroke]) {
        circle.setAttribute('cx', shape.x);
        circle.setAttribute('cy', shape.y);
    }
    stroke.setAttribute('r', radius - width / 2);
    stroke.setAttribute('stroke', strokeColor);
    stroke.setAttribute('stroke-width', width);
    stroke.setAttribute('fill', 'none');
    fill.setAttribute('r', Math.max(0, radius - width));
    fill.setAttribute('stroke', 'none');

    if (shape.fill) {
        fill.setAttribute('fill', fillColor);
        fill.setAttribute('fill-opacity', String(shape.fillAlpha));
    } else {
        fill.setAttribute('fill', 'none');
        fill.removeAttribute('fill-opacity');
    }
}

/**
 * @param {NoConnect} shape
 * @param {SvgRenderElement} el
 * @param {string} strokeColor
 * @param {string} _fillColor
 * @param {number} scale
 */
export function updateNoConnectElement(shape, el, strokeColor, _fillColor, scale) {
    const sw = Math.max(shape.lineWidth, 1.5 / scale);

    if (el.children.length < 2) {
        el.innerHTML = '';
        el.appendChild(document.createElementNS(NS, 'line'));
        el.appendChild(document.createElementNS(NS, 'line'));
    }

    const line1 = /** @type {SvgRenderElement} */ (el.children[0]);
    const line2 = /** @type {SvgRenderElement} */ (el.children[1]);

    line1.setAttribute('x1', shape.x - NC_HALF);
    line1.setAttribute('y1', shape.y - NC_HALF);
    line1.setAttribute('x2', shape.x + NC_HALF);
    line1.setAttribute('y2', shape.y + NC_HALF);
    line1.setAttribute('stroke', strokeColor);
    line1.setAttribute('stroke-width', sw);
    line1.setAttribute('stroke-linecap', 'round');

    line2.setAttribute('x1', shape.x + NC_HALF);
    line2.setAttribute('y1', shape.y - NC_HALF);
    line2.setAttribute('x2', shape.x - NC_HALF);
    line2.setAttribute('y2', shape.y + NC_HALF);
    line2.setAttribute('stroke', strokeColor);
    line2.setAttribute('stroke-width', sw);
    line2.setAttribute('stroke-linecap', 'round');
}
