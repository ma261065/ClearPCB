/**
 * KiCad symbol graphics owns primitive pin, stroke, fill and shape conversion
 * from parsed KiCad symbol S-expressions into ClearPCB graphics objects.
 */

import { circumcircle } from '../../core/geometry.js';



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse KiCad pin
     * (pin type shape (at x y angle) (length len) (name "name" ...) (number "num" ...))
     */
export function _parseKiCadPin(fetcher, pinSexp) {
    /** @type {{ type: string, number: string, name: string, x: number, y: number, orientation: string, length: number, pinType: string, shape: string, hidden: boolean, kicadNameFontSize: number|null, kicadNumberFontSize: number|null, _coordKey?: string }} */
    const pin = {
        type: 'pin',
        number: '',
        name: '',
        x: 0,
        y: 0,
        orientation: 'right',
        length: 2.54,
        pinType: 'passive',
        shape: 'line',
        hidden: false,
        kicadNameFontSize: null,
        kicadNumberFontSize: null
    };

    const extractFontSize = (node) => {
        if (!Array.isArray(node)) return null;
        for (const child of node) {
            if (!Array.isArray(child)) continue;
            if (child[0] === 'effects') {
                for (const eff of child) {
                    if (!Array.isArray(eff)) continue;
                    if (eff[0] === 'font') {
                        for (const fontItem of eff) {
                            if (!Array.isArray(fontItem)) continue;
                            if (fontItem[0] === 'size') {
                                const sx = parseFloat(fontItem[1]);
                                const sy = parseFloat(fontItem[2]);
                                if (Number.isFinite(sy)) return sy;
                                if (Number.isFinite(sx)) return sx;
                            }
                        }
                    }
                }
            }
        }
        return null;
    };

    // Get pin type and shape
    if (pinSexp.length > 1) pin.pinType = pinSexp[1];
    if (pinSexp.length > 2) pin.shape = pinSexp[2];

    for (const item of pinSexp) {
        if (!Array.isArray(item)) continue;

        switch (item[0]) {
            case 'at':
                // KiCad 6+ uses mm directly, just negate Y
                pin.x = parseFloat(item[1]) || 0;
                pin.y = -(parseFloat(item[2]) || 0); // Invert Y axis
                if (item.length > 3) {
                    const angle = parseFloat(item[3]) || 0;
                    pin.orientation = fetcher._angleToOrientation(angle);
                }
                break;
            case 'length':
                pin.length = parseFloat(item[1]) || 2.54;
                break;
            case 'hide':
                // KiCad 7+: (hide yes); older value forms also count as hidden
                // unless explicitly 'no'/false.
                pin.hidden = item[1] == null || (item[1] !== 'no' && item[1] !== false);
                break;
            case 'name':
                // Remove quotes if present
                pin.name = String(item[1] || '').replace(/^"|"$/g, '');
                pin.kicadNameFontSize = extractFontSize(item) ?? pin.kicadNameFontSize;
                break;
            case 'number':
                pin.number = String(item[1] || '').replace(/^"|"$/g, '');
                pin.kicadNumberFontSize = extractFontSize(item) ?? pin.kicadNumberFontSize;
                break;
        }
    }
    // KiCad 6 marks hidden pins with a bare `hide` token (not a list).
    if (pinSexp.includes('hide')) pin.hidden = true;

    if (Number.isFinite(pin.x) && Number.isFinite(pin.y)) {
        pin._coordKey = `${pin.x.toFixed(3)},${pin.y.toFixed(3)}`;
    }
    return pin;
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse a `(property "Name" "Value")` S-expression.
     * @param {Array<any>} propSexp
     * @returns {{name: string|null, value: string|null}|null}
     */
export function _parseKiCadProperty(fetcher, propSexp) {
    if (!Array.isArray(propSexp) || propSexp.length < 3) return null;
    const nameRaw = propSexp[1];
    const valueRaw = propSexp[2];

    const name = typeof nameRaw === 'string'
        ? nameRaw.replace(/^"|"$/g, '')
        : null;

    const value = typeof valueRaw === 'string'
        ? valueRaw.replace(/^"|"$/g, '')
        : null;

    return { name, value };
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse KiCad rectangle
     * (rectangle (start x1 y1) (end x2 y2) (stroke ...) (fill ...))
     */
export function _parseKiCadRectangle(fetcher, rectSexp) {
    let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    let stroke = 'var(--sch-symbol-outline)';
    let strokeWidth = 0.254;
    let fill = 'none';

    for (const item of rectSexp) {
        if (!Array.isArray(item)) continue;

        switch (item[0]) {
            case 'start':
                x1 = parseFloat(item[1]) || 0;
                y1 = -(parseFloat(item[2]) || 0);
                break;
            case 'end':
                x2 = parseFloat(item[1]) || 0;
                y2 = -(parseFloat(item[2]) || 0);
                break;
            case 'stroke':
                const strokeInfo = fetcher._parseStroke(item);
                stroke = strokeInfo.color;
                strokeWidth = strokeInfo.width;
                break;
            case 'fill':
                fill = fetcher._parseFill(item);
                break;
        }
    }

    return {
        type: 'rect',
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
        stroke: stroke,
        strokeWidth: strokeWidth,
        fill: fill
    };
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse KiCad polyline
     * (polyline (pts (xy x y) (xy x y) ...) (stroke ...) (fill ...))
     */
export function _parseKiCadPolyline(fetcher, polySexp) {
    const points = [];
    let stroke = 'var(--sch-symbol-outline)';
    let strokeWidth = 0.254;
    let fill = 'none';

    for (const item of polySexp) {
        if (!Array.isArray(item)) continue;

        switch (item[0]) {
            case 'pts':
                for (let i = 1; i < item.length; i++) {
                    if (Array.isArray(item[i]) && item[i][0] === 'xy') {
                        points.push([
                            parseFloat(item[i][1]) || 0,
                            -(parseFloat(item[i][2]) || 0)
                        ]);
                    }
                }
                break;
            case 'stroke':
                const strokeInfo = fetcher._parseStroke(item);
                stroke = strokeInfo.color;
                strokeWidth = strokeInfo.width;
                break;
            case 'fill':
                fill = fetcher._parseFill(item);
                break;
        }
    }

    return {
        type: 'polyline',
        points: points,
        stroke: stroke,
        strokeWidth: strokeWidth,
        fill: fill
    };
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse KiCad circle
     * (circle (center x y) (radius r) (stroke ...) (fill ...))
     */
export function _parseKiCadCircle(fetcher, circleSexp) {
    let cx = 0, cy = 0, r = 1;
    let stroke = 'var(--sch-symbol-outline)';
    let strokeWidth = 0.254;
    let fill = 'none';

    for (const item of circleSexp) {
        if (!Array.isArray(item)) continue;

        switch (item[0]) {
            case 'center':
                cx = parseFloat(item[1]) || 0;
                cy = -(parseFloat(item[2]) || 0);
                break;
            case 'radius':
                r = parseFloat(item[1]) || 1;
                break;
            case 'stroke':
                const strokeInfo = fetcher._parseStroke(item);
                stroke = strokeInfo.color;
                strokeWidth = strokeInfo.width;
                break;
            case 'fill':
                fill = fetcher._parseFill(item);
                break;
        }
    }

    return {
        type: 'circle',
        cx: cx,
        cy: cy,
        r: r,
        stroke: stroke,
        strokeWidth: strokeWidth,
        fill: fill
    };
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse KiCad arc
     * (arc (start x y) (mid x y) (end x y) (stroke ...) (fill ...))
     */
export function _parseKiCadArc(fetcher, arcSexp) {
    let startX = 0, startY = 0;
    let midX = 0, midY = 0;
    let endX = 0, endY = 0;
    let stroke = 'var(--sch-symbol-outline)';
    let strokeWidth = 0.254;
    let fill = 'none';

    for (const item of arcSexp) {
        if (!Array.isArray(item)) continue;

        switch (item[0]) {
            case 'start':
                startX = parseFloat(item[1]) || 0;
                startY = -(parseFloat(item[2]) || 0);
                break;
            case 'mid':
                midX = parseFloat(item[1]) || 0;
                midY = -(parseFloat(item[2]) || 0);
                break;
            case 'end':
                endX = parseFloat(item[1]) || 0;
                endY = -(parseFloat(item[2]) || 0);
                break;
            case 'stroke':
                const strokeInfo = fetcher._parseStroke(item);
                stroke = strokeInfo.color;
                strokeWidth = strokeInfo.width;
                break;
            case 'fill':
                fill = fetcher._parseFill(item);
                break;
        }
    }

    // Calculate center and radius from three points
    const circ = circumcircle(
        { x: startX, y: startY }, { x: midX, y: midY }, { x: endX, y: endY }
    );
    const cx = circ ? circ.cx : midX;
    const cy = circ ? circ.cy : midY;
    const r = circ ? circ.radius : 1;

    // Calculate angles
    const startAngle = Math.atan2(startY - cy, startX - cx);
    const endAngle = Math.atan2(endY - cy, endX - cx);

    return {
        type: 'arc',
        cx: cx,
        cy: cy,
        r: r,
        startAngle: startAngle * 180 / Math.PI,
        endAngle: endAngle * 180 / Math.PI,
        stroke: stroke,
        strokeWidth: strokeWidth,
        fill: fill
    };
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse stroke properties
     */
export function _parseStroke(fetcher, strokeSexp) {
    // Use CSS variable for theme-aware colors
    let color = 'var(--sch-symbol-outline)';
    let width = 0.254;

    for (const item of strokeSexp) {
        if (!Array.isArray(item)) continue;

        switch (item[0]) {
            case 'width':
                width = parseFloat(item[1]) || 0.254;
                break;
            case 'color':
                if (item.length >= 4) {
                    const r = Math.round(parseFloat(item[1]) || 0);
                    const g = Math.round(parseFloat(item[2]) || 0);
                    const b = Math.round(parseFloat(item[3]) || 0);
                    color = `rgb(${r},${g},${b})`;
                }
                break;
        }
    }

    return { color, width };
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse fill properties
     */
export function _parseFill(fetcher, fillSexp) {
    for (const item of fillSexp) {
        if (!Array.isArray(item)) continue;

        if (item[0] === 'type') {
            const fillType = String(item[1] || '').replace(/^"|"$/g, '');
            if (fillType === 'none') {
                return 'none';
            } else if (fillType === 'outline') {
                return 'currentColor';
            } else if (fillType === 'background') {
                return '#ffffcc'; // Light yellow background fill (common in KiCad)
            }
        }
    }
    return 'none';
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Convert angle to orientation string
     */
export function _angleToOrientation(fetcher, angle) {
    const normalized = ((angle % 360) + 360) % 360;
    if (normalized === 0) return 'right';
    if (normalized === 90) return 'up';
    if (normalized === 180) return 'left';
    if (normalized === 270) return 'down';
    return 'right';
}



    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Offset a graphic element
     */
export function _offsetGraphic(fetcher, g, dx, dy) {
    switch (g.type) {
        case 'rect':
            g.x += dx;
            g.y += dy;
            break;
        case 'circle':
        case 'arc':
            g.cx += dx;
            g.cy += dy;
            break;
        case 'polyline':
        case 'polygon':
            g.points = g.points.map(p => [p[0] + dx, p[1] + dy]);
            break;
        case 'line':
            g.x1 += dx;
            g.y1 += dy;
            g.x2 += dx;
            g.y2 += dy;
            break;
        case 'text':
            g.x += dx;
            g.y += dy;
            break;
    }
}

