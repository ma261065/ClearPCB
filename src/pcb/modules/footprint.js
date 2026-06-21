/**
 * Footprint geometry and rendering for the PCB editor.
 *
 * All components carry real pad data in their `footprintShapes` array
 * (format: "PAD~TYPE~x~y~w~h~padNumber").  This module parses those
 * strings into pad geometry objects and renders them as SVG.
 */

import { stringToPolylines, measureText } from './stroke-font.js';

const NS = 'http://www.w3.org/2000/svg';

/** Default reference-designator silk text size / line width (mm). */
export const REF_DEFAULT_SIZE = 0.9;
export const REF_DEFAULT_STROKE = 0.15;

/**
 * (Re)build a reference designator's stroked-polyline geometry inside its
 * `<g data-fp-ref>` group and refresh the cached layout attributes the editor
 * relies on (bounding box, centre, baseline anchor, current size/line width).
 * Used both when first rendering a footprint and when the user changes the
 * designator's size or line width from the properties panel.
 *
 * @param {SVGGElement} refGroup - the `data-fp-ref` group to fill
 * @param {string} ref - reference string (e.g. 'R3')
 * @param {number} cxRef - horizontal anchor/centre (footprint-local)
 * @param {number} baseY - text baseline Y (footprint-local)
 * @param {number} size - glyph size (mm)
 * @param {number} strokeWidth - line width (mm)
 */
export function applyRefGeometry(refGroup, ref, cxRef, baseY, size, strokeWidth) {
    while (refGroup.firstChild) refGroup.removeChild(refGroup.firstChild);
    refGroup.setAttribute('stroke-width', String(strokeWidth));
    const labelW = measureText(ref, size);
    const baseX = cxRef - labelW / 2;
    let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
    for (const poly of stringToPolylines(ref, baseX, baseY, size, false)) {
        if (poly.length < 2) continue;
        const pl = document.createElementNS(NS, 'polyline');
        pl.setAttribute('points', poly.map(p => `${p.x},${p.y}`).join(' '));
        refGroup.appendChild(pl);
        for (const p of poly) {
            if (p.x < rMinX) rMinX = p.x;
            if (p.y < rMinY) rMinY = p.y;
            if (p.x > rMaxX) rMaxX = p.x;
            if (p.y > rMaxY) rMaxY = p.y;
        }
    }
    // Local bounding box of the reference glyphs, used by the editor for
    // hit-testing and as the rotation centre when the user moves/rotates the
    // designator relative to the footprint. Fall back to a label-width box.
    if (!Number.isFinite(rMinX)) {
        rMinX = baseX; rMaxX = baseX + labelW;
        rMinY = baseY - size; rMaxY = baseY;
    }
    refGroup.setAttribute('data-mx-center', String(cxRef));
    refGroup.setAttribute('data-ref-anchor-y', String(baseY));
    refGroup.setAttribute('data-ref-size', String(size));
    refGroup.setAttribute('data-ref-lw', String(strokeWidth));
    refGroup.setAttribute('data-ref-bx', String(rMinX));
    refGroup.setAttribute('data-ref-by', String(rMinY));
    refGroup.setAttribute('data-ref-bw', String(rMaxX - rMinX));
    refGroup.setAttribute('data-ref-bh', String(rMaxY - rMinY));
    refGroup.setAttribute('data-ref-cy', String((rMinY + rMaxY) / 2));
}

/**
 * Generate pad layout from a component's footprintShapes data.
 *
 * @param {string} _footprintName - Footprint name (unused, kept for API compat)
 * @param {Array<{number: string, name: string}>} _pins - Schematic pins (unused)
 * @param {string[]|null} [footprintShapes] - Real pad data (PAD~TYPE~x~y~w~h~num)
 * @param {object|null} [footprintBBox] - Bounding box {x, y, width, height}
 * @param {string} [source] - Component source ('EasyEDA', 'LCSC', 'KiCad', 'Built-in')
 * @returns {{pads: Array, silks: Array, outline: object|null, courtyard: object|null}}
 */
export function generateFootprint(_footprintName, _pins, footprintShapes, footprintBBox, source) {
    if (!Array.isArray(footprintShapes) || footprintShapes.length === 0) {
        return {
            pads: [],
            silks: [],
            outline: null,
            courtyard: null,
        };
    }

    return generateFromShapes(footprintShapes, footprintBBox, source);
}

// ── Pad shape parser ─────────────────────────────────────────────

/**
 * Build footprint geometry from PAD shape strings.
 *
 * Each string has the form:  PAD~{TYPE}~{x}~{y}~{w}~{h}~{padNumber}
 *   TYPE = RECT | ELLIPSE
 *   Coordinates are in the footprint's local space (mm, or 10-mil
 *   for EasyEDA sources which are auto-scaled).
 *
 * @param {string[]} shapes - Array of PAD~ strings
 * @param {object|null} bbox - Optional bounding box from source
 * @param {string} [source] - Component source ('EasyEDA', 'LCSC', 'KiCad', 'Built-in')
 * @returns {{pads: Array, silks: Array, outline: object|null, courtyard: object|null}}
 */
