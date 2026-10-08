/**
 * Component bodies and pads in 3D: OBJ models placed on the board, fallback boxes,
 * pad flashes and plated through-hole barrels.
 * Split from board3d.js; the viewer itself is board3d.js.
 */
import { resolvePadFlashes } from '../../shared/pcb/board-geometry.js';
import { BOARD_THICKNESS, FALLBACK_HEIGHT, COLOR_FALLBACK, COLOR_PAD, Y_TOP, Y_BOT, PAD_EPS, PAD_BARREL_SEGMENTS } from './board3d-params.js';
import { roundedRectOutline, extrudePrism, triangulateWithHoles, cylinderWallMesh, capsuleRing, polygonWallMesh } from './board3d-board.js';
import { emptyMesh, appendMesh } from './board3d-mesh-ops.js';

/** @typedef {import('./board3d-mesh-ops.js').MeshVertex} MeshVertex */
/** @typedef {import('./board3d-mesh-ops.js').MeshFace} MeshFace */
/** @typedef {import('./board3d-mesh-ops.js').Mesh & {cull?: boolean}} Mesh */
/** @typedef {import('../../shapes/pad-geometry.js').PadFlash & {rad:number,layer?:string,isThru?:boolean,drill?:number,slot?:{x1:number,y1:number,x2:number,y2:number}}} Board3dPadFlash */
/** @typedef {{top?: boolean, bottom?: boolean, outerWall?: boolean}} ThroughHoleFaces */

/**
 * Transform a parsed OBJ model ({@link parseObjModel}) into a placed mesh.
 * Preserves per-face material colour.
 * @param {{vertices:Array<{x:number,y:number,z:number}>, faces:Array<{idx:number[], color:number[]}>, source?: string}} parsed
 * @param {{x:number,y:number,rotation?:number,side?:string,mirror?:boolean,model3dPlacement?:{dx?:number,dy?:number,rotation?:number,z?:number}}} pl
 * @returns {Mesh|null}
 */
export function objModelToMesh(parsed, pl) {
    if (!parsed?.vertices?.length || !parsed.faces?.length) return null;

    // EasyEDA's c_origin (the model3dPlacement dx/dy target) is the model's
    // projected XY bounding-box centre, not its raw OBJ origin. Seat the model
    // by its XY bbox centre so an off-centre OBJ lands correctly — and so the
    // intrinsic Z rotation spins about that same centre (matching EasyEDA).
    // KiCad models follow KiCad's own convention instead: the model origin IS
    // the footprint origin (often pin 1, not the body centre) and model Z = 0 is
    // the board surface, so they keep their raw origin and height (see the
    // KiCad model3d offset in shared/pcb/footprint.js).
    const kicad = parsed.source === 'kicad';
    let minZ = Infinity;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of parsed.vertices) {
        if (v.z < minZ) minZ = v.z;
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
    }
    if (!isFinite(minZ)) minZ = 0;
    // Built-in and KiCad leads extend below their authored mounting plane; do not lift the body.
    const mountingZ = parsed.source === 'builtin' || kicad ? 0 : minZ;
    const ocx = !kicad && isFinite(minX) ? (minX + maxX) / 2 : 0;
    const ocy = !kicad && isFinite(minY) ? (minY + maxY) / 2 : 0;

    // EasyEDA seats the model with an intrinsic Z rotation and an origin
    // offset relative to the footprint centroid (model3dPlacement). The
    // placement rotation orients the whole footprint on the board.
    const mp = pl.model3dPlacement || { dx: 0, dy: 0, rotation: 0, z: 0 };
    // Intrinsic model spin (about the model's own centre). The spin is NEGATED
    // because the model→board map reflects Y (mx,my below), and a reflection
    // inverts the chirality of a rotation: Reflect∘R(θ) = R(−θ)∘Reflect. EasyEDA
    // spins the model by +c_rotation in its own (un-reflected) frame, so to land
    // the model's asymmetric features (pin-1 marker, polarity band, text) on the
    // matching footprint corner we must apply −c_rotation here. This is a no-op
    // for the common 0°/180° parts (−180≡180) and correctly 180°-reorients the
    // 90°/270° parts (e.g. a TSSOP whose pin-1 otherwise lands on the far end).
    //
    // The Y-reflection (my below) is the standard Z-up→Y-up conversion for BOTH
    // sources: KiCad and EasyEDA models are Y-up while footprints are Y-down.
    const spin = ((-(mp.rotation || 0)) * Math.PI) / 180;
    const sct = Math.cos(spin);
    const sst = Math.sin(spin);
    // Placement rotation (orients the whole footprint on the board).
    const pr = ((pl.rotation || 0) * Math.PI) / 180;
    const pct = Math.cos(pr);
    const pst = Math.sin(pr);

    // A bottom-side placement seats the body under the board (growing downward
    // from the bottom face) and mirrors it; the net mirror matches the 2D pose
    // (a Flip and a bottom side each mirror, so together they cancel).
    const bottom = pl.side === 'bottom';
    const mir = (!!pl.mirror) !== bottom;

    const verts = parsed.vertices.map((v) => {
        // The board plane maps model X->world X and model Y->world Z while
        // model Z becomes world Y (height). That axis swap is a reflection,
        // so the model Y must be negated to keep the part un-mirrored (text
        // readable) and align its asymmetric features with the footprint.
        // Subtract the OBJ XY bbox centre so the model seats on its centre.
        const mx = v.x - ocx;
        const my = -(v.y - ocy);
        // Footprint-local position: intrinsic spin + model-origin offset.
        let fx = (mp.dx || 0) + (mx * sct - my * sst);
        const fy = (mp.dy || 0) + (mx * sst + my * sct);
        // Mirror in the footprint-local frame (before the placement rotation),
        // matching the 2D `scale(-1,1) … rotate(r)` SVG pose. Mirroring after
        // rotation reflects across the wrong axis for rotated parts.
        if (mir) fx = -fx;
        const wx = fx * pct - fy * pst;
        const wz = fx * pst + fy * pct;
        const up = (mp.z || 0) + (v.z - mountingZ);
        return {
            x: pl.x + wx,
            y: bottom ? -up : BOARD_THICKNESS + up,
            z: pl.y + wz,
        };
    });

    return { verts, faces: parsed.faces, cull: true };
}

