/** @typedef {{minX:number, minY:number, maxX:number, maxY:number}} Bounds */
/** @typedef {{item:any, bounds:Bounds, side?:0|1}} SpatialEntry */

/** @param {SpatialEntry[]} active @param {number} minX @param {number} margin */
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
 * @param {any[]} items
 * @param {(item:any) => Bounds} bounds
 * @returns {SpatialEntry[]}
 */
export function prepareSpatialOrder(items, bounds) {
    return items.map((item) => ({ item, bounds: bounds(item) }))
        .sort((left, right) => left.bounds.minX - right.bounds.minX);
}

/** Conservative query of a prepared order, retaining its original records and tie order. */
/** @param {SpatialEntry[]} ordered @param {Bounds} query @param {number} [margin] */
export function filterSpatialOrder(ordered, query, margin = 0) {
    /** @type {SpatialEntry[]} */
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
 * @param {any[]} items
 * @param {(item:any) => Bounds} bounds
 * @param {number} [margin]
 * @returns {Generator<[any, any], void, unknown>}
 */
export function* spatialPairs(items, bounds, margin = 0) {
    const ordered = prepareSpatialOrder(items, bounds);
    /** @type {SpatialEntry[]} */
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

/** @param {any[]} first @param {any[]} second @param {(item:any) => Bounds} bounds @param {number} [margin] */
export function spatialCrossPairs(first, second, bounds, margin = 0) {
    return crossPairs(first, second, margin, bounds);
}

/** Merge pre-sorted immutable inputs without boxing or sorting their items again. */
/** @param {SpatialEntry[]} first @param {SpatialEntry[]} second @param {number} [margin] */
export function spatialCrossPairsPrepared(first, second, margin = 0) {
    return crossPairs(first, second, margin, null, true);
}

/**
 * @param {any[]|SpatialEntry[]} first
 * @param {any[]|SpatialEntry[]|null} second
 * @param {number} margin
 * @param {((item:any) => Bounds)|null} bounds
 * @param {boolean} [prepared]
 * @returns {Generator<[any, any], void, unknown>}
 */
function* crossPairs(first, second, margin, bounds, prepared = false) {
    if (!prepared) {
        const getBounds = /** @type {(item:any) => Bounds} */ (bounds);
        first = [first, second].flatMap((items, side) => (items || []).map(item => ({ item, side: /** @type {0|1} */ (side), bounds: getBounds(item) })))
            .sort((left, right) => left.bounds.minX - right.bounds.minX);
        second = null;
    }
    first = /** @type {SpatialEntry[]} */ (first);
    second = /** @type {SpatialEntry[]|null} */ (second);
    /** @type {[SpatialEntry[], SpatialEntry[]]} */
    const active = [[], []];
    let firstIndex = 0, secondIndex = 0;
    while (firstIndex < first.length || (second && secondIndex < second.length)) {
        let current, side;
        if (second) {
            side = secondIndex >= second.length || (firstIndex < first.length
                && first[firstIndex].bounds.minX <= second[secondIndex].bounds.minX) ? 0 : 1;
            current = side === 0 ? first[firstIndex++] : second[secondIndex++];
        } else {
            current = first[firstIndex++];
            side = current.side;
        }
        const otherSide = 1 - side;
        retainActive(active[otherSide], current.bounds.minX, margin);
        for (const entry of active[otherSide]) {
            if (entry.bounds.maxY + margin < current.bounds.minY
                || current.bounds.maxY + margin < entry.bounds.minY) continue;
            yield side === 0 ? [current.item, entry.item] : [entry.item, current.item];
        }
        active[side].push(current);
    }
}