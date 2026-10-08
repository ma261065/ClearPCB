/**
 * Unified PCB multi-selection registry.
 *
 * The registry uses the shared schematic SelectionManager and exposes typed
 * original PCB objects to PCB-specific render, move, and command code.
 */

import { SelectionManager } from '../../core/SelectionManager.js';
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus, setBoardShapeNodeFocus, setBoardShapeSegmentFocus } from './board-shape-state.js';
// Low-level plumbing that owner modules register into at load time, so it reads the
// group-drag preview from the import-free store rather than importing box-select.
import { getPcbInteraction } from './pcb-interactions.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{id: string, kind: string, object?: any, visible?: boolean, locked?: boolean, beginMove?: (worldPos: Point, options?: object) => unknown, updateMove?: (worldPos: Point) => void, endMove?: (commit: boolean, options?: object) => void, getBounds: () => any, getHitBounds?: () => any, hitTest: (point: Point, tolerance: number) => boolean, getPosition?: () => Point, getAnchors?: () => SelectionAnchor[], getEditPath?: () => string|null|undefined, getLockPosition?: (point: Point, scale: number) => Point|null|undefined, invalidate: () => void, render?: () => void, beginAnchorDrag?: (anchorId: string|number|undefined, worldPos: Point, options?: object) => boolean|void, updateAnchorDrag?: (worldPos: Point) => void, endAnchorDrag?: (commit: boolean, options?: object) => void, getSelectedSegment?: () => unknown, [key: string]: any}} SelectionShape */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{kind: string, object?: any}} PcbSelectionValue */
/** @typedef {{id?: string|number, key?: string|number, x: number, y: number, sizePx?: number, symbol?: string, round?: boolean, hidden?: boolean, selected?: boolean, fill?: string, stroke?: string, strokeWidthPx?: number, cursor?: string}} SelectionAnchor */
/** @typedef {SelectionShape} SelectionAdapter */
/** @typedef {SelectionAdapter} PcbSelectionEntry */
/** @typedef {(app: PcbEditor, point: Point, all?: boolean) => any} PlacementHitReader */
/** @typedef {(app: PcbEditor, original: any, id: string) => SelectionShape} AdapterFactory */

/** @param {string|undefined} kind @param {any} object */
const keyFor = (kind, object) => `${kind}:${kind === 'component' || kind === 'reftext' ? object : object.id}`;
/** @type {Map<string, AdapterFactory>} */
const adapterFactories = new Map();
/** @type {Map<string, PlacementHitReader>} */
const placementHitReaders = new Map();
/** @type {WeakMap<PcbEditor, {x: number, y: number, results: Map<string, any>}>} */
const hitQueries = new WeakMap();
/** @type {WeakMap<PcbEditor, SelectionManager>} */
const selectionManagers = new WeakMap();
/** @type {((app: PcbEditor, componentId: string|null) => void)|null} */
let referenceOverlayRefresher = null;
/** @type {Set<string|symbol>} */
const groupGeometryMembers = new Set([
    'object', 'getBounds', 'getHitBounds', 'hitTest', 'getPosition', 'getAnchors', 'getEditPath',
    'getLockPosition', 'invalidate', 'render',
]);

/**
 * @param {PcbEditor} app
 * @param {Point} point
 * @param {string} method
 * @param {PlacementHitReader|undefined} readHit
 * @param {boolean} [all]
 */
function placementSelectionHit(app, point, method, readHit, all = false) {
    const query = hitQueries.get(app);
    const read = () => {
        const hit = readHit
            ? readHit(app, point, all)
            : /** @type {PcbEditor & Record<string, (point: Point, all?: boolean) => any>} */ (app)[method]?.(point, all);
        return all ? new Set(hit || []) : hit ?? null;
    };
    const key = `${method}:${all}`;
    if (!query || query.x !== point.x || query.y !== point.y) return read();
    if (!query.results.has(key)) query.results.set(key, read());
    return query.results.get(key);
}

/** @param {string} kind @param {PlacementHitReader} readHit */
export function registerPcbPlacementHitTest(kind, readHit) {
    placementHitReaders.set(kind, readHit);
}

/** @param {(app: PcbEditor, componentId: string|null) => void} refresh */
export function registerPcbReferenceOverlayRefresh(refresh) {
    referenceOverlayRefresher = refresh;
}

/** @param {PcbEditor} app @param {Point} point */
export function getComponentSelectionHits(app, point) {
    return placementSelectionHit(app, point, 'component', placementHitReaders.get('component'), true);
}

