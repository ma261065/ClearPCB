import { runDrcInputs } from './drc.js';

/** @param {MessageEvent<{id: unknown, inputs: any}>} event */
globalThis.onmessage = ({ data }) => {
    try {
        globalThis.postMessage({ id: data.id, result: runDrcInputs(data.inputs) });
    } catch (error) {
        globalThis.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
};
