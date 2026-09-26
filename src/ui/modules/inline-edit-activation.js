export function isUnmodifiedPrimaryDoublePress(event) {
    return event.button === 0 && event.detail === 2
        && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function findInlineEditableHit(selection, point, eventTarget = null) {
    const directHit = eventTarget?.__shape;
    if (directHit?.supportsInlineEdit) return directHit;
    return selection.hitTest(point, true).find(shape => shape.supportsInlineEdit) || null;
}
