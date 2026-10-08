/**
 * Selecting finished tracks and vias: the selection state (a whole track, or one of its
 * nodes or segments, kept as the refined track edit), the selection adapters, hit tests,
 * selecting, clearing, deleting, and the track context menu.
 *
 * Halos and net hover are copper-halos.js; the track and via Properties panels are
 * track-properties.js and via-properties.js.
 */
import { renderTrack, renderVia, setTrackLabelsVisible } from './track-render.js';
import { hitTestTrackEdge, deleteTrackSegment, hitTestTrackNode, deleteTrackNode } from './track-edits.js';
import { splitTrackNodeAndDrag, startVertexDrag, startTrackBulgeDrag, updateVertexDrag, finishVertexDrag, cancelVertexDrag, getVertexDrag, isDraggingTrack } from './track-drag.js';
import { startViaDrag, updateViaDrag, finishViaDrag, cancelViaDrag } from './terminal-drag.js';
import { RemoveTrackCommand, RemoveViaCommand, AddTrackCommand, CompoundCommand, ModifyTrackGraphCommand, canonicalVia, displayedVia, canonicalTrack, displayedTrack } from './track-commands.js';
import { setSelectionInteraction } from './selection-interaction.js';
import { PCB_LAYERS, isLayerLocked, isViaLocked, isLayerVisible, isViaVisible } from './layers.js';
import { isPcbObjectLocked } from './object-locks.js';
import { getPcbSelection, registerPcbSelectionAdapter, setPcbSelection } from './selection-registry.js';
import { lockPositionOutsideOutline, renderPcbSelectionAnchors } from './selection-anchors.js';
import { updateVertexDragCrosshair } from './cursor-state.js';
import { resolveTrackEdgePaths, resolveTrackSegments } from '../../shared/pcb/board-geometry.js';
import { arcEdgePathD, arcFromBulge } from '../../shapes/arc-edge.js';
import { pathMoveInteraction, pathContextActions, showPathContextMenu, dismissPathContextMenu } from './path-edit.js';
import { viaBounds, viaHitTest } from '../../shapes/via.js';
import { beginPcbAnchorInteraction } from './selection-interaction.js';
import { getPropertyEditor } from './property-editors.js';
import { showTrackNodeProperties, showTrackProperties, showTrackSegmentProperties, showTrackSelectionProperties } from './track-properties.js';
import { HALO_CLASS, HALO_COLOR, clearHoverHighlight, drawSegmentHalo, drawTrackHalo, drawViaHalo, refreshTrackSelectionHalo, removeHalosByClass } from './copper-halos.js';
import { showViaProperties } from './via-properties.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/track.js').Track} Track */
/** @typedef {import('../../shapes/via.js').Via} Via */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{track: Track, nodeId?: string|null, edgeId?: string|null}} TrackEdit */
/** @typedef {{type:'track', track: Track}|{type:'via', via: Via}} TrackViaHit */
/** @typedef {{place?: boolean, moved?: boolean}} FinishMoveOptions */
/** @typedef {{nodeId?: string|null, edgeId?: string|null, whole?: boolean, allowMidpointInsert?: boolean}} TrackDragOptions */

const NS = 'http://www.w3.org/2000/svg';
const trackSelectStates = new WeakMap();

/** Pixel tolerance for hit-testing tracks (converted to world units). */
const HIT_TOL_PX = 6;
const COPPER_LAYERS = PCB_LAYERS.filter((layer) => layer.id === 'top-copper' || layer.id === 'bottom-copper');

/** @param {PcbEditor} app */
function trackSelectState(app) {
    let state = trackSelectStates.get(app);
    if (!state) trackSelectStates.set(app, state = { trackEdit: null });
    return state;
}

/** @param {PcbEditor} app */
export function getTrackEdit(app) {
    return trackSelectState(app).trackEdit;
}

/**
 * @param {PcbEditor} app
 * @param {TrackEdit|null} edit
 */
