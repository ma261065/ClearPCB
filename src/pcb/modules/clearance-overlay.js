import { buildTrackLayerRuns, hasTrackElements, hasViaElements } from './track-render.js';
import { boardShapeClearanceOutlines, pcbTextClearanceOutlines } from './copper-fill-geom.js';
import { placementTransform } from './track-commands.js';
import { shouldDeferShapeClearance } from './picture-refresh.js';
import { isPcbPasteActive } from './pcb-paste.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/*
 * The clearance overlay: a faint halo at the Clearance distance around every pad,
 * via, track, copper shape and copper text, drawn beneath the copper. Toggled from
 * the Design tab (showClearances); edits refresh only what changed (a dragged track,
 * a moved via or shape). The per-editor overlay state is owned here.
 */

const overlayStates = new WeakMap();

/**
 * Halo elements per track id, shared via halos keyed by geometry, and overlay view state.
 * @param {PcbEditor} app
 */
function overlayState(app) {
    let state = overlayStates.get(app);
    if (!state) overlayStates.set(app, state = {
        trackElements: new Map(),
        viaCache: new Map(),
        viaKeys: new Map(),
        clearancesVisible: false,
        boardShapeClearanceCache: new Map(),
        padHaloGroups: null,
    });
    return state;
}

/**
 * The overlay's caches, for tests.
 * @param {PcbEditor} app
 */
export function clearanceOverlayState(app) {
    return overlayState(app);
}

/**
 * Whether the clearance overlay is showing.
 * @param {PcbEditor} app
 */
export function areClearancesVisible(app) {
    return !!overlayState(app).clearancesVisible;
}

/**
 * Cached clearance halo of a board shape or copper text, if any.
 * @param {PcbEditor} app
 */
export function getBoardShapeClearance(app, id) {
    return overlayState(app).boardShapeClearanceCache.get(id);
}

/**
 * Forget a board shape's or text's cached halo (its element is the caller's to remove).
 * @param {PcbEditor} app
 */
export function forgetBoardShapeClearance(app, id) {
    overlayState(app).boardShapeClearanceCache.delete(id);
}

/**
 * The halo group that follows a component's pads during a move, if the overlay is on.
 * @param {PcbEditor} app
 */
export function getPadHaloGroup(app, compId) {
    return overlayState(app).padHaloGroups?.get(compId);
}

/**
 * Toggle a faint ghost halo showing the clearance band around every
* pad, via, track, and copper/hole shape. The halo width equals the **Clearance** value
 * from the routing tab — i.e. the minimum copper-to-copper gap any
 * other net's copper must keep from this object's edge.
 *
 * Pad shapes (rect / ellipse / oval) are honored. Halos are drawn
 * beneath copper so they don't obscure the board.
 *
 * Wired to the "Clearance" toggle button in the routing tab. Also
 * callable from the console: `bootstrap.pcbApp.showClearances(true|false)`.
 *
 * @param {PcbEditor} app
 * @param {boolean} [show] - explicit on/off; omit to toggle.
 * @param {object|null} [liveTrack] - update only this track's rendered clearance during a drag.
 */
