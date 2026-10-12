/**
 * Interactive 3D board visualiser (WebGL / three.js).
 *
 * Opens a pop-up window with a hardware-accelerated 3D view of the PCB and its
 * placed components. EasyEDA/LCSC parts render from the OBJ model carried on
 * the placement; KiCad parts fetch the same WRL/STEP models the schematic
 * component picker previews and convert them to the same coloured OBJ
 * (via {@link resolveObjFromModelUrl}), lazily and cached, so both sources flow
 * through one body-build pipeline ({@link parseObjModel} + objModelToMesh).
 * Components without an available model fall back to a simple extruded box
 * sized from the footprint bounds.
 *
 * Rendering uses three.js (vendored at assets/vendor/three.module.js) with a
 * real GPU depth buffer, so there are no painter's-algorithm artefacts; orbit/
 * pan/zoom comes from a custom Shoemake arcball (shared/3d/ArcballController.js).
 * The geometry builders are plain data ({verts, faces}), converted to BufferGeometry
 * with flat per-face colours, and live beside this viewer: dimensions and colours in
 * board3d-params.js, the bare board in board3d-board.js, component bodies and pads in
 * board3d-parts.js, copper, mask, silk and text in board3d-layers.js, the window and
 * three.js scene in board3d-scene.js, and the worker-built surfaces in
 * board3d-surfaces.js.
 *
 * Coordinate mapping (PCB → 3D world):
 *   world X = pcb x (mm)
 *   world Z = pcb y (mm, SVG Y-down)
 *   world Y = height above the board (mm, up)
 * The board top surface sits at world Y = BOARD_THICKNESS; component models
 * are dropped so their lowest point rests on that surface.
 */
import * as THREE from '../../../assets/vendor/three.module.js';
import { createBoardViewSync } from './board-view-sync.js';
// @ts-ignore -- cache-busting query string (see sw.js); TypeScript cannot resolve it
import { createSurfaceBuilder } from './board3d-surface-client.js?v=9';
import { parseObjModel } from '../../shared/3d/model-rendering.js';
import { resolveObjFromModelUrl } from '../../components/model3d-source.js';
import { getComponentLibrary } from '../../components/index.js';
import { boardDimensions } from '../../shared/pcb/board-outline.js';
import { Board2D } from './board2d.js';
import { loadClipper, isClipperReady } from './copper-fill-geom.js';
import { VIEWER_BACKGROUND, paintViewerBackground } from './viewer-background.js';
import { areDragOverlaysDeferred, clearBoardViewPanel, getBoardViewPanel, isBoardViewRefreshSuspended, isFillRefreshPending, isFillRefreshScheduled, isFillRefreshSuspended, setBoardViewPanel, setLastBoard2DSide } from './refresh-state.js';
import { projectBaseName, savePcbBlob } from './pcb-export.js';
import { hsvToRgb, getLayerStylesAppearance, setLayerStylesAppearance } from './board3d-params.js';
import { objModelToMesh, fallbackBoxMesh } from './board3d-parts.js';
import { createSilkArtworkMeshCache } from './board3d-layers.js';
import { ensure3DStyles, build3DHost, ThreeScene } from './board3d-scene.js';
import { boardSurfaceFrame, buildBoardSurfaceInputs, BOARD_SURFACE_ORDER, boardSurfaceMaterials, publishBoardSurfaces, createSurfacePublisher, createBoard3DSyncScheduler } from './board3d-surfaces.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('./board2d.js').LayerStyleKey} LayerStyleKey */
/** @typedef {import('./board2d.js').LayerStyle} LayerStyle */

/** @param {PcbEditor} app */
export function board2DDataFromApp(app) {
    return {
        placements: app.placements,
        tracks: app.tracks,
        vias: app.vias,
        pads: app.pads,
        circles: [],
        boardShapes: (app.boardShapes || []).filter(/** @param {{type?: string}|null|undefined} shape */ shape => shape?.type !== 'fill'),
        fills: app.copperFills,
        texts: [...(app.texts?.values?.() || [])],
        boardX: 0,
        boardY: 0,
        boardWidth: boardDimensions(app).width,
        boardHeight: boardDimensions(app).height,
        boardRadius: boardDimensions(app).radius,
    };
}


