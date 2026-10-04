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
 * @property {(fill: object|null) => void} selectFill
 *   Select (or clear) the focused copper pour.
 * @property {() => void} refreshSelectedDRCMarker
 *   Reposition the highlighted design-rule marker.
 * @property {() => void} clearProperties
 *   Reset the Properties panel.
 * @property {(text: string) => void} setStatus
 *   Show a transient status-bar message.
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
 * @property {(current?: string) => {escape: (value: string) => string, options: string}} toolNetOptions
 *   HTML for the shared Net picker menu, with an escape helper.
 * @property {(items: HTMLElement, inputId: string, onChange: (net: string) => void) => void} bindToolNetControl
 *   Wire a Net input and its picker menu to a callback.
 * @property {(layer: string) => string} layerLabel
 *   Display name of a PCB layer.
 * @property {() => void} fitToContent
 *   Fit the view to the board (or panel preview); shared viewport controls call it on either editor.
 * @property {(text: object|null) => void} selectText
 *   Select (or clear) one free text.
 * @property {(text: object) => void} showTextProperties
 *   Show a free text's Properties panel, aware of an inline edit in progress.
 */

/**
 * Whether the PCB editor is the active (visible) tab. Editors and fixtures that
 * never set the flag count as active; only an explicitly deactivated editor is not.
 * @param {any} app
 */
export const isEditorActive = app => app._active !== false;

/** Service names, checked against PCBApp by test-pcb-editor-api. */
export const PCB_EDITOR_SERVICES = Object.freeze([
    'getLayerGroup', 'getRoutingParams', 'refreshFills', 'refreshClearanceHalos', 'updateRatsnest',
    'updateCopperCuts', 'refreshText', 'selectFill', 'refreshSelectedDRCMarker', 'clearProperties',
    'setStatus', 'setPcbStatus', 'syncClipboardButtons', 'propertiesItems', 'setPropertiesTitle', 'showPropertiesTab',
    'toolNetOptions', 'bindToolNetControl', 'layerLabel', 'fitToContent', 'setActiveRibbonTab',
    'selectText', 'showTextProperties',
]);