export function showClearances(app, show, liveTrack = null) {
    const NS = 'http://www.w3.org/2000/svg';
    const HALO_CLASS = 'debug-clearance';
    const OVERLAY_LAYER = 'clearance-overlay';

    const state = overlayState(app);
    const overlay = app.getLayerGroup(OVERLAY_LAYER);
    if (liveTrack) {
        for (const element of state.trackElements.get(liveTrack.id) || []) element.remove();
        state.trackElements.delete(liveTrack.id);
    } else {
        while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
        state.trackElements.clear();
        state.viaCache.clear();
        state.viaKeys.clear();
    }

    if (show === undefined) show = !state.clearancesVisible;
    if (!liveTrack) {
        const shapeIds = new Set([...(app.boardShapes || []), ...(app.texts?.values() || [])].map(shape => shape.id));
        for (const id of state.boardShapeClearanceCache.keys()) {
            if (!shapeIds.has(id)) state.boardShapeClearanceCache.delete(id);
        }
    }
    state.clearancesVisible = !!show;
    if (!state.clearancesVisible) {
        state.boardShapeClearanceCache.clear();
        return;
    }

    const params = app.getRoutingParams();
    const halo = params.clearance;

    const HALO_STROKE = 'rgba(255, 255, 255, 0.55)';
    // Stroke width in CSS pixels (constant on screen at any zoom thanks
    // to vector-effect: non-scaling-stroke). 1px = thin clean line.
    const OUTLINE_W = 1;

    const styleHalo = (el) => {
        el.setAttribute('class', HALO_CLASS);
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', HALO_STROKE);
        el.setAttribute('stroke-width', String(OUTLINE_W));
        el.setAttribute('vector-effect', 'non-scaling-stroke');
        el.setAttribute('pointer-events', 'none');
    };

    const isLayerVisible = (layerId) => {
        const g = app.getLayerGroup(layerId);
        return !g || g.style.display !== 'none';
    };
    const topVisible = isLayerVisible('top-copper');
    const bottomVisible = isLayerVisible('bottom-copper');

    // Build a single SVG path representing the Minkowski expansion of a
    // pad shape by `halo`. Returns null if shape unsupported.
    // Geometry is sized exactly to the clearance boundary; the constant-
    // width screen-pixel stroke straddles it.
    const padHaloPath = (cx, cy, w, h, shape) => {
        const hw = w / 2, hh = h / 2;
        const grow = halo;
        if (shape === 'ellipse') {
            if (Math.abs(hw - hh) < 1e-9) {
                const r = hw + grow;
                const c = document.createElementNS(NS, 'circle');
                c.setAttribute('cx', String(cx));
                c.setAttribute('cy', String(cy));
                c.setAttribute('r', String(r));
                return c;
            }
            const e = document.createElementNS(NS, 'ellipse');
            e.setAttribute('cx', String(cx));
            e.setAttribute('cy', String(cy));
            e.setAttribute('rx', String(hw + grow));
            e.setAttribute('ry', String(hh + grow));
            return e;
        }
        // 'oval' (stadium) and 'rect' both expand to a rounded rectangle:
        //   oval: corner radius = min(hw, hh) + halo
        //   rect: corner radius = halo (true Minkowski sum with a disk)
        const cornerR = (shape === 'oval' ? Math.min(hw, hh) : 0) + grow;
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', String(cx - hw - grow));
        r.setAttribute('y', String(cy - hh - grow));
        r.setAttribute('width', String(w + grow * 2));
        r.setAttribute('height', String(h + grow * 2));
        r.setAttribute('rx', String(cornerR));
        r.setAttribute('ry', String(cornerR));
        return r;
    };

    // Halos for component pads — wrapped in a per-placement <g> with a
    // translate() transform so they follow the component during drag
    // (the drag handler updates the same transform).
    if (!liveTrack) state.padHaloGroups = new Map();
    for (const [compId, pl] of liveTrack ? [] : app.placements) {
        const grp = document.createElementNS(NS, 'g');
        grp.setAttribute('class', 'halo-comp');
        grp.setAttribute('data-comp-id', compId);
        grp.setAttribute('transform', placementTransform(pl));
        for (const off of (pl.padOffsets || [])) {
            const padLayer = off.layer || 'top';
            // Respect copper-layer visibility. 'both' (through-hole pads)
            // are shown if either copper layer is visible.
            if (padLayer === 'top' && !topVisible) continue;
            if (padLayer === 'bottom' && !bottomVisible) continue;
            if (padLayer === 'both' && !topVisible && !bottomVisible) continue;
            // Coords are pad offsets from the component origin; the
            // wrapping <g> applies pl.x/pl.y as a translate.
            const el = padHaloPath(off.dx, off.dy, off.width || 0, off.height || 0, off.shape || 'rect');
            styleHalo(el);
            grp.appendChild(el);
        }
        overlay.appendChild(grp);
        state.padHaloGroups.set(compId, grp);
    }

    // Halos for routed tracks. Computed as the Minkowski-sum offset
    // polygon of each track centerline by (trackR + OUTLINE_W/2),
    // rendered as a closed <polygon> stroked with width OUTLINE_W. Pure
    // vector — no masks, no rasterization, zero per-frame cost on
    // zoom/pan.
    //
    // Construction (per track):
    //   - Walk each segment; emit perpendicular offsets on the right
    //     side going forward, then on the left side going backward.
    //   - At interior vertices: insert a short arc fan on the OUTSIDE
    //     of the bend (round-join). Inside vertex uses the segment-
    //     intersection point.
    //   - At endpoints: insert a semicircular cap (round-cap).
    //
    // Where two tracks meet at a junction, their polygons overlap and
    // the stroked outlines visibly cross — same artifact as pad/via
    // halos already have. Acceptable.
    //
    // Halo radius is sized per-track from each rendered run's stroke
    // width (tracks may carry per-segment widths); see the track loop.
    // Arc tessellation: number of segments per FULL CIRCLE. Each arc
    // emits a proportional fraction of these. Higher = smoother caps
    // and corners at the cost of more polygon vertices.
    const ARC_STEPS_FULL = 64;

    const trackToPoints = (track) => {
        const out = [];
        const push = (x, y) => {
            const xn = parseFloat(x), yn = parseFloat(y);
            if (Number.isFinite(xn) && Number.isFinite(yn)) out.push([xn, yn]);
        };
        if (track.tagName === 'polyline') {
            const tokens = (track.getAttribute('points') || '').trim().split(/[\s,]+/);
            for (let i = 0; i + 1 < tokens.length; i += 2) push(tokens[i], tokens[i + 1]);
        } else if (track.tagName === 'line') {
            push(track.getAttribute('x1'), track.getAttribute('y1'));
            push(track.getAttribute('x2'), track.getAttribute('y2'));
        }
        // De-dupe consecutive identical points.
        const dedup = [];
        for (const p of out) {
            if (dedup.length === 0 || dedup[dedup.length - 1][0] !== p[0] || dedup[dedup.length - 1][1] !== p[1]) {
                dedup.push(p);
            }
        }
        return dedup;
    };

    // Build the offset polygon of `pts` by radius `r`. Returns array of
    // [x, y] pairs (closed polygon — first ≠ last).
    const offsetPolygon = (pts, r) => {
        if (pts.length < 2) return [];
        const n = pts.length;
        // Per-segment unit direction and perpendicular (right-hand normal).
        const dirs = new Array(n - 1);
        const perps = new Array(n - 1);
        for (let i = 0; i < n - 1; i++) {
            const dx = pts[i + 1][0] - pts[i][0];
            const dy = pts[i + 1][1] - pts[i][1];
            const len = Math.hypot(dx, dy) || 1;
            dirs[i] = [dx / len, dy / len];
            perps[i] = [dy / len, -dx / len]; // right-hand perpendicular
        }

        const arcFan = (cx, cy, fromAngle, toAngle, ccw) => {
            // Returns intermediate arc points (not including endpoints).
            let delta = toAngle - fromAngle;
            if (ccw) {
                while (delta <= 0) delta += Math.PI * 2;
            } else {
                while (delta >= 0) delta -= Math.PI * 2;
            }
            // Number of steps proportional to arc sweep angle.
            const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI * 2) * ARC_STEPS_FULL));
            const out = [];
            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                const a = fromAngle + delta * t;
                out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
            }
            return out;
        };

        // Right side, forward (i = 0 .. n-1)
        const right = [];
        // Start cap (semicircle from left side around to right side)
        {
            const p = perps[0];
            const startAngle = Math.atan2(-p[1], -p[0]); // left-side angle
            const endAngle = Math.atan2(p[1], p[0]);     // right-side angle
            right.push([pts[0][0] + Math.cos(startAngle) * r, pts[0][1] + Math.sin(startAngle) * r]);
            // CCW so the cap bulges AWAY from the segment (around the back of the start point).
            for (const a of arcFan(pts[0][0], pts[0][1], startAngle, endAngle, true)) right.push(a);
            right.push([pts[0][0] + p[0] * r, pts[0][1] + p[1] * r]);
        }
        // Forward through interior vertices (1 .. n-2): join between seg i-1 and seg i.
        for (let i = 1; i < n - 1; i++) {
            const p0 = perps[i - 1];
            const p1 = perps[i];
            // Cross of dirs to determine bend direction.
            const cross = dirs[i - 1][0] * dirs[i][1] - dirs[i - 1][1] * dirs[i][0];
            if (Math.abs(cross) < 1e-9) {
                // Collinear — just push the point.
                right.push([pts[i][0] + p1[0] * r, pts[i][1] + p1[1] * r]);
                continue;
            }
            if (cross > 0) {
                // Right turn — right side is OUTSIDE → arc fan.
                const fromA = Math.atan2(p0[1], p0[0]);
                const toA = Math.atan2(p1[1], p1[0]);
                right.push([pts[i][0] + p0[0] * r, pts[i][1] + p0[1] * r]);
                for (const a of arcFan(pts[i][0], pts[i][1], fromA, toA, true)) right.push(a);
                right.push([pts[i][0] + p1[0] * r, pts[i][1] + p1[1] * r]);
            } else {
                // Left turn — right side is INSIDE → miter (segment intersection).
                // Lines: P1 = pts[i-1]+p0*r + t*dirs[i-1]
                //        P2 = pts[i]  +p1*r + s*dirs[i]
                // Solve for intersection.
                const a1x = pts[i - 1][0] + p0[0] * r;
                const a1y = pts[i - 1][1] + p0[1] * r;
                const a2x = pts[i][0] + p1[0] * r;
                const a2y = pts[i][1] + p1[1] * r;
                const denom = dirs[i - 1][0] * (-dirs[i][1]) - dirs[i - 1][1] * (-dirs[i][0]);
                if (Math.abs(denom) < 1e-9) {
                    right.push([a2x, a2y]);
                } else {
                    const t = ((a2x - a1x) * (-dirs[i][1]) - (a2y - a1y) * (-dirs[i][0])) / denom;
                    const mx = a1x + dirs[i - 1][0] * t;
                    const my = a1y + dirs[i - 1][1] * t;
                    // Miter limit: if the miter point is too far from
                    // the vertex (acute inside corner), fall back to a
                    // bevel (two endpoints) to avoid the spike.
                    const distSq = (mx - pts[i][0]) * (mx - pts[i][0]) + (my - pts[i][1]) * (my - pts[i][1]);
                    const maxDist = r * 4; // miter limit ~4× ring radius
                    if (distSq > maxDist * maxDist) {
                        right.push([pts[i][0] + p0[0] * r, pts[i][1] + p0[1] * r]);
                        right.push([pts[i][0] + p1[0] * r, pts[i][1] + p1[1] * r]);
                    } else {
                        right.push([mx, my]);
                    }
                }
            }
        }
        // End cap (right side around to left side)
        {
            const p = perps[n - 2];
            right.push([pts[n - 1][0] + p[0] * r, pts[n - 1][1] + p[1] * r]);
            const startAngle = Math.atan2(p[1], p[0]);
            const endAngle = Math.atan2(-p[1], -p[0]);
            // CCW so the cap bulges AWAY from the segment (around the front of the end point).
            for (const a of arcFan(pts[n - 1][0], pts[n - 1][1], startAngle, endAngle, true)) right.push(a);
            right.push([pts[n - 1][0] - p[0] * r, pts[n - 1][1] - p[1] * r]);
        }
        // Left side, backward (i = n-2 .. 1): mirror logic with negated perps.
        for (let i = n - 2; i >= 1; i--) {
            const p0 = perps[i];      // perp of segment going INTO vertex from left walk
            const p1 = perps[i - 1];
            const cross = dirs[i][0] * dirs[i - 1][1] - dirs[i][1] * dirs[i - 1][0];
            // Left side uses negated perpendiculars.
            if (Math.abs(cross) < 1e-9) {
                right.push([pts[i][0] - p1[0] * r, pts[i][1] - p1[1] * r]);
                continue;
            }
            if (cross > 0) {
                // Walking backwards: a "right turn" in reverse means left side is OUTSIDE → arc fan.
                const fromA = Math.atan2(-p0[1], -p0[0]);
                const toA = Math.atan2(-p1[1], -p1[0]);
                right.push([pts[i][0] - p0[0] * r, pts[i][1] - p0[1] * r]);
                for (const a of arcFan(pts[i][0], pts[i][1], fromA, toA, true)) right.push(a);
                right.push([pts[i][0] - p1[0] * r, pts[i][1] - p1[1] * r]);
            } else {
                // Inside — miter with limit fallback to bevel.
                const a1x = pts[i + 1][0] - p0[0] * r;
                const a1y = pts[i + 1][1] - p0[1] * r;
                const a2x = pts[i][0] - p1[0] * r;
                const a2y = pts[i][1] - p1[1] * r;
                const dx0 = -dirs[i][0], dy0 = -dirs[i][1];
                const dx1 = -dirs[i - 1][0], dy1 = -dirs[i - 1][1];
                const denom = dx0 * (-dy1) - dy0 * (-dx1);
                if (Math.abs(denom) < 1e-9) {
                    right.push([a2x, a2y]);
                } else {
                    const t = ((a2x - a1x) * (-dy1) - (a2y - a1y) * (-dx1)) / denom;
                    const mx = a1x + dx0 * t;
                    const my = a1y + dy0 * t;
                    const distSq = (mx - pts[i][0]) * (mx - pts[i][0]) + (my - pts[i][1]) * (my - pts[i][1]);
                    const maxDist = r * 4;
                    if (distSq > maxDist * maxDist) {
                        right.push([pts[i][0] - p0[0] * r, pts[i][1] - p0[1] * r]);
                        right.push([pts[i][0] - p1[0] * r, pts[i][1] - p1[1] * r]);
                    } else {
                        right.push([mx, my]);
                    }
                }
            }
        }
        return right;
    };

    const liveRuns = liveTrack ? (hasTrackElements(liveTrack) ? buildTrackLayerRuns(liveTrack) : []) : null;
    const layerIds = ['top-copper', 'bottom-copper'];
    for (const layerId of layerIds) {
        if (layerId === 'top-copper' && !topVisible) continue;
        if (layerId === 'bottom-copper' && !bottomVisible) continue;
        // Both the legacy incremental render ('.pcb-routed-track') and
        // the model-driven render ('.pcb-track') are valid track sources.
        const tracks = liveRuns ? liveRuns.filter(run => run.layer === layerId).map(run => ({
            points: run.points.filter((point, index) => !index
                || point.x !== run.points[index - 1].x || point.y !== run.points[index - 1].y)
                .map(point => [point.x, point.y]), width: run.width,
            id: liveTrack.id, net: liveTrack.net,
        })) : [.../** @type {NodeListOf<SVGElement>} */ (app.getLayerGroup(layerId).querySelectorAll('.pcb-routed-track, .pcb-track'))]
            .map(track => ({ points: trackToPoints(track), width: parseFloat(track.getAttribute('stroke-width')),
                id: track.dataset?.trackId, net: track.dataset?.net }));
        if (tracks.length === 0) continue;

        for (const track of tracks) {
            const pts = track.points;
            if (pts.length < 2) continue;
            // Each rendered run carries its own stroke-width (tracks can
            // have per-segment widths), so size the halo from THIS track's
            // width rather than the global routing width.
            const sw = track.width;
            const ringR = (Number.isFinite(sw) && sw > 0 ? sw / 2 : params.trackWidth / 2) + halo;
            const poly = offsetPolygon(pts, ringR);
            if (poly.length < 3) continue;
            const el = document.createElementNS(NS, 'polygon');
            el.setAttribute('class', HALO_CLASS);
            el.setAttribute('points', poly.map(p => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(' '));
            el.setAttribute('fill', 'none');
            el.setAttribute('stroke', HALO_STROKE);
            el.setAttribute('stroke-width', String(OUTLINE_W));
            el.setAttribute('vector-effect', 'non-scaling-stroke');
            el.setAttribute('stroke-linejoin', 'round');
            el.setAttribute('pointer-events', 'none');
            // Tag with the source track's net so a footprint drag can hide
            // the halos of the nets it moves (their tracks shift mid-drag,
            // leaving the deferred halo stranded at the old position).
            const tnet = track.net;
            if (tnet) el.dataset.net = tnet;
            if (track.id) {
                el.dataset.trackId = track.id;
                if (!state.trackElements.has(track.id)) state.trackElements.set(track.id, []);
                state.trackElements.get(track.id).push(el);
            }
            overlay.appendChild(el);
        }
    }

    if (liveTrack) return;
    for (const shape of app.boardShapes || []) {
        if (shape) refreshBoardShapeClearance(app, shape);
    }
    for (const text of app.texts?.values() || []) refreshBoardShapeClearance(app, text);

    refreshViaClearance(app);
}

