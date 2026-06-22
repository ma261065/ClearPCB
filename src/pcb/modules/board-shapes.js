/**
 * Free-standing PCB board shapes: rectangle, polygon and arc.
 *
 * Modelled on the circle tool (see PCBApp._renderCircle and friends) but
 * generalised so the three new shapes share one code path. Shapes are plain
 * objects stored in `app.boardShapes`; geometry-specific bits (path, outline,
 * hit-test) dispatch on `shape.kind`.
 *
 * Shape object shape:
 *   common: { id, kind:'rect'|'polygon'|'arc', layer, lineWidth, filled, copperMode }
 *   rect/polygon: + { points: [{x,y}, ...] }   (closed)
 *   arc:          + { start:{x,y}, end:{x,y}, bulge:{x,y} }
 */

import { circumcircle, pointInPolygon, distanceToSegment } from '../../core/geometry.js';
import { isLayerLocked, isLayerVisible, PCB_LAYERS } from './layers.js';
import {
    AddBoardShapeCommand,
    RemoveBoardShapeCommand,
    MoveBoardShapeCommand,
    ModifyBoardShapeCommand,
} from './shape-commands.js';

const NS = 'http://www.w3.org/2000/svg';
const SHAPE_KINDS = new Set(['rect', 'polygon', 'arc']);

/** Round to 4 dp for compact, stable path/serialisation output. */
const r4 = (n) => Math.round(n * 10000) / 10000;

/** Human-friendly title for the Properties panel. */
export function shapeKindLabel(kind) {
    return kind === 'rect' ? 'Rectangle'
        : kind === 'polygon' ? 'Polygon'
            : kind === 'arc' ? 'Arc'
                : 'Shape';
}

/** Normalise a copper mode string (back-compatible with old circle modes). */
export function normalizeShapeCopperMode(mode) {
    const m = String(mode || 'add');
    if (m === 'remove-copper' || m === 'remove-solder-mask' || m === 'remove-copper-mask') return m;
    if (m === 'remove') return 'remove-copper-mask';
    if (m === 'remove-mask') return 'remove-solder-mask';
    return 'add';
}

function isMaskOrDocLayer(layer) {
    const l = String(layer || '');
    return l === 'top-mask' || l === 'bottom-mask'
        || l === 'document' || l === 'top-document' || l === 'bottom-document';
}

// ── Geometry ────────────────────────────────────────────────────────────────

function normAngle(a) {
    let v = a % (2 * Math.PI);
    if (v < 0) v += 2 * Math.PI;
    return v;
}

/** Circumcircle-derived centre/radius for an arc, or null when collinear. */
function arcGeom(shape) {
    return circumcircle(shape.start, shape.bulge, shape.end);
}

/**
 * Walk angles from start through bulge to end. Returns { a1, dir, total }
 * where the arc spans `total` radians from `a1` in direction `dir` (+1/-1),
 * guaranteeing the bulge control point lies on the swept arc.
 */
function arcSweep(shape, g) {
    const a1 = Math.atan2(shape.start.y - g.cy, shape.start.x - g.cx);
    const a2 = Math.atan2(shape.bulge.y - g.cy, shape.bulge.x - g.cx);
    const a3 = Math.atan2(shape.end.y - g.cy, shape.end.x - g.cx);
    const ccw2 = normAngle(a2 - a1);
    const ccw3 = normAngle(a3 - a1);
    // If, walking CCW from start, we reach the bulge before the end, the arc
    // sweeps CCW; otherwise it sweeps CW.
    if (ccw2 < ccw3) return { a1, dir: 1, total: ccw3 };
    return { a1, dir: -1, total: 2 * Math.PI - ccw3 };
}

/** Tessellate an arc into points (start → … → end), passing through the bulge. */
function arcSamples(shape, segments = 48) {
    const g = arcGeom(shape);
    if (!g) return [{ ...shape.start }, { ...shape.end }];
    const { a1, dir, total } = arcSweep(shape, g);
    const pts = [];
    for (let i = 0; i <= segments; i++) {
        const a = a1 + dir * total * (i / segments);
        pts.push({ x: g.cx + g.radius * Math.cos(a), y: g.cy + g.radius * Math.sin(a) });
    }
    return pts;
}

/** Outline points used for fill hit-testing, copper cuts and bounds. */
export function shapeOutline(shape) {
    if (shape.kind === 'arc') return arcSamples(shape);
    return (shape.points || []).map((p) => ({ x: p.x, y: p.y }));
}

