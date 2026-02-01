const MEASURE_CANVAS = document.createElement('canvas');
const MEASURE_CTX = MEASURE_CANVAS.getContext('2d');

export function startTextEdit(app, shape, options = {}) {
    if (!shape || shape.type !== 'text') return;
    if (shape.locked) return;

    cleanupLegacyOverlays(app);

    if (app.textEdit && app.textEdit.shape === shape) {
        updateTextEditOverlay(app);
        if (options.focus !== false) {
            focusEditor(app.textEdit);
        }
        return;
    }

    if (app.textEdit) {
        endTextEdit(app, true);
    }

    app.textEdit = {
        shape,
        originalText: typeof shape.text === 'string' ? shape.text : '',
        editor: null,
        caretIndex: null
    };

    ensureEditor(app, app.textEdit);
    updateTextEditOverlay(app);
    if (options.focus !== false) {
        focusEditor(app.textEdit);
    }
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

    if (state.editor && state.editor.parentNode) {
        state.editor.parentNode.removeChild(state.editor);
    }

    cleanupLegacyOverlays(app);

    app.textEdit = null;
}

export function handleTextEditKey(app, e) {
    const state = app.textEdit;
    if (!state || !state.editor) return false;

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

    return false;
}

export function updateTextEditOverlay(app) {
    const state = app.textEdit;
    if (!state || !state.shape || !state.editor) return;
    if (state.shape.locked) {
        endTextEdit(app, true);
        return;
    }

    const shape = state.shape;
    const editor = state.editor;
    const scale = app.viewport?.scale || 1;
    const fontSizePx = Math.max((shape.fontSize || 2.5) * scale, 6);

    const containerRect = app.container.getBoundingClientRect();
    const elementRect = shape.element?.getBoundingClientRect?.();
    const pos = app.viewport.worldToScreen({ x: shape.x, y: shape.y });
    const textValue = typeof shape.text === 'string' ? shape.text : '';
    const fontFamily = shape.fontFamily || 'Arial';

    if (editor.value !== textValue) {
        editor.value = textValue;
    }
    editor.style.fontSize = `${fontSizePx}px`;
    editor.style.fontFamily = fontFamily;
    editor.style.color = shape.fill ? (shape.fillColor || shape.color) : (shape.color || '#cccccc');

    const approxWidth = Math.max(measureTextWidth(textValue || 'M', fontSizePx, fontFamily), fontSizePx * 0.6);
    const widthPx = Math.max(approxWidth + 4, 12);
    const heightPx = Math.max(fontSizePx * 1.2, 10);

    const hasElementRect = elementRect
        && Number.isFinite(elementRect.left)
        && Number.isFinite(elementRect.top)
        && Number.isFinite(elementRect.width)
        && Number.isFinite(elementRect.height);

    if (hasElementRect) {
        const rectWidth = Number.isFinite(elementRect.width) && elementRect.width > 0 ? elementRect.width : widthPx;
        const rectHeight = Number.isFinite(elementRect.height) && elementRect.height > 0 ? elementRect.height : heightPx;
        editor.style.left = `${elementRect.left - containerRect.left}px`;
        editor.style.top = `${elementRect.top - containerRect.top}px`;
        editor.style.width = `${rectWidth}px`;
        editor.style.height = `${rectHeight}px`;
        editor.style.transform = 'translate(0, 0)';
        editor.style.textAlign = 'left';
    } else {
        editor.style.left = `${pos.x}px`;
        editor.style.top = `${pos.y}px`;
        editor.style.width = `${widthPx}px`;
        editor.style.height = `${heightPx}px`;
        const anchor = shape.textAnchor || 'start';
        if (anchor === 'middle') {
            editor.style.transform = 'translate(-50%, 0)';
            editor.style.textAlign = 'center';
        } else if (anchor === 'end') {
            editor.style.transform = 'translate(-100%, 0)';
            editor.style.textAlign = 'right';
        } else {
            editor.style.transform = 'translate(0, 0)';
            editor.style.textAlign = 'left';
        }
    }
}

export function nudgeTextEditOverlay(app, dx, dy) {
    const state = app.textEdit;
    if (!state || !state.editor) return;
    const editor = state.editor;
    const left = parseFloat(editor.style.left || '0');
    const top = parseFloat(editor.style.top || '0');
    editor.style.left = `${left + dx}px`;
    editor.style.top = `${top + dy}px`;
}

