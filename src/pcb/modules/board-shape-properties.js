/**
 * Properties-panel UI for PCB board shapes and the shape drawing tools: builds
 * the panel markup, binds its inputs to live property previews, and commits
 * edits through board-shape commands. Geometry, rendering and interaction stay
 * in board-shapes.js.
 */

import { bulgePointFromRatio } from '../../core/geometry.js';
import { displayRotationDegrees, formatNumberInput, formatNumberInputValue } from '../../core/number-inputs.js';
import { canRoundPathNode } from '../../shapes/path-geometry.js';
import { SHAPE_KINDS, applyShapeGeometry, applyShapeSnapshot, captureBoardShapeState as shapeSnapshot } from '../../core/pcb-board-shapes.js';
import { isLayerLocked, PCB_LAYERS, pcbLayerOptionHtml, setPcbLayerLocked } from './layers.js';
import { bindLockedProperty, lockedPropertyHtml } from './object-locks.js';
import { ModifyBoardShapeCommand } from './shape-commands.js';
import { CompoundCommand } from './track-commands.js';
import { commitPropertyPreviewInput, bindPropertyPreviewInput } from '../../shapes/property-preview.js';
import { getPcbSelection, getPcbSelectionEntries, isPcbSelected, syncPcbSelection } from './selection-registry.js';
import { showPcbSelectionProperties } from './selection-interaction.js';
import { PICTURE_LAYERS } from '../../shared/pcb/picture-raster.js';
import { bindPictureRefreshHold } from './picture-refresh.js';
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

