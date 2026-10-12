/**
 * Drawing board shapes: each shape's SVG element, its colour and stroke by layer and
 * copper mode (with the hatch removal shapes get), and the hover and net-hover states.
 */
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus, getHoveredBoardShape, getNetHoveredShapeIds, setHoveredBoardShape, setNetHoveredShapeIds } from './board-shape-state.js';
import { pcbHighlightColor, PCB_HOVER_HIGHLIGHT_OPACITY, PCB_LAYERS, PCB_SELECTION_HIGHLIGHT_OPACITY } from './layers.js';
import { isPcbSelected } from './selection-registry.js';
import { insideStrokeGroup } from '../../core/ui-helpers.js';
import { canDrawPictureCircles } from '../../shared/pcb/picture-raster.js';
import { deferShapeCopperCuts } from './picture-refresh.js';
import { isPictureCopperRefreshPending } from './refresh-state.js';
import { normalizeShapeCopperMode, isMaskLayer, boardShapeStrokeSegments, boardShapeRemovalPathD, boardShapeFillPathD, shapePathD, shapeIsFilled } from '../../shared/pcb/board-shape-geometry.js';
import { forgetBoardShapeClearance, getBoardShapeClearance, refreshBoardShapeClearance } from './clearance-overlay.js';
import { hasCopperCuts } from './copper-cuts.js';
import { removalHatchFill } from './removal-hatch.js';
import { refreshSelectedDrcMarker } from './drc-state.js';
import { canonicalBoardShape, displayedBoardShape } from './board-shapes.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShape} BoardShape */
/** @typedef {{interactionOnly?: boolean, skipCopperUpdate?: boolean, liveDrag?: boolean, preserveInteraction?: boolean}} BoardShapeRenderOptions */

const NS = 'http://www.w3.org/2000/svg';

/** @param {number} n */
const r4 = (n) => Math.round(n * 10000) / 10000;

const HOLE_BORDER_WIDTH = 0.05;
const REMOVAL_OUTLINE_WIDTH_PX = 1;
const shapeElementsByApp = new WeakMap();

/** @param {PcbEditor} app */
function shapeElements(app) {
    let elements = shapeElementsByApp.get(app);
    if (!elements) shapeElementsByApp.set(app, elements = new Map());
    return elements;
}

/**
 * @param {PcbEditor} app
 * @param {string} id
 */
export function getBoardShapeElement(app, id) {
    return shapeElements(app).get(id);
}

/**
 * @param {PcbEditor} app
 * @param {string} id
 */
export function hasBoardShapeElement(app, id) {
    return shapeElements(app).has(id);
}

/** @param {PcbEditor} app */
export function boardShapeElementCount(app) {
    return shapeElements(app).size;
}

/** @param {PcbEditor} app */
export function clearBoardShapeElements(app) {
    for (const id of [...shapeElements(app).keys()]) removeBoardShapeElement(app, id);
}

// â”€â”€ Style â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CUT_RING = '#8a929b';
const REMOVAL_COLORS = {
    'remove-copper': '#5f6770',
    'remove-solder-mask': '#8a6923',
    'remove-copper-mask': '#7c3b4c',
};
// Holes use a muted teal feedback base so they read distinctly from copper,
// but hover/selection lighten it in the same direction as every other layer.
const HOLE_FEEDBACK_BASE = '#2f7d72';

/**
 * Base display color for the shape's PCB layer.
 * @param {BoardShape|null|undefined} shape
 */
export function shapeLayerColor(shape) {
    return PCB_LAYERS.find((layer) => layer.id === shape?.layer)?.color || '#ffffff';
}

/**
 * Selection is a lighter version of the owning layer, not a fixed side color.
 * @param {BoardShape|null|undefined} shape
 */
export function shapeSelectionColor(shape) {
    const base = shape?.layer === 'hole' ? HOLE_FEEDBACK_BASE : shapeLayerColor(shape);
    return pcbHighlightColor(base, PCB_SELECTION_HIGHLIGHT_OPACITY);
}

/**
 * Match the effective colour of the track hover's translucent white overlay.
 * @param {BoardShape|null|undefined} shape
 */
export function shapeHoverColor(shape) {
    const base = shape?.layer === 'hole' ? HOLE_FEEDBACK_BASE : shapeLayerColor(shape);
    return pcbHighlightColor(base, PCB_HOVER_HIGHLIGHT_OPACITY);
}

