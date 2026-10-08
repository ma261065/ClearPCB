/**
 * Text - SVG text label
 */

import { Shape } from './shape.js';
import { ShapeValidator } from '../core/ShapeValidator.js';
import { hasOwnLock } from './lock-owner.js';

/** Round to 4 decimal places for compact serialisation. */
/** @param {number} v */
const _r4 = v => Math.round(v * 10000) / 10000;

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{x:number,y:number,width:number,height:number}} TextBBox */
/** @typedef {{type?: string, id?: string, locked?: boolean, syncTextOffsetFromLabelText?: () => void}} TextParent */
/** @typedef {{x?: number, y?: number, text?: string, fontSize?: number, fontFamily?: string, textAnchor?: string, rotation?: number, border?: boolean, attachment?: Record<string, any>|null, parentComponentId?: string|null, fieldKey?: string|null, visible?: boolean, color?: string|number, fillColor?: string|number|null}} TextOptions */
/** @typedef {{x: number, y: number, text: string, fontSize: number, fontFamily: string, textAnchor: string, rotation: 0|270, border: boolean, attachment?: Record<string, any>|null, parentComponentId?: string|null, fieldKey?: string|null, visible?: boolean}} TextState */
/** @typedef {ReturnType<Shape['toJSON']> & {x: number, y: number, t: string, fs?: number, ff?: string, ta?: string, rot?: number, bd?: true, cid?: string, fk?: string|null, att?: Record<string, any>}} TextJSON */

/** @type {null | ((text: Text) => TextBBox|null|undefined)} */
let textMeasurer = null;

/** @param {null | ((text: Text) => TextBBox|null|undefined)} fn */
export function setTextMeasurer(fn) {
    textMeasurer = typeof fn === 'function' ? fn : null;
}

/**
 * Schematic text reads horizontally (0) or vertically, bottom to top (270), like every
 * other schematic object; any other stored angle snaps to the nearer of the two.
 * @param {number} [rotation]
 * @returns {0|270}
 */
export function textOrientation(rotation = 0) {
    const angle = ((Number(rotation) || 0) % 180 + 180) % 180;
    return angle > 45 && angle < 135 ? 270 : 0;
}

export class Text extends Shape {
    /**
     * @param {TextOptions} [options]
     */
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
        this.rotation = textOrientation(options.rotation);
        this.border = !!options.border;

        // Text is rendered as a filled glyph, so its fill follows `color`
        // unless an explicit override is supplied. Without this, reloaded
        // text (which only serialises `color`) would fall back to the
        // generic shape-fill default and lose its colour.
        if (options.fillColor == null) this.fillColor = this.color;
        
