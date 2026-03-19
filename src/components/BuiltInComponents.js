/**
 * Built-in Component Library
 * 
 * Basic electronic component symbols for ClearPCB
 * All dimensions in mm
 */

export const BuiltInComponents = [
    // ============ PASSIVE COMPONENTS ============
    
    {
        name: 'Resistor',
        description: 'Standard resistor symbol (US style)',
        category: 'Passive Components',
        keywords: ['R', 'res', 'ohm'],
        defaultReference: 'R?',
        defaultValue: '10k',
        symbol: {
            width: 7.62,
            height: 2.54,
            origin: { x: 3.81, y: 1.27 },
            graphics: [
                // Zigzag body (US style)
                { type: 'polyline', points: [
                    [-3.81, 0], [-3.048, 0], [-2.54, -1.016], [-1.524, 1.016], 
                    [-0.508, -1.016], [0.508, 1.016], [1.524, -1.016], [2.54, 1.016],
                    [3.048, 0], [3.81, 0]
                ], stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Reference text
                { type: 'text', x: 0, y: -2, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' },
                // Value text  
                { type: 'text', x: 0, y: 2.5, text: '${VALUE}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: '1', x: -3.81, y: 0, orientation: 'left', length: 0, type: 'passive', shape: 'line', namePos: { x: -3.81, y: -0.9, anchor: 'middle' } },
                { number: '', name: '2', x: 3.81, y: 0, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 3.81, y: -0.9, anchor: 'middle' } }
            ]
        },
        footprint: null  // Generic, user selects
    },
    
    {
        name: 'Resistor_IEC',
        description: 'Standard resistor symbol (IEC/European style)',
        category: 'Passive Components',
        keywords: ['R', 'res', 'ohm', 'european'],
        defaultReference: 'R?',
        defaultValue: '10k',
        symbol: {
            width: 7.62,
            height: 2.54,
            origin: { x: 3.81, y: 1.27 },
            graphics: [
                // Rectangle body (IEC style)
                { type: 'rect', x: -2.54, y: -0.762, width: 5.08, height: 1.524, stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Lead lines
                { type: 'line', x1: -3.81, y1: 0, x2: -2.54, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 2.54, y1: 0, x2: 3.81, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Reference text
                { type: 'text', x: 0, y: -2, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' },
                // Value text  
                { type: 'text', x: 0, y: 2.5, text: '${VALUE}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: '1', x: -3.81, y: 0, orientation: 'left', length: 0, type: 'passive', shape: 'line', namePos: { x: -3.81, y: -0.9, anchor: 'middle' } },
                { number: '', name: '2', x: 3.81, y: 0, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 3.81, y: -0.9, anchor: 'middle' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'Capacitor',
        description: 'Non-polarized capacitor',
        category: 'Passive Components',
        keywords: ['C', 'cap', 'farad'],
        defaultReference: 'C?',
        defaultValue: '100nF',
        symbol: {
            width: 5.08,
            height: 3.048,
            origin: { x: 2.54, y: 1.524 },
            graphics: [
                // Two parallel lines
                { type: 'line', x1: -0.508, y1: -1.27, x2: -0.508, y2: 1.27, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 0.508, y1: -1.27, x2: 0.508, y2: 1.27, stroke: '#000000', strokeWidth: 0.254 },
                // Lead lines
                { type: 'line', x1: -2.54, y1: 0, x2: -0.508, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 0.508, y1: 0, x2: 2.54, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Reference text
                { type: 'text', x: 0, y: -2.5, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' },
                // Value text  
                { type: 'text', x: 0, y: 2.5, text: '${VALUE}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: '1', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'passive', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: '2', x: 2.54, y: 0, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.54, y: -0.9, anchor: 'middle' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'Capacitor_Polarized',
        description: 'Polarized capacitor (electrolytic)',
        category: 'Passive Components',
        keywords: ['C', 'cap', 'farad', 'electrolytic', 'polarized'],
        defaultReference: 'C?',
        defaultValue: '10uF',
        symbol: {
            width: 5.08,
            height: 3.048,
            origin: { x: 2.54, y: 1.524 },
            graphics: [
                // Positive plate (straight line)
                { type: 'line', x1: -0.508, y1: -1.27, x2: -0.508, y2: 1.27, stroke: '#000000', strokeWidth: 0.254 },
                // Negative plate (curved/box)
                { type: 'polyline', points: [[0.508, -1.27], [0.762, -0.635], [0.762, 0.635], [0.508, 1.27]], stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Lead lines
                { type: 'line', x1: -2.54, y1: 0, x2: -0.508, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 0.762, y1: 0, x2: 2.54, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Plus sign
                { type: 'line', x1: -1.778, y1: -0.508, x2: -1.778, y2: -1.27, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: -2.159, y1: -0.889, x2: -1.397, y2: -0.889, stroke: '#000000', strokeWidth: 0.254 },
                // Reference text
                { type: 'text', x: 0, y: -2.5, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' },
                // Value text  
                { type: 'text', x: 0, y: 2.5, text: '${VALUE}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: '+', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'passive', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: '-', x: 2.54, y: 0, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.54, y: -0.9, anchor: 'middle' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'Inductor',
        description: 'Standard inductor symbol',
        category: 'Passive Components',
        keywords: ['L', 'ind', 'coil', 'henry'],
        defaultReference: 'L?',
        defaultValue: '10uH',
        symbol: {
            width: 7.62,
            height: 2.54,
            origin: { x: 3.81, y: 1.27 },
            graphics: [
                // Four humps using bezier curves
                { type: 'path', d: 'M -3.81 0 L -3.048 0 Q -3.048 -1.5 -2.286 -1.5 Q -1.524 -1.5 -1.524 0 Q -1.524 -1.5 -0.762 -1.5 Q 0 -1.5 0 0 Q 0 -1.5 0.762 -1.5 Q 1.524 -1.5 1.524 0 Q 1.524 -1.5 2.286 -1.5 Q 3.048 -1.5 3.048 0 L 3.81 0', stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Reference text
                { type: 'text', x: 0, y: -2.5, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' },
                // Value text  
                { type: 'text', x: 0, y: 2, text: '${VALUE}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: '1', x: -3.81, y: 0, orientation: 'left', length: 0, type: 'passive', shape: 'line', namePos: { x: -3.81, y: -0.9, anchor: 'middle' } },
                { number: '', name: '2', x: 3.81, y: 0, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 3.81, y: -0.9, anchor: 'middle' } }
            ]
        },
        footprint: null
    },
    
    // ============ DISCRETE SEMICONDUCTORS ============
    
    {
        name: 'Diode',
        description: 'Standard diode symbol',
        category: 'Discrete Semiconductors',
        keywords: ['D', 'diode', 'rectifier'],
        defaultReference: 'D?',
        defaultValue: '1N4148',
        symbol: {
            width: 5.08,
            height: 2.54,
            origin: { x: 2.54, y: 1.27 },
            graphics: [
                // Triangle
                { type: 'polygon', points: [[-1.27, -1.27], [-1.27, 1.27], [1.27, 0]], stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Bar (cathode)
                { type: 'line', x1: 1.27, y1: -1.27, x2: 1.27, y2: 1.27, stroke: '#000000', strokeWidth: 0.254 },
                // Lead lines
                { type: 'line', x1: -2.54, y1: 0, x2: -1.27, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 1.27, y1: 0, x2: 2.54, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Reference text
                { type: 'text', x: 0, y: -2.5, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' },
                // Value text  
                { type: 'text', x: 0, y: 2.5, text: '${VALUE}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: 'A', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'passive', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: 'K', x: 2.54, y: 0, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.54, y: -0.9, anchor: 'middle' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'LED',
        description: 'Light Emitting Diode',
        category: 'Optoelectronics',
        keywords: ['D', 'LED', 'light'],
        defaultReference: 'D?',
        defaultValue: 'LED',
        symbol: {
            width: 5.08,
            height: 3.81,
            origin: { x: 2.54, y: 1.905 },
            graphics: [
                // Triangle
                { type: 'polygon', points: [[-1.27, -1.27], [-1.27, 1.27], [1.27, 0]], stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Bar (cathode)
                { type: 'line', x1: 1.27, y1: -1.27, x2: 1.27, y2: 1.27, stroke: '#000000', strokeWidth: 0.254 },
                // Lead lines
                { type: 'line', x1: -2.54, y1: 0, x2: -1.27, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 1.27, y1: 0, x2: 2.54, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Light arrows
                { type: 'line', x1: 0, y1: -1.778, x2: 1.016, y2: -2.794, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'polygon', points: [[1.016, -2.794], [0.508, -2.286], [0.762, -2.54]], stroke: '#000000', strokeWidth: 0.127, fill: '#000000' },
                { type: 'line', x1: 0.762, y1: -1.524, x2: 1.778, y2: -2.54, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'polygon', points: [[1.778, -2.54], [1.27, -2.032], [1.524, -2.286]], stroke: '#000000', strokeWidth: 0.127, fill: '#000000' },
                // Reference text
                { type: 'text', x: 0, y: -3.5, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' },
                // Value text  
                { type: 'text', x: 0, y: 2.5, text: '${VALUE}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: 'A', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'passive', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: 'K', x: 2.54, y: 0, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.54, y: -0.9, anchor: 'middle' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'NPN',
        description: 'NPN Bipolar Transistor',
        category: 'Discrete Semiconductors',
        keywords: ['Q', 'transistor', 'BJT', 'NPN'],
        defaultReference: 'Q?',
        defaultValue: '2N2222',
        symbol: {
            width: 5.08,
            height: 5.08,
            origin: { x: 2.54, y: 2.54 },
            graphics: [
                // Base line (vertical)
                { type: 'line', x1: 0, y1: -1.778, x2: 0, y2: 1.778, stroke: '#000000', strokeWidth: 0.508 },
                // Emitter (with arrow)
                { type: 'line', x1: 0, y1: 0.762, x2: 1.778, y2: 2.54, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'polygon', points: [[1.778, 2.54], [1.016, 1.778], [1.27, 2.286]], stroke: '#000000', strokeWidth: 0.127, fill: '#000000' },
                // Collector
                { type: 'line', x1: 0, y1: -0.762, x2: 1.778, y2: -2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Base lead
                { type: 'line', x1: -2.54, y1: 0, x2: 0, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Emitter lead
                { type: 'line', x1: 1.778, y1: 2.54, x2: 2.54, y2: 2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Collector lead
                { type: 'line', x1: 1.778, y1: -2.54, x2: 2.54, y2: -2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Circle (optional package outline)
                { type: 'circle', cx: 0.889, cy: 0, r: 2.794, stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Reference text
                { type: 'text', x: 3.5, y: 0, text: '${REF}', fontSize: 1.27, anchor: 'start', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: 'B', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'input', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: 'C', x: 2.54, y: -2.54, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 3.44, y: -3.44, anchor: 'start' } },
                { number: '', name: 'E', x: 2.54, y: 2.54, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 3.44, y: 3.44, anchor: 'start' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'PNP',
        description: 'PNP Bipolar Transistor',
        category: 'Discrete Semiconductors',
        keywords: ['Q', 'transistor', 'BJT', 'PNP'],
        defaultReference: 'Q?',
        defaultValue: '2N2907',
        symbol: {
            width: 5.08,
            height: 5.08,
            origin: { x: 2.54, y: 2.54 },
            graphics: [
                // Base line (vertical)
                { type: 'line', x1: 0, y1: -1.778, x2: 0, y2: 1.778, stroke: '#000000', strokeWidth: 0.508 },
                // Emitter (with arrow pointing IN)
                { type: 'line', x1: 0, y1: 0.762, x2: 1.778, y2: 2.54, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'polygon', points: [[0, 0.762], [0.762, 1.524], [0.508, 1.016]], stroke: '#000000', strokeWidth: 0.127, fill: '#000000' },
                // Collector
                { type: 'line', x1: 0, y1: -0.762, x2: 1.778, y2: -2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Base lead
                { type: 'line', x1: -2.54, y1: 0, x2: 0, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Emitter lead
                { type: 'line', x1: 1.778, y1: 2.54, x2: 2.54, y2: 2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Collector lead
                { type: 'line', x1: 1.778, y1: -2.54, x2: 2.54, y2: -2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Circle (optional package outline)
                { type: 'circle', cx: 0.889, cy: 0, r: 2.794, stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Reference text
                { type: 'text', x: 3.5, y: 0, text: '${REF}', fontSize: 1.27, anchor: 'start', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: 'B', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'input', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: 'C', x: 2.54, y: -2.54, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 3.44, y: -3.44, anchor: 'start' } },
                { number: '', name: 'E', x: 2.54, y: 2.54, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 3.44, y: 3.44, anchor: 'start' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'NMOS',
        description: 'N-Channel MOSFET',
        category: 'Discrete Semiconductors',
        keywords: ['Q', 'MOSFET', 'NMOS', 'FET'],
        defaultReference: 'Q?',
        defaultValue: '2N7000',
        symbol: {
            width: 5.08,
            height: 5.08,
            origin: { x: 2.54, y: 2.54 },
            graphics: [
                // Gate vertical line
                { type: 'line', x1: -0.508, y1: -1.778, x2: -0.508, y2: 1.778, stroke: '#000000', strokeWidth: 0.254 },
                // Channel segments
                { type: 'line', x1: 0.508, y1: -1.778, x2: 0.508, y2: -0.762, stroke: '#000000', strokeWidth: 0.508 },
                { type: 'line', x1: 0.508, y1: -0.254, x2: 0.508, y2: 0.762, stroke: '#000000', strokeWidth: 0.508 },
                { type: 'line', x1: 0.508, y1: 1.27, x2: 0.508, y2: 1.778, stroke: '#000000', strokeWidth: 0.508 },
                // Drain line
                { type: 'line', x1: 0.508, y1: -1.27, x2: 2.54, y2: -1.27, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 2.54, y1: -2.54, x2: 2.54, y2: -1.27, stroke: '#000000', strokeWidth: 0.254 },
                // Source line  
                { type: 'line', x1: 0.508, y1: 1.524, x2: 2.54, y2: 1.524, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 2.54, y1: 2.54, x2: 2.54, y2: 1.524, stroke: '#000000', strokeWidth: 0.254 },
                // Arrow (points into device for N-channel)
                { type: 'line', x1: 0.508, y1: 0.254, x2: 1.524, y2: 0.254, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'polygon', points: [[1.524, 0.254], [1.016, 0], [1.016, 0.508]], stroke: '#000000', strokeWidth: 0.127, fill: '#000000' },
                // Body diode connection to source
                { type: 'line', x1: 1.524, y1: 0.254, x2: 1.524, y2: 1.524, stroke: '#000000', strokeWidth: 0.254 },
                // Gate lead
                { type: 'line', x1: -2.54, y1: 0, x2: -0.508, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Reference text
                { type: 'text', x: 3.5, y: 0, text: '${REF}', fontSize: 1.27, anchor: 'start', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: 'G', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'input', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: 'D', x: 2.54, y: -2.54, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 3.44, y: -3.44, anchor: 'start' } },
                { number: '', name: 'S', x: 2.54, y: 2.54, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 3.44, y: 3.44, anchor: 'start' } }
            ]
        },
        footprint: null
    },
    
    // ============ INTEGRATED CIRCUITS ============
    
    {
        name: 'OpAmp',
        description: 'Operational Amplifier (single)',
        category: 'Integrated Circuits',
        keywords: ['U', 'op-amp', 'opamp', 'amplifier'],
        defaultReference: 'U?',
        defaultValue: 'LM358',
        symbol: {
            width: 7.62,
            height: 5.08,
            origin: { x: 3.81, y: 2.54 },
            graphics: [
                // Triangle body
                { type: 'polygon', points: [[-2.54, -2.54], [-2.54, 2.54], [2.54, 0]], stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // + sign (non-inverting input)
                { type: 'line', x1: -1.778, y1: 1.27, x2: -1.016, y2: 1.27, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: -1.397, y1: 0.889, x2: -1.397, y2: 1.651, stroke: '#000000', strokeWidth: 0.254 },
                // - sign (inverting input)
                { type: 'line', x1: -1.778, y1: -1.27, x2: -1.016, y2: -1.27, stroke: '#000000', strokeWidth: 0.254 },
                // Input leads
                { type: 'line', x1: -3.81, y1: 1.27, x2: -2.54, y2: 1.27, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: -3.81, y1: -1.27, x2: -2.54, y2: -1.27, stroke: '#000000', strokeWidth: 0.254 },
                // Output lead
                { type: 'line', x1: 2.54, y1: 0, x2: 3.81, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Reference text
                { type: 'text', x: 0, y: -3.5, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: '+', x: -3.81, y: 1.27, orientation: 'left', length: 0, type: 'input', shape: 'line', namePos: { x: -3.81, y: 0.37, anchor: 'middle' } },
                { number: '', name: '-', x: -3.81, y: -1.27, orientation: 'left', length: 0, type: 'input', shape: 'line', namePos: { x: -3.81, y: -2.17, anchor: 'middle' } },
                { number: '', name: 'OUT', x: 3.81, y: 0, orientation: 'right', length: 0, type: 'output', shape: 'line', namePos: { x: 3.81, y: -0.9, anchor: 'middle' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'IC_DIP8',
        description: '8-pin DIP IC (generic)',
        category: 'Integrated Circuits',
        keywords: ['U', 'IC', 'DIP8', 'chip'],
        defaultReference: 'U?',
        defaultValue: '',
        symbol: {
            width: 10.16,
            height: 12.7,
            origin: { x: 5.08, y: 6.35 },
            graphics: [
                // Body rectangle
                { type: 'rect', x: -2.54, y: -5.08, width: 5.08, height: 10.16, stroke: '#000000', strokeWidth: 0.254, fill: '#FFFFCC' },
                // Notch at top (half-circle using path)
                { type: 'path', d: 'M -0.762 -5.08 A 0.762 0.762 0 0 1 0.762 -5.08', stroke: '#000000', strokeWidth: 0.254, fill: '#FFFFCC' },
                // Pin 1 dot
                { type: 'circle', cx: -1.778, cy: -4.064, r: 0.381, stroke: 'none', strokeWidth: 0, fill: '#000000' },
                // Reference text
                { type: 'text', x: 0, y: 0, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                // Left side (top to bottom: 1-4) - orientation 'right' to draw toward body
                { number: '1', name: '1', x: -5.08, y: -3.81, orientation: 'right', length: 2.54, type: 'passive', shape: 'line' },
                { number: '2', name: '2', x: -5.08, y: -1.27, orientation: 'right', length: 2.54, type: 'passive', shape: 'line' },
                { number: '3', name: '3', x: -5.08, y: 1.27, orientation: 'right', length: 2.54, type: 'passive', shape: 'line' },
                { number: '4', name: '4', x: -5.08, y: 3.81, orientation: 'right', length: 2.54, type: 'passive', shape: 'line' },
                // Right side (bottom to top: 5-8) - orientation 'left' to draw toward body
                { number: '5', name: '5', x: 5.08, y: 3.81, orientation: 'left', length: 2.54, type: 'passive', shape: 'line' },
                { number: '6', name: '6', x: 5.08, y: 1.27, orientation: 'left', length: 2.54, type: 'passive', shape: 'line' },
                { number: '7', name: '7', x: 5.08, y: -1.27, orientation: 'left', length: 2.54, type: 'passive', shape: 'line' },
                { number: '8', name: '8', x: 5.08, y: -3.81, orientation: 'left', length: 2.54, type: 'passive', shape: 'line' }
            ]
        },
        footprint: null
    },
    
    // ============ CONNECTORS ============
    
    {
        name: 'Conn_01x02',
        description: '2-pin connector',
        category: 'Connectors',
        keywords: ['J', 'connector', 'header', '2pin'],
        defaultReference: 'J?',
        defaultValue: '',
        symbol: {
            width: 5.08,
            height: 5.08,
            origin: { x: 2.54, y: 2.54 },
            graphics: [
                // Box
                { type: 'rect', x: -1.27, y: -2.54, width: 2.54, height: 5.08, stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Pin indicators
                { type: 'rect', x: -1.27, y: -2.032, width: 1.27, height: 1.016, stroke: '#000000', strokeWidth: 0.254, fill: '#FFFFCC' },
                { type: 'rect', x: -1.27, y: 1.016, width: 1.27, height: 1.016, stroke: '#000000', strokeWidth: 0.254, fill: '#FFFFCC' },
                // Reference
                { type: 'text', x: 0, y: -4, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: '1', x: -3.81, y: -1.524, orientation: 'right', length: 2.54, type: 'passive', shape: 'line', namePos: { x: -3.81, y: -2.424, anchor: 'middle' } },
                { number: '', name: '2', x: -3.81, y: 1.524, orientation: 'right', length: 2.54, type: 'passive', shape: 'line', namePos: { x: -3.81, y: 0.624, anchor: 'middle' } }
            ]
        },
        footprint: null
    },
    
    // ============ SWITCHES ============
    
    {
        name: 'SW_Push',
        description: 'Push button (normally open)',
        category: 'Switches',
        keywords: ['SW', 'switch', 'push', 'button', 'tactile'],
        defaultReference: 'SW?',
        defaultValue: '',
        symbol: {
            width: 5.08,
            height: 5.08,
            origin: { x: 2.54, y: 2.54 },
            graphics: [
                // Lead lines
                { type: 'line', x1: -2.54, y1: 0, x2: -1.27, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 2.54, y1: 0, x2: 1.27, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Contact stubs
                { type: 'line', x1: -1.27, y1: 0.762, x2: -1.27, y2: -0.762, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 1.27, y1: 0.762, x2: 1.27, y2: -0.762, stroke: '#000000', strokeWidth: 0.254 },
                // Push bar (normally open, above contacts)
                { type: 'line', x1: -1.27, y1: -1.27, x2: 1.27, y2: -1.27, stroke: '#000000', strokeWidth: 0.254 },
                // Push indicator
                { type: 'line', x1: 0, y1: -2.54, x2: 0, y2: -1.27, stroke: '#000000', strokeWidth: 0.254 },
                // Reference
                { type: 'text', x: 0, y: 2.5, text: '${REF}', fontSize: 1.27, anchor: 'middle', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: '1', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'passive', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: '2', x: 2.54, y: 0, orientation: 'right', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.54, y: -0.9, anchor: 'middle' } }
            ]
        },
        footprint: null
    },
    
    // ============ TRANSISTORS ============
    
    {
        name: 'NPN',
        description: 'NPN bipolar transistor',
        category: 'Transistors',
        keywords: ['Q', 'NPN', 'BJT', 'transistor'],
        defaultReference: 'Q?',
        defaultValue: '2N2222',
        symbol: {
            width: 5.08,
            height: 6.35,
            origin: { x: 2.54, y: 3.175 },
            graphics: [
                // Vertical bar (base region)
                { type: 'line', x1: 0, y1: -1.524, x2: 0, y2: 1.524, stroke: '#000000', strokeWidth: 0.381 },
                // Base lead
                { type: 'line', x1: -2.54, y1: 0, x2: 0, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Collector line
                { type: 'line', x1: 0, y1: -1.016, x2: 1.524, y2: -2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Collector lead
                { type: 'line', x1: 1.524, y1: -2.54, x2: 1.524, y2: -3.175, stroke: '#000000', strokeWidth: 0.254 },
                // Emitter line
                { type: 'line', x1: 0, y1: 1.016, x2: 1.524, y2: 2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Emitter lead
                { type: 'line', x1: 1.524, y1: 2.54, x2: 1.524, y2: 3.175, stroke: '#000000', strokeWidth: 0.254 },
                // Emitter arrow
                { type: 'polyline', points: [[0.762, 2.286], [1.524, 2.54], [1.27, 1.778]], stroke: '#000000', strokeWidth: 0.254, fill: '#000000' },
                // Reference
                { type: 'text', x: 3, y: -1.5, text: '${REF}', fontSize: 1.27, anchor: 'start', baseline: 'middle' },
                // Value
                { type: 'text', x: 3, y: 1.5, text: '${VALUE}', fontSize: 1.27, anchor: 'start', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: 'B', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'input', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: 'C', x: 1.524, y: -3.175, orientation: 'up', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.424, y: -4.075, anchor: 'start' } },
                { number: '', name: 'E', x: 1.524, y: 3.175, orientation: 'down', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.424, y: 4.075, anchor: 'start' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'PNP',
        description: 'PNP bipolar transistor',
        category: 'Transistors',
        keywords: ['Q', 'PNP', 'BJT', 'transistor'],
        defaultReference: 'Q?',
        defaultValue: '2N2907',
        symbol: {
            width: 5.08,
            height: 6.35,
            origin: { x: 2.54, y: 3.175 },
            graphics: [
                // Vertical bar (base region)
                { type: 'line', x1: 0, y1: -1.524, x2: 0, y2: 1.524, stroke: '#000000', strokeWidth: 0.381 },
                // Base lead
                { type: 'line', x1: -2.54, y1: 0, x2: 0, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Collector line
                { type: 'line', x1: 0, y1: 1.016, x2: 1.524, y2: 2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Collector lead
                { type: 'line', x1: 1.524, y1: 2.54, x2: 1.524, y2: 3.175, stroke: '#000000', strokeWidth: 0.254 },
                // Emitter line
                { type: 'line', x1: 0, y1: -1.016, x2: 1.524, y2: -2.54, stroke: '#000000', strokeWidth: 0.254 },
                // Emitter lead
                { type: 'line', x1: 1.524, y1: -2.54, x2: 1.524, y2: -3.175, stroke: '#000000', strokeWidth: 0.254 },
                // Emitter arrow (pointing inward for PNP)
                { type: 'polyline', points: [[0.254, -0.762], [0, -1.016], [0.762, -1.27]], stroke: '#000000', strokeWidth: 0.254, fill: '#000000' },
                // Reference
                { type: 'text', x: 3, y: -1.5, text: '${REF}', fontSize: 1.27, anchor: 'start', baseline: 'middle' },
                // Value
                { type: 'text', x: 3, y: 1.5, text: '${VALUE}', fontSize: 1.27, anchor: 'start', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: 'B', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'input', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: 'E', x: 1.524, y: -3.175, orientation: 'up', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.424, y: -4.075, anchor: 'start' } },
                { number: '', name: 'C', x: 1.524, y: 3.175, orientation: 'down', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.424, y: 4.075, anchor: 'start' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'NMOS',
        description: 'N-channel MOSFET',
        category: 'Transistors',
        keywords: ['Q', 'NMOS', 'NFET', 'MOSFET', 'FET', 'transistor'],
        defaultReference: 'Q?',
        defaultValue: '2N7000',
        symbol: {
            width: 5.08,
            height: 6.35,
            origin: { x: 2.54, y: 3.175 },
            graphics: [
                // Gate vertical bar
                { type: 'line', x1: -0.254, y1: -1.524, x2: -0.254, y2: 1.524, stroke: '#000000', strokeWidth: 0.254 },
                // Channel segments (broken for enhancement mode)
                { type: 'line', x1: 0.508, y1: -1.524, x2: 0.508, y2: -0.508, stroke: '#000000', strokeWidth: 0.381 },
                { type: 'line', x1: 0.508, y1: -0.254, x2: 0.508, y2: 0.254, stroke: '#000000', strokeWidth: 0.381 },
                { type: 'line', x1: 0.508, y1: 0.508, x2: 0.508, y2: 1.524, stroke: '#000000', strokeWidth: 0.381 },
                // Gate lead
                { type: 'line', x1: -2.54, y1: 0, x2: -0.254, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Drain line
                { type: 'line', x1: 0.508, y1: -1.016, x2: 1.524, y2: -1.016, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 1.524, y1: -1.016, x2: 1.524, y2: -3.175, stroke: '#000000', strokeWidth: 0.254 },
                // Source line
                { type: 'line', x1: 0.508, y1: 1.016, x2: 1.524, y2: 1.016, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 1.524, y1: 1.016, x2: 1.524, y2: 3.175, stroke: '#000000', strokeWidth: 0.254 },
                // Arrow on source (pointing in for N-channel)
                { type: 'polyline', points: [[0.254, 1.016], [0.508, 1.016], [0.508, 0.762]], stroke: '#000000', strokeWidth: 0.254, fill: '#000000' },
                // Body diode connection
                { type: 'line', x1: 1.524, y1: 1.016, x2: 1.524, y2: -1.016, stroke: '#000000', strokeWidth: 0.127, },
                // Reference
                { type: 'text', x: 3, y: -1.5, text: '${REF}', fontSize: 1.27, anchor: 'start', baseline: 'middle' },
                // Value
                { type: 'text', x: 3, y: 1.5, text: '${VALUE}', fontSize: 1.27, anchor: 'start', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: 'G', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'input', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: 'D', x: 1.524, y: -3.175, orientation: 'up', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.424, y: -4.075, anchor: 'start' } },
                { number: '', name: 'S', x: 1.524, y: 3.175, orientation: 'down', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.424, y: 4.075, anchor: 'start' } }
            ]
        },
        footprint: null
    },
    
    {
        name: 'PMOS',
        description: 'P-channel MOSFET',
        category: 'Transistors',
        keywords: ['Q', 'PMOS', 'PFET', 'MOSFET', 'FET', 'transistor'],
        defaultReference: 'Q?',
        defaultValue: 'BSS84',
        symbol: {
            width: 5.08,
            height: 6.35,
            origin: { x: 2.54, y: 3.175 },
            graphics: [
                // Gate vertical bar
                { type: 'line', x1: -0.254, y1: -1.524, x2: -0.254, y2: 1.524, stroke: '#000000', strokeWidth: 0.254 },
                // Channel segments (broken for enhancement mode)
                { type: 'line', x1: 0.508, y1: -1.524, x2: 0.508, y2: -0.508, stroke: '#000000', strokeWidth: 0.381 },
                { type: 'line', x1: 0.508, y1: -0.254, x2: 0.508, y2: 0.254, stroke: '#000000', strokeWidth: 0.381 },
                { type: 'line', x1: 0.508, y1: 0.508, x2: 0.508, y2: 1.524, stroke: '#000000', strokeWidth: 0.381 },
                // Gate lead
                { type: 'line', x1: -2.54, y1: 0, x2: -0.254, y2: 0, stroke: '#000000', strokeWidth: 0.254 },
                // Source line (top for PMOS)
                { type: 'line', x1: 0.508, y1: -1.016, x2: 1.524, y2: -1.016, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 1.524, y1: -1.016, x2: 1.524, y2: -3.175, stroke: '#000000', strokeWidth: 0.254 },
                // Drain line (bottom for PMOS)
                { type: 'line', x1: 0.508, y1: 1.016, x2: 1.524, y2: 1.016, stroke: '#000000', strokeWidth: 0.254 },
                { type: 'line', x1: 1.524, y1: 1.016, x2: 1.524, y2: 3.175, stroke: '#000000', strokeWidth: 0.254 },
                // Arrow on source (pointing out for P-channel)
                { type: 'polyline', points: [[0.762, -1.016], [0.508, -1.016], [0.508, -1.27]], stroke: '#000000', strokeWidth: 0.254, fill: '#000000' },
                // Body diode connection
                { type: 'line', x1: 1.524, y1: 1.016, x2: 1.524, y2: -1.016, stroke: '#000000', strokeWidth: 0.127 },
                // Gate bubble (inversion)
                { type: 'circle', cx: -0.635, cy: 0, r: 0.381, stroke: '#000000', strokeWidth: 0.254, fill: 'none' },
                // Reference
                { type: 'text', x: 3, y: -1.5, text: '${REF}', fontSize: 1.27, anchor: 'start', baseline: 'middle' },
                // Value
                { type: 'text', x: 3, y: 1.5, text: '${VALUE}', fontSize: 1.27, anchor: 'start', baseline: 'middle' }
            ],
            pins: [
                { number: '', name: 'G', x: -2.54, y: 0, orientation: 'left', length: 0, type: 'input', shape: 'line', namePos: { x: -2.54, y: -0.9, anchor: 'middle' } },
                { number: '', name: 'S', x: 1.524, y: -3.175, orientation: 'up', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.424, y: -4.075, anchor: 'start' } },
                { number: '', name: 'D', x: 1.524, y: 3.175, orientation: 'down', length: 0, type: 'passive', shape: 'line', namePos: { x: 2.424, y: 4.075, anchor: 'start' } }
            ]
        },
        footprint: null
    }
];

export default BuiltInComponents;

