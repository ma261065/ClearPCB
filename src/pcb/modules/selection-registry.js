/**
 * Unified PCB multi-selection registry.
 *
 * The registry uses the shared schematic SelectionManager and exposes typed
 * original PCB objects to PCB-specific render, move, and command code.
 */

import { SelectionManager } from '../../core/SelectionManager.js';

const keyFor = (kind, object) => `${kind}:${kind === 'component' || kind === 'reftext' ? object : object.id}`;
const adapterFactories = new Map();

/** Register a factory implementing the SelectionManager shape contract. */
export function registerPcbSelectionAdapter(kind, factory) {
    adapterFactories.set(kind, factory);
}

function manager(app) {
    if (!app._pcbSelection) {
        app._pcbSelection = new SelectionManager({
            getScale: () => app.viewport?.scale || 1,
        });
    }
    return app._pcbSelection;
}

function adapter(app, kind, object) {
    const factory = adapterFactories.get(kind);
    if (factory) return factory(app, object, keyFor(kind, object));
    return {
        id: keyFor(kind, object),
        kind,
        object,
        visible: true,
        getBounds() { return { minX: 0, minY: 0, maxX: 0, maxY: 0 }; },
        hitTest() { return false; },
        invalidate() {},
    };
}

function entries(app) {
    const out = [];
    for (const [id] of app.placements || []) out.push(adapter(app, 'component', id));
    for (const track of app.tracks || []) out.push(adapter(app, 'track', track));
    for (const via of app.vias || []) out.push(adapter(app, 'via', via));
    for (const shape of app.boardShapes || []) {
        if (shape?.type === 'fill') out.push(adapter(app, 'fill', shape));
        else out.push(adapter(app, 'shape', shape));
    }
    for (const text of app.texts?.values?.() || []) out.push(adapter(app, 'text', text));
    for (const [componentId, placement] of app.placements || []) {
        if (placement?.refVisible !== false) out.push(adapter(app, 'reftext', componentId));
    }
    return out;
}

/** Synchronize current PCB model entities while retaining selected keys. */
export function syncPcbSelection(app) {
    const selection = manager(app);
    const selected = new Set(selection.selected);
    selection.setShapes(entries(app));
    selection.selected = new Set([...selected].filter((id) => selection._getShape(id)));
    for (const item of selection.shapes) item.selected = selection.selected.has(item.id);
    selection._selectionCache = null;
}

export function setPcbSelection(app, values) {
    syncPcbSelection(app);
    manager(app).selectMultiple(values.map(({ kind, object }) => keyFor(kind, object)));
}

export function togglePcbSelection(app, kind, object) {
    syncPcbSelection(app);
    manager(app).toggle(keyFor(kind, object));
}

export function clearPcbSelection(app) {
    manager(app).clearSelection();
}

export function getPcbSelection(app, kind = null) {
    return manager(app).getSelection()
        .filter((item) => !kind || item.kind === kind)
        .map((item) => item.object);
}

/** Return selected adapters when the caller needs both kind and object. */
export function getPcbSelectionEntries(app) {
    return manager(app).getSelection();
}

/** Hit test an adapter kind through the shared selection ordering rules. */
export function hitTestPcbSelection(app, point, kind = null) {
    syncPcbSelection(app);
    const hits = manager(app).hitTest(point, true);
    const hit = kind ? hits.find((item) => item.kind === kind) : hits[0];
    return hit?.object || null;
}

/** Return the topmost adapter belonging to one of the requested kinds. */
export function hitTestPcbSelectionEntry(app, point, kinds) {
    syncPcbSelection(app);
    const allowed = new Set(kinds);
    const hits = manager(app).hitTest(point, true).filter((item) => allowed.has(item.kind));
    // Copper targets have always won when they overlap graphics or pads.
    // Keep that established PCB picking order as tracks join the registry.
    return hits.find((item) => item.kind === 'via')
        || hits.find((item) => item.kind === 'track')
        || hits.find((item) => item.kind === 'text')
        || hits.find((item) => item.kind === 'reftext')
        || hits[0]
        || null;
}

export function hasPcbSelection(app) {
    return manager(app).count > 0;
}

export function isPcbSelected(app, kind, object) {
    return !!object && manager(app).isSelected(keyFor(kind, object));
}
