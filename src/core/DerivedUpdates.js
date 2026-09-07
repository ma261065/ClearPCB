const batches = new WeakMap();

export function deferDerivedUpdate(owner, key, update) {
    const batch = batches.get(owner);
    if (!batch) return false;
    batch.pending.set(key, update);
    return true;
}

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