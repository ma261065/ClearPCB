import { Line, Circle, Rect, Arc, Polygon, Text } from '../../shapes/index.js';

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
            if (!app.arcEndpoint) {
                // Stage 1: Drawing line to second endpoint
                svg = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" 
                        stroke="${opts.color}" stroke-width="${strokeWidth}" stroke-dasharray="0.5 0.5"/>`;
            } else {
                // Stage 2: Drawing arc through bulge point
                const p1 = start;
                const p2 = app.arcEndpoint;
                const bulgePoint = clampBulgePoint(p1, p2, end);
                
                // Check if bulge point is essentially on the chord (determinant near zero)
                const d1 = p1.x * p1.x + p1.y * p1.y;
                const d2 = p2.x * p2.x + p2.y * p2.y;
                const d3 = bulgePoint.x * bulgePoint.x + bulgePoint.y * bulgePoint.y;
                
                const det = 2 * (p1.x * (p2.y - bulgePoint.y) + p2.x * (bulgePoint.y - p1.y) + bulgePoint.x * (p1.y - p2.y));
                
                // If determinant is too small, points are nearly collinear - show a line
                if (Math.abs(det) < 0.001) {
                    svg = `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" 
                            stroke="${opts.color}" stroke-width="${strokeWidth}" stroke-dasharray="0.5 0.5"/>`;
                } else {
                    const cx = (d1 * (p2.y - bulgePoint.y) + d2 * (bulgePoint.y - p1.y) + d3 * (p1.y - p2.y)) / det;
                    const cy = (d1 * (bulgePoint.x - p2.x) + d2 * (p1.x - bulgePoint.x) + d3 * (p2.x - p1.x)) / det;
                    const radius = Math.hypot(p1.x - cx, p1.y - cy);
                    
                    // Calculate angles
                    const angle1 = Math.atan2(p1.y - cy, p1.x - cx);
                    const angle2 = Math.atan2(bulgePoint.y - cy, bulgePoint.x - cx);
                    const angle3 = Math.atan2(p2.y - cy, p2.x - cx);
                    
                    // Determine sweep direction using cross product (same as creation logic)
                    const ccw = ((p2.x - p1.x) * (bulgePoint.y - p1.y) - (p2.y - p1.y) * (bulgePoint.x - p1.x)) > 0;
                    
                    // SVG sweep flag is inverted from our CCW calculation due to Y-axis direction
                    const sweepFlag = ccw ? 0 : 1;
                    
                    // Always use the small arc
                    const largeArc = 0;
                    
                    // Store the direction/flags for when we create the actual arc
                    app.arcDirection = ccw;
                    app.arcSweepFlag = sweepFlag;
                    app.arcLargeArc = largeArc;
                    
                        svg = `<path d="M ${p1.x} ${p1.y} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${p2.x} ${p2.y}" 
                            stroke="${opts.color}" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round"/>`;
                    // Show bulge point for reference
                    svg += `<circle cx="${bulgePoint.x}" cy="${bulgePoint.y}" r="${2 / app.viewport.scale}" fill="${opts.color}"/>`;
                }
            }
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
            if (!app.arcEndpoint) return null;
            
            const p1 = start;
            const p2 = app.arcEndpoint;
            const bulgePoint = clampBulgePoint(p1, p2, app.drawCurrent);
            
            // Calculate arc center and radius from three points using circumcircle
            const dx1 = p2.x - p1.x;
            const dy1 = p2.y - p1.y;
            const dx2 = bulgePoint.x - p2.x;
            const dy2 = bulgePoint.y - p2.y;
            
            const d1 = p1.x * p1.x + p1.y * p1.y;
            const d2 = p2.x * p2.x + p2.y * p2.y;
            const d3 = bulgePoint.x * bulgePoint.x + bulgePoint.y * bulgePoint.y;
            
            const det = 2 * (p1.x * (p2.y - bulgePoint.y) + p2.x * (bulgePoint.y - p1.y) + bulgePoint.x * (p1.y - p2.y));
            
            if (Math.abs(det) < 0.0001) return null; // Points are collinear
            
            const cx = (d1 * (p2.y - bulgePoint.y) + d2 * (bulgePoint.y - p1.y) + d3 * (p1.y - p2.y)) / det;
            const cy = (d1 * (bulgePoint.x - p2.x) + d2 * (p1.x - bulgePoint.x) + d3 * (p2.x - p1.x)) / det;
            const radius = Math.hypot(p1.x - cx, p1.y - cy);
            
            if (radius < minSize) return null;
            
            // Calculate angles
            const angle1 = Math.atan2(p1.y - cy, p1.x - cx);
            const angle3 = Math.atan2(p2.y - cy, p2.x - cx);
            
            // Use the stored direction/flags from preview (or calculate if not available)
            const ccw = app.arcDirection !== undefined ? app.arcDirection : 
                ((p2.x - p1.x) * (bulgePoint.y - p1.y) - (p2.y - p1.y) * (bulgePoint.x - p1.x)) > 0;
            const sweepFlag = app.arcSweepFlag !== undefined ? app.arcSweepFlag : (ccw ? 0 : 1);
            const largeArc = 0;
            
            const startAngle = angle1;
            let endAngle = angle3;
            
            // Adjust endAngle to be in the correct direction (arc on the bulge side)
            if (ccw) {
                // Counter-clockwise: endAngle should be > startAngle
                while (endAngle <= startAngle) endAngle += Math.PI * 2;
            } else {
                // Clockwise: endAngle should be < startAngle
                while (endAngle >= startAngle) endAngle -= Math.PI * 2;
            }
            
            // Clear stored direction/flags
            app.arcDirection = undefined;
            app.arcSweepFlag = undefined;
            app.arcLargeArc = undefined;
            
            return new Arc({
                x: cx,
                y: cy,
                radius: radius,
                startAngle: startAngle,
                endAngle: endAngle,
                sweepFlag: sweepFlag,
                largeArc: largeArc,
                bulgePoint: { x: bulgePoint.x, y: bulgePoint.y },
                startPoint: { x: p1.x, y: p1.y },
                endPoint: { x: p2.x, y: p2.y },
                snapToGrid: app.viewport.snapToGrid,
                gridSize: app.viewport.gridSize,
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
