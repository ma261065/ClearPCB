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
 * pan/zoom comes from three.js `TrackballControls`. The footprint geometry +
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
import { TrackballControls } from '../../../assets/vendor/three.module.js';
import { STEPPreview } from '../../components/STEPPreview.js';
import { getComponentLibrary } from '../../components/index.js';

/** Finished board thickness in millimetres (standard 1.6 mm). */
const BOARD_THICKNESS = 1.6;

/** Default body height (mm) for fallback component boxes with no STEP model. */
const FALLBACK_HEIGHT = 1.2;

/** Colours (0–255 RGB triplets). */
const COLOR_BOARD = [20, 100, 50];     // PCB green (slightly dark)
const COLOR_BOARD_EDGE = [14, 74, 37];
const COLOR_COMPONENT = [40, 44, 52];  // dark IC body
const COLOR_FALLBACK = [70, 78, 90];   // generic part
const COLOR_PAD = [201, 164, 74];      // gold

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
 * @param {{x:number,y:number,rotation?:number}} pl placement
 * @returns {{verts: Array, faces: Array}|null}
 */
function objModelToMesh(parsed, pl) {
    if (!parsed?.vertices?.length || !parsed.faces?.length) return null;

    let minZ = Infinity;
    for (const v of parsed.vertices) if (v.z < minZ) minZ = v.z;
    if (!isFinite(minZ)) minZ = 0;

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
        const rx = v.x * ct - v.y * st;
        const ry = v.x * st + v.y * ct;
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
 * Build thin pad pads (flat gold quads) on the board top for a placement.
 * @param {{x:number,y:number,rotation?:number,padOffsets?:Array}} pl
 * @returns {{verts: Array, faces: Array}}
 */
function padMesh(pl) {
    const theta = ((pl.rotation || 0) * Math.PI) / 180;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const verts = [];
    const faces = [];
    const y = BOARD_THICKNESS + 0.02; // just above the surface
    for (const off of (pl.padOffsets || [])) {
        const w = (off.width || 1) / 2;
        const h = (off.height || 1) / 2;
        const local = [
            { x: off.dx - w, z: off.dy - h },
            { x: off.dx + w, z: off.dy - h },
            { x: off.dx + w, z: off.dy + h },
            { x: off.dx - w, z: off.dy + h },
        ];
        const base = verts.length;
        for (const c of local) {
            verts.push({
                x: pl.x + (c.x * ct - c.z * st),
                y,
                z: pl.y + (c.x * st + c.z * ct),
            });
        }
        faces.push({ idx: [base, base + 1, base + 2, base + 3], color: COLOR_PAD });
    }
    return { verts, faces };
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
    for (const f of mesh.faces) {
        const idx = f.idx;
        if (!idx || idx.length < 3) continue;
        const c = f.color || [128, 128, 128];
        const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
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
        // Cap the pixel ratio: hi-DPI displays otherwise render 4× the pixels
        // for no visible gain, which is the main cause of sluggish orbiting.
        this.renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 1.5));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x21262c);

        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
        this.camera.position.set(80, 120, 160);

        // Lighting: ambient gives a soft base fill; the key directional and the
        // point light both ride with the camera (see _updateLights) so the side
        // of the board facing the viewer is always the lit one.
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.62));
        this.key = new THREE.DirectionalLight(0xffffff, 0.55);
        this.scene.add(this.key);

        // Camera headlight: a point light pinned to the camera each frame. With
        // physical inverse-square decay it pools into a soft circular glow on
        // whichever face is toward the viewer (brightest at the centre of view,
        // fading outward) — the EasyEDA reflection look. Intensity is set from
        // the camera distance in _updateLights so the pool stays consistent.
        this.glint = new THREE.PointLight(0xffffff, 1.0, 0, 2);
        this.scene.add(this.glint);

        this.controls = new TrackballControls(this.camera, this.renderer.domElement);
        // Trackball gives EasyEDA-style free rotation: the board can be flipped
        // over the poles and spun indefinitely (OrbitControls clamps at
        // vertical because of its fixed up-vector). staticMoving = no inertia,
        // so motion stops the instant the mouse is released.
        this.controls.rotateSpeed = 3.2;
        this.controls.zoomSpeed = 7;
        this.controls.panSpeed = 0.8;
        this.controls.staticMoving = true;
        // Floor the zoom-in distance (set from board size in positionGlint) so
        // the camera can't push through the surface into the board/components.
        this.controls.minDistance = 5;

        /** @type {THREE.Group} */
        this.root = new THREE.Group();
        this.scene.add(this.root);

        // Render only while interacting: TrackballControls applies motion in
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
        this.win.requestAnimationFrame(this._animate);
    }

    /** Stop the render loop and draw one final settled frame. */
    _stopAnimating() {
        this._animating = false;
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
     * @param {THREE.Material} [material] optional material override
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
    const boardMesh = extrudePrism(outline, 0, BOARD_THICKNESS, COLOR_BOARD, COLOR_BOARD_EDGE);
    scene.addMesh(boardMesh, scene.boardMaterial);
    scene.positionGlint(w / 2, -h / 2, Math.max(w, h));

    // ── Pads + component bodies (OBJ now, STEP lazily) ──────────────────
    const placements = [...app.placements.entries()];
    /** @type {Map<string, THREE.Mesh>} compId → its body mesh */
    const bodyMeshes = new Map();
    /** @type {Set<string>} compIds already resolved to a real model */
    const resolved = new Set();

    for (const [id, pl] of placements) {
        scene.addMesh(padMesh(pl));
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
    scene.frameAll();

    const setStatus = (text) => { if (dom.status && !win.closed) dom.status.textContent = text; };
    if (!placements.length) setStatus('No components placed');

    // ── View buttons ────────────────────────────────────────────────────
    dom.btnTop?.addEventListener('click', () => scene.setView([0, 1, 0.0001]));
    dom.btnIso?.addEventListener('click', () => scene.setView([0.7, 0.9, 1.1]));
    dom.btnFit?.addEventListener('click', () => scene.frameAll());

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
