import earcut from '../../../assets/vendor/earcut.module.js';

/** @returns {{verts:Array, faces:Array}} */
const emptyMesh = () => ({ verts: [], faces: [] });

/** Signed area of a closed polygon in the x–z plane; its sign is the winding. */
export function polygonAreaXZ(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
    }
    return a / 2;
}

/**
 * Clip every triangle of `mesh` to the vertical prism of the convex board
 * `outline` (Sutherland–Hodgman in the x–z plane, with y linearly interpolated
 * at each new edge crossing). Geometry that overhangs the board edge is trimmed
 * exactly at the boundary instead of being dropped or left floating. The board
 * outline is convex (a rounded rectangle), so each clipped triangle stays a
 * single convex polygon that fan-triangulates cleanly.
 * @param {{verts:Array<{x:number,y:number,z:number}>, faces:Array<{idx:number[],color:number[]}>}} mesh
 * @param {Array<{x:number,z:number}>} outline
 * @returns {{verts:Array, faces:Array}}
 */
export function clipMeshToOutline(mesh, outline) {
    if (!outline || outline.length < 3) return mesh;
    const orient = polygonAreaXZ(outline) >= 0 ? 1 : -1;
    const edges = [];
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        edges.push({
            ax: outline[j].x, az: outline[j].z,
            bx: outline[i].x, bz: outline[i].z,
        });
    }
    // Signed distance of (px,pz) to a clip edge; ≥0 means on the inside.
    const side = (e, px, pz) =>
        orient * ((e.bx - e.ax) * (pz - e.az) - (e.bz - e.az) * (px - e.ax));

    const out = emptyMesh();
    const emitTri = (a, b, c, color) => {
        const base = out.verts.length;
        out.verts.push(a, b, c);
        out.faces.push({ idx: [base, base + 1, base + 2], color });
    };

    for (const f of mesh.faces) {
        const idx = f.idx;
        if (!idx || idx.length < 3) continue;
        // Fan-triangulate the (possibly quad) face, then clip each triangle.
        for (let t = 1; t + 1 < idx.length; t++) {
            const v0 = mesh.verts[idx[0]];
            const v1 = mesh.verts[idx[t]];
            const v2 = mesh.verts[idx[t + 1]];
            if (!v0 || !v1 || !v2) continue;
            // Fast path: a triangle wholly inside every edge passes through.
            let allIn = true;
            for (const e of edges) {
                if (side(e, v0.x, v0.z) < 0 || side(e, v1.x, v1.z) < 0 ||
                    side(e, v2.x, v2.z) < 0) { allIn = false; break; }
            }
            if (allIn) {
                emitTri({ ...v0 }, { ...v1 }, { ...v2 }, f.color);
                continue;
            }
            // Sutherland–Hodgman: clip the triangle against each outline edge.
            let poly = [
                { x: v0.x, y: v0.y, z: v0.z },
                { x: v1.x, y: v1.y, z: v1.z },
                { x: v2.x, y: v2.y, z: v2.z },
            ];
            for (const e of edges) {
                if (poly.length === 0) break;
                const next = [];
                for (let k = 0; k < poly.length; k++) {
                    const S = poly[(k + poly.length - 1) % poly.length];
                    const E = poly[k];
                    const dS = side(e, S.x, S.z);
                    const dE = side(e, E.x, E.z);
                    if (dE >= 0) {
                        if (dS < 0) {
                            const u = dS / (dS - dE);
                            next.push({
                                x: S.x + u * (E.x - S.x),
                                y: S.y + u * (E.y - S.y),
                                z: S.z + u * (E.z - S.z),
                            });
                        }
                        next.push(E);
                    } else if (dS >= 0) {
                        const u = dS / (dS - dE);
                        next.push({
                            x: S.x + u * (E.x - S.x),
                            y: S.y + u * (E.y - S.y),
                            z: S.z + u * (E.z - S.z),
                        });
                    }
                }
                poly = next;
            }
            for (let k = 1; k + 1 < poly.length; k++) {
                emitTri(poly[0], poly[k], poly[k + 1], f.color);
            }
        }
    }
    return out;
}

