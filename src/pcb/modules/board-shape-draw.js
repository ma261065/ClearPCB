/**
 * The shape-drawing tools (line, rectangle, polygon, arc, circle and hole): clicks place
 * corners, the preview follows the pointer, and the draw finishes on a double-click,
 * Enter, a click on the first corner or a stationary right-click. The draw is the
 * _shapeDraw interaction slot, which this module owns.
 */
import { shapeFromPoints, shapePreviewPath, advanceShapeDrawing, canFinishShapeAtPoint } from '../../shapes/shape-drawing.js';
import { SHAPE_KINDS } from '../../core/pcb-board-shapes.js';
import { getShapeDefaults } from './board-shape-state.js';
import { PCB_LAYERS, placementBlock } from './layers.js';
import { AddBoardShapeCommand } from './shape-commands.js';
import { AddTrackCommand } from './track-commands.js';
import { isCopperPathShape, trackFromBoardShape } from '../../shared/pcb/copper-path-tracks.js';
import { clearAxisGlow, renderAxisGlow, pathAlignmentSegments } from '../../shapes/axis-glow.js';
import { pathContinuationConstraints } from '../../shapes/path-snap.js';
import { setPcbSelection } from './selection-registry.js';
import { snapPathPoint } from './path-edit.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { normalizeShapeCopperMode, isMaskLayer, normalizedBoardShapeLineWidth } from '../../shared/pcb/board-shape-geometry.js';
import { PROP_HIDDEN_LAYERS } from './board-shape-properties.js';
import { boardSquareIndicators } from './board-shape-drag.js';
import { shapeStyle } from './board-shape-render.js';
import { nextBoardShapeId } from './board-shapes.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/track.js').Track} Track */
/** @typedef {import('../../shapes/shape-drawing.js').DrawingKind} DrawingKind */
/** @typedef {{x: number, y: number, [key: string]: any}} Point */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShape} BoardShape */
/** @typedef {Record<string, any> & {kind: DrawingKind, layer: string, points: Point[], preview: SVGPathElement, cursorWorld?: Point}} ShapeDraw */

const NS = 'http://www.w3.org/2000/svg';

// â”€â”€ Draw lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * The layer a shape tool draws on: the active layer, with display-only layers (paste,
 * mask, outline, Via) mapped to a drawable one. A locked or hidden layer is kept, not
 * swapped for another: the tool refuses to draw there and says why (tool-lifecycle.js).
 * @param {PcbEditor} app
 * @param {string|null|undefined} layerId
 * @returns {string}
 */
export function resolveShapeDrawLayer(app, layerId) {
    let id = String(layerId || 'top-copper');
    if (id === 'top-paste' || id === 'bottom-paste' || id === 'board-outline' || id === 'vias') {
        id = id.startsWith('bottom-') ? 'bottom-silk' : 'top-silk';
    }
    const drawable = PCB_LAYERS.filter(layer => !PROP_HIDDEN_LAYERS.has(layer.id));
    return (drawable.find(layer => layer.id === id) || drawable[0]).id;
}

/** @param {PcbEditor} app */
function makePreview(app) {
    const preview = document.createElementNS(NS, 'path');
    preview.setAttribute('class', 'pcb-shape-preview');
    preview.setAttribute('stroke', 'var(--sch-symbol-outline, #ffffff)');
    preview.setAttribute('stroke-width', '1');
    preview.setAttribute('opacity', '0.6');
    preview.setAttribute('vector-effect', 'non-scaling-stroke');
    preview.setAttribute('stroke-linejoin', 'round');
    app.getLayerGroup('selection-overlay')?.appendChild(preview);
    return preview;
}

/**
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
function shapeDrawSnap(app, worldPos) {
    const draw = getShapeDraw(app);
    if (draw?.kind === 'arc' && draw.points.length === 2) return worldPos;
    const previous = draw?.points.at(-1);
    const continuations = draw && ['line', 'polygon'].includes(draw.kind)
        ? pathContinuationConstraints([...draw.points, worldPos], false, draw.points.length) : [];
    return snapPathPoint(app, worldPos, previous ? [previous] : [], false, continuations);
}

/** Screen distance (px) within which a click repeats the last placed vertex. */
const REPEAT_CLICK_PX = 4;

