/**
 * Command classes for PCB free-standing text undo/redo.
 *
 * Model commands own mutations and undo state. These adapters keep SVG,
 * selection, and derived-geometry updates synchronized with those operations.
 */

import {
    AddTextCommand as ModelAddTextCommand, RemoveTextCommand as ModelRemoveTextCommand,
    MoveTextCommand as ModelMoveTextCommand, EditTextCommand as ModelEditTextCommand,
} from '../../core/pcb-text-commands.js';
import { isPcbSelected } from './selection-registry.js';
import { schedulePictureCopperRefresh } from './picture-refresh.js';

/** Add a text to app.texts and render it. */
export class AddTextCommand extends ModelAddTextCommand {
    constructor(app, text) {
        super(app.pcbDocument, text);
        this.app = app;
    }
    execute() {
        super.execute();
        schedulePictureCopperRefresh(this.app, this.text);
        this.app._renderText(this.text);
    }
    undo() {
        this.app._removeTextElement(this.text.id);
        super.undo();
        schedulePictureCopperRefresh(this.app, this.text);
        if (isPcbSelected(this.app, 'text', this.text)) {
            this.app._selectText(null);
        }
    }
}

/** Remove a text. */
export class RemoveTextCommand extends ModelRemoveTextCommand {
    constructor(app, textId) {
        super(app.pcbDocument, textId);
        this.app = app;
    }
    execute() {
        const text = this.document.texts.get(this.snapshot.id);
        this.app._removeTextElement(this.snapshot.id);
        super.execute();
        schedulePictureCopperRefresh(this.app, this.snapshot);
        if (text && isPcbSelected(this.app, 'text', text)) {
            this.app._selectText(null);
        }
    }
    undo() {
        super.undo();
        const text = this.document.texts.get(this.snapshot.id);
        schedulePictureCopperRefresh(this.app, text);
        this.app._renderText(text);
    }
}

/** Move a text from (x0,y0) to (x1,y1). */
export class MoveTextCommand extends ModelMoveTextCommand {
    constructor(app, textId, x0, y0, x1, y1) {
        super(app.pcbDocument, textId, x0, y0, x1, y1);
        this.app = app;
    }
    _set(x, y) {
        super._set(x, y);
        schedulePictureCopperRefresh(this.app);
        this.app._refreshText(this.id);
    }
}

/**
 * Replace any subset of a text's editable properties. `after` is a
 * partial object (e.g. `{ size: 1.2, layer: 'bottom-silk' }`). The
 * pre-edit values are captured at construction time.
 */
export class EditTextCommand extends ModelEditTextCommand {
    constructor(app, textId, after) {
        super(app.pcbDocument, textId, after);
        this.app = app;
    }
    _apply(patch) {
        super._apply(patch);
        const t = this.document.texts.get(this.id);
        schedulePictureCopperRefresh(this.app, t);
        this.app._refreshText(this.id);
        if ('rotation' in patch && isPcbSelected(this.app, 'text', t)) {
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTextRot'));
            if (input) input.value = String(Math.round(t.rotation) % 360);
        }
    }
}
