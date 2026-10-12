/**
 * Small, original package approximations in millimetres, mounted at Z = 0.
 * Authoring uses centred board-local XY; OBJ Y is reflected for the board viewer.
 * These visual models are not mechanical/manufacturing specifications.
 */
const cache = new Map();
// Through the standard 1.6 mm board, with 0.5 mm of lead beyond the opposite face.
const THROUGH_HOLE_LEAD_BOTTOM = -2.1;
const colors = {
    plastic: [35, 38, 43],
    metal: [180, 188, 198],
    gold: [211, 166, 57],
    ceramic: [192, 110, 40],
    resistor: [193, 167, 118],
    brown: [104, 55, 29],
    red: [193, 36, 32],
    green: [55, 111, 75],
    blue: [40, 77, 137],
    glass: [166, 70, 44],
    stripe: [216, 218, 205],
};

/**
 * @typedef {'plastic'|'metal'|'gold'|'ceramic'|'resistor'|'brown'|'red'|'green'|'blue'|'glass'|'stripe'} MaterialName
 * @typedef {[number, number]} Point2
 * @typedef {[number, number, number]} Vertex3
 * @typedef {number[]} Face
 * @typedef {(point: Vertex3) => Vertex3} VertexTransform
 * @typedef {[number, number, MaterialName]} Band
 * @typedef {(model: Model) => void} ModelBuilder
 * @typedef {'r'|'c'|'l'|'led'|'can'|'axial'|'led-th'|'diode'|'transistor'|'ic'|'header'|'terminal'|'switch'} PackageKind
 * @typedef {[number, number, number]} PackageBody
 * @typedef {[number, number, number, number, number]} PackagePad
 * @typedef {{label: string, kind: PackageKind, footprint: string, body: Readonly<PackageBody>, pads: ReadonlyArray<Readonly<PackagePad>>}} BuiltInPackageLayout
 */

class Model {
    constructor() {
        /** @type {Vertex3[]} */
        this.vertices = [];
        /** @type {string[]} */
        this.lines = Object.entries(colors).flatMap(([name, color]) => [
            `newmtl builtin_${name}`,
            `Kd ${color.map(value => (value / 255).toFixed(6)).join(' ')}`,
        ]);
    }

    // Every primitive is convex. Orient against its interior before reflecting Y.
    /**
     * @param {Vertex3[]} vertices
     * @param {Face[]} faces
     * @param {MaterialName|MaterialName[]} material
     */
    solid(vertices, faces, material) {
        const offset = this.vertices.length + 1;
        const centre = [0, 1, 2].map(axis =>
            vertices.reduce((sum, vertex) => sum + vertex[axis], 0) / vertices.length);
        this.vertices.push(...vertices);
        this.lines.push(...vertices.map(([x, y, z]) =>
            `v ${[x, -y, z].map(value => Number(value.toFixed(6))).join(' ')}`));
        /** @type {MaterialName|undefined} */
        let previousMaterial;
        faces.forEach((face, index) => {
            const color = Array.isArray(material) ? material[index] : material;
            if (color !== previousMaterial) {
                this.lines.push(`usemtl builtin_${color}`);
                previousMaterial = color;
            }
            const [a, b, c] = face.map(i => vertices[i]);
            const u = b.map((v, i) => v - a[i]);
            const v = c.map((value, i) => value - a[i]);
            const normal = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            const outward = normal.reduce((sum, value, i) => sum + value * (a[i] - centre[i]), 0) > 0;
            const indices = outward ? [...face].reverse() : face;
            this.lines.push(`f ${indices.map(i => i + offset).join(' ')}`);
        });
    }