/**
 * The open shape drawing session (`{ kind, â€¦ }`), or null.
 * @param {PcbEditor} app
 * @returns {ShapeDraw|null}
 */
export function getShapeDraw(app) {
    return getPcbInteraction(app, '_shapeDraw');
}

/**
 * Left-click while a shape tool is active.
 * @param {PcbEditor} app
 * @param {string} kind
 * @param {Point} worldPos
 */
export function shapeDrawClick(app, kind, worldPos) {
    if (!SHAPE_KINDS.has(kind) || kind === 'image') return;
    const drawKind = /** @type {DrawingKind} */ (kind);
    const snap = shapeDrawSnap(app, worldPos);
    const activeDraw = getShapeDraw(app);
    if (!activeDraw || activeDraw.kind !== kind) {
        const layer = resolveShapeDrawLayer(app, app.activeLayer);
        // The press handler explains a blocked layer; nothing is drawn there either way.
        if (placementBlock([{ id: layer }])) return;
        app.activeLayer = layer;
        setPcbInteraction(app, '_shapeDraw', {
            kind: drawKind,
            layer,
            points: [{ x: snap.x, y: snap.y }],
            preview: makePreview(app),
        });
        updateShapeDrawPreview(app, worldPos);
        return;
    }
    const d = activeDraw;
    // The second click of a double-click lands on the vertex it just placed. It
    // must not add another: snapped against itself it can land just off-grid.
    const last = d.points.at(-1);
    if ((kind === 'line' || kind === 'polygon') && last
        && Math.hypot(worldPos.x - last.x, worldPos.y - last.y) * (app.viewport?.scale || 1) < REPEAT_CLICK_PX) {
        updateShapeDrawPreview(app, worldPos);
        return;
    }
    const next = advanceShapeDrawing(drawKind, d.points, snap);
    d.points = next.points;
    if (next.complete) finishShapeDraw(app);
    else updateShapeDrawPreview(app, worldPos);
}

/**
 * Live preview as the cursor moves (cursor acts as the pending next point).
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function updateShapeDrawPreview(app, worldPos) {
    const d = getShapeDraw(app);
    if (!d) return;
    d.cursorWorld = { ...worldPos };
    d.preview.setAttribute('stroke-linejoin', 'round');
    d.preview.setAttribute('stroke-linecap', 'round');
    const p = shapeDrawSnap(app, worldPos);
    const dstr = shapePreviewPath(d.kind, d.points, p, getShapeDefaults(app)?.cornerRadius);
    d.preview?.setAttribute('d', dstr);
    const geometry = shapeFromPoints(d.kind, [...d.points, p], true);
    const lineWidth = normalizedBoardShapeLineWidth({ kind: d.kind, layer: d.layer }, getShapeDefaults(app)?.lineWidth);
    const indicators = geometry?.points
        ? d.kind === 'rect' ? boardSquareIndicators(/** @type {BoardShape} */ (/** @type {unknown} */ ({ ...geometry, layer: d.layer, lineWidth })))
            : pathAlignmentSegments(geometry.points, d.kind !== 'line', [geometry.points.length - 1],
                geometry.points.map(() => lineWidth)).map(segment => ({ ...segment, layerId: d.layer }))
        : [];
    renderAxisGlow(app, indicators);
    if (d.preview) {
        const st = shapeStyle(/** @type {BoardShape} */ (/** @type {unknown} */ ({
            layer: d.layer,
            filled: !!getShapeDefaults(app)?.filled,
            copperMode: getShapeDefaults(app)?.copperMode,
        })));
        const previewFilled = d.kind !== 'line' && st.filled;
        d.preview.setAttribute('fill', previewFilled ? st.fillColor : 'none');
        if (previewFilled) d.preview.setAttribute('fill-opacity', st.fillOpacity);
        else d.preview.removeAttribute('fill-opacity');
    }
}

/**
 * Remove the live preview element and clear draw state.
 * @param {PcbEditor} app
 */
