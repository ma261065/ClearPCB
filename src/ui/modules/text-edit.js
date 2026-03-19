import { ModalManager } from '../../core/ModalManager.js';
import { ModifyShapeCommand } from '../../core/CommandHistory.js';
import { freeWireLabel, bumpWireLabelCounter, freeNetName, bumpNetNameCounter } from '../../shapes/wire.js';
import { validateNetNameAtPoint } from './net-validation.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Update wires connected to a Net label to use its current net name.
 */
function _propagateNetNameToWires(app, netShape) {
    for (const wire of app.shapes) {
        if (wire.type !== 'wire') continue;
        for (const [, conn] of wire.pinConnections) {
            if (conn.componentId === netShape.id) {
                if (wire.net !== netShape.net) {
                    freeNetName(wire.net);
                    wire.net = netShape.net;
                    bumpNetNameCounter(netShape.net);
                    wire.invalidate();
                }
                break;
            }
        }
    }
    app._updatePropertiesPanel?.(app.selection?.getSelection?.() || []);
}

/**
 * Begins inline text editing on a text shape: initializes caret, creates
 * the overlay (box + blinking caret), and pushes a ModalManager entry.
 * @param {object} app - Application state.
 * @param {import('../../shapes/text.js').Text} shape - Text shape to edit.
 */
export function startTextEdit(app, shape) {
    if (!shape || !shape.supportsInlineEdit) return;
    if (shape.locked) return;

    // Keep edited shape selected so render z-order logic does not move
    // overlay-type shapes above the text-edit overlay while typing.
    if (app.selection && !app.selection.isSelected(shape)) {
        app.selection.select(shape, false);
        app.renderShapes(true);
    }

    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA')) {
        activeEl.blur();
    }

    if (app.textEdit && app.textEdit.shape === shape) {
        updateTextEditOverlay(app);
        return;
    }

    if (app.textEdit) {
        endTextEdit(app, true);
    }

    const initialText = typeof shape.text === 'string' ? shape.text : '';
    const shapeWithCaret = /** @type {import('../../shapes/text.js').Text & {_lastCaretIndex?: number}} */ (shape);
    const storedCaret = Number.isFinite(shapeWithCaret._lastCaretIndex) ? shapeWithCaret._lastCaretIndex : null;
    const initialCaret = storedCaret === null
        ? initialText.length
        : Math.max(0, Math.min(initialText.length, storedCaret));

    app.textEdit = {
        shape,
        originalText: initialText,
        caretIndex: initialCaret,
        overlayGroup: null,
        overlayBox: null,
        overlayCaret: null,
        overlayBlink: null,
        blinkTimeoutId: null,
        overlayOffset: null
    };

    ensureOverlay(app);
    updateTextEditOverlay(app);

    ModalManager.push('text-edit', () => {
        app._suppressNextEscape = true;
        endTextEdit(app, false);
    });
}

/**
 * Ends text editing. If `commit` is true, creates an undo command for the
 * text change and syncs to the parent component; otherwise reverts.
 * Cleans up the overlay.
 * @param {object} app - Application state.
 * @param {boolean} [commit=true] - Whether to commit the edit.
 */