/* ───────────────────────────── public entry ─────────────────────────────── */

/**
 * Open the interactive 3D board visualiser as a 50:50 split panel beside the
 * PCB editor. The panel can be popped out into a separate window and docked
 * back again, carrying its live WebGL view with it.
 * @param {PcbEditor} app
 * @param {{view?: '3d'|'top'|'bottom'}} [opts] Initial view; defaults to 3D.
 */
export async function openBoard3DViewer(app, opts = {}) {
    const initialView = opts.view || '3d';
    // Single instance: re-opening shows a hidden panel, focuses a popped-out
    // window, or is otherwise a no-op.
    const existingPanel = getBoardViewPanel(app);
    if (existingPanel && !existingPanel.closed) {
        if (existingPanel.hidden) existingPanel.show?.();
        else if (existingPanel.mode === 'popped') existingPanel.popWin?.focus();
        existingPanel.setView?.(initialView);
        return;
    }

    const pcbContainer = document.getElementById('pcbCanvasContainer');
    const mainContainer = pcbContainer?.parentElement;
    if (!pcbContainer || !mainContainer) {
        app.setStatus('Cannot open 3D view — editor not ready');
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
    let panelPct = 100 / 3;
    const applyDockLayout = () => {
        host.style.width = `${panelPct}%`;
        splitter.style.right = `${panelPct}%`;
    };
    applyDockLayout();

    // ── Slide helpers (GPU transform — same feel as the editor slider) ───
    // The docked host is already an absolute overlay, so opening/closing only
    // animates its translateX. The editor underneath is never touched.
    let slideTimer = 0;
    /** @param {() => void} [onDone] */
    const slideIn = (onDone) => {
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

    /** @type {any} Panel is augmented below with lifecycle methods and optional popout state. */
    const panel = { mode: 'docked', popWin: null, closed: false, hidden: false, scene: null, view: initialView };
    setBoardViewPanel(app, panel);
    app.refreshPcbRibbon?.();

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
        // Resize drag is left-button only; swallow other buttons so a
        // right-click on the divider never opens context menus underneath.
        if (e.button !== 0) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        dragging = true;
        splitter.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    });
    splitter.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    window.addEventListener('pointermove', onSplitMove);
    window.addEventListener('pointerup', onSplitUp);

    // ── Spinner (armed in ensure3D) ───────────────────────────────────
    let startedAt = 0;
    let spinnerShown = false;
    let lastYieldAt = 0;
    const nextFrame = () =>
        new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
    const revealSpinner = () => {
        if (!panel.closed && !spinnerShown) {
            dom.spinner3d.classList.add('show');
            spinnerShown = true;
        }
    };
    const hideSpinner = () => {
        dom.spinner3d.classList.remove('show');
        spinnerShown = false;
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
    dom.btnParts?.classList.toggle('active', partsVisible);
    const surfaceBuilder = createSurfaceBuilder();
    let rebuildSurfaces = async (syncComponentBodies = false) => false;
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
    const boardData = () => board2DDataFromApp(app);
    const ensureBoard2D = () => {
        if (!board2d) board2d = new Board2D(dom.canvas2d);
        return board2d;
    };
    const paint2DBackground = () => {
        const canvas = dom.canvas2d;
        const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Board preview requires a 2D canvas.');
        paintViewerBackground(context, canvas.width, canvas.height);
    };

    const applySceneLayerOpacity = () => {
        if (!scene) return;
        const styles = getLayerStylesAppearance();
        /**
         * @param {{opacity: number, transparent: boolean, needsUpdate: boolean}} mat
         * @param {number} opacity
         */
        const applyMat = (mat, opacity) => {
            const o = Math.max(0, Math.min(1, Number(opacity) || 0));
            mat.opacity = o;
            mat.transparent = o < 0.999;
            mat.needsUpdate = true;
        };
        applyMat(scene.boardMaterial, styles.board.o);
        applyMat(scene.maskCoatMaterial, styles.soldermask.o);
        applyMat(scene.copperMaterial, styles.tracks.o);
        applyMat(scene.viaMaterial, styles.vias.o);
        applyMat(scene.silkMaterial, styles.silkscreen.o);
        applyMat(scene.padMaterial, styles.pads.o);
    };

    /** @type {LayerStyleKey} */
    let styleLayer = 'board';
    /** @param {number} n */
    const hex2 = (n) => Number(n).toString(16).padStart(2, '0').toUpperCase();
    const updateStyleWindow = () => {
        const styles = getLayerStylesAppearance();
        const layer = styles[styleLayer] || styles.board;
        const [r, g, b] = hsvToRgb(layer.h, layer.s, layer.v);
        const hPaint = ((Math.round(layer.h) % 360) + 360) % 360;
        const sPaint = Math.round(layer.s * 100);
        const vPaint = Math.round(layer.v * 100);
        const oByte = Math.round(layer.o * 255);
        if (dom.styleLayer) dom.styleLayer.value = styleLayer;
        if (dom.styleH) dom.styleH.value = String(hPaint);
        if (dom.styleS) dom.styleS.value = String(sPaint);
        if (dom.styleV) dom.styleV.value = String(vPaint);
        if (dom.styleO) dom.styleO.value = String(oByte);
        if (dom.styleHVal) dom.styleHVal.textContent = String(hPaint);
        if (dom.styleSVal) dom.styleSVal.textContent = String(sPaint);
        if (dom.styleVVal) dom.styleVVal.textContent = String(vPaint);
        if (dom.styleOVal) dom.styleOVal.textContent = String(oByte);
        if (dom.styleChip) {
            dom.styleChip.style.background = `rgb(${r},${g},${b})`;
        }
        if (dom.styleChipOpaque) {
            dom.styleChipOpaque.style.background =
                `linear-gradient(0deg, rgba(${r},${g},${b},${layer.o}), rgba(${r},${g},${b},${layer.o})), ` +
                'repeating-conic-gradient(#8a8f96 0 25%, #d2d6dc 0 50%) 50% / 10px 10px';
        }
        if (dom.styleRgb) {
            dom.styleRgb.textContent =
                `#${hex2(r)}${hex2(g)}${hex2(b)}  rgb(${r},${g},${b})  a ${oByte}/255`;
        }
        if (dom.stylePaint) {
            dom.stylePaint.textContent =
                `HSV: ${hPaint},${sPaint},${vPaint} · sRGB values (screenshots on wide-gamut displays may read differently)`;
        }
    };

    /**
     * @param {Partial<Record<LayerStyleKey, Partial<LayerStyle>>>} patch
     * @param {{rebuild?: boolean}} [options]
     */
    const applyLayerStyleChange = (patch, { rebuild = true } = {}) => {
        setLayerStylesAppearance(patch);
        if (scene) {
            if (rebuild) rebuildSurfaces();
            applySceneLayerOpacity();
            scene.requestRender();
        }
        if (board2d && (panel.view === 'top' || panel.view === 'bottom')) board2d.render();
        updateStyleWindow();
    };

    dom.styleBtn?.addEventListener('click', () => {
        dom.styleWin?.classList.toggle('hide');
        updateStyleWindow();
    });
    dom.styleClose?.addEventListener('click', () => {
        dom.styleWin?.classList.add('hide');
    });
    dom.styleLayer?.addEventListener('change', () => {
        styleLayer = /** @type {LayerStyleKey} */ (String(dom.styleLayer.value || 'board'));
        updateStyleWindow();
    });
    dom.styleH?.addEventListener('input', () => {
        applyLayerStyleChange({ [styleLayer]: { h: Number(dom.styleH.value) } }, { rebuild: true });
    });
    dom.styleS?.addEventListener('input', () => {
        applyLayerStyleChange({ [styleLayer]: { s: Number(dom.styleS.value) / 100 } }, { rebuild: true });
    });
    dom.styleV?.addEventListener('input', () => {
        applyLayerStyleChange({ [styleLayer]: { v: Number(dom.styleV.value) / 100 } }, { rebuild: true });
    });
    dom.styleO?.addEventListener('input', () => {
        applyLayerStyleChange({ [styleLayer]: { o: Number(dom.styleO.value) / 255 } }, { rebuild: false });
    });
    updateStyleWindow();

    /** Window/title text reflecting whether the flat 2D or orbit 3D view is active. */
    const popTitle = () =>
        (panel.view === 'top' || panel.view === 'bottom')
            ? 'ClearPCB — 2D View'
            : 'ClearPCB — 3D View';

    // ── View mode (3D ⇄ flat 2D top/bottom) ─────────────────────────────
    // One shared sliding panel hosts both views; `panel.view` decides which
    // canvas (WebGL vs 2D) is shown and which toolbar button is highlighted.
    const viewSync = createBoardViewSync({
        refresh3D: () => { return rebuildSurfaces(true); },
        refresh2D: () => { board2d?.setData(boardData()); },
        on3DSettled: ({ dirty }) => { if (dirty) syncScheduler.schedulePending(); },
    });
    let viewRevision = 0;
    const applyView = (/** @type {'3d'|'top'|'bottom'} */ view) => {
        const revision = ++viewRevision;
        /** @type {Promise<void>|undefined} */
        let loading;
        panel.view = view;
        if (view === 'top' || view === 'bottom') {
            host.classList.add('cpcb3d-mode2d');
            dom.btn2dTop?.classList.toggle('active', view === 'top');
            dom.btn2dBottom?.classList.toggle('active', view === 'bottom');
            if (dom.hint) dom.hint.textContent = 'Drag to pan · Wheel to zoom';
            if (board2d) {
                board2d.setData(boardData(), view);
                dom.spinner2d.classList.remove('show');
            } else {
                paint2DBackground();
                dom.spinner2d.classList.add('show');
                loading = (async () => {
                    await nextFrame();
                    await nextFrame();
                    if (revision !== viewRevision || panel.closed || panel.hidden) return;
                    ensureBoard2D().setData(boardData(), view);
                    dom.spinner2d.classList.remove('show');
                })().catch(error => {
                    console.error('Failed to load 2D board preview:', error);
                    setStatus(`Failed to load 2D board preview: ${error instanceof Error ? error.message : String(error)}`);
                    dom.spinner2d.classList.remove('show');
                });
            }
        } else {
            host.classList.remove('cpcb3d-mode2d');
            const alreadyStarted = build3DStarted;
            ensure3D();
            if (alreadyStarted && !panel.hidden && !panel.closed && !isBoardViewRefreshSuspended(app)) viewSync.flush('3d');
            scene?.resize();
            scene?.requestRender();
            if (dom.hint) dom.hint.textContent =
                'Drag to orbit · Right-drag to pan · Wheel to zoom';
        }
        // Keep a torn-off window's title in sync with the active view.
        if (panel.mode === 'popped' && panel.popWin && !panel.popWin.closed) {
            try { panel.popWin.document.title = popTitle(); } catch { /* ignore */ }
        }
        app.refreshPcbRibbon?.();
        return loading;
    };
    panel.setView = applyView;

    // ── Lazy 3D build ───────────────────────────────────────────────────
    // Runs once, the first time the 3D view is shown. Creates the WebGL scene,
    // builds every board surface, then streams component bodies + STEP models.
    const ensure3D = () => {
        if (build3DStarted) return;
        build3DStarted = true;
        revealSpinner();

        // The render loop schedules its frames on whichever window currently
        // hosts the canvas (see ThreeScene._raf), so tearing the view into a
        // pop-up keeps it animating even when that pop-up is maximised over
        // (and throttles) the main window. The scene runs on this JS thread.
        scene = new ThreeScene(window, dom.canvas);
        applySceneLayerOpacity();
        panel.scene = scene;

    // ── Model fetching (KiCad WRL/STEP, cached per model) ────────────────
    const fetcher = getComponentLibrary()?.kicadFetcher;
    /** @type {Map<string, Promise<string|null>>} model URL or footprint → colored OBJ text */
    const modelCache = new Map();
    /**
     * The coloured OBJ for a placement's KiCad model: the model its component
     * carries (the one the component picker and the part's own 3D view show),
     * else the one the footprint's library lists.
     * @param {{model3dUrl?: string|null, footprint?: string}} pl
     */
    const fetchModel = (pl) => {
        const key = pl.model3dUrl || pl.footprint || '';
        if (modelCache.has(key)) return modelCache.get(key);
        const p = (async () => {
            try {
                let modelUrl = pl.model3dUrl || '';
                if (!modelUrl) {
                    const avail = await fetcher?.checkFootprintAvailability(pl.footprint || '');
                    if (!avail?.has3d || !avail.modelUrl) return null;
                    modelUrl = avail.modelUrl;
                }
                // Convert via the shared resolver so the async path produces the
                // SAME colored OBJ (inline `newmtl`/`Kd`) the synchronous
                // model3dObj path uses — not a flat-grey STEP mesh. This keeps
                // KiCad bodies coloured AND routed through objModelToMesh (which
                // applies KiCad's origin and height convention), so both paths render identically.
                const objText = await resolveObjFromModelUrl(modelUrl, fetcher?.corsProxy || '');
                return objText || null;
            } catch (err) {
                console.warn('3D model fetch failed for', key, err);
                return null;
            }
        })();
        modelCache.set(key, p);
        return p;
    };

    // ── Reusable surface builders (initial build + live re-sync) ────────
    // Each is one merged, single-draw-call mesh kept by handle so a live edit
    // can swap it without disturbing the camera or the component bodies. Every
    // surface is clipped to the board outline so copper/via/silk/text/pads that
    // overhang the edge are trimmed at the boundary rather than floating.
    /** @type {{board:THREE.Mesh|null,maskOpenings:THREE.Mesh|null,copper:THREE.Mesh|null,via:THREE.Mesh|null,pads:THREE.Mesh|null,maskCoatTop:THREE.Mesh|null,maskCoatBottom:THREE.Mesh|null,silk:THREE.Mesh|null,silkArtwork:THREE.Mesh|null,text:THREE.Mesh|null}} */
    const surf = {
        board: null,
        maskOpenings: null,
        copper: null,
        via: null,
        pads: null,
        maskCoatTop: null,
        maskCoatBottom: null,
        silk: null,
        silkArtwork: null,
        text: null,
    };
    const swapSurface = createSurfacePublisher({ getScene: () => scene, surf, order: BOARD_SURFACE_ORDER });
    let hasSurfaces = false;
    const silkArtworkMesh = createSilkArtworkMeshCache();
    rebuildSurfaces = async (syncComponentBodies = false) => {
        try {
            const frame = boardSurfaceFrame(app);
            const { boundary } = frame;
            const surfaces = buildBoardSurfaceInputs(app, frame, silkArtworkMesh);
            const result = await surfaceBuilder.build(surfaces, { takeOwnership: true });
            if (!result || panel.closed || !scene) return false;
            if (panel.hidden || panel.view !== '3d'
                || areDragOverlaysDeferred(app) || isFillRefreshSuspended(app) || isFillRefreshScheduled(app)
                || isBoardViewRefreshSuspended(app) || (isFillRefreshPending(app) && app.copperFills?.length)) {
                viewSync.invalidate();
                return false;
            }
            publishBoardSurfaces(swapSurface, Object.keys(surf), result, boardSurfaceMaterials(scene));
            if (syncComponentBodies) syncBodies();
            scene.positionGlint(boundary.x + boundary.w / 2, boundary.y + boundary.h / 2, Math.max(boundary.w, boundary.h));
            if (!hasSurfaces) { hasSurfaces = true; scene.frameAll(); }
            scene.requestRender();
            return true;
        } catch (error) {
            console.warn('3D surface build failed', error);
            viewSync.invalidate();
            setStatus('3D update failed');
            return false;
        }
    };

    // ── Component bodies (OBJ now, STEP lazily, diffed on live re-sync) ──
    /** @type {Set<string>} ids currently showing a real (OBJ/STEP) model */
    const resolved = new Set();
    /** @type {Map<string, string>} id → placement signature (change detection) */
    const bodySig = new Map();
    const placementSig = (/** @type {any} */ pl) =>
        `${pl.x}|${pl.y}|${pl.rotation || 0}|${pl.side || 'top'}|${pl.mirror ? 1 : 0}|${pl.footprint || ''}|${pl.model3dObj ? 1 : 0}|${pl.model3dUrl || ''}`;

    // Build the immediate (synchronous) body for a placement: a real OBJ body if
    // the part carries one in memory, otherwise a fallback box. STEP models load
    // asynchronously afterward via loadModelFor.
    const addBody = (/** @type {string} */ id, /** @type {any} */ pl) => {
        if (!scene) return;
        let body = null;
        if (pl.model3dObj) {
            const parsed = parseObjModel(pl.model3dObj);
            body = parsed && objModelToMesh(parsed, pl);
        }
        // Group component bodies by colour so coincident markings/pads on the
        // shell get a stepped depth bias and don't z-fight (see addMesh).
        const mesh = scene.addMesh(body || fallbackBoxMesh(pl), undefined, true);
        mesh.visible = partsVisible;
        bodyMeshes.set(id, mesh);
        if (body) resolved.add(id); else resolved.delete(id);
        bodySig.set(id, placementSig(pl));
    };

    // Fetch + apply the KiCad model (WRL/STEP → coloured OBJ) for one
    // placement, cached per model. Re-checks the signature before applying
    // so a model that arrives after the component was moved/removed is not
    // stamped onto a now-stale body.
    const loadModelFor = async (/** @type {string} */ id, /** @type {any} */ pl) => {
        if (!scene) return;
        if (resolved.has(id)) return;
        if (!pl.model3dUrl && (!fetcher || !(pl.footprint || '').includes(':'))) return;
        const objText = await fetchModel(pl);
        if (panel.closed) return;
        const obj = bodyMeshes.get(id);
        if (objText && obj && bodySig.get(id) === placementSig(pl)) {
            const parsed = parseObjModel(objText);
            const mesh = parsed && objModelToMesh(parsed, pl);
            if (mesh) { scene.replaceMesh(obj, mesh, true); resolved.add(id); }
        }
    };

    // Diff component bodies against the current placements: only new, removed or
    // moved components are rebuilt — unchanged ones (the common case while
    // routing tracks) keep their already-loaded STEP models untouched.
    syncBodies = () => {
        if (!scene) return;
        const ids = new Set();
        /** @type {Array<[string, any]>} Placement model-load queue carries live placement objects with optional 3D source fields. */
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
        // Reveal the spinner before preparing the worker input, then stream
        // component bodies and STEP models after the surfaces are ready.
        (async () => {
            startedAt = performance.now();
            lastYieldAt = startedAt;
            revealSpinner();
            await nextFrame();
            await nextFrame();
            if (panel.closed) { hideSpinner(); return; }

            await rebuildSurfaces();
            if (panel.closed) return;
            scene.resize();
            scene.requestRender();
            // Polygon-boolean board notching (edge-crossing cutouts) needs
            // clipper; if it loads after this first build, rebuild once ready.
            if (!isClipperReady()) {
                loadClipper().then(() => {
                    const currentScene = scene;
                    if (!panel.closed && currentScene) { rebuildSurfaces(); currentScene.requestRender(); }
                }).catch(() => {});
            }
            await nextFrame();
            if (panel.closed) { hideSpinner(); return; }
            await nextFrame();
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
    dom.btn2dTop?.addEventListener('click', () => { setLastBoard2DSide(app, 'top'); applyView('top'); });
    dom.btn2dBottom?.addEventListener('click', () => { setLastBoard2DSide(app, 'bottom'); applyView('bottom'); });

    // The 2D canvas is a plain board preview; suppress the browser context menu
    // so right-drag panning never pops up the default menu.
    dom.canvas2d?.addEventListener('contextmenu', (e) => e.preventDefault());

    // ── Save Image: export the current flat 2D view as a PNG ────────────
    dom.btn2dSave?.addEventListener('click', () => {
        const b2 = board2d;
        if (!b2) return;
        /** @param {Blob|null} blob */
        const done = (blob) => {
            if (!blob) return;
            const side = panel.view === 'bottom' ? 'bottom' : 'top';
            const base = projectBaseName(app, 'board');
            savePcbBlob(blob, `${base}-${side}.png`, {
                description: 'PNG image',
                accept: { 'image/png': ['.png'] },
                win: panel.mode === 'popped' ? panel.popWin : window,
            });
        };
        // Supersampled capture (matches the 3D Save Image quality).
        b2.captureBlob(done, 3);
    });

    // ── Save Image (3D): export the current orbit view as a PNG ─────────
    dom.btn3dSave?.addEventListener('click', () => {
        scene?.captureBlob((blob) => {
            if (!blob) return;
            const base = projectBaseName(app, 'board');
            savePcbBlob(blob, `${base}-3d.png`, {
                description: 'PNG image',
                accept: { 'image/png': ['.png'] },
                win: panel.mode === 'popped' ? panel.popWin : window,
            });
        });
    });

    // ── Parts toggle: show/hide every component body mesh ───────────────
    dom.btnParts?.addEventListener('click', () => {
        partsVisible = !partsVisible;
        for (const mesh of bodyMeshes.values()) mesh.visible = partsVisible;
        dom.btnParts?.classList.toggle('active', partsVisible);
        dom.btnParts?.classList.toggle('off', !partsVisible);
        scene?.requestRender();
    });

    // ── Live sync: mirror 2D edits into the 3D view ─────────────────────
    // PCB edits run through app.history; wrap its onChanged so every committed
    // edit schedules a rebuild. Coalesce notifications into the next frame;
    // drag and pour guards defer rebuilding until the board is ready.
    // Refresh the visible renderer; defer hidden 3D work until it is shown.
    const syncScheduler = createBoard3DSyncScheduler({ app, panel, viewSync, surfaceBuilder });
    const scheduleSync = syncScheduler.schedule;
    // Public hook so non-history edits (e.g. a schematic-driven re-sync that
    // adds/removes components) can refresh the 3D view too. PCB-side edits go
    // through history.onChanged below; schematic-side edits call panel.refresh.
    panel.refresh = scheduleSync;
    const prevOnChanged = app.history?.onChanged;
    /** @template {unknown[]} A */
    const onHistoryChanged = (/** @type {A} */ ...args) => {
        prevOnChanged?.(...args);
        scheduleSync();
    };
    if (app.history) app.history.onChanged = onHistoryChanged;

    // ── Pop out / dock / close ──────────────────────────────────────────
    let pollTimer = 0;
    // Keep the live canvases sized to the pop-up window. The 3D viewer's
    // ResizeObserver was created in the main document and stops firing once the
    // canvas is adopted into the pop-up, and Board2D has no observer at all — so
    // without this the backing store keeps its old size and the image stretches.
    const onPopResize = () => {
        scene?.resize();
        if (panel.view === 'top' || panel.view === 'bottom') board2d?.resize();
    };
    // Re-frame the active view to fit, deferred one frame in the host window so
    // the canvas has laid out at its new size before we compute the framing.
    const fitCurrentView = (/** @type {Window} */ w) => {
        const host = (w && typeof w.requestAnimationFrame === 'function') ? w : window;
        host.requestAnimationFrame(() => {
            if (panel.closed || panel.hidden) return;
            if (panel.view === 'top' || panel.view === 'bottom') {
                board2d?.resize();
                board2d?.fit();
            } else {
                scene?.resize();
                scene?.frameAll();
                scene?.requestRender();
            }
        });
    };
    const dock = () => {
        if (panel.mode !== 'popped') return;
        if (pollTimer) { window.clearInterval(pollTimer); pollTimer = 0; }
        try { panel.popWin?.removeEventListener('resize', onPopResize); } catch { /* ignore */ }
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
        fitCurrentView(window);
    };
    const popOut = () => {
        if (panel.mode === 'popped') { panel.popWin?.focus(); return; }
        const win = window.open('', 'clearpcb3d', 'width=980,height=720');
        if (!win) { setStatus('Pop-up blocked — allow pop-ups to tear off'); return; }
        const wd = win.document;
        try {
            wd.documentElement.style.background = VIEWER_BACKGROUND.edge;
            wd.documentElement.style.colorScheme = 'dark';
        } catch { /* ignore */ }
        wd.title = popTitle();
        ensure3DStyles(wd);
        const base = wd.createElement('style');
        base.textContent = `html,body{margin:0;height:100%;background:${VIEWER_BACKGROUND.edge};overflow:hidden}`
            + '.cpcb3d-host{position:absolute;inset:0}';
        (wd.head || wd.documentElement).appendChild(base);
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
        win.addEventListener('resize', onPopResize);
        scene?.resize();
        if (panel.view === 'top' || panel.view === 'bottom') board2d?.resize();
        fitCurrentView(win);
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
        syncScheduler.cancel();
        surfaceBuilder.dispose();
        if (slideTimer) { window.clearTimeout(slideTimer); slideTimer = 0; }
        // Unhook the live-sync wrapper (only if nothing re-wrapped after us).
        if (app.history && app.history.onChanged === onHistoryChanged) {
            app.history.onChanged = prevOnChanged;
        }
        window.removeEventListener('pointermove', onSplitMove);
        window.removeEventListener('pointerup', onSplitUp);
        hideSpinner();
        dom.spinner2d.classList.remove('show');
        scene?.dispose();
        board2d?.dispose();
        if (panel.mode === 'popped' && panel.popWin && !panel.popWin.closed) {
            try { panel.popWin.close(); } catch { /* ignore */ }
        }
        host.remove();
        splitter.remove();
        clearBoardViewPanel(app, panel);
        app.refreshPcbRibbon?.();
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
        app.refreshPcbRibbon?.();
        // Slide the overlay out to the right; the editor underneath is untouched.
        slideOut(() => {
            host.style.display = 'none';
        });
    };
    const showPanel = () => {
        if (panel.closed || !panel.hidden) return;
        panel.hidden = false;
        app.refreshPcbRibbon?.();
        slideIn(() => {
            scene?.resize();
            if (panel.view === 'top' || panel.view === 'bottom') board2d?.resize();
            scheduleSync();
        });
    };
    panel.hide = hidePanel;
    panel.show = showPanel;

    dom.btnPop?.addEventListener('click', () => (panel.mode === 'popped' ? dock() : popOut()));
    dom.btnClose?.addEventListener('click', hidePanel);

    // Let the panel become visible before synchronous canvas/scene preparation.
    host.classList.toggle('cpcb3d-mode2d', initialView !== '3d');
    host.style.backgroundColor = VIEWER_BACKGROUND.edge;
    if (initialView !== '3d') paint2DBackground();
    if (dom.hint && initialView !== '3d') dom.hint.textContent = 'Drag to pan · Wheel to zoom';
    if (initialView === '3d') revealSpinner();
    else dom.spinner2d.classList.add('show');
    await new Promise(resolve => slideIn(() => resolve(undefined)));
    if (!panel.closed && !panel.hidden) {
        // transitionend runs before paint; yield again so the loading state
        // is actually on screen before the first expensive artwork build.
        await nextFrame();
        await nextFrame();
        if (!panel.closed && !panel.hidden) await applyView(panel.view);
    }
}
