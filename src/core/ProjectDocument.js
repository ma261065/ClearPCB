import { FileManager } from './FileManager.js';
import { validateEditableProject } from './project-format.js';
import { compactProjectAliases } from './project-field-aliases.js';
import { SchematicDocument } from './SchematicDocument.js';
import { PcbDocument } from './PcbDocument.js';
import { extractComponents } from './netlist.js';
import { createPcbFootprint } from './pcb-footprint.js';
import { disconnectIncompatiblePadNodes, repositionPadConnectedNodes } from './pcb-placement-geometry.js';
import { flushSettledChanges } from '../shared/ui/settled-input.js';

/** @typedef {{id: string, reference: string, locked: boolean, footprintShapes: string[]}} ComponentInfo */
/** @typedef {import('./project-field-aliases.js').JsonRecord} JsonRecord */
/** @typedef {JsonRecord & {shapes: JsonRecord[], components: JsonRecord[], defs?: Record<string, import('../components/Component.js').ComponentDefinition>, settings?: JsonRecord}} ProjectSchematicData */
/** @typedef {JsonRecord & {version?: string, type?: string, created?: string, schematic: ProjectSchematicData, pcb?: import('./PcbDocument.js').PcbData|null}} ProjectData Parsed project JSON remains loosely shaped until validated. */
/**
 * @typedef {{
 *   onDocumentChanged?: (() => void)|null,
 *   onProjectChanged?: () => void,
 *   onComponentReferenceChanged?: (id: string) => void,
 *   onSchematicChanged?: () => void,
 *   onDocumentReplaced?: (reason: 'new'|'open'|'import') => void,
 *   getViewSettings?: () => object|undefined,
 *   loadSection?: Function,
 *   prepareSection?: Function,
 *   clearSection?: () => void|Promise<void>,
 *   isSectionDirty?: () => unknown,
 *   markSectionClean?: () => void,
 *   isSectionEditing?: () => unknown,
 *   restoreSectionDirty?: (dirty: boolean) => void,
 * }} ProjectView
 */

