import { isViaVisible, saveLayerPrefs, refreshPcbLayerOptions } from './layers.js';
import { isPcbPasteActive, isPcbPasteEditable } from './pcb-paste.js';
import { getPropertyEditor, eachPropertyEditorOnLayer } from './property-editors.js';
import { endBoardOutlineResize, isBoardOutlineSelected, selectBoardOutline } from './board-outline-resize.js';
import { getPcbSelection, getPcbSelectionEntries } from './selection-registry.js';
import { finishSelectionInteraction, getSelectionInteraction, showPcbSelectionProperties } from './selection-interaction.js';
import { getGroupDrag, deselectHiddenPcbSelection } from './box-select.js';
import {
    endBoardShapeDrag, getBoardShapeDrag, getBoardShapeRotationPreview, finishBoardShapeRotationPreview, selectBoardShape,
} from './board-shapes.js';
import { refreshBoardShapeToolLayer } from './board-shape-properties.js';
import { cancelVertexDrag, getVertexDrag, trackPointerTouchesLayer } from './track-drag.js';
import { getSelectedTrack, getSelectedVia, clearTrackSelection, setHoverHighlight } from './track-select.js';
import { activeTextInlineEdit, endTextInlineEdit } from './text-inline-edit.js';
import { endTextDrag, getTextDrag } from './pcb-text-selection.js';
import { endRefDrag, getRefDrag } from './ref-text-selection.js';
import { areClearancesVisible } from './clearance-overlay.js';
import { fillGroupId } from './copper-fill-render.js';
import { pcbObjectLayers } from './object-locks.js';
import { peekDrcPresentation } from './drc-state.js';

/*
 * What the PCB editor does when the layer panel hides, shows, locks or unlocks a layer,
 * a copper pour or an overlay: cancel the gestures and edits the change strands, show,
 * hide or dim the render groups, drop hidden objects from the selection and hover, and
 * save the panel state. The layer panel calls these through the editor's `_on…Changed`
 * methods.
 */

const silkLayerOf = placement => (placement.side === 'bottom' ? 'bottom-silk' : 'top-silk');

/**
 * Cancel the pointer gestures a hidden or locked layer strands: the board-outline resize,
 * a shape, vertex or rotation drag on that layer (through the selection interaction that
 * wraps it, if any), and a group drag of objects that are no longer editable.
 * @param {(entry: any) => boolean} affectsGroup Whether a group-drag entry became uneditable.
 */
function cancelStrandedGestures(app, layerId, affectsGroup) {
    if (layerId === 'board-outline') endBoardOutlineResize(app, false);
    if (getGroupDrag(app) && getPcbSelectionEntries(app).some(affectsGroup)) app._cancelPosePreviews();
    if (getBoardShapeDrag(app)?.original.layer === layerId) {
        if (!finishSelectionInteraction(app, false)) endBoardShapeDrag(app, false);
    }
    if (getVertexDrag(app) && trackPointerTouchesLayer(app, layerId)) {
        if (!finishSelectionInteraction(app, false)) cancelVertexDrag(app);
    }
    if (getBoardShapeRotationPreview(app)?.original.layer === layerId) {
        if (!finishSelectionInteraction(app, false)) finishBoardShapeRotationPreview(app);
    }
}

/** Show or hide a layer's render group (and the copper side's companion groups). */
export function onLayerVisibilityChanged(app, layerId, visible) {
    if (isPcbPasteActive(app) && !visible && !isPcbPasteEditable(app)) app._cancelPasteDrop();
    if (!visible) {
        if (layerId === 'board-outline') getPropertyEditor(app, 'boardDimension')?.dispose();
        cancelStrandedGestures(app, layerId, entry => entry.visible === false);
        eachPropertyEditorOnLayer(app, layerId, editor => editor.dispose());
    }
    const groups = app.existingLayerGroups();
    const display = visible ? '' : 'none';
    const g = groups.get(layerId);
    if (g) g.style.display = display;
    // Pad-number labels live on their own layer above each copper layer
    // (so tracks can't hide them); keep their visibility tied to the
    // copper side they belong to. Copper-removal knockouts, track labels and
    // pad drills likewise belong to the copper they sit on.
    if (layerId === 'top-copper' || layerId === 'bottom-copper') {
        const side = layerId === 'bottom-copper' ? 'bottom' : 'top';
        for (const id of [`${side}-pad-numbers`, `${side}-copper-knockout`, `${layerId}-track-labels`, `${layerId}-pad-drills`]) {
            const companion = groups.get(id);
            if (companion) companion.style.display = display;
        }
    }
    // Clearance overlay tracks per-layer visibility.
    if (areClearancesVisible(app) && ['top-copper', 'bottom-copper', 'vias', 'hole'].includes(layerId)) {
        app.showClearances(true);
    }
    // A newly-hidden layer must not keep anything on it selected or
    // hovered — hidden objects are non-interactive (can't be selected,
    // dragged or deleted), mirroring the locked-layer behaviour. Objects
    // that stay visible keep their selection.
    if (!visible) {
        const viaAffected = layerId === 'vias' && !isViaVisible();
        const selectedTrack = getSelectedTrack(app);
        const selectedVia = getSelectedVia(app);
        if ((selectedTrack && selectedTrack.layer === layerId) ||
            (selectedVia && viaAffected)) {
            clearTrackSelection(app);
            app.clearProperties();
        }
        // Single-object teardown (node focus, text refresh); multi-selections
        // are pruned below so objects on other layers stay selected.
        const single = getPcbSelectionEntries(app).length === 1;
        const selectedText = getPcbSelection(app, 'text')[0] || null;
        if (single && selectedText && selectedText.layer === layerId) {
            app.selectText(null);
            app.clearProperties();
        }
        const selectedShape = getPcbSelection(app, 'shape')[0] || null;
        if (single && selectedShape && selectedShape.layer === layerId) {
            selectBoardShape(app, null);
            app.clearProperties();
        }
        if (isBoardOutlineSelected(app) && layerId === 'board-outline') {
            selectBoardOutline(app, false);
        }
        if (deselectHiddenPcbSelection(app)) showPcbSelectionProperties(app);
        setHoverHighlight(app, null);
    }
    app._refreshPcbSelectionHighlights?.();
    saveLayerPrefs();
}

