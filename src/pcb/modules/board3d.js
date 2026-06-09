/**
 * Interactive 3D board visualiser (WebGL / three.js).
 *
 * Opens a pop-up window with a hardware-accelerated 3D view of the PCB and its
 * placed components. EasyEDA/LCSC parts render from the OBJ model carried on
 * the placement; KiCad parts fetch the same STEP models the schematic
 * component picker previews (via {@link STEPPreview}), lazily and cached.
 * Components without an available model fall back to a simple extruded box
 * sized from the footprint bounds.
 *
 * Rendering uses three.js (vendored at assets/vendor/three.module.js) with a
 * real GPU depth buffer, so there are no painter's-algorithm artefacts; orbit/
 * pan/zoom comes from a custom Shoemake arcball ({@link ArcballController}).
 * The footprint geometry +
 * placement-transform builders below are plain data ({verts, faces}); the
 * renderer converts each into a BufferGeometry with flat per-face colours.
 *
 * Coordinate mapping (PCB → 3D world):
 *   world X = pcb x (mm)
 *   world Z = pcb y (mm, SVG Y-down)
 *   world Y = height above the board (mm, up)
 * The board top surface sits at world Y = BOARD_THICKNESS; component models
 * are dropped so their lowest point rests on that surface.
 */

import * as THREE from '../../../assets/vendor/three.module.js';
import earcut from '../../../assets/vendor/earcut.module.js';

/* ─────────────────────────── arcball controller ──────────────────────────── */

/**
 * Drop-in orbit/pan/zoom controller with a true Shoemake **arcball** rotation,
 * matching EasyEDA's feel: orientation is an *absolute* function of the current
 * drag vector from the mouse-down anchor — never an accumulation of per-frame
 * deltas. Returning the pointer to where the drag started returns to the exact
 * same orientation, so circling the mouse cannot drift (the failure mode of
 * three.js `TrackballControls`), yet the board can still be flipped freely over
 * the poles (which `OrbitControls`' fixed up-vector forbids).
 *
 * Exposes the small slice of the `TrackballControls` interface the viewer uses:
 * `target`, `minDistance`/`maxDistance`, `rotateSpeed`/`zoomSpeed`/`panSpeed`,
 * `update()`, `handleResize()`, `addEventListener('start'|'end'|'change')` and
 * `dispose()`.
 */
class ArcballController {
    /**
     * @param {any} camera THREE.PerspectiveCamera
     * @param {HTMLElement} domElement
     */
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.target = new THREE.Vector3();

        this.rotateSpeed = 1.0;
        this.zoomSpeed = 1.0;
        this.panSpeed = 1.0;
        this.minDistance = 1;
        this.maxDistance = Infinity;
        this.enabled = true;

        /** @type {Record<string, Array<() => void>>} */
        this._listeners = { start: [], end: [], change: [] };

        // The vendored three.js bundle is tree-shaken and does NOT export
        // `Quaternion` (or `Vector2`); only the camera's own `.quaternion`
        // instance is reachable. Clone it to mint fresh, identity quaternions.
        this._newQuat = () => camera.quaternion.clone().identity();

        // Rotation state. `_q0` is the camera orientation at mouse-down; the
        // live orientation while dragging is `_q0 · delta`, where `delta` is the
        // single arcball rotation from the current sphere-point to the anchor.
        this._q0 = this._newQuat();             // camera orientation at drag start
        this._anchor = new THREE.Vector3();     // sphere point under mouse-down

        this._mode = 0; // 0 none, 1 rotate, 2 pan
        this._rect = domElement.getBoundingClientRect();
        this._panStartX = 0;
        this._panStartY = 0;
        this._needsUpdate = false;

        // The viewer lives in a pop-up window, so listen on *that* window — the
        // module-global `window` is the opener and would never see the events.
        this._win = domElement.ownerDocument?.defaultView || window;

        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        this._onWheel = this._onWheel.bind(this);
        this._onContextMenu = (/** @type {Event} */ e) => e.preventDefault();

        domElement.addEventListener('pointerdown', this._onPointerDown);
        domElement.addEventListener('wheel', this._onWheel, { passive: false });
        domElement.addEventListener('contextmenu', this._onContextMenu);
    }

    /** @param {'start'|'end'|'change'} type @param {() => void} fn */
    addEventListener(type, fn) {
        (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    }

    /** @param {string} type */
    _emit(type) {
        for (const fn of this._listeners[type] || []) fn();
    }

    handleResize() {
        this._rect = this.domElement.getBoundingClientRect();
    }

    /**
     * Map a client point to a vector on the virtual arcball (unit sphere with a
     * hyperbolic-sheet falloff outside r=1, per Holroyd/Shoemake) in the
     * camera's eye space. Returns a normalised direction.
     * @param {number} clientX @param {number} clientY
     * @returns {THREE.Vector3}
     */
    _ballPoint(clientX, clientY) {
        const r = this._rect;
        const px = ((clientX - r.left) / r.width) * 2 - 1;
        const py = -(((clientY - r.top) / r.height) * 2 - 1);
        const v = new THREE.Vector3(px, py, 0);
        const len2 = px * px + py * py;
        if (len2 <= 1) {
            v.z = Math.sqrt(1 - len2);          // on the sphere
        } else {
            v.normalize();                       // hyperbolic sheet → rim
            v.z = 0;
        }
        return v;
    }

    /** @param {PointerEvent} e */
    _onPointerDown(e) {
        if (!this.enabled) return;
        this._rect = this.domElement.getBoundingClientRect();
        const pan = e.button === 2 || e.button === 1 || e.shiftKey;
        this._mode = pan ? 2 : 1;
        if (this._mode === 1) {
            this._q0.copy(this.camera.quaternion);
            this._anchor.copy(this._ballPoint(e.clientX, e.clientY));
        } else {
            this._panStartX = e.clientX;
            this._panStartY = e.clientY;
        }
        this.domElement.setPointerCapture?.(e.pointerId);
        this._win.addEventListener('pointermove', this._onPointerMove);
        this._win.addEventListener('pointerup', this._onPointerUp);
        this._emit('start');
    }

    /** @param {PointerEvent} e */
    _onPointerMove(e) {
        if (this._mode === 1) this._rotateTo(e.clientX, e.clientY);
        else if (this._mode === 2) this._panBy(e.clientX, e.clientY);
    }

    /** @param {PointerEvent} e */
    _onPointerUp(e) {
        this._mode = 0;
        this.domElement.releasePointerCapture?.(e.pointerId);
        this._win.removeEventListener('pointermove', this._onPointerMove);
        this._win.removeEventListener('pointerup', this._onPointerUp);
        this._emit('end');
    }

    /**
     * Absolute arcball rotation: orient the camera as `q0 · delta`, where
     * `delta` is the eye-space rotation taking the current sphere point back to
     * the mouse-down anchor (so the model follows the cursor). Because it is
     * always measured from the fixed anchor, never accumulated, looping the
     * mouse cannot drift.
     * @param {number} clientX @param {number} clientY
     */
    _rotateTo(clientX, clientY) {
        const cur = this._ballPoint(clientX, clientY);
        // Scale the swing angle for rotateSpeed by pushing `cur` further along
        // the great-circle arc from the anchor.
        if (this.rotateSpeed !== 1) {
            const dot = Math.max(-1, Math.min(1, this._anchor.dot(cur)));
            const ang = Math.acos(dot);
            if (ang > 1e-6) {
                const axis = new THREE.Vector3().crossVectors(this._anchor, cur).normalize();
                const q = this._newQuat().setFromAxisAngle(axis, ang * this.rotateSpeed);
                cur.copy(this._anchor).applyQuaternion(q);
            }
        }
        // Eye-space delta mapping current → anchor, applied in the camera's
        // local frame on top of the start orientation.
        const deltaEye = this._newQuat().setFromUnitVectors(cur, this._anchor);
        const q = this._q0.clone().multiply(deltaEye);
        const dist = this.camera.position.distanceTo(this.target);
        const offset = new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(dist);
        this.camera.position.copy(this.target).add(offset);
        // Carry the up-vector with the rotation. `update()` re-derives the
        // orientation with `lookAt(target)`, which uses `camera.up`; keeping up
        // rotated by q means lookAt reproduces this exact orientation — and,
        // because up stays perpendicular to the view direction, the board can
        // be flipped past the poles without the gimbal lock a fixed +Y up
        // (OrbitControls) imposes.
        this.camera.up.set(0, 1, 0).applyQuaternion(q);
        this.camera.quaternion.copy(q);
        this._needsUpdate = true;
        this._emit('change');
    }

    /**
     * Screen-space pan: shift both camera and target in the camera's right/up
     * plane so the grabbed point tracks the cursor.
     * @param {number} clientX @param {number} clientY
     */
    _panBy(clientX, clientY) {
        const dx = clientX - this._panStartX;
        const dy = clientY - this._panStartY;
        this._panStartX = clientX;
        this._panStartY = clientY;
        const dist = this.camera.position.distanceTo(this.target);
        const fov = (this.camera.fov * Math.PI) / 180;
        const worldPerPx = (2 * dist * Math.tan(fov / 2)) / this._rect.height;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        const move = right.multiplyScalar(-dx * worldPerPx * this.panSpeed)
            .add(up.multiplyScalar(dy * worldPerPx * this.panSpeed));
        this.camera.position.add(move);
        this.target.add(move);
        this._needsUpdate = true;
        this._emit('change');
    }

    /** @param {WheelEvent} e */
    _onWheel(e) {
        if (!this.enabled) return;
        e.preventDefault();
        const factor = Math.pow(0.95, this.zoomSpeed * (e.deltaY < 0 ? 1 : -1));
        const offset = this.camera.position.clone().sub(this.target);
        let dist = offset.length() * factor;
        dist = Math.max(this.minDistance, Math.min(this.maxDistance, dist));
        offset.setLength(dist);
        this.camera.position.copy(this.target).add(offset);
        this._needsUpdate = true;
        this._emit('start');
        this._emit('change');
        this._emit('end');
    }

    /** Keep the camera looking at the target; clamp distance. */
    update() {
        const offset = this.camera.position.clone().sub(this.target);
        let dist = offset.length();
        const clamped = Math.max(this.minDistance, Math.min(this.maxDistance, dist));
        if (clamped !== dist) {
            offset.setLength(clamped);
            this.camera.position.copy(this.target).add(offset);
        }
        this.camera.lookAt(this.target);
        this._needsUpdate = false;
        return true;
    }

    dispose() {
        this.domElement.removeEventListener('pointerdown', this._onPointerDown);
        this.domElement.removeEventListener('wheel', this._onWheel);
        this.domElement.removeEventListener('contextmenu', this._onContextMenu);
        this._win.removeEventListener('pointermove', this._onPointerMove);
        this._win.removeEventListener('pointerup', this._onPointerUp);
    }
}
import { STEPPreview } from '../../components/STEPPreview.js';
import { getComponentLibrary } from '../../components/index.js';
import { stringToPolylines, measureText } from './stroke-font.js';

