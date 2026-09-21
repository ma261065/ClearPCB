export function surfaceInputsEqual(first, second, seen = new WeakMap()) {
    if (Object.is(first, second)) return true;
    if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false;
    if (Array.isArray(first) !== Array.isArray(second)) return false;
    const matches = seen.get(first);
    if (matches?.has(second)) return matches.get(second);
    let equal;
    if (Array.isArray(first)) {
        equal = first.length === second.length;
        for (let index = 0; equal && index < first.length; index++) {
            equal = surfaceInputsEqual(first[index], second[index], seen);
        }
    } else {
        const keys = Object.keys(first);
        if (keys.length !== Object.keys(second).length) equal = false;
        else {
            // A moved hole invalidates a surface regardless of its mesh. Check
            // that compact list before traversing potentially millions of mesh
            // coordinates, even though parts are constructed mesh-first.
            const holesIndex = keys.indexOf('holes');
            if (holesIndex > 0) keys.unshift(...keys.splice(holesIndex, 1));
            equal = keys.every((key) => Object.prototype.hasOwnProperty.call(second, key)
                && surfaceInputsEqual(first[key], second[key], seen));
        }
    }
    const proven = matches || new WeakMap();
    proven.set(second, equal);
    if (!matches) seen.set(first, proven);
    return equal;
}