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

function placementSelectionHit(app, point, method) {
    const query = hitQueries.get(app);
    if (!query || query.x !== point.x || query.y !== point.y) return app[method]?.(point) ?? null;
    if (!query.results.has(method)) query.results.set(method, app[method]?.(point) ?? null);
    return query.results.get(method);
}

export function getComponentSelectionHit(app, point) {
    return placementSelectionHit(app, point, '_hitTestComponent');
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
                    const overlay = app._getLayerGroup?.('selection-overlay');
                    for (const element of [...(overlay?.querySelectorAll?.('.pcb-shape-segment-selection') || [])]) {
                        element.remove();
                    }
                }
                const node = app._selectedBoardShapeNode;
                const nodeStillSelected = node && selected.some(
                    (item) => item.kind === 'shape' && item.object?.id === node.shapeId,
                );
                if (node && !nodeStillSelected) app._selectedBoardShapeNode = null;
                app._setPcbStatus?.();
                refreshPcbReferenceOverlay(app);
            },
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
    const priority = { via: 0, track: 1, text: 2, reftext: 3 };
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