function netOptions(app, current = '') {
    const names = boardNetNames(app);
    const selected = String(current || '');
    return `<button type="button" data-net="">None</button>${names.map((name) =>
        `<button type="button" data-net="${name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"${name === selected ? ' aria-current="true"' : ''}>${name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</button>`
    ).join('')}`;
}

function syncNetMenuSelection(menu, input) {
    if (!menu || !input) return;
    const current = input.value.trim();
    for (const option of menu.querySelectorAll('button[data-net]')) {
        option.toggleAttribute('aria-current', option.dataset.net === current);
    }
}

/**
 * Show Properties-tab controls for the active board-shape tool. These edit
 * creation defaults (and an unfinished draw), rather than a saved shape.
 * @param {object} app
 * @param {'line'|'circle'|'rect'|'polygon'|'arc'} kind
 */
export function showBoardShapeToolProperties(app, kind) {
        const items = app.propertiesItems?.();
        if (!items) return;
        const defaults = getShapeDefaults(app);
        const currentLayer = app._shapeDraw?.layer || resolveShapeDrawLayer(app, app.activeLayer);
        if (!app._shapeDraw && currentLayer) app.activeLayer = currentLayer;
        const layerOptionsHtml = PCB_LAYERS
            .filter((layer) => !PROP_HIDDEN_LAYERS.has(layer.id))
            .map((layer) => pcbLayerOptionHtml(layer.id, layer.name, layer.id === currentLayer))
            .join('');
        const initialCopperMode = normalizeShapeCopperMode(defaults.copperMode);
        const initialNet = String(defaults.net || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const toolNetOptions = netOptions(app, defaults.net);
        const showFill = currentLayer !== 'hole' && kind !== 'line';
        const showLineWidth = currentLayer !== 'hole' || kind === 'line';
        const lineWidthMinimum = boardShapeLineWidthMinimum({ kind, layer: currentLayer });
        const toolLineWidth = normalizedBoardShapeLineWidth(
            { kind, layer: currentLayer },
            defaults.lineWidth,
        );

        app.setPropertiesTitle?.(`New ${shapeKindLabel(kind)}`);
        items.innerHTML = `
            <div class="prop-row" data-prop="layer"><label>Layer</label><select id="pcbToolShapeLayer"${currentLayer ? '' : ' disabled'}>${currentLayer ? '' : '<option value="" selected disabled>No unlocked layers</option>'}${layerOptionsHtml}</select></div>
            <div class="prop-row" data-prop="copperMode" id="pcbToolShapeCopperModeRow"><label>Copper Mode</label><select id="pcbToolShapeCopperMode"><option value="add"${initialCopperMode === 'add' ? ' selected' : ''}>Add Copper</option><option value="remove-copper"${initialCopperMode === 'remove-copper' ? ' selected' : ''}>Remove Copper</option><option value="remove-solder-mask"${initialCopperMode === 'remove-solder-mask' ? ' selected' : ''}>Remove Solder Mask</option><option value="remove-copper-mask"${initialCopperMode === 'remove-copper-mask' ? ' selected' : ''}>Remove Copper + Mask</option></select></div>
            <div class="prop-row" data-prop="net" id="pcbToolShapeNetRow"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbToolShapeNet" value="${initialNet}" placeholder="None"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${toolNetOptions}</div></details></span></div>
            ${showFill ? `<label class="prop-row prop-toggle" data-prop="fill"><input type="checkbox" id="pcbToolShapeFilled"${defaults.filled ? ' checked' : ''}><span>Fill</span></label>` : ''}
            ${currentLayer === 'hole' ? `<label class="prop-row prop-toggle" data-prop="plated"><input type="checkbox" id="pcbToolShapePlated"${defaults.plated ? ' checked' : ''}><span>Plated</span></label>` : ''}
            ${showLineWidth ? `<div class="prop-row" data-prop="lineWidth" id="pcbToolShapeLineWidthRow"><label>Line Width (mm)</label><input type="number" id="pcbToolShapeLineWidth" min="${lineWidthMinimum}" step="0.05" value="${toolLineWidth.toFixed(2)}"></div>` : ''}
            ${kind === 'rect' ? `<div class="prop-row" data-prop="cornerRadius"><label>Corner Radius (mm)</label><input type="number" id="pcbToolShapeCornerRadius" min="0" max="25" step="0.5" value="${Math.max(0, Number(defaults.cornerRadius) || 0).toFixed(2)}"></div>` : ''}
        `;

        const lineEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapeLineWidth'));
        const lineRowEl = /** @type {HTMLDivElement|null} */ (items.querySelector('#pcbToolShapeLineWidthRow'));
    const cornerRadiusEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapeCornerRadius'));
        const filledEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapeFilled'));
        const platedEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapePlated'));
        const layerEl = /** @type {HTMLSelectElement|null} */ (items.querySelector('#pcbToolShapeLayer'));
        const copperModeRowEl = /** @type {HTMLDivElement|null} */ (items.querySelector('#pcbToolShapeCopperModeRow'));
        const copperModeEl = /** @type {HTMLSelectElement|null} */ (items.querySelector('#pcbToolShapeCopperMode'));
        const netRowEl = /** @type {HTMLDivElement|null} */ (items.querySelector('#pcbToolShapeNetRow'));
        const netEl = /** @type {HTMLInputElement|null} */ (items.querySelector('#pcbToolShapeNet'));
        const netMenuEl = /** @type {HTMLDetailsElement|null} */ (items.querySelector('.prop-net-menu'));
        const syncAvailability = () => {
            if (!layerEl || !copperModeEl || !copperModeRowEl) return;
            const copper = layerEl.value === 'top-copper' || layerEl.value === 'bottom-copper';
            copperModeRowEl.style.display = copper ? '' : 'none';
            copperModeEl.disabled = !copper;
            if (netRowEl) netRowEl.style.display = copper && copperModeEl.value === 'add' ? '' : 'none';
            if (lineRowEl) lineRowEl.style.display = filledEl?.checked ? 'none' : '';
        };

        lineEl?.addEventListener('input', () => {
            defaults.lineWidth = normalizedBoardShapeLineWidth(
                { kind, layer: layerEl?.value || currentLayer },
                lineEl.value,
            );
            if (Number(lineEl.value) < defaults.lineWidth) lineEl.value = defaults.lineWidth.toFixed(2);
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
        });
        cornerRadiusEl?.addEventListener('input', () => {
            defaults.cornerRadius = Math.min(25, Math.max(0, Number(cornerRadiusEl.value) || 0));
            cornerRadiusEl.value = defaults.cornerRadius.toFixed(2);
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
        });
        filledEl?.addEventListener('change', () => {
            defaults.filled = !!filledEl.checked;
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
            syncAvailability();
        });
        platedEl?.addEventListener('change', () => {
            defaults.plated = !!platedEl.checked;
        });
        netEl?.addEventListener('change', () => {
            defaults.net = netEl.value.trim();
        });
        netMenuEl?.addEventListener('click', (event) => {
            const option = /** @type {HTMLButtonElement|null} */ (event.target instanceof Element ? event.target.closest('button[data-net]') : null);
            if (!option || !netEl) return;
            netEl.value = option.dataset.net || '';
            netEl.dispatchEvent(new Event('change'));
            netMenuEl.open = false;
        });
        netMenuEl?.addEventListener('toggle', () => {
            if (netMenuEl.open) syncNetMenuSelection(netMenuEl, netEl);
        });
        layerEl?.addEventListener('change', () => {
            const next = layerEl.value;
            if (!next || isLayerLocked(next)) {
                layerEl.value = app._shapeDraw?.layer || app.activeLayer;
                syncAvailability();
                return;
            }
            app.activeLayer = next;
            app.setPcbStatus?.();
            if (app._shapeDraw?.kind === kind) app._shapeDraw.layer = next;
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
            syncAvailability();
            showBoardShapeToolProperties(app, kind);
        });
        copperModeEl?.addEventListener('change', () => {
            defaults.copperMode = normalizeShapeCopperMode(copperModeEl.value);
            updateShapeDrawPreview(app, app._lastCrosshairWorld || app._shapeDraw?.points.at(-1));
        });
        syncAvailability();
        app.setPcbStatus?.();
        app.showPropertiesTab?.();
}

export function refreshBoardShapeToolLayer(app) {
    if (!SHAPE_KINDS.has(app.currentTool) || app.currentTool === 'image') return;
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbToolShapeLayer'));
    if (!select || app._shapeDraw) return;
    const layer = resolveShapeDrawLayer(app, app.activeLayer);
    if ((select.value || null) !== layer) showBoardShapeToolProperties(app, app.currentTool);
}

export function showImageProperties(app, shape, items) {
    if (getPropertyEditor(app, 'boardShape')?.committing) return;
    shape = canonicalBoardShape(app, shape);
    getPropertyEditor(app, 'boardShape')?.dispose();
    app.setPropertiesTitle?.('Image', shape);
    const binding = createBoardShapePropertyBinding(app);
    const geometryValues = () => {
        const { points } = displayedBoardShape(app, shape);
        return {
            width: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
            height: Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y),
            rotation: ((-Math.atan2(points[1].y - points[0].y,
                points[1].x - points[0].x) * 180 / Math.PI) % 360 + 360) % 360,
        };
    };
    const { width, height, rotation } = geometryValues();
    const layers = PCB_LAYERS.filter(layer => PICTURE_LAYERS.includes(layer.id));
    const names = [...new Set([...boardNetNames(app), String(shape.net || '')])].filter(Boolean).sort();
    const imageNetOptions = names.map(name => {
        const escaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return `<option value="${escaped}">${escaped}</option>`;
    }).join('');
    const lockEntries = [{ kind: 'shape', object: shape }];
    items.innerHTML = `
        ${lockedPropertyHtml(app, lockEntries)}
        <div class="prop-row" data-prop="layer"><label>Layer</label><select id="pcbPropImageLayer">${layers.map(layer =>
            pcbLayerOptionHtml(layer.id, layer.name, layer.id === shape.layer)).join('')}</select></div>
        ${shape.layer.endsWith('copper') ? `<div class="prop-row" data-prop="net"><label>Net</label><select id="pcbPropImageNet"><option value="">Unassigned</option>${imageNetOptions}</select></div>` : ''}
        <div class="prop-row" data-prop="width"><label>Width (mm)</label><input id="pcbPropImageWidth" type="number" min="0.1" max="500" step="0.1" value="${width.toFixed(2)}"></div>
        <div class="prop-row" data-prop="height"><label>Height (mm)</label><input id="pcbPropImageHeight" type="number" min="0.1" max="500" step="0.1" value="${height.toFixed(2)}"></div>
        <div class="prop-row" data-prop="rotation"><label>Rotation (°)</label><input id="pcbPropImageRot" type="number" step="1" data-number-format="rotation" value="${displayRotationDegrees(rotation)}"></div>
        <div class="prop-row" data-prop="flipHorizontal"><label for="pcbPropImageFlipHorizontal">Flip Horizontal</label><input id="pcbPropImageFlipHorizontal" type="checkbox"${shape.artwork.flipHorizontal ? ' checked' : ''}></div>
        <div class="prop-row" data-prop="flipVertical"><label for="pcbPropImageFlipVertical">Flip Vertical</label><input id="pcbPropImageFlipVertical" type="checkbox"${shape.artwork.flipVertical ? ' checked' : ''}></div>
        <div class="prop-row" data-prop="invert"><label for="pcbPropImageInvert">Invert</label><input id="pcbPropImageInvert" type="checkbox"${shape.artwork.invert ? ' checked' : ''}></div>`;
    const commit = mutate => {
        if (!binding.prepare()) return;
        const before = shapeSnapshot(shape);
        const candidate = copyBoardShape(shape);
        mutate(candidate);
        const after = shapeSnapshot(candidate);
        if (JSON.stringify(before) !== JSON.stringify(after)) app.history.execute(new ModifyBoardShapeCommand(app, shape, before, after));
        else showImageProperties(app, shape, items);
    };
    const commitNumericPreview = (input, preview) => {
        const keepFocus = document.activeElement === input || items.contains?.(document.activeElement);
        commitPropertyPreviewInput(input, preview, { focusRoot: items });
        if (binding.disposed) return;
        if (!keepFocus) {
            showImageProperties(app, shape, items);
            return;
        }
        // Native number stepping emits change while the field is still focused.
        const geometry = geometryValues();
        for (const [id, value] of [
            ['pcbPropImageWidth', geometry.width.toFixed(2)],
            ['pcbPropImageHeight', geometry.height.toFixed(2)],
            ['pcbPropImageRot', String(Math.round(geometry.rotation) % 360)],
        ]) {
            const field = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
            if (field) field.value = value;
        }
    };
    const layerInput = /** @type {HTMLSelectElement} */ (document.getElementById('pcbPropImageLayer'));
    for (const [id, property] of [
        ['pcbPropImageInvert', 'invert'],
        ['pcbPropImageFlipHorizontal', 'flipHorizontal'],
        ['pcbPropImageFlipVertical', 'flipVertical'],
    ]) {
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        input?.addEventListener('change', () => commit(candidate => {
            candidate.artwork = { ...candidate.artwork, [property]: input.checked };
        }));
    }
    layerInput?.addEventListener('change', () => {
        if (!PICTURE_LAYERS.includes(layerInput.value) || isLayerLocked(layerInput.value)) return;
        commit(candidate => { candidate.layer = layerInput.value; });
    });
    for (const [id, dimension] of [['pcbPropImageWidth', width], ['pcbPropImageHeight', height]]) {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(String(id)));
        bindPictureRefreshHold(app, input);
        const resizePreview = createBoardShapePropertyPreview(app, [shape], { liveDrag: true });
        bindPropertyPreviewInput(input, resizePreview, {
            binding, isCurrent: () => !binding.disposed, focusRoot: items,
            onCancel: () => showImageProperties(app, shape, items),
        });
        const previewResize = () => {
            if (binding.disposed) return;
            const value = input.valueAsNumber;
            const factor = value / Number(dimension);
            if (!Number.isFinite(factor) || value < 0.1 || Math.max(width, height) * factor > 500) return;
            const current = displayedBoardShape(app, shape);
            const edge = id === 'pcbPropImageWidth' ? 1 : 3;
            if (Math.abs(Math.hypot(current.points[edge].x - current.points[0].x,
                current.points[edge].y - current.points[0].y) - value) < 1e-9) return;
            resizePreview.update((before, [candidate]) => {
                applyShapeSnapshot(candidate, before[0]);
                const baseline = Math.hypot(candidate.points[edge].x - candidate.points[0].x,
                    candidate.points[edge].y - candidate.points[0].y);
                const scale = value / baseline;
                const center = { x: (candidate.points[0].x + candidate.points[2].x) / 2, y: (candidate.points[0].y + candidate.points[2].y) / 2 };
                if (scale !== 1) candidate.points = candidate.points.map(point => ({ x: center.x + (point.x - center.x) * scale,
                    y: center.y + (point.y - center.y) * scale }));
            });
            const pairedId = id === 'pcbPropImageWidth' ? 'pcbPropImageHeight' : 'pcbPropImageWidth';
            const pairedInput = /** @type {HTMLInputElement} */ (document.getElementById(pairedId));
            if (pairedInput) pairedInput.value = ((id === 'pcbPropImageWidth' ? height : width) * factor).toFixed(2);
        };
        input?.addEventListener('input', previewResize);
        input?.addEventListener('change', () => {
            if (binding.disposed) return;
            previewResize();
            commitNumericPreview(input, resizePreview);
        });
    }
    const rotationInput = /** @type {HTMLInputElement} */ (document.getElementById('pcbPropImageRot'));
    bindPictureRefreshHold(app, rotationInput);
    const rotationPreview = createBoardShapePropertyPreview(app, [shape], { liveDrag: true });
    bindPropertyPreviewInput(rotationInput, rotationPreview, {
        binding, isCurrent: () => !binding.disposed, focusRoot: items,
        onCancel: () => showImageProperties(app, shape, items),
    });
    const previewRotation = () => {
        if (binding.disposed) return;
        const value = parseFloat(rotationInput.value);
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
    };
    rotationInput?.addEventListener('input', previewRotation);
    rotationInput?.addEventListener('change', () => {
        if (binding.disposed) return;
        previewRotation();
        commitNumericPreview(rotationInput, rotationPreview);
    });
    const wrapRotation = () => {
        if (binding.disposed) return;
        const value = parseFloat(rotationInput.value);
        if (!Number.isFinite(value)) return;
        const wrapped = ((Math.round(value) % 360) + 360) % 360;
        if (wrapped !== value) rotationInput.value = String(wrapped);
    };
    rotationInput?.addEventListener('input', wrapRotation);
    rotationInput?.addEventListener('change', wrapRotation);
    const netInput = /** @type {HTMLSelectElement} */ (document.getElementById('pcbPropImageNet'));
    if (netInput) {
        netInput.value = shape.net || '';
        netInput.addEventListener('change', () => commit(candidate => { candidate.net = netInput.value.trim(); }));
    }
    bindLockedProperty(app, items, lockEntries);
    app.showPropertiesTab?.();
}

