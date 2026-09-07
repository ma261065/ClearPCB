import { surfaceInputsEqual } from './board3d-surface-equality.js';

export function createSurfaceBuilder(createWorker = () => new Worker(
    new URL('./board3d-surface-worker.js', import.meta.url), { type: 'module' },
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
    const send = () => {
        if (active || !pending || disposed) return;
        active = pending;
        pending = null;
        if (!Object.keys(active.surfaces).length) {
            const completed = active;
            active = null;
            cache = new Map([...completed.inputs].map(([key, input]) => [key, {
                input, buffers: completed.reused[key],
            }]));
            completed.resolve(completed.reused);
            return;
        }
        try {
            if (!worker) {
                worker = createWorker();
                worker.onmessage = ({ data }) => {
                    if (!active || data.id !== active.id) return;
                    const completed = active;
                    active = null;
                    if (completed.revision !== revision) completed.resolve(null);
                    else if (data.error) completed.reject(new Error(data.error));
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
            }
            worker.postMessage({ id: active.id, surfaces: active.surfaces });
        } catch (error) {
            fail(error);
        }
    };
    return {
        invalidate() {
            revision++;
            pending?.resolve(null);
            pending = null;
        },
        build(surfaces) {
            if (disposed) return Promise.resolve(null);
            revision++;
            pending?.resolve(null);
            const changed = {};
            const reused = {};
            const inputs = new Map();
            for (const [key, surface] of Object.entries(surfaces)) {
                const previous = cache.get(key);
                if (previous && surfaceInputsEqual(previous.input, surface)) {
                    inputs.set(key, previous.input);
                    reused[key] = previous.buffers;
                } else {
                    const snapshot = structuredClone(surface);
                    inputs.set(key, snapshot);
                    changed[key] = snapshot;
                }
            }
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