/** Finished board thickness in millimetres (standard 1.6 mm). */
const BOARD_THICKNESS = 1.6;

/** Default body height (mm) for fallback component boxes with no STEP model. */
const FALLBACK_HEIGHT = 1.2;

/** Colours (0–255 RGB triplets). */
const COLOR_BOARD = [10, 130, 50];     // EasyEDA solder-mask green (top/bottom faces only)
const COLOR_BOARD_EDGE = [190, 192, 122]; // bare FR4 substrate (board edges, no mask)
const COLOR_COMPONENT = [40, 44, 52];  // dark IC body
const COLOR_FALLBACK = [70, 78, 90];   // generic part
const COLOR_PAD = [201, 164, 74];      // gold
// Tracks sit UNDER the solder mask in EasyEDA's 3D view, so they read as
// slightly-raised green ridges (the copper tints the mask a touch brighter),
// not the red/blue layer colours used in the flat 2D editor.
const COLOR_TRACK_TOP = [26, 165, 70];     // top trace under mask (brighter green)
const COLOR_TRACK_BOTTOM = [16, 142, 58];  // bottom trace under mask (slightly darker)
const COLOR_VIA = [184, 134, 11];          // gold plated barrel
const COLOR_HOLE = [12, 12, 16];           // dark drilled hole
const COLOR_SILK = [228, 228, 228];        // white silkscreen

/** Surface heights (world Y, mm) for the thin layers on each board face. */
const Y_TOP = BOARD_THICKNESS;             // top copper plane
const Y_BOT = 0;                           // bottom copper plane
const COPPER_EPS = 0.015;                  // copper sits just proud of the face
const SILK_EPS = 0.035;                    // silk sits just above the copper

/* ───────────────────────────── mesh builders ────────────────────────────── */

/**
 * Sample a rounded-rectangle outline into a closed point list (XZ plane).
 * @param {number} x0 @param {number} z0 left/top (mm)
 * @param {number} w @param {number} h size (mm)
 * @param {number} r corner radius (mm)
 * @returns {Array<{x:number,z:number}>}
 */
function roundedRectOutline(x0, z0, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r <= 0) {
        return [
            { x: x0, z: z0 },
            { x: x0 + w, z: z0 },
            { x: x0 + w, z: z0 + h },
            { x: x0, z: z0 + h },
        ];
    }
    const seg = 6; // points per corner arc
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
 * @returns {{verts: Array, faces: Array}}
 */
function extrudePrism(outline, yBottom, yTop, color, edgeColor) {
    const verts = [];
    const n = outline.length;
    for (const p of outline) verts.push({ x: p.x, y: yTop, z: p.z });     // 0..n-1 top
    for (const p of outline) verts.push({ x: p.x, y: yBottom, z: p.z });  // n..2n-1 bottom

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
function triangulateWithHoles(outerIn, holesIn) {
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
function cylinderWallMesh(cx, cz, r, yBottom, yTop, color, seg = 16) {
    const verts = [];
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

/**
 * Build the board slab with drilled holes bored clean through it, so plated
 * and mounting holes read as actual openings. Falls back to a solid prism if
 * the holes can't be triangulated (e.g. overlapping or off-board).
 * @param {Array<{x:number,z:number}>} outline
 * @param {Array<{x:number,z:number,r:number}>} holeList world-space holes
 * @param {number} yBottom @param {number} yTop
 * @param {number[]} color @param {number[]} edgeColor
 * @returns {{verts: Array, faces: Array}}
 */
function boardWithHoles(outline, holeList, yBottom, yTop, color, edgeColor) {
    if (!holeList.length) return extrudePrism(outline, yBottom, yTop, color, edgeColor);
    const seg = 16;
    const bores = mergeOverlappingHoles(holeList);
    const outer2d = outline.map((p) => ({ x: p.x, y: p.z }));
    const holes2d = bores.map((h) => {
        const ring = [];
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            ring.push({ x: h.x + h.r * Math.cos(a), y: h.z + h.r * Math.sin(a) });
        }
        return ring;
    });
    let tri = null;
    try { tri = triangulateWithHoles(outer2d, holes2d); } catch { tri = null; }
    if (!tri || !tri.tris.length) return extrudePrism(outline, yBottom, yTop, color, edgeColor);

    const mesh = emptyMesh();
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
    const wall = { verts: [], faces: [] };
    for (const p of outline) wall.verts.push({ x: p.x, y: yTop, z: p.z });
    for (const p of outline) wall.verts.push({ x: p.x, y: yBottom, z: p.z });
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        wall.faces.push({ idx: [i, j, n + j, n + i], color: side });
    }
    appendMesh(mesh, wall);
    // Inner walls lining each bore (FR4 substrate edge).
    for (const h of bores) {
        appendMesh(mesh, cylinderWallMesh(h.x, h.z, h.r, yBottom, yTop, side, seg));
    }
    return mesh;
}

/**
 * Convert a parsed STEP geometry into a renderer mesh, positioned for a
 * placement. The model is rotated about the vertical axis by the placement
 * rotation, translated to the placement origin, and dropped so its lowest
 * point rests on the board top surface.
 *
 * @param {{vertices:Array<{x:number,y:number,z:number}>, faces:number[][]}} geom
 * @param {{x:number,y:number,rotation?:number}} pl placement
 * @returns {{verts: Array, faces: Array}|null}
 */
function stepGeometryToMesh(geom, pl) {
    if (!geom?.vertices?.length || !geom.faces?.length) return null;

    // Find the model's minimum Z (its base) so it sits on the board.
    let minZ = Infinity;
    for (const v of geom.vertices) if (v.z < minZ) minZ = v.z;
    if (!isFinite(minZ)) minZ = 0;

    const theta = ((pl.rotation || 0) * Math.PI) / 180;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);

    const verts = geom.vertices.map((v) => {
        // Model board-plane axes (mx, my); height = mz.
        const rx = v.x * ct - v.y * st;
        const ry = v.x * st + v.y * ct;
        return {
            x: pl.x + rx,
            y: BOARD_THICKNESS + (v.z - minZ),
            z: pl.y + ry,
        };
    });

    const faces = geom.faces.map((f) => ({ idx: f, color: COLOR_COMPONENT }));
    return { verts, faces };
}

