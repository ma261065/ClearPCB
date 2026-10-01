import { validateCopperRegionContact } from './track-contact-geometry.js';

/** One active job and one replaceable pending job, matching the surface-worker transport. */
export function createFillWorker(createWorker = () => new Worker(
    new URL('./fill-worker.js', import.meta.url), { type: 'module' },
)) {
    let worker = null, active = null, pending = null, revision = 0, nextId = 0, disposed = false;
    const fail = error => {
        worker?.terminate();
        worker = null;
        const jobs = [active, pending];
        active = pending = null;
        for (const job of jobs) job?.reject(error);
    };
    const send = () => {
        if (disposed || active || !pending) return;
        active = pending;
        pending = null;
        try {
            if (!worker) {
                worker = createWorker();
                worker.onmessage = ({ data }) => {
                    if (!active || data?.id !== active.id) return;
                    if (data.error) { fail(new Error(data.error)); return; }
                    const ring = points => Array.isArray(points) && points.length >= 3
                        && points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
                    if (!Array.isArray(data.results) || data.results.length !== active.inputs.fills.length
                        || data.results.some(result => !Array.isArray(result) || result.some(polygon =>
                            !ring(polygon?.outer) || !Array.isArray(polygon?.holes) || !polygon.holes.every(ring)))) {
                        fail(new Error('Incomplete copper-fill worker response'));
                        return;
                    }
                    try {
                        if (!Array.isArray(data.contacts) || data.contacts.length !== data.results.length) {
                            throw new Error('Incomplete prepared copper contacts');
                        }
                        data.results.forEach((regions, index) => {
                            const contacts = data.contacts[index];
                            if (!Array.isArray(contacts) || contacts.length !== regions.length) {
                                throw new Error('Incomplete prepared copper contacts');
                            }
                            regions.forEach((region, index) => validateCopperRegionContact(region, contacts[index]));
                        });
                    } catch (error) { fail(error); return; }
                    const completed = active;
                    active = null;
                    completed.resolve(completed.revision === revision ? { results: data.results, contacts: data.contacts } : null);
                    send();
                };
                worker.onerror = event => fail(new Error(event.message || 'Copper-fill worker failed'));
                worker.onmessageerror = () => fail(new Error('Invalid copper-fill worker response'));
            }
            worker.postMessage({ id: active.id, inputs: active.inputs });
        } catch (error) { fail(error); }
    };
    return {
        build(inputs) {
            if (disposed) return Promise.resolve(null);
            revision++;
            pending?.resolve(null);
            return new Promise((resolve, reject) => {
                pending = { id: ++nextId, revision, inputs, resolve, reject };
                send();
            });
        },
        invalidate() {
            revision++;
            pending?.resolve(null);
            pending = null;
        },
        dispose() {
            disposed = true;
            worker?.terminate();
            worker = null;
            active?.resolve(null);
            pending?.resolve(null);
            active = pending = null;
        },
    };
}