/** @param {PcbEditor} app */
export function computeClearanceOutlines(app, shape, clearance) {
    return typeof shape.content === 'string'
        ? pcbTextClearanceOutlines(shape, clearance)
        : boardShapeClearanceOutlines(shape, clearance);
}

/** @param {PcbEditor} app */
export function refreshBoardShapeClearance(app, shape) {
    if (isPcbPasteActive(app)) return;
    if (!areClearancesVisible(app)) return;
    const overlay = app.getLayerGroup('clearance-overlay');
    if (!overlay) return;
    const cache = overlayState(app).boardShapeClearanceCache;
    const previous = cache.get(shape.id);
    if (shouldDeferShapeClearance(app, shape)) {
        for (const element of previous?.elements || []) {
            element.parentNode?.removeChild(element);
        }
        return;
    }
    const clearance = app.getRoutingParams().clearance;
    const layer = app.existingLayerGroups().get(shape.layer);
    const visible = !!layer && layer.style.display !== 'none';
    const isText = typeof shape.content === 'string';
    const points = shape.points || (shape.kind === 'circle' || isText ? [{ x: shape.x, y: shape.y }]
        : shape.kind === 'arc' ? [shape.start, shape.end, shape.bulge] : []);
    const style = JSON.stringify([shape.kind, shape.layer, visible, clearance, shape.net, shape.radius,
        shape.lineWidth, shape.segmentWidths, shape.segmentBulges, shape.filled, shape.copperMode,
        shape.cornerRadius, shape.nodeCornerRadii,
        shape.content, shape.size, shape.strokeWidth, shape.rotation]);
    if (previous && previous.style === style && previous.artwork === shape.artwork
        && points.length && points.length === previous.points.length) {
        const dx = points[0].x - previous.points[0].x;
        const dy = points[0].y - previous.points[0].y;
        if (points.every((point, index) => Math.abs(point.x - previous.points[index].x - dx) < 1e-9
            && Math.abs(point.y - previous.points[index].y - dy) < 1e-9)) {
            for (const element of previous.elements) {
                element.setAttribute('transform', `translate(${dx} ${dy})`);
                if (element.parentNode !== overlay) overlay.appendChild(element);
            }
            return;
        }
    }
    for (const element of previous?.elements || []) {
        if (element.parentNode === overlay) overlay.removeChild(element);
    }
    const elements = [];
    if (visible) for (const outline of computeClearanceOutlines(app, shape, clearance)) {
        const element = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        element.setAttribute('class', 'debug-clearance');
        element.setAttribute('fill', 'none');
        element.setAttribute('stroke', 'rgba(255, 255, 255, 0.55)');
        element.setAttribute('stroke-width', '1');
        element.setAttribute('vector-effect', 'non-scaling-stroke');
        element.setAttribute('pointer-events', 'none');
        element.setAttribute('points', outline.map(point => `${point.x},${point.y}`).join(' '));
        element.setAttribute('data-shape-id', shape.id);
        if (shape.net) element.dataset.net = shape.net;
        overlay.appendChild(element);
        elements.push(element);
    }
    cache.set(shape.id, { style, artwork: shape.artwork,
        points: points.map(point => ({ x: point.x, y: point.y })), elements });
}

