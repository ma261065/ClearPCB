import { Line, Circle, Rect, Arc, Polygon, Text } from '../../shapes/index.js';

export function startDrawing(app, worldPos) {
    if (app.currentTool === 'select') return;

    app.isDrawing = true;
    app.drawStart = { ...worldPos };
    app.drawCurrent = { ...worldPos };

    if (app.currentTool === 'polygon') {
        app.polygonPoints = [{ ...worldPos }];
    }

    createPreview(app);
    app._showCrosshair();
    app._updateCrosshair(worldPos);
    app._setToolCursor(app.currentTool, app.viewport.svg);
}

export function updateDrawing(app, worldPos) {
    if (!app.isDrawing) return;

    app.drawCurrent = { ...worldPos };
    updatePreview(app);
}

export function finishDrawing(app, worldPos) {
    if (!app.isDrawing) return;

    app.drawCurrent = { ...worldPos };

    const shape = createShapeFromDrawing(app);
    if (shape) {
        app.addShape(shape);
        if (shape.type === 'text') {
            app._startTextEdit?.(shape);
        }
    }

    cancelDrawing(app);
}

export function addPolygonPoint(app, worldPos) {
    if (app.currentTool === 'polygon' && app.isDrawing) {
        app.polygonPoints.push({ ...worldPos });
        updatePreview(app);
    }
}

export function finishPolygon(app) {
    if (app.currentTool === 'polygon' && app.isDrawing && app.polygonPoints.length >= 3) {
        const shape = new Polygon({
            points: app.polygonPoints.map(p => ({ ...p })),
            color: app.toolOptions.color,
            lineWidth: app.toolOptions.lineWidth,
            fill: app.toolOptions.fill,
            fillColor: app.toolOptions.color,
            fillAlpha: 0.3,
            closed: true
        });
        app.addShape(shape);
    }
    cancelDrawing(app);
}

export function cancelDrawing(app) {
    app.isDrawing = false;
    app.drawStart = null;
    app.drawCurrent = null;
    app.polygonPoints = [];

    if (app.previewElement) {
        app.previewElement.remove();
        app.previewElement = null;
    }

    app._hideCrosshair();
    app._setToolCursor(app.currentTool, app.viewport.svg);
}

export function createPreview(app) {
    app.previewElement = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    app.previewElement.setAttribute('class', 'preview');
    app.previewElement.style.opacity = '0.6';
    app.previewElement.style.pointerEvents = 'none';
    app.viewport.contentLayer.appendChild(app.previewElement);
}

export function getEffectiveStrokeWidth(app, lineWidth) {
    const minWorldWidth = 1 / app.viewport.scale;
    return Math.max(lineWidth, minWorldWidth);
}

export function updatePreview(app) {
    if (!app.previewElement || !app.drawStart || !app.drawCurrent) return;

    const start = app.drawStart;
    const end = app.drawCurrent;
    const opts = app.toolOptions;
    const strokeWidth = getEffectiveStrokeWidth(app, opts.lineWidth);

    let svg = '';

    switch (app.currentTool) {
        case 'line':
        case 'wire':
            svg = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
            break;

        case 'rect': {
            const x = Math.min(start.x, end.x);
            const y = Math.min(start.y, end.y);
            const w = Math.abs(end.x - start.x);
            const h = Math.abs(end.y - start.y);
            svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" 
                    fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"/>`;
            break;
        }

        case 'circle': {
            const radius = Math.hypot(end.x - start.x, end.y - start.y);
            svg = `<circle cx="${start.x}" cy="${start.y}" r="${radius}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" 
                    fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"/>`;
            break;
        }

        case 'arc': {
            const arcRadius = Math.hypot(end.x - start.x, end.y - start.y);
            const endAngle = Math.atan2(end.y - start.y, end.x - start.x);
            const arcEndX = start.x + arcRadius * Math.cos(endAngle);
            const arcEndY = start.y + arcRadius * Math.sin(endAngle);
            const largeArc = endAngle > Math.PI ? 1 : 0;
            svg = `<path d="M ${start.x + arcRadius} ${start.y} A ${arcRadius} ${arcRadius} 0 ${largeArc} 1 ${arcEndX} ${arcEndY}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round"/>`;
            break;
        }

        case 'polygon':
            if (app.polygonPoints.length > 0) {
                const points = [...app.polygonPoints, end];
                const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');
                svg = `<polyline points="${pointsStr}" 
                        stroke="${opts.color}" stroke-width="${strokeWidth}" 
                        fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"
                        stroke-linecap="round" stroke-linejoin="round"/>`;
                for (const p of app.polygonPoints) {
                    svg += `<circle cx="${p.x}" cy="${p.y}" r="${2 / app.viewport.scale}" fill="${opts.color}"/>`;
                }
            }
            break;
        case 'text':
            svg = `<text x="${start.x}" y="${start.y}" fill="${opts.color}" font-size="2.5" font-family="Arial" dominant-baseline="alphabetic" alignment-baseline="alphabetic"></text>`;
            break;
    }

    app.previewElement.innerHTML = svg;
}

export function createShapeFromDrawing(app) {
    const start = app.drawStart;
    const end = app.drawCurrent;
    const opts = app.toolOptions;
    const minSize = 0.5;

    switch (app.currentTool) {
        case 'line':
        case 'wire': {
            const length = Math.hypot(end.x - start.x, end.y - start.y);
            if (length < minSize) return null;
            return new Line({
                x1: start.x, y1: start.y,
                x2: end.x, y2: end.y,
                color: app.currentTool === 'wire' ? '#00cc66' : opts.color,
                lineWidth: opts.lineWidth
            });
        }

        case 'rect': {
            const w = Math.abs(end.x - start.x);
            const h = Math.abs(end.y - start.y);
            if (w < minSize || h < minSize) return null;
            return new Rect({
                x: Math.min(start.x, end.x),
                y: Math.min(start.y, end.y),
                width: w,
                height: h,
                color: opts.color,
                lineWidth: opts.lineWidth,
                fill: opts.fill,
                fillColor: opts.color,
                fillAlpha: 0.3
            });
        }

        case 'circle': {
            const radius = Math.hypot(end.x - start.x, end.y - start.y);
            if (radius < minSize) return null;
            return new Circle({
                x: start.x,
                y: start.y,
                radius,
                color: opts.color,
                lineWidth: opts.lineWidth,
                fill: opts.fill,
                fillColor: opts.color,
                fillAlpha: 0.3
            });
        }

        case 'arc': {
            const arcRadius = Math.hypot(end.x - start.x, end.y - start.y);
            if (arcRadius < minSize) return null;
            const endAngle = Math.atan2(end.y - start.y, end.x - start.x);
            return new Arc({
                x: start.x,
                y: start.y,
                radius: arcRadius,
                startAngle: 0,
                endAngle: endAngle,
                color: opts.color,
                lineWidth: opts.lineWidth
            });
        }
        case 'text': {
            return new Text({
                x: start.x,
                y: start.y,
                text: '',
                color: opts.color,
                fillColor: opts.color
            });
        }

        default:
            return null;
    }
}
