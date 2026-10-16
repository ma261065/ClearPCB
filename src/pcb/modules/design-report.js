/**
 * On-demand PCB reports for automation clients (MCP): a design rule check that
 * does not wait on animation frames, and a whole-board PNG render.
 *
 * Interactive DRC is scheduled after pours settle (drc-refresh.js), and pours
 * recompute after a frame, which never arrives in a hidden tab. These helpers
 * bring pours and the ratsnest up to date synchronously instead.
 */

import { runDRC } from './drc.js';
import { drcRulesFor } from './drc-refresh.js';
import { recomputeFillsNow } from './fill-refresh.js';
import { getComputedFill } from './computed-fill-cache.js';
import { loadClipper } from './copper-fill-geom.js';
import { reconcileRatsnest } from './ratsnest.js';
import { refreshStatus } from './refresh-state.js';
import { clonePcbViewportForExport, listArtworkLayers } from './pcb-export.js';
import { rasterizeSvgToPng } from '../../shared/ui/export.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/** @param {number} value */
const round = value => Math.round(value * 1000) / 1000;

/**
 * Recompute pours and the ratsnest now, so DRC and renders see the current board.
 * @param {PcbEditor} app
 * @returns {Promise<string[]>} Reasons the derived state may still be stale.
 */
export async function settlePcbDerivedState(app) {
    const fills = app.pcbDocument.copperFills || [];
    if (fills.length) {
        await loadClipper();
        const status = refreshStatus(app);
        if (status.fillPending || status.fillScheduled || status.fillError
            || fills.some(fill => !getComputedFill(fill))) {
            recomputeFillsNow(app);
        }
    }
    reconcileRatsnest(app, { skipFillRefresh: true });
    const status = refreshStatus(app);
    const stale = [];
    if (status.overlaysDeferred || status.fillSuspended || app.isSectionEditing()) stale.push('an edit is in progress in the PCB editor');
    if (status.pictureCopperPending) stale.push('picture copper is still being processed');
    if (status.fillError) stale.push('copper pours failed to compute');
    else if (status.fillPending) stale.push('copper pours are not yet computed');
    return stale;
}

/**
 * Run the full design rule check against the current board.
 * @param {PcbEditor} app
 * @param {{limit?: number}} [options] Maximum violations listed (counts cover all).
 */
export async function pcbDesignRuleReport(app, { limit = 100 } = {}) {
    const stale = await settlePcbDerivedState(app);
    const result = runDRC(app, drcRulesFor(app));
    /** @type {Record<string, number>} */
    const byRule = {};
    for (const violation of result.violations) byRule[violation.rule] = (byRule[violation.rule] || 0) + 1;
    return {
        ok: result.ok,
        upToDate: stale.length === 0,
        ...(stale.length ? { stale } : {}),
        units: 'mm',
        counts: { ...result.counts, total: result.violations.length, byRule },
        truncated: result.violations.length > limit,
        violations: result.violations.slice(0, limit).map(violation => ({
            rule: violation.rule,
            severity: violation.severity,
            message: violation.message,
            x: round(violation.x),
            y: round(violation.y),
            ...(typeof violation.marker?.net === 'string' && violation.marker.net ? { net: violation.marker.net } : {}),
        })),
    };
}

/**
 * Render every populated artwork layer, in colour on black, cropped to the artwork.
 * @param {PcbEditor} app
 * @param {{maxSize?: number}} [options] Longer image side in pixels.
 */
export async function renderPcbPng(app, { maxSize = 1600 } = {}) {
    await settlePcbDerivedState(app);
    const layers = new Set(listArtworkLayers(app).filter(layer => layer.populated).map(layer => layer.id));
    if (!layers.size) throw new Error('The PCB has no artwork to render.');
    // Render the whole design regardless of the user's layer visibility. The
    // clone is synchronous, so the temporarily shown layers are never painted.
    const hidden = [];
    for (const [id, group] of app.existingLayerGroups()) {
        const owner = id === 'top-fill' ? 'top-copper' : id === 'bottom-fill' ? 'bottom-copper' : id;
        if (layers.has(owner) && group.style.display === 'none') {
            hidden.push(group);
            group.style.display = '';
        }
    }
    let svgNode;
    try {
        ({ svgNode } = clonePcbViewportForExport(app, { layers, mono: false, invert: true, scaleMode: 'actual', scalePercent: 100 }));
    } finally {
        for (const group of hidden) group.style.display = 'none';
    }
    const [x, y, width, height] = String(svgNode.getAttribute('viewBox')).split(/\s+/).map(Number);
    const image = await rasterizeSvgToPng(svgNode, maxSize);
    return {
        ...image,
        view: 'pcb',
        units: 'mm',
        bounds: { x: round(x), y: round(y), width: round(width), height: round(height) },
        layers: [...layers],
    };
}
