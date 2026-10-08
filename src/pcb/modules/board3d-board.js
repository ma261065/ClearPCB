/**
 * The bare board in 3D: its outline, drilled and plated holes, cut-outs and the
 * substrate slab with its edges.
 * Split from board3d.js; the viewer itself is board3d.js.
 */
import earcut from '../../../assets/vendor/earcut.module.js';
import { isClipperReady, getClipper } from './copper-fill-geom.js';
import { emptyMesh, appendMesh } from './board3d-mesh-ops.js';
/** @typedef {import('../../shared/3d/model-rendering.js').ModelMesh} ModelMesh */
/** @typedef {{x:number,y:number}} PointXY */
/** @typedef {{x:number,z:number}} PointXZ */
/** @typedef {{x:number,z:number,r:number}} CircleBore */
/** @typedef {{x:number,z:number,r:number,plated?:boolean,boardShape?:boolean,ring?:PointXZ[]}} Bore */
/** @typedef {{ring:PointXY[], circle:CircleBore|null}} TriangulatedBore */
/** @typedef {{outer:PointXZ[], holes:PointXZ[][]}} ExPolygonXZ */

/* ───────────────────────────── mesh builders ────────────────────────────── */

/**
 * Sample a rounded-rectangle outline into a closed point list (XZ plane).
 * @param {number} x0 @param {number} z0 left/top (mm)
 * @param {number} w @param {number} h size (mm)
 * @param {number} r corner radius (mm)
 * @returns {Array<{x:number,z:number}>}
 */
export function roundedRectOutline(x0, z0, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r <= 0) {
        return [
            { x: x0, z: z0 },
            { x: x0 + w, z: z0 },
            { x: x0 + w, z: z0 + h },
            { x: x0, z: z0 + h },
        ];
    }
    const seg = 24; // points per corner arc
    const pts = [];
    const corners = [
        { cx: x0 + w - r, cz: z0 + r, a0: -Math.PI / 2, a1: 0 },        // TR
        { cx: x0 + w - r, cz: z0 + h - r, a0: 0, a1: Math.PI / 2 },     // BR
        { cx: x0 + r, cz: z0 + h - r, a0: Math.PI / 2, a1: Math.PI },   // BL
        { cx: x0 + r, cz: z0 + r, a0: Math.PI, a1: 3 * Math.PI / 2 },   // TL
    ];
    for (const c of corners) {
        for (let i = 0; i <= seg; i++) {
            const a = c.a0 + (c.a1 - c.a0) * (i / seg);
            pts.push({ x: c.cx + r * Math.cos(a), z: c.cz + r * Math.sin(a) });
        }
    }
    return pts;
}

/**
 * Build an extruded prism mesh from a closed outline, between y=yBottom and
 * y=yTop. Returns an object suitable for the renderer.
 * @param {Array<{x:number,z:number}>} outline
 * @param {number} yBottom @param {number} yTop
 * @param {number[]} color @param {number[]} [edgeColor]
 * @returns {ModelMesh}
 */
export function extrudePrism(outline, yBottom, yTop, color, edgeColor) {
    /** @type {ModelMesh['verts']} */
    const verts = [];
    const n = outline.length;
    for (const p of outline) verts.push({ x: p.x, y: yTop, z: p.z });     // 0..n-1 top
    for (const p of outline) verts.push({ x: p.x, y: yBottom, z: p.z });  // n..2n-1 bottom

    /** @type {ModelMesh['faces']} */
    const faces = [];
    // Top face (outline order)
    faces.push({ idx: outline.map((_, i) => i), color });
    // Bottom face (reversed)
    faces.push({ idx: outline.map((_, i) => n + (n - 1 - i)), color });
    // Side quads
    const side = edgeColor || color;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push({ idx: [i, j, n + j, n + i], color: side });
    }
    return { verts, faces };
}

/* ───────────────── polygon-with-holes triangulation (board bores) ──────── */
// Used to bore drilled holes through the board slab so light reads through
// plated/mounting holes. Triangulation is delegated to the vendored earcut
// library (robust to many disjoint holes); a naive hand-rolled bridge+earclip
// here produced self-intersections and left see-through gaps. Works in the
// board plane (x, y) where y carries the world Z coordinate.

