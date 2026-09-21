import { surfaceInputsEqual } from './board3d-surface-equality.js';
import { encodeSurfaceInputs } from './board3d-surface-transfer.js';

export function createSurfaceBuilder(createWorker = () => new Worker(
    new URL('./board3d-surface-worker.js?v=7', import.meta.url), { type: 'module' },
)) {
    let worker = null;
    let revision = 0;
    let nextId = 0;
    let active = null;
    let pending = null;
    let disposed = false;
    let cache = new Map();

    const fail = (error) => {
        worker?.terminate();
        worker = null;
        active?.reject(error);
        pending?.reject(error);
        active = pending = null;
    };
    const ensureWorker = () => {
        if (worker) return;
        worker = createWorker();
        worker.onmessage = ({ data }) => {
            if (!active || data.id !== active.id) return;
            if (data.error) {
                fail(new Error(data.error));
                return;
            }
            const completed = active;
            active = null;
            if (completed.revision !== revision) completed.resolve(null);
            else {
                const result = { ...completed.reused, ...data.surfaces };
                cache = new Map([...completed.inputs].map(([key, input]) => [key, {
                    input, buffers: result[key],
                }]));
                completed.resolve(result);
            }
            send();
        };
        worker.onerror = (event) => fail(new Error(event.message || '3D geometry worker failed'));
        worker.onmessageerror = () => fail(new Error('Invalid 3D geometry worker response'));
    };
    const send = () => {
        if (active || !pending || disposed) return;
        active = pending;
        pending = null;
        const entries = Object.entries(active.surfaces);
        if (!entries.length) {
            const completed = active;
            active = null;
            cache = new Map([...completed.inputs].map(([key, input]) => [key, {
                input, buffers: completed.reused[key],
            }]));
            completed.resolve(completed.reused);
            return;
        }
        try {
            ensureWorker();
            const encoded = encodeSurfaceInputs(active.surfaces);
            worker.postMessage({ id: active.id, surfaces: encoded.surfaces }, encoded.transfer);
        } catch (error) {
            fail(error);
        }
    };
    return {
        invalidate({ cancelActive = false } = {}) {
            revision++;
            pending?.resolve(null);
            pending = null;
            if (cancelActive && active) {
                const cancelled = active;
                active = null;
                worker?.terminate();
                worker = null;
                cancelled.resolve(null);
            }
        },
        /** With takeOwnership, callers must never mutate the supplied geometry after this call. */
        build(surfaces, { takeOwnership = false } = {}) {
            if (disposed) return Promise.resolve(null);
            revision++;
            pending?.resolve(null);
            const changedSources = {};
            const reused = {};
            const inputs = new Map();
            const equalityMemo = new WeakMap();
            for (const [key, surface] of Object.entries(surfaces)) {
                const previous = cache.get(key);
                if (previous && surfaceInputsEqual(previous.input, surface, equalityMemo)) {
                    inputs.set(key, previous.input);
                    reused[key] = previous.buffers;
                } else {
                    changedSources[key] = surface;
                }
            }
            const changed = takeOwnership ? changedSources : structuredClone(changedSources);
            for (const [key, snapshot] of Object.entries(changed)) inputs.set(key, snapshot);
            return new Promise((resolve, reject) => {
                pending = { id: ++nextId, revision, surfaces: changed, reused, inputs, resolve, reject };
                send();
            });
        },
        dispose() {
            disposed = true;
            worker?.terminate();
            worker = null;
            active?.resolve(null);
            pending?.resolve(null);
            active = pending = null;
            cache.clear();
        },
    };
}