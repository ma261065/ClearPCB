/**
 * Owns schematic-to-PCB synchronization and footprint placement rendering.
 */
import { renderFootprint, REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../../shared/pcb/footprint.js';
import { setEditorStale, isEditorActive } from './pcb-editor-api.js';
import { disposeDrcRefresh } from './drc-refresh.js';
import { setDrcRatlines } from './drc-state.js';
import { refreshBoardViewPanel } from './refresh-state.js';
import { isBoardOutlineDrawn, drawBoardOutline } from './board-outline-resize.js';
import { clearTextElements, renderText } from './pcb-text-render.js';
import { renderTrack, renderVia, removeTrackElements, removeViaElements } from './track-render.js';
import { getSelectedTrack } from './track-select.js';
import { getVertexDrag } from './track-drag.js';
import { renderPad } from './pad.js';
import { renderBoardShape } from './board-shape-render.js';
import { getPcbSelection } from './selection-registry.js';
import { refreshBoxSelectionHighlights } from './box-select.js';
import { endRefDrag, drawRefOverlay } from './ref-text-selection.js';
import { renderPlacementPose, renderPlacementSide, applyPlacementRefVisible, placementTransform } from './track-commands.js';
import { resetPlacementCullView } from './component-selection.js';
import { clearCopperCuts } from './copper-cuts.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/pcb-placement-geometry.js').Placement} Placement */

const syncTimers = new WeakMap();
const hasContent = new WeakMap();

/** @param {PcbEditor} app @param {{hasContent?: boolean}} [state] */
export function initializeSchematicSyncState(app, state = {}) {
    syncTimers.set(app, null);
    hasContent.set(app, !!state.hasContent);
}

/** @param {PcbEditor} app @param {boolean} value */
export function setSchematicSyncHasContent(app, value) {
    hasContent.set(app, !!value);
}

/** @param {PcbEditor} app */
function clearSyncTimer(app) {
    const timer = syncTimers.get(app);
    if (timer !== null && timer !== undefined) clearTimeout(timer);
    syncTimers.set(app, null);
}

/**
 * Mark the PCB as needing a rebuild, scheduling it when the PCB pane is active.
 * @param {PcbEditor} app
 */
export function scheduleSchematicPcbSync(app) {
    app.cancelAutoRoute('Routing cancelled because the schematic changed.');
    setEditorStale(app, true);
    if (!isEditorActive(app)) return;

    clearSyncTimer(app);
    syncTimers.set(app, setTimeout(() => syncFromSchematic(app), 300));
}

/**
 * Rebuild the PCB content from the current schematic state.
 * @param {PcbEditor} app
 */
export function syncFromSchematic(app) {
    if (!isEditorActive(app)) {
        setEditorStale(app, true);
        clearSyncTimer(app);
        return;
    }
    clearSyncTimer(app);

    const project = /** @type {NonNullable<PcbEditor['project']>} */ (app.project);
    const schematic = project?.schematicDocument;
    if (!schematic) {
        setEditorStale(app, true);
        return;
    }
    setEditorStale(app, false);

    app.ensureViewport();

    const { placements, netlist } = project.synchronizePcbLayout();
    app.netlist = netlist;

    clearPcbContent(app);
    renderPersistentObjects(app, { renderShapes: placements.size === 0 });

    if (placements.size === 0) {
        app.refreshClearanceHalos();
        app.updateRatsnest();
        app.setStatus('No components in schematic');
        refreshBoardViewPanel(app);
        return;
    }

    app.getLayerGroup('ratlines');
    placeFootprints(app, placements);

    for (const shape of app.boardShapes) {
        if (shape.type === 'fill' || (isBoardOutlineDrawn(app) && shape.layer === 'board-outline')) continue;
        renderBoardShape(app, shape, { skipCopperUpdate: true });
    }
    app.updateCopperCuts();

    app.refreshClearanceHalos();
    app.updateRatsnest();

    if (!hasContent.get(app)) {
        fitToPlacedContent(app);
        hasContent.set(app, true);
    }

    app.setStatus(`${placements.size} component(s), ${netlist.length} net(s)`);
    refreshBoardViewPanel(app);
}

/**
 * Re-render persistent board model objects into the layer groups.
 * @param {PcbEditor} app
 * @param {{renderShapes?: boolean}} [options]
 */
export function renderPersistentObjects(app, { renderShapes = true } = {}) {
    const getGroup = /** @param {string} id */ (id) => app.getLayerGroup(id);

    if (isBoardOutlineDrawn(app)) {
        drawBoardOutline(app);
    }

    clearTextElements(app);
    for (const text of app.texts.values()) {
        renderText(app, text);
    }

    const routeParams = app.getRoutingParams();
    for (const track of app.tracks) {
        removeTrackElements(track);
        renderTrack(track, getGroup, {
            viaDiameter: routeParams?.viaDiameter,
            viaDrill: routeParams?.viaDrill,
            hideNetLabel: track === getSelectedTrack(app) || track === getVertexDrag(app)?.track,
        });
    }
    for (const via of app.vias) {
        removeViaElements(via);
        renderVia(via, getGroup);
    }
    for (const pad of app.pads || []) renderPad(pad, getGroup);
    for (const shape of app.boardShapes) {
        if (!renderShapes || shape.type === 'fill'
            || (isBoardOutlineDrawn(app) && shape.layer === 'board-outline')) continue;
        renderBoardShape(app, shape, { skipCopperUpdate: true });
    }
    if (renderShapes) app.updateCopperCuts();
    if (getPcbSelection(app).length) refreshBoxSelectionHighlights(app);
    if (app.copperFills.length) {
        app.refreshFills();
    }
}

