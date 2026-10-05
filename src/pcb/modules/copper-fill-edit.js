import { canonicalBoardShape, createBoardShapePropertyBinding, createBoardShapePropertyPreview, displayedBoardShape,
    getBoardShapeAnchors, handleBoardShapeDrag, startBoardShapeDrag, endBoardShapeDrag,
    remapBoardShapeNodeRadii } from './board-shapes.js';
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus, setBoardShapeNodeFocus, setBoardShapeSegmentFocus } from './board-shape-state.js';
import { shapePathD } from '../../shared/pcb/board-shape-geometry.js';
import { validBoardOutline } from '../../shared/pcb/board-outline.js';
import { ModifyFillCommand, RemoveFillCommand } from './copper-fill-commands.js';
import { renderCopperFill, removeCopperFillElements } from './copper-fill-render.js';
import { lockPositionOutsideOutline, renderPcbSelectionAnchors } from './selection-anchors.js';
import { isPcbSelected, setPcbSelection } from './selection-registry.js';
import { isCopperFillLocked, isCopperFillVisible, isLayerLocked, pcbLayerOption } from './layers.js';
import { isPcbObjectLocked, lockedProperty } from './object-locks.js';
import { pathContextActions, showPathContextMenu } from './path-edit.js';
import { distanceToArcEdge, arcEdgePathD } from '../../shapes/arc-edge.js';
import { CopperFill, normalizeCopperFillKind } from '../../shapes/copper-fill.js';
import { fillToolDefaults, setFillToolDefaults } from './copper-fill-draw.js';
import { getPropertyEditor } from './property-editors.js';

/**
 * A pour's outline follows its Properties number fields live (corner radius, size,
 * diameter, bulge) on a detached copy, while its copper waits, as during a drag, for
 * the run to settle into one ModifyFillCommand.
 */
const geometryPreviews = new WeakMap();

export function fillEditProfile() {
    return {
        kind: 'fill',
        editorKey: 'fill',
        missingEditMessage: 'Cannot edit a missing copper fill.',
        missingDragMessage: 'Cannot finish a drag of a missing copper fill.',
        canonical: canonicalBoardShape,
        displayed: (app, fill) => displayedBoardShape(app, fill),
        collection: app => app.pcbDocument?.boardShapes || app.boardShapes,
        copy: fill => new CopperFill(fill.captureState()),
        capture: fill => fill.captureState(),
        canEdit: (_app, fill) => canEditFill(fill),
        visible: (_app, fill) => fill.visible !== false && isCopperFillVisible(fill.layer),
        locked: (app, fill) => isPcbObjectLocked(app, 'fill', fill),
        getNodeFocus: getBoardShapeNodeFocus,
        getSegmentFocus: getBoardShapeSegmentFocus,
        setNodeFocus: setBoardShapeNodeFocus,
        setSegmentFocus: setBoardShapeSegmentFocus,
        clearFocus(app) {
            setBoardShapeNodeFocus(app, null);
            setBoardShapeSegmentFocus(app, null);
        },
        getBounds(_app, fill) { return fill.getBounds() || { minX: 0, minY: 0, maxX: 0, maxY: 0 }; },
        getLockPosition(_app, fill, pointer, scale) {
            return lockPositionOutsideOutline(fill.getOutline(), pointer, scale);
        },
        hitTest(app, fill, point, tolerance) {
            return fill.distanceToEdge(point.x, point.y) <= Math.max(0.6, tolerance)
                || (isPcbSelected(app, 'fill', fill) && fillSegmentAt(fill, point, tolerance) != null);
        },
        segmentAt(_app, fill, point, tolerance) { return fillSegmentAt(fill, point, tolerance); },
        getEditPath(app, fill) { return fillEditPath(app, fill); },
        anchorColor: () => '#3399ff',
        render(app, fill, opts = {}) {
            renderCopperFill(fill, id => app.getLayerGroup(id), {
                selected: isPcbSelected(app, 'fill', this.collection(app).includes(fill) ? fill : this.canonical(app, fill)),
                outlineOnly: opts.outlineOnly || !this.collection(app).includes(fill),
            });
        },
        renderHandles(app) { renderPcbSelectionAnchors(app); },
        renderSegmentSelection(app) { renderPcbSelectionAnchors(app); },
        remove(app, fill) { removeCopperFillElements(fill, id => app.getLayerGroup(id)); },
        showProperties(app, fill) { app._showFillProperties?.(fill); },
        refreshProperties(app, fill) { app._refreshFillProperties?.(fill); },
        syncProperties(app, fill) { syncFillPanel(app, fill); },
        propertyPreviewPrepare() {},
        propertyPreviewRender(app, changed) {
            for (const fill of changed) this.render(app, fill, { outlineOnly: true });
        },
        propertyPreviewCancel(app, originals) {
            for (const original of originals) {
                if (this.collection(app).includes(original)) this.render(app, original);
                else this.remove(app, original);
            }
            renderPcbSelectionAnchors(app);
        },
        makeCommand(app, original, beforeState, afterState) {
            return new ModifyFillCommand(app, original, beforeState, afterState);
        },
        modifyCommand(app, original, beforeState, afterState) {
            return new ModifyFillCommand(app, original, beforeState, afterState);
        },
        removeCommand(app, fill) { return new RemoveFillCommand(app, fill); },
        valid(_app, fill) { return validFill(fill); },
        afterCommit(app, original) {
            if (this.collection(app).includes(original)) {
                app._refreshFillProperties?.(original);
                renderPcbSelectionAnchors(app);
            }
        },
    };
}

