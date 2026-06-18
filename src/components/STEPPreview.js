/**
 * STEP file (ISO-10303-21) preview renderer.
 *
 * This is a *previewer* — it extracts face geometry from the STEP topology to
 * produce a recognisable 3D model. Curved edges (arcs, ellipses and
 * non-rational B-splines) are sampled into intermediate points, and faces on
 * curved surfaces (cylinders, spheres) are tessellated in the surface's
 * parametric (u,v) space via ear clipping rather than fan-triangulated, so
 * rounded corners, pin barrels and lead bends shade smoothly. Planar faces keep
 * the cheap single-polygon path. Rational/NURBS edges and unsupported surface
 * types fall back to a straight-chord / fan approximation.
 */
import { escapeHtml } from '../core/ui-helpers.js';

export class STEPPreview {

    // ── public API ──────────────────────────────────────────────────────

    /**
     * Detect whether text content is a STEP file.
     * @param {string} text - First ~500 chars of the file
     * @returns {boolean}
     */
    static isSTEP(text) {
        const head = text.slice(0, 500);
        return /ISO[- ]?10303[- ]?21/i.test(head) || /\bHEADER\s*;/i.test(head);
    }

    /**
     * Parse a STEP file into preview geometry with optional per-face colors.
     *
     * Walks: ADVANCED_FACE → FACE_BOUND / FACE_OUTER_BOUND → EDGE_LOOP
     *        → ORIENTED_EDGE → EDGE_CURVE → VERTEX_POINT → CARTESIAN_POINT
     *        Also attempts to extract STYLED_ITEM→SURFACE_STYLE→COLOR for face colors.
     *
     * @param {string} stepText - Full STEP file content
     * @returns {{vertices:{x:number,y:number,z:number}[], faces:number[][], faceColors?:number[][]|null}|null}
     */
    static parse(stepText) {
        const geometry = { vertices: [], faces: [], faceColors: null };

        try {
            // Flatten to a single line
            const flat = stepText.replace(/\r\n?/g, '\n').replace(/\n/g, ' ');

            // Isolate the DATA section
            const dataMatch = flat.match(/DATA\s*;(.*?)ENDSEC\s*;/i);
            if (!dataMatch) return null;

            // ── Build entity map ─────────────────────────────────────────
            const entities = {};
            for (const stmt of dataMatch[1].split(';')) {
                const t = stmt.trim();
                if (!t || t.startsWith('/*')) continue;
                const m = t.match(/^#(\d+)\s*=\s*([A-Z_][A-Z0-9_]*)\s*\(([\s\S]*)\)$/);
                if (m) entities[m[1]] = { type: m[2], raw: m[3] };
            }

            // ── Helpers ──────────────────────────────────────────────────

            /** Split top-level comma-separated args, respecting nested parens & strings */
            function splitArgs(raw) {
                const out = [];
                let cur = '', depth = 0, inStr = false;
                for (let i = 0; i < raw.length; i++) {
                    const ch = raw[i];
                    if (inStr)  { cur += ch; if (ch === "'") inStr = false; continue; }
                    if (ch === "'") { inStr = true; cur += ch; continue; }
                    if (ch === '(') { depth++; cur += ch; continue; }
                    if (ch === ')') { depth--; cur += ch; continue; }
                    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
                    cur += ch;
                }
                if (cur.trim()) out.push(cur.trim());
                return out;
            }

            function refList(s) {
                const inner = s.replace(/^\(/, '').replace(/\)$/, '').trim();
                if (!inner) return [];
                return inner.split(',')
                    .map(t => { const r = t.trim().match(/#(\d+)/); return r ? r[1] : null; })
                    .filter(Boolean);
            }

            function ref(s) { const r = s.trim().match(/#(\d+)/); return r ? r[1] : null; }

            function coords(s) {
                const inner = s.replace(/^\(/, '').replace(/\)$/, '').trim();
                const p = inner.split(',').map(v => parseFloat(v.trim()));
                return { x: p[0] || 0, y: p[1] || 0, z: p[2] || 0 };
            }

            // ── Cached lookups ───────────────────────────────────────────
            const cpCache = {};
            const vpCache = {};

            function getCartesianPoint(id) {
                if (cpCache[id] !== undefined) return cpCache[id];
                const e = entities[id];
                if (!e || e.type !== 'CARTESIAN_POINT') return (cpCache[id] = null);
                const args = splitArgs(e.raw);
                return (cpCache[id] = args.length >= 2 ? coords(args[1]) : null);
            }

            function getVertexPoint(id) {
                if (vpCache[id] !== undefined) return vpCache[id];
                const e = entities[id];
                if (!e || e.type !== 'VERTEX_POINT') return (vpCache[id] = null);
                const args = splitArgs(e.raw);
                const r = args.length >= 2 ? ref(args[1]) : null;
                return (vpCache[id] = r ? getCartesianPoint(r) : null);
            }

            // ── Curved-edge tessellation ─────────────────────────────────
            // STEP stores edges as analytic curves (arcs, ellipses, B-splines),
            // not polylines. The boundary walk below samples each curved edge
            // into intermediate points so curves render smooth instead of as a
            // single straight chord between the two end vertices. Straight lines
            // and unsupported/rational curves yield no extra points (graceful
            // fallback to the old chord behaviour).
            const vAdd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
            const vSub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
            const vScale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
            const vDot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
            const vCross = (a, b) => ({
                x: a.y * b.z - a.z * b.y,
                y: a.z * b.x - a.x * b.z,
                z: a.x * b.y - a.y * b.x,
            });
            const vLen = (a) => Math.hypot(a.x, a.y, a.z);
            const vNorm = (a) => { const l = vLen(a) || 1; return vScale(a, 1 / l); };

            function getDirectionVec(id) {
                const e = entities[id];
                if (!e || e.type !== 'DIRECTION') return null;
                const a = splitArgs(e.raw);
                return a.length >= 2 ? coords(a[1]) : null;
            }

            /**
             * Build an orthonormal frame {loc, x, y, z} from an
             * AXIS2_PLACEMENT_3D (location + local Z axis + local X ref dir).
             */
            function getPlacementFrame(id) {
                const e = entities[id];
                if (!e || e.type !== 'AXIS2_PLACEMENT_3D') return null;
                const a = splitArgs(e.raw);
                const loc = a.length >= 2 && ref(a[1]) ? getCartesianPoint(ref(a[1])) : null;
                if (!loc) return null;
                let z = a.length >= 3 && ref(a[2]) ? getDirectionVec(ref(a[2])) : null;
                let x = a.length >= 4 && ref(a[3]) ? getDirectionVec(ref(a[3])) : null;
                z = z ? vNorm(z) : { x: 0, y: 0, z: 1 };
                x = x ? vNorm(x) : { x: 1, y: 0, z: 0 };
                // Gram–Schmidt: make x orthogonal to z.
                x = vSub(x, vScale(z, vDot(x, z)));
                const xl = vLen(x);
                x = xl > 1e-9 ? vScale(x, 1 / xl) : { x: 1, y: 0, z: 0 };
                const y = vCross(z, x);
                return { loc, x, y, z };
            }

            const TWO_PI = Math.PI * 2;
            // Angular step ~2.8°/seg. KiCad's mesher uses an angular + linear
            // (chord) deflection budget; for the small-radius fillets on SMD
            // leads the angular term dominates, so a fine fixed step is what
            // makes the bends read round under smooth shading. Capped high
            // enough that a full circle still resolves cleanly.
            const ARC_STEP = Math.PI / 64;
            const ARC_MAX_SEGS = 256;
            // Chord-deflection floor: also guarantee the straight-segment sag
            // never exceeds this fraction of the radius, so tight bends viewed
            // up close stay smooth regardless of sweep angle.
            const ARC_CHORD_TOL = 0.02;      // ≤2% of radius sagitta
            const arcSegments = (absDelta, radius) => {
                let segs = Math.ceil(absDelta / ARC_STEP);
                if (radius > 0) {
                    // sagitta = r(1-cos(θ/2)) ≤ ARC_CHORD_TOL·r  ⇒  θ ≤ 2·acos(1-tol)
                    const maxTheta = 2 * Math.acos(Math.max(-1, 1 - ARC_CHORD_TOL));
                    if (maxTheta > 1e-6) segs = Math.max(segs, Math.ceil(absDelta / maxTheta));
                }
                return Math.max(1, Math.min(ARC_MAX_SEGS, segs));
            };

            /** Intermediate points (excluding both endpoints) along a CIRCLE arc. */
            function sampleCircleArc(ent, vs, ve, sweepPositive) {
                const a = splitArgs(ent.raw);
                const frame = a.length >= 2 && ref(a[1]) ? getPlacementFrame(ref(a[1])) : null;
                const radius = a.length >= 3 ? getNumericValue(a[2]) : null;
                if (!frame || !Number.isFinite(radius) || radius <= 0) return [];
                const { loc, x, y } = frame;
                const ang = (P) => { const d = vSub(P, loc); return Math.atan2(vDot(d, y), vDot(d, x)); };
                const ts = ang(vs);
                let delta = ang(ve) - ts;
                if (sweepPositive) { while (delta <= 1e-9) delta += TWO_PI; }
                else { while (delta >= -1e-9) delta -= TWO_PI; }
                if (Math.abs(delta) < 1e-6) delta = sweepPositive ? TWO_PI : -TWO_PI;
                const segs = arcSegments(Math.abs(delta), radius);
                const out = [];
                for (let i = 1; i < segs; i++) {
                    const t = ts + delta * (i / segs);
                    out.push(vAdd(loc, vAdd(vScale(x, radius * Math.cos(t)), vScale(y, radius * Math.sin(t)))));
                }
                return out;
            }

            /** Intermediate points (excluding both endpoints) along an ELLIPSE arc. */
            function sampleEllipseArc(ent, vs, ve, sweepPositive) {
                const a = splitArgs(ent.raw);
                const frame = a.length >= 2 && ref(a[1]) ? getPlacementFrame(ref(a[1])) : null;
                const r1 = a.length >= 3 ? getNumericValue(a[2]) : null;
                const r2 = a.length >= 4 ? getNumericValue(a[3]) : null;
                if (!frame || !Number.isFinite(r1) || !Number.isFinite(r2) || r1 <= 0 || r2 <= 0) return [];
                const { loc, x, y } = frame;
                const ang = (P) => { const d = vSub(P, loc); return Math.atan2(vDot(d, y) / r2, vDot(d, x) / r1); };
                const ts = ang(vs);
                let delta = ang(ve) - ts;
                if (sweepPositive) { while (delta <= 1e-9) delta += TWO_PI; }
                else { while (delta >= -1e-9) delta -= TWO_PI; }
                if (Math.abs(delta) < 1e-6) delta = sweepPositive ? TWO_PI : -TWO_PI;
                const segs = arcSegments(Math.abs(delta), Math.max(r1, r2));
                const out = [];
                for (let i = 1; i < segs; i++) {
                    const t = ts + delta * (i / segs);
                    out.push(vAdd(loc, vAdd(vScale(x, r1 * Math.cos(t)), vScale(y, r2 * Math.sin(t)))));
                }
                return out;
            }

            /** Parse a parenthesised list of numbers, e.g. "(1,2,1)" → [1,2,1]. */
            function parseNumberList(s) {
                const inner = (s || '').replace(/^\(/, '').replace(/\)$/, '');
                if (!inner.trim()) return [];
                return inner.split(',').map(t => parseFloat(t)).filter(v => Number.isFinite(v));
            }

            /** De Boor evaluation of a (non-rational) B-spline at parameter u. */
            function deBoor(p, ctrl, knots, u) {
                const n = ctrl.length - 1;
                let k = -1;
                for (let i = p; i <= n; i++) { if (u >= knots[i] && u < knots[i + 1]) { k = i; break; } }
                if (k < 0) k = n;
                const d = [];
                for (let j = 0; j <= p; j++) { const c = ctrl[k - p + j]; d.push({ x: c.x, y: c.y, z: c.z }); }
                for (let r = 1; r <= p; r++) {
                    for (let j = p; j >= r; j--) {
                        const i = k - p + j;
                        const denom = knots[i + p - r + 1] - knots[i];
                        const alpha = denom > 1e-12 ? (u - knots[i]) / denom : 0;
                        d[j] = {
                            x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
                            y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
                            z: (1 - alpha) * d[j - 1].z + alpha * d[j].z,
                        };
                    }
                }
                return d[p];
            }

            /** Intermediate points along a B_SPLINE_CURVE_WITH_KNOTS (non-rational). */
            function sampleBSpline(ent, sweepPositive) {
                // B_SPLINE_CURVE_WITH_KNOTS(name, degree, (ctrl), form, closed,
                //   self_intersect, (knot_mults), (knots), knot_spec)
                const a = splitArgs(ent.raw);
                const degree = parseInt(a[1], 10);
                const ctrl = refList(a[2]).map(r => getCartesianPoint(r)).filter(Boolean);
                if (!Number.isFinite(degree) || degree < 1 || ctrl.length < degree + 1) return [];
                const mults = parseNumberList(a[6]).map(v => Math.round(v));
                const knotsU = parseNumberList(a[7]);
                if (!mults.length || mults.length !== knotsU.length) return [];
                const knots = [];
                for (let i = 0; i < knotsU.length; i++) for (let m = 0; m < mults[i]; m++) knots.push(knotsU[i]);
                if (knots.length !== ctrl.length + degree + 1) return [];
                const u0 = knots[degree];
                const u1 = knots[knots.length - 1 - degree];
                if (!(u1 > u0)) return [];
                const segs = Math.max(6, Math.min(48, ctrl.length * 3));
                const out = [];
                for (let i = 1; i < segs; i++) {
                    const u = u0 + (u1 - u0) * (i / segs);
                    const pt = deBoor(degree, ctrl, knots, u);
                    if (pt) out.push(pt);
                }
                if (!sweepPositive) out.reverse();
                return out;
            }

            /**
             * Sample the analytic geometry of one EDGE_CURVE into intermediate
             * points (excluding endpoints), ordered from `vs` toward `ve`.
             * @param {string|null} curveId  geometry curve entity id
             * @param {{x,y,z}|null} vs  traversal start point
             * @param {{x,y,z}|null} ve  traversal end point
             * @param {boolean} sweepPositive  traversal matches the curve's
             *        natural parameter direction
             */
            function sampleEdgeCurve(curveId, vs, ve, sweepPositive) {
                if (!curveId || !vs || !ve) return [];
                const ent = entities[curveId];
                if (!ent) return [];
                switch (ent.type) {
                    case 'CIRCLE': return sampleCircleArc(ent, vs, ve, sweepPositive);
                    case 'ELLIPSE': return sampleEllipseArc(ent, vs, ve, sweepPositive);
                    case 'B_SPLINE_CURVE_WITH_KNOTS': return sampleBSpline(ent, sweepPositive);
                    default: return [];
                }
            }

            // ── Curved-surface tessellation ──────────────────────────────
            // A face on a curved surface (cylinder/sphere) has its boundary
            // densely sampled above, but fan-triangulating that boundary cuts
            // flat chords across the curvature and flat-shades as a few large
            // facets. Instead we map the boundary into the surface's parametric
            // (u,v) space and ear-clip there: for a developable cylinder this is
            // an exact "unrolled" triangulation; for a sphere it curves the
            // silhouette. Both yield many correctly-oriented strips that shade
            // smoothly. Returns the surface descriptor or null for planes.
            function getCurvedSurface(id) {
                const e = entities[id];
                if (!e) return null;
                if (e.type === 'CYLINDRICAL_SURFACE') {
                    const a = splitArgs(e.raw);
                    const frame = a.length >= 2 && ref(a[1]) ? getPlacementFrame(ref(a[1])) : null;
                    const radius = a.length >= 3 ? getNumericValue(a[2]) : null;
                    if (!frame || !Number.isFinite(radius) || radius <= 0) return null;
                    return { kind: 'cylinder', frame, radius };
                }
                if (e.type === 'SPHERICAL_SURFACE') {
                    const a = splitArgs(e.raw);
                    const frame = a.length >= 2 && ref(a[1]) ? getPlacementFrame(ref(a[1])) : null;
                    const radius = a.length >= 3 ? getNumericValue(a[2]) : null;
                    if (!frame || !Number.isFinite(radius) || radius <= 0) return null;
                    return { kind: 'sphere', frame, radius };
                }
                return null;
            }

            /** Map a 3D point to raw (u,v) for a curved surface (u = angle). */
            function surfaceUV(surf, P) {
                const { loc, x, y, z } = surf.frame;
                const d = vSub(P, loc);
                const du = vDot(d, x), dv = vDot(d, y), dz = vDot(d, z);
                if (surf.kind === 'cylinder') {
                    return { u: Math.atan2(dv, du), v: dz };
                }
                // sphere: u = longitude, v = latitude
                return { u: Math.atan2(dv, du), v: Math.atan2(dz, Math.hypot(du, dv)) };
            }

            /**
             * Triangulate a closed loop of vertex indices that lies on a curved
             * surface. Maps to (u,v), unwraps the angular coordinate along the
             * loop so it stays continuous across the ±π seam, then ear-clips.
             * @returns {number[][]} triangles as [i,j,k] vertex indices
             */
            function triangulateCurvedLoop(vertIdx, surf) {
                const n = vertIdx.length;
                if (n < 3) return [];
                const uv = [];
                let prevU = null;
                for (let i = 0; i < n; i++) {
                    const P = geometry.vertices[vertIdx[i]];
                    let { u, v } = surfaceUV(surf, P);
                    if (prevU !== null) {            // unwrap to nearest branch
                        while (u - prevU > Math.PI) u -= TWO_PI;
                        while (u - prevU < -Math.PI) u += TWO_PI;
                    }
                    prevU = u;
                    uv.push({ u, v });
                }
                const tris = earClip2D(uv);
                return tris.map(([a, b, c]) => [vertIdx[a], vertIdx[b], vertIdx[c]]);
            }

            /** Ear-clipping triangulation of a simple polygon in (u,v). */
            function earClip2D(pts) {
                const n = pts.length;
                if (n < 3) return [];
                const V = [...Array(n).keys()];
                // Orient CCW.
                let area = 0;
                for (let i = 0; i < n; i++) {
                    const a = pts[i], b = pts[(i + 1) % n];
                    area += a.u * b.v - b.u * a.v;
                }
                if (area < 0) V.reverse();
                const cross = (o, a, b) =>
                    (pts[a].u - pts[o].u) * (pts[b].v - pts[o].v) -
                    (pts[a].v - pts[o].v) * (pts[b].u - pts[o].u);
                const inTri = (p, a, b, c) => {
                    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
                    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
                    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
                    return !(hasNeg && hasPos);
                };
                const tris = [];
                let guard = 0;
                while (V.length > 3 && guard++ < 5000) {
                    let clipped = false;
                    for (let i = 0; i < V.length; i++) {
                        const a = V[(i - 1 + V.length) % V.length];
                        const b = V[i];
                        const c = V[(i + 1) % V.length];
                        if (cross(a, b, c) <= 0) continue;          // reflex/collinear
                        let ok = true;
                        for (let j = 0; j < V.length; j++) {
                            const p = V[j];
                            if (p === a || p === b || p === c) continue;
                            if (inTri(p, a, b, c)) { ok = false; break; }
                        }
                        if (!ok) continue;
                        tris.push([a, b, c]);
                        V.splice(i, 1);
                        clipped = true;
                        break;
                    }
                    if (!clipped) break;                            // degenerate; bail
                }
                if (V.length === 3) tris.push([V[0], V[1], V[2]]);
                return tris;
            }

            // Vertex deduplication
            const vertexMap = new Map();
            function vertexIdx(pt) {
                if (!pt) return -1;
                const key = `${pt.x.toFixed(6)},${pt.y.toFixed(6)},${pt.z.toFixed(6)}`;
                if (vertexMap.has(key)) return vertexMap.get(key);
                const idx = geometry.vertices.length;
                geometry.vertices.push(pt);
                vertexMap.set(key, idx);
                return idx;
            }

            // ── Build entity references graph ────────────────────────────
            const refsById = new Map();

            function collectRefs(raw) {
                const refs = [];
                const re = /#(\d+)/g;
                let m;
                while ((m = re.exec(raw)) !== null) refs.push(m[1]);
                return refs;
            }

            for (const [id, ent] of Object.entries(entities)) {
                const refs = collectRefs(ent.raw);
                refsById.set(id, refs);
            }

            // ── STEP style/color resolver (AP214/AP242 variants) ────────
            const predefinedColors = {
                black: [0, 0, 0],
                white: [255, 255, 255],
                red: [255, 0, 0],
                green: [0, 128, 0],
                blue: [0, 0, 255],
                yellow: [255, 255, 0],
                cyan: [0, 255, 255],
                magenta: [255, 0, 255],
                grey: [128, 128, 128],
                gray: [128, 128, 128]
            };

            const numericValueCache = new Map();
            const colorValueCache = new Map();

            function toRgb255(r, g, b) {
                if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;

                const max = Math.max(r, g, b);
                // STEP commonly uses normalized 0..1, but some sources emit 0..255 values.
                if (max > 1.000001) {
                    return [
                        Math.max(0, Math.min(255, Math.round(r))),
                        Math.max(0, Math.min(255, Math.round(g))),
                        Math.max(0, Math.min(255, Math.round(b)))
                    ];
                }

                return [
                    Math.max(0, Math.min(255, Math.round(r * 255))),
                    Math.max(0, Math.min(255, Math.round(g * 255))),
                    Math.max(0, Math.min(255, Math.round(b * 255)))
                ];
            }

            function getNumericValue(token, seen = new Set()) {
                const trimmed = (token || '').trim();
                if (!trimmed) return null;
                if (trimmed[0] !== '#') {
                    const v = parseFloat(trimmed);
                    return Number.isFinite(v) ? v : null;
                }
                const rid = trimmed.slice(1);
                if (!rid || seen.has(rid)) return null;
                if (numericValueCache.has(rid)) return numericValueCache.get(rid);
                seen.add(rid);

                const ent = entities[rid];
                if (!ent) {
                    numericValueCache.set(rid, null);
                    return null;
                }

                let value = null;
                if (ent.type === 'REAL' || ent.type === 'LENGTH_MEASURE' || ent.type === 'POSITIVE_LENGTH_MEASURE') {
                    const m = ent.raw.match(/([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/);
                    value = m ? parseFloat(m[1]) : null;
                } else {
                    for (const r of (refsById.get(rid) || [])) {
                        const nested = getNumericValue(`#${r}`, seen);
                        if (nested !== null) {
                            value = nested;
                            break;
                        }
                    }
                }

                numericValueCache.set(rid, value);
                return value;
            }

            function getColorFromEntity(id, seen = new Set()) {
                if (!id || seen.has(id)) return null;
                if (colorValueCache.has(id)) return colorValueCache.get(id);
                seen.add(id);

                const ent = entities[id];
                if (!ent) {
                    colorValueCache.set(id, null);
                    return null;
                }

                let color = null;
                const args = splitArgs(ent.raw);

                if (ent.type === 'COLOUR_RGB') {
                    if (args.length >= 4) {
                        const r = getNumericValue(args[1]);
                        const g = getNumericValue(args[2]);
                        const b = getNumericValue(args[3]);
                        color = toRgb255(r, g, b);
                    }
                } else if (ent.type === 'DRAUGHTING_PRE_DEFINED_COLOUR' || ent.type === 'PRE_DEFINED_COLOUR') {
                    const m = ent.raw.match(/'([^']+)'/);
                    if (m) color = predefinedColors[m[1].toLowerCase()] || null;
                } else if (ent.type.startsWith('CURVE_STYLE') || ent.type === 'POINT_STYLE') {
                    // Edge / point styles describe outline colours, not surface
                    // fill — never let them tint a face. Skip this branch.
                    color = null;
                } else {
                    // Generic traversal: many STEP style entities eventually reference COLOUR_RGB.
                    for (const child of (refsById.get(id) || [])) {
                        color = getColorFromEntity(child, seen);
                        if (color) break;
                    }
                }

                colorValueCache.set(id, color || null);
                return color || null;
            }

            function getFaceTargetsFromItem(itemId) {
                if (!itemId) return [];
                if (entities[itemId]?.type === 'ADVANCED_FACE') return [itemId];

                const out = new Set();
                const stack = [itemId];
                const seen = new Set();

                while (stack.length) {
                    const cur = stack.pop();
                    if (!cur || seen.has(cur)) continue;
                    seen.add(cur);

                    const ce = entities[cur];
                    if (!ce) continue;
                    if (ce.type === 'ADVANCED_FACE') {
                        out.add(cur);
                        continue;
                    }

                    for (const child of (refsById.get(cur) || [])) {
                        stack.push(child);
                    }
                }

                return Array.from(out);
            }

            const directFaceColor = new Map();
            const inheritedFaceColor = new Map();

            for (const [id, ent] of Object.entries(entities)) {
                if (ent.type !== 'STYLED_ITEM' && ent.type !== 'OVER_RIDING_STYLED_ITEM') continue;

                // STYLED_ITEM            (name, styles, item)
                // OVER_RIDING_STYLED_ITEM(name, styles, item, over_ridden_style)
                // In both cases the styled target is arg index 2 and the style
                // set is arg index 1; the trailing over_ridden_style must NOT be
                // treated as the target.
                const args = splitArgs(ent.raw);
                if (args.length < 3) continue;

                const itemRef = ref(args[2]);
                // args[1] is a parenthesised list of style refs; collect them all.
                const directStyleRefs = (args[1].match(/#(\d+)/g) || []).map(s => s.slice(1));
                if (!itemRef || directStyleRefs.length === 0) continue;

                let color = null;
                for (const sid of directStyleRefs) {
                    color = getColorFromEntity(sid);
                    if (color) break;
                }
                if (!color) continue;

                const faces = getFaceTargetsFromItem(itemRef);
                if (faces.length === 0) continue;

                const isDirect = entities[itemRef]?.type === 'ADVANCED_FACE';
                for (const fid of faces) {
                    if (isDirect) {
                        directFaceColor.set(fid, color);
                    } else if (!directFaceColor.has(fid) && !inheritedFaceColor.has(fid)) {
                        inheritedFaceColor.set(fid, color);
                    }
                }
            }

            // ── Walk ADVANCED_FACE topology and emit polygonal loops ─────
            const faceColors = [];
            let anyResolvedFaceColor = false;
            let anyDirectResolvedFaceColor = false;

            // Map each ADVANCED_FACE to the shell (solid) that owns it, and the
            // size of each shell. KiCad builds the body as one large shell and
            // each pad / antenna trace as its own small shell. When a pad sits
            // flush on the body, the body carries a redundant sub-face matching
            // the pad outline — coincident with the pad face and the true cause
            // of the "shimmer". Shell membership lets us drop the right (body)
            // face without any colour guessing.
            const faceShell = new Map();   // ADVANCED_FACE id → shell id
            const shellSize = new Map();   // shell id → face count
            for (const [sid, sEnt] of Object.entries(entities)) {
                if (sEnt.type !== 'CLOSED_SHELL' && sEnt.type !== 'OPEN_SHELL') continue;
                let count = 0;
                for (const fr of (refsById.get(sid) || [])) {
                    if (entities[fr]?.type === 'ADVANCED_FACE') {
                        if (!faceShell.has(fr)) faceShell.set(fr, sid);
                        count++;
                    }
                }
                shellSize.set(sid, count);
            }

            // Parallel to geometry.faces: the source ADVANCED_FACE id of each
            // emitted loop, so coincident faces can be resolved by shell size.
            const faceSource = [];

            for (const [faceId, ent] of Object.entries(entities)) {
                if (ent.type !== 'ADVANCED_FACE') continue;

                const args = splitArgs(ent.raw);
                if (args.length < 2) continue;

                // ADVANCED_FACE(name, bounds, face_geometry, same_sense): the
                // surface is arg index 2. Curved surfaces get parametric
                // triangulation; planes keep the cheap single-polygon path.
                const curvedSurface = args.length >= 3 ? getCurvedSurface(ref(args[2])) : null;

                const directResolved = directFaceColor.get(faceId) || null;
                const inheritedResolved = inheritedFaceColor.get(faceId) || null;
                const resolved = directResolved || inheritedResolved;

                const emitFace = (verts) => {
                    geometry.faces.push(verts);
                    faceSource.push(faceId);
                    if (directResolved) anyDirectResolvedFaceColor = true;
                    if (resolved) anyResolvedFaceColor = true;
                    faceColors.push(resolved);
                };

                for (const bId of refList(args[1])) {
                    const bound = entities[bId];
                    if (!bound || (bound.type !== 'FACE_BOUND' && bound.type !== 'FACE_OUTER_BOUND')) continue;

                    const bArgs = splitArgs(bound.raw);
                    if (bArgs.length < 2) continue;
                    const edgeLoop = entities[ref(bArgs[1])];
                    if (!edgeLoop || edgeLoop.type !== 'EDGE_LOOP') continue;

                    const elArgs = splitArgs(edgeLoop.raw);
                    if (elArgs.length < 2) continue;

                    const faceVerts = [];
                    const pushVertIdx = (idx) => {
                        if (idx >= 0 && (faceVerts.length === 0 || faceVerts[faceVerts.length - 1] !== idx)) {
                            faceVerts.push(idx);
                        }
                    };
                    for (const oeId of refList(elArgs[1])) {
                        const oe = entities[oeId];
                        if (!oe || oe.type !== 'ORIENTED_EDGE') continue;
                        const oeArgs = splitArgs(oe.raw);
                        if (oeArgs.length < 5) continue;

                        const ec = entities[ref(oeArgs[3])];
                        if (!ec || ec.type !== 'EDGE_CURVE') continue;
                        const ecArgs = splitArgs(ec.raw);
                        if (ecArgs.length < 3) continue;

                        const orientation = oeArgs[4].trim();              // .T./.F.
                        const startRef = orientation === '.T.' ? ref(ecArgs[1]) : ref(ecArgs[2]);
                        const endRef   = orientation === '.T.' ? ref(ecArgs[2]) : ref(ecArgs[1]);
                        const vsPt = startRef ? getVertexPoint(startRef) : null;
                        const vePt = endRef ? getVertexPoint(endRef) : null;

                        // Loop-order start vertex of this edge.
                        pushVertIdx(vertexIdx(vsPt));

                        // Sample the analytic edge geometry into intermediate
                        // points so curved boundaries render smooth. The
                        // traversal matches the curve's natural parameter
                        // direction when the oriented-edge orientation equals the
                        // edge's same_sense flag.
                        if (ecArgs.length >= 5) {
                            const sameSense = ecArgs[4].trim();
                            const sweepPositive = orientation === sameSense;
                            for (const pt of sampleEdgeCurve(ref(ecArgs[3]), vsPt, vePt, sweepPositive)) {
                                pushVertIdx(vertexIdx(pt));
                            }
                        }
                    }

                    // Drop a trailing vertex that duplicates the loop start so
                    // fan triangulation doesn't emit a degenerate triangle.
                    if (faceVerts.length > 1 && faceVerts[0] === faceVerts[faceVerts.length - 1]) {
                        faceVerts.pop();
                    }
                    if (faceVerts.length < 3) continue;

                    if (curvedSurface) {
                        // Parametric triangulation: emit each strip triangle as
                        // its own face (shares colour + source id, so body-face
                        // tagging and coincident-dedup still work per source).
                        const tris = triangulateCurvedLoop(faceVerts, curvedSurface);
                        if (tris.length) {
                            for (const t of tris) emitFace(t);
                            continue;
                        }
                        // Fall through to polygon if triangulation failed.
                    }
                    emitFace(faceVerts);
                }
            }

            if (geometry.vertices.length > 0) {
                if (anyResolvedFaceColor && faceColors.length === geometry.faces.length) {
                    const fallback = [120, 120, 120];
                    const normalized = faceColors.map(c => c || fallback);

                    const uniq = new Set(normalized.map(c => `${c[0]},${c[1]},${c[2]}`));
                    const first = normalized[0] || fallback;
                    const isNearWhite = first[0] >= 245 && first[1] >= 245 && first[2] >= 245;
                    const looksLikeGlobalWhiteWash = !anyDirectResolvedFaceColor && uniq.size === 1 && isNearWhite;

                    if (!looksLikeGlobalWhiteWash) {
                        geometry.faceColors = normalized;
                        STEPPreview._tagCoplanarBodyFaces(geometry, faceSource, faceShell, shellSize);
                    }
                }
                return geometry;
            }
            return null;
        } catch (error) {
            console.error('Error parsing STEP:', error);
            return null;
        }
    }

    /**
     * KiCad STEP models build the body as one large shell (solid) and each pad,
     * castellation or antenna trace as its own small shell sitting on the body.
     * Where a detail rests on the body, the body shell carries a face in the
     * *same plane* that overlaps the detail's face — two coplanar surfaces
     * (body colour vs copper colour) at the same depth. They z-fight ("shimmer")
     * every frame because no depth-buffer precision can order coplanar geometry,
     * and the amount of flicker varies with how much of the body face a given
     * detail covers (hence some pads shimmer only in one corner).
     *
     * We resolve this exactly the way KiCad's own renderer does: a depth-buffer
     * polygon offset. KiCad draws the board body, then re-draws the plated copper
     * as a *separate* pass with `glPolygonOffset` so the copper always wins the
     * depth test while staying geometrically flush. We reproduce that by tagging
     * every body face (the largest shell) on `geometry.bodyFaces`; downstream the
     * renderer puts the body in its own draw group and shades it through a
     * `polygonOffset` material. Nothing is moved, so pads stay perfectly flush
     * and the fix is resolution-independent (the offset adapts with the depth
     * slope at any zoom) — no fragile world-space epsilon.
     *
     * One cheap geometric cleanup still helps: many details share an *identical*
     * vertex set with a hidden body sub-face (internal interfaces, pad bottoms).
     * We drop those exact duplicates first — keeping the smallest-shell copy — to
     * cut overdraw and remove same-depth twins outright.
     *
     * @param {{vertices:{x:number,y:number,z:number}[], faces:number[][], faceColors:number[][], bodyFaces?:boolean[]}} geometry
     * @param {string[]} faceSource  source ADVANCED_FACE id per emitted face
     * @param {Map<string,string>} faceShell  ADVANCED_FACE id → shell id
     * @param {Map<string,number>} shellSize  shell id → face count
     */
    static _tagCoplanarBodyFaces(geometry, faceSource, faceShell, shellSize) {
        let { faces, faceColors } = geometry;
        if (!faceColors || faceColors.length !== faces.length) return;
        if (!faceSource || faceSource.length !== faces.length) return;

        // Identify the body shell (the largest).
        let bodyShell = null, bodyMax = -1;
        for (const [s, n] of shellSize) if (n > bodyMax) { bodyMax = n; bodyShell = s; }
        const sizeOf = (i) => shellSize.get(faceShell.get(faceSource[i])) ?? Infinity;

        // ── Drop exact-coincident faces ──────────────────────────────────
        // Many details (pad bottoms, internal interfaces) share an *identical*
        // vertex set with a body sub-face. Keep the one from the smallest shell
        // (the detail) and drop the rest, so the hidden body twin is gone.
        const groups = new Map();
        for (let i = 0; i < faces.length; i++) {
            if (faces[i].length < 3) continue;
            const k = [...faces[i]].sort((a, b) => a - b).join(',');
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(i);
        }
        const drop = new Set();
        for (const idxs of groups.values()) {
            if (idxs.length < 2) continue;
            let keep = idxs[0];
            for (const i of idxs) if (sizeOf(i) < sizeOf(keep)) keep = i;
            for (const i of idxs) if (i !== keep) drop.add(i);
        }
        if (drop.size > 0) {
            const nf = [], nc = [], ns = [];
            for (let i = 0; i < faces.length; i++) {
                if (drop.has(i)) continue;
                nf.push(faces[i]); nc.push(faceColors[i]); ns.push(faceSource[i]);
            }
            faces = nf; faceColors = nc; faceSource = ns;
            geometry.faces = faces; geometry.faceColors = faceColors;
        }

        // ── Tag body faces for the depth-offset draw pass ────────────────
        // The body top/bottom is one large polygon while details are many small
        // ones, so they overlap by *area* without sharing a vertex set (the exact
        // dedup above can't catch those). Rather than move any geometry, mark
        // every body face; the renderer draws these through a polygon-offset
        // material so the coincident detail wins the depth test (KiCad's
        // approach), keeping the surfaces flush at any zoom.
        geometry.bodyFaces = faces.map((_, i) => faceShell.get(faceSource[i]) === bodyShell);
    }

    // ── Projection & rendering (self-contained for preview) ─────────────

    /**
     * Project a 3D point to 2D isometric coordinates.
     */
    static _project(v, scale) {
        const a = Math.PI / 6;
        return {
            x: (v.x - v.z) * Math.cos(a) * scale,
            y: (v.x + v.z) * Math.sin(a) * scale - v.y * scale
        };
    }

    /**
     * Render parsed geometry to an SVG string.
     * @param {{vertices:{x:number,y:number,z:number}[], faces:number[][]}} geometry
     * @param {object} [options]
     * @returns {string} SVG markup
     */
    static renderToSVG(geometry, options = {}) {
        const {
            width = 200, height = 200,
            lineColor = '#444444', lineWidth = 0.8,
            fillColor = '#666666',
            strokeOpacity = 0.9, fillOpacity = 0.7
        } = options;

        if (!geometry?.vertices?.length) {
            return '<div style="color:var(--text-muted);text-align:center;padding:20px">No 3D data</div>';
        }

        // Auto-scale
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const v of geometry.vertices) {
            const p = this._project(v, 1);
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }
        const maxDim = Math.max(maxX - minX, maxY - minY);
        const scale = maxDim > 0 ? (Math.min(width, height) * 0.8) / maxDim : 1;

        // Recompute bounds at final scale
        minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
        for (const v of geometry.vertices) {
            const p = this._project(v, scale);
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }

        const pad = 10;
        const vb = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
        let svg = `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">`;

        // Depth-sort faces (back-to-front)
        const sorted = geometry.faces
            .map(face => {
                let z = 0;
                for (const i of face) if (i < geometry.vertices.length) z += geometry.vertices[i].z;
                return { face, depth: z / face.length };
            })
            .sort((a, b) => a.depth - b.depth);

        for (const { face } of sorted) {
            const pts = face
                .filter(i => i < geometry.vertices.length)
                .map(i => { const p = this._project(geometry.vertices[i], scale); return `${p.x},${p.y}`; })
                .join(' ');
            if (pts) {
                svg += `<polygon points="${pts}" fill="${fillColor}" fill-opacity="${fillOpacity}" stroke="${lineColor}" stroke-width="${lineWidth}" stroke-opacity="${strokeOpacity}"/>`;
            }
        }

        svg += '</svg>';
        return svg;
    }

    /**
     * Fetch a STEP file via URL and render a preview SVG.
     * @param {string} url
     * @param {object} [options] - Rendering options + optional `proxyUrl`
     * @returns {Promise<string>} SVG markup or error HTML
     */
    static async fetchAndRender(url, options = {}) {
        try {
            const fetchUrl = options.proxyUrl
                ? `${options.proxyUrl}${encodeURIComponent(url)}`
                : url;
            const res = await fetch(fetchUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const text = await res.text();
            const geometry = this.parse(text);

            if (!geometry?.vertices?.length) {
                return '<div style="color:var(--text-muted);text-align:center;padding:20px">No geometry found</div>';
            }
            return this.renderToSVG(geometry, options);
        } catch (error) {
            console.error('Error fetching/rendering STEP:', error);
            return `<div style="color:var(--accent-color);text-align:center;padding:20px;font-size:12px">3D load error: ${escapeHtml(error.message)}</div>`;
        }
    }
}
