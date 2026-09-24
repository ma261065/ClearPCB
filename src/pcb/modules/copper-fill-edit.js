import { applyBoardShapeVertexResize, getBoardShapeAnchors, shapePathD,
    splitBoardShapeSegmentMetadata, remapBoardShapeNodeRadii } from './board-shapes.js';
import { validBoardOutline } from './board-outline.js';
import { ModifyFillCommand, RemoveFillCommand } from './copper-fill-commands.js';
import { renderCopperFill } from './copper-fill-render.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { isPcbSelected, setPcbSelection } from './selection-registry.js';
import { isCopperFillLocked, isCopperFillVisible, isLayerLocked } from './layers.js';
import { snapPathPoint, snapPathTranslation, pathContextActions, showPathContextMenu } from './path-edit.js';
import { distanceToArcEdge, arcEdgePathD } from '../../shapes/arc-edge.js';
import { formatNumberInputValue } from '../../core/number-inputs.js';

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
    mutate();
    const after = fill.captureState();
    const valid = validFill(fill);
    fill.applyState(before);
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
    if (midpoint) {
        const index = Number(midpoint[1]);
        const start = fill.outline[index], end = fill.outline[(index + 1) % fill.outline.length];
        if (!start || !end) return false;
        fill.kind = 'polygon';
        splitBoardShapeSegmentMetadata(fill, index);
        remapBoardShapeNodeRadii(fill, index + 1, 1);
        fill.outline.splice(index + 1, 0, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
        anchor = index + 1;
    }
    const bulge = /^bulge:(\d+)$/.exec(String(anchor));
    app._fillEdit = { fillId: fill.id, node: typeof anchor === 'number' ? anchor : null,
        segment: bulge ? Number(bulge[1]) : segment };
    app._fillDrag = { fill, before, editBefore: fill.captureState(), anchor, segment,
        start: { ...point }, previousFocus, previousDeferDragOverlays: !!app._deferDragOverlays };
    app._deferDragOverlays = true;
    updateFillHandleCrosshair(app, fill, anchor);
    return true;
}

export function updateFillEdit(app, point) {
    const drag = app._fillDrag;
    if (!drag) return;
    const { fill, editBefore, anchor, segment, start } = drag;
    fill.applyState(editBefore);
    if (anchor != null) {
        const count = fill.outline.length;
        const neighbours = typeof anchor === 'number'
            ? [fill.outline[(anchor + count - 1) % count], fill.outline[(anchor + 1) % count]] : [];
        const snap = snapPathPoint(app, point, neighbours, true);
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
    renderCopperFill(fill, id => app._getLayerGroup(id), { selected: true, outlineOnly: true });
    renderPcbSelectionAnchors(app);
}

export function endFillEdit(app, commit) {
    const drag = app._fillDrag;
    if (!drag) return;
    app._fillDrag = null;
    if (drag.anchor != null) app.viewport?.hideCrosshair?.();
    app._deferDragOverlays = drag.previousDeferDragOverlays;
    const { fill, before } = drag;
    const after = fill.captureState();
    const valid = commit && validFill(fill);
    if (!valid) app._fillEdit = drag.previousFocus;
    fill.applyState(before);
    if (valid && JSON.stringify(before) !== JSON.stringify(after)) {
        app.history.execute(new ModifyFillCommand(app, fill, before, after));
    } else {
        renderCopperFill(fill, id => app._getLayerGroup(id), { selected: isPcbSelected(app, 'fill', fill) });
        app._refreshFillProperties?.(fill);
    }
    renderPcbSelectionAnchors(app);
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
    return commitFillEdit(app, fill, () => {
        const count = fill.outline.length;
        const previous = (index + count - 1) % count;
        fill.segmentBulges = Object.fromEntries(Object.entries(fill.segmentBulges)
            .filter(([key]) => Number(key) !== index && Number(key) !== previous)
            .map(([key, value]) => [Number(key) > index ? Number(key) - 1 : Number(key), value]));
        remapBoardShapeNodeRadii(fill, index, -1);
        fill.outline.splice(index, 1);
        fill.kind = 'polygon';
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
        convert: () => commitFillEdit(app, fill, () => {
            fill.kind = 'polygon';
            if (curved) delete fill.segmentBulges[segment];
            else fill.segmentBulges[segment] = 0.25;
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

export function addFillGeometryProperties(app, fill, items) {
    const { node, segment } = fillEditFocus(app, fill);
    const number = (id, label, value, min, max = '') => `<div class="prop-row"><label for="${id}">${label}</label><input id="${id}" type="number" min="${min}" ${max === '' ? '' : `max="${max}"`} step="0.05" value="${formatNumberInputValue(value)}"></div>`;
    const bounds = fill.getBounds();
    items.insertAdjacentHTML('beforeend', node != null
        ? number('pcbPropFillNodeRadius', 'Corner Radius (mm)', fill.nodeCornerRadii[node] ?? fill.cornerRadius, 0)
        : segment != null
            ? number('pcbPropFillBulge', 'Bulge', fill.segmentBulges[segment] || 0, -1, 1)
            : `<div class="prop-row"><label>Outline</label><select id="pcbPropFillKind">${[['rect', 'Rectangle'], ['polygon', 'Polygon'], ['circle', 'Circle']].map(([kind, label]) => `<option value="${kind}"${fill.kind === kind ? ' selected' : ''}>${label}</option>`).join('')}</select></div>`
                + (fill.kind === 'circle' ? number('pcbPropFillDiameter', 'Diameter (mm)', fill.radius * 2, 0.1)
                    : number('pcbPropFillCornerRadius', 'Corner Radius (mm)', fill.cornerRadius, 0))
                + (fill.kind === 'rect' && bounds ? number('pcbPropFillWidth', 'Width (mm)', bounds.maxX - bounds.minX, 0.1)
                    + number('pcbPropFillHeight', 'Height (mm)', bounds.maxY - bounds.minY, 0.1) : ''));
    const bind = (id, mutate, min, max = Infinity) => {
        const input = items.querySelector(`#${id}`);
        input?.addEventListener('change', () => {
            const value = input.valueAsNumber;
            if (!Number.isFinite(value) || value < min || value > max) return;
            commitFillEdit(app, fill, () => mutate(value));
        });
    };
    bind('pcbPropFillNodeRadius', value => { fill.nodeCornerRadii[node] = value; }, 0);
    bind('pcbPropFillBulge', value => {
        fill.kind = 'polygon';
        if (Math.abs(value) < 1e-4) delete fill.segmentBulges[segment];
        else fill.segmentBulges[segment] = value;
    }, -1, 1);
    bind('pcbPropFillCornerRadius', value => { fill.cornerRadius = value; fill.nodeCornerRadii = {}; }, 0);
    bind('pcbPropFillDiameter', value => { fill.radius = value / 2; }, 0.1);
    for (const [id, axis, minimum, maximum] of [['pcbPropFillWidth', 'x', 'minX', 'maxX'], ['pcbPropFillHeight', 'y', 'minY', 'maxY']]) {
        bind(id, value => {
            const current = fill.getBounds();
            const factor = value / (current[maximum] - current[minimum]);
            fill.outline = fill.outline.map(point => ({ ...point, [axis]: current[minimum] + (point[axis] - current[minimum]) * factor }));
        }, 0.1);
    }
    const kindInput = items.querySelector('#pcbPropFillKind');
    kindInput?.addEventListener('change', () => {
        const kind = kindInput.value;
        if (!bounds || kind === fill.kind || !['rect', 'polygon', 'circle'].includes(kind)) return;
        commitFillEdit(app, fill, () => {
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
        });
    });
}