// @ts-ignore -- cache-busting query string (see sw.js); TypeScript cannot resolve it
import { clipMeshToOutline, punchHolesInFlatMesh } from './board3d-mesh-ops.js?v=4';
// @ts-ignore -- cache-busting query string (see sw.js); TypeScript cannot resolve it
import { meshToGeometry } from '../../shared/3d/model-rendering.js?v=2';

/** @typedef {import('./board3d-mesh-ops.js').MeshVertex} MeshVertex */
/** @typedef {import('./board3d-mesh-ops.js').MeshFace} MeshFace */
/** @typedef {import('./board3d-mesh-ops.js').Mesh} Mesh */
/** @typedef {import('./board3d-surface-transfer.js').SurfacePart} SurfacePart */
/** @typedef {{parts: SurfacePart[], outline: any}} SurfaceBuildInput */
/** @typedef {{position: ArrayLike<number>, color: ArrayLike<number>, normal: ArrayLike<number>}} SurfaceBuffers */

/** @param {Record<string, SurfaceBuildInput>} surfaces @returns {Record<string, SurfaceBuffers>} */
export function buildSurfaceBuffers(surfaces) {
    /** @type {Record<string, SurfaceBuffers>} */
    const result = {};
    for (const [key, surface] of Object.entries(surfaces)) {
        /** @type {Mesh} */
        const mesh = { verts: [], faces: [] };
        for (const part of surface.parts) {
            const cut = punchHolesInFlatMesh(part.mesh, part.holes || []);
            const base = mesh.verts.length;
            for (const vertex of cut.verts) mesh.verts.push(vertex);
            for (const face of cut.faces) mesh.faces.push({
                idx: face.idx.map((/** @type {number} */ index) => index + base), color: face.color,
            });
        }
        const geometry = meshToGeometry(clipMeshToOutline(mesh, surface.outline));
        result[key] = {
            position: geometry.getAttribute('position').array,
            color: geometry.getAttribute('color').array,
            normal: geometry.getAttribute('normal').array,
        };
        geometry.dispose();
    }
    return result;
}