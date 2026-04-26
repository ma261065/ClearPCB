/**
 * ClearPCB Specctra DSN export & SES import
 *
 * DSN (Design) — exports board outline, layers, padstacks, components,
 *   pad positions and netlist so an external router (e.g. Freerouting)
 *   can route the board.
 *
 * SES (Session) — imports routed wires back from the external router
 *   and returns them as trace arrays for rendering.
 */

// ── DSN Export ────────────────────────────────────────────────────

/**
 * Build a Specctra DSN string from current board state.
 *
 * @param {object} opts
 * @param {Map<string, object>} opts.placements  - componentId → { x, y, reference, padOffsets }
 * @param {Array<{net: string, pins: Array<{componentId: string, pinNumber: string}>}>} opts.netlist
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} [opts.bounds]
 * @param {number} opts.traceWidth - required, mm
 * @param {number} opts.clearance - required, mm
 * @param {number} opts.viaDiameter - required, mm
 * @returns {string}
 */
export function exportDSN(opts) {
    const { placements, netlist, traceWidth, clearance, viaDiameter } = opts;
    if (typeof traceWidth !== 'number' || !Number.isFinite(traceWidth) || traceWidth <= 0) {
        throw new Error(`exportDSN: opts.traceWidth must be a positive number, got ${traceWidth}`);
    }
    if (typeof clearance !== 'number' || !Number.isFinite(clearance) || clearance <= 0) {
        throw new Error(`exportDSN: opts.clearance must be a positive number, got ${clearance}`);
    }
    if (typeof viaDiameter !== 'number' || !Number.isFinite(viaDiameter) || viaDiameter <= 0) {
        throw new Error(`exportDSN: opts.viaDiameter must be a positive number, got ${viaDiameter}`);
    }
    const resolution = 1000; // units per mm (microns)

    // Convert mm to DSN resolution units
    const u = (mm) => Math.round(mm * resolution);

    // Compute board boundary from placements
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [, pl] of placements) {
        for (const off of (pl.padOffsets || [])) {
            const px = pl.x + off.dx;
            const py = pl.y + off.dy;
            const hw = (off.width || 1) / 2 + 2;
            const hh = (off.height || 1) / 2 + 2;
            minX = Math.min(minX, px - hw);
            minY = Math.min(minY, py - hh);
            maxX = Math.max(maxX, px + hw);
            maxY = Math.max(maxY, py + hh);
        }
    }
    if (opts.bounds) {
        minX = Math.min(minX, opts.bounds.minX);
        minY = Math.min(minY, opts.bounds.minY);
        maxX = Math.max(maxX, opts.bounds.maxX);
        maxY = Math.max(maxY, opts.bounds.maxY);
    }

    // Collect unique padstacks and build image (footprint) definitions
    const padstacks = new Map(); // key → { w, h, shape, name }
    const images = new Map();    // reference → image def string

    const padstackName = (w, h, shape) => {
        const key = `${shape}_${u(w)}x${u(h)}`;
        if (!padstacks.has(key)) {
            padstacks.set(key, { w, h, shape, name: key });
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

        if (!images.has(imageName)) {
            const pinDefs = [];
            for (const off of (pl.padOffsets || [])) {
                const psName = padstackName(off.width || 1, off.height || 1, 'rect');
                pinDefs.push(`      (pin ${psName} ${off.number} ${u(off.dx)} ${u(-off.dy)})`);
            }
            const imgDef = `    (image ${imageName}\n${pinDefs.join('\n')}\n    )`;
            imageDefs.push(imgDef);
            images.set(imageName, true);
        }

        placementDefs.push(
            `    (component ${imageName}\n` +
            `      (place ${ref} ${u(pl.x)} ${u(-pl.y)} front 0)\n` +
            `    )`
        );
    }

    // Build padstack definitions
    const padstackDefs = [];
    for (const [, ps] of padstacks) {
        const hw = u(ps.w / 2), hh = u(ps.h / 2);
        padstackDefs.push(
            `    (padstack ${ps.name}\n` +
            `      (shape (rect F.Cu ${-hw} ${-hh} ${hw} ${hh}))\n` +
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
          `      (rule (width ${u(traceWidth)}) (clearance ${u(clearance)}))\n` +
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
    (rule (width ${u(traceWidth)}) (clearance ${u(clearance)}))
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
 *   routeInput: import('./autorouter.js').RouteInput,
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
    const resolution = parseFloat(resNode?.[2]) || 1000;
    const toMM = (v) => {
        const n = parseFloat(v);
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
    const traceWidth = toMM(widthNode[1]);
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
    const padstacks = new Map();
    for (const child of library) {
        if (!Array.isArray(child) || child[0] !== 'padstack') continue;
        const name = child[1];
        let width = 1.0;
        let height = 1.0;
        let layer = 'both';
        for (const n of child) {
            if (!Array.isArray(n) || n[0] !== 'shape') continue;
            // (shape (rect F.Cu x1 y1 x2 y2)) or (shape (circle F.Cu dia))
            const shape = n[1];
            if (!Array.isArray(shape)) continue;
            if (shape[0] === 'rect' && shape.length >= 6) {
                const sx1 = toMM(shape[2]);
                const sy1 = toMM(shape[3]);
                const sx2 = toMM(shape[4]);
                const sy2 = toMM(shape[5]);
                width = Math.abs(sx2 - sx1);
                height = Math.abs(sy2 - sy1);
                layer = shape[1] === 'B.Cu' ? 'bottom' : shape[1] === 'F.Cu' ? 'top' : 'both';
                break;
            }
            if (shape[0] === 'circle' && shape.length >= 3) {
                const dia = toMM(shape[2]);
                width = dia;
                height = dia;
                layer = shape[1] === 'B.Cu' ? 'bottom' : shape[1] === 'F.Cu' ? 'top' : 'both';
            }
        }
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
    const components = new Map();
    for (const compNode of placement) {
        if (!Array.isArray(compNode) || compNode[0] !== 'component') continue;
        const imageName = compNode[1];
        for (const placeNode of compNode) {
            if (!Array.isArray(placeNode) || placeNode[0] !== 'place' || placeNode.length < 5) continue;
            const ref = String(placeNode[1]);
            const x = toMM(placeNode[2]);
            const y = -toMM(placeNode[3]);
            components.set(ref, { imageName, x, y });
        }
    }

    const padByRefPin = new Map();
    const allObstaclePads = [];
    for (const [ref, comp] of components.entries()) {
        const imgPins = images.get(comp.imageName);
        if (!imgPins) continue;
        for (const [pinNumber, pinDef] of imgPins.entries()) {
            const ps = padstacks.get(pinDef.padstackName) || { width: 1.0, height: 1.0, layer: 'both' };
            const padX = comp.x + pinDef.dx;
            const padY = comp.y - pinDef.dy;
            const pad = {
                x: padX,
                y: padY,
                width: ps.width,
                height: ps.height,
                layer: ps.layer,
            };
            padByRefPin.set(`${ref}:${pinNumber}`, pad);
            allObstaclePads.push(pad);
        }
    }

    // Parse nets -> pins list to RouteInput connections
    const connections = [];
    for (const netNode of network) {
        if (!Array.isArray(netNode) || netNode[0] !== 'net' || netNode.length < 2) continue;
        const netName = _unquote(String(netNode[1]));
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
            traceWidth,
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
 */
function _q(name) {
    if (/^[A-Za-z0-9_.+\-/]+$/.test(name)) return name;
    return `"${name.replace(/"/g, '""')}"`;
}

// ── SES Import ────────────────────────────────────────────────────

/**
 * Parse a Specctra SES (session) file and extract routed wires.
 *
 * @param {string} sesText - contents of the .ses file
 * @param {number} resolution - DSN resolution (units per mm), default 1000
 * @returns {{ traces: Array<{net: string, points: Array<{x: number, y: number}>, layer: string}>, vias: Array<{net: string, x: number, y: number}> }}
 */
export function importSES(sesText, resolution = 1000) {
    const traces = [];
    const tree = _parseSExp(sesText);
    if (!tree) { console.warn('[SES] Failed to parse S-expression'); return { traces, vias: [] }; }

    // Find (routes ...) → (network_out ...) → (net ...) → (wire ...)
    const session = Array.isArray(tree) ? tree : [tree];
    const routes = _findNode(session, 'routes');
    if (!routes) { console.warn('[SES] No (routes) node found'); return { traces, vias: [] }; }

    // Parse resolution — handles (resolution mm 1000) or (resolution um 10) etc.
    let toMM = 1 / resolution; // default: assume mm with given resolution
    const resNode = _findNode(routes, 'resolution');
    if (resNode && resNode.length >= 3) {
        const unit = resNode[1];
        const res = parseFloat(resNode[2]) || resolution;
        if (unit === 'um') {
            toMM = 1 / (res * 1000);       // e.g. (resolution um 10) → 0.1um → /10000
        } else if (unit === 'mil') {
            toMM = 0.0254 / res;
        } else {
            toMM = 1 / res;                 // mm
        }
        console.log(`[SES] Resolution: ${unit} ${res} → toMM=${toMM}`);
    }

    const fromU = (v) => parseFloat(v) * toMM;

    const networkOut = _findNode(routes, 'network_out');
    if (!networkOut) { console.warn('[SES] No (network_out) node found'); return { traces, vias: [] }; }

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
                    // Expected trace width ~0.1-0.5mm; find the right power of 10
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

    const fromUCorrected = (v) => parseFloat(v) * toMM;

    /** @type {Array<{net: string, x: number, y: number}>} */
    const vias = [];

    for (const child of networkOut) {
        if (!Array.isArray(child) || child[0] !== 'net') continue;
        const netName = _unquote(child[1]);

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
                    traces.push({ net: netName, points, layer });
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

    console.log(`[SES] Imported ${traces.length} trace segments, ${vias.length} vias`);
    return { traces, vias };
}

/**
 * Remove surrounding quotes from a DSN/SES string token.
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
 */
function _parseSExp(text) {
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
    const stack = [[]];
    for (const tok of tokens) {
        if (tok === '(') {
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

function _findDirectNode(tree, name) {
    if (!Array.isArray(tree)) return null;
    for (const child of tree) {
        if (Array.isArray(child) && child[0] === name) return child;
    }
    return null;
}