/** @param {BoardShape} shape */
export function shapeStyle(shape) {
    const layer = String(shape.layer || 'top-silk');
    const isHoleLayer = layer === 'hole';
    const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
    const isMaskLayer = layer === 'top-mask' || layer === 'bottom-mask';
    const copperMode = normalizeShapeCopperMode(shape.copperMode);
    const isCopperAdd = isCopperLayer && copperMode === 'add';
    const isCopperRemoveOnly = isCopperLayer && copperMode === 'remove-copper';
    const isCopperRemoveSolderMask = isCopperLayer && copperMode === 'remove-solder-mask';
    const isCopperRemoveMask = isCopperLayer && copperMode === 'remove-copper-mask';
    const isCopperRemoval = isCopperRemoveOnly || isCopperRemoveSolderMask || isCopperRemoveMask;
    const isCopperKnockout = isCopperRemoveOnly || isCopperRemoveMask;
    const layerColor = shapeLayerColor(shape);
    const copperColor = layerColor;
    const filled = isHoleLayer || shapeIsFilled(shape);
    const fillColor = isHoleLayer ? 'var(--bg-canvas, #000000)' : layerColor;
    const fillOpacity = '1';
    const baseStroke = isCopperRemoval ? (REMOVAL_COLORS[copperMode] || CUT_RING) : layerColor;
    const strokeWidth = isCopperRemoval
        ? REMOVAL_OUTLINE_WIDTH_PX
        : isHoleLayer
            ? HOLE_BORDER_WIDTH
            : Math.max(0.05, Number(shape.lineWidth) || 0.2);
    const targetLayer = isCopperKnockout
        ? (layer === 'bottom-copper' ? 'bottom-copper-knockout' : 'top-copper-knockout')
        : layer;
    return { filled, fillColor, fillOpacity, baseStroke, strokeWidth, isHoleLayer, isCopperRemoval, isCopperKnockout, targetLayer };
}

/**
 * @param {PcbEditor} app
 * @param {BoardShape} shape
 * @param {BoardShapeRenderOptions} [opts]
 */
export function renderBoardShape(app, shape, opts = {}) {
    if (!opts.interactionOnly) refreshSelectedDrcMarker(app);
    shape = /** @type {BoardShape} */ (displayedBoardShape(app, shape));
    removeBoardShapeElement(app, shape.id, { preserveInteraction: true });
    const segmentFocus = getBoardShapeSegmentFocus(app);
    const selectedSegment = segmentFocus?.shapeId === shape.id
        && isPcbSelected(app, 'shape', shape)
        ? segmentFocus.segment
        : null;
    const supportsSegmentRendering = !shapeAffectsCopperCuts(shape)
        && shape.kind === 'line';
    const renderAsSegments = supportsSegmentRendering
        && ((!shapeIsFilled(shape) && Object.keys(shape.segmentWidths || {}).length > 0)
            || selectedSegment != null);
    const el = document.createElementNS(NS, renderAsSegments ? 'g' : 'path');
    const isSelected = isPcbSelected(app, 'shape', shape)
        && getBoardShapeSegmentFocus(app)?.shapeId !== shape.id
        && getBoardShapeNodeFocus(app)?.shapeId !== shape.id;
    const hovered = /** @type {BoardShape|null} */ (getHoveredBoardShape(app) || null);
    const isHovered = (!!(hovered && hovered.id === shape.id)
        || getNetHoveredShapeIds(app)?.has(shape.id))
        && getBoardShapeSegmentFocus(app)?.shapeId !== shape.id
        && getBoardShapeNodeFocus(app)?.shapeId !== shape.id;
    const st = shapeStyle(shape);
    if (!renderAsSegments) {
        el.setAttribute('d', st.isCopperRemoval || st.isHoleLayer
            ? boardShapeRemovalPathD(shape)
            : shapePathD(shape, { close: st.filled }));
    }
    if (st.isCopperRemoval || st.isHoleLayer) el.setAttribute('fill-rule', 'evenodd');
    // Removal shapes are hatched across their whole removal area, filled or not.
    el.setAttribute('fill', st.isCopperRemoval
        ? removalHatchFill(app, shape.copperMode)
        : st.filled
            ? (isSelected
                ? shapeSelectionColor(shape)
                : isHovered ? shapeHoverColor(shape) : st.fillColor)
            : 'none');
    if (st.filled || st.isCopperRemoval) el.setAttribute('fill-opacity', st.isCopperRemoval ? '1' : st.fillOpacity);
    el.setAttribute('stroke', isSelected ? shapeSelectionColor(shape) : isHovered ? shapeHoverColor(shape) : st.baseStroke);
    el.setAttribute('stroke-width', String(st.strokeWidth));
    if (st.isCopperRemoval) el.setAttribute('vector-effect', 'non-scaling-stroke');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
    if (shape.layer !== 'board-outline' && ['rect', 'polygon', 'circle', 'image'].includes(shape.kind) && !renderAsSegments && !st.isCopperRemoval && !st.isHoleLayer) {
        el.setAttribute('d', boardShapeFillPathD(shape));
        el.setAttribute('fill-rule', 'evenodd');
        if (!st.filled) el.setAttribute('fill', /** @type {string} */ (el.getAttribute('stroke')));
        el.setAttribute('stroke', 'none');
    }
    if (st.isCopperKnockout && !isSelected && !st.filled) el.setAttribute('stroke-dasharray', '0.6 0.45');
    if (shape.kind === 'image' && canDrawPictureCircles(shape.artwork)) el.setAttribute('fill-rule', 'nonzero');
    if (shape.layer === 'board-outline') el.setAttribute('class', 'pcb-board-outline');
    if (renderAsSegments) {
        if (st.filled) {
            const fillEl = document.createElementNS(NS, 'path');
            fillEl.setAttribute('d', shapePathD(shape, { close: true }));
            fillEl.setAttribute('stroke', 'none');
            el.appendChild(fillEl);
        }
        for (const segment of boardShapeStrokeSegments(shape)) {
            const { start, end, logicalSegment } = segment;
            const segmentEl = document.createElementNS(NS, 'path');
            segmentEl.setAttribute('d', `M ${r4(start.x)} ${r4(start.y)} L ${r4(end.x)} ${r4(end.y)}`);
            segmentEl.setAttribute('fill', 'none');
            segmentEl.setAttribute('stroke', logicalSegment === selectedSegment
                ? shapeSelectionColor(shape)
                : el.getAttribute('stroke') || st.baseStroke);
            segmentEl.setAttribute('stroke-width', String(segment.lineWidth));
            segmentEl.setAttribute('stroke-linejoin', 'round');
            segmentEl.setAttribute('stroke-linecap', 'round');
            if (logicalSegment != null) segmentEl.setAttribute('data-segment', String(logicalSegment));
            el.appendChild(segmentEl);
        }
    }
    const root = st.isHoleLayer ? insideStrokeGroup(el) : el;
    root.setAttribute('data-board-shape-layer', shape.layer || '');
    app.getLayerGroup(st.targetLayer)?.appendChild(root);
    shapeElements(app).set(shape.id, root);
    if (!opts.interactionOnly) refreshBoardShapeClearance(app, shape);
    if (isPictureCopperRefreshPending(app)) {
        if (!opts.skipCopperUpdate && (shapeAffectsCopperCuts(shape) || (!opts.liveDrag && hasCopperCuts(app)))) deferShapeCopperCuts(app);
        return;
    }
    // Rebuilding the copper-cut clip-path re-rasterises the whole copper/fill
    // layer (every track + pour), so during a live drag skip it unless THIS
    // shape is itself a copper cut. Outside a drag, also run it when cuts
    // already exist so a layer/mode change can clear a stale cut.
    if (!opts.skipCopperUpdate) {
        const affectsCuts = shapeAffectsCopperCuts(shape);
        if (opts.liveDrag) {
            if (affectsCuts) app.updateCopperCuts();
        } else if (affectsCuts || hasCopperCuts(app)) {
            app.updateCopperCuts();
        }
    }
}

