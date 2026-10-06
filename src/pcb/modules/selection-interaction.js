/** Pointer state machine for adapter-backed PCB selection gestures. */

import {
    getPcbSelection,
    getPcbSelectionEntries,
    getPcbSelectionHits,
    hitTestPcbSelectionEntry,
    setPcbSelection,
    togglePcbSelection,
} from './selection-registry.js';
import {
    selectBoardShape,
} from './board-shapes.js';
import { showBoardShapeProperties } from './board-shape-properties.js';
import { clearTrackSelection, showTrackSelectionProperties, showViaProperties } from './track-select.js';
import {
    beginGroupDrag,
    cancelGroupDrag,
    endGroupDrag,
    refreshBoxSelectionHighlights,
    scheduleBoxSelectionHighlights,
    scheduleGroupDrag,
} from './box-select.js';
import { hitTestPcbSelectionAnchor, renderPcbSelectionAnchors } from './selection-anchors.js';
import { isRotationHandleDragActive, ROTATION_CURSOR } from './rotation-handle.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { selectBoardOutline } from './board-outline-resize.js';
import { selectRefText } from './ref-text-selection.js';
import { setLastPointerWorld } from './cursor-state.js';
import { showFillProperties } from './copper-fill-edit.js';

const SUPPORTED_KINDS = new Set(['component', 'shape', 'track', 'via', 'pad', 'fill', 'text', 'reftext']);

/** The active shared selection interaction (`{ mode, adapter, ... }`), or null. */
export function getSelectionInteraction(app) {
    return getPcbInteraction(app, '_pcbSelectionInteraction');
}

export function setSelectionInteraction(app, state) {
    setPcbInteraction(app, '_pcbSelectionInteraction', state);
}

export function selectionInteractionCursor(app) {
    if (isRotationHandleDragActive(app)) return ROTATION_CURSOR;
    const state = getSelectionInteraction(app);
    return state?.mode === 'circle-anchor'
        ? (state.anchorKey === 'radius' ? 'ew-resize' : 'move') : 'grabbing';
}

export function clearSelectionInteractionUi(app) {
    clearTrackSelection(app);
    app._selectComponent?.(null);
    selectBoardOutline(app, false);
    app.selectText?.(null);
    selectRefText(app, null);
    app.selectFill?.(null);
    selectBoardShape(app, null);
}

function showSingleProperties(app, entry) {
    if (entry.kind === 'component') {
        app._selectComponent?.(entry.object);
        app.showComponentProperties?.(entry.object);
    } else if (entry.kind === 'text') {
        app.selectText?.(entry.object);
        app.showTextProperties?.(entry.object);
    } else if (entry.kind === 'reftext') {
        selectRefText(app, entry.object);
        app._showRefProperties?.(entry.object);
    } else if (entry.kind === 'shape') showBoardShapeProperties(app, entry.object);
    else if (entry.kind === 'track') showTrackSelectionProperties(app, entry.object);
    else if (entry.kind === 'via') showViaProperties(app, entry.object);
    else if (entry.kind === 'pad') app._showPadProperties?.(entry.object);
    else if (entry.kind === 'fill') {
        app.selectFill?.(entry.object);
        showFillProperties(app, entry.object);
    }
}

/** Show Properties for the current registry selection without collapsing it. */
export function showPcbSelectionProperties(app) {
    const selected = getPcbSelectionEntries(app);
    if (!selected.length) {
        app.clearProperties?.();
        return;
    }
    if (selected.length === 1) {
        showSingleProperties(app, selected[0]);
        return;
    }
    const kinds = new Set(selected.map((entry) => entry.kind));
    // Families with geometry-aware batch editors keep those specialized panels while
    // every member is editable. A selection holding a locked object uses PCBApp's
    // shared capability panel, which applies edits to the unlocked members only.
    const anyLocked = selected.some(entry => entry.locked);
    if (anyLocked) {
        app._showPcbMultiSelectionProperties?.(selected);
    } else if (kinds.size === 1 && selected[0].kind === 'shape') {
        showBoardShapeProperties(app, selected[0].object);
    } else if (kinds.size === 1 && selected[0].kind === 'via') {
        showViaProperties(app, selected[0].object);
    } else if (kinds.size === 1 && selected[0].kind === 'pad') {
        app._showPadProperties?.(selected[0].object);
    } else {
        app._showPcbMultiSelectionProperties?.(selected);
    }
}

