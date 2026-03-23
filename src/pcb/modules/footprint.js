/**
 * Footprint geometry and rendering for the PCB editor.
 *
 * All components carry real pad data in their `footprintShapes` array
 * (format: "PAD~TYPE~x~y~w~h~padNumber").  This module parses those
 * strings into pad geometry objects and renders them as SVG.
 */

const NS = 'http://www.w3.org/2000/svg';

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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

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
            const w  = parseFloat(parts[4]) * S;
            const h  = parseFloat(parts[5]) * S;

            const num = isEasyEDA
                ? (parts[8] || String(pads.length + 1))
                : (parts[6] || String(pads.length + 1));

            let padLayer = 'top-copper';
            if (isEasyEDA) {
                const layerCode = parseInt(parts[6], 10);
                if (layerCode === 11) padLayer = 'both';            // multi-layer = through-hole
                else if (layerCode === 2) padLayer = 'bottom-copper'; // back SMD
                else if (layerCode === 1) padLayer = 'top-copper';    // front SMD
                else padLayer = 'both';                               // unknown → safer default
            }

            if (!Number.isFinite(cx) || !Number.isFinite(cy) ||
                !Number.isFinite(w)  || !Number.isFinite(h)) continue;

            // PAD field [9] = hole radius (official docs), convert to diameter
            const drillRadius = isEasyEDA && parts.length > 9 ? (parseFloat(parts[9]) || 0) : 0;
            const drill = drillRadius * 2 * S;

            pads.push({
                number: num, x: cx, y: cy, width: w, height: h,
                shape: padType === 'ELLIPSE' ? 'circle' : 'rect',
                drill, layer: padLayer,
            });

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
        // Format: HOLE~cx~cy~diameter~id~locked
        if (shape.startsWith('HOLE~') && isEasyEDA) {
            const parts = shape.split('~');
            if (parts.length < 4) continue;
            const hx = parseFloat(parts[1]) * S;
            const hy = parseFloat(parts[2]) * S;
            const hd = parseFloat(parts[3]) * S;
            if (Number.isFinite(hx) && Number.isFinite(hd) && hd > 0) {
                silks.push({ type: 'circle', cx: hx, cy: hy, r: hd / 2, strokeWidth: 0.15, layer: 'hole' });
                minX = Math.min(minX, hx - hd / 2); minY = Math.min(minY, hy - hd / 2);
                maxX = Math.max(maxX, hx + hd / 2); maxY = Math.max(maxY, hy + hd / 2);
            }
        }
    }

    if (pads.length === 0 && silks.length === 0) {
        return { pads: [], silks: [], outline: null, courtyard: null };
    }

    // Center the footprint at the origin — EasyEDA data uses arbitrary
    // absolute coordinates, so shift everything so the centroid is (0,0).
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    if (Math.abs(centerX) > 0.01 || Math.abs(centerY) > 0.01) {
        for (const pad of pads) {
            pad.x -= centerX;
            pad.y -= centerY;
        }
        for (const s of silks) {
            if (s.type === 'line') { s.x1 -= centerX; s.y1 -= centerY; s.x2 -= centerX; s.y2 -= centerY; }
            else if (s.type === 'circle') { s.cx -= centerX; s.cy -= centerY; }
            else if (s.type === 'path') {
                // Offset path coordinates for centering
                s.d = _offsetPath(s.d, -centerX, -centerY);
            }
        }
        const w = maxX - minX;
        const h = maxY - minY;
        minX = -w / 2;
        minY = -h / 2;
        maxX = w / 2;
        maxY = h / 2;
    }

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
    for (const pad of pads) {
        const copperLayer = pad.layer || 'top-copper';
        const isTop = copperLayer === 'top-copper' || copperLayer === 'both';
        const isBottom = copperLayer === 'bottom-copper' || copperLayer === 'both';
        const sw = 0.1;

        const layers = [];
        if (isTop) layers.push(['top-paste', 0], ['top-mask', MASK_EXPANSION]);
        if (isBottom) layers.push(['bottom-paste', 0], ['bottom-mask', MASK_EXPANSION]);

        for (const entry of layers) {
            const layerId = /** @type {string} */ (entry[0]);
            const exp = /** @type {number} */ (entry[1]);
            if (pad.shape === 'circle') {
                silks.push({ type: 'circle', cx: pad.x, cy: pad.y,
                    r: pad.width / 2 + exp, strokeWidth: sw, layer: layerId, filled: true });
            } else {
                // Filled rectangle as path
                const x1 = pad.x - pad.width / 2 - exp, y1 = pad.y - pad.height / 2 - exp;
                const x2 = pad.x + pad.width / 2 + exp, y2 = pad.y + pad.height / 2 + exp;
                const d = `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2} L ${x1} ${y2} Z`;
                silks.push({ type: 'path', d, strokeWidth: sw, layer: layerId, filled: true });
            }
        }
    }

    return { pads, silks, outline, courtyard };
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

    // Pads → copper layers
    for (const pad of fp.pads) {
        // Determine target layer(s)
        const padLayers = pad.layer === 'both'
            ? ['top-copper', 'bottom-copper']
            : [pad.layer || 'top-copper'];

        for (const layerId of padLayers) {
            const target = getLayer(layerId);
            const padG = document.createElementNS(NS, 'g');
            padG.setAttribute('class', 'pcb-pad');
            padG.setAttribute('data-pad', pad.number);

            const padFill = layerId === 'bottom-copper'
                ? '#3498db'
                : pad.layer === 'both' ? '#b8860b' : '#e74c3c';

            if (pad.shape === 'circle') {
                const c = document.createElementNS(NS, 'circle');
                c.setAttribute('cx', String(pad.x));
                c.setAttribute('cy', String(pad.y));
                c.setAttribute('r', String(pad.width / 2));
                c.setAttribute('fill', padFill);
                c.setAttribute('stroke', 'var(--pcb-pad-outline, #daa520)');
                c.setAttribute('stroke-width', '0.08');
                padG.appendChild(c);
            } else {
                const r = document.createElementNS(NS, 'rect');
                r.setAttribute('x', String(pad.x - pad.width / 2));
                r.setAttribute('y', String(pad.y - pad.height / 2));
                r.setAttribute('width', String(pad.width));
                r.setAttribute('height', String(pad.height));
                r.setAttribute('fill', padFill);
                r.setAttribute('stroke', 'var(--pcb-pad-outline, #daa520)');
                r.setAttribute('stroke-width', '0.08');
                padG.appendChild(r);
            }

            if (pad.drill > 0) {
                const hole = document.createElementNS(NS, 'circle');
                hole.setAttribute('cx', String(pad.x));
                hole.setAttribute('cy', String(pad.y));
                hole.setAttribute('r', String(pad.drill / 2));
                hole.setAttribute('fill', 'var(--pcb-drill, #1a1a2e)');
                padG.appendChild(hole);
            }

            const numText = document.createElementNS(NS, 'text');
            numText.setAttribute('x', String(pad.x));
            numText.setAttribute('y', String(pad.y));
            numText.setAttribute('text-anchor', 'middle');
            numText.setAttribute('dominant-baseline', 'central');
            numText.setAttribute('font-size', '0.7');
            numText.setAttribute('fill', 'var(--pcb-pad-text, #fff)');
            numText.setAttribute('font-family', 'Arial, sans-serif');
            numText.setAttribute('pointer-events', 'none');
            numText.textContent = pad.number;
            padG.appendChild(numText);

            target.appendChild(padG);
        }
    }

    // Reference text → top silk
    const refText = document.createElementNS(NS, 'text');
    const outlineY = fp.outline ? fp.outline.y : -2;
    refText.setAttribute('x', String(fp.outline ? fp.outline.x + fp.outline.width / 2 : 0));
    refText.setAttribute('y', String(outlineY - 0.8));
    refText.setAttribute('text-anchor', 'middle');
    refText.setAttribute('dominant-baseline', 'auto');
    refText.setAttribute('font-size', '1.2');
    refText.setAttribute('fill', '#f0e68c');
    refText.setAttribute('font-family', 'Arial, sans-serif');
    refText.setAttribute('pointer-events', 'none');
    refText.textContent = ref;
    getLayer('top-silk').appendChild(refText);

    return layers;
}
