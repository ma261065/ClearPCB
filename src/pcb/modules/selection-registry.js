/**
 * Unified PCB multi-selection registry.
 *
 * The registry uses the shared schematic SelectionManager and exposes typed
 * original PCB objects to PCB-specific render, move, and command code.
 */

import { SelectionManager } from '../../core/SelectionManager.js';

const keyFor = (kind, object) => `${kind}:${kind === 'component' || kind === 'reftext' ? object : object.id}`;
const adapterFactories = new Map();
const hitQueries = new WeakMap();
const groupGeometryMembers = new Set([
    'object', 'getBounds', 'getHitBounds', 'hitTest', 'getPosition', 'getAnchors', 'getEditPath',
    'getLockPosition', 'invalidate', 'render',
]);

function placementSelectionHit(app, point, method, all = false) {
    const query = hitQueries.get(app);
    const read = () => all ? new Set(app[method]?.(point, true) || []) : app[method]?.(point) ?? null;
    const key = `${method}:${all}`;
    if (!query || query.x !== point.x || query.y !== point.y) return read();
    if (!query.results.has(key)) query.results.set(key, read());
    return query.results.get(key);
}

export function getComponentSelectionHits(app, point) {
    return placementSelectionHit(app, point, '_hitTestComponent', true);
}

export function getRefTextSelectionHit(app, point) {
    return placementSelectionHit(app, point, '_hitTestRefText');
}

function querySelectionHits(app, point) {
    const previous = hitQueries.get(app);
    hitQueries.set(app, { x: point.x, y: point.y, results: new Map() });
    try {
        manager(app)._invalidateHitTestCache();
        return manager(app).hitTest(point, true);
    } finally {
        if (previous) hitQueries.set(app, previous);
        else hitQueries.delete(app);
    }
}

/** Register a factory implementing the SelectionManager shape contract. */
export function registerPcbSelectionAdapter(kind, factory) {
    adapterFactories.set(kind, factory);
}

function manager(app) {
    if (!app._pcbSelection) {
        app._pcbSelection = new SelectionManager({
            getScale: () => app.viewport?.scale || 1,
            onSelectionChanged: (selected) => {
                const segment = app._selectedBoardShapeSegment;
                const segmentStillSelected = segment && selected.some(
                    (item) => item.kind === 'shape' && item.object?.id === segment.shapeId,
                );
                if (segment && !segmentStillSelected) {
                    app._selectedBoardShapeSegment = null;
                    const overlay = app.getLayerGroup?.('selection-overlay');
                    for (const element of [...(overlay?.querySelectorAll?.('.pcb-shape-segment-selection') || [])]) {
                        element.remove();
                    }
                }
                const node = app._selectedBoardShapeNode;
                const nodeStillSelected = node && selected.some(
                    (item) => item.kind === 'shape' && item.object?.id === node.shapeId,
                );
                if (node && !nodeStillSelected) app._selectedBoardShapeNode = null;
                if (app._fillEdit && !selected.some(item => item.kind === 'fill'
                    && item.object?.id === app._fillEdit.fillId)) app._fillEdit = null;
                app.setPcbStatus?.();
                refreshPcbReferenceOverlay(app);
            },
        });
    }
    return app._pcbSelection;
}

function adapter(app, kind, object) {
    const factory = adapterFactories.get(kind);
    if (factory) {
        const original = app._groupDrag?.preview?.originals.get(object) || object;
        const base = factory(app, original, keyFor(kind, original));
        if (!['track', 'via', 'pad', 'shape', 'fill'].includes(kind)) return base;
        let displayed, projected;
        // Geometry follows the group copy; gesture methods keep canonical command targets.
        return new Proxy(base, {
            get(target, member, receiver) {
                const copy = app._groupDrag?.preview?.copies.get(original);
                if (!copy || !groupGeometryMembers.has(member)) return Reflect.get(target, member, receiver);
                if (displayed !== copy) {
                    displayed = copy;
                    projected = factory(app, copy, base.id);
                }
                const value = projected[member];
                return typeof value === 'function' ? value.bind(projected) : value;
            },
        });
    }
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
    for (const pad of app.pads || []) out.push(adapter(app, 'pad', pad));
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

/** Discard selection and hover adapters before replacing the document's models. */
export function resetPcbSelection(app) {
    const selection = manager(app);
    selection.clearSelection();
    selection.setHovered(null);
    selection.setShapes([]);
}

/** @param {string|null} [kind] */
export function getPcbSelection(app, kind = null) {
    return manager(app).getSelection()
        .filter((item) => !kind || item.kind === kind)
        .map((item) => item.object);
}

/** Return selected adapters when the caller needs both kind and object. */
export function getPcbSelectionEntries(app) {
    return manager(app).getSelection();
}

export function refreshPcbReferenceOverlay(app) {
    const componentId = getPcbSelection(app, 'reftext')[0] || null;
    if (componentId || app._refOverlay) app._drawRefOverlay?.(componentId, false);
}

/** Hit test an adapter kind through the shared selection ordering rules. */
/** @param {string|null} [kind] */
export function hitTestPcbSelection(app, point, kind = null) {
    syncPcbSelection(app);
    const hits = querySelectionHits(app, point);
    const hit = kind ? hits.find((item) => item.kind === kind) : hits[0];
    return hit?.object || null;
}

export function getPcbSelectionHits(app, point, kinds = null, { sync = true } = {}) {
    if (sync) syncPcbSelection(app);
    const allowed = kinds ? new Set(kinds) : null;
    const hits = querySelectionHits(app, point).filter((item) => !allowed || allowed.has(item.kind));
    const priority = { pad: 0, via: 1, track: 2, text: 3, reftext: 4 };
    const rank = item => item.kind === 'shape' && item.object.layer === 'hole' ? -1 : (priority[item.kind] ?? 4);
    return hits.sort((first, second) => rank(first) - rank(second));
}

export function hitTestPcbSelectionEntry(app, point, kinds) {
    return getPcbSelectionHits(app, point, kinds)[0] || null;
}

export function hasPcbSelection(app) {
    return manager(app).count > 0;
}

export function isPcbSelected(app, kind, object) {
    return !!object && manager(app).isSelected(keyFor(kind, object));
}