/**
 * Parse an EasyEDA/LCSC OBJ 3D model into vertices and per-face coloured
 * triangles. EasyEDA models are authored in millimetres with Z up and the
 * body centred on the footprint origin — the same convention as KiCad STEP.
 * Inline materials (`newmtl`/`Kd`/`usemtl`) provide per-region diffuse colour.
 *
 * @param {string} objText raw Wavefront OBJ text
 * @returns {{vertices:Array<{x:number,y:number,z:number}>, faces:Array<{idx:number[], color:number[]}>}|null}
 */
function parseObjModel(objText) {
    if (!objText) return null;
    /** @type {Array<{x:number,y:number,z:number}>} */
    const vertices = [];
    /** @type {Map<string, number[]|null>} material name → [r,g,b] 0-255 */
    const materials = new Map();
    /** @type {Array<{idx:number[], color:number[]}>} */
    const faces = [];
    let pendingMtl = null;
    let curColor = COLOR_COMPONENT;

    for (const raw of objText.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const sp = line.indexOf(' ');
        const kw = sp < 0 ? line : line.slice(0, sp);
        const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
        switch (kw) {
            case 'v': {
                const p = rest.split(/\s+/);
                vertices.push({ x: +p[0], y: +p[1], z: +p[2] });
                break;
            }
            case 'newmtl':
                pendingMtl = rest;
                if (!materials.has(pendingMtl)) materials.set(pendingMtl, null);
                break;
            case 'Kd':
                if (pendingMtl) {
                    const c = rest.split(/\s+/).map(Number);
                    materials.set(pendingMtl, [
                        Math.round((c[0] || 0) * 255),
                        Math.round((c[1] || 0) * 255),
                        Math.round((c[2] || 0) * 255),
                    ]);
                }
                break;
            case 'endmtl':
                pendingMtl = null;
                break;
            case 'usemtl':
                curColor = materials.get(rest) || COLOR_COMPONENT;
                break;
            case 'f': {
                const p = rest.split(/\s+/);
                const idx = p.map((tok) => parseInt(tok.split('/')[0], 10) - 1);
                if (idx.length < 3 || idx.some((i) => i < 0 || Number.isNaN(i))) break;
                // Fan-triangulate polygons (quads etc.).
                for (let i = 1; i + 1 < idx.length; i++) {
                    faces.push({ idx: [idx[0], idx[i], idx[i + 1]], color: curColor });
                }
                break;
            }
        }
    }
    if (!vertices.length || !faces.length) return null;
    return { vertices, faces };
}

/**
 * Transform a parsed OBJ model ({@link parseObjModel}) into a placed mesh.
 * Mirrors {@link stepGeometryToMesh} but preserves per-face material colour.
 *
 * @param {{vertices:Array<{x:number,y:number,z:number}>, faces:Array<{idx:number[], color:number[]}>}} parsed
 * @param {{x:number,y:number,rotation?:number,model3dPlacement?:{dx?:number,dy?:number,rotation?:number,z?:number}}} pl placement
 * @returns {{verts: Array, faces: Array, cull?: boolean}|null}
 */
function objModelToMesh(parsed, pl) {
    if (!parsed?.vertices?.length || !parsed.faces?.length) return null;

    // EasyEDA's c_origin (the model3dPlacement dx/dy target) is the model's
    // projected XY bounding-box centre, not its raw OBJ origin. Seat the model
    // by its XY bbox centre so an off-centre OBJ lands correctly — and so the
    // intrinsic Z rotation spins about that same centre (matching EasyEDA).
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
    const ocx = isFinite(minX) ? (minX + maxX) / 2 : 0;
    const ocy = isFinite(minY) ? (minY + maxY) / 2 : 0;

    // EasyEDA seats the model with an intrinsic Z rotation and an origin
    // offset relative to the footprint centroid (model3dPlacement). The
    // placement rotation orients the whole footprint on the board.
    const mp = pl.model3dPlacement || { dx: 0, dy: 0, rotation: 0, z: 0 };
    const angle = (((pl.rotation || 0) + (mp.rotation || 0)) * Math.PI) / 180;
    const ct = Math.cos(angle);
    const st = Math.sin(angle);

    // The model-origin offset rotates with the placement (not the model spin).
    const pr = ((pl.rotation || 0) * Math.PI) / 180;
    const pct = Math.cos(pr);
    const pst = Math.sin(pr);
    const ox = (mp.dx || 0) * pct - (mp.dy || 0) * pst;
    const oy = (mp.dx || 0) * pst + (mp.dy || 0) * pct;

    const verts = parsed.vertices.map((v) => {
        // The board plane maps model X->world X and model Y->world Z while
        // model Z becomes world Y (height). That axis swap is a reflection,
        // so the model Y must be negated to keep the part un-mirrored (text
        // readable) and align its asymmetric features with the footprint.
        // Subtract the OBJ XY bbox centre so the model seats on its centre.
        const mx = v.x - ocx;
        const my = -(v.y - ocy);
        const rx = mx * ct - my * st;
        const ry = mx * st + my * ct;
        return {
            x: pl.x + ox + rx,
            y: BOARD_THICKNESS + (mp.z || 0) + (v.z - minZ),
            z: pl.y + oy + ry,
        };
    });

    return { verts, faces: parsed.faces, cull: true };
}

/**
 * Build a fallback box mesh for a placement from its footprint bounds.
 * @param {{x:number,y:number,rotation?:number,bounds?:{x:number,y:number,width:number,height:number}}} pl
 * @returns {{verts: Array, faces: Array}}
 */
function fallbackBoxMesh(pl) {
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
    return extrudePrism(
        corners,
        BOARD_THICKNESS,
        BOARD_THICKNESS + FALLBACK_HEIGHT,
        COLOR_FALLBACK,
        COLOR_FALLBACK,
    );
}

/**
 * Build copper pads for a placement. SMD pads are flat shapes (disc for
 * round/oval, quad for rect) on their own face; through-hole pads are gold
 * annular rings on BOTH faces with an open bore (the board is bored to match),
 * so the drilled hole reads as a real opening.
 * @param {{x:number,y:number,rotation?:number,padOffsets?:Array}} pl
 * @returns {{verts: Array, faces: Array}}
 */
