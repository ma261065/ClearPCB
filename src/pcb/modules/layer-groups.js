/**
 * Owns construction of PCB SVG layer groups and their canvas z-order.
 */
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/Viewport.js').Viewport} Viewport */

const PCB_LAYER_GROUP_ORDER = Object.freeze([
    'board-outline',
    'bottom-mask', 'top-mask',
    'bottom-paste', 'top-paste',
    // Copper pours sit directly beneath their copper layer so tracks and pads
    // paint on top of the flood fill.
    'bottom-fill', 'bottom-copper',
    // Pad numbers sit just above their copper layer so a track routed to a pad
    // never hides its number (visibility follows the copper).
    'bottom-pad-numbers',
    // Copper-removal knockouts sit above all copper/pads on that side so they
    // visually cut copper, matching the 2D/3D board views.
    'bottom-copper-knockout',
    'top-fill', 'top-copper',
    'top-pad-numbers',
    'top-copper-knockout',
    'bottom-copper-pad-drills', 'top-copper-pad-drills',
    'vias',
    // Track labels remain readable where a connected track terminates beneath a
    // via, while still following copper-layer visibility.
    'bottom-copper-track-labels',
    'top-copper-track-labels',
    'bottom-silk', 'top-silk',
    // LOD placeholders cover footprints when zoomed far enough out that full
    // detail is sub-pixel.
    'fp-lod',
    'bottom-document',
    'top-document',
    'hole',
    'ratlines',
    'clearance-overlay',
    'selection-overlay',
    'drc-overlay',
]);

/**
 * Create the SVG groups for every PCB layer and overlay in z-order.
 * @param {PcbEditor} app
 */
export function createPcbLayerGroups(app) {
    if (app.existingLayerGroups().size > 0) return;
    for (const id of PCB_LAYER_GROUP_ORDER) {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', `pcb-layer-${id}`);
        group.setAttribute('data-layer', id);
        /** @type {Viewport} */ (app.viewport).addContent(group);
        app.existingLayerGroups().set(id, group);
    }
}
