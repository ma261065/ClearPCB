export function spatialClusterMST(clusters) {
    const parent = clusters.map((_, index) => index);
    const find = index => {
        while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
        return index;
    };
    const points = clusters.flatMap((cluster, owner) => cluster.map(point => ({ x: point.x, y: point.y, owner })));
    const build = (items, depth = 0) => {
        if (!items.length) return null;
        const axis = depth % 2 ? 'y' : 'x';
        items.sort((first, second) => first[axis] - second[axis]);
        const middle = items.length >> 1;
        const point = items[middle];
        const left = build(items.slice(0, middle), depth + 1);
        const right = build(items.slice(middle + 1), depth + 1);
        return { point, left, right, owner: -1,
            minX: Math.min(point.x, left?.minX ?? Infinity, right?.minX ?? Infinity),
            minY: Math.min(point.y, left?.minY ?? Infinity, right?.minY ?? Infinity),
            maxX: Math.max(point.x, left?.maxX ?? -Infinity, right?.maxX ?? -Infinity),
            maxY: Math.max(point.y, left?.maxY ?? -Infinity, right?.maxY ?? -Infinity) };
    };
    const tree = build(points);
    const label = node => {
        if (!node) return;
        label(node.left);
        label(node.right);
        node.owner = find(node.point.owner);
        if ((node.left && node.left.owner !== node.owner) || (node.right && node.right.owner !== node.owner)) node.owner = -1;
    };
    const boxDistance = (point, node) => {
        if (!node) return Infinity;
        const dx = Math.max(node.minX - point.x, 0, point.x - node.maxX);
        const dy = Math.max(node.minY - point.y, 0, point.y - node.maxY);
        return dx * dx + dy * dy;
    };
    const edges = [];
    while (edges.length < clusters.length - 1) {
        label(tree);
        const candidates = new Map();
        for (const point of points) {
            const owner = find(point.owner);
            let best = candidates.get(owner);
            const visit = node => {
                if (!node || node.owner === owner || boxDistance(point, node) >= (best?.distance ?? Infinity)) return;
                const target = node.point;
                if (find(target.owner) !== owner) {
                    const distance = (point.x - target.x) ** 2 + (point.y - target.y) ** 2;
                    if (distance < (best?.distance ?? Infinity)) best = { point, target, distance };
                }
                const leftDistance = boxDistance(point, node.left);
                const rightDistance = boxDistance(point, node.right);
                if (leftDistance <= rightDistance) { visit(node.left); visit(node.right); }
                else { visit(node.right); visit(node.left); }
            };
            visit(tree);
            if (best) candidates.set(owner, best);
        }
        let merged = false;
        for (const { point, target } of candidates.values()) {
            const first = find(point.owner), second = find(target.owner);
            if (first === second) continue;
            parent[first] = second;
            edges.push({ x1: point.x, y1: point.y, x2: target.x, y2: target.y });
            merged = true;
        }
        if (!merged) break;
    }
    return edges;
}