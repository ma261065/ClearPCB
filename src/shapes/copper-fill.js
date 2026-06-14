/**
 * CopperFill – a flood-filled copper pour region on a single copper layer.
 *
 * The user draws a closed outline polygon; the PCB editor floods that
 * region with copper, clearing the configured clearance around any
 * *other-net* copper (tracks / vias / pads) and merging solidly into
 * *same-net* copper. The actual poured geometry is computed on the fly
 * (see src/pcb/modules/copper-fill-geom.js) and is NOT stored here — this
 * class only holds the user-authored region (outline + layer + net).
 *
 * Positioned in world coordinates (mm). Like Via, CopperFill is a
 * lightweight data class: it does not extend Shape and is rendered by
 * src/pcb/modules/copper-fill-render.js rather than the schematic Shape
 * pipeline.
 */

let fillIdCounter = 0;

/** Reset the fill ID counter (for testing / new-document). */
export function resetFillIdCounter() {
    fillIdCounter = 0;
}

/** Update the fill ID counter so newly-issued IDs don't collide on load. */
export function updateFillIdCounter(id) {
    if (typeof id !== 'string') return;
    const m = id.match(/^fill_(\d+)$/);
    if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n >= fillIdCounter) fillIdCounter = n + 1;
    }
}

export class CopperFill {
    /**
     * @param {object} options
     * @param {string} [options.id]
     * @param {string} [options.layer] - 'top-copper' | 'bottom-copper'
     * @param {string} [options.net] - Net to pour (empty = isolated pour)
     * @param {Array<{x:number,y:number}>} [options.outline] - Closed region
     *   outline in world mm (no implicit closing point needed).
     */
    constructor(options = {}) {
        this.id = options.id || `fill_${++fillIdCounter}`;
        this.type = 'fill';
        this.layer = options.layer === 'bottom-copper' ? 'bottom-copper' : 'top-copper';
        this.net = typeof options.net === 'string' ? options.net : '';
        this.outline = Array.isArray(options.outline)
            ? options.outline.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }))
            : [];
        this.selected = false;
        this.locked = !!options.locked;
        this.visible = options.visible !== undefined ? options.visible : true;
        /** Last-computed poured geometry: [{outer:[{x,y}], holes:[[{x,y}]]}] */
        this._computed = null;
    }

    /** Move the whole region by (dx, dy) in world units. */
    move(dx, dy) {
        for (const p of this.outline) {
            p.x += dx;
            p.y += dy;
        }
    }

    /** Axis-aligned bounds of the outline, or null when empty. */
    getBounds() {
        if (this.outline.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of this.outline) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return { minX, minY, maxX, maxY };
    }

    /** Point-in-polygon test against the outline (world coords). */
    containsPoint(x, y) {
        const pts = this.outline;
        const n = pts.length;
        if (n < 3) return false;
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = pts[i].x, yi = pts[i].y;
            const xj = pts[j].x, yj = pts[j].y;
            const intersect = ((yi > y) !== (yj > y))
                && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    /** Distance from a point to the nearest outline edge (world coords). */
    distanceToEdge(x, y) {
        const pts = this.outline;
        const n = pts.length;
        if (n < 2) return Infinity;
        let best = Infinity;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const d = distPointSeg(x, y, pts[j].x, pts[j].y, pts[i].x, pts[i].y);
            if (d < best) best = d;
        }
        return best;
    }

    clone() {
        return new CopperFill({
            layer: this.layer,
            net: this.net,
            outline: this.outline,
            locked: this.locked,
            visible: this.visible,
        });
    }

    /** Capture state for undo/redo. */
    captureState() {
        return {
            id: this.id,
            layer: this.layer,
            net: this.net,
            outline: this.outline.map((p) => ({ x: p.x, y: p.y })),
            locked: this.locked,
            visible: this.visible,
        };
    }

    /** Restore state from captureState() output. */
    applyState(state) {
        if (state.layer === 'top-copper' || state.layer === 'bottom-copper') this.layer = state.layer;
        if (typeof state.net === 'string') this.net = state.net;
        if (Array.isArray(state.outline)) {
            this.outline = state.outline.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
        }
        if (typeof state.locked === 'boolean') this.locked = state.locked;
        if (typeof state.visible === 'boolean') this.visible = state.visible;
    }

    /** Serialise to compact JSON. */
    toJSON() {
        const out = {
            type: 'fill',
            id: this.id,
            l: this.layer,
            pts: this.outline.map((p) => [p.x, p.y]),
        };
        if (this.net) out.n = this.net;
        if (this.locked) out.lk = true;
        if (!this.visible) out.v = false;
        return out;
    }

    /** Deserialise from compact JSON produced by toJSON(). */
    static fromJSON(data) {
        const outline = Array.isArray(data.pts)
            ? data.pts.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y }))
            : (Array.isArray(data.outline) ? data.outline : []);
        return new CopperFill({
            id: data.id,
            layer: data.l !== undefined ? data.l : data.layer,
            net: data.n !== undefined ? data.n : data.net,
            outline,
            locked: data.lk !== undefined ? data.lk : data.locked,
            visible: data.v !== undefined ? data.v : data.visible,
        });
    }
}

/** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
function distPointSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
