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
                console.log(`[3D] STEP: Using extracted colors (${geometry.faceColors.length} faces)`, geometry.faceColors.slice(0, 3));
                objText = _coloredMeshToObj(geometry);
            } else {
                console.log(`[3D] STEP: No colors found, using plain geometry`);
                objText = _stepGeometryToObj(geometry);
            }
        }
    }
    
    if (objText) {
        console.log(`[3D] Model resolved from ${modelUrl.slice(-20)}`);
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
 * @param {{vertices:Array<{x:number,y:number,z:number}>,faces:number[][],faceColors?:number[][]}} geometry
 * @returns {string}
 */
function _coloredMeshToObj(geometry) {
    const lines = [];
    const mats = new Map();

    for (const v of (geometry?.vertices || [])) {
        lines.push(`v ${v.x} ${v.y} ${v.z}`);
    }

    const getMatName = (c) => {
        const color = Array.isArray(c) && c.length >= 3 ? c : [102, 102, 102];
        const key = `${color[0]},${color[1]},${color[2]}`;
        if (mats.has(key)) return mats.get(key);
        const name = `m_${color[0]}_${color[1]}_${color[2]}`;
        mats.set(key, name);
        return name;
    };

    // Declare materials first (inline in OBJ text).
    const seen = new Set();
    for (const color of (geometry.faceColors || [])) {
        const safe = Array.isArray(color) && color.length >= 3 ? color : [102, 102, 102];
        const key = `${safe[0]},${safe[1]},${safe[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const name = getMatName(safe);
        lines.push(`newmtl ${name}`);
        lines.push(`Kd ${Math.max(0, Math.min(1, safe[0] / 255))} ${Math.max(0, Math.min(1, safe[1] / 255))} ${Math.max(0, Math.min(1, safe[2] / 255))}`);
    }

    let activeMat = '';
    for (let fi = 0; fi < (geometry?.faces || []).length; fi++) {
        const face = geometry.faces[fi];
        if (!Array.isArray(face) || face.length < 3) continue;
        const idx = face
            .map(i => Number(i))
            .filter(i => Number.isFinite(i) && i >= 0 && i < geometry.vertices.length)
            .map(i => i + 1);
        if (idx.length < 3) continue;

        const mat = getMatName((geometry.faceColors || [])[fi]);
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