function generateFromShapes(shapes, bbox, source) {
    const pads = [];
    const silks = [];
    /** Paste-only stencil apertures (no copper): {x,y,width,height,shape,side} */
    const pasteApertures = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // Separate bounding box of the copper PADS only. The footprint is centred on
    // this (not the all-geometry bbox) so the pads stay symmetric about the
    // origin: asymmetric silkscreen / courtyard / pin-1 markers would otherwise
    // pull the bbox centre off the pad centre, leaving the pads (and thus the
    // 3D model, which self-centres) misaligned with each other.
    let padMinX = Infinity, padMinY = Infinity, padMaxX = -Infinity, padMaxY = -Infinity;

    const isEasyEDA = source === 'EasyEDA' || source === 'LCSC';

    // Debug: log all shape prefixes for EasyEDA components
    if (isEasyEDA && typeof console !== 'undefined') {
        const prefixes = {};
        for (const s of shapes) {
            const p = typeof s === 'string' ? s.split('~')[0] : typeof s;
            prefixes[p] = (prefixes[p] || 0) + 1;
        }
        console.log('[PCB footprint] EasyEDA shape types:', prefixes, '| total:', shapes.length);
    }

    /**
     * Extract M/L endpoint coordinates from an SVG path for bounds calculation.
     * Ignores arc parameters and flags which aren't spatial coordinates.
     * @param {string} pathData - raw (unscaled) path
     * @param {number} scale
     */
    const updateBoundsFromPath = (pathData, scale) => {
        const segs = _tokenisePath(pathData);
        for (const { cmd, args } of segs) {
            const upper = cmd.toUpperCase();
            if (upper === 'M' || upper === 'L' || upper === 'T') {
                for (let i = 0; i + 1 < args.length; i += 2) {
                    const px = args[i] * scale, py = args[i + 1] * scale;
                    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
                    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
                }
            } else if (upper === 'A') {
                // Only use the endpoint (last 2 of each 7-param group)
                for (let i = 0; i + 6 < args.length; i += 7) {
                    const px = args[i + 5] * scale, py = args[i + 6] * scale;
                    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
                    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
                }
            } else if (upper === 'C') {
                for (let i = 0; i + 1 < args.length; i += 2) {
                    const px = args[i] * scale, py = args[i + 1] * scale;
                    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
                    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
                }
            }
        }
    };

    // Detect 10-mil → mm scaling need
    let maxCoord = 0;
    for (const shape of shapes) {
        if (typeof shape !== 'string') continue;
        const parts = shape.split('~');
        if (parts.length < 6) continue;
        if (shape.startsWith('PAD~') || shape.startsWith('TRACK~')) {
            maxCoord = Math.max(maxCoord, Math.abs(parseFloat(parts[2]) || 0),
                                          Math.abs(parseFloat(parts[3]) || 0));
        }
    }
    const S = maxCoord > 50 ? 0.254 : 1;

    // Capture the EasyEDA 3D model placement (SVGNODE outline3D). It carries the
    // model's Z rotation (c_rotation = rx,ry,rz), Z height, and — crucially —
    // the model body's true planar centre.
    //
    // That centre is the bounding-box centre of the SVGNODE's child outline
    // geometry (the projected 3D body outline). Those points live in the SAME
    // footprint coordinate frame as the pads, so the centre tells us exactly
    // where the body seats relative to the copper, even when the body is offset
    // from the pad centroid (e.g. a module with pads along only one edge).
    //
    // Do NOT use the SVGNODE `c_origin` attribute for this: its scale varies per
    // part (sometimes a different unit entirely — e.g. (411,308) where the pads
    // are at (4000,3000)), which is what once threw the model ~1 m off the
    // board. The child polyline points are always footprint-space.
    /** @type {{rotation:number, z:number, ox:number, oy:number}|null} */
    let model3dRaw = null;
    for (const shape of shapes) {
        if (typeof shape !== 'string' || !shape.startsWith('SVGNODE~')) continue;
        try {
            const svg = JSON.parse(shape.substring(8));
            const at = svg?.attrs;
            if (!at || at.c_etype !== 'outline3D') continue;
            const rot = String(at.c_rotation || '0,0,0').split(',').map(Number);
            // Bounding box of the outline geometry, in raw footprint units.
            let oMinX = Infinity, oMinY = Infinity, oMaxX = -Infinity, oMaxY = -Infinity;
            const accPts = (str) => {
                const n = String(str).trim().split(/[\s,]+/).map(Number);
                for (let i = 0; i + 1 < n.length; i += 2) {
                    if (!Number.isFinite(n[i]) || !Number.isFinite(n[i + 1])) continue;
                    oMinX = Math.min(oMinX, n[i]); oMaxX = Math.max(oMaxX, n[i]);
                    oMinY = Math.min(oMinY, n[i + 1]); oMaxY = Math.max(oMaxY, n[i + 1]);
                }
            };
            const walk = (node) => {
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node)) { node.forEach(walk); return; }
                if (node.attrs && typeof node.attrs.points === 'string') accPts(node.attrs.points);
                if (Array.isArray(node.childNodes)) node.childNodes.forEach(walk);
            };
            walk(svg);
            const hasOutline = oMaxX > oMinX;
            model3dRaw = {
                rotation: rot[2] || 0,
                z: (parseFloat(at.z) || 0) * S,
                ox: hasOutline ? (oMinX + oMaxX) / 2 : NaN,
                oy: hasOutline ? (oMinY + oMaxY) / 2 : NaN,
            };
        } catch { /* ignore malformed SVGNODE */ }
        break;
    }

    // KiCad footprints carry no EasyEDA SVGNODE outline. Their 3D model is
    // authored at the KiCad footprint origin (raw 0,0) — the SAME origin the
    // pads are positioned around. When we recentre the footprint on the pad
    // bounding box below (centerX/centerY), that origin moves to footprint-local
    // (-centerX,-centerY). Seat the model there rather than at the pad-bbox
    // centre, so 3-sided parts (modules with pads on only some edges, e.g.
    // ESP32-S3-WROOM-1) keep their body aligned to the copper instead of
    // self-centring on the asymmetric pad cluster. ox=oy=0 makes the model3d
    // dx/dy formula below resolve to dx=-centerX, dy=-centerY.
    if (!model3dRaw && source === 'KiCad') {
        model3dRaw = { rotation: 0, z: 0, ox: 0, oy: 0 };
    }

    /**
     * Map an EasyEDA layer code to a PCB layer id for outline/silk shapes.
     * Returns null for layers we don't render (copper, etc.).
     * @param {number} code
     * @returns {string|null}
     */
    /**
     * Map EasyEDA layer codes to PCB layer ids.
     * Official: https://docs.easyeda.com/en/DocumentFormat/3-EasyEDA-PCB-File-Format/
     * KiCad:    https://dev-docs.kicad.org/en/import-formats/easyeda/
     *   1  = TopLayer (F.Cu)       2  = BottomLayer (B.Cu)
     *   3  = TopSilkLayer          4  = BottomSilkLayer
     *   5  = TopPasterLayer        6  = BottomPasterLayer
     *   7  = TopSolderLayer        8  = BottomSolderLayer
     *   9  = Ratlines              10 = BoardOutline (Edge.Cuts)
     *   11 = Multi-Layer           12 = Document (Dwgs.User)
     *   13 = F.Fab (fabrication)   14 = B.Fab (fabrication)
     *   99/100/101 = EasyEDA Pro component shape/lead/marking layers
     * @param {number} code
     * @returns {string|null}
     */
    const eeShapeLayer = (code) => {
        if (code === 1) return 'top-copper';
        if (code === 2) return 'bottom-copper';
        if (code === 3) return 'top-silk';
        if (code === 4) return 'bottom-silk';
        if (code === 5) return 'top-paste';
        if (code === 6) return 'bottom-paste';
        if (code === 7) return 'top-mask';
        if (code === 8) return 'bottom-mask';
        if (code === 10) return 'board-outline';
        if (code === 11) return 'hole';            // multi-layer → render on hole layer
        if (code === 12) return 'document';
        if (code === 13 || code === 14) return 'document'; // fabrication → document
        // Layers 99/100/101 are EasyEDA Pro assembly/3D layers — not rendered
        return null;
    };

    for (const shape of shapes) {
        if (typeof shape !== 'string') continue;

        // ── PAD shapes ─────────────────────────────────────────
        if (shape.startsWith('PAD~')) {
            const parts = shape.split('~');
            if (parts.length < 7) continue;

            const padType = parts[1];
            const cx = parseFloat(parts[2]) * S;
            const cy = parseFloat(parts[3]) * S;
            let w  = parseFloat(parts[4]) * S;
            let h  = parseFloat(parts[5]) * S;

            // EasyEDA field [11] is pad rotation — swap w/h for 90°/270°
            if (isEasyEDA && parts.length > 11) {
                const rotation = parseFloat(parts[11]) || 0;
                if (Math.abs(rotation) % 180 === 90) {
                    const tmp = w; w = h; h = tmp;
                }
            }

            const num = isEasyEDA
                ? (parts[8] || String(pads.length + 1))
                : (parts[6] || String(pads.length + 1));

            // Pad layer naming convention: 'top' | 'bottom' | 'both'
            // (compact form used throughout the routing + gerber pipelines).
            // Tracks/edges use the long form 'top-copper'/'bottom-copper'.
            let padLayer = 'top';
            if (isEasyEDA) {
                const layerCode = parseInt(parts[6], 10);
                if (layerCode === 11) padLayer = 'both';        // multi-layer = through-hole
                else if (layerCode === 2) padLayer = 'bottom';  // back SMD
                else if (layerCode === 1) padLayer = 'top';     // front SMD
                else padLayer = 'both';                         // unknown → safer default
            } else if (parts[7] === 'top' || parts[7] === 'bottom' || parts[7] === 'both') {
                // KiCad copper pads carry their side as field [7]
                // ('top'/'bottom' for SMD, 'both' for through-hole).
                padLayer = parts[7];
            }

            // KiCad pads also carry mask/paste membership as fields [8]/[9]
            // ('1'/'0'). A copper pad without paste — e.g. a QFN exposed pad
            // that is windowpaned by separate PASTE apertures — must NOT get
            // a full-area paste opening. Absent (EasyEDA) → default true.
            const hasMask  = isEasyEDA ? true : parts[8] !== '0';
            const hasPaste = isEasyEDA ? true : parts[9] !== '0';

            if (!Number.isFinite(cx) || !Number.isFinite(cy) ||
                !Number.isFinite(w)  || !Number.isFinite(h)) continue;

            // PAD field [9] = hole radius (official docs), convert to diameter.
            // KiCad pads carry their drill DIAMETER in field [10] instead.
            const drill = isEasyEDA
                ? (parts.length > 9 ? (parseFloat(parts[9]) || 0) : 0) * 2 * S
                : (parts.length > 10 ? (parseFloat(parts[10]) || 0) : 0) * S;

            // Slotted (oval) drills: EasyEDA field [13] is the slot's full
            // length (10-mil units) and field [14] holds the two slot end-cap
            // centres ("x1 y1 x2 y2"). When the length exceeds the drill width
            // the hole is a stadium-shaped slot rather than a round bore.
            // slotAngle is the slot's long-axis orientation in footprint-local
            // space — derived from the end-cap centres, whose orientation the
            // (translation-only) footprint centring preserves.
            let slotLength = 0;
            let slotAngle = 0;
            if (isEasyEDA && parts.length > 13) {
                const sl = (parseFloat(parts[13]) || 0) * S;
                if (sl > drill + 1e-6) {
                    slotLength = sl;
                    const pts = (parts[14] || '').trim().split(/\s+/).map(Number);
                    if (pts.length >= 4 && pts.every(Number.isFinite)
                        && (pts[0] !== pts[2] || pts[1] !== pts[3])) {
                        slotAngle = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]);
                    } else if (parts.length > 11) {
                        // Fall back to the pad rotation when endpoints are absent.
                        slotAngle = ((parseFloat(parts[11]) || 0) * Math.PI) / 180;
                    }
                }
            }

            // Map EasyEDA's PAD shape enum onto our internal vocabulary.
            // POLYGON pads are fairly rare; we conservatively treat them as
            // their bounding rectangle for both rendering and routing — the
            // polygon outline (field [10]) is not yet consumed.
            let canonicalShape;
            switch (padType) {
                case 'ELLIPSE': canonicalShape = 'ellipse'; break;
                case 'OVAL':    canonicalShape = 'oval'; break;
                case 'POLYGON': canonicalShape = 'rect'; break; // bbox fallback
                case 'RECT':
                default:        canonicalShape = 'rect'; break;
            }

            pads.push({
                number: num, x: cx, y: cy, width: w, height: h,
                shape: canonicalShape,
                drill, slotLength, slotAngle, layer: padLayer,
                mask: hasMask, paste: hasPaste,
            });

            minX = Math.min(minX, cx - w / 2);
            minY = Math.min(minY, cy - h / 2);
            maxX = Math.max(maxX, cx + w / 2);
            maxY = Math.max(maxY, cy + h / 2);
            padMinX = Math.min(padMinX, cx - w / 2);
            padMinY = Math.min(padMinY, cy - h / 2);
            padMaxX = Math.max(padMaxX, cx + w / 2);
            padMaxY = Math.max(padMaxY, cy + h / 2);
            continue;
        }

        // ── PASTE apertures (KiCad paste-only sub-pads) ────────
        // Format: PASTE~{TYPE}~{x}~{y}~{w}~{h}~{side}
        // These are stencil openings with no copper/number (e.g. the matrix
        // a QFN exposed pad is subdivided into). They render on the paste
        // layer only and never participate in copper/ratsnest/netlist.
        if (shape.startsWith('PASTE~')) {
            const parts = shape.split('~');
            if (parts.length < 7) continue;
            const padType = parts[1];
            const cx = parseFloat(parts[2]) * S;
            const cy = parseFloat(parts[3]) * S;
            const w  = parseFloat(parts[4]) * S;
            const h  = parseFloat(parts[5]) * S;
            const side = parts[6] === 'bottom' ? 'bottom' : 'top';
            if (!Number.isFinite(cx) || !Number.isFinite(cy) ||
                !Number.isFinite(w)  || !Number.isFinite(h)) continue;
            let canonicalShape;
            switch (padType) {
                case 'ELLIPSE': canonicalShape = 'ellipse'; break;
                case 'OVAL':    canonicalShape = 'oval'; break;
                default:        canonicalShape = 'rect'; break;
            }
            pasteApertures.push({ x: cx, y: cy, width: w, height: h, shape: canonicalShape, side });
            minX = Math.min(minX, cx - w / 2);
            minY = Math.min(minY, cy - h / 2);
            maxX = Math.max(maxX, cx + w / 2);
            maxY = Math.max(maxY, cy + h / 2);
            continue;
        }


        // ── SILK shapes (from KiCad parser) ────────────────────
        // Format: SILK~LINE~x1~y1~x2~y2~strokeWidth~side
        //         SILK~CIRCLE~cx~cy~r~strokeWidth~side
        if (shape.startsWith('SILK~')) {
            const parts = shape.split('~');
            const type = parts[1];
            const side = parts[parts.length - 1] === 'bottom' ? 'bottom-silk' : 'top-silk';

            if (type === 'LINE' && parts.length >= 8) {
                const x1 = parseFloat(parts[2]), y1 = parseFloat(parts[3]);
                const x2 = parseFloat(parts[4]), y2 = parseFloat(parts[5]);
                const sw = parseFloat(parts[6]) || 0.12;
                if (Number.isFinite(x1) && Number.isFinite(y1)) {
                    silks.push({ type: 'line', x1, y1, x2, y2, strokeWidth: sw, layer: side });
                    minX = Math.min(minX, x1, x2); minY = Math.min(minY, y1, y2);
                    maxX = Math.max(maxX, x1, x2); maxY = Math.max(maxY, y1, y2);
                }
            } else if (type === 'CIRCLE' && parts.length >= 7) {
                const cx2 = parseFloat(parts[2]), cy2 = parseFloat(parts[3]);
                const r = parseFloat(parts[4]), sw = parseFloat(parts[5]) || 0.12;
                if (Number.isFinite(cx2) && Number.isFinite(r)) {
                    silks.push({ type: 'circle', cx: cx2, cy: cy2, r, strokeWidth: sw, layer: side });
                    minX = Math.min(minX, cx2 - r); minY = Math.min(minY, cy2 - r);
                    maxX = Math.max(maxX, cx2 + r); maxY = Math.max(maxY, cy2 + r);
                }
            } else if (type === 'PATH') {
                // Format: SILK~PATH~{svgPathData}~{strokeWidth}~{side}
                const pathD = parts[2];
                const sw = parseFloat(parts[3]) || 0.12;
                if (pathD) {
                    silks.push({ type: 'path', d: pathD, strokeWidth: sw, layer: side });
                    updateBoundsFromPath(pathD, 1);
                }
            }
            continue;
        }

        // ── TRACK shapes (from EasyEDA) ────────────────────────
        // Format: TRACK~strokeWidth~layer~net~points~id~locked
        // Points: space-separated x1 y1 x2 y2 ...
        if (shape.startsWith('TRACK~') && isEasyEDA) {
            const parts = shape.split('~');
            if (parts.length < 5) continue;
            const sw = (parseFloat(parts[1]) || 1) * S;
            const silkLayer = eeShapeLayer(parseInt(parts[2], 10));
            if (!silkLayer) continue;  // skip non-silk tracks

            const pointsStr = parts[4] || '';
            const coords = pointsStr.split(' ').map(v => parseFloat(v) * S);
            for (let i = 0; i + 3 < coords.length; i += 2) {
                const x1 = coords[i], y1 = coords[i + 1];
                const x2 = coords[i + 2], y2 = coords[i + 3];
                if (!Number.isFinite(x1) || !Number.isFinite(y1) ||
                    !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
                silks.push({ type: 'line', x1, y1, x2, y2, strokeWidth: sw, layer: silkLayer });
                minX = Math.min(minX, x1, x2); minY = Math.min(minY, y1, y2);
                maxX = Math.max(maxX, x1, x2); maxY = Math.max(maxY, y1, y2);
            }
            continue;
        }

        // ── CIRCLE shapes (from EasyEDA) ───────────────────────
        // Format: CIRCLE~cx~cy~radius~strokeWidth~layer~id~flag~...
        // Layers 100/101 are decorative (per kicad_jlcimport) — skip them
        if (shape.startsWith('CIRCLE~') && isEasyEDA) {
            const parts = shape.split('~');
            if (parts.length < 6) continue;

            const cx2 = parseFloat(parts[1]) * S;
            const cy2 = parseFloat(parts[2]) * S;
            const r   = parseFloat(parts[3]) * S;
            const sw  = (parseFloat(parts[4]) || 1) * S;
            const layerCode = parseInt(parts[5], 10);

            const silkLayer = eeShapeLayer(layerCode);
            if (!silkLayer) continue;

            // Filled circle: when stroke width covers entire circle
            const filled = sw >= 2 * r && r > 0;

            if (Number.isFinite(cx2) && Number.isFinite(r) && r > 0) {
                silks.push({ type: 'circle', cx: cx2, cy: cy2, r, strokeWidth: sw, layer: silkLayer, filled });
                minX = Math.min(minX, cx2 - r); minY = Math.min(minY, cy2 - r);
                maxX = Math.max(maxX, cx2 + r); maxY = Math.max(maxY, cy2 + r);
            }
            continue;
        }

        // ── ARC shapes (from EasyEDA) ──────────────────────────
        // Format: ARC~strokeWidth~layer~net~path~id~locked
        // path is SVG path data: M x1 y1 A rx ry rot large sweep x2 y2
        if (shape.startsWith('ARC~') && isEasyEDA) {
            const parts = shape.split('~');
            if (parts.length < 5) continue;
            const sw = (parseFloat(parts[1]) || 1) * S;
            const silkLayer = eeShapeLayer(parseInt(parts[2], 10));
            if (!silkLayer) continue;

            const pathData = parts[4] || '';
            // Scale path coordinates to mm at parse time
            const scaledPath = _scalePath(pathData, S);
            silks.push({ type: 'path', d: scaledPath, strokeWidth: sw, layer: silkLayer });
            updateBoundsFromPath(pathData, S);
            continue;
        }

        // ── RECT shapes (from EasyEDA) ─────────────────────────
        // Format: RECT~x~y~width~height~layer~id~locked
        if (shape.startsWith('RECT~') && isEasyEDA) {
            const parts = shape.split('~');
            if (parts.length < 6) continue;
            const rx = parseFloat(parts[1]) * S;
            const ry = parseFloat(parts[2]) * S;
            const rw = parseFloat(parts[3]) * S;
            const rh = parseFloat(parts[4]) * S;
            const layerCode = parseInt(parts[5], 10);
            const sw = 0.15 * S;  // No stroke width in RECT format
            const silkLayer = eeShapeLayer(layerCode);
            if (!silkLayer) continue;

            if (Number.isFinite(rx) && Number.isFinite(rw)) {
                // Emit 4 lines for the rectangle
                silks.push({ type: 'line', x1: rx, y1: ry, x2: rx + rw, y2: ry, strokeWidth: sw, layer: silkLayer });
                silks.push({ type: 'line', x1: rx + rw, y1: ry, x2: rx + rw, y2: ry + rh, strokeWidth: sw, layer: silkLayer });
                silks.push({ type: 'line', x1: rx + rw, y1: ry + rh, x2: rx, y2: ry + rh, strokeWidth: sw, layer: silkLayer });
                silks.push({ type: 'line', x1: rx, y1: ry + rh, x2: rx, y2: ry, strokeWidth: sw, layer: silkLayer });
                minX = Math.min(minX, rx); minY = Math.min(minY, ry);
                maxX = Math.max(maxX, rx + rw); maxY = Math.max(maxY, ry + rh);
            }
            continue;
        }

        // ── SOLIDREGION shapes (from EasyEDA) ──────────────────
        // Format: SOLIDREGION~layer~net~points~type~id~...
        if (shape.startsWith('SOLIDREGION~') && isEasyEDA) {
            const parts = shape.split('~');
            if (parts.length < 4) continue;
            const layerCode = parseInt(parts[1], 10);
            const silkLayer = eeShapeLayer(layerCode);
            if (!silkLayer) continue;

            const pathData = parts[3] || '';
            if (!pathData) continue;
            // Check if region type is 'solid' (filled) — field [4]
            const regionType = (parts[4] || '').trim().toLowerCase();
            const filled = regionType === 'solid';
            const scaledPath = _scalePath(pathData, S);
            silks.push({ type: 'path', d: scaledPath, strokeWidth: 0.15 * S, layer: silkLayer, filled });
            updateBoundsFromPath(pathData, S);
            continue;
        }

        // Log unrecognized shapes for debugging
        if (isEasyEDA && shape.length > 0) {
            const prefix = shape.split('~')[0];
            if (prefix !== 'SVGNODE' && prefix !== 'TEXT') {
                console.log('[PCB footprint] Unhandled EasyEDA shape:', prefix, '| layer:', shape.split('~').slice(0, 6).join('~'));
            }
        }
    }

    // ── Also parse HOLE shapes ────────────────────────────────
    // Done as a second pass so we don't disrupt the main loop
    for (const shape of shapes) {
        if (typeof shape !== 'string') continue;
        // Format: HOLE~cx~cy~radius~id~locked
        // EasyEDA field [3] is the hole RADIUS (10-mil units), matching the
        // PAD hole-radius convention — NOT a diameter. (Confirmed against the
        // EeFootprintHole schema in easyeda2kicad.) Treating it as a diameter
        // bores the hole at half its true size.
        if (shape.startsWith('HOLE~') && isEasyEDA) {
            const parts = shape.split('~');
            if (parts.length < 4) continue;
            const hx = parseFloat(parts[1]) * S;
            const hy = parseFloat(parts[2]) * S;
            const hr = parseFloat(parts[3]) * S;
            if (Number.isFinite(hx) && Number.isFinite(hr) && hr > 0) {
                silks.push({ type: 'circle', cx: hx, cy: hy, r: hr, strokeWidth: 0.15, layer: 'hole' });
                minX = Math.min(minX, hx - hr); minY = Math.min(minY, hy - hr);
                maxX = Math.max(maxX, hx + hr); maxY = Math.max(maxY, hy + hr);
            }
        }
    }

    if (pads.length === 0 && silks.length === 0) {
        return { pads: [], silks: [], outline: null, courtyard: null };
    }

    // Center the footprint at the origin — EasyEDA data uses arbitrary
    // absolute coordinates, so shift everything so the origin is at the pad
    // centre. Centre on the PAD bounding box when pads exist (so the copper
    // pads stay symmetric about the origin and align with the self-centring 3D
    // model); fall back to the all-geometry bbox for silk-only footprints.
    const hasPads = padMaxX > padMinX;
    const centerX = hasPads ? (padMinX + padMaxX) / 2 : (minX + maxX) / 2;
    const centerY = hasPads ? (padMinY + padMaxY) / 2 : (minY + maxY) / 2;
    if (Math.abs(centerX) > 0.01 || Math.abs(centerY) > 0.01) {
        for (const pad of pads) {
            pad.x -= centerX;
            pad.y -= centerY;
        }
        for (const ap of pasteApertures) {
            ap.x -= centerX;
            ap.y -= centerY;
        }
        for (const s of silks) {
            if (s.type === 'line') { s.x1 -= centerX; s.y1 -= centerY; s.x2 -= centerX; s.y2 -= centerY; }
            else if (s.type === 'circle') { s.cx -= centerX; s.cy -= centerY; }
            else if (s.type === 'path') {
                // Offset path coordinates for centering
                s.d = _offsetPath(s.d, -centerX, -centerY);
            }
        }
        // Re-reference the full-geometry bbox to the new (pad-centred) origin.
        // This bbox can be asymmetric (silk/courtyard extend further on one
        // side), so shift it rather than forcing it symmetric.
        minX -= centerX; maxX -= centerX;
        minY -= centerY; maxY -= centerY;
    }

    // Seat the 3D model on its true planar centre (the outline-geometry centre
    // captured above), expressed relative to the now-centred footprint origin.
    // The OBJ re-centres on its own XY bbox in the 3D viewer (objModelToMesh),
    // so dx/dy place that centre exactly on the body centre. For parts whose
    // body is centred on the pads (most SMD/THT parts) this resolves to ~0; for
    // parts with offset bodies (modules, edge connectors) it correctly shifts
    // the model so its leads land on the copper. Falls back to 0 (footprint
    // origin) when no outline geometry is available.
    /** @type {{dx:number, dy:number, rotation:number, z:number}|null} */
    const model3d = model3dRaw ? {
        dx: Number.isFinite(model3dRaw.ox) ? model3dRaw.ox * S - centerX : 0,
        dy: Number.isFinite(model3dRaw.oy) ? model3dRaw.oy * S - centerY : 0,
        rotation: model3dRaw.rotation,
        z: model3dRaw.z,
    } : null;

    const padding = 0.5;
    const outline = {
        x: minX - padding,
        y: minY - padding,
        width: maxX - minX + padding * 2,
        height: maxY - minY + padding * 2,
    };
    const courtyard = {
        x: minX - padding * 2,
        y: minY - padding * 2,
        width: maxX - minX + padding * 4,
        height: maxY - minY + padding * 4,
    };

    // Generate paste mask and solder mask shapes from pads.
    // EasyEDA doesn't store these explicitly — they're derived from pad geometry.
    // Paste = same size as pad, Mask = pad + 0.1mm expansion.
    const MASK_EXPANSION = 0.1;  // mm
    const sw = 0.1;

    /** Push a filled pad-shaped opening onto `silks` for the given layer. */
    const emitFilledOpening = (px, py, pw, ph, padShape, exp, layerId) => {
        if (padShape === 'ellipse') {
            silks.push({ type: 'circle', cx: px, cy: py,
                r: pw / 2 + exp, strokeWidth: sw, layer: layerId, filled: true });
        } else if (padShape === 'oval') {
            // Stadium / discorectangle as SVG path (rounded rect with r = min(w,h)/2)
            const r = Math.min(pw, ph) / 2 + exp;
            const x1 = px - pw / 2 - exp, y1 = py - ph / 2 - exp;
            const w = pw + 2 * exp, h = ph + 2 * exp;
            let d;
            if (w >= h) {
                d = `M ${x1 + r} ${y1} L ${x1 + w - r} ${y1} A ${r} ${r} 0 0 1 ${x1 + w - r} ${y1 + h} L ${x1 + r} ${y1 + h} A ${r} ${r} 0 0 1 ${x1 + r} ${y1} Z`;
            } else {
                d = `M ${x1} ${y1 + r} L ${x1} ${y1 + h - r} A ${r} ${r} 0 0 0 ${x1 + w} ${y1 + h - r} L ${x1 + w} ${y1 + r} A ${r} ${r} 0 0 0 ${x1} ${y1 + r} Z`;
            }
            silks.push({ type: 'path', d, strokeWidth: sw, layer: layerId, filled: true });
        } else {
            // Filled rectangle as path
            const x1 = px - pw / 2 - exp, y1 = py - ph / 2 - exp;
            const x2 = px + pw / 2 + exp, y2 = py + ph / 2 + exp;
            const d = `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2} L ${x1} ${y2} Z`;
            silks.push({ type: 'path', d, strokeWidth: sw, layer: layerId, filled: true });
        }
    };

    for (const pad of pads) {
        const copperLayer = pad.layer || 'top';
        const isTop = copperLayer === 'top' || copperLayer === 'both';
        const isBottom = copperLayer === 'bottom' || copperLayer === 'both';

        // A pad only contributes paste/mask openings on the layers it
        // actually lists (KiCad). Absent flags (EasyEDA) default to true.
        for (const side of (isTop ? ['top'] : []).concat(isBottom ? ['bottom'] : [])) {
            if (pad.paste !== false) emitFilledOpening(pad.x, pad.y, pad.width, pad.height, pad.shape, 0, `${side}-paste`);
            if (pad.mask !== false) emitFilledOpening(pad.x, pad.y, pad.width, pad.height, pad.shape, MASK_EXPANSION, `${side}-mask`);
        }
    }

    // Standalone paste apertures (no copper) — windowpane stencil openings.
    for (const ap of pasteApertures) {
        emitFilledOpening(ap.x, ap.y, ap.width, ap.height, ap.shape, 0, `${ap.side}-paste`);
    }

    return { pads, silks, outline, courtyard, pasteApertures, model3d };
}

