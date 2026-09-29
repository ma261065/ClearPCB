import { normalizeProjectAliases, normalizePcbSection } from './project-field-aliases.js';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (...names) => new Set(names);

const ENVELOPE_FIELDS = fields('version', 'type', 'created', 'schematic', 'pcb');
const SCHEMATIC_FIELDS = fields('settings', 'shapes', 'components', 'defs');
const GRID_FIELDS = fields('gridSize', 'gridStyle', 'units', 'gridVisible', 'snapToGrid');
const SCHEMATIC_SETTINGS_FIELDS = new Set([...GRID_FIELDS,
    'paperSize', 'paperOrientation', 'titleBlock', 'titleBlockInfo', 'titleBlockData']);
const COMPONENT_FIELDS = fields('type', 'id', 'dn', 'x', 'y', 'rot', 'mir', 'ref', 'val', 'sr', 'sv', 'props', 'v', 'lk');
const DEFINITION_FIELDS = fields('name', 'category', 'description', 'symbol', 'defaultReference', 'defaultValue',
    'defaultProperties', '_source', 'supplier_part_numbers', 'footprintShapes', 'footprintBBox', 'footprintName',
    'model3dObj', 'model3dUrl', 'model3dName', 'has3d');
const SHAPE_COMMON_FIELDS = fields('id', 'type', 'c', 'l', 'lw', 'v', 'lk');
const SHAPE_FIELDS = {
    polyline: fields('nd', 'ed', 'cl', 'f', 'fa', 'cr', 'ncr', 'bg', 'ew', 'ir', 'fc'),
    wire: fields('nd', 'ed', 'f', 'fa', 'cr', 'ncr', 'bg', 'ew', 'pc', 'wl', 'n', 'lo'),
    circle: fields('x', 'y', 'r', 'f', 'fa'),
    arc: fields('sp', 'ep', 'bp', 'f'),
    text: fields('x', 'y', 't', 'fs', 'ff', 'ta', 'rot', 'cid', 'fk', 'att', 'bd'),
    net: fields('x', 'y', 'n', 'fs', 'nst', 'no', 'nto', 'bd'),
    noconnect: fields('x', 'y', 'pn'),
};
const PCB_FIELDS = fields('stackup', 'board', 'design', 'panelization', 'settings',
    'tracks', 'vias', 'pads', 'boardShapes', 'texts', 'placements');
const STACKUP_FIELDS = fields('copperLayers');
const BOARD_FIELDS = fields('width', 'height', 'radius');
const DESIGN_FIELDS = fields('trackWidth', 'clearance', 'viaDiameter', 'viaDrill', 'units', 'router');
const TRACK_FIELDS = new Set([...SHAPE_COMMON_FIELDS,
    'nd', 'ed', 'cl', 'f', 'fa', 'cr', 'ncr', 'bg', 'el', 'ew', 'n', 'w', 'pdc', 'sbs']);
const VIA_FIELDS = fields('type', 'id', 'x', 'y', 'd', 'dr', 'n', 'lk', 'v', 'span');
const VIA_SPAN_FIELDS = fields('from', 'to');
const BOARD_SHAPE_FIELDS = fields('id', 'kind', 'layer', 'lineWidth', 'filled', 'copperMode', 'plated', 'net',
    'segmentWidths', 'segmentBulges', 'nodeCornerRadii', 'cornerRadius', 'start', 'end', 'bulge',
    'x', 'y', 'radius', 'name', 'artwork', 'points');
const FILL_FIELDS = fields('type', 'id', 'l', 'pts', 'n', 'lk', 'v', 'kind', 'cornerRadius',
    'nodeCornerRadii', 'segmentBulges', 'x', 'y', 'radius');
const PCB_TEXT_FIELDS = fields('id', 'content', 'x', 'y', 'size', 'rotation', 'layer', 'strokeWidth', 'border');
const PAD_FIELDS = fields('type', 'id', 'x', 'y', 'shape', 'size', 'drill', 'ratio',
    'rotation', 'layers', 'net', 'locked', 'visible');
const PLACEMENT_FIELDS = fields('x', 'y', 'rotation', 'locked', 'mirror', 'side', 'refVisible',
    'refDx', 'refDy', 'refRot', 'refSize', 'refStrokeWidth');
const PANEL_FIELDS = fields('rows', 'columns', 'rowSpacing', 'columnSpacing', 'separation',
    'railTop', 'railBottom', 'railLeft', 'railRight', 'verticalTabsPerEdge', 'horizontalTabsPerEdge',
    'verticalTabOffset', 'horizontalTabOffset', 'horizontalPositioningHoles', 'horizontalFiducials',
    'verticalPositioningHoles', 'verticalFiducials', 'tabWidth', 'holeDiameter', 'holePitch', 'noteCreated');
