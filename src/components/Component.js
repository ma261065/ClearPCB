/**
 * ClearPCB Component Format
 * 
 * A component represents an electronic part with:
 * - Schematic symbol (for schematic editor)
 * - PCB footprint (for PCB editor)
 * - Metadata (part info, datasheet, supplier part numbers)
 * 
 * Component Definition Format (JSON):
 * {
 *   "name": "NE555",
 *   "description": "Timer IC",
 *   "category": "Integrated Circuits",
 *   "datasheet": "https://...",
 *   "supplier_part_numbers": {
 *     "lcsc": "C46749",
 *     "digikey": "...",
 *   },
 *   "symbol": { ... },      // Schematic symbol definition
 *   "footprint": { ... },   // PCB footprint definition
 *   "model_3d": { ... }     // 3D model reference (optional)
 * }
 * 
 * Symbol Definition:
 * {
 *   "width": 10,           // In mm
 *   "height": 15,
 *   "origin": { "x": 5, "y": 7.5 },  // Reference point
 *   "graphics": [          // SVG-friendly primitives
 *     { "type": "rect", "x": 0, "y": 0, "width": 10, "height": 15, "fill": "none", "stroke": "#000" },
 *     { "type": "line", "x1": 0, "y1": 5, "x2": -2, "y2": 5, "stroke": "#000" },
 *     { "type": "circle", "cx": 5, "cy": 5, "r": 1, "fill": "none", "stroke": "#000" },
 *     { "type": "arc", "cx": 5, "cy": 5, "r": 2, "startAngle": 0, "endAngle": 180, "stroke": "#000" },
 *     { "type": "polyline", "points": [[0,0], [2,2], [4,0]], "stroke": "#000", "fill": "none" },
 *     { "type": "polygon", "points": [[0,0], [2,2], [4,0]], "stroke": "#000", "fill": "#000" },
 *     { "type": "text", "x": 5, "y": -1, "text": "${REF}", "fontSize": 1.27, "anchor": "middle" },
 *     { "type": "path", "d": "M 0 0 L 2 2 Q 3 3 4 2", "stroke": "#000", "fill": "none" }
 *   ],
 *   "pins": [
 *     { 
 *       "number": "1", 
 *       "name": "GND", 
 *       "x": -2, "y": 5,           // Position (end of pin line)
 *       "orientation": "right",    // Pin points right into component
 *       "length": 2,
 *       "type": "passive",         // passive, input, output, bidirectional, power_in, power_out, etc.
 *       "shape": "line"            // line, clock, inverted, inverted_clock
 *     }
 *   ]
 * }
 * 
 * Footprint Definition:
 * {
 *   "width": 8,
 *   "height": 10,
 *   "origin": { "x": 4, "y": 5 },
 *   "pads": [
 *     {
 *       "number": "1",
 *       "x": -2.54, "y": 3.81,
 *       "width": 1.5, "height": 0.6,
 *       "shape": "rect",           // rect, circle, oval, roundrect
 *       "type": "smd",             // smd, th (through-hole)
 *       "layers": ["F.Cu", "F.Paste", "F.Mask"],
 *       "drill": null,             // For through-hole: { "diameter": 0.8 } or { "width": 0.8, "height": 1.2 }
 *       "roundness": 0             // 0-100% for roundrect
 *     }
 *   ],
 *   "graphics": [
 *     { "type": "line", "x1": -3, "y1": 4.5, "x2": 3, "y2": 4.5, "layer": "F.SilkS", "stroke": 0.15 },
 *     { "type": "rect", "x": -3.5, "y": -5, "width": 7, "height": 10, "layer": "F.CrtYd", "stroke": 0.05 }
 *   ],
 *   "model_3d": {
 *     "path": "path/to/model.step",
 *     "offset": { "x": 0, "y": 0, "z": 0 },
 *     "rotation": { "x": 0, "y": 0, "z": 0 },
 *     "scale": { "x": 1, "y": 1, "z": 1 }
 *   }
 * }
 */

