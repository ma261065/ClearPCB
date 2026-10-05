/**
 * Properties-panel UI for PCB board shapes and the shape drawing tools: builds
 * the panel markup, binds its inputs to live property previews, and commits
 * edits through board-shape commands. Geometry, rendering and interaction stay
 * in board-shapes.js.
 */

import { bulgePointFromRatio } from '../../core/geometry.js';
import { displayRotationDegrees, formatNumberInputValue } from '../../core/number-inputs.js';
import { canRoundPathNode } from '../../shapes/path-geometry.js';
import { SHAPE_KINDS, applyShapeGeometry, applyShapeSnapshot, captureBoardShapeState as shapeSnapshot } from '../../core/pcb-board-shapes.js';
import { isLayerLocked, PCB_LAYERS, pcbLayerOption, setPcbLayerLocked } from './layers.js';
import { lockedProperty } from './object-locks.js';
import { ModifyBoardShapeCommand } from './shape-commands.js';
import { CompoundCommand } from './track-commands.js';
import { getPcbSelection, getPcbSelectionEntries, isPcbSelected, syncPcbSelection } from './selection-registry.js';
import { showPcbSelectionProperties } from './selection-interaction.js';
import { PICTURE_LAYERS } from '../../shared/pcb/picture-raster.js';
import { pictureRefreshHold } from './picture-refresh.js';
import { rotatedImagePoints } from './rotation-handle.js';
import { BULGE_EPS } from '../../shapes/arc-edge.js';
import { boardBoundary } from '../../shared/pcb/board-outline.js';
import { getPropertyEditor } from './property-editors.js';
import { normalizeShapeCopperMode, isMaskLayer, rectCornerRadius, polygonCornerRadius, boardShapeNodeCornerRadius, circleFilledRadius, boardShapeSegmentBulge, shapeOutline, boardShapeLineWidthMinimum, normalizedBoardShapeLineWidth, boardShapeSegmentWidth } from '../../shared/pcb/board-shape-geometry.js';
import {
    copperPathReplacementCommands,
    canonicalBoardShape,
    collapseCollinearPolylinePoints,
    selectReplacementTracks,
    copyBoardShape,
    createBoardShapePropertyBinding,
    createBoardShapePropertyPreview,
    displayedBoardShape,
    editableShapeBulge,
    normalizeStraightArc,
    resolveShapeDrawLayer,
    setBoardShapeNodeCornerRadius,
    shapeKindLabel,
    updateShapeDrawPreview,
} from './board-shapes.js';
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus, getShapeDefaults } from './board-shape-state.js';

// ── Properties panel ─────────────────────────────────────────────────────────

export const PROP_HIDDEN_LAYERS = new Set([
    'top-paste', 'bottom-paste',
    'top-mask', 'bottom-mask',
    'board-outline', 'vias',
]);

const COPPER_MODE_OPTIONS = [
    { value: 'add', label: 'Add Copper' },
    { value: 'remove-copper', label: 'Remove Copper' },
    { value: 'remove-solder-mask', label: 'Remove Solder Mask' },
    { value: 'remove-copper-mask', label: 'Remove Copper + Mask' },
];

function boardNetNames(app) {
    const netNames = new Set((app.netlist || []).map((entry) => String(entry.net || '')).filter(Boolean));
    for (const source of [app.tracks, app.vias, app.boardShapes, app.copperFills]) {
        for (const item of source || []) {
            const net = String(item?.net || '');
            if (net) netNames.add(net);
        }
    }
    return [...netNames].sort();
}

/**
 * Show Properties-tab controls for the active board-shape tool. These edit
 * creation defaults (and an unfinished draw), rather than a saved shape.
 * @param {object} app
 * @param {'line'|'circle'|'rect'|'polygon'|'arc'} kind
 */