    /**
     * @param {Point2[]} polygon
     * @param {number} bottom
     * @param {number} top
     * @param {MaterialName|MaterialName[]} material
     * @param {VertexTransform} [transform]
     */
    prism(polygon, bottom, top, material, transform = point => point) {
        const count = polygon.length;
        const vertices = [bottom, top].flatMap(z => polygon.map(([x, y]) => transform([x, y, z])));
        const faces = [
            Array.from({ length: count }, (_, i) => i),
            Array.from({ length: count }, (_, i) => count + i),
            ...polygon.map((_, i) => [i, (i + 1) % count, (i + 1) % count + count, i + count]),
        ];
        this.solid(vertices, faces, material);
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} bottom
     * @param {number} width
     * @param {number} depth
     * @param {number} top
     * @param {MaterialName} material
     */
    box(x, y, bottom, width, depth, top, material) {
        this.prism([
            [x - width / 2, y - depth / 2], [x + width / 2, y - depth / 2],
            [x + width / 2, y + depth / 2], [x - width / 2, y + depth / 2],
        ], bottom, top, material);
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} bottom
     * @param {number} radius
     * @param {number} top
     * @param {MaterialName|MaterialName[]} material
     * @param {number} [sides]
     * @param {VertexTransform} [transform]
     */
    round(x, y, bottom, radius, top, material, sides = 16, transform = point => point) {
        this.prism(Array.from({ length: sides }, (_, i) => [
            x + radius * Math.cos(i * 2 * Math.PI / sides),
            y + radius * Math.sin(i * 2 * Math.PI / sides),
        ]), bottom, top, material, transform);
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} top
     * @param {number} [radius]
     */
    pin(x, y, top, radius = 0.25) {
        this.round(x, y, THROUGH_HOLE_LEAD_BOTTOM, radius, top, 'metal', 8);
    }

    /**
     * @param {number} length
     * @param {number} radius
     * @param {number} height
     * @param {MaterialName} body
     * @param {Band[]} [bands]
     * @param {number} [halfPitch]
     */
    axial(length, radius, height, body, bands = [], halfPitch = 3.81) {
        const ends = [-length / 2, ...bands.flatMap(band => [band[0], band[1]]), length / 2];
        for (let i = 0; i < ends.length - 1; i++) {
            const material = i % 2 === 1 ? bands[(i - 1) / 2][2] : body;
            this.round(0, 0, ends[i], radius, ends[i + 1], material, 12,
                ([x, y, z]) => [z, x, y + height]);
        }
        for (const sign of [-1, 1]) {
            this.pin(sign * halfPitch, 0, height + 0.22, 0.22);
            const start = sign < 0 ? -halfPitch : length / 2;
            const end = sign < 0 ? -length / 2 : halfPitch;
            this.round(0, 0, start, 0.22, end, 'metal', 8,
                ([x, y, z]) => [z, x, y + height]);
        }
    }

    /**
     * @param {number} diameter
     */
    led(diameter) {
        const radius = diameter / 2;
        const shoulder = 0.8 + diameter * 0.6;
        this.pin(-1.27, 0, 1.1);
        this.pin(1.27, 0, 1.1);
        this.round(0, 0, 0.8, radius, shoulder, [
            'red', 'red',
            ...Array.from({ length: 16 }, (_, i) => i === 0 || i === 15 ? 'stripe' : 'red'),
        ]);
        // Three latitude rings and a single apex avoid degenerate pole faces.
        const sides = 16;
        /** @type {Vertex3[]} */
        const vertices = [0, Math.PI / 6, Math.PI / 3].flatMap(angle =>
            Array.from({ length: sides }, (_, i) => /** @type {Vertex3} */ ([
                radius * Math.cos(angle) * Math.cos(i * 2 * Math.PI / sides),
                radius * Math.cos(angle) * Math.sin(i * 2 * Math.PI / sides),
                shoulder + radius * Math.sin(angle),
            ])));
        vertices.push([0, 0, shoulder + radius]);
        /** @type {Face[]} */
        const faces = [Array.from({ length: sides }, (_, i) => i)];
        for (let ring = 0; ring < 2; ring++) {
            for (let i = 0; i < sides; i++) {
                const next = (i + 1) % sides;
                faces.push([ring * sides + i, ring * sides + next,
                    (ring + 1) * sides + next, (ring + 1) * sides + i]);
            }
        }
        for (let i = 0; i < sides; i++) faces.push([32 + i, 32 + (i + 1) % sides, 48]);
        this.solid(vertices, faces, 'red');
    }