/**
 * Component class - represents an electronic component instance on the schematic
 */
export class Component {
    constructor(definition, options = {}) {
        this.id = options.id || `component_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.definition = definition;
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.rotation = options.rotation || 0;  // degrees
        this.mirror = options.mirror || false;
        this.reference = options.reference || definition.defaultReference || 'U?';
        this.value = options.value || definition.defaultValue || definition.name;
        
        // Instance-specific properties
        this.properties = {
            ...definition.defaultProperties,
            ...options.properties
        };
        
        // SVG element (created when rendered)
        this.element = null;
        this.pinElements = new Map();  // pin number -> SVG element
    }
    
    /**
     * Get the symbol definition
     */
    get symbol() {
        return this.definition.symbol;
    }
    
    /**
     * Get the footprint definition
     */
    get footprint() {
        return this.definition.footprint;
    }
    
    /**
     * Create SVG element for the schematic symbol
     */
    createSymbolElement(ns = 'http://www.w3.org/2000/svg') {
        const group = document.createElementNS(ns, 'g');
        group.setAttribute('class', 'component');
        group.setAttribute('data-component-id', this.id);
        
        // Apply transform
        const transform = this._buildTransform();
        if (transform) {
            group.setAttribute('transform', transform);
        }
        
        // Render graphics
        const symbol = this.symbol;
        if (symbol && symbol.graphics) {
            for (const graphic of symbol.graphics) {
                const el = this._createGraphicElement(graphic, ns);
                if (el) group.appendChild(el);
            }
        }
        
        // Render pins
        if (symbol && symbol.pins) {
            for (const pin of symbol.pins) {
                const pinGroup = this._createPinElement(pin, ns);
                if (pinGroup) {
                    group.appendChild(pinGroup);
                    this.pinElements.set(pin.number, pinGroup);
                }
            }
        }
        
        this.element = group;
        return group;
    }
    
    /**
     * Build SVG transform string
     */
    _buildTransform() {
        const parts = [];
        
        // Translate to position
        if (this.x !== 0 || this.y !== 0) {
            parts.push(`translate(${this.x}, ${this.y})`);
        }
        
        // Rotate around origin
        if (this.rotation !== 0) {
            parts.push(`rotate(${this.rotation})`);
        }
        
        // Mirror (flip horizontally)
        if (this.mirror) {
            parts.push('scale(-1, 1)');
        }
        
        return parts.length > 0 ? parts.join(' ') : null;
    }
    
    /**
     * Create SVG element for a graphic primitive
     */
    _createGraphicElement(graphic, ns) {
        let el;
        const stroke = graphic.stroke || '#000000';
        const strokeWidth = graphic.strokeWidth || 0.254;  // Default ~10mil
        const fill = graphic.fill || 'none';
        
        switch (graphic.type) {
            case 'line':
                el = document.createElementNS(ns, 'line');
                el.setAttribute('x1', graphic.x1);
                el.setAttribute('y1', graphic.y1);
                el.setAttribute('x2', graphic.x2);
                el.setAttribute('y2', graphic.y2);
                el.setAttribute('stroke', stroke);
                el.setAttribute('stroke-width', strokeWidth);
                break;
                
            case 'rect':
                el = document.createElementNS(ns, 'rect');
                el.setAttribute('x', graphic.x);
                el.setAttribute('y', graphic.y);
                el.setAttribute('width', graphic.width);
                el.setAttribute('height', graphic.height);
                el.setAttribute('stroke', stroke);
                el.setAttribute('stroke-width', strokeWidth);
                el.setAttribute('fill', fill);
                if (graphic.rx) el.setAttribute('rx', graphic.rx);
                if (graphic.ry) el.setAttribute('ry', graphic.ry);
                break;
                
            case 'circle':
                el = document.createElementNS(ns, 'circle');
                el.setAttribute('cx', graphic.cx);
                el.setAttribute('cy', graphic.cy);
                el.setAttribute('r', graphic.r);
                el.setAttribute('stroke', stroke);
                el.setAttribute('stroke-width', strokeWidth);
                el.setAttribute('fill', fill);
                break;
                
            case 'ellipse':
                el = document.createElementNS(ns, 'ellipse');
                el.setAttribute('cx', graphic.cx);
                el.setAttribute('cy', graphic.cy);
                el.setAttribute('rx', graphic.rx);
                el.setAttribute('ry', graphic.ry);
                el.setAttribute('stroke', stroke);
                el.setAttribute('stroke-width', strokeWidth);
                el.setAttribute('fill', fill);
                break;
                
            case 'arc':
                el = document.createElementNS(ns, 'path');
                const arcPath = this._arcToPath(graphic);
                el.setAttribute('d', arcPath);
                el.setAttribute('stroke', stroke);
                el.setAttribute('stroke-width', strokeWidth);
                el.setAttribute('fill', fill);
                break;
                
            case 'polyline':
                el = document.createElementNS(ns, 'polyline');
                el.setAttribute('points', graphic.points.map(p => `${p[0]},${p[1]}`).join(' '));
                el.setAttribute('stroke', stroke);
                el.setAttribute('stroke-width', strokeWidth);
                el.setAttribute('fill', fill);
                break;
                
            case 'polygon':
                el = document.createElementNS(ns, 'polygon');
                el.setAttribute('points', graphic.points.map(p => `${p[0]},${p[1]}`).join(' '));
                el.setAttribute('stroke', stroke);
                el.setAttribute('stroke-width', strokeWidth);
                el.setAttribute('fill', fill);
                break;
                
            case 'path':
                el = document.createElementNS(ns, 'path');
                el.setAttribute('d', graphic.d);
                el.setAttribute('stroke', stroke);
                el.setAttribute('stroke-width', strokeWidth);
                el.setAttribute('fill', fill);
                break;
                
            case 'text':
                el = document.createElementNS(ns, 'text');
                el.setAttribute('x', graphic.x);
                el.setAttribute('y', graphic.y);
                el.setAttribute('font-size', graphic.fontSize || 1.27);
                el.setAttribute('font-family', graphic.fontFamily || 'sans-serif');
                el.setAttribute('fill', graphic.color || '#000000');
                if (graphic.anchor) {
                    el.setAttribute('text-anchor', graphic.anchor);
                }
                if (graphic.baseline) {
                    el.setAttribute('dominant-baseline', graphic.baseline);
                }
                // Substitute variables
                let text = graphic.text || '';
                text = text.replace('${REF}', this.reference);
                text = text.replace('${VALUE}', this.value);
                text = text.replace('${NAME}', this.definition.name);
                el.textContent = text;
                break;
                
            default:
                console.warn(`Unknown graphic type: ${graphic.type}`);
                return null;
        }
        
        if (graphic.class) {
            el.setAttribute('class', graphic.class);
        }
        
        return el;
    }
    
    /**
     * Convert arc definition to SVG path
     */
    _arcToPath(arc) {
        const { cx, cy, r, startAngle = 0, endAngle = 360 } = arc;
        
        // Handle full circle case
        if (Math.abs(endAngle - startAngle) >= 360) {
            return `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy}`;
        }
        
        const start = this._polarToCartesian(cx, cy, r, startAngle);
        const end = this._polarToCartesian(cx, cy, r, endAngle);
        
        // Determine if it's a large arc (> 180 degrees)
        let angleDiff = endAngle - startAngle;
        if (angleDiff < 0) angleDiff += 360;
        const largeArc = angleDiff > 180 ? 1 : 0;
        const sweep = 1;  // Clockwise
        
        return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`;
    }
    
    /**
     * Convert polar coordinates to cartesian
     */
    _polarToCartesian(cx, cy, r, angleDeg) {
        const angleRad = (angleDeg - 90) * Math.PI / 180;
        return {
            x: cx + r * Math.cos(angleRad),
            y: cy + r * Math.sin(angleRad)
        };
    }
    
    /**
     * Create SVG element for a pin
     */
    _createPinElement(pin, ns) {
        const group = document.createElementNS(ns, 'g');
        group.setAttribute('class', 'pin');
        group.setAttribute('data-pin-number', pin.number);
        group.setAttribute('data-pin-name', pin.name || '');
        
        const length = pin.length || 2.54;  // Default 100mil
        const strokeWidth = 0.254;
        
        // Calculate pin line endpoints based on orientation
        let x1 = pin.x, y1 = pin.y, x2, y2;
        let textX, textY, textAnchor, nameX, nameY, nameAnchor;
        
        switch (pin.orientation) {
            case 'right':  // Pin points right (into component on right side)
                x2 = pin.x + length;
                y2 = pin.y;
                textX = pin.x - 0.5;
                textAnchor = 'end';
                nameX = pin.x + length + 0.5;
                nameAnchor = 'start';
                textY = nameY = pin.y;
                break;
            case 'left':   // Pin points left
                x2 = pin.x - length;
                y2 = pin.y;
                textX = pin.x + 0.5;
                textAnchor = 'start';
                nameX = pin.x - length - 0.5;
                nameAnchor = 'end';
                textY = nameY = pin.y;
                break;
            case 'up':     // Pin points up
                x2 = pin.x;
                y2 = pin.y - length;
                textX = nameX = pin.x;
                textY = pin.y + 0.5;
                nameY = pin.y - length - 0.5;
                textAnchor = nameAnchor = 'middle';
                break;
            case 'down':   // Pin points down
                x2 = pin.x;
                y2 = pin.y + length;
                textX = nameX = pin.x;
                textY = pin.y - 0.5;
                nameY = pin.y + length + 0.5;
                textAnchor = nameAnchor = 'middle';
                break;
            default:
                x2 = pin.x + length;
                y2 = pin.y;
                textX = pin.x - 0.5;
                textAnchor = 'end';
                nameX = pin.x + length + 0.5;
                nameAnchor = 'start';
                textY = nameY = pin.y;
        }
        
        // Pin line
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        line.setAttribute('stroke', '#000000');
        line.setAttribute('stroke-width', strokeWidth);
        group.appendChild(line);
        
        // Pin endpoint circle (connection point)
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', x2);
        circle.setAttribute('cy', y2);
        circle.setAttribute('r', 0.4);
        circle.setAttribute('fill', '#e94560');
        circle.setAttribute('stroke', 'none');
        circle.setAttribute('class', 'pin-endpoint');
        group.appendChild(circle);
        
        // Inverted bubble (if pin shape is inverted)
        if (pin.shape === 'inverted' || pin.shape === 'inverted_clock') {
            const bubble = document.createElementNS(ns, 'circle');
            bubble.setAttribute('cx', x1 + (x2 - x1) * 0.15);
            bubble.setAttribute('cy', y1 + (y2 - y1) * 0.15);
            bubble.setAttribute('r', 0.5);
            bubble.setAttribute('fill', 'none');
            bubble.setAttribute('stroke', '#000000');
            bubble.setAttribute('stroke-width', strokeWidth);
            group.appendChild(bubble);
        }
        
        // Clock symbol (if pin has clock)
        if (pin.shape === 'clock' || pin.shape === 'inverted_clock') {
            const clock = document.createElementNS(ns, 'polyline');
            // Draw small triangle at pin
            if (pin.orientation === 'right' || pin.orientation === 'left') {
                const dir = pin.orientation === 'right' ? 1 : -1;
                clock.setAttribute('points', `${x1},${y1-0.5} ${x1+0.5*dir},${y1} ${x1},${y1+0.5}`);
            } else {
                const dir = pin.orientation === 'down' ? 1 : -1;
                clock.setAttribute('points', `${x1-0.5},${y1} ${x1},${y1+0.5*dir} ${x1+0.5},${y1}`);
            }
            clock.setAttribute('fill', 'none');
            clock.setAttribute('stroke', '#000000');
            clock.setAttribute('stroke-width', strokeWidth);
            group.appendChild(clock);
        }
        
        // Pin number text
        if (pin.number) {
            const numText = document.createElementNS(ns, 'text');
            numText.setAttribute('x', textX);
            numText.setAttribute('y', textY);
            numText.setAttribute('font-size', 1);
            numText.setAttribute('font-family', 'sans-serif');
            numText.setAttribute('fill', '#666666');
            numText.setAttribute('text-anchor', textAnchor);
            numText.setAttribute('dominant-baseline', 'middle');
            numText.setAttribute('class', 'pin-number');
            numText.textContent = pin.number;
            group.appendChild(numText);
        }
        
        // Pin name text (on opposite side)
        if (pin.name && pin.showName !== false) {
            const nameText = document.createElementNS(ns, 'text');
            nameText.setAttribute('x', nameX);
            nameText.setAttribute('y', nameY);
            nameText.setAttribute('font-size', 1);
            nameText.setAttribute('font-family', 'sans-serif');
            nameText.setAttribute('fill', '#000000');
            nameText.setAttribute('text-anchor', nameAnchor);
            nameText.setAttribute('dominant-baseline', 'middle');
            nameText.setAttribute('class', 'pin-name');
            nameText.textContent = pin.name;
            group.appendChild(nameText);
        }
        
        return group;
    }
    
    /**
     * Get pin by number
     */
    getPin(number) {
        if (!this.symbol || !this.symbol.pins) return null;
        return this.symbol.pins.find(p => p.number === String(number));
    }
    
    /**
     * Get pin position in world coordinates
     */
    getPinPosition(number) {
        const pin = this.getPin(number);
        if (!pin) return null;
        
        const length = pin.length || 2.54;
        let endX, endY;
        
        // Calculate end of pin line
        switch (pin.orientation) {
            case 'right': endX = pin.x + length; endY = pin.y; break;
            case 'left': endX = pin.x - length; endY = pin.y; break;
            case 'up': endX = pin.x; endY = pin.y - length; break;
            case 'down': endX = pin.x; endY = pin.y + length; break;
            default: endX = pin.x + length; endY = pin.y;
        }
        
        // Apply component transform
        const rad = this.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        
        let x = endX, y = endY;
        
        // Mirror
        if (this.mirror) x = -x;
        
        // Rotate
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        
        // Translate
        return {
            x: rx + this.x,
            y: ry + this.y
        };
    }
    
    /**
     * Get bounding box
     */
    getBounds() {
        const symbol = this.symbol;
        if (!symbol) return null;
        
        return {
            x: this.x - (symbol.origin?.x || 0),
            y: this.y - (symbol.origin?.y || 0),
            width: symbol.width || 10,
            height: symbol.height || 10
        };
    }
    
    /**
     * Update position
     */
    setPosition(x, y) {
        this.x = x;
        this.y = y;
        if (this.element) {
            const transform = this._buildTransform();
            if (transform) {
                this.element.setAttribute('transform', transform);
            } else {
                this.element.removeAttribute('transform');
            }
        }
    }
    
    /**
     * Rotate component
     */
    rotate(degrees = 90) {
        this.rotation = (this.rotation + degrees) % 360;
        if (this.element) {
            const transform = this._buildTransform();
            if (transform) {
                this.element.setAttribute('transform', transform);
            }
        }
    }
    
    /**
     * Toggle mirror
     */
    toggleMirror() {
        this.mirror = !this.mirror;
        if (this.element) {
            const transform = this._buildTransform();
            if (transform) {
                this.element.setAttribute('transform', transform);
            }
        }
    }
    
    /**
     * Serialize to JSON
     */
    toJSON() {
        return {
            id: this.id,
            definitionName: this.definition.name,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            mirror: this.mirror,
            reference: this.reference,
            value: this.value,
            properties: this.properties
        };
    }
    
    /**
     * Clean up
     */
    destroy() {
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
        this.element = null;
        this.pinElements.clear();
    }
}

export default Component;