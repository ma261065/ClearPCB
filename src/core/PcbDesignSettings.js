export const PCB_ROUTING_FIELDS = ['trackWidth', 'clearance', 'viaDiameter', 'viaDrill'];

/** Canonical project design settings; numeric dimensions are always millimetres. */
export class PcbDesignSettings {
    constructor() {
        this._values = { trackWidth: 0.2, clearance: 0.1, viaDiameter: 0.3, viaDrill: 0.15,
            units: 'mm', router: 'maze' };
    }

    get values() { return { ...this._values }; }

    /** Validate before changing any field. Returns whether anything changed. */
    update(changes) {
        const next = { ...this._values, ...changes };
        for (const key of PCB_ROUTING_FIELDS) {
            if (!Number.isFinite(next[key]) || next[key] <= 0) {
                throw new Error(`PCB ${key} must be a positive finite value in millimetres.`);
            }
        }
        if (!['mm', 'inch'].includes(next.units)) throw new Error('Invalid PCB design units.');
        if (!['maze', 'pathfinder'].includes(next.router)) throw new Error('Invalid PCB router mode.');
        const changed = Object.keys(this._values).some(key => this._values[key] !== next[key]);
        this._values = next;
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