/**
 * Build a fallback box mesh for a placement from its footprint bounds.
 * @param {{x:number,y:number,rotation?:number,side?:string,bounds?:{x:number,y:number,width:number,height:number}}} pl
 * @returns {Mesh}
 */
export function fallbackBoxMesh(pl) {
    const b = pl.bounds || { x: -1, y: -1, width: 2, height: 2 };
    const theta = ((pl.rotation || 0) * Math.PI) / 180;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    // Four corners in local board-plane coords.
    const corners = [
        { x: b.x, z: b.y },
        { x: b.x + b.width, z: b.y },
        { x: b.x + b.width, z: b.y + b.height },
        { x: b.x, z: b.y + b.height },
    ].map((c) => ({
        x: pl.x + (c.x * ct - c.z * st),
        z: pl.y + (c.x * st + c.z * ct),
    }));
    const bottom = pl.side === 'bottom';
    return extrudePrism(
        corners,
        bottom ? -FALLBACK_HEIGHT : BOARD_THICKNESS,
        bottom ? 0 : BOARD_THICKNESS + FALLBACK_HEIGHT,
        COLOR_FALLBACK,
        COLOR_FALLBACK,
    );
}

/**
 * Build copper pads for a placement. SMD pads are flat shapes (disc for
 * round/oval, quad for rect) on their own face; through-hole pads are gold
 * annular rings on BOTH faces with an open bore (the board is bored to match),
 * so the drilled hole reads as a real opening.
 * @param {{x:number,y:number,rotation?:number,padOffsets?:Array<any>}} pl Dynamic footprint pad offsets come from component definitions and may include package-specific fields.
 * @returns {Mesh}
 */