/**
 * Tokenise an SVG path string into an array of {cmd, args} objects.
 * Handles compact notation (no spaces between numbers) and repeated
 * implicit commands.  Returns [{cmd: 'M', args: [x,y]}, ...].
 * @param {string} d
 * @returns {Array<{cmd: string, args: number[]}>}
 */
function _tokenisePath(d) {
    const segs = [];
    // Split into command + numbers.  Regex captures a command letter
    // followed by all the numbers (with optional signs/decimals).
    const re = /([MmLlHhVvCcSsQqTtAaZz])\s*((?:[^MmLlHhVvCcSsQqTtAaZz])*)/g;
    let m;
    while ((m = re.exec(d)) !== null) {
        const cmd = m[1];
        const argStr = m[2].trim();
        if (cmd === 'Z' || cmd === 'z' || !argStr) {
            segs.push({ cmd, args: [] });
            continue;
        }
        // Extract all numbers (handles "1.5-2.3" → [1.5, -2.3])
        const nums = [];
        const nr = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
        let nm;
        while ((nm = nr.exec(argStr)) !== null) nums.push(parseFloat(nm[0]));
        segs.push({ cmd, args: nums });
    }
    return segs;
}

/**
 * Scale coordinates in an SVG path by factor `s`, correctly preserving
 * arc flags (large-arc and sweep-flag are 0/1 and must not be scaled).
 * @param {string} d - SVG path data
 * @param {number} s - Scale factor (1 = no change)
 * @returns {string} Scaled SVG path data
 */
