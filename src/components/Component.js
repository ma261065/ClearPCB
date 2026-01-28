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
        
        // Selection-related properties
        this.visible = true;
        this.locked = false;
        this.selected = false;
        this.hovered = false;
    }

    get symbol() { return this.definition.symbol; }

    /**
     * Hit test - check if point is within component bounds
     */
    hitTest(point, tolerance = 1) {
        const bounds = this.getBounds();
        if (!bounds) return false;
        
        return point.x >= bounds.minX - tolerance &&
               point.x <= bounds.maxX + tolerance &&
               point.y >= bounds.minY - tolerance &&
               point.y <= bounds.maxY + tolerance;
    }

    /**
     * Hit test for anchors - components don't have resize anchors
     */
    hitTestAnchor(point, scale) {
        return null;  // Components don't have anchors
    }

    /**
     * Get anchors - components don't have resize anchors
     */
    getAnchors() {
        return [];  // Components don't have anchors
    }

    /**
     * Get bounding box in world coordinates
     */
    getBounds() {
        const symbol = this.symbol;
        if (!symbol) return null;
        
        // Get symbol dimensions
        const width = symbol.width || 10;
        const height = symbol.height || 10;
        const origin = symbol.origin || { x: width / 2, y: height / 2 };
        
        // Local bounds (relative to component origin)
        let minX = -origin.x;
        let minY = -origin.y;
        let maxX = width - origin.x;
        let maxY = height - origin.y;
        
        // Include pins in bounds
        if (symbol.pins) {
            for (const pin of symbol.pins) {
                const length = pin.length ?? 2.54;
                let px = pin.x, py = pin.y;
                
                // Extend to pin tip based on orientation
                switch (pin.orientation) {
                    case 'right': px += length; break;
                    case 'left': px -= length; break;
                    case 'up': py -= length; break;
                    case 'down': py += length; break;
                }
                
                minX = Math.min(minX, pin.x, px);
                maxX = Math.max(maxX, pin.x, px);
                minY = Math.min(minY, pin.y, py);
                maxY = Math.max(maxY, pin.y, py);
            }
        }
        
        // Apply rotation
        const rad = this.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        
        // Get all four corners and rotate them
        const corners = [
            { x: minX, y: minY },
            { x: maxX, y: minY },
            { x: maxX, y: maxY },
            { x: minX, y: maxY }
        ];
        
        let worldMinX = Infinity, worldMinY = Infinity;
        let worldMaxX = -Infinity, worldMaxY = -Infinity;
        
        for (const c of corners) {
            let x = c.x, y = c.y;
            if (this.mirror) x = -x;
            
            const rx = x * cos - y * sin;
            const ry = x * sin + y * cos;
            
            const wx = rx + this.x;
            const wy = ry + this.y;
            
            worldMinX = Math.min(worldMinX, wx);
            worldMaxX = Math.max(worldMaxX, wx);
            worldMinY = Math.min(worldMinY, wy);
            worldMaxY = Math.max(worldMaxY, wy);
        }
        
        return { minX: worldMinX, minY: worldMinY, maxX: worldMaxX, maxY: worldMaxY };
    }

    /**
     * Set selection state and update visual
     */
    setSelected(selected) {
        this.selected = selected;
        this._updateHighlight();
    }

    /**
     * Called by SelectionManager to update visual state
     */
    invalidate() {
        this._updateHighlight();
    }

    /**
     * Update visual highlight for hover and selection states
     */
    _updateHighlight() {
        if (!this.element) return;
        
        // Remove existing highlight
        const existing = this.element.querySelector('.component-highlight');
        if (existing) existing.remove();
        
        // Show highlight if hovered or selected
        if (!this.hovered && !this.selected) return;
        
        const bounds = this.getBounds();
        if (!bounds) return;
        
        const ns = 'http://www.w3.org/2000/svg';
        const highlight = document.createElementNS(ns, 'rect');
        
        // Calculate local bounds (before component transform)
        const symbol = this.symbol;
        const width = symbol?.width || 10;
        const height = symbol?.height || 10;
        const origin = symbol?.origin || { x: width / 2, y: height / 2 };
        
        // Include pins
        let minX = -origin.x, minY = -origin.y;
        let maxX = width - origin.x, maxY = height - origin.y;
        
        if (symbol?.pins) {
            for (const pin of symbol.pins) {
                const length = pin.length ?? 2.54;
                let px = pin.x, py = pin.y;
                switch (pin.orientation) {
                    case 'right': px += length; break;
                    case 'left': px -= length; break;
                    case 'up': py -= length; break;
                    case 'down': py += length; break;
                }
                minX = Math.min(minX, pin.x, px);
                maxX = Math.max(maxX, pin.x, px);
                minY = Math.min(minY, pin.y, py);
                maxY = Math.max(maxY, pin.y, py);
            }
        }
        
        highlight.setAttribute('class', 'component-highlight');
        highlight.setAttribute('x', minX - 0.5);
        highlight.setAttribute('y', minY - 0.5);
        highlight.setAttribute('width', maxX - minX + 1);
        highlight.setAttribute('height', maxY - minY + 1);
        highlight.setAttribute('fill', this.selected ? 'var(--sch-selection-fill, rgba(51,153,255,0.2))' : 'rgba(255,255,255,0.1)');
        highlight.setAttribute('stroke', this.selected ? 'var(--sch-selection, #3399ff)' : 'var(--sch-selection, #3399ff)');
        highlight.setAttribute('stroke-width', 0.2);
        highlight.setAttribute('stroke-dasharray', this.selected ? 'none' : '0.5 0.5');
        highlight.setAttribute('pointer-events', 'none');
        
        // Insert at beginning so it's behind component graphics
        this.element.insertBefore(highlight, this.element.firstChild);
    }

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
        line.setAttribute('stroke', 'var(--sch-pin, #aa0000)');
        line.setAttribute('stroke-width', 0.254);
        group.appendChild(line);

        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', x1); dot.setAttribute('cy', y1);
        dot.setAttribute('r', dotRadius);
        dot.setAttribute('fill', 'var(--sch-pin, #aa0000)'); 
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
            bubble.setAttribute('fill', 'var(--sch-symbol-fill, #ffffc0)');
            bubble.setAttribute('stroke', 'var(--sch-pin, #aa0000)');
            bubble.setAttribute('stroke-width', 0.254);
            group.appendChild(bubble);
        }

        const shouldShowName = pin.name && pin.showName !== false && pin.name !== pin.number;

        if (shouldShowName) {
            const labelGroup = document.createElementNS(ns, 'g');
            const nameTxt = document.createElementNS(ns, 'text');
            const cleanName = pin.name.replace(/[{}]/g, '').replace(/[~/]/g, '');
            nameTxt.setAttribute('font-size', 1.3);
            nameTxt.setAttribute('fill', 'var(--sch-pin-name, #00cccc)'); 
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
                overbar.setAttribute('stroke', 'var(--sch-pin-name, #00cccc)'); overbar.setAttribute('stroke-width', 0.15);
                labelGroup.appendChild(overbar);
            }
            group.appendChild(labelGroup);
        }

        if (pin.number) {
            const numTxt = document.createElementNS(ns, 'text');
            numTxt.setAttribute('x', numX); numTxt.setAttribute('y', numY);
            numTxt.setAttribute('font-size', 1.1);
            numTxt.setAttribute('fill', 'var(--sch-pin-number, #aa0000)');
            numTxt.setAttribute('text-anchor', numAnchor);
            numTxt.setAttribute('dominant-baseline', 'middle');
            numTxt.textContent = pin.number;
            group.appendChild(numTxt);
        }
        return group;
    }

    _createGraphicElement(g, ns) {
        let el;
        // Convert black colors to themed color
        const isBlack = g.stroke === 'black' || g.stroke === '#000' || g.stroke === '#000000';
        const stroke = isBlack ? 'var(--sch-symbol-outline, #aa0000)' : g.stroke;
        const fill = g.fill === 'none' ? 'none' : 'var(--sch-symbol-fill, #ffffcc)';
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
            case 'polyline':
                el = document.createElementNS(ns, 'polyline');
                const pts = g.points.map(p => `${p[0]},${p[1]}`).join(' ');
                el.setAttribute('points', pts);
                break;
            case 'text':
                el = document.createElementNS(ns, 'text');
                el.setAttribute('x', g.x); el.setAttribute('y', g.y);
                el.setAttribute('font-size', g.fontSize || 1.5);
                el.setAttribute('fill', 'var(--sch-text, #cccccc)');
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

    /**
     * Move component by delta
     */
    move(dx, dy) {
        this.setPosition(this.x + dx, this.y + dy);
    }

    setPosition(x, y) {
        this.x = x; this.y = y;
        if (this.element) {
            const transform = this._buildTransform();
            if (transform) this.element.setAttribute('transform', transform);
        }
    }

    /**
     * Remove component from DOM
     */
    destroy() {
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
        this.element = null;
        this.pinElements.clear();
    }

    /**
     * Serialize component to JSON
     */
    toJSON() {
        const json = {
            type: 'component',
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
        
        // Include full definition for online components (KiCad, LCSC, etc.)
        // This ensures the component can be loaded even if the library hasn't cached it
        if (this.definition._source && this.definition._source !== 'Built-in') {
            // Save a safe copy of the definition (avoid circular refs)
            json.definition = {
                name: this.definition.name,
                category: this.definition.category,
                description: this.definition.description,
                symbol: this.definition.symbol,
                defaultReference: this.definition.defaultReference,
                defaultValue: this.definition.defaultValue,
                defaultProperties: this.definition.defaultProperties,
                _source: this.definition._source
            };
        }
        
        return json;
    }

    /**
     * Create component from JSON data
     */
    static fromJSON(json, library) {
        const definition = library.getComponent(json.definitionName);
        if (!definition) {
            console.warn(`Component definition not found: ${json.definitionName}`);
            return null;
        }
        return new Component(definition, {
            id: json.id,
            x: json.x,
            y: json.y,
            rotation: json.rotation,
            mirror: json.mirror,
            reference: json.reference,
            value: json.value,
            properties: json.properties
        });
    }
}
export default Component;