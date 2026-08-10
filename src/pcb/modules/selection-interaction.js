/**
 * Pointer state machine for the first fully migrated PCB selection slice.
 * Tracks, vias, holes, fills, text, and components continue through their
 * existing interaction handlers until they receive complete adapters.
 */

import {
    getPcbSelection,
    getPcbSelectionEntries,
    hitTestPcbSelectionEntry,
    setPcbSelection,
    togglePcbSelection,
} from './selection-registry.js';
import {
    selectBoardShape,
    showBoardShapeProperties,
} from './board-shapes.js';
import { clearTrackSelection, showViaProperties } from './track-select.js';
import {
    beginGroupDrag,
    cancelGroupDrag,
    endGroupDrag,
    refreshBoxSelectionHighlights,
    updateGroupDrag,
} from './box-select.js';
import { hitTestPcbSelectionAnchor } from './selection-anchors.js';

const SUPPORTED_KINDS = new Set(['shape', 'via']);

function clearUnsupportedSelectionUi(app) {
    clearTrackSelection(app);
    app._selectComponent?.(null);
    app._selectBoardOutline?.(false);
    app._selectText?.(null);
    app._selectRefText?.(null);
    app._selectFill?.(null);
    selectBoardShape(app, null);
}

function showProperties(app, entry) {
    if (entry.kind === 'shape') showBoardShapeProperties(app, entry.object);
    else if (entry.kind === 'via') showViaProperties(app, entry.object);
}

/** Start a state-machine-owned select gesture. Returns true when consumed. */
export function beginSelectionInteraction(app, worldPos, additive) {
    app._lastPointerWorld = worldPos;
    const selectedAnchor = hitTestPcbSelectionAnchor(app, worldPos, SUPPORTED_KINDS);
    if (selectedAnchor?.adapter.beginAnchorDrag?.(selectedAnchor.anchorId, worldPos)) {
        app._pcbSelectionInteraction = { mode: 'anchor', ...selectedAnchor };
        showProperties(app, selectedAnchor.adapter);
        return true;
    }

    const entry = hitTestPcbSelectionEntry(app, worldPos, SUPPORTED_KINDS);
    if (!entry) return false;

    if (additive) {
        togglePcbSelection(app, entry.kind, entry.object);
        refreshBoxSelectionHighlights(app);
        const selected = getPcbSelectionEntries(app);
        const lead = selected.find((item) => item.kind === entry.kind)
            || selected.find((item) => SUPPORTED_KINDS.has(item.kind));
        if (lead) showProperties(app, lead);
        else app._clearProperties?.();
        return true;
    }

    clearUnsupportedSelectionUi(app);
    const selected = getPcbSelectionEntries(app);
    const onlySupported = selected.length > 0 && selected.every((item) => SUPPORTED_KINDS.has(item.kind));
    const alreadySelected = selected.some((item) => item.id === entry.id);
    if (!alreadySelected || !onlySupported) {
        setPcbSelection(app, [{ kind: entry.kind, object: entry.object }]);
    }
    if (entry.beginMove?.(worldPos)) {
        app._pcbSelectionInteraction = { mode: 'move-adapter', entry };
    } else {
        beginGroupDrag(app, worldPos);
        app._pcbSelectionInteraction = { mode: 'move', entry };
    }
    showProperties(app, entry);
    refreshBoxSelectionHighlights(app);
    return true;
}

/** Update the active supported-entity pointer state. */
export function updateSelectionInteraction(app, worldPos) {
    const state = app._pcbSelectionInteraction;
    if (!state) return false;
    if (state.mode === 'anchor') {
        state.adapter.updateAnchorDrag?.(worldPos);
        refreshBoxSelectionHighlights(app);
        return true;
    }
    if (state.mode === 'move') {
        updateGroupDrag(app, worldPos);
        return true;
    }
    if (state.mode === 'move-adapter') {
        state.entry.updateMove?.(worldPos);
        refreshBoxSelectionHighlights(app);
        return true;
    }
    return false;
}

/** Finish the active supported-entity pointer state. */
export function finishSelectionInteraction(app, commit = true) {
    const state = app._pcbSelectionInteraction;
    if (!state) return false;
    app._pcbSelectionInteraction = null;
    if (state.mode === 'anchor') state.adapter.endAnchorDrag?.(commit);
    else if (state.mode === 'move') {
        if (commit) endGroupDrag(app);
        else cancelGroupDrag(app);
    } else if (state.mode === 'move-adapter') {
        state.entry.endMove?.(commit);
    }
    refreshBoxSelectionHighlights(app);
    return true;
}