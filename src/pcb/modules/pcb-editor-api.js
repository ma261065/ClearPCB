/**
 * Public services the PCB editor offers to pcb/modules.
 *
 * Modules call these on the editor instead of reaching into its `_`-prefixed members.
 * `tools/check-pcb-editor-access.mjs` ratchets the remaining private accesses down; add
 * a service here (and drop its underscore in PCBApp) rather than adding new ones.
 * This module has no imports so tools and workers can read the list cheaply.
 *
 * @typedef {object} PcbEditorServices
 * @property {(layerId: string) => SVGGElement} getLayerGroup
 *   SVG group for a layer or overlay, created on first use.
 * @property {() => ReadonlyMap<string, SVGGElement>} existingLayerGroups
 *   The layer and overlay groups created so far, without creating any.
 * @property {() => ReturnType<import('../../core/PcbDesignSettings.js').PcbDesignSettings['getRoutingParams']>} getRoutingParams
 *   Canonical millimetre design rules, independent of ribbon display rounding.
 * @property {() => void} refreshFills
 *   Schedule a coalesced recompute and redraw of every copper pour.
 * @property {() => void} refreshClearanceHalos
 *   Redraw clearance halos when they are visible.
 * @property {(opts?: {nets?: Iterable<string>}) => void} updateRatsnest
 *   Rebuild ratlines, optionally only for the given nets.
 * @property {(options?: {geometryChanged?: boolean}) => void} updateCopperCuts
 *   Rebuild the per-side copper-removal clip paths.
 * @property {(id: string) => void} refreshText
 *   Re-render one free text in place.
 * @property {() => boolean} isBoardOutlineDrawn
 *   Whether the board outline is ready for page and browser-test readiness checks.
 * @property {(fill: object|null) => void} selectFill
 *   Select (or clear) the focused copper pour.
 * @property {() => void} clearProperties
 *   Reset the Properties panel.
 * @property {(text: string) => void} setStatus
 *   Show a transient status-bar message.
 * @property {(message: string, options?: {title?: string}) => Promise<void>} alert
 *   Show a modal message (the schematic editor offers the same).
 * @property {() => void} setPcbStatus
 *   Refresh the tool/layer mode indicator.
 * @property {() => void} syncClipboardButtons
 *   Enable or disable the clipboard buttons for the current selection.
 * @property {() => HTMLElement|null} propertiesItems
 *   The Properties panel's item container, cleared of component-only sections.
 * @property {(title: string, owner?: object|null) => void} setPropertiesTitle
 *   Title the Properties panel (disposing editors bound to another object).
 * @property {() => void} showPropertiesTab
 *   Bring the Properties ribbon tab to the front.
 * @property {(tabId: string) => void} setActiveRibbonTab
 *   Bring any ribbon tab to the front; a no-op before the ribbon is bound.
 * @property {(panel: import('../../shared/ui/property-fields.js').PropertyPanel, owner?: object|null) => boolean} openPropertyPanel
 *   Show a Properties panel description, releasing the previous panel's editors.
 * @property {(panel: import('../../shared/ui/property-fields.js').PropertyPanel) => void} refreshPropertyPanel
 *   Re-render the open panel from a fresh description, keeping its editors and focus.
 * @property {() => string[]} netNames
 *   Every net on the board or in the netlist, for the Net menu.
 * @property {(layer: string) => string} layerLabel
 *   The layer panel's name for a PCB layer.
 * @property {() => void} fitToContent
 *   Fit the view to the board (or panel preview); shared viewport controls call it on either editor.
 * @property {(text: object|null) => void} selectText
 *   Select (or clear) one free text.
 * @property {(text: object) => void} showTextProperties
 *   Show a free text's Properties panel, aware of an inline edit in progress.
 * @property {() => void} selectAll
 *   Select every selectable, unlocked object on visible layers.
 * @property {(compId: string, dir: 'L'|'R') => void} rotateComponent
 * @property {(compId: string, axis: 'H'|'V') => void} flipComponent
 *   Rotate or flip a placed component (undoable; locked parts are left alone).
 * @property {(compId: string) => void} rotateRefText
 *   Rotate a component's reference designator by 90 degrees.
 * @property {(compId: string) => void} showComponentProperties
 *   Show a placed component's Properties panel.
 * @property {(event: MouseEvent) => {x: number, y: number}} screenToWorld
 *   Convert a pointer event to world coordinates using the viewport's cached SVG rect.
 * @property {(point: {x: number, y: number}) => {x: number, y: number}} snapToGrid
 *   Snap a world point to the PCB viewport grid.
 * @property {() => void} ensureViewport
 *   Create the canvas viewport on first use (loading may render before the tab is shown).
 * @property {() => void} markDirty
 *   Flag a PCB edit: cancels a running route, notifies the project and refreshes
 *   the panel preview, clearance halos and DRC.
 * @property {(message?: string|null) => void} cancelAutoRoute
 *   Stop a running autoroute, optionally saying why in the status bar.
 * @property {() => void} applyPlacementOverrides
 *   Restore saved placement overrides onto the rendered footprints.
 * @property {(compId: string|null) => void} selectComponent
 *   Select (or clear) one placed component.
 * @property {(pad: object) => void} showPadProperties
 *   Show a standalone pad's Properties panel.
 * @property {(entries: Array<{kind: string, object: any}>) => void} showMultiSelectionProperties
 *   Show the editable intersection of properties for a multi-selection.
 * @property {() => void} refreshSelectionHighlights
 *   Redraw the selection halos and lock overlays after an externally driven edit.
 */

