import { Line, Circle, Rect, Arc, Polygon, Text, Net, NoConnect, createRect } from '../../shapes/index.js';
import { circumcircle, projectOntoChordBisector, clampBulgePoint } from '../../core/geometry.js';
import { normalizeNetOrientation, normalizeNetStyle } from '../../shapes/net.js';
import { validateNetNameAtPoint } from './net-validation.js';

/**
 * Allocate the lowest unused default net name in the current document.
 * Example: NET1, NET2, NET3 ... (fills gaps).
 * @param {object} app - Application state.
 * @returns {string}
 */
function nextNetName_(app) {
    const used = new Set();
    for (const shape of app.shapes) {
        if (shape?.type !== 'net' || typeof shape.net !== 'string') continue;
        const m = shape.net.trim().match(/^NET(\d+)$/i);
        if (m) used.add(Number(m[1]));
    }
    let i = 1;
    while (used.has(i)) i += 1;
    return `NET${i}`;
}

function defaultNetText(app, style) {
    if (app.toolOptions.netPresetText) return app.toolOptions.netPresetText;
    if (style === 'gnd') return 'Gnd';
    return nextNetName_(app);
}

/**
 * Begins a shape-drawing session: stores start position, initializes
 * polygon/line/arc state, creates preview, and shows crosshair.
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} worldPos - Starting position in world coordinates.
 */
export function startDrawing(app, worldPos) {
    if (app.currentTool === 'select') return;

    app.isDrawing = true;
    app.drawStart = { ...worldPos };
    app.drawCurrent = { ...worldPos };
    app.interactionState = 'drawing';

    if (app.currentTool === 'polygon') {
        app.polygonPoints = [{ ...worldPos }];
    }

    if (app.currentTool === 'line') {
        app.linePoints = [{ ...worldPos }];
    }
    
    if (app.currentTool === 'arc') {
        app.arcEndpoint = null;
    }

    createPreview(app);
    app._showCrosshair();
    app._updateCrosshair(worldPos);
    app._setToolCursor(app.currentTool, app.viewport.svg);
}

/**
 * Updates the current cursor position during drawing and refreshes the preview.
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} worldPos - Current cursor position in world coordinates.
 */
export function updateDrawing(app, worldPos) {
    if (!app.isDrawing) return;

    app.drawCurrent = { ...worldPos };
    updatePreview(app);
}

/**
 * Completes the drawing: creates the final shape, adds it to the canvas,
 * starts text edit if text tool, then cancels drawing mode.
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} worldPos - Final position in world coordinates.
 */
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

/**
 * Remove duplicate trailing points caused by double-click adding two at the same spot.
 */
function stripDuplicateTrailingPoints(points, minCount) {
    while (points.length > minCount) {
        const last = points[points.length - 1];
        const prev = points[points.length - 2];
        if (last.x === prev.x && last.y === prev.y) {
            points.pop();
        } else {
            break;
        }
    }
}

/**
 * Adds a vertex to the in-progress polygon and updates the preview.
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} worldPos - Vertex position in world coordinates.
 */
export function addPolygonPoint(app, worldPos) {
    if (app.currentTool === 'polygon' && app.isDrawing) {
        app.polygonPoints.push({ ...worldPos });
        updatePreview(app);
    }
}

/**
 * Completes the polygon (≥3 points required), strips duplicate trailing
 * points, creates a `Polygon` shape, and adds it to the canvas.
 * @param {object} app - Application state.
 */
export function finishPolygon(app) {
    if (app.currentTool === 'polygon' && app.isDrawing && app.polygonPoints.length >= 3) {
        stripDuplicateTrailingPoints(app.polygonPoints, 3);
        const shape = new Polygon({
            points: app.polygonPoints.map(p => ({ ...p })),
            color: app.toolOptions.color,
            lineWidth: app.toolOptions.lineWidth,
                fill: app.toolOptions.fill,
                fillColor: 'var(--sch-shape-fill, #777777)',
            fillAlpha: 0.3,
            closed: true
        });
        // Check if the polygon forms a rectangle
        if (shape.isAxisAlignedRect()) {
            shape.isRect = true;
        }
        app.addShape(shape);
    }
    cancelDrawing(app);
}

/**
 * Adds a vertex to the in-progress polyline and updates the preview.
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} worldPos - Vertex position in world coordinates.
 */
export function addLinePoint(app, worldPos) {
    if (app.currentTool === 'line' && app.isDrawing) {
        app.linePoints.push({ ...worldPos });
        updatePreview(app);
    }
}

/**
 * Completes the line (≥2 points required), strips duplicates, creates
 * a `Line` shape, and adds it to the canvas.
 * @param {object} app - Application state.
 */
