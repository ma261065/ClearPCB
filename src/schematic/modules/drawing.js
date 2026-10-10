import { Line, Circle, Arc, Text, Net, NoConnect } from '../../shapes/index.js';
import { DRAWING_SHAPES, shapeFromPoints, shapePreviewPath, advanceShapeDrawing } from '../../shapes/shape-drawing.js';
import { normalizeNetOrientation, normalizeNetStyle } from '../../shapes/net.js';
import { validateNetNameAtPoint } from './net-validation.js';
import { clearAxisGlow, pathAlignmentSegments, renderAxisGlow, squareAlignmentSegments } from '../../shapes/axis-glow.js';
import { controlArcGeometry } from '../../shapes/arc-edit.js';
import { takeDrawSnapResult } from './draw-states.js';
import { getSchematicInteraction, setSchematicInteraction } from './schematic-interactions.js';
import { isNetItem } from '../../core/schematic-items.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../core/SchematicDocument.js').SchematicDrawable} SchematicDrawable */
/** @typedef {import('../../shapes/shape-drawing.js').DrawingKind} DrawingKind */
/** @typedef {import('../../shapes/net.js').NetStyle} NetStyle */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {import('../../ui/SchematicApp.js').SchematicToolOptions} SchematicToolOptions */

/** @param {SchematicEditor} app */
export function isSchematicDrawingActive(app) {
    return !!getSchematicInteraction(app, 'isDrawing');
}

/**
 * @param {SchematicEditor} app
 * @param {boolean} active
 */
export function setSchematicDrawingActive(app, active) {
    setSchematicInteraction(app, 'isDrawing', active);
}

/**
 * Allocate the lowest unused default net name in the current document.
 * Example: NET1, NET2, NET3 ... (fills gaps).
 * @param {SchematicEditor} app
 * @returns {string}
 */
function nextNetName_(app) {
    const used = new Set();
    for (const shape of app.shapes) {
        if (!isNetItem(shape) || typeof shape.net !== 'string') continue;
        const m = shape.net.trim().match(/^NET(\d+)$/i);
        if (m) used.add(Number(m[1]));
    }
    let i = 1;
    while (used.has(i)) i += 1;
    return `NET${i}`;
}

/**
 * @param {string} tool
 * @returns {tool is DrawingKind}
 */
function isDrawingKind(tool) {
    return DRAWING_SHAPES.has(/** @type {DrawingKind} */ (tool));
}

/** @param {SchematicEditor} app @param {NetStyle} style */
function defaultNetText(app, style) {
    const opts = /** @type {SchematicToolOptions} */ (app.toolOptions);
    if (typeof opts.netPresetText === 'string') return opts.netPresetText;
    if (style === 'gnd') return 'Gnd';
    return nextNetName_(app);
}

/**
 * Begins a shape-drawing session: stores start position, initializes
 * polygon/line/arc state, creates preview, and shows crosshair.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number}} worldPos - Starting position in world coordinates.
 */
export function startDrawing(app, worldPos) {
    if (app.currentTool === 'select') return;

    setSchematicDrawingActive(app, true);
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
    app.showCrosshair();
    app.updateCrosshair(worldPos);
    app.setToolCursor(app.currentTool, app.viewport.svg);
}

/**
 * Updates the current cursor position during drawing and refreshes the preview.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number}} worldPos - Current cursor position in world coordinates.
 */
export function updateDrawing(app, worldPos) {
    if (!isSchematicDrawingActive(app)) return;

    app.drawCurrent = { ...worldPos };
    updatePreview(app);
}

/**
 * Completes the drawing: creates the final shape, adds it to the canvas,
 * starts text edit if text tool, then cancels drawing mode.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number}} worldPos - Final position in world coordinates.
 */
export function finishDrawing(app, worldPos) {
    if (!isSchematicDrawingActive(app)) return;

    app.drawCurrent = { ...worldPos };

    const shape = createShapeFromDrawing(app);
    if (shape) {
        app.addShape(shape);
        if (shape.type === 'text') {
            // A new label opens straight into inline editing, which edits the selection.
            app.selection.select(shape);
            app.startTextEdit(shape);
        } else {
            // A drawn shape is not selected; its handles appear once the user selects it.
            app.selection.clearSelection();
        }
    }

    cancelDrawing(app);
}

/**
 * Adds a vertex to the in-progress polygon and updates the preview.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number}} worldPos - Vertex position in world coordinates.
 */
export function addPolygonPoint(app, worldPos) {
    if (app.currentTool === 'polygon' && isSchematicDrawingActive(app)) {
        app.polygonPoints.push({ ...worldPos });
        updatePreview(app);
    }
}

/**
 * Completes the polygon (≥3 points required), strips duplicate trailing
 * points, creates a `Polygon` shape, and adds it to the canvas.
 * @param {SchematicEditor} app
 */
export function finishPolygon(app) {
    if (app.currentTool === 'polygon' && isSchematicDrawingActive(app) && app.drawCurrent) finishDrawing(app, app.drawCurrent);
}

/**
 * Adds a vertex to the in-progress polyline and updates the preview.
 * @param {SchematicEditor} app
 * @param {{x: number, y: number}} worldPos - Vertex position in world coordinates.
 */
export function addLinePoint(app, worldPos) {
    if (app.currentTool === 'line' && isSchematicDrawingActive(app)) {
        app.linePoints.push({ ...worldPos });
        updatePreview(app);
    }
}

