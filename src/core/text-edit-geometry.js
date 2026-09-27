export const TEXT_EDIT_BOX_PADDING_RATIO = 0.4;

export function getTextEditBoxPadding(shape, measuredHeight = 0) {
    const basis = measuredHeight > 0
        ? measuredHeight
        : Math.max(Number(shape?.fontSize) || 0, 1);
    return basis * TEXT_EDIT_BOX_PADDING_RATIO;
}

let textMeasureContext = null;

function canvasTextMetrics(shape, text) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    try {
        if (!textMeasureContext) {
            textMeasureContext = document.createElement('canvas').getContext('2d');
        }
        if (!textMeasureContext) return null;
        const fontSize = Math.max(Number(shape?.fontSize) || 0, 1);
        const measurementSize = 1000;
        textMeasureContext.font = `${measurementSize}px ${shape?.fontFamily || 'Arial'}`;
        textMeasureContext.textBaseline = 'alphabetic';
        const horizontal = textMeasureContext.measureText(text);
        const vertical = textMeasureContext.measureText('Mg');
        const width = Number(horizontal.width) * fontSize / measurementSize;
        const ascent = Number(vertical.actualBoundingBoxAscent) * fontSize / measurementSize;
        const descent = Number(vertical.actualBoundingBoxDescent) * fontSize / measurementSize;
        if (![width, ascent, descent].every(Number.isFinite) || ascent + descent <= 0) return null;
        return { width, ascent, descent };
    } catch {
        textMeasureContext = null;
        return null;
    }
}

export function measureTextAdvance(shape, text) {
    return canvasTextMetrics(shape, text)?.width ?? null;
}

export function measureTextGlyphBBox(shape, el) {
    const text = typeof shape?.text === 'string' ? shape.text : '';
    const metrics = canvasTextMetrics(shape, text);
    if (metrics) {
        const x = parseFloat(el?.getAttribute?.('x') || String(shape.x || 0));
        const y = parseFloat(el?.getAttribute?.('y') || String(shape.y || 0));
        if (Number.isFinite(x) && Number.isFinite(y)) {
            let left = x;
            if (shape.textAnchor === 'middle') left -= metrics.width / 2;
            else if (shape.textAnchor === 'end') left -= metrics.width;
            return {
                x: left,
                y: y - metrics.ascent,
                width: metrics.width,
                height: metrics.ascent + metrics.descent,
            };
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

export function getTextEditBoxGeometry(shape, el, bbox = null, usesNestedTextCoords = false) {
    const measured = bbox || measureTextGlyphBBox(shape, el);
    const normalized = normalizeTextBBox(shape, el, measured, usesNestedTextCoords) || measured;
    if (!normalized) return null;

    const origin = shape.getTextEditOrigin?.() || { x: shape.x, y: shape.y };
    const originX = Number.isFinite(origin.x) ? origin.x : 0;
    const originY = Number.isFinite(origin.y) ? origin.y : 0;
    let localX = usesNestedTextCoords ? normalized.x : normalized.x - originX;
    const localY = usesNestedTextCoords ? normalized.y : normalized.y - originY;
    const hasText = typeof shape.text !== 'string' || shape.text.length > 0;
    const width = hasText
        ? normalized.width
        : Math.max(normalized.width, Math.max((shape.fontSize || 2.5) * 0.6, 1));
    if (!hasText) {
        if (shape.textAnchor === 'middle') localX -= width / 2;
        else if (shape.textAnchor === 'end') localX -= width;
    }
    const height = normalized.height > 0
        ? normalized.height
        : Math.max(shape.fontSize || 2.5, 1);
    const padding = getTextEditBoxPadding(shape, height);

    return {
        x: localX - padding,
        y: localY - padding,
        width: width + padding * 2,
        height: height + padding * 2,
        contentX: localX,
        contentY: localY,
        contentWidth: width,
        contentHeight: height,
        originX,
        originY,
    };
}

export function getTextEditBoxWorldCorners(shape) {
    const textEl = shape?.getTextElement?.();
    const el = textEl || shape?.element;
    if (!shape || !el) return null;

    const bbox = measureTextGlyphBBox(shape, el);
    if (!bbox || (bbox.width === 0 && bbox.height === 0)) return null;

    const usesNestedTextCoords = !!textEl && textEl !== shape.element;
    const box = getTextEditBoxGeometry(shape, el, bbox, usesNestedTextCoords);
    if (!box) return null;
    const angle = (shape.rotation || 0) * Math.PI / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    return [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x + box.width, box.y + box.height],
        [box.x, box.y + box.height],
    ].map(([x, y]) => ({
        x: box.originX + x * cosine - y * sine,
        y: box.originY + x * sine + y * cosine,
    }));
}
