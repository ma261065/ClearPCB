/**
 * Selection view state handed to entity renderers. The editor's SelectionManager
 * implements it; NO_SELECTION draws previews and ghosts as unselected.
 * @typedef {{ isSelected(entity: any): boolean, isHovered(entity: any): boolean }} SelectionView
 */

/** @type {SelectionView} */
export const NO_SELECTION = Object.freeze({
    isSelected: () => false,
    isHovered: () => false,
});