import { STEPPreview } from './STEPPreview.js';
import { VRMLPreview } from './VRMLPreview.js';
import { openModel3DPopout } from './Model3DPopout.js';
import { getComponentLibrary } from './index.js';

/** @type {Map<string, string>} modelURL -> generated OBJ cache */
const _modelObjCache = new Map();

/**
 * True when a component/placement has some 3D source we can try to render.
 * @param {any} data
 * @returns {boolean}
 */
export function hasAny3DModel(data) {
    if (!data) return false;
    return !!(
        data.model3dObj
        || data.model3dUrl
        || (data.has3d && (data.footprintName || data.footprint))
    );
}

/**
 * Build the 3D viewer window title: `Reference - Value (SOURCE)`. Each piece is
 * optional — a missing reference/value is dropped, and the source suffix only
 * shows for known supplier sources (KiCad/LCSC/EasyEDA), uppercased. Falls back
 * to '3D Model' when nothing identifying is available.
 * @param {{reference?: string, value?: string, source?: string, _source?: string}} data
 * @returns {string}
 */
export function buildComponent3DTitle(data) {
    const ref = (data?.reference || '').trim();
    const val = (data?.value || '').trim();
    let base = ref && val ? `${ref} \u2014 ${val}` : (ref || val);
    const src = (data?.source || data?._source || '').trim();
    const label = /kicad/i.test(src) ? 'KICAD'
        : /lcsc/i.test(src) ? 'LCSC'
        : /easyeda/i.test(src) ? 'EASYEDA'
        : '';
    if (label) base = base ? `${base} (${label})` : `(${label})`;
    return base || '3D Model';
}

/**
 * Open the model pop-out for either OBJ-backed (EasyEDA) or KiCad model-backed
 * (KiCad URL/footprint) components.
 * @param {Object} opts
 * @param {any} opts.data component definition / placement-like object
 * @param {string} [opts.title]
 * @returns {Promise<boolean>}
 */
export async function openComponent3DFromData({ data, title = '3D Model' }) {
    if (!data) return false;

    let objText = data.model3dObj || '';
    if (!objText) {
        const modelUrl = await _resolveModelUrl(data);
        if (!modelUrl) return false;
        objText = await _resolveObjFromModelUrl(modelUrl, _getProxyUrl());
        if (!objText) return false;
        // Cache on the object so subsequent opens are instant.
        data.model3dObj = objText;
        if (!data.model3dUrl) data.model3dUrl = modelUrl;
        data.has3d = true;
    }

    return openModel3DPopout({ objText, title });
}

async function _resolveModelUrl(data) {
    if (data.model3dUrl) return data.model3dUrl;

    const footprintName = data.footprintName || data.footprint;
    if (!footprintName || !data.has3d) return null;

    const kicad = _getKiCadFetcher();
    if (!kicad?.checkFootprintAvailability) return null;
    try {
        const availability = await kicad.checkFootprintAvailability(footprintName);
        if (availability?.has3d && availability.modelUrl) {
            data.model3dUrl = availability.modelUrl;
            return availability.modelUrl;
        }
    } catch (error) {
        console.warn('Failed to resolve KiCad model URL:', error);
    }
    return null;
}

/**
 * Resolve any supported KiCad model URL (WRL/STEP) into OBJ text.
 * @param {string} modelUrl
 * @param {string} proxyUrl
 * @returns {Promise<string>}
 */
export async function resolveObjFromModelUrl(modelUrl, proxyUrl = '') {
    return _resolveObjFromModelUrl(modelUrl, proxyUrl);
}

async function _resolveObjFromModelUrl(modelUrl, proxyUrl) {
    if (_modelObjCache.has(modelUrl)) return _modelObjCache.get(modelUrl) || '';

    const fetchUrl = proxyUrl
        ? `${proxyUrl}${encodeURIComponent(modelUrl)}`
        : modelUrl;
    const response = await fetch(fetchUrl);
    if (!response.ok) return '';

    const text = await response.text();
    let objText = '';

    // Prefer VRML parser when the source is WRL/VRML (keeps diffuse colors).
    if (/\.(wrl|vrml)(\?|$)/i.test(modelUrl) || /^#\s*VRML/i.test(text)) {
        const geom = VRMLPreview.parseVRMLWithColors(text);
        if (geom?.vertices?.length && geom?.faces?.length) {
            objText = _coloredMeshToObj(geom);
        }
    }

    // Otherwise parse STEP (or fallback parse when VRML detection didn't match).
    if (!objText) {
        const geometry = STEPPreview.parse(text);
        if (geometry?.vertices?.length && geometry?.faces?.length) {
            // Use color-aware conversion if STEP parser found colors; otherwise plain OBJ.
            if (geometry.faceColors?.length === geometry.faces.length) {
                objText = _coloredMeshToObj(geometry);
            } else {
                objText = _stepGeometryToObj(geometry);
            }
        }
    }

    _modelObjCache.set(modelUrl, objText || '');
    return objText;
}

