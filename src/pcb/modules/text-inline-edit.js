import { createInlineTextOverlay, setInlineTextInputActive } from '../../shared/ui/inline-text-overlay.js';
import { isLayerVisible } from './layers.js';
import { boardShapeLocked } from './object-locks.js';
import { invalidateDrcRefresh } from './drc-refresh.js';
import { pcbTextEditBox } from './pcb-text.js';
import { AddTextCommand, RemoveTextCommand, EditTextCommand, finishTextContentPreview, beginTextContentPreview } from './text-commands.js';
import { invalidateFillRefresh } from './fill-refresh.js';
import { isPcbSelected } from './selection-registry.js';
import { measureText as measureStrokeText, stringToPolylines } from '../../shared/pcb/stroke-font.js';
import { isEditorActive } from './pcb-editor-api.js';
import { getPropertyEditor } from './property-editors.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {import('../../core/pcb-text.js').PcbText} PcbText */
/** @typedef {{componentId?: string|null, isNewPlacement?: boolean, select?: () => void, prepare?: () => void, transform?: () => string, localX?: (point: Point) => number, render?: () => void, validate?: (value: string) => boolean, finish?: (value: string, commit: boolean) => void}} TextInlineEditOptions */

/*
 * In-place editing of free PCB text: a hidden input captures keystrokes, IME and
 * clipboard while an SVG overlay draws the box and caret at the stroke font's real
 * glyph positions. Enter, a click elsewhere on the board, another tool or the other
 * editor commits; Escape cancels; a blur alone keeps editing. The edit state is the
 * editor's `_textEdit` interaction (see pcb-interactions.js). Key handlers finish
 * the edit through endTextInlineEdit().
 */

/** Vertical extent of a string in the stroke font, including half the stroke width. */
/**
 * @param {string} text
 * @param {number} size
 * @param {number} [strokeWidth]
 */
function measureStrokeTextVerticalBounds(text, size, strokeWidth = 0) {
    const polylines = stringToPolylines(text, 0, 0, size, false);
    let top = Infinity;
    let bottom = -Infinity;
    for (const polyline of polylines) {
        for (const point of polyline) {
            top = Math.min(top, point.y);
            bottom = Math.max(bottom, point.y);
        }
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
        top = -size;
        bottom = 0;
    }
    const strokeRadius = Math.max(Number(strokeWidth) || 0, 0) / 2;
    return { top: top - strokeRadius, bottom: bottom + strokeRadius };
}

/**
 * The in-progress inline text edit (`{ text, … }`), or null.
 * @param {PcbEditor} app
 */
export function activeTextInlineEdit(app) {
    return getPcbInteraction(app, '_textEdit');
}

/**
 * Begin in-place editing of a PCB text annotation. A hidden input takes the
 * keystrokes and an SVG overlay draws the box and caret. Commits on Enter,
 * cancels on Escape (see the module comment for the other ways it ends).
 * @param {PcbEditor} app
 * @param {PcbText} text
 * @param {{x:number,y:number}|null} [worldPos] - if given, the caret is
 *   placed at the character nearest this click point; otherwise it
 *   goes to the end of the text.
 * @param {TextInlineEditOptions} [opts]
 */
