import { REF_DEFAULT_SIZE, REF_DEFAULT_STROKE } from '../shared/pcb/reference-text.js';
import { createPcbFootprint } from './pcb-footprint.js';
import { applyPlacementSide, updatePlacementPadPositions } from './pcb-placement-geometry.js';

/**
 * @typedef {{x:number, y:number, rotation:number, locked:boolean, mirror:boolean,
 * side:string, refVisible:boolean, refDx:number, refDy:number, refRot:number,
 * refSize:number, refStrokeWidth:number}} PlacementOverride
 */

/**
 * @typedef {{id:string, reference?:string, value?:string, footprint?:string, source?:string, model3dObj?:unknown, model3dUrl?:string|null}} PlacementComponent
 */

/** @param {number} value */
const round4 = value => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : value;

/** @param {Partial<PlacementOverride> & {x:number, y:number}} placement */
export function capturePlacementOverride(placement) {
    return {
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
    };
}

/** Saved footprint poses and reference settings, independent of generated artwork. */
export class PcbPlacementState {
    constructor() {
        /** @type {Map<string, PlacementOverride>} */
        this.overrides = new Map();
        /** @type {Map<string, {x:number, y:number}>} Stable automatic positions, saved alongside overrides. */
        this.autoSlots = new Map();
    }

    /**
     * Remember committed placement data without retaining SVG, pads or caches.
     * @param {string} id
     * @param {Partial<PlacementOverride> & {x:number, y:number}} placement
     */
    record(id, placement) {
        const snapshot = capturePlacementOverride(placement);
        this.overrides.set(id, snapshot);
        return snapshot;
    }

    /**
     * Resolve physical placements without rendering or changing authored overrides.
     * @param {PlacementComponent[]} components
     */
    resolve(components) {
        const columns = Math.max(1, Math.ceil(Math.sqrt(components.length)));
        /** @param {number} index */
        const slotPosition = index => ({ x: 10 + (index % columns) * 20,
            y: -10 - Math.floor(index / columns) * 20 });
        /**
         * @param {number} x
         * @param {number} y
         */
        const positionKey = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
        const occupied = new Set();
        const newSlots = new Map();
        for (const component of components) {
            const position = this.overrides.get(component.id) || this.autoSlots.get(component.id);
            if (position) occupied.add(positionKey(position.x, position.y));
        }
        // Retain existing slots across deletion/reordering; only new components scan for a free cell.
        for (const component of components) {
            if (this.overrides.has(component.id) || this.autoSlots.has(component.id) || newSlots.has(component.id)) continue;
            let index = 0, position = slotPosition(0);
            while (occupied.has(positionKey(position.x, position.y))) position = slotPosition(++index);
            occupied.add(positionKey(position.x, position.y));
            newSlots.set(component.id, position);
        }
        const placements = new Map();
        for (const component of components) {
            const pose = this.overrides.get(component.id) || this.autoSlots.get(component.id) || newSlots.get(component.id);
            const { geometry, padOffsets, pasteOffsets } = createPcbFootprint(/** @type {Parameters<typeof createPcbFootprint>[0]} */ (/** @type {unknown} */ (component)));
            const placement = {
                ...capturePlacementOverride(pose),
                geometry, padOffsets, pasteOffsets, pads: new Map(),
                outline: geometry.outline || null, silks: geometry.silks || [],
                reference: component.reference, value: component.value || '',
                footprint: component.footprint || '', source: component.source || '',
                model3dObj: component.model3dObj || null, model3dUrl: component.model3dUrl || null,
            };
            if (placement.side === 'bottom') applyPlacementSide(placement, 'bottom');
            updatePlacementPadPositions(placement);
            placements.set(component.id, placement);
        }
        for (const [id, position] of newSlots) this.autoSlots.set(id, position);
        return placements;
    }

    /**
     * Restore saved values in place so editor aliases remain valid.
     * @param {Record<string, Partial<PlacementOverride>>|null|undefined} placements
     */
    load(placements) {
        this.overrides.clear();
        this.autoSlots.clear();
        if (!placements || typeof placements !== 'object') return;
        for (const [id, placement] of Object.entries(placements)) {
            if (!placement) continue;
            const loaded = /** @type {Partial<PlacementOverride> & {x:number,y:number}} */ ({ ...placement, x: 0, y: 0 });
            loaded.x = Number(placement.x) || 0;
            loaded.y = Number(placement.y) || 0;
            loaded.rotation = Number(placement.rotation) || 0;
            loaded.refDx = Number(placement.refDx) || 0;
            loaded.refDy = Number(placement.refDy) || 0;
            loaded.refRot = Number(placement.refRot) || 0;
            loaded.refSize = Number(placement.refSize) || 0;
            loaded.refStrokeWidth = Number(placement.refStrokeWidth) || 0;
            this.record(id, loaded);
        }
    }

    /** @returns {Record<string, Partial<PlacementOverride>>} */
    serialize() {
        /** @type {Record<string, Partial<PlacementOverride>>} */
        const placements = {};
        for (const [id, p] of this.autoSlots) {
            placements[id] = { x: round4(p.x), y: round4(p.y), rotation: 0 };
        }
        for (const [id, p] of this.overrides) {
            /** @type {Partial<PlacementOverride>} */
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