/**
 * @param {{vertices:{x:number,y:number,z:number}[], faces:number[][]}} geometry
 * @returns {string}
 */
function _stepGeometryToObj(geometry) {
    const lines = [];
    for (const v of (geometry?.vertices || [])) {
        lines.push(`v ${v.x} ${v.y} ${v.z}`);
    }
    for (const face of (geometry?.faces || [])) {
        if (!Array.isArray(face) || face.length < 3) continue;
        const idx = face
            .map(i => Number(i))
            .filter(i => Number.isFinite(i) && i >= 0 && i < geometry.vertices.length)
            .map(i => i + 1);
        if (idx.length < 3) continue;
        for (let i = 1; i < idx.length - 1; i++) {
            lines.push(`f ${idx[0]} ${idx[i]} ${idx[i + 1]}`);
        }
    }
    return lines.join('\n');
}

/**
 * Convert a colored face mesh to OBJ text with inline materials.
 * parseObjModel supports inline `newmtl`/`Kd`/`usemtl`, so no external .mtl is needed.
 * @param {{vertices:Array<{x:number,y:number,z:number}>,faces:number[][],faceColors?:number[][],bodyFaces?:boolean[]}} geometry
 * @returns {string}
 */
function _coloredMeshToObj(geometry) {
    const lines = [];
    const bodyFaces = geometry.bodyFaces || null;

    for (const v of (geometry?.vertices || [])) {
        lines.push(`v ${v.x} ${v.y} ${v.z}`);
    }

    const safeColor = (c) => (Array.isArray(c) && c.length >= 3 ? c : [102, 102, 102]);
    // Body faces (the STEP solid's largest shell) are emitted under a distinct
    // material — same colour, "_body" suffix — so the renderer can draw them in
    // a separate, depth-offset pass to beat coplanar z-fighting with the pads
    // resting on them, without moving any geometry. See STEPPreview.
    const matName = (c, body) => {
        const col = safeColor(c);
        return `m_${col[0]}_${col[1]}_${col[2]}${body ? '_body' : ''}`;
    };

    // Declare every (colour, body) material used, inline.
    const faceColors = geometry.faceColors || [];
    const faceCount = (geometry?.faces || []).length;
    const declared = new Set();
    for (let fi = 0; fi < faceCount; fi++) {
        const col = safeColor(faceColors[fi]);
        const name = matName(col, !!(bodyFaces && bodyFaces[fi]));
        if (declared.has(name)) continue;
        declared.add(name);
        lines.push(`newmtl ${name}`);
        lines.push(`Kd ${Math.max(0, Math.min(1, col[0] / 255))} ${Math.max(0, Math.min(1, col[1] / 255))} ${Math.max(0, Math.min(1, col[2] / 255))}`);
    }

    let activeMat = '';
    for (let fi = 0; fi < faceCount; fi++) {
        const face = geometry.faces[fi];
        if (!Array.isArray(face) || face.length < 3) continue;
        const idx = face
            .map(i => Number(i))
            .filter(i => Number.isFinite(i) && i >= 0 && i < geometry.vertices.length)
            .map(i => i + 1);
        if (idx.length < 3) continue;

        const mat = matName(faceColors[fi], !!(bodyFaces && bodyFaces[fi]));
        if (mat !== activeMat) {
            lines.push(`usemtl ${mat}`);
            activeMat = mat;
        }

        for (let i = 1; i + 1 < idx.length; i++) {
            lines.push(`f ${idx[0]} ${idx[i]} ${idx[i + 1]}`);
        }
    }

    return lines.join('\n');
}

function _getKiCadFetcher() {
    try {
        return getComponentLibrary()?.kicadFetcher || null;
    } catch {
        return null;
    }
}

function _getProxyUrl() {
    return _getKiCadFetcher()?.corsProxy || '';
}
