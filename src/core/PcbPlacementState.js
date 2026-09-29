import { REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../pcb/modules/reference-text.js';

/**
 * @typedef {{x:number, y:number, rotation:number, locked:boolean, mirror:boolean,
 * side:string, refVisible:boolean, refDx:number, refDy:number, refRot:number,
 * refSize:number, refStrokeWidth:number}} PlacementOverride
 */

const round4 = value => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : value;

/** Saved footprint poses and reference settings, independent of generated artwork. */
export class PcbPlacementState {
    constructor() {
        /** @type {Map<string, PlacementOverride>} */
        this.overrides = new Map();
    }

    /**
     * Remember committed placement data without retaining SVG, pads or caches.
     * @param {string} id
     * @param {Partial<PlacementOverride> & {x:number, y:number}} placement
     */
    record(id, placement) {
        this.overrides.set(id, {
            x: placement.x,
            y: placement.y,
            rotation: placement.rotation || 0,
            locked: !!placement.locked,
            mirror: !!placement.mirror,
            side: placement.side === 'bottom' ? 'bottom' : 'top',
            refVisible: placement.refVisible !== false,
            refDx: placement.refDx || 0,
            refDy: placement.refDy || 0,
            refRot: ((placement.refRot || 0) % 360 + 360) % 360,
            refSize: placement.refSize || REF_DEFAULT_SIZE,
            refStrokeWidth: placement.refStrokeWidth || REF_DEFAULT_STROKE,
        });
    }

    /** Restore saved values in place so editor aliases remain valid. */
    load(placements) {
        this.overrides.clear();
        if (!placements || typeof placements !== 'object') return;
        for (const [id, placement] of Object.entries(placements)) {
            if (!placement) continue;
            const loaded = { ...placement };
            for (const key of ['x', 'y', 'rotation', 'refDx', 'refDy', 'refRot', 'refSize', 'refStrokeWidth']) {
                loaded[key] = Number(placement[key]) || 0;
            }
            this.record(id, loaded);
        }
    }

    serialize() {
        /** @type {Record<string, Partial<PlacementOverride>>} */
        const placements = {};
        for (const [id, p] of this.overrides) {
            const saved = { x: round4(p.x), y: round4(p.y), rotation: round4(p.rotation || 0) };
            if (p.locked) saved.locked = true;
            if (p.mirror) saved.mirror = true;
            if (p.side === 'bottom') saved.side = 'bottom';
            if (p.refVisible === false) saved.refVisible = false;
            if (p.refDx) saved.refDx = round4(p.refDx);
            if (p.refDy) saved.refDy = round4(p.refDy);
            if (p.refRot) saved.refRot = round4(p.refRot);
            if (p.refSize && p.refSize !== REF_DEFAULT_SIZE) saved.refSize = round4(p.refSize);
            if (p.refStrokeWidth && p.refStrokeWidth !== REF_DEFAULT_STROKE) saved.refStrokeWidth = round4(p.refStrokeWidth);
            placements[id] = saved;
        }
        return placements;
    }
}
