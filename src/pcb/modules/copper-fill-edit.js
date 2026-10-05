import { applyBoardShapeVertexResize, getBoardShapeAnchors,
    splitBoardShapeSegmentMetadata, remapBoardShapeNodeRadii } from './board-shapes.js';
import { shapePathD } from '../../shared/pcb/board-shape-geometry.js';
import { validBoardOutline } from '../../shared/pcb/board-outline.js';
import { ModifyFillCommand, RemoveFillCommand } from './copper-fill-commands.js';
import { renderCopperFill, removeCopperFillElements } from './copper-fill-render.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { isPcbSelected, setPcbSelection } from './selection-registry.js';
import { isCopperFillLocked, isCopperFillVisible, isLayerLocked, pcbLayerOption } from './layers.js';
import { lockedProperty } from './object-locks.js';
import { snapPathPoint, snapPathTranslation, pathContextActions, showPathContextMenu } from './path-edit.js';
import { distanceToArcEdge, arcEdgePathD } from '../../shapes/arc-edge.js';
import { CopperFill, normalizeCopperFillKind } from '../../shapes/copper-fill.js';
import { areDragOverlaysDeferred, setDragOverlaysDeferred } from './refresh-state.js';

export function canEditFill(fill) {
    return fill && !fill.locked && fill.visible !== false && !isLayerLocked(fill.layer)
        && !isCopperFillLocked(fill.layer) && isCopperFillVisible(fill.layer);
}

export function fillEditFocus(app, fill) {
    if (app._fillEdit?.fillId !== fill.id || fill.kind === 'circle') return {};
    const { node, segment } = app._fillEdit;
    return {
        node: Number.isInteger(node) && node >= 0 && node < fill.outline.length ? node : null,
        segment: Number.isInteger(segment) && segment >= 0 && segment < fill.outline.length ? segment : null,
    };
}

export function fillSegmentAt(fill, point, tolerance) {
    if (fill.kind === 'circle') return null;
    let selected = null;
    let best = tolerance;
    fill.outline.forEach((start, index) => {
        const distance = distanceToArcEdge(point, start, fill.outline[(index + 1) % fill.outline.length],
            fill.segmentBulges[index] || 0);
        if (distance <= best) { best = distance; selected = index; }
    });
    return selected;
}

function validFill(fill) {
    return validBoardOutline({ ...fill, points: fill.outline, layer: 'board-outline' });
}

export function commitFillEdit(app, fill, mutate) {
    if (!canEditFill(fill)) return false;
    const before = fill.captureState();
    const candidate = new CopperFill(before);
    mutate(candidate);
    const after = candidate.captureState();
    const valid = validFill(candidate);
    if (!valid || JSON.stringify(before) === JSON.stringify(after)) return false;
    app.history.execute(new ModifyFillCommand(app, fill, before, after));
    return true;
}

function updateFillHandleCrosshair(app, fill, anchor) {
    if (anchor == null) return;
    const handle = getBoardShapeAnchors(fill).find(item => item.id === anchor);
    if (handle) app.viewport?.setCrosshair?.({ x: handle.x, y: handle.y });
}

