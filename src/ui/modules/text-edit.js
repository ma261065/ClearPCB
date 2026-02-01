const SVG_NS = 'http://www.w3.org/2000/svg';

export function startTextEdit(app, shape) {
    if (!shape || shape.type !== 'text') return;
    if (shape.locked) return;

    if (app.textEdit && app.textEdit.shape === shape) {
        updateTextEditOverlay(app);
        return;
    }

    if (app.textEdit) {
        endTextEdit(app, true);
    }

    app.textEdit = {
        shape,
        originalText: typeof shape.text === 'string' ? shape.text : '',
        caretIndex: typeof shape.text === 'string' ? shape.text.length : 0,
        overlayGroup: null,
        overlayBox: null,
        overlayCaret: null,
        overlayBlink: null,
        blinkTimeoutId: null,
        overlayOffset: null
    };

    ensureOverlay(app);
    updateTextEditOverlay(app);
}

export function endTextEdit(app, commit = true) {
    const state = app.textEdit;
    if (!state) return;

    if (!commit) {
        state.shape.text = state.originalText;
        if (typeof state.shape.invalidate === 'function') {
            state.shape.invalidate();
        }
        app.renderShapes(true);
    }

    if (state.overlayGroup && state.overlayGroup.parentNode) {
        state.overlayGroup.parentNode.removeChild(state.overlayGroup);
    }
    state.overlayGroup = null;
    state.overlayBox = null;
    state.overlayCaret = null;
    state.overlayBlink = null;
    if (state.blinkTimeoutId) {
        clearTimeout(state.blinkTimeoutId);
        state.blinkTimeoutId = null;
    }

    app.textEdit = null;
}