const COPPER_MODES = new Set(['add', 'remove-copper', 'remove-solder-mask', 'remove-copper-mask']);
const ARTWORK_FIELDS = {
    'tuples-v1': fields('encoding', 'data'),
    'deflate-tuples-v1': fields('encoding', 'bytes', 'data'),
    'reference-v1': fields('encoding', 'index'),
};

function numberedSnippet(value) {
    let text;
    try {
        text = JSON.stringify(value, null, 2);
    } catch {
        text = String(value);
    }
    if (text === undefined) text = String(value);
    const lines = text.split('\n');
    const shown = lines.slice(0, 16);
    const width = String(shown.length).length;
    const numbered = shown.map((line, index) => `${String(index + 1).padStart(width)} | ${line}`);
    if (lines.length > shown.length) numbered.push(`${' '.repeat(width)} | ...`);
    return numbered.join('\n');
}

function invalid(path, message, value) {
    throw new Error(`${message}\nLocation: ${path}\nFaulty snippet:\n${numberedSnippet(value)}`);
}

function requireRecord(value, path, message = 'Expected an object.') {
    if (!record(value)) invalid(path, message, value);
}

function requireFields(value, required, path) {
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            invalid(path, `Missing required field "${key}".`, value);
        }
    }
}

function rejectUnknownFields(value, allowed, path) {
    requireRecord(value, path);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) invalid(`${path}.${key}`, `Unknown field "${key}".`, { [key]: value[key] });
    }
}

function validateGraph(item, path) {
    requireRecord(item.nd, `${path}.nd`, 'Graph shapes require an "nd" node map.');
    requireRecord(item.ed, `${path}.ed`, 'Graph shapes require an "ed" edge map.');
    for (const [id, node] of Object.entries(item.nd)) {
        if (!Array.isArray(node) || node.length !== 2 || !node.every(Number.isFinite)) {
            invalid(`${path}.nd.${id}`, 'Graph nodes must use the canonical [x, y] tuple.', node);
        }
    }
    for (const [id, edge] of Object.entries(item.ed)) {
        if (!Array.isArray(edge) || edge.length !== 2 || !edge.every(value => typeof value === 'string')) {
            invalid(`${path}.ed.${id}`, 'Graph edges must use the canonical [fromNodeId, toNodeId] tuple.', edge);
        }
        if (!Object.prototype.hasOwnProperty.call(item.nd, edge[0])
            || !Object.prototype.hasOwnProperty.call(item.nd, edge[1])) {
            invalid(`${path}.ed.${id}`, 'Graph edge references a missing node.', edge);
        }
    }
}

function validateSchematicShape(item, index) {
    const path = `schematic.shapes[${index}]`;
    requireRecord(item, path);
    if (!Object.prototype.hasOwnProperty.call(SHAPE_FIELDS, item.type)) {
        invalid(`${path}.type`, `Unknown schematic shape type "${item.type}".`, { type: item.type });
    }
    rejectUnknownFields(item, new Set([...SHAPE_COMMON_FIELDS, ...SHAPE_FIELDS[item.type]]), path);
    requireFields(item, ['id', 'type'], path);
    if (item.type === 'polyline' || item.type === 'wire') validateGraph(item, path);
}

function validateComponent(item, index) {
    const path = `schematic.components[${index}]`;
    rejectUnknownFields(item, COMPONENT_FIELDS, path);
    requireFields(item, ['type', 'id', 'dn', 'x', 'y', 'ref', 'val'], path);
    if (item.type !== 'component') invalid(`${path}.type`, 'Component type must be "component".', { type: item.type });
}

function validateSchematic(schematic) {
    rejectUnknownFields(schematic, SCHEMATIC_FIELDS, 'schematic');
    requireFields(schematic, ['shapes', 'components'], 'schematic');
    if (schematic.settings !== undefined) {
        rejectUnknownFields(schematic.settings, SCHEMATIC_SETTINGS_FIELDS, 'schematic.settings');
        validateUnits(schematic.settings, 'schematic.settings');
    }
    if (!Array.isArray(schematic.shapes)) invalid('schematic.shapes', 'Schematic shapes must be an array.', schematic.shapes);
    if (!Array.isArray(schematic.components)) invalid('schematic.components', 'Schematic components must be an array.', schematic.components);
    schematic.shapes.forEach(validateSchematicShape);
    schematic.components.forEach(validateComponent);
    if (schematic.defs !== undefined) {
        requireRecord(schematic.defs, 'schematic.defs');
        for (const [name, definition] of Object.entries(schematic.defs)) {
            rejectUnknownFields(definition, DEFINITION_FIELDS, `schematic.defs.${name}`);
        }
    }
}

