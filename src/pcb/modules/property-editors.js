/**
 * Owner of each PCB editor's Properties-panel editors ("bindings").
 *
 * A binding exposes `active`, `commit()`, `cancel()`, `dispose()` and
 * `affectsLayer(layerId)`. The module that
 * creates one claims its slot with setPropertyEditor and releases it on disposal with
 * releasePropertyEditor; everything else reads it with getPropertyEditor. State lives
 * here rather than on the editor so no other module can replace a binding behind its
 * owner's back. No imports, so worker-loaded export code can query it.
 */

/** Panel editors, in the order lifecycle cancellation and disposal visit them. */
export const PANEL_EDITOR_KINDS = Object.freeze(['text', 'component', 'pad', 'via', 'track', 'boardShape']);
/** Every slot: the panel editors plus the board-size fields. */
export const PROPERTY_EDITOR_KINDS = Object.freeze([...PANEL_EDITOR_KINDS, 'boardDimension']);

const KNOWN = new Set(PROPERTY_EDITOR_KINDS);
/** @type {WeakMap<object, Record<string, any>>} */
const editors = new WeakMap();

const checkKind = kind => {
    if (!KNOWN.has(kind)) throw new Error(`Unknown PCB property editor kind: ${kind}`);
};

/** @returns {any} The binding in `kind`'s slot, or null. */
export function getPropertyEditor(app, kind) {
    return editors.get(app)?.[kind] ?? null;
}

/** Claim `kind`'s slot for a binding (or clear it with null); returns the binding. */
export function setPropertyEditor(app, kind, binding) {
    checkKind(kind);
    let slots = editors.get(app);
    if (!slots) editors.set(app, slots = {});
    slots[kind] = binding ?? null;
    return binding;
}

/** Clear `kind`'s slot only if it still holds `binding` (a newer editor may own it). */
export function releasePropertyEditor(app, kind, binding) {
    checkKind(kind);
    const slots = editors.get(app);
    if (slots?.[kind] === binding) slots[kind] = null;
}

/** Whether any of `kinds` has a binding with an uncommitted preview. */
export function hasActivePropertyEditor(app, kinds = PROPERTY_EDITOR_KINDS) {
    const slots = editors.get(app);
    if (!slots) return false;
    for (const kind of kinds) if (slots[kind]?.active) return true;
    return false;
}

/** Commit each of `kinds`' bindings in order (an error stops the sequence). */
export function commitPropertyEditors(app, kinds) {
    for (const kind of kinds) getPropertyEditor(app, kind)?.commit();
}

/** Order in which hiding or locking a layer releases the panel editors on it. */
const LAYER_RELEASE_ORDER = Object.freeze(['track', 'boardShape', 'via', 'text', 'component', 'pad']);

/**
 * Visit the panel editors whose targets are on `layerId`. Each editor's
 * `affectsLayer` runs just before `action`, so an earlier release cannot stale it.
 * @param {(editor: any) => void} action
 */
export function eachPropertyEditorOnLayer(app, layerId, action) {
    for (const kind of LAYER_RELEASE_ORDER) {
        const editor = getPropertyEditor(app, kind);
        if (editor?.affectsLayer(layerId)) action(editor);
    }
}
