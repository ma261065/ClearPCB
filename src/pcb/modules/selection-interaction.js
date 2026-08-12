/** Pointer state machine for adapter-backed PCB selection gestures. */

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
import { clearTrackSelection, selectTrackOrVia, showViaProperties } from './track-select.js';
import {
    beginGroupDrag,
    cancelGroupDrag,
    endGroupDrag,
    refreshBoxSelectionHighlights,
    updateGroupDrag,
} from './box-select.js';
import { hitTestPcbSelectionAnchor } from './selection-anchors.js';

const SUPPORTED_KINDS = new Set(['component', 'shape', 'track', 'via', 'fill', 'text', 'reftext']);

export function clearSelectionInteractionUi(app) {
    clearTrackSelection(app);
    app._selectComponent?.(null);
    app._selectBoardOutline?.(false);
    app._selectText?.(null);
    app._selectRefText?.(null);
    app._selectFill?.(null);
    selectBoardShape(app, null);
}

function showProperties(app, entry) {
    if (entry.kind === 'component') {
        app._selectComponent?.(entry.object);
        app._showComponentProperties?.(entry.object);
    } else if (entry.kind === 'text') {
        app._selectText?.(entry.object);
        app._showTextProperties?.(entry.object);
    } else if (entry.kind === 'reftext') {
        app._selectRefText?.(entry.object);
        app._showRefProperties?.(entry.object);
    } else if (entry.kind === 'shape') showBoardShapeProperties(app, entry.object);
    else if (entry.kind === 'track') selectTrackOrVia(app, { type: 'track', track: entry.object });
    else if (entry.kind === 'via') showViaProperties(app, entry.object);
    else if (entry.kind === 'fill') {
        app._selectFill?.(entry.object);
        app._showFillProperties?.(entry.object);
    }
}

/** Start a state-machine-owned select gesture. Returns true when consumed. */
export function beginSelectionInteraction(app, worldPos, additive) {
    app._lastPointerWorld = worldPos;
    const selectedAnchor = hitTestPcbSelectionAnchor(app, worldPos, SUPPORTED_KINDS);
    if (selectedAnchor?.adapter.beginAnchorDrag?.(selectedAnchor.anchorId, worldPos)) {
        app._pcbSelectionInteraction = {
            mode: 'anchor',
            startWorld: { x: worldPos.x, y: worldPos.y },
            moved: false,
            ...selectedAnchor,
        };
        showProperties(app, selectedAnchor.adapter);
        return true;
    }

    const entry = hitTestPcbSelectionEntry(app, worldPos, SUPPORTED_KINDS);
    if (!entry) return false;

    if (additive) {
        togglePcbSelection(app, entry.kind, entry.object);
        const selected = getPcbSelectionEntries(app);
        const lead = selected.find((item) => item.kind === entry.kind)
            || selected.find((item) => SUPPORTED_KINDS.has(item.kind));
        if (lead) showProperties(app, lead);
        else app._clearProperties?.();
        refreshBoxSelectionHighlights(app);
        return true;
    }

    const selected = getPcbSelectionEntries(app);
    // Let PCBApp's marquee path move the complete set when a selected member
    // is clicked. Explicit anchor drags above still edit only that member.
    if (selected.length > 1 && selected.some((item) => item.id === entry.id)) return false;

    clearSelectionInteractionUi(app);
    const onlySupported = selected.length > 0 && selected.every((item) => SUPPORTED_KINDS.has(item.kind));
    const alreadySelected = selected.some((item) => item.id === entry.id);
    if (!alreadySelected || !onlySupported) {
        setPcbSelection(app, [{ kind: entry.kind, object: entry.object }]);
    }
    if (entry.beginMove?.(worldPos, { alreadySelected })) {
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
    if (state.mode === 'anchor' || state.mode === 'floating-anchor') {
        if (state.mode === 'anchor' && !state.moved) {
            const threshold = 3 / Math.max(0.01, app.viewport?.scale || 1);
            if (Math.hypot(worldPos.x - state.startWorld.x, worldPos.y - state.startWorld.y) > threshold) {
                state.moved = true;
            }
        }
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
    if (state.mode === 'anchor') {
        const result = state.adapter.endAnchorDrag?.(commit, { moved: state.moved });
        if (commit && result?.floating) {
            state.mode = 'floating-anchor';
            return true;
        }
    } else if (state.mode === 'floating-anchor') {
        state.adapter.endAnchorDrag?.(false, { moved: true });
    } else if (state.mode === 'move') {
        if (commit) endGroupDrag(app);
        else cancelGroupDrag(app);
    } else if (state.mode === 'move-adapter') {
        state.entry.endMove?.(commit);
    }
    app._pcbSelectionInteraction = null;
    refreshBoxSelectionHighlights(app);
    return true;
}

/** Place a click-release floating anchor at its current pointer position. */
export function placeFloatingSelectionInteraction(app) {
    const state = app._pcbSelectionInteraction;
    if (state?.mode !== 'floating-anchor') return false;
    app._pcbSelectionInteraction = null;
    state.adapter.endAnchorDrag?.(true, { moved: true, place: true });
    refreshBoxSelectionHighlights(app);
    return true;
}