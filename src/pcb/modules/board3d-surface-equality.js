export function surfaceInputsEqual(first, second) {
    if (Object.is(first, second)) return true;
    if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false;
    if (Array.isArray(first) !== Array.isArray(second)) return false;
    const keys = Object.keys(first);
    if (keys.length !== Object.keys(second).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(second, key)
        && surfaceInputsEqual(first[key], second[key]));
}