export function beginFillEdit(app, fill, point, anchor = null, segment = null) {
    if (!canEditFill(fill)) return false;
    const before = fill.captureState();
    const previousFocus = app._fillEdit;
    const midpoint = /^mid:(\d+)$/.exec(String(anchor));
    const original = fill;
    if (midpoint) {
        const index = Number(midpoint[1]);
        const start = fill.outline[index], end = fill.outline[(index + 1) % fill.outline.length];
        if (!start || !end) return false;
        fill = new CopperFill(before);
        fill.kind = 'polygon';
        splitBoardShapeSegmentMetadata(fill, index);
        remapBoardShapeNodeRadii(fill, index + 1, 1);
        fill.outline.splice(index + 1, 0, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
        anchor = index + 1;
    }
    const bulge = /^bulge:(\d+)$/.exec(String(anchor));
    app._fillEdit = { fillId: fill.id, node: typeof anchor === 'number' ? anchor : null,
        segment: bulge ? Number(bulge[1]) : segment };
    app._fillDrag = { original, fill, before, editBefore: fill.captureState(), anchor, segment,
        start: { ...point }, lastPoint: { ...point }, previousFocus, previousDeferDragOverlays: !!areDragOverlaysDeferred(app) };
    setDragOverlaysDeferred(app, true);
    updateFillHandleCrosshair(app, fill, anchor);
    return true;
}

export function updateFillEdit(app, point) {
    const drag = app._fillDrag;
    if (!drag) return;
    if (point.x === drag.lastPoint.x && point.y === drag.lastPoint.y) return;
    if (drag.fill === drag.original) drag.fill = new CopperFill(drag.before);
    const { fill, editBefore, anchor, segment, start } = drag;
    fill.applyState(editBefore);
    if (anchor != null) {
        const count = fill.outline.length;
        const neighbours = typeof anchor === 'number'
            ? [fill.outline[(anchor + count - 1) % count], fill.outline[(anchor + 1) % count]] : [];
        const snap = snapPathPoint(app, point, neighbours);
        applyBoardShapeVertexResize(fill, { before: { points: editBefore.outline }, handle: anchor }, snap);
        updateFillHandleCrosshair(app, fill, anchor);
    } else {
        const indices = segment == null ? null : [segment, (segment + 1) % fill.outline.length];
        const vertices = indices ? indices.map(index => fill.outline[index])
            : fill.kind === 'circle' ? [{ x: fill.x, y: fill.y }] : fill.outline;
        const delta = snapPathTranslation(app, vertices, { x: point.x - start.x, y: point.y - start.y });
        if (indices) {
            fill.kind = 'polygon';
            for (const index of indices) {
                fill.outline[index].x += delta.x;
                fill.outline[index].y += delta.y;
            }
        } else fill.move(delta.x, delta.y);
    }
    drag.lastPoint = { ...point };
    renderCopperFill(fill, id => app.getLayerGroup(id), { selected: true, outlineOnly: true });
    renderPcbSelectionAnchors(app);
}

export function endFillEdit(app, commit) {
    const drag = app._fillDrag;
    if (!drag) return;
    app._fillDrag = null;
    if (drag.anchor != null) app.viewport?.hideCrosshair?.();
    setDragOverlaysDeferred(app, drag.previousDeferDragOverlays);
    const { original, fill, before } = drag;
    if (fill !== original && (drag.anchor != null || drag.segment != null)) normalizeCopperFillKind(fill);
    const after = fill.captureState();
    const valid = commit && canEditFill(original) && validFill(fill);
    if (!valid) app._fillEdit = drag.previousFocus;
    const changed = valid && JSON.stringify(before) !== JSON.stringify(after);
    let committed = false;
    try {
        if (changed) {
            if (!app.pcbDocument.boardShapes.includes(original)) throw new Error('Cannot edit a missing copper fill.');
            app.history.execute(new ModifyFillCommand(app, original, before, after));
            committed = true;
        }
    } finally {
        if (!committed) {
            if (changed) app._fillEdit = drag.previousFocus;
            if (app.pcbDocument.boardShapes.includes(original)) {
                renderCopperFill(original, id => app.getLayerGroup(id), { selected: isPcbSelected(app, 'fill', original) });
                app._refreshFillProperties?.(original);
            } else removeCopperFillElements(original, id => app.getLayerGroup(id));
        }
        renderPcbSelectionAnchors(app);
    }
}

export function startFillEditAt(app, fill, point) {
    if (!canEditFill(fill)) return false;
    const tolerance = Math.max(0.6, 8 / Math.max(0.01, app.viewport?.scale || 1));
    const anchor = getBoardShapeAnchors(fill).find(item => Math.hypot(item.x - point.x, item.y - point.y) <= tolerance);
    if (anchor) return beginFillEdit(app, fill, point, anchor.id);
    if (fill.distanceToEdge(point.x, point.y) > tolerance) return false;
    return beginFillEdit(app, fill, point);
}

export function deleteFillNode(app, fill, index) {
    if (fill.kind === 'circle' || fill.outline.length <= 3 || !Number.isInteger(index)
        || index < 0 || index >= fill.outline.length) return false;
    return commitFillEdit(app, fill, fill => {
        const count = fill.outline.length;
        const previous = (index + count - 1) % count;
        fill.segmentBulges = Object.fromEntries(Object.entries(fill.segmentBulges)
            .filter(([key]) => Number(key) !== index && Number(key) !== previous)
            .map(([key, value]) => [Number(key) > index ? Number(key) - 1 : Number(key), value]));
        remapBoardShapeNodeRadii(fill, index, -1);
        fill.outline.splice(index, 1);
        normalizeCopperFillKind(fill);
        app._fillEdit = null;
    });
}

export function deleteFocusedFillPart(app, fill) {
    const { node, segment } = fillEditFocus(app, fill);
    if (node == null && segment == null) return false;
    deleteFillNode(app, fill, node ?? (segment + 1) % fill.outline.length);
    return true;
}

export function showFillContextMenu(app, fill, clientX, clientY, point) {
    if (!canEditFill(fill)) return;
    setPcbSelection(app, [{ kind: 'fill', object: fill }]);
    const tolerance = 8 / Math.max(0.01, app.viewport?.scale || 1);
    const anchor = getBoardShapeAnchors(fill).find(item => typeof item.id === 'number'
        && Math.hypot(point.x - item.x, point.y - item.y) <= tolerance);
    const node = anchor?.id;
    const segment = node == null ? fillSegmentAt(fill, point, tolerance) : null;
    app._fillEdit = { fillId: fill.id, node, segment };
    const curved = !!fill.segmentBulges[segment];
    const items = pathContextActions({ node: node != null, segment: segment != null, curved,
        deleteNode: fill.outline.length > 3 ? () => deleteFillNode(app, fill, node) : null,
        deleteSegment: fill.outline.length > 3 ? () => deleteFillNode(app, fill, (segment + 1) % fill.outline.length) : null,
        convert: () => commitFillEdit(app, fill, fill => {
            fill.kind = 'polygon';
            if (curved) delete fill.segmentBulges[segment];
            else fill.segmentBulges[segment] = 0.25;
            normalizeCopperFillKind(fill);
        }),
        deleteObject: () => app.history.execute(new RemoveFillCommand(app, fill)), label: 'copper fill',
    });
    app._showFillProperties?.(fill);
    renderPcbSelectionAnchors(app);
    return showPathContextMenu('pcbBoardShapeContextMenu', items, clientX, clientY);
}

export function fillEditPath(app, fill) {
    const { node, segment } = fillEditFocus(app, fill);
    if (node != null) return '';
    if (segment != null) return arcEdgePathD(fill.outline[segment], fill.outline[(segment + 1) % fill.outline.length],
        fill.segmentBulges[segment] || 0);
    return shapePathD({ ...fill, points: fill.outline, cornerRadius: 0, nodeCornerRadii: {} });
}

/** Properties for a copper pour: Locked, Layer, Net, then its outline geometry. */
export function showFillProperties(app, fill) {
    if (!fill) return;
    const lockEntries = [{ kind: 'fill', object: fill }];
    const lock = lockedProperty(app, lockEntries);
    const refresh = () => app.refreshPropertyPanel?.(describe());
    const commit = (mutate) => {
        if (!canEditFill(fill)) return;
        const before = fill.captureState();
        mutate();
        const after = fill.captureState();
        fill.applyState(before);
        app.history.execute(new ModifyFillCommand(app, fill, before, after));
        refresh();
    };
    const describe = () => ({
        title: 'Copper Fill',
        fields: [
            { ...lock.field, commit: value => { lock.field.commit(value); refresh(); } },
            { key: 'layer', id: 'pcbPropFillLayer', type: 'select', label: 'Layer', value: fill.layer,
                disabled: lock.readOnly, options: [
                    pcbLayerOption('top-copper', 'Top Copper'),
                    pcbLayerOption('bottom-copper', 'Bottom Copper'),
                ], commit: value => {
                    if (fill.layer === value || isLayerLocked(value)) { refresh(); return; }
                    commit(() => { fill.layer = value; });
                } },
            { key: 'net', id: 'pcbPropFillNet', type: 'net', label: 'Net', value: fill.net || '', disabled: lock.readOnly,
                nets: fillNetNames(app), commit: value => {
                    if ((fill.net || '') === value) return;
                    commit(() => { fill.net = value; });
                } },
            ...addFillGeometryProperties(app, fill, lock.readOnly, refresh),
        ],
    });
    app.openPropertyPanel?.(describe());
}

function fillNetNames(app) {
    if (typeof app.netNames === 'function') return app.netNames();
    const names = new Set((app.netlist || []).map(entry => String(entry.net || '')).filter(Boolean));
    for (const source of [app.tracks, app.vias, app.boardShapes, app.copperFills]) {
        for (const item of source || []) {
            const net = String(item?.net || '');
            if (net) names.add(net);
        }
    }
    return [...names].sort();
}

export function addFillGeometryProperties(app, fill, disabled = false, refresh = () => {}) {
    const { node, segment } = fillEditFocus(app, fill);
    const bounds = fill.getBounds();
    const fields = [];
    const number = (id, key, label, value, min, max = Infinity, mutate) => ({
        key, id, type: 'number', label, value, min, max, step: 0.05, disabled,
        commit: next => {
            if (!Number.isFinite(next) || next < min || next > max) return;
            if (commitFillEdit(app, fill, candidate => mutate(candidate, next))) refresh();
        },
    });
    if (node == null && segment == null) {
        fields.push({ key: 'outline', id: 'pcbPropFillKind', type: 'select', label: 'Outline', value: fill.kind,
            disabled, options: [
                { value: 'rect', label: 'Rectangle' },
                { value: 'polygon', label: 'Polygon' },
                { value: 'circle', label: 'Circle' },
            ], commit: kind => {
                if (!bounds || kind === fill.kind || !['rect', 'polygon', 'circle'].includes(kind)) return;
                if (commitFillEdit(app, fill, fill => {
                    if (kind === 'polygon' && fill.kind !== 'circle') { fill.kind = kind; return; }
                    const contour = fill.getOutline();
                    fill.kind = kind;
                    fill.cornerRadius = 0;
                    fill.nodeCornerRadii = {};
                    fill.segmentBulges = {};
                    if (kind === 'circle') {
                        fill.outline = [];
                        fill.x = (bounds.minX + bounds.maxX) / 2;
                        fill.y = (bounds.minY + bounds.maxY) / 2;
                        fill.radius = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;
                    } else fill.outline = kind === 'polygon' ? contour : [
                        { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
                        { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
                    ];
                })) refresh();
            } });
    }
    if (node != null) {
        fields.push(number('pcbPropFillNodeRadius', 'cornerRadius', 'Corner Radius (mm)',
            fill.nodeCornerRadii[node] ?? fill.cornerRadius, 0, Infinity,
            (fill, value) => { fill.nodeCornerRadii[node] = value; }));
    } else if (segment != null) {
        fields.push(number('pcbPropFillBulge', 'bulge', 'Bulge', fill.segmentBulges[segment] || 0, -1, 1,
            (fill, value) => {
                fill.kind = 'polygon';
                if (Math.abs(value) < 1e-4) delete fill.segmentBulges[segment];
                else fill.segmentBulges[segment] = value;
                normalizeCopperFillKind(fill);
            }));
    } else {
        if (fill.kind === 'rect' && bounds) {
            fields.push(
                number('pcbPropFillWidth', 'width', 'Width (mm)', bounds.maxX - bounds.minX, 0.1, Infinity,
                    (fill, value) => {
                        const current = fill.getBounds();
                        const factor = value / (current.maxX - current.minX);
                        fill.outline = fill.outline.map(point => ({ ...point, x: current.minX + (point.x - current.minX) * factor }));
                    }),
                number('pcbPropFillHeight', 'height', 'Height (mm)', bounds.maxY - bounds.minY, 0.1, Infinity,
                    (fill, value) => {
                        const current = fill.getBounds();
                        const factor = value / (current.maxY - current.minY);
                        fill.outline = fill.outline.map(point => ({ ...point, y: current.minY + (point.y - current.minY) * factor }));
                    }),
            );
        }
        if (fill.kind === 'circle') {
            fields.push(number('pcbPropFillDiameter', 'diameter', 'Diameter (mm)', fill.radius * 2, 0.1, Infinity,
                (fill, value) => { fill.radius = value / 2; }));
        } else {
            fields.push(number('pcbPropFillCornerRadius', 'cornerRadius', 'Corner Radius (mm)', fill.cornerRadius, 0, Infinity,
                (fill, value) => { fill.cornerRadius = value; fill.nodeCornerRadii = {}; }));
        }
    }
    return fields;
}