/**
 * Subtract drilled holes from a flat (single y-plane) mesh so copper, silk and
 * text are bored through exactly where the board substrate is — otherwise a
 * track or pad lid floats over an open hole. Each hole is approximated by a
 * convex polygon pieces; every face triangle that overlaps a hole is replaced by
 * the convex pieces of `triangle \ holePolygon` (the standard convex-difference
 * decomposition: the part outside edge i but inside edges 0..i-1, unioned over
 * all edges). Triangles clear of every hole pass straight through.
 * @param {{verts:Array, faces:Array}} mesh flat planar mesh (constant-ish y)
 * @param {Array<{x:number,z:number,r:number,ring?:Array<{x:number,z:number}>,y?:number}>} holes drilled holes (board plane)
 * @param {number} [seg] polygon segments per hole
 * @returns {{verts:Array, faces:Array}}
 */
export function punchHolesInFlatMesh(mesh, holes, seg = 48) {
    if (!holes || !holes.length || !mesh.faces.length) return mesh;
    // Pre-build each hole as a CCW polygon ring in the (x, z) board plane.
    // Circular bores sample a ring; polygon cutouts carry an explicit ring.
    const rings = holes.filter((h) => {
        if (h.ring && h.ring.length >= 3) {
            return h.ring.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
        }
        return Number.isFinite(h.x) && Number.isFinite(h.z) && Number.isFinite(h.r) && h.r > 0;
    }).flatMap((h) => {
        if (h.ring && h.ring.length >= 3) {
            let pts = h.ring.map((p) => ({ x: p.x, z: p.z }));
            // Half-plane subtraction expects CCW convex rings. Rounded polygons
            // can be concave, so decompose those into convex triangles first.
            let area = 0;
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                area += a.x * b.z - b.x * a.z;
            }
            if (area < 0) pts = pts.reverse();
            let direction = 0;
            let convex = true;
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
                const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
                if (Math.abs(cross) <= 1e-9) continue;
                const sign = Math.sign(cross);
                if (direction && sign !== direction) { convex = false; break; }
                direction = sign;
            }
            if (convex) return [{ pts, x: h.x, z: h.z, r: h.r, y: h.y }];
            const indices = earcut(pts.flatMap((point) => [point.x, point.z]));
            return Array.from({ length: indices.length / 3 }, (_, index) => ({
                pts: [pts[indices[index * 3]], pts[indices[index * 3 + 1]], pts[indices[index * 3 + 2]]],
                x: h.x, z: h.z, r: h.r, y: h.y,
            }));
        }
        const pts = [];
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            pts.push({ x: h.x + h.r * Math.cos(a), z: h.z + h.r * Math.sin(a) });
        }
        return [{ pts, x: h.x, z: h.z, r: h.r, y: h.y }];
    }).map((ring) => ({
        ...ring,
        minX: Math.min(...ring.pts.map(point => point.x)),
        maxX: Math.max(...ring.pts.map(point => point.x)),
        minZ: Math.min(...ring.pts.map(point => point.z)),
        maxZ: Math.max(...ring.pts.map(point => point.z)),
    }));
    if (!rings.length) return mesh;

    // Signed area-ish test against the directed edge P→Q in the (x,z) plane;
    // ≥0 is the polygon interior side (rings are CCW, so interior is left).
    const dist = (P, Q, R) =>
        (Q.x - P.x) * (R.z - P.z) - (Q.z - P.z) * (R.x - P.x);
    const lerp = (S, E, dS, dE) => {
        const u = dS / (dS - dE);
        return {
            x: S.x + u * (E.x - S.x),
            y: S.y + u * (E.y - S.y),
            z: S.z + u * (E.z - S.z),
        };
    };
    // Sutherland–Hodgman clip of a convex polygon against one half-plane.
    // keepInside=true keeps the interior side of edge P→Q, false the exterior.
    const clipHalf = (poly, P, Q, keepInside) => {
        const res = [];
        const n = poly.length;
        const s = keepInside ? 1 : -1;
        for (let k = 0; k < n; k++) {
            const S = poly[(k + n - 1) % n];
            const E = poly[k];
            const dS = s * dist(P, Q, S);
            const dE = s * dist(P, Q, E);
            if (dE >= 0) {
                if (dS < 0) res.push(lerp(S, E, dS, dE));
                res.push(E);
            } else if (dS >= 0) {
                res.push(lerp(S, E, dS, dE));
            }
        }
        return res;
    };
    const triangleHasArea = (first, second, third) => {
        const edgeX = second.x - first.x;
        const edgeY = second.y - first.y;
        const edgeZ = second.z - first.z;
        const otherX = third.x - first.x;
        const otherY = third.y - first.y;
        const otherZ = third.z - first.z;
        return Math.hypot(
            edgeY * otherZ - edgeZ * otherY,
            edgeZ * otherX - edgeX * otherZ,
            edgeX * otherY - edgeY * otherX,
        ) > 1e-12;
    };
    const polygonHasArea = (polygon) => {
        for (let index = 1; index + 1 < polygon.length; index++) {
            if (triangleHasArea(polygon[0], polygon[index], polygon[index + 1])) return true;
        }
        return false;
    };
    // piece \ ringPoly → push the resulting convex sub-pieces onto `out`.
    const subtractRing = (piece, ring, out) => {
        const separatedByEdge = (polygon, other) => {
            const area = polygonAreaXZ(polygon);
            if (area === 0) return false;
            const orientation = area > 0 ? 1 : -1;
            return polygon.some((start, index) => {
                const end = polygon[(index + 1) % polygon.length];
                const edgeLength = Math.hypot(end.x - start.x, end.z - start.z);
                if (edgeLength <= 1e-9) return false;
                return other.every((point) => orientation * dist(start, end, point) <= 0)
                    && other.some((point) => orientation * dist(start, end, point) < -1e-9 * edgeLength);
            });
        };
        if (separatedByEdge(ring.pts, piece) || separatedByEdge(piece, ring.pts)) {
            out.push(piece);
            return;
        }
        const m = ring.pts.length;
        let inside = piece; // part still inside edges processed so far
        for (let i = 0; i < m; i++) {
            const P = ring.pts[i];
            const Q = ring.pts[(i + 1) % m];
            const outer = clipHalf(inside, P, Q, false);
            if (polygonHasArea(outer)) out.push(outer);
            inside = clipHalf(inside, P, Q, true);
            if (!polygonHasArea(inside)) return; // fully consumed by the hole
        }
        // Whatever remains `inside` every edge is the hole interior → dropped.
    };
    const overlapsBounds = (piece, ring) => {
        let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
        for (const p of piece) {
            if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
            if (p.z < minz) minz = p.z; if (p.z > maxz) maxz = p.z;
        }
        return !(minx > ring.maxX || maxx < ring.minX ||
            minz > ring.maxZ || maxz < ring.minZ);
    };

    const out = emptyMesh();
    const emitTri = (a, b, c, color) => {
        const base = out.verts.length;
        out.verts.push(a, b, c);
        out.faces.push({ idx: [base, base + 1, base + 2], color });
    };
    for (const f of mesh.faces) {
        const idx = f.idx;
        if (!idx || idx.length < 3) continue;
        for (let t = 1; t + 1 < idx.length; t++) {
            const v0 = mesh.verts[idx[0]];
            const v1 = mesh.verts[idx[t]];
            const v2 = mesh.verts[idx[t + 1]];
            if (!v0 || !v1 || !v2) continue;
            let pieces = [[
                { x: v0.x, y: v0.y, z: v0.z },
                { x: v1.x, y: v1.y, z: v1.z },
                { x: v2.x, y: v2.y, z: v2.z },
            ]];
            for (const ring of rings) {
                if (typeof ring.y === 'number' && Number.isFinite(ring.y)
                    && Math.abs(pieces[0][0].y - ring.y) > 1e-6) continue;
                const next = [];
                for (const piece of pieces) {
                    if (overlapsBounds(piece, ring)) subtractRing(piece, ring, next);
                    else next.push(piece);
                }
                pieces = next;
                if (!pieces.length) break;
            }
            for (const piece of pieces) {
                for (let k = 1; k + 1 < piece.length; k++) {
                    if (!triangleHasArea(piece[0], piece[k], piece[k + 1])) continue;
                    emitTri({ ...piece[0] }, { ...piece[k] }, { ...piece[k + 1] }, f.color);
                }
            }
        }
    }
    return out;
}

