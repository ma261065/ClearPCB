import { generateFootprint } from '../pcb/modules/footprint.js';

/**
 * Resolve footprint artwork data and physical pad descriptors without rendering.
 * @param {{footprint:string, pins:Array<{number:string, name:string}>, footprintShapes?:string[]|null, footprintBBox?:object|null, source?:string}} component
 */
export function createPcbFootprint(component) {
    const geometry = generateFootprint(component.footprint, component.pins,
        component.footprintShapes, component.footprintBBox, component.source);
    /** @type {Map<string, number>} */
    const counts = new Map();
    const padOffsets = geometry.pads.map(pad => {
        const number = String(pad.number);
        const seen = counts.get(number) || 0;
        counts.set(number, seen + 1);
        // Keep logical numbers for nets, but distinguish every physical pad.
        const padId = seen === 0 ? number : `${number}#${seen + 1}`;
        return {
            number, padId, dx: pad.x, dy: pad.y, width: pad.width, height: pad.height,
            drill: pad.drill || 0, slotLength: pad.slotLength || 0, slotAngle: pad.slotAngle || 0,
            layer: pad.layer, shape: pad.shape || 'rect',
            mask: pad.mask !== false, paste: pad.paste !== false,
        };
    });
    const pasteOffsets = (geometry.pasteApertures || []).map(aperture => ({
        dx: aperture.x, dy: aperture.y, width: aperture.width, height: aperture.height,
        shape: aperture.shape || 'rect', side: aperture.side || 'top',
    }));
    return { geometry, padOffsets, pasteOffsets };
}