export function setTrackEdit(app, edit) {
    trackSelectState(app).trackEdit = edit;
}

/** @param {PcbEditor} app */
export function clearTrackEdit(app) {
    setTrackEdit(app, null);
}

/** @param {PcbEditor} app */
export function getSelectedTrack(app) {
    return getPcbSelection(app, 'track')[0] || null;
}

/** @param {PcbEditor} app */
export function hasTrackEdit(app) {
    return !!getTrackEdit(app);
}

/** @param {PcbEditor} app */
export function getSelectedVia(app) {
    return getPcbSelection(app, 'via')[0] || null;
}

/** @param {Track|null|undefined} track */
export function trackIsSelectable(track) {
    if (track?.visible === false) return false;
    if (!track) return false;
    for (const [edgeId] of track?.edges || []) {
        const layer = track.getEdgeLayer(edgeId);
        if (!isLayerLocked(layer) && isLayerVisible(layer)) return true;
    }
    return false;
}

/** @param {Track|null|undefined} track */
export function trackIsVisible(track) {
    if (track?.visible === false) return false;
    if (!track) return false;
    for (const [edgeId] of track?.edges || []) {
        if (isLayerVisible(track.getEdgeLayer(edgeId))) return true;
    }
    return false;
}

/**
 * @param {Track} track
 * @param {Point} point
 * @param {number} tolerance
 */
function trackHitTest(track, point, tolerance) {
    for (const { start, end, width, layer } of resolveTrackSegments(track)) {
        if (!isLayerVisible(layer)) continue;
        const halfWidth = width / 2;
        if (_pointSegDist(point, start, end) <= halfWidth + tolerance) return true;
    }
    return false;
}

/**
 * Adapter bridge for the graph-based Track model.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} id
 */