export function cancelShapeDraw(app) {
    const d = getShapeDraw(app);
    if (!d) return;
    clearAxisGlow(app);
    if (d.preview?.parentNode) d.preview.parentNode.removeChild(d.preview);
    setPcbInteraction(app, '_shapeDraw', null);
}

/**
 * Finish a multi-click polygon (Enter / double-click).
 * @param {PcbEditor} app
 */
export function finishPolygonDraw(app) {
    if (getShapeDraw(app)?.kind === 'polygon') finishShapeDraw(app);
}

/**
 * Finish a multi-click open Line (Enter / double-click).
 * @param {PcbEditor} app
 */
export function finishLineDraw(app) {
    if (getShapeDraw(app)?.kind === 'line') finishShapeDraw(app);
}

/**
 * Commit the cursor position as the final point and finish the active shape.
 * @param {PcbEditor} app
 * @param {Point|null|undefined} worldPos
 */
export function finishShapeDrawAtPoint(app, worldPos) {
    const draw = getShapeDraw(app);
    if (!draw || !worldPos) return false;
    const point = shapeDrawSnap(app, worldPos);
    if (!canFinishShapeAtPoint(draw.kind, draw.points)) return false;
    draw.points = advanceShapeDrawing(draw.kind, draw.points, point).points;
    finishShapeDraw(app);
    return true;
}

/**
 * Commit the in-progress draw into a board shape.
 * @param {PcbEditor} app
 */
export function finishShapeDraw(app) {
    const d = getShapeDraw(app);
    if (!d) return;
    clearAxisGlow(app);
    if (d.preview?.parentNode) d.preview.parentNode.removeChild(d.preview);
    setPcbInteraction(app, '_shapeDraw', null);

    const layer = d.layer || app.activeLayer;
    const alwaysFilled = isMaskLayer(layer);
    const base = {
        id: nextBoardShapeId(app),
        kind: d.kind,
        layer,
        lineWidth: normalizedBoardShapeLineWidth(
            { kind: d.kind, layer },
            getShapeDefaults(app)?.lineWidth,
        ),
        filled: d.kind === 'line' ? false : alwaysFilled || !!getShapeDefaults(app)?.filled,
        copperMode: normalizeShapeCopperMode(getShapeDefaults(app)?.copperMode),
        plated: layer === 'hole' && !!getShapeDefaults(app)?.plated,
        net: layer === 'top-copper' || layer === 'bottom-copper'
            ? String(getShapeDefaults(app)?.net || '')
            : '',
        cornerRadius: d.kind === 'rect' ? Math.max(0, Number(getShapeDefaults(app)?.cornerRadius) || 0) : undefined,
    };

    const geometry = shapeFromPoints(d.kind, d.points);
    if (!geometry) return;
    const shape = /** @type {BoardShape} */ ({ ...base, ...geometry, filled: d.kind === 'arc' ? false : base.filled });
    if ('points' in shape && isCopperPathShape(shape)) {
        // A copper path is routing intent, with or without a net, so it enters
        // the Track model directly instead of creating a generic shape first.
        const track = trackFromBoardShape(shape, shape.net);
        app.history.execute(new AddTrackCommand(app, track));
        setPcbSelection(app, [{ kind: 'track', object: track }]);
        app.refreshSelectionHighlights();
        return;
    }
    app.history.execute(new AddBoardShapeCommand(app, shape));
}

/**
 * Keys while a board shape is being drawn: Escape cancels; Enter finishes a polygon
 * or line, or completes any other shape at the cursor.
 * @param {PcbEditor} app
 * @param {KeyboardEvent} e
 * @returns {boolean|null} null when no shape is being drawn, else whether the key was consumed.
 */
export function handleShapeDrawKey(app, e) {
    const draw = getShapeDraw(app);
    if (!draw) return null;
    if (e.key === 'Escape') {
        cancelShapeDraw(app);
        return true;
    }
    if (e.key === 'Enter' && draw.kind === 'polygon') {
        finishPolygonDraw(app);
        return true;
    }
    if (e.key === 'Enter' && draw.kind === 'line') {
        finishLineDraw(app);
        return true;
    }
    if (e.key === 'Enter') {
        finishShapeDrawAtPoint(app, draw.cursorWorld);
        return true;
    }
    return false;
}
