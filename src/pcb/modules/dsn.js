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
 * @param {number} [opts.traceWidth=0.254]
 * @param {number} [opts.clearance=0.2]
 * @returns {string}
 */
export function exportDSN(opts) {
    const { placements, netlist, traceWidth = 0.254, clearance = 0.2 } = opts;
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
      (shape (circle F.Cu ${u(0.6)}))
      (shape (circle B.Cu ${u(0.6)}))
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