/**
 * Triangulate a simple outline with polygonal holes punched out, via earcut.
 * Holes must be disjoint and inside the outline (callers merge overlaps first).
 * @param {Array<{x:number,y:number}>} outerIn  outline in (x,y)
 * @param {Array<Array<{x:number,y:number}>>} holesIn  hole rings
 * @returns {{pts: Array<{x:number,y:number}>, tris: number[][]}}
 */
export function triangulateWithHoles(outerIn, holesIn) {
    const data = [];
    const pts = [];
    for (const p of outerIn) { data.push(p.x, p.y); pts.push({ x: p.x, y: p.y }); }
    const holeIndices = [];
    for (const h of holesIn) {
        holeIndices.push(data.length / 2);
        for (const p of h) { data.push(p.x, p.y); pts.push({ x: p.x, y: p.y }); }
    }
    const idx = earcut(data, holeIndices, 2);
    const tris = [];
    for (let i = 0; i < idx.length; i += 3) tris.push([idx[i], idx[i + 1], idx[i + 2]]);
    return { pts, tris };
}

/** Vertical cylinder wall (no end caps) — lines a bored hole. */
/**
 * @param {number} cx @param {number} cz @param {number} r
 * @param {number} yBottom @param {number} yTop
 * @param {number[]} color
 * @param {number} [seg]
 * @returns {ModelMesh}
 */
export function cylinderWallMesh(cx, cz, r, yBottom, yTop, color, seg = 16) {
    /** @type {ModelMesh['verts']} */
    const verts = [];
    /** @type {ModelMesh['faces']} */
    const faces = [];
    for (let i = 0; i < seg; i++) {
        const ang = (i / seg) * Math.PI * 2;
        const c = Math.cos(ang), s = Math.sin(ang);
        verts.push({ x: cx + r * c, y: yTop, z: cz + r * s });
        verts.push({ x: cx + r * c, y: yBottom, z: cz + r * s });
    }
    for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        faces.push({ idx: [i * 2, i * 2 + 1, j * 2 + 1, j * 2], color });
    }
    return { verts, faces };
}

/**
 * Merge overlapping / touching / coincident bores into single circles so the
 * hole triangulator only ever sees disjoint, well-separated holes. Without
 * this, two circles that overlap or near-coincide (e.g. a pad drill plus a
 * HOLE shape at the same spot, or closely-spaced pads) make the bridged
 * polygon self-intersect and the ear-clipper leaves a gap in the board face —
 * which reads as see-through holes in the slab. Disjoint holes (normal pad
 * pitch) are left untouched.
 * @param {Array<{x:number,z:number,r:number}>} holes
 * @param {number} margin minimum clear gap to keep between bores (mm)
 * @returns {Array<{x:number,z:number,r:number}>}
 */
function mergeOverlappingHoles(holes, margin = 0.1) {
    const list = holes.map((h) => ({ x: h.x, z: h.z, r: h.r }));
    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i < list.length && !merged; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i], b = list[j];
                const d = Math.hypot(a.x - b.x, a.z - b.z);
                if (d >= a.r + b.r + margin) continue; // disjoint → keep both
                let nx, nz, nr;
                if (d + Math.min(a.r, b.r) <= Math.max(a.r, b.r)) {
                    // one bore contains the other → keep the larger
                    const big = a.r >= b.r ? a : b;
                    nx = big.x; nz = big.z; nr = big.r;
                } else {
                    // smallest circle enclosing both
                    nr = (d + a.r + b.r) / 2;
                    const t = d > 1e-9 ? (nr - a.r) / d : 0;
                    nx = a.x + (b.x - a.x) * t;
                    nz = a.z + (b.z - a.z) * t;
                }
                list.splice(j, 1);
                list[i] = { x: nx, z: nz, r: nr };
                merged = true;
                break;
            }
        }
    }
    return list;
}

/** Sample a circle into a CCW polygon ring in the (x, y=z) plane. */
/** @param {number} cx @param {number} cz @param {number} r @param {number} seg @returns {PointXY[]} */
export function circleRing(cx, cz, r, seg) {
    /** @type {PointXY[]} */
    const ring = [];
    for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        ring.push({ x: cx + r * Math.cos(a), y: cz + r * Math.sin(a) });
    }
    return ring;
}