function padMesh(pl) {
    const rot = pl.rotation || 0;
    const theta = (rot * Math.PI) / 180;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const mesh = emptyMesh();
    for (const off of (pl.padOffsets || [])) {
        const w = plLocalToWorld(pl, off.dx, off.dy);
        const halfW = (off.width || 1) / 2;
        const halfH = (off.height || 1) / 2;
        if (off.drill > 0) {
            // Plated through-hole: shape-correct copper ring on each face +
            // barrel lining the bore (inner radius inset so it occludes the
            // board's FR4 edge).
            const ri = Math.max(0.05, off.drill / 2 - 0.02);
            const round = (off.shape === 'ellipse' || off.shape === 'oval')
                && Math.abs(halfW - halfH) < 1e-3;
            if (round) {
                const ro = Math.max(halfW, Math.max(0.05, ri + 0.05));
                appendMesh(mesh, tubeMesh(w.x, w.z, ri, ro,
                    Y_BOT - COPPER_EPS, Y_TOP + COPPER_EPS, COLOR_PAD, 16));
            } else {
                appendMesh(mesh, throughHolePadMesh(w.x, w.z, off.shape, halfW, halfH,
                    ct, st, ri, Y_BOT - COPPER_EPS, Y_TOP + COPPER_EPS, COLOR_PAD));
            }
            continue;
        }
        const bottom = off.layer === 'bottom';
        const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
        if (off.shape === 'ellipse' || off.shape === 'oval') {
            appendMesh(mesh, ellipseDiscMesh(w.x, w.z, halfW, halfH, ct, st, y, COLOR_PAD, 20));
        } else {
            const local = [
                { x: -halfW, z: -halfH }, { x: halfW, z: -halfH },
                { x: halfW, z: halfH }, { x: -halfW, z: halfH },
            ];
            const base = mesh.verts.length;
            for (const c of local) {
                mesh.verts.push({
                    x: w.x + (c.x * ct - c.z * st),
                    y,
                    z: w.z + (c.x * st + c.z * ct),
                });
            }
            mesh.faces.push({ idx: [base, base + 1, base + 2, base + 3], color: COLOR_PAD });
        }
    }
    return mesh;
}

/** Flat (optionally rotated) elliptical disc on a y-plane (round/oval pad). */
function ellipseDiscMesh(cx, cz, rx, rz, ct, st, y, color, seg = 20) {
    const verts = [{ x: cx, y, z: cz }];
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
 * @returns {{verts: Array, faces: Array}}
 */
function throughHolePadMesh(cx, cz, shape, halfW, halfH, ct, st, ri, yBottom, yTop, color) {
    const toWorld = (lx, lz) => ({ x: cx + lx * ct - lz * st, y: cz + lx * st + lz * ct });
    // Outer outline in the board plane (x, y(=world z)).
    const outline = [];
    if (shape === 'ellipse' || shape === 'oval') {
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
    // Round drill hole (rotation-invariant).
    const seg = 16;
    const hole = [];
    for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        hole.push({ x: cx + ri * Math.cos(a), y: cz + ri * Math.sin(a) });
    }
    let tri = null;
    try { tri = triangulateWithHoles(outline, [hole]); } catch { tri = null; }
    const mesh = emptyMesh();
    if (tri && tri.tris.length) {
        appendMesh(mesh, {
            verts: tri.pts.map((p) => ({ x: p.x, y: yTop, z: p.y })),
            faces: tri.tris.map((t) => ({ idx: [t[0], t[1], t[2]], color })),
        });
        appendMesh(mesh, {
            verts: tri.pts.map((p) => ({ x: p.x, y: yBottom, z: p.y })),
            faces: tri.tris.map((t) => ({ idx: [t[2], t[1], t[0]], color })),
        });
    }
    // Outer side wall around the pad outline.
    const wall = { verts: [], faces: [] };
    const n = outline.length;
    for (const p of outline) wall.verts.push({ x: p.x, y: yTop, z: p.y });
    for (const p of outline) wall.verts.push({ x: p.x, y: yBottom, z: p.y });
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        wall.faces.push({ idx: [i, j, n + j, n + i], color });
    }
    appendMesh(mesh, wall);
    // Inner barrel lining the bore.
    appendMesh(mesh, cylinderWallMesh(cx, cz, ri, yBottom, yTop, color, seg));
    return mesh;
}

/* ─────────────────── copper / via / hole / silk builders ─────────────────── */


/** A fresh empty `{verts, faces}` accumulator. */
function emptyMesh() {
    return { verts: [], faces: [] };
}

/** Append `src` mesh into `dst`, offsetting face indices. */
function appendMesh(dst, src) {
    const base = dst.verts.length;
    for (const v of src.verts) dst.verts.push(v);
    for (const f of src.faces) {
        dst.faces.push({ idx: f.idx.map((i) => i + base), color: f.color });
    }
}

/** Flat filled disc on the y-plane (used for round trace end-caps / pads). */
function discMesh(cx, cz, r, y, color, seg = 14) {
    const verts = [{ x: cx, y, z: cz }];
    for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        verts.push({ x: cx + r * Math.cos(a), y, z: cz + r * Math.sin(a) });
    }
    const faces = [];
    for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        faces.push({ idx: [0, 1 + i, 1 + j], color });
    }
    return { verts, faces };
}

