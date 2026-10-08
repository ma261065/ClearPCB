import { padOutline, padBounds, padHitTest } from './pad-geometry.js';
import { IdAllocator } from '../core/id-allocator.js';

const padIds = new IdAllocator('pad');
/** @param {number} value */
const round4 = value => Math.round(value * 10000) / 10000;
// Bounds are read by every pointer query's pre-filter; pads change by field assignment.
const boundsCache = new WeakMap();

/**
 * @typedef {Object} PadOptions
 * @property {string} [id]
 * @property {number|string} [x]
 * @property {number|string} [y]
 * @property {string} [shape]
 * @property {number} [size]
 * @property {number} [drill]
 * @property {number} [ratio]
 * @property {number|string} [rotation]
 * @property {string} [layers]
 * @property {string} [net]
 * @property {boolean} [locked]
 * @property {boolean} [visible]
 */
/** @typedef {ReturnType<Pad['captureState']>} PadState */
/** @typedef {{type:string, id:string, x:number, y:number, sh:string, s:number, dr:number, ls:string, ra?:number, rot?:number, n?:string, lk?:boolean, v?:boolean}} SerializedPad */
/** @typedef {{x:number, y:number}} Point */

export const PAD_SHAPES = ['round', 'stadium', 'square', 'rectangle', 'oval'];
export const PAD_LAYERS = ['top-copper', 'bottom-copper', 'both'];

export function resetPadIdCounter() {
    padIds.reset();
}

/** @param {string} id */
export function updatePadIdCounter(id) {
    padIds.observe(id);
}

export class Pad {
    /** @param {PadOptions} [options] */
    constructor(options = {}) {
        const size = /** @type {number} */ (options.size);
        const drill = /** @type {number} */ (options.drill);
        const ratio = /** @type {number} */ (options.ratio);
        /** @type {string} */
        this.id = padIds.claim(options.id);
        this.type = 'pad';
        this.x = Number(options.x) || 0;
        this.y = Number(options.y) || 0;
        /** @type {string} */
        this.shape = typeof options.shape === 'string' && PAD_SHAPES.includes(options.shape) ? options.shape : 'round';
        /** @type {number} */
        this.size = Number.isFinite(size) && size > 0 ? size : 1.5;
        // A zero drill is a pad without a hole (e.g. a test pad).
        /** @type {number} */
        this.drill = Math.min(
            Number.isFinite(drill) && drill >= 0 ? drill : 0.8,
            this.size,
        );
        /** @type {number} */
        this.ratio = Number.isFinite(ratio) && ratio >= 1 ? ratio : 2;
        this.rotation = ((Number(options.rotation) || 0) % 360 + 360) % 360;
        /** @type {string} */
        this.layers = typeof options.layers === 'string' && PAD_LAYERS.includes(options.layers) ? options.layers : 'both';
        this.net = typeof options.net === 'string' ? options.net : '';
        this.locked = !!options.locked;
        this.visible = options.visible !== false;
    }

    get width() {
        return ['stadium', 'rectangle', 'oval'].includes(this.shape)
            ? this.size * this.ratio : this.size;
    }

    get height() {
        return this.size;
    }

    getOutline() {
        return padOutline(this);
    }

    getBounds() {
        const cached = boundsCache.get(this);
        if (cached && cached.x === this.x && cached.y === this.y && cached.shape === this.shape
            && cached.size === this.size && cached.ratio === this.ratio && cached.rotation === this.rotation
            && cached.drill === this.drill) return { ...cached.bounds };
        const bounds = padBounds(this);
        boundsCache.set(this, { x: this.x, y: this.y, shape: this.shape, size: this.size, ratio: this.ratio,
            rotation: this.rotation, drill: this.drill, bounds });
        return { ...bounds };
    }

    /** Test the outer pad area, including the drill centre for selection. */
    /** @param {Point} point */
    hitTest(point) {
        return padHitTest(this, point);
    }

    /** @param {number} dx @param {number} dy */
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    captureState() {
        return {
            id: this.id, x: this.x, y: this.y, shape: this.shape,
            size: this.size, drill: this.drill, ratio: this.ratio,
            rotation: this.rotation, layers: this.layers, net: this.net,
            locked: this.locked, visible: this.visible,
        };
    }

    /** @param {Partial<PadState>} state */
    applyState(state) {
        Object.assign(this, new Pad({ ...this.captureState(), ...state, id: this.id }));
    }

    clone() {
        return new Pad({ ...this.captureState(), id: undefined });
    }

    toJSON() {
        /** @type {SerializedPad} */
        const out = {
            type: 'pad', id: this.id, x: round4(this.x), y: round4(this.y),
            sh: this.shape, s: round4(this.size), dr: round4(this.drill),
            ls: this.layers,
        };
        if (['stadium', 'rectangle', 'oval'].includes(this.shape)) out.ra = round4(this.ratio);
        if (this.rotation) out.rot = round4(this.rotation);
        if (this.net) out.n = this.net;
        if (this.locked) out.lk = true;
        if (!this.visible) out.v = false;
        return out;
    }

    /** @param {any} data */
    static fromJSON(data) {
        return new Pad({
            id: data.id, x: data.x, y: data.y, shape: data.sh,
            size: data.s, drill: data.dr, ratio: data.ra,
            rotation: data.rot, layers: data.ls, net: data.n,
            locked: data.lk, visible: data.v,
        });
    }
}