/** Lock or unlock a layer: cancel edits on it and refresh the lock-dependent UI. */
export function onLayerLockChanged(app, layerId, locked) {
    if (isPcbPasteActive(app) && locked && !isPcbPasteEditable(app)) app._cancelPasteDrop();
    if (locked) {
        if (layerId === 'board-outline') getPropertyEditor(app, 'boardDimension')?.cancel();
        cancelStrandedGestures(app, layerId, entry => entry.locked);
        eachPropertyEditorOnLayer(app, layerId, editor => editor.cancel());
        const draggingReference = app.placements?.get(getRefDrag(app)?.compId);
        if (draggingReference && silkLayerOf(draggingReference) === layerId) {
            if (!finishSelectionInteraction(app, false)) endRefDrag(app, false);
        }
        const draggingText = app.texts?.get(getTextDrag(app)?.textId);
        if (draggingText?.layer === layerId) {
            if (!finishSelectionInteraction(app, false)) endTextDrag(app, false);
        }
        const anchorInteraction = getSelectionInteraction(app);
        if (anchorInteraction?.adapter?.kind === 'text'
            && anchorInteraction.adapter.object.layer === layerId) {
            finishSelectionInteraction(app, false);
        }
        const textEdit = activeTextInlineEdit(app);
        const editingReference = app.placements?.get(textEdit?.options?.componentId);
        const editingLayer = editingReference ? silkLayerOf(editingReference) : textEdit?.text?.layer;
        if (editingLayer === layerId) endTextInlineEdit(app, false);
    }
    const groups = app.existingLayerGroups();
    const g = groups.get(layerId);
    if (g) g.style.opacity = '';
    if (layerId === 'top-copper' || layerId === 'bottom-copper') {
        const ko = groups.get(layerId === 'bottom-copper' ? 'bottom-copper-knockout' : 'top-copper-knockout');
        if (ko) ko.style.opacity = '';
    }
    saveLayerPrefs();
    refreshPcbLayerOptions(layerId);
    refreshBoardShapeToolLayer(app);
    const checkbox = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropOutlineLocked'));
    if (checkbox) checkbox.checked = locked;
    app._refreshPcbSelectionHighlights?.();
    if (getPcbSelectionEntries(app).some(entry => pcbObjectLayers(app, entry.kind, entry.object).includes(layerId))) {
        showPcbSelectionProperties(app);
    }
    setHoverHighlight(app, null);
}

/** Whether a group drag carries a pour on this copper side. */
const groupDragsPourOn = (app, copperLayerId) => getGroupDrag(app)?.fills.some(({ fill }) => fill.layer === copperLayerId);

/** Show or hide the copper pour on one side; purely a view state. */
export function onCopperFillVisibilityChanged(app, copperLayerId, visible) {
    if (isPcbPasteActive(app) && !visible && !isPcbPasteEditable(app)) app._cancelPasteDrop();
    if (!visible && groupDragsPourOn(app, copperLayerId)) app._cancelPosePreviews();
    const g = app.existingLayerGroups().get(fillGroupId(copperLayerId));
    if (g) g.style.display = visible ? '' : 'none';
    app._refreshPcbSelectionHighlights?.();
    saveLayerPrefs();
}

/**
 * Lock or unlock the copper pour on one side. A locked pour is dimmed and remains
 * selectable only for its unlock affordance.
 */
export function onCopperFillLockChanged(app, copperLayerId, locked) {
    if (isPcbPasteActive(app) && locked && !isPcbPasteEditable(app)) app._cancelPasteDrop();
    if (locked && groupDragsPourOn(app, copperLayerId)) app._cancelPosePreviews();
    const g = app.existingLayerGroups().get(fillGroupId(copperLayerId));
    if (g) g.style.opacity = locked ? '0.4' : '';
    app._refreshPcbSelectionHighlights?.();
    if (getPcbSelection(app, 'fill').some(fill => fill.layer === copperLayerId)) showPcbSelectionProperties(app);
    saveLayerPrefs();
}

/** Show or hide an overlay (clearance halos, ratlines). */
export function onOverlayVisibilityChanged(app, overlayId, visible) {
    if (overlayId === 'clearance') {
        app.showClearances(visible);
    } else if (overlayId === 'ratlines') {
        // Ratlines have a real SVG layer group; toggle its display.
        const g = app.existingLayerGroups().get('ratlines');
        if (g) g.style.display = visible ? '' : 'none';
        peekDrcPresentation(app)?.overlayVisibilityChanged();
    }
    saveLayerPrefs();
}