    text() {
        return '# ClearPCB procedural package; millimetres; Z up\n' + this.lines.join('\n') + '\n';
    }
}

const builders = new Map(/** @type {Array<[string, ModelBuilder]>} */ ([
    ['Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal', model => {
        model.axial(6.3, 1.25, 1.65, 'resistor', [
            [-2.3, -1.9, 'brown'], [-1.25, -0.85, 'plastic'],
            [-0.2, 0.2, 'red'], [1.8, 2.15, 'gold'],
        ]);
    }],
    ['Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm', model => {
        model.round(0, 0, -1.25, 2.5, 1.25, 'ceramic', 16,
            ([x, y, z]) => [x, z, y + 3.5]);
        for (const sign of [-1, 1]) {
            model.pin(sign * 2.5, 0, 2);
            model.box(sign * 2.05, 0, 1.7, 0.9, 0.5, 2.2, 'metal');
        }
    }],
    ['Capacitor_THT:CP_Radial_D5.0mm_P2.50mm', model => {
        model.pin(-1.25, 0, 1);
        model.pin(1.25, 0, 1);
        model.round(0, 0, 0.7, 2.5, 6.4, [
            'blue', 'blue',
            ...Array.from({ length: 16 }, (_, i) => i === 0 || i === 15 ? 'stripe' : 'blue'),
        ]);
        model.round(0, 0, 6.4, 2.5, 6.7, 'metal');
        // A negative-side stripe stays inside the can's XY bounds.
        model.box(1.8, 0, 6.7, 0.5, 2, 6.72, 'stripe');
        model.box(0, 0, 6.7, 0.09, 3.2, 6.72, 'plastic');
        model.box(0, 0, 6.7, 3, 0.09, 6.72, 'plastic');
    }],
    ['Inductor_THT:L_Axial_L6.8mm_D2.4mm_P7.62mm_Horizontal_Vertical', model => {
        model.axial(6.8, 1.2, 1.6, 'green', [
            [-2.3, -1.9, 'brown'], [-1.1, -0.7, 'plastic'],
            [0.1, 0.5, 'brown'], [2, 2.35, 'stripe'],
        ]);
    }],
    ['Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal', model => {
        model.axial(4, 0.9, 1.3, 'glass', [[1.05, 1.55, 'plastic']]);
    }],
    ['LED_THT:LED_D5.0mm', model => model.led(5)],
    ['Package_TO_SOT_THT:TO-92_Inline', model => {
        for (const x of [-1.27, 0, 1.27]) model.pin(x, 0, 2, 0.22);
        model.prism(Array.from({ length: 13 }, (_, i) => [
            2.3 * Math.cos(i * Math.PI / 12), 3 * Math.sin(i * Math.PI / 12) - 1.5,
        ]), 1.5, 5.7, 'plastic');
    }],
    ['Package_DIP:DIP-8_W7.62mm', model => {
        model.box(0, 0, 1, 6.3, 9.4, 3.5, 'plastic');
        for (const x of [-3.81, 3.81]) {
            for (const y of [-3.81, -1.27, 1.27, 3.81]) {
                model.box(x, y, THROUGH_HOLE_LEAD_BOTTOM, 0.3, 0.55, 1.9, 'metal');
                model.box(Math.sign(x) * 3.45, y, 1.65, 0.9, 0.55, 1.95, 'metal');
            }
        }
        model.round(-2.1, -3.6, 3.5, 0.35, 3.53, 'stripe', 12);
        model.box(0, -4.15, 3.5, 1.2, 0.55, 3.53, 'stripe');
    }],
    ['Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical', model => {
        model.box(0, 0, 0.1, 2.54, 5.08, 2.5, 'plastic');
        for (const y of [-1.27, 1.27]) model.box(0, y, THROUGH_HOLE_LEAD_BOTTOM, 0.64, 0.64, 8.3, 'gold');
    }],
    ['Button_Switch_THT:SW_PUSH_6mm', model => {
        model.box(0, 0, 0.5, 6, 6, 3, 'plastic');
        model.box(0, 0, 3, 5.7, 5.7, 3.3, 'metal');
        model.round(0, 0, 3.3, 1.65, 4.8, 'plastic', 16);
        for (const x of [-3.25, 3.25]) {
            for (const y of [-2.25, 2.25]) {
                model.box(x, y, THROUGH_HOLE_LEAD_BOTTOM, 0.5, 0.5, 1.4, 'metal');
            }
        }
    }],
    ['Package_TO_SOT_SMD:SOT-23', model => {
        model.box(0, 0, 0.2, 2.9, 1.3, 1.3, 'plastic');
        for (const [x, y] of [[-0.95, 1.1], [0.95, 1.1], [0, -1.1]]) {
            model.box(x, y, 0, 0.45, 0.6, 0.2, 'metal');
            model.box(x, Math.sign(y) * 0.8, 0.15, 0.45, 0.5, 0.65, 'metal');
        }
    }],
]));

