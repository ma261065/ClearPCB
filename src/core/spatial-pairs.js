function retainActive(active, minX, margin) {
    let retained = 0;
    for (let index = 0; index < active.length; index++) {
        const entry = active[index];
        if (entry.bounds.maxX + margin >= minX) active[retained++] = entry;
    }
    active.length = retained;
}

export function* spatialPairs(items, bounds, margin = 0) {
    const ordered = items.map((item) => ({ item, bounds: bounds(item) }))
        .sort((left, right) => left.bounds.minX - right.bounds.minX);
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

export function* spatialCrossPairs(first, second, bounds, margin = 0) {
    const ordered = [first, second].flatMap((items, side) => items.map(item => ({ item, side, bounds: bounds(item) })))
        .sort((left, right) => left.bounds.minX - right.bounds.minX);
    const active = [[], []];
    for (const current of ordered) {
        const otherSide = 1 - current.side;
        retainActive(active[otherSide], current.bounds.minX, margin);
        for (const entry of active[otherSide]) {
            if (entry.bounds.maxY + margin < current.bounds.minY
                || current.bounds.maxY + margin < entry.bounds.minY) continue;
            yield current.side === 0 ? [current.item, entry.item] : [entry.item, current.item];
        }
        active[current.side].push(current);
    }
}