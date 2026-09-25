import { Line, Circle, Arc, Text, Net, NoConnect } from '../../shapes/index.js';
import { DRAWING_SHAPES, shapeFromPoints, shapePreviewPath, advanceShapeDrawing } from '../../shapes/shape-drawing.js';
import { normalizeNetOrientation, normalizeNetStyle } from '../../shapes/net.js';
import { validateNetNameAtPoint } from './net-validation.js';
import { clearAxisGlow, pathAlignmentSegments, renderAxisGlow, squareAlignmentSegments } from '../../shapes/axis-glow.js';
import { controlArcGeometry } from '../../shapes/arc-edit.js';

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
        app.selection.select(shape);
        if (shape.type === 'text') {
            app._startTextEdit?.(shape);
        }
    }

    cancelDrawing(app);
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
    if (app.currentTool === 'polygon' && app.isDrawing) finishDrawing(app, app.drawCurrent);
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
    if (app.currentTool === 'line' && app.isDrawing) finishDrawing(app, app.drawCurrent);
}

/**
 * Cancels active drawing: resets all state, removes the preview SVG,
 * hides crosshair, and restores cursor.
 * @param {object} app - Application state.
 */
export function cancelDrawing(app) {
    clearAxisGlow(app);
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
    const kind = app.currentTool === 'wire' ? 'line' : app.currentTool;
    if (!DRAWING_SHAPES.has(kind)) return;
    const points = drawingPoints(app);
    let element = app.previewElement.firstElementChild;
    if (!element || element.tagName !== 'path') {
        app.previewElement.textContent = '';
        element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        app.previewElement.appendChild(element);
    }
    element.setAttribute('d', shapePreviewPath(kind, points, app.drawCurrent, app.toolOptions.cornerRadius || 0));
    element.setAttribute('stroke', app.toolOptions.color);
    element.setAttribute('stroke-width', getEffectiveStrokeWidth(app, app.toolOptions.lineWidth));
    element.setAttribute('stroke-linecap', 'round');
    element.setAttribute('stroke-linejoin', 'round');
    element.setAttribute('fill', app.toolOptions.fill && kind !== 'line' && kind !== 'arc' ? 'var(--sch-shape-fill, #777777)' : 'none');
    element.setAttribute('fill-opacity', '0.3');
    if (app.currentTool !== 'wire') {
        const geometry = shapeFromPoints(kind, [...points, app.drawCurrent], true);
        let segments = [];
        if (geometry?.points) {
            const vertices = geometry.points;
            const widths = vertices.map(() => app.toolOptions.lineWidth);
            segments = kind === 'rect' ? squareAlignmentSegments(vertices, widths)
                : pathAlignmentSegments(vertices, kind !== 'line', [vertices.length - 2, vertices.length - 1], widths);
        } else if (kind === 'arc') {
            const start = points[0], end = points[1] || app.drawCurrent;
            segments = points.length === 1
                ? pathAlignmentSegments([start, end], false, [0], [app.toolOptions.lineWidth])
                : geometry && !controlArcGeometry(geometry)
                    ? [{ a: start, b: end, width: app.toolOptions.lineWidth, collinear: true }] : [];
        }
        renderAxisGlow(app, segments);
    }
}

function drawingPoints(app) {
    if (app.currentTool === 'line') return app.linePoints || [];
    if (app.currentTool === 'polygon') return app.polygonPoints || [];
    return app.arcEndpoint && app.currentTool === 'arc' ? [app.drawStart, app.arcEndpoint] : [app.drawStart];
}

export function shapeDrawingClick(app, point) {
    if (!app.isDrawing) {
        app._startDrawing(point);
        return;
    }
    const next = advanceShapeDrawing(app.currentTool, drawingPoints(app), point);
    if (app.currentTool === 'line') app.linePoints = next.points;
    if (app.currentTool === 'polygon') app.polygonPoints = next.points;
    if (app.currentTool === 'arc') app.arcEndpoint = next.points[1];
    app._updateDrawing(point);
    if (next.complete) app._finishDrawing(point);
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
    if (DRAWING_SHAPES.has(app.currentTool)) {
        const points = drawingPoints(app);
        const geometry = shapeFromPoints(app.currentTool,
            ['line', 'polygon'].includes(app.currentTool) ? points : [...points, end]);
        if (!geometry) return null;
        const style = { color: opts.color, lineWidth: opts.lineWidth,
            fill: opts.fill && !['line', 'arc'].includes(app.currentTool),
            fillColor: 'var(--sch-shape-fill, #777777)', fillAlpha: 0.3 };
        if (geometry.kind === 'circle') return new Circle({ ...style, ...geometry });
        if (geometry.kind === 'arc') return new Arc({ ...style,
            startPoint: geometry.start, endPoint: geometry.end, bulgePoint: geometry.bulge });
        const shape = new Line({ ...style, points: geometry.points,
            closed: geometry.kind !== 'line', cornerRadius: opts.cornerRadius || 0 });
        shape.isRect = shape.closed && shape.isAxisAlignedRect();
        return shape;
    }

    switch (app.currentTool) {
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