/** Union solid bore rings so Earcut only receives disjoint interior holes. */
/** @param {PointXY[][]} rings @returns {PointXY[][]|null} */
export function unionBoreRings(rings) {
    if (!isClipperReady() || !rings.length) return null;
    const C = /** @type {any} */ (getClipper());
    const scale = 10000;
    const paths = rings
        .filter((ring) => ring.length >= 3)
        .map((ring) => ring.map((point) => ({ X: Math.round(point.x * scale), Y: Math.round(point.y * scale) })));
    if (!paths.length) return [];
    const clip = new C.Clipper();
    clip.AddPaths(paths, C.PolyType.ptSubject, true);
    const tree = new C.PolyTree();
    clip.Execute(C.ClipType.ctUnion, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    const polygons = /** @type {Array<{outer:Array<{X:number,Y:number}>}>} */ (C.JS.PolyTreeToExPolygons(tree));
    return polygons
        .map((polygon) => polygon.outer.map((point) => ({ x: point.X / scale, y: point.Y / scale })))
        .filter((ring) => ring.length >= 3);
}

/**
 * Sample a stadium/capsule bore (two cap-centres + radius) into a CCW polygon
 * ring in the (x, y=z) plane — the slot equivalent of {@link circleRing}.
 * @param {number} x1 @param {number} z1 first cap centre (world x, z)
 * @param {number} x2 @param {number} z2 second cap centre (world x, z)
 * @param {number} r bore radius @param {number} capSeg segments per semicircle
 * @returns {Array<{x:number,y:number}>}
 */
export function capsuleRing(x1, z1, x2, z2, r, capSeg = 10) {
    const base = Math.atan2(z2 - z1, x2 - x1);
    const ring = [];
    for (let i = 0; i <= capSeg; i++) {
        const a = base - Math.PI / 2 + Math.PI * (i / capSeg);
        ring.push({ x: x2 + r * Math.cos(a), y: z2 + r * Math.sin(a) });
    }
    for (let i = 0; i <= capSeg; i++) {
        const a = base + Math.PI / 2 + Math.PI * (i / capSeg);
        ring.push({ x: x1 + r * Math.cos(a), y: z1 + r * Math.sin(a) });
    }
    return ring;
}

/**
 * Partition bores into connected clusters where each member overlaps or
 * touches at least one other (union-find over circle intersection). Disjoint
 * bores fall out as singleton clusters.
 * @param {Array<{x:number,z:number,r:number}>} holes
 * @param {number} margin treat bores within this clear gap as touching (mm)
 * @returns {Array<Array<{x:number,z:number,r:number}>>}
 */
function clusterOverlappingHoles(holes, margin = 0.1) {
    const list = holes.map((h) => ({ x: h.x, z: h.z, r: h.r }));
    const parent = list.map((_, i) => i);
    /** @param {number} i */
    const find = (i) => { while (parent[i] !== i) { parent[i] = /** @type {number} */ (parent[parent[i]]); i = parent[i]; } return i; };
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j];
            const d = Math.hypot(a.x - b.x, a.z - b.z);
            if (d < a.r + b.r + margin) parent[find(i)] = find(j);
        }
    }
    /** @type {Map<number, CircleBore[]>} */
    const groups = new Map();
    for (let i = 0; i < list.length; i++) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        /** @type {CircleBore[]} */ (groups.get(root)).push(/** @type {CircleBore} */ (list[i]));
    }
    return [...groups.values()];
}

/** True if (px,pz) lies strictly inside any circle other than index `exclude`. */
/** @param {number} px @param {number} pz @param {CircleBore[]} circles @param {number} exclude */
function pointInsideOtherCircle(px, pz, circles, exclude) {
    for (let j = 0; j < circles.length; j++) {
        if (j === exclude) continue;
        const o = circles[j];
        if (Math.hypot(px - o.x, pz - o.z) < o.r - 1e-6) return true;
    }
    return false;
}

/**
 * Trace the outer boundary of a connected cluster of overlapping circles as a
 * single polygon ring. Each circle contributes the arcs of its rim that lie
 * outside every other circle; those arcs are tessellated and stitched together
 * at the circle-circle intersection points. Two overlapping bores thus read as
 * a clean figure-8 / peanut opening that earcut can punch without slivers.
 * @param {Array<{x:number,z:number,r:number}>} circles
 * @param {number} seg points per full circle
 * @returns {Array<{x:number,y:number}>|null}
 */