function validateUnits(settings, path) {
    if (settings.units !== undefined && !['mm', 'inch'].includes(settings.units)) {
        invalid(`${path}.units`, 'Units must be "mm" or "inch".', { units: settings.units });
    }
}

function validatePcbShape(item, index) {
    const path = `pcb.boardShapes[${index}]`;
    requireRecord(item, path);
    if (item.type === 'fill') {
        rejectUnknownFields(item, FILL_FIELDS, path);
        requireFields(item, ['type', 'id', 'l', 'pts', 'kind'], path);
        if (!['polygon', 'rect', 'circle'].includes(item.kind)) {
            invalid(`${path}.kind`, 'Copper-fill kind must be "polygon", "rect", or "circle".', { kind: item.kind });
        }
        if (!Array.isArray(item.pts)
            || item.pts.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) {
            invalid(`${path}.pts`, 'Copper-fill points must use canonical [x, y] tuples.', item.pts);
        }
        return;
    }
    rejectUnknownFields(item, BOARD_SHAPE_FIELDS, path);
    requireFields(item, ['id', 'kind', 'layer', 'lineWidth', 'filled', 'copperMode', 'plated', 'net'], path);
    if (!['line', 'rect', 'polygon', 'arc', 'circle', 'image'].includes(item.kind)) {
        invalid(`${path}.kind`, 'Unknown board-shape kind.', { kind: item.kind });
    }
    if (!COPPER_MODES.has(item.copperMode)) {
        invalid(`${path}.copperMode`, 'Copper mode must be "add", "remove-copper", "remove-solder-mask", or "remove-copper-mask".',
            { copperMode: item.copperMode });
    }
    if (item.kind === 'image') {
        requireRecord(item.artwork, `${path}.artwork`, 'Image artwork is required.');
        const allowed = ARTWORK_FIELDS[item.artwork.encoding];
        if (!allowed) invalid(`${path}.artwork.encoding`, 'Unsupported image artwork encoding.', item.artwork);
        rejectUnknownFields(item.artwork, allowed, `${path}.artwork`);
    }
}

