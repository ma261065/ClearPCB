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

        // Solid-geometry keep-out volume (set via setBounds). The camera is
        // never allowed inside it, so panning/zooming can't punch through the
        // board slab or dive into a component — update() pushes the camera back
        // out to the nearest face each frame. `minDistance` alone can't prevent
        // this because it only limits distance-to-target, and panning moves the
        // whole rig (camera + target) together.
        /** @type {any} */
        this.boundingBox = null;

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
        // Resolve the window from the canvas's CURRENT document each time: the
        // canvas can be re-homed between the in-page panel and a torn-off pop-up
        // (document.adoptNode), so a window captured at construction would go
        // stale and miss pointer events in the other document.
        this._activeWin = this.domElement.ownerDocument?.defaultView || this._win;
        this._activeWin.addEventListener('pointermove', this._onPointerMove);
        this._activeWin.addEventListener('pointerup', this._onPointerUp);
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
        const win = this._activeWin || this._win;
        win.removeEventListener('pointermove', this._onPointerMove);
        win.removeEventListener('pointerup', this._onPointerUp);
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
        this._ejectFromBounds();
        this.camera.lookAt(this.target);
        this._needsUpdate = false;
        return true;
    }

    /**
     * Define the solid keep-out volume the camera may not enter (the board +
     * components bounding box). A small margin keeps the camera just clear of
     * surfaces. Pass null to disable.
     * @param {any} box THREE.Box3 in world space, or null
     * @param {number} [margin] outward expansion in mm
     */
    setBounds(box, margin = 0.5) {
        if (!box || box.isEmpty()) { this.boundingBox = null; return; }
        this.boundingBox = box.clone().expandByScalar(margin);
    }

    /**
     * If the camera sits inside the keep-out box, shove it out through the
     * nearest face. Run every frame from update() so pan/zoom/rotate feel like
     * they hit a solid wall at the board/component surface.
     */
    _ejectFromBounds() {
        const bb = this.boundingBox;
        const p = this.camera.position;
        if (!bb || !bb.containsPoint(p)) return;
        const dxMin = p.x - bb.min.x, dxMax = bb.max.x - p.x;
        const dyMin = p.y - bb.min.y, dyMax = bb.max.y - p.y;
        const dzMin = p.z - bb.min.z, dzMax = bb.max.z - p.z;
        const m = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
        if (m === dyMax) p.y = bb.max.y;
        else if (m === dyMin) p.y = bb.min.y;
        else if (m === dxMax) p.x = bb.max.x;
        else if (m === dxMin) p.x = bb.min.x;
        else if (m === dzMax) p.z = bb.max.z;
        else p.z = bb.min.z;
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
import { Board2D } from './board2d.js';

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
const COPPER_EPS = 0.015;                  // copper (tracks) sits just proud of the face
const PAD_EPS = 0.025;                      // pads sit just above the tracks (avoids
                                           // coplanar z-fight where a track overlaps a pad)
const SILK_EPS = 0.035;                    // silk sits just above the pads

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
                    Y_BOT - PAD_EPS, Y_TOP + PAD_EPS, COLOR_PAD, 16));
            } else {
                appendMesh(mesh, throughHolePadMesh(w.x, w.z, off.shape, halfW, halfH,
                    ct, st, ri, Y_BOT - PAD_EPS, Y_TOP + PAD_EPS, COLOR_PAD));
            }
            continue;
        }
        const bottom = off.layer === 'bottom';
        const y = bottom ? Y_BOT - PAD_EPS : Y_TOP + PAD_EPS;
        if (off.shape === 'oval') {
            // Stadium / obround (matches the 2D footprint render): straight
            // sides with semicircular ends, NOT a pointy ellipse.
            appendMesh(mesh, stadiumDiscMesh(w.x, w.z, halfW, halfH, ct, st, y, COLOR_PAD));
        } else if (off.shape === 'ellipse') {
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

/** Flat (optionally rotated) stadium/obround disc on a y-plane (oval pad). */
function stadiumDiscMesh(cx, cz, halfW, halfH, ct, st, y, color) {
    // Stadium = rounded rect with r = min(halfW, halfH), centred on origin.
    const local = roundedRectOutline(-halfW, -halfH, halfW * 2, halfH * 2, Math.min(halfW, halfH));
    const n = local.length;
    const verts = [{ x: cx, y, z: cz }];
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
 * @returns {{verts: Array, faces: Array}}
 */
function throughHolePadMesh(cx, cz, shape, halfW, halfH, ct, st, ri, yBottom, yTop, color) {
    const toWorld = (lx, lz) => ({ x: cx + lx * ct - lz * st, y: cz + lx * st + lz * ct });
    // Outer outline in the board plane (x, y(=world z)).
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

/** Signed area of a closed polygon in the x–z plane; its sign is the winding. */
function polygonAreaXZ(poly) {
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
function clipMeshToOutline(mesh, outline) {
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
 * convex polygon ring; every face triangle that overlaps a hole is replaced by
 * the convex pieces of `triangle \ holePolygon` (the standard convex-difference
 * decomposition: the part outside edge i but inside edges 0..i-1, unioned over
 * all edges). Triangles clear of every hole pass straight through.
 * @param {{verts:Array, faces:Array}} mesh flat planar mesh (constant-ish y)
 * @param {Array<{x:number,z:number,r:number}>} holes drilled holes (board plane)
 * @param {number} [seg] polygon segments per hole
 * @returns {{verts:Array, faces:Array}}
 */
function punchHolesInFlatMesh(mesh, holes, seg = 16) {
    if (!holes || !holes.length || !mesh.faces.length) return mesh;
    // Pre-build each hole as a CCW polygon ring in the (x, z) board plane.
    const rings = holes.filter((h) => h.r > 0).map((h) => {
        const pts = [];
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            pts.push({ x: h.x + h.r * Math.cos(a), z: h.z + h.r * Math.sin(a) });
        }
        return { pts, x: h.x, z: h.z, r: h.r };
    });
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
    // piece \ ringPoly → push the resulting convex sub-pieces onto `out`.
    const subtractRing = (piece, ring, out) => {
        const m = ring.pts.length;
        let inside = piece; // part still inside edges processed so far
        for (let i = 0; i < m; i++) {
            const P = ring.pts[i];
            const Q = ring.pts[(i + 1) % m];
            const outer = clipHalf(inside, P, Q, false);
            if (outer.length >= 3) out.push(outer);
            inside = clipHalf(inside, P, Q, true);
            if (inside.length < 3) return; // fully consumed by the hole
        }
        // Whatever remains `inside` every edge is the hole interior → dropped.
    };
    const overlapsCircle = (piece, ring) => {
        let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
        for (const p of piece) {
            if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
            if (p.z < minz) minz = p.z; if (p.z > maxz) maxz = p.z;
        }
        return !(minx > ring.x + ring.r || maxx < ring.x - ring.r ||
            minz > ring.z + ring.r || maxz < ring.z - ring.r);
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
                const next = [];
                for (const piece of pieces) {
                    if (overlapsCircle(piece, ring)) subtractRing(piece, ring, next);
                    else next.push(piece);
                }
                pieces = next;
                if (!pieces.length) break;
            }
            for (const piece of pieces) {
                for (let k = 1; k + 1 < piece.length; k++) {
                    emitTri({ ...piece[0] }, { ...piece[k] }, { ...piece[k + 1] }, f.color);
                }
            }
        }
    }
    return out;
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

/* ───────────────────────────── view host ────────────────────────────────── */

const CPCB3D_CSS = `
  .cpcb3d-host{position:relative;flex:1 1 0;min-width:0;min-height:0;
    overflow:hidden;background:#4a4c4f;color:#e6e6e6;
    font:13px/1.4 system-ui,Segoe UI,sans-serif}
  .cpcb3d-bar{position:absolute;top:0;left:0;right:0;height:38px;display:flex;
    align-items:center;gap:8px;padding:0 10px;background:rgba(20,23,27,.85);
    backdrop-filter:blur(4px);border-bottom:1px solid #2c3138;z-index:2}
  .cpcb3d-bar strong{font-size:13px}
  .cpcb3d-bar button{background:#2c3138;color:#e6e6e6;border:1px solid #3a414a;
    border-radius:5px;padding:5px 10px;cursor:pointer;font-size:12px}
  .cpcb3d-bar button:hover{background:#3a414a}
  .cpcb3d-bar button.off{opacity:.5}
  .cpcb3d-bar .cpcb3d-sp{flex:1}
  .cpcb3d-status{font-size:12px;color:#9aa3ad}
  .cpcb3d-cv{position:absolute;inset:38px 0 0 0;width:100%;height:calc(100% - 38px);
    display:block;cursor:grab;background:#4a4c4f}
  .cpcb3d-cv:active{cursor:grabbing}
  /* Flat 2D board preview canvas (board2d.js). Shares the host with the WebGL
     canvas; only one is shown at a time depending on the active view. */
  .cpcb3d-cv2d{position:absolute;inset:38px 0 0 0;width:100%;height:calc(100% - 38px);
    display:none;cursor:grab;background:#4a4c4f}
  .cpcb3d-cv2d:active{cursor:grabbing}
  .cpcb3d-host.cpcb3d-mode2d .cpcb3d-cv{display:none}
  .cpcb3d-host.cpcb3d-mode2d .cpcb3d-cv2d{display:block}
  /* The Top/Bottom side buttons are 2D-only; Parts/Top/Iso are 3D-only. */
  [data-act="2dtop"],[data-act="2dbottom"]{display:none}
  .cpcb3d-host.cpcb3d-mode2d [data-act="parts"],
  .cpcb3d-host.cpcb3d-mode2d [data-act="top"],
  .cpcb3d-host.cpcb3d-mode2d [data-act="iso"]{display:none}
  .cpcb3d-host.cpcb3d-mode2d [data-act="2dtop"],
  .cpcb3d-host.cpcb3d-mode2d [data-act="2dbottom"]{display:inline-block}
  .cpcb3d-bar [data-act="2dtop"].active,
  .cpcb3d-bar [data-act="2dbottom"].active{
    background:#2d7dd2;border-color:#2d7dd2;color:#fff}
  /* Opaque cover painted from the first frame so the canvas's black pre-render
     frames never show; fades once the board has actually rendered. */
  .cpcb3d-cover{position:absolute;inset:0;background:#4a4c4f;z-index:10;
    pointer-events:none;transition:opacity .18s linear}
  .cpcb3d-cover.hide{opacity:0}
  .cpcb3d-hint{position:absolute;bottom:8px;left:10px;font-size:11px;color:#6b7480;
    z-index:2;pointer-events:none}
  .cpcb3d-spinner{position:absolute;inset:38px 0 0 0;display:none;
    flex-direction:column;align-items:center;justify-content:center;gap:14px;
    z-index:3;background:rgba(21,24,28,.55);color:#cfd6de;font-size:13px;
    pointer-events:none}
  .cpcb3d-spinner.show{display:flex}
  .cpcb3d-spinner .cpcb3d-ring{width:38px;height:38px;border-radius:50%;
    border:3px solid #3a414a;border-top-color:#5aa9ff;
    animation:cpcb-spin .8s linear infinite}
  @keyframes cpcb-spin{to{transform:rotate(360deg)}}
  /* Drag divider between the PCB editor and the 3D panel. */
  .cpcb3d-splitter{flex:0 0 6px;cursor:col-resize;background:#23262b;
    border-left:1px solid #2c3138;border-right:1px solid #2c3138;z-index:5}
  .cpcb3d-splitter:hover{background:#3a414a}
  /* Docked = a floating overlay pinned to the right of the editor area. The
     PCB editor pane underneath keeps its full width and never reflows; the
     panel simply covers the right portion of it. */
  .cpcb3d-host.cpcb3d-docked{position:absolute;top:0;right:0;bottom:0;
    flex:none;z-index:6}
  .cpcb3d-splitter.cpcb3d-docked{position:absolute;top:0;bottom:0;width:6px;
    flex:none;z-index:7}
  /* Slide in/out as a GPU-composited transform (same technique as the
     schematic/PCB editor slider): only translateX is animated, so nothing
     re-rasterises per frame and the editor underneath is untouched. */
  .cpcb3d-host.cpcb3d-sliding{transition:transform .35s ease;will-change:transform}
`;

/**
 * Inject the shared 3D-view stylesheet into a document once.
 * @param {Document} doc
 */
function ensure3DStyles(doc) {
    if (doc.getElementById('cpcb3d-styles')) return;
    const style = doc.createElement('style');
    style.id = 'cpcb3d-styles';
    style.textContent = CPCB3D_CSS;
    (doc.head || doc.documentElement).appendChild(style);
}

/**
 * Build the 3D-view host element (bar + canvas + overlays) inside a document.
 * The same host can live in-page (split panel) or be adopted into a torn-off
 * pop-up window, so it is a self-contained element tree, not a whole document.
 * @param {Document} doc
 * @returns {{host:HTMLElement, canvas:HTMLCanvasElement, status:HTMLElement,
 *   spinner:HTMLElement, cover:HTMLElement, btnParts:HTMLElement,
 *   btnTop:HTMLElement, btnIso:HTMLElement, btnFit:HTMLElement,
 *   btn2dTop:HTMLElement, btn2dBottom:HTMLElement, btnPop:HTMLElement}}
 */
function build3DHost(doc) {
    ensure3DStyles(doc);
    const host = doc.createElement('div');
    host.className = 'cpcb3d-host';
    host.innerHTML = `
  <div class="cpcb3d-bar">
    <button data-act="parts" title="Show/hide component parts">Parts</button>
    <button data-act="top">Top</button>
    <button data-act="iso">Iso</button>
    <button data-act="2dtop" title="Show the top of the board">Top</button>
    <button data-act="2dbottom" title="Show the bottom of the board">Bottom</button>
    <button data-act="fit">Fit</button>
    <button data-act="pop" title="Pop out to a separate window">⇱ Pop out</button>
    <span class="cpcb3d-sp"></span>
    <span class="cpcb3d-status"></span>
  </div>
  <canvas class="cpcb3d-cv"></canvas>
  <canvas class="cpcb3d-cv2d"></canvas>
  <div class="cpcb3d-spinner"><div class="cpcb3d-ring"></div><div>Loading…</div></div>
  <div class="cpcb3d-hint">Drag to orbit · Right-drag to pan · Wheel to zoom</div>
  <div class="cpcb3d-cover"></div>`;
    const q = (/** @type {string} */ sel) => /** @type {any} */ (host.querySelector(sel));
    return {
        host,
        canvas: q('.cpcb3d-cv'),
        canvas2d: q('.cpcb3d-cv2d'),
        status: q('.cpcb3d-status'),
        spinner: q('.cpcb3d-spinner'),
        cover: q('.cpcb3d-cover'),
        btnParts: q('[data-act="parts"]'),
        btnTop: q('[data-act="top"]'),
        btnIso: q('[data-act="iso"]'),
        btn2dTop: q('[data-act="2dtop"]'),
        btn2dBottom: q('[data-act="2dbottom"]'),
        btnFit: q('[data-act="fit"]'),
        btnPop: q('[data-act="pop"]'),
        hint: q('.cpcb3d-hint'),
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

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true,
            logarithmicDepthBuffer: true });
        // Two pixel-ratio tiers. Orbiting renders at the capped ratio (hi-DPI
        // displays otherwise draw 4× the pixels for no visible gain — the main
        // cause of sluggish dragging); the settled frame after interaction ends
        // renders at full device ratio so a stationary, zoomed-in view is crisp.
        this._dprActive = Math.min(win.devicePixelRatio || 1, 1.5);
        this._dprIdle = win.devicePixelRatio || 1;
        this.renderer.setPixelRatio(this._dprIdle);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        // Clear to the board grey, not the WebGL default black, so any frame the
        // canvas presents before the first scene render (or any uncovered moment)
        // is grey rather than a black flash.
        this.renderer.setClearColor(0x4a4c4f, 1);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x4a4c4f);

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
        this._disposed = false;
        this._renderOnce = this._renderOnce.bind(this);
        this._animate = this._animate.bind(this);
        this.controls.addEventListener('start', () => this._startAnimating());
        this.controls.addEventListener('end', () => this._stopAnimating());
        // Observe the canvas itself rather than a window 'resize' event: the
        // canvas resizes both when the in-page split divider is dragged AND when
        // a torn-off pop-up window is resized, and a ResizeObserver fires for
        // either regardless of which document the canvas currently lives in.
        this._ro = new ResizeObserver(() => {
            if (this._disposed) return;
            this._resize();
            this.controls.handleResize();
            this.requestRender();
        });
        this._ro.observe(this.canvas);
        // Moving the canvas between documents (in-page panel ⇄ torn-off pop-up)
        // can drop the WebGL context on some browsers. Allow the browser to
        // restore it, then re-upload by drawing again — three.js re-initialises
        // its GL state on the next render after a restore.
        this.canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
        this.canvas.addEventListener('webglcontextrestored', () => {
            if (this._disposed) return;
            this.resize();
            this.requestRender();
        });
        this._resize();
        this.controls.handleResize();
        // Render the (empty) grey scene synchronously now so the opaque WebGL
        // canvas presents grey on its very first composite — without this the
        // canvas can flash black/white in the gap before the first async frame.
        this.renderer.render(this.scene, this.camera);
        this.requestRender();
    }

    /** Recompute the canvas/camera for the current host size. */
    resize() {
        this._resize();
        this.controls.handleResize();
        this.requestRender();
    }

    /** Tear down the render loop, observers and GL context. */
    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._animating = false;
        try { this._ro?.disconnect(); } catch { /* ignore */ }
        try { this.controls?.dispose?.(); } catch { /* ignore */ }
        try { this.renderer?.dispose?.(); } catch { /* ignore */ }
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
        if (this._renderScheduled || this._disposed) return;
        this._renderScheduled = true;
        this._raf(this._renderOnce);
    }

    /**
     * Request an animation frame from the window that currently hosts the
     * canvas. When the view is torn off into a pop-up, the main window can be
     * occluded (e.g. the pop-up is maximised over it) and the browser throttles
     * or pauses its rAF — which would freeze the loop if it stayed pinned to the
     * main window. The host window (canvas's owner document) is the visible one,
     * so its rAF keeps firing.
     * @param {FrameRequestCallback} cb
     */
    _raf(cb) {
        const w = this.canvas.ownerDocument?.defaultView || this.win;
        w.requestAnimationFrame(cb);
    }

    _renderOnce() {
        this._renderScheduled = false;
        if (this._disposed) return;
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
        this._raf(this._animate);
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
        if (!this._animating || this._disposed) return;
        this.controls.update();
        this._updateLights();
        this.renderer.render(this.scene, this.camera);
        this._raf(this._animate);
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

    /**
     * Remove a mesh from the scene and free its geometry.
     * @param {THREE.Mesh|null|undefined} obj
     */
    removeMesh(obj) {
        if (!obj) return;
        this.root.remove(obj);
        obj.geometry?.dispose();
        this.requestRender();
    }

    /** Frame the camera to fit the whole scene. */
    frameAll() {
        const box = new THREE.Box3().setFromObject(this.root);
        if (box.isEmpty()) return;
        // The fitted scene box doubles as the camera keep-out volume so pan/zoom
        // can't end up inside the board or a component.
        this.controls.setBounds(box);
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
 * Open the interactive 3D board visualiser as a 50:50 split panel beside the
 * PCB editor. The panel can be popped out into a separate window and docked
 * back again, carrying its live WebGL view with it.
 * @param {any} app The PCBApp instance.
 * @param {{view?: '3d'|'top'|'bottom'}} [opts] Initial view; defaults to 3D.
 */
export async function openBoard3DViewer(app, opts = {}) {
    const initialView = opts.view || '3d';
    // Single instance: re-opening shows a hidden panel, focuses a popped-out
    // window, or is otherwise a no-op.
    if (app._board3d && !app._board3d.closed) {
        if (app._board3d.hidden) app._board3d.show?.();
        else if (app._board3d.mode === 'popped') app._board3d.popWin?.focus();
        app._board3d.setView?.(initialView);
        return;
    }

    const pcbContainer = document.getElementById('pcbCanvasContainer');
    const mainContainer = pcbContainer?.parentElement;
    if (!pcbContainer || !mainContainer) {
        app._setStatus?.('Cannot open 3D view — editor not ready');
        return;
    }

    // ── Mount the host as a floating overlay over the right of the editor ─
    const dom = build3DHost(document);
    const host = dom.host;
    const splitter = document.createElement('div');
    splitter.className = 'cpcb3d-splitter';
    mainContainer.appendChild(splitter);
    mainContainer.appendChild(host);
    // The host is positioned absolutely within this container, so it must be a
    // positioned ancestor (harmless to leave relative permanently).
    if (!mainContainer.style.position) mainContainer.style.position = 'relative';
    pcbContainer.style.flex = '1 1 0';
    host.classList.add('cpcb3d-docked');
    splitter.classList.add('cpcb3d-docked');

    // ── Overlay layout ───────────────────────────────────────────────────
    // The panel covers the right `panelPct`% of the editor area; the PCB pane
    // underneath keeps its full width and never resizes. Stored as a percentage
    // so the ratio survives window resizes.
    let panelPct = 50;
    const applyDockLayout = () => {
        host.style.width = `${panelPct}%`;
        splitter.style.right = `${panelPct}%`;
    };
    applyDockLayout();

    // ── Slide helpers (GPU transform — same feel as the editor slider) ───
    // The docked host is already an absolute overlay, so opening/closing only
    // animates its translateX. The editor underneath is never touched.
    let slideTimer = 0;
    const slideIn = (/** @type {(()=>void)=} */ onDone) => {
        if (slideTimer) { window.clearTimeout(slideTimer); slideTimer = 0; }
        host.style.display = '';
        splitter.style.display = 'none';
        applyDockLayout();
        host.classList.add('cpcb3d-sliding');
        host.style.transition = 'none';
        host.style.transform = 'translateX(100%)';
        void host.offsetWidth;
        host.style.transition = '';
        host.style.transform = 'translateX(0)';
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            host.removeEventListener('transitionend', finish);
            host.classList.remove('cpcb3d-sliding');
            host.style.transition = '';
            host.style.transform = '';
            splitter.style.display = '';
            onDone?.();
        };
        host.addEventListener('transitionend', finish);
        slideTimer = window.setTimeout(finish, 420);
    };
    const slideOut = (/** @type {(()=>void)=} */ onDone) => {
        if (slideTimer) { window.clearTimeout(slideTimer); slideTimer = 0; }
        splitter.style.display = 'none';
        host.classList.add('cpcb3d-sliding');
        host.style.transition = 'none';
        host.style.transform = 'translateX(0)';
        void host.offsetWidth;
        host.style.transition = '';
        host.style.transform = 'translateX(100%)';
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            host.removeEventListener('transitionend', finish);
            host.classList.remove('cpcb3d-sliding');
            host.style.transition = '';
            host.style.transform = '';
            onDone?.();
        };
        host.addEventListener('transitionend', finish);
        slideTimer = window.setTimeout(finish, 420);
    };

    // Slide the panel in.
    slideIn();

    /** @type {any} */
    const panel = { mode: 'docked', popWin: null, closed: false, hidden: false, scene: null, view: initialView };
    app._board3d = panel;
    app._update3DButtonState?.();

    // ── Split-divider drag ───────────────────────────────────────────────
    // Resizes only the overlay panel; the PCB editor underneath is unaffected.
    let dragging = false;
    const onSplitMove = (/** @type {PointerEvent} */ e) => {
        if (!dragging) return;
        const rect = mainContainer.getBoundingClientRect();
        let pct = ((rect.right - e.clientX) / rect.width) * 100;
        pct = Math.max(20, Math.min(80, pct));
        panelPct = pct;
        applyDockLayout();
        panel.scene?.resize();
        if (panel.view === 'top' || panel.view === 'bottom') board2d?.resize();
    };
    const onSplitUp = (/** @type {PointerEvent} */ e) => {
        if (!dragging) return;
        dragging = false;
        splitter.releasePointerCapture?.(e.pointerId);
    };
    splitter.addEventListener('pointerdown', (e) => {
        dragging = true;
        splitter.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    });
    window.addEventListener('pointermove', onSplitMove);
    window.addEventListener('pointerup', onSplitUp);

    // ── Spinner / cover (the 3D build blocks the thread; armed in ensure3D) ─
    let startedAt = 0;
    let spinnerShown = false;
    let lastYieldAt = 0;
    let spinnerTimer = 0;
    const nextFrame = () =>
        new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
    const revealSpinner = () => {
        if (!panel.closed && !spinnerShown) {
            dom.spinner?.classList.add('show');
            spinnerShown = true;
        }
    };
    const hideSpinner = () => {
        window.clearTimeout(spinnerTimer);
        if (!panel.closed) dom.spinner?.classList.remove('show');
    };
    const checkpoint = async () => {
        if (panel.closed) return;
        const now = performance.now();
        if (!spinnerShown && now - startedAt > 1000) revealSpinner();
        // Yield on a fixed cadence regardless of whether the spinner is showing
        // yet: the first second of the build would otherwise run without ever
        // releasing the main thread, so a hide/close click during that window
        // sat queued until the build paused (the panel felt unresponsive to
        // close while it was still loading). Yielding every ~50ms keeps input
        // — including the hide button — responsive throughout the build.
        if (now - lastYieldAt > 50) {
            await nextFrame();
            lastYieldAt = performance.now();
        }
    };

    // ── Lazy 3D state ───────────────────────────────────────────────────
    // The WebGL scene and every board surface/body are built only when the 3D
    // view is first shown (see ensure3D). Opening straight into a flat 2D view
    // therefore pays no 3D cost — no GL context, no surface meshing, no STEP
    // fetch. These are forward-declared so the shared panel handlers (sync,
    // dock, pop-out, parts toggle, …) can reference them before the build runs.
    /** @type {ThreeScene|null} */
    let scene = null;
    let build3DStarted = false;
    /** @type {Map<string, THREE.Mesh>} compId → body mesh */
    const bodyMeshes = new Map();
    let partsVisible = true;
    let rebuildSurfaces = () => {};
    let syncBodies = () => {};
    const setStatus = (/** @type {string} */ text) => {
        if (dom.status && !panel.closed) dom.status.textContent = text;
    };

    // ── Flat 2D board preview (board2d.js) ──────────────────────────────
    // The 2D side views do NOT use the 3D renderer: they draw the board the way
    // the Gerber exporter builds its layers (copper / pads / vias / silk),
    // straight to a 2D canvas. Created lazily the first time a 2D view shows.
    /** @type {import('./board2d.js').Board2D|null} */
    let board2d = null;
    const boardData = () => ({
        placements: app.placements,
        tracks: app.tracks,
        vias: app.vias,
        texts: [...(app.texts?.values?.() || [])],
        boardX: app._boardX || 0,
        boardY: app._boardY || 0,
        boardWidth: app._boardWidth,
        boardHeight: app._boardHeight,
        boardRadius: app._boardRadius,
    });
    const ensureBoard2D = () => {
        if (!board2d) board2d = new Board2D(dom.canvas2d);
        return board2d;
    };

    // ── View mode (3D ⇄ flat 2D top/bottom) ─────────────────────────────
    // One shared sliding panel hosts both views; `panel.view` decides which
    // canvas (WebGL vs 2D) is shown and which toolbar button is highlighted.
    const applyView = (/** @type {'3d'|'top'|'bottom'} */ view) => {
        panel.view = view;
        if (view === 'top' || view === 'bottom') {
            host.classList.add('cpcb3d-mode2d');
            // The 2D canvas paints instantly; drop the grey 3D cover/spinner.
            dom.cover?.classList.add('hide');
            hideSpinner();
            const b2 = ensureBoard2D();
            b2.setSide(view);
            b2.setData(boardData());
            b2.resize();
            b2.fit();
            dom.btn2dTop?.classList.toggle('active', view === 'top');
            dom.btn2dBottom?.classList.toggle('active', view === 'bottom');
            if (dom.hint) dom.hint.textContent = 'Drag to pan · Wheel to zoom';
        } else {
            host.classList.remove('cpcb3d-mode2d');
            // Show the grey cover only while the 3D scene is being built for the
            // first time, so a 2D→3D switch on an already-built scene doesn't
            // flash grey over the live view.
            if (!build3DStarted) dom.cover?.classList.remove('hide');
            ensure3D();
            scene?.resize();
            scene?.requestRender();
            if (dom.hint) dom.hint.textContent =
                'Drag to orbit · Right-drag to pan · Wheel to zoom';
        }
        app._update3DButtonState?.();
    };
    panel.setView = applyView;

    // ── Lazy 3D build ───────────────────────────────────────────────────
    // Runs once, the first time the 3D view is shown. Creates the WebGL scene,
    // builds every board surface, then streams component bodies + STEP models.
    const ensure3D = () => {
        if (build3DStarted) return;
        build3DStarted = true;

        // The render loop schedules its frames on whichever window currently
        // hosts the canvas (see ThreeScene._raf), so tearing the view into a
        // pop-up keeps it animating even when that pop-up is maximised over
        // (and throttles) the main window. The scene runs on this JS thread.
        scene = new ThreeScene(window, dom.canvas);
        panel.scene = scene;

    // ── Model fetching (KiCad STEP, cached per footprint) ───────────────
    const fetcher = getComponentLibrary()?.kicadFetcher;
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

    // ── Reusable surface builders (initial build + live re-sync) ────────
    // Each is one merged, single-draw-call mesh kept by handle so a live edit
    // can swap it without disturbing the camera or the component bodies. Every
    // surface is clipped to the board outline so copper/via/silk/text/pads that
    // overhang the edge are trimmed at the boundary rather than floating.
    /** @type {{board:THREE.Mesh|null,copper:THREE.Mesh|null,via:THREE.Mesh|null,silk:THREE.Mesh|null,text:THREE.Mesh|null,pads:THREE.Mesh|null}} */
    const surf = { board: null, copper: null, via: null, silk: null, text: null, pads: null };
    let outline = null;
    const swapSurface = (/** @type {string} */ key, /** @type {any} */ data) => {
        scene.removeMesh(surf[key]);
        surf[key] = data && data.faces.length ? scene.addMesh(data) : null;
    };
    rebuildSurfaces = () => {
        const w = app._boardWidth || 100;
        const h = app._boardHeight || 80;
        const r = app._boardRadius || 0;
        // PCB world: X∈[0,w], Z(=pcb y)∈[-h,0].
        outline = roundedRectOutline(0, -h, w, h, r);
        // Bore drilled holes (pad drills + mounting holes) clean through the
        // slab so they read as real openings; only holes wholly inside the board.
        const drilledHoles = collectBoardHoles(app.placements).filter((ho) => ho.r > 0);
        const boardHoles = drilledHoles.filter((ho) =>
            ho.x - ho.r > 0 && ho.x + ho.r < w &&
            ho.z - ho.r > -h && ho.z + ho.r < 0);
        scene.removeMesh(surf.board);
        surf.board = scene.addMesh(
            boardWithHoles(outline, boardHoles, 0, BOARD_THICKNESS, COLOR_BOARD, COLOR_BOARD_EDGE),
            scene.boardMaterial);
        scene.positionGlint(w / 2, -h / 2, Math.max(w, h));
        // Punch the same drilled holes through the flat copper so tracks/pours
        // crossing a hole are bored out instead of lidding over an open hole.
        swapSurface('copper', clipMeshToOutline(
            punchHolesInFlatMesh(buildCopperMesh(app.tracks), drilledHoles), outline));
        swapSurface('via', clipMeshToOutline(buildViaMesh(app.vias), outline));
        swapSurface('silk', clipMeshToOutline(
            punchHolesInFlatMesh(buildSilkMesh(app.placements), drilledHoles), outline));
        swapSurface('text', clipMeshToOutline(
            punchHolesInFlatMesh(buildTextMesh(app), drilledHoles), outline));
        const padsMesh = emptyMesh();
        for (const [, pl] of app.placements) appendMesh(padsMesh, padMesh(pl));
        swapSurface('pads', clipMeshToOutline(padsMesh, outline));
    };

    // ── Component bodies (OBJ now, STEP lazily, diffed on live re-sync) ──
    /** @type {Set<string>} ids currently showing a real (OBJ/STEP) model */
    const resolved = new Set();
    /** @type {Map<string, string>} id → placement signature (change detection) */
    const bodySig = new Map();
    const placementSig = (/** @type {any} */ pl) =>
        `${pl.x}|${pl.y}|${pl.rotation || 0}|${pl.layer || ''}|${pl.footprint || ''}|${pl.model3dObj ? 1 : 0}`;

    // Build the immediate (synchronous) body for a placement: a real OBJ body if
    // the part carries one in memory, otherwise a fallback box. STEP models load
    // asynchronously afterward via loadModelFor.
    const addBody = (/** @type {string} */ id, /** @type {any} */ pl) => {
        let body = null;
        if (pl.model3dObj) {
            const parsed = parseObjModel(pl.model3dObj);
            body = parsed && objModelToMesh(parsed, pl);
        }
        const mesh = scene.addMesh(body || fallbackBoxMesh(pl));
        mesh.visible = partsVisible;
        bodyMeshes.set(id, mesh);
        if (body) resolved.add(id); else resolved.delete(id);
        bodySig.set(id, placementSig(pl));
    };

    // Fetch + apply the KiCad STEP model for one placement (cached per footprint).
    // Re-checks the signature before applying so a model that arrives after the
    // component was moved/removed is not stamped onto a now-stale body.
    const loadModelFor = async (/** @type {string} */ id, /** @type {any} */ pl) => {
        const footprint = pl.footprint || '';
        if (!fetcher || resolved.has(id) || !footprint.includes(':')) return;
        const geom = await fetchModel(footprint);
        if (panel.closed) return;
        const obj = bodyMeshes.get(id);
        if (geom && obj && bodySig.get(id) === placementSig(pl)) {
            const mesh = stepGeometryToMesh(geom, pl);
            if (mesh) { scene.replaceMesh(obj, mesh); resolved.add(id); }
        }
    };

    // Diff component bodies against the current placements: only new, removed or
    // moved components are rebuilt — unchanged ones (the common case while
    // routing tracks) keep their already-loaded STEP models untouched.
    syncBodies = () => {
        const ids = new Set();
        /** @type {Array<[string, any]>} */
        const toLoad = [];
        for (const [id, pl] of app.placements) {
            ids.add(id);
            if (!bodyMeshes.has(id)) {
                addBody(id, pl);
                toLoad.push([id, pl]);
            } else if (bodySig.get(id) !== placementSig(pl)) {
                scene.removeMesh(bodyMeshes.get(id));
                bodyMeshes.delete(id);
                resolved.delete(id);
                addBody(id, pl);
                toLoad.push([id, pl]);
            }
        }
        for (const id of [...bodyMeshes.keys()]) {
            if (!ids.has(id)) {
                scene.removeMesh(bodyMeshes.get(id));
                bodyMeshes.delete(id);
                resolved.delete(id);
                bodySig.delete(id);
            }
        }
        for (const [id, pl] of toLoad) loadModelFor(id, pl);
    };

        // ── Initial build ───────────────────────────────────────────────
        // Build all board surfaces synchronously and frame the camera to the
        // board now, then stream component bodies + STEP models asynchronously.
        rebuildSurfaces();
        scene.frameAll();
        scene.resize();
        scene.requestRender();
        (async () => {
            startedAt = performance.now();
            lastYieldAt = startedAt;
            spinnerTimer = window.setTimeout(revealSpinner, 1000);
            // Fade the grey cover out once the board has rendered its first frame.
            await nextFrame();
            if (panel.closed) { hideSpinner(); return; }
            await nextFrame();
            dom.cover?.classList.add('hide');
            await checkpoint();

            // Component bodies: parsing OBJ bodies is the dominant synchronous
            // cost on dense boards, so yield occasionally through checkpoint()
            // so the spinner can surface and the panel repaint.
            const placements = [...app.placements.entries()];
            let built = 0;
            for (const [id, pl] of placements) {
                addBody(id, pl);
                if ((++built & 15) === 0) await checkpoint();
            }
            const total = placements.length;
            if (!total) setStatus('No components placed');

            // ── Lazy STEP load (with progress) ──────────────────────────
            if (fetcher && total) {
                let loaded = 0;
                await Promise.all(placements.map(async ([id, pl]) => {
                    await loadModelFor(id, pl);
                    loaded++;
                    if (!panel.closed) {
                        setStatus(`${loaded}/${total} components · ${resolved.size} with 3D models`);
                    }
                }));
            }
            setStatus(total
                ? `${total} components · ${resolved.size} with 3D models`
                : 'No components placed');
            hideSpinner();
        })();
    };

    // ── View buttons ────────────────────────────────────────────────────
    // These navigate the orbitable 3D view, so they also drop any flat 2D lock.
    dom.btnTop?.addEventListener('click', () => { applyView('3d'); scene?.setView([0, 1, 0.0001]); });
    dom.btnIso?.addEventListener('click', () => { applyView('3d'); scene?.setView([0.7, 0.9, 1.1]); });
    dom.btnFit?.addEventListener('click', () => {
        if (panel.view === 'top' || panel.view === 'bottom') board2d?.fit();
        else scene?.frameAll();
    });

    // ── 2D Top/Bottom side buttons (only visible while a flat 2D view shows).
    // Two side-by-side buttons; the active one is highlighted (see applyView).
    dom.btn2dTop?.addEventListener('click', () => { app._last2DSide = 'top'; applyView('top'); });
    dom.btn2dBottom?.addEventListener('click', () => { app._last2DSide = 'bottom'; applyView('bottom'); });

    // ── Parts toggle: show/hide every component body mesh ───────────────
    dom.btnParts?.addEventListener('click', () => {
        partsVisible = !partsVisible;
        for (const mesh of bodyMeshes.values()) mesh.visible = partsVisible;
        dom.btnParts?.classList.toggle('off', !partsVisible);
        scene?.requestRender();
    });

    // ── Live sync: mirror 2D edits into the 3D view (debounced) ─────────
    // PCB edits run through app.history; wrap its onChanged so every committed
    // edit schedules a rebuild. Debounced so a burst of edits (or a drag that
    // commits many sub-steps) collapses into one rebuild after things settle.
    // Surfaces (copper/via/silk/text/pads/board) always rebuild — they are cheap
    // merged meshes; component bodies only rebuild for placements that changed.
    let syncTimer = 0;
    const scheduleSync = () => {
        if (panel.closed || panel.hidden) return;
        if (syncTimer) window.clearTimeout(syncTimer);
        syncTimer = window.setTimeout(() => {
            syncTimer = 0;
            if (panel.closed || panel.hidden) return;
            rebuildSurfaces();
            syncBodies();
            // Keep the flat 2D view in step with edits when it is the one showing.
            if (board2d && (panel.view === 'top' || panel.view === 'bottom')) {
                board2d.setData(boardData());
            }
        }, 300);
    };
    // Public hook so non-history edits (e.g. a schematic-driven re-sync that
    // adds/removes components) can refresh the 3D view too. PCB-side edits go
    // through history.onChanged below; schematic-side edits call panel.refresh.
    panel.refresh = scheduleSync;
    const prevOnChanged = app.history?.onChanged;
    const onHistoryChanged = (/** @type {any[]} */ ...args) => {
        prevOnChanged?.(...args);
        scheduleSync();
    };
    if (app.history) app.history.onChanged = onHistoryChanged;

    // ── Pop out / dock / close ──────────────────────────────────────────
    let pollTimer = 0;
    const dock = () => {
        if (panel.mode !== 'popped') return;
        if (pollTimer) { window.clearInterval(pollTimer); pollTimer = 0; }
        // Re-home the host (and its live canvas) back into the main document as
        // the right-side overlay again.
        mainContainer.appendChild(document.adoptNode(host));
        host.classList.add('cpcb3d-docked');
        splitter.classList.add('cpcb3d-docked');
        host.style.transform = '';
        host.style.transition = '';
        applyDockLayout();
        splitter.style.display = '';
        dom.btnPop.textContent = '⇱ Pop out';
        dom.btnPop.title = 'Pop out to a separate window';
        panel.mode = 'docked';
        if (panel.popWin && !panel.popWin.closed) {
            try { panel.popWin.close(); } catch { /* ignore */ }
        }
        panel.popWin = null;
        scene?.resize();
        if (panel.view === 'top' || panel.view === 'bottom') board2d?.resize();
    };
    const popOut = () => {
        if (panel.mode === 'popped') { panel.popWin?.focus(); return; }
        const win = window.open('', 'clearpcb3d', 'width=980,height=720');
        if (!win) { setStatus('Pop-up blocked — allow pop-ups to tear off'); return; }
        const wd = win.document;
        // Paint the new window grey immediately and give it the 3D stylesheet.
        try {
            wd.documentElement.style.background = '#4a4c4f';
            wd.documentElement.style.colorScheme = 'dark';
        } catch { /* ignore */ }
        wd.title = 'ClearPCB — 3D View';
        ensure3DStyles(wd);
        const base = wd.createElement('style');
        base.textContent =
            'html,body{margin:0;height:100%;background:#4a4c4f;overflow:hidden}' +
            '.cpcb3d-host{position:absolute;inset:0}';
        (wd.head || wd.documentElement).appendChild(base);
        if (wd.body) wd.body.style.background = '#4a4c4f';
        // Move the live host into the pop-up; the WebGL canvas and its context
        // travel with the node and the render loop follows it to the pop-up's rAF.
        wd.body.appendChild(wd.adoptNode(host));
        // Shed the docked-overlay positioning so the popup CSS (inset:0) fills.
        host.classList.remove('cpcb3d-docked', 'cpcb3d-sliding');
        host.style.width = '';
        host.style.transform = '';
        host.style.transition = '';
        splitter.style.display = 'none';
        dom.btnPop.textContent = '⤢ Dock';
        dom.btnPop.title = 'Dock back into the main window';
        panel.mode = 'popped';
        panel.popWin = win;
        scene?.resize();
        if (panel.view === 'top' || panel.view === 'bottom') board2d?.resize();
        // Closing the pop-up with its red X should HIDE the view, not destroy
        // it — so re-opening is instant (no 3D rebuild / STEP re-fetch). Rescue
        // the host back into the main document first (pagehide fires before the
        // pop-up document is torn down), then hide the now-docked panel. The
        // Dock button instead leaves it visible; it sets panel.mode='docked'
        // before closing the window, so these guards only fire for a genuine
        // user window close. A poll covers browsers with no usable pagehide.
        const rescueAndHide = () => {
            if (panel.mode !== 'popped') return;
            dock();
            hidePanel();
        };
        win.addEventListener('pagehide', rescueAndHide, { once: true });
        pollTimer = window.setInterval(() => {
            if (win.closed) {
                window.clearInterval(pollTimer); pollTimer = 0;
                rescueAndHide();
            }
        }, 500);
    };
    const closePanel = () => {
        if (panel.closed) return;
        panel.closed = true;
        if (pollTimer) { window.clearInterval(pollTimer); pollTimer = 0; }
        if (syncTimer) { window.clearTimeout(syncTimer); syncTimer = 0; }
        if (slideTimer) { window.clearTimeout(slideTimer); slideTimer = 0; }
        // Unhook the live-sync wrapper (only if nothing re-wrapped after us).
        if (app.history && app.history.onChanged === onHistoryChanged) {
            app.history.onChanged = prevOnChanged;
        }
        window.removeEventListener('pointermove', onSplitMove);
        window.removeEventListener('pointerup', onSplitUp);
        hideSpinner();
        scene?.dispose();
        board2d?.dispose();
        if (panel.mode === 'popped' && panel.popWin && !panel.popWin.closed) {
            try { panel.popWin.close(); } catch { /* ignore */ }
        }
        host.remove();
        splitter.remove();
        if (app._board3d === panel) app._board3d = null;
        app._update3DButtonState?.();
    };
    panel.popOut = popOut;
    panel.dock = dock;
    panel.close = closePanel;

    // ── Hide / show ─────────────────────────────────────────────────────
    // The ✕ button hides the panel rather than disposing it, so re-opening is
    // instant (no rebuild / STEP re-fetch). The render loop is on-demand, so a
    // hidden panel costs no CPU/GPU — it only holds its WebGL context + meshes
    // in memory (modest for a single board). A hidden panel skips live sync;
    // show() runs one catch-up sync for edits made while it was hidden.
    const hidePanel = () => {
        if (panel.closed || panel.hidden) return;
        if (panel.mode === 'popped') dock();
        panel.hidden = true;
        app._update3DButtonState?.();
        // Slide the overlay out to the right; the editor underneath is untouched.
        slideOut(() => {
            host.style.display = 'none';
        });
    };
    const showPanel = () => {
        if (panel.closed || !panel.hidden) return;
        panel.hidden = false;
        app._update3DButtonState?.();
        slideIn(() => {
            scene?.resize();
            if (panel.view === 'top' || panel.view === 'bottom') board2d?.resize();
            scheduleSync();
        });
    };
    panel.hide = hidePanel;
    panel.show = showPanel;

    dom.btnPop?.addEventListener('click', () => (panel.mode === 'popped' ? dock() : popOut()));

    // Honour the initial view. Opening into 2D never builds 3D (instant); the
    // 3D scene + STEP models are built lazily by ensure3D when 3D is first shown.
    applyView(initialView);
}

