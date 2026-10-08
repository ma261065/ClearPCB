/** @typedef {import('../../core/geometry.js').Point} Point */
/** @typedef {{supportsInlineEdit?: boolean, [key: string]: any}} EditableHit */

/**
 * @param {MouseEvent} event
 */
export function isUnmodifiedPrimaryDoublePress(event) {
    return event.button === 0 && event.detail === 2
        && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/**
 * @param {{hitTest(point: Point, all: true): EditableHit[]}} selection
 * @param {Point} point
 * @param {EventTarget|null} [eventTarget]
 * @returns {EditableHit|null}
 */
export function findInlineEditableHit(selection, point, eventTarget = null) {
    const directHit = eventTarget && /** @type {EventTarget & {__shape?: EditableHit}} */ (eventTarget).__shape;
    if (directHit?.supportsInlineEdit) return directHit;
    return selection.hitTest(point, true).find(shape => shape.supportsInlineEdit) || null;
}
