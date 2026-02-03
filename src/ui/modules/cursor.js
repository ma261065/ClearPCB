export function updateCrosshair(app, snapped, screenPosOverride = null) {
    const screenPos = app.viewport.worldToScreen(snapped);
    const w = app.container.clientWidth;
    const h = app.container.clientHeight;

    app.lastCrosshairWorld = { x: snapped.x, y: snapped.y };

    app.crosshair.lineX.setAttribute('x1', 0);
    app.crosshair.lineX.setAttribute('y1', screenPos.y);
    app.crosshair.lineX.setAttribute('x2', w);
    app.crosshair.lineX.setAttribute('y2', screenPos.y);

    app.crosshair.lineY.setAttribute('x1', screenPos.x);
    app.crosshair.lineY.setAttribute('y1', 0);
    app.crosshair.lineY.setAttribute('x2', screenPos.x);
    app.crosshair.lineY.setAttribute('y2', h);
}

export function getToolIconPath(tool) {
    switch (tool) {
        case 'line':
            return 'M 0 8 L 8 0';
        case 'wire':
            return 'M 0 4 L 8 4';
        case 'rect':
            return 'M 1 1 H 7 V 7 H 1 Z';
        case 'circle':
            return 'M 4 1 A 3 3 0 1 1 3.999 1';
        case 'arc':
            return 'M 1 7 A 6 6 0 0 1 7 1';
        case 'polygon':
            return 'M 4 0 L 8 3 L 6 8 L 2 8 L 0 3 Z';
        case 'text':
            return 'M 1 1 H 7 M 4 1 V 7';
        case 'component':
            return 'M 1 1 H 7 V 7 H 1 Z M 4 2 V 6 M 2 4 H 6';
        default:
            return '';
    }
}

export function setToolCursor(app, tool, svg) {
    if (!svg) return;
    if (tool === 'select') {
        svg.style.cursor = 'default';
        return;
    }

    const path = getToolIconPath(tool);
    if (!path) {
        svg.style.cursor = 'crosshair';
        return;
    }

    const stroke = '#ffffff';
    const svgMarkup = `<?xml version="1.0" encoding="UTF-8"?>
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="-4 -6 26 26">
            <path d="M 0 8 H 16 M 8 0 V 16" fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round" />
            <g transform="translate(10 -2)">
                <path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </g>
        </svg>`;
    const encoded = encodeURIComponent(svgMarkup)
        .replace(/'/g, '%27')
        .replace(/"/g, '%22');
    svg.style.cursor = `url("data:image/svg+xml,${encoded}") 16 18, crosshair`;
}

export function showCrosshair(app) {
    app.crosshair.container.classList.add('active');
}

export function hideCrosshair(app) {
    app.crosshair.container.classList.remove('active');
}