function circleUnionRing(circles, seg) {
    const EPS = 1e-9;
    /** @type {PointXY[][]} */
    const arcs = [];
    for (let i = 0; i < circles.length; i++) {
        const c = circles[i];
        const cuts = [];
        for (let j = 0; j < circles.length; j++) {
            if (j === i) continue;
            const o = circles[j];
            const d = Math.hypot(o.x - c.x, o.z - c.z);
            if (d <= EPS) continue;
            if (d >= c.r + o.r) continue;           // disjoint
            if (d <= Math.abs(c.r - o.r)) continue; // one contains the other
            const a = (c.r * c.r - o.r * o.r + d * d) / (2 * d);
            const base = Math.atan2(o.z - c.z, o.x - c.x);
            const delta = Math.acos(Math.max(-1, Math.min(1, a / c.r)));
            cuts.push(base + delta, base - delta);
        }
        if (!cuts.length) continue; // rim fully covered, or isolated within cluster
        /** @param {number} t */
        const norm = (t) => { let x = t % (2 * Math.PI); if (x < 0) x += 2 * Math.PI; return x; };
        const sorted = cuts.map(norm).sort((p, q) => p - q);
        for (let k = 0; k < sorted.length; k++) {
            const a0 = sorted[k];
            const a1 = (k + 1 < sorted.length ? sorted[k + 1] : sorted[0] + 2 * Math.PI);
            const mid = (a0 + a1) / 2;
            const mx = c.x + c.r * Math.cos(mid);
            const mz = c.z + c.r * Math.sin(mid);
            if (pointInsideOtherCircle(mx, mz, circles, i)) continue; // interior arc
            const span = a1 - a0;
            const steps = Math.max(1, Math.ceil((span / (2 * Math.PI)) * seg));
            /** @type {PointXY[]} */
            const pts = [];
            for (let s = 0; s <= steps; s++) {
                const a = a0 + span * (s / steps);
                pts.push({ x: c.x + c.r * Math.cos(a), y: c.z + c.r * Math.sin(a) });
            }
            arcs.push(pts);
        }
    }
    if (!arcs.length) return null;
    return stitchBoundaryArcs(arcs);
}

/** Chain boundary arcs end-to-end into one closed ring by nearest endpoints. */
/** @param {PointXY[][]} arcs @returns {PointXY[]} */
function stitchBoundaryArcs(arcs) {
    /** @param {PointXY} a @param {PointXY} b */
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const used = new Array(arcs.length).fill(false);
    const ring = arcs[0].slice();
    used[0] = true;
    for (let count = 1; count < arcs.length; count++) {
        const end = ring[ring.length - 1];
        let best = -1, bestD = Infinity, bestRev = false;
        for (let k = 0; k < arcs.length; k++) {
            if (used[k]) continue;
            const a = arcs[k];
            const ds = dist(end, a[0]);
            const de = dist(end, a[a.length - 1]);
            if (ds < bestD) { bestD = ds; best = k; bestRev = false; }
            if (de < bestD) { bestD = de; best = k; bestRev = true; }
        }
        if (best < 0) break;
        used[best] = true;
        const arc = bestRev ? arcs[best].slice().reverse() : arcs[best];
        for (let s = 1; s < arc.length; s++) ring.push(arc[s]);
    }
    // Drop a duplicated closing vertex if the loop came back on itself.
    if (ring.length > 1) {
        const f = ring[0], l = ring[ring.length - 1];
        if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) ring.pop();
    }
    return ring;
}

/** Vertical wall lining a polygonal bore (no end caps). */
/** @param {PointXY[]} ring @param {number} yBottom @param {number} yTop @param {number[]} color @returns {ModelMesh} */
export function polygonWallMesh(ring, yBottom, yTop, color) {
    /** @type {ModelMesh['verts']} */
    const verts = [];
    /** @type {ModelMesh['faces']} */
    const faces = [];
    const n = ring.length;
    for (const p of ring) verts.push({ x: p.x, y: yTop, z: p.y });
    for (const p of ring) verts.push({ x: p.x, y: yBottom, z: p.y });
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push({ idx: [i, j, n + j, n + i], color });
    }
    return { verts, faces };
}

/** Append only the selected vertical segments of a polygonal bore wall. */
/**
 * @param {PointXY[]} ring
 * @param {(a: PointXY, b: PointXY) => boolean} include
 * @param {number} yBottom @param {number} yTop
 * @param {number[]} color
 * @returns {ModelMesh}
 */