export function showBoardShapeProperties(app, shape) {
    if (getPropertyEditor(app, 'boardShape')?.committing) return;
    shape = canonicalBoardShape(app, shape);
    getPropertyEditor(app, 'boardShape')?.dispose();
    if (app._shapeDrag?.original === shape) shape = app._shapeDrag.shape;
    const items = app.propertiesItems?.();
    if (!items || !shape) return;
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
        if (initialTargets.length === 1) showImageProperties(app, shape, items);
        else app._showPcbMultiSelectionProperties?.(
            initialTargets.map((object) => ({ kind: 'shape', object })),
        );
        return;
    }
    const selectedSegment = initialTargets.length === 1
        && getBoardShapeSegmentFocus(app)?.shapeId === shape.id
        ? getBoardShapeSegmentFocus(app).segment
        : null;
    const selectedNode = initialTargets.length === 1
        && getBoardShapeNodeFocus(app)?.shapeId === shape.id
        && shape.points?.[getBoardShapeNodeFocus(app).index]
        ? getBoardShapeNodeFocus(app).index
        : null;
    const mixedKind = initialTargets.some((target) => target.kind !== initialTargets[0].kind);
    const segmentLabel = shape.kind === 'arc' || boardShapeSegmentBulge(shape, selectedSegment) ? 'Arc' : 'Line';
    const standalone = shape.kind === 'arc' || (shape.kind === 'line' && shape.points.length === 2);
    app.setPropertiesTitle?.(outlineTarget
        ? selectedNode != null ? 'Board Outline Node'
            : selectedSegment != null ? 'Board Outline Segment'
                : 'Board Outline'
        : selectedNode != null ? `${shapeKindLabel(shape.kind)} Node`
            : selectedSegment != null ? `${segmentLabel}${standalone ? '' : ' Segment'}`
                : mixedKind ? 'Mixed' : shapeKindLabel(initialTargets[0].kind));
    const binding = createBoardShapePropertyBinding(app);
    const lineWidthMinimum = Math.max(...initialTargets.map((target) => boardShapeLineWidthMinimum(target)));
    const initialLineWidth = selectedSegment == null
        ? normalizedBoardShapeLineWidth(initialTargets[0], initialTargets[0].lineWidth)
        : boardShapeSegmentWidth(shape, selectedSegment);
    const mixedLineWidth = selectedSegment == null && initialTargets.some(
        (target) => Math.abs(normalizedBoardShapeLineWidth(target, target.lineWidth) - initialLineWidth) >= 1e-9,
    );
    const mixedFill = initialTargets.some((target) => !!target.filled !== !!initialTargets[0].filled);
    const allCircleTargets = initialTargets.every((target) => target.kind === 'circle');
    const initialDiameter = allCircleTargets ? circleFilledRadius(initialTargets[0]) * 2 : 0;
    const mixedDiameter = allCircleTargets && initialTargets.some(
        (target) => Math.abs(circleFilledRadius(target) * 2 - initialDiameter) >= 1e-9,
    );
    const diameterMinimum = () => Number(Math.max(...propertyTargets().map(
        (target) => boardShapeLineWidthMinimum(target) + 0.1,
    )).toFixed(6));
    const allRoundedTargets = initialTargets.every((target) => ['line', 'rect', 'polygon'].includes(target.kind));
    const targetCornerRadius = (target) => target.kind === 'rect'
        ? rectCornerRadius(target)
        : polygonCornerRadius(target);
    const initialCornerRadius = targetCornerRadius(shape);
    const mixedCornerRadius = initialTargets.some(
        (target) => Math.abs(targetCornerRadius(target) - initialCornerRadius) >= 1e-9,
    );

    const currentLayer = String(shape.layer || 'top-silk');
    const mixedLayer = initialTargets.some((target) => String(target.layer || 'top-silk') !== currentLayer);
    const holeTargets = initialTargets.filter((target) => target.layer === 'hole');
    const showFill = !hasOutline && initialTargets.every((target) => target.layer !== 'hole' && target.kind !== 'line');
    const showLineWidth = !hasOutline && initialTargets.every(
        (target) => target.layer !== 'hole' || target.kind === 'line',
    );
    const showPlated = initialTargets.every((target) => target.layer === 'hole');
    const mixedPlated = holeTargets.some((target) => !!target.plated !== !!holeTargets[0]?.plated);
    const legacyCurrentOpt = !mixedLayer && PROP_HIDDEN_LAYERS.has(currentLayer)
        ? `<option value="${currentLayer}" selected hidden></option>`
        : '';
    const layerOpts = PCB_LAYERS
        .filter((l) => !PROP_HIDDEN_LAYERS.has(l.id))
        .map((l) => pcbLayerOptionHtml(l.id, l.name, !mixedLayer && l.id === currentLayer));
    const layerOptionsHtml = [legacyCurrentOpt, ...layerOpts].join('');
    const isCopperLayer = (id) => id === 'top-copper' || id === 'bottom-copper';
    const showCopperMode = initialTargets.every((target) => isCopperLayer(target.layer));
    const initialCopperMode = normalizeShapeCopperMode(shape.copperMode);
    const mixedCopperMode = initialTargets.some(
        (target) => normalizeShapeCopperMode(target.copperMode) !== initialCopperMode,
    );
    const initialNet = String(shape.net || '');
    const mixedNet = initialTargets.some((target) => String(target.net || '') !== initialNet);
    const shapeNetOptions = netOptions(app, mixedNet ? '' : initialNet);
    const showNet = showCopperMode && initialTargets.every(
        (target) => normalizeShapeCopperMode(target.copperMode) === 'add',
    );
    const showBulge = initialTargets.length === 1 && selectedNode == null
        && (shape.kind === 'arc' || (selectedSegment != null && boardShapeSegmentBulge(shape, selectedSegment) !== 0));
    const bulgeHtml = showBulge
        ? `<div class="prop-row" data-prop="bulge"><label for="pcbPropShapeBulge">Bulge</label><input type="number" id="pcbPropShapeBulge" min="-1" max="1" step="0.05" value="${formatNumberInputValue(editableShapeBulge(shape, selectedSegment))}"></div>`
        : '';

    const lockEntries = selectedNode == null && selectedSegment == null && !hasOutline
        ? propertyOriginals.map(object => ({ kind: 'shape', object })) : [];
    items.innerHTML = selectedNode != null
        ? `<div class="prop-row" data-prop="x"><label>X (mm)</label><span id="pcbPropShapeNodeX">${formatNumberInputValue(shape.points[selectedNode].x)}</span></div>
                <div class="prop-row" data-prop="y"><label>Y (mm)</label><span id="pcbPropShapeNodeY">${formatNumberInputValue(shape.points[selectedNode].y)}</span></div>
                ${canRoundPathNode(shape, selectedNode) ? `<div class="prop-row" data-prop="cornerRadius"><label>Corner Radius (mm)</label><input type="number" id="pcbPropShapeNodeCornerRadius" min="0" max="25" step="0.5" value="${formatNumberInputValue(boardShapeNodeCornerRadius(shape, selectedNode))}"></div>` : ''}`
        : selectedSegment != null
        ? `${hasOutline ? '' : `<div class="prop-row" data-prop="lineWidth" id="pcbPropShapeLineWidthRow"><label>Line Width (mm)</label><input type="number" id="pcbPropShapeLineWidth" min="${lineWidthMinimum}" step="0.05" value="${initialLineWidth.toFixed(2)}"></div>`}${bulgeHtml}`
        : `
            ${lockEntries.length ? lockedPropertyHtml(app, lockEntries) : ''}
            ${outlineTarget ? `<label class="prop-row prop-toggle" data-prop="locked"><input type="checkbox" id="pcbPropOutlineLocked"${isLayerLocked('board-outline') ? ' checked' : ''}><span>Locked</span></label>` : ''}
            ${outlineTarget ? `<div class="prop-row" data-prop="outline"><label>Outline</label><select id="pcbPropOutlineKind">${['rect', 'polygon', 'circle'].map(kind => `<option value="${kind}"${kind === shape.kind ? ' selected' : ''}>${shapeKindLabel(kind)}</option>`).join('')}</select></div>` : ''}
            ${hasOutline ? '' : `<div class="prop-row" data-prop="layer"><label>Layer</label><select id="pcbPropShapeLayer">${mixedLayer ? '<option value="" selected disabled>Mixed</option>' : ''}${layerOptionsHtml}</select></div>`}
            ${showCopperMode ? `<div class="prop-row" data-prop="copperMode" id="pcbPropShapeCopperModeRow"><label>Copper Mode</label><select id="pcbPropShapeCopperMode">${mixedCopperMode ? '<option value="" selected disabled>Mixed</option>' : ''}<option value="add"${!mixedCopperMode && initialCopperMode === 'add' ? ' selected' : ''}>Add Copper</option><option value="remove-copper"${!mixedCopperMode && initialCopperMode === 'remove-copper' ? ' selected' : ''}>Remove Copper</option><option value="remove-solder-mask"${!mixedCopperMode && initialCopperMode === 'remove-solder-mask' ? ' selected' : ''}>Remove Solder Mask</option><option value="remove-copper-mask"${!mixedCopperMode && initialCopperMode === 'remove-copper-mask' ? ' selected' : ''}>Remove Copper + Mask</option></select></div>` : ''}
            ${showNet ? `<div class="prop-row" data-prop="net"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropShapeNet" value="${mixedNet ? '' : initialNet.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="${mixedNet ? 'Mixed' : 'None'}"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${shapeNetOptions}</div></details></span></div>` : ''}
            ${showFill ? `<label class="prop-row prop-toggle" data-prop="fill"><input type="checkbox" id="pcbPropShapeFilled"${shape.filled ? ' checked' : ''}><span>Fill</span></label>` : ''}
            ${showPlated ? `<label class="prop-row prop-toggle" data-prop="plated"><input type="checkbox" id="pcbPropShapePlated"${!mixedPlated && holeTargets[0]?.plated ? ' checked' : ''}><span>Plated</span></label>` : ''}
            ${outlineTarget && shape.kind === 'rect' ? `<div class="prop-row" data-prop="width"><label>Width (mm)</label><input id="pcbPropOutlineWidth" type="number" min="0.1" step="1" value="${formatNumberInputValue(outlineBounds.w)}"></div><div class="prop-row" data-prop="height"><label>Height (mm)</label><input id="pcbPropOutlineHeight" type="number" min="0.1" step="1" value="${formatNumberInputValue(outlineBounds.h)}"></div>` : ''}
            ${showLineWidth ? `<div class="prop-row" data-prop="lineWidth" id="pcbPropShapeLineWidthRow"><label>Line Width (mm)</label><input type="number" id="pcbPropShapeLineWidth" min="${lineWidthMinimum}" step="0.05" value="${mixedLineWidth ? '' : initialLineWidth.toFixed(2)}"${mixedLineWidth ? ' placeholder="Mixed"' : ''}></div>` : ''}
            ${allCircleTargets ? `<div class="prop-row" data-prop="outerDiameter"><label for="pcbPropShapeDiameter">Outer Diameter (mm)</label><input type="number" id="pcbPropShapeDiameter" min="${diameterMinimum()}" step="0.05" value="${mixedDiameter ? '' : initialDiameter.toFixed(2)}"${mixedDiameter ? ' placeholder="Mixed"' : ''}></div>` : ''}
            ${allRoundedTargets ? `<div class="prop-row" data-prop="cornerRadius"><label>Corner Radius (mm)</label><input type="number" id="pcbPropShapeCornerRadius" min="0" max="25" step="0.5" value="${mixedCornerRadius ? '' : initialCornerRadius.toFixed(2)}"${mixedCornerRadius ? ' placeholder="Mixed"' : ''}></div>` : ''}
            ${bulgeHtml}
        `;

    const outlineLocked = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropOutlineLocked'));
    outlineLocked?.addEventListener('change', () => {
        setPcbLayerLocked(app, 'board-outline', outlineLocked.checked);
    });
    for (const [id, axis, dimension] of [
        ['pcbPropOutlineWidth', 'x', 'w'],
        ['pcbPropOutlineHeight', 'y', 'h'],
    ]) {
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById(String(id)));
        input?.addEventListener('change', () => {
            if (isLayerLocked(shape.layer) || !Number.isFinite(input.valueAsNumber) || input.valueAsNumber < 0.1) return;
            const bounds = boardBoundary(app);
            const factor = input.valueAsNumber / bounds[dimension];
            commit(candidate => {
                candidate.points = candidate.points.map(point => ({ ...point, [axis]: bounds[axis] + (point[axis] - bounds[axis]) * factor }));
            });
        });
    }
    const outlineKind = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropOutlineKind'));
    outlineKind?.addEventListener('change', () => {
        if (isLayerLocked(shape.layer) || shape.kind === outlineKind.value || !['rect', 'polygon', 'circle'].includes(outlineKind.value)) return;
        const bounds = boardBoundary(app);
        const keepCorners = shape.kind === 'rect' && outlineKind.value === 'polygon';
        const points = keepCorners ? shape.points.map(point => ({ ...point })) : shapeOutline(shape);
        commit(candidate => {
            candidate.kind = outlineKind.value;
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
        });
    });
    const bulgeEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeBulge'));
    const bulgePreview = createBoardShapePropertyPreview(app, [shape], {
        liveDrag: true,
        beforeCommit: ([candidate]) => {
            formatNumberInput(bulgeEl);
            const straight = Math.abs(editableShapeBulge(candidate, selectedSegment)) < BULGE_EPS;
            normalizeStraightArc(candidate, selectedSegment);
            if (straight) collapseCollinearPolylinePoints(candidate);
            return straight;
        },
    });
    const previewBulge = () => {
        if (binding.disposed) return;
        if (!bulgeEl || !Number.isFinite(bulgeEl.valueAsNumber)) return;
        const value = Number(formatNumberInputValue(Math.max(-1, Math.min(1, bulgeEl.valueAsNumber))));
        if (value === editableShapeBulge(displayedBoardShape(app, shape), selectedSegment)) return;
        const text = bulgeEl.value;
        bulgePreview.update((_before, [candidate]) => {
            if (candidate.kind === 'arc') candidate.bulge = bulgePointFromRatio(candidate.start, candidate.end, value);
            else if (selectedSegment != null) {
                candidate.segmentBulges ||= {};
                candidate.segmentBulges[selectedSegment] = value;
            }
        });
        if (!binding.disposed) bulgeEl.value = text;
    };
    const commitBulge = () => {
        if (binding.disposed) return;
        if (!bulgeEl) return;
        if (!Number.isFinite(bulgeEl.valueAsNumber)) { commitNumericPreview(bulgeEl, bulgePreview); return; }
        previewBulge();
        // An externally supplied zero-bulge arc still needs a normalization transaction.
        if (!bulgePreview.active && Math.abs(editableShapeBulge(displayedBoardShape(app, shape), selectedSegment)) < BULGE_EPS) {
            bulgePreview.update(() => {});
        }
        commitNumericPreview(bulgeEl, bulgePreview);
    };
    bulgeEl?.addEventListener('input', previewBulge);
    bulgeEl?.addEventListener('change', commitBulge);

    /** Apply an edit; returns true when it turned the shapes into Tracks (the shape panel is then stale). */
    const commit = (mutate) => {
        if (!binding.prepare()) return false;
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
    const lineWidthPreview = createBoardShapePropertyPreview(app, propertyTargets());
    const diameterPreview = createBoardShapePropertyPreview(app, propertyTargets().filter(target => target.kind === 'circle'));
    const cornerRadiusPreview = createBoardShapePropertyPreview(app, propertyTargets().filter(target => ['line', 'rect', 'polygon'].includes(target.kind)));
    const nodeCornerRadiusPreview = createBoardShapePropertyPreview(app, [shape]);
    const previewCornerRadius = () => {
        if (binding.disposed) return;
        if (!cornerRadiusEl || !Number.isFinite(cornerRadiusEl.valueAsNumber)) return;
        const radius = Math.min(25, Math.max(0, cornerRadiusEl.valueAsNumber));
        cornerRadiusEl.value = radius.toFixed(2);
        const targets = propertyTargets().filter((target) => ['line', 'rect', 'polygon'].includes(target.kind));
        if (targets.every((target) => Math.abs(targetCornerRadius(target) - radius) < 1e-9
            && !Object.keys(target.nodeCornerRadii || {}).length)) return;
        cornerRadiusPreview.update((_before, copies) => {
            for (const target of copies) {
                target.cornerRadius = radius;
                target.nodeCornerRadii = {};
            }
        });
    };

    const previewNodeCornerRadius = () => {
        if (binding.disposed) return;
        if (!nodeCornerRadiusEl || selectedNode == null || !Number.isFinite(nodeCornerRadiusEl.valueAsNumber)) return;
        const radius = Math.min(25, Math.max(0, nodeCornerRadiusEl.valueAsNumber));
        nodeCornerRadiusEl.value = radius.toFixed(2);
        if (Math.abs(boardShapeNodeCornerRadius(displayedBoardShape(app, shape), selectedNode) - radius) < 1e-9) return;
        nodeCornerRadiusPreview.update((_before, [candidate]) => setBoardShapeNodeCornerRadius(candidate, selectedNode, radius));
    };

    const diameterEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeDiameter'));
    const syncDiameter = () => {
        if (binding.disposed) return;
        if (!diameterEl) return;
        const targets = propertyTargets();
        const diameter = circleFilledRadius(targets[0]) * 2;
        const mixed = targets.some((target) => Math.abs(circleFilledRadius(target) * 2 - diameter) >= 1e-9);
        diameterEl.min = String(diameterMinimum());
        diameterEl.value = mixed ? '' : diameter.toFixed(2);
        diameterEl.placeholder = mixed ? 'Mixed' : '';
    };
    const previewDiameter = () => {
        if (binding.disposed) return;
        if (!diameterEl || !Number.isFinite(diameterEl.valueAsNumber)) return;
        const diameter = Number(diameterEl.valueAsNumber.toFixed(6));
        if (diameter < diameterMinimum()) return;
        const targets = propertyTargets().filter((target) => target.kind === 'circle');
        if (targets.every((target) => Math.abs(circleFilledRadius(target) * 2 - diameter) < 1e-9)) return;
        const text = diameterEl.value;
        diameterPreview.update((before, copies) => {
            copies.forEach((target, index) => {
                target.lineWidth = Math.min(normalizedBoardShapeLineWidth(target, before[index].lineWidth), diameter / 2);
                target.radius = Math.max(0.05, diameter / 2);
            });
            if (!binding.disposed) diameterEl.value = text;
        });
        if (lineEl) {
            const displayed = propertyTargets();
            const width = displayed[0].lineWidth;
            const mixed = displayed.some((target) => Math.abs(target.lineWidth - width) >= 1e-9);
            lineEl.value = mixed ? '' : width.toFixed(2);
            lineEl.placeholder = mixed ? 'Mixed' : '';
        }
    };
    const seedMixedDiameter = () => {
        if (!diameterEl || Number.isFinite(diameterEl.valueAsNumber)) return;
        diameterEl.value = (circleFilledRadius(propertyTargets()[0]) * 2).toFixed(2);
    };
    let steppingDiameter = false;
    diameterEl?.addEventListener('pointerdown', () => { steppingDiameter = true; });
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave', 'keyup', 'blur']) {
        diameterEl?.addEventListener(eventName, () => { steppingDiameter = false; });
    }
    diameterEl?.addEventListener('keydown', (event) => {
        steppingDiameter = event.key === 'ArrowUp' || event.key === 'ArrowDown';
        if (steppingDiameter) seedMixedDiameter();
    });
    diameterEl?.addEventListener('input', () => {
        if (steppingDiameter && Number.isFinite(diameterEl.valueAsNumber)) {
            diameterEl.value = diameterEl.valueAsNumber.toFixed(2);
        }
        previewDiameter();
    });
    diameterEl?.addEventListener('change', () => {
        if (binding.disposed) return;
        if (!Number.isFinite(diameterEl.valueAsNumber)) { commitNumericPreview(diameterEl, diameterPreview); return; }
        if (Number.isFinite(diameterEl.valueAsNumber)) {
            diameterEl.value = Math.max(diameterMinimum(), diameterEl.valueAsNumber).toFixed(2);
        }
        previewDiameter();
        syncDiameter();
        commitNumericPreview(diameterEl, diameterPreview);
    });
    const lineEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeLineWidth'));
    const lineRowEl = /** @type {HTMLDivElement|null} */ (document.getElementById('pcbPropShapeLineWidthRow'));
    const cornerRadiusEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeCornerRadius'));
    const nodeCornerRadiusEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeNodeCornerRadius'));
    const commitNumericPreview = (input, preview, forceRebuild = false) => {
        commitPropertyPreviewInput(input, preview, {
            forceRebuild, isCurrent: () => !binding.disposed, focusRoot: items,
        });
        if (binding.disposed) return;
        const targets = propertyTargets();
        const syncMixed = (field, values) => {
            const mixed = values.some(value => Math.abs(value - values[0]) >= 1e-9);
            field.value = mixed ? '' : values[0].toFixed(2);
            field.placeholder = mixed ? 'Mixed' : '';
        };
        if (lineEl) syncMixed(lineEl, selectedSegment == null
            ? targets.map(target => normalizedBoardShapeLineWidth(target, target.lineWidth))
            : [boardShapeSegmentWidth(displayedBoardShape(app, shape), selectedSegment)]);
        syncDiameter();
        if (cornerRadiusEl) syncMixed(cornerRadiusEl, targets.map(targetCornerRadius));
        if (nodeCornerRadiusEl && selectedNode != null) {
            nodeCornerRadiusEl.value = formatNumberInputValue(boardShapeNodeCornerRadius(displayedBoardShape(app, shape), selectedNode));
        }
        if (bulgeEl) {
            bulgeEl.value = formatNumberInputValue(editableShapeBulge(displayedBoardShape(app, shape), selectedSegment));
        }
    };
    const filledEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeFilled'));
    const platedEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapePlated'));
    const layerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropShapeLayer'));
    const copperModeRowEl = /** @type {HTMLDivElement|null} */ (document.getElementById('pcbPropShapeCopperModeRow'));
    const copperModeEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropShapeCopperMode'));
    const netEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeNet'));
    const netMenuEl = /** @type {HTMLDetailsElement|null} */ (document.querySelector('.prop-net-menu'));
    for (const input of [diameterEl, lineEl, cornerRadiusEl, nodeCornerRadiusEl, bulgeEl]) bindPictureRefreshHold(app, input);
    for (const [input, preview] of /** @type {Array<[HTMLInputElement|null, any]>} */ ([[diameterEl, diameterPreview], [lineEl, lineWidthPreview],
        [cornerRadiusEl, cornerRadiusPreview], [nodeCornerRadiusEl, nodeCornerRadiusPreview], [bulgeEl, bulgePreview]])) {
        bindPropertyPreviewInput(input, preview, {
            binding, isCurrent: () => !binding.disposed, focusRoot: items,
            onCancel: () => showBoardShapeProperties(app, shape),
        });
    }
    if (filledEl) {
        filledEl.checked = mixedFill ? false : !!shape.filled;
        filledEl.indeterminate = mixedFill;
    }
    if (platedEl) {
        platedEl.checked = mixedPlated ? false : !!holeTargets[0]?.plated;
        platedEl.indeterminate = mixedPlated;
    }
    let fillIsMixed = mixedFill;

    const syncCopperModeAvailability = () => {
        if (!copperModeEl || !layerEl || !copperModeRowEl) return;
        const targets = propertyTargets();
        const mixed = targets.some(
            (target) => normalizeShapeCopperMode(target.copperMode) !== normalizeShapeCopperMode(shape.copperMode),
        );
        const hasCopperTarget = targets.some((target) => isCopperLayer(target.layer));
        const allCopperTargets = targets.every((target) => isCopperLayer(target.layer));
        copperModeRowEl.style.display = hasCopperTarget ? '' : 'none';
        copperModeEl.disabled = !allCopperTargets;
        copperModeEl.value = mixed ? '' : normalizeShapeCopperMode(shape.copperMode);
        // A hole-layer shape is a board cutout — "Filled" doesn't apply.
        if (filledEl) filledEl.disabled = layerEl.value === 'hole';
        if (lineRowEl) lineRowEl.style.display = targets.every((target) => !!target.filled) ? 'none' : '';
    };

    const previewLineWidth = () => {
        if (binding.disposed) return;
        if (!lineEl || !Number.isFinite(lineEl.valueAsNumber)) return;
        const targets = propertyTargets();
        const minimum = Math.max(...targets.map((target) => boardShapeLineWidthMinimum(target)));
        const maximum = selectedSegment == null
            ? Math.min(...targets.map((target) => target.kind === 'circle' ? circleFilledRadius(target) : Infinity))
            : Infinity;
        const v = Math.max(minimum, Math.min(maximum, lineEl.valueAsNumber));
        if (lineEl.valueAsNumber !== v) lineEl.value = v.toFixed(2);
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
        syncDiameter();
    };
    const seedMixedLineWidth = () => {
        if (!lineEl || Number.isFinite(lineEl.valueAsNumber)) return;
        lineEl.value = initialLineWidth.toFixed(2);
    };
    // Native number steppers may retain an empty mixed value, leaving
    // valueAsNumber as NaN and bypassing the batch preview entirely.
    let steppingLineWidth = false;
    lineEl?.addEventListener('pointerdown', () => {
        steppingLineWidth = true;
        seedMixedLineWidth();
    });
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave', 'keyup', 'blur']) {
        lineEl?.addEventListener(eventName, () => { steppingLineWidth = false; });
    }
    lineEl?.addEventListener('keydown', (event) => {
        steppingLineWidth = event.key === 'ArrowUp' || event.key === 'ArrowDown';
        if (steppingLineWidth) seedMixedLineWidth();
    });
    lineEl?.addEventListener('input', () => {
        if (steppingLineWidth && Number.isFinite(lineEl.valueAsNumber)) {
            lineEl.value = lineEl.valueAsNumber.toFixed(2);
        }
        previewLineWidth();
    });
    lineEl?.addEventListener('change', () => {
        if (binding.disposed) return;
        if (!Number.isFinite(lineEl.valueAsNumber)) { commitNumericPreview(lineEl, lineWidthPreview); return; }
        if (Number.isFinite(lineEl.valueAsNumber)) lineEl.value = lineEl.valueAsNumber.toFixed(2);
        previewLineWidth();
        commitNumericPreview(lineEl, lineWidthPreview);
    });
    cornerRadiusEl?.addEventListener('input', previewCornerRadius);
    cornerRadiusEl?.addEventListener('change', () => {
        if (binding.disposed) return;
        if (!Number.isFinite(cornerRadiusEl.valueAsNumber)) { commitNumericPreview(cornerRadiusEl, cornerRadiusPreview); return; }
        previewCornerRadius();
        commitNumericPreview(cornerRadiusEl, cornerRadiusPreview);
    });
    nodeCornerRadiusEl?.addEventListener('input', previewNodeCornerRadius);
    nodeCornerRadiusEl?.addEventListener('change', () => {
        if (binding.disposed) return;
        if (!Number.isFinite(nodeCornerRadiusEl.valueAsNumber)) { commitNumericPreview(nodeCornerRadiusEl, nodeCornerRadiusPreview); return; }
        previewNodeCornerRadius();
        commitNumericPreview(nodeCornerRadiusEl, nodeCornerRadiusPreview);
    });
    filledEl?.addEventListener('change', () => {
        if (binding.disposed) return;
        const v = !!filledEl.checked;
        fillIsMixed = false;
        filledEl.indeterminate = false;
        filledEl.checked = v;
        if (propertyTargets().every((target) => v === !!target.filled)) return;
        commit((target) => { target.filled = v; });
    });
    platedEl?.addEventListener('change', () => {
        if (binding.disposed) return;
        const plated = !!platedEl.checked;
        platedEl.indeterminate = false;
        if (propertyTargets().filter((target) => target.layer === 'hole').every(
            (target) => plated === !!target.plated,
        )) return;
        commit((target) => {
            if (target.layer === 'hole') target.plated = plated;
        });
    });
    layerEl?.addEventListener('change', () => {
        if (binding.disposed) return;
        const next = layerEl.value;
        if (!next || propertyTargets().every((target) => next === target.layer)) return;
        if (isLayerLocked(next)) {
            layerEl.value = shape.layer;
            syncCopperModeAvailability();
            return;
        }
        const replaced = commit((target) => {
            target.layer = next;
            target.lineWidth = normalizedBoardShapeLineWidth(target, target.lineWidth);
        });
        // A move onto copper can turn the shape into a Track that is now selected instead.
        if (replaced) return;
        syncCopperModeAvailability();
        showBoardShapeProperties(app, shape);
    });
    copperModeEl?.addEventListener('change', () => {
        if (binding.disposed || copperModeEl.disabled) return;
        const next = normalizeShapeCopperMode(copperModeEl.value);
        if (!copperModeEl.value || propertyTargets().every(
            (target) => next === normalizeShapeCopperMode(target.copperMode),
        )) return;
        if (commit((target) => { target.copperMode = next; })) return;
        syncCopperModeAvailability();
    });
    netEl?.addEventListener('change', () => {
        if (binding.disposed) return;
        const next = netEl.value.trim();
        if (!binding.prepare()) return;
        const targets = propertyTargets();
        if (targets.every((target) => String(target.net || '') === next)) return;
        commit((target) => { target.net = next; });
    });
    netMenuEl?.addEventListener('click', (event) => {
        if (binding.disposed) return;
        const option = /** @type {HTMLButtonElement|null} */ (event.target instanceof Element ? event.target.closest('button[data-net]') : null);
        if (!option || !netEl) return;
        netEl.value = option.dataset.net || '';
        netEl.dispatchEvent(new Event('change'));
        netMenuEl.open = false;
    });
    netMenuEl?.addEventListener('toggle', () => {
        if (!binding.disposed && netMenuEl.open) syncNetMenuSelection(netMenuEl, netEl);
    });

    syncCopperModeAvailability();
    if (lockEntries.length) bindLockedProperty(app, items, lockEntries);
    app.showPropertiesTab?.();
}

