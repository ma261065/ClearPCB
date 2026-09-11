import { REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from './footprint.js';
import { renderTrack, renderVia, removeTrackElements, removeViaElements } from './track-render.js';
import { reconcileRatsnest } from './track-draw.js';
import { clearTrackSelection, getSelectedTrack } from './track-select.js';
import { createPcbText, serializePcbText } from './pcb-text.js';
import { serializeBoardShapes, loadBoardShapes, removeBoardShapeElement, renderBoardShape } from './board-shapes.js';
import { Track } from '../../shapes/track.js';
import { Via, resetViaIdCounter, updateViaIdCounter } from '../../shapes/via.js';
import { CopperFill, updateFillIdCounter } from '../../shapes/copper-fill.js';
import { createShape } from '../../shapes/index.js';
import { serializeGridSettings, restoreGridSettings } from '../../ui/modules/viewport.js';

/** @param {any} app */
export function serializePcb(app) {
    /** @type {Record<string, {x:number, y:number, rotation:number, mirror?:boolean, side?:string, refVisible?:boolean, refDx?:number, refDy?:number, refRot?:number, refSize?:number, refStrokeWidth?:number}>} */
    const placements = {};
    for (const [id, p] of app._placementOverrides) {
        placements[id] = { x: p.x, y: p.y, rotation: p.rotation || 0 };
        if (p.mirror) placements[id].mirror = true;
        if (p.side === 'bottom') placements[id].side = 'bottom';
        if (p.refVisible === false) placements[id].refVisible = false;
        if (p.refDx) placements[id].refDx = p.refDx;
        if (p.refDy) placements[id].refDy = p.refDy;
        if (p.refRot) placements[id].refRot = p.refRot;
        if (p.refSize && p.refSize !== REF_DEFAULT_SIZE) placements[id].refSize = p.refSize;
        if (p.refStrokeWidth && p.refStrokeWidth !== REF_DEFAULT_STROKE) placements[id].refStrokeWidth = p.refStrokeWidth;
    }
    // Per-project design rules (track/clearance/via sizes are canonical mm;
    // units/router record the user's display + routing preferences).
    const routing = app._getRoutingParams();
    const design = {
        trackWidth: routing.trackWidth,
        clearance: routing.clearance,
        viaDiameter: routing.viaDiameter,
        viaDrill: routing.viaDrill,
        units: /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbRouteUnits'))?.value || 'mm',
        router: app._getRouterMode(),
    };
    return {
        board: {
            width: app._boardWidth,
            height: app._boardHeight,
            radius: app._boardRadius,
        },
        design,
        settings: serializeGridSettings(app.viewport),
        tracks: app.tracks.map(t => t.toJSON()),
        vias: app.vias.map(v => v.toJSON()),
        boardShapes: serializeBoardShapes(app),
        texts: [...app.texts.values()].map(serializePcbText),
        placements,
    };
}

export function preparePcb(data) {
    const stage = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(stage, data?.boardShapes, { render: false, strict: true });
    const tracks = (data?.tracks || []).map((item) => {
        const track = createShape(item);
        if (!(track instanceof Track)) throw new Error('Invalid PCB track.');
        return track;
    });
    for (const item of data?.fills || []) stage.boardShapes.push(CopperFill.fromJSON(item));
    return { tracks, vias: (data?.vias || []).map((item) => Via.fromJSON(item)),
        texts: (data?.texts || []).map((item) => createPcbText(item)),
        boardShapes: stage.boardShapes, shapeIdCounter: stage._shapeIdCounter };
}

/** @param {any} app */
export function loadPcb(app, data, prepared = preparePcb(data)) {
    // Need a viewport in place before we can render into layer
    // groups (autosave-recovery may call this before the user has
    // ever activated the PCB tab).
    app._ensureViewport();
    // Drop any existing tracks/vias and their SVG.
    for (const t of app.tracks) removeTrackElements(t);
    for (const v of app.vias) removeViaElements(v);
    app.tracks.length = 0;
    app.vias.length = 0;
    resetViaIdCounter();
    for (const id of app._shapeElements.keys()) removeBoardShapeElement(app, id);
    app.boardShapes.length = 0;
    app._shapeIdCounter = 1;
    app._hoveredShape = null;
    app._shapeDraw = null;
    app._shapeDrag = null;
    app._updateCopperCuts?.();
    // Copper pours live in boardShapes; clear their SVG state.
    app._clearFillGroups?.();
    // Drop any existing free-standing texts.
    for (const id of app._textElements.keys()) app._removeTextElement(id);
    app.texts.clear();
    clearTrackSelection(app);
    app.history.clear?.();

    // A new/opened document invalidates any current DRC results, so close
    // the problem panel and clear its marker/leader.
    app._closeDRCPanel?.();
    app._drcSelectedId = null;
    app._clearDRCMarker?.();
    app._drcViolations = [];

    // Reset the board outline to "undrawn" so a document without board
    // dimensions (a brand-new board) prompts for them on activation, and a
    // loaded document gets a clean slate before its outline is restored.
    app._selectBoardOutline?.(false);
    app._getLayerGroup('board-outline')
        ?.querySelector('.pcb-board-outline')?.remove();
    app._boardOutlineDrawn = false;
    app._boardWidth = 100;
    app._boardHeight = 80;
    app._boardRadius = 0;

    // Restore manual footprint position overrides. These are applied when
    // _placeFootprints rebuilds the placements from the schematic; if
    // placements already exist (sync ran first), re-apply immediately.
    app._placementOverrides.clear();

    if (!data) {
        app.markSectionClean();
        return;
    }

    // Restore per-project design parameters (track/clearance/via sizes,
    // units, router) onto the ribbon inputs. Documents that predate this
    // field simply keep the current localStorage working defaults.
    if (data.design) app._applyProjectDesignParams(data.design);
    restoreGridSettings(app, data.settings);

    // Restore the saved board outline so it survives save/reopen and
    // autosave-recovery (the dimensions are part of the document).
    if (data.board && data.board.width > 0 && data.board.height > 0) {
        app._boardWidth = data.board.width;
        app._boardHeight = data.board.height;
        app._boardRadius = data.board.radius || 0;
        app._drawBoardOutline();
    }

    if (data.placements && typeof data.placements === 'object') {
        for (const [id, p] of Object.entries(data.placements)) {
            if (!p) continue;
            app._placementOverrides.set(id, {
                x: Number(p.x) || 0,
                y: Number(p.y) || 0,
                rotation: Number(p.rotation) || 0,
                mirror: !!p.mirror,
                side: p.side === 'bottom' ? 'bottom' : 'top',
                refVisible: p.refVisible !== false,
                refDx: Number(p.refDx) || 0,
                refDy: Number(p.refDy) || 0,
                refRot: ((Number(p.refRot) || 0) % 360 + 360) % 360,
                refSize: Number(p.refSize) || REF_DEFAULT_SIZE,
                refStrokeWidth: Number(p.refStrokeWidth) || REF_DEFAULT_STROKE,
            });
        }
        if (app.placements.size) app._applyPlacementOverrides();
    }

    for (const track of prepared.tracks) {
        app.tracks.push(track);
        renderTrack(track, (id) => app._getLayerGroup(id), {
            viaDiameter: app._getRoutingParams?.()?.viaDiameter,
            viaDrill: app._getRoutingParams?.()?.viaDrill,
            hideNetLabel: track === getSelectedTrack(app),
        });
    }
    for (const via of prepared.vias) {
        updateViaIdCounter(via.id);
        app.vias.push(via);
        renderVia(via, (id) => app._getLayerGroup(id));
    }
    app._shapeIdCounter = prepared.shapeIdCounter;
    for (const shape of prepared.boardShapes) {
        app.boardShapes.push(shape);
        if (shape.type === 'fill') updateFillIdCounter(shape.id);
        else renderBoardShape(app, shape);
    }
    for (const text of prepared.texts) {
        app.texts.set(text.id, text);
        app._renderText(text);
    }
    // Re-evaluate ratlines once the model is in place.
    reconcileRatsnest(app);
    // Compute and render the pours now that obstacles are loaded.
    app._refreshFills();
    // Loading a document is not a user edit — start from a clean slate so
    // a freshly opened/recovered board isn't immediately treated as having
    // unsaved PCB changes (which would re-trigger autosave after a save).
    app._isDirty = false;
}

/** @param {any} app */
export function applyProjectDesignParams(app, design) {
    if (!design || typeof design !== 'object') return;
    const inputEl = (id) => /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    const units = design.units === 'inch' ? 'inch' : 'mm';
    const unitsEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbRouteUnits'));
    const routerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbRouterMode'));
    if (unitsEl) unitsEl.value = units;
    if (routerEl && (design.router === 'pathfinder' || design.router === 'maze')) routerEl.value = design.router;
    const fromMM = units === 'inch' ? 1 / 25.4 : 1;
    const digits = units === 'inch' ? 4 : 3;
    const map = { trackWidth: 'pcbTrackWidth', clearance: 'pcbClearance', viaDiameter: 'pcbViaDiameter', viaDrill: 'pcbViaDrill' };
    for (const [key, id] of Object.entries(map)) {
        const mmVal = Number(design[key]);
        const el = inputEl(id);
        if (el && Number.isFinite(mmVal) && mmVal > 0) {
            el.value = String(Number((mmVal * fromMM).toFixed(digits)));
            el.step = units === 'inch' ? '0.001' : '0.01';
        }
    }
    // Keep the unit-toggle baseline (owned by controls.js) in sync, else a
    // later unit switch early-returns and leaves mismatched values.
    app._routeParamUnit = units;
    // Mirror controls.js saveDesignParams so these also become the working
    // defaults (key must match DESIGN_PARAMS_KEY in controls.js).
    try {
        /** @type {Record<string, string>} */
        const stored = { units, router: routerEl?.value || 'maze' };
        for (const id of ['pcbTrackWidth', 'pcbClearance', 'pcbViaDiameter', 'pcbViaDrill']) {
            const el = inputEl(id);
            if (el) stored[id] = el.value;
        }
        localStorage.setItem('clearpcb_pcb_design_params', JSON.stringify(stored));
    } catch { /* storage unavailable — ignore */ }
}