export function createTrackSelectionAdapter(app, track, id) {
    track = /** @type {Track} */ (canonicalTrack(app, track));
    const current = () => displayedTrack(app, track);
    /**
     * @param {Point} worldPos
     * @param {TrackDragOptions} options
     */
    const beginDrag = (worldPos, options) => {
        const started = startVertexDrag(app, track, worldPos, /** @type {any} */ (options));
        app.setPcbStatus();
        return started;
    };
    /** @param {Point} worldPos */
    const updateDrag = (worldPos) => {
        if (!isDraggingTrack(app, track)) return;
        updateVertexDrag(app, worldPos);
        updateVertexDragCrosshair(app);
    };
    /**
     * @param {boolean} commit
     * @param {FinishMoveOptions} [options]
     */
    const finishNodeMove = (commit, options = {}) => {
        if (!isDraggingTrack(app, track)) return;
        if (!commit) {
            cancelVertexDrag(app);
            if ((app.pcbDocument?.tracks || app.tracks).includes(track)) showTrackSelectionProperties(app, track);
            app.setPcbStatus();
            return;
        }
        const drag = getVertexDrag(app);
        if (options.place && drag) {
            const edit = getTrackEdit(app);
            const nodeId = edit?.track === track ? edit.nodeId : null;
            finishVertexDrag(app);
            const selectedTrack = getSelectedTrack(app);
            if (selectedTrack) {
                if (selectedTrack === track && track.nodes.has(nodeId)) selectTrackNode(app, track, nodeId);
                else selectTrackOrVia(app, { type: 'track', track: selectedTrack });
            }
            app.setPcbStatus();
            return;
        }
        const clickedNodeId = options.moved ? null : drag?.mode === 'node' ? drag.nodes[0].nodeId
            : drag?.mode === 'rectangle' ? drag.nodes[drag.handle].nodeId : null;
        finishVertexDrag(app);
        if (getSelectedTrack(app) === track && clickedNodeId != null && track.nodes.has(clickedNodeId)) {
            selectTrackNode(app, track, clickedNodeId);
        } else if (getSelectedTrack(app) === track && getTrackEdit(app)?.nodeId != null) showTrackSelectionProperties(app, track);
        app.setPcbStatus();
    };
    return {
        id,
        kind: 'track',
        get object() { return current(); },
        get visible() { return trackIsVisible(current()); },
        get locked() { return isPcbObjectLocked(app, 'track', track); },
        /** @param {Point} pointer @param {number} scale */
        getLockPosition(pointer, scale) {
            const track = current();
            const paths = [...resolveTrackEdgePaths(track).entries()];
            return lockPositionOutsideOutline(
                paths.map(([, points]) => points),
                pointer,
                scale,
                false,
                paths.map(([edgeId]) => Math.max(0, Number(track.getEdgeWidth?.(edgeId) ?? track.width) || 0) / 2),
            );
        },
        getBounds() { return current().getBounds(); },
        /** @param {Point} point @param {number} tolerance */
        hitTest(point, tolerance) { return trackHitTest(current(), point, tolerance); },
        getEditPath() {
            const edit = getTrackEdit(app);
            if (edit?.track === track && edit.nodeId != null
                && !isDraggingTrack(app, track)) return '';
            const display = current();
            return [...display.edges.entries()].flatMap(([edgeId, edge]) => {
                if (!isLayerVisible(display.getEdgeLayer(edgeId))) return [];
                const start = display.nodes.get(edge.from), end = display.nodes.get(edge.to);
                return start && end ? [arcEdgePathD(start, end, edge.bulge || 0)] : [];
            }).join(' ');
        },
        getAnchors() {
            const display = current();
            const visibleEdges = [...display.edges.entries()].filter(([edgeId]) => isLayerVisible(display.getEdgeLayer(edgeId)));
            const visibleNodes = new Set(visibleEdges.flatMap(([, edge]) => [edge.from, edge.to]));
            const nodes = [...display.nodes.entries()].filter(([nodeId]) => visibleNodes.has(nodeId)).map(([nodeId, point]) => ({
                id: nodeId,
                ...point,
                fill: HALO_COLOR,
                stroke: getTrackEdit(app)?.track === track && getTrackEdit(app).nodeId === nodeId ? '#3399ff' : '#000000',
                selected: getTrackEdit(app)?.track === track && getTrackEdit(app).nodeId === nodeId,
                sizePx: 7,
                strokeWidthPx: 1.25,
                cursor: 'nwse-resize',
            }));
            const midpoints = visibleEdges.flatMap(([edgeId, edge]) => {
                const start = display.nodes.get(edge.from);
                const end = display.nodes.get(edge.to);
                if (start && end && edge.bulge) {
                    const arc = arcFromBulge(start, end, edge.bulge);
                    return arc ? [{ id: `bulge:${edgeId}`, ...arc.bulgePoint, round: true, fill: '#33dd77', cursor: 'grab' }] : [];
                }
                return start && end ? [{
                    id: `mid:${edgeId}`,
                    x: (start.x + end.x) / 2,
                    y: (start.y + end.y) / 2,
                    round: true,
                    fill: '#ffffff',
                    symbol: 'plus',
                    cursor: 'copy',
                }] : [];
            });
            return [...nodes, ...midpoints];
        },
        /** @param {string|number} anchorId @param {Point} worldPos */
        beginAnchorDrag(anchorId, worldPos) {
            getPropertyEditor(app, 'track')?.commit();
            if (String(anchorId).startsWith('bulge:')) {
                const edgeId = String(anchorId).slice(6);
                if (!track.edges.has(edgeId)) return false;
                selectTrackSegment(app, track, edgeId);
                return startTrackBulgeDrag(app, track, edgeId);
            }
            const started = beginDrag(worldPos, { nodeId: current().nodes.has(/** @type {string} */ (anchorId)) ? /** @type {string} */ (anchorId) : null,
                allowMidpointInsert: String(anchorId).startsWith('mid:') });
            return started;
        },
        /** @param {Point} worldPos */
        updateAnchorDrag(worldPos) {
            updateDrag(worldPos);
        },
        /** @param {boolean} commit @param {FinishMoveOptions} [options] */
        endAnchorDrag(commit, options = {}) {
            const drag = getVertexDrag(app);
            if (drag?.original !== track) return;
            if (drag?.mode !== 'bulge') return finishNodeMove(commit, options);
            try {
                if (commit) finishVertexDrag(app);
                else cancelVertexDrag(app);
            } finally {
                if ((app.pcbDocument?.tracks || app.tracks).includes(track)) showTrackSelectionProperties(app, track);
            }
        },
        // The selecting click must not split a midpoint. The legacy flow
        // requires a deliberate second click on the insertion handle.
        ...pathMoveInteraction({
            segmentAt: /** @param {Point} point */ point => hitTestTrackEdge(app, current(), point)?.edgeId ?? null,
            selectedSegment: () => getTrackEdit(app)?.track === track ? getTrackEdit(app).edgeId : null,
            selectSegment: /** @param {string} edgeId */ edgeId => selectTrackSegment(app, track, edgeId),
            /** @param {Point} point @param {string|null} edgeId */
            begin: (point, edgeId) => {
                if (edgeId != null) setTrackEdit(app, { track, edgeId });
                return beginDrag(point, { whole: edgeId == null, edgeId, allowMidpointInsert: false });
            },
            update: updateDrag,
            end: /** @param {boolean} commit */ commit => finishNodeMove(commit, { moved: true }),
        }),
        invalidate() { renderTrack(current(), (layerId) => app.getLayerGroup(layerId)); },
        render() { renderTrack(current(), (layerId) => app.getLayerGroup(layerId)); },
        clearEdit() { clearTrackEdit(app); },
    };
}