export function syncShapeBulgeProperty(app, shape) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeBulge'));
    if (!input) return;
    const segment = getBoardShapeSegmentFocus(app)?.shapeId === shape.id
        ? getBoardShapeSegmentFocus(app).segment : null;
    input.value = String(editableShapeBulge(shape, segment));
    formatNumberInput(input);
}

export function syncCircleDiameterProperty(app, shape) {
    if (shape.kind !== 'circle') return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropShapeDiameter'));
    if (!input) return;
    const selected = getPcbSelection(app, 'shape');
    const targets = selected.length ? selected : [shape];
    if (!targets.every((target) => target.kind === 'circle')) return;
    const diameter = circleFilledRadius(targets[0]) * 2;
    const mixed = targets.some((target) => Math.abs(circleFilledRadius(target) * 2 - diameter) >= 1e-9);
    input.value = mixed ? '' : diameter.toFixed(2);
    input.placeholder = mixed ? 'Mixed' : '';
}

export function refreshBoardShapeProperties(app, shape) {
    if (!shape || !isPcbSelected(app, 'shape', shape)) return;
    // A multi-selection may be showing the shared panel (mixed kinds or locked members).
    if (getPcbSelectionEntries(app).length > 1) showPcbSelectionProperties(app);
    else showBoardShapeProperties(app, shape);
}