/** Outline edges as [p, q] pairs (closed for rect/polygon, open for arc). */
function shapeSegments(shape) {
    if (shape.kind === 'arc') {
        const s = arcSamples(shape);
        const segs = [];
        for (let i = 0; i < s.length - 1; i++) segs.push([s[i], s[i + 1]]);
        return segs;
    }
    const pts = shape.points || [];
    const segs = [];
    for (let i = 0; i < pts.length; i++) segs.push([pts[i], pts[(i + 1) % pts.length]]);
    return segs;
}

/**
 * SVG path data for a shape. rect/polygon are always closed; an arc is closed
 * (chord) only when `close` is set (filled rendering).
 */
export function shapePathD(shape, { close = false } = {}) {
    if (shape.kind === 'arc') {
        const g = arcGeom(shape);
        if (!g) {
            return `M ${r4(shape.start.x)} ${r4(shape.start.y)} L ${r4(shape.end.x)} ${r4(shape.end.y)}`;
        }
        const { dir, total } = arcSweep(shape, g);
        const largeArc = total > Math.PI ? 1 : 0;
        const sweep = dir > 0 ? 1 : 0;
        const rad = r4(g.radius);
        let d = `M ${r4(shape.start.x)} ${r4(shape.start.y)}`
            + ` A ${rad} ${rad} 0 ${largeArc} ${sweep} ${r4(shape.end.x)} ${r4(shape.end.y)}`;
        if (close) d += ' Z';
        return d;
    }
    const pts = shape.points || [];
    if (!pts.length) return '';
    let d = `M ${r4(pts[0].x)} ${r4(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${r4(pts[i].x)} ${r4(pts[i].y)}`;
    return d + ' Z';
}

// ── Geometry clone / translate (shared by drag + commands) ───────────────────

/** Snapshot just the geometry (for move/modify undo). */
export function cloneShapeGeometry(shape) {
    if (shape.kind === 'arc') {
        return { start: { ...shape.start }, end: { ...shape.end }, bulge: { ...shape.bulge } };
    }
    return { points: (shape.points || []).map((p) => ({ x: p.x, y: p.y })) };
}

/** Write a geometry snapshot back onto a shape. */
export function applyShapeGeometry(shape, geom) {
    if (shape.kind === 'arc') {
        shape.start = { ...geom.start };
        shape.end = { ...geom.end };
        shape.bulge = { ...geom.bulge };
    } else {
        shape.points = (geom.points || []).map((p) => ({ x: p.x, y: p.y }));
    }
}

function geomAnchor(geom) {
    return geom.points ? geom.points[0] : geom.start;
}

