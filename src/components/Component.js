/**
 * Component class - represents an electronic component instance on the schematic
 */
export class Component {
    constructor(definition, options = {}) {
        this.id = options.id || `component_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.definition = definition;
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.rotation = options.rotation || 0;
        this.mirror = options.mirror || false;
        this.reference = options.reference || definition.defaultReference || 'U?';
        this.value = options.value || definition.defaultValue || definition.name;
        this.properties = { ...definition.defaultProperties, ...options.properties };
        this.element = null;
        this.pinElements = new Map();
    }

    get symbol() { return this.definition.symbol; }

    createSymbolElement(ns = 'http://www.w3.org/2000/svg') {
        const group = document.createElementNS(ns, 'g');
        group.setAttribute('class', 'component');
        group.setAttribute('data-id', this.id);
        
        const transform = this._buildTransform();
        if (transform) group.setAttribute('transform', transform);

        if (this.symbol?.graphics) {
            for (const graphic of this.symbol.graphics) {
                const el = this._createGraphicElement(graphic, ns);
                if (el) group.appendChild(el);
            }
        }

        if (this.symbol?.pins) {
            for (const pin of this.symbol.pins) {
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

    _createPinElement(pin, ns) {
        const group = document.createElementNS(ns, 'g');
        const length = pin.length ?? 2.54;
        
        const x1 = pin.x; 
        const y1 = pin.y;
        let x2 = x1, y2 = y1;

        let nameX, nameY, nameAnchor;
        let numX, numY, numAnchor;
        let nameRot = 0;
        
        const labelOffset = length + 1.0; 
        const isActiveLow = pin.bubble || pin.name?.includes('~') || pin.name?.includes('/');
        const bubbleRadius = 0.6;
        const dotRadius = 0.45;

        // BODY-ANCHOR LOGIC
        // We ensure the number stays close to the body/bubble so it doesn't drift into the connection dot.
        const bubbleClearance = isActiveLow ? (bubbleRadius * 2) + 0.2 : 0;
        const marginFromBody = 0.6; 
        const numPos = length - (bubbleClearance + marginFromBody);
        
        const lineNudge = 0.5; 

        switch (pin.orientation) {
            case 'right':
                x2 = x1 + length; 
                nameX = x1 + labelOffset; nameY = y1; nameAnchor = 'start';
                numX = x1 + numPos; numY = y1 - lineNudge; numAnchor = 'middle';
                break;
            case 'left':
                x2 = x1 - length;
                nameX = x1 - labelOffset; nameY = y1; nameAnchor = 'end';
                numX = x1 - numPos; numY = y1 - lineNudge; numAnchor = 'middle';
                break;
            case 'up':
                y2 = y1 - length;
                nameX = x1; nameY = y1 - labelOffset; nameAnchor = 'end'; nameRot = 90;
                numX = x1 - lineNudge; numY = y1 - numPos; numAnchor = 'middle';
                break;
            case 'down':
                y2 = y1 + length;
                nameX = x1; nameY = y1 + labelOffset; nameAnchor = 'start'; nameRot = 90;
                numX = x1 - lineNudge; numY = y1 + numPos; numAnchor = 'middle';
                break;
        }

        let lineX2 = x2, lineY2 = y2;
        if (isActiveLow) {
            const bOffset = bubbleRadius * 2;
            if (pin.orientation === 'right') lineX2 -= bOffset;
            else if (pin.orientation === 'left') lineX2 += bOffset;
            else if (pin.orientation === 'up') lineY2 += bOffset;
            else if (pin.orientation === 'down') lineY2 -= bOffset;
        }

        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', x1); line.setAttribute('y1', y1);
        line.setAttribute('x2', lineX2); line.setAttribute('y2', lineY2);
        line.setAttribute('stroke', 'var(--schematic-pin, #800000)');
        line.setAttribute('stroke-width', 0.254);
        group.appendChild(line);

        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', x1); dot.setAttribute('cy', y1);
        dot.setAttribute('r', dotRadius);
        dot.setAttribute('fill', 'var(--schematic-pin, #800000)'); 
        dot.setAttribute('stroke', 'none'); 
        group.appendChild(dot);

        if (isActiveLow) {
            const bubble = document.createElementNS(ns, 'circle');
            let bx = x2, by = y2;
            if (pin.orientation === 'right') bx -= bubbleRadius;
            else if (pin.orientation === 'left') bx += bubbleRadius;
            else if (pin.orientation === 'up') by += bubbleRadius;
            else if (pin.orientation === 'down') by -= bubbleRadius;
            bubble.setAttribute('cx', bx); bubble.setAttribute('cy', by);
            bubble.setAttribute('r', bubbleRadius);
            bubble.setAttribute('fill', 'var(--schematic-body-bg, #ffffc0)');
            bubble.setAttribute('stroke', 'var(--schematic-pin, #800000)');
            bubble.setAttribute('stroke-width', 0.254);
            group.appendChild(bubble);
        }

        const shouldShowName = pin.name && pin.showName !== false && pin.name !== pin.number;

        if (shouldShowName) {
            const labelGroup = document.createElementNS(ns, 'g');
            const nameTxt = document.createElementNS(ns, 'text');
            const cleanName = pin.name.replace(/[{}]/g, '').replace(/[~/]/g, '');
            nameTxt.setAttribute('font-size', 1.3);
            nameTxt.setAttribute('fill', '#0000FF'); 
            nameTxt.setAttribute('text-anchor', nameAnchor);
            nameTxt.setAttribute('dominant-baseline', 'middle');
            nameTxt.textContent = cleanName;

            if (nameRot !== 0) {
                labelGroup.setAttribute('transform', `translate(${nameX},${nameY}) rotate(${nameRot})`);
            } else {
                nameTxt.setAttribute('x', nameX); nameTxt.setAttribute('y', nameY);
            }
            labelGroup.appendChild(nameTxt);

            if (isActiveLow) {
                const overbar = document.createElementNS(ns, 'line');
                const textWidth = cleanName.length * 0.65; 
                let oy = (nameRot !== 0) ? -0.8 : nameY - 0.8; 
                let ox1, ox2;
                if (nameAnchor === 'start') {
                    ox1 = (nameRot !== 0) ? 0.1 : nameX + 0.1;
                    ox2 = ox1 + textWidth;
                } else {
                    ox2 = (nameRot !== 0) ? -0.1 : nameX - 0.1;
                    ox1 = ox2 - textWidth;
                }
                overbar.setAttribute('x1', ox1); overbar.setAttribute('y1', oy);
                overbar.setAttribute('x2', ox2); overbar.setAttribute('y2', oy);
                overbar.setAttribute('stroke', '#0000FF'); overbar.setAttribute('stroke-width', 0.15);
                labelGroup.appendChild(overbar);
            }
            group.appendChild(labelGroup);
        }

        if (pin.number) {
            const numTxt = document.createElementNS(ns, 'text');
            numTxt.setAttribute('x', numX); numTxt.setAttribute('y', numY);
            numTxt.setAttribute('font-size', 1.1);
            numTxt.setAttribute('fill', '#0000FF');
            numTxt.setAttribute('text-anchor', numAnchor);
            numTxt.setAttribute('dominant-baseline', 'middle');
            numTxt.textContent = pin.number;
            group.appendChild(numTxt);
        }
        return group;
    }

    _createGraphicElement(g, ns) {
        let el;
        const stroke = (g.stroke === 'black' || g.stroke === '#000') ? 'var(--schematic-body, #800000)' : g.stroke;
        const fill = g.fill === 'none' ? 'none' : 'var(--schematic-body-bg, #ffffc0)';
        switch (g.type) {
            case 'rect':
                el = document.createElementNS(ns, 'rect');
                el.setAttribute('x', g.x); el.setAttribute('y', g.y);
                el.setAttribute('width', g.width); el.setAttribute('height', g.height);
                break;
            case 'circle':
                el = document.createElementNS(ns, 'circle');
                el.setAttribute('cx', g.cx); el.setAttribute('cy', g.cy); el.setAttribute('r', g.r);
                break;
            case 'line':
                el = document.createElementNS(ns, 'line');
                el.setAttribute('x1', g.x1); el.setAttribute('y1', g.y1);
                el.setAttribute('x2', g.x2); el.setAttribute('y2', g.y2);
                break;
            case 'text':
                el = document.createElementNS(ns, 'text');
                el.setAttribute('x', g.x); el.setAttribute('y', g.y);
                el.setAttribute('font-size', g.fontSize || 1.5);
                el.setAttribute('fill', '#800000');
                if (g.anchor) el.setAttribute('text-anchor', g.anchor);
                el.textContent = (g.text || '').replace('${REF}', this.reference).replace('${VALUE}', this.value);
                return el;
        }
        if (el) {
            el.setAttribute('stroke', stroke); el.setAttribute('fill', fill);
            el.setAttribute('stroke-width', g.strokeWidth || 0.254);
        }
        return el;
    }

    _buildTransform() {
        const parts = [];
        if (this.x || this.y) parts.push(`translate(${this.x},${this.y})`);
        if (this.rotation) parts.push(`rotate(${this.rotation})`);
        if (this.mirror) parts.push('scale(-1, 1)');
        return parts.length ? parts.join(' ') : null;
    }

    getPinPosition(number) {
        const pin = this.getPin(number);
        if (!pin) return null;
        let x = pin.x, y = pin.y;
        if (this.mirror) x = -x;
        const rad = this.rotation * Math.PI / 180;
        return {
            x: (x * Math.cos(rad) - y * Math.sin(rad)) + this.x,
            y: (x * Math.sin(rad) + y * Math.cos(rad)) + this.y
        };
    }

    getPin(num) { return this.symbol?.pins?.find(p => p.number === String(num)); }

    setPosition(x, y) {
        this.x = x; this.y = y;
        if (this.element) {
            const transform = this._buildTransform();
            if (transform) this.element.setAttribute('transform', transform);
        }
    }
}
export default Component;