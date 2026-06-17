import { FileManager } from './FileManager.js';

/**
 * Neutral owner of the single ClearPCB project document.
 *
 * A ClearPCB project is one file containing BOTH a schematic and a PCB.
 * Historically the schematic editor owned the file (it was built first),
 * which forced the PCB editor to reach sideways into the schematic for
 * every File operation. `ProjectDocument` makes ownership explicit and
 * symmetric: it holds the single {@link FileManager} and coordinates a
 * set of registered *views* (the schematic and PCB editors), each of which
 * contributes one section of the document.
 *
 * Views implement a small duck-typed interface:
 *   - `serializeSection()` → the view's slice of the document (or null).
 *   - `loadSection(data)`   → restore the view from its slice.
 *   - `clearSection()`      → reset the view to empty (used by New).
 *   - `isSectionDirty()`    → unsaved-changes flag for autosave/beforeunload.
 *
 * The schematic view additionally acts as the *UI host* (it owns the
 * canvas-level prompts/toasts/title), and injects the file-lifecycle
 * implementation via {@link registerView}'s `lifecycle` option so that
 * `core` never has to import a view module.
 */
export class ProjectDocument {
    constructor() {
        /** The single source of truth for the file on disk. */
        this.fileManager = new FileManager();
        /** @type {Map<string, any>} Registered editor views by name. */
        this.views = new Map();
        /** View that owns canvas-level UI (prompts, toasts, title). */
        this.uiHost = null;
        /** @type {Record<string, () => any>} Injected lifecycle callbacks. */
        this._lifecycle = {};
    }

    /**
     * Register an editor view as a contributor to the project document.
     * @param {string} name e.g. 'schematic' | 'pcb'.
     * @param {any} view The editor instance implementing the view interface.
     * @param {{isUiHost?: boolean, lifecycle?: Record<string, () => any>}} [opts]
     * @returns {any} The registered view (for convenience).
     */
    registerView(name, view, opts = {}) {
        this.views.set(name, view);
        if (opts.isUiHost) this.uiHost = view;
        if (opts.lifecycle) this._lifecycle = { ...this._lifecycle, ...opts.lifecycle };
        return view;
    }

    /** @returns {any} The schematic view, if registered. */
    get schematic() { return this.views.get('schematic'); }
    /** @returns {any} The PCB view, if registered. */
    get pcb() { return this.views.get('pcb'); }

    /**
     * Whether any view has unsaved changes beyond the file manager's own
     * dirty flag. Used as the autosave / beforeunload predicate so that
     * edits in EITHER editor are captured (both persist into one file).
     * @returns {boolean}
     */
    isViewDirty() {
        for (const v of this.views.values()) {
            if (v?.isSectionDirty?.()) return true;
        }
        return false;
    }

    /**
     * Mark every registered view as having no unsaved changes. Called after
     * the combined document is successfully written to disk so that section
     * dirty flags (e.g. the PCB's) don't keep re-triggering autosave and the
     * beforeunload warning even though everything is saved.
     */
    markAllSectionsClean() {
        for (const v of this.views.values()) {
            v?.markSectionClean?.();
        }
    }

    /** @returns {boolean} True if the document has any unsaved changes. */
    get isDirty() {
        return !!this.fileManager.isDirty || this.isViewDirty();
    }

    /**
     * Assemble the combined on-disk document from every registered view.
     * The schematic view produces the document envelope (version/type/
     * settings/shapes/components); the PCB view contributes `doc.pcb`.
     * Neither view reaches into the other — the project coordinates them.
     * @returns {object} The serialized project document.
     */
    serialize() {
        const doc = this.schematic?.serializeSection?.() || {
            version: '2.0',
            type: 'clearpcb-project',
            created: new Date().toISOString(),
        };
        const pcbSection = this.pcb?.serializeSection?.();
        if (pcbSection) doc.pcb = pcbSection;
        else delete doc.pcb;
        return doc;
    }

    /**
     * Restore every registered view from a previously serialized document.
     * @param {object} data The serialized project document.
     * @returns {Promise<void>}
     */
    async load(data) {
        await this.schematic?.loadSection?.(data);
        this.pcb?.loadSection?.(data?.pcb || null);
    }

    /**
     * Start the autosave timer. Fires whenever the file manager OR any
     * view reports unsaved changes, persisting the combined document.
     */
    startAutoSave() {
        this.fileManager.startAutoSave(
            () => this.serialize(),
            () => this.isViewDirty(),
        );
    }

    // ── File lifecycle facade ─────────────────────────────────────────
    // Both editors' File menus call these so neither depends on the other.
    // The concrete implementation is injected by the UI-host view via
    // registerView({ lifecycle }), keeping `core` free of view imports.

    /** Create a new blank document (prompts if unsaved). */
    async newDocument() { return this._lifecycle.new?.(); }
    /** Open a document from disk (prompts if unsaved). */
    async open() { return this._lifecycle.open?.(); }
    /** Save the document, prompting for a location if needed. */
    async save() { return this._lifecycle.save?.(); }
    /** Save the document to a new location. */
    async saveAs() { return this._lifecycle.saveAs?.(); }
    /** Import an EasyEDA schematic into a fresh document. */
    async importEasyEDA() { return this._lifecycle.importEasyEDA?.(); }
}
