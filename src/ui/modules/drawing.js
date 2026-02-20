import { Line, Circle, Rect, Arc, Polygon, Text } from '../../shapes/index.js';
import { circumcircle } from '../../core/geometry.js';

function clampBulgePoint(p1, p2, b) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const chordDx = p2.x - p1.x;
    const chordDy = p2.y - p1.y;
    const maxRadius = Math.hypot(chordDx, chordDy) / 2;

    if (maxRadius === 0) return { x: b.x, y: b.y };

    const dx = b.x - mx;
    const dy = b.y - my;
    const dist = Math.hypot(dx, dy);

    if (dist <= maxRadius) return { x: b.x, y: b.y };

    const scale = maxRadius / dist;
    return {
        x: mx + dx * scale,
        y: my + dy * scale
    };
}

export function startDrawing(app, worldPos) {
    if (app.currentTool === 'select') return;

    app.isDrawing = true;
    app.drawStart = { ...worldPos };
    app.drawCurrent = { ...worldPos };

    if (app.currentTool === 'polygon') {
        app.polygonPoints = [{ ...worldPos }];
    }
    
    if (app.currentTool === 'arc') {
        app.arcEndpoint = null;
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
    app.arcEndpoint = null;

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

    // Reuse existing child element when possible to avoid innerHTML churn
    const ns = 'http://www.w3.org/2000/svg';
    const tool = app.currentTool;

    // Helper: ensure a single child element of the given tag exists
    const ensureChild = (tag, index = 0) => {
        let el = app.previewElement.children[index];
        if (!el || el.tagName !== tag) {
            // Fallback to innerHTML for complex changes or tag mismatch
            return null;
        }
        return el;
    };

    switch (tool) {
        case 'line':
        case 'wire': {
            let el = ensureChild('line');
            if (el) {
                el.setAttribute('x1', start.x);
                el.setAttribute('y1', start.y);
                el.setAttribute('x2', end.x);
                el.setAttribute('y2', end.y);
                el.setAttribute('stroke', opts.color);
                el.setAttribute('stroke-width', strokeWidth);
                return;
            }
            app.previewElement.innerHTML = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
            break;
        }

        case 'rect': {
            const x = Math.min(start.x, end.x);
            const y = Math.min(start.y, end.y);
            const w = Math.abs(end.x - start.x);
            const h = Math.abs(end.y - start.y);
            let el = ensureChild('rect');
            if (el) {
                el.setAttribute('x', x);
                el.setAttribute('y', y);
                el.setAttribute('width', w);
                el.setAttribute('height', h);
                el.setAttribute('stroke', opts.color);
                el.setAttribute('stroke-width', strokeWidth);
                el.setAttribute('fill', opts.fill ? opts.color : 'none');
                return;
            }
            app.previewElement.innerHTML = `<rect x="${x}" y="${y}" width="${w}" height="${h}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" 
                    fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"/>`;
            break;
        }

        case 'circle': {
            const radius = Math.hypot(end.x - start.x, end.y - start.y);
            let el = ensureChild('circle');
            if (el) {
                el.setAttribute('cx', start.x);
                el.setAttribute('cy', start.y);
                el.setAttribute('r', radius);
                el.setAttribute('stroke', opts.color);
                el.setAttribute('stroke-width', strokeWidth);
                el.setAttribute('fill', opts.fill ? opts.color : 'none');
                return;
            }
            app.previewElement.innerHTML = `<circle cx="${start.x}" cy="${start.y}" r="${radius}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" 
                    fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"/>`;
            break;
        }

        case 'arc': {
            // Arc preview is complex (path changes structure), keep innerHTML for now
            if (!app.arcEndpoint) {
                app.previewElement.innerHTML = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" 
                        stroke="${opts.color}" stroke-width="${strokeWidth}" stroke-dasharray="0.5 0.5"/>`;
            } else {
                const p1 = start;
                const p2 = app.arcEndpoint;
                const bulgePoint = clampBulgePoint(p1, p2, end);
                
                const det = 2 * (p1.x * (p2.y - bulgePoint.y) + p2.x * (bulgePoint.y - p1.y) + bulgePoint.x * (p1.y - p2.y));
                
                if (Math.abs(det) < 0.001) {
                    app.previewElement.innerHTML = `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" 
                            stroke="${opts.color}" stroke-width="${strokeWidth}" stroke-dasharray="0.5 0.5"/>`;
                } else {
                    const circ = circumcircle(p1, p2, bulgePoint);
                    const { cx, cy, radius } = circ;
                    
                    const ccw = ((p2.x - p1.x) * (bulgePoint.y - p1.y) - (p2.y - p1.y) * (bulgePoint.x - p1.x)) > 0;
                    const sweepFlag = ccw ? 0 : 1;
                    const largeArc = 0;
                    
                    app.arcDirection = ccw;
                    app.arcSweepFlag = sweepFlag;
                    app.arcLargeArc = largeArc;
                    
                    let svg = `<path d="M ${p1.x} ${p1.y} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${p2.x} ${p2.y}" 
                            stroke="${opts.color}" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round"/>`;
                    svg += `<circle cx="${bulgePoint.x}" cy="${bulgePoint.y}" r="${2 / app.viewport.scale}" fill="${opts.color}"/>`;
                    app.previewElement.innerHTML = svg;
                }
            }
            break;
        }

        case 'polygon':
            if (app.polygonPoints.length > 0) {
                const points = [...app.polygonPoints, end];
                const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');
                let svg = `<polyline points="${pointsStr}" 
                        stroke="${opts.color}" stroke-width="${strokeWidth}" 
                        fill="${opts.fill ? opts.color : 'none'}" fill-opacity="0.3"
                        stroke-linecap="round" stroke-linejoin="round"/>`;
                for (const p of app.polygonPoints) {
                    svg += `<circle cx="${p.x}" cy="${p.y}" r="${2 / app.viewport.scale}" fill="${opts.color}"/>`;
                }
                app.previewElement.innerHTML = svg;
            }
            break;
        case 'text':
            // Text preview doesn't change during draw
            break;
    }
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
            if (!app.arcEndpoint) return null;
            
            const p1 = start;
            const p2 = app.arcEndpoint;
            const bulgePoint = clampBulgePoint(p1, p2, app.drawCurrent);
            
            // Clear stored direction/flags
            app.arcDirection = undefined;
            app.arcSweepFlag = undefined;
            app.arcLargeArc = undefined;
            
            return new Arc({
                bulgePoint: { x: bulgePoint.x, y: bulgePoint.y },
                startPoint: { x: p1.x, y: p1.y },
                endPoint: { x: p2.x, y: p2.y },
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
                fillColor: opts.color,
                fontSize: app.toolOptions.fontSize || 2.0
            });
        }

        default:
            return null;
    }
}
