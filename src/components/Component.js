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
        
        const localBounds = this._getLocalBounds();
        let minX = localBounds.minX;
        let minY = localBounds.minY;
        let maxX = localBounds.maxX;
        let maxY = localBounds.maxY;
        
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
        
        const localBounds = this._getLocalBounds();
        const minX = localBounds.minX;
        const minY = localBounds.minY;
        const maxX = localBounds.maxX;
        const maxY = localBounds.maxY;
        
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

    /**
     * Render the component with optional lock icon
     */
    render(scale) {
        if (!this.element) return;
        
        // Update highlight for selection/hover
        this._updateHighlight();
        
        // Remove existing lock icon
        const existing = this.element.querySelector('.component-lock-icon');
        if (existing) existing.remove();
        
        // Draw lock icon when locked and selected
        if (this.locked && this.selected) {
            const localBounds = this._getLocalBounds();
            
            const ns = 'http://www.w3.org/2000/svg';
            const lockGroup = document.createElementNS(ns, 'g');
            lockGroup.setAttribute('class', 'component-lock-icon');
            
            const lockSize = 0.8; // world units
            const offset = 0.6;
            const strokeW = 0.15;
            
            // Position lock icon at top-left of local component bounds
            const lockX = localBounds.minX - offset - lockSize;
            const lockY = localBounds.minY - offset - lockSize * 0.6;
            
            const bodyW = lockSize;
            const bodyH = lockSize * 0.7;
            const bodyY = lockY + bodyH * 0.25;
            
            // Lock body
            const body = document.createElementNS(ns, 'rect');
            body.setAttribute('x', lockX);
            body.setAttribute('y', bodyY);
            body.setAttribute('width', bodyW);
            body.setAttribute('height', bodyH);
            body.setAttribute('rx', lockSize * 0.12);
            body.setAttribute('fill', 'var(--lock-icon, #666666)');
            body.setAttribute('stroke', 'var(--lock-icon, #666666)');
            body.setAttribute('stroke-width', strokeW);
            lockGroup.appendChild(body);
            
            // Lock shackle
            const shackleR = bodyW * 0.35;
            const shackleY = lockY + bodyH * 0.25;
            const shacklePath = document.createElementNS(ns, 'path');
            const shackleCx = lockX + bodyW / 2;
            const shackleD = `M ${shackleCx - shackleR} ${shackleY} ` +
                `A ${shackleR} ${shackleR} 0 0 1 ${shackleCx + shackleR} ${shackleY}`;
            shacklePath.setAttribute('d', shackleD);
            shacklePath.setAttribute('fill', 'none');
            shacklePath.setAttribute('stroke', 'var(--lock-icon, #666666)');
            shacklePath.setAttribute('stroke-width', strokeW);
            lockGroup.appendChild(shacklePath);
            
            this.element.appendChild(lockGroup);
        }
    }

    _getLocalBounds() {
        const symbol = this.symbol;
        const width = symbol?.width || 10;
        const height = symbol?.height || 10;
        const origin = symbol?.origin || { x: width / 2, y: height / 2 };

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        if (symbol?.graphics) {
            for (const g of symbol.graphics) {
                if (!g) continue;
                switch (g.type) {
                    case 'rect':
                        minX = Math.min(minX, g.x);
                        minY = Math.min(minY, g.y);
                        maxX = Math.max(maxX, g.x + g.width);
                        maxY = Math.max(maxY, g.y + g.height);
                        break;
                    case 'circle':
                        minX = Math.min(minX, g.cx - g.r);
                        minY = Math.min(minY, g.cy - g.r);
                        maxX = Math.max(maxX, g.cx + g.r);
                        maxY = Math.max(maxY, g.cy + g.r);
                        break;
                    case 'line':
                        minX = Math.min(minX, g.x1, g.x2);
                        minY = Math.min(minY, g.y1, g.y2);
                        maxX = Math.max(maxX, g.x1, g.x2);
                        maxY = Math.max(maxY, g.y1, g.y2);
                        break;
                    case 'polyline':
                    case 'polygon':
                        if (Array.isArray(g.points)) {
                            for (const p of g.points) {
                                minX = Math.min(minX, p[0]);
                                minY = Math.min(minY, p[1]);
                                maxX = Math.max(maxX, p[0]);
                                maxY = Math.max(maxY, p[1]);
                            }
                        }
                        break;
                    case 'text': {
                        const rawText = (g.text || '')
                            .replace('${REF}', this.reference)
                            .replace('${VALUE}', this.value);
                        const source = symbol?._source || this.definition?._source;
                        const fontSize = Number.isFinite(g.fontSize) ? g.fontSize : 1.5;
                        const textScale = source === 'KiCad' ? 1.6 : 1.0;
                        const actualFontSize = fontSize * textScale;
                        const textWidth = rawText.length * actualFontSize * 0.7; // More generous
                        const textHeight = actualFontSize * 1.3; // Add extra height
                        let x1 = g.x;
                        if (g.anchor === 'middle') {
                            x1 = g.x - textWidth / 2;
                        } else if (g.anchor === 'end') {
                            x1 = g.x - textWidth;
                        }
                        let y1;
                        if (g.baseline === 'text-after-edge') {
                            y1 = g.y - textHeight;
                        } else if (g.baseline === 'text-before-edge') {
                            y1 = g.y;
                        } else {
                            // middle/unspecified baseline
                            y1 = g.y - textHeight / 2;
                        }
                        minX = Math.min(minX, x1);
                        minY = Math.min(minY, y1);
                        maxX = Math.max(maxX, x1 + textWidth);
                        maxY = Math.max(maxY, y1 + textHeight);
                        break;
                    }
                }
            }
        }

        // Always include pins in bounds calculation
        if (symbol?.pins) {
            for (const pin of symbol.pins) {
                // Include pin connection point
                minX = Math.min(minX, pin.x);
                maxX = Math.max(maxX, pin.x);
                minY = Math.min(minY, pin.y);
                maxY = Math.max(maxY, pin.y);
                
                // If we have path data, parse it to get line extent
                if (pin._pathData) {
                    const pathMatch = pin._pathData.match(/M\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*([hvL])\s*(-?\d+(?:\.\d+)?)/i);
                    if (pathMatch) {
                        const startX = Number(pathMatch[1]);
                        const startY = Number(pathMatch[2]);
                        const cmd = pathMatch[3].toLowerCase();
                        const value = Number(pathMatch[4]);
                        
                        minX = Math.min(minX, startX);
                        minY = Math.min(minY, startY);
                        
                        if (cmd === 'h') {
                            const endX = startX + value;
                            minX = Math.min(minX, endX);
                            maxX = Math.max(maxX, endX);
                        } else if (cmd === 'v') {
                            const endY = startY + value;
                            minY = Math.min(minY, endY);
                            maxY = Math.max(maxY, endY);
                        }
                        
                        maxX = Math.max(maxX, startX);
                        maxY = Math.max(maxY, startY);
                    } else {
                        // Try alternate format
                        const pathMatch2 = pin._pathData.match(/M(-?\d+(?:\.\d+)?)[,\s](-?\d+(?:\.\d+)?)([hvL])(-?\d+(?:\.\d+)?)/i);
                        if (pathMatch2) {
                            const startX = Number(pathMatch2[1]);
                            const startY = Number(pathMatch2[2]);
                            const cmd = pathMatch2[3].toLowerCase();
                            const value = Number(pathMatch2[4]);
                            
                            minX = Math.min(minX, startX);
                            minY = Math.min(minY, startY);
                            
                            if (cmd === 'h') {
                                const endX = startX + value;
                                minX = Math.min(minX, endX);
                                maxX = Math.max(maxX, endX);
                            } else if (cmd === 'v') {
                                const endY = startY + value;
                                minY = Math.min(minY, endY);
                                maxY = Math.max(maxY, endY);
                            }
                            
                            maxX = Math.max(maxX, startX);
                            maxY = Math.max(maxY, startY);
                        }
                    }
                } else if (Number.isFinite(pin.length)) {
                    // Fallback to orientation-based length
                    const length = pin.length;
                    let px = pin.x, py = pin.y;
                    switch (pin.orientation) {
                        case 'right': px += length; break;
                        case 'left': px -= length; break;
                        case 'up': py -= length; break;
                        case 'down': py += length; break;
                    }
                    minX = Math.min(minX, px);
                    maxX = Math.max(maxX, px);
                    minY = Math.min(minY, py);
                    maxY = Math.max(maxY, py);
                }
            }
        }

        if (!Number.isFinite(minX)) {
            minX = -origin.x;
            minY = -origin.y;
            maxX = width - origin.x;
            maxY = height - origin.y;
        }

        const padding = 1.0; // Increased padding to ensure everything is included
        return {
            minX: minX - padding,
            minY: minY - padding,
            maxX: maxX + padding,
            maxY: maxY + padding
        };
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
                    const pinKey = pin._key || pin._id || pin.number || `${pin.x},${pin.y}`;
                    this.pinElements.set(pinKey, pinGroup);
                }
            }
        }
        
        this.element = group;
        return group;
    }

    _createPinElement(pin, ns) {
        const group = document.createElementNS(ns, 'g');
        const length = Number.isFinite(pin.length) ? pin.length : 0;
        const source = this.symbol?._source || this.definition?._source;
        
        // Pin connection point (always at pin.x, pin.y - from segment 2)
        const connectionX = pin.x; 
        const connectionY = pin.y;
        
        // Line endpoints
        let x1 = pin.x; 
        let y1 = pin.y;
        let x2 = x1, y2 = y1;

        // If we have path data, parse it to get the actual line coordinates
        if (pin._pathData) {
            // Try both space-separated and compact formats
            const pathMatch = pin._pathData.match(/M\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*([hvL])\s*(-?\d+(?:\.\d+)?)/i) ||
                            pin._pathData.match(/M(-?\d+(?:\.\d+)?)[,\s](-?\d+(?:\.\d+)?)([hvL])(-?\d+(?:\.\d+)?)/i);
            
            if (pathMatch) {
                const startX = Number(pathMatch[1]);
                const startY = Number(pathMatch[2]);
                const cmd = pathMatch[3].toLowerCase();
                const value = Number(pathMatch[4]);
                
                // Line starts at path M position
                x1 = startX;
                y1 = startY;
                
                // Line ends based on direction and length
                if (cmd === 'h') {
                    x2 = startX + value;
                    y2 = startY;
                } else if (cmd === 'v') {
                    x2 = startX;
                    y2 = startY + value;
                } else if (cmd === 'l') {
                    x2 = startX + value;
                    y2 = startY;
                }
            }
        } else {
            // Fallback to orientation-based calculation
            // Connection point at x1,y1, line extends away from body
            switch (pin.orientation) {
                case 'right':
                    x2 = x1 - length; 
                    break;
                case 'left':
                    x2 = x1 + length;
                    break;
                case 'up':
                    y2 = y1 + length;
                    break;
                case 'down':
                    y2 = y1 - length;
                    break;
            }
        }

        let nameX, nameY, nameAnchor;
        let numX, numY, numAnchor;
        let nameRot = 0;
        let numRot = 0;
        
        const isKiCad = source === 'KiCad';
        const isActiveLow = pin.bubble || pin.name?.includes('~') || pin.name?.includes('/');
        const bubbleRadius = 0.6;
        const dotRadius = 0.35;
        const kicadTextOffset = isKiCad ? (this.symbol?.kicadTextOffset ?? 0.508) : null;

        const hasNamePos = pin.namePos && Number.isFinite(pin.namePos.x) && Number.isFinite(pin.namePos.y);
        const hasNumberPos = pin.numberPos && Number.isFinite(pin.numberPos.x) && Number.isFinite(pin.numberPos.y);
        const allowInfer = !(this.symbol?._source === 'EasyEDA');

        if (hasNamePos) {
            nameX = pin.namePos.x;
            nameY = pin.namePos.y;
            nameAnchor = pin.namePos.anchor || nameAnchor;
            if (Number.isFinite(pin.namePos.rotation)) {
                nameRot = pin.namePos.rotation;
            }
        }

        if (hasNumberPos) {
            numX = pin.numberPos.x;
            numY = pin.numberPos.y;
            numAnchor = pin.numberPos.anchor || numAnchor;
            if (Number.isFinite(pin.numberPos.rotation)) {
                numRot = pin.numberPos.rotation;
            }
        }

        if (allowInfer && (!hasNamePos || !hasNumberPos)) {
            if (isKiCad) {
                const dx = x2 - x1;
                const dy = y2 - y1;
                const lineLen = Math.hypot(dx, dy) || 1;
                const ux = dx / lineLen;
                const uy = dy / lineLen;
                const isHorizontal = Math.abs(ux) >= Math.abs(uy);
                const numPerpOffset = Number.isFinite(pin.kicadNumberYOffset)
                    ? pin.kicadNumberYOffset
                    : -0.05;
                const perpX = -uy;
                const perpY = ux;

                if (!hasNamePos) {
                    nameX = x2 + ux * kicadTextOffset;
                    nameY = y2 + uy * kicadTextOffset;
                    if (isHorizontal) {
                        nameAnchor = ux >= 0 ? 'start' : 'end';
                    } else {
                        nameAnchor = uy >= 0 ? 'end' : 'start';
                        nameRot = -90;
                    }
                }

                if (!hasNumberPos) {
                    numX = x2 - ux * kicadTextOffset + perpX * numPerpOffset;
                    numY = y2 - uy * kicadTextOffset + perpY * numPerpOffset;
                    if (isHorizontal) {
                        numAnchor = ux >= 0 ? 'end' : 'start';
                    } else {
                        numAnchor = uy >= 0 ? 'start' : 'end';
                        numRot = -90;
                    }
                }
            } else {
            const labelOffset = length + 0.2;
            // BODY-ANCHOR LOGIC
            // We ensure the number stays close to the body/bubble so it doesn't drift into the connection dot.
            const bubbleClearance = isActiveLow ? (bubbleRadius * 2) + 0.2 : 0;
            const numBodyOffset = 0.5;
            const numPos = length - (bubbleClearance + numBodyOffset);
            
            const numOffsetLR = 0.35;
            const numOffsetUD = 0.5;
            switch (pin.orientation) {
                case 'right':
                    if (!hasNamePos) {
                        nameX = x1 + labelOffset; nameY = y1; nameAnchor = 'start';
                    }
                    if (!hasNumberPos) {
                        numX = x1 + numPos; numY = y1 - numOffsetLR; numAnchor = 'middle';
                    }
                    break;
                case 'left':
                    if (!hasNamePos) {
                        nameX = x1 - labelOffset; nameY = y1; nameAnchor = 'end';
                    }
                    if (!hasNumberPos) {
                        numX = x1 - numPos; numY = y1 - numOffsetLR; numAnchor = 'middle';
                    }
                    break;
                case 'up':
                    if (!hasNamePos) {
                        nameX = x1; nameY = y1 - labelOffset; nameAnchor = 'end'; nameRot = 90;
                    }
                    if (!hasNumberPos) {
                        numX = x1 - numOffsetUD; numY = y1 - numPos; numAnchor = 'middle';
                    }
                    break;
                case 'down':
                    if (!hasNamePos) {
                        nameX = x1; nameY = y1 + labelOffset; nameAnchor = 'start'; nameRot = 90;
                    }
                    if (!hasNumberPos) {
                        numX = x1 - numOffsetUD; numY = y1 + numPos; numAnchor = 'middle';
                    }
                    break;
            }
            }
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
        line.setAttribute('stroke-width', 0.2);
        group.appendChild(line);

        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', connectionX); dot.setAttribute('cy', connectionY);
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

        if (shouldShowName && (hasNamePos || allowInfer)) {
            const labelGroup = document.createElementNS(ns, 'g');
            const nameTxt = document.createElementNS(ns, 'text');
            const cleanName = pin.name.replace(/[{}]/g, '').replace(/[~/]/g, '');
            const nameFontSizeBase = (pin.namePos && Number.isFinite(pin.namePos.fontSize))
                ? pin.namePos.fontSize
                : (source === 'KiCad' ? (pin.kicadNameFontSize || 1.27) : 1.0);
            const nameFontScale = source === 'KiCad' ? 1.3386 : 1.0;
            const nameFontSize = nameFontSizeBase * nameFontScale;
            const nameFontFamily = (pin.namePos && pin.namePos.fontFamily)
                ? pin.namePos.fontFamily
                : (source === 'EasyEDA' || source === 'KiCad' ? 'Verdana' : null);
            nameTxt.setAttribute('font-size', nameFontSize);
            if (nameFontFamily) {
                nameTxt.setAttribute('font-family', nameFontFamily);
            }
            nameTxt.setAttribute('fill', 'var(--sch-pin-name, #00cccc)'); 
            if (nameAnchor) {
                nameTxt.setAttribute('text-anchor', nameAnchor);
            }
            if (this.symbol?._source !== 'EasyEDA') {
                nameTxt.setAttribute('dominant-baseline', 'middle');
            }
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

        if (pin.number && (hasNumberPos || allowInfer)) {
            const numLabelGroup = document.createElementNS(ns, 'g');
            const numTxt = document.createElementNS(ns, 'text');
            const numFontSizeBase = (pin.numberPos && Number.isFinite(pin.numberPos.fontSize))
                ? pin.numberPos.fontSize
                : (source === 'KiCad' ? (pin.kicadNumberFontSize || 1.27) : 0.7);
            const numFontScale = source === 'KiCad' ? 1.3386 : 1.0;
            const numFontSize = numFontSizeBase * numFontScale;
            const numFontFamily = (pin.numberPos && pin.numberPos.fontFamily)
                ? pin.numberPos.fontFamily
                : (source === 'EasyEDA' || source === 'KiCad' ? 'Verdana' : null);
            numTxt.setAttribute('font-size', numFontSize);
            if (numFontFamily) {
                numTxt.setAttribute('font-family', numFontFamily);
            }
            numTxt.setAttribute('fill', 'var(--sch-pin-number, #aa0000)');
            if (numAnchor) {
                numTxt.setAttribute('text-anchor', numAnchor);
            }
            if (this.symbol?._source === 'KiCad') {
                numTxt.setAttribute('dominant-baseline', 'text-after-edge');
            } else if (this.symbol?._source !== 'EasyEDA') {
                numTxt.setAttribute('dominant-baseline', 'middle');
            }
            numTxt.textContent = pin.number;
            if (numRot !== 0) {
                numLabelGroup.setAttribute('transform', `translate(${numX},${numY}) rotate(${numRot})`);
            } else {
                numTxt.setAttribute('x', numX); numTxt.setAttribute('y', numY);
            }
            numLabelGroup.appendChild(numTxt);
            group.appendChild(numLabelGroup);
        }
        return group;
    }

    _createGraphicElement(g, ns) {
        let el;
        // Ignore colors from component data, use themed colors
        const stroke = 'var(--sch-symbol-outline, #000000)';
        const fill = 'none';
        switch (g.type) {
            case 'rect':
                el = document.createElementNS(ns, 'rect');
                el.setAttribute('x', g.x); el.setAttribute('y', g.y);
                el.setAttribute('width', g.width); el.setAttribute('height', g.height);
                if (Number.isFinite(g.rx)) el.setAttribute('rx', g.rx);
                if (Number.isFinite(g.ry)) el.setAttribute('ry', g.ry);
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
            case 'polygon':
                el = document.createElementNS(ns, 'polygon');
                const polPts = g.points.map(p => `${p[0]},${p[1]}`).join(' ');
                el.setAttribute('points', polPts);
                break;
            case 'path':
                el = document.createElementNS(ns, 'path');
                el.setAttribute('d', g.d);
                break;
            case 'text':
                el = document.createElementNS(ns, 'text');
                el.setAttribute('x', g.x); el.setAttribute('y', g.y);
                const textSize = g.fontSize || 1.5;
                const source = this.symbol?._source || this.definition?._source;
                const textScale = source === 'KiCad' ? 1.6 : 1.0;
                el.setAttribute('font-size', textSize * textScale);
                if (source === 'KiCad') {
                    el.setAttribute('font-family', 'Verdana');
                }
                el.setAttribute('fill', 'var(--sch-text, #cccccc)');
                if (g.anchor) el.setAttribute('text-anchor', g.anchor);
                if (g.baseline) {
                    el.setAttribute('dominant-baseline', g.baseline);
                } else {
                    el.setAttribute('dominant-baseline', 'middle');
                }
                el.textContent = (g.text || '').replace('${REF}', this.reference).replace('${VALUE}', this.value);
                return el;
        }
        if (el) {
            el.setAttribute('stroke', stroke); el.setAttribute('fill', fill);
            el.setAttribute('stroke-width', g.strokeWidth || 0.254);
            el.setAttribute('stroke-linecap', 'round');
            el.setAttribute('stroke-linejoin', 'round');
            if (g.transform) {
                el.setAttribute('transform', g.transform);
            }
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