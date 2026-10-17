/**
 * ClearPCB Specctra DSN export & SES import
 *
 * DSN (Design) — exports board outline, layers, padstacks, components,
 *   pad positions and netlist so an external router (e.g. Freerouting)
 *   can route the board.
 *
 * SES (Session) — imports routed wires back from the external router
 *   and returns them as track arrays for rendering.
 */

// ── DSN Export ────────────────────────────────────────────────────

import { placementPose } from '../../shared/pcb/board-geometry.js';
/** @typedef {import('../../shapes/track.js').Point} Point */
/** @typedef {{dx: number, dy: number, width?: number, height?: number, number: string|number, layer?: string, _baseLayer?: string, shape?: string}} DsnPadOffset */
/** @typedef {{x: number, y: number, rotation?: number, mirror?: boolean, side?: string, reference?: string, padOffsets?: DsnPadOffset[]}} DsnPlacement */
/** @typedef {{componentId: string, pinNumber: string}} DsnNetPin */
/** @typedef {{net: string, pins: DsnNetPin[]}} DsnNet */
/** @typedef {{minX: number, minY: number, maxX: number, maxY: number}} DsnBounds */
/** @typedef {{placements: Map<string, DsnPlacement>, netlist: DsnNet[], bounds?: DsnBounds, trackWidth: number, clearance: number, viaDiameter: number}} ExportDsnOptions */
/** @typedef {{width: number, height: number, layer: 'top'|'bottom'|'both'}} DsnPadstack */
/** @typedef {{padstackName: string, dx: number, dy: number}} DsnPinDef */
/** @typedef {{imageName: string, x: number, y: number, rotation: number, back: boolean}} DsnComponent */
/** @typedef {{x: number, y: number, width: number, height: number, layer: 'top'|'bottom'|'both'}} DsnPad */

/** @param {string|undefined} layer @returns {'top'|'bottom'|'both'} */
const dsnPadLayer = layer => layer === 'bottom' ? 'bottom' : layer === 'top' ? 'top' : 'both';
/** @param {string|undefined} layer */
const flipPadLayer = layer => layer === 'top' ? 'bottom' : layer === 'bottom' ? 'top' : layer;

/**
 * ClearPCB poses a footprint as mirror-x (when `mirror` XOR bottom side), then a
 * clockwise-on-screen rotation in Y-down board space. Specctra (as read by
 * Freerouting's default flip style) mirrors x only for `back` parts, flips their
 * pad layers itself, then rotates counter-clockwise in Y-up space. So the DSN
 * rotation is the negated angle, bottom parts are `back`, and only a user
 * `mirror` flag needs mirroring baked into the per-component image.
 * @param {DsnPlacement} pl
 */
export function dsnPlacementPose(pl) {
    const rotation = ((-(pl.rotation || 0) % 360) + 360) % 360;
    return {
        rotation: Math.round(rotation * 1000) / 1000 % 360,
        back: pl.side === 'bottom',
        imageMirror: !!pl.mirror,
    };
}

/**
 * Build a Specctra DSN string from current board state.
 *
 * @param {ExportDsnOptions} opts
 * @returns {string}
 */
