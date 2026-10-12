/**
 * Owns user-facing PCB fabrication import/export actions.
 */
import { errorMessage } from '../../core/errors.js';
import { exportDSN as buildDSN, importSES as parseSES } from './dsn.js';
import { hasFabricationContent } from './fabrication-snapshot.js';
import { openPanelizeDialog } from './panelization-ui.js';
import { generateGerberArchive, showGerberProgress } from './gerber-export.js';
import { generateBOM, generatePickAndPlace } from './assembly.js';
import { projectBaseName, savePcbBlob } from './pcb-export.js';
import { renderRouteResult } from './autorouter-actions.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/** @type {WeakMap<PcbEditor, boolean>} */
const gerberExportPending = new WeakMap();

/** @param {PcbEditor} app */
export function isGerberExportPending(app) {
    return gerberExportPending.get(app) === true;
}

/**
 * Export the current board as a Specctra DSN file and trigger download.
 * @param {PcbEditor} app
 */
export function exportDSN(app) {
    if (!app.placements.size || !app.netlist.length) {
        app.setStatus('Nothing to export');
        return;
    }

    const params = app.getRoutingParams();
    const dsn = buildDSN({
        placements: app.placements,
        netlist: app.netlist,
        trackWidth: params.trackWidth,
        clearance: params.clearance,
        viaDiameter: params.viaDiameter,
    });

    const blob = new Blob([dsn], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'board.dsn';
    link.click();
    URL.revokeObjectURL(url);

    app.setStatus('DSN exported — open in Freerouting, then Import SES');
}

/** @param {PcbEditor} app */
export function openPanelize(app) {
    app.ensureViewport();
    openPanelizeDialog(app);
}

/** @param {PcbEditor} app */
export async function exportGerber(app) {
    if (gerberExportPending.get(app)) return;
    if (!hasFabricationContent(app)) {
        app.setStatus('Nothing to export');
        return;
    }
    gerberExportPending.set(app, true);
    const suggestedName = `${projectBaseName(app, 'untitled')}-gerber.zip`;
    try {
        let fileCount = 0;
        const saved = await savePcbBlob(async () => {
            const result = await generateGerberArchive(app);
            fileCount = result.fileCount;
            /** @type {(label: string|null, value?: number|null) => void} */ (showGerberProgress)('Saving ZIP', 100);
            return result.blob;
        }, suggestedName, {
            description: 'Gerber ZIP archive',
            accept: { 'application/zip': ['.zip'] },
        });
        if (saved) app.setStatus(`Gerbers exported (${fileCount} files)`);
    } catch (err) {
        console.error('Gerber export failed:', err);
        app.setStatus(`Gerber export failed: ${errorMessage(err)}`);
    } finally {
        showGerberProgress(/** @type {string} */ (/** @type {unknown} */ (null)));
        gerberExportPending.set(app, false);
    }
}

/** @param {PcbEditor} app */
export function exportBOM(app) {
    if (!app.placements.size) {
        app.setStatus('No components to export');
        return;
    }
    let blob;
    try {
        const csv = generateBOM(app.placements);
        blob = new Blob([csv], { type: 'text/csv' });
    } catch (err) {
        console.error('BOM export failed:', err);
        app.setStatus(`BOM export failed: ${errorMessage(err)}`);
        return;
    }
    const suggestedName = `${projectBaseName(app, 'untitled')}-bom.csv`;
    savePcbBlob(blob, suggestedName, {
        description: 'CSV file',
        accept: { 'text/csv': ['.csv'] },
    }).then(saved => {
        if (saved) app.setStatus(`BOM exported (${app.placements.size} parts)`);
    }).catch(err => {
        console.error('BOM save failed:', err);
        app.setStatus(`BOM save failed: ${errorMessage(err)}`);
    });
}

/** @param {PcbEditor} app */
export function exportPickAndPlace(app) {
    if (!app.placements.size) {
        app.setStatus('No components to export');
        return;
    }
    let blob;
    try {
        const csv = generatePickAndPlace(app.placements);
        blob = new Blob([csv], { type: 'text/csv' });
    } catch (err) {
        console.error('Pick-and-place export failed:', err);
        app.setStatus(`Pick-and-place export failed: ${errorMessage(err)}`);
        return;
    }
    const suggestedName = `${projectBaseName(app, 'untitled')}-pick-and-place.csv`;
    savePcbBlob(blob, suggestedName, {
        description: 'CSV file',
        accept: { 'text/csv': ['.csv'] },
    }).then(saved => {
        if (saved) app.setStatus(`Pick-and-place exported (${app.placements.size} parts)`);
    }).catch(err => {
        console.error('Pick-and-place save failed:', err);
        app.setStatus(`Pick-and-place save failed: ${errorMessage(err)}`);
    });
}

/**
 * Prompt user to select an SES file and import routed tracks.
 * @param {PcbEditor} app
 */
export function importSES(app) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ses';
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const text = /** @type {string} */ (reader.result);
            const result = parseSES(text);
            if (!result.tracks.length) {
                app.setStatus('No routes found in SES file');
                return;
            }
            app.cancelAutoRoute();
            if (result.tracks.length) {
                const track = result.tracks[0];
                console.log(`[SES] First track: net=${track.net} layer=${track.layer} pts=${track.points.length}`, track.points);
                for (const [, placement] of app.placements) {
                    for (const [number, position] of placement.pads) {
                        console.log(`[SES] Pad ${placement.reference}-${number} at (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
                        break;
                    }
                    break;
                }
            }
            renderRouteResult(app, { tracks: result.tracks, vias: result.vias || [], failed: [] });
            app.setStatus(`Imported ${result.tracks.length} track(s), ${result.vias?.length || 0} via(s) from SES`);
        };
        reader.readAsText(file);
    });
    input.click();
}