/** The live outline copy of `fill` while its Properties numbers preview, else null. */
export function fillGeometryPreview(app, fill) {
    const displayed = displayedBoardShape(app, fill);
    return displayed === fill ? null : displayed;
}

function previewFillGeometry(app, fill, mutate) {
    if (!getPropertyEditor(app, 'fill')) createBoardShapePropertyBinding(app, fillEditProfile());
    let preview = geometryPreviews.get(app);
    if (preview?.fill !== fill || !preview.control.active) {
        endFillGeometryPreview(app);
        preview = { fill, control: createBoardShapePropertyPreview(app, [fill], { editProfile: fillEditProfile() }) };
        geometryPreviews.set(app, preview);
    }
    preview.control.update((_before, [candidate]) => {
        mutate(candidate);
        if (!validFill(candidate)) throw new Error('Invalid copper fill preview geometry.');
    });
    return preview.control.active;
}

/**
 * Commit a pour's live outline now. Pointer gestures call this before they save the
 * overlay deferral, so a preview ending mid-gesture cannot leave pours deferred.
 */
export function settleFillGeometryPreview(app) {
    const preview = geometryPreviews.get(app);
    if (!preview) return false;
    geometryPreviews.delete(app);
    return preview.control.commit({ rebuild: false });
}

/** End a pour's live outline, showing the pour as it is (copper included). */
export function endFillGeometryPreview(app) {
    const preview = geometryPreviews.get(app);
    if (!preview) return false;
    geometryPreviews.delete(app);
    return preview.control.cancel();
}

export function canEditFill(fill) {
    return fill && !fill.locked && fill.visible !== false && !isLayerLocked(fill.layer)
        && !isCopperFillLocked(fill.layer) && isCopperFillVisible(fill.layer);
}