export function finishLine(app) {
    if (app.currentTool === 'line' && app.isDrawing && app.linePoints.length >= 2) {
        stripDuplicateTrailingPoints(app.linePoints, 2);
        const pts = app.linePoints.map(p => ({ ...p }));

        // Check if the line closes on itself → create polygon instead
        const first = pts[0];
        const last = pts[pts.length - 1];
        const closes = pts.length >= 3 && Math.hypot(first.x - last.x, first.y - last.y) < 0.15;

        if (closes) {
            // Remove the duplicate closing point
            pts.pop();
            const shape = new Line({
                points: pts,
                color: app.toolOptions.color,
                lineWidth: app.toolOptions.lineWidth,
                closed: true,
                fill: app.toolOptions.fill,
            });
            // Check if it forms a rectangle
            if (shape.isAxisAlignedRect()) {
                shape.isRect = true;
            }
            app.addShape(shape);
        } else {
            const shape = new Line({
                points: pts,
                color: app.toolOptions.color,
                lineWidth: app.toolOptions.lineWidth,
                fill: app.toolOptions.fill,
            });
            app.addShape(shape);
        }
    }
    cancelDrawing(app);
}

/**
 * Cancels active drawing: resets all state, removes the preview SVG,
 * hides crosshair, and restores cursor.
 * @param {object} app - Application state.
 */
export function cancelDrawing(app) {
    app.isDrawing = false;
    app.interactionState = app.currentTool === 'select' ? 'idle' : 'toolActive';
    app.drawStart = null;
    app.drawCurrent = null;
    app.polygonPoints = [];
    app.linePoints = [];
    app.arcEndpoint = null;

    if (app.previewElement) {
        app.previewElement.remove();
        app.previewElement = null;
    }

    app._hideCrosshair();
    app._setToolCursor(app.currentTool, app.viewport.svg);
}

/**
 * Creates a semi-transparent SVG `<g>` for previewing the shape being drawn.
 * @param {object} app - Application state.
 */
export function createPreview(app) {
    app.previewElement = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    app.previewElement.setAttribute('class', 'preview');
    app.previewElement.style.opacity = '0.6';
    app.previewElement.style.pointerEvents = 'none';
    app.viewport.contentLayer.appendChild(app.previewElement);
}

/**
 * Returns the larger of `lineWidth` or the minimum visible stroke width
 * at the current zoom level.
 * @param {object} app - Application state.
 * @param {number} lineWidth - Requested line width.
 * @returns {number} Effective stroke width.
 */
export function getEffectiveStrokeWidth(app, lineWidth) {
    const minWorldWidth = 1 / app.viewport.scale;
    return Math.max(lineWidth, minWorldWidth);
}