export function exportDSN(opts) {
    const { placements, netlist, trackWidth, clearance, viaDiameter } = opts;
    if (typeof trackWidth !== 'number' || !Number.isFinite(trackWidth) || trackWidth <= 0) {
        throw new Error(`exportDSN: opts.trackWidth must be a positive number, got ${trackWidth}`);
    }
    if (typeof clearance !== 'number' || !Number.isFinite(clearance) || clearance <= 0) {
        throw new Error(`exportDSN: opts.clearance must be a positive number, got ${clearance}`);
    }
    if (typeof viaDiameter !== 'number' || !Number.isFinite(viaDiameter) || viaDiameter <= 0) {
        throw new Error(`exportDSN: opts.viaDiameter must be a positive number, got ${viaDiameter}`);
    }
    const resolution = 1000; // units per mm (microns)

    // Convert mm to DSN resolution units
    /** @param {number} mm */
    const u = (mm) => Math.round(mm * resolution);

    // Compute board boundary from posed pad positions
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [, pl] of placements) {
        const pose = placementPose(pl);
        for (const off of (pl.padOffsets || [])) {
            const { x: px, y: py } = pose.xf(off.dx, off.dy);
            const r = Math.max(off.width || 1, off.height || 1) / 2 + 2;
            minX = Math.min(minX, px - r);
            minY = Math.min(minY, py - r);
            maxX = Math.max(maxX, px + r);
            maxY = Math.max(maxY, py + r);
        }
    }
    if (opts.bounds) {
        minX = Math.min(minX, opts.bounds.minX);
        minY = Math.min(minY, opts.bounds.minY);
        maxX = Math.max(maxX, opts.bounds.maxX);
        maxY = Math.max(maxY, opts.bounds.maxY);
    }

    // Collect unique padstacks and build image (footprint) definitions
    const padstacks = new Map(); // key → { w, h, shape, layer, name }
    const images = new Map();    // reference → image def string

    /**
     * @param {number} w
     * @param {number} h
     * @param {string} shape
     * @param {'top'|'bottom'|'both'} layer
     */
    const padstackName = (w, h, shape, layer) => {
        const key = `${shape}_${u(w)}x${u(h)}_${layer}`;
        if (!padstacks.has(key)) {
            padstacks.set(key, { w, h, shape, layer, name: key });
        }
        return key;
    };

    // Build component images and placements
    const imageDefs = [];
    const placementDefs = [];
    const compImageMap = new Map(); // componentId → image name

    for (const [compId, pl] of placements) {
        const ref = pl.reference || compId;
        const imageName = `img_${ref}`;
        compImageMap.set(compId, imageName);
        const pose = dsnPlacementPose(pl);

        if (!images.has(imageName)) {
            const pinDefs = [];
            for (const off of (pl.padOffsets || [])) {
                // Freerouting flips back-side pad layers itself, so the image keeps the footprint's own side.
                const baseLayer = off._baseLayer ?? (pose.back ? flipPadLayer(off.layer) : off.layer);
                const psName = padstackName(off.width || 1, off.height || 1, off.shape || 'rect', dsnPadLayer(baseLayer));
                const dx = pose.imageMirror ? -off.dx : off.dx;
                pinDefs.push(`      (pin ${psName} ${off.number} ${u(dx)} ${u(-off.dy)})`);
            }
            const imgDef = `    (image ${imageName}\n${pinDefs.join('\n')}\n    )`;
            imageDefs.push(imgDef);
            images.set(imageName, true);
        }

        placementDefs.push(
            `    (component ${imageName}\n` +
            `      (place ${ref} ${u(pl.x)} ${u(-pl.y)} ${pose.back ? 'back' : 'front'} ${pose.rotation})\n` +
            `    )`
        );
    }

    // Build padstack definitions
    const padstackDefs = [];
    for (const [, ps] of padstacks) {
        const layers = ps.layer === 'both' ? ['F.Cu', 'B.Cu'] : [ps.layer === 'bottom' ? 'B.Cu' : 'F.Cu'];
        padstackDefs.push(
            `    (padstack ${ps.name}\n` +
            layers.map(layer => `      (shape ${_padShape(ps, layer, u)})\n`).join('') +
            `      (attach off)\n` +
            `    )`
        );
    }

    // Build net definitions
    const netDefs = [];
    for (const entry of netlist) {
        const pins = [];
        for (const pin of entry.pins) {
            const pl = placements.get(pin.componentId);
            if (!pl) continue;
            const ref = pl.reference || pin.componentId;
            pins.push(`${ref}-${pin.pinNumber}`);
        }
        if (pins.length >= 2) {
            netDefs.push(`    (net ${_q(entry.net)}\n      (pins ${pins.join(' ')})\n    )`);
        }
    }

    // Build class definition (all nets in one class)
    const allNetNames = netlist.filter(e => e.pins.length >= 2).map(e => _q(e.net));
    const classDef = allNetNames.length
        ? `    (class default ${allNetNames.join(' ')}\n` +
          `      (circuit (use_via via_default))\n` +
          `      (rule (width ${u(trackWidth)}) (clearance ${u(clearance)}))\n` +
          `    )`
        : '';

    // Assemble DSN
    const dsn = `(pcb ClearPCB.dsn
  (parser
    (string_quote ")
    (space_in_quoted_tokens on)
    (host_cad ClearPCB)
    (host_version 1.0)
  )
  (resolution mm ${resolution})
  (unit mm)
  (structure
    (layer F.Cu (type signal))
    (layer B.Cu (type signal))
    (boundary
      (path signal 0 ${u(minX)} ${u(-minY)} ${u(maxX)} ${u(-minY)} ${u(maxX)} ${u(-maxY)} ${u(minX)} ${u(-maxY)} ${u(minX)} ${u(-minY)})
    )
    (via via_default)
    (rule (width ${u(trackWidth)}) (clearance ${u(clearance)}))
  )
  (placement
${placementDefs.join('\n')}
  )
  (library
${padstackDefs.join('\n')}
${imageDefs.join('\n')}
    (padstack via_default
      (shape (circle F.Cu ${u(viaDiameter)}))
      (shape (circle B.Cu ${u(viaDiameter)}))
      (attach off)
    )
  )
  (network
${netDefs.join('\n')}
${classDef}
  )
  (wiring
  )
)
`;
    return dsn;
}

