function retainActive(active, minX, margin) {
    let retained = 0;
    for (let index = 0; index < active.length; index++) {
        const entry = active[index];
        if (entry.bounds.maxX + margin >= minX) active[retained++] = entry;
    }
    active.length = retained;
}

/** Capture sorted records; retain them only while items and finite bounds stay unchanged. */
export function prepareSpatialOrder(items, bounds) {
    return items.map((item) => ({ item, bounds: bounds(item) }))
        .sort((left, right) => left.bounds.minX - right.bounds.minX);
}

/** Conservative query of a prepared order, retaining its original records and tie order. */
export function filterSpatialOrder(ordered, query, margin = 0) {
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

export function* spatialPairs(items, bounds, margin = 0) {
    const ordered = prepareSpatialOrder(items, bounds);
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

export function spatialCrossPairs(first, second, bounds, margin = 0) {
    return crossPairs(first, second, margin, bounds);
}

/** Merge pre-sorted immutable inputs without boxing or sorting their items again. */
export function spatialCrossPairsPrepared(first, second, margin = 0) {
    return crossPairs(first, second, margin, null, true);
}

function* crossPairs(first, second, margin, bounds, prepared = false) {
    if (!prepared) {
        first = [first, second].flatMap((items, side) => items.map(item => ({ item, side, bounds: bounds(item) })))
            .sort((left, right) => left.bounds.minX - right.bounds.minX);
        second = null;
    }
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