/**
 * Redraws the preview SVG to match the current tool, start position, and
 * cursor position (handles line, wire, rect, circle, arc, polygon, text).
 * @param {object} app - Application state.
 */
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
        case 'line': {
            if (app.linePoints && app.linePoints.length > 0) {
                const points = [...app.linePoints, end];
                const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');
                const fillAttr = opts.fill && points.length >= 3 ? 'var(--sch-shape-fill, #777777)' : 'none';
                let svg = `<polyline points="${pointsStr}" 
                        stroke="${opts.color}" stroke-width="${strokeWidth}" 
                        fill="${fillAttr}" fill-opacity="0.3"
                        stroke-linecap="round" stroke-linejoin="round"/>`;
                for (const p of app.linePoints) {
                    svg += `<circle cx="${p.x}" cy="${p.y}" r="${2 / app.viewport.scale}" fill="${opts.color}"/>`;
                }
                app.previewElement.innerHTML = svg;
            }
            break;
        }

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
                el.setAttribute('fill', opts.fill ? 'var(--sch-shape-fill, #777777)' : 'none');
                return;
            }
                app.previewElement.innerHTML = `<rect x="${x}" y="${y}" width="${w}" height="${h}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" 
                    fill="${opts.fill ? 'var(--sch-shape-fill, #777777)' : 'none'}" fill-opacity="0.3"/>`;
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
                el.setAttribute('fill', opts.fill ? 'var(--sch-shape-fill, #777777)' : 'none');
                return;
            }
                app.previewElement.innerHTML = `<circle cx="${start.x}" cy="${start.y}" r="${radius}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" 
                    fill="${opts.fill ? 'var(--sch-shape-fill, #777777)' : 'none'}" fill-opacity="0.3"/>`;
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
                const bulgePoint = clampBulgePoint(p1, p2, projectOntoChordBisector(p1, p2, end));
                const circ = circumcircle(p1, p2, bulgePoint);
                
                if (!circ) {
                    app.previewElement.innerHTML = `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" 
                            stroke="${opts.color}" stroke-width="${strokeWidth}" stroke-dasharray="0.5 0.5"/>`;
                } else {
                    const { radius } = circ;
                    const ccw = ((p2.x - p1.x) * (bulgePoint.y - p1.y) - (p2.y - p1.y) * (bulgePoint.x - p1.x)) > 0;
                    const sweepFlag = ccw ? 0 : 1;
                    
                    app.arcDirection = ccw;
                    app.arcSweepFlag = sweepFlag;
                    
                    const arcFill = opts.fill ? `<path d="M ${p1.x} ${p1.y} A ${radius} ${radius} 0 0 ${sweepFlag} ${p2.x} ${p2.y} Z" 
                            fill="var(--sch-shape-fill, #777777)" fill-opacity="0.3" stroke="none"/>` : '';
                    app.previewElement.innerHTML = `${arcFill}<path d="M ${p1.x} ${p1.y} A ${radius} ${radius} 0 0 ${sweepFlag} ${p2.x} ${p2.y}" 
                            stroke="${opts.color}" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round"/>`;
                }
            }
            break;
        }

        case 'polygon':
            if (app.polygonPoints.length > 0) {
                const points = [...app.polygonPoints, end];
                const pointsStr = points.map(p => `${p.x},${p.y}`).join(' ');
                // Use <polygon> (closed) once we have 3+ points so the closing edge is visible
                const tag = points.length >= 3 ? 'polygon' : 'polyline';
                let svg = `<${tag} points="${pointsStr}" 
                    stroke="${opts.color}" stroke-width="${strokeWidth}" 
                    fill="${opts.fill ? 'var(--sch-shape-fill, #777777)' : 'none'}" fill-opacity="0.3"
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

/**
 * Instantiates the appropriate shape object (Rect, Circle, Arc, Text) from
 * the current drawing state and tool options.
 * @param {object} app - Application state.
 * @returns {import('../../shapes/shape.js').Shape|null} The created shape, or `null` if too small.
 */
export function createShapeFromDrawing(app) {
    const start = app.drawStart;
    const end = app.drawCurrent;
    const opts = app.toolOptions;
    const minSize = 0.5;

    switch (app.currentTool) {
        case 'rect': {
            const w = Math.abs(end.x - start.x);
            const h = Math.abs(end.y - start.y);
            if (w < minSize || h < minSize) return null;
            return createRect({
                x: Math.min(start.x, end.x),
                y: Math.min(start.y, end.y),
                width: w,
                height: h,
                color: opts.color,
                lineWidth: opts.lineWidth,
                fill: opts.fill,
                fillColor: 'var(--sch-shape-fill, #777777)',
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
                fillColor: 'var(--sch-shape-fill, #777777)',
                fillAlpha: 0.3
            });
        }

        case 'arc': {
            if (!app.arcEndpoint) return null;
            
            const p1 = start;
            const p2 = app.arcEndpoint;
            const bulgePoint = clampBulgePoint(p1, p2, projectOntoChordBisector(p1, p2, app.drawCurrent));
            
            // Clear stored direction/flags
            app.arcDirection = undefined;
            app.arcSweepFlag = undefined;
            
            return new Arc({
                bulgePoint: { x: bulgePoint.x, y: bulgePoint.y },
                startPoint: { x: p1.x, y: p1.y },
                endPoint: { x: p2.x, y: p2.y },
                color: opts.color,
                lineWidth: opts.lineWidth,
                fill: opts.fill,
            });
        }
        case 'text': {
            return new Text({
                x: start.x,
                y: start.y,
                text: '',
                color: opts.textColor,
                fillColor: opts.textColor,
                fontSize: app.toolOptions.fontSize || 2.0
            });
        }

        case 'net': {
            const style = normalizeNetStyle(app.toolOptions.netStyle || 't');
            const net = defaultNetText(app, style);
            const validation = validateNetNameAtPoint(app, { x: start.x, y: start.y }, net);
            if (!validation.ok) {
                const conflict = validation.conflictWith || 'an existing net';
                app._alert(`Cannot place net "${net}" on this connected wire. Net is already labeled "${conflict}".`, { title: 'Net Conflict' });
                return null;
            }
            return new Net({
                x: start.x,
                y: start.y,
                net,
                fontSize: app.toolOptions.netFontSize || 1.4,
                style,
                orientation: normalizeNetOrientation(app.toolOptions.netOrientation || 'N')
            });
        }

        case 'noconnect': {
            const snap = app._drawSnapResult;
            app._drawSnapResult = null;
            const nc = new NoConnect({
                x: start.x,
                y: start.y
            });
            if (snap?.snapPin) {
                nc.pinConnection = {
                    componentId: snap.snapPin.component.id,
                    pinNumber: snap.snapPin.pin.number
                };
            }
            return nc;
        }

        default:
            return null;
    }
}
