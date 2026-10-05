/**
 * Schematic lock ownership. A field text that belongs to another object (a
 * component's reference or value, a wire's name, a net label's text) has no lock
 * of its own: it follows its owner's, as a PCB reference designator follows its
 * component. Free texts and detachable labels keep their own lock.
 */

/** The object whose `locked` flag governs `item`. */
export function lockOwner(item) {
    const owner = item?.parentComponent;
    return owner && item.fieldKey && item.fieldKey !== 'label' && typeof owner.locked === 'boolean'
        ? owner : item;
}

/** Whether `item` is locked, by its own lock or its owner's. */
export function isSchematicLocked(item) {
    return !!lockOwner(item)?.locked;
}

/** Whether `item` carries its own lock (owned field texts do not). */
export function hasOwnLock(item) {
    return !!item && lockOwner(item) === item && typeof item.locked === 'boolean';
}