/**
 * Neutral owner of the single ClearPCB project document.
 *
 * A ClearPCB project is one file containing BOTH a schematic and a PCB.
 * Historically the schematic editor owned the file (it was built first),
 * which forced the PCB editor to reach sideways into the schematic for
 * every File operation. `ProjectDocument` makes ownership explicit and
 * symmetric: it holds the single {@link FileManager}, document models, and
 * registered *views*. Live view settings remain editor-owned;
 * models retain loaded preferences for use without a view.
 *
 * Views implement a small duck-typed interface:
 *   - `getViewSettings()` → current view preferences, or undefined before viewport creation.
 *   - `loadSection(data)`   → restore the view from its slice.
 *   - `clearSection()`      → reset the view to empty (used by New).
 *   - `isSectionDirty()`    → unsaved-changes flag for autosave/beforeunload.
 *   - `isSectionEditing()`  → transient previews make a file snapshot unsafe.
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
        /** @type {Map<string, ProjectView>} Registered editor views by name. */
        this.views = new Map();
        /** View that owns canvas-level UI (prompts, toasts, title). */
        this.uiHost = null;
        /** @type {Record<string, (...args: *[]) => unknown>} Injected lifecycle callbacks. */
        this._lifecycle = {};
        /** @type {((loading: boolean) => void|Promise<void>)|null} */
        this.onLoadingChange = null;
    }

    /**
     * Register an editor view as a contributor to the project document.
     * @param {string} name e.g. 'schematic' | 'pcb'.
     * @param {ProjectView} view The editor instance implementing the view interface.
     * @param {{isUiHost?: boolean, lifecycle?: Record<string, (...args: *[]) => unknown>}} [opts]
     * @returns {ProjectView} The registered view (for convenience).
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

    /** @returns {ProjectView|undefined} The schematic view, if registered. */
    get schematic() { return this.views.get('schematic'); }
    /** @returns {ProjectView|undefined} The PCB view, if registered. */
    get pcb() { return this.views.get('pcb'); }

    /**
     * @param {string} id
     * @returns {ComponentInfo|null} Detached component metadata.
     */
    getComponentInfo(id) {
        return this.schematicDocument.getComponentInfo(id);
    }

    /** Resolve the current physical footprint; missing/non-physical components return null. */
    /** @param {string} id */
    getPcbFootprint(id) {
        const component = this.schematicDocument.components.find(item => item.id === id);
        if (!component) return null;
        const [summary] = extractComponents({ components: [component] });
        return summary ? createPcbFootprint(summary) : null;
    }

    /** Resolve physical placements and matching connectivity from the current models. */
    resolvePcbLayout() {
        const components = extractComponents(this.schematicDocument);
        const netlist = this.getNetlist();
        return { placements: this.pcbDocument.placementState.resolve(components), netlist };
    }

    /** Resolve the complete layout before applying the existing rebuild policy to track bonds. */
    synchronizePcbLayout() {
        const layout = this.resolvePcbLayout();
        const tracks = this.pcbDocument.tracks;
        for (const [id, placement] of layout.placements) {
            if (placement.side === 'bottom') disconnectIncompatiblePadNodes(tracks, id, placement.padOffsets);
            // Preserve the legacy rebuild eligibility, including reference-offset placements.
            if (placement.mirror || placement.side === 'bottom' || placement.rotation
                || placement.refDx || placement.refDy || placement.refRot) {
                repositionPadConnectedNodes(tracks, id, placement.pads);
            }
        }
        return layout;
    }

    /**
     * Restore saved poses and their track bonds using current model-owned footprints.
     * @param {Iterable<string>} [componentIds]
     */
    restorePcbPlacementOverrides(componentIds = this.pcbDocument.placementState.overrides.keys()) {
        const ids = new Set(componentIds);
        const state = this.pcbDocument.placementState;
        const components = extractComponents({ components: this.schematicDocument.components
            .filter(component => ids.has(component.id) && state.overrides.has(component.id)) });
        const placements = state.resolve(components);
        for (const [id, placement] of placements) {
            disconnectIncompatiblePadNodes(this.pcbDocument.tracks, id, placement.padOffsets);
            repositionPadConnectedNodes(this.pcbDocument.tracks, id, placement.pads);
        }
        return placements;
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
        /** @param {boolean} redo */
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

    /** Whether registered views permit a snapshot of the authored models. */
    canSerialize() {
        for (const view of this.views.values()) {
            if (view.isSectionEditing?.()) return false;
        }
        return true;
    }

    /**
     * Assemble authored content from the project-owned models.
     * Views contribute only current preferences, with loaded model fallback.
     * Neither view reaches into the other — the project coordinates them.
     * @returns {ProjectData} The serialized project document.
     */
    serialize() {
        if (!this.canSerialize()) throw new Error('Finish the current edit before saving.');
        const doc = /** @type {ProjectData} */ (this.schematicDocument.serialize(this.schematic?.getViewSettings?.()));
        const pcbSection = this.pcbDocument.serializeSection(this.pcb?.getViewSettings?.());
        if (pcbSection) doc.pcb = pcbSection;
        else delete doc.pcb;
        return /** @type {ProjectData} */ (compactProjectAliases(doc));
    }

    /**
     * Restore models and registered views from a previously serialized document.
     * @param {object|null} data The serialized project document.
     * @returns {Promise<void>}
     */
    async load(data) {
        if (this.fileManager.saving) throw new Error('Wait for the current save to finish.');
        if (this.fileManager.loading) throw new Error('A project is already being loaded.');
        const projectData = /** @type {ProjectData} */ (validateEditableProject(data));
        this.fileManager.loading = true;
        try {
            await this.onLoadingChange?.(true);
            const previous = structuredClone(this.serialize());
            const dirty = this.fileManager.isDirty;
            const pcbDirty = this.pcb?.isSectionDirty?.();
            const prepared = this.schematic
                ? await this.schematic.prepareSection?.(projectData)
                : this.schematicDocument.prepare(projectData);
            const pcbPrepared = this.pcb
                ? await this.pcb.prepareSection?.(projectData.pcb || null)
                : PcbDocument.prepare(projectData.pcb || null);
            this.fileManager.touch();
            try {
                await this.schematic?.loadSection?.(projectData, /** @type {never} */ (prepared));
                if (!this.schematic) this.schematicDocument.load(projectData, /** @type {Parameters<SchematicDocument['load']>[1]} */ (prepared));
                await this.pcb?.loadSection?.(projectData.pcb || null, /** @type {never} */ (pcbPrepared));
                if (!this.pcb) this.pcbDocument.load(projectData.pcb || null, /** @type {Parameters<PcbDocument['load']>[1]} */ (pcbPrepared));
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
            await this.schematic?.clearSection?.();
            if (!this.schematic) this.schematicDocument.clear();
            await this.pcb?.clearSection?.();
            if (!this.pcb) this.pcbDocument.clear();
            // FileManager's JS default parameter infers empty-array literals; the serialized project is the same runtime shape.
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
            () => this.canSerialize(),
        );
    }

    // ── File lifecycle facade ─────────────────────────────────────────
    // Both editors' File menus call these so neither depends on the other.
    // The concrete implementation is injected by the UI-host view via
    // registerView({ lifecycle }), keeping `core` free of view imports.
    // Each first commits a number field still settling, so it is saved or
    // counted as unsaved rather than lost.

    /** Create a new blank document (prompts if unsaved). @returns {Promise<void>} */
    async newDocument() { flushSettledChanges(); await this._lifecycle.new?.(); }
    /** Open a document from disk (prompts if unsaved). @returns {Promise<void>} */
    async open() { flushSettledChanges(); await this._lifecycle.open?.(); }
    /** Re-open a file from the recents list (prompts if unsaved). @param {string} name @returns {Promise<void>} */
    async openRecent(name) { flushSettledChanges(); await this._lifecycle.openRecent?.(name); }
    /** Save the document, prompting for a location if needed. @returns {Promise<*>} */
    async save() { flushSettledChanges(); return this._lifecycle.save?.(); }
    /** Save the document to a new location. @returns {Promise<*>} */
    async saveAs() { flushSettledChanges(); return this._lifecycle.saveAs?.(); }
    /** Import an EasyEDA schematic into a fresh document. @returns {Promise<void>} */
    async importEasyEDA() { flushSettledChanges(); await this._lifecycle.importEasyEDA?.(); }
}