function translateGeometry(geom, dx, dy) {
    if (geom.points) {
        return { points: geom.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    }
    return {
        start: { x: geom.start.x + dx, y: geom.start.y + dy },
        end: { x: geom.end.x + dx, y: geom.end.y + dy },
        bulge: { x: geom.bulge.x + dx, y: geom.bulge.y + dy },
    };
}

// ── Style ────────────────────────────────────────────────────────────────────

const COPPER_TOP = '#e74c3c';
const COPPER_BOTTOM = '#3498db';
const MASK_OPENING = '#c9a44a';
const BARE_BOARD = '#6e4e2a';
const CUT_RING = '#8a929b';
const HOLE_RING = '#1abc9c';

function shapeStyle(shape) {
    const layer = String(shape.layer || 'top-silk');
    const isHoleLayer = layer === 'hole';
    const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
    const isMaskLayer = layer === 'top-mask' || layer === 'bottom-mask';
    const isDocumentLayer = layer === 'document' || layer === 'top-document' || layer === 'bottom-document';
    const copperMode = normalizeShapeCopperMode(shape.copperMode);
    const isCopperAdd = isCopperLayer && copperMode === 'add';
    const isCopperRemoveOnly = isCopperLayer && copperMode === 'remove-copper';
    const isCopperRemoveSolderMask = isCopperLayer && copperMode === 'remove-solder-mask';
    const isCopperRemoveMask = isCopperLayer && copperMode === 'remove-copper-mask';
    const isCopperKnockout = isCopperRemoveOnly || isCopperRemoveMask;
    const copperColor = layer === 'bottom-copper' ? COPPER_BOTTOM : COPPER_TOP;
    const filled = isHoleLayer
        ? false
        : isCopperLayer
            ? isCopperAdd
            : (!!shape.filled || isMaskLayer || isDocumentLayer);
    const fillColor = isCopperAdd ? copperColor
        : isMaskLayer ? MASK_OPENING
            : isDocumentLayer ? BARE_BOARD
                : '#ffffff';
    const fillOpacity = isCopperAdd ? '0.9' : isDocumentLayer ? '1' : '0.18';
    const baseStroke = isHoleLayer ? HOLE_RING
        : isCopperAdd ? copperColor
            : isCopperKnockout ? CUT_RING
                : isCopperRemoveSolderMask ? MASK_OPENING
                    : isMaskLayer ? MASK_OPENING
                        : isDocumentLayer ? BARE_BOARD
                            : '#ffffff';
    const strokeWidth = Math.max(0.05, Number(shape.lineWidth) || 0.2);
    const targetLayer = isCopperKnockout
        ? (layer === 'bottom-copper' ? 'bottom-copper-knockout' : 'top-copper-knockout')
        : layer;
    return { filled, fillColor, fillOpacity, baseStroke, strokeWidth, isCopperKnockout, targetLayer };
}

/** True when a shape reads as a solid region for hit-testing. */
export function shapeIsFilled(shape) {
    const layer = String(shape.layer || 'top-silk');
    // A hole-layer shape is a board cutout — its whole interior is clickable.
    if (layer === 'hole') return true;
    const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
    if (isCopperLayer) {
        const m = normalizeShapeCopperMode(shape.copperMode);
        if (m === 'add' || m === 'remove-copper' || m === 'remove-copper-mask') return true;
    }
    return !!shape.filled || isMaskOrDocLayer(layer);
}

// ── Render ───────────────────────────────────────────────────────────────────

export function renderBoardShape(app, shape, opts = {}) {
    removeBoardShapeElement(app, shape.id);
    const el = document.createElementNS(NS, 'path');
    const isSelected = !!(app._selectedShape && app._selectedShape.id === shape.id);
    const isHovered = !!(app._hoveredShape && app._hoveredShape.id === shape.id);
    const st = shapeStyle(shape);
    el.setAttribute('d', shapePathD(shape, { close: st.filled }));
    el.setAttribute('fill', st.filled ? st.fillColor : 'none');
    if (st.filled) el.setAttribute('fill-opacity', st.fillOpacity);
    el.setAttribute('stroke', isSelected ? '#ffffff' : isHovered ? '#66ccff' : st.baseStroke);
    el.setAttribute('stroke-width', String(st.strokeWidth));
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
    if (st.isCopperKnockout && !isSelected) el.setAttribute('stroke-dasharray', '0.6 0.45');
    app._getLayerGroup(st.targetLayer)?.appendChild(el);
    app._shapeElements.set(shape.id, el);
    // Rebuilding the copper-cut clip-path re-rasterises the whole copper/fill
    // layer (every track + pour), so during a live drag skip it unless THIS
    // shape is itself a copper cut. Outside a drag, also run it when cuts
    // already exist so a layer/mode change can clear a stale cut.
    const affectsCuts = shapeAffectsCopperCuts(shape);
    if (opts.liveDrag) {
        if (affectsCuts) app._updateCopperCuts?.();
    } else if (affectsCuts || app._hasCopperCuts) {
        app._updateCopperCuts?.();
    }
}

/**
 * Does this shape participate in copper-cut geometry? (Hole-layer shapes are
 * board cutouts that drill both sides; copper-removal shapes cut their own
 * layer.) Mirrors the filter in `boardShapeCopperCuts`.
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

export function removeBoardShapeElement(app, id) {
    const el = app._shapeElements.get(id);
    if (el?.parentNode) el.parentNode.removeChild(el);
    app._shapeElements.delete(id);
}

// ── Hit-test / hover / selection ─────────────────────────────────────────────

export function hitTestBoardShape(app, worldPos) {
    if (!Array.isArray(app.boardShapes) || !worldPos) return null;
    for (let i = app.boardShapes.length - 1; i >= 0; i--) {
        const s = app.boardShapes[i];
        if (!s) continue;
        if (isLayerLocked(s.layer) || !isLayerVisible(s.layer)) continue;
        if (shapeIsFilled(s) && pointInPolygon(worldPos, shapeOutline(s))) return s;
        const tol = Math.max(0.25, (Number(s.lineWidth) || 0.2) / 2 + 0.12);
        for (const [a, b] of shapeSegments(s)) {
            if (distanceToSegment(worldPos, a, b) <= tol) return s;
        }
    }
    return null;
}

export function setBoardShapeHover(app, shape) {
    const prev = app._hoveredShape || null;
    const next = shape || null;
    if (prev === next || (prev && next && prev.id === next.id)) return;
    app._hoveredShape = next;
    if (prev) renderBoardShape(app, prev);
    if (next) renderBoardShape(app, next);
}

export function selectBoardShape(app, shape) {
    const prev = app._selectedShape;
    const next = shape || null;
    if (prev === next || (prev && next && prev.id === next.id)) return;
    app._selectedShape = next;
    app._syncClipboardButtons?.();
    if (prev && app.boardShapes.includes(prev)) renderBoardShape(app, prev);
    if (next) renderBoardShape(app, next);
}

export function deleteSelectedBoardShape(app) {
    const s = app._selectedShape;
    if (!s) return false;
    if (isLayerLocked(s.layer)) return false;
    app.history.execute(new RemoveBoardShapeCommand(app, s));
    selectBoardShape(app, null);
    app._clearProperties?.();
    return true;
}

// ── Drag (move whole shape) ──────────────────────────────────────────────────

export function startBoardShapeDrag(app, shape, worldPos) {
    if (!shape || isLayerLocked(shape.layer)) return false;
    app._shapeDrag = {
        id: shape.id,
        startWorld: { x: worldPos.x, y: worldPos.y },
        before: cloneShapeGeometry(shape),
    };
    return true;
}

export function handleBoardShapeDrag(app, worldPos) {
    const d = app._shapeDrag;
    if (!d) return;
    const s = app.boardShapes.find((x) => x.id === d.id);
    if (!s) return;
    const dx = worldPos.x - d.startWorld.x;
    const dy = worldPos.y - d.startWorld.y;
    // Snap by the shape's anchor point so the whole shape lands on the grid.
    const anchor = geomAnchor(d.before);
    const snapped = app._snapToGrid({ x: anchor.x + dx, y: anchor.y + dy });
    applyShapeGeometry(s, translateGeometry(d.before, snapped.x - anchor.x, snapped.y - anchor.y));
    renderBoardShape(app, s, { liveDrag: true });
}

export function endBoardShapeDrag(app, commit) {
    const d = app._shapeDrag;
    app._shapeDrag = null;
    if (!d) return;
    const s = app.boardShapes.find((x) => x.id === d.id);
    if (!s) return;
    const after = cloneShapeGeometry(s);
    const moved = JSON.stringify(after) !== JSON.stringify(d.before);
    // Roll back first, then commit through history so undo is exact.
    applyShapeGeometry(s, d.before);
    renderBoardShape(app, s);
    if (!moved || !commit) return;
    app.history.execute(new MoveBoardShapeCommand(app, s, d.before, after));
}

// ── Draw lifecycle ───────────────────────────────────────────────────────────

/** Shapes follow the active edit layer; redirect non-graphic layers to silk. */
export function resolveShapeDrawLayer(app, layerId) {
    const id = String(layerId || 'top-copper');
    if (id === 'top-paste' || id === 'bottom-paste' || id === 'board-outline') {
        return id.startsWith('bottom-') ? 'bottom-silk' : 'top-silk';
    }
    return id;
}

function makePreview(app) {
    const preview = document.createElementNS(NS, 'path');
    preview.setAttribute('class', 'pcb-shape-preview');
    preview.setAttribute('fill', 'none');
    preview.setAttribute('stroke', '#66b3ff');
    preview.setAttribute('stroke-width', '0.2');
    preview.setAttribute('stroke-dasharray', '2 2');
    preview.setAttribute('vector-effect', 'non-scaling-stroke');
    preview.setAttribute('stroke-linejoin', 'round');
    app._getLayerGroup('selection-overlay')?.appendChild(preview);
    return preview;
}

function rectPreviewPath(a, b) {
    const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x);
    const miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
    return `M ${minx} ${miny} L ${maxx} ${miny} L ${maxx} ${maxy} L ${minx} ${maxy} Z`;
}