export function fillEditFocus(app, fill) {
    if (fill.kind === 'circle') return {};
    const nodeFocus = getBoardShapeNodeFocus(app);
    const segmentFocus = getBoardShapeSegmentFocus(app);
    const node = nodeFocus?.shapeId === fill.id ? nodeFocus.index : null;
    const segment = segmentFocus?.shapeId === fill.id ? segmentFocus.segment : null;
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

export function beginFillEdit(app, fill, point, anchor = null, segment = null) {
    settleFillGeometryPreview(app);
    return startBoardShapeDrag(app, fill, point, anchor, {
        editProfile: fillEditProfile(),
        whole: anchor == null && segment == null,
        allowSegment: segment != null,
        segment,
    });
}

export function updateFillEdit(app, point) {
    handleBoardShapeDrag(app, point);
}

export function endFillEdit(app, commit) {
    endBoardShapeDrag(app, commit);
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
        setBoardShapeNodeFocus(app, null);
        setBoardShapeSegmentFocus(app, null);
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
    setBoardShapeNodeFocus(app, node != null ? { shapeId: fill.id, index: node } : null);
    setBoardShapeSegmentFocus(app, segment != null ? { shapeId: fill.id, segment } : null);
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

/** The open pour panel per editor: its pour id and in-place refresh. */
const openFillPanels = new WeakMap();

/** Re-describe the open pour panel in place when it shows `fill` (during a drag). */
export function syncFillPanel(app, fill) {
    const panel = openFillPanels.get(app);
    if (fill && panel && panel.id === fill.id) panel.refresh();
}

/** Properties for a copper pour: Locked, Layer, Net, then its outline geometry. */
export function showFillProperties(app, fill) {
    if (!fill) return;
    const lockEntries = [{ kind: 'fill', object: fill }];
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
    const describe = () => {
        // Read on every description: locking the pour from this panel changes it.
        const lock = lockedProperty(app, lockEntries);
        return { title: 'Copper Fill', fields: [
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
        ] };
    };
    if (app.openPropertyPanel?.(describe())) {
        openFillPanels.set(app, { id: fill.id, refresh });
        createBoardShapePropertyBinding(app, fillEditProfile());
    }
}

/**
 * Properties for the Fill tool, like the other drawing tools' "New …" panels: the
 * layer, net and corner radius a new pour gets. A pour being drawn follows them.
 */
export function showFillToolProperties(app) {
    const refresh = () => app.refreshPropertyPanel?.(describe());
    const setCornerRadius = value => setFillToolDefaults(app, { cornerRadius: value });
    /** @returns {import('../../shared/ui/property-fields.js').PropertyPanel} */
    const describe = () => {
        const defaults = fillToolDefaults(app);
        return { title: 'New Fill', fields: [
            { key: 'layer', id: 'pcbPropFillToolLayer', type: 'select', label: 'Layer', value: defaults.layer,
                options: [pcbLayerOption('top-copper', 'Top Copper'), pcbLayerOption('bottom-copper', 'Bottom Copper')],
                commit: value => {
                    if (value !== 'top-copper' && value !== 'bottom-copper' || isLayerLocked(value)) { refresh(); return; }
                    setFillToolDefaults(app, { layer: value });
                    app.setPcbStatus?.();
                    refresh();
                } },
            { key: 'net', id: 'pcbPropFillToolNet', type: 'net', label: 'Net', value: defaults.net,
                nets: fillNetNames(app), commit: value => { setFillToolDefaults(app, { net: value }); refresh(); } },
            { key: 'cornerRadius', id: 'pcbPropFillToolCornerRadius', type: 'number', label: 'Corner Radius (mm)',
                value: defaults.cornerRadius, min: 0, step: 0.05,
                normalize: value => (value < 0 ? NaN : value), preview: setCornerRadius, commit: setCornerRadius },
        ] };
    };
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
    // Values show the displayed pour: a drag's or preview's live copy, else the pour.
    const shown = displayedBoardShape(app, fill) || fill;
    const shownBounds = shown.getBounds();
    const fields = [];
    // Each step previews the outline; the settled run commits once.
    const number = (id, key, label, value, min, max = Infinity, mutate) => ({
        key, id, type: 'number', label, value, min, max, step: 0.05, disabled,
        normalize: next => (next < min || next > max ? NaN : next),
        preview: next => { previewFillGeometry(app, fill, candidate => mutate(candidate, next)); },
        commit: next => {
            previewFillGeometry(app, fill, candidate => mutate(candidate, next));
            settleFillGeometryPreview(app);
            refresh();
        },
        cancel: () => {
            const active = endFillGeometryPreview(app);
            if (active) refresh();
            return active;
        },
    });
    if (node == null && segment == null) {
        fields.push({ key: 'outline', id: 'pcbPropFillKind', type: 'select', label: 'Outline', value: shown.kind,
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
            shown.nodeCornerRadii[node] ?? shown.cornerRadius, 0, Infinity,
            (fill, value) => { fill.nodeCornerRadii[node] = value; }));
    } else if (segment != null) {
        fields.push(number('pcbPropFillBulge', 'bulge', 'Bulge', shown.segmentBulges[segment] || 0, -1, 1,
            (fill, value) => {
                fill.kind = 'polygon';
                if (Math.abs(value) < 1e-4) delete fill.segmentBulges[segment];
                else fill.segmentBulges[segment] = value;
                normalizeCopperFillKind(fill);
            }));
    } else {
        if (shown.kind === 'rect' && shownBounds) {
            fields.push(
                number('pcbPropFillWidth', 'width', 'Width (mm)', shownBounds.maxX - shownBounds.minX, 0.1, Infinity,
                    (fill, value) => {
                        const current = fill.getBounds();
                        const factor = value / (current.maxX - current.minX);
                        fill.outline = fill.outline.map(point => ({ ...point, x: current.minX + (point.x - current.minX) * factor }));
                    }),
                number('pcbPropFillHeight', 'height', 'Height (mm)', shownBounds.maxY - shownBounds.minY, 0.1, Infinity,
                    (fill, value) => {
                        const current = fill.getBounds();
                        const factor = value / (current.maxY - current.minY);
                        fill.outline = fill.outline.map(point => ({ ...point, y: current.minY + (point.y - current.minY) * factor }));
                    }),
            );
        }
        if (shown.kind === 'circle') {
            fields.push(number('pcbPropFillDiameter', 'diameter', 'Diameter (mm)', shown.radius * 2, 0.1, Infinity,
                (fill, value) => { fill.radius = value / 2; }));
        } else {
            fields.push(number('pcbPropFillCornerRadius', 'cornerRadius', 'Corner Radius (mm)', shown.cornerRadius, 0, Infinity,
                (fill, value) => { fill.cornerRadius = value; fill.nodeCornerRadii = {}; }));
        }
    }
    return fields;
}