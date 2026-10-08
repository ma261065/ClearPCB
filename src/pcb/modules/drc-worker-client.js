/** @typedef {{x: number, y: number}} Point */
/** @typedef {import('./drc.js').DrcMarker} DrcMarker */
/** @typedef {import('./drc.js').DrcViolation} DrcViolation */
/** @typedef {import('./drc.js').DrcResult} DrcResult */
/** @typedef {{id: number, revision: number, inputs: any, resolve: (value: DrcResult|null) => void, reject: (reason?: any) => void}} DrcJob */

/** @param {any} value */
const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y);
/** @param {any} marker */
function validMarker(marker) {
    if (marker === null) return true;
    if (!marker) return false;
    if (marker.type === 'short') return true;
    if (marker.type === 'ring') return point(marker) && Number.isFinite(marker.r);
    return ['clearance', 'ratline'].includes(marker.type) && point(marker.a) && point(marker.b)
        && (marker.type !== 'ratline' || typeof marker.net === 'string');
}
/** @param {any} result */
function validResult(result) {
    if (!result || typeof result.ok !== 'boolean' || !Array.isArray(result.violations)) return false;
    let errors = 0, warnings = 0;
    for (const item of result.violations) {
        if (!item || typeof item.id !== 'string' || typeof item.rule !== 'string'
            || typeof item.message !== 'string' || !Number.isFinite(item.x) || !Number.isFinite(item.y)
            || !['error', 'warning'].includes(item.severity) || !validMarker(item.marker)) return false;
        if (item.severity === 'error') errors++; else warnings++;
    }
    return result.counts?.errors === errors && result.counts?.warnings === warnings
        && result.ok === (errors === 0 && warnings === 0);
}

/** Latest-only transport: one active check and one replaceable pending snapshot. */
/** @param {() => Worker} [createWorker] */
export function createDrcWorker(createWorker = () => new Worker(
    new URL('./drc-worker.js', import.meta.url), { type: 'module' },
)) {
    /** @type {Worker|null} */
    let worker = null;
    /** @type {DrcJob|null} */
    let active = null;
    /** @type {DrcJob|null} */
    let pending = null;
    let revision = 0, nextId = 0, disposed = false;
    /** @param {any} error */
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
                    if (!validResult(data.result)) { fail(new Error('Incomplete DRC worker response')); return; }
                    const completed = active;
                    active = null;
                    completed.resolve(completed.revision === revision ? data.result : null);
                    send();
                };
                worker.onerror = event => fail(new Error(event.message || 'DRC worker failed'));
                worker.onmessageerror = () => fail(new Error('Invalid DRC worker response'));
            }
            worker.postMessage({ id: active.id, inputs: active.inputs });
        } catch (error) { fail(error); }
    };
    return {
        /** @param {any} inputs */
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