function _scalePath(d, s) {
    if (s === 1) return d;
    const segs = _tokenisePath(d);
    const parts = [];
    for (const { cmd, args } of segs) {
        const upper = cmd.toUpperCase();
        const a = args.slice();
        if (upper === 'Z') {
            parts.push(cmd);
        } else if (upper === 'H') {
            // H x
            for (let i = 0; i < a.length; i++) a[i] *= s;
            parts.push(cmd + ' ' + a.join(' '));
        } else if (upper === 'V') {
            // V y
            for (let i = 0; i < a.length; i++) a[i] *= s;
            parts.push(cmd + ' ' + a.join(' '));
        } else if (upper === 'A') {
            // A rx ry rotation large-arc sweep x y  (7 params per arc)
            for (let i = 0; i + 6 < a.length; i += 7) {
                a[i]     *= s; // rx
                a[i + 1] *= s; // ry
                // a[i+2] = rotation — don't scale
                // a[i+3] = large-arc flag — don't scale
                // a[i+4] = sweep flag — don't scale
                a[i + 5] *= s; // x
                a[i + 6] *= s; // y
            }
            parts.push(cmd + ' ' + a.join(' '));
        } else {
            // M, L, C, S, Q, T — all args are coordinates
            for (let i = 0; i < a.length; i++) a[i] *= s;
            parts.push(cmd + ' ' + a.join(' '));
        }
    }
    return parts.join(' ');
}

