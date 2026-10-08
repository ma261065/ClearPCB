/**
 * KiCad footprint parser owns translating .kicad_mod S-expressions into
 * ClearPCB footprint preview shapes and bounding boxes.
 */

import { FOOTPRINT_MARKER } from './constants.js';



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse a `.kicad_mod` S-expression into a simplified pad-shapes array
     * with a bounding box, suitable for rendering a footprint preview.
     * KiCad footprint files are Y-down like ClearPCB, so coordinates are used as
     * written (unlike `.kicad_sym` symbols, which are Y-up).
     * @param {string} content - Raw `.kicad_mod` file content
     * @returns {{shapes: Array, bbox: Object}|null}
     */
export function _parseFootprintPreview(fetcher, content) {
    if (!content) return null;

    const sexp = fetcher._parseSExp(content);
    if (!Array.isArray(sexp) || sexp[0] !== FOOTPRINT_MARKER) {
        return null;
    }

    const shapes = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const includeRect = (x, y, w, h) => {
        const rx = x - w / 2;
        const ry = y - h / 2;
        const x2 = rx + w;
        const y2 = ry + h;
        minX = Math.min(minX, rx);
        minY = Math.min(minY, ry);
        maxX = Math.max(maxX, x2);
        maxY = Math.max(maxY, y2);
    };

    for (const item of sexp) {
        if (!Array.isArray(item)) continue;

        // ── Silk lines (fp_line on F.SilkS / B.SilkS) ────────
        if (item[0] === 'fp_line') {
            let sx = 0, sy = 0, ex = 0, ey = 0, layer = '', sw = 0.12;
            for (const sub of item) {
                if (!Array.isArray(sub)) continue;
                if (sub[0] === 'start') { sx = parseFloat(sub[1]) || 0; sy = parseFloat(sub[2]) || 0; }
                else if (sub[0] === 'end') { ex = parseFloat(sub[1]) || 0; ey = parseFloat(sub[2]) || 0; }
                else if (sub[0] === 'layer') { layer = typeof sub[1] === 'string' ? sub[1].replace(/"/g, '') : ''; }
                else if (sub[0] === 'stroke') {
                    for (const ssub of sub) {
                        if (Array.isArray(ssub) && ssub[0] === 'width') sw = parseFloat(ssub[1]) || 0.12;
                    }
                }
                else if (sub[0] === 'width') { sw = parseFloat(sub[1]) || 0.12; }
            }
            if (layer === 'F.SilkS' || layer === 'B.SilkS') {
                const side = layer === 'F.SilkS' ? 'top' : 'bottom';
                shapes.push(`SILK~LINE~${sx}~${sy}~${ex}~${ey}~${sw}~${side}`);
                minX = Math.min(minX, sx, ex); minY = Math.min(minY, sy, ey);
                maxX = Math.max(maxX, sx, ex); maxY = Math.max(maxY, sy, ey);
            }
            continue;
        }

        // ── Silk circles (fp_circle on F.SilkS / B.SilkS) ────
        if (item[0] === 'fp_circle') {
            let cx2 = 0, cy2 = 0, endx = 0, endy = 0, layer = '', sw = 0.12;
            for (const sub of item) {
                if (!Array.isArray(sub)) continue;
                if (sub[0] === 'center') { cx2 = parseFloat(sub[1]) || 0; cy2 = parseFloat(sub[2]) || 0; }
                else if (sub[0] === 'end') { endx = parseFloat(sub[1]) || 0; endy = parseFloat(sub[2]) || 0; }
                else if (sub[0] === 'layer') { layer = typeof sub[1] === 'string' ? sub[1].replace(/"/g, '') : ''; }
                else if (sub[0] === 'stroke') {
                    for (const ssub of sub) {
                        if (Array.isArray(ssub) && ssub[0] === 'width') sw = parseFloat(ssub[1]) || 0.12;
                    }
                }
                else if (sub[0] === 'width') { sw = parseFloat(sub[1]) || 0.12; }
            }
            if (layer === 'F.SilkS' || layer === 'B.SilkS') {
                const r = Math.hypot(endx - cx2, endy - cy2);
                const side = layer === 'F.SilkS' ? 'top' : 'bottom';
                shapes.push(`SILK~CIRCLE~${cx2}~${cy2}~${r}~${sw}~${side}`);
                minX = Math.min(minX, cx2 - r); minY = Math.min(minY, cy2 - r);
                maxX = Math.max(maxX, cx2 + r); maxY = Math.max(maxY, cy2 + r);
            }
            continue;
        }

        // ── Silk arcs (fp_arc on F.SilkS / B.SilkS) ──────────
        if (item[0] === 'fp_arc') {
            let sx = 0, sy = 0, mx = 0, my = 0, ex = 0, ey = 0, layer = '', sw = 0.12;
            for (const sub of item) {
                if (!Array.isArray(sub)) continue;
                if (sub[0] === 'start') { sx = parseFloat(sub[1]) || 0; sy = parseFloat(sub[2]) || 0; }
                else if (sub[0] === 'mid') { mx = parseFloat(sub[1]) || 0; my = parseFloat(sub[2]) || 0; }
                else if (sub[0] === 'end') { ex = parseFloat(sub[1]) || 0; ey = parseFloat(sub[2]) || 0; }
                else if (sub[0] === 'layer') { layer = typeof sub[1] === 'string' ? sub[1].replace(/"/g, '') : ''; }
                else if (sub[0] === 'stroke') {
                    for (const ssub of sub) {
                        if (Array.isArray(ssub) && ssub[0] === 'width') sw = parseFloat(ssub[1]) || 0.12;
                    }
                }
                else if (sub[0] === 'width') { sw = parseFloat(sub[1]) || 0.12; }
            }
            if (layer === 'F.SilkS' || layer === 'B.SilkS') {
                const side = layer === 'F.SilkS' ? 'top' : 'bottom';
                // Approximate arc with a quadratic bezier through midpoint
                const d = `M ${sx} ${sy} Q ${mx * 2 - (sx + ex) / 2} ${my * 2 - (sy + ey) / 2} ${ex} ${ey}`;
                shapes.push(`SILK~PATH~${d}~${sw}~${side}`);
                minX = Math.min(minX, sx, mx, ex); minY = Math.min(minY, sy, my, ey);
                maxX = Math.max(maxX, sx, mx, ex); maxY = Math.max(maxY, sy, my, ey);
            }
            continue;
        }

        // ── Silk rects (fp_rect on F.SilkS / B.SilkS) ────────
        if (item[0] === 'fp_rect') {
            let sx = 0, sy = 0, ex = 0, ey = 0, layer = '', sw = 0.12;
            for (const sub of item) {
                if (!Array.isArray(sub)) continue;
                if (sub[0] === 'start') { sx = parseFloat(sub[1]) || 0; sy = parseFloat(sub[2]) || 0; }
                else if (sub[0] === 'end') { ex = parseFloat(sub[1]) || 0; ey = parseFloat(sub[2]) || 0; }
                else if (sub[0] === 'layer') { layer = typeof sub[1] === 'string' ? sub[1].replace(/"/g, '') : ''; }
                else if (sub[0] === 'stroke') {
                    for (const ssub of sub) {
                        if (Array.isArray(ssub) && ssub[0] === 'width') sw = parseFloat(ssub[1]) || 0.12;
                    }
                }
                else if (sub[0] === 'width') { sw = parseFloat(sub[1]) || 0.12; }
            }
            if (layer === 'F.SilkS' || layer === 'B.SilkS') {
                const side = layer === 'F.SilkS' ? 'top' : 'bottom';
                // Emit 4 lines for the rectangle
                shapes.push(`SILK~LINE~${sx}~${sy}~${ex}~${sy}~${sw}~${side}`);
                shapes.push(`SILK~LINE~${ex}~${sy}~${ex}~${ey}~${sw}~${side}`);
                shapes.push(`SILK~LINE~${ex}~${ey}~${sx}~${ey}~${sw}~${side}`);
                shapes.push(`SILK~LINE~${sx}~${ey}~${sx}~${sy}~${sw}~${side}`);
                minX = Math.min(minX, sx, ex); minY = Math.min(minY, sy, ey);
                maxX = Math.max(maxX, sx, ex); maxY = Math.max(maxY, sy, ey);
            }
            continue;
        }

        // ── Silk polygons (fp_poly on F.SilkS / B.SilkS) ─────
        if (item[0] === 'fp_poly') {
            let layer = '', sw = 0.12;
            /** @type {number[][]} */
            const pts = [];
            for (const sub of item) {
                if (!Array.isArray(sub)) continue;
                if (sub[0] === 'layer') { layer = typeof sub[1] === 'string' ? sub[1].replace(/"/g, '') : ''; }
                else if (sub[0] === 'pts') {
                    for (const xy of sub) {
                        if (Array.isArray(xy) && xy[0] === 'xy') {
                            pts.push([parseFloat(xy[1]) || 0, parseFloat(xy[2]) || 0]);
                        }
                    }
                }
                else if (sub[0] === 'stroke') {
                    for (const ssub of sub) {
                        if (Array.isArray(ssub) && ssub[0] === 'width') sw = parseFloat(ssub[1]) || 0.12;
                    }
                }
                else if (sub[0] === 'width') { sw = parseFloat(sub[1]) || 0.12; }
            }
            if ((layer === 'F.SilkS' || layer === 'B.SilkS') && pts.length >= 2) {
                const side = layer === 'F.SilkS' ? 'top' : 'bottom';
                for (let i = 0; i < pts.length; i++) {
                    const [x1, y1] = pts[i];
                    const [x2, y2] = pts[(i + 1) % pts.length];
                    shapes.push(`SILK~LINE~${x1}~${y1}~${x2}~${y2}~${sw}~${side}`);
                    minX = Math.min(minX, x1); minY = Math.min(minY, y1);
                    maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
                }
            }
            continue;
        }

        // ── Pads ──────────────────────────────────────────────
        if (item[0] !== 'pad') continue;

        const padNumber = item.length > 1 && item[1] != null ? String(item[1]).replace(/^"|"$/g, '') : '';
        const padKind = typeof item[2] === 'string' ? item[2] : '';
        const shape = typeof item[3] === 'string' ? item[3] : '';
        let atX = 0;
        let atY = 0;
        let rotation = 0;
        let sizeX = 0;
        let sizeY = 0;
        let drill = 0;
        let slotLength = 0;
        let slotAngle = 0;
        // Layer membership. A pad may live on any combination of copper,
        // soldermask and solderpaste, on the front (F.*) or back (B.*).
        let hasCopper = false, hasPaste = false, hasMask = false;
        let onFront = false, onBack = false;

        for (const padItem of item) {
            if (!Array.isArray(padItem)) continue;
            if (padItem[0] === 'at') {
                atX = parseFloat(padItem[1]) || 0;
                atY = parseFloat(padItem[2]) || 0;
                rotation = padItem.length > 3 ? parseFloat(padItem[3]) || 0 : 0;
            } else if (padItem[0] === 'size') {
                sizeX = parseFloat(padItem[1]) || 0;
                sizeY = parseFloat(padItem[2]) || 0;
            } else if (padItem[0] === 'drill') {
                if (padItem[1] === 'oval') {
                    const dx = parseFloat(padItem[2]) || 0;
                    const dy = parseFloat(padItem[3]) || 0;
                    drill = Math.min(dx, dy) || dx || dy;
                    slotLength = Math.max(dx, dy);
                    slotAngle = dy > dx ? Math.PI / 2 : 0;
                } else {
                    drill = parseFloat(padItem[1]) || 0;
                }
            } else if (padItem[0] === 'layers') {
                for (let li = 1; li < padItem.length; li++) {
                    const lyr = String(padItem[li]).replace(/"/g, '');
                    if (lyr === 'F.Cu' || lyr === 'B.Cu' || lyr.endsWith('*.Cu')) hasCopper = true;
                    else if (lyr.endsWith('.Paste')) hasPaste = true;
                    else if (lyr.endsWith('.Mask')) hasMask = true;
                    if (lyr.startsWith('F.') || lyr.startsWith('*.')) onFront = true;
                    if (lyr.startsWith('B.')) onBack = true;
                }
            }
        }

        if (!sizeX || !sizeY) continue;
        // KiCad pad rotation is counter-clockwise on screen, which is negative in
        // KiCad's (and ClearPCB's) Y-down footprint coordinates.
        slotAngle -= rotation * Math.PI / 180;

        if (padKind === 'np_thru_hole') {
            if (drill > 0) {
                // Mechanical holes must not become numbered copper pads.
                shapes.push(`HOLE~${atX}~${atY}~${drill}~${slotLength}~${slotAngle}`);
                includeRect(atX, atY, sizeX, sizeY);
            }
            continue;
        }

        let w = sizeX;
        let h = sizeY;
        if (Math.abs(rotation) % 180 === 90) {
            w = sizeY;
            h = sizeX;
        }

        // KiCad pad shape vocabulary: circle, oval, rect, roundrect,
        // trapezoid, chamfered_rect, custom. We map to the EasyEDA-style
        // PAD~ enum used internally by the footprint parser:
        //   - circle → ELLIPSE (router treats hw==hh as exact circle)
        //   - oval   → OVAL    (router uses stadium/discorectangle math)
        //   - everything else → RECT (conservative bbox)
        let padType;
        if (shape === 'circle') padType = 'ELLIPSE';
        else if (shape === 'oval') padType = 'OVAL';
        else padType = 'RECT';

        const side = onBack && !onFront ? 'bottom' : 'top';

        if (!hasCopper) {
            // Non-copper pad — a paste (or mask) aperture, not a pin.
            // The matrix of paste sub-apertures a QFN exposed pad is
            // subdivided into is the common case; importing these as
            // copper pins collides their (blank → auto-numbered)
            // numbers with real pins and stacks them in gerber. Emit
            // them as standalone PASTE apertures so the stencil stays
            // faithful without polluting the electrical pad list.
            if (hasPaste) {
                shapes.push(`PASTE~${padType}~${atX}~${atY}~${w}~${h}~${side}`);
                includeRect(atX, atY, w, h);
            }
            continue;
        }

        // Copper pad. Append side + mask/paste membership so the
        // footprint pipeline can build a faithful stencil/mask: an
        // exposed pad that is copper+mask but NOT paste (windowpaned
        // separately) must not get a full-area paste opening.
        // Through-hole pads (and any copper pad carrying a
        // drill — e.g. the thermal-via grid under an exposed pad) live on
        // both copper faces and render with a drilled bore. Field [10] =
        // drill diameter (mm, 0 for SMD); optional fields [11]/[12]
        // retain slot length (mm) and local axis angle (radians).
        const isThruHole = padKind === 'thru_hole' || drill > 0;
        const copperSide = isThruHole ? 'both' : side;
        const maskFlag = hasMask ? 1 : 0;
        const pasteFlag = hasPaste ? 1 : 0;
        shapes.push(`PAD~${padType}~${atX}~${atY}~${w}~${h}~${padNumber}~${copperSide}~${maskFlag}~${pasteFlag}~${drill}`
            + (slotLength > drill ? `~${slotLength}~${slotAngle}` : ''));
        includeRect(atX, atY, w, h);
    }

    if (shapes.length === 0 || !Number.isFinite(minX)) {
        return null;
    }

    return {
        shapes,
        bbox: {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        }
    };
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Extract the `Footprint` property value for a given symbol name
     * from raw KiCad library file content.
     * @param {string} content - Raw `.kicad_sym` content
     * @param {string} symbolName
     * @returns {string} Footprint reference or empty string
     */
export function _extractFootprintFromContent(fetcher, content, symbolName) {
    if (!content || !symbolName) return '';

    const cleanName = symbolName.replace(/^"|"$/g, '');
    const symbolToken = `(symbol "${cleanName}"`;
    const idx = content.indexOf(symbolToken);
    if (idx === -1) return '';

    const window = content.slice(idx, idx + 8000);
    const match = window.match(/\(property\s+"Footprint"\s+"([^"]*)"/);
    return match ? match[1] : '';
}