/** Left-click while a shape tool is active. */
export function shapeDrawClick(app, kind, worldPos) {
    if (!SHAPE_KINDS.has(kind)) return;
    const snap = app._snapToGrid(worldPos);
    if (!app._shapeDraw || app._shapeDraw.kind !== kind) {
        const layer = resolveShapeDrawLayer(app, app.activeLayer);
        if (isLayerLocked(layer)) return;
        app._shapeDraw = {
            kind,
            layer,
            points: [{ x: snap.x, y: snap.y }],
            preview: makePreview(app),
        };
        updateShapeDrawPreview(app, worldPos);
        return;
    }
    const d = app._shapeDraw;
    d.points.push({ x: snap.x, y: snap.y });
    if (kind === 'rect' && d.points.length >= 2) finishShapeDraw(app);
    else if (kind === 'arc' && d.points.length >= 3) finishShapeDraw(app);
    else updateShapeDrawPreview(app, worldPos);
}

/** Live preview as the cursor moves (cursor acts as the pending next point). */
export function updateShapeDrawPreview(app, worldPos) {
    const d = app._shapeDraw;
    if (!d) return;
    const p = app._snapToGrid(worldPos);
    let dstr = '';
    if (d.kind === 'rect') {
        dstr = rectPreviewPath(d.points[0], p);
    } else if (d.kind === 'arc') {
        if (d.points.length === 1) {
            dstr = `M ${d.points[0].x} ${d.points[0].y} L ${p.x} ${p.y}`;
        } else {
            dstr = shapePathD({ kind: 'arc', start: d.points[0], end: d.points[1], bulge: p });
        }
    } else if (d.kind === 'polygon') {
        const pts = [...d.points, p];
        dstr = `M ${pts[0].x} ${pts[0].y}` + pts.slice(1).map((q) => ` L ${q.x} ${q.y}`).join('');
        if (d.points.length >= 2) dstr += ` L ${d.points[0].x} ${d.points[0].y}`;
    }
    d.preview?.setAttribute('d', dstr);
}

