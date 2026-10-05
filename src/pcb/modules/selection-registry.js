/**
 * Unified PCB multi-selection registry.
 *
 * The registry uses the shared schematic SelectionManager and exposes typed
 * original PCB objects to PCB-specific render, move, and command code.
 */

import { SelectionManager } from '../../core/SelectionManager.js';
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus, setBoardShapeNodeFocus, setBoardShapeSegmentFocus } from './board-shape-state.js';
import { getPcbInteraction } from './pcb-interactions.js';

const keyFor = (kind, object) => `${kind}:${kind === 'component' || kind === 'reftext' ? object : object.id}`;
const adapterFactories = new Map();
const hitQueries = new WeakMap();
/** @type {Set<string|symbol>} */
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
    adapterCaches = new WeakMap();
}

// Adapters read live model state lazily, so one per model object is reused across
// syncs instead of rebuilding every adapter on each hover/hit query. Objects are
// keyed weakly; component/reference IDs are pruned when their placement goes.
let adapterCaches = new WeakMap();

function adapter(app, kind, object) {
    let caches = adapterCaches.get(app);
    if (!caches) adapterCaches.set(app, caches = new Map());
    let cache = caches.get(kind);
    if (!cache) caches.set(kind, cache = typeof object === 'object' ? new WeakMap() : new Map());
    let entry = cache.get(object);
    if (!entry) cache.set(object, entry = createAdapter(app, kind, object));
    return entry;
}

function pruneIdAdapters(app) {
    for (const kind of ['component', 'reftext']) {
        const cache = adapterCaches.get(app)?.get(kind);
        if (cache?.size > (app.placements?.size || 0)) {
            for (const id of cache.keys()) if (!app.placements?.has(id)) cache.delete(id);
        }
    }
}

function manager(app) {
    if (!app._pcbSelection) {
        app._pcbSelection = new SelectionManager({
            getScale: () => app.viewport?.scale || 1,
            onSelectionChanged: (selected) => {
                const segment = getBoardShapeSegmentFocus(app);
                const segmentStillSelected = segment && selected.some(
                    (item) => (item.kind === 'shape' || item.kind === 'fill') && item.object?.id === segment.shapeId,
                );
                if (segment && !segmentStillSelected) {
                    setBoardShapeSegmentFocus(app, null);
                    const overlay = app.getLayerGroup?.('selection-overlay');
                    for (const element of [...(overlay?.querySelectorAll?.('.pcb-shape-segment-selection') || [])]) {
                        element.remove();
                    }
                }
                const node = getBoardShapeNodeFocus(app);
                const nodeStillSelected = node && selected.some(
                    (item) => (item.kind === 'shape' || item.kind === 'fill') && item.object?.id === node.shapeId,
                );
                if (node && !nodeStillSelected) setBoardShapeNodeFocus(app, null);
                app.setPcbStatus?.();
                refreshPcbReferenceOverlay(app);
            },
        });
    }
    return app._pcbSelection;
}

function createAdapter(app, kind, object) {
    const factory = adapterFactories.get(kind);
    if (factory) {
        const original = getPcbInteraction(app, '_groupDrag')?.preview?.originals.get(object) || object;
        const base = factory(app, original, keyFor(kind, original));
        if (!['track', 'via', 'pad', 'shape', 'fill'].includes(kind)) return base;
        let displayed, projected;
        // Geometry follows the group copy; gesture methods keep canonical command targets.
        return new Proxy(base, {
            get(target, member, receiver) {
                const copy = getPcbInteraction(app, '_groupDrag')?.preview?.copies.get(original);
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
    const next = entries(app);
    const previous = selection.shapes;
    let unchanged = previous.length === next.length;
    for (let index = 0; unchanged && index < next.length; index++) unchanged = previous[index] === next[index];
    // Reused adapters keep the id map and selected ids valid; geometry may still have
    // moved, so hit caches always reset.
    if (unchanged) {
        selection._invalidateHitTestCache();
        selection._selectionCache = null;
        return;
    }
    selection.setShapes(next);
    pruneIdAdapters(app);
    selection.selected = new Set([...selection.selected].filter((id) => selection._getShape(id)));
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
    adapterCaches.delete(app);
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

/**
 * Hit bounds for a selected path: its visual bounds plus its nodes, because the
 * unrounded edges of a selected path stay hittable outside large corner radii.
 */
export function boundsWithPathNodes(bounds, points) {
    if (!bounds || !points?.length) return bounds;
    let { minX, minY, maxX, maxY } = bounds;
    for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
    }
    return { minX, minY, maxX, maxY };
}

export function hasPcbSelection(app) {
    return manager(app).count > 0;
}

export function isPcbSelected(app, kind, object) {
    return !!object && manager(app).isSelected(keyFor(kind, object));
}