/** Start an anchor gesture; context-menu actions may request floating placement. */
export function beginPcbAnchorInteraction(app, adapter, anchor, worldPos, floating = false) {
    if (adapter.locked) return false;
    const anchorId = anchor.id ?? anchor.key;
    if (!adapter.beginAnchorDrag?.(anchorId, worldPos, { floating })) return false;
    setSelectionInteraction(app, {
        mode: floating ? 'floating-anchor' : 'anchor',
        startWorld: { x: worldPos.x, y: worldPos.y },
        moved: false,
        adapter, anchor, anchorId,
    });
    showPcbSelectionProperties(app);
    if (floating) adapter.updateAnchorDrag?.(worldPos);
    if (floating || isRotationHandleDragActive(app)) {
        renderPcbSelectionAnchors(app);
        if (app.viewport?.svg) app.viewport.svg.style.cursor = selectionInteractionCursor(app);
    }
    return true;
}

export function beginSelectionInteraction(app, worldPos, additive, cycle = false) {
    setLastPointerWorld(app, worldPos);
    const selected = getPcbSelectionEntries(app);
    if (cycle || additive) {
        const entry = hitTestPcbSelectionEntry(app, worldPos, SUPPORTED_KINDS);
        if (!entry) return false;
        if (cycle) {
            setSelectionInteraction(app, { mode: 'cycle', startWorld: { ...worldPos }, additive });
        } else {
            togglePcbSelection(app, entry.kind, entry.object);
            showPcbSelectionProperties(app);
            refreshBoxSelectionHighlights(app);
        }
        return true;
    }
    // A selected shape's anchor used to preempt the shared group-drag path.
    // This made Ctrl+A depend on the exact pixel grabbed: a vertex moved one
    // shape while its body moved the whole selection. Let PCBApp route every
    // multi-selection drag through beginGroupDrag before inspecting anchors.
    if (!additive && selected.length > 1) return false;

    const selectedAnchor = hitTestPcbSelectionAnchor(app, worldPos, SUPPORTED_KINDS);
    if (selectedAnchor && beginPcbAnchorInteraction(app, selectedAnchor.adapter, selectedAnchor.anchor, worldPos)) {
        return true;
    }

    const hits = getPcbSelectionHits(app, worldPos, SUPPORTED_KINDS);
    const entry = hits.find(hit => selected.some(item => item.id === hit.id)) || hits[0];
    if (!entry) return false;

    // Let PCBApp's marquee path move the complete set when a selected member
    // is clicked.
    if (selected.length > 1 && selected.some((item) => item.id === entry.id)) return false;

    const selectedSegment = entry.getSelectedSegment?.() ?? null;
    clearSelectionInteractionUi(app);
    const alreadySelected = selected.some((item) => item.id === entry.id);
    setPcbSelection(app, [{ kind: entry.kind, object: entry.object }]);
    if (entry.locked) {
        setSelectionInteraction(app, null);
    } else if (entry.beginMove?.(worldPos, { alreadySelected, selectedSegment })) {
        setSelectionInteraction(app, {
            mode: 'move-adapter',
            entry,
            startWorld: { x: worldPos.x, y: worldPos.y },
            moved: false,
        });
    } else {
        beginGroupDrag(app, worldPos);
        setSelectionInteraction(app, { mode: 'move', entry });
    }
    showPcbSelectionProperties(app);
    refreshBoxSelectionHighlights(app);
    return true;
}