/**
 * Offset coordinate pairs in an SVG path by (dx, dy).
 * Only affects absolute commands; relative commands are unchanged.
 * @param {string} d - SVG path data
 * @param {number} dx
 * @param {number} dy
 * @returns {string}
 */
function _offsetPath(d, dx, dy) {
    const segs = _tokenisePath(d);
    const parts = [];
    for (const { cmd, args } of segs) {
        const a = args.slice();
        // Only offset absolute (uppercase) commands
        if (cmd === 'M' || cmd === 'L' || cmd === 'T') {
            for (let i = 0; i + 1 < a.length; i += 2) { a[i] += dx; a[i + 1] += dy; }
        } else if (cmd === 'H') {
            for (let i = 0; i < a.length; i++) a[i] += dx;
        } else if (cmd === 'V') {
            for (let i = 0; i < a.length; i++) a[i] += dy;
        } else if (cmd === 'C') {
            for (let i = 0; i + 1 < a.length; i += 2) { a[i] += dx; a[i + 1] += dy; }
        } else if (cmd === 'S' || cmd === 'Q') {
            for (let i = 0; i + 1 < a.length; i += 2) { a[i] += dx; a[i + 1] += dy; }
        } else if (cmd === 'A') {
            for (let i = 0; i + 6 < a.length; i += 7) { a[i + 5] += dx; a[i + 6] += dy; }
        }
        // Relative commands (lowercase) and Z are left unchanged
        parts.push(cmd + (a.length ? ' ' + a.join(' ') : ''));
    }
    return parts.join(' ');
}