export function endTextEdit(app, commit = true) {
    const state = app.textEdit;
    if (!state) return;
    const shape = state.shape;

    // Defer pop so ModalManager can complete its current handling
    Promise.resolve().then(() => ModalManager.pop('text-edit'));

    if (state.shape) {
        const textLength = (state.shape.text || '').length;
        const caret = state.caretIndex ?? textLength;
        state.shape._lastCaretIndex = Math.max(0, Math.min(textLength, caret));
    }

    if (!commit) {
        state.shape.text = state.originalText;
        if (typeof state.shape.invalidate === 'function') {
            state.shape.invalidate();
        }
        app.renderShapes(true);
    } else if (state.shape.text !== state.originalText) {
        // Enforce unique references for component field texts
        if (state.shape.parentComponent && state.shape.fieldKey === 'reference' && state.shape.text) {
            const dup = app.components.find(c =>
                c.reference.toUpperCase() === state.shape.text.toUpperCase() &&
                c !== state.shape.parentComponent);
            if (dup) {
                    app._alert(`Reference "${state.shape.text}" is already used by another component.`, { title: 'Duplicate Reference' });
                state.shape.text = state.originalText;
                if (typeof state.shape.invalidate === 'function') state.shape.invalidate();
                app.renderShapes(true);
                // Skip command creation — fall through to cleanup
                _cleanupTextEditState(state, app, shape);
                return;
            }
        }

        // Enforce unique wire labels
        if (state.shape.parentComponent?.type === 'wire' && state.shape.fieldKey === 'wireLabel' && state.shape.text) {
            const parentWire = state.shape.parentComponent;
            const dup = app.shapes.find(s =>
                s.type === 'wire' && s !== parentWire &&
                s.wireLabel.toUpperCase() === state.shape.text.toUpperCase());
            if (dup) {
                    app._alert(`Wire name "${state.shape.text}" is already used by another wire.`, { title: 'Duplicate Wire Name' });
                state.shape.text = state.originalText;
                if (typeof state.shape.invalidate === 'function') state.shape.invalidate();
                app.renderShapes(true);
                _cleanupTextEditState(state, app, shape);
                return;
            }
        }

        if (state.shape.parentComponent?.type === 'net' && state.shape.fieldKey === 'net') {
            if (!state.shape.text || !state.shape.text.trim()) {
                app._alert('Net name cannot be empty.', { title: 'Invalid Net Name' });
                state.shape.text = state.originalText;
                if (typeof state.shape.invalidate === 'function') state.shape.invalidate();
                app.renderShapes(true);
                _cleanupTextEditState(state, app, shape);
                return;
            }
            const parentnet = state.shape.parentComponent;
            const check = validateNetNameAtPoint(
                app,
                { x: parentnet.x, y: parentnet.y },
                state.shape.text,
                parentnet.id
            );
            if (!check.ok) {
                    app._alert(`Net conflict: this connected wire is already labeled "${check.conflictWith || ''}".`, { title: 'Net Conflict' });
                state.shape.text = state.originalText;
                if (typeof state.shape.invalidate === 'function') state.shape.invalidate();
                app.renderShapes(true);
                _cleanupTextEditState(state, app, shape);
                return;
            }
        }

        // Create undo command for the text change
        const beforeState = { text: state.originalText };
        const afterState = { text: state.shape.text };
        // Temporarily revert so execute() applies the new text
        state.shape.text = state.originalText;
        const command = new ModifyShapeCommand(app, state.shape, beforeState, afterState);
        app.history.execute(command);

        // Sync field text back to component
        _syncFieldToComponent(state.shape);
    }

    // Refresh properties panel so it reflects the updated text
    const sel = app.selection.getSelection();
    if (sel.length > 0) app._updatePropertiesPanel(sel);

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

    if (shape && app.selection && !app.selection.isSelected(shape)) {
        app.selection.select(shape, false);
    }
}

/**
 * Handles all keystrokes during text editing: arrow keys, Home/End,
 * Backspace, Delete, printable characters, Enter (commit), Escape (cancel).
 * @param {object} app - Application state.
 * @param {KeyboardEvent} e - The keyboard event.
 * @returns {boolean} `true` if the key was consumed.
 */