export function showBoardShapeToolProperties(app, kind) {
    const defaults = getShapeDefaults(app);
    const currentLayer = app._shapeDraw?.layer || resolveShapeDrawLayer(app, app.activeLayer);
    if (!app._shapeDraw && currentLayer) app.activeLayer = currentLayer;
    const redraw = () => updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
    const refresh = () => app.refreshPropertyPanel?.(describe());
    const describe = () => {
        const layer = app._shapeDraw?.layer || resolveShapeDrawLayer(app, app.activeLayer);
        const copper = layer === 'top-copper' || layer === 'bottom-copper';
        const showFill = layer !== 'hole' && kind !== 'line';
        const showLineWidth = (layer !== 'hole' || kind === 'line') && !defaults.filled;
        const lineWidthMinimum = boardShapeLineWidthMinimum({ kind, layer });
        return {
            title: `New ${shapeKindLabel(kind)}`,
            fields: [
                { key: 'layer', id: 'pcbToolShapeLayer', type: 'select', label: 'Layer', value: layer || '', disabled: !layer,
                    options: layer ? PCB_LAYERS.filter(item => !PROP_HIDDEN_LAYERS.has(item.id))
                        .map(item => pcbLayerOption(item.id, item.name)) : [{ value: '', label: 'No unlocked layers', disabled: true }],
                    commit: next => {
                        if (!next || isLayerLocked(next)) { refresh(); return; }
                        app.activeLayer = next;
                        app.setPcbStatus?.();
                        if (app._shapeDraw?.kind === kind) app._shapeDraw.layer = next;
                        redraw();
                        showBoardShapeToolProperties(app, kind);
                    } },
                ...(copper ? [{ key: 'copperMode', id: 'pcbToolShapeCopperMode', type: 'select', label: 'Copper Mode',
                    value: normalizeShapeCopperMode(defaults.copperMode), options: COPPER_MODE_OPTIONS, commit: value => {
                        defaults.copperMode = normalizeShapeCopperMode(value);
                        redraw();
                        refresh();
                    } }] : []),
                ...(copper && normalizeShapeCopperMode(defaults.copperMode) === 'add'
                    ? [{ key: 'net', id: 'pcbToolShapeNet', type: 'net', label: 'Net', value: defaults.net || '',
                        nets: boardNetNames(app), commit: value => { defaults.net = value.trim(); } }] : []),
                ...(showFill ? [{ key: 'fill', id: 'pcbToolShapeFilled', type: 'checkbox', label: 'Fill', value: !!defaults.filled,
                    commit: value => { defaults.filled = !!value; redraw(); refresh(); } }] : []),
                ...(layer === 'hole' ? [{ key: 'plated', id: 'pcbToolShapePlated', type: 'checkbox', label: 'Plated',
                    value: !!defaults.plated, commit: value => { defaults.plated = !!value; } }] : []),
                ...(showLineWidth ? [{ key: 'lineWidth', id: 'pcbToolShapeLineWidth', type: 'number', label: 'Line Width (mm)',
                    value: normalizedBoardShapeLineWidth({ kind, layer }, defaults.lineWidth), min: lineWidthMinimum, step: 0.05,
                    format: value => Number(value).toFixed(2), preview: value => {
                        const next = normalizedBoardShapeLineWidth({ kind, layer }, value);
                        if (defaults.lineWidth === next) return;
                        defaults.lineWidth = next;
                        redraw();
                        refresh();
                    }, commit: () => {} }] : []),
                ...(kind === 'rect' ? [{ key: 'cornerRadius', id: 'pcbToolShapeCornerRadius', type: 'number',
                    label: 'Corner Radius (mm)', value: Math.max(0, Number(defaults.cornerRadius) || 0), min: 0, max: 25, step: 0.5,
                    format: value => Number(value).toFixed(2), normalize: value => Math.min(25, Math.max(0, value)),
                    preview: value => {
                        const next = Math.min(25, Math.max(0, value));
                        if (defaults.cornerRadius === next) return;
                        defaults.cornerRadius = next;
                        redraw();
                        refresh();
                    }, commit: () => {} }] : []),
            ],
        };
    };
    if (!app.openPropertyPanel?.(describe())) return;
    app.setPcbStatus?.();
}

export function refreshBoardShapeToolLayer(app) {
    if (!SHAPE_KINDS.has(app.currentTool) || app.currentTool === 'image') return;
    if (app._shapeDraw) return;
    showBoardShapeToolProperties(app, app.currentTool);
}

