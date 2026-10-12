/**
 * @param {unknown} first
 * @param {unknown} second
 * @param {WeakMap<object, WeakMap<object, boolean>>} [seen]
 * @returns {boolean}
 */
export function surfaceInputsEqual(first, second, seen = new WeakMap()) {
    if (Object.is(first, second)) return true;
    if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false;
    if (Array.isArray(first) !== Array.isArray(second)) return false;
    const matches = seen.get(first);
    if (matches?.has(second)) return matches.get(second) === true;
    let equal;
    if (Array.isArray(first)) {
        const firstArray = /** @type {unknown[]} */ (first);
        const secondArray = /** @type {unknown[]} */ (second);
        equal = firstArray.length === secondArray.length;
        for (let index = 0; equal && index < firstArray.length; index++) {
            equal = surfaceInputsEqual(firstArray[index], secondArray[index], seen);
        }
    } else {
        const firstRecord = /** @type {Record<string, unknown>} */ (first);
        const secondRecord = /** @type {Record<string, unknown>} */ (second);
        const keys = Object.keys(firstRecord);
        if (keys.length !== Object.keys(secondRecord).length) equal = false;
        else {
            // A moved hole invalidates a surface regardless of its mesh. Check
            // that compact list before traversing potentially millions of mesh
            // coordinates, even though parts are constructed mesh-first.
            const holesIndex = keys.indexOf('holes');
            if (holesIndex > 0) keys.unshift(...keys.splice(holesIndex, 1));
            equal = keys.every((key) => Object.prototype.hasOwnProperty.call(secondRecord, key)
                && surfaceInputsEqual(firstRecord[key], secondRecord[key], seen));
        }
    }
    const proven = matches || new WeakMap();
    proven.set(second, equal);
    if (!matches) seen.set(first, proven);
    return equal;
}