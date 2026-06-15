/**
 * Hole – Non-plated through-hole (NPTH)
 *
 * A standalone drilled hole with no copper, no annular ring and no net.
 * Used for mounting holes, tooling holes and other mechanical cut-outs.
 * Decoupled from any Track or Via — moving one does not affect the other.
 *
 * Holes are positioned in world coordinates (mm). The drill is drawn as a
 * single circle of radius (diameter / 2) on the 'hole' layer.
 *
 * Note: Hole is a lightweight data class — it does not extend Shape. The
 * PCB editor renders Holes via src/pcb/modules/track-render.js, not via the
 * schematic Shape pipeline.
 */

let holeIdCounter = 0;

/** Reset the hole ID counter (for testing / new-document). */
export function resetHoleIdCounter() {
    holeIdCounter = 0;
}

/** Update the hole ID counter so newly-issued IDs don't collide on load. */
export function updateHoleIdCounter(id) {
    if (typeof id !== 'string') return;
    const m = id.match(/^hole_(\d+)$/);
    if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n >= holeIdCounter) holeIdCounter = n + 1;
    }
}

export class Hole {
    /**
     * @param {object} options
     * @param {string} [options.id]
     * @param {number} options.x - World x in mm
     * @param {number} options.y - World y in mm
     * @param {number} options.diameter - Drill hole diameter (mm)
     * @param {boolean} [options.plated] - Through-plated (copper barrel)
     */
    constructor(options = {}) {
        this.id = options.id || `hole_${++holeIdCounter}`;
        this.type = 'hole';
        this.x = Number(options.x) || 0;
        this.y = Number(options.y) || 0;
        this.diameter = Number.isFinite(options.diameter) && options.diameter > 0
            ? options.diameter : 0.8;
        this.plated = !!options.plated;
        this.selected = false;
        this.locked = !!options.locked;
        this.visible = options.visible !== undefined ? options.visible : true;
    }

    /** Move the hole by (dx, dy) in world units. */
    move(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    clone() {
        return new Hole({
            x: this.x,
            y: this.y,
            diameter: this.diameter,
            plated: this.plated,
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
            plated: this.plated,
            locked: this.locked,
            visible: this.visible,
        };
    }

    /** Restore state from captureState() output. */
    applyState(state) {
        if (Number.isFinite(state.x)) this.x = state.x;
        if (Number.isFinite(state.y)) this.y = state.y;
        if (Number.isFinite(state.diameter) && state.diameter > 0) this.diameter = state.diameter;
        if (typeof state.plated === 'boolean') this.plated = state.plated;
        if (typeof state.locked === 'boolean') this.locked = state.locked;
        if (typeof state.visible === 'boolean') this.visible = state.visible;
    }

    /** Serialise to compact JSON. */
    toJSON() {
        const out = {
            type: 'hole',
            id: this.id,
            x: this.x,
            y: this.y,
            d: this.diameter,
        };
        if (this.plated) out.pl = true;
        if (this.locked) out.lk = true;
        if (!this.visible) out.v = false;
        return out;
    }

    /** Deserialise from compact JSON produced by toJSON(). */
    static fromJSON(data) {
        return new Hole({
            id: data.id,
            x: data.x,
            y: data.y,
            diameter: data.d !== undefined ? data.d : data.diameter,
            plated: data.pl !== undefined ? data.pl : data.plated,
            locked: data.lk !== undefined ? data.lk : data.locked,
            visible: data.v !== undefined ? data.v : data.visible,
        });
    }
}
