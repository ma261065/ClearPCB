/**
 * Convert a thrown value to the message shown to users.
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @param {string} name
 */
export function errorHasName(error, name) {
    if (error instanceof Error) return error.name === name;
    return !!error && typeof error === 'object' && 'name' in error && error.name === name;
}

/** @param {unknown} error */
export function isAbortError(error) {
    return errorHasName(error, 'AbortError')
        || !!error && typeof error === 'object' && 'code' in error && error.code === 20;
}