/** Remove the live preview element and clear draw state. */
export function cancelShapeDraw(app) {
    const d = app._shapeDraw;
    if (!d) return;
    if (d.preview?.parentNode) d.preview.parentNode.removeChild(d.preview);
    app._shapeDraw = null;
}

/** Finish a multi-click polygon (Enter / double-click). */
export function finishPolygonDraw(app) {
    if (app._shapeDraw && app._shapeDraw.kind === 'polygon') finishShapeDraw(app);
}

/** Commit the in-progress draw into a board shape. */
export function finishShapeDraw(app) {
    const d = app._shapeDraw;
    if (!d) return;
    if (d.preview?.parentNode) d.preview.parentNode.removeChild(d.preview);
    app._shapeDraw = null;

    const layer = d.layer || app.activeLayer;
    const alwaysFilled = isMaskOrDocLayer(layer);
    const base = {
        id: `pshape_${app._shapeIdCounter++}`,
        kind: d.kind,
        layer,
        lineWidth: app._shapeDefaults?.lineWidth ?? 0.2,
        filled: alwaysFilled,
        copperMode: 'add',
    };

    let shape = null;
    if (d.kind === 'rect') {
        const a = d.points[0], b = d.points[1];
        if (!a || !b) return;
        const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x);
        const miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
        if (maxx - minx < 0.05 || maxy - miny < 0.05) return;
        shape = {
            ...base,
            points: [
                { x: minx, y: miny }, { x: maxx, y: miny },
                { x: maxx, y: maxy }, { x: minx, y: maxy },
            ],
        };
    } else if (d.kind === 'arc') {
        const [s, e, b] = d.points;
        if (!s || !e || !b) return;
        if (Math.hypot(e.x - s.x, e.y - s.y) < 0.05) return;
        shape = { ...base, filled: false, start: { ...s }, end: { ...e }, bulge: { ...b } };
    } else if (d.kind === 'polygon') {
        const pts = dedupePoints(d.points);
        if (pts.length < 3) return;
        shape = { ...base, points: pts };
    }
    if (!shape) return;
    app.history.execute(new AddBoardShapeCommand(app, shape));
}

/** Drop consecutive (and wrap-around) near-duplicate vertices. */
function dedupePoints(points) {
    const out = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-4) continue;
        out.push({ x: p.x, y: p.y });
    }
    if (out.length >= 2) {
        const first = out[0], last = out[out.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-4) out.pop();
    }
    return out;
}

// ── Properties panel ─────────────────────────────────────────────────────────

const PROP_HIDDEN_LAYERS = new Set([
    'top-paste', 'bottom-paste',
    'top-mask', 'bottom-mask',
    'board-outline',
    'document', 'top-document', 'bottom-document',
]);