export function handleTextEditKey(app, e) {
    const state = app.textEdit;
    if (!state) return false;

    const shape = state.shape;
    const text = typeof shape.text === 'string' ? shape.text : '';
    const caret = state.caretIndex ?? text.length;

    if (e.key === 'Escape') {
        app._suppressNextEscape = true;
        endTextEdit(app, false);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return true;
    }

    if (e.key === 'Enter') {
        endTextEdit(app, true);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return true;
    }

    if (e.key === 'ArrowLeft') {
        if (e.ctrlKey || e.metaKey) {
            state.caretIndex = findWordBoundaryLeft(text, caret);
        } else {
            state.caretIndex = Math.max(0, caret - 1);
        }
        updateTextEditOverlay(app);
        resetCaretBlink(state);
        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    if (e.key === 'ArrowRight') {
        if (e.ctrlKey || e.metaKey) {
            state.caretIndex = findWordBoundaryRight(text, caret);
        } else {
            state.caretIndex = Math.min(text.length, caret + 1);
        }
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

    // Consume all other keys (e.g. Ctrl+A) so they don't trigger
    // browser defaults or app shortcuts while editing text.
    e.preventDefault();
    e.stopPropagation();
    return true;
}

/**
 * Repositions and resizes the text-edit overlay box and caret based on
 * the text shape's current bounding box and caret index.
 * @param {object} app - Application state.
 */
export function updateTextEditOverlay(app) {
    const state = app.textEdit;
    if (!state || !state.shape || !state.overlayGroup) return;
    if (state.shape.locked) {
        endTextEdit(app, true);
        return;
    }

    const shape = state.shape;
    const textEl = shape.getTextElement?.();
    const el = textEl || shape.element;
    if (!el) {
        state.overlayGroup.style.display = 'none';
        return;
    }

    const usesNestedTextCoords = !!textEl && textEl !== shape.element;

    // For shapes with a text element inside a group (e.g. Net),
    // use the shape's textEditOrigin if available, otherwise shape.x/y.
    const editOrigin = shape.getTextEditOrigin?.() || { x: shape.x, y: shape.y };
    const originX = Number.isFinite(editOrigin.x) ? editOrigin.x : 0;
    const originY = Number.isFinite(editOrigin.y) ? editOrigin.y : 0;
    const nudgeX = state.overlayOffset?.x || 0;
    const nudgeY = state.overlayOffset?.y || 0;
    // Apply same rotation as the text shape so the edit overlay aligns
    const rot = shape.rotation || 0;
    let groupTransform = `translate(${originX + nudgeX} ${originY + nudgeY})`;
    if (rot) groupTransform += ` rotate(${rot})`;
    state.overlayGroup.setAttribute('transform', groupTransform);

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

    const normalized = normalizeTextBBox(shape, el, bbox, usesNestedTextCoords);
    bbox = normalized || bbox;

    const pad = 0.4;
    const minHeight = Math.max(shape.fontSize || 2.5, 1);
    const minWidth = Math.max((shape.fontSize || 2.5) * 0.6, 1);

    const baseX = usesNestedTextCoords
        ? (bbox ? bbox.x : 0)
        : ((bbox ? bbox.x : originX) - originX);
    const baseY = usesNestedTextCoords
        ? (bbox ? bbox.y : 0)
        : ((bbox ? bbox.y : originY) - originY);
    const width = Math.max(bbox ? bbox.width : 0, minWidth);
    const height = Math.max(bbox ? bbox.height : 0, minHeight);

    const caretProbe = usesNestedTextCoords
        ? { x: baseX, width }
        : { x: baseX + originX, width };
    const caretXAbs = getCaretX(app, shape, el, caretProbe, state.caretIndex ?? 0);
    const caretX = usesNestedTextCoords ? caretXAbs : (caretXAbs - originX);
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

function normalizeTextBBox(shape, el, bbox, usesNestedTextCoords) {
    if (!bbox) return null;

    const metrics = measureOverlayVerticalMetrics(shape);
    if (!metrics) return null;

    const yAttr = parseFloat(el?.getAttribute?.('y') || '0');
    const baselineY = Number.isFinite(yAttr)
        ? yAttr
        : (Number.isFinite(bbox.y) ? (bbox.y + metrics.ascent) : (usesNestedTextCoords ? 0 : Number(shape?.y) || 0));

    return {
        x: bbox.x,
        y: baselineY - metrics.ascent,
        width: bbox.width,
        height: metrics.height
    };
}

function measureOverlayVerticalMetrics(shape) {
    const fontSize = Math.max(Number(shape?.fontSize) || 0, 1);
    // Keep edit-box sizing behavior identical across wire/component/net labels.
    // Ratios are intentionally conservative: enough room for descenders
    // without the oversized lower gap from raw SVG bbox measurements.
    const ascent = fontSize * 0.78;
    const descent = fontSize * 0.18;
    return { ascent, descent, height: ascent + descent };
}

/**
 * Applies an incremental pixel offset to the text-edit overlay group
 * (used during drag to keep the overlay in sync).
 * @param {object} app - Application state.
 * @param {number} dx - Horizontal offset in world units.
 * @param {number} dy - Vertical offset in world units.
 */
export function nudgeTextEditOverlay(app, dx, dy) {
    const state = app.textEdit;
    if (!state || !state.overlayGroup) return;

    const nextX = (state.overlayOffset?.x || 0) + dx;
    const nextY = (state.overlayOffset?.y || 0) + dy;
    state.overlayOffset = { x: nextX, y: nextY };
    const editOrigin = state.shape?.getTextEditOrigin?.() || { x: state.shape?.x, y: state.shape?.y };
    const originX = Number.isFinite(editOrigin.x) ? editOrigin.x : 0;
    const originY = Number.isFinite(editOrigin.y) ? editOrigin.y : 0;
    const rot = state.shape?.rotation || 0;
    let t = `translate(${originX + nextX} ${originY + nextY})`;
    if (rot) t += ` rotate(${rot})`;
    state.overlayGroup.setAttribute('transform', t);
}

/**
 * Sets the text caret position from a screen-space click coordinate
 * using `getCharNumAtPosition`.
 * @param {object} app - Application state.
 * @param {{x: number, y: number}} screenPos - Screen-space click position.
 */
export function setTextCaretFromScreen(app, screenPos) {
    const state = app.textEdit;
    if (!state || !state.shape) return;

    const el = state.shape.getTextElement?.() || state.shape.element;
    if (!el || typeof el.getCharNumAtPosition !== 'function') {
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

function isWordChar(ch) {
    if (!ch) return false;
    return /[\p{L}\p{N}_]/u.test(ch);
}

function findWordBoundaryLeft(text, index) {
    let i = Math.max(0, Math.min(text.length, index));
    if (i === 0) return 0;
    while (i > 0 && !isWordChar(text[i - 1])) {
        i -= 1;
    }
    while (i > 0 && isWordChar(text[i - 1])) {
        i -= 1;
    }
    return i;
}

function findWordBoundaryRight(text, index) {
    let i = Math.max(0, Math.min(text.length, index));
    if (i >= text.length) return text.length;
    if (isWordChar(text[i])) {
        while (i < text.length && isWordChar(text[i])) {
            i += 1;
        }
    }
    while (i < text.length && !isWordChar(text[i])) {
        i += 1;
    }
    return i;
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
    caret.style.opacity = '1';

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
        // Use the original element's x/y for position so the cursor
        // stays at the text anchor when text is empty
        const origX = parseFloat(el.getAttribute('x')) || 0;
        return { x: origX, y: bbox.y, width: 0, height: bbox.height };
    } catch (e) {
        return null;
    }
}

function getCaretX(app, shape, el, bbox, caretIndex) {
    if (!el || caretIndex <= 0) {
        // Caret at position 0 — left edge of first character
        try {
            if (typeof el?.getStartPositionOfChar === 'function' && (shape.text || '').length > 0) {
                const start = el.getStartPositionOfChar(0);
                if (start && Number.isFinite(start.x)) return start.x;
            }
        } catch (e) { /* fall through */ }
        return Number.isFinite(bbox?.x) ? bbox.x : 0;
    }

    try {
        const textValue = typeof shape.text === 'string' ? shape.text : '';
        const clampedIndex = Math.min(caretIndex, textValue.length);

        // Use getEndPositionOfChar for the character just before the caret.
        // This works correctly for all text-anchor values (start/middle/end).
        if (typeof el.getEndPositionOfChar === 'function' && clampedIndex > 0) {
            const endPos = el.getEndPositionOfChar(clampedIndex - 1);
            if (endPos && Number.isFinite(endPos.x)) return endPos.x;
        }

        // Fallback: clone-based measurement for texts with spaces
        if (textValue.includes(' ') && app?.viewport) {
            const measured = measureCaretWithClone(app, el, textValue, clampedIndex);
            if (Number.isFinite(measured)) return measured;
        }

        // Fallback: start + substring length (only reliable for text-anchor="start")
        if (typeof el.getSubStringLength === 'function' && typeof el.getStartPositionOfChar === 'function') {
            const start = el.getStartPositionOfChar(0);
            const length = el.getSubStringLength(0, clampedIndex);
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

// ── field text helpers ───────────────────────────────────────────

/** Sync a field Text shape's content back to its parent component or wire. */
function _syncFieldToComponent(textShape) {
    if (!textShape.parentComponent || !textShape.fieldKey) return;
    if (textShape.fieldKey === 'label') {
        if (textShape.parentComponent.type === 'wire') {
            const wire = textShape.parentComponent;
            freeWireLabel(wire.wireLabel);
            wire.wireLabel = textShape.text;
            bumpWireLabelCounter(textShape.text);
            wire.invalidate();
        }
        return;
    }
    // Wire label: track label counter
    if (textShape.fieldKey === 'wireLabel' && textShape.parentComponent.type === 'wire') {
        const wire = textShape.parentComponent;
        freeWireLabel(wire.wireLabel);
        wire.wireLabel = textShape.text;
        bumpWireLabelCounter(textShape.text);
        wire.invalidate();
        return;
    }
    if (textShape.fieldKey === 'net' && textShape.parentComponent.type === 'net') {
        const Net = textShape.parentComponent;
        const oldName = Net.net;
        Net.net = textShape.text;
        Net.syncTextOffsetFromLabelText?.();
        Net.invalidate();
        // Propagate renamed net to all attached wires
        if (oldName !== Net.net) {
            _propagateNetNameToWires(app, Net);
        }
        return;
    }
    textShape.parentComponent[textShape.fieldKey] = textShape.text;
}

/** Clean up text-edit overlay state (used for early abort). */
function _cleanupTextEditState(state, app, shape) {
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
    if (shape && app.selection && !app.selection.isSelected(shape)) {
        app.selection.select(shape, false);
    }
}