/**
 * The PCB editor as pcb/modules see it. Every module types its `app` parameter with this
 * (`@typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor` at the top of the file),
 * so the checker knows which editor members a module uses.
 * @typedef {import('../../ui/PCBApp.js').default} PcbEditor
 */

/**
 * A board as plain collections: what board computations (DRC, copper connectivity, the
 * 2D, 3D and Gerber builders) read. The editor is one; a worker's detached snapshot or a
 * filtered copy is another, so those functions take this rather than the whole editor.
 * Any collection may be missing, and they read each with a fallback.
 * @typedef {Partial<Pick<PcbEditor, 'tracks'|'vias'|'pads'|'texts'|'boardShapes'|'copperFills'|'placements'|'netlist'>>} PcbBoard
 */

const editorActive = new WeakMap();

/**
 * Set whether the PCB editor is the active (visible) tab.
 * @param {PcbEditor} app
 * @param {boolean} active
 */
export function setEditorActive(app, active) {
    editorActive.set(app, !!active);
}

/**
 * Whether the PCB editor is the active (visible) tab. Editors and fixtures that
 * never set the flag count as active; only an explicitly deactivated editor is not.
 * @param {PcbEditor} app
 */
export const isEditorActive = app => editorActive.get(app) !== false;

const editorStale = new WeakMap();

/**
 * Set whether the PCB must be rebuilt from the schematic before it is next shown.
 * @param {PcbEditor} app
 * @param {boolean} stale
 */
export function setEditorStale(app, stale) {
    editorStale.set(app, !!stale);
}

/**
 * Whether the PCB must be rebuilt from the schematic before it is next shown.
 * Editors and fixtures that never set the flag are up to date.
 * @param {PcbEditor} app
 */
export const isEditorStale = app => editorStale.get(app) === true;

/** Service names, checked against PCBApp by test-pcb-editor-api. */
export const PCB_EDITOR_SERVICES = Object.freeze([
    'getLayerGroup', 'existingLayerGroups', 'getRoutingParams', 'refreshFills', 'refreshClearanceHalos', 'updateRatsnest',
    'updateCopperCuts', 'refreshText', 'isBoardOutlineDrawn', 'selectFill', 'clearProperties',
    'setStatus', 'alert', 'setPcbStatus', 'syncClipboardButtons', 'propertiesItems', 'setPropertiesTitle', 'showPropertiesTab',
    'openPropertyPanel', 'refreshPropertyPanel', 'netNames', 'layerLabel', 'fitToContent', 'setActiveRibbonTab',
    'selectText', 'showTextProperties', 'selectAll', 'rotateComponent', 'flipComponent', 'rotateRefText',
    'showComponentProperties', 'screenToWorld', 'snapToGrid', 'ensureViewport', 'markDirty', 'cancelAutoRoute',
    'applyPlacementOverrides', 'selectComponent', 'showPadProperties', 'showMultiSelectionProperties',
    'refreshSelectionHighlights',
]);