export function padMesh(pl) {
    const mesh = emptyMesh();
    for (const rawFlash of resolvePadFlashes(new Map([[0, pl]]))) {
        const flash = /** @type {Board3dPadFlash} */ (rawFlash);
        const ct = Math.cos(flash.rad);
        const st = Math.sin(flash.rad);
        const halfW = flash.w / 2;
        const halfH = flash.h / 2;
        if (flash.isThru) {
            // Plated through-hole: shape-correct copper ring on each face +
            // barrel lining the bore (inner radius inset so it occludes the
            // board's FR4 edge).
            const ri = Math.max(0.05, /** @type {number} */ (flash.drill) / 2 - 0.02);
            // Stadium slot drill (holeLength > drill): bore between the two
            // cap-centres rather than a single round hole, so the slot reads
            // as a slot instead of being lidded over by round pad copper. The
            // cap-centres come from the shared resolver, so the pad bore aligns
            // exactly with the board slab slot (collectBoardHoles).
            const slot = flash.slot
                ? { x1: flash.slot.x1, z1: flash.slot.y1, x2: flash.slot.x2, z2: flash.slot.y2 }
                : null;
            const round = (flash.shape === 'ellipse' || flash.shape === 'oval')
                && Math.abs(halfW - halfH) < 1e-3;
            if (round && !slot) {
                const ro = Math.max(halfW, Math.max(0.05, ri + 0.05));
                appendMesh(mesh, tubeMesh(flash.x, flash.y, ri, ro,
                    Y_BOT - PAD_EPS, Y_TOP + PAD_EPS, COLOR_PAD, 16));
            } else {
                appendMesh(mesh, throughHolePadMesh(flash.x, flash.y, flash.shape, halfW, halfH,
                    ct, st, ri, Y_BOT - PAD_EPS, Y_TOP + PAD_EPS, COLOR_PAD, slot));
            }
            continue;
        }
        const bottom = flash.layer === 'bottom';
        appendMesh(mesh, flatPadMesh(flash, bottom ? Y_BOT - PAD_EPS : Y_TOP + PAD_EPS));
    }
    return mesh;
}

/** Surface-mount pad copper: a flat flash on one board face at height `y`.
 * @param {Board3dPadFlash} flash
 * @param {number} y
 * @returns {Mesh}
 */
export function flatPadMesh(flash, y) {
    const ct = Math.cos(flash.rad);
    const st = Math.sin(flash.rad);
    const halfW = flash.w / 2;
    const halfH = flash.h / 2;
    if (flash.shape === 'oval') {
        // Stadium / obround (matches the 2D footprint render): straight
        // sides with semicircular ends, NOT a pointy ellipse.
        return stadiumDiscMesh(flash.x, flash.y, halfW, halfH, ct, st, y, COLOR_PAD);
    }
    if (flash.shape === 'ellipse' || flash.shape === 'circle') {
        return ellipseDiscMesh(flash.x, flash.y, halfW, halfH, ct, st, y, COLOR_PAD, 20);
    }
    const local = [
        { x: -halfW, z: -halfH }, { x: halfW, z: -halfH },
        { x: halfW, z: halfH }, { x: -halfW, z: halfH },
    ];
    return {
        verts: local.map(c => ({ x: flash.x + (c.x * ct - c.z * st), y, z: flash.y + (c.x * st + c.z * ct) })),
        faces: [{ idx: [0, 1, 2, 3], color: COLOR_PAD }],
    };
}

/** Flat (optionally rotated) elliptical disc on a y-plane (round/oval pad).
 * @param {number} cx @param {number} cz @param {number} rx @param {number} rz
 * @param {number} ct @param {number} st @param {number} y @param {number[]} color @param {number} [seg]
 * @returns {Mesh}
 */
function ellipseDiscMesh(cx, cz, rx, rz, ct, st, y, color, seg = 20) {
    /** @type {MeshVertex[]} */
    const verts = [{ x: cx, y, z: cz }];
    /** @type {MeshFace[]} */
    const faces = [];
    for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const lx = rx * Math.cos(a), lz = rz * Math.sin(a);
        verts.push({ x: cx + lx * ct - lz * st, y, z: cz + lx * st + lz * ct });
    }
    for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        faces.push({ idx: [0, 1 + i, 1 + j], color });
    }
    return { verts, faces };
}

/** Flat (optionally rotated) stadium/obround disc on a y-plane (oval pad).
 * @param {number} cx @param {number} cz @param {number} halfW @param {number} halfH
 * @param {number} ct @param {number} st @param {number} y @param {number[]} color
 * @returns {Mesh}
 */
function stadiumDiscMesh(cx, cz, halfW, halfH, ct, st, y, color) {
    // Stadium = rounded rect with r = min(halfW, halfH), centred on origin.
    const local = roundedRectOutline(-halfW, -halfH, halfW * 2, halfH * 2, Math.min(halfW, halfH));
    const n = local.length;
    /** @type {MeshVertex[]} */
    const verts = [{ x: cx, y, z: cz }];
    /** @type {MeshFace[]} */
    const faces = [];
    for (const p of local) {
        verts.push({ x: cx + p.x * ct - p.z * st, y, z: cz + p.x * st + p.z * ct });
    }
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push({ idx: [0, 1 + i, 1 + j], color });
    }
    return { verts, faces };
}

