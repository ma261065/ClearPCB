import { FileManager } from './FileManager.js';
import { validateEditableProject } from './project-format.js';
import { compactProjectAliases } from './project-field-aliases.js';
import { SchematicDocument } from './SchematicDocument.js';
import { PcbDocument } from './PcbDocument.js';
import { extractComponents } from './netlist.js';
import { createPcbFootprint } from './pcb-footprint.js';

/** @typedef {{id: string, reference: string, locked: boolean, footprintShapes: string[]}} ComponentInfo */

/**
 * Neutral owner of the single ClearPCB project document.
 *
 * A ClearPCB project is one file containing BOTH a schematic and a PCB.
 * Historically the schematic editor owned the file (it was built first),
 * which forced the PCB editor to reach sideways into the schematic for
 * every File operation. `ProjectDocument` makes ownership explicit and
 * symmetric: it holds the single {@link FileManager}, document models, and
 * registered *views*. View settings remain
 * editor-owned during the incremental model migration.
 *
 * Views implement a small duck-typed interface:
 *   - `serializeSection()` → the view's slice of the document (or null).
 *   - `loadSection(data)`   → restore the view from its slice.
 *   - `clearSection()`      → reset the view to empty (used by New).
 *   - `isSectionDirty()`    → unsaved-changes flag for autosave/beforeunload.
 *   - `restoreSectionDirty(dirty)` → restore section dirtiness after a failed load.
 *   - `onDocumentReplaced(reason)` → local UI reset after a successful file action.
 *   - `onProjectChanged()` → UI host refreshes aggregate project status.
 *   - `onComponentReferenceChanged(id)` → schematic refreshes reference presentation.
 *   - `onSchematicChanged()` → PCB schedules a model-driven refresh.
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
        this.schematicDocument = new SchematicDocument();
        this.pcbDocument = new PcbDocument();
        /** @type {Map<string, any>} Registered editor views by name. */
        this.views = new Map();
        /** View that owns canvas-level UI (prompts, toasts, title). */
        this.uiHost = null;
        /** @type {Record<string, () => any>} Injected lifecycle callbacks. */
        this._lifecycle = {};
        /** @type {((loading: boolean) => void|Promise<void>)|null} */
        this.onLoadingChange = null;
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
        view.onDocumentChanged = () => {
            this.fileManager.touch();
            this.uiHost?.onProjectChanged?.();
        };
        if (opts.isUiHost) this.uiHost = view;
        if (opts.lifecycle) this._lifecycle = { ...this._lifecycle, ...opts.lifecycle };
        return view;
    }

    /** @returns {any} The schematic view, if registered. */
    get schematic() { return this.views.get('schematic'); }
    /** @returns {any} The PCB view, if registered. */
    get pcb() { return this.views.get('pcb'); }

    /**
     * @param {string} id
     * @returns {ComponentInfo|null} Detached component metadata.
     */
    getComponentInfo(id) {
        return this.schematicDocument.getComponentInfo(id);
    }

    /** Resolve the current physical footprint; missing/non-physical components return null. */
    getPcbFootprint(id) {
        const component = this.schematicDocument.components.find(item => item.id === id);
        if (!component) return null;
        const [summary] = extractComponents({ components: [component] });
        return summary ? createPcbFootprint(summary) : null;
    }

    /**
     * @param {string} id
     * @param {string} reference
     * @returns {{message: string, title: string}|null}
     */
    validateComponentReference(id, reference) {
        return this.schematicDocument.validateComponentReference(id, reference);
    }

    /**
     * Create, but do not execute or record, an editor-independent undoable operation.
     * @param {string} id
     * @param {string} reference
     * @returns {{execute(): void, undo(): void}}
     */
    createReferenceRenameCommand(id, reference) {
        const command = this.schematicDocument.createReferenceRenameCommand(id, reference);
        const apply = redo => {
            if (redo) command.execute();
            else command.undo();
            this.schematic?.onComponentReferenceChanged?.(id);
        };
        return { execute: () => apply(true), undo: () => apply(false) };
    }

    /** @returns {import('./netlist.js').NetlistEntry[]} */
    getNetlist() {
        return this.schematicDocument.getNetlist();
    }

    /** Route schematic edit/lifecycle notifications without exposing editor callbacks. */
    notifySchematicChanged() {
        this.pcb?.onSchematicChanged?.();
    }

    /**
     * Notify views only after replacement and file-identity updates succeed.
     * Each editor owns its own tabs and any new-document setup UI.
     * @param {'new'|'open'|'import'} reason
     */
    notifyDocumentReplaced(reason) {
        for (const view of this.views.values()) {
            view.onDocumentReplaced?.(reason);
        }
    }

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
     * Assemble the combined document using views where registered, otherwise models.
     * Adapters supply current viewport settings; models retain loaded preferences.
     * Neither view reaches into the other — the project coordinates them.
     * @returns {object} The serialized project document.
     */
    serialize() {
        const doc = this.schematic?.serializeSection?.() || this.schematicDocument.serialize();
        const pcbSection = this.pcb ? this.pcb.serializeSection?.() : this.pcbDocument.serializeSection();
        if (pcbSection) doc.pcb = pcbSection;
        else delete doc.pcb;
        return compactProjectAliases(doc);
    }

    /**
     * Restore models and registered views from a previously serialized document.
     * @param {object} data The serialized project document.
     * @returns {Promise<void>}
     */
    async load(data) {
        if (this.fileManager.saving) throw new Error('Wait for the current save to finish.');
        if (this.fileManager.loading) throw new Error('A project is already being loaded.');
        data = validateEditableProject(data);
        this.fileManager.loading = true;
        try {
            await this.onLoadingChange?.(true);
            const previous = structuredClone(this.serialize());
            const dirty = this.fileManager.isDirty;
            const pcbDirty = this.pcb?.isSectionDirty?.();
            const prepared = this.schematic
                ? await this.schematic.prepareSection?.(data)
                : this.schematicDocument.prepare(data);
            const pcbPrepared = this.pcb
                ? await this.pcb.prepareSection?.(data.pcb || null)
                : PcbDocument.prepare(data.pcb || null);
            this.fileManager.touch();
            try {
                await this.schematic?.loadSection?.(data, prepared);
                if (!this.schematic) this.schematicDocument.load(data, prepared);
                await this.pcb?.loadSection?.(data.pcb || null, pcbPrepared);
                if (!this.pcb) this.pcbDocument.load(data.pcb || null, pcbPrepared);
            } catch (error) {
                await this.schematic?.loadSection?.(previous);
                if (!this.schematic) this.schematicDocument.load(previous);
                await this.pcb?.loadSection?.(previous.pcb || null);
                if (!this.pcb) this.pcbDocument.load(previous.pcb || null);
                this.fileManager.setDirty(dirty);
                if (pcbDirty) this.pcb?.restoreSectionDirty?.(true);
                throw error;
            }
        } finally {
            this.fileManager.loading = false;
            await this.onLoadingChange?.(false);
        }
    }

    /** Clear views or their headless models before adopting a new file identity. */
    async reset() {
        if (this.fileManager.saving || this.fileManager.loading) {
            throw new Error('A file operation is already in progress.');
        }
        this.fileManager.loading = true;
        try {
            await this.schematic?.clearSection();
            if (!this.schematic) this.schematicDocument.clear();
            await this.pcb?.clearSection();
            if (!this.pcb) this.pcbDocument.clear();
            this.fileManager.newDocument(this.serialize());
        } finally {
            this.fileManager.loading = false;
        }
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
    /** Re-open a file from the recents list (prompts if unsaved). */
    async openRecent(name) { return this._lifecycle.openRecent?.(name); }
    /** Save the document, prompting for a location if needed. */
    async save() { return this._lifecycle.save?.(); }
    /** Save the document to a new location. */
    async saveAs() { return this._lifecycle.saveAs?.(); }
    /** Import an EasyEDA schematic into a fresh document. */
    async importEasyEDA() { return this._lifecycle.importEasyEDA?.(); }
}