/** Snapshot of everything ModifyBoardShapeCommand can change. */
function shapeSnapshot(shape) {
    return {
        geom: cloneShapeGeometry(shape),
        layer: shape.layer,
        lineWidth: Math.max(0.05, Number(shape.lineWidth) || 0.2),
        filled: !!shape.filled,
        copperMode: normalizeShapeCopperMode(shape.copperMode),
    };
}

/** Write a full snapshot back onto a shape (used by ModifyBoardShapeCommand). */
export function applyShapeSnapshot(shape, state) {
    applyShapeGeometry(shape, state.geom);
    shape.layer = state.layer;
    shape.lineWidth = state.lineWidth;
    shape.filled = !!state.filled;
    shape.copperMode = normalizeShapeCopperMode(state.copperMode);
}

export function showBoardShapeProperties(app, shape) {
    const items = app._pcbPropsItems?.();
    if (!items || !shape) return;
    app._setPcbPropsTitle?.(shapeKindLabel(shape.kind));

    const currentLayer = String(shape.layer || 'top-silk');
    const legacyCurrentOpt = PROP_HIDDEN_LAYERS.has(currentLayer)
        ? `<option value="${currentLayer}" selected hidden></option>`
        : '';
    const layerOpts = PCB_LAYERS
        .filter((l) => !PROP_HIDDEN_LAYERS.has(l.id))
        .map((l) => `<option value="${l.id}"${l.id === currentLayer ? ' selected' : ''}>${l.name}</option>`);
    const layerOptionsHtml = [legacyCurrentOpt, ...layerOpts].join('');
    const isCopperLayer = (id) => id === 'top-copper' || id === 'bottom-copper';
    const initialCopperMode = normalizeShapeCopperMode(shape.copperMode);

    items.innerHTML = `
        <div class="prop-row"><label>Line Thickness (mm)</label><input type="number" id="pcbPropShapeLineWidth" min="0.05" step="0.05" value="${Number(shape.lineWidth || 0.2).toFixed(2)}"></div>
        <div class="prop-row"><label>Layer</label><select id="pcbPropShapeLayer">${layerOptionsHtml}</select></div>
        <div class="prop-row"><input type="checkbox" id="pcbPropShapeFilled"${shape.filled ? ' checked' : ''}> <span style="font-size:11px;color:var(--text-secondary)">Filled</span></div>
        <div class="prop-row" id="pcbPropShapeCopperModeRow"><label>Copper Mode</label><select id="pcbPropShapeCopperMode"><option value="add"${initialCopperMode === 'add' ? ' selected' : ''}>Add Copper</option><option value="remove-copper"${initialCopperMode === 'remove-copper' ? ' selected' : ''}>Remove Copper</option><option value="remove-solder-mask"${initialCopperMode === 'remove-solder-mask' ? ' selected' : ''}>Remove Solder Mask</option><option value="remove-copper-mask"${initialCopperMode === 'remove-copper-mask' ? ' selected' : ''}>Remove Copper + Mask</option></select></div>
    `;

    const commit = (mutate) => {
        const before = shapeSnapshot(shape);
        mutate();
        if (isMaskOrDocLayer(shape.layer)) shape.filled = true;
        shape.copperMode = normalizeShapeCopperMode(shape.copperMode);
        const after = shapeSnapshot(shape);
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        applyShapeSnapshot(shape, before);
        app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
    };

    const lineEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeLineWidth'));
    const filledEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeFilled'));
    const layerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropShapeLayer'));
    const copperModeRowEl = /** @type {HTMLDivElement|null} */ (document.getElementById('pcbPropShapeCopperModeRow'));
    const copperModeEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropShapeCopperMode'));

    const syncCopperModeAvailability = () => {
        if (!copperModeEl || !layerEl || !copperModeRowEl) return;
        const copper = isCopperLayer(layerEl.value);
        copperModeRowEl.style.display = copper ? '' : 'none';
        copperModeEl.disabled = !copper;
        copperModeEl.value = copper ? normalizeShapeCopperMode(shape.copperMode) : 'add';
        // A hole-layer shape is a board cutout — "Filled" doesn't apply.
        if (filledEl) filledEl.disabled = layerEl.value === 'hole';
    };

    lineEl?.addEventListener('change', () => {
        const v = Math.max(0.05, Number(lineEl.value) || 0.2);
        if (Math.abs(v - (Number(shape.lineWidth) || 0.2)) < 1e-9) return;
        commit(() => { shape.lineWidth = v; });
    });
    filledEl?.addEventListener('change', () => {
        const v = !!filledEl.checked;
        if (v === !!shape.filled) return;
        commit(() => { shape.filled = v; });
    });
    layerEl?.addEventListener('change', () => {
        const next = layerEl.value;
        if (next === shape.layer) return;
        if (isLayerLocked(next)) {
            layerEl.value = shape.layer;
            syncCopperModeAvailability();
            return;
        }
        commit(() => { shape.layer = next; });
        syncCopperModeAvailability();
    });
    copperModeEl?.addEventListener('change', () => {
        if (copperModeEl.disabled) return;
        const next = normalizeShapeCopperMode(copperModeEl.value);
        if (next === normalizeShapeCopperMode(shape.copperMode)) return;
        commit(() => { shape.copperMode = next; });
        syncCopperModeAvailability();
    });

    syncCopperModeAvailability();
    app._setActiveRibbonTab?.('pcb-properties');
}