/**
 * Parse a Specctra DSN and convert it into ClearPCB RouteInput.
 * Designed primarily for DSN files produced by exportDSN().
 *
 * @param {string} dsnText
 * @returns {{
 *   routeInput: import('./autorouter-common.js').RouteInput,
 *   meta: {
 *     resolution: number,
 *     unit: string,
 *     nets: number,
 *     pads: number,
 *   }
 * }}
 */
export function importDSN(dsnText) {
    const tree = _parseSExp(dsnText);
    if (!tree || !Array.isArray(tree)) {
        throw new Error('Invalid DSN: failed to parse S-expression');
    }

    const pcb = Array.isArray(tree) && tree[0] === 'pcb' ? tree : _findNode(tree, 'pcb');
    if (!pcb) throw new Error('Invalid DSN: missing (pcb ...) root');

    const resNode = _findNode(pcb, 'resolution');
    const resUnit = resNode?.[1] || 'mm';
    let resolution = parseFloat(resNode?.[2]);
    if (!Number.isFinite(resolution) || resolution <= 0) resolution = 1000;
    /** @param {unknown} v */
    const toMM = (v) => {
        const n = parseFloat(String(v));
        if (!Number.isFinite(n)) return 0;
        if (resUnit === 'mil') return (n / resolution) * 0.0254;
        if (resUnit === 'um') return (n / resolution) / 1000;
        return n / resolution;
    };

    const structure = _findNode(pcb, 'structure');
    const network = _findNode(pcb, 'network');
    const placement = _findNode(pcb, 'placement');
    const library = _findNode(pcb, 'library');
    if (!structure || !network || !placement || !library) {
        throw new Error('Invalid DSN: missing one or more required sections (structure/network/placement/library)');
    }

    // Extract rules. DSN format requires (rule (width ...) (clearance ...))
    // inside (structure ...). Refuse to silently substitute defaults — bad
    // input should fail loudly so the user can fix the source.
    const structureRule = _findDirectNode(structure, 'rule');
    const widthNode = _findDirectNode(structureRule, 'width');
    const clearanceNode = _findDirectNode(structureRule, 'clearance');
    if (!widthNode || widthNode[1] == null) {
        throw new Error('Invalid DSN: missing (rule (width ...)) inside (structure ...)');
    }
    if (!clearanceNode || clearanceNode[1] == null) {
        throw new Error('Invalid DSN: missing (rule (clearance ...)) inside (structure ...)');
    }
    const trackWidth = toMM(widthNode[1]);
    const clearance = toMM(clearanceNode[1]);

    // Parse board bounds from boundary path
    let bounds = null;
    const boundaryNode = _findDirectNode(structure, 'boundary');
    const pathNode = _findDirectNode(boundaryNode, 'path');
    if (pathNode && pathNode.length >= 7) {
        const coords = pathNode.slice(3);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < coords.length - 1; i += 2) {
            const x = toMM(coords[i]);
            const y = -toMM(coords[i + 1]);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
        if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
            bounds = { minX, minY, maxX, maxY };
        }
    }

    // Parse padstacks from library
    /** @type {Map<string, DsnPadstack>} */
    const padstacks = new Map();
    for (const child of library) {
        if (!Array.isArray(child) || child[0] !== 'padstack') continue;
        const name = child[1];
        let width = 1.0;
        let height = 1.0;
        let sized = false;
        const layers = new Set();
        for (const n of child) {
            if (!Array.isArray(n) || n[0] !== 'shape') continue;
            // (shape (rect F.Cu x1 y1 x2 y2)), (shape (circle F.Cu dia)),
            // (shape (path F.Cu width x1 y1 x2 y2)) or (shape (polygon F.Cu 0 x y ...))
            const shape = n[1];
            if (!Array.isArray(shape)) continue;
            /** @type {{width: number, height: number}|null} */
            let size = null;
            if (shape[0] === 'rect' && shape.length >= 6) {
                size = { width: Math.abs(toMM(shape[4]) - toMM(shape[2])), height: Math.abs(toMM(shape[5]) - toMM(shape[3])) };
            } else if (shape[0] === 'circle' && shape.length >= 3) {
                const dia = toMM(shape[2]);
                size = { width: dia, height: dia };
            } else if (shape[0] === 'path' && shape.length >= 7) {
                const w = toMM(shape[2]);
                size = { width: Math.abs(toMM(shape[5]) - toMM(shape[3])) + w, height: Math.abs(toMM(shape[6]) - toMM(shape[4])) + w };
            } else if (shape[0] === 'polygon' && shape.length >= 8) {
                const xs = [], ys = [];
                for (let i = 3; i + 1 < shape.length; i += 2) { xs.push(toMM(shape[i])); ys.push(toMM(shape[i + 1])); }
                size = { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
            }
            if (!size) continue;
            layers.add(shape[1]);
            if (!sized) ({ width, height } = size);
            sized = true;
        }
        /** @type {'top'|'bottom'|'both'} */
        const layer = layers.size === 1 && layers.has('F.Cu') ? 'top'
            : layers.size === 1 && layers.has('B.Cu') ? 'bottom' : 'both';
        padstacks.set(name, { width, height, layer });
    }

    // Resolve via diameter from the padstack referenced by (via NAME) in structure.
    // DSN files written by ClearPCB use 'via_default'; foreign DSN may use any name.
    const viaRefNode = _findDirectNode(structure, 'via');
    const viaPadstackName = viaRefNode && viaRefNode[1] != null ? String(viaRefNode[1]) : null;
    const viaPadstack = viaPadstackName ? padstacks.get(viaPadstackName) : null;
    if (!viaPadstack) {
        throw new Error(`Invalid DSN: missing or unresolved (via ${viaPadstackName ?? '?'}) padstack reference`);
    }
    // Vias are circular — width === height for a (circle ...) shape.
    const viaDiameter = viaPadstack.width;
    if (!Number.isFinite(viaDiameter) || viaDiameter <= 0) {
        throw new Error(`Invalid DSN: via padstack '${viaPadstackName}' has invalid diameter ${viaDiameter}`);
    }

    // Parse images -> pin offsets and padstack refs
    /** @type {Map<string, Map<string, DsnPinDef>>} */
    const images = new Map();
    for (const child of library) {
        if (!Array.isArray(child) || child[0] !== 'image') continue;
        const imageName = child[1];
        const pins = new Map();
        for (const n of child) {
            if (!Array.isArray(n) || n[0] !== 'pin' || n.length < 5) continue;
            const padstackName = n[1];
            const pinNumber = String(n[2]);
            const dx = toMM(n[3]);
            const dy = toMM(n[4]);
            pins.set(pinNumber, { padstackName, dx, dy });
        }
        images.set(imageName, pins);
    }

    // Parse placements -> component reference world location + image mapping
    /** @type {Map<string, DsnComponent>} */
    const components = new Map();
    for (const compNode of placement) {
        if (!Array.isArray(compNode) || compNode[0] !== 'component') continue;
        const imageName = compNode[1];
        for (const placeNode of compNode) {
            if (!Array.isArray(placeNode) || placeNode[0] !== 'place' || placeNode.length < 5) continue;
            const ref = String(placeNode[1]);
            const x = toMM(placeNode[2]);
            const y = -toMM(placeNode[3]);
            const back = placeNode[4] === 'back';
            const rotation = parseFloat(placeNode[5]) || 0;
            components.set(ref, { imageName, x, y, rotation, back });
        }
    }

    /** @type {Map<string, DsnPad>} */
    const padByRefPin = new Map();
    /** @type {DsnPad[]} */
    const allObstaclePads = [];
    for (const [ref, comp] of components.entries()) {
        const imgPins = images.get(comp.imageName);
        if (!imgPins) continue;
        // Freerouting's default flip style: mirror x for back parts, then rotate CCW (Y-up).
        const rad = comp.rotation * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const quarterTurn = Math.abs(sin) > Math.SQRT1_2;
        for (const [pinNumber, pinDef] of imgPins.entries()) {
            const ps = padstacks.get(pinDef.padstackName) || { width: 1.0, height: 1.0, layer: 'both' };
            const lx = comp.back ? -pinDef.dx : pinDef.dx;
            const pad = {
                x: comp.x + lx * cos - pinDef.dy * sin,
                y: comp.y - (lx * sin + pinDef.dy * cos),
                width: quarterTurn ? ps.height : ps.width,
                height: quarterTurn ? ps.width : ps.height,
                layer: comp.back ? /** @type {'top'|'bottom'|'both'} */ (flipPadLayer(ps.layer)) : ps.layer,
            };
            padByRefPin.set(`${ref}:${pinNumber}`, pad);
            allObstaclePads.push(pad);
        }
    }

    // Parse nets -> pins list to RouteInput connections
    /** @type {Array<{net: string, pads: DsnPad[]}>} */
    const connections = [];
    for (const netNode of network) {
        if (!Array.isArray(netNode) || netNode[0] !== 'net' || netNode.length < 2) continue;
        const netName = String(_unquote(String(netNode[1])));
        const pinsNode = _findDirectNode(netNode, 'pins');
        if (!pinsNode || pinsNode.length < 3) continue;

        const pads = [];
        const pinTokens = pinsNode.slice(1).map(String);
        for (const tok of pinTokens) {
            const splitIdx = tok.lastIndexOf('-');
            if (splitIdx <= 0 || splitIdx >= tok.length - 1) continue;
            const ref = tok.slice(0, splitIdx);
            const pinNumber = tok.slice(splitIdx + 1);
            const pad = padByRefPin.get(`${ref}:${pinNumber}`);
            if (pad) pads.push({ ...pad });
        }
        if (pads.length >= 2) connections.push({ net: netName, pads });
    }

    if (!bounds) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of allObstaclePads) {
            minX = Math.min(minX, p.x - p.width);
            minY = Math.min(minY, p.y - p.height);
            maxX = Math.max(maxX, p.x + p.width);
            maxY = Math.max(maxY, p.y + p.height);
        }
        if (Number.isFinite(minX) && Number.isFinite(minY)) bounds = { minX, minY, maxX, maxY };
        else bounds = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    }

    return {
        routeInput: {
            connections,
            allObstaclePads,
            trackWidth,
            clearance,
            viaDiameter,
            gridStep: 0.5,
            bounds,
        },
        meta: {
            resolution,
            unit: resUnit,
            nets: connections.length,
            pads: allObstaclePads.length,
        },
    };
}