function validatePcb(pcb) {
    rejectUnknownFields(pcb, PCB_FIELDS, 'pcb');
    requireFields(pcb, ['stackup', 'design'], 'pcb');
    rejectUnknownFields(pcb.stackup, STACKUP_FIELDS, 'pcb.stackup');
    requireFields(pcb.stackup, ['copperLayers'], 'pcb.stackup');
    rejectUnknownFields(pcb.design, DESIGN_FIELDS, 'pcb.design');
    requireFields(pcb.design, DESIGN_FIELDS, 'pcb.design');
    validateUnits(pcb.design, 'pcb.design');
    if (pcb.board !== undefined) rejectUnknownFields(pcb.board, BOARD_FIELDS, 'pcb.board');
    if (pcb.settings !== undefined) {
        rejectUnknownFields(pcb.settings, GRID_FIELDS, 'pcb.settings');
        validateUnits(pcb.settings, 'pcb.settings');
    }
    if (pcb.panelization != null) {
        rejectUnknownFields(pcb.panelization, PANEL_FIELDS, 'pcb.panelization');
        requireFields(pcb.panelization, [...PANEL_FIELDS].filter(key => key !== 'noteCreated'), 'pcb.panelization');
    }
    for (const [field, validator] of [
        ['tracks', (item, index) => {
            const path = `pcb.tracks[${index}]`;
            rejectUnknownFields(item, TRACK_FIELDS, path);
            requireFields(item, ['id', 'type', 'nd', 'ed'], path);
            if (item.type !== 'track') invalid(`${path}.type`, 'PCB track type must be "track".', { type: item.type });
            validateGraph(item, path);
        }],
        ['vias', (item, index) => {
            const path = `pcb.vias[${index}]`;
            rejectUnknownFields(item, VIA_FIELDS, path);
            requireFields(item, ['type', 'id', 'x', 'y', 'd', 'dr'], path);
            if (item.type !== 'via') invalid(`${path}.type`, 'PCB via type must be "via".', { type: item.type });
            if (item.span !== undefined) {
                requireRecord(item.span, `${path}.span`, 'Invalid via copper-layer span.');
                rejectUnknownFields(item.span, VIA_SPAN_FIELDS, `${path}.span`);
            }
        }],
        ['pads', (item, index) => {
            const path = `pcb.pads[${index}]`;
            rejectUnknownFields(item, PAD_FIELDS, path);
            requireFields(item, ['type', 'id', 'x', 'y', 'shape', 'size', 'drill', 'layers'], path);
            if (item.type !== 'pad') invalid(`${path}.type`, 'PCB pad type must be "pad".', { type: item.type });
            if (!['round', 'stadium', 'square', 'rectangle', 'oval'].includes(item.shape)) {
                invalid(`${path}.shape`, 'Invalid PCB pad shape.', { shape: item.shape });
            }
            if (['stadium', 'rectangle', 'oval'].includes(item.shape)) requireFields(item, ['ratio'], path);
            if (!['top-copper', 'bottom-copper', 'both'].includes(item.layers)) {
                invalid(`${path}.layers`, 'Pad layers must be top-copper, bottom-copper, or both.', { layers: item.layers });
            }
            if (!(item.size > 0) || !(item.drill > 0) || item.drill > item.size) {
                invalid(path, 'Pad size and drill must be positive, with drill no larger than size.', item);
            }
            if (['stadium', 'rectangle', 'oval'].includes(item.shape) && !(item.ratio >= 1)) {
                invalid(`${path}.ratio`, 'Elongated pad ratio must be at least 1.', { ratio: item.ratio });
            }
        }],
        ['boardShapes', validatePcbShape],
        ['texts', (item, index) => {
            const path = `pcb.texts[${index}]`;
            rejectUnknownFields(item, PCB_TEXT_FIELDS, path);
            requireFields(item, ['id', 'content', 'x', 'y', 'size', 'rotation', 'layer', 'strokeWidth'], path);
        }],
    ]) {
        if (pcb[field] === undefined) continue;
        if (!Array.isArray(pcb[field])) invalid(`pcb.${field}`, `PCB ${field} must be an array.`, pcb[field]);
        pcb[field].forEach(validator);
    }
    if (pcb.placements !== undefined) {
        requireRecord(pcb.placements, 'pcb.placements');
        for (const [id, placement] of Object.entries(pcb.placements)) {
            rejectUnknownFields(placement, PLACEMENT_FIELDS, `pcb.placements.${id}`);
            requireFields(placement, ['x', 'y', 'rotation'], `pcb.placements.${id}`);
        }
    }
}

export function defaultPcbStackup() {
    return { copperLayers: ['top-copper', 'bottom-copper'] };
}

export function validatePcbStackup(pcb) {
    if (pcb == null) return defaultPcbStackup().copperLayers;
    requireRecord(pcb.stackup, 'pcb.stackup', 'PCB stackup is required.');
    const layers = pcb.stackup.copperLayers;
    if (!Array.isArray(layers) || layers.length < 2 || layers[0] !== 'top-copper'
        || layers[layers.length - 1] !== 'bottom-copper' || new Set(layers).size !== layers.length
        || layers.slice(1, -1).some(layer => typeof layer !== 'string' || !/^inner-copper-[1-9]\d*$/.test(layer))) {
        invalid('pcb.stackup.copperLayers', 'Invalid ordered PCB copper layers.', layers);
    }
    for (const field of ['tracks', 'boardShapes', 'texts']) {
        if (!Array.isArray(pcb?.[field])) continue;
        for (const item of pcb[field]) {
            const references = [item?.l, item?.layer, ...Object.values(item?.el || {})];
            for (const layer of references) {
                if (typeof layer === 'string' && layer.includes('copper') && !layers.includes(layer)) {
                    invalid(`pcb.${field}`, `Undeclared PCB copper layer: ${layer}`, item);
                }
            }
        }
    }
    if (Array.isArray(pcb?.vias)) {
        for (const via of pcb.vias) {
            if (via?.span === undefined) continue;
            if (!record(via.span) || !layers.includes(via.span.from) || !layers.includes(via.span.to)
                || layers.indexOf(via.span.from) >= layers.indexOf(via.span.to)) {
                invalid(`pcb.vias[${pcb.vias.indexOf(via)}].span`, 'Invalid via copper-layer span.', via.span);
            }
            for (const pad of pcb?.pads || []) {
                for (const layer of pad.layers === 'both' ? ['top-copper', 'bottom-copper'] : [pad.layers]) {
                    if (!layers.includes(layer)) invalid('pcb.pads', `Undeclared PCB copper layer: ${layer}`, pad);
                }
            }
        }
    }
    return layers;
}