export function polygonWallSegmentsMesh(ring, include, yBottom, yTop, color) {
    const mesh = /** @type {ModelMesh} */ (emptyMesh());
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (!include(a, b)) continue;
        const base = mesh.verts.length;
        mesh.verts.push(
            { x: a.x, y: yTop, z: a.y }, { x: b.x, y: yTop, z: b.y },
            { x: b.x, y: yBottom, z: b.y }, { x: a.x, y: yBottom, z: a.y },
        );
        mesh.faces.push({ idx: [base, base + 1, base + 2, base + 3], color });
    }
    return mesh;
}

/** @param {PointXY} point @param {PointXY} a @param {PointXY} b */
export function pointToSegmentDistance(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/**
 * Build the board slab with drilled holes bored clean through it, so plated
 * and mounting holes read as actual openings. Falls back to a solid prism if
 * the holes can't be triangulated (e.g. overlapping or off-board).
 * @param {Array<{x:number,z:number}>} outline
 * @param {Bore[]} holeList world-space holes
 * @param {number} yBottom @param {number} yTop
 * @param {number[]} color @param {number[]} edgeColor
 * @returns {ModelMesh}
 */
function boardWithHoles(outline, holeList, yBottom, yTop, color, edgeColor) {
    if (!holeList.length) return extrudePrism(outline, yBottom, yTop, color, edgeColor);
    const seg = 48;
    // Polygon cutouts (board shapes on the hole layer) carry an explicit ring
    // in board (x, z) coords; circular bores are clustered as before.
    const circleHoles = holeList.filter((h) => !h.ring);
    const ringHoles = holeList.filter((h) => h.ring && h.ring.length >= 3);
    // Group bores that overlap/touch into clusters. A lone bore stays a clean
    // circle; an overlapping cluster becomes the true union outline, so two
    // mounting holes that overlap read as a figure-8 opening — not one big
    // enclosing circle, and not an earcut-bridged sliver.
    /** @type {TriangulatedBore[]} */
    const bores = [];
    const polygonRings = ringHoles.map((hole) => /** @type {PointXZ[]} */ (hole.ring).map((point) => ({ x: point.x, y: point.z })));
    // A polygonal cutout can overlap a circle (or another polygon). Union all
    // rings before Earcut sees them, because intersecting hole rings produce
    // invalid triangulation and leave spurious board-face wedges.
    const unioned = ringHoles.length && unionBoreRings([
        ...circleHoles.map((hole) => circleRing(hole.x, hole.z, hole.r, seg)),
        ...polygonRings,
    ]);
    if (unioned) {
        for (const ring of unioned) bores.push({ ring, circle: null });
    } else {
        const clusters = clusterOverlappingHoles(circleHoles);
        for (const cluster of clusters) {
            if (cluster.length === 1) {
                const hole = cluster[0];
                bores.push({ ring: circleRing(hole.x, hole.z, hole.r, seg), circle: { x: hole.x, z: hole.z, r: hole.r } });
                continue;
            }
            const ring = circleUnionRing(cluster, seg);
            if (ring && ring.length >= 3) {
                bores.push({ ring, circle: null });
            } else {
                const merged = mergeOverlappingHoles(cluster)[0];
                bores.push({ ring: circleRing(merged.x, merged.z, merged.r, seg), circle: { x: merged.x, z: merged.z, r: merged.r } });
            }
        }
        for (const ring of polygonRings) bores.push({ ring, circle: null });
    }
    const outer2d = outline.map((p) => ({ x: p.x, y: p.z }));
    const holes2d = bores.map((b) => b.ring);
    let tri = null;
    try { tri = triangulateWithHoles(outer2d, holes2d); } catch { tri = null; }
    if (!tri || !tri.tris.length) return extrudePrism(outline, yBottom, yTop, color, edgeColor);

    const mesh = /** @type {ModelMesh} */ (emptyMesh());
    const side = edgeColor || color;
    // Top + bottom faces from the holed triangulation.
    const top = { verts: tri.pts.map((p) => ({ x: p.x, y: yTop, z: p.y })),
        faces: tri.tris.map((t) => ({ idx: [t[0], t[1], t[2]], color })) };
    const bot = { verts: tri.pts.map((p) => ({ x: p.x, y: yBottom, z: p.y })),
        faces: tri.tris.map((t) => ({ idx: [t[2], t[1], t[0]], color })) };
    appendMesh(mesh, top);
    appendMesh(mesh, bot);
    // Outer side wall.
    const n = outline.length;
    /** @type {ModelMesh} */
    const wall = { verts: [], faces: [] };
    for (const p of outline) wall.verts.push({ x: p.x, y: yTop, z: p.z });
    for (const p of outline) wall.verts.push({ x: p.x, y: yBottom, z: p.z });
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        wall.faces.push({ idx: [i, j, n + j, n + i], color: side });
    }
    appendMesh(mesh, wall);
    // Inner walls lining each bore (FR4 substrate edge).
    for (const b of bores) {
        if (b.circle) appendMesh(mesh, cylinderWallMesh(b.circle.x, b.circle.z, b.circle.r, yBottom, yTop, side, seg));
        else appendMesh(mesh, polygonWallMesh(b.ring, yBottom, yTop, side));
    }
    return mesh;
}

