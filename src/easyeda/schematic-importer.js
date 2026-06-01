/**
 * EasyEDA Schematic Importer
 *
 * Converts an EasyEDA schematic JSON file into ClearPCB's native document
 * format (same shape as serializeDocument produces).
 *
 * Supported EasyEDA shape types:
 *   LIB  – component instances (symbols with pins)
 *   W    – wires
 *   J    – junctions (implicit in ClearPCB's Wire graph)
 *   F    – net flags (GND, VCC, +5V, etc.)
 *   T~L  – net labels on wires
 *   O    – no-connect markers
 */

// EasyEDA uses 10-mil units; multiply by this to get mm.
const SCALE = 0.254;

let _nextId = 1;
function nextShapeId() { return `eda_s${_nextId++}`; }
function nextCompId() { return `eda_c${_nextId++}`; }

/**
 * Main entry point — import an EasyEDA schematic JSON object.
 * @param {object} fileData - Parsed JSON from an EasyEDA .json file
 * @param {object} componentLibrary - ComponentLibrary instance (for EasyEDA symbol parsing)
 * @returns {object} ClearPCB document (same shape as serializeDocument output)
 */
export function importEasyEDASchematic(fileData, componentLibrary) {
    _nextId = 1;

    if (!fileData || !Array.isArray(fileData.schematics) || fileData.schematics.length === 0) {
        throw new Error('Invalid EasyEDA schematic file: no schematics found');
    }

    const schematic = fileData.schematics[0];
    let dataStr;
    if (typeof schematic.dataStr === 'string') {
        try {
            dataStr = JSON.parse(schematic.dataStr);
        } catch (e) {
            throw new Error('Invalid EasyEDA schematic: malformed dataStr JSON (' + (e instanceof Error ? e.message : e) + ')');
        }
    } else {
        dataStr = schematic.dataStr;
    }

    if (!dataStr || !Array.isArray(dataStr.shape)) {
        throw new Error('Invalid EasyEDA schematic: no shape data');
    }

    const shapes = [];
    const components = [];
    const defs = {};

    // ── Sort shapes by type ──────────────────────────────────────
    const libShapes = [];
    const wireShapes = [];
    const junctionShapes = [];
    const flagShapes = [];
    const labelShapes = [];
    const noConnectShapes = [];

    for (const shape of dataStr.shape) {
        if (typeof shape !== 'string') continue;
        const prefix = shape.split('~')[0];
        switch (prefix) {
            case 'LIB': libShapes.push(shape); break;
            case 'W':   wireShapes.push(shape); break;
            case 'J':   junctionShapes.push(shape); break;
            case 'F':   flagShapes.push(shape); break;
            case 'T':   labelShapes.push(shape); break;
            case 'O':   noConnectShapes.push(shape); break;
        }
    }

    // ── Convert components (LIB) ─────────────────────────────────
    for (const lib of libShapes) {
        const result = _convertLIB(lib, componentLibrary);
        if (!result) continue;

        const { component, definition } = result;
        const defName = definition.name;

        // Deduplicate definitions
        if (!defs[defName]) {
            defs[defName] = definition;
        }

        components.push(component);
    }

    // ── Convert wires ────────────────────────────────────────────
    for (const w of wireShapes) {
        const wire = _convertWire(w);
        if (wire) shapes.push(wire);
    }

    // ── Convert net flags (power symbols) ────────────────────────
    for (const f of flagShapes) {
        const net = _convertFlag(f);
        if (net) shapes.push(net);
    }

    // ── Convert net labels (T~L) ─────────────────────────────────
    for (const t of labelShapes) {
        const net = _convertLabel(t);
        if (net) shapes.push(net);
    }

    // ── Convert no-connects ──────────────────────────────────────
    for (const o of noConnectShapes) {
        const nc = _convertNoConnect(o);
        if (nc) shapes.push(nc);
    }

    // ── Build document ───────────────────────────────────────────
    const doc = {
        version: '2.0',
        type: 'clearpcb-project',
        created: new Date().toISOString(),
        schematic: {
            settings: {
                gridSize: 2.54,
                units: 'mm',
                paperSize: null,
                paperOrientation: null,
                titleBlock: false,
                titleBlockInfo: false,
                titleBlockData: {}
            },
            shapes,
            components
        }
    };

    if (Object.keys(defs).length > 0) {
        doc.schematic.defs = defs;
    }

    console.log(`EasyEDA import: ${components.length} components, ${shapes.length} shapes `
        + `(${wireShapes.length} wires, ${flagShapes.length} flags, `
        + `${labelShapes.length} labels, ${noConnectShapes.length} no-connects)`);

    return doc;
}

// ─── LIB (component) conversion ──────────────────────────────────

