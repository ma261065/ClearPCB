/**
 * Public services the schematic editor offers to schematic/modules — the counterpart
 * of pcb/modules/pcb-editor-api.js.
 *
 * Modules call another module's function directly when they need its behaviour, and
 * call these on the editor for what the editor itself owns: its Properties panel,
 * crosshair, dialogs, tool state, in-progress drawing/paste/placement, inline text
 * editing and the view hooks commands use. They are also the seams tests stub.
 * `tools/check-schematic-editor-access.mjs` ratchets the remaining private accesses
 * down; add a service here (and drop its underscore in SchematicApp) rather than
 * adding new ones. This module has no imports so tools can read the list cheaply.
 *
 * @typedef {import('../../shapes/shape.js').Shape} Shape
 * @typedef {object} SchematicEditorServices
 * @property {(selection?: object[]) => void} updatePropertiesPanel
 *   Rebuild the Properties panel for the given (default: current) selection.
 * @property {() => void} showCrosshair
 * @property {() => void} hideCrosshair
 * @property {(snapped: {x: number, y: number}, screenPos?: {x: number, y: number}) => void} updateCrosshair
 *   Move the snapped-cursor crosshair.
 * @property {(message: string, options?: object) => Promise<void>} alert
 * @property {(message: string, options?: object) => Promise<boolean>} confirm
 *   Modal dialogs; File actions use them on the UI host too.
 * @property {() => void} cancelDrawing
 * @property {() => void} cancelWireDrawing
 * @property {() => void} cancelComponentPlacement
 * @property {() => void} cancelPaste
 *   Abandon the in-progress shape, wire, component placement or paste preview.
 * @property {(shape: Shape) => void} startTextEdit
 * @property {(commit?: boolean) => void} endTextEdit
 * @property {(event: KeyboardEvent) => void} handleTextEditKey
 * @property {() => void} updateTextEditOverlay
 * @property {(screenPos: {x: number, y: number}) => void} setTextEditCaretFromScreen
 *   Inline text editing (value fields of passive components open a dialog instead).
 * @property {(tool: string, svg?: string) => void} setToolCursor
 * @property {(tool: string) => void} selectTool
 *   Switch tools and announce the change.
 * @property {(options: object) => void} updateToolOptions
 *   Merge and persist the current tool's options.
 * @property {(selection?: object[], toolId?: string) => void} updateShapePanelOptions
 * @property {() => void} copySelection
 * @property {() => void} updateSelectableItems
 *   Rebuild the selection manager's hit-test list after shapes or components change.
 * @property {() => void} updateShapeSelectionTip
 * @property {() => void} removeBoxSelectElement
 * @property {() => void} fitToContent
 * @property {(tabId: string) => void} setActiveRibbonTab
 *   Bring a ribbon tab to the front; a no-op before the ribbon is bound.
 * @property {(component: object, screenPos?: {x: number, y: number}, options?: object) => void} updateComponentCodeTooltip
 * @property {(shape: Shape, linkedWireLabelText?: string|null) => Shape} commandAddShape
 * @property {(shape: Shape, options?: object) => void} commandRemoveShape
 * @property {(shapesData: object[], linkedLabelData?: object[]) => void} commandDeleteShapes
 * @property {(shapesData: object[], linkedLabelData?: object[]) => void} commandRestoreShapes
 *   View hooks commands call to add, remove, delete and restore shapes without history.
 */

/**
 * The schematic editor as schematic/modules see it. Every module types its `app`
 * parameter with this (`@typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor`
 * at the top of the file), so the checker knows which editor members a module uses.
 * @typedef {import('../../ui/SchematicApp.js').default} SchematicEditor
 */

/** Service names, checked against SchematicApp by test-schematic-editor-api. */
export const SCHEMATIC_EDITOR_SERVICES = Object.freeze([
    'updatePropertiesPanel', 'showCrosshair', 'hideCrosshair', 'updateCrosshair', 'alert', 'confirm',
    'cancelDrawing', 'cancelWireDrawing', 'cancelComponentPlacement', 'cancelPaste',
    'startTextEdit', 'endTextEdit', 'handleTextEditKey', 'updateTextEditOverlay', 'setTextEditCaretFromScreen',
    'setToolCursor', 'selectTool', 'updateToolOptions', 'updateShapePanelOptions', 'copySelection',
    'updateSelectableItems', 'updateShapeSelectionTip', 'removeBoxSelectElement', 'fitToContent',
    'setActiveRibbonTab', 'updateComponentCodeTooltip', 'commandAddShape', 'commandRemoveShape', 'commandDeleteShapes',
    'commandRestoreShapes',
]);
