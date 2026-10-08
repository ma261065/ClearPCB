/**
 * Selection view state handed to entity renderers. The editor's SelectionManager
 * implements it; NO_SELECTION draws previews and ghosts as unselected.
 * @typedef {{ isSelected(entity: unknown): boolean, isHovered(entity: unknown): boolean,
 *   lockPointer?: {x: number, y: number} | null }} SelectionView
 *   `lockPointer` is where the last selecting press landed; lock icons sit beside the
 *   part of a locked object nearest it.
 */

/** @type {SelectionView} */
export const NO_SELECTION = Object.freeze({
    isSelected: () => false,
    isHovered: () => false,
});