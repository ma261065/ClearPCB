export const TEXT_EDIT_BOX_PADDING_RATIO = 0.15;

export function getTextEditBoxPadding(shape, measuredHeight = 0) {
    const basis = measuredHeight > 0
        ? measuredHeight
        : Math.max(Number(shape?.fontSize) || 0, 1);
    return basis * TEXT_EDIT_BOX_PADDING_RATIO;
}

let textMeasureContext = null;

export function measureTextGlyphBBox(shape, el) {
    const text = typeof shape?.text === 'string' ? shape.text : '';
    if (text && typeof document?.createElement === 'function') {
        try {
            if (!textMeasureContext) {
                textMeasureContext = document.createElement('canvas').getContext('2d');
            }
            if (textMeasureContext) {
                const fontSize = Math.max(Number(shape.fontSize) || 0, 1);
                const measurementSize = 1000;
                const scale = fontSize / measurementSize;
                textMeasureContext.font = `${measurementSize}px ${shape.fontFamily || 'Arial'}`;
                textMeasureContext.textBaseline = 'alphabetic';
                textMeasureContext.textAlign = shape.textAnchor === 'middle'
                    ? 'center'
                    : shape.textAnchor === 'end' ? 'right' : 'left';
                const metrics = textMeasureContext.measureText(text);
                const left = metrics.actualBoundingBoxLeft * scale;
                const right = metrics.actualBoundingBoxRight * scale;
                const ascent = metrics.actualBoundingBoxAscent * scale;
                const descent = metrics.actualBoundingBoxDescent * scale;
                const x = parseFloat(el?.getAttribute?.('x') || String(shape.x || 0));
                const y = parseFloat(el?.getAttribute?.('y') || String(shape.y || 0));
                if ([left, right, ascent, descent, x, y].every(Number.isFinite)
                    && left + right > 0 && ascent + descent > 0) {
                    return {
                        x: x - left,
                        y: y - ascent,
                        width: left + right,
                        height: ascent + descent,
                    };
                }
            }
        } catch {
            textMeasureContext = null;
        }
    }

    try {
        return el?.getBBox?.() || null;
    } catch {
        return null;
    }
}

export function normalizeTextBBox(shape, el, bbox, usesNestedTextCoords) {
    if (!bbox) return null;

    if (Number.isFinite(bbox.y) && Number.isFinite(bbox.height) && bbox.height > 0) {
        return {
            x: bbox.x,
            y: bbox.y,
            width: bbox.width,
            height: bbox.height,
        };
    }

    const fontSize = Math.max(Number(shape?.fontSize) || 0, 1);
    const ascent = fontSize * 0.78;
    const descent = fontSize * 0.18;
    const yAttr = parseFloat(el?.getAttribute?.('y') || '0');
    const baselineY = Number.isFinite(yAttr)
        ? yAttr
        : (Number.isFinite(bbox.y) ? bbox.y + ascent : (usesNestedTextCoords ? 0 : Number(shape?.y) || 0));

    return {
        x: bbox.x,
        y: baselineY - ascent,
        width: bbox.width,
        height: ascent + descent,
    };
}

export function getTextEditBoxWorldCorners(shape) {
    const textEl = shape?.getTextElement?.();
    const el = textEl || shape?.element;
    if (!shape || !el) return null;

    const bbox = measureTextGlyphBBox(shape, el);
    if (!bbox || (bbox.width === 0 && bbox.height === 0)) return null;

    const usesNestedTextCoords = !!textEl && textEl !== shape.element;
    const normalized = normalizeTextBBox(shape, el, bbox, usesNestedTextCoords) || bbox;
    const origin = shape.getTextEditOrigin?.() || { x: shape.x, y: shape.y };
    const originX = Number.isFinite(origin.x) ? origin.x : 0;
    const originY = Number.isFinite(origin.y) ? origin.y : 0;
    const baseX = usesNestedTextCoords ? normalized.x : normalized.x - originX;
    const baseY = usesNestedTextCoords ? normalized.y : normalized.y - originY;
    const hasText = typeof shape.text === 'string' && shape.text.length > 0;
    const width = hasText
        ? normalized.width
        : Math.max(normalized.width, Math.max((shape.fontSize || 2.5) * 0.6, 1));
    const height = normalized.height > 0
        ? normalized.height
        : Math.max(shape.fontSize || 2.5, 1);
    const angle = (shape.rotation || 0) * Math.PI / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    const padding = getTextEditBoxPadding(shape, height);
    return [
        [baseX - padding, baseY - padding],
        [baseX + width + padding, baseY - padding],
        [baseX + width + padding, baseY + height + padding],
        [baseX - padding, baseY + height + padding],
    ].map(([x, y]) => ({
        x: originX + x * cosine - y * sine,
        y: originY + x * sine + y * cosine,
    }));
}