/** @param {PcbEditor} app @param {Point} point */
export function getRefTextSelectionHit(app, point) {
    return placementSelectionHit(app, point, '_hitTestRefText', placementHitReaders.get('reftext'));
}

/** @param {PcbEditor} app @param {Point} point */
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
/** @param {string} kind @param {AdapterFactory} factory */
export function registerPcbSelectionAdapter(kind, factory) {
    adapterFactories.set(kind, factory);
    adapterCaches = new WeakMap();
}

// Adapters read live model state lazily, so one per model object is reused across
// syncs instead of rebuilding every adapter on each hover/hit query. Objects are
// keyed weakly; component/reference IDs are pruned when their placement goes.
/** @type {WeakMap<PcbEditor, Map<string, any>>} */
let adapterCaches = new WeakMap();

/** @param {PcbEditor} app @param {string} kind @param {any} object */
function adapter(app, kind, object) {
    let caches = adapterCaches.get(app);
    if (!caches) adapterCaches.set(app, caches = new Map());
    let cache = caches.get(kind);
    if (!cache) caches.set(kind, cache = typeof object === 'object' ? new WeakMap() : new Map());
    let entry = cache.get(object);
    if (!entry) cache.set(object, entry = createAdapter(app, kind, object));
    return entry;
}

/** @param {PcbEditor} app */
function pruneIdAdapters(app) {
    for (const kind of ['component', 'reftext']) {
        const cache = /** @type {Map<string, SelectionShape>|undefined} */ (adapterCaches.get(app)?.get(kind));
        if (cache && cache.size > (app.placements?.size || 0)) {
            for (const id of cache.keys()) if (!app.placements?.has(id)) cache.delete(id);
        }
    }
}

/** @param {PcbEditor} app */
function manager(app) {
    let selection = selectionManagers.get(app);
    if (!selection) {
        selection = new SelectionManager({
            getScale: () => app.viewport?.scale || 1,
            onSelectionChanged: (selected) => {
                const segment = getBoardShapeSegmentFocus(app);
                const segmentStillSelected = segment && selected.some(
                    (item) => (item.kind === 'shape' || item.kind === 'fill') && item.object?.id === segment.shapeId,
                );
                if (segment && !segmentStillSelected) {
                    setBoardShapeSegmentFocus(app, null);
                    const overlay = app.getLayerGroup('selection-overlay');
                    for (const element of [...(overlay?.querySelectorAll?.('.pcb-shape-segment-selection') || [])]) {
                        element.remove();
                    }
                }
                const node = getBoardShapeNodeFocus(app);
                const nodeStillSelected = node && selected.some(
                    (item) => (item.kind === 'shape' || item.kind === 'fill') && item.object?.id === node.shapeId,
                );
                if (node && !nodeStillSelected) setBoardShapeNodeFocus(app, null);
                app.setPcbStatus();
                refreshPcbReferenceOverlay(app);
            },
        });
        selectionManagers.set(app, selection);
    }
    return selection;
}

/** @param {PcbEditor} app */
export function getPcbSelectionManager(app) {
    return manager(app);
}

