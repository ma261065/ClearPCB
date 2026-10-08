import { pcbToolBlockNotice } from './tool-lifecycle.js';
import { canonicalBoardShape, createBoardShapePropertyBinding, createBoardShapePropertyPreview, displayedBoardShape, getBoardShapeAnchors, remapBoardShapeNodeRadii } from './board-shapes.js';
import { handleBoardShapeDrag, startBoardShapeDrag, endBoardShapeDrag } from './board-shape-drag.js';
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
import { addFillWaypoint, fillToolDefaults, getFillDraw, setFillToolDefaults, startFillDraw } from './copper-fill-draw.js';
import { getPropertyEditor } from './property-editors.js';
import { loadClipper } from './copper-fill-geom.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyField} PropertyField */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyPanel} PropertyPanel */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{minX: number, minY: number, maxX: number, maxY: number}} Bounds */
/** @typedef {import('../../shapes/copper-fill.js').CopperFillState} CopperFillState */
/** @typedef {{node?: number|null, segment?: number|null}} FillEditFocus */
/** @typedef {{fill: CopperFill, control: ReturnType<typeof createBoardShapePropertyPreview>}} FillGeometryPreview */
/** @typedef {'cornerRadius'|'bulge'|'width'|'height'|'diameter'} FillGeometryKey */

/** @param {CopperFill|Record<string, unknown>} fill @returns {import('../../core/pcb-board-shapes.js').BoardShape} */
const fillBoardShape = fill => /** @type {import('../../core/pcb-board-shapes.js').BoardShape} */ (/** @type {unknown} */ (fill));

/**
 * A pour's outline follows its Properties number fields live (corner radius, size,
 * diameter, bulge) on a detached copy, while its copper waits, as during a drag, for
 * the run to settle into one ModifyFillCommand.
 */
const geometryPreviews = new WeakMap();

/**
 * board-shapes.js leaves custom edit profiles untyped, so calls into it need
 * this narrow adapter until that shared profile parameter is typed.
 * @param {ReturnType<typeof fillEditProfile>} profile
 * @returns {any}
 */
function boardShapeFillProfile(profile) {
    return profile;
}

