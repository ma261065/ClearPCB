import { buildSurfaceBuffers } from './board3d-surface-build.js';

globalThis.onmessage = ({ data }) => {
    try {
        const surfaces = buildSurfaceBuffers(data.surfaces);
        const transfer = Object.values(surfaces).flatMap((surface) =>
            Object.values(surface).map((attribute) => attribute.buffer));
        globalThis.postMessage({ id: data.id, surfaces }, { transfer });
    } catch (error) {
        globalThis.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
};