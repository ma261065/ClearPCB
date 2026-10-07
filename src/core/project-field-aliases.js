const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const GRID = {
    gs: 'gridSize', gt: 'gridStyle', u: 'units', gv: 'gridVisible', sg: 'snapToGrid',
};
const SCHEMATIC_SETTINGS = {
    ...GRID, ps: 'paperSize', po: 'paperOrientation', tb: 'titleBlock',
    ti: 'titleBlockInfo', td: 'titleBlockData',
};
const SHAPE_COMMON = {
    c: 'color', l: 'layer', lw: 'lineWidth', v: 'visible', lk: 'locked',
};
const SCHEMATIC_SHAPE = {
    ...SHAPE_COMMON,
    nd: 'graphNodes', ed: 'graphEdges', cl: 'closed', f: 'fill', fa: 'fillAlpha',
    cr: 'cornerRadius', ncr: 'nodeCornerRadii', bg: 'edgeBulges', ew: 'edgeWidths',
    ir: 'isRect', fc: 'fillColor', pc: 'pinConnections', wl: 'wireLabel',
    w: 'width', h: 'height', rev: 'reversed', cn: 'cornerNodeIds',
    n: 'net', lo: 'labelOffset', sp: 'startPoint', ep: 'endPoint', bp: 'bulgePoint',
    t: 'text', fs: 'fontSize', ff: 'fontFamily', ta: 'textAnchor', rot: 'rotation',
    cid: 'componentId', fk: 'fieldKey', att: 'attachment', bd: 'border',
    nst: 'style', no: 'orientation', nto: 'textOffset', pn: 'pinConnection',
};
const COMPONENT = {
    dn: 'definitionName', rot: 'rotation', mir: 'mirror', ref: 'reference', val: 'value',
    sr: 'showReference', sv: 'showValue', props: 'properties', v: 'visible', lk: 'locked',
    pkg: 'packageId',
};
const PIN_CONNECTION = { cid: 'componentId', pn: 'pinNumber' };
const DEFINITION = {
    n: 'name', cat: 'category', desc: 'description', sym: 'symbol', dr: 'defaultReference',
    dv: 'defaultValue', dp: 'defaultProperties', src: '_source', spn: 'supplier_part_numbers',
    fsh: 'footprintShapes', fbb: 'footprintBBox', fn: 'footprintName',
    m3o: 'model3dObj', m3u: 'model3dUrl', m3n: 'model3dName', h3: 'has3d',
};
const SYMBOL = { w: 'width', h: 'height', o: 'origin', g: 'graphics', p: 'pins' };
const SYMBOL_GRAPHIC = {
    k: 'type', w: 'width', h: 'height', sw: 'strokeWidth', s: 'stroke', f: 'fill',
    pts: 'points', tx: 'text', fs: 'fontSize', a: 'anchor', bl: 'baseline',
    tr: 'transform', sa: 'startAngle', ea: 'endAngle',
};
const SYMBOL_PIN = {
    i: '_id', k: '_key', pd: '_pathData', num: 'number', n: 'name',
    o: 'orientation', len: 'length', t: 'type', pt: 'pinType', sh: 'shape',
    np: 'namePos', nup: 'numberPos', sn: 'showName', snu: 'showNumber',
    hd: 'hidden', b: 'bubble', knfs: 'kicadNameFontSize',
    kufs: 'kicadNumberFontSize', kny: 'kicadNumberYOffset',
};
const SYMBOL_TEXT_POSITION = {
    rot: 'rotation', a: 'anchor', ff: 'fontFamily', fs: 'fontSize',
};
const BOUNDS = { w: 'width', h: 'height' };