export function assertSupportedPcb(pcb) {
    const layers = validatePcbStackup(normalizePcbSection(pcb));
    if (layers.length !== 2) {
        throw new Error('This project uses multiple copper layers. This editor currently supports only two-layer boards.');
    }
}

export function validateEditableProject(data) {
    const normalized = validateProject(data);
    assertSupportedPcb(normalized.pcb);
    return normalized;
}

export function repairDuplicateTrackIds(data) {
    const normalized = normalizeProjectAliases(data);
    const tracks = normalized?.pcb?.tracks;
    if (!Array.isArray(tracks)) return { data: normalized, count: 0 };
    const seen = new Set();
    const duplicates = [];
    tracks.forEach((track, index) => {
        if (!track?.id) return;
        if (seen.has(track.id)) duplicates.push(index);
        seen.add(track.id);
    });
    if (!duplicates.length) return { data: normalized, count: 0 };
    for (const shape of normalized.schematic?.shapes || []) if (shape?.id) seen.add(shape.id);
    const repaired = structuredClone(normalized);
    let next = 1;
    for (const index of duplicates) {
        while (seen.has(`shape_${next}`)) next++;
        const id = `shape_${next++}`;
        repaired.pcb.tracks[index].id = id;
        seen.add(id);
    }
    return { data: repaired, count: duplicates.length };
}

export function validateProject(data) {
    data = normalizeProjectAliases(data);
    if (!record(data) || data.type !== 'clearpcb-project' || data.version !== '1.0') {
        invalid('project', 'Unsupported ClearPCB project format or version.', data);
    }
    rejectUnknownFields(data, ENVELOPE_FIELDS, 'project');
    if (!record(data.schematic)) invalid('schematic', 'Missing schematic section.', data.schematic);
    validateSchematic(data.schematic);
    if (data.pcb != null) {
        requireRecord(data.pcb, 'pcb', 'Invalid PCB section.');
        validatePcb(data.pcb);
    }
    validatePcbStackup(data.pcb);
    for (const [section, fields] of [[data.schematic, ['shapes', 'components']],
        [data.pcb, ['tracks', 'vias', 'pads', 'boardShapes', 'texts']]]) {
        if (!section) continue;
        for (const field of fields) {
            const items = section[field];
            if (items === undefined) continue;
            if (!Array.isArray(items) || items.some((item) => !record(item))) {
                invalid(`${section === data.pcb ? 'pcb' : 'schematic'}.${field}`,
                    `Invalid project collection: ${field}`, items);
            }
            const ids = new Set();
            for (const [index, item] of items.entries()) {
                if (item.id && ids.has(item.id)) {
                    invalid(`${section === data.pcb ? 'pcb' : 'schematic'}.${field}[${index}]`,
                        `Duplicate ${field} id: ${item.id}`, item);
                }
                if (item.id) ids.add(item.id);
                const nodes = item.nd;
                const edges = item.ed;
                if (nodes && !record(nodes)) invalid(`${field}[${index}].nd`, `Invalid nodes in ${field}`, nodes);
                if (edges && !record(edges)) invalid(`${field}[${index}].ed`, `Invalid edges in ${field}`, edges);
                for (const node of Object.values(nodes || {})) {
                    if (!Array.isArray(node) || node.length !== 2 || !node.every(Number.isFinite)) {
                        invalid(`${field}[${index}].nd`, `Invalid graph coordinates in ${field}`, node);
                    }
                }
                for (const edge of Object.values(edges || {})) {
                    const from = edge[0];
                    const to = edge[1];
                    if (!nodes || !Object.prototype.hasOwnProperty.call(nodes, from) || !Object.prototype.hasOwnProperty.call(nodes, to)) {
                        invalid(`${field}[${index}].ed`, `Dangling graph edge in ${field}`, edge);
                    }
                }
            }
        }
    }
    for (const section of [data.schematic, data.pcb]) {
        for (const key of ['defs', 'settings', 'placements', 'design', 'board']) {
            if (section?.[key] != null && !record(section[key])) invalid(key, `Invalid ${key}`, section[key]);
        }
        for (const key of ['defs', 'placements']) {
            if (Object.values(section?.[key] || {}).some((item) => !record(item))) {
                invalid(key, `Invalid ${key} entry`, section[key]);
            }
        }
    }
    const stack = [data];
    const visited = new Set();
    while (stack.length) {
        const value = stack.pop();
        if (typeof value === 'number' && !Number.isFinite(value)) {
            invalid('project', 'Non-finite project coordinate.', value);
        }
        if (value && typeof value === 'object' && !visited.has(value)) {
            visited.add(value);
            for (const child of Object.values(value)) stack.push(child);
        }
    }
    return data;
}