export function handleTextEditKey(app, e) {
    const state = app.textEdit;
    if (!state) return false;

    const shape = state.shape;
    const text = typeof shape.text === 'string' ? shape.text : '';
    const caret = state.caretIndex ?? text.length;

    if (e.key === 'Escape') {
        endTextEdit(app, false);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    if (e.key === 'Enter') {
        endTextEdit(app, true);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    if (e.key === 'ArrowLeft') {
        state.caretIndex = Math.max(0, caret - 1);
        updateTextEditOverlay(app);
        resetCaretBlink(state);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    if (e.key === 'ArrowRight') {
        state.caretIndex = Math.min(text.length, caret + 1);
        updateTextEditOverlay(app);
        resetCaretBlink(state);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    if (e.key === 'Home') {
        state.caretIndex = 0;
        updateTextEditOverlay(app);
        resetCaretBlink(state);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    if (e.key === 'End') {
        state.caretIndex = text.length;
        updateTextEditOverlay(app);
        resetCaretBlink(state);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    if (e.key === 'Backspace') {
        if (caret > 0) {
            const nextText = text.slice(0, caret - 1) + text.slice(caret);
            updateText(app, nextText, caret - 1);
        }
        resetCaretBlink(state);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    if (e.key === 'Delete') {
        if (caret < text.length) {
            const nextText = text.slice(0, caret) + text.slice(caret + 1);
            updateText(app, nextText, caret);
        }
        resetCaretBlink(state);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const nextText = text.slice(0, caret) + e.key + text.slice(caret);
        updateText(app, nextText, caret + 1);
        resetCaretBlink(state);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    return true;
}

export function updateTextEditOverlay(app) {
    const state = app.textEdit;
    if (!state || !state.shape || !state.overlayGroup) return;
    if (state.shape.locked) {
        endTextEdit(app, true);
        return;
    }

    const shape = state.shape;
    const el = shape.element;
    if (!el) {
        state.overlayGroup.style.display = 'none';
        return;
    }

    const originX = Number.isFinite(shape.x) ? shape.x : 0;
    const originY = Number.isFinite(shape.y) ? shape.y : 0;
    state.overlayGroup.setAttribute('transform', `translate(${originX} ${originY})`);

    let bbox;
    try {
        bbox = el.getBBox();
    } catch (e) {
        bbox = null;
    }

    const textValue = typeof shape.text === 'string' ? shape.text : '';
    if (textValue.length === 0) {
        const measured = measurePlaceholderBBox(app, el);
        if (measured) {
            bbox = measured;
        } else if (bbox) {
            bbox = null;
        }
    }
    if (bbox && bbox.width === 0 && bbox.height === 0) {
        bbox = null;
    }

    const pad = 0.4;
    const minHeight = Math.max(shape.fontSize || 2.5, 1);
    const minWidth = Math.max((shape.fontSize || 2.5) * 0.6, 1);

    const baseX = (bbox ? bbox.x : originX) - originX;
    const baseY = (bbox ? bbox.y : originY) - originY;
    const width = Math.max(bbox ? bbox.width : 0, minWidth);
    const height = Math.max(bbox ? bbox.height : 0, minHeight);

    const caretXAbs = getCaretX(app, shape, el, { x: baseX + originX, width }, state.caretIndex ?? 0);
    const caretX = caretXAbs - originX;
    const caretInset = 0.25;
    const caretTop = baseY - pad + caretInset;
    const caretBottom = baseY + height + pad - caretInset;

    const numericValues = [baseX, baseY, width, height, caretX, caretTop, caretBottom];
    if (numericValues.some((value) => !Number.isFinite(value))) {
        state.overlayGroup.style.display = 'none';
        return;
    }

    state.overlayGroup.style.display = '';
    state.overlayBox.setAttribute('x', baseX - pad);
    state.overlayBox.setAttribute('y', baseY - pad);
    state.overlayBox.setAttribute('width', width + pad * 2);
    state.overlayBox.setAttribute('height', height + pad * 2);

    state.overlayCaret.setAttribute('x1', caretX);
    state.overlayCaret.setAttribute('x2', caretX);
    state.overlayCaret.setAttribute('y1', caretTop);
    state.overlayCaret.setAttribute('y2', caretBottom);
}

export function nudgeTextEditOverlay(app, dx, dy) {
    const state = app.textEdit;
    if (!state || !state.overlayGroup) return;

    const nextX = (state.overlayOffset?.x || 0) + dx;
    const nextY = (state.overlayOffset?.y || 0) + dy;
    state.overlayOffset = { x: nextX, y: nextY };
    state.overlayGroup.setAttribute('transform', `translate(${nextX} ${nextY})`);
}

export function setTextCaretFromScreen(app, screenPos) {
    const state = app.textEdit;
    if (!state || !state.shape || !state.shape.element) return;

    const el = state.shape.element;
    if (typeof el.getCharNumAtPosition !== 'function') {
        state.caretIndex = (state.shape.text || '').length;
        updateTextEditOverlay(app);
        return;
    }

    try {
        const rect = app.viewport.svg.getBoundingClientRect();
        const pt = app.viewport.svg.createSVGPoint();
        pt.x = screenPos.x + rect.left;
        pt.y = screenPos.y + rect.top;
        const ctm = el.getScreenCTM();
        const localPt = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
        const idx = el.getCharNumAtPosition(localPt);
        if (idx >= 0) {
            state.caretIndex = idx;
        } else {
            state.caretIndex = (state.shape.text || '').length;
        }
        updateTextEditOverlay(app);
        resetCaretBlink(state);
    } catch (e) {
        state.caretIndex = (state.shape.text || '').length;
        updateTextEditOverlay(app);
        resetCaretBlink(state);
    }
}

function ensureOverlay(app) {
    const state = app.textEdit;
    if (!state || state.overlayGroup) return;

    const g = app.viewport.createGroup();
    g.setAttribute('class', 'text-edit-overlay');
    g.setAttribute('pointer-events', 'none');

    const box = document.createElementNS(SVG_NS, 'rect');
    box.setAttribute('fill', 'none');
    box.setAttribute('stroke', 'var(--accent-color, #00ccff)');
    box.setAttribute('stroke-width', '0.15');
    box.setAttribute('stroke-opacity', '0.4');

    const caret = document.createElementNS(SVG_NS, 'line');
    caret.setAttribute('stroke', 'var(--accent-color, #00ccff)');
    caret.setAttribute('stroke-width', '0.2');

    const blink = document.createElementNS(SVG_NS, 'animate');
    blink.setAttribute('attributeName', 'opacity');
    blink.setAttribute('values', '1;1;0;0;1');
    blink.setAttribute('keyTimes', '0;0.49;0.5;0.99;1');
    blink.setAttribute('dur', '1s');
    blink.setAttribute('repeatCount', 'indefinite');
    caret.appendChild(blink);

    g.appendChild(box);
    g.appendChild(caret);

    app.viewport.addContent(g);

    state.overlayGroup = g;
    state.overlayBox = box;
    state.overlayCaret = caret;
    state.overlayBlink = blink;
}

function resetCaretBlink(state, delay = 300) {
    if (!state || !state.overlayCaret) return;

    if (state.overlayBlink && state.overlayBlink.parentNode === state.overlayCaret) {
        state.overlayCaret.removeChild(state.overlayBlink);
    }

    state.overlayCaret.style.opacity = '1';

    if (state.blinkTimeoutId) {
        clearTimeout(state.blinkTimeoutId);
        state.blinkTimeoutId = null;
    }

    state.blinkTimeoutId = setTimeout(() => {
        if (state.overlayCaret && state.overlayBlink && !state.overlayBlink.parentNode) {
            state.overlayCaret.appendChild(state.overlayBlink);
        }
        state.blinkTimeoutId = null;
    }, delay);
}

function updateText(app, nextText, caretIndex) {
    const state = app.textEdit;
    if (!state) return;

    state.shape.text = nextText;
    if (typeof state.shape.invalidate === 'function') {
        state.shape.invalidate();
    }
    state.caretIndex = caretIndex;
    app.fileManager.setDirty(true);
    app.renderShapes(true);
    updateTextEditOverlay(app);
}

function measurePlaceholderBBox(app, el) {
    if (!app?.viewport || !el) return null;

    try {
        const temp = el.cloneNode(true);
        temp.textContent = 'M';
        temp.setAttribute('visibility', 'hidden');
        temp.setAttribute('pointer-events', 'none');
        app.viewport.addContent(temp);
        const bbox = temp.getBBox();
        if (temp.parentNode) {
            temp.parentNode.removeChild(temp);
        }
        return bbox;
    } catch (e) {
        return null;
    }
}

function getCaretX(app, shape, el, bbox, caretIndex) {
    if (!el || caretIndex <= 0) {
        return Number.isFinite(shape.x) ? shape.x : bbox.x;
    }

    try {
        const textValue = typeof shape.text === 'string' ? shape.text : '';
        if (textValue.includes(' ') && app?.viewport) {
            const measured = measureCaretWithClone(app, el, textValue, caretIndex);
            if (Number.isFinite(measured)) {
                return measured;
            }
        }
        if (typeof el.getSubStringLength === 'function' && typeof el.getStartPositionOfChar === 'function') {
            const start = el.getStartPositionOfChar(0);
            const length = el.getSubStringLength(0, caretIndex);
            if (start && Number.isFinite(start.x) && Number.isFinite(length)) {
                return start.x + length;
            }
        }
    } catch (e) {
        // fall through
    }

    const textLength = (shape.text || '').length || 1;
    return bbox.x + (bbox.width * (caretIndex / textLength));
}

function measureCaretWithClone(app, el, textValue, caretIndex) {
    try {
        const temp = el.cloneNode(true);
        temp.textContent = textValue;
        temp.setAttribute('xml:space', 'preserve');
        temp.style.whiteSpace = 'pre';
        temp.setAttribute('visibility', 'hidden');
        temp.setAttribute('pointer-events', 'none');
        app.viewport.addContent(temp);
        if (typeof temp.getSubStringLength === 'function' && typeof temp.getStartPositionOfChar === 'function') {
            const clampedIndex = Math.max(0, Math.min(caretIndex, textValue.length));
            const start = temp.getStartPositionOfChar(0);
            const length = temp.getSubStringLength(0, clampedIndex);
            if (temp.parentNode) {
                temp.parentNode.removeChild(temp);
            }
            if (start && Number.isFinite(start.x) && Number.isFinite(length)) {
                return start.x + length;
            }
        }
        if (temp.parentNode) {
            temp.parentNode.removeChild(temp);
        }
    } catch (e) {
        return null;
    }
    return null;
}