// ── SVG Rendering ────────────────────────────────────────────────

/**
 * Render a footprint's elements into per-layer SVG groups.
 *
 * @param {object} fp    - Footprint geometry from generateFootprint()
 * @param {string} ref   - Reference designator (e.g. 'R1')
 * @param {number} x     - World X position
 * @param {number} y     - World Y position
 * @param {number} rotation - Rotation in degrees
 * @returns {Map<string, SVGGElement>} Map of layerId → SVG group
 */
export function renderFootprint(fp, ref, x, y, rotation = 0) {
    /** @type {Map<string, SVGGElement>} */
    const layers = new Map();

    const getLayer = (layerId) => {
        let g = layers.get(layerId);
        if (!g) {
            g = document.createElementNS(NS, 'g');
            g.setAttribute('class', `pcb-fp-${layerId}`);
            g.setAttribute('data-ref', ref);
            g.setAttribute('data-fp-layer', layerId);
            let transform = `translate(${x}, ${y})`;
            if (rotation) transform += ` rotate(${rotation})`;
            g.setAttribute('transform', transform);
            layers.set(layerId, g);
        }
        return g;
    };

    const layerColors = {
        'top-copper': '#e74c3c',
        'bottom-copper': '#3498db',
        'top-silk': '#f0e68c',
        'bottom-silk': '#a89332',
        'top-paste': '#e88dd6',
        'bottom-paste': '#8d5e87',
        'top-mask': '#9b59b6',
        'bottom-mask': '#5b3a70',
        'document': '#95a5a6',
        'board-outline': '#f1c40f',
        'hole': '#1abc9c',
    };

    // Silk outline (fallback bounding box when no real silk data)
    if (fp.outline && (!fp.silks || fp.silks.length === 0)) {
        const ol = document.createElementNS(NS, 'rect');
        ol.setAttribute('x', fp.outline.x);
        ol.setAttribute('y', fp.outline.y);
        ol.setAttribute('width', fp.outline.width);
        ol.setAttribute('height', fp.outline.height);
        ol.setAttribute('fill', 'none');
        ol.setAttribute('stroke', '#f0e68c');
        ol.setAttribute('stroke-width', '0.15');
        getLayer('top-silk').appendChild(ol);
    }

    // Silkscreen / document / outline shapes → their respective layers
    if (fp.silks) {
        for (const s of fp.silks) {
            const color = layerColors[s.layer] || '#f0e68c';
            const target = getLayer(s.layer);
            if (s.type === 'line') {
                const ln = document.createElementNS(NS, 'line');
                ln.setAttribute('x1', String(s.x1));
                ln.setAttribute('y1', String(s.y1));
                ln.setAttribute('x2', String(s.x2));
                ln.setAttribute('y2', String(s.y2));
                ln.setAttribute('stroke', color);
                ln.setAttribute('stroke-width', String(s.strokeWidth));
                ln.setAttribute('stroke-linecap', 'round');
                target.appendChild(ln);
            } else if (s.type === 'circle') {
                const ci = document.createElementNS(NS, 'circle');
                ci.setAttribute('cx', String(s.cx));
                ci.setAttribute('cy', String(s.cy));
                ci.setAttribute('r', String(s.r));
                ci.setAttribute('fill', s.filled ? color : 'none');
                ci.setAttribute('fill-opacity', s.filled ? '0.5' : '1');
                ci.setAttribute('stroke', color);
                ci.setAttribute('stroke-width', String(s.strokeWidth));
                target.appendChild(ci);
            } else if (s.type === 'path') {
                const p = document.createElementNS(NS, 'path');
                p.setAttribute('d', s.d);
                p.setAttribute('fill', s.filled ? color : 'none');
                p.setAttribute('fill-opacity', s.filled ? '0.5' : '1');
                p.setAttribute('stroke', color);
                p.setAttribute('stroke-width', String(s.strokeWidth));
                p.setAttribute('stroke-linecap', 'round');
                target.appendChild(p);
            }
        }
    }

    // Pads → copper layers.
    //
    // Draw larger pads first so smaller ones land on top. A thermal/heatsink
    // pad (e.g. ESP32-S3-WROOM-1 pad "41") is one big SMD rect plus a grid of
    // small thru-hole thermal vias sharing the number. In the source order the
    // big rect sits mid-list and would paint over every via emitted before it,
    // hiding ~half of them. Sorting by descending area puts the big pad
    // underneath and keeps all the vias visible, matching KiCad.
    const padsToRender = [...fp.pads].sort(
        (a, b) => ((Number(b.width) || 0) * (Number(b.height) || 0))
                - ((Number(a.width) || 0) * (Number(a.height) || 0))
    );
    for (const pad of padsToRender) {
        // Determine target layer(s)
        // Pad layer convention: 'top'|'bottom'|'both' (short form).
        // The SVG groups still use 'top-copper'/'bottom-copper' ids.
        const padLayers = pad.layer === 'both'
            ? ['top-copper', 'bottom-copper']
            : pad.layer === 'bottom'
                ? ['bottom-copper']
                : ['top-copper'];

        for (const layerId of padLayers) {
            const target = getLayer(layerId);
            const padG = document.createElementNS(NS, 'g');
            padG.setAttribute('class', 'pcb-pad');
            padG.setAttribute('data-pad', pad.number);
            // Through-hole ('both') pads are gold on every face; SMD pads take
            // the copper colour of the side they sit on (recoloured on flip).
            padG.setAttribute('data-pad-kind', pad.layer === 'both' ? 'th' : 'smd');

            const padFill = layerId === 'bottom-copper'
                ? '#3498db'
                : pad.layer === 'both' ? '#b8860b' : '#e74c3c';

            if (pad.shape === 'ellipse') {
                const c = document.createElementNS(NS, 'circle');
                c.setAttribute('cx', String(pad.x));
                c.setAttribute('cy', String(pad.y));
                c.setAttribute('r', String(pad.width / 2));
                c.setAttribute('fill', padFill);
                padG.appendChild(c);
            } else if (pad.shape === 'oval') {
                // Stadium = SVG rect with rx = ry = min(w,h)/2
                const r = Math.min(pad.width, pad.height) / 2;
                const rect = document.createElementNS(NS, 'rect');
                rect.setAttribute('x', String(pad.x - pad.width / 2));
                rect.setAttribute('y', String(pad.y - pad.height / 2));
                rect.setAttribute('width', String(pad.width));
                rect.setAttribute('height', String(pad.height));
                rect.setAttribute('rx', String(r));
                rect.setAttribute('ry', String(r));
                rect.setAttribute('fill', padFill);
                padG.appendChild(rect);
            } else {
                const r = document.createElementNS(NS, 'rect');
                r.setAttribute('x', String(pad.x - pad.width / 2));
                r.setAttribute('y', String(pad.y - pad.height / 2));
                r.setAttribute('width', String(pad.width));
                r.setAttribute('height', String(pad.height));
                r.setAttribute('fill', padFill);
                padG.appendChild(r);
            }

            if (pad.drill > 0) {
                if (pad.slotLength > pad.drill) {
                    // Stadium-shaped slot drill: a round-capped stroke of
                    // width = drill, length = slotLength, along slotAngle.
                    const half = (pad.slotLength - pad.drill) / 2;
                    const ca = Math.cos(pad.slotAngle || 0);
                    const sa = Math.sin(pad.slotAngle || 0);
                    const slot = document.createElementNS(NS, 'line');
                    slot.setAttribute('x1', String(pad.x - half * ca));
                    slot.setAttribute('y1', String(pad.y - half * sa));
                    slot.setAttribute('x2', String(pad.x + half * ca));
                    slot.setAttribute('y2', String(pad.y + half * sa));
                    slot.setAttribute('stroke', 'var(--pcb-drill, #1a1a2e)');
                    slot.setAttribute('stroke-width', String(pad.drill));
                    slot.setAttribute('stroke-linecap', 'round');
                    padG.appendChild(slot);
                } else {
                    const hole = document.createElementNS(NS, 'circle');
                    hole.setAttribute('cx', String(pad.x));
                    hole.setAttribute('cy', String(pad.y));
                    hole.setAttribute('r', String(pad.drill / 2));
                    hole.setAttribute('fill', 'var(--pcb-drill, #1a1a2e)');
                    padG.appendChild(hole);
                }
            }

            const numText = document.createElementNS(NS, 'text');
            const padLabel = String(pad.number ?? '');
            const padW = Math.max(0.01, Number(pad.width) || 0.01);
            const padH = Math.max(0.01, Number(pad.height) || 0.01);
            const minDim = Math.min(padW, padH);
            const labelChars = Math.max(1, padLabel.length);
            // Fit by both pad height and available horizontal width so
            // multi-digit labels on fine-pitch pads don't overlap.
            const sizeByHeight = minDim * 0.62;
            const sizeByWidth = (padW * 0.82) / (0.62 * labelChars);
            const labelFont = Math.max(0.2, Math.min(0.9, sizeByHeight, sizeByWidth));
            numText.setAttribute('x', String(pad.x));
            numText.setAttribute('y', String(pad.y));
            numText.setAttribute('text-anchor', 'middle');
            numText.setAttribute('dominant-baseline', 'central');
            numText.setAttribute('font-size', String(labelFont));
            numText.setAttribute('fill', 'var(--pcb-pad-text, #fff)');
            numText.setAttribute('font-family', 'Arial, sans-serif');
            numText.setAttribute('pointer-events', 'none');
            // Kept readable when the footprint is mirrored (see applyPlacementPose).
            numText.setAttribute('class', 'pcb-mirror-text');
            numText.setAttribute('data-mx-center', String(pad.x));
            numText.textContent = padLabel;
            // Pad numbers live on a dedicated layer that sits above the copper
            // (and any tracks routed on it) so a track connecting to the pad
            // never hides its number. The layer flips with the footprint side.
            const numLayerId = layerId === 'bottom-copper' ? 'bottom-pad-numbers' : 'top-pad-numbers';
            getLayer(numLayerId).appendChild(numText);

            target.appendChild(padG);
        }
    }

    // Reference text → top silk (stroked polylines, identical to gerber)
    const refSize = REF_DEFAULT_SIZE;
    const outlineY = fp.outline ? fp.outline.y : -2;
    const cxRef = fp.outline ? fp.outline.x + fp.outline.width / 2 : 0;
    // SVG is Y-down; place baseline at outlineY - 0.8 (above the outline).
    const baseY = outlineY - 0.8;
    const refGroup = document.createElementNS(NS, 'g');
    refGroup.setAttribute('pointer-events', 'none');
    refGroup.setAttribute('fill', 'none');
    refGroup.setAttribute('stroke', '#f0e68c');
    refGroup.setAttribute('stroke-linecap', 'round');
    refGroup.setAttribute('stroke-linejoin', 'round');
    // Kept readable when the footprint is mirrored (see applyPlacementPose).
    refGroup.setAttribute('class', 'pcb-mirror-text');
    refGroup.setAttribute('data-fp-ref', '1');
    // Fill in the stroked glyphs + layout attributes (bbox/centre/anchor).
    applyRefGeometry(refGroup, ref, cxRef, baseY, refSize, REF_DEFAULT_STROKE);
    getLayer('top-silk').appendChild(refGroup);

    return layers;
}
