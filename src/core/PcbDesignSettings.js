/** @typedef {'trackWidth'|'clearance'|'viaDiameter'|'viaDrill'} PcbRoutingField */
/** @typedef {{trackWidth: number, clearance: number, viaDiameter: number, viaDrill: number, units: string, router: string, excludeSameFootprintPadClearance: boolean}} PcbDesignValues */

/** @type {PcbRoutingField[]} */
export const PCB_ROUTING_FIELDS = ['trackWidth', 'clearance', 'viaDiameter', 'viaDrill'];
/**
 * Upper bounds for routing dimensions. Larger values are input slips: clearance halo
 * rendering grows with the clearance, and a 5 m clearance took minutes to open.
 */
/** @type {Readonly<Record<PcbRoutingField, number>>} */
export const PCB_DESIGN_MAX_MM = Object.freeze({ trackWidth: 25, clearance: 10, viaDiameter: 25, viaDrill: 25 });

export const PCB_MIN_VIA_ANNULAR_RING = 0.05;

/** @param {number} diameter @param {number} drill */
export function viaDimensionError(diameter, drill) {
    if (!Number.isFinite(diameter) || diameter <= 0 || !Number.isFinite(drill) || drill <= 0) {
        return 'Via Diameter and Via Drill must be positive finite values in millimetres.';
    }
    const minimum = drill + 2 * PCB_MIN_VIA_ANNULAR_RING;
    return diameter + 1e-9 >= minimum ? ''
        : `Via Diameter must be at least ${minimum.toFixed(3)} mm for a ${drill.toFixed(3)} mm Via Drill (${PCB_MIN_VIA_ANNULAR_RING.toFixed(3)} mm minimum annular ring).`;
}

/** Clamp oversized routing dimensions from saved data so slipped values still open, at a renderable size.
 * @param {Record<string, unknown>} design
 * @returns {Record<string, unknown> & Partial<Record<PcbRoutingField, number>>}
 */
export function clampDesignDimensions(design) {
    /** @type {Record<string, unknown> & Partial<Record<PcbRoutingField, number>>} */
    const clamped = { ...design };
    for (const key of PCB_ROUTING_FIELDS) {
        const value = clamped[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > PCB_DESIGN_MAX_MM[key]) clamped[key] = PCB_DESIGN_MAX_MM[key];
    }
    return clamped;
}

/** Canonical project design settings; numeric dimensions are always millimetres. */
export class PcbDesignSettings {
    constructor() {
        this.hasAppliedSettings = false;
        /** @type {PcbDesignValues} */
        this._values = { trackWidth: 0.2, clearance: 0.1, viaDiameter: 0.3, viaDrill: 0.15,
            units: 'mm', router: 'maze', excludeSameFootprintPadClearance: false };
    }

    get values() { return { ...this._values }; }

    /** Validate before changing any field. Returns whether anything changed.
     * @param {Partial<PcbDesignValues>} changes
     * @returns {boolean}
     */
    update(changes) {
        const next = { ...this._values, ...changes };
        for (const key of PCB_ROUTING_FIELDS) {
            if (!Number.isFinite(next[key]) || next[key] <= 0) {
                throw new Error(`PCB ${key} must be a positive finite value in millimetres.`);
            }
            if (next[key] > PCB_DESIGN_MAX_MM[key]) {
                throw new Error(`PCB ${key} must be no larger than ${PCB_DESIGN_MAX_MM[key]} mm.`);
            }
        }
        const viaError = viaDimensionError(next.viaDiameter, next.viaDrill);
        if (viaError) throw new Error(viaError);
        if (!['mm', 'inch'].includes(next.units)) throw new Error('Invalid PCB design units.');
        if (!['maze', 'pathfinder'].includes(next.router)) throw new Error('Invalid PCB router mode.');
        if (typeof next.excludeSameFootprintPadClearance !== 'boolean') {
            throw new Error('PCB same-footprint pad clearance exclusion must be a boolean.');
        }
        const keys = /** @type {(keyof PcbDesignValues)[]} */ (Object.keys(this._values));
        const changed = keys.some(key => this._values[key] !== next[key]);
        this._values = next;
        this.hasAppliedSettings = true;
        return changed;
    }

    getRoutingParams() {
        const { trackWidth, clearance, viaDiameter, viaDrill } = this._values;
        return { trackWidth, clearance, viaDiameter, viaDrill };
    }

    serialize() {
        const saved = this.values;
        for (const key of PCB_ROUTING_FIELDS) saved[key] = Math.round(saved[key] * 10000) / 10000;
        return saved;
    }
}