/** @param {PcbEditor} app */
export function refreshClearanceHalos(app) {
    if (areClearancesVisible(app)) showClearances(app, true);
}

/** @param {PcbEditor} app */
export function refreshTrackClearance(app, track) {
    if (areClearancesVisible(app)) showClearances(app, true, track);
}

/**
 * Refresh via halos: just this via's (and whatever shared its halo) when given,
 * otherwise every via.
 * @param {PcbEditor} app
 * @param {any} [via] - a Via, or null for every via
 */
export function refreshViaClearance(app, via = null) {
    if (!areClearancesVisible(app)) return;
    const overlay = app.getLayerGroup('clearance-overlay');
    const layer = app.getLayerGroup('vias');
    if (!overlay) return;
    const state = overlayState(app);
    const affected = new Set();
    if (via) {
        const previous = state.viaKeys.get(via.id);
        if (previous != null) {
            state.viaCache.get(previous)?.sources.delete(via.id);
            state.viaKeys.delete(via.id);
            affected.add(previous);
        }
    } else {
        for (const entry of state.viaCache.values()) entry.element?.remove();
        state.viaCache.clear();
        state.viaKeys.clear();
    }
    const register = (id, cx, cy, r, net) => {
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return;
        const key = `${cx.toFixed(4)},${cy.toFixed(4)}`;
        if (!state.viaCache.has(key)) state.viaCache.set(key, { sources: new Map() });
        const sources = state.viaCache.get(key).sources;
        const previous = sources.get(id);
        if (!previous || r > previous.r) sources.set(id, { cx, cy, r, net: net || previous?.net });
        state.viaKeys.set(id, key);
        affected.add(key);
    };
    if (layer && layer.style.display !== 'none') {
        if (via) {
            if (hasViaElements(via)) register(via.id, via.x, via.y, via.diameter / 2, via.net);
        } else for (const rendered of /** @type {NodeListOf<SVGElement>} */ (layer.querySelectorAll('circle.pcb-routed-via, circle.pcb-via, path.pcb-via'))) {
            const path = rendered.localName === 'path';
            register(rendered.dataset?.viaId || rendered,
                parseFloat(rendered.getAttribute(path ? 'data-via-x' : 'cx')),
                parseFloat(rendered.getAttribute(path ? 'data-via-y' : 'cy')),
                parseFloat(rendered.getAttribute(path ? 'data-via-radius' : 'r')), rendered.dataset?.net);
        }
    }
    const clearance = app.getRoutingParams().clearance;
    for (const key of affected) {
        const entry = state.viaCache.get(key);
        entry.element?.remove();
        if (!entry.sources.size) {
            state.viaCache.delete(key);
            continue;
        }
        // Coincident vias share the largest ring; moving one must retain any others.
        let largest = null, net = '';
        for (const source of entry.sources.values()) {
            if (!largest || source.r > largest.r) {
                largest = source;
                net = source.net || net;
            }
        }
        const element = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        element.setAttribute('cx', String(largest.cx));
        element.setAttribute('cy', String(largest.cy));
        element.setAttribute('r', String(largest.r + clearance));
        element.setAttribute('class', 'debug-clearance');
        element.setAttribute('fill', 'none');
        element.setAttribute('stroke', 'rgba(255, 255, 255, 0.55)');
        element.setAttribute('stroke-width', '1');
        element.setAttribute('vector-effect', 'non-scaling-stroke');
        element.setAttribute('pointer-events', 'none');
        if (net) element.dataset.net = net;
        overlay.appendChild(element);
        entry.element = element;
    }
}
