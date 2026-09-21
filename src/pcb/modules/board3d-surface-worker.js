import { buildSurfaceBuffers } from './board3d-surface-build.js?v=5';
import { decodeSurfaceInputs } from './board3d-surface-transfer.js';

globalThis.onmessage = ({ data }) => {
    try {
        const surfaces = buildSurfaceBuffers(decodeSurfaceInputs(data.surfaces));
        const transfer = Object.values(surfaces).flatMap((surface) =>
            Object.values(surface).map((attribute) => attribute.buffer));
        globalThis.postMessage({ id: data.id, surfaces }, { transfer });
    } catch (error) {
        globalThis.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
};