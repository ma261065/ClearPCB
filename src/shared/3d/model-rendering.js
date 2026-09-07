import * as THREE from '../../../assets/vendor/three.module.js';

export const COLOR_COMPONENT = [40, 44, 52];

export function parseObjModel(objText) {
    if (!objText) return null;
    /** @type {Array<{x:number,y:number,z:number}>} */
    const vertices = [];
    /** @type {Map<string, number[]|null>} material name → [r,g,b] 0-255 */
    const materials = new Map();
    /** @type {Array<{idx:number[], color:number[]}>} */
    const faces = [];
    let pendingMtl = null;
    let curColor = COLOR_COMPONENT;
    // Source discriminator: the KiCad WRL/STEP→OBJ converter names materials
    // `m_<r>_<g>_<b>`; EasyEDA OBJs use numeric names with `endmtl` blocks.
    let kicadMaterial = false;

    for (const raw of objText.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const sp = line.indexOf(' ');
        const kw = sp < 0 ? line : line.slice(0, sp);
        const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
        switch (kw) {
            case 'v': {
                const p = rest.split(/\s+/);
                vertices.push({ x: +p[0], y: +p[1], z: +p[2] });
                break;
            }
            case 'newmtl':
                pendingMtl = rest;
                if (/^m_\d+_\d+_\d+(_body)?$/.test(pendingMtl)) kicadMaterial = true;
                if (!materials.has(pendingMtl)) materials.set(pendingMtl, null);
                break;
            case 'Kd':
                if (pendingMtl) {
                    const c = rest.split(/\s+/).map(Number);
                    materials.set(pendingMtl, [
                        Math.round((c[0] || 0) * 255),
                        Math.round((c[1] || 0) * 255),
                        Math.round((c[2] || 0) * 255),
                    ]);
                }
                break;
            case 'endmtl':
                pendingMtl = null;
                break;
            case 'usemtl':
                curColor = materials.get(rest) || COLOR_COMPONENT;
                break;
            case 'f': {
                const p = rest.split(/\s+/);
                const idx = p.map((tok) => parseInt(tok.split('/')[0], 10) - 1);
                if (idx.length < 3 || idx.some((i) => i < 0 || Number.isNaN(i))) break;
                // Fan-triangulate polygons (quads etc.).
                for (let i = 1; i + 1 < idx.length; i++) {
                    faces.push({ idx: [idx[0], idx[i], idx[i + 1]], color: curColor });
                }
                break;
            }
        }
    }
    if (!vertices.length || !faces.length) return null;
    return { vertices, faces, source: kicadMaterial ? 'kicad' : 'easyeda' };
}

export function meshToGeometry(mesh, groupByColor = false) {
    const col = new THREE.Color();
    if (!groupByColor) {
        const positions = [];
        const colors = [];
        for (const f of mesh.faces) {
            const idx = f.idx;
            if (!idx || idx.length < 3) continue;
            const c = f.color || [128, 128, 128];
            // Our colours are authored in sRGB (0–255). three.js treats vertex
            // colours as linear and the renderer re-encodes to sRGB on output,
            // so uploading raw sRGB values double-brightens and desaturates them
            // (the "washed-out" look). Convert sRGB → linear here so they render
            // true.
            col.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
            const r = col.r, g = col.g, b = col.b;
            for (let i = 1; i + 1 < idx.length; i++) {
                for (const vi of [idx[0], idx[i], idx[i + 1]]) {
                    const v = mesh.verts[vi];
                    if (!v) continue;
                    positions.push(v.x, v.y, v.z);
                    colors.push(r, g, b);
                }
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geo.computeVertexNormals();
        return geo;
    }

    // Grouped path: bucket triangles by face colour so each distinct material
    // becomes its own draw group. OBJ component models (e.g. ESP32 modules)
    // author printed markings/logos as faces sitting EXACTLY coincident with the
    // body shell — no depth precision (not even a log buffer) can separate
    // truly coplanar faces, but a per-group polygonOffset gives each material a
    // deterministic depth bias so the marking reliably wins over the shell
    // instead of z-fighting it. geo.userData.groupVertCounts lets the caller
    // pick which group is the body (the largest) and offset accordingly.
    const buckets = new Map();
    for (const f of mesh.faces) {
        const idx = f.idx;
        if (!idx || idx.length < 3) continue;
        const c = f.color || [128, 128, 128];
        const key = `${c[0]},${c[1]},${c[2]}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            col.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
            bucket = { lin: [col.r, col.g, col.b], pos: [] };
            buckets.set(key, bucket);
        }
        for (let i = 1; i + 1 < idx.length; i++) {
            for (const vi of [idx[0], idx[i], idx[i + 1]]) {
                const v = mesh.verts[vi];
                if (!v) continue;
                bucket.pos.push(v.x, v.y, v.z);
            }
        }
    }
    const positions = [];
    const colors = [];
    const groupVertCounts = [];
    const geo = new THREE.BufferGeometry();
    let start = 0;
    let materialIndex = 0;
    for (const bucket of buckets.values()) {
        const vertCount = bucket.pos.length / 3;
        if (!vertCount) continue;
        for (let k = 0; k < bucket.pos.length; k++) positions.push(bucket.pos[k]);
        for (let k = 0; k < vertCount; k++) colors.push(bucket.lin[0], bucket.lin[1], bucket.lin[2]);
        geo.addGroup(start, vertCount, materialIndex);
        groupVertCounts.push(vertCount);
        start += vertCount;
        materialIndex++;
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.userData.groupVertCounts = groupVertCounts;
    return geo;
}

export function makeMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        side: THREE.DoubleSide,
        roughness: 0.62,
        metalness: 0.08,
    });
}

export function makeComponentMaterial() {
    return makeMaterial();
}

export function makeComponentGroupMaterials(groupVertCounts) {
    return groupVertCounts.map((_, i) => {
        const m = makeComponentMaterial();
        m.polygonOffset = true;
        m.polygonOffsetFactor = 0;
        // Later-authored groups pulled forward (more negative = nearer).
        m.polygonOffsetUnits = -2 * i;
        return m;
    });
}
