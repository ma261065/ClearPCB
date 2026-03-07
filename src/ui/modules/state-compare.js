/**
 * Snapshot/state comparison utilities.
 */

/**
 * Compare two captured states for semantic equality.
 *
 * @param {any} beforeState
 * @param {any} afterState
 * @returns {boolean}
 */
export function areCapturedStatesEqual(beforeState, afterState) {
    return JSON.stringify(beforeState) === JSON.stringify(afterState);
}
