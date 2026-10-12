import { prepareSnapshotFills } from './fabrication-snapshot.js';
import { exportGerbers, buildZip } from './gerber.js';

/** @typedef {Parameters<typeof prepareSnapshotFills>[0] & Parameters<typeof exportGerbers>[0] & {tracks: Array<{edges: Map<string, {width: number, layer: string}>, getEdgeWidth?: (id: string) => number, getEdgeLayer?: (id: string) => string}>}} GerberWorkerSnapshot */

/** @param {MessageEvent<GerberWorkerSnapshot>} event */
globalThis.onmessage = async ({ data: snapshot }) => {
    /** @param {string} label @param {number|null} [value] */
    const progress = (label, value = null) => globalThis.postMessage({ type: 'progress', label, value });
    try {
        for (const track of snapshot.tracks) {
            track.getEdgeWidth = id => track.edges.get(id).width;
            track.getEdgeLayer = id => track.edges.get(id).layer;
        }
        progress('Preparing fills');
        await prepareSnapshotFills(snapshot, (done, total) => {
            progress(`Fills ${done}/${total}`, 5 + 20 * done / total);
        });
        progress('Building panel and layers', 25);
        const files = exportGerbers(snapshot, (done, total, name) => {
            progress(name, 25 + 65 * done / total);
        });
        progress('Packaging ZIP');
        const blob = buildZip(files);
        globalThis.postMessage({ type: 'complete', blob, fileCount: files.size });
    } catch (error) {
        globalThis.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
};