const STACKUP = { cl: 'copperLayers' };
const BOARD = { w: 'width', h: 'height', r: 'radius' };
const DESIGN = {
    tw: 'trackWidth', cl: 'clearance', vd: 'viaDiameter', dr: 'viaDrill',
    u: 'units', rt: 'router',
};
const TRACK = {
    ...SHAPE_COMMON,
    nd: 'graphNodes', ed: 'graphEdges', cl: 'closed', f: 'fill', fa: 'fillAlpha',
    cr: 'cornerRadius', ncr: 'nodeCornerRadii', bg: 'edgeBulges',
    el: 'edgeLayers', ew: 'edgeWidths', n: 'net', w: 'width',
    pdc: 'padConnections', sbs: 'sourceBoardShape',
};
const VIA = { d: 'diameter', dr: 'drill', n: 'net', lk: 'locked', v: 'visible' };
const VIA_CONTAINER = { sp: 'span' };
const VIA_SPAN = { f: 'from', t: 'to' };
const BOARD_SHAPE = {
    k: 'kind', l: 'layer', lw: 'lineWidth', f: 'filled', cm: 'copperMode',
    p: 'plated', n: 'net', sw: 'segmentWidths', sb: 'segmentBulges',
    ncr: 'nodeCornerRadii', cr: 'cornerRadius', sp: 'start', ep: 'end',
    bp: 'bulge', r: 'radius', nm: 'name', aw: 'artwork', pts: 'points',
    w: 'width', h: 'height', rot: 'rotation', rev: 'reversed', lk: 'locked',
};
const FILL_BASE = { l: 'layer', pts: 'points', n: 'net', lk: 'locked', v: 'visible' };
const FILL_GEOMETRY = {
    k: 'kind', cr: 'cornerRadius', ncr: 'nodeCornerRadii', sb: 'segmentBulges', r: 'radius',
    w: 'width', h: 'height', rot: 'rotation', rev: 'reversed',
};
const ARTWORK = { e: 'encoding', b: 'bytes', d: 'data', i: 'index' };
const PCB_TEXT = {
    t: 'content', s: 'size', rot: 'rotation', l: 'layer', lw: 'strokeWidth', bd: 'border',
    lk: 'locked',
};
const PAD = {
    sh: 'shape', s: 'size', dr: 'drill', ra: 'ratio', rot: 'rotation',
    ls: 'layers', n: 'net', lk: 'locked', v: 'visible',
};
const PLACEMENT = {
    rot: 'rotation', lk: 'locked', mir: 'mirror', sd: 'side', rv: 'refVisible',
    rdx: 'refDx', rdy: 'refDy', rr: 'refRot', rs: 'refSize', rw: 'refStrokeWidth',
};
const PANEL = {
    r: 'rows', c: 'columns', rs: 'rowSpacing', cs: 'columnSpacing', sp: 'separation',
    rt: 'railTop', rb: 'railBottom', rl: 'railLeft', rr: 'railRight',
    vt: 'verticalTabsPerEdge', ht: 'horizontalTabsPerEdge',
    vo: 'verticalTabOffset', ho: 'horizontalTabOffset',
    vph: 'verticalPositioningHoles', hf: 'horizontalFiducials',
    hph: 'horizontalPositioningHoles', vf: 'verticalFiducials',
    tw: 'tabWidth', hd: 'holeDiameter', hp: 'holePitch', nc: 'noteCreated',
};

function equivalent(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => equivalent(value, right[index]));
    }
    if (!record(left) || !record(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && equivalent(left[key], right[key]));
}

function conflict(path, shortKey, longKey, value) {
    const snippet = JSON.stringify(value, null, 2)
        .split('\n')
        .map((line, index) => `${index + 1} | ${line}`)
        .join('\n');
    throw new Error(`Conflicting fields "${shortKey}" and "${longKey}".\nLocation: ${path}.${shortKey}\nFaulty snippet:\n${snippet}`);
}

function convertRecord(value, aliases, target, path) {
    if (!record(value)) return value;
    for (const [shortKey, longKey] of Object.entries(aliases)) {
        if (own(value, shortKey) && own(value, longKey) && !equivalent(value[shortKey], value[longKey])) {
            conflict(path, shortKey, longKey, { [shortKey]: value[shortKey], [longKey]: value[longKey] });
        }
        const sourceKey = target === 'short' ? longKey : shortKey;
        const targetKey = target === 'short' ? shortKey : longKey;
        if (own(value, sourceKey) && !own(value, targetKey)) value[targetKey] = value[sourceKey];
        delete value[sourceKey];
    }
    return value;
}

function transformSchematic(schematic, target) {
    if (!record(schematic)) return schematic;
    convertRecord(schematic.settings, SCHEMATIC_SETTINGS, target, 'schematic.settings');
    for (const [index, shape] of (Array.isArray(schematic.shapes) ? schematic.shapes : []).entries()) {
        convertRecord(shape, SCHEMATIC_SHAPE, 'short', `schematic.shapes[${index}]`);
        for (const [nodeId, connection] of Object.entries(record(shape?.pc) ? shape.pc : {})) {
            convertRecord(connection, PIN_CONNECTION, target, `schematic.shapes[${index}].pinConnections.${nodeId}`);
        }
        convertRecord(shape?.pn, PIN_CONNECTION, target, `schematic.shapes[${index}].pinConnection`);
    }
    for (const [index, component] of (Array.isArray(schematic.components) ? schematic.components : []).entries()) {
        convertRecord(component, COMPONENT, 'short', `schematic.components[${index}]`);
    }
    for (const [name, definition] of Object.entries(schematic.defs || {})) {
        convertRecord(definition, DEFINITION, target, `schematic.defs.${name}`);
        const symbol = target === 'short' ? definition?.sym : definition?.symbol;
        convertRecord(symbol, SYMBOL, target, `schematic.defs.${name}.symbol`);
        const graphics = target === 'short' ? symbol?.g : symbol?.graphics;
        for (const [index, graphic] of (Array.isArray(graphics) ? graphics : []).entries()) {
            convertRecord(graphic, SYMBOL_GRAPHIC, target,
                `schematic.defs.${name}.symbol.graphics[${index}]`);
        }
        const pins = target === 'short' ? symbol?.p : symbol?.pins;
        for (const [index, pin] of (Array.isArray(pins) ? pins : []).entries()) {
            convertRecord(pin, SYMBOL_PIN, target, `schematic.defs.${name}.symbol.pins[${index}]`);
            convertRecord(target === 'short' ? pin?.np : pin?.namePos, SYMBOL_TEXT_POSITION, target,
                `schematic.defs.${name}.symbol.pins[${index}].namePos`);
            convertRecord(target === 'short' ? pin?.nup : pin?.numberPos, SYMBOL_TEXT_POSITION, target,
                `schematic.defs.${name}.symbol.pins[${index}].numberPos`);
        }
        convertRecord(target === 'short' ? definition?.fbb : definition?.footprintBBox, BOUNDS, target,
            `schematic.defs.${name}.footprintBBox`);
    }
    return schematic;
}