/**
 * Parse a LIB shape string and return a ClearPCB component + definition.
 */
function _convertLIB(libString, componentLibrary) {
    const segments = libString.split('#@$');
    const header = segments[0].split('~');

    // Header: LIB~x~y~props~?~rotation~id~...
    const rawX = Number(header[1]);
    const rawY = Number(header[2]);
    const propsStr = header[3] || '';
    const rotation = Number(header[5]) || 0;

    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;

    // Parse properties (backtick-delimited key`value pairs)
    const props = _parseProps(propsStr);

    // Skip frame/border shapes
    if (props.package === 'NONE' || props.spicePre === '.') return null;

    // Extract sub-shapes (same format as EasyEDA symbol dataStr.shape)
    const subShapes = [];
    for (let i = 1; i < segments.length; i++) {
        const seg = segments[i].trim();
        if (seg) subShapes.push(seg);
    }

    if (subShapes.length === 0) return null;

    // Extract reference and value from T~P and T~N sub-shapes
    let reference = '';
    let value = '';
    for (const sub of subShapes) {
        if (!sub.startsWith('T~')) continue;
        const tp = sub.split('~');
        const textType = tp[1]; // N = name/value, P = prefix/reference
        const text = tp[12] || '';
        if (textType === 'P' && text) reference = text;
        if (textType === 'N' && text) value = text;
    }

    // Use supplier part for definition naming
    const supplierPart = props['Supplier Part'] || '';
    const mfgPart = props['Manufacturer Part'] || '';
    const defName = supplierPart
        ? `LCSC_${supplierPart}`
        : `EDA_${mfgPart || reference || 'unknown'}_${_nextId}`;

    // Build a dataStr-like object for the existing EasyEDA symbol parser
    const symbolDataStr = {
        shape: subShapes,
        BBox: null
    };

    // Parse symbol using the library's EasyEDA symbol parser
    let symbol = null;
    if (componentLibrary && typeof componentLibrary._createEasyEDASymbol === 'function') {
        symbol = componentLibrary._createEasyEDASymbol(symbolDataStr);
        if (symbol) symbol._source = 'EasyEDA';
    }

    if (!symbol) {
        console.warn('Failed to parse EasyEDA symbol for', defName);
        return null;
    }

    // Build definition
    const definition = {
        name: defName,
        description: value || mfgPart,
        category: 'EasyEDA Import',
        defaultValue: value || mfgPart || '',
        defaultReference: _refPrefix(reference) || 'U?',
        symbol,
        mpn: mfgPart,
        package: props.package || '',
        _source: 'EasyEDA-Import',
    };

    if (supplierPart) {
        definition.supplier_part_numbers = { LCSC: supplierPart };
    }

    // Determine component world position.
    // The symbol parser uses the first pin as origin.  Find it.
    const firstPin = _findFirstPin(subShapes);
    let worldX, worldY;
    if (firstPin) {
        worldX = firstPin.x * SCALE;
        worldY = firstPin.y * SCALE;
    } else {
        worldX = rawX * SCALE;
        worldY = rawY * SCALE;
    }

    const compId = nextCompId();

    const component = {
        id: compId,
        dn: defName,
        x: worldX,
        y: worldY,
        rot: rotation,
        mir: false,
        ref: reference,
        val: value,
        sr: true,
        sv: true,
    };

    return { component, definition };
}

/**
 * Extract a reference designator prefix (e.g. "R" from "R3", "U" from "U1").
 */
function _refPrefix(ref) {
    if (!ref) return '';
    const m = ref.match(/^([A-Z]+)/i);
    return m ? m[1] + '?' : '';
}

/**
 * Find the first pin's connection point in sub-shapes.
 */
function _findFirstPin(subShapes) {
    for (const sub of subShapes) {
        if (!/^P~/i.test(sub)) continue;
        const segments = sub.split('^^');
        // Connection point is in the second segment: "x~y"
        if (segments.length > 1 && segments[1]) {
            const parts = segments[1].split('~');
            const x = Number(parts[0]);
            const y = Number(parts[1]);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                return { x, y };
            }
        }
        // Fallback to header position
        const header = segments[0].split('~');
        const x = Number(header[4]);
        const y = Number(header[5]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
            return { x, y };
        }
    }
    return null;
}

// ─── Wire conversion ─────────────────────────────────────────────

/**
 * Convert an EasyEDA W shape to a ClearPCB Wire.
 * W format: W~x1 y1 x2 y2 ...~color~strokeWidth~...
 */