/** Signed area of a closed ring in the (x, z) plane (CCW → positive). */
/** @param {PointXZ[]} ring */
function _signedAreaXZ(ring) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        a += p.x * q.z - q.x * p.z;
    }
    return a / 2;
}

/** Ray-cast point-in-polygon test for a ring of {x, z} points. */
/** @param {number} x @param {number} z @param {PointXZ[]} ring */
function _pointInRingXZ(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if (((a.z > z) !== (b.z > z)) &&
            (x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x)) inside = !inside;
    }
    return inside;
}

/** Boundary samples for a circular or polygonal bore. */
/** @param {Bore} bore @returns {PointXZ[]} */
function _boreBoundaryPoints(bore) {
    const ring = bore.ring;
    if (ring && ring.length >= 3) return ring;
    const points = [];
    for (let index = 0; index < 24; index++) {
        const angle = index * Math.PI * 2 / 24;
        points.push({ x: bore.x + bore.r * Math.cos(angle), z: bore.z + bore.r * Math.sin(angle) });
    }
    return points;
}

/** True when a larger bore completely contains another bore's boundary. */
/** @param {Bore} outer @param {Bore} inner */
function _boreContains(outer, inner) {
    const outerRing = outer.ring;
    const innerRing = inner.ring;
    const outerArea = outerRing && outerRing.length >= 3
        ? Math.abs(_signedAreaXZ(outerRing))
        : Math.PI * outer.r * outer.r;
    const innerArea = innerRing && innerRing.length >= 3
        ? Math.abs(_signedAreaXZ(innerRing))
        : Math.PI * inner.r * inner.r;
    if (outerArea <= innerArea + 1e-6) return false;
    const boundary = _boreBoundaryPoints(inner);
    if (outerRing && outerRing.length >= 3) {
        return boundary.every((point) => _pointInRingXZ(point.x, point.z, outerRing));
    }
    return boundary.every((point) => Math.hypot(point.x - outer.x, point.z - outer.z) <= outer.r + 1e-6);
}

/** A cutout entirely inside another cutout is already void and needs no bore. */
/** @param {Bore[]} bores */
export function discardNestedBores(bores) {
    return bores.filter((bore, index) => !bores.some(
        (other, otherIndex) => otherIndex !== index && _boreContains(other, bore),
    ));
}

/**
 * Boolean-subtract cutout rings from the board outline (clipper difference),
 * returning the notched region(s) as ExPolygons in (x, z). Winding is
 * normalised so each outer matches the source outline and holes are opposite.
 * @param {Array<{x:number,z:number}>} outline
 * @param {Array<Array<{x:number,z:number}>>} rings cutout rings (x, z)
 * @returns {ExPolygonXZ[]}
 */