export function refreshBoardShapeProperties(app, shape) {
    if (shape && app._selectedShape && app._selectedShape.id === shape.id) {
        showBoardShapeProperties(app, shape);
    }
}

// ── Copper cuts ──────────────────────────────────────────────────────────────

/**
 * SVG sub-paths for board shapes that subtract copper on the given copper
 * layer. Returns { count, d } to fold into PCBApp._updateCopperCuts.
 */
export function boardShapeCopperCuts(app, copperLayer) {
    let d = '';
    let count = 0;
    for (const s of (app.boardShapes || [])) {
        if (!s) continue;
        // A hole-layer shape is a board cutout — it removes copper on both
        // sides regardless of mode. Copper-removal shapes only cut their own
        // copper layer.
        if (s.layer === 'hole') {
            // included on every side
        } else if (s.layer === copperLayer) {
            const m = normalizeShapeCopperMode(s.copperMode);
            if (m !== 'remove-copper' && m !== 'remove-copper-mask') continue;
        } else {
            continue;
        }
        const outline = shapeOutline(s);
        if (outline.length < 3) continue;
        d += ` M ${r4(outline[0].x)} ${r4(outline[0].y)}`;
        for (let i = 1; i < outline.length; i++) d += ` L ${r4(outline[i].x)} ${r4(outline[i].y)}`;
        d += ' Z';
        count++;
    }
    return { count, d };
}

// ── Serialisation ────────────────────────────────────────────────────────────

export function serializeBoardShapes(app) {
    return (app.boardShapes || []).map((s) => {
        const base = {
            id: s.id,
            kind: s.kind,
            layer: s.layer,
            lineWidth: s.lineWidth,
            filled: !!s.filled,
            copperMode: normalizeShapeCopperMode(s.copperMode),
        };
        if (s.kind === 'arc') {
            return { ...base, start: { ...s.start }, end: { ...s.end }, bulge: { ...s.bulge } };
        }
        return { ...base, points: (s.points || []).map((p) => ({ x: p.x, y: p.y })) };
    });
}

const pt = (p) => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 });

export function loadBoardShapes(app, arr) {
    if (!Array.isArray(arr)) return;
    for (const sd of arr) {
        const kind = SHAPE_KINDS.has(sd?.kind) ? sd.kind : null;
        if (!kind) continue;
        const base = {
            id: String(sd.id || `pshape_${app._shapeIdCounter++}`),
            kind,
            layer: String(sd.layer || 'top-silk'),
            lineWidth: Math.max(0.05, Number(sd.lineWidth) || (app._shapeDefaults?.lineWidth ?? 0.2)),
            filled: !!sd.filled,
            copperMode: normalizeShapeCopperMode(sd.copperMode),
        };
        let shape;
        if (kind === 'arc') {
            shape = { ...base, start: pt(sd.start), end: pt(sd.end), bulge: pt(sd.bulge) };
        } else {
            const pts = Array.isArray(sd.points) ? sd.points.map(pt) : [];
            if (pts.length < 3) continue;
            shape = { ...base, points: pts };
        }
        app.boardShapes.push(shape);
        renderBoardShape(app, shape);
        const n = /pshape_(\d+)/.exec(shape.id);
        if (n) app._shapeIdCounter = Math.max(app._shapeIdCounter, Number(n[1]) + 1);
    }
}
