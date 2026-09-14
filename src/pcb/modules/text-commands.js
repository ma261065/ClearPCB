/**
 * Command classes for PCB free-standing text undo/redo.
 *
 * Each command owns enough state to fully reverse itself. SVG updates
 * happen inside execute()/undo() so the visible board state always
 * matches the model.
 */

import { serializePcbText } from './pcb-text.js';
import { isPcbSelected } from './selection-registry.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';

/** Add a text to app.texts and render it. */
export class AddTextCommand {
    constructor(app, text) {
        this.app = app;
        this.text = text;
    }
    execute() {
        this.app.texts.set(this.text.id, this.text);
        schedulePictureCopperRefresh(this.app, this.text);
        this.app._renderText(this.text);
    }
    undo() {
        this.app._removeTextElement(this.text.id);
        this.app.texts.delete(this.text.id);
        schedulePictureCopperRefresh(this.app, this.text);
        if (isPcbSelected(this.app, 'text', this.text)) {
            this.app._selectText(null);
        }
    }
    get description() { return `Add text "${this.text.content}"`; }
}

/** Remove a text. */
export class RemoveTextCommand {
    constructor(app, textId) {
        this.app = app;
        this.snapshot = serializePcbText(app.texts.get(textId));
    }
    execute() {
        const text = this.app.texts.get(this.snapshot.id);
        this.app._removeTextElement(this.snapshot.id);
        this.app.texts.delete(this.snapshot.id);
        schedulePictureCopperRefresh(this.app, this.snapshot);
        if (text && isPcbSelected(this.app, 'text', text)) {
            this.app._selectText(null);
        }
    }
    undo() {
        const text = { ...this.snapshot };
        this.app.texts.set(text.id, text);
        schedulePictureCopperRefresh(this.app, text);
        this.app._renderText(text);
    }
    get description() { return `Delete text "${this.snapshot.content}"`; }
}

/** Move a text from (x0,y0) to (x1,y1). */
export class MoveTextCommand {
    constructor(app, textId, x0, y0, x1, y1) {
        this.app = app;
        this.id = textId;
        this.x0 = x0; this.y0 = y0;
        this.x1 = x1; this.y1 = y1;
    }
    execute() { this._set(this.x1, this.y1); }
    undo()    { this._set(this.x0, this.y0); }
    _set(x, y) {
        const t = this.app.texts.get(this.id);
        if (!t) return;
        t.x = x; t.y = y;
        schedulePictureCopperRefresh(this.app);
        this.app._refreshText(this.id);
    }
    get description() { return 'Move text'; }
}

/**
 * Replace any subset of a text's editable properties. `after` is a
 * partial object (e.g. `{ size: 1.2, layer: 'bottom-silk' }`). The
 * pre-edit values are captured at construction time.
 */
export class EditTextCommand {
    constructor(app, textId, after) {
        this.app = app;
        this.id = textId;
        const t = app.texts.get(textId);
        this.before = {};
        this.after = {};
        for (const k of Object.keys(after)) {
            this.before[k] = t[k];
            this.after[k] = after[k];
        }
    }
    execute() { this._apply(this.after); }
    undo()    { this._apply(this.before); }
    _apply(patch) {
        const t = this.app.texts.get(this.id);
        if (!t) return;
        Object.assign(t, patch);
        schedulePictureCopperRefresh(this.app, t);
        this.app._refreshText(this.id);
        if ('rotation' in patch && isPcbSelected(this.app, 'text', t)) {
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTextRot'));
            if (input) input.value = String(Math.round(t.rotation) % 360);
        }
    }
    get description() { return 'Edit text'; }
}