function _convertWire(wString) {
    const parts = wString.split('~');
    const coordStr = (parts[1] || '').trim();
    if (!coordStr) return null;

    const nums = coordStr.split(/\s+/).map(Number);
    if (nums.length < 4 || nums.some(n => !Number.isFinite(n))) return null;

    // Build points array
    const points = [];
    for (let i = 0; i < nums.length - 1; i += 2) {
        points.push({ x: nums[i] * SCALE, y: nums[i + 1] * SCALE });
    }

    // Build graph nodes and edges
    const graphNodes = {};
    const graphEdges = {};
    for (let i = 0; i < points.length; i++) {
        graphNodes[`n${i}`] = [points[i].x, points[i].y];
    }
    for (let i = 0; i < points.length - 1; i++) {
        graphEdges[`e${i}`] = [`n${i}`, `n${i + 1}`];
    }

    return {
        id: nextShapeId(),
        type: 'wire',
        c: 'var(--sch-wire, #008800)',
        lw: 0.25,
        nd: graphNodes,
        ed: graphEdges,
    };
}

// ─── Flag (power symbol) conversion ──────────────────────────────

/**
 * Convert an EasyEDA F shape (power/net flag) to a ClearPCB Net shape.
 * F format: F~type~x~y~rotation~id~...^^cx~cy^^netName~color~...
 */
function _convertFlag(fString) {
    const mainSegments = fString.split('^^');
    const header = mainSegments[0].split('~');

    const flagType = header[1] || ''; // e.g. 'part_netLabel_gnD', 'part_netLabel_VCC'
    const rawX = Number(header[2]);
    const rawY = Number(header[3]);
    const rawRot = Number(header[4]) || 0;

    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;

    // Net name from third segment
    let netName = '';
    if (mainSegments.length > 2) {
        const labelParts = mainSegments[2].split('~');
        netName = (labelParts[0] || '').trim();
    }

    if (!netName) return null;

    // Determine style
    let style = 't';
    const lowerType = flagType.toLowerCase();
    if (lowerType.includes('gnd') || lowerType.includes('ground')) {
        style = 'gnd';
    } else if (lowerType.includes('vcc') || lowerType.includes('vdd') || lowerType.includes('+')) {
        style = 'arrow';
    }

    // Map EasyEDA rotation to ClearPCB Net orientation
    // EasyEDA: 0=default, connection point determines direction
    // For GND, connection is up (N orientation = points up, symbol goes down)
    // For VCC/power, connection is down (S orientation)
    let orientation = 'N';
    if (style === 'gnd') {
        orientation = 'S';  // GND: connection on top, symbol below
    } else if (style === 'arrow') {
        orientation = 'N';  // VCC: connection on bottom, symbol above
    }

    return {
        id: nextShapeId(),
        type: 'net',
        x: rawX * SCALE,
        y: rawY * SCALE,
        n: netName,
        nst: style,
        no: orientation,
    };
}

// ─── Net label (T~L) conversion ──────────────────────────────────

/**
 * Convert an EasyEDA T~L shape (net label on wire) to a ClearPCB Net shape.
 * T~L format: T~L~x~y~rotation~color~font~...~comment~text~...
 */
function _convertLabel(tString) {
    const parts = tString.split('~');
    if (parts[1] !== 'L') return null;

    const rawX = Number(parts[2]);
    const rawY = Number(parts[3]);
    const rawRot = Number(parts[4]) || 0;
    const text = (parts[12] || '').trim();

    if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !text) return null;

    // Skip multi-line comments and very long labels (not net labels)
    if ((text.includes('\n') || text.includes('\\n')) && text.length > 20) return null;

    return {
        id: nextShapeId(),
        type: 'net',
        x: rawX * SCALE,
        y: rawY * SCALE,
        n: text,
        nst: 't',
        no: 'E',
    };
}

// ─── NoConnect conversion ────────────────────────────────────────

/**
 * Convert an EasyEDA O shape (no-connect) to a ClearPCB NoConnect.
 * O format: O~x~y~id~pathData~color~...
 */
function _convertNoConnect(oString) {
    const parts = oString.split('~');
    const rawX = Number(parts[1]);
    const rawY = Number(parts[2]);

    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;

    return {
        id: nextShapeId(),
        type: 'noconnect',
        x: rawX * SCALE,
        y: rawY * SCALE,
    };
}

// ─── Utilities ───────────────────────────────────────────────────

/**
 * Parse EasyEDA backtick-delimited properties string.
 * Format: key1`value1`key2`value2`...
 */
function _parseProps(propsStr) {
    const result = {};
    if (!propsStr) return result;
    const tokens = propsStr.split('`');
    for (let i = 0; i < tokens.length - 1; i += 2) {
        const key = tokens[i].trim();
        const val = tokens[i + 1]?.trim() || '';
        if (key) result[key] = val;
    }
    return result;
}
