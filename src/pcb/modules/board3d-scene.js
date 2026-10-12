/**
 * The 3D viewer's window and scene: its styles and DOM host, the three.js scene,
 * camera, lights and render loop, and camera clipping.
 * Split from board3d.js; the viewer itself is board3d.js.
 */
import * as THREE from '../../../assets/vendor/three.module.js';
import { ArcballController } from '../../shared/3d/ArcballController.js';
import { meshToGeometry, makeMaterial, makeComponentGroupMaterials } from '../../shared/3d/model-rendering.js';
import { createViewerBackgroundTexture } from './viewer-background.js';
import { BOARD_THICKNESS, LAYER_STYLE } from './board3d-params.js';
import { makeDecalMaterial, makeBoardMaterial } from './board3d-layers.js';
/** @typedef {import('../../shared/3d/model-rendering.js').ModelMesh} ModelMesh */
/** @typedef {{groupVertCounts?: number[]}} GroupedGeometryUserData */
/** @typedef {{ownedMaterials?: Array<{dispose: () => void}>|null}} OwnedMaterialUserData */

/* ───────────────────────────── view host ────────────────────────────────── */

const CPCB3D_CSS = `
  .cpcb3d-host{position:relative;flex:1 1 0;min-width:0;min-height:0;
        overflow:hidden;color:#e6e6e6;
    font:13px/1.4 system-ui,Segoe UI,sans-serif}
  .cpcb3d-bar{position:absolute;top:0;left:0;right:0;height:38px;display:flex;
    align-items:center;gap:8px;padding:0 10px;background:rgba(20,23,27,.85);
        backdrop-filter:blur(4px);border-bottom:1px solid #2c3138;z-index:2;
        overflow-x:auto;overflow-y:hidden}
  .cpcb3d-bar strong{font-size:13px}
  .cpcb3d-bar button{background:#2c3138;color:#e6e6e6;border:1px solid #3a414a;
    border-radius:5px;padding:5px 10px;cursor:pointer;font-size:12px}
  .cpcb3d-bar button:hover{background:#3a414a}
    .cpcb3d-bar button.cpcb3d-close{min-width:28px;padding:4px 8px;
        color:#ff7070;border-color:#8f4141;font-size:16px;line-height:1}
    .cpcb3d-bar button.cpcb3d-close:hover{background:#5a2525;border-color:#e05050;color:#fff}
    .cpcb3d-host:not(.cpcb3d-docked) .cpcb3d-close{display:none}
  .cpcb3d-bar button.off{opacity:.5}
  .cpcb3d-bar .cpcb3d-sp{flex:1}
    .cpcb3d-stylewin{position:absolute;top:50px;right:10px;z-index:12;
        width:260px;padding:10px;border:1px solid #3a414a;border-radius:8px;
        background:rgba(20,23,27,.96);box-shadow:0 8px 22px rgba(0,0,0,.35)}
    .cpcb3d-stylewin.hide{display:none}
    .cpcb3d-stylehead{display:flex;align-items:center;justify-content:space-between;
        margin-bottom:8px;font-size:12px;color:#dbe3ec}
    .cpcb3d-stylehead button{padding:2px 8px;font-size:12px;line-height:1}
    .cpcb3d-stylerow{display:grid;grid-template-columns:18px 1fr 40px;
        align-items:center;gap:6px;margin:5px 0;color:#a9b3bf;font-size:11px}
    .cpcb3d-stylerow input[type="range"]{width:100%}
    .cpcb3d-stylerow output{text-align:right;color:#dbe3ec;
        font-variant-numeric:tabular-nums}
    .cpcb3d-styleselect{width:100%;margin-bottom:8px;background:#2c3138;
        color:#e6e6e6;border:1px solid #3a414a;border-radius:5px;padding:4px 6px;
        font-size:12px}
    .cpcb3d-stylepreview{display:flex;align-items:flex-start;gap:10px;margin-top:8px}
    .cpcb3d-stylechipwrap{display:flex;flex-direction:column;align-items:center;gap:4px}
    .cpcb3d-stylechip{width:54px;height:24px;border:1px solid #3a414a;
        border-radius:4px;box-sizing:border-box}
    .cpcb3d-stylechip-exact{width:72px;height:32px;border:0;outline:1px solid #3a414a;
        border-radius:2px}
    .cpcb3d-stylechiplabel{font-size:10px;color:#a9b3bf;line-height:1}
    .cpcb3d-stylergb{font-size:11px;color:#dbe3ec;font-variant-numeric:tabular-nums}
    .cpcb3d-stylepaint{display:block;margin-top:4px;font-size:11px;
        color:#b8c2cd;font-variant-numeric:tabular-nums}
  .cpcb3d-status{font-size:12px;color:#9aa3ad}
  .cpcb3d-cv{position:absolute;inset:38px 0 0 0;width:100%;height:calc(100% - 38px);
        display:block;cursor:grab}
  .cpcb3d-cv:active{cursor:grabbing}
  /* Flat 2D board preview canvas (board2d.js). Shares the host with the WebGL
     canvas; only one is shown at a time depending on the active view. */
  .cpcb3d-cv2d{position:absolute;inset:38px 0 0 0;width:100%;height:calc(100% - 38px);
        display:none;cursor:grab}
  .cpcb3d-cv2d:active{cursor:grabbing}
  .cpcb3d-host.cpcb3d-mode2d .cpcb3d-cv{display:none}
  .cpcb3d-host.cpcb3d-mode2d .cpcb3d-cv2d{display:block}
  /* The Top/Bottom/Save side buttons are 2D-only; Parts/Top/Iso are 3D-only. */
  [data-act="2dtop"],[data-act="2dbottom"],[data-act="2dsave"]{display:none}
  .cpcb3d-host.cpcb3d-mode2d [data-act="parts"],
  .cpcb3d-host.cpcb3d-mode2d [data-act="top"],
  .cpcb3d-host.cpcb3d-mode2d [data-act="iso"],
  .cpcb3d-host.cpcb3d-mode2d [data-act="3dsave"]{display:none}
  .cpcb3d-host.cpcb3d-mode2d [data-act="2dtop"],
  .cpcb3d-host.cpcb3d-mode2d [data-act="2dbottom"],
  .cpcb3d-host.cpcb3d-mode2d [data-act="2dsave"]{display:inline-block}
    .cpcb3d-bar [data-act="parts"].active,
    .cpcb3d-bar [data-act="2dtop"].active,
  .cpcb3d-bar [data-act="2dbottom"].active{
    background:#2d7dd2;border-color:#2d7dd2;color:#fff}
  .cpcb3d-hint{position:absolute;bottom:8px;left:10px;font-size:11px;color:#6b7480;
    z-index:2;pointer-events:none}
  .cpcb3d-spinner{position:absolute;inset:38px 0 0 0;display:none;
    flex-direction:column;align-items:center;justify-content:center;gap:14px;
    z-index:11;background:rgba(21,24,28,.55);color:#cfd6de;font-size:13px;
    pointer-events:none}
  .cpcb3d-spinner.show{display:flex}
  .cpcb3d-host.cpcb3d-mode2d .cpcb3d-spinner3d,
  .cpcb3d-host:not(.cpcb3d-mode2d) .cpcb3d-spinner2d{display:none}
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
export function ensure3DStyles(doc) {
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
 * @returns {{host:HTMLElement, canvas:HTMLCanvasElement, canvas2d:HTMLCanvasElement, status:HTMLElement,
 *   spinner3d:HTMLElement, spinner2d:HTMLElement, btnParts:HTMLElement,
 *   btnTop:HTMLElement, btnIso:HTMLElement, btnFit:HTMLElement,
 *   btn2dTop:HTMLElement, btn2dBottom:HTMLElement, btn2dSave:HTMLElement,
 *   btn3dSave:HTMLElement, btnPop:HTMLElement, btnClose:HTMLElement, styleBtn:HTMLElement,
 *   styleWin:HTMLElement, styleClose:HTMLElement, styleLayer:HTMLSelectElement,
 *   styleH:HTMLInputElement, styleS:HTMLInputElement, styleV:HTMLInputElement,
 *   styleO:HTMLInputElement, styleHVal:HTMLOutputElement,
 *   styleSVal:HTMLOutputElement, styleVVal:HTMLOutputElement,
 *   styleOVal:HTMLOutputElement, styleChip:HTMLElement,
 *   styleChipOpaque:HTMLElement, styleRgb:HTMLOutputElement,
 *   stylePaint:HTMLOutputElement, hint:HTMLElement}}
 */
export function build3DHost(doc) {
    ensure3DStyles(doc);
    const host = doc.createElement('div');
    host.className = 'cpcb3d-host';
    host.innerHTML = `
  <div class="cpcb3d-bar">
    <button data-act="parts" title="Show/hide component parts">Parts</button>
    <button data-act="top">Top</button>
    <button data-act="iso">Iso</button>
    <button data-act="3dsave" title="Save this 3D view as a PNG image">Save Image</button>
    <button data-act="2dtop" title="Show the top of the board">Top</button>
    <button data-act="2dbottom" title="Show the bottom of the board">Bottom</button>
    <button data-act="2dsave" title="Save this view as a PNG image">Save Image</button>
    <button data-act="fit">Fit</button>
    <button data-act="pop" title="Pop out to a separate window">⇱ Pop out</button>
    <button data-act="style" title="Open color style editor">Styles</button>
    <span class="cpcb3d-sp"></span>
    <span class="cpcb3d-status"></span>
    <button class="cpcb3d-close" data-act="close" title="Close view" aria-label="Close view">X</button>
  </div>
  <canvas class="cpcb3d-cv"></canvas>
  <canvas class="cpcb3d-cv2d"></canvas>
  <div class="cpcb3d-spinner cpcb3d-spinner3d"><div class="cpcb3d-ring"></div><div>Loading…</div></div>
  <div class="cpcb3d-spinner cpcb3d-spinner2d"><div class="cpcb3d-ring"></div><div>Loading…</div></div>
  <div class="cpcb3d-hint">Drag to orbit · Right-drag to pan · Wheel to zoom</div>
    <div class="cpcb3d-stylewin hide">
        <div class="cpcb3d-stylehead">
            <strong>Layer Styles</strong>
            <button data-act="style-close" title="Close style editor">x</button>
        </div>
        <select class="cpcb3d-styleselect" data-act="style-layer" title="Layer target">
            <option value="board">Board</option>
            <option value="soldermask">Soldermask</option>
            <option value="tracks">Tracks</option>
            <option value="vias">Vias</option>
            <option value="silkscreen">Silkscreen</option>
            <option value="pads">Pads</option>
        </select>
        <div class="cpcb3d-stylerow"><span>H</span><input data-act="style-h" type="range" min="0" max="359" step="1" /><output data-act="style-h-val"></output></div>
        <div class="cpcb3d-stylerow"><span>S</span><input data-act="style-s" type="range" min="0" max="100" step="1" /><output data-act="style-s-val"></output></div>
        <div class="cpcb3d-stylerow"><span>V</span><input data-act="style-v" type="range" min="0" max="100" step="1" /><output data-act="style-v-val"></output></div>
        <div class="cpcb3d-stylerow"><span>O</span><input data-act="style-o" type="range" min="0" max="255" step="1" /><output data-act="style-o-val"></output></div>
        <div class="cpcb3d-stylepreview">
            <div class="cpcb3d-stylechipwrap">
                <div class="cpcb3d-stylechip cpcb3d-stylechip-exact" data-act="style-chip"></div>
                <span class="cpcb3d-stylechiplabel">Paint RGB</span>
            </div>
            <div class="cpcb3d-stylechipwrap">
                <div class="cpcb3d-stylechip" data-act="style-chip-opaque"></div>
                <span class="cpcb3d-stylechiplabel">With Opacity</span>
            </div>
        </div>
        <output class="cpcb3d-stylergb" data-act="style-rgb"></output>
        <output class="cpcb3d-stylepaint" data-act="style-paint"></output>
    </div>`;
    const q = (/** @type {string} */ sel) => /** @type {any} */ (host.querySelector(sel));
    return {
        host,
        canvas: q('.cpcb3d-cv'),
        canvas2d: q('.cpcb3d-cv2d'),
        status: q('.cpcb3d-status'),
        spinner3d: q('.cpcb3d-spinner3d'),
        spinner2d: q('.cpcb3d-spinner2d'),
        btnParts: q('[data-act="parts"]'),
        btnTop: q('[data-act="top"]'),
        btnIso: q('[data-act="iso"]'),
        btn2dTop: q('[data-act="2dtop"]'),
        btn2dBottom: q('[data-act="2dbottom"]'),
        btn2dSave: q('[data-act="2dsave"]'),
        btn3dSave: q('[data-act="3dsave"]'),
        btnFit: q('[data-act="fit"]'),
        btnPop: q('[data-act="pop"]'),
        btnClose: q('[data-act="close"]'),
        styleBtn: q('[data-act="style"]'),
        styleWin: q('.cpcb3d-stylewin'),
        styleClose: q('[data-act="style-close"]'),
        styleLayer: q('[data-act="style-layer"]'),
        styleH: q('[data-act="style-h"]'),
        styleS: q('[data-act="style-s"]'),
        styleV: q('[data-act="style-v"]'),
        styleO: q('[data-act="style-o"]'),
        styleHVal: q('[data-act="style-h-val"]'),
        styleSVal: q('[data-act="style-s-val"]'),
        styleVVal: q('[data-act="style-v-val"]'),
        styleOVal: q('[data-act="style-o-val"]'),
        styleChip: q('[data-act="style-chip"]'),
        styleChipOpaque: q('[data-act="style-chip-opaque"]'),
        styleRgb: q('[data-act="style-rgb"]'),
        stylePaint: q('[data-act="style-paint"]'),
        hint: q('.cpcb3d-hint'),
    };
}


/* ───────────────────────────── scene helper ─────────────────────────────── */

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.Box3} bounds
 * @param {number} [depthBits]
 */
export function updateBoardCameraClipping(camera, bounds, depthBits = 24) {
    if (!bounds || bounds.isEmpty()) return;
    camera.updateMatrixWorld();
    const point = new THREE.Vector3();
    let nearest = Infinity;
    let farthest = -Infinity;
    for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
            for (const z of [bounds.min.z, bounds.max.z]) {
                point.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
                nearest = Math.min(nearest, -point.z);
                farthest = Math.max(farthest, -point.z);
            }
        }
    }
    if (!Number.isFinite(nearest) || !Number.isFinite(farthest) || farthest <= 0) return;
    // A corner behind the eye may be entirely off-screen. The distance to the
    // box gives a second, conservative lower bound for visible depth: every
    // visible ray is within the diagonal half-FOV of the camera's forward axis.
    // This preserves nearby visible geometry without throwing away precision
    // whenever the view grazes the scene's bounding box.
    const tanHalfFov = Math.tan(camera.getEffectiveFOV() * Math.PI / 360);
    const cosHalfDiagonal = 1 / Math.sqrt(1 + tanHalfFov ** 2 * (1 + camera.aspect ** 2));
    const visibleNear = bounds.distanceToPoint(camera.getWorldPosition(point)) * cosHalfDiagonal;
    nearest = Math.max(nearest, visibleNear);
    const far = Math.max(1.01, farthest * 1.5);
    const depthSteps = 2 ** depthBits - 1;
    const depthResolutionMm = 0.001;
    const precisionNear = 1 / (depthResolutionMm * depthSteps / (farthest * farthest) + 1 / far);
    const near = Math.max(0.01, Math.min(nearest / 2, precisionNear));
    if (camera.near === near && camera.far === far) return;
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
}

export class ThreeScene {
    /**
     * @param {Window} win
     * @param {HTMLCanvasElement} canvas
     */
    constructor(win, canvas) {
        this.win = win;
        this.canvas = canvas;
        this.material = makeMaterial();
        this.boardMaterial = makeBoardMaterial();
        // Per-layer surface materials. Each thin board layer is kept perfectly
        // coplanar with the board face and given its own CONSTANT depth-bias
        // slice (makeDecalMaterial) so coplanar layers never z-fight — no
        // world-space Y step (→ no shimmer at distance, no visible pad "side")
        // and no slope-scaled bias (→ no peter-panning over the bore/edge
        // walls). Stack from the board up: mask-opening cutouts < copper < via <
        // pad < mask-coat < document-cutouts < silk < text;
        // renderOrder (BOARD_SURFACE_ORDER) matches so the paint order agrees with the
        // depth order. Component bodies use the neutral `material`.
        //
        // The units are spaced widely: a polygonOffset "unit" is only the
        // SMALLEST GUARANTEED-resolvable depth increment — at tight spacing the
        // effective gap can collapse at oblique/far depth and the layers z-fight
        // again (the "vias shimmer over tracks" bug). Wide constant spacing
        // keeps every coplanar pair separated at all angles; it raises nothing
        // visually (depth-only bias) and stays well short of the bore/edge walls.
        this.maskOpeningMaterial = makeDecalMaterial(-8);
        this.copperMaterial = makeDecalMaterial(-16);
        this.viaMaterial = makeDecalMaterial(-32);
        this.padMaterial = makeDecalMaterial(-48);
        this.maskCoatMaterial = makeDecalMaterial(-52);
        this.maskCoatMaterial.transparent = true;
        this.maskCoatMaterial.opacity = LAYER_STYLE.soldermask.o;
        this.maskCoatMaterial.depthWrite = false;
        this.silkMaterial = makeDecalMaterial(-64);
        this.textMaterial = makeDecalMaterial(-80);

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        const gl = this.renderer.getContext();
        this._depthBits = gl.getParameter(gl.DEPTH_BITS);
        // Two pixel-ratio tiers. Orbiting renders at the capped ratio (hi-DPI
        // displays otherwise draw 4× the pixels for no visible gain — the main
        // cause of sluggish dragging); the settled frame after interaction ends
        // renders at full device ratio so a stationary, zoomed-in view is crisp.
        this._dprActive = Math.min(win.devicePixelRatio || 1, 1.5);
        this._dprIdle = win.devicePixelRatio || 1;
        this.renderer.setPixelRatio(this._dprIdle);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        // Filmic tone mapping rolls the bright headlight highlights off into a
        // smooth shoulder instead of hard-clipping them to white, so saturated
        // mask greens and gold pads read richer and more "lit" (the premium
        // viewer look). Exposure is tuned to keep overall brightness close to
        // the previous linear output — lower it for a moodier look, raise it for
        // a brighter one. NOTE: the vendored three build is tree-shaken and does
        // NOT export the `ACESFilmicToneMapping` constant, so its numeric value
        // (4) is set directly; the renderer maps 4 → "ACESFilmic".
        this.renderer.toneMapping = 4; // THREE.ACESFilmicToneMapping
        this.renderer.toneMappingExposure = 1.15;
        this.scene = new THREE.Scene();
        this.backgroundTexture = createViewerBackgroundTexture(THREE, canvas.ownerDocument);
        this.scene.background = this.backgroundTexture;

        this.camera = /** @type {any} */ (new THREE.PerspectiveCamera(45, 1, 0.1, 20000));
        this.camera.position.set(80, 120, 160);

        // Lighting: ambient gives a soft base fill; the key directional and the
        // point light both ride with the camera (see _updateLights) so the side
        // of the board facing the viewer is always the lit one. Ambient is kept
        // moderate so directional shading stays crisp and colours stay vivid (too
        // much flat fill washes the saturation out).
        this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
        this.key = /** @type {any} */ (new THREE.DirectionalLight(0xffffff, 0.85));
        this.scene.add(this.key);

        // Camera headlight: a point light pinned to the camera each frame. With
        // physical inverse-square decay it pools into a soft circular glow on
        // whichever face is toward the viewer (brightest at the centre of view,
        // fading outward) — the EasyEDA reflection look. Intensity is set from
        // the camera distance in _updateLights so the pool stays consistent.
        this.glint = /** @type {any} */ (new THREE.PointLight(0xffffff, 1.0, 0, 2));
        this.scene.add(this.glint);

        // Fixed cool fill from above-left, independent of the camera. It never
        // moves, so it adds steady form/shading gradient and a faint cool cast
        // that plays against the warm white headlight — the subtle two-tone
        // "studio" modelling that reads as nicer than a single flat key. Kept
        // low so it shapes without washing out the layer colours.
        this.fill = /** @type {any} */ (new THREE.DirectionalLight(0xbcd2ff, 0.28));
        this.fill.position.set(-120, 180, 90);
        this.scene.add(this.fill);

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
        // Keep pan-depth scaling tied to the board slab, not the moving camera
        // target, so long pan/zoom sessions do not accumulate drag drift.
        this.controls.setPanReferencePlaneY(BOARD_THICKNESS * 0.5);
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
        try { this.backgroundTexture?.dispose?.(); } catch { /* ignore */ }
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
        this._updateCameraClipping();
        this._updateLights();
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Render one frame synchronously and hand the canvas pixels to a callback
     * as a PNG Blob. The render and the readback happen in the same task so the
     * WebGL drawing buffer is still intact (the renderer is created without
     * preserveDrawingBuffer, so the buffer is cleared after the frame is
     * composited — reading later would yield a blank image).
     *
     * The frame is supersampled: the drawing buffer is temporarily enlarged to
     * `scale`× the on-screen pixel ratio (the GPU renders extra samples that the
     * PNG encoder downfilters), so edges, silk text and copper read much
     * sharper than the live view. The buffer size and pixel ratio are restored
     * immediately afterwards so the interactive canvas is unaffected.
     * @param {(blob: Blob|null) => void} cb
     * @param {number} [scale] Supersample factor applied over the idle DPR.
     */
    captureBlob(cb, scale = 3) {
        if (this._disposed) { cb(null); return; }
        const cv = this.canvas;
        const w = cv.clientWidth || 1;
        const h = cv.clientHeight || 1;
        // Cap the buffer so a large viewport can't exceed the GPU's max texture
        // size (commonly 8192/16384); pick the largest scale that still fits.
        const gl = this.renderer.getContext();
        const maxDim = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 8192;
        const targetDpr = this._dprIdle * Math.max(1, scale);
        const dpr = Math.max(
            this._dprIdle,
            Math.min(targetDpr, maxDim / w, maxDim / h),
        );
        const prevDpr = this.renderer.getPixelRatio();
        try {
            this.renderer.setPixelRatio(dpr);
            this.renderer.setSize(w, h, false);
            this.controls.update();
            this._updateCameraClipping();
            this._updateLights();
            this.renderer.render(this.scene, this.camera);
            cv.toBlob(cb, 'image/png');
        } finally {
            // Restore the live buffer resolution regardless of capture outcome.
            this.renderer.setPixelRatio(prevDpr);
            this._resize();
            this.requestRender();
        }
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
        this._updateCameraClipping();
        this._updateLights();
        this.renderer.render(this.scene, this.camera);
        this._raf(this._animate);
    }

    _updateCameraClipping() {
        if (!this._clippingBounds) this._clippingBounds = new THREE.Box3().setFromObject(this.root);
        updateBoardCameraClipping(this.camera, this._clippingBounds, this._depthBits);
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
        this.glint.intensity = standoff * standoff * 1.2;
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
        // Let the solid keep-out box (_ejectFromBounds) stop the camera at the
        // actual board/component surface; keep only a tiny floor so the orbit
        // distance never collapses to zero. A large minDistance here would wall
        // zoom-in off well above the surface and feel like it "stops".
        this.controls.minDistance = Math.max(1, span * 0.02);
        this._updateLights();
        this.requestRender();
    }

    /**
     * Add a mesh, returning the THREE.Mesh so callers can replace it later.
     * @param {ModelMesh|THREE.BufferGeometry} mesh
     * @param {any} [material] optional material override
     * @param {boolean} [groupByColor] split a component body by colour and shade
     *   each group through a stepped polygonOffset so coincident detail faces
     *   (markings/pads on the shell) don't z-fight. Ignored if `material` given.
     * @returns {THREE.Mesh}
     */
    addMesh(mesh, material, groupByColor = false) {
        const geo = mesh instanceof THREE.BufferGeometry ? mesh : meshToGeometry(mesh, groupByColor);
        // Any material, or one per geometry group (three.js's inferred types allow neither).
        /** @type {any} */
        let mat = material || this.material;
        let owned = null;
        if (groupByColor && !material) {
            const counts = /** @type {GroupedGeometryUserData} */ (geo.userData).groupVertCounts || [];
            if (counts.length > 1) {
                owned = makeComponentGroupMaterials(counts);
                mat = owned;
            }
        }
        const m = new THREE.Mesh(geo, mat);
        /** @type {OwnedMaterialUserData} */ (m.userData).ownedMaterials = owned;
        this.root.add(m);
        this._clippingBounds = null;
        this.requestRender();
        return m;
    }

    /**
     * Swap the geometry of an existing mesh in place.
     * @param {THREE.Mesh} obj
     * @param {ModelMesh} mesh
     * @param {boolean} [groupByColor] see {@link addMesh}; rebuilds the stepped
     *   per-group materials for the new geometry.
     */
    replaceMesh(obj, mesh, groupByColor = false) {
        obj.geometry.dispose();
        const geo = meshToGeometry(mesh, groupByColor);
        obj.geometry = geo;
        this._clippingBounds = null;
        if (groupByColor) {
            const userData = /** @type {OwnedMaterialUserData} */ (obj.userData);
            if (userData.ownedMaterials) {
                for (const mm of userData.ownedMaterials) mm.dispose();
                userData.ownedMaterials = null;
            }
            const counts = /** @type {GroupedGeometryUserData} */ (geo.userData).groupVertCounts || [];
            if (counts.length > 1) {
                const owned = makeComponentGroupMaterials(counts);
                obj.material = /** @type {any} */ (owned);
                userData.ownedMaterials = owned;
            } else {
                obj.material = /** @type {any} */ (this.material);
            }
        }
        this.requestRender();
    }

    /**
     * Remove a mesh from the scene and free its geometry.
     * @param {THREE.Mesh|null|undefined} obj
     */
    removeMesh(obj) {
        if (!obj) return;
        this.root.remove(obj);
        this._clippingBounds = null;
        obj.geometry?.dispose();
        const userData = /** @type {OwnedMaterialUserData} */ (obj.userData);
        if (userData.ownedMaterials) {
            for (const mm of userData.ownedMaterials) mm.dispose();
            userData.ownedMaterials = null;
        }
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
        // Floor the zoom-out so the board can't shrink away to nothing: cap the
        // camera distance at a few times the framing distance.
        this.controls.maxDistance = dist * 5;
        const dir = this.camera.position.clone().sub(this.controls.target);
        if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.9, 1.2);
        dir.normalize();
        this.controls.target.copy(center);
        this.camera.position.copy(center).addScaledVector(dir, dist);
        this._clippingBounds = box;
        this.controls.update();
        this._updateCameraClipping();
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