/**
 * Quote a net name for DSN if it contains special characters.
 * @param {string} name
 */
function _q(name) {
    if (/^[A-Za-z0-9_.+\-/]+$/.test(name)) return name;
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * One copper layer's Specctra shape for a pad, centred on the pin, in image (Y-up) units.
 * Stadium pads are a round-ended path; ellipses are approximated by a 24-gon.
 * @param {{w: number, h: number, shape: string}} ps
 * @param {string} layer
 * @param {(mm: number) => number} u
 */
function _padShape(ps, layer, u) {
    const hw = ps.w / 2, hh = ps.h / 2;
    if (Math.abs(hw - hh) < 1e-9 && ps.shape !== 'rect') {
        return `(circle ${layer} ${u(ps.w)})`;
    }
    if (ps.shape === 'stadium') {
        const r = Math.min(hw, hh);
        const ex = hw - r, ey = hh - r;
        return `(path ${layer} ${u(2 * r)} ${u(-ex)} ${u(-ey)} ${u(ex)} ${u(ey)})`;
    }
    if (ps.shape === 'oval' || ps.shape === 'round') {
        const points = [];
        for (let i = 0; i < 24; i++) {
            const a = (i / 24) * 2 * Math.PI;
            points.push(u(hw * Math.cos(a)), u(hh * Math.sin(a)));
        }
        return `(polygon ${layer} 0 ${points.join(' ')})`;
    }
    return `(rect ${layer} ${u(-hw)} ${u(-hh)} ${u(hw)} ${u(hh)})`;
}

// ── SES Import ────────────────────────────────────────────────────

/**
 * Parse a Specctra SES (session) file and extract routed wires.
 *
 * @param {string} sesText - contents of the .ses file
 * @param {number} resolution - DSN resolution (units per mm), default 1000
 * @returns {{ tracks: Array<{net: string, points: Array<{x: number, y: number}>, layer: string}>, vias: Array<{net: string, x: number, y: number}> }}
 */
export function importSES(sesText, resolution = 1000) {
    /** @type {Array<{net: string, points: Point[], layer: string}>} */
    const tracks = [];
    const tree = _parseSExp(sesText);
    if (!tree) { console.warn('[SES] Failed to parse S-expression'); return { tracks, vias: [] }; }

    // Find (routes ...) → (network_out ...) → (net ...) → (wire ...)
    const session = Array.isArray(tree) ? tree : [tree];
    const routes = _findNode(session, 'routes');
    if (!routes) { console.warn('[SES] No (routes) node found'); return { tracks, vias: [] }; }

    // Parse resolution — handles (resolution mm 1000) or (resolution um 10) etc.
    let toMM = 1 / resolution; // default: assume mm with given resolution
    const resNode = _findNode(routes, 'resolution');
    if (resNode && resNode.length >= 3) {
        const unit = resNode[1];
        let res = parseFloat(resNode[2]);
        if (!Number.isFinite(res) || res <= 0) res = resolution;
        if (unit === 'um') {
            toMM = 1 / (res * 1000);       // e.g. (resolution um 10) → 0.1um → /10000
        } else if (unit === 'mil') {
            toMM = 0.0254 / res;
        } else {
            toMM = 1 / res;                 // mm
        }
        console.log(`[SES] Resolution: ${unit} ${res} → toMM=${toMM}`);
    }

    /** @param {unknown} v */
    const fromU = (v) => parseFloat(String(v)) * toMM;

    const networkOut = _findNode(routes, 'network_out');
    if (!networkOut) { console.warn('[SES] No (network_out) node found'); return { tracks, vias: [] }; }

    // Auto-detect actual scale: check first wire's width field.
    // Freerouting often outputs in nm regardless of declared resolution.
    // If path width / declared_res > 5mm, the coordinates are finer-grained.
    let scaleCorrection = 1;
    for (const child of networkOut) {
        if (!Array.isArray(child) || child[0] !== 'net') continue;
        for (const w of child) {
            if (!Array.isArray(w) || w[0] !== 'wire') continue;
            const pn = w.find(n => Array.isArray(n) && n[0] === 'path');
            if (pn && pn.length >= 4) {
                const rawWidth = parseFloat(pn[2]);
                const widthMM = rawWidth * toMM;
                if (widthMM > 1) {
                    // Width seems way too big — auto-correct
                    // Expected track width ~0.1-0.5mm; find the right power of 10
                    scaleCorrection = 1;
                    while (rawWidth * toMM * scaleCorrection > 1) scaleCorrection /= 10;
                    toMM *= scaleCorrection;
                    console.log(`[SES] Auto-corrected scale: width=${rawWidth} → ${(rawWidth * toMM).toFixed(4)}mm, toMM=${toMM}`);
                }
            }
            break;
        }
        break;
    }

    /** @param {unknown} v */
    const fromUCorrected = (v) => parseFloat(String(v)) * toMM;

    /** @type {Array<{net: string, x: number, y: number}>} */
    const vias = [];

    for (const child of networkOut) {
        if (!Array.isArray(child) || child[0] !== 'net') continue;
        const netName = String(_unquote(child[1]));

        for (const wireOrVia of child) {
            if (!Array.isArray(wireOrVia)) continue;

            if (wireOrVia[0] === 'wire') {
                // (wire (path F.Cu <width> x1 y1 x2 y2 ...) ...)
                const pathNode = wireOrVia.find(n => Array.isArray(n) && n[0] === 'path');
                if (!pathNode) continue;

                const layerName = pathNode[1];
                const layer = layerName === 'B.Cu' ? 'bottom' : 'top';
                const coords = pathNode.slice(3);
                const points = [];
                for (let i = 0; i < coords.length - 1; i += 2) {
                    points.push({
                        x: fromUCorrected(coords[i]),
                        y: -fromUCorrected(coords[i + 1]),
                    });
                }
                if (points.length >= 2) {
                    tracks.push({ net: netName, points, layer });
                }
            } else if (wireOrVia[0] === 'via') {
                // (via via_default x y) or (via padstack_name x y ...)
                if (wireOrVia.length >= 4) {
                    const vx = fromUCorrected(wireOrVia[2]);
                    const vy = -fromUCorrected(wireOrVia[3]);
                    vias.push({ net: netName, x: vx, y: vy });
                }
            }
        }
    }

    console.log(`[SES] Imported ${tracks.length} track segments, ${vias.length} vias`);
    return { tracks, vias };
}

/**
 * Remove surrounding quotes from a DSN/SES string token.
 * @param {unknown} s
 * @returns {unknown}
 */
function _unquote(s) {
    if (typeof s === 'string' && s.startsWith('"') && s.endsWith('"')) {
        return s.slice(1, -1).replace(/""/g, '"');
    }
    return s;
}

// ── S-expression parser ───────────────────────────────────────────

/**
 * Minimal S-expression parser for DSN/SES files.
 * Returns nested arrays: (a b (c d)) → ['a', 'b', ['c', 'd']]
 * @param {string} text
 * @returns {any[]} Dynamic DSN S-expression leaves are strings or nested lists from external files.
 */
function _parseSExp(text) {
    /** @type {string[]} */
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '(' || ch === ')') {
            tokens.push(ch);
            i++;
        } else if (ch === '"') {
            // DSN can encode string_quote as a bare quote token: (string_quote ")
            // Handle that form before parsing regular quoted strings.
            if (i + 1 >= text.length || /[\s)]/.test(text[i + 1])) {
                tokens.push('"');
                i++;
                continue;
            }

            // Quoted string — "" is escaped quote
            let str = '';
            i++;
            while (i < text.length) {
                if (text[i] === '"') {
                    if (text[i + 1] === '"') { str += '"'; i += 2; }
                    else { i++; break; }
                } else {
                    str += text[i++];
                }
            }
            tokens.push(str);
        } else if (/\s/.test(ch)) {
            i++;
        } else {
            let tok = '';
            while (i < text.length && !/[\s()]/.test(text[i]) && text[i] !== '"') {
                tok += text[i++];
            }
            tokens.push(tok);
        }
    }

    // Build tree
    /** @type {any[][]} Dynamic DSN S-expression stack; leaves and nested lists are validated by readers. */
    const stack = [[]];
    for (const tok of tokens) {
        if (tok === '(') {
            /** @type {any[]} Dynamic DSN S-expression node; readers validate expected leaves. */
            const node = [];
            stack[stack.length - 1].push(node);
            stack.push(node);
        } else if (tok === ')') {
            if (stack.length > 1) stack.pop();
        } else {
            stack[stack.length - 1].push(tok);
        }
    }
    return stack[0].length === 1 ? stack[0][0] : stack[0];
}

/**
 * Find a named node in an S-expression tree.
 * @param {any[]|null|undefined} tree Dynamic DSN S-expression tree; callers validate named node contents.
 * @param {string} name
 * @returns {any[]|null}
 */
function _findNode(tree, name) {
    if (!Array.isArray(tree)) return null;
    if (tree[0] === name) return tree;
    for (const child of tree) {
        if (Array.isArray(child)) {
            const found = _findNode(child, name);
            if (found) return found;
        }
    }
    return null;
}

/**
 * @param {any[]|null|undefined} tree Dynamic DSN S-expression tree; callers validate named node contents.
 * @param {string} name
 * @returns {any[]|null}
 */
function _findDirectNode(tree, name) {
    if (!Array.isArray(tree)) return null;
    for (const child of tree) {
        if (Array.isArray(child) && child[0] === name) return child;
    }
    return null;
}