/**
 * Remove all footprint, overlay and ratsnest SVG content from layer groups.
 * @param {PcbEditor} app
 */
export function clearPcbContent(app) {
    disposeDrcRefresh(app);
    setDrcRatlines(app, []);
    for (const group of app.existingLayerGroups().values()) {
        while (group.firstChild) group.removeChild(group.firstChild);
    }
    endRefDrag(app, false);
    drawRefOverlay(app, null, false);
    app.placements.clear();
    clearCopperCuts(app);
}

/**
 * Render model-resolved footprints onto PCB SVG layer groups.
 * @param {PcbEditor} app
 * @param {Map<string, Placement & {geometry: any}>} placements
 */
export function placeFootprints(app, placements) {
    for (const [compId, resolved] of placements) {
        const { geometry: fpGeom, ...placement } = resolved;
        const fpLayers = app.renderFootprint(fpGeom, /** @type {Placement & {reference: string}} */ (placement));

        /** @type {SVGGElement[]} */
        const elements = [];
        for (const [layerId, layerGroup] of fpLayers) {
            app.getLayerGroup(layerId).appendChild(layerGroup);
            elements.push(layerGroup);
        }

        app.placements.set(compId, {
            ...placement,
            elements,
            bounds: fpGeom.courtyard || fpGeom.outline,
            model3dPlacement: fpGeom.model3d || null,
        });
        buildLodPlaceholder(app, compId);
    }

    for (const compId of placements.keys()) {
        const placement = app.placements.get(compId);
        if (!placement) continue;
        if (placement.side === 'bottom') renderPlacementSide(app, compId, 'bottom');
        if (placement.refVisible === false) applyPlacementRefVisible(app, compId, false);
        if (placement.mirror || placement.side === 'bottom' || placement.rotation
            || placement.refDx || placement.refDy || placement.refRot) {
            renderPlacementPose(app, compId);
        }
        if (placement.refSize !== REF_DEFAULT_SIZE || placement.refStrokeWidth !== REF_DEFAULT_STROKE) {
            app.rerenderRef(compId);
        }
    }
}

/**
 * Render one resolved footprint's SVG layer groups.
 * @param {any} geometry
 * @param {Placement & {reference: string}} placement
 */
export function renderPcbFootprint(geometry, placement) {
    return renderFootprint(geometry, placement.reference, placement.x, placement.y, placement.rotation);
}

/**
 * Restore saved placement models, then replace only their footprint artwork.
 * @param {PcbEditor} app
 */
export function applyPlacementOverrides(app) {
    const project = app.project;
    if (!project) return;
    const placements = project.restorePcbPlacementOverrides(app.placements.keys());
    for (const compId of placements.keys()) {
        const placement = /** @type {Placement} */ (app.placements.get(compId));
        for (const element of placement.elements || []) element.remove();
        placement.lodEl?.remove();
    }
    placeFootprints(app, placements);
    app.updateRatsnest();
}

/**
 * Fit the viewport to show all placed content.
 * @param {PcbEditor} app
 */
export function fitToPlacedContent(app) {
    if (!app.viewport || !app.placements.size) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const placement of app.placements.values()) {
        for (const pad of placement.pads.values()) {
            minX = Math.min(minX, pad.x - 2);
            minY = Math.min(minY, pad.y - 2);
            maxX = Math.max(maxX, pad.x + 2);
            maxY = Math.max(maxY, pad.y + 2);
        }
    }
    if (!Number.isFinite(minX)) return;

    const padding = 10;
    app.viewport.fitToBounds(
        minX - padding, minY - padding,
        maxX + padding, maxY + padding,
    );
}

/**
 * @param {PcbEditor} app
 * @param {string} compId
 */
function buildLodPlaceholder(app, compId) {
    const placement = app.placements.get(compId);
    if (!placement || !placement.bounds) return;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'pcb-fp-lod culled');
    rect.setAttribute('x', String(placement.bounds.x));
    rect.setAttribute('y', String(placement.bounds.y));
    rect.setAttribute('width', String(placement.bounds.width));
    rect.setAttribute('height', String(placement.bounds.height));
    rect.setAttribute('pointer-events', 'none');
    rect.setAttribute('transform', placementTransform(placement));
    app.getLayerGroup('fp-lod').appendChild(rect);
    placement.lodEl = rect;
    resetPlacementCullView(placement);
}
