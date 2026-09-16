export function* spatialPairs(items, bounds, margin = 0) {
    const ordered = items.map((item) => ({ item, bounds: bounds(item) }))
        .sort((left, right) => left.bounds.minX - right.bounds.minX);
    let active = [];
    for (const current of ordered) {
        active = active.filter((entry) => entry.bounds.maxX + margin >= current.bounds.minX);
        for (const entry of active) {
            if (entry.bounds.maxY + margin < current.bounds.minY
                || current.bounds.maxY + margin < entry.bounds.minY) continue;
            yield [entry.item, current.item];
        }
        active.push(current);
    }
}

export function* spatialCrossPairs(first, second, bounds, margin = 0) {
    const ordered = [first, second].flatMap((items, side) => items.map(item => ({ item, side, bounds: bounds(item) })))
        .sort((left, right) => left.bounds.minX - right.bounds.minX);
    const active = [[], []];
    for (const current of ordered) {
        const otherSide = 1 - current.side;
        active[otherSide] = active[otherSide].filter(entry => entry.bounds.maxX + margin >= current.bounds.minX);
        for (const entry of active[otherSide]) {
            if (entry.bounds.maxY + margin < current.bounds.minY
                || current.bounds.maxY + margin < entry.bounds.minY) continue;
            yield current.side === 0 ? [current.item, entry.item] : [entry.item, current.item];
        }
        active[current.side].push(current);
    }
}