export function setTextCaretFromScreen(app, screenPos) {
    const state = app.textEdit;
    if (!state || !state.editor || !state.shape) return;

    const rect = app.viewport.svg.getBoundingClientRect();
    const clientX = screenPos.x + rect.left;
    const clientY = screenPos.y + rect.top;

    const editorRect = state.editor.getBoundingClientRect();
    const localX = clientX - editorRect.left;
    const text = state.editor.value || '';

    const fontSizePx = parseFloat(state.editor.style.fontSize || '12');
    const fontFamily = state.editor.style.fontFamily || 'Arial';

    const caretIndex = getCaretIndexFromX(text, localX, fontSizePx, fontFamily);
    state.editor.focus();
    state.editor.setSelectionRange(caretIndex, caretIndex);
    state.caretIndex = caretIndex;
}

function ensureEditor(app, state) {
    if (!state || state.editor) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-edit-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.value = state.originalText || '';

    input.addEventListener('input', () => {
        updateText(app, input.value);
        updateTextEditOverlay(app);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            endTextEdit(app, false);
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === 'Enter') {
            endTextEdit(app, true);
            e.preventDefault();
            e.stopPropagation();
        }
    });

    input.addEventListener('blur', () => {
        if (app.textEdit && app.textEdit.editor === input) {
            endTextEdit(app, true);
        }
    });

    app.container.appendChild(input);
    state.editor = input;
}

function focusEditor(state) {
    if (!state?.editor) return;
    const editor = state.editor;
    editor.focus();
    const len = editor.value.length;
    editor.setSelectionRange(len, len);
}

function updateText(app, nextText) {
    const state = app.textEdit;
    if (!state) return;
    state.shape.text = nextText;
    if (typeof state.shape.invalidate === 'function') {
        state.shape.invalidate();
    }
    app.fileManager.setDirty(true);
    app.renderShapes(true);
}

function measureTextWidth(text, fontSizePx, fontFamily) {
    if (!MEASURE_CTX) return text.length * fontSizePx * 0.6;
    MEASURE_CTX.font = `${fontSizePx}px ${fontFamily}`;
    return MEASURE_CTX.measureText(text).width;
}

function getCaretIndexFromX(text, x, fontSizePx, fontFamily) {
    if (!text) return 0;
    MEASURE_CTX.font = `${fontSizePx}px ${fontFamily}`;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const width = MEASURE_CTX.measureText(text.slice(0, mid)).width;
        if (width < x) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return Math.max(0, Math.min(text.length, low));
}

function cleanupLegacyOverlays(app) {
    const svg = app?.viewport?.svg;
    if (!svg) return;
    const overlays = svg.querySelectorAll('.text-edit-overlay');
    overlays.forEach((node) => node.parentNode?.removeChild(node));
}