// Shared, immutable dimensions for the package catalogue and its visual models.
// Pads: [x, y, width, height, drill]. Layouts are generic, not vendor land patterns.
/** @type {Record<string, BuiltInPackageLayout>} */
const layouts = Object.create(null);
/**
 * @param {string} id
 * @param {string} label
 * @param {PackageKind} kind
 * @param {PackageBody} body
 * @param {PackagePad[]} pads
 * @param {string} [footprint]
 */
function layout(id, label, kind, body, pads, footprint = `ClearPCB:${id}`) {
    layouts[id] = Object.freeze({
        label, kind, footprint, body: Object.freeze(body),
        pads: Object.freeze(pads.map(pad => Object.freeze(pad))),
    });
}
/** @type {Array<[string, number, number]>} */
const chipSizes = [
    ['0402', 1, 0.5], ['0603', 1.6, 0.8], ['0805', 2, 1.25],
    ['1206', 3.2, 1.6], ['1210', 3.2, 2.5], ['2010', 5, 2.5], ['2512', 6.3, 3.2],
];
for (const [size, length, width] of chipSizes) {
    for (const kind of /** @type {PackageKind[]} */ (['r', 'c', 'l', 'led'])) {
        if (kind === 'l' && !['0603', '0805', '1206', '1210'].includes(size)) continue;
        if (kind === 'led' && !['0603', '0805', '1206'].includes(size)) continue;
        layout(`${kind}-${size}`, `${size} inch (${length} × ${width} mm) SMT`, kind,
            [length, width, Math.min(1.8, Math.max(0.35, width * (kind === 'r' ? 0.3 : 0.65)))],
            [-1, 1].map(sign => [sign * length * 0.4, 0, Math.max(0.55, length * 0.25), width + 0.25, 0]));
    }
}
for (const diameter of [4, 5, 6.3]) {
    layout(`can-${diameter}`, `Electrolytic Ø${diameter} mm SMT`, 'can',
        [diameter, diameter, diameter + 1],
        [-1, 1].map(sign => [sign * (diameter / 2 + 0.3), 0, 1.5, 1.3, 0]));
}
layout('do41', 'DO-41 axial, 10.16 mm pitch TH', 'axial', [5.2, 2.7, 3.1],
    [[-5.08, 0, 1.8, 1.8, 0.8], [5.08, 0, 1.8, 1.8, 0.8]]);
