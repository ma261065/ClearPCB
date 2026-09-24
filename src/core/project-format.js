const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function defaultPcbStackup() {
    return { copperLayers: ['top-copper', 'bottom-copper'] };
}

export function validatePcbStackup(pcb) {
    if (pcb?.stackup !== undefined && !record(pcb.stackup)) throw new Error('Invalid PCB stackup.');
    const layers = pcb?.stackup === undefined ? defaultPcbStackup().copperLayers : pcb.stackup.copperLayers;
    if (!Array.isArray(layers) || layers.length < 2 || layers[0] !== 'top-copper'
        || layers[layers.length - 1] !== 'bottom-copper' || new Set(layers).size !== layers.length
        || layers.slice(1, -1).some(layer => typeof layer !== 'string' || !/^inner-copper-[1-9]\d*$/.test(layer))) {
        throw new Error('Invalid ordered PCB copper layers.');
    }
    for (const field of ['tracks', 'boardShapes', 'texts', 'fills']) {
        if (!Array.isArray(pcb?.[field])) continue;
        for (const item of pcb[field]) {
            const references = [item?.l, item?.layer, ...Object.values(item?.el || item?.edgeLayers || {})];
            for (const layer of references) {
                if (typeof layer === 'string' && layer.includes('copper') && !layers.includes(layer)) {
                    throw new Error(`Undeclared PCB copper layer: ${layer}`);
                }
            }
        }
    }
    if (Array.isArray(pcb?.vias)) {
        for (const via of pcb.vias) {
            if (via?.span === undefined) continue;
            if (!record(via.span) || !layers.includes(via.span.from) || !layers.includes(via.span.to)
                || layers.indexOf(via.span.from) >= layers.indexOf(via.span.to)) {
                throw new Error('Invalid via copper-layer span.');
            }
        }
    }
    return layers;
}

export function assertSupportedPcb(pcb) {
    const layers = validatePcbStackup(pcb);
    if (layers.length !== 2) {
        throw new Error('This project uses multiple copper layers. This editor currently supports only two-layer boards.');
    }
}

export function validateEditableProject(data) {
    validateProject(data);
    assertSupportedPcb(data.pcb);
    return data;
}

export function repairDuplicateTrackIds(data) {
    const tracks = data?.pcb?.tracks;
    if (!Array.isArray(tracks)) return { data, count: 0 };
    const seen = new Set();
    const duplicates = [];
    tracks.forEach((track, index) => {
        if (!track?.id) return;
        if (seen.has(track.id)) duplicates.push(index);
        seen.add(track.id);
    });
    if (!duplicates.length) return { data, count: 0 };
    for (const shape of data.schematic?.shapes || []) if (shape?.id) seen.add(shape.id);
    const repaired = structuredClone(data);
    let next = 1;
    for (const index of duplicates) {
        while (seen.has(`shape_${next}`)) next++;
        const id = `shape_${next++}`;
        repaired.pcb.tracks[index].id = id;
        seen.add(id);
    }
    return { data: repaired, count: duplicates.length };
}

export function validateProject(data) {
    if (!record(data) || data.type !== 'clearpcb-project' || data.version !== '1.0') {
        throw new Error('Unsupported ClearPCB project format or version.');
    }
    if (!record(data.schematic)) throw new Error('Missing schematic section.');
    if (data.pcb != null && !record(data.pcb)) throw new Error('Invalid PCB section.');
    validatePcbStackup(data.pcb);
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