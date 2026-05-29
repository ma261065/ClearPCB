/**
 * Via – Plated through-hole connecting copper layers
 *
 * A standalone via that can exist independently of any Track (e.g. for
 * ground-plane stitching). Vias produced *implicitly* by Tracks that
 * change layer at a node are represented by Track.getImplicitViaNodes(),
 * not by Via instances.
 *
 * Vias are positioned in world coordinates (mm). The annular ring is
 * drawn as a filled circle of radius (diameter / 2); the drill is a
 * concentric circle of radius (drill / 2).
 *
 * Note: Via is a lightweight data class — it does not extend Shape. The
 * PCB editor renders Vias via src/pcb/modules/track-render.js, not via
 * the schematic Shape pipeline.
 */

let viaIdCounter = 0;

/** Reset the via ID counter (for testing / new-document). */
export function resetViaIdCounter() {
    viaIdCounter = 0;
}

/** Update the via ID counter so newly-issued IDs don't collide on load. */
export function updateViaIdCounter(id) {
    if (typeof id !== 'string') return;
    const m = id.match(/^via_(\d+)$/);
    if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n >= viaIdCounter) viaIdCounter = n + 1;
    }
}

export class Via {
    /**
     * @param {object} options
     * @param {string} [options.id]
     * @param {number} options.x - World x in mm
     * @param {number} options.y - World y in mm
     * @param {number} options.diameter - Annular ring outer diameter (mm)
     * @param {number} options.drill - Drill hole diameter (mm)
     * @param {string} [options.net] - Net name (optional; set explicitly
     *   for standalone vias such as ground-plane stitches)
     */
    constructor(options = {}) {
        this.id = options.id || `via_${++viaIdCounter}`;
        this.type = 'via';
        this.x = Number(options.x) || 0;
        this.y = Number(options.y) || 0;
        this.diameter = Number.isFinite(options.diameter) && options.diameter > 0
            ? options.diameter : 0.6;
        this.drill = Number.isFinite(options.drill) && options.drill > 0
            ? options.drill : 0.3;
        this.net = typeof options.net === 'string' ? options.net : '';
        this.selected = false;
        this.locked = !!options.locked;
        this.visible = options.visible !== undefined ? options.visible : true;
    }

    /** Move the via by (dx, dy) in world units. */
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
    applyState(state) {
        if (Number.isFinite(state.x)) this.x = state.x;
        if (Number.isFinite(state.y)) this.y = state.y;
        if (Number.isFinite(state.diameter) && state.diameter > 0) this.diameter = state.diameter;
        if (Number.isFinite(state.drill) && state.drill > 0) this.drill = state.drill;
        if (typeof state.net === 'string') this.net = state.net;
        if (typeof state.locked === 'boolean') this.locked = state.locked;
        if (typeof state.visible === 'boolean') this.visible = state.visible;
    }

    /** Serialise to compact JSON. */
    toJSON() {
        const out = {
            type: 'via',
            id: this.id,
            x: this.x,
            y: this.y,
            d: this.diameter,
            dr: this.drill,
        };
        if (this.net) out.n = this.net;
        if (this.locked) out.lk = true;
        if (!this.visible) out.v = false;
        return out;
    }

    /** Deserialise from compact JSON produced by toJSON(). */
    static fromJSON(data) {
        return new Via({
            id: data.id,
            x: data.x,
            y: data.y,
            diameter: data.d !== undefined ? data.d : data.diameter,
            drill: data.dr !== undefined ? data.dr : data.drill,
            net: data.n !== undefined ? data.n : data.net,
            locked: data.lk !== undefined ? data.lk : data.locked,
            visible: data.v !== undefined ? data.v : data.visible,
        });
    }
}