/** Flat rectangle of the given width from A→B on the y-plane (a trace body). */
function ribbonMesh(ax, az, bx, bz, width, y, color) {
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

/** Flat annular ring band (silk circle outline) on the y-plane. */
function flatRingMesh(cx, cz, r, strokeWidth, y, color, seg = 28) {
    const ro = r + strokeWidth / 2;
    const ri = Math.max(0, r - strokeWidth / 2);
    const verts = [];
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

/** Hollow vertical tube (plated via/hole barrel) with annular end caps. */
function tubeMesh(cx, cz, rInner, rOuter, yBottom, yTop, color, seg = 18) {
    const verts = [];
    const faces = [];
    for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        verts.push({ x: cx + rOuter * c, y: yTop, z: cz + rOuter * s });    // +0 OT
        verts.push({ x: cx + rOuter * c, y: yBottom, z: cz + rOuter * s }); // +1 OB
        verts.push({ x: cx + rInner * c, y: yTop, z: cz + rInner * s });    // +2 IT
        verts.push({ x: cx + rInner * c, y: yBottom, z: cz + rInner * s }); // +3 IB
    }
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

/** Solid vertical cylinder (an un-plated/mounting hole plug). */
function cylinderMesh(cx, cz, r, yBottom, yTop, color, seg = 18) {
    const verts = [];
    const faces = [];
    const topC = verts.push({ x: cx, y: yTop, z: cz }) - 1;
    const botC = verts.push({ x: cx, y: yBottom, z: cz }) - 1;
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

/** Rotate a placement-local (dx, dy) offset into world (x, z). */
function plLocalToWorld(pl, lx, ly) {
    const t = ((pl.rotation || 0) * Math.PI) / 180;
    const ct = Math.cos(t), st = Math.sin(t);
    return { x: pl.x + (lx * ct - ly * st), z: pl.y + (lx * st + ly * ct) };
}

/**
 * Flatten an SVG path `d` string into a list of polylines (`{x,y}[]`).
 * Supports the commands ClearPCB silk emits: M/L/H/V/Z and C/Q béziers
 * (sampled to short chords). Mirrors the gerber exporter's flattener.
 * @param {string} d
 * @returns {Array<Array<{x:number,y:number}>>}
 */
function flattenSvgPath(d) {
    if (!d) return [];
    const tokens = d.match(/[a-zA-Z]|-?[0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?/g) || [];
    const polys = [];
    let poly = [];
    let x = 0, y = 0, sx = 0, sy = 0, i = 0;
    const num = () => parseFloat(tokens[i++]);
    const push = () => poly.push({ x, y });
    const isCmd = (tok) => /[a-zA-Z]/.test(tok);
    const bezier = (x0, y0, x1, y1, x2, y2, x3, y3, steps) => {
        for (let s = 1; s <= steps; s++) {
            const t = s / steps, u = 1 - t;
            poly.push({
                x: u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
                y: u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
            });
        }
    };
    // SVG elliptical arc (A/a) → sampled chords. Endpoint-to-centre
    // parameterisation per the SVG implementation notes (F.6.5).
    const arc = (x0, y0, rx, ry, phiDeg, largeArc, sweep, ex, ey) => {
        rx = Math.abs(rx); ry = Math.abs(ry);
        if (rx === 0 || ry === 0) { x = ex; y = ey; push(); return; }
        const phi = (phiDeg * Math.PI) / 180;
        const cp = Math.cos(phi), sp = Math.sin(phi);
        const dx = (x0 - ex) / 2, dy = (y0 - ey) / 2;
        const x1p = cp * dx + sp * dy;
        const y1p = -sp * dx + cp * dy;
        let rxs = rx * rx, rys = ry * ry;
        const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys;
        if (lambda > 1) {
            const sl = Math.sqrt(lambda);
            rx *= sl; ry *= sl; rxs = rx * rx; rys = ry * ry;
        }
        let denom = rxs * y1p * y1p + rys * x1p * x1p;
        let factor = Math.sqrt(Math.max(0, (rxs * rys - denom) / denom));
        if (largeArc === sweep) factor = -factor;
        const cxp = (factor * rx * y1p) / ry;
        const cyp = (-factor * ry * x1p) / rx;
        const cx = cp * cxp - sp * cyp + (x0 + ex) / 2;
        const cy = sp * cxp + cp * cyp + (y0 + ey) / 2;
        const ang = (ux, uy, vx, vy) => {
            const dot = ux * vx + uy * vy;
            const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
            let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
            if (ux * vy - uy * vx < 0) a = -a;
            return a;
        };
        const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry,
            (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
        else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
        const steps = Math.max(4, Math.ceil((Math.abs(dTheta) / (Math.PI * 2)) * 48));
        for (let s = 1; s <= steps; s++) {
            const th = theta1 + (dTheta * s) / steps;
            const ct = Math.cos(th), st = Math.sin(th);
            poly.push({
                x: cp * rx * ct - sp * ry * st + cx,
                y: sp * rx * ct + cp * ry * st + cy,
            });
        }
        x = ex; y = ey;
    };
    while (i < tokens.length) {
        let t = tokens[i++];
        if (!isCmd(t)) { i--; t = 'L'; }
        const rel = t === t.toLowerCase() && t !== 'Z' && t !== 'z';
        const c = t.toUpperCase();
        if (c === 'M') {
            if (poly.length) { polys.push(poly); poly = []; }
            x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num();
            sx = x; sy = y; push();
            while (i < tokens.length && !isCmd(tokens[i])) {
                x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); push();
            }
        } else if (c === 'L') {
            while (i < tokens.length && !isCmd(tokens[i])) {
                x = (rel ? x : 0) + num(); y = (rel ? y : 0) + num(); push();
            }
        } else if (c === 'H') {
            while (i < tokens.length && !isCmd(tokens[i])) { x = (rel ? x : 0) + num(); push(); }
        } else if (c === 'V') {
            while (i < tokens.length && !isCmd(tokens[i])) { y = (rel ? y : 0) + num(); push(); }
        } else if (c === 'Z') {
            x = sx; y = sy; push();
            polys.push(poly); poly = [];
        } else if (c === 'C') {
            while (i < tokens.length && !isCmd(tokens[i])) {
                const x1 = (rel ? x : 0) + num(), y1 = (rel ? y : 0) + num();
                const x2 = (rel ? x : 0) + num(), y2 = (rel ? y : 0) + num();
                const nx = (rel ? x : 0) + num(), ny = (rel ? y : 0) + num();
                bezier(x, y, x1, y1, x2, y2, nx, ny, 24); x = nx; y = ny;
            }
        } else if (c === 'Q') {
            while (i < tokens.length && !isCmd(tokens[i])) {
                const x1 = (rel ? x : 0) + num(), y1 = (rel ? y : 0) + num();
                const nx = (rel ? x : 0) + num(), ny = (rel ? y : 0) + num();
                const cx1 = x + (2 / 3) * (x1 - x), cy1 = y + (2 / 3) * (y1 - y);
                const cx2 = nx + (2 / 3) * (x1 - nx), cy2 = ny + (2 / 3) * (y1 - ny);
                bezier(x, y, cx1, cy1, cx2, cy2, nx, ny, 24); x = nx; y = ny;
            }
        } else if (c === 'A') {
            while (i < tokens.length && !isCmd(tokens[i])) {
                const rx = num(), ry = num(), rot = num();
                const large = num(), sweep = num();
                const ex = (rel ? x : 0) + num(), ey = (rel ? y : 0) + num();
                arc(x, y, rx, ry, rot, large !== 0, sweep !== 0, ex, ey);
            }
        } else {
            // Unsupported (S/T): skip its numeric args.
            while (i < tokens.length && !isCmd(tokens[i])) i++;
        }
    }
    if (poly.length) polys.push(poly);
    return polys;
}

/**
 * Build a mesh that strokes a list of 2D polylines as flat ribbons with
 * round joints on a single y-plane. `toWorld(px, py)` maps each polyline
 * point into world (x, z).
 * @param {Array<Array<{x:number,y:number}>>} polys
 * @param {number} strokeWidth @param {number} y @param {number[]} color
 * @param {(px:number, py:number) => {x:number,z:number}} toWorld
 * @returns {{verts:Array, faces:Array}}
 */
function strokePolysToMesh(polys, strokeWidth, y, color, toWorld) {
    const mesh = emptyMesh();
    const sw = strokeWidth > 0 ? strokeWidth : 0.15;
    for (const poly of polys) {
        if (!poly || poly.length === 0) continue;
        if (poly.length === 1) {
            const p = toWorld(poly[0].x, poly[0].y);
            appendMesh(mesh, discMesh(p.x, p.z, sw / 2, y, color, 12));
            continue;
        }
        for (let i = 1; i < poly.length; i++) {
            const a = toWorld(poly[i - 1].x, poly[i - 1].y);
            const b = toWorld(poly[i].x, poly[i].y);
            appendMesh(mesh, ribbonMesh(a.x, a.z, b.x, b.z, sw, y, color));
            appendMesh(mesh, discMesh(a.x, a.z, sw / 2, y, color, 12));
        }
        const last = poly[poly.length - 1];
        const lp = toWorld(last.x, last.y);
        appendMesh(mesh, discMesh(lp.x, lp.z, sw / 2, y, color, 12));
    }
    return mesh;
}

/**
 * Build one combined copper mesh from all routed Tracks. Each edge becomes a
 * flat ribbon on its layer's surface with round end-caps so joints look smooth.
 * @param {Array} tracks
 * @returns {{verts:Array, faces:Array}}
 */
function buildCopperMesh(tracks) {
    const mesh = emptyMesh();
    for (const track of tracks || []) {
        if (!track?.edges || !track?.nodes) continue;
        for (const [eid, e] of track.edges) {
            const a = track.nodes.get(e.from);
            const b = track.nodes.get(e.to);
            if (!a || !b) continue;
            const layer = track.getEdgeLayer ? track.getEdgeLayer(eid) : track.layer;
            const width = (track.getEdgeWidth ? track.getEdgeWidth(eid) : track.width) || 0.2;
            const bottom = layer === 'bottom-copper';
            const y = bottom ? Y_BOT - COPPER_EPS : Y_TOP + COPPER_EPS;
            const color = bottom ? COLOR_TRACK_BOTTOM : COLOR_TRACK_TOP;
            appendMesh(mesh, ribbonMesh(a.x, a.y, b.x, b.y, width, y, color));
            appendMesh(mesh, discMesh(a.x, a.y, width / 2, y, color, 10));
            appendMesh(mesh, discMesh(b.x, b.y, width / 2, y, color, 10));
        }
    }
    return mesh;
}

/**
 * Build one combined mesh for standalone vias. Each via is a gold annular pad
 * on both copper faces, a dark drilled centre, and a plated barrel through the
 * board — so it reads clearly from above (the bare barrel alone is buried in
 * the solid board and invisible).
 * @param {Array} vias
 * @returns {{verts:Array, faces:Array}}
 */
function buildViaMesh(vias) {
    const mesh = emptyMesh();
    const yTop = Y_TOP + COPPER_EPS;
    const yBot = Y_BOT - COPPER_EPS;
    for (const via of vias || []) {
        const ro = (via.diameter || 0.6) / 2;
        const ri = Math.max(Math.min((via.drill || 0.3) / 2, ro - 0.02), 0.02);
        // Plated barrel (visible from the side / through the hole).
        appendMesh(mesh, tubeMesh(via.x, via.y, ri, ro, yBot, yTop, COLOR_VIA, 16));
        // Gold annular pads proud of each face.
        appendMesh(mesh, discMesh(via.x, via.y, ro, yTop, COLOR_VIA, 18));
        appendMesh(mesh, discMesh(via.x, via.y, ro, yBot, COLOR_VIA, 18));
        // Dark drilled centre sitting just above the pads so the hole reads.
        appendMesh(mesh, discMesh(via.x, via.y, ri, yTop + 0.006, COLOR_HOLE, 14));
        appendMesh(mesh, discMesh(via.x, via.y, ri, yBot - 0.006, COLOR_HOLE, 14));
    }
    return mesh;
}

/**
 * Collect drilled-hole positions (plated pad drills + bare HOLE shapes) from
 * all component placements, in world board-plane coordinates. These are bored
 * clean through the board slab by {@link boardWithHoles}; plated holes are
 * additionally lined with a gold barrel by {@link padMesh}.
 * @param {Iterable<[string, object]>} placements
 * @returns {Array<{x:number,z:number,r:number,plated:boolean}>}
 */
function collectBoardHoles(placements) {
    const holes = [];
    for (const [, pl] of placements) {
        for (const off of pl.padOffsets || []) {
            if (!(off.drill > 0)) continue;
            const w = plLocalToWorld(pl, off.dx, off.dy);
            holes.push({ x: w.x, z: w.z, r: off.drill / 2, plated: true });
        }
        for (const s of pl.silks || []) {
            if (s.layer !== 'hole' || s.type !== 'circle' || !(s.r > 0)) continue;
            const w = plLocalToWorld(pl, s.cx, s.cy);
            holes.push({ x: w.x, z: w.z, r: s.r, plated: false });
        }
    }
    return holes;
}

/**
 * Build one combined silkscreen mesh (lines, circle outlines/fills and
 * flattened SVG paths) from all component placements, dropped onto the top
 * or bottom face as appropriate. Stroke-font text is handled separately by
 * {@link buildTextMesh}.
 * @param {Iterable<[string, object]>} placements
 * @returns {{verts:Array, faces:Array}}
 */
function buildSilkMesh(placements) {
    const mesh = emptyMesh();
    for (const [, pl] of placements) {
        for (const s of pl.silks || []) {
            const bottom = s.layer === 'bottom-silk';
            if (s.layer !== 'top-silk' && s.layer !== 'bottom-silk') continue;
            const y = bottom ? Y_BOT - SILK_EPS : Y_TOP + SILK_EPS;
            const sw = s.strokeWidth || 0.15;
            if (s.type === 'line') {
                const a = plLocalToWorld(pl, s.x1, s.y1);
                const b = plLocalToWorld(pl, s.x2, s.y2);
                appendMesh(mesh, ribbonMesh(a.x, a.z, b.x, b.z, sw, y, COLOR_SILK));
                appendMesh(mesh, discMesh(a.x, a.z, sw / 2, y, COLOR_SILK, 8));
                appendMesh(mesh, discMesh(b.x, b.z, sw / 2, y, COLOR_SILK, 8));
            } else if (s.type === 'circle' && s.r > 0) {
                const c = plLocalToWorld(pl, s.cx, s.cy);
                if (s.filled) {
                    appendMesh(mesh, discMesh(c.x, c.z, s.r, y, COLOR_SILK, 24));
                } else {
                    appendMesh(mesh, flatRingMesh(c.x, c.z, s.r, sw, y, COLOR_SILK, 28));
                }
            } else if (s.type === 'path' && s.d) {
                const polys = flattenSvgPath(s.d);
                appendMesh(mesh, strokePolysToMesh(
                    polys, sw, y, COLOR_SILK,
                    (px, py) => plLocalToWorld(pl, px, py)));
            }
        }
    }
    return mesh;
}

/**
 * Build one combined mesh of stroke-font text — free-standing PCB text
 * annotations plus component reference designators — as white silk strokes
 * (copper-coloured when the text lives on a copper layer).
 * @param {object} app PCBApp instance
 * @returns {{verts:Array, faces:Array}}
 */
function buildTextMesh(app) {
    const mesh = emptyMesh();

    // ── Free-standing text annotations (app.texts) ──────────────────────
    for (const [, t] of (app.texts || [])) {
        if (!t?.content) continue;
        const bottom = typeof t.layer === 'string' && t.layer.startsWith('bottom-');
        const copper = t.layer === 'top-copper' || t.layer === 'bottom-copper';
        const eps = copper ? COPPER_EPS : SILK_EPS;
        const y = bottom ? Y_BOT - eps : Y_TOP + eps;
        const color = copper ? (bottom ? COLOR_TRACK_BOTTOM : COLOR_TRACK_TOP) : COLOR_SILK;
        const mirror = bottom ? -1 : 1;
        const rad = (-(t.rotation || 0) * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        // Mirror local X (bottom side), rotate, then translate — matching
        // renderPcbText's `translate(x,y) rotate(-rot) scale(mirror,1)`.
        const toWorld = (px, py) => {
            const mx = px * mirror;
            return { x: t.x + mx * cos - py * sin, z: t.y + mx * sin + py * cos };
        };
        const polys = stringToPolylines(t.content, 0, 0, t.size || 1, false);
        appendMesh(mesh, strokePolysToMesh(polys, t.strokeWidth || 0.15, y, color, toWorld));
    }

    // ── Component reference designators (top silk) ──────────────────────
    for (const [, pl] of (app.placements || [])) {
        const ref = pl.reference;
        if (!ref) continue;
        const size = 0.9;
        const ob = pl.bounds;
        const labelW = measureText(ref, size);
        const tx = ob ? pl.x + ob.x + ob.width / 2 - labelW / 2 : pl.x - labelW / 2;
        const ty = ob ? pl.y + ob.y - 0.8 : pl.y - 2;
        const polys = stringToPolylines(ref, tx, ty, size, false);
        appendMesh(mesh, strokePolysToMesh(
            polys, 0.15, Y_TOP + SILK_EPS, COLOR_SILK,
            (px, py) => ({ x: px, z: py })));
    }

    return mesh;
}

/* ───────────────────────── mesh → BufferGeometry ─────────────────────────── */

/**
 * Convert one of our `{verts, faces}` meshes into a non-indexed
 * BufferGeometry with flat per-face vertex colours. Faces are fan-triangulated.
 * @param {{verts:Array<{x:number,y:number,z:number}>, faces:Array<{idx:number[], color:number[]}>}} mesh
 * @returns {THREE.BufferGeometry}
 */
function meshToGeometry(mesh) {
    const positions = [];
    const colors = [];
    const col = new THREE.Color();
    for (const f of mesh.faces) {
        const idx = f.idx;
        if (!idx || idx.length < 3) continue;
        const c = f.color || [128, 128, 128];
        // Our colours are authored in sRGB (0–255). three.js treats vertex
        // colours as linear and the renderer re-encodes to sRGB on output, so
        // uploading raw sRGB values double-brightens and desaturates them (the
        // "washed-out" look). Convert sRGB → linear here so they render true.
        col.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
        const r = col.r, g = col.g, b = col.b;
        for (let i = 1; i + 1 < idx.length; i++) {
            for (const vi of [idx[0], idx[i], idx[i + 1]]) {
                const v = mesh.verts[vi];
                if (!v) continue;
                positions.push(v.x, v.y, v.z);
                colors.push(r, g, b);
            }
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
}

/** Shared flat-shaded, vertex-coloured, double-sided material. */
function makeMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        side: THREE.DoubleSide,
        roughness: 0.62,
        metalness: 0.08,
    });
}

/**
 * Material for the bare board. A soft, mostly-matte solder mask: the overhead
 * point light pools into a gentle radial glow on the surface (EasyEDA style)
 * rather than a tight mirror glint, which also keeps shading cheap.
 */
function makeBoardMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: false,
        side: THREE.DoubleSide,
        roughness: 0.55,
        metalness: 0.0,
    });
}

/* ───────────────────────────── pop-up host ──────────────────────────────── */

/**
 * Build the pop-up document skeleton and return its canvas + status elements.
 * @param {Window} win
 */
function buildPopupDom(win) {
    const doc = win.document;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>ClearPCB — 3D View</title>
<style>
  html,body{margin:0;height:100%;background:#15181c;color:#e6e6e6;
    font:13px/1.4 system-ui,Segoe UI,sans-serif;overflow:hidden}
  #bar{position:absolute;top:0;left:0;right:0;height:38px;display:flex;
    align-items:center;gap:8px;padding:0 10px;background:rgba(20,23,27,.85);
    backdrop-filter:blur(4px);border-bottom:1px solid #2c3138;z-index:2}
  #bar button{background:#2c3138;color:#e6e6e6;border:1px solid #3a414a;
    border-radius:5px;padding:5px 10px;cursor:pointer;font-size:12px}
  #bar button:hover{background:#3a414a}
  #bar button.off{opacity:.5}
  #bar .sp{flex:1}
  #status{font-size:12px;color:#9aa3ad}
  #cv{position:absolute;inset:38px 0 0 0;width:100%;height:calc(100% - 38px);
    display:block;cursor:grab}
  #cv:active{cursor:grabbing}
  #hint{position:absolute;bottom:8px;left:10px;font-size:11px;color:#6b7480;
    z-index:2;pointer-events:none}