export function showImageProperties(app, shape) {
    if (getPropertyEditor(app, 'boardShape')?.committing) return;
    shape = canonicalBoardShape(app, shape);
    let binding = null;
    let widthPreview = null;
    let heightPreview = null;
    let rotationPreview = null;
    const hold = pictureRefreshHold(app);
    const geometryValues = () => {
        const { points } = displayedBoardShape(app, shape);
        return {
            width: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
            height: Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y),
            rotation: ((-Math.atan2(points[1].y - points[0].y,
                points[1].x - points[0].x) * 180 / Math.PI) % 360 + 360) % 360,
        };
    };
    const lockEntries = [{ kind: 'shape', object: shape }];
    const lock = lockedProperty(app, lockEntries);
    const readOnly = lock.readOnly;
    const refresh = () => { if (!binding?.disposed) app.refreshPropertyPanel?.(describe()); };
    const commit = mutate => {
        if (!binding?.prepare()) return;
        const before = shapeSnapshot(shape);
        const candidate = copyBoardShape(shape);
        mutate(candidate);
        const after = shapeSnapshot(candidate);
        if (JSON.stringify(before) !== JSON.stringify(after)) app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
        refresh();
    };
    const finishPreview = preview => {
        if (!preview || binding?.disposed) return;
        preview.commit({ rebuild: false });
        refresh();
    };
    const cancelPreview = preview => {
        const active = preview?.cancel() || false;
        refresh();
        return active;
    };
    const previewResize = (axis, value) => {
            if (binding?.disposed) return;
            const { width, height } = geometryValues();
            const dimension = axis === 'width' ? width : height;
            const factor = value / dimension;
            if (!Number.isFinite(factor) || value < 0.1 || Math.max(width, height) * factor > 500) return;
            const current = displayedBoardShape(app, shape);
            const edge = axis === 'width' ? 1 : 3;
            if (Math.abs(Math.hypot(current.points[edge].x - current.points[0].x,
                current.points[edge].y - current.points[0].y) - value) < 1e-9) return;
            const resizePreview = axis === 'width' ? widthPreview : heightPreview;
            resizePreview.update((before, [candidate]) => {
                applyShapeSnapshot(candidate, before[0]);
                const baseline = Math.hypot(candidate.points[edge].x - candidate.points[0].x,
                    candidate.points[edge].y - candidate.points[0].y);
                const scale = value / baseline;
                const center = { x: (candidate.points[0].x + candidate.points[2].x) / 2, y: (candidate.points[0].y + candidate.points[2].y) / 2 };
                if (scale !== 1) candidate.points = candidate.points.map(point => ({ x: center.x + (point.x - center.x) * scale,
                    y: center.y + (point.y - center.y) * scale }));
            });
            refresh();
    };
    const previewRotation = value => {
        if (binding?.disposed) return;
        if (!Number.isFinite(value)) return;
        const next = ((Math.round(value) % 360) + 360) % 360;
        const current = displayedBoardShape(app, shape);
        const currentAngle = ((-Math.atan2(current.points[1].y - current.points[0].y,
            current.points[1].x - current.points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
        if (Math.abs(next - currentAngle) < 1e-9) return;
        rotationPreview.update((before, [candidate]) => {
            applyShapeSnapshot(candidate, before[0]);
            const baseline = ((-Math.atan2(candidate.points[1].y - candidate.points[0].y,
                candidate.points[1].x - candidate.points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
            const center = { x: (candidate.points[0].x + candidate.points[2].x) / 2,
                y: (candidate.points[0].y + candidate.points[2].y) / 2 };
            if (next !== baseline) candidate.points = rotatedImagePoints(candidate.points, center, next - baseline);
        });
        refresh();
    };
    const describe = () => {
        const { width, height, rotation } = geometryValues();
        const names = [...new Set([...boardNetNames(app), String(shape.net || '')])].filter(Boolean).sort();
        return {
            title: 'Image',
            fields: [
                lock.field,
                { key: 'layer', id: 'pcbPropImageLayer', type: 'select', label: 'Layer', value: shape.layer, disabled: readOnly,
                    options: PCB_LAYERS.filter(layer => PICTURE_LAYERS.includes(layer.id)).map(layer => pcbLayerOption(layer.id, layer.name)),
                    commit: value => {
                        if (!PICTURE_LAYERS.includes(value) || isLayerLocked(value)) { refresh(); return; }
                        commit(candidate => { candidate.layer = value; });
                    } },
                ...(shape.layer.endsWith('copper') ? [{ key: 'net', id: 'pcbPropImageNet', type: 'select', label: 'Net',
                    value: shape.net || '', disabled: readOnly, options: [{ value: '', label: 'Unassigned' },
                        ...names.map(name => ({ value: name, label: name }))],
                    commit: value => commit(candidate => { candidate.net = value.trim(); }) }] : []),
                { key: 'width', id: 'pcbPropImageWidth', type: 'number', label: 'Width (mm)', value: width, min: 0.1, max: 500,
                    step: 0.1, hold, format: value => Number(value).toFixed(2), disabled: readOnly,
                    preview: value => previewResize('width', value), commit: () => finishPreview(widthPreview),
                    cancel: () => cancelPreview(widthPreview) },
                { key: 'height', id: 'pcbPropImageHeight', type: 'number', label: 'Height (mm)', value: height, min: 0.1, max: 500,
                    step: 0.1, hold, format: value => Number(value).toFixed(2), disabled: readOnly,
                    preview: value => previewResize('height', value), commit: () => finishPreview(heightPreview),
                    cancel: () => cancelPreview(heightPreview) },
                { key: 'rotation', id: 'pcbPropImageRot', type: 'number', label: 'Rotation (°)', value: Math.round(rotation) % 360,
                    step: 1, numberFormat: 'rotation', hold, format: displayRotationDegrees, disabled: readOnly,
                    normalize: value => ((Math.round(value) % 360) + 360) % 360,
                    preview: previewRotation, commit: () => finishPreview(rotationPreview),
                    cancel: () => cancelPreview(rotationPreview) },
                { key: 'flipHorizontal', id: 'pcbPropImageFlipHorizontal', type: 'checkbox', label: 'Flip Horizontal',
                    value: !!shape.artwork.flipHorizontal, disabled: readOnly,
                    commit: value => commit(candidate => { candidate.artwork = { ...candidate.artwork, flipHorizontal: value }; }) },
                { key: 'flipVertical', id: 'pcbPropImageFlipVertical', type: 'checkbox', label: 'Flip Vertical',
                    value: !!shape.artwork.flipVertical, disabled: readOnly,
                    commit: value => commit(candidate => { candidate.artwork = { ...candidate.artwork, flipVertical: value }; }) },
                { key: 'invert', id: 'pcbPropImageInvert', type: 'checkbox', label: 'Invert',
                    value: !!shape.artwork.invert, disabled: readOnly,
                    commit: value => commit(candidate => { candidate.artwork = { ...candidate.artwork, invert: value }; }) },
            ],
        };
    };
    if (!app.openPropertyPanel?.(describe(), shape)) return;
    binding = createBoardShapePropertyBinding(app);
    widthPreview = createBoardShapePropertyPreview(app, [shape], { liveDrag: true });
    heightPreview = createBoardShapePropertyPreview(app, [shape], { liveDrag: true });
    rotationPreview = createBoardShapePropertyPreview(app, [shape], { liveDrag: true });
    refresh();
}

export function showBoardShapeProperties(app, shape) {
    if (getPropertyEditor(app, 'boardShape')?.committing) return;
    shape = canonicalBoardShape(app, shape);
    if (app._shapeDrag?.original === shape) shape = app._shapeDrag.shape;
    if (!shape) return;
    syncPcbSelection(app);
    app.setPcbStatus?.();

    const selectedTargets = getPcbSelection(app, 'shape');
    const propertyOriginals = (selectedTargets.length > 0 ? selectedTargets : [shape])
        .map(target => canonicalBoardShape(app, target));
    const propertyTargets = () => propertyOriginals.map(target => displayedBoardShape(app, target));
    const initialTargets = propertyTargets();
    const outlineTarget = initialTargets.length === 1 && shape.layer === 'board-outline';
    const hasOutline = initialTargets.some(target => target.layer === 'board-outline');
    const outlineBounds = outlineTarget ? boardBoundary(app) : null;
    if (initialTargets.some(target => target.kind === 'image')) {
        if (initialTargets.length === 1) showImageProperties(app, shape);
        else app._showPcbMultiSelectionProperties?.(
            initialTargets.map((object) => ({ kind: 'shape', object })),
        );
        return;
    }
    const segmentFocus = getBoardShapeSegmentFocus(app);
    const selectedSegment = initialTargets.length === 1 && segmentFocus?.shapeId === shape.id
        && (shape.kind === 'arc' || shape.points?.[segmentFocus.segment])
        ? segmentFocus.segment : null;
    const selectedNode = initialTargets.length === 1
        && getBoardShapeNodeFocus(app)?.shapeId === shape.id
        && shape.points?.[getBoardShapeNodeFocus(app).index]
        ? getBoardShapeNodeFocus(app).index
        : null;
    const panelTitle = () => {
        const mixedKind = initialTargets.some((target) => target.kind !== initialTargets[0].kind);
        const segmentLabel = shape.kind === 'arc' || boardShapeSegmentBulge(shape, selectedSegment) ? 'Arc' : 'Line';
        const standalone = shape.kind === 'arc' || (shape.kind === 'line' && shape.points.length === 2);
        return outlineTarget
        ? selectedNode != null ? 'Board Outline Node'
            : selectedSegment != null ? 'Board Outline Segment'
                : 'Board Outline'
        : selectedNode != null ? `${shapeKindLabel(shape.kind)} Node`
            : selectedSegment != null ? `${segmentLabel}${standalone ? '' : ' Segment'}`
                : mixedKind ? 'Mixed' : shapeKindLabel(initialTargets[0].kind);
    };
    const diameterMinimum = () => Number(Math.max(...propertyTargets().map(
        (target) => boardShapeLineWidthMinimum(target) + 0.1,
    )).toFixed(6));
    const allCircleTargets = initialTargets.every((target) => target.kind === 'circle');
    const allRoundedTargets = initialTargets.every((target) => ['line', 'rect', 'polygon'].includes(target.kind));
    const targetCornerRadius = (target) => target.kind === 'rect'
        ? rectCornerRadius(target)
        : polygonCornerRadius(target);
    const isCopperLayer = (id) => id === 'top-copper' || id === 'bottom-copper';
    const lockEntries = selectedNode == null && selectedSegment == null && !hasOutline
        ? propertyOriginals.map(object => ({ kind: 'shape', object })) : [];
    const lock = lockEntries.length ? lockedProperty(app, lockEntries) : null;
    const readOnly = !!lock?.readOnly;
    const hold = pictureRefreshHold(app);
    let binding = null;
    let lineWidthPreview = null;
    let diameterPreview = null;
    let cornerRadiusPreview = null;
    let nodeCornerRadiusPreview = null;
    let bulgePreview = null;
    const refresh = () => { if (!binding?.disposed) app.refreshPropertyPanel?.(describe()); };

    /** Apply an edit; returns true when it turned the shapes into Tracks (the shape panel is then stale). */
    const commit = (mutate) => {
        if (!binding?.prepare()) return false;
        const tracks = [];
        const commands = propertyTargets().flatMap(displayed => {
            const target = canonicalBoardShape(app, displayed);
            const before = shapeSnapshot(target), candidate = copyBoardShape(target);
            mutate(candidate);
            if (isMaskLayer(candidate.layer)) candidate.filled = true;
            candidate.copperMode = normalizeShapeCopperMode(candidate.copperMode);
            const after = shapeSnapshot(candidate);
            if (JSON.stringify(before) === JSON.stringify(after)) return [];
            // An edit that makes the shape a copper path (unfilled, additive,
            // on copper) turns it into a Track in the same undo step.
            const replacement = copperPathReplacementCommands(app, target, candidate);
            if (!replacement) return [new ModifyBoardShapeCommand(app, target, before, after)];
            tracks.push(replacement.track);
            return replacement.commands;
        });
        if (!commands.length) return false;
        app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
        if (tracks.length) {
            selectReplacementTracks(app, tracks);
            return true;
        }
        app._refreshPcbSelectionHighlights?.();
        return false;
    };
    const finishPreview = preview => {
        if (!preview || binding?.disposed) return;
        preview.commit({ rebuild: false });
        refresh();
    };
    const cancelPreview = preview => {
        const active = preview?.cancel() || false;
        refresh();
        return active;
    };
    const previewCornerRadius = value => {
        if (binding?.disposed) return;
        const radius = Math.min(25, Math.max(0, value));
        const targets = propertyTargets().filter((target) => ['line', 'rect', 'polygon'].includes(target.kind));
        if (targets.every((target) => Math.abs(targetCornerRadius(target) - radius) < 1e-9
            && !Object.keys(target.nodeCornerRadii || {}).length)) return;
        cornerRadiusPreview.update((_before, copies) => {
            for (const target of copies) {
                target.cornerRadius = radius;
                target.nodeCornerRadii = {};
            }
        });
        refresh();
    };

    const previewNodeCornerRadius = value => {
        if (binding?.disposed || selectedNode == null) return;
        const radius = Math.min(25, Math.max(0, value));
        if (Math.abs(boardShapeNodeCornerRadius(displayedBoardShape(app, shape), selectedNode) - radius) < 1e-9) return;
        nodeCornerRadiusPreview.update((_before, [candidate]) => setBoardShapeNodeCornerRadius(candidate, selectedNode, radius));
        refresh();
    };

    const previewDiameter = value => {
        if (binding?.disposed) return;
        const diameter = Number(value.toFixed(6));
        if (diameter < diameterMinimum()) return;
        const targets = propertyTargets().filter((target) => target.kind === 'circle');
        if (targets.every((target) => Math.abs(circleFilledRadius(target) * 2 - diameter) < 1e-9)) return;
        diameterPreview.update((before, copies) => {
            copies.forEach((target, index) => {
                target.lineWidth = Math.min(normalizedBoardShapeLineWidth(target, before[index].lineWidth), diameter / 2);
                target.radius = Math.max(0.05, diameter / 2);
            });
        });
        refresh();
    };

    const previewLineWidth = value => {
        if (binding?.disposed) return;
        const targets = propertyTargets();
        const minimum = Math.max(...targets.map((target) => boardShapeLineWidthMinimum(target)));
        const maximum = selectedSegment == null
            ? Math.min(...targets.map((target) => target.kind === 'circle' ? circleFilledRadius(target) : Infinity))
            : Infinity;
        const v = Math.max(minimum, Math.min(maximum, value));
        if (selectedSegment != null && Math.abs(v - boardShapeSegmentWidth(displayedBoardShape(app, shape), selectedSegment)) < 1e-9) return;
        if (selectedSegment == null
            && targets.every((target) => Math.abs(v - (Number(target.lineWidth) || 0.2)) < 1e-9
                && !Object.keys(target.segmentWidths || {}).length)) return;
        lineWidthPreview.update((_before, copies) => {
            for (const target of copies) {
                if (selectedSegment != null && target.kind !== 'arc') {
                    target.segmentWidths ||= {};
                    if (Math.abs(v - normalizedBoardShapeLineWidth(target, target.lineWidth)) < 1e-9) {
                        delete target.segmentWidths[selectedSegment];
                    } else {
                        target.segmentWidths[selectedSegment] = v;
                    }
                } else {
                    target.lineWidth = v;
                    target.segmentWidths = {};
                }
            }
        });
        refresh();
    };
    const previewBulge = value => {
        if (binding?.disposed) return;
        value = Number(formatNumberInputValue(Math.max(-1, Math.min(1, value))));
        if (value === editableShapeBulge(displayedBoardShape(app, shape), selectedSegment)) return;
        bulgePreview.update((_before, [candidate]) => {
            if (candidate.kind === 'arc') candidate.bulge = bulgePointFromRatio(candidate.start, candidate.end, value);
            else if (selectedSegment != null) {
                candidate.segmentBulges ||= {};
                candidate.segmentBulges[selectedSegment] = value;
            }
        });
        refresh();
    };
    const commitBulge = () => {
        if (binding?.disposed) return;
        if (!bulgePreview.active && Math.abs(editableShapeBulge(displayedBoardShape(app, shape), selectedSegment)) < BULGE_EPS) {
            bulgePreview.update(() => {});
        }
        finishPreview(bulgePreview);
    };
    const commitAndRefresh = (mutate, rebuild = false) => {
        const replaced = commit(mutate);
        if (!replaced) (rebuild ? showBoardShapeProperties(app, shape) : refresh());
        return replaced;
    };
    const outlineDimensionField = (key, id, label, axis, dimension) => ({
        key, id, type: 'number', label, value: outlineBounds?.[dimension] ?? 0, min: 0.1, step: 1,
        format: formatNumberInputValue, disabled: isLayerLocked(shape.layer),
        commit: value => {
            if (isLayerLocked(shape.layer) || !Number.isFinite(value) || value < 0.1) return;
            const bounds = boardBoundary(app);
            const factor = value / bounds[dimension];
            commitAndRefresh(candidate => {
                candidate.points = candidate.points.map(point => ({ ...point, [axis]: bounds[axis] + (point[axis] - bounds[axis]) * factor }));
            }, true);
        },
    });
    const describe = () => {
        const targets = propertyTargets();
        const lineWidthMinimum = Math.max(...targets.map((target) => boardShapeLineWidthMinimum(target)));
        const initialLineWidth = selectedSegment == null
            ? normalizedBoardShapeLineWidth(targets[0], targets[0].lineWidth)
            : boardShapeSegmentWidth(displayedBoardShape(app, shape), selectedSegment);
        const mixedLineWidth = selectedSegment == null && targets.some(
            (target) => Math.abs(normalizedBoardShapeLineWidth(target, target.lineWidth) - initialLineWidth) >= 1e-9,
        );
        const mixedFill = targets.some((target) => !!target.filled !== !!targets[0].filled);
        const initialDiameter = allCircleTargets ? circleFilledRadius(targets[0]) * 2 : 0;
        const mixedDiameter = allCircleTargets && targets.some(
            (target) => Math.abs(circleFilledRadius(target) * 2 - initialDiameter) >= 1e-9,
        );
        const initialCornerRadius = allRoundedTargets ? targetCornerRadius(targets[0]) : 0;
        const mixedCornerRadius = allRoundedTargets && targets.some(
            (target) => Math.abs(targetCornerRadius(target) - initialCornerRadius) >= 1e-9,
        );
        const currentLayer = String(targets[0].layer || 'top-silk');
        const mixedLayer = targets.some((target) => String(target.layer || 'top-silk') !== currentLayer);
        const holeTargets = targets.filter((target) => target.layer === 'hole');
        const showFill = !hasOutline && targets.every((target) => target.layer !== 'hole' && target.kind !== 'line');
        const showLineWidth = !hasOutline && targets.every(
            (target) => (target.layer !== 'hole' || target.kind === 'line') && !target.filled,
        );
        const showPlated = targets.every((target) => target.layer === 'hole');
        const mixedPlated = holeTargets.some((target) => !!target.plated !== !!holeTargets[0]?.plated);
        const hasCopperTarget = targets.some((target) => isCopperLayer(target.layer));
        const showCopperMode = hasCopperTarget;
        const allCopperTargets = targets.every((target) => isCopperLayer(target.layer));
        const initialCopperMode = normalizeShapeCopperMode(targets[0].copperMode);
        const mixedCopperMode = targets.some(
            (target) => normalizeShapeCopperMode(target.copperMode) !== initialCopperMode,
        );
        const initialNet = String(targets[0].net || '');
        const mixedNet = targets.some((target) => String(target.net || '') !== initialNet);
        const showNet = allCopperTargets && targets.every(
            (target) => normalizeShapeCopperMode(target.copperMode) === 'add',
        );
        const showBulge = targets.length === 1 && selectedNode == null
            && (shape.kind === 'arc' || (selectedSegment != null && boardShapeSegmentBulge(displayedBoardShape(app, shape), selectedSegment) !== 0));
        const fields = [];
        if (selectedNode != null) {
            fields.push(
                { key: 'x', id: 'pcbPropShapeNodeX', type: 'readout', label: 'X (mm)', value: formatNumberInputValue(shape.points[selectedNode].x) },
                { key: 'y', id: 'pcbPropShapeNodeY', type: 'readout', label: 'Y (mm)', value: formatNumberInputValue(shape.points[selectedNode].y) },
            );
            if (canRoundPathNode(shape, selectedNode)) fields.push({ key: 'cornerRadius', id: 'pcbPropShapeNodeCornerRadius',
                type: 'number', label: 'Corner Radius (mm)', value: boardShapeNodeCornerRadius(displayedBoardShape(app, shape), selectedNode),
                min: 0, max: 25, step: 0.5, hold, format: formatNumberInputValue,
                normalize: value => Math.min(25, Math.max(0, value)), preview: previewNodeCornerRadius,
                commit: () => finishPreview(nodeCornerRadiusPreview), cancel: () => cancelPreview(nodeCornerRadiusPreview) });
        } else if (selectedSegment != null) {
            if (!hasOutline) fields.push({ key: 'lineWidth', id: 'pcbPropShapeLineWidth', type: 'number',
                label: 'Line Width (mm)', value: initialLineWidth, min: lineWidthMinimum, step: 0.05, hold,
                format: value => Number(value).toFixed(2), formatStepped: true,
                preview: previewLineWidth, commit: () => finishPreview(lineWidthPreview), cancel: () => cancelPreview(lineWidthPreview) });
            if (showBulge) fields.push({ key: 'bulge', id: 'pcbPropShapeBulge', type: 'number', label: 'Bulge',
                value: editableShapeBulge(displayedBoardShape(app, shape), selectedSegment), min: -1, max: 1, step: 0.05, hold,
                format: formatNumberInputValue, normalize: value => Math.max(-1, Math.min(1, value)),
                preview: previewBulge, commit: commitBulge, cancel: () => cancelPreview(bulgePreview) });
        } else {
            if (lock) fields.push({ ...lock.field, commit: value => { lock.field.commit(value); showBoardShapeProperties(app, shape); } });
            if (outlineTarget) {
                fields.push(
                    { key: 'locked', id: 'pcbPropOutlineLocked', type: 'checkbox', label: 'Locked',
                        value: isLayerLocked('board-outline'), commit: value => { setPcbLayerLocked(app, 'board-outline', value); refresh(); } },
                    { key: 'outline', id: 'pcbPropOutlineKind', type: 'select', label: 'Outline', value: shape.kind,
                        disabled: isLayerLocked(shape.layer), options: ['rect', 'polygon', 'circle']
                            .map(kind => ({ value: kind, label: shapeKindLabel(kind) })),
                        commit: value => {
                            if (isLayerLocked(shape.layer) || shape.kind === value || !['rect', 'polygon', 'circle'].includes(value)) return;
                            const bounds = boardBoundary(app);
                            const keepCorners = shape.kind === 'rect' && value === 'polygon';
                            const points = keepCorners ? shape.points.map(point => ({ ...point })) : shapeOutline(shape);
                            commitAndRefresh(candidate => {
                                candidate.kind = value;
                                if (!keepCorners) {
                                    candidate.segmentBulges = {};
                                    candidate.nodeCornerRadii = {};
                                    candidate.cornerRadius = 0;
                                }
                                applyShapeGeometry(candidate, candidate.kind === 'circle'
                                    ? { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, radius: Math.min(bounds.w, bounds.h) / 2 }
                                    : { points: candidate.kind === 'polygon' ? points : [
                                        { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y },
                                        { x: bounds.x + bounds.w, y: bounds.y + bounds.h }, { x: bounds.x, y: bounds.y + bounds.h }] });
                            }, true);
                        } },
                );
            }
            if (!hasOutline) fields.push({ key: 'layer', id: 'pcbPropShapeLayer', type: 'select', label: 'Layer',
                value: currentLayer, mixed: mixedLayer, disabled: readOnly,
                options: [
                    ...(!mixedLayer && PROP_HIDDEN_LAYERS.has(currentLayer) ? [{ value: currentLayer, label: '' }] : []),
                    ...PCB_LAYERS.filter((l) => !PROP_HIDDEN_LAYERS.has(l.id)).map((l) => pcbLayerOption(l.id, l.name)),
                ],
                commit: next => {
                    if (!next || targets.every((target) => next === target.layer)) return;
                    if (isLayerLocked(next)) { refresh(); return; }
                    const replaced = commit((target) => {
                        target.layer = next;
                        target.lineWidth = normalizedBoardShapeLineWidth(target, target.lineWidth);
                    });
                    if (!replaced) showBoardShapeProperties(app, shape);
                } });
            if (showCopperMode) fields.push({ key: 'copperMode', id: 'pcbPropShapeCopperMode', type: 'select', label: 'Copper Mode',
                value: initialCopperMode, mixed: mixedCopperMode, disabled: readOnly || !allCopperTargets,
                options: COPPER_MODE_OPTIONS, commit: value => {
                    const next = normalizeShapeCopperMode(value);
                    if (!value || targets.every((target) => next === normalizeShapeCopperMode(target.copperMode))) return;
                    if (!commit((target) => { target.copperMode = next; })) showBoardShapeProperties(app, shape);
                } });
            if (showNet) fields.push({ key: 'net', id: 'pcbPropShapeNet', type: 'net', label: 'Net', value: initialNet,
                mixed: mixedNet, disabled: readOnly, nets: boardNetNames(app),
                commit: value => {
                    const next = value.trim();
                    if (targets.every((target) => String(target.net || '') === next)) return;
                    commitAndRefresh((target) => { target.net = next; });
                } });
            if (showFill) fields.push({ key: 'fill', id: 'pcbPropShapeFilled', type: 'checkbox', label: 'Fill',
                value: !!targets[0].filled, mixed: mixedFill, disabled: readOnly,
                commit: value => {
                    if (targets.every((target) => value === !!target.filled)) return;
                    commitAndRefresh((target) => { target.filled = value; }, true);
                } });
            if (showPlated) fields.push({ key: 'plated', id: 'pcbPropShapePlated', type: 'checkbox', label: 'Plated',
                value: !!holeTargets[0]?.plated, mixed: mixedPlated, disabled: readOnly,
                commit: plated => {
                    if (targets.filter((target) => target.layer === 'hole').every((target) => plated === !!target.plated)) return;
                    commitAndRefresh((target) => { if (target.layer === 'hole') target.plated = plated; });
                } });
            if (outlineTarget && shape.kind === 'rect') {
                fields.push(
                    outlineDimensionField('width', 'pcbPropOutlineWidth', 'Width (mm)', 'x', 'w'),
                    outlineDimensionField('height', 'pcbPropOutlineHeight', 'Height (mm)', 'y', 'h'),
                );
            }
            if (showLineWidth) fields.push({ key: 'lineWidth', id: 'pcbPropShapeLineWidth', type: 'number',
                label: 'Line Width (mm)', value: initialLineWidth, mixed: mixedLineWidth, min: lineWidthMinimum, step: 0.05,
                hold, format: value => Number(value).toFixed(2), formatStepped: true,
                seedMixed: () => initialLineWidth, disabled: readOnly,
                preview: previewLineWidth, commit: () => finishPreview(lineWidthPreview), cancel: () => cancelPreview(lineWidthPreview) });
            if (allCircleTargets) fields.push({ key: 'outerDiameter', id: 'pcbPropShapeDiameter', type: 'number',
                label: 'Outer Diameter (mm)', value: initialDiameter, mixed: mixedDiameter, min: diameterMinimum(), step: 0.05,
                hold, format: value => Number(value).toFixed(2), formatStepped: true, seedMixed: () => initialDiameter,
                disabled: readOnly, preview: previewDiameter,
                commit: value => {
                    if (Number.isFinite(value)) previewDiameter(Number(Math.max(diameterMinimum(), value).toFixed(2)));
                    finishPreview(diameterPreview);
                },
                cancel: () => cancelPreview(diameterPreview) });
            if (allRoundedTargets) fields.push({ key: 'cornerRadius', id: 'pcbPropShapeCornerRadius', type: 'number',
                label: 'Corner Radius (mm)', value: initialCornerRadius, mixed: mixedCornerRadius, min: 0, max: 25, step: 0.5,
                hold, format: value => Number(value).toFixed(2), disabled: readOnly,
                normalize: value => Math.min(25, Math.max(0, value)), preview: previewCornerRadius,
                commit: () => finishPreview(cornerRadiusPreview), cancel: () => cancelPreview(cornerRadiusPreview) });
            if (showBulge) fields.push({ key: 'bulge', id: 'pcbPropShapeBulge', type: 'number', label: 'Bulge',
                value: editableShapeBulge(displayedBoardShape(app, shape), selectedSegment), min: -1, max: 1, step: 0.05,
                hold, format: formatNumberInputValue, normalize: value => Math.max(-1, Math.min(1, value)),
                disabled: readOnly, preview: previewBulge, commit: commitBulge, cancel: () => cancelPreview(bulgePreview) });
        }
        return { title: panelTitle(), fields };
    };
    if (!app.openPropertyPanel?.(describe(), shape)) return;
    binding = createBoardShapePropertyBinding(app);
    lineWidthPreview = createBoardShapePropertyPreview(app, propertyTargets());
    diameterPreview = createBoardShapePropertyPreview(app, propertyTargets().filter(target => target.kind === 'circle'));
    cornerRadiusPreview = createBoardShapePropertyPreview(app, propertyTargets().filter(target => ['line', 'rect', 'polygon'].includes(target.kind)));
    nodeCornerRadiusPreview = createBoardShapePropertyPreview(app, [shape]);
    bulgePreview = createBoardShapePropertyPreview(app, [shape], {
        liveDrag: true,
        beforeCommit: ([candidate]) => {
            const straight = Math.abs(editableShapeBulge(candidate, selectedSegment)) < BULGE_EPS;
            normalizeStraightArc(candidate, selectedSegment);
            if (straight) collapseCollinearPolylinePoints(candidate);
            return straight;
        },
    });
    refresh();
}

export function syncShapeBulgeProperty(app, shape) {
    if (shape) showBoardShapeProperties(app, shape);
}

export function syncCircleDiameterProperty(app, shape) {
    if (shape?.kind === 'circle') showBoardShapeProperties(app, shape);
}

export function refreshBoardShapeProperties(app, shape) {
    if (!shape || !isPcbSelected(app, 'shape', shape)) return;
    // A multi-selection may be showing the shared panel (mixed kinds or locked members).
    if (getPcbSelectionEntries(app).length > 1) showPcbSelectionProperties(app);
    else showBoardShapeProperties(app, shape);
}
