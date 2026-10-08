/** @typedef {import('./board3d-mesh-ops.js').MeshVertex} MeshVertex */
/** @typedef {import('./board3d-mesh-ops.js').MeshFace} MeshFace */
/** @typedef {import('./board3d-mesh-ops.js').Mesh} Board3dMesh */
/** @typedef {{packed: Float64Array}} EncodedMesh */
/** @typedef {{mesh: Board3dMesh, [key: string]: unknown}} SurfacePart */
/** @typedef {{parts: SurfacePart[], [key: string]: unknown}} SurfaceInput */
/** @typedef {{mesh: Board3dMesh|EncodedMesh, [key: string]: unknown}} TransferSurfacePart */
/** @typedef {{parts: TransferSurfacePart[], [key: string]: unknown}} TransferSurfaceInput */

/**
 * @param {Record<string, SurfaceInput>} surfaces
 * @returns {{surfaces: Record<string, TransferSurfaceInput>, transfer: ArrayBuffer[]}}
 */
export function encodeSurfaceInputs(surfaces) {
    /** @type {WeakMap<Board3dMesh, EncodedMesh>} */
    const meshes = new WeakMap();
    /** @type {ArrayBuffer[]} */
    const transfer = [];
    /** @param {Board3dMesh} mesh */
    const encodeMesh = (mesh) => {
        const cached = meshes.get(mesh);
        if (cached) return cached;
        let length = 2 + mesh.verts.length * 3;
        for (const face of mesh.faces) length += 2 + face.idx.length + (face.color?.length || 0);
        const packed = new Float64Array(length);
        let offset = 0;
        packed[offset++] = mesh.verts.length;
        packed[offset++] = mesh.faces.length;
        for (const vertex of mesh.verts) {
            packed[offset++] = vertex.x;
            packed[offset++] = vertex.y;
            packed[offset++] = vertex.z;
        }
        for (const face of mesh.faces) {
            packed[offset++] = face.idx.length;
            packed[offset++] = face.color ? face.color.length : -1;
            for (const index of face.idx) packed[offset++] = index;
            for (const channel of face.color || []) packed[offset++] = channel;
        }
        const encoded = { packed };
        meshes.set(mesh, encoded);
        transfer.push(packed.buffer);
        return encoded;
    };
    return {
        surfaces: /** @type {Record<string, TransferSurfaceInput>} */ (Object.fromEntries(Object.entries(surfaces).map(([key, surface]) => [key, {
            ...surface, parts: surface.parts.map(part => ({ ...part, mesh: encodeMesh(part.mesh) })),
        }]))),
        transfer,
    };
}

/**
 * @param {Record<string, TransferSurfaceInput>} surfaces
 * @returns {Record<string, SurfaceInput>}
 */
export function decodeSurfaceInputs(surfaces) {
    /** @type {WeakMap<EncodedMesh, Board3dMesh>} */
    const meshes = new WeakMap();
    /** @param {Board3dMesh|EncodedMesh} encoded */
    const decodeMesh = (encoded) => {
        if (!('packed' in encoded)) return encoded;
        const cached = meshes.get(encoded);
        if (cached) return cached;
        const packed = encoded.packed;
        let offset = 0;
        const vertexCount = packed[offset++];
        const faceCount = packed[offset++];
        const verts = new Array(vertexCount);
        const faces = new Array(faceCount);
        for (let index = 0; index < vertexCount; index++) {
            verts[index] = { x: packed[offset++], y: packed[offset++], z: packed[offset++] };
        }
        for (let index = 0; index < faceCount; index++) {
            const indexCount = packed[offset++];
            const colorCount = packed[offset++];
            const idx = Array.from(packed.subarray(offset, offset + indexCount));
            offset += indexCount;
            /** @type {MeshFace} */
            const face = { idx };
            if (colorCount >= 0) {
                face.color = Array.from(packed.subarray(offset, offset + colorCount));
                offset += colorCount;
            }
            faces[index] = face;
        }
        const mesh = { verts, faces };
        meshes.set(encoded, mesh);
        return mesh;
    };
    return /** @type {Record<string, SurfaceInput>} */ (Object.fromEntries(Object.entries(surfaces).map(([key, surface]) => [key, {
        ...surface, parts: surface.parts.map(part => ({ ...part, mesh: decodeMesh(part.mesh) })),
    }])));
}