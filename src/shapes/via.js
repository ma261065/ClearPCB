/**
 * Via – Plated through-hole connecting copper layers
 *
 * All vias on a PCB are standalone Via objects, decoupled from any
 * Track. They may sit at a Track's layer-change node (placed there by
 * the drawing/autorouter pipeline) but moving the Track does NOT move
 * the Via — and vice versa.
 *
 * Vias are positioned in world coordinates (mm). The annular ring is
 * drawn as a filled circle of radius (diameter / 2); the drill is a
 * concentric circle of radius (drill / 2).
 *
 * Note: Via is a lightweight data class — it does not extend Shape. The
 * PCB editor renders Vias via src/pcb/modules/track-render.js, not via
 * the schematic Shape pipeline.
 */

import { IdAllocator } from '../core/id-allocator.js';

/**
 * @typedef {{x: number, y: number}} Point
 * @typedef {{
 *   id?: string,
 *   x?: number,
 *   y?: number,
 *   diameter?: number,
 *   drill?: number,
 *   net?: string,
 *   locked?: boolean,
 *   visible?: boolean,
 * }} ViaOptions
 * @typedef {{
 *   id: string,
 *   x: number,
 *   y: number,
 *   diameter: number,
 *   drill: number,
 *   net: string,
 *   locked: boolean,
 *   visible: boolean,
 * }} ViaState
 * @typedef {{type: 'via', id: string, x: number, y: number, d: number, dr: number, n?: string, lk?: boolean, v?: boolean}} ViaJSON
 */

const viaIds = new IdAllocator('via');
/** @param {number} value */
const round4 = value => Math.round(value * 10000) / 10000;

/** Reset the via ID counter (for testing / new-document). */
export function resetViaIdCounter() {
    viaIds.reset();
}

/** Update the via ID counter so newly-issued IDs don't collide on load. */
/** @param {string} id */
export function updateViaIdCounter(id) {
    viaIds.observe(id);
}

/** Issue the next unused generated Via ID. */
export function nextViaId() {
    return viaIds.next();
}

/** Physical bounds, also accepting detached plain via data. */
/** @param {{x: number, y: number, diameter?: number}} via */
export function viaBounds(via) {
    const radius = Math.max(0, Number(via.diameter) || 0.6) / 2;
    return { minX: via.x - radius, minY: via.y - radius, maxX: via.x + radius, maxY: via.y + radius };
}

/** Test the outer via area, including its drill centre. Tolerance is in mm. */
/**
 * @param {{x: number, y: number, diameter?: number}} via
 * @param {Point} point
 * @param {number} [tolerance]
 */
export function viaHitTest(via, point, tolerance = 0) {
    return Math.hypot(via.x - point.x, via.y - point.y) <= (Number(via.diameter) || 0.6) / 2 + tolerance;
}

export class Via {
    /** @param {ViaOptions} [options] */
    constructor(options = {}) {
        this.id = viaIds.claim(options.id);
        this.type = 'via';
        this.x = Number(options.x) || 0;
        this.y = Number(options.y) || 0;
        const diameter = Number.isFinite(options.diameter) && /** @type {number} */ (options.diameter) > 0
            ? /** @type {number} */ (options.diameter) : 0.6;
        this.diameter = diameter;
        const drill = Number.isFinite(options.drill) && /** @type {number} */ (options.drill) > 0
            ? /** @type {number} */ (options.drill) : 0.3;
        this.drill = Math.min(drill, this.diameter);
        this.net = typeof options.net === 'string' ? options.net : '';
        this.locked = !!options.locked;
        this.visible = options.visible !== undefined ? options.visible : true;
    }

    getBounds() {
        return viaBounds(this);
    }

    /**
     * @param {Point} point
     * @param {number} [tolerance]
     */
    hitTest(point, tolerance = 0) {
        return viaHitTest(this, point, tolerance);
    }

    /** Move the via by (dx, dy) in world units. */
    /**
     * @param {number} dx
     * @param {number} dy
     */
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    clone() {
        return new Via({
            x: this.x,
            y: this.y,
            diameter: this.diameter,
            drill: this.drill,
            net: this.net,
            locked: this.locked,
            visible: this.visible,
        });
    }

    /** Capture state for undo/redo. */
    /** @returns {ViaState} */
    captureState() {
        return {
            id: this.id,
            x: this.x,
            y: this.y,
            diameter: this.diameter,
            drill: this.drill,
            net: this.net,
            locked: this.locked,
            visible: this.visible,
        };
    }

    /** Restore state from captureState() output. */
    /** @param {Partial<ViaState>} state */
    applyState(state) {
        if (Number.isFinite(state.x)) this.x = /** @type {number} */ (state.x);
        if (Number.isFinite(state.y)) this.y = /** @type {number} */ (state.y);
        const diameter = Number.isFinite(state.diameter) && /** @type {number} */ (state.diameter) > 0
            ? /** @type {number} */ (state.diameter) : this.diameter;
        const drill = Number.isFinite(state.drill) && /** @type {number} */ (state.drill) > 0
            ? /** @type {number} */ (state.drill) : this.drill;
        this.diameter = diameter;
        this.drill = Math.min(drill, diameter);
        if (typeof state.net === 'string') this.net = state.net;
        if (typeof state.locked === 'boolean') this.locked = state.locked;
        if (typeof state.visible === 'boolean') this.visible = state.visible;
    }

    /** Serialise to compact JSON. */
    /** @returns {ViaJSON} */
    toJSON() {
        /** @type {ViaJSON} */
        const out = {
            type: 'via',
            id: this.id,
            x: round4(this.x),
            y: round4(this.y),
            d: round4(this.diameter),
            dr: round4(this.drill),
        };
        if (this.net) out.n = this.net;
        if (this.locked) out.lk = true;
        if (!this.visible) out.v = false;
        return out;
    }

    /** Deserialise from compact JSON produced by toJSON(). */
    /** @param {ViaJSON} data */
    static fromJSON(data) {
        return new Via({
            id: data.id,
            x: data.x,
            y: data.y,
            diameter: data.d,
            drill: data.dr,
            net: data.n,
            locked: data.lk,
            visible: data.v,
        });
    }
}