/**
 * Completes the line (≥2 points required), strips duplicates, creates
 * a `Line` shape, and adds it to the canvas.
 * @param {SchematicEditor} app
 */
export function finishLine(app) {
    if (app.currentTool === 'line' && isSchematicDrawingActive(app) && app.drawCurrent) finishDrawing(app, app.drawCurrent);
}

/**
 * Cancels active drawing: resets all state, removes the preview SVG,
 * hides crosshair, and restores cursor.
 * @param {SchematicEditor} app
 */
export function cancelDrawing(app) {
    clearAxisGlow(app);
    setSchematicDrawingActive(app, false);
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

    app.hideCrosshair();
    app.setToolCursor(app.currentTool, app.viewport.svg);
}

/**
 * Creates a semi-transparent SVG `<g>` for previewing the shape being drawn.
 * @param {SchematicEditor} app
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
 * @param {SchematicEditor} app
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
 * @param {SchematicEditor} app
 */
export function updatePreview(app) {
    if (!app.previewElement || !app.drawStart || !app.drawCurrent) return;
    const kind = app.currentTool === 'wire' ? 'line' : app.currentTool;
    if (!isDrawingKind(kind)) return;
    const opts = /** @type {SchematicToolOptions} */ (app.toolOptions);
    const points = drawingPoints(app);
    let element = app.previewElement.firstElementChild;
    if (!element || element.tagName !== 'path') {
        app.previewElement.textContent = '';
        element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        app.previewElement.appendChild(element);
    }
    element.setAttribute('d', shapePreviewPath(kind, points, app.drawCurrent, opts.cornerRadius || 0));
    element.setAttribute('stroke', String(opts.color));
    const lineWidth = opts.lineWidth ?? 0.25;
    element.setAttribute('stroke-width', String(getEffectiveStrokeWidth(app, lineWidth)));
    element.setAttribute('stroke-linecap', 'round');
    element.setAttribute('stroke-linejoin', 'round');
    element.setAttribute('fill', opts.fill && kind !== 'line' && kind !== 'arc' ? 'var(--sch-shape-fill, #777777)' : 'none');
    element.setAttribute('fill-opacity', '0.3');
    if (app.currentTool !== 'wire') {
        const geometry = shapeFromPoints(kind, [...points, app.drawCurrent], true);
        let segments = [];
        if (geometry?.points) {
            const vertices = geometry.points;
            const widths = vertices.map(() => lineWidth);
            segments = kind === 'rect' ? squareAlignmentSegments(vertices, widths)
                : pathAlignmentSegments(vertices, kind !== 'line', [vertices.length - 2, vertices.length - 1], widths);
        } else if (kind === 'arc') {
            const start = points[0], end = points[1] || app.drawCurrent;
            segments = points.length === 1
                ? pathAlignmentSegments([start, end], false, [0], [lineWidth])
                : geometry && !controlArcGeometry(geometry)
                    ? [{ a: start, b: end, width: lineWidth, collinear: true }] : [];
        }
        renderAxisGlow(app, segments);
    }
}

/** @param {SchematicEditor} app @returns {Point[]} */
function drawingPoints(app) {
    if (app.currentTool === 'line') return app.linePoints || [];
    if (app.currentTool === 'polygon') return app.polygonPoints || [];
    const start = /** @type {Point} */ (app.drawStart);
    return app.arcEndpoint && app.currentTool === 'arc' ? [start, app.arcEndpoint] : [start];
}

/** @param {SchematicEditor} app @param {Point} point */
export function shapeDrawingClick(app, point) {
    if (!isSchematicDrawingActive(app)) {
        startDrawing(app, point);
        return;
    }
    const next = advanceShapeDrawing(/** @type {DrawingKind} */ (app.currentTool), drawingPoints(app), point);
    if (app.currentTool === 'line') app.linePoints = next.points;
    if (app.currentTool === 'polygon') app.polygonPoints = next.points;
    if (app.currentTool === 'arc') app.arcEndpoint = next.points[1];
    updateDrawing(app, point);
    if (next.complete) finishDrawing(app, point);
}

/**
 * Instantiates the appropriate shape object (Rect, Circle, Arc, Text) from
 * the current drawing state and tool options.
 * @param {SchematicEditor} app
 * @returns {SchematicDrawable|null} The created shape, or `null` if too small.
 */
export function createShapeFromDrawing(app) {
    const start = /** @type {Point} */ (app.drawStart);
    const end = app.drawCurrent;
    if (!end) return null;
    const opts = /** @type {SchematicToolOptions} */ (app.toolOptions);
    if (isDrawingKind(app.currentTool)) {
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
                fontSize: opts.fontSize || 2.0,
                rotation: opts.textRotation || 0
            });
        }

        case 'net': {
            const style = normalizeNetStyle(typeof opts.netStyle === 'string' ? opts.netStyle : 't');
            const net = defaultNetText(app, style);
            const validation = validateNetNameAtPoint(app, { x: start.x, y: start.y }, net);
            if (!validation.ok) {
                const conflict = validation.conflictWith || 'an existing net';
                app.alert(`Cannot place net "${net}" on this connected wire. Net is already labeled "${conflict}".`, { title: 'Net Conflict' });
                return null;
            }
            return new Net({
                x: start.x,
                y: start.y,
                net,
                fontSize: opts.netFontSize || 1.4,
                style,
                orientation: normalizeNetOrientation(typeof opts.netOrientation === 'string' ? opts.netOrientation : 'N')
            });
        }

        case 'noconnect': {
            const snap = takeDrawSnapResult(app);
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