/**
 * Shape-correct through-hole pad copper: an outer pad outline (oval/rect) with
 * a round drill hole punched out, rendered as copper on BOTH faces plus an
 * outer side wall and an inner barrel lining the bore.
 * @param {number} cx @param {number} cz pad centre (world x, z)
 * @param {string} shape pad shape ('ellipse'|'oval'|'rect'|…)
 * @param {number} halfW @param {number} halfH pad half-extents (mm)
 * @param {number} ct @param {number} st cos/sin of the placement rotation
 * @param {number} ri bore (inner) radius — the visible hole edge
 * @param {number} yBottom @param {number} yTop
 * @param {number[]} color
 * @param {{x1:number,z1:number,x2:number,z2:number}|null} [slot] stadium-slot
 *        cap-centres (world x, z); when set the bore is a slot, not a circle
 * @param {ThroughHoleFaces} [faces]
 * @returns {Mesh}
 */
export function throughHolePadMesh(cx, cz, shape, halfW, halfH, ct, st, ri, yBottom, yTop, color, slot = null,
    faces = { top: true, bottom: true, outerWall: true }) {
    /** @param {number} lx @param {number} lz @returns {{x:number,y:number}} */
    const toWorld = (lx, lz) => ({ x: cx + lx * ct - lz * st, y: cz + lx * st + lz * ct });
    // Outer outline in the board plane (x, y(=world z)).
    /** @type {Array<{x:number,y:number}>} */
    const outline = [];
    if (shape === 'oval') {
        // Stadium / obround — matches the 2D footprint render.
        for (const p of roundedRectOutline(-halfW, -halfH, halfW * 2, halfH * 2, Math.min(halfW, halfH))) {
            outline.push(toWorld(p.x, p.z));
        }
    } else if (shape === 'ellipse') {
        const seg = 24;
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            outline.push(toWorld(halfW * Math.cos(a), halfH * Math.sin(a)));
        }
    } else {
        for (const [lx, lz] of [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]]) {
            outline.push(toWorld(lx, lz));
        }
    }
    // Drill hole: a stadium slot when one is given, else a round bore.
    const seg = PAD_BARREL_SEGMENTS;
    const hole = slot
        ? capsuleRing(slot.x1, slot.z1, slot.x2, slot.z2, ri)
        : [];
    if (!slot) {
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            hole.push({ x: cx + ri * Math.cos(a), y: cz + ri * Math.sin(a) });
        }
    }
    let tri = null;
    try { tri = triangulateWithHoles(outline, [hole]); } catch { tri = null; }
    const mesh = emptyMesh();
    if (tri && tri.tris.length) {
        if (faces.top) {
            appendMesh(mesh, {
                verts: tri.pts.map((p) => ({ x: p.x, y: yTop, z: p.y })),
                faces: tri.tris.map((t) => ({ idx: [t[0], t[1], t[2]], color })),
            });
        }
        if (faces.bottom) {
            appendMesh(mesh, {
                verts: tri.pts.map((p) => ({ x: p.x, y: yBottom, z: p.y })),
                faces: tri.tris.map((t) => ({ idx: [t[2], t[1], t[0]], color })),
            });
        }
    }
    // Outer side wall around the pad outline.
    /** @type {Mesh} */
    const wall = { verts: [], faces: [] };
    const n = outline.length;
    for (const p of outline) wall.verts.push({ x: p.x, y: yTop, z: p.y });
    for (const p of outline) wall.verts.push({ x: p.x, y: yBottom, z: p.y });
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        wall.faces.push({ idx: [i, j, n + j, n + i], color });
    }
    if (faces.outerWall) appendMesh(mesh, wall);
    // Inner barrel lining the bore (capsule wall for slots, cylinder for round).
    if (slot) appendMesh(mesh, polygonWallMesh(hole, yBottom, yTop, color));
    else appendMesh(mesh, cylinderWallMesh(cx, cz, ri, yBottom, yTop, color, seg));
    return mesh;
}



/** Flat filled disc on the y-plane (used for round track end-caps / pads).
 * @param {number} cx @param {number} cz @param {number} r @param {number} y @param {number[]} color @param {number} [seg]
 * @returns {Mesh}
 */
export function discMesh(cx, cz, r, y, color, seg = 14) {
    /** @type {MeshVertex[]} */
    const verts = [{ x: cx, y, z: cz }];
    for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        verts.push({ x: cx + r * Math.cos(a), y, z: cz + r * Math.sin(a) });
    }
    /** @type {MeshFace[]} */
    const faces = [];
    for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        faces.push({ idx: [0, 1 + i, 1 + j], color });
    }
    return { verts, faces };
}

