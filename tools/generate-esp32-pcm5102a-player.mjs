import { writeFile } from 'node:fs/promises';
import { zip, strToU8 } from '../assets/vendor/fflate.module.js';

const output = new URL('../ESP32-PCM5102A-Audio-Player.cpcb', import.meta.url);
const defs = {};
const components = [];
const shapes = [];
let componentCounter = 0;
let wireCounter = 0;

const pin = (number, name, x, y, orientation, type = 'passive') => ({
    number: String(number), name, showNumber: true, x, y, orientation,
    length: 0, type, shape: 'line',
    namePos: { x: x + (orientation === 'left' ? 0.8 : -0.8), y: y - 0.45,
        anchor: orientation === 'left' ? 'start' : 'end' },
});

function define(name, options) {
    defs[name] = {
        name,
        category: options.category || 'Audio Player',
        description: options.description || name,
        defaultReference: options.defaultReference || 'U?',
        defaultValue: options.defaultValue || name,
        defaultProperties: options.defaultProperties || {},
        _source: 'Generated',
        symbol: {
            width: options.width,
            height: options.height,
            origin: { x: 0, y: 0 },
            graphics: [
                { type: 'rect', x: -options.width / 2, y: -options.height / 2,
                    width: options.width, height: options.height,
                    stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                { type: 'text', x: 0, y: -options.height / 2 - 1.6,
                    text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' },
                { type: 'text', x: 0, y: options.height / 2 + 1.6,
                    text: '${VALUE}', fontSize: 1.1, anchor: 'middle', baseline: 'middle' },
                ...(options.graphics || []),
            ],
            pins: options.pins,
        },
        footprintName: options.footprintName,
        footprintShapes: options.footprintShapes || [],
        footprintBBox: options.footprintBBox,
    };
}

function add(definitionName, reference, value, x, y, properties = {}) {
    const id = `comp_${++componentCounter}`;
    components.push({
        type: 'component', id, dn: definitionName, x, y,
        ref: reference, val: value, props: properties,
    });
    return { id, def: defs[definitionName], x, y, reference };
}

function endpoint(component, pinNumber) {
    const index = component.def.symbol.pins.findIndex((p) => p.number === String(pinNumber));
    if (index < 0) throw new Error(`${component.reference}: pin ${pinNumber} not found`);
    const p = component.def.symbol.pins[index];
    return { componentId: component.id, pinNumber: String(pinNumber), x: component.x + p.x, y: component.y + p.y };
}

function wire(net, connections) {
    const points = connections.map(([component, pinNumber]) => endpoint(component, pinNumber));
    const nd = {};
    const ed = {};
    const pc = {};
    const busX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    let nodeIndex = 0;
    let edgeIndex = 0;
    const addNode = (x, y, connection = null) => {
        const id = `n${nodeIndex++}`;
        nd[id] = [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
        if (connection) pc[id] = { componentId: connection.componentId, pinNumber: connection.pinNumber };
        return id;
    };
    const busNodes = [];
    for (const point of points) {
        const terminal = addNode(point.x, point.y, point);
        if (Math.abs(point.x - busX) < 1e-6) {
            busNodes.push({ id: terminal, y: point.y });
        } else {
            const bend = addNode(busX, point.y);
            ed[`e${edgeIndex++}`] = [terminal, bend];
            busNodes.push({ id: bend, y: point.y });
        }
    }
    busNodes.sort((a, b) => a.y - b.y);
    for (let i = 1; i < busNodes.length; i++) {
        if (Math.abs(busNodes[i].y - busNodes[i - 1].y) > 1e-6) {
            ed[`e${edgeIndex++}`] = [busNodes[i - 1].id, busNodes[i].id];
        }
    }
    shapes.push({
        type: 'wire', id: `shape_${++wireCounter}`, lw: 0.254,
        nd, ed, pc, wl: `W${String(wireCounter).padStart(4, '0')}`, n: net,
    });
}

function twoPinDefinition(name, defaultReference, defaultValue, body = 'rect', footprintName = '0603') {
    const graphics = body === 'switch'
        ? [{ type: 'line', x1: -1.2, y1: 0, x2: 1.2, y2: -1.0, stroke: '#000000', strokeWidth: 0.254 }]
        : body === 'led'
            ? [{ type: 'polygon', points: [[-1.1, -1], [-1.1, 1], [0.8, 0]], stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                { type: 'line', x1: 0.8, y1: -1, x2: 0.8, y2: 1, stroke: '#000000', strokeWidth: 0.254 }]
            : [];
    define(name, {
        width: 5.08, height: 3.0, defaultReference, defaultValue, graphics,
        pins: [pin('1', body === 'led' ? 'A' : '1', -2.54, 0, 'left'), pin('2', body === 'led' ? 'K' : '2', 2.54, 0, 'right')],
        footprintName,
        footprintShapes: ['PAD~RECT~0~0~1.1~1.0~1~top', 'PAD~RECT~1.6~0~1.1~1.0~2~top'],
        footprintBBox: { x: -0.6, y: -0.7, width: 2.8, height: 1.4 },
    });
}

twoPinDefinition('R_0603', 'R?', '10k');
twoPinDefinition('C_0603', 'C?', '100nF');
twoPinDefinition('C_0805', 'C?', '2.2uF', 'rect', 'C_0805');
twoPinDefinition('SW_TACT', 'SW?', 'Button', 'switch', 'SW_SPST_TL3301AN');
twoPinDefinition('LED_0603', 'D?', 'POWER GREEN', 'led', 'LED_0603');
twoPinDefinition('FUSE_1206', 'F?', '500mA PTC', 'rect', 'Fuse_1206');
twoPinDefinition('FERRITE_0603', 'FB?', '600R@100MHz', 'rect', 'L_0603');
twoPinDefinition('TVS_5V', 'D?', 'USBLC6/5V TVS', 'rect', 'SOD-323');

define('USB_C_USB2', {
    width: 12, height: 13, defaultReference: 'J?', defaultValue: 'USB-C USB2.0',
    pins: [
        pin('VBUS', 'VBUS', 6, -4, 'right', 'power'), pin('GND', 'GND', 6, 4, 'right', 'power'),
        pin('CC1', 'CC1', -6, -3, 'left'), pin('CC2', 'CC2', -6, 0, 'left'),
        pin('D+', 'D+', -6, 3, 'left'), pin('D-', 'D-', -6, 5, 'left'),
    ],
    footprintName: 'USB_C_Receptacle_USB2.0_16P',
    footprintShapes: [
        'PAD~RECT~0~0~0.6~1.2~VBUS~top', 'PAD~RECT~0.8~0~0.6~1.2~GND~top',
        'PAD~RECT~1.6~0~0.6~1.2~CC1~top', 'PAD~RECT~2.4~0~0.6~1.2~D+~top',
        'PAD~RECT~3.2~0~0.6~1.2~D-~top', 'PAD~RECT~4.0~0~0.6~1.2~CC2~top',
    ],
    footprintBBox: { x: -1, y: -4, width: 10, height: 8 },
});

define('AP2112K_3V3', {
    width: 7, height: 8, defaultReference: 'U?', defaultValue: 'AP2112K-3.3',
    pins: [pin('1', 'VIN', -3.5, -2, 'left', 'power'), pin('3', 'EN', -3.5, 2, 'left', 'input'),
        pin('5', 'VOUT', 3.5, -2, 'right', 'power'), pin('2', 'GND', 3.5, 2, 'right', 'power'),
        pin('4', 'NC', 3.5, 0, 'right')],
    footprintName: 'SOT-23-5',
    footprintShapes: ['PAD~RECT~0~0~0.7~1.0~1~top', 'PAD~RECT~0~0.95~0.7~1.0~2~top', 'PAD~RECT~0~1.9~0.7~1.0~3~top',
        'PAD~RECT~2.0~1.9~0.7~1.0~4~top', 'PAD~RECT~2.0~0~0.7~1.0~5~top'],
    footprintBBox: { x: -0.5, y: -0.5, width: 3, height: 3 },
});

const espPins = [
    ['3V3', '3V3', -8, -7], ['GND', 'GND', -8, 7], ['EN', 'EN', -8, -4], ['GPIO0', 'GPIO0/BOOT', -8, 4],
    ['GPIO19', 'USB D-', -8, -1], ['GPIO20', 'USB D+', -8, 1],
    ['GPIO4', 'I2S BCK', 8, -6], ['GPIO5', 'I2S LRCK', 8, -4], ['GPIO6', 'I2S DATA', 8, -2],
    ['GPIO7', 'DAC MUTE', 8, 0], ['GPIO14', 'REW', 8, 2], ['GPIO27', 'FFD', 8, 4],
    ['GPIO32', 'PLAY/PAUSE', 8, 6], ['GPIO33', 'STOP', 8, 8],
].map(([number, name, x, y]) => pin(number, name, x, y, x < 0 ? 'left' : 'right', String(number).startsWith('GPIO') ? 'bidirectional' : 'power'));
define('ESP32_S3_WROOM_1', {
    width: 16, height: 18, defaultReference: 'U?', defaultValue: 'ESP32-S3-WROOM-1', pins: espPins,
    footprintName: 'ESP32-S3-WROOM-1',
    footprintShapes: espPins.map((p, i) => `PAD~RECT~${i < 6 ? 0 : 16}~${(i % 8) * 1.27}~1.5~0.9~${p.number}~top`),
    footprintBBox: { x: -1, y: -1, width: 18, height: 12 },
});

const pcmPinData = [
    ['1', 'CPVDD', -8, -8], ['2', 'CAPP', -8, -6], ['3', 'CAPM', -8, -4], ['4', 'VNEG', -8, -2],
    ['7', 'AVDD', -8, 0], ['8', 'AGND', -8, 2], ['9', 'DEMP', -8, 4], ['10', 'FLT', -8, 6],
    ['11', 'SCK', -8, 8], ['12', 'BCK', 8, -8], ['13', 'DIN', 8, -6], ['14', 'LRCK', 8, -4],
    ['15', 'XSMT', 8, -2], ['16', 'DGND', 8, 0], ['17', 'DVDD', 8, 2], ['18', 'LDOO', 8, 4],
    ['19', 'PGND', 8, 6], ['20', 'OUTL', 8, 8], ['6', 'OUTR', 8, 10], ['5', 'AGND', -8, 10],
];
define('PCM5102A', {
    width: 16, height: 21, defaultReference: 'U?', defaultValue: 'PCM5102APWR',
    pins: pcmPinData.map(([number, name, x, y]) => pin(number, name, x, y, x < 0 ? 'left' : 'right', name.startsWith('OUT') ? 'output' : 'passive')),
    footprintName: 'TSSOP-20_4.4x6.5mm_P0.65mm',
    footprintShapes: Array.from({ length: 20 }, (_, i) => {
        const left = i < 10;
        const n = i + 1;
        return `PAD~RECT~${left ? 0 : 6.4}~${(left ? i : 19 - i) * 0.65}~1.5~0.4~${n}~top`;
    }),
    footprintBBox: { x: -0.8, y: -0.5, width: 8, height: 7 },
});

define('AUDIO_JACK_STEREO', {
    width: 8, height: 9, defaultReference: 'J?', defaultValue: '3.5mm Stereo Out',
    pins: [pin('L', 'LEFT', -4, -2.5, 'left'), pin('R', 'RIGHT', -4, 0, 'left'), pin('G', 'GND', -4, 2.5, 'left')],
    footprintName: 'AudioJack3_Ground',
    footprintShapes: ['PAD~ELLIPSE~0~0~2~2~L', 'PAD~ELLIPSE~5~0~2~2~R', 'PAD~ELLIPSE~2.5~5~2~2~G'],
    footprintBBox: { x: -1, y: -1, width: 7, height: 7 },
});

// Functional blocks.
const usb = add('USB_C_USB2', 'J1', 'USB-C POWER + USB', -85, -15);
const fuse = add('FUSE_1206', 'F1', '500mA PTC', -68, -19);
const tvs = add('TVS_5V', 'D1', 'SMBJ5.0A', -58, -5);
const cc1 = add('R_0603', 'R1', '5.1k CC1', -72, -4);
const cc2 = add('R_0603', 'R2', '5.1k CC2', -72, 2);
const usbDp = add('R_0603', 'R3', '22R USB D+', -57, 0);
const usbDm = add('R_0603', 'R4', '22R USB D-', -57, 6);
const ldo = add('AP2112K_3V3', 'U1', 'AP2112K-3.3', -42, -18);
const cin = add('C_0805', 'C1', '10uF', -48, -7);
const cout = add('C_0805', 'C2', '10uF', -34, -7);
const esp = add('ESP32_S3_WROOM_1', 'U2', 'ESP32-S3-WROOM-1', -16, -8);
const enR = add('R_0603', 'R5', '10k EN pull-up', -33, 6);
const enC = add('C_0805', 'C3', '1uF EN delay', -23, 10);
const bootR = add('R_0603', 'R6', '10k BOOT pull-up', -33, 18);
const bootSw = add('SW_TACT', 'SW6', 'BOOT', -21, 18);
const resetSw = add('SW_TACT', 'SW7', 'RESET', -21, 6);
const espDec = add('C_0603', 'C4', '100nF ESP32', -6, 10);
const espBulk = add('C_0805', 'C5', '10uF ESP32', 4, 10);

const fb = add('FERRITE_0603', 'FB1', '600R@100MHz', 10, -18);
const pcm = add('PCM5102A', 'U3', 'PCM5102APWR', 31, -8);
const pcmCp = add('C_0603', 'C6', '100nF CPVDD', 12, -2);
const pcmAv = add('C_0603', 'C7', '100nF AVDD', 12, 4);
const pcmDv = add('C_0603', 'C8', '100nF DVDD', 53, -1);
const pump = add('C_0805', 'C9', '2.2uF CAPP-CAPM', 14, -10);
const vneg = add('C_0805', 'C10', '2.2uF VNEG', 16, 12);
const ldoo = add('C_0805', 'C11', '1uF LDOO', 52, 8);
const muteR = add('R_0603', 'R7', '10k XSMT pull-up', 53, -8);

const outLR = add('R_0603', 'R8', '470R LEFT', 58, -15);
const outLC = add('C_0603', 'C12', '2.2nF LEFT', 68, -8);
const outRR = add('R_0603', 'R9', '470R RIGHT', 58, -2);
const outRC = add('C_0603', 'C13', '2.2nF RIGHT', 68, 5);
const jack = add('AUDIO_JACK_STEREO', 'J2', 'LINE OUT', 84, -8);

const ledR = add('R_0603', 'R10', '1k', -4, 23);
const led = add('LED_0603', 'D2', 'POWER GREEN', 8, 23);

const buttonNames = ['PLAY/PAUSE', 'STOP', 'FFD', 'REW'];
const buttonGpios = ['GPIO32', 'GPIO33', 'GPIO27', 'GPIO14'];
const buttons = buttonNames.map((name, i) => ({
    sw: add('SW_TACT', `SW${i + 1}`, name, 16 + i * 18, 30),
    pull: add('R_0603', `R${11 + i}`, `10k ${name}`, 16 + i * 18, 21),
    cap: add('C_0603', `C${14 + i}`, `100nF ${name}`, 16 + i * 18, 38),
    gpio: buttonGpios[i],
}));

// Power and ground distribution.
wire('VBUS_RAW', [[usb, 'VBUS'], [fuse, '1']]);
wire('+5V_FUSED', [[fuse, '2'], [ldo, '1'], [ldo, '3'], [cin, '1'], [tvs, '1']]);
wire('+3V3', [[ldo, '5'], [cout, '1'], [esp, '3V3'], [enR, '1'], [bootR, '1'], [espDec, '1'], [espBulk, '1'],
    [fb, '1'], [muteR, '1'], [ledR, '1'], ...buttons.map((b) => [b.pull, '1'])]);
wire('+3V3_A', [[fb, '2'], [pcm, '1'], [pcm, '7'], [pcm, '17'], [pcmCp, '1'], [pcmAv, '1'], [pcmDv, '1']]);
wire('GND', [[usb, 'GND'], [ldo, '2'], [cin, '2'], [cout, '2'], [tvs, '2'], [cc1, '2'], [cc2, '2'],
    [esp, 'GND'], [enC, '2'], [bootSw, '2'], [resetSw, '2'], [espDec, '2'], [espBulk, '2'],
    [pcm, '5'], [pcm, '8'], [pcm, '9'], [pcm, '10'], [pcm, '11'], [pcm, '16'], [pcm, '19'],
    [pcmCp, '2'], [pcmAv, '2'], [pcmDv, '2'],
    [vneg, '2'], [ldoo, '2'], [outLC, '2'], [outRC, '2'], [jack, 'G'], [led, '2'],
    ...buttons.flatMap((b) => [[b.sw, '2'], [b.cap, '2']])]);

wire('USB_CC1', [[usb, 'CC1'], [cc1, '1']]);
wire('USB_CC2', [[usb, 'CC2'], [cc2, '1']]);
wire('USB_D_PLUS', [[usb, 'D+'], [usbDp, '1']]);
wire('USB_D_PLUS_MCU', [[usbDp, '2'], [esp, 'GPIO20']]);
wire('USB_D_MINUS', [[usb, 'D-'], [usbDm, '1']]);
wire('USB_D_MINUS_MCU', [[usbDm, '2'], [esp, 'GPIO19']]);
wire('ESP_EN', [[enR, '2'], [enC, '1'], [resetSw, '1'], [esp, 'EN']]);
wire('ESP_BOOT', [[bootR, '2'], [bootSw, '1'], [esp, 'GPIO0']]);
wire('I2S_BCK', [[esp, 'GPIO4'], [pcm, '12']]);
wire('I2S_LRCK', [[esp, 'GPIO5'], [pcm, '14']]);
wire('I2S_DATA', [[esp, 'GPIO6'], [pcm, '13']]);
wire('DAC_MUTE', [[esp, 'GPIO7'], [pcm, '15'], [muteR, '2']]);
wire('DAC_CAPP', [[pcm, '2'], [pump, '1']]);
wire('DAC_CAPM', [[pcm, '3'], [pump, '2']]);
wire('DAC_VNEG', [[pcm, '4'], [vneg, '1']]);
wire('DAC_LDOO', [[pcm, '18'], [ldoo, '1']]);
wire('AUDIO_LEFT_RAW', [[pcm, '20'], [outLR, '1']]);
wire('AUDIO_LEFT', [[outLR, '2'], [outLC, '1'], [jack, 'L']]);
wire('AUDIO_RIGHT_RAW', [[pcm, '6'], [outRR, '1']]);
wire('AUDIO_RIGHT', [[outRR, '2'], [outRC, '1'], [jack, 'R']]);
wire('POWER_LED', [[ledR, '2'], [led, '1']]);
for (const button of buttons) {
    wire(`BTN_${button.reference || button.sw.reference}`, [[esp, button.gpio], [button.pull, '2'], [button.sw, '1'], [button.cap, '1']]);
}

const doc = {
    version: '2.0', type: 'clearpcb-project', created: new Date().toISOString(),
    schematic: {
        settings: {
            gridSize: 1.27, units: 'mm', paperSize: 'A3', paperOrientation: 'landscape',
            titleBlock: true, titleBlockInfo: true,
            titleBlockData: {
                title: 'ESP32-S3 PCM5102A Audio Player', rev: 'A',
                company: 'ClearPCB Generated Reference Design', drawnBy: 'Automation',
                date: new Date().toISOString().slice(0, 10), sheet: '1/1',
            },
        },
        shapes, components, defs,
    },
    pcb: {
        board: { width: 120, height: 80, radius: 3 },
        design: { trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.7, viaDrill: 0.35, units: 'mm', router: 'maze' },
        tracks: [], vias: [], holes: [], boardShapes: [], texts: [], placements: {},
    },
};

const entries = {
    'manifest.json': strToU8(JSON.stringify({ format: 'clearpcb-zip', version: 1, models: {} })),
    'options.json': strToU8(JSON.stringify({ version: doc.version, type: doc.type, created: doc.created })),
    'schematic.json': strToU8(JSON.stringify(doc.schematic)),
    'pcb.json': strToU8(JSON.stringify(doc.pcb)),
};
const bytes = await new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (error, data) => error ? reject(error) : resolve(data));
});
await writeFile(output, bytes);
console.log(`Created ${output.pathname}`);
console.log(`${components.length} components, ${shapes.length} connected nets, ${Object.keys(defs).length} definitions`);