/** @param {PcbEditor} app @param {string} kind @param {any} object */
function createAdapter(app, kind, object) {
    const factory = adapterFactories.get(kind);
    if (factory) {
        const original = getPcbInteraction(app, '_groupDrag')?.preview?.originals.get(object) || object;
        const base = factory(app, original, keyFor(kind, original));
        if (!['track', 'via', 'pad', 'shape', 'fill'].includes(kind)) return base;
        /** @type {any} */
        let displayed;
        /** @type {SelectionShape|null} */
        let projected = null;
        // Geometry follows the group copy; gesture methods keep canonical command targets.
        return new Proxy(base, {
            get(target, member, receiver) {
                const copy = getPcbInteraction(app, '_groupDrag')?.preview?.copies.get(original);
                if (!copy || !groupGeometryMembers.has(member)) return Reflect.get(target, member, receiver);
                if (displayed !== copy) {
                    displayed = copy;
                    projected = factory(app, copy, base.id);
                }
                const value = /** @type {Record<PropertyKey, any>} */ (projected)[member];
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

/** @param {PcbEditor} app */
function entries(app) {
    /** @type {SelectionShape[]} */
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

/**
 * Synchronize current PCB model entities while retaining selected keys.
 * @param {PcbEditor} app
 */
export function syncPcbSelection(app) {
    const selection = manager(app);
    const next = entries(app);
    const previous = selection.shapes;
    let unchanged = previous.length === next.length;
    for (let index = 0; unchanged && index < next.length; index++) unchanged = previous[index] === next[index];
    // Reused adapters keep the id map and selected ids valid; geometry may still have
    // moved, so hit caches always reset.
    if (unchanged) {
        selection.invalidateHitCache();
        selection.invalidateSelectionCache();
        return;
    }
    selection.setShapes(next);
    pruneIdAdapters(app);
    selection.selected = new Set([...selection.selected].filter((id) => selection._getShape(id)));
    selection.invalidateSelectionCache();
}

/** @param {PcbEditor} app @param {PcbSelectionValue[]} [values] */
export function setPcbSelection(app, values = []) {
    syncPcbSelection(app);
    manager(app).selectMultiple(values.map(({ kind, object }) => keyFor(kind, object)));
}

/** @param {PcbEditor} app @param {string} kind @param {any} object */
export function togglePcbSelection(app, kind, object) {
    syncPcbSelection(app);
    manager(app).toggle(keyFor(kind, object));
}

/** @param {PcbEditor} app */
export function clearPcbSelection(app) {
    manager(app).clearSelection();
}

/**
 * Discard selection and hover adapters before replacing the document's models.
 * @param {PcbEditor} app
 */
export function resetPcbSelection(app) {
    const selection = manager(app);
    selection.clearSelection();
    selection.setHovered(null);
    selection.setShapes([]);
    adapterCaches.delete(app);
}

/**
 * @param {PcbEditor} app
 * @param {string|null} [kind]
 * @returns {any[]}
 */
export function getPcbSelection(app, kind = null) {
    return manager(app).getSelection()
        .filter((item) => !kind || item.kind === kind)
        .map((item) => item.object);
}

/**
 * Return selected adapters when the caller needs both kind and object.
 * @param {PcbEditor} app
 * @returns {any[]}
 */
export function getPcbSelectionEntries(app) {
    return manager(app).getSelection();
}

/** @param {PcbEditor} app */
export function refreshPcbReferenceOverlay(app) {
    const componentId = getPcbSelection(app, 'reftext')[0] || null;
    referenceOverlayRefresher?.(app, componentId);
}

/** Hit test an adapter kind through the shared selection ordering rules. */
/**
 * @param {PcbEditor} app
 * @param {Point} point
 * @param {string|null} [kind]
 */
export function hitTestPcbSelection(app, point, kind = null) {
    syncPcbSelection(app);
    const hits = /** @type {SelectionShape[]} */ (querySelectionHits(app, point));
    const hit = kind ? hits.find((item) => item.kind === kind) : hits[0];
    return hit?.object || null;
}

/** @param {PcbEditor} app @param {Point} point @param {Iterable<string>|null} [kinds] @param {{sync?: boolean}} [options] @returns {any[]} */
export function getPcbSelectionHits(app, point, kinds = null, { sync = true } = {}) {
    if (sync) syncPcbSelection(app);
    const allowed = kinds ? new Set(kinds) : null;
    const hits = /** @type {SelectionShape[]} */ (querySelectionHits(app, point)).filter((item) => !allowed || allowed.has(String(item.kind)));
    /** @type {Record<string, number>} */
    const priority = { pad: 0, via: 1, track: 2, text: 3, reftext: 4 };
    /** @param {SelectionShape} item */
    const rank = item => item.kind === 'shape' && item.object.layer === 'hole' ? -1 : (priority[String(item.kind)] ?? 4);
    return hits.sort((first, second) => rank(first) - rank(second));
}

/** @param {PcbEditor} app @param {Point} point @param {Iterable<string>|null} kinds */
export function hitTestPcbSelectionEntry(app, point, kinds) {
    return getPcbSelectionHits(app, point, kinds)[0] || null;
}

/**
 * Hit bounds for a selected path: its visual bounds plus its nodes, because the
 * unrounded edges of a selected path stay hittable outside large corner radii.
 * @param {{minX: number, minY: number, maxX: number, maxY: number}|null} bounds
 * @param {Point[]|null|undefined} points
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

/** @param {PcbEditor} app */
export function hasPcbSelection(app) {
    return manager(app).count > 0;
}

/** @param {PcbEditor} app @param {string} kind @param {any} object */
export function isPcbSelected(app, kind, object) {
    return !!object && manager(app).isSelected(keyFor(kind, object));
}
