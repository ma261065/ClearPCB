import { prepareFabricationSnapshot } from './fabrication-snapshot.js';

export function showGerberProgress(label, value = null) {
    const host = document.getElementById('pcbGerberProgress');
    if (!host) return;
    host.hidden = !label;
    const text = host.querySelector('[data-label]');
    const bar = host.querySelector('progress');
    text.textContent = label ? `Gerber: ${label}` : '';
    host.title = text.textContent;
    if (value === null) bar.removeAttribute('value');
    else bar.value = value;
}

export async function generateGerberArchive(app, onProgress = showGerberProgress) {
    onProgress('Capturing board');
    await new Promise(resolve => setTimeout(resolve, 0));
    const snapshot = await prepareFabricationSnapshot(app, { computeFills: false });
    snapshot.tracks = snapshot.tracks.map(({ getEdgeWidth, getEdgeLayer, ...track }) => track);
    onProgress('Starting export');
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./gerber-worker.js', import.meta.url), { type: 'module' });
        const fail = error => { worker.terminate(); reject(error); };
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') onProgress(data.label, data.value);
            else if (data.type === 'complete') {
                worker.terminate();
                resolve({ blob: data.blob, fileCount: data.fileCount });
            } else if (data.type === 'error') fail(new Error(data.message));
        };
        worker.onerror = event => {
            event.preventDefault();
            fail(new Error(event.message || 'Gerber worker failed.'));
        };
        worker.onmessageerror = () => fail(new Error('Unable to receive Gerber export data.'));
        try { worker.postMessage(snapshot); }
        catch (error) { fail(error); }
    });
}