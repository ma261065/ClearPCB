import { clipMeshToOutline, punchHolesInFlatMesh } from './board3d-mesh-ops.js';
import { meshToGeometry } from '../../shared/3d/model-rendering.js';

export function buildSurfaceBuffers(surfaces) {
    const result = {};
    for (const [key, surface] of Object.entries(surfaces)) {
        /** @type {{verts:Array, faces:Array}} */
        const mesh = { verts: [], faces: [] };
        for (const part of surface.parts) {
            const cut = punchHolesInFlatMesh(part.mesh, part.holes || []);
            const base = mesh.verts.length;
            for (const vertex of cut.verts) mesh.verts.push(vertex);
            for (const face of cut.faces) mesh.faces.push({
                idx: face.idx.map((index) => index + base), color: face.color,
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