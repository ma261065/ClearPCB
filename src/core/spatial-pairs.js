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