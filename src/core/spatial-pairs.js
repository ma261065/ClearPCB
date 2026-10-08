/** @typedef {{minX:number, minY:number, maxX:number, maxY:number}} Bounds */
/** @template T @typedef {{item:T, bounds:Bounds, side?:0|1}} SpatialEntry<T> */

/** @template T @param {SpatialEntry<T>[]} active @param {number} minX @param {number} margin */
function retainActive(active, minX, margin) {
    let retained = 0;
    for (let index = 0; index < active.length; index++) {
        const entry = active[index];
        if (entry.bounds.maxX + margin >= minX) active[retained++] = entry;
    }
    active.length = retained;
}

/** Capture sorted records; retain them only while items and finite bounds stay unchanged. */
/**
 * @template T
 * @param {T[]} items
 * @param {(item:T) => Bounds} bounds
 * @returns {SpatialEntry<T>[]}
 */
export function prepareSpatialOrder(items, bounds) {
    return items.map((item) => ({ item, bounds: bounds(item) }))
        .sort((left, right) => left.bounds.minX - right.bounds.minX);
}

/** Conservative query of a prepared order, retaining its original records and tie order. */
/** @template T @param {SpatialEntry<T>[]} ordered @param {Bounds} query @param {number} [margin] */
export function filterSpatialOrder(ordered, query, margin = 0) {
    /** @type {SpatialEntry<T>[]} */
    const candidates = [];
    for (const entry of ordered) {
        const bounds = entry.bounds;
        if (bounds.minX > query.maxX + margin) break;
        if (bounds.maxX + margin < query.minX || bounds.maxY + margin < query.minY
            || query.maxY + margin < bounds.minY) continue;
        candidates.push(entry);
    }
    return candidates;
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item:T) => Bounds} bounds
 * @param {number} [margin]
 * @returns {Generator<[T, T], void, unknown>}
 */
export function* spatialPairs(items, bounds, margin = 0) {
    const ordered = prepareSpatialOrder(items, bounds);
    /** @type {SpatialEntry<T>[]} */
    const active = [];
    for (const current of ordered) {
        retainActive(active, current.bounds.minX, margin);
        for (const entry of active) {
            if (entry.bounds.maxY + margin < current.bounds.minY
                || current.bounds.maxY + margin < entry.bounds.minY) continue;
            yield [entry.item, current.item];
        }
        active.push(current);
    }
}

/** @template T,U @param {T[]} first @param {U[]} second @param {(item:T|U) => Bounds} bounds @param {number} [margin] @returns {Generator<[T, U], void, unknown>} */
export function spatialCrossPairs(first, second, bounds, margin = 0) {
    return /** @type {Generator<[T, U], void, unknown>} */ (crossPairs(
        /** @type {Array<T|U>} */ (first),
        /** @type {Array<T|U>} */ (second),
        margin,
        bounds
    ));
}

/** Merge pre-sorted immutable inputs without boxing or sorting their items again. */
/** @template T @param {SpatialEntry<T>[]} first @param {SpatialEntry<T>[]} second @param {number} [margin] */
export function spatialCrossPairsPrepared(first, second, margin = 0) {
    return crossPairsPrepared(first, second, margin);
}

/**
 * @template T
 * @param {SpatialEntry<T>[]} first
 * @param {SpatialEntry<T>[]} second
 * @param {number} margin
 * @returns {Generator<[T, T], void, unknown>}
 */
function* crossPairsPrepared(first, second, margin) {
    /** @type {[SpatialEntry<T>[], SpatialEntry<T>[]]} */
    const active = [[], []];
    let firstIndex = 0, secondIndex = 0;
    while (firstIndex < first.length || secondIndex < second.length) {
        const side = secondIndex >= second.length || (firstIndex < first.length
            && first[firstIndex].bounds.minX <= second[secondIndex].bounds.minX) ? 0 : 1;
        const current = side === 0 ? first[firstIndex++] : second[secondIndex++];
        const otherSide = /** @type {0|1} */ (1 - side);
        retainActive(active[otherSide], current.bounds.minX, margin);
        for (const entry of active[otherSide]) {
            if (entry.bounds.maxY + margin < current.bounds.minY
                || current.bounds.maxY + margin < entry.bounds.minY) continue;
            yield side === 0 ? [current.item, entry.item] : [entry.item, current.item];
        }
        active[side].push(current);
    }
}

/**
 * @template T
 * @param {T[]|SpatialEntry<T>[]} first
 * @param {T[]|SpatialEntry<T>[]|null} second
 * @param {number} margin
 * @param {((item:T) => Bounds)|null} bounds
 * @param {boolean} [prepared]
 * @returns {Generator<[T, T], void, unknown>}
 */
function* crossPairs(first, second, margin, bounds, prepared = false) {
    /** @type {SpatialEntry<T>[]} */
    let orderedFirst;
    /** @type {SpatialEntry<T>[]|null} */
    let orderedSecond;
    if (!prepared) {
        const getBounds = /** @type {(item:T) => Bounds} */ (bounds);
        orderedFirst = [/** @type {T[]} */ (first), /** @type {T[]|null} */ (second)]
            .flatMap((items, side) => (items || []).map(item => ({ item, side: /** @type {0|1} */ (side), bounds: getBounds(item) })))
            .sort((left, right) => left.bounds.minX - right.bounds.minX);
        orderedSecond = null;
    } else {
        orderedFirst = /** @type {SpatialEntry<T>[]} */ (first);
        orderedSecond = /** @type {SpatialEntry<T>[]|null} */ (second);
    }
    /** @type {[SpatialEntry<T>[], SpatialEntry<T>[]]} */
    const active = [[], []];
    let firstIndex = 0, secondIndex = 0;
    while (firstIndex < orderedFirst.length || (orderedSecond && secondIndex < orderedSecond.length)) {
        let current, side;
        if (orderedSecond) {
            side = secondIndex >= orderedSecond.length || (firstIndex < orderedFirst.length
                && orderedFirst[firstIndex].bounds.minX <= orderedSecond[secondIndex].bounds.minX) ? 0 : 1;
            current = side === 0 ? orderedFirst[firstIndex++] : orderedSecond[secondIndex++];
        } else {
            current = orderedFirst[firstIndex++];
            side = current.side ?? 0;
        }
        const otherSide = /** @type {0|1} */ (1 - side);
        retainActive(active[otherSide], current.bounds.minX, margin);
        for (const entry of active[otherSide]) {
            if (entry.bounds.maxY + margin < current.bounds.minY
                || current.bounds.maxY + margin < entry.bounds.minY) continue;
            yield side === 0 ? [current.item, entry.item] : [entry.item, current.item];
        }
        active[side].push(current);
    }
}