/**
 * Quiet stand-ins for the schematic editor methods that modules call, for tests that
 * build a plain-object editor instead of a SchematicApp. Modules call these methods
 * directly (test-schematic-editor-api forbids `app.method?.()`), so a fake needs every
 * one it reaches. Each stub returns undefined, as the optional call did when a fake
 * lacked the method. Spread the stubs first and override what a test observes:
 * `{ ...schematicEditorStubs(), updatePropertiesPanel: () => calls++ }`.
 */
import { SCHEMATIC_EDITOR_SERVICES } from '../../../src/schematic/modules/schematic-editor-api.js';

/** Editor methods modules call that are not in the service list. */
const MODULE_CALLED_METHODS = ['isSectionEditing', 'openRecentFile', 'showSaveToast', 'clearComponentCaches'];

const quiet = () => undefined;

/** @returns {Record<string, Function>} */
export function schematicEditorStubs() {
    return Object.fromEntries([...SCHEMATIC_EDITOR_SERVICES, ...MODULE_CALLED_METHODS].map(name => [name, quiet]));
}