/** Update the active supported-entity pointer state. */
export function updateSelectionInteraction(app, worldPos) {
    const state = getSelectionInteraction(app);
    if (!state) return false;
    if (state.mode === 'cycle') {
        const threshold = 3 / Math.max(0.01, app.viewport?.scale || 1);
        if (Math.hypot(worldPos.x - state.startWorld.x, worldPos.y - state.startWorld.y) <= threshold) return true;
        setSelectionInteraction(app, null);
        if (!beginSelectionInteraction(app, state.startWorld, false)) {
            const entry = hitTestPcbSelectionEntry(app, state.startWorld, SUPPORTED_KINDS);
            if (!entry) return true;
            if (getPcbSelectionEntries(app).some((item) => item.id === entry.id)) {
                beginGroupDrag(app, state.startWorld);
                setSelectionInteraction(app, { mode: 'move' });
            } else {
                setPcbSelection(app, [{ kind: entry.kind, object: entry.object }]);
                beginSelectionInteraction(app, state.startWorld, false);
            }
        }
        return updateSelectionInteraction(app, worldPos);
    }
    if (state.mode === 'anchor' || state.mode === 'floating-anchor') {
        if (state.mode === 'anchor' && !state.moved) {
            const threshold = 3 / Math.max(0.01, app.viewport?.scale || 1);
            if (Math.hypot(worldPos.x - state.startWorld.x, worldPos.y - state.startWorld.y) > threshold) {
                state.moved = true;
            }
        }
        state.adapter.updateAnchorDrag?.(worldPos);
        scheduleBoxSelectionHighlights(app);
        return true;
    }
    if (state.mode === 'move') {
        scheduleGroupDrag(app, worldPos);
        return true;
    }
    if (state.mode === 'move-adapter') {
        if (!state.moved) {
            const threshold = 3 / Math.max(0.01, app.viewport?.scale || 1);
            if (Math.hypot(worldPos.x - state.startWorld.x, worldPos.y - state.startWorld.y) > threshold) {
                state.moved = true;
            }
        }
        state.entry.updateMove?.(worldPos);
        scheduleBoxSelectionHighlights(app);
        return true;
    }
    return false;
}

/** Finish the active supported-entity pointer state. */
export function finishSelectionInteraction(app, commit = true, worldPos = null) {
    if (commit && worldPos && getSelectionInteraction(app)?.mode === 'cycle') updateSelectionInteraction(app, worldPos);
    const state = getSelectionInteraction(app);
    if (!state) return false;
    if (commit && state.mode === 'anchor' && !state.moved
        && ['shape', 'track', 'fill'].includes(state.adapter.kind)
        && String(state.anchorId).startsWith('mid:')) {
        state.mode = 'floating-anchor';
        renderPcbSelectionAnchors(app);
        if (app.viewport?.svg) app.viewport.svg.style.cursor = selectionInteractionCursor(app);
        return true;
    }
    try {
        if (state.mode === 'cycle') {
            if (commit) {
                const selected = getPcbSelectionEntries(app);
                const hits = getPcbSelectionHits(app, state.startWorld, SUPPORTED_KINDS);
                const index = hits.findIndex((hit) => selected.some((item) => item.id === hit.id));
                const next = hits[(index + 1) % hits.length];
                if (next) {
                    const keep = state.additive ? selected.filter((item) => !hits.some((hit) => hit.id === item.id)) : [];
                    setPcbSelection(app, [...keep, next].map(({ kind, object }) => ({ kind, object })));
                    showPcbSelectionProperties(app);
                }
            }
        } else if (state.mode === 'anchor') {
            if (commit && worldPos && state.anchor?.symbol === 'rotate') state.adapter.updateAnchorDrag?.(worldPos);
            state.adapter.endAnchorDrag?.(commit, { moved: state.moved });
        } else if (state.mode === 'floating-anchor') {
            state.adapter.endAnchorDrag?.(false, { moved: true });
        } else if (state.mode === 'move') {
            if (commit) endGroupDrag(app);
            else cancelGroupDrag(app);
        } else if (state.mode === 'move-adapter') {
            state.entry.endMove?.(commit, { moved: state.moved, startWorld: state.startWorld });
        }
    } finally {
        setSelectionInteraction(app, null);
        refreshBoxSelectionHighlights(app);
        if (state.anchor?.symbol === 'rotate' && app.viewport?.svg) app.viewport.svg.style.cursor = 'default';
    }
    return true;
}

/** Place an anchor picked up by a midpoint click or context-menu action. */
export function placeFloatingSelectionInteraction(app) {
    const state = getSelectionInteraction(app);
    if (state?.mode !== 'floating-anchor') return false;
    setSelectionInteraction(app, null);
    state.adapter.endAnchorDrag?.(true, { moved: true, place: true });
    refreshBoxSelectionHighlights(app);
    return true;
}