registerPcbSelectionAdapter('track', createTrackSelectionAdapter);

/**
 * @param {PcbEditor} app
 * @param {Via} via
 * @param {string} id
 */
export function createViaSelectionAdapter(app, via, id) {
    via = canonicalVia(app, via);
    const current = () => displayedVia(app, via);
    return {
        id,
        kind: 'via',
        get object() { return current(); },
        get visible() { return isViaVisible(); },
        get locked() { return isPcbObjectLocked(app, 'via', via); },
        /** @param {Point} pointer @param {number} scale */
        getLockPosition(pointer, scale) {
            const via = current();
            const radius = (Number(via.diameter) || 0.6) / 2;
            const outline = Array.from({ length: 24 }, (_, index) => {
                const angle = index * Math.PI * 2 / 24;
                return {
                    x: via.x + Math.cos(angle) * radius,
                    y: via.y + Math.sin(angle) * radius,
                };
            });
            return lockPositionOutsideOutline(outline, pointer, scale);
        },
        getBounds() { return viaBounds(current()); },
        /** @param {Point} point @param {number} tolerance */
        hitTest(point, tolerance) { return viaHitTest(current(), point, tolerance); },
        getPosition() { const via = current(); return { x: via.x, y: via.y }; },
        /** @param {Point} worldPos */
        beginMove(worldPos) {
            getPropertyEditor(app, 'via')?.commit();
            return startViaDrag(app, via, worldPos);
        },
        /** @param {Point} worldPos */
        updateMove(worldPos) { updateViaDrag(app, worldPos); },
        /** @param {boolean} commit */
        endMove(commit) { if (commit) finishViaDrag(app); else cancelViaDrag(app); },
        invalidate() { renderVia(current(), (layerId) => app.getLayerGroup(layerId)); },
        render() { renderVia(current(), (layerId) => app.getLayerGroup(layerId)); },
    };
}

registerPcbSelectionAdapter('via', createViaSelectionAdapter);

/* ──────────────────────────── hit testing ──────────────────────────── */

