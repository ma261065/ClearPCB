/** Shared H/V/45 axis-alignment halo and patterned centerline renderer. */

const NS = 'http://www.w3.org/2000/svg';
const COLLINEAR_GLOW_COLOR = '#0072B2';

export function axisAlignment(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const tolerance = 1e-4;
    if (ady / len < tolerance) return 'h';
    if (adx / len < tolerance) return 'v';
    if (Math.abs(adx - ady) / len < tolerance) return 'd';
    return null;
}

export function renderAxisGlow(app, segments) {
    clearAxisGlow(app);
    const resolved = [];
    const halos = [];
    for (const segment of segments || []) {
        let color;
        if (segment.collinear) color = COLLINEAR_GLOW_COLOR;
        else if (segment.frozen) continue;
        else {
            const axis = segment.axisKind ?? axisAlignment(segment.a, segment.b);
            if (!axis) continue;
            color = axis === 'd' ? '#CC79A7' : '#E69F00';
        }
        const parent = app._getLayerGroup?.(segment.layerId);
        if (!parent) continue;
        const dashKind = segment.collinear ? 'dotted'
            : (segment.axisKind ?? axisAlignment(segment.a, segment.b)) === 'd' ? 'dashed' : 'solid';
        const halo = makeAxisGlowHalo(app, segment, color);
        // A zoom refresh runs after copper is already present. Insert the
        // halo at the layer bottom so it remains under copper in both paths.
        parent.insertBefore(halo, parent.firstChild);
        halos.push(halo);
        resolved.push({ segment, dashKind });
    }
    app._axisGlowHalos = halos;
    app._axisGlowResolved = resolved;
    renderAxisGlowTop(app);
}

export function renderAxisGlowTop(app) {
    for (const element of app._axisGlowTop || []) element.remove();
    const centerlines = [];
    for (const { segment, dashKind } of app._axisGlowResolved || []) {
        const parent = app._getLayerGroup?.(segment.layerId);
        if (!parent) continue;
        const centerline = makeAxisGlowCenterline(app, segment, dashKind);
        parent.appendChild(centerline);
        centerlines.push(centerline);
    }
    app._axisGlowTop = centerlines;
}

/** Rebuild an active glow after viewport scaling changes its floor width. */
export function refreshAxisGlow(app) {
    const segments = app._axisGlowResolved?.map(({ segment }) => segment);
    if (segments) renderAxisGlow(app, segments);
}

export function clearAxisGlow(app) {
    for (const key of ['_axisGlowHalos', '_axisGlowTop']) {
        for (const element of app[key] || []) element.remove();
        app[key] = null;
    }
    app._axisGlowResolved = null;
}

export function makeAxisGlowHalo(app, segment, color) {
    const scale = Math.max(0.01, app.viewport?.scale || 1);
    const width = segment.width || 0.2;
    // The ring grows with copper width, with a 4px-per-side floor so fine
    // tracks retain a visible cue when zoomed out.
    const ring = Math.max(4 / scale, width * 0.25);
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('class', 'pcb-track-preview');
    line.setAttribute('x1', String(segment.a.x));
    line.setAttribute('y1', String(segment.a.y));
    line.setAttribute('x2', String(segment.b.x));
    line.setAttribute('y2', String(segment.b.y));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(width + ring * 2));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-opacity', '0.7');
    line.setAttribute('pointer-events', 'none');
    return line;
}

export function makeAxisGlowCenterline(app, segment, dashKind) {
    const scale = app.viewport?.scale || 1;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('class', 'pcb-track-preview');
    line.setAttribute('x1', String(segment.a.x));
    line.setAttribute('y1', String(segment.a.y));
    line.setAttribute('x2', String(segment.b.x));
    line.setAttribute('y2', String(segment.b.y));
    line.setAttribute('stroke', '#ffffff');
    line.setAttribute('stroke-width', String(1.5 / scale));
    line.setAttribute('stroke-linecap', dashKind === 'dotted' ? 'round' : 'butt');
    if (dashKind === 'dotted') line.setAttribute('stroke-dasharray', `${0.01 / scale} ${6 / scale}`);
    else if (dashKind === 'dashed') line.setAttribute('stroke-dasharray', `${8 / scale} ${6 / scale}`);
    line.setAttribute('stroke-opacity', '0.95');
    line.setAttribute('pointer-events', 'none');
    return line;
}