        // Component field linkage (set externally, not via constructor)
        /** @type {TextParent|null} */
        this.parentComponent = null;
        this.fieldKey = null;  // 'reference', 'value', or 'wireLabel'
        this.attachment = options.attachment || null;
    }

    _syncLinkedParentAfterGeometryChange() {
        if (this.parentComponent?.type === 'net' && this.fieldKey === 'net') {
            this.parentComponent.syncTextOffsetFromLabelText?.();
        }
    }

    /** @override — uses SVG `getBBox()` when rendered, else estimates from text length. */
    _calculateBounds() {
        let localBounds;
        if (textMeasurer) {
            try {
                const bbox = textMeasurer(this);
                if (bbox) {
                    localBounds = {
                        minX: bbox.x, minY: bbox.y,
                        maxX: bbox.x + bbox.width, maxY: bbox.y + bbox.height
                    };
                }
            } catch (e) { /* fall through to estimate */ }
        }

        if (!localBounds) {
            const approxWidth = this.text.length * this.fontSize * 0.6;
            const approxHeight = this.fontSize;
            const padding = this.border ? this.fontSize * 0.2 : 0;
            let minX = this.x;
            if (this.textAnchor === 'middle') {
                minX = this.x - approxWidth / 2;
            } else if (this.textAnchor === 'end') {
                minX = this.x - approxWidth;
            }
            localBounds = {
                minX: minX - padding, minY: this.y - approxHeight - padding,
                maxX: minX + approxWidth + padding, maxY: this.y + padding
            };
        }

        if (!this.rotation) return localBounds;

        // Rotate all four corners around the text anchor and recompute AABB
        const rad = (this.rotation * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const cx = this.x, cy = this.y;
        const corners = [
            { x: localBounds.minX, y: localBounds.minY },
            { x: localBounds.maxX, y: localBounds.minY },
            { x: localBounds.maxX, y: localBounds.maxY },
            { x: localBounds.minX, y: localBounds.maxY },
        ];
        let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
        for (const c of corners) {
            const dx = c.x - cx, dy = c.y - cy;
            const rx = cx + dx * cos - dy * sin;
            const ry = cy + dx * sin + dy * cos;
            if (rx < rMinX) rMinX = rx;
            if (ry < rMinY) rMinY = ry;
            if (rx > rMaxX) rMaxX = rx;
            if (ry > rMaxY) rMaxY = ry;
        }
        return { minX: rMinX, minY: rMinY, maxX: rMaxX, maxY: rMaxY };
    }

    /**
     * @override
     * @param {Point} point @param {number} [tolerance]
     */
    hitTest(point, tolerance = 0.5) {
        if (!this.rotation) {
            const bounds = this.getBounds();
            return (
                point.x >= bounds.minX - tolerance &&
                point.x <= bounds.maxX + tolerance &&
                point.y >= bounds.minY - tolerance &&
                point.y <= bounds.maxY + tolerance
            );
        }

        // Rotate the test point into the text's local (un-rotated) space
        const rad = (-this.rotation * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const dx = point.x - this.x, dy = point.y - this.y;
        const local = {
            x: this.x + dx * cos - dy * sin,
            y: this.y + dx * sin + dy * cos
        };

        // Get un-rotated bounds for the local-space test
        let localBounds;
        if (textMeasurer) {
            try {
                const bbox = textMeasurer(this);
                if (bbox) localBounds = { minX: bbox.x, minY: bbox.y, maxX: bbox.x + bbox.width, maxY: bbox.y + bbox.height };
            } catch (e) { /* fall through */ }
        }
        if (!localBounds) {
            const approxWidth = this.text.length * this.fontSize * 0.6;
            const approxHeight = this.fontSize;
            let minX = this.x;
            if (this.textAnchor === 'middle') minX = this.x - approxWidth / 2;
            else if (this.textAnchor === 'end') minX = this.x - approxWidth;
            localBounds = { minX, minY: this.y - approxHeight, maxX: minX + approxWidth, maxY: this.y };
        }

        return (
            local.x >= localBounds.minX - tolerance &&
            local.x <= localBounds.maxX + tolerance &&
            local.y >= localBounds.minY - tolerance &&
            local.y <= localBounds.maxY + tolerance
        );
    }

    /** @override */
    getAnchors() {
        return [
            { id: 'pos', x: this.x, y: this.y, cursor: 'move', hidden: true }
        ];
    }
    /**
     * @override
     * @param {string} anchorId @param {number} x @param {number} y
     */
    moveAnchor(anchorId, x, y) {
        if (anchorId === 'pos') {
            this.x = x;
            this.y = y;
            this.invalidate();
            this._syncLinkedParentAfterGeometryChange();
        }
        return undefined;
    }

    /**
     * @override
     * @param {number} dx @param {number} dy
     */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx;
        this.y += dy;
        this.invalidate();
        this._syncLinkedParentAfterGeometryChange();
    }

    /** @override */
    clone() {
        return new Text({
            ...this.toJSON(),
            x: this.x,
            y: this.y,
            text: this.text,
            fontSize: this.fontSize,
            fontFamily: this.fontFamily,
            textAnchor: this.textAnchor,
            rotation: this.rotation,
            border: this.border
        });
    }
    
    /** @override */
    captureState() {
        const state = /** @type {TextState} */ ({ x: this.x, y: this.y, text: this.text, fontSize: this.fontSize, fontFamily: this.fontFamily, textAnchor: this.textAnchor, rotation: this.rotation, border: this.border });
        if (this.attachment) state.attachment = { ...this.attachment };
        else state.attachment = null;
        state.parentComponentId = this.parentComponent?.id || null;
        state.fieldKey = this.fieldKey || null;
        // Include visibility for field texts so merge/split undo restores it
        if (this.fieldKey) state.visible = this.visible;
        return state;
    }

    /**
     * @override
     * @param {Partial<TextState> & Record<string, any>} state
     */
    applyState(state) {
        super.applyState(state);
        if ('attachment' in state) {
            this.attachment = state.attachment ? { ...state.attachment } : null;
        }
        if ('fieldKey' in state) {
            this.fieldKey = state.fieldKey;
        }
        this._syncLinkedParentAfterGeometryChange();
    }
    /** @override */
    getPropertyDescriptors() {
        if (this.fieldKey) {
            // Component/wire field text — show text content as editable, plus size
            const label = this.fieldKey === 'reference' ? 'Reference'
                        : this.fieldKey === 'wireLabel' ? 'Name'
                        : this.fieldKey === 'label' ? 'Label'
                        : 'Value';
            /** @type {ReturnType<import('./shape.js').Shape['getPropertyDescriptors']>} */
            const descriptors = [
                // An owned field text follows its owner's lock (lock-owner.js); a detachable label has its own.
                ...(hasOwnLock(this) ? [{ key: 'locked', label: 'Locked', type: 'checkbox' }] : []),
                { key: 'text',     label,               type: 'text' },
                { key: 'fontSize', label: 'Text Size (mm)',  type: 'number', min: 0.5, max: 50, step: 0.5 },
            ];
            if (this.fieldKey === 'label') {
                descriptors.push({ key: 'border', label: 'Border', type: 'checkbox' });
            }
            return descriptors;
        }
        return [
            { key: 'locked',   label: 'Locked',    type: 'checkbox' },
            { key: 'text',     label: 'Label',      type: 'text' },
            { key: 'fontSize', label: 'Text Size (mm)',  type: 'number', min: 0.5, max: 50, step: 0.5 },
            { key: 'border',   label: 'Border',     type: 'checkbox' },
        ];
    }
    
    /** @override */
    get supportsInlineEdit() {
        return true;
    }
    /** @override */
    toJSON() {
        const json = /** @type {TextJSON} */ ({
            ...super.toJSON(),
            x: _r4(this.x),
            y: _r4(this.y),
            t: this.text,
        });
        if (this.fontSize !== 2.0) json.fs = this.fontSize;
        if (this.fontFamily !== 'Arial') json.ff = this.fontFamily;
        if (this.textAnchor !== 'start') json.ta = this.textAnchor;
        if (this.rotation) json.rot = this.rotation;
        if (this.border) json.bd = true;
        if (this.parentComponent) {
            json.cid = this.parentComponent.id;
            json.fk = this.fieldKey;
        }
        if (this.attachment) {
            json.att = { ...this.attachment };
        }
        return json;
    }
}
