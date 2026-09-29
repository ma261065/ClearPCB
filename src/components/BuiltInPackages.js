/**
 * Generic, non-manufacturer-specific package choices for the built-in symbols.
 * Dimensions and mappings are illustrative: check a part's datasheet before fabrication.
 * Pin identifiers are semantic schematic nets, not a claim about vendor pin numbering.
 */
import { BuiltInComponents } from './BuiltInComponents.js';
import { builtInPackageLayouts, getBuiltInModel3D } from './BuiltInModels3D.js';

// Match library registration: the last definition with a given name is canonical.
const defaults = new Map(BuiltInComponents.map(definition => [definition.name, definition]));
const chips = ['0402', '0603', '0805', '1206', '1210', '2010', '2512'];
const choices = {
    Resistor: chips.map(id => [id, `r-${id}`]),
    Resistor_IEC: chips.map(id => [id, `r-${id}`]),
    Capacitor: chips.map(id => [id, `c-${id}`]),
    Capacitor_Polarized: [4, 5, 6.3].map(size => [`smd-${size}`, `can-${size}`]),
    Inductor: ['0603', '0805', '1206', '1210'].map(id => [id, `l-${id}`]),
    Diode: ['do41', 'sod123', 'sod323', 'sma'].map(id => [id, id]),
    LED: [['th-3mm', 'led3'], ...['0603', '0805', '1206'].map(id => [id, `led-${id}`])],
    NPN: [['to92', 'to92'], ['sot23', 'sot23']],
    PNP: [['to92', 'to92'], ['sot23', 'sot23']],
    NMOS: [['to92', 'to92'], ['sot23', 'sot23']],
    PMOS: [['to92', 'to92'], ['sot23', 'sot23']],
    OpAmp: [['soic8', 'soic8'], ['tssop8', 'tssop8']],
    IC_DIP8: [['soic8', 'soic8'], ['tssop8', 'tssop8']],
    Conn_01x02: [['header-smt', 'header-smt'], ['terminal-5.08', 'terminal-5.08']],
    SW_Push: [['smt-6mm', 'switch-smt']],
};
const defaultLabels = {
    Resistor: 'Axial resistor TH', Resistor_IEC: 'Axial resistor TH',
    Capacitor: 'Disc Ø5 mm TH', Capacitor_Polarized: 'Radial Ø5 mm TH',
    Inductor: 'Axial inductor TH', Diode: 'DO-35 axial TH', LED: 'LED Ø5 mm TH',
    NPN: 'TO-92 inline TH', PNP: 'TO-92 inline TH', NMOS: 'TO-92 inline TH',
    PMOS: 'SOT-23 SMT', OpAmp: 'DIP-8 TH', IC_DIP8: 'DIP-8 TH',
    Conn_01x02: '1×02 header, 2.54 mm pitch TH', SW_Push: '6×6 mm tactile switch TH',
};

function supported(definition) {
    return definition?._source === 'Built-in'
        && defaults.has(definition.name) && Object.hasOwn(choices, definition.name);
}

/** Return fresh UI options, or [] for definitions outside this built-in catalogue. */
export function getBuiltInPackageOptions(definition) {
    if (!supported(definition)) return [];
    return [
        { value: 'default', label: `Default — ${defaultLabels[definition.name]}` },
        ...choices[definition.name].map(([value, id]) => ({ value, label: builtInPackageLayouts[id].label })),
    ];
}

function padLabels(name, packageId) {
    // TO-92: left → right; SOT-23: lower-left, lower-right, upper-centre.
    // Preserve the existing TH definitions, including their intentionally different PNP order.
    if (name === 'NPN') return packageId === 'to92' ? ['B', 'C', 'E'] : ['B', 'E', 'C'];
    if (name === 'PNP') return ['B', 'E', 'C'];
    if (name === 'NMOS' || name === 'PMOS') return packageId === 'to92' ? ['G', 'D', 'S'] : ['G', 'S', 'D'];
    // IC layouts run counterclockwise from upper-left, like the canonical DIP.
    if (name === 'OpAmp') return ['+', '-', 'OUT', '4', '5', '6', '7', '8'];
    if (name === 'IC_DIP8') return ['1', '2', '3', '4', '5', '6', '7', '8'];
    if (name === 'SW_Push') return ['1', '2', '1', '2'];
    if (name === 'Capacitor_Polarized') return ['+', '-'];
    if (name === 'Diode' || name === 'LED') return ['A', 'K'];
    return ['1', '2'];
}

function variantFootprint(name, packageId, entry) {
    const labels = padLabels(name, packageId);
    const footprintShapes = entry.pads.map(([x, y, width, height, drill], i) =>
        ['PAD', drill ? 'ELLIPSE' : 'RECT', x, y, width, height, labels[i],
            drill ? 'both' : 'top', 1, drill ? 0 : 1, drill].join('~'));
    const halfWidth = Math.max(entry.body[0] / 2, ...entry.pads.map(([x, , width]) => Math.abs(x) + width / 2));
    const halfHeight = Math.max(entry.body[1] / 2, ...entry.pads.map(([, y, , height]) => Math.abs(y) + height / 2));
    return {
        footprint: entry.footprint,
        footprintName: entry.footprint.split(':')[1],
        hasFootprint: true,
        footprintShapes,
        footprintBBox: { x: -halfWidth, y: -halfHeight, width: 2 * halfWidth, height: 2 * halfHeight },
    };
}

/**
 * Clone a built-in definition and select its package without changing the library.
 * 'default' always restores the canonical footprint, even from a modified instance.
 * All old footprint/model metadata is removed; OBJ generation remains lazy and cached.
 * @param {object} definition
 * @param {string} packageId An option's value returned by getBuiltInPackageOptions.
 * @returns {object} Independent definition with packageId and a lazy model3dObj getter.
 * @throws {Error} For a non-built-in definition, unknown name, or unsupported package ID.
 */
export function withBuiltInPackage(definition, packageId) {
    if (!supported(definition)) throw new Error('Unsupported built-in component definition');
    if (!getBuiltInPackageOptions(definition).some(option => option.value === packageId)) {
        throw new Error(`Unsupported built-in package: ${packageId}`);
    }
    const result = {};
    for (const key of Object.keys(definition)) {
        if (/^(footprint|model3d)/i.test(key) || ['hasFootprint', 'has3d', 'packageId'].includes(key)) continue;
        result[key] = structuredClone(definition[key]);
    }
    if (packageId === 'default') {
        const canonical = defaults.get(definition.name);
        for (const key of Object.keys(canonical)) {
            if (/^footprint/i.test(key) || key === 'hasFootprint') result[key] = structuredClone(canonical[key]);
        }
    } else {
        const [, id] = choices[definition.name].find(([value]) => value === packageId);
        Object.assign(result, variantFootprint(definition.name, packageId, builtInPackageLayouts[id]));
    }
    Object.assign(result, { packageId, has3d: true, model3dUrl: null, model3dName: result.footprintName });
    Object.defineProperty(result, 'model3dObj', {
        enumerable: true,
        configurable: true,
        get() { return getBuiltInModel3D(result.footprint); },
    });
    return result;
}