/** Flat rectangle of the given width from A→B on the y-plane (a track body).
 * @param {number} ax @param {number} az @param {number} bx @param {number} bz
 * @param {number} width @param {number} y @param {number[]} color
 * @returns {Mesh}
 */
export function ribbonMesh(ax, az, bx, bz, width, y, color) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * (width / 2);
    const nz = (dx / len) * (width / 2);
    const verts = [
        { x: ax + nx, y, z: az + nz },
        { x: bx + nx, y, z: bz + nz },
        { x: bx - nx, y, z: bz - nz },
        { x: ax - nx, y, z: az - nz },
    ];
    return { verts, faces: [{ idx: [0, 1, 2, 3], color }] };
}

/** Flat annular ring band (silk circle outline) on the y-plane.
 * @param {number} cx @param {number} cz @param {number} r @param {number} strokeWidth
 * @param {number} y @param {number[]} color @param {number} [seg]
 * @returns {Mesh}
 */
export function flatRingMesh(cx, cz, r, strokeWidth, y, color, seg = 28) {
    const ro = r + strokeWidth / 2;
    const ri = Math.max(0, r - strokeWidth / 2);
    /** @type {MeshVertex[]} */
    const verts = [];
    /** @type {MeshFace[]} */
    const faces = [];
    for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        verts.push({ x: cx + ro * c, y, z: cz + ro * s });
        verts.push({ x: cx + ri * c, y, z: cz + ri * s });
    }
    for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        faces.push({ idx: [i * 2, j * 2, j * 2 + 1, i * 2 + 1], color });
    }
    return { verts, faces };
}

/** Hollow vertical tube (plated via/hole barrel) with annular end caps.
 * @param {number} cx @param {number} cz @param {number} rInner @param {number} rOuter
 * @param {number} yBottom @param {number} yTop @param {number[]} color @param {number} [seg]
 * @returns {Mesh}
 */
export function tubeMesh(cx, cz, rInner, rOuter, yBottom, yTop, color, seg = 18) {
    /** @type {MeshVertex[]} */
    const verts = [];
    /** @type {MeshFace[]} */
    const faces = [];
    for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        verts.push({ x: cx + rOuter * c, y: yTop, z: cz + rOuter * s });    // +0 OT
        verts.push({ x: cx + rOuter * c, y: yBottom, z: cz + rOuter * s }); // +1 OB
        verts.push({ x: cx + rInner * c, y: yTop, z: cz + rInner * s });    // +2 IT
        verts.push({ x: cx + rInner * c, y: yBottom, z: cz + rInner * s }); // +3 IB
    }
    /** @param {number} i @param {number} k */
    const V = (i, k) => (i % seg) * 4 + k;
    for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        faces.push({ idx: [V(i, 0), V(i, 1), V(j, 1), V(j, 0)], color }); // outer wall
        faces.push({ idx: [V(i, 2), V(j, 2), V(j, 3), V(i, 3)], color }); // inner wall
        faces.push({ idx: [V(i, 0), V(j, 0), V(j, 2), V(i, 2)], color }); // top ring
        faces.push({ idx: [V(i, 1), V(i, 3), V(j, 3), V(j, 1)], color }); // bottom ring
    }
    return { verts, faces };
}

/** Solid vertical cylinder (an un-plated/mounting hole plug).
 * @param {number} cx @param {number} cz @param {number} r @param {number} yBottom
 * @param {number} yTop @param {number[]} color @param {number} [seg]
 * @returns {Mesh}
 */
function cylinderMesh(cx, cz, r, yBottom, yTop, color, seg = 18) {
    /** @type {MeshVertex[]} */
    const verts = [];
    /** @type {MeshFace[]} */
    const faces = [];
    const topC = verts.push({ x: cx, y: yTop, z: cz }) - 1;
    const botC = verts.push({ x: cx, y: yBottom, z: cz }) - 1;
    /** @type {Array<[number, number]>} */
    const ring = [];
    for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        const t = verts.push({ x: cx + r * c, y: yTop, z: cz + r * s }) - 1;
        const b = verts.push({ x: cx + r * c, y: yBottom, z: cz + r * s }) - 1;
        ring.push([t, b]);
    }
    for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        const [ti, bi] = ring[i];
        const [tj, bj] = ring[j];
        faces.push({ idx: [ti, bi, bj, tj], color }); // wall
        faces.push({ idx: [topC, tj, ti], color });   // top fan
        faces.push({ idx: [botC, bi, bj], color });   // bottom fan
    }
    return { verts, faces };
}