</style></head>
<body>
  <div id="bar">
    <strong>3D Board View</strong>
    <span id="status"></span>
    <span class="sp"></span>
    <button id="btnParts" title="Show/hide component parts">Parts</button>
    <button id="btnTop">Top</button>
    <button id="btnIso">Iso</button>
    <button id="btnFit">Fit</button>
  </div>
  <canvas id="cv"></canvas>
  <div id="hint">Drag to orbit · Right-drag to pan · Wheel to zoom</div>
</body></html>`);
    doc.close();
    return {
        canvas: /** @type {HTMLCanvasElement} */ (doc.getElementById('cv')),
        status: doc.getElementById('status'),
        btnParts: doc.getElementById('btnParts'),
        btnTop: doc.getElementById('btnTop'),
        btnIso: doc.getElementById('btnIso'),
        btnFit: doc.getElementById('btnFit'),
    };
}

/* ───────────────────────────── scene helper ─────────────────────────────── */

class ThreeScene {
    /**
     * @param {Window} win
     * @param {HTMLCanvasElement} canvas
     */
    constructor(win, canvas) {
        this.win = win;
        this.canvas = canvas;
        this.material = makeMaterial();
        this.boardMaterial = makeBoardMaterial();

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        // Two pixel-ratio tiers. Orbiting renders at the capped ratio (hi-DPI
        // displays otherwise draw 4× the pixels for no visible gain — the main
        // cause of sluggish dragging); the settled frame after interaction ends
        // renders at full device ratio so a stationary, zoomed-in view is crisp.
        this._dprActive = Math.min(win.devicePixelRatio || 1, 1.5);
        this._dprIdle = win.devicePixelRatio || 1;
        this.renderer.setPixelRatio(this._dprIdle);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x808286);

        this.camera = /** @type {any} */ (new THREE.PerspectiveCamera(45, 1, 0.1, 20000));
        this.camera.position.set(80, 120, 160);

        // Lighting: ambient gives a soft base fill; the key directional and the
        // point light both ride with the camera (see _updateLights) so the side
        // of the board facing the viewer is always the lit one. Ambient is kept
        // moderate so directional shading stays crisp and colours stay vivid (too
        // much flat fill washes the saturation out).
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
        this.key = /** @type {any} */ (new THREE.DirectionalLight(0xffffff, 0.7));
        this.scene.add(this.key);

        // Camera headlight: a point light pinned to the camera each frame. With
        // physical inverse-square decay it pools into a soft circular glow on
        // whichever face is toward the viewer (brightest at the centre of view,
        // fading outward) — the EasyEDA reflection look. Intensity is set from
        // the camera distance in _updateLights so the pool stays consistent.
        this.glint = /** @type {any} */ (new THREE.PointLight(0xffffff, 1.0, 0, 2));
        this.scene.add(this.glint);

        this.controls = new ArcballController(this.camera, this.renderer.domElement);
        // A true Shoemake arcball: free rotation (the board flips over the
        // poles and spins indefinitely, which OrbitControls' fixed up-vector
        // forbids) but with no drift — orientation is an absolute function of
        // the drag vector from the mouse-down anchor, so circling the mouse
        // returns to the same pose (unlike TrackballControls' accumulated
        // per-frame deltas).
        this.controls.rotateSpeed = 1.0;
        this.controls.zoomSpeed = 1.4;
        this.controls.panSpeed = 1.0;
        // Floor the zoom-in distance (set from board size in positionGlint) so
        // the camera can't push through the surface into the board/components.
        this.controls.minDistance = 5;

        /** @type {THREE.Group} */
        this.root = new THREE.Group();
        this.scene.add(this.root);

        // Render only while interacting: the controller applies motion in
        // update(), so a render loop runs between its 'start' and 'end' events
        // (drag/zoom/pan) and the viewer stays idle otherwise. One-off changes
        // (geometry added, resize, view buttons) use requestRender().
        this._renderScheduled = false;
        this._animating = false;
        this._renderOnce = this._renderOnce.bind(this);
        this._animate = this._animate.bind(this);
        this.controls.addEventListener('start', () => this._startAnimating());
        this.controls.addEventListener('end', () => this._stopAnimating());
        win.addEventListener('resize', () => {
            this._resize();
            this.controls.handleResize();
            this.requestRender();
        });
        this._resize();
        this.controls.handleResize();
        this.requestRender();
    }

    _resize() {
        const cv = this.canvas;
        const w = cv.clientWidth || 1;
        const h = cv.clientHeight || 1;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    /** Schedule a single render on the next animation frame (deduplicated). */
    requestRender() {
        if (this._renderScheduled || this.win.closed) return;
        this._renderScheduled = true;
        this.win.requestAnimationFrame(this._renderOnce);
    }

    _renderOnce() {
        this._renderScheduled = false;
        if (this.win.closed) return;
        this.controls.update();
        this._updateLights();
        this.renderer.render(this.scene, this.camera);
    }

    /** Begin the per-frame render loop (while the user is interacting). */
    _startAnimating() {
        if (this._animating) return;
        this._animating = true;
        // Drop to the capped pixel ratio for the duration of the interaction so
        // dragging stays smooth; the settled frame restores full resolution.
        if (this.renderer.getPixelRatio() !== this._dprActive) {
            this.renderer.setPixelRatio(this._dprActive);
            this._resize();
        }
        this.win.requestAnimationFrame(this._animate);
    }

    /** Stop the render loop and draw one final settled frame. */
    _stopAnimating() {
        this._animating = false;
        // Restore full device pixel ratio so the stationary view is crisp.
        if (this.renderer.getPixelRatio() !== this._dprIdle) {
            this.renderer.setPixelRatio(this._dprIdle);
            this._resize();
        }
        this.requestRender();
    }

    _animate() {
        if (!this._animating || this.win.closed) return;
        this.controls.update();
        this._updateLights();
        this.renderer.render(this.scene, this.camera);
        this.win.requestAnimationFrame(this._animate);
    }

    /**
     * Pin the headlight rig to the camera so the face toward the viewer is lit.
     * The light follows the view direction but is held at a minimum standoff
     * distance from the target: riding all the way in with the camera makes
     * near surfaces blow out (inverse-square falloff spikes as r→0), so when
     * zoomed in close the light stays back and the glow stays even. Intensity
     * tracks that standoff distance (illuminance ≈ I / r² ≈ constant).
     */
    _updateLights() {
        const target = this.controls.target;
        const cam = this.camera.position;
        const d = cam.distanceTo(target) || 1;
        const standoff = Math.max(d, this._glintMinDist || d);
        const dir = cam.clone().sub(target);
        if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
        dir.normalize();
        const pos = target.clone().addScaledVector(dir, standoff);
        this.glint.position.copy(pos);
        this.key.position.copy(pos);
        this.glint.intensity = standoff * standoff * 1.4;
    }

    /**
     * Configure the headlight pool for the board scale. The light rides with the
     * camera (see _updateLights) but never closer than this standoff distance,
     * so zooming into a component doesn't wash the scene out. Pure inverse-square
     * (distance 0) keeps a smooth, uncut pool.
     * @param {number} _x @param {number} _z @param {number} span board extent (mm)
     */
    positionGlint(_x, _z, span) {
        this.glint.distance = 0;
        this._glintMinDist = Math.max(40, span * 0.9);
        // Stop the camera before it reaches the surface: ~12% of the board span
        // keeps a close-up component in view without clipping into geometry.
        this.controls.minDistance = Math.max(6, span * 0.12);
        this._updateLights();
        this.requestRender();
    }

    /**
     * Add a mesh, returning the THREE.Mesh so callers can replace it later.
     * @param {{verts:Array, faces:Array}} mesh
     * @param {any} [material] optional material override
     * @returns {THREE.Mesh}
     */
    addMesh(mesh, material) {
        const m = new THREE.Mesh(meshToGeometry(mesh), material || this.material);
        this.root.add(m);
        this.requestRender();
        return m;
    }

    /**
     * Swap the geometry of an existing mesh in place.
     * @param {THREE.Mesh} obj
     * @param {{verts:Array, faces:Array}} mesh
     */
    replaceMesh(obj, mesh) {
        obj.geometry.dispose();
        obj.geometry = meshToGeometry(mesh);
        this.requestRender();
    }

    /** Frame the camera to fit the whole scene. */
    frameAll() {
        const box = new THREE.Box3().setFromObject(this.root);
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const radius = 0.5 * Math.hypot(size.x, size.y, size.z);
        const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 180 / 2)) * 1.15;
        const dir = this.camera.position.clone().sub(this.controls.target);
        if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.9, 1.2);
        dir.normalize();
        this.controls.target.copy(center);
        this.camera.position.copy(center).addScaledVector(dir, dist);
        this.camera.near = Math.max(0.05, dist / 1000);
        this.camera.far = dist * 10;
        this.camera.updateProjectionMatrix();
        this.controls.update();
        this.requestRender();
    }

    /**
     * Point the camera from a unit direction, then frame all.
     * @param {[number, number, number]} dir
     */
    setView(dir) {
        const center = this.controls.target.clone();
        this.camera.position.copy(center).add(new THREE.Vector3(dir[0], dir[1], dir[2]));
        this.frameAll();
    }
}

/* ───────────────────────────── public entry ─────────────────────────────── */

/**
 * Open the interactive 3D board visualiser in a pop-up window.
 * @param {any} app The PCBApp instance.
 */
export async function openBoard3DViewer(app) {
    const win = window.open('', 'clearpcb3d', 'width=960,height=720');
    if (!win) {
        app._setStatus?.('Pop-up blocked — allow pop-ups to use 3D view');
        return;
    }

    const dom = buildPopupDom(win);
    const scene = new ThreeScene(win, dom.canvas);

    // ── Board ───────────────────────────────────────────────────────────
    const w = app._boardWidth || 100;
    const h = app._boardHeight || 80;
    const r = app._boardRadius || 0;
    // PCB world: X∈[0,w], Z(=pcb y)∈[-h,0].
    const outline = roundedRectOutline(0, -h, w, h, r);
    // Bore drilled holes (plated pad drills + mounting holes) clean through the
    // slab so they read as real openings; only holes wholly inside the board.
    const boardHoles = collectBoardHoles(app.placements).filter((ho) =>
        ho.r > 0 && ho.x - ho.r > 0 && ho.x + ho.r < w &&
        ho.z - ho.r > -h && ho.z + ho.r < 0);
    const boardMesh = boardWithHoles(outline, boardHoles, 0, BOARD_THICKNESS,
        COLOR_BOARD, COLOR_BOARD_EDGE);
    scene.addMesh(boardMesh, scene.boardMaterial);
    scene.positionGlint(w / 2, -h / 2, Math.max(w, h));

    // ── Copper, vias and silkscreen ────────────────────────────────────
    // Each is one merged mesh so the whole board's traces/silk cost a single
    // draw call rather than one per feature. Drilled holes are bored into the
    // board slab above; plated pads line their bores in padMesh.
    const copper = buildCopperMesh(app.tracks);
    if (copper.faces.length) scene.addMesh(copper);
    const viaMesh = buildViaMesh(app.vias);
    if (viaMesh.faces.length) scene.addMesh(viaMesh);
    const silk = buildSilkMesh(app.placements);
    if (silk.faces.length) scene.addMesh(silk);
    const textMesh = buildTextMesh(app);
    if (textMesh.faces.length) scene.addMesh(textMesh);

    // ── Pads + component bodies (OBJ now, STEP lazily) ──────────────────
    const placements = [...app.placements.entries()];
    /** @type {Map<string, THREE.Mesh>} compId → its body mesh */
    const bodyMeshes = new Map();
    /** @type {Set<string>} compIds already resolved to a real model */
    const resolved = new Set();

    // All pads share the gold material and never move, so merge them into one
    // mesh: the whole board's copper pads cost a single draw call instead of
    // one per component (the dominant cost on dense boards). Component bodies
    // stay separate — they toggle and get swapped for lazy STEP models by id.
    const padsMesh = emptyMesh();
    for (const [id, pl] of placements) {
        appendMesh(padsMesh, padMesh(pl));
        // EasyEDA/LCSC parts carry an OBJ model on the placement — render it
        // immediately (it is already in memory, no network needed).
        let body = null;
        if (pl.model3dObj) {
            const parsed = parseObjModel(pl.model3dObj);
            body = parsed && objModelToMesh(parsed, pl);
            if (body) resolved.add(id);
        }
        bodyMeshes.set(id, scene.addMesh(body || fallbackBoxMesh(pl)));
    }
    if (padsMesh.faces.length) scene.addMesh(padsMesh);
    scene.frameAll();

    const setStatus = (text) => { if (dom.status && !win.closed) dom.status.textContent = text; };
    if (!placements.length) setStatus('No components placed');

    // ── View buttons ────────────────────────────────────────────────────
    dom.btnTop?.addEventListener('click', () => scene.setView([0, 1, 0.0001]));
    dom.btnIso?.addEventListener('click', () => scene.setView([0.7, 0.9, 1.1]));
    dom.btnFit?.addEventListener('click', () => scene.frameAll());

    // ── Parts toggle: show/hide every component body mesh ───────────────
    let partsVisible = true;
    dom.btnParts?.addEventListener('click', () => {
        partsVisible = !partsVisible;
        for (const mesh of bodyMeshes.values()) mesh.visible = partsVisible;
        dom.btnParts?.classList.toggle('off', !partsVisible);
        scene.requestRender();
    });

    // ── Lazily fetch KiCad STEP models per unique footprint ─────────────
    const fetcher = getComponentLibrary()?.kicadFetcher;
    if (!fetcher) {
        setStatus(placements.length
            ? `${placements.length} components · ${resolved.size} with 3D models`
            : 'No components placed');
        return;
    }

    /** @type {Map<string, Promise<{vertices:Array,faces:Array}|null>>} */
    const modelCache = new Map();
    const fetchModel = (footprint) => {
        if (modelCache.has(footprint)) return modelCache.get(footprint);
        const p = (async () => {
            try {
                const avail = await fetcher.checkFootprintAvailability(footprint);
                if (!avail?.has3d || !avail.modelUrl) return null;
                const url = fetcher.corsProxy
                    ? `${fetcher.corsProxy}${encodeURIComponent(avail.modelUrl)}`
                    : avail.modelUrl;
                const res = await fetch(url);
                if (!res.ok) return null;
                return STEPPreview.parse(await res.text());
            } catch (err) {
                console.warn('3D model fetch failed for', footprint, err);
                return null;
            }
        })();
        modelCache.set(footprint, p);
        return p;
    };

    let loaded = 0;
    let withModels = resolved.size;
    const total = placements.length;

    await Promise.all(placements.map(async ([id, pl]) => {
        if (win.closed) return;
        // OBJ models were resolved synchronously above; only fetch STEP for
        // KiCad footprints (namespaced as "Library:Footprint") that have none.
        const footprint = pl.footprint || '';
        if (!resolved.has(id) && footprint.includes(':')) {
            const geom = await fetchModel(footprint);
            const obj = bodyMeshes.get(id);
            if (!win.closed && geom && obj) {
                const mesh = stepGeometryToMesh(geom, pl);
                if (mesh) {
                    scene.replaceMesh(obj, mesh);
                    withModels++;
                }
            }
        }
        loaded++;
        setStatus(`${loaded}/${total} components · ${withModels} with 3D models`);
    }));

    setStatus(total
        ? `${total} components · ${withModels} with 3D models`
        : 'No components placed');
    if (!win.closed) scene.frameAll();
}