/**
 * Find the topmost track/via under `worldPos` (vias preferred).
 * @param {PcbEditor} app
 * @param {Point} worldPos
 * @param {number} [pxTol]
 * @returns {TrackViaHit|null}
 */
export function hitTestTrack(app, worldPos, pxTol = HIT_TOL_PX) {
    const scale = app.viewport?.scale || 1;
    const worldTol = pxTol / scale;

    // Vias first (smaller targets, should win over coincident tracks).
    // Skip them entirely when the via layers are locked or hidden.
    if (!isViaLocked() && isViaVisible()) {
        for (let i = app.vias.length - 1; i >= 0; i--) {
            const v = app.vias[i];
            if (!v.locked && viaHitTest(v, worldPos, worldTol)) {
                return { type: 'via', via: v };
            }
        }
    }

    // Tracks: distance to any segment within (width/2 + tol). Width is
    // per-edge, so resolve it inside the segment loop. Locked (by layer or
    // individually) and hidden-layer tracks are not hit-testable.
    for (let i = app.tracks.length - 1; i >= 0; i--) {
        const t = app.tracks[i];
        if (t.locked || isLayerLocked(t.layer) || !isLayerVisible(t.layer)) continue;
        if (trackHitTest(t, worldPos, worldTol)) return { type: 'track', track: t };
    }
    return null;
}

/**
 * Hit-test a world position against LOCKED tracks/vias only — the mirror of
 * hitTestTrack, which deliberately ignores them. Used to detect when a user
 * clicks something that's locked so we can explain why it can't be selected.
 * @param {PcbEditor} app
 * @param {{x:number,y:number}} worldPos
 * @param {number} [pxTol]
 * @returns {{type:'via'|'track', layerId:string}|null}
 */
export function hitTestLockedTrack(app, worldPos, pxTol = HIT_TOL_PX) {
    const scale = app.viewport?.scale || 1;
    const worldTol = pxTol / scale;

    if (isViaLocked() && isViaVisible()) {
        for (let i = app.vias.length - 1; i >= 0; i--) {
            const v = app.vias[i];
            if (viaHitTest(v, worldPos, worldTol)) {
                return { type: 'via', layerId: v.layer || 'top-copper' };
            }
        }
    }

    for (let i = app.tracks.length - 1; i >= 0; i--) {
        const t = app.tracks[i];
        if (!isLayerLocked(t.layer) || !isLayerVisible(t.layer)) continue;
        if (trackHitTest(t, worldPos, worldTol)) return { type: 'track', layerId: t.layer };
    }
    return null;
}

/**
 * @param {Point} p
 * @param {Point} a
 * @param {Point} b
 */