export function fillEditProfile() {
    return {
        kind: 'fill',
        editorKey: 'fill',
        missingEditMessage: 'Cannot edit a missing copper fill.',
        missingDragMessage: 'Cannot finish a drag of a missing copper fill.',
        canonical: canonicalBoardShape,
        /** @param {PcbEditor} app @param {CopperFill} fill */
        displayed: (app, fill) => displayedBoardShape(app, fillBoardShape(fill)),
        /** @param {PcbEditor} app */
        collection: app => app.pcbDocument?.boardShapes || app.boardShapes,
        copy: /** @param {CopperFill} fill */ fill => new CopperFill(fill.captureState()),
        capture: /** @param {CopperFill} fill */ fill => fill.captureState(),
        canEdit: /** @param {PcbEditor} _app @param {CopperFill} fill */ (_app, fill) => canEditFill(fill),
        visible: /** @param {PcbEditor} _app @param {CopperFill} fill */ (_app, fill) => fill.visible !== false && isCopperFillVisible(fill.layer),
        /** @param {PcbEditor} app @param {CopperFill} fill */
        locked: (app, fill) => isPcbObjectLocked(app, 'fill', fill),
        getNodeFocus: getBoardShapeNodeFocus,
        getSegmentFocus: getBoardShapeSegmentFocus,
        setNodeFocus: setBoardShapeNodeFocus,
        setSegmentFocus: setBoardShapeSegmentFocus,
        /** @param {PcbEditor} app */
        clearFocus(app) {
            setBoardShapeNodeFocus(app, null);
            setBoardShapeSegmentFocus(app, null);
        },
        /** @param {PcbEditor} _app @param {CopperFill} fill */
        getBounds(_app, fill) { return fill.getBounds() || { minX: 0, minY: 0, maxX: 0, maxY: 0 }; },
        /** @param {PcbEditor} _app @param {CopperFill} fill @param {Point} pointer @param {number} scale */
        getLockPosition(_app, fill, pointer, scale) {
            return lockPositionOutsideOutline(fill.getOutline(), pointer, scale);
        },
        /** @param {PcbEditor} app @param {CopperFill} fill @param {Point} point @param {number} tolerance */
        hitTest(app, fill, point, tolerance) {
            return fill.distanceToEdge(point.x, point.y) <= Math.max(0.6, tolerance)
                || (isPcbSelected(app, 'fill', fill) && fillSegmentAt(fill, point, tolerance) != null);
        },
        /** @param {PcbEditor} _app @param {CopperFill} fill @param {Point} point @param {number} tolerance */
        segmentAt(_app, fill, point, tolerance) { return fillSegmentAt(fill, point, tolerance); },
        /** @param {PcbEditor} app @param {CopperFill} fill */
        getEditPath(app, fill) { return fillEditPath(app, fill); },
        anchorColor: () => '#3399ff',
        /** @param {PcbEditor} app @param {CopperFill} fill @param {{outlineOnly?: boolean}} [opts] */
        render(app, fill, opts = {}) {
            renderCopperFill(fill, id => app.getLayerGroup(id), {
                selected: isPcbSelected(app, 'fill', this.collection(app).includes(fill) ? fill : this.canonical(app, fillBoardShape(fill))),
                outlineOnly: opts.outlineOnly || !this.collection(app).includes(fill),
            });
        },
        /** @param {PcbEditor} app */
        renderHandles(app) { renderPcbSelectionAnchors(app); },
        /** @param {PcbEditor} app */
        renderSegmentSelection(app) { renderPcbSelectionAnchors(app); },
        /** @param {PcbEditor} app @param {CopperFill} fill */
        remove(app, fill) { removeCopperFillElements(fill, /** @param {string} id */ id => app.getLayerGroup(id)); },
        /** @param {PcbEditor} app @param {CopperFill} fill */
        showProperties(app, fill) { showFillProperties(app, fill); },
        /** @param {PcbEditor} app @param {CopperFill} fill */
        refreshProperties(app, fill) { refreshFillProperties(app, fill); },
        /** @param {PcbEditor} app @param {CopperFill} fill */
        syncProperties(app, fill) { syncFillPanel(app, fill); },
        propertyPreviewPrepare() {},
        /** @param {PcbEditor} app @param {CopperFill[]} changed */
        propertyPreviewRender(app, changed) {
            for (const fill of changed) this.render(app, fill, { outlineOnly: true });
        },
        /** @param {PcbEditor} app @param {CopperFill[]} originals */
        propertyPreviewCancel(app, originals) {
            for (const original of originals) {
                if (this.collection(app).includes(original)) this.render(app, original);
                else this.remove(app, original);
            }
            renderPcbSelectionAnchors(app);
        },
        /** @param {PcbEditor} app @param {CopperFill} original @param {CopperFillState} beforeState @param {CopperFillState} afterState */
        makeCommand(app, original, beforeState, afterState) {
            return new ModifyFillCommand(app, original, beforeState, afterState);
        },
        /** @param {PcbEditor} app @param {CopperFill} original @param {CopperFillState} beforeState @param {CopperFillState} afterState */
        modifyCommand(app, original, beforeState, afterState) {
            return new ModifyFillCommand(app, original, beforeState, afterState);
        },
        /** @param {PcbEditor} app @param {CopperFill} fill */
        removeCommand(app, fill) { return new RemoveFillCommand(app, fill); },
        /** @param {PcbEditor} _app @param {CopperFill} fill */
        valid(_app, fill) { return validFill(fill); },
        // A drop recomputes pours on the main thread; load the geometry library now, so the
        // first drop after opening a board does not wait for it.
        prepareDrag() { loadClipper().catch(() => {}); },
        // No dragRatsnestNets: ratlines see a pour's computed copper, which stays put until
        // the drop recomputes it, so rebuilding them while the outline moves changes nothing.
        /** @param {PcbEditor} app @param {CopperFill} original */
        afterCommit(app, original) {
            if (this.collection(app).includes(original)) {
                refreshFillProperties(app, original);
                renderPcbSelectionAnchors(app);
            }
        },
    };
}

