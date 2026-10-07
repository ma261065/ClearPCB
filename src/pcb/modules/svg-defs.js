const svgDefs = new WeakMap();

/** Get (or lazily create) the shared <defs> in the editor SVG. */
/**
 * The editor's own top-level <defs> (copper-cut clip paths, removal hatches). Not the
 * grid's: the viewport rebuilds the grid layer, <defs> included, on zoom.
 */
export function ensureSvgDefs(app) {
    const svg = app.viewport?.svg;
    if (!svg) return null;
    const cached = svgDefs.get(app);
    if (cached && cached.isConnected) return cached;
    let defs = [...svg.children].find(child => child.localName === 'defs' && child.hasAttribute('data-pcb-defs'));
    if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.setAttribute('data-pcb-defs', '');
        svg.insertBefore(defs, svg.firstChild);
    }
    svgDefs.set(app, defs);
    return defs;
}