function _pointSegDist(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return Math.hypot(wx, wy);
    let t = (wx * vx + wy * vy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/* ──────────────────────────── selection ──────────────────────────── */

/**
 * Set the current track/via selection. Pass `null` to clear.
 * @param {PcbEditor} app
 * @param {TrackViaHit|null} hit
 */
export function selectTrackOrVia(app, hit) {
    if (hit?.type === 'track') hit = { ...hit, track: canonicalTrack(app, hit.track) };
    clearTrackSelection(app);
    // Clear any hover halo for the now-selected item so the two highlights
    // don't stack.
    clearHoverHighlight(app);
    if (!hit) {
        app.clearProperties();
        app.syncClipboardButtons();
        return;
    }
    if (hit.type === 'track') {
        setPcbSelection(app, [{ kind: 'track', object: hit.track }]);
        setTrackLabelsVisible(hit.track, false);
        drawTrackHalo(app, hit.track);
        showTrackProperties(app, hit.track);
    } else {
        setPcbSelection(app, [{ kind: 'via', object: hit.via }]);
        drawViaHalo(app, hit.via);
        showViaProperties(app, hit.via);
    }
    renderPcbSelectionAnchors(app);
    app.syncClipboardButtons();
}

/**
 * Select a single segment (one edge) of a track — the "second click"
 * refinement after the whole track is already selected. Keeps
 * Records the focused edge in the explicit Track edit state so selection
 * remains owned by the registry.
 *
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} edgeId
 */
export function selectTrackSegment(app, track, edgeId) {
    track = canonicalTrack(app, track);
    clearTrackSelection(app);
    clearHoverHighlight(app);
    if (!track || !track.edges?.has(edgeId)) {
        // Edge vanished (e.g. merged away) — fall back to whole-track select.
        if (track) selectTrackOrVia(app, { type: 'track', track });
        return;
    }
    setPcbSelection(app, [{ kind: 'track', object: track }]);
    setTrackEdit(app, { track, edgeId });
    setTrackLabelsVisible(track, false);
    drawSegmentHalo(app, track, edgeId);
    showTrackSegmentProperties(app, track, edgeId);
    renderPcbSelectionAnchors(app);
    app.setPcbStatus();
    app.syncClipboardButtons();
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} nodeId
 */
export function selectTrackNode(app, track, nodeId) {
    track = canonicalTrack(app, track);
    if (!track.nodes.has(nodeId)) return;
    setTrackEdit(app, { track, nodeId });
    showTrackNodeProperties(app, track, nodeId);
    refreshTrackSelectionHalo(app);
    app.setPcbStatus();
}

/**
 * Remove any track/via selection halos and clear stored references.
 * @param {PcbEditor} app
 */
export function clearTrackSelection(app) {
    getPropertyEditor(app, 'track')?.dispose();
    const prev = getSelectedTrack(app);
    clearTrackEdit(app);
    removeHalosByClass(app, HALO_CLASS);
    if (prev) {
        // Bring the net labels back. They were hidden via display toggling,
        // but a re-render while selected may have dropped them entirely
        // (hideNetLabel) — in that case re-render now to rebuild them.
        const restored = setTrackLabelsVisible(prev, true);
        if (!restored) {
            renderTrack(prev, (id) => app.getLayerGroup(id), {
                viaDiameter: app.getRoutingParams()?.viaDiameter,
                viaDrill: app.getRoutingParams()?.viaDrill,
            });
        }
    }
    app.syncClipboardButtons();
}

/**
 * Delete the currently selected track or via, then reconcile ratlines
 * and update the properties panel.
 * @param {PcbEditor} app
 */
export function deleteSelectedTrack(app) {
    getPropertyEditor(app, 'track')?.cancel();
    const lockedTrack = getSelectedTrack(app), lockedVia = getSelectedVia(app);
    if (lockedTrack ? isPcbObjectLocked(app, 'track', canonicalTrack(app, lockedTrack))
        : lockedVia && isPcbObjectLocked(app, 'via', canonicalVia(app, lockedVia))) return;
    // A single highlighted segment deletes just that edge (the rest of the
    // track survives as its remaining connected pieces). The focused edge is
    // explicit edit state, so verify its Track is still registry-selected.
    const selectedTrack = getSelectedTrack(app);
    const edit = getTrackEdit(app);
    if (edit && selectedTrack === edit.track) {
        const { track, edgeId, nodeId } = edit;
        if (nodeId != null) {
            if (getVertexDrag(app)) {
                setSelectionInteraction(app, null);
                cancelVertexDrag(app);
            }
            if (track.nodes.has(nodeId)) deleteTrackNode(app, track, nodeId);
            clearTrackEdit(app);
            if (app.tracks.includes(track)) showTrackSelectionProperties(app, track);
            else clearTrackSelection(app);
            app.setPcbStatus();
            return;
        }
        deleteTrackSegmentAt(app, track, edgeId);
        return;
    }
    if (selectedTrack) {
        const t = selectedTrack;
        clearTrackSelection(app);
        app.history?.execute(new RemoveTrackCommand(app, t));
    } else {
        const selectedVia = getSelectedVia(app);
        if (!selectedVia) return;
        const v = selectedVia;
        clearTrackSelection(app);
        app.history?.execute(new RemoveViaCommand(app, v));
    }
}

/**
 * Delete a single segment (edge) of `track`, replacing it with the
 * remaining connected pieces. Runs as one undoable compound command.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string|null|undefined} edgeId
 */
export function deleteTrackSegmentAt(app, track, edgeId) {
    track = canonicalTrack(app, track);
    getPropertyEditor(app, 'track')?.cancel();
    if (!track || !edgeId) return;
    const parts = deleteTrackSegment(track, edgeId);
    clearTrackSelection(app);
    const cmds = [new RemoveTrackCommand(app, track)];
    for (const part of parts) cmds.push(new AddTrackCommand(app, part));
    app.history?.execute(new CompoundCommand(cmds));
}

/* ─────────────────────────── context menu ─────────────────────────── */

/** Remove any open PCB context menu and its dismiss listeners. */
export function dismissTrackContextMenu() {
    dismissPathContextMenu('pcbTrackContextMenu');
}

/**
 * Show a right-click context menu for the given track/via hit at the
 * screen position. Selects the item first so the action targets it.
 * Intended for the select tool only (caller enforces that).
 *
 * @param {PcbEditor} app
 * @param {TrackViaHit} hit
 * @param {number} clientX
 * @param {number} clientY
 * @param {Point} [worldPos] - cursor position, used to
 *   target a specific segment for "Delete segment".
 */
export function showTrackContextMenu(app, hit, clientX, clientY, worldPos) {
    if (hit.type === 'track') {
        hit = { ...hit, track: canonicalTrack(app, hit.track) };
        getPropertyEditor(app, 'track')?.commit();
    }
    dismissTrackContextMenu();
    selectTrackOrVia(app, hit);
    if (hit.type === 'via') return showPathContextMenu('pcbTrackContextMenu',
        [{ text: 'Delete via', onClick: () => deleteSelectedTrack(app) }], clientX, clientY);
    const track = hit.track;
    const nodeId = worldPos ? hitTestTrackNode(app, track, worldPos) : null;
    const edgeId = !nodeId && worldPos ? hitTestTrackEdge(app, track, worldPos)?.edgeId : null;
    if (nodeId) selectTrackNode(app, track, nodeId);
    else if (edgeId) selectTrackSegment(app, track, edgeId);
    const items = pathContextActions({ node: nodeId != null, segment: edgeId != null,
        curved: !!track.edges.get(edgeId)?.bulge,
        split: nodeId && track.degree(nodeId) >= 2 ? () => splitTrackNodeAndDrag(app, track, nodeId) : null,
        deleteNode: nodeId && track.degree(nodeId) <= 2 ? () => deleteSelectedTrack(app) : null,
        deleteSegment: () => deleteTrackSegmentAt(app, track, edgeId),
        convert: () => {
            const before = track.captureState();
            const edge = track.edges.get(edgeId);
            const curved = !!edge.bulge;
            edge.bulge = curved ? 0 : 0.25;
            const after = track.captureState();
            track.applyState(before);
            app.history.execute(new ModifyTrackGraphCommand(app, track, before, after));
            selectTrackSegment(app, track, edgeId);
            if (!curved) {
                const adapter = /** @type {import('./selection-registry.js').SelectionAdapter} */ (createTrackSelectionAdapter(app, track, track.id));
                const anchor = adapter.getAnchors?.().find(item => item.id === `bulge:${edgeId}`);
                if (anchor) beginPcbAnchorInteraction(app, adapter, anchor, anchor, true);
            }
        },
        deleteObject: () => { clearTrackSelection(app); app.history.execute(new RemoveTrackCommand(app, track)); },
        label: 'track',
    });
    return showPathContextMenu('pcbTrackContextMenu', /** @type {import('../../shared/ui/context-menu.js').MenuItem[]} */ (items.filter(Boolean)), clientX, clientY, () => refreshTrackSelectionHalo(app));
}
