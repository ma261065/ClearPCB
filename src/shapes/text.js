/**
 * Text - SVG text label
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';

export class Text extends Shape {
    constructor(options = {}) {
        super(options);
        this.type = 'text';

        this.x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
        this.y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
        this.text = typeof options.text === 'string' ? options.text : '';
        this.fontSize = ShapeValidator.validateNumber(options.fontSize || 2.0, {
            min: 1,
            max: 50,
            default: 2.0,
            name: 'fontSize'
        });
        this.fontFamily = options.fontFamily || 'Arial';
        this.textAnchor = options.textAnchor || 'start';
        
        // Component field linkage (set externally, not via constructor)
        this.parentComponent = null;
        this.fieldKey = null;  // 'reference' or 'value'
    }

    _calculateBounds() {
        if (this.element) {
            try {
                const bbox = this.element.getBBox();
                return {
                    minX: bbox.x,
                    minY: bbox.y,
                    maxX: bbox.x + bbox.width,
                    maxY: bbox.y + bbox.height
                };
            } catch (e) {
                // Fall back to estimated bounds
            }
        }

        const approxWidth = this.text.length * this.fontSize * 0.6;
        const approxHeight = this.fontSize;
        let minX = this.x;
        if (this.textAnchor === 'middle') {
            minX = this.x - approxWidth / 2;
        } else if (this.textAnchor === 'end') {
            minX = this.x - approxWidth;
        }
        return {
            minX,
            minY: this.y - approxHeight,
            maxX: minX + approxWidth,
            maxY: this.y
        };
    }

    hitTest(point, tolerance = 0.5) {
        const bounds = this.getBounds();
        return (
            point.x >= bounds.minX - tolerance &&
            point.x <= bounds.maxX + tolerance &&
            point.y >= bounds.minY - tolerance &&
            point.y <= bounds.maxY + tolerance
        );
    }

    getAnchors() {
        return [
            { id: 'pos', x: this.x, y: this.y, cursor: 'move', hidden: true }
        ];
    }

    moveAnchor(anchorId, x, y) {
        if (anchorId === 'pos') {
            this.x = x;
            this.y = y;
            this.invalidate();
        }
    }

    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'text');
    }

    _updateElement(el, strokeColor, fillColor, scale) {
        el.setAttribute('x', this.x);
        el.setAttribute('y', this.y);
        // When parent component is selected but this field text isn't,
        // tint blue to show ownership
        if (this.parentComponent?.selected && !this.selected && !this.hovered) {
            fillColor = 'var(--sch-selection, #3399ff)';
        }
        el.setAttribute('fill', fillColor);
        el.setAttribute('font-size', this.fontSize);
        el.setAttribute('font-family', this.fontFamily);
        el.setAttribute('text-anchor', this.textAnchor);
        el.setAttribute('dominant-baseline', 'alphabetic');
        el.setAttribute('alignment-baseline', 'alphabetic');
        el.setAttribute('xml:space', 'preserve');
        el.style.whiteSpace = 'pre';
        el.textContent = typeof this.text === 'string' ? this.text : '';
        el.removeAttribute('stroke');
    }

    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        this.invalidate();
    }

    clone() {
        return new Text({
            ...this.toJSON(),
            x: this.x,
            y: this.y,
            text: this.text,
            fontSize: this.fontSize,
            fontFamily: this.fontFamily,
            textAnchor: this.textAnchor
        });
    }
    
    captureState() {
        return { x: this.x, y: this.y, text: this.text, fontSize: this.fontSize, fontFamily: this.fontFamily, textAnchor: this.textAnchor };
    }
    
    getPropertyDescriptors() {
        if (this.fieldKey) {
            // Component field text — show text content as editable, plus size
            return [
                { key: 'locked',   label: 'Locked',    type: 'checkbox' },
                { key: 'text',     label: this.fieldKey === 'reference' ? 'Reference' : 'Value', type: 'text' },
                { key: 'fontSize', label: 'Text size',  type: 'number', min: 0.5, max: 50, step: 0.5 },
            ];
        }
        return [
            { key: 'locked',   label: 'Locked',    type: 'checkbox' },
            { key: 'text',     label: 'Text',       type: 'text' },
            { key: 'fontSize', label: 'Text size',  type: 'number', min: 0.5, max: 50, step: 0.5 },
        ];
    }
    
    get supportsInlineEdit() {
        return true;
    }

    toJSON() {
        const json = {
            ...super.toJSON(),
            x: this.x,
            y: this.y,
            text: this.text,
            fontSize: this.fontSize,
            fontFamily: this.fontFamily,
            textAnchor: this.textAnchor
        };
        if (this.parentComponent) {
            json.componentId = this.parentComponent.id;
            json.fieldKey = this.fieldKey;
        }
        return json;
    }
}