/**
 * Does this shape participate in copper-cut geometry? (Hole-layer shapes are
 * board cutouts that drill both sides; copper-removal shapes cut their own
 * layer.) Mirrors the filter in `boardShapeCopperCuts`.
 * @param {BoardShape|null|undefined} shape
 */
export function shapeAffectsCopperCuts(shape) {
    if (!shape) return false;
    if (shape.layer === 'hole') return true;
    if (shape.layer === 'top-copper' || shape.layer === 'bottom-copper') {
        const m = normalizeShapeCopperMode(shape.copperMode);
        return m === 'remove-copper' || m === 'remove-copper-mask';
    }
    return false;
}

/**
 * @param {PcbEditor} app
 * @param {string} id
 * @param {BoardShapeRenderOptions} [opts]
 */
export function removeBoardShapeElement(app, id, opts = {}) {
    const el = shapeElements(app).get(id);
    if (el?.parentNode) el.parentNode.removeChild(el);
    shapeElements(app).delete(id);
    if (!opts.preserveInteraction) {
        if ((/** @type {BoardShape|null} */ (getHoveredBoardShape(app) || null))?.id === id) setHoveredBoardShape(app, null);
        const clearance = getBoardShapeClearance(app, id);
        for (const element of clearance?.elements || []) {
            element.parentNode?.removeChild(element);
        }
        forgetBoardShapeClearance(app, id);
    }
}

/**
 * @param {PcbEditor} app
 * @param {BoardShape|null} shape
 */
export function setBoardShapeHover(app, shape) {
    const prev = /** @type {BoardShape|null} */ (getHoveredBoardShape(app) || null);
    const next = /** @type {BoardShape|null} */ (canonicalBoardShape(app, shape) || null);
    if (prev === next || (prev && next && prev.id === next.id)) return;
    setHoveredBoardShape(app, next);
    if (prev) renderBoardShape(app, prev, { interactionOnly: true, skipCopperUpdate: true });
    if (next) renderBoardShape(app, next, { interactionOnly: true, skipCopperUpdate: true });
}

/**
 * @param {PcbEditor} app
 * @param {Iterable<BoardShape>|null|undefined} shapes
 */
export function setBoardShapeNetHover(app, shapes) {
    const previous = getNetHoveredShapeIds(app) || new Set();
    const next = new Set([...shapes || []].map(shape => shape.id));
    if (previous.size === next.size && [...previous].every(id => next.has(id))) return;
    setNetHoveredShapeIds(app, next);
    const changed = new Set([...previous, ...next]);
    for (const shape of app.boardShapes || []) {
        if (changed.has(shape.id)) {
            renderBoardShape(app, shape, { interactionOnly: true, skipCopperUpdate: true });
        }
    }
}
