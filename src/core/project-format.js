const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateProject(data) {
    if (!record(data) || data.type !== 'clearpcb-project' || data.version !== '2.0') {
        throw new Error('Unsupported ClearPCB project format or version.');
    }
    if (!record(data.schematic)) throw new Error('Missing schematic section.');
    if (data.pcb != null && !record(data.pcb)) throw new Error('Invalid PCB section.');
    for (const [section, fields] of [[data.schematic, ['shapes', 'components']],
        [data.pcb, ['tracks', 'vias', 'boardShapes', 'texts', 'fills']]]) {
        if (!section) continue;
        for (const field of fields) {
            const items = section[field];
            if (items === undefined) continue;
            if (!Array.isArray(items) || items.some((item) => !record(item))) {
                throw new Error(`Invalid project collection: ${field}`);
            }
            const ids = new Set();
            for (const item of items) {
                if (item.id && ids.has(item.id)) throw new Error(`Duplicate ${field} id: ${item.id}`);
                if (item.id) ids.add(item.id);
                const nodes = item.nd || item.graphNodes;
                const edges = item.ed || item.graphEdges;
                if (nodes && !record(nodes)) throw new Error(`Invalid nodes in ${field}`);
                if (edges && !record(edges)) throw new Error(`Invalid edges in ${field}`);
                for (const node of Object.values(nodes || {})) {
                    const coordinates = Array.isArray(node) ? node.slice(0, 2) : [node?.x, node?.y];
                    if (coordinates.length !== 2 || !coordinates.every(Number.isFinite)) {
                        throw new Error(`Invalid graph coordinates in ${field}`);
                    }
                }
                for (const edge of Object.values(edges || {})) {
                    const from = Array.isArray(edge) ? edge[0] : edge?.from;
                    const to = Array.isArray(edge) ? edge[1] : edge?.to;
                    if (!nodes || !Object.prototype.hasOwnProperty.call(nodes, from) || !Object.prototype.hasOwnProperty.call(nodes, to)) {
                        throw new Error(`Dangling graph edge in ${field}`);
                    }
                }
            }
        }
    }
    for (const section of [data.schematic, data.pcb]) {
        for (const key of ['defs', 'settings', 'placements', 'design', 'board']) {
            if (section?.[key] != null && !record(section[key])) throw new Error(`Invalid ${key}`);
        }
        for (const key of ['defs', 'placements']) {
            if (Object.values(section?.[key] || {}).some((item) => !record(item))) {
                throw new Error(`Invalid ${key} entry`);
            }
        }
    }
    const stack = [data];
    const visited = new Set();
    while (stack.length) {
        const value = stack.pop();
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite project coordinate.');
        if (value && typeof value === 'object' && !visited.has(value)) {
            visited.add(value);
            for (const child of Object.values(value)) stack.push(child);
        }
    }
    return data;
}