/*

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

    if (state.editor && state.editor.parentNode) {
        state.editor.parentNode.removeChild(state.editor);
    }

    app.textEdit = null;
}

export function handleTextEditKey(app, e) {
    const state = app.textEdit;
    if (!state || !state.editor) return false;

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

    return false;
}

export function updateTextEditOverlay(app) {
    const state = app.textEdit;
    if (!state || !state.shape || !state.editor) return;
    if (state.shape.locked) {
        endTextEdit(app, true);
        return;
    }

    const shape = state.shape;
    const editor = state.editor;
    const scale = app.viewport?.scale || 1;
    const fontSizePx = Math.max((shape.fontSize || 2.5) * scale, 6);

    const pos = app.viewport.worldToScreen({ x: shape.x, y: shape.y });
    const textValue = typeof shape.text === 'string' ? shape.text : '';
    const fontFamily = shape.fontFamily || 'Arial';

    if (editor.value !== textValue) {
        editor.value = textValue;
    }
    editor.style.fontSize = `${fontSizePx}px`;
    editor.style.fontFamily = fontFamily;
    editor.style.color = shape.fill ? (shape.fillColor || shape.color) : (shape.color || '#cccccc');

    const approxWidth = Math.max(measureTextWidth(textValue || 'M', fontSizePx, fontFamily), fontSizePx * 0.6);
    const widthPx = Math.max(approxWidth + 4, 12);
    editor.style.width = `${widthPx}px`;
    editor.style.height = `${Math.max(fontSizePx * 1.2, 10)}px`;

    editor.style.left = `${pos.x}px`;
    editor.style.top = `${pos.y}px`;

    const anchor = shape.textAnchor || 'start';
    if (anchor === 'middle') {
        editor.style.transform = 'translate(-50%, 0)';
        editor.style.textAlign = 'center';
    } else if (anchor === 'end') {
        editor.style.transform = 'translate(-100%, 0)';
        editor.style.textAlign = 'right';
    } else {
        editor.style.transform = 'translate(0, 0)';
        editor.style.textAlign = 'left';
    }
}

export function nudgeTextEditOverlay(app, dx, dy) {
    const state = app.textEdit;
    if (!state || !state.editor) return;
    const editor = state.editor;
    const left = parseFloat(editor.style.left || '0');
    const top = parseFloat(editor.style.top || '0');
    editor.style.left = `${left + dx}px`;
    editor.style.top = `${top + dy}px`;
}

export function setTextCaretFromScreen(app, screenPos) {
    const state = app.textEdit;
    if (!state || !state.editor || !state.shape) return;

    const rect = app.viewport.svg.getBoundingClientRect();
    const clientX = screenPos.x + rect.left;
    const clientY = screenPos.y + rect.top;

    const editorRect = state.editor.getBoundingClientRect();
    const localX = clientX - editorRect.left;
    const text = state.editor.value || '';

    const fontSizePx = parseFloat(state.editor.style.fontSize || '12');
    const fontFamily = state.editor.style.fontFamily || 'Arial';

    const caretIndex = getCaretIndexFromX(text, localX, fontSizePx, fontFamily);
    state.editor.focus();
    state.editor.setSelectionRange(caretIndex, caretIndex);
    state.caretIndex = caretIndex;
}

function ensureEditor(app, state) {
    if (!state || state.editor) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-edit-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.value = state.originalText || '';

    input.addEventListener('input', () => {
        updateText(app, input.value);
        updateTextEditOverlay(app);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            endTextEdit(app, false);
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === 'Enter') {
            endTextEdit(app, true);
            e.preventDefault();
            e.stopPropagation();
        }
    });

    input.addEventListener('blur', () => {
        if (app.textEdit && app.textEdit.editor === input) {
            endTextEdit(app, true);
        }
    });

    app.container.appendChild(input);
    state.editor = input;
}

function focusEditor(state) {
    if (!state?.editor) return;
    const editor = state.editor;
    editor.focus();
    const len = editor.value.length;
    editor.setSelectionRange(len, len);
}

function updateText(app, nextText) {
    const state = app.textEdit;
    if (!state) return;
    state.shape.text = nextText;
    if (typeof state.shape.invalidate === 'function') {
        state.shape.invalidate();
    }
    app.fileManager.setDirty(true);
    app.renderShapes(true);
}

function measureTextWidth(text, fontSizePx, fontFamily) {
    if (!MEASURE_CTX) return text.length * fontSizePx * 0.6;
    MEASURE_CTX.font = `${fontSizePx}px ${fontFamily}`;
    return MEASURE_CTX.measureText(text).width;
}

function getCaretIndexFromX(text, x, fontSizePx, fontFamily) {
    if (!text) return 0;
    MEASURE_CTX.font = `${fontSizePx}px ${fontFamily}`;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const width = MEASURE_CTX.measureText(text.slice(0, mid)).width;
        if (width < x) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return Math.max(0, Math.min(text.length, low));
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

    if (state.editor && state.editor.parentNode) {
        state.editor.parentNode.removeChild(state.editor);
    }

    app.textEdit = null;
}

export function handleTextEditKey(app, e) {
    const state = app.textEdit;
    if (!state || !state.editor) return false;

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

    return false;
}

export function updateTextEditOverlay(app) {
    const state = app.textEdit;
    if (!state || !state.shape || !state.editor) return;
    if (state.shape.locked) {
        endTextEdit(app, true);
        return;
    }

    const shape = state.shape;
    const editor = state.editor;
    const scale = app.viewport?.scale || 1;
    const fontSizePx = Math.max((shape.fontSize || 2.5) * scale, 6);

    const pos = app.viewport.worldToScreen({ x: shape.x, y: shape.y });
    const textValue = typeof shape.text === 'string' ? shape.text : '';
    const fontFamily = shape.fontFamily || 'Arial';

    if (editor.value !== textValue) {
        editor.value = textValue;
    }
    editor.style.fontSize = `${fontSizePx}px`;
    editor.style.fontFamily = fontFamily;
    editor.style.color = shape.fill ? (shape.fillColor || shape.color) : (shape.color || '#cccccc');

    const approxWidth = Math.max(measureTextWidth(textValue || 'M', fontSizePx, fontFamily), fontSizePx * 0.6);
    const widthPx = Math.max(approxWidth + 4, 12);
    editor.style.width = `${widthPx}px`;
    editor.style.height = `${Math.max(fontSizePx * 1.2, 10)}px`;

    editor.style.left = `${pos.x}px`;
    editor.style.top = `${pos.y}px`;

    const anchor = shape.textAnchor || 'start';
    if (anchor === 'middle') {
        editor.style.transform = 'translate(-50%, 0)';
        editor.style.textAlign = 'center';
    } else if (anchor === 'end') {
        editor.style.transform = 'translate(-100%, 0)';
        editor.style.textAlign = 'right';
    } else {
        editor.style.transform = 'translate(0, 0)';
        editor.style.textAlign = 'left';
    }
}

export function nudgeTextEditOverlay(app, dx, dy) {
    const state = app.textEdit;
    if (!state || !state.editor) return;
    const editor = state.editor;
    const left = parseFloat(editor.style.left || '0');
    const top = parseFloat(editor.style.top || '0');
    editor.style.left = `${left + dx}px`;
    editor.style.top = `${top + dy}px`;
}

export function setTextCaretFromScreen(app, screenPos) {
    const state = app.textEdit;
    if (!state || !state.editor || !state.shape) return;

    const rect = app.viewport.svg.getBoundingClientRect();
    const clientX = screenPos.x + rect.left;
    const clientY = screenPos.y + rect.top;

    const editorRect = state.editor.getBoundingClientRect();
    const localX = clientX - editorRect.left;
    const text = state.editor.value || '';

    const fontSizePx = parseFloat(state.editor.style.fontSize || '12');
    const fontFamily = state.editor.style.fontFamily || 'Arial';

    const caretIndex = getCaretIndexFromX(text, localX, fontSizePx, fontFamily);
    state.editor.focus();
    state.editor.setSelectionRange(caretIndex, caretIndex);
    state.caretIndex = caretIndex;
}

function ensureEditor(app, state) {
    if (!state || state.editor) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-edit-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.value = state.originalText || '';

    input.addEventListener('input', () => {
        updateText(app, input.value);
        updateTextEditOverlay(app);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            endTextEdit(app, false);
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === 'Enter') {
            endTextEdit(app, true);
            e.preventDefault();
            e.stopPropagation();
        }
    });

    input.addEventListener('blur', () => {
        if (app.textEdit && app.textEdit.editor === input) {
            endTextEdit(app, true);
        }
    });

    app.container.appendChild(input);
    state.editor = input;
}

function focusEditor(state) {
    if (!state?.editor) return;
    const editor = state.editor;
    editor.focus();
    const len = editor.value.length;
    editor.setSelectionRange(len, len);
}

function updateText(app, nextText) {
    const state = app.textEdit;
    if (!state) return;
    state.shape.text = nextText;
    if (typeof state.shape.invalidate === 'function') {
        state.shape.invalidate();
    }
    app.fileManager.setDirty(true);
    app.renderShapes(true);
}

function measureTextWidth(text, fontSizePx, fontFamily) {
    if (!MEASURE_CTX) return text.length * fontSizePx * 0.6;
    MEASURE_CTX.font = `${fontSizePx}px ${fontFamily}`;
    return MEASURE_CTX.measureText(text).width;
}

function getCaretIndexFromX(text, x, fontSizePx, fontFamily) {
    if (!text) return 0;
    MEASURE_CTX.font = `${fontSizePx}px ${fontFamily}`;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const width = MEASURE_CTX.measureText(text.slice(0, mid)).width;
        if (width < x) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return Math.max(0, Math.min(text.length, low));
}

function ensureOverlay(app) {
    const state = app.textEdit;
    if (!state || state.overlayGroup) return;

    const g = app.viewport.createGroup();
    g.setAttribute('class', 'text-edit-overlay');
    g.setAttribute('pointer-events', 'none');

    const box = document.createElementNS(SVG_NS, 'rect');
    box.setAttribute('fill', 'none');
    box.setAttribute('stroke', 'var(--sch-accent, #00ccff)');
    box.setAttribute('stroke-width', '0.15');
    box.setAttribute('stroke-opacity', '0.4');

    const caret = document.createElementNS(SVG_NS, 'line');
    caret.setAttribute('stroke', 'var(--sch-accent, #00ccff)');
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
*/