function transformBoardShape(shape, target, path) {
    if (shape?.type === 'fill') {
        convertRecord(shape, FILL_BASE, 'short', path);
        convertRecord(shape, FILL_GEOMETRY, target, path);
    } else {
        convertRecord(shape, BOARD_SHAPE, target, path);
    }
    const artwork = target === 'short' ? shape?.aw : shape?.artwork;
    convertRecord(artwork, ARTWORK, target, `${path}.artwork`);
}

function transformPcb(pcb, target) {
    if (!record(pcb)) return pcb;
    convertRecord(pcb.stackup, STACKUP, target, 'pcb.stackup');
    convertRecord(pcb.board, BOARD, target, 'pcb.board');
    convertRecord(pcb.design, DESIGN, target, 'pcb.design');
    convertRecord(pcb.settings, GRID, target, 'pcb.settings');
    convertRecord(pcb.panelization, PANEL, target, 'pcb.panelization');

    for (const [index, track] of (Array.isArray(pcb.tracks) ? pcb.tracks : []).entries()) {
        convertRecord(track, TRACK, 'short', `pcb.tracks[${index}]`);
        for (const [nodeId, connection] of Object.entries(record(track?.pdc) ? track.pdc : {})) {
            convertRecord(connection, PIN_CONNECTION, target, `pcb.tracks[${index}].padConnections.${nodeId}`);
        }
        transformBoardShape(track?.sbs, target, `pcb.tracks[${index}].sourceBoardShape`);
    }
    for (const [index, via] of (Array.isArray(pcb.vias) ? pcb.vias : []).entries()) {
        convertRecord(via, VIA, 'short', `pcb.vias[${index}]`);
        convertRecord(via, VIA_CONTAINER, target, `pcb.vias[${index}]`);
        convertRecord(target === 'short' ? via.sp : via.span, VIA_SPAN, target, `pcb.vias[${index}].span`);
    }
    for (const [index, shape] of (Array.isArray(pcb.boardShapes) ? pcb.boardShapes : []).entries()) {
        transformBoardShape(shape, target, `pcb.boardShapes[${index}]`);
    }
    for (const [index, text] of (Array.isArray(pcb.texts) ? pcb.texts : []).entries()) {
        convertRecord(text, PCB_TEXT, target, `pcb.texts[${index}]`);
    }
    for (const [index, pad] of (Array.isArray(pcb.pads) ? pcb.pads : []).entries()) {
        convertRecord(pad, PAD, target, `pcb.pads[${index}]`);
    }
    for (const [id, placement] of Object.entries(pcb.placements || {})) {
        convertRecord(placement, PLACEMENT, target, `pcb.placements.${id}`);
    }
    return pcb;
}

export function normalizePcbSection(pcb) {
    return transformPcb(structuredClone(pcb), 'long');
}

export function normalizeProjectAliases(data) {
    const normalized = structuredClone(data);
    if (!record(normalized)) return normalized;
    transformSchematic(normalized.schematic, 'long');
    transformPcb(normalized.pcb, 'long');
    return normalized;
}

export function compactProjectAliases(data) {
    return compactNormalizedProject(normalizeProjectAliases(data));
}

/**
 * Compact, in place, a project already in the form {@link normalizeProjectAliases}
 * returns. Saves a copy when the caller owns the normalized object.
 */
export function compactNormalizedProject(normalized) {
    if (!record(normalized)) return normalized;
    transformSchematic(normalized.schematic, 'short');
    transformPcb(normalized.pcb, 'short');
    return normalized;
}
