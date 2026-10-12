const batches = new WeakMap();

/**
 * @param {object} owner
 * @param {string} key
 * @param {() => void} update
 */
export function deferDerivedUpdate(owner, key, update) {
    const batch = batches.get(owner);
    if (!batch) return false;
    batch.pending.set(key, update);
    return true;
}

/**
 * @template T
 * @param {object|null|undefined} owner
 * @param {() => T} operation
 * @returns {T}
 */
export function batchDerivedUpdates(owner, operation) {
    if (!owner || batches.has(owner)) return operation();
    const batch = { pending: new Map() };
    batches.set(owner, batch);
    try {
        return operation();
    } finally {
        batches.delete(owner);
        for (const update of batch.pending.values()) update();
    }
}