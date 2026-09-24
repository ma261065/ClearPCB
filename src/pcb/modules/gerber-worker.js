import { prepareSnapshotFills } from './fabrication-snapshot.js';
import { exportGerbers, buildZip } from './gerber.js';

globalThis.onmessage = async ({ data: snapshot }) => {
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