/**
 * The live outline copy of `fill` while its Properties numbers preview, else null.
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 */
export function fillGeometryPreview(app, fill) {
    const displayed = displayedBoardShape(app, fillBoardShape(fill));
    return displayed === fill ? null : displayed;
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 * @param {(fill: CopperFill) => void} mutate
 */
function previewFillGeometry(app, fill, mutate) {
    if (!getPropertyEditor(app, 'fill')) createBoardShapePropertyBinding(app, boardShapeFillProfile(fillEditProfile()));
    let preview = geometryPreviews.get(app);
    if (preview?.fill !== fill || !preview.control.active) {
        endFillGeometryPreview(app);
        preview = { fill, control: createBoardShapePropertyPreview(app, [fill], { editProfile: boardShapeFillProfile(fillEditProfile()) }) };
        geometryPreviews.set(app, preview);
    }
    preview.control.update(/** @param {unknown} _before @param {CopperFill[]} candidates */ (_before, [candidate]) => {
        mutate(candidate);
        if (!validFill(candidate)) throw new Error('Invalid copper fill preview geometry.');
    });
    return preview.control.active;
}

/**
 * Commit a pour's live outline now. Pointer gestures call this before they save the
 * overlay deferral, so a preview ending mid-gesture cannot leave pours deferred.
 * @param {PcbEditor} app
 */
export function settleFillGeometryPreview(app) {
    const preview = geometryPreviews.get(app);
    if (!preview) return false;
    geometryPreviews.delete(app);
    return preview.control.commit({ rebuild: false });
}

/**
 * End a pour's live outline, showing the pour as it is (copper included).
 * @param {PcbEditor} app
 */
export function endFillGeometryPreview(app) {
    const preview = geometryPreviews.get(app);
    if (!preview) return false;
    geometryPreviews.delete(app);
    return preview.control.cancel();
}

/** @param {CopperFill|null|undefined} fill */
export function canEditFill(fill) {
    return fill && !fill.locked && fill.visible !== false && !isLayerLocked(fill.layer)
        && !isCopperFillLocked(fill.layer) && isCopperFillVisible(fill.layer);
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 * @returns {FillEditFocus}
 */
export function fillEditFocus(app, fill) {
    if (fill.kind === 'circle') return {};
    const nodeFocus = getBoardShapeNodeFocus(app);
    const segmentFocus = getBoardShapeSegmentFocus(app);
    const node = nodeFocus?.shapeId === fill.id ? nodeFocus.index : null;
    const segment = segmentFocus?.shapeId === fill.id ? segmentFocus.segment : null;
    return {
        node: node != null && Number.isInteger(node) && node >= 0 && node < fill.outline.length ? node : null,
        segment: segment != null && Number.isInteger(segment) && segment >= 0 && segment < fill.outline.length ? segment : null,
    };
}

/**
 * @param {CopperFill} fill
 * @param {Point} point
 * @param {number} tolerance
 */
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

/** @param {CopperFill} fill */
function validFill(fill) {
    return validBoardOutline(fillBoardShape({ ...fill, points: fill.outline, layer: 'board-outline' }));
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 * @param {(fill: CopperFill) => void} mutate
 */
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

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 * @param {Point} point
 * @param {number|string|null} [anchor]
 * @param {number|null} [segment]
 */
export function beginFillEdit(app, fill, point, anchor = null, segment = null) {
    settleFillGeometryPreview(app);
    return startBoardShapeDrag(app, fillBoardShape(fill), point, /** @type {any} */ (anchor), {
        editProfile: boardShapeFillProfile(fillEditProfile()),
        whole: anchor == null && segment == null,
        allowSegment: segment != null,
        segment: segment ?? undefined,
    });
}

/**
 * @param {PcbEditor} app
 * @param {Point} point
 */
export function updateFillEdit(app, point) {
    handleBoardShapeDrag(app, point);
}

/**
 * @param {PcbEditor} app
 * @param {boolean} commit
 */
export function endFillEdit(app, commit) {
    endBoardShapeDrag(app, commit);
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 * @param {Point} point
 */
export function startFillEditAt(app, fill, point) {
    if (!canEditFill(fill)) return false;
    const tolerance = Math.max(0.6, 8 / Math.max(0.01, app.viewport?.scale || 1));
    const anchor = getBoardShapeAnchors(fillBoardShape(fill)).find(item => Math.hypot(item.x - point.x, item.y - point.y) <= tolerance);
    if (anchor) return beginFillEdit(app, fill, point, anchor.id);
    if (fill.distanceToEdge(point.x, point.y) > tolerance) return false;
    return beginFillEdit(app, fill, point);
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 * @param {number} index
 */
export function deleteFillNode(app, fill, index) {
    if (fill.kind === 'circle' || fill.outline.length <= 3 || !Number.isInteger(index)
        || index < 0 || index >= fill.outline.length) return false;
    return commitFillEdit(app, fill, /** @param {CopperFill} fill */ fill => {
        const count = fill.outline.length;
        const previous = (index + count - 1) % count;
        fill.segmentBulges = Object.fromEntries(Object.entries(fill.segmentBulges)
            .filter(([key]) => Number(key) !== index && Number(key) !== previous)
            .map(([key, value]) => [Number(key) > index ? Number(key) - 1 : Number(key), value]));
        remapBoardShapeNodeRadii(fillBoardShape(fill), index, -1);
        fill.outline.splice(index, 1);
        normalizeCopperFillKind(fill);
        setBoardShapeNodeFocus(app, null);
        setBoardShapeSegmentFocus(app, null);
    });
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 */
export function deleteFocusedFillPart(app, fill) {
    const { node, segment } = fillEditFocus(app, fill);
    if (node == null && segment == null) return false;
    if (node != null) deleteFillNode(app, fill, node);
    else if (segment != null) deleteFillNode(app, fill, (segment + 1) % fill.outline.length);
    return true;
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 * @param {number} clientX
 * @param {number} clientY
 * @param {Point} point
 */
export function showFillContextMenu(app, fill, clientX, clientY, point) {
    if (!canEditFill(fill)) return;
    setPcbSelection(app, [{ kind: 'fill', object: fill }]);
    const tolerance = 8 / Math.max(0.01, app.viewport?.scale || 1);
    const anchor = getBoardShapeAnchors(fillBoardShape(fill)).find(item => typeof item.id === 'number'
        && Math.hypot(point.x - item.x, point.y - item.y) <= tolerance);
    const node = /** @type {number|undefined} */ (anchor?.id);
    const segment = node == null ? fillSegmentAt(fill, point, tolerance) : null;
    setBoardShapeNodeFocus(app, node != null ? { shapeId: fill.id, index: node } : null);
    setBoardShapeSegmentFocus(app, segment != null ? { shapeId: fill.id, segment } : null);
    const activeSegment = segment;
    const curved = activeSegment != null && !!fill.segmentBulges[activeSegment];
    const items = pathContextActions({ node: node != null, segment: segment != null, curved,
        deleteNode: fill.outline.length > 3 && node != null ? () => deleteFillNode(app, fill, node) : null,
        deleteSegment: fill.outline.length > 3 && activeSegment != null ? () => deleteFillNode(app, fill, (activeSegment + 1) % fill.outline.length) : null,
        convert: activeSegment != null ? () => commitFillEdit(app, fill, fill => {
            fill.kind = 'polygon';
            if (curved) delete fill.segmentBulges[activeSegment];
            else fill.segmentBulges[activeSegment] = 0.25;
            normalizeCopperFillKind(fill);
        }) : null,
        deleteObject: () => app.history.execute(new RemoveFillCommand(app, fill)), label: 'copper fill',
    });
    showFillProperties(app, fill);
    renderPcbSelectionAnchors(app);
    return showPathContextMenu('pcbBoardShapeContextMenu', /** @type {import('../../shared/ui/context-menu.js').MenuItem[]} */ (items.filter(Boolean)), clientX, clientY);
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 */
export function fillEditPath(app, fill) {
    const { node, segment } = fillEditFocus(app, fill);
    if (node != null) return '';
    if (segment != null) return arcEdgePathD(fill.outline[segment], fill.outline[(segment + 1) % fill.outline.length],
        fill.segmentBulges[segment] || 0);
    return shapePathD(fillBoardShape({ ...fill, points: fill.outline, cornerRadius: 0, nodeCornerRadii: {} }));
}

/** The open pour panel per editor: its pour id and in-place refresh. */
const openFillPanels = new WeakMap();

/**
 * Re-describe the open pour panel in place when it shows `fill` (during a drag).
 * @param {PcbEditor} app
 * @param {CopperFill|null} fill
 */
export function syncFillPanel(app, fill) {
    const panel = openFillPanels.get(app);
    if (fill && panel && panel.id === fill.id) panel.refresh();
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill|null} fill
 */
export function refreshFillProperties(app, fill) {
    if (fill && isPcbSelected(app, 'fill', fill)) showFillProperties(app, fill);
}

/**
 * Properties for a copper pour: Locked, Layer, Net, then its outline geometry.
 * @param {PcbEditor} app
 * @param {CopperFill|null} fill
 */
export function showFillProperties(app, fill) {
    if (!fill) return;
    const lockEntries = [{ kind: 'fill', object: fill }];
    const refresh = () => app.refreshPropertyPanel(describe());
    /** @param {() => void} mutate */
    const commit = (mutate) => {
        if (!canEditFill(fill)) return;
        const before = fill.captureState();
        mutate();
        const after = fill.captureState();
        fill.applyState(before);
        app.history.execute(new ModifyFillCommand(app, fill, before, after));
        refresh();
    };
    /** @returns {PropertyPanel} */
    const describe = () => {
        // Read on every description: locking the pour from this panel changes it.
        const lock = lockedProperty(app, lockEntries);
        return { title: 'Copper Fill', fields: [
            { ...lock.field, commit: value => { /** @type {(value: boolean) => void} */ (lock.field.commit)(value); refresh(); } },
            { key: 'layer', id: 'pcbPropFillLayer', type: 'select', label: 'Layer', value: fill.layer,
                disabled: lock.readOnly, options: [
                    pcbLayerOption('top-copper', 'Top Copper'),
                    pcbLayerOption('bottom-copper', 'Bottom Copper'),
                ], commit: value => {
                    if (fill.layer === value || isLayerLocked(value)) { refresh(); return; }
                    commit(() => { fill.layer = value; });
                } },
            { key: 'net', id: 'pcbPropFillNet', type: 'net', label: 'Net', value: fill.net || '', disabled: lock.readOnly,
                nets: app.netNames(), commit: value => {
                    if ((fill.net || '') === value) return;
                    commit(() => { fill.net = value; });
                } },
            ...addFillGeometryProperties(app, fill, lock.readOnly, refresh),
        ] };
    };
    if (app.openPropertyPanel(describe())) {
        openFillPanels.set(app, { id: fill.id, refresh });
        createBoardShapePropertyBinding(app, boardShapeFillProfile(fillEditProfile()));
    }
}

/**
 * Properties for the Fill tool, like the other drawing tools' "New …" panels: the
 * layer, net and corner radius a new pour gets. A pour being drawn follows them.
 * @param {PcbEditor} app
 */
export function showFillToolProperties(app) {
    const refresh = () => app.refreshPropertyPanel(describe());
    /** @param {number} value */
    const setCornerRadius = value => setFillToolDefaults(app, { cornerRadius: value });
    /** @returns {PropertyPanel} */
    const describe = () => {
        const defaults = fillToolDefaults(app);
        const notice = pcbToolBlockNotice(app, 'fill');
        return { title: 'New Fill', actions: notice.actions, fields: [
            { key: 'layer', id: 'pcbPropFillToolLayer', type: 'select', label: 'Layer', value: defaults.layer, warning: notice.warning,
                options: [pcbLayerOption('top-copper', 'Top Copper'), pcbLayerOption('bottom-copper', 'Bottom Copper')],
                commit: value => {
                    if (value !== 'top-copper' && value !== 'bottom-copper' || isLayerLocked(value)) { refresh(); return; }
                    setFillToolDefaults(app, { layer: value });
                    app.setPcbStatus();
                    refresh();
                } },
            { key: 'net', id: 'pcbPropFillToolNet', type: 'net', label: 'Net', value: defaults.net,
                nets: app.netNames(), commit: value => { setFillToolDefaults(app, { net: value }); refresh(); } },
            { key: 'cornerRadius', id: 'pcbPropFillToolCornerRadius', type: 'number', label: 'Corner Radius (mm)',
                value: defaults.cornerRadius, min: 0, step: 0.05,
                normalize: value => (value < 0 ? NaN : value), preview: setCornerRadius, commit: setCornerRadius },
        ] };
    };
    app.openPropertyPanel(describe());
}

/**
 * @param {PcbEditor} app
 * @param {CopperFill} fill
 * @param {boolean} [disabled]
 * @param {() => void} [refresh]
 * @returns {PropertyField[]}
 */
export function addFillGeometryProperties(app, fill, disabled = false, refresh = () => {}) {
    const { node, segment } = fillEditFocus(app, fill);
    const bounds = fill.getBounds();
    // Values show the displayed pour: a drag's or preview's live copy, else the pour.
    const shown = displayedBoardShape(app, fillBoardShape(fill)) || fill;
    const shownBounds = shown.getBounds();
    /** @type {PropertyField[]} */
    const fields = [];
    // Each step previews the outline; the settled run commits once.
    /**
     * @param {string} id
     * @param {FillGeometryKey} key
     * @param {string} label
     * @param {number} value
     * @param {number} min
     * @param {number} max
     * @param {(fill: CopperFill, value: number) => void} mutate
     * @returns {PropertyField}
     */
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
                if (commitFillEdit(app, fill, /** @param {CopperFill} fill */ fill => {
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
                        const current = /** @type {Bounds} */ (fill.getBounds());
                        const factor = value / (current.maxX - current.minX);
                        fill.outline = fill.outline.map((point) => ({ ...point, x: current.minX + (point.x - current.minX) * factor }));
                    }),
                number('pcbPropFillHeight', 'height', 'Height (mm)', shownBounds.maxY - shownBounds.minY, 0.1, Infinity,
                    (fill, value) => {
                        const current = /** @type {Bounds} */ (fill.getBounds());
                        const factor = value / (current.maxY - current.minY);
                        fill.outline = fill.outline.map((point) => ({ ...point, y: current.minY + (point.y - current.minY) * factor }));
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

/**
 * A primary press with the Fill tool: start a pour outline, or add its next corner.
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function pressFillTool(app, worldPos) {
    if (getFillDraw(app)) {
        addFillWaypoint(app, worldPos);
        return;
    }
    startFillDraw(app, worldPos);
    // Drawing a pour shows the Fill tool's Properties (a finished pour showed its own).
    showFillToolProperties(app);
}
