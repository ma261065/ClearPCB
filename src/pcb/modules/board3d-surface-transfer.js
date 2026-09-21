export function encodeSurfaceInputs(surfaces) {
    const meshes = new WeakMap();
    const transfer = [];
    const encodeMesh = (mesh) => {
        if (meshes.has(mesh)) return meshes.get(mesh);
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
        surfaces: Object.fromEntries(Object.entries(surfaces).map(([key, surface]) => [key, {
            ...surface, parts: surface.parts.map(part => ({ ...part, mesh: encodeMesh(part.mesh) })),
        }])),
        transfer,
    };
}

export function decodeSurfaceInputs(surfaces) {
    const meshes = new WeakMap();
    const decodeMesh = (encoded) => {
        if (!encoded.packed) return encoded;
        if (meshes.has(encoded)) return meshes.get(encoded);
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
    return Object.fromEntries(Object.entries(surfaces).map(([key, surface]) => [key, {
        ...surface, parts: surface.parts.map(part => ({ ...part, mesh: decodeMesh(part.mesh) })),
    }]));
}