export function startTextInlineEdit(app, text, worldPos, opts = {}) {
    if (!text || boardShapeLocked(text) || !isLayerVisible(text.layer)) return;
    if (activeTextInlineEdit(app) && endTextInlineEdit(app, true) === false) return;

    const viewport = app.viewport;
    const svg = viewport?.svg;
    if (!svg) return;
    invalidateFillRefresh(app);
    invalidateDrcRefresh(app);
    if (!opts.componentId) text = beginTextContentPreview(app, text.id);

    // Hidden input captures keystrokes / selection / IME / clipboard.
    // Its visual is irrelevant; we draw our own caret as an SVG line
    // positioned via the actual Hershey font's measureText().
    const input = document.createElement('input');
    input.type = 'text';
    input.value = text.content;
    input.style.cssText =
        'position:fixed;left:-1000px;top:-1000px;width:10px;height:10px;' +
        'opacity:0;';
    document.body.appendChild(input);
    setInlineTextInputActive(input, isEditorActive(app));

    const layerG = app.getLayerGroup(text.layer);
    const overlay = createInlineTextOverlay(
        /** @param {SVGGElement} group */
        group => {
            if (typeof viewport.addInteractionOverlay === 'function') {
                viewport.addInteractionOverlay(group);
            } else {
                layerG?.appendChild(group);
            }
        },
        { emphasized: true },
    );
    const { box, caret } = overlay;

    setPcbInteraction(app, '_textEdit', {
        text, input, caret, box, overlay,
        options: opts,
        isNewPlacement: !!opts.isNewPlacement,
        originalContent: text.content,
        committed: false,
        blinkTimer: overlay.blinkTimer,
    });

    // Surface the Properties panel for this text so the user can
    // tweak size/rotation/etc. mid-edit without leaving edit mode.
    if (opts.select) opts.select();
    else {
        app.selectText(text);
        app.showTextProperties(text);
    }
    const keepVisible = () => {
        activeTextInlineEdit(app)?.overlay?.keepCaretVisible();
    };

    const updateCaret = () => {
        opts.prepare?.();
        // Update editing box bounds. Top of box sits a small pad
        // above the cap-top; bottom sits below the baseline far
        // enough to clear descenders (g, y, p, …).
        const editBox = pcbTextEditBox(text, input.value);
        const mirror = (typeof text.layer === 'string' && text.layer.startsWith('bottom-')) ? -1 : 1;
        const xform = opts.transform?.()
            ?? `translate(${text.x},${text.y}) rotate(${-(text.rotation || 0)}) scale(${mirror},1)`;

        const caretIdx = input.selectionStart ?? input.value.length;
        const sub = input.value.slice(0, caretIdx);
        const lx = measureStrokeText(sub, text.size);
        const verticalBounds = measureStrokeTextVerticalBounds(
            input.value,
            text.size,
            text.strokeWidth,
        );
        const caretExtension = text.size * 0.15;
        overlay.updateGeometry({
            ...editBox,
            caretX: lx,
            caretTop: verticalBounds.top - caretExtension,
            caretBottom: verticalBounds.bottom + caretExtension,
            transform: xform,
        });
    };

    keepVisible();
    activeTextInlineEdit(app).updateCaret = updateCaret;

    const live = (/** @type {Event} */ event) => {
        // Inline autoreplace for common typographic symbols. Matches
        // only at the caret, only while typing, and goes through the
        // browser's editing command so Ctrl+Z restores a literal "(c)".
        const AUTOREPLACE = [
            ['(c)',  '\u00A9'],
            ['(C)',  '\u00A9'],
            ['(r)',  '\u00AE'],
            ['(R)',  '\u00AE'],
            ['(tm)', '\u2122'],
            ['(TM)', '\u2122'],
        ];
        const caret = input.selectionStart ?? input.value.length;
        const typing = /** @type {InputEvent} */ (event)?.inputType === 'insertText';
        for (const [from, to] of typing ? AUTOREPLACE : []) {
            if (caret >= from.length &&
                input.value.slice(caret - from.length, caret) === from) {
                const start = caret - from.length;
                try { input.setSelectionRange(start, caret); } catch { /* */ }
                // insertText fires its own input event (not 'insertText' typing, so no loop).
                if (!document.execCommand('insertText', false, to)) {
                    input.value = input.value.slice(0, start) + to + input.value.slice(caret);
                    try { input.setSelectionRange(start + to.length, start + to.length); } catch { /* */ }
                }
                break;
            }
        }
        if (text.content !== input.value) {
            text.content = input.value;
            if (opts.render) opts.render();
            else app.refreshText(text.id);
        }
        updateCaret();
        keepVisible();
    };
    input.addEventListener('input', live);
    input.addEventListener('keyup', () => { updateCaret(); keepVisible(); });
    input.addEventListener('click', () => { updateCaret(); keepVisible(); });
    input.addEventListener('select', () => { updateCaret(); keepVisible(); });

    // Resume label typing from property controls, but let numeric fields
    // own their editing keys. Enter/Escape still finish the inline edit.
    /** @param {KeyboardEvent} ev */
    const docKeyCapture = (ev) => {
        const st = activeTextInlineEdit(app);
        if (!st || !isEditorActive(app)) return;
        const active = document.activeElement;
        if (active === input) return;
        const propsPanel = document.getElementById('pcbPropertiesPanel');
        if (!(propsPanel && active && propsPanel.contains(active))) return;
        // Determine if this is a text-editing key we should reroute.
        const k = ev.key;
        // A number field keeps its own keys (digits, signs, separators, arrows, editing
        // keys); characters it cannot hold go back to the text, so typing resumes there.
        const textCharacter = k.length === 1 && !ev.ctrlKey && !ev.metaKey && !/[0-9.,+\-]/.test(k);
        if (active.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (active).type === 'number'
            && k !== 'Enter' && k !== 'Escape' && !textCharacter) return;
        const editingKey =
            k === 'ArrowLeft' || k === 'ArrowRight' ||
            k === 'Home' || k === 'End' ||
            k === 'Backspace' || k === 'Delete' ||
            k === 'Escape' || k === 'Enter' ||
            (k.length === 1 && !ev.metaKey);
        if (!editingKey) return;
        // Don't steal the spinner's own up/down arrows, Tab, etc.
        ev.preventDefault();
        ev.stopPropagation();
        input.focus();
        // Synthesize: for printable chars, insert at selection.
        const sel = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? sel;
        if (k.length === 1 && !ev.ctrlKey && !ev.metaKey) {
            const v = input.value;
            input.value = v.slice(0, sel) + k + v.slice(end);
            const pos = sel + 1;
            try { input.setSelectionRange(pos, pos); } catch { /* */ }
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: k }));
        } else if (k === 'Backspace') {
            const v = input.value;
            if (sel !== end) {
                input.value = v.slice(0, sel) + v.slice(end);
                try { input.setSelectionRange(sel, sel); } catch { /* */ }
            } else if (sel > 0) {
                input.value = v.slice(0, sel - 1) + v.slice(sel);
                try { input.setSelectionRange(sel - 1, sel - 1); } catch { /* */ }
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (k === 'Delete') {
            const v = input.value;
            if (sel !== end) {
                input.value = v.slice(0, sel) + v.slice(end);
            } else if (sel < v.length) {
                input.value = v.slice(0, sel) + v.slice(sel + 1);
            }
            try { input.setSelectionRange(sel, sel); } catch { /* */ }
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (k === 'ArrowLeft') {
            const pos = Math.max(0, (ev.ctrlKey ? 0 : sel - 1));
            try { input.setSelectionRange(pos, pos); } catch { /* */ }
            updateCaret(); keepVisible();
        } else if (k === 'ArrowRight') {
            const pos = ev.ctrlKey ? input.value.length : Math.min(input.value.length, sel + 1);
            try { input.setSelectionRange(pos, pos); } catch { /* */ }
            updateCaret(); keepVisible();
        } else if (k === 'Home') {
            try { input.setSelectionRange(0, 0); } catch { /* */ }
            updateCaret(); keepVisible();
        } else if (k === 'End') {
            const pos = input.value.length;
            try { input.setSelectionRange(pos, pos); } catch { /* */ }
            updateCaret(); keepVisible();
        } else if (k === 'Enter') {
            endTextInlineEdit(app, true);
        } else if (k === 'Escape') {
            endTextInlineEdit(app, false);
        }
    };
    document.addEventListener('keydown', docKeyCapture, true);
    activeTextInlineEdit(app).docKeyCapture = docKeyCapture;

    input.addEventListener('keydown', (e) => {
        if (!isEditorActive(app)) {
            e.preventDefault();
            return;
        }
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            endTextInlineEdit(app, true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            endTextInlineEdit(app, false);
        } else {
            // Arrow/Home/End/Backspace/Delete autorepeat only fires
            // keydown (no keyup, no input event for arrows). Defer
            // one tick so input.selectionStart reflects the post-key
            // position, then redraw the SVG caret.
            requestAnimationFrame(() => { updateCaret(); keepVisible(); });
        }
    });
    input.addEventListener('blur', (e) => {
        // Keep edit mode alive on blur. If focus moved to the
        // Properties panel, leave it there (the user is tweaking
        // a spinner). Otherwise refocus the hidden input on the
        // next tick so transient blurs (e.g. right-drag panning
        // the canvas) don't end edit mode. Commit happens only
        // via Enter or Escape.
        const propsPanel = document.getElementById('pcbPropertiesPanel');
        setTimeout(() => {
            const state = activeTextInlineEdit(app);
            if (!isEditorActive(app) || !state || state.committed) return;
            const active = document.activeElement;
            if (active === input) return;
            if (propsPanel && active && propsPanel.contains(active)) return;
            input.focus();
        }, 0);
    });

    // Take the keyboard now, so keys typed straight after the double-click reach the text
    // even on a busy machine. The next tick places the caret at the click and refocuses if
    // the press's default action moved focus; keys that arrive first keep their caret.
    let typedFirst = false;
    const noteTyping = () => { typedFirst = true; };
    input.addEventListener('keydown', noteTyping);
    input.addEventListener('input', noteTyping);
    if (isEditorActive(app)) input.focus();

    setTimeout(() => {
        if (!isEditorActive(app) || activeTextInlineEdit(app)?.input !== input) return;
        input.focus();
        if (typedFirst) { updateCaret(); return; }
        // Place caret at the character nearest the click, if known.
        let idx = input.value.length;
        if (worldPos) {
            // Inverse-rotate the click into the text's local frame,
            // undo the mirror, then walk glyphs accumulating widths
            // to find the nearest gap.
            const rad = -(text.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(-rad), sin = Math.sin(-rad);
            const mirror = (typeof text.layer === 'string' && text.layer.startsWith('bottom-')) ? -1 : 1;
            const dx = worldPos.x - text.x, dy = worldPos.y - text.y;
            const lx = opts.localX ? opts.localX(worldPos) : (dx * cos - dy * sin) * mirror;
            let cursorX = 0;
            let best = 0;
            let bestDist = Math.abs(lx - cursorX);
            const s = input.value;
            for (let i = 0; i < s.length; i++) {
                const charW = measureStrokeText(s[i], text.size);
                cursorX += charW;
                // After the i-th char, caret would be at index i+1.
                const d = Math.abs(lx - cursorX);
                if (d < bestDist) { bestDist = d; best = i + 1; }
            }
            idx = best;
        }
        try { input.setSelectionRange(idx, idx); } catch { /* ignore */ }
        updateCaret();
    }, 0);
}

/**
 * Finish in-place text editing. If `commit`, pushes an EditTextCommand
 * with the new content. Always tears down the overlay.
 * @param {PcbEditor} app
 * @param {boolean} commit
 */
export function endTextInlineEdit(app, commit) {
    const state = activeTextInlineEdit(app);
    if (!state) return;
    if (commit) getPropertyEditor(app, 'text')?.commit();
    else getPropertyEditor(app, 'text')?.cancel();
    if (commit && state.options?.validate && !state.options.validate(state.input.value)) return false;
    state.committed = true;
    setPcbInteraction(app, '_textEdit', null);

    const { text, input, originalContent, isNewPlacement } = state;
    const finalContent = input.value;

    if (state.docKeyCapture) document.removeEventListener('keydown', state.docKeyCapture, true);
    state.overlay?.destroy();
    if (input.parentNode) input.parentNode.removeChild(input);

    if (state.options?.finish) {
        text.content = originalContent;
        state.options.finish(commit ? finalContent : originalContent, commit);
        return;
    }

    // Determine effective final content (empty if cancelled).
    const effective = commit ? finalContent : originalContent;
    // Remove blank text without recording its temporary typed content.
    const blank = effective.trim() === '';
    const wasSelected = isPcbSelected(app, 'text', text);
    try {
        finishTextContentPreview(app, () => {
            if (blank) {
                const remove = new RemoveTextCommand(app, text.id);
                const last = app.history.undoStack.at(-1);
                if (isNewPlacement && last instanceof AddTextCommand && last.text.id === text.id) {
                    remove.execute();
                    app.history.popUndo();
                    app.history.redoStack = [];
                    app.history._notifyChanged();
                } else {
                    // Keep intervening edits undoable against a restored text.
                    app.history.execute(remove);
                }
            } else if (commit && finalContent !== originalContent) {
                app.history.execute(new EditTextCommand(app, text.id, { content: finalContent }));
            } else {
                app.refreshText(text.id);
            }
        });
    } finally {
        if (!blank || wasSelected) {
            app.selectText(null);
            app.clearProperties?.();
        }
        app.setActiveRibbonTab('pcb-home');
    }
}