for (const [id, label, length, width, height] of /** @type {Array<[string, string, number, number, number]>} */ ([
    ['sod123', 'SOD-123', 2.7, 1.6, 1.1],
    ['sod323', 'SOD-323', 1.7, 1.25, 0.9],
    ['sma', 'SMA (DO-214AC)', 4.5, 2.6, 2.1],
])) {
    layout(id, `${label} SMT`, 'diode', [length, width, height],
        [-1, 1].map(sign => [sign * (length / 2 + 0.35), 0, 1, width * 0.7, 0]));
}
layout('led3', 'LED Ø3 mm, 2.54 mm pitch TH', 'led-th', [3, 3, 4.1],
    [[-1.27, 0, 1.8, 1.8, 0.8], [1.27, 0, 1.8, 1.8, 0.8]]);
layout('to92', 'TO-92 inline TH', 'transistor', [4.6, 3, 5.7],
    [-1.27, 0, 1.27].map(x => [x, 0, 1.4, 1.4, 0.8]),
    'Package_TO_SOT_THT:TO-92_Inline');
layout('sot23', 'SOT-23 SMT', 'transistor', [2.9, 2.8, 1.3],
    [[-0.95, 1.1, 1, 0.6, 0], [0.95, 1.1, 1, 0.6, 0], [0, -1.1, 1, 0.6, 0]],
    'Package_TO_SOT_SMD:SOT-23');
for (const [id, label, width, length, height, x, pitch, padWidth, padHeight] of /** @type {Array<[string, string, ...number[]]>} */ ([
    ['soic8', 'SOIC-8, 1.27 mm pitch SMT', 3.9, 4.9, 1.5, 2.7, 1.27, 1.4, 0.6],
    ['tssop8', 'TSSOP-8, 0.65 mm pitch SMT', 4.4, 3, 1.1, 3, 0.65, 1.4, 0.4],
])) {
    layout(id, label, 'ic', [width, length, height], [
        ...[-1.5, -0.5, 0.5, 1.5].map(y => /** @type {PackagePad} */ ([-x, y * pitch, padWidth, padHeight, 0])),
        ...[1.5, 0.5, -0.5, -1.5].map(y => /** @type {PackagePad} */ ([x, y * pitch, padWidth, padHeight, 0])),
    ]);
}
layout('header-smt', '1×02 header, 2.54 mm pitch SMT', 'header', [2.54, 5.08, 8.3],
    [[0, -1.27, 2.4, 1.2, 0], [0, 1.27, 2.4, 1.2, 0]]);
layout('terminal-5.08', '2-way screw terminal, 5.08 mm pitch TH', 'terminal', [10, 7, 9.3],
    [[-2.54, 0, 2.4, 2.4, 0.8], [2.54, 0, 2.4, 2.4, 0.8]]);
layout('switch-smt', '6×6 mm tactile switch SMT', 'switch', [6, 6, 4.8],
    [[-3.8, -2.25], [3.8, -2.25], [-3.8, 2.25], [3.8, 2.25]].map(([x, y]) => [x, y, 1.8, 1.1, 0]));

/** @internal Shared by BuiltInPackages; values and their nested arrays are immutable. */
export const builtInPackageLayouts = Object.freeze(layouts);

/**
 * @param {Model} model
 * @param {BuiltInPackageLayout} entry
 */