function _subtractRingsFromOutline(outline, rings) {
    if (!isClipperReady()) return [{ outer: outline, holes: [] }];
    const C = /** @type {any} */ (getClipper());
    const SC = 10000;
    /** @param {PointXZ[]} pts */
    const toPath = (pts) => pts.map((p) => ({ X: Math.round(p.x * SC), Y: Math.round(p.z * SC) }));
    const clip = new C.Clipper();
    clip.AddPaths([toPath(outline)], C.PolyType.ptSubject, true);
    clip.AddPaths(rings.map(toPath), C.PolyType.ptClip, true);
    const tree = new C.PolyTree();
    clip.Execute(C.ClipType.ctDifference, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    const exPolys = C.JS.PolyTreeToExPolygons(tree);
    const want = Math.sign(_signedAreaXZ(outline)) || 1;
    /** @param {Array<{X:number,Y:number}>} ring @param {number} sign */
    const norm = (ring, sign) => {
        const r = ring.map((pt) => ({ x: pt.X / SC, z: pt.Y / SC }));
        if ((Math.sign(_signedAreaXZ(r)) || 1) !== sign) r.reverse();
        return r;
    };
    return /** @type {Array<{outer:Array<{X:number,Y:number}>,holes?:Array<Array<{X:number,Y:number}>>}>} */ (exPolys).map((ex) => ({
        outer: norm(ex.outer, want),
        holes: (ex.holes || []).map((h) => norm(h, -want)),
    }));
}

/**
 * Build the board slab, boundary-crossing cutouts included. When any cutout
 * breaches the edge, every bore is subtracted from the outline together so
 * intersecting interior and boundary cutouts become one valid geometry.
 * Falls back to the plain {@link boardWithHoles} path when clipper is unavailable.
 * @param {Array<{x:number,z:number}>} outline board outer ring (x, z)
 * @param {Bore[]} holeList wholly-inside bores ({x,z,r} or {x,z,r,ring})
 * @param {Array<Array<{x:number,z:number}>>} crossingRings edge-crossing cutouts
 * @param {number} yBottom @param {number} yTop
 * @param {number[]} color @param {number[]} edgeColor
 * @returns {ModelMesh}
 */
export function boardSlabWithCutouts(outline, holeList, crossingRings, yBottom, yTop, color, edgeColor) {
    if (!crossingRings.length || !isClipperReady()) {
        return boardWithHoles(outline, holeList, yBottom, yTop, color, edgeColor);
    }
    const mesh = /** @type {ModelMesh} */ (emptyMesh());
    const seg = 48;
    const side = edgeColor || color;
    const allCutoutRings = [...crossingRings, ...holeList.flatMap((hole) => {
        const ring = hole.ring;
        if (ring && ring.length >= 3) return [ring];
        return hole.r > 0 ? [circleRing(hole.x, hole.z, hole.r, seg).map((point) => ({ x: point.x, z: point.y }))] : [];
    })];
    const exPolys = _subtractRingsFromOutline(outline, allCutoutRings);
    for (const ex of exPolys) {
        if (!ex.outer || ex.outer.length < 3) continue;
        // Clipper has already resolved every overlap and classified each
        // remaining interior void as an explicit hole ring.
        /** @type {TriangulatedBore[]} */
        const bores = [];
        for (const hr of ex.holes) {
            if (hr.length >= 3) bores.push({ ring: hr.map((p) => ({ x: p.x, y: p.z })), circle: null });
        }
        // Earcut the (possibly concave) notched outer with bore rings as holes —
        // extrudePrism's single n-gon face can't triangulate a concave notch.
        const outer2d = ex.outer.map((p) => ({ x: p.x, y: p.z }));
        let tri = null;
        try { tri = triangulateWithHoles(outer2d, bores.map((b) => b.ring)); } catch { tri = null; }
        if (!tri || !tri.tris.length) continue;
        appendMesh(mesh, { verts: tri.pts.map((p) => ({ x: p.x, y: yTop, z: p.y })),
            faces: tri.tris.map((t) => ({ idx: [t[0], t[1], t[2]], color })) });
        appendMesh(mesh, { verts: tri.pts.map((p) => ({ x: p.x, y: yBottom, z: p.y })),
            faces: tri.tris.map((t) => ({ idx: [t[2], t[1], t[0]], color })) });
        // Outer side wall following the notched perimeter.
        const n = ex.outer.length;
        /** @type {ModelMesh} */
        const wall = { verts: [], faces: [] };
        for (const p of ex.outer) wall.verts.push({ x: p.x, y: yTop, z: p.z });
        for (const p of ex.outer) wall.verts.push({ x: p.x, y: yBottom, z: p.z });
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            wall.faces.push({ idx: [i, j, n + j, n + i], color: side });
        }
        appendMesh(mesh, wall);
        // Inner walls lining each bore.
        for (const b of bores) {
            if (b.circle) appendMesh(mesh, cylinderWallMesh(b.circle.x, b.circle.z, b.circle.r, yBottom, yTop, side, seg));
            else appendMesh(mesh, polygonWallMesh(b.ring, yBottom, yTop, side));
        }
    }
    return mesh;
}