function buildVariant(model, { kind, body: [width, depth, height], pads }) {
    if (kind === 'r' || kind === 'c' || kind === 'l' || kind === 'led') {
        // The centre and two 20% end caps meet without coplanar surface overlap.
        const bodyMaterial = /** @type {Record<'r'|'c'|'l'|'led', MaterialName>} */ (
            { r: 'plastic', c: 'ceramic', l: 'green', led: 'stripe' })[kind];
        model.box(0, 0, 0.04, width * 0.6, depth, height,
            bodyMaterial);
        for (const [x, y] of pads) model.box(x, y, 0, width * 0.2, depth, height, 'metal');
        if (kind === 'led') {
            model.box(0, 0, height, width * 0.4, depth * 0.7, height + 0.12, 'red');
            model.box(width * 0.25, 0, height, width * 0.08, depth * 0.7, height + 0.13, 'plastic');
        }
    } else if (kind === 'axial') {
        model.axial(width, depth / 2, 1.75, 'plastic', [[1.3, 1.9, 'stripe']], 5.08);
    } else if (kind === 'led-th') {
        model.led(width);
    } else if (kind === 'diode' || kind === 'can') {
        for (const [x, y, , padDepth] of pads) {
            model.box(x, y, 0, 0.8, padDepth * 0.7, 0.25, 'metal');
            model.box(Math.sign(x) * width / 2, 0, 0.15, 1, padDepth * 0.7, 0.5, 'metal');
        }
        if (kind === 'can') {
            model.box(0, 0, 0.25, width, depth, 0.65, 'plastic');
            model.round(0, 0, 0.65, width / 2, height, [
                'metal', 'metal',
                ...Array.from({ length: 16 }, (_, i) => i === 0 || i === 15 ? 'plastic' : 'metal'),
            ]);
            model.box(width * 0.3, 0, height, width * 0.1, width * 0.45, height + 0.02, 'plastic');
        } else {
            model.box(0, 0, 0.25, width, depth, height, 'plastic');
            model.box(width * 0.32, 0, height, width * 0.12, depth * 0.95, height + 0.02, 'stripe');
        }
    } else if (kind === 'ic') {
        model.box(0, 0, 0.2, width, depth, height, 'plastic');
        for (const [x, y, , padDepth] of pads) {
            model.box(x, y, 0, 0.8, padDepth * 0.75, 0.18, 'metal');
            const inner = width / 2 - 0.1, outer = Math.abs(x);
            model.box(Math.sign(x) * (inner + outer) / 2, y, 0.15,
                outer - inner, padDepth * 0.75, 0.65, 'metal');
        }
        model.round(-width * 0.3, -depth * 0.35, height, 0.2, height + 0.02, 'stripe', 12);
    } else if (kind === 'header') {
        model.box(0, 0, 0.3, width, depth, 2.5, 'plastic');
        for (const [x, y] of pads) {
            model.box(x, y, 0, 1.8, 0.64, 0.3, 'gold');
            model.box(x, y, 0.2, 0.64, 0.64, height, 'gold');
        }
    } else if (kind === 'terminal') {
        model.box(0, 0, 0.5, width, depth, height - 0.5, 'green');
        for (const [x, y] of pads) {
            model.pin(x, y, 1, 0.3);
            model.round(x, y, height - 0.5, 1.5, height, 'metal', 12);
            model.box(x, y, height, 2.1, 0.2, height + 0.02, 'plastic');
        }
    } else if (kind === 'switch') {
        model.box(0, 0, 0.5, width, depth, 3, 'plastic');
        model.box(0, 0, 3, 5.7, 5.7, 3.3, 'metal');
        model.round(0, 0, 3.3, 1.65, height, 'plastic');
        for (const [x, y] of pads) {
            model.box(x, y, 0, 1.3, 0.6, 0.2, 'metal');
            model.box(Math.sign(x) * 3.1, y, 0.15, 1.4, 0.6, 1.4, 'metal');
        }
    }
}
for (const entry of Object.values(layouts)) {
    if (!builders.has(entry.footprint)) builders.set(entry.footprint, model => buildVariant(model, entry));
}

/**
 * Return a lazily generated, cached OBJ string for an exact built-in footprint ID.
 * Unsupported IDs throw; callers can fall back to their usual model provider.
 * No external assets, renderer objects, or browser state are required.
 * @param {string} footprint
 * @returns {string}
 */
export function getBuiltInModel3D(footprint) {
    const build = builders.get(footprint);
    if (!build) throw new Error(`Unsupported built-in 3D footprint: ${footprint}`);
    let cached = cache.get(footprint);
    if (cached === undefined) {
        const model = new Model();
        build(model);
        cached = model.text();
        cache.set(footprint, cached);
    }
    return cached;
}
