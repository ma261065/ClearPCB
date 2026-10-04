/**
 * Selection + manipulation of finished Tracks and Vias on the PCB tab.
 *
 * Phase 4 scope:
 *   - Hit-test a world position against existing tracks/vias.
 *   - Select / deselect with a coloured halo overlay.
 *   - Delete the selected object (and trigger ratsnest reconciliation).
 *   - Edit the selected track's width / via's diameter live from the
 *     Properties panel.
 *
 * Out of scope (deferred):
 *   - Vertex/segment dragging.
 *   - Undo/redo (PCBApp has no CommandHistory yet).
 *   - Multi-selection.
 */

import { buildTrackLayerRuns, removeTrackElements, removeViaElements, renderTrack, renderVia, setTrackLabelsVisible } from './track-render.js';
import { reconcileRatsnest, collectBondedCopper } from './track-draw.js';
import {
    hitTestTrackEdge,
    deleteTrackSegment,
    hitTestTrackNode,
    splitTrackNodeAndDrag,
    deleteTrackNode,
    reconcileCopperRegion,
    startViaDrag,
    updateViaDrag,
    finishViaDrag,
    cancelViaDrag,
    startVertexDrag,
    startTrackBulgeDrag,
    updateVertexDrag,
    finishVertexDrag,
    cancelVertexDrag,
} from './track-drag.js';
import {
    RemoveTrackCommand,
    RemoveViaCommand,
    AddTrackCommand,
    AddViaCommand,
    CompoundCommand,
    ModifyTrackCommand,
    ModifyTrackGraphCommand,
    ModifyViaCommand,
    ModifyViasCommand,
    canonicalVia, displayedVia, beginViaPropertyPreview, finishViaPropertyPreview,
    canonicalTrack, displayedTrack, beginTrackPropertyPreview, finishTrackPropertyPreview,
} from './track-commands.js';
import {
    PCB_HOVER_HIGHLIGHT_OPACITY,
    PCB_LAYERS,
    PCB_SELECTION_HIGHLIGHT_OPACITY,
    isLayerLocked,
    isViaLocked,
    isLayerVisible,
    isViaVisible,
    pcbLayerOptionHtml,
    unlockPcbLayer,
} from './layers.js';
import { setBoardShapeNetHover, canFillTrackLoop, fillTrackLoop, canMoveTrackToBoardLayer, moveTrackToBoardLayer, setTrackCopperMode } from './board-shapes.js';
import { PROP_HIDDEN_LAYERS } from './board-shape-properties.js';
import { normalizeShapeCopperMode } from '../../shared/pcb/board-shape-geometry.js';
import { showAlert } from '../../shared/ui/modal.js';
import {
    getPcbSelection,
    isPcbSelected,
    registerPcbSelectionAdapter,
    setPcbSelection,
} from './selection-registry.js';
import { lockPositionOutsideOutline, renderPcbSelectionAnchors } from './selection-anchors.js';
import { formatNumberInputValue } from '../../core/number-inputs.js';
import { resolveTrackEdgePaths, resolveTrackSegments } from '../../shared/pcb/board-geometry.js';
import { arcEdgePathD, arcFromBulge } from '../../shapes/arc-edge.js';
import { pathMoveInteraction, pathContextActions, showPathContextMenu, dismissPathContextMenu } from './path-edit.js';
import { padOutline } from '../../shapes/pad-geometry.js';
import { viaBounds, viaHitTest } from '../../shapes/via.js';
import { beginPcbAnchorInteraction } from './selection-interaction.js';
import { getPropertyEditor, releasePropertyEditor, setPropertyEditor } from './property-editors.js';
import { isEditorActive } from './pcb-editor-api.js';

const NS = 'http://www.w3.org/2000/svg';
const HALO_CLASS = 'pcb-track-selection';
const HOVER_CLASS = 'pcb-track-hover';
const VIA_BATCH_HALO_CLASS = 'pcb-box-via-sel';

/** Halo stroke colour — translucent white overlays the track so the
 *  underlying copper colour still reads through. Kept low-opacity so a
 *  selected track only brightens slightly and its layer colour (top vs
 *  bottom) stays clearly distinguishable. */
const HALO_COLOR = '#ffffff';
const HALO_OPACITY_SELECTED = PCB_SELECTION_HIGHLIGHT_OPACITY;
const HALO_OPACITY_HOVER = PCB_HOVER_HIGHLIGHT_OPACITY;

/** Pixel tolerance for hit-testing tracks (converted to world units). */
const HIT_TOL_PX = 6;
const COPPER_LAYERS = PCB_LAYERS.filter((layer) => layer.id === 'top-copper' || layer.id === 'bottom-copper');

export function getSelectedTrack(app) {
    return getPcbSelection(app, 'track')[0] || null;
}

export function getSelectedVia(app) {
    return getPcbSelection(app, 'via')[0] || null;
}

export function trackIsSelectable(track) {
    if (track?.visible === false) return false;
    for (const [edgeId] of track?.edges || []) {
        const layer = track.getEdgeLayer(edgeId);
        if (!isLayerLocked(layer) && isLayerVisible(layer)) return true;
    }
    return false;
}

function trackIsVisible(track) {
    if (track?.visible === false) return false;
    for (const [edgeId] of track?.edges || []) {
        if (isLayerVisible(track.getEdgeLayer(edgeId))) return true;
    }
    return false;
}

function trackHitTest(track, point, tolerance) {
    for (const { start, end, width, layer } of resolveTrackSegments(track)) {
        if (!isLayerVisible(layer)) continue;
        const halfWidth = width / 2;
        if (_pointSegDist(point, start, end) <= halfWidth + tolerance) return true;
    }
    return false;
}

/** Adapter bridge for the graph-based Track model. */
export function createTrackSelectionAdapter(app, track, id) {
    track = canonicalTrack(app, track);
    const current = () => displayedTrack(app, track);
    const beginDrag = (worldPos, options) => {
        const started = startVertexDrag(app, track, worldPos, options);
        app.setPcbStatus?.();
        return started;
    };
    const updateDrag = (worldPos) => {
        const drag = app._vertexDrag;
        if (drag?.original !== track) return;
        updateVertexDrag(app, worldPos);
        app._updateVertexDragCrosshair?.();
    };
    const finishNodeMove = (commit, options = {}) => {
        if (app._vertexDrag?.original !== track) return;
        if (!commit) {
            cancelVertexDrag(app);
            if ((app.pcbDocument?.tracks || app.tracks).includes(track)) showTrackSelectionProperties(app, track);
            app.setPcbStatus?.();
            return;
        }
        const drag = app._vertexDrag;
        if (options.place && drag) {
            const nodeId = app._trackEdit?.track === track ? app._trackEdit.nodeId : null;
            finishVertexDrag(app);
            const selectedTrack = getSelectedTrack(app);
            if (selectedTrack) {
                if (selectedTrack === track && track.nodes.has(nodeId)) selectTrackNode(app, track, nodeId);
                else selectTrackOrVia(app, { type: 'track', track: selectedTrack });
            }
            app.setPcbStatus?.();
            return;
        }
        const clickedNodeId = options.moved ? null : drag?.mode === 'node' ? drag.nodes[0].nodeId
            : drag?.mode === 'rectangle' ? drag.nodes[drag.handle].nodeId : null;
        finishVertexDrag(app);
        if (getSelectedTrack(app) === track && clickedNodeId != null && track.nodes.has(clickedNodeId)) {
            selectTrackNode(app, track, clickedNodeId);
        } else if (getSelectedTrack(app) === track && app._trackEdit?.nodeId != null) showTrackSelectionProperties(app, track);
        app.setPcbStatus?.();
    };
    return {
        id,
        kind: 'track',
        get object() { return current(); },
        get visible() { return trackIsVisible(current()); },
        get locked() { return !trackIsSelectable(track); },
        unlock() {
            for (const [edgeId] of track.edges || []) {
                const layer = track.getEdgeLayer(edgeId);
                if (isLayerLocked(layer)) unlockPcbLayer(app, layer);
            }
        },
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
        hitTest(point, tolerance) { return trackHitTest(current(), point, tolerance); },
        getEditPath() {
            if (app._trackEdit?.track === track && app._trackEdit.nodeId != null
                && app._vertexDrag?.original !== track) return '';
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
                stroke: app._trackEdit?.track === track && app._trackEdit.nodeId === nodeId ? '#3399ff' : '#000000',
                selected: app._trackEdit?.track === track && app._trackEdit.nodeId === nodeId,
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
        beginAnchorDrag(anchorId, worldPos) {
            getPropertyEditor(app, 'track')?.commit();
            if (String(anchorId).startsWith('bulge:')) {
                const edgeId = String(anchorId).slice(6);
                if (!track.edges.has(edgeId)) return false;
                selectTrackSegment(app, track, edgeId);
                return startTrackBulgeDrag(app, track, edgeId);
            }
            const started = beginDrag(worldPos, { nodeId: current().nodes.has(anchorId) ? anchorId : null,
                allowMidpointInsert: String(anchorId).startsWith('mid:') });
            return started;
        },
        updateAnchorDrag(worldPos) {
            updateDrag(worldPos);
        },
        endAnchorDrag(commit, options = {}) {
            if (app._vertexDrag?.original !== track) return;
            if (app._vertexDrag?.mode !== 'bulge') return finishNodeMove(commit, options);
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
            segmentAt: point => hitTestTrackEdge(app, current(), point)?.edgeId ?? null,
            selectedSegment: () => app._trackEdit?.track === track ? app._trackEdit.edgeId : null,
            selectSegment: edgeId => selectTrackSegment(app, track, edgeId),
            begin: (point, edgeId) => {
                if (edgeId != null) app._trackEdit = { track, edgeId };
                return beginDrag(point, { whole: edgeId == null, edgeId, allowMidpointInsert: false });
            },
            update: updateDrag,
            end: commit => finishNodeMove(commit, { moved: true }),
        }),
        invalidate() { renderTrack(current(), (layerId) => app.getLayerGroup(layerId)); },
        render() { renderTrack(current(), (layerId) => app.getLayerGroup(layerId)); },
    };
}

registerPcbSelectionAdapter('track', createTrackSelectionAdapter);

export function createViaSelectionAdapter(app, via, id) {
    via = canonicalVia(app, via);
    const current = () => displayedVia(app, via);
    return {
        id,
        kind: 'via',
        get object() { return current(); },
        get visible() { return isViaVisible(); },
        get locked() { return isViaLocked(); },
        unlock() {
            unlockPcbLayer(app, 'vias');
        },
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
        hitTest(point, tolerance) { return viaHitTest(current(), point, tolerance); },
        getPosition() { const via = current(); return { x: via.x, y: via.y }; },
        beginMove(worldPos) {
            getPropertyEditor(app, 'via')?.commit();
            return startViaDrag(app, via, worldPos);
        },
        updateMove(worldPos) { updateViaDrag(app, worldPos); },
        endMove(commit) { if (commit) finishViaDrag(app); else cancelViaDrag(app); },
        invalidate() { renderVia(current(), (layerId) => app.getLayerGroup(layerId)); },
        render() { renderVia(current(), (layerId) => app.getLayerGroup(layerId)); },
    };
}

registerPcbSelectionAdapter('via', createViaSelectionAdapter);

/* ──────────────────────────── hit testing ──────────────────────────── */

/**
 * Find the topmost track/via under `worldPos` (vias preferred).
 * @returns {{type:'track', track:object}|{type:'via', via:object}|null}
 */
export function hitTestTrack(app, worldPos, pxTol = HIT_TOL_PX) {
    const scale = app.viewport?.scale || 1;
    const worldTol = pxTol / scale;

    // Vias first (smaller targets, should win over coincident tracks).
    // Skip them entirely when the via layers are locked or hidden.
    if (!isViaLocked() && isViaVisible()) {
        for (let i = app.vias.length - 1; i >= 0; i--) {
            const v = app.vias[i];
            if (viaHitTest(v, worldPos, worldTol)) {
                return { type: 'via', via: v };
            }
        }
    }

    // Tracks: distance to any segment within (width/2 + tol). Width is
    // per-edge, so resolve it inside the segment loop. Locked- or hidden-layer
    // tracks are not hit-testable.
    for (let i = app.tracks.length - 1; i >= 0; i--) {
        const t = app.tracks[i];
        if (isLayerLocked(t.layer) || !isLayerVisible(t.layer)) continue;
        if (trackHitTest(t, worldPos, worldTol)) return { type: 'track', track: t };
    }
    return null;
}

/**
 * Hit-test a world position against LOCKED tracks/vias only — the mirror of
 * hitTestTrack, which deliberately ignores them. Used to detect when a user
 * clicks something that's locked so we can explain why it can't be selected.
 * @param {object} app
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
 * @param {object} app
 * @param {{type:'track', track:object}|{type:'via', via:object}|null} hit
 */
export function selectTrackOrVia(app, hit) {
    if (hit?.type === 'track') hit = { ...hit, track: canonicalTrack(app, hit.track) };
    clearTrackSelection(app);
    // Clear any hover halo for the now-selected item so the two highlights
    // don't stack.
    _removeHalos(app, HOVER_CLASS);
    app._hoveredTrackOrVia = null;
    if (!hit) {
        app.clearProperties?.();
        app.syncClipboardButtons?.();
        return;
    }
    if (hit.type === 'track') {
        setPcbSelection(app, [{ kind: 'track', object: hit.track }]);
        setTrackLabelsVisible(hit.track, false);
        _drawTrackHalo(app, hit.track);
        _showTrackProperties(app, hit.track);
    } else {
        setPcbSelection(app, [{ kind: 'via', object: hit.via }]);
        _drawViaHalo(app, hit.via);
        showViaProperties(app, hit.via);
    }
    renderPcbSelectionAnchors(app);
    app.syncClipboardButtons?.();
}

/**
 * Select a single segment (one edge) of a track — the "second click"
 * refinement after the whole track is already selected. Keeps
 * Records the focused edge in the explicit Track edit state so selection
 * remains owned by the registry.
 *
 * @param {object} app
 * @param {object} track
 * @param {string} edgeId
 */
export function selectTrackSegment(app, track, edgeId) {
    track = canonicalTrack(app, track);
    clearTrackSelection(app);
    _removeHalos(app, HOVER_CLASS);
    app._hoveredTrackOrVia = null;
    if (!track || !track.edges?.has(edgeId)) {
        // Edge vanished (e.g. merged away) — fall back to whole-track select.
        if (track) selectTrackOrVia(app, { type: 'track', track });
        return;
    }
    setPcbSelection(app, [{ kind: 'track', object: track }]);
    app._trackEdit = { track, edgeId };
    setTrackLabelsVisible(track, false);
    _drawSegmentHalo(app, track, edgeId);
    _showTrackSegmentProperties(app, track, edgeId);
    renderPcbSelectionAnchors(app);
    app.setPcbStatus?.();
    app.syncClipboardButtons?.();
}

export function selectTrackNode(app, track, nodeId) {
    track = canonicalTrack(app, track);
    if (!track.nodes.has(nodeId)) return;
    app._trackEdit = { track, nodeId };
    _showTrackNodeProperties(app, track, nodeId);
    refreshTrackSelectionHalo(app);
    app.setPcbStatus?.();
}

export function showTrackSelectionProperties(app, track) {
    track = canonicalTrack(app, track);
    const edit = app._trackEdit;
    if (edit?.track === track && track.nodes.has(edit.nodeId)) {
        _showTrackNodeProperties(app, track, edit.nodeId);
    } else if (edit?.track === track && track.edges.has(edit.edgeId)) {
        _showTrackSegmentProperties(app, track, edit.edgeId);
    } else selectTrackOrVia(app, { type: 'track', track });
}

/** Remove any track/via selection halos and clear stored references. */
export function clearTrackSelection(app) {
    getPropertyEditor(app, 'track')?.dispose();
    const prev = getSelectedTrack(app);
    app._trackEdit = null;
    _removeHalos(app, HALO_CLASS);
    if (prev) {
        // Bring the net labels back. They were hidden via display toggling,
        // but a re-render while selected may have dropped them entirely
        // (hideNetLabel) — in that case re-render now to rebuild them.
        const restored = setTrackLabelsVisible(prev, true);
        if (!restored) {
            renderTrack(prev, (id) => app.getLayerGroup(id), {
                viaDiameter: app.getRoutingParams?.()?.viaDiameter,
                viaDrill: app.getRoutingParams?.()?.viaDrill,
            });
        }
    }
    app.syncClipboardButtons?.();
}

/**
 * Re-draw the selection halo for the currently-selected track/via.
 * Call this after the underlying track has been re-rendered (e.g.
 * during a vertex drag) so the halo follows the new geometry.
 */
export function refreshTrackSelectionHalo(app) {
    _removeHalos(app, HALO_CLASS);
    const selectedVias = getPcbSelection(app, 'via');
    if (selectedVias.length > 1) {
        _removeHalos(app, VIA_BATCH_HALO_CLASS);
        for (const via of selectedVias) _drawViaHalo(app, via, VIA_BATCH_HALO_CLASS, HALO_OPACITY_SELECTED);
        renderPcbSelectionAnchors(app);
        return;
    }
    // A previous batch refresh can leave its Via-specific overlay behind.
    // It is only valid for a multi-selection; otherwise a larger old ring
    // masks the freshly resized single-selection halo when the Via shrinks.
    if (getPcbSelection(app).length === 1) _removeHalos(app, VIA_BATCH_HALO_CLASS);
    const selectedTrack = getSelectedTrack(app);
    const selectedVia = getSelectedVia(app);
    const selectedNode = canonicalTrack(app, selectedTrack) === app._trackEdit?.track
        && selectedTrack?.nodes.has(app._trackEdit.nodeId);
    if (app._trackEdit?.edgeId && canonicalTrack(app, selectedTrack) === app._trackEdit.track) {
        _drawSegmentHalo(app, selectedTrack, app._trackEdit.edgeId);
    } else if (selectedTrack && !selectedNode) _drawTrackHalo(app, selectedTrack, HALO_CLASS, HALO_OPACITY_SELECTED);
    else if (selectedVia) _drawViaHalo(app, selectedVia, HALO_CLASS, HALO_OPACITY_SELECTED);
    if (selectedTrack && app._trackEdit?.track === canonicalTrack(app, selectedTrack)) {
        const node = selectedTrack.nodes.get(app._trackEdit.nodeId);
        for (const axis of ['x', 'y']) {
            const field = document.getElementById(`pcbPropTrackNode${axis.toUpperCase()}`);
            if (field && node) field.textContent = formatNumberInputValue(node[axis]);
        }
    }
    renderPcbSelectionAnchors(app);
}

/**
 * Set the currently-hovered track/via highlight. Pass `null` to clear.
 * Selected objects keep their selection halo while the rest of the hovered
 * net receives hover halos.
 */
export function setHoverHighlight(app, hit) {
    if (hit?.type === 'track') {
        const track = displayedTrack(app, canonicalTrack(app, hit.track));
        if (track !== hit.track) hit = { ...hit, track };
    }
    if (hit?.type === 'via') {
        const via = displayedVia(app, hit.via);
        if (via !== hit.via) hit = { ...hit, via };
    }
    const selectedTrack = getSelectedTrack(app);
    const selectedVia = getSelectedVia(app);
    const selectedPad = getPcbSelection(app, 'pad')[0] || null;
    const key = hit
        ? (hit.type === 'track' ? hit.track
            : hit.type === 'via' ? hit.via
            : hit.type === 'pad' ? `pad:${hit.componentId}|${hit.pinNumber}`
                : hit.type === 'standalone-pad' ? `standalone-pad:${hit.pad.id}`
                    : hit.type === 'shape' ? `shape:${hit.shape.id}`
            : null)
        : null;
    if (app._hoveredTrackOrVia === key) return;
    app._hoveredTrackOrVia = key;
    _removeHalos(app, HOVER_CLASS);
    if (!hit) {
        setBoardShapeNetHover(app, []);
        return;
    }
    if (hit.type === 'track' || hit.type === 'via'
        || hit.type === 'pad' || hit.type === 'standalone-pad' || hit.type === 'shape') {
        const seed = hit.type === 'track'
            ? { type: 'track', track: hit.track }
            : hit.type === 'via'
                ? { type: 'via', via: hit.via }
                : hit.type === 'standalone-pad'
                    ? { type: 'standalone-pad', pad: hit.pad }
                    : hit.type === 'shape'
                        ? { type: 'shape', shape: hit.shape }
                    : { type: 'pad', componentId: hit.componentId, pinNumber: hit.pinNumber };
        const net = _collectConnectedNet(app, seed);
        for (const track of net.tracks) {
            if (track !== selectedTrack) _drawTrackHalo(app, track, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        for (const via of net.vias) {
            if (via !== selectedVia) _drawViaHalo(app, via, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        for (const padKey of net.pads) {
            const [componentId, pinNumber] = padKey.split('|');
            _drawSinglePadHighlight(app, componentId, pinNumber, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        for (const pad of net.standalonePads) {
            if (pad !== selectedPad) drawStandalonePadHalo(app, pad, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        setBoardShapeNetHover(app, net.shapes);
    }
}

/** Walk the connected copper graph starting from a pad, track, or via. */
function _collectConnectedNet(app, seed) {
    const tracks = new Set();
    const vias = new Set();
    const pads = new Set();
    const standalonePads = new Set();
    const shapes = new Set();
    const viaByPos = new Map();
    for (const via of app.vias || []) viaByPos.set(_posKey(via.x, via.y), via);

    const netName = seed.type === 'track'
        ? seed.track.net || ''
        : seed.type === 'via'
            ? seed.via.net || ''
            : seed.type === 'standalone-pad'
                ? seed.pad.net || ''
                : seed.type === 'shape'
                    ? seed.shape.net || ''
                : _netForPad(app, seed.componentId, seed.pinNumber);
    if (netName) {
        for (const track of app.tracks || []) if (track.net === netName) tracks.add(track);
        for (const via of app.vias || []) if (via.net === netName) vias.add(via);
        for (const pad of app.pads || []) if (pad.net === netName) standalonePads.add(pad);
        for (const shape of app.boardShapes || []) {
            if (shape.net === netName
                && (shape.layer === 'top-copper' || shape.layer === 'bottom-copper')
                && normalizeShapeCopperMode(shape.copperMode) === 'add') shapes.add(shape);
        }
        const netEntry = (app.netlist || []).find((entry) => entry.net === netName);
        for (const pin of netEntry?.pins || []) pads.add(`${pin.componentId}|${pin.pinNumber}`);
    }

    const queue = [];
    if (seed.type === 'pad') {
        const key = `${seed.componentId}|${seed.pinNumber}`;
        pads.add(key);
        queue.push({ kind: 'pad', key });
    } else if (seed.type === 'track') {
        tracks.add(seed.track);
        queue.push({ kind: 'track', track: seed.track });
    } else if (seed.type === 'via') {
        vias.add(seed.via);
        queue.push({ kind: 'via', via: seed.via });
    } else if (seed.type === 'shape') {
        shapes.add(seed.shape);
    } else {
        standalonePads.add(seed.pad);
    }
    for (const track of tracks) queue.push({ kind: 'track', track });
    for (const via of vias) queue.push({ kind: 'via', via });
    for (const key of pads) queue.push({ kind: 'pad', key });

    while (queue.length) {
        const item = queue.shift();
        if (item.kind === 'pad') {
            const [componentId, pinNumber] = item.key.split('|');
            for (const track of app.tracks || []) {
                if (tracks.has(track)) continue;
                for (const connection of track.padConnections?.values?.() || []) {
                    if (String(connection.componentId) === componentId
                        && String(connection.pinNumber) === pinNumber) {
                        tracks.add(track);
                        queue.push({ kind: 'track', track });
                        break;
                    }
                }
            }
        } else if (item.kind === 'track') {
            for (const connection of item.track.padConnections?.values?.() || []) {
                const key = `${connection.componentId}|${connection.pinNumber}`;
                if (!pads.has(key)) { pads.add(key); queue.push({ kind: 'pad', key }); }
            }
            for (const node of item.track.nodes.values()) {
                const key = _posKey(node.x, node.y);
                const via = viaByPos.get(key);
                if (via && !vias.has(via)) { vias.add(via); queue.push({ kind: 'via', via }); }
                for (const otherTrack of app.tracks || []) {
                    if (otherTrack === item.track || tracks.has(otherTrack)) continue;
                    if ([...otherTrack.nodes.values()].some((otherNode) => _posKey(otherNode.x, otherNode.y) === key)) {
                        tracks.add(otherTrack);
                        queue.push({ kind: 'track', track: otherTrack });
                    }
                }
            }
        } else if (item.kind === 'via') {
            const key = _posKey(item.via.x, item.via.y);
            for (const track of app.tracks || []) {
                if (tracks.has(track)) continue;
                if ([...track.nodes.values()].some((node) => _posKey(node.x, node.y) === key)) {
                    tracks.add(track);
                    queue.push({ kind: 'track', track });
                }
            }
        }
    }
    return { tracks, vias, pads, standalonePads, shapes };
}

function _posKey(x, y) {
    // 0.01 mm bucket — matches the autorouter-adapter's pad lookup.
    return `${Math.round(x * 100)},${Math.round(y * 100)}`;
}

/** Look up the net name a pad belongs to, or '' if unknown. */
function _netForPad(app, componentId, pinNumber) {
    for (const entry of app.netlist || []) {
        for (const pin of entry.pins || []) {
            if (String(pin.componentId) === String(componentId)
                && String(pin.pinNumber) === String(pinNumber)) {
                return entry.net || '';
            }
        }
    }
    return '';
}

/**
 * Draw a translucent overlay over a single pad (used for pad-hover).
 * Extracted from _drawPadHighlights so we can target one pad without
 * a Track context.
 */
function _drawSinglePadHighlight(app, componentId, pinNumber, cls, opacity) {
    const pl = app.placements?.get(componentId);
    if (!pl) return;
    const off = pl.padOffsets?.find((p) => String(p.number) === String(pinNumber));
    const padId = off?.padId ?? pinNumber;
    const pos = pl.pads?.get(padId)
        || [...(pl.pads?.entries?.() || [])].find(([id]) => String(id) === String(padId))?.[1];
    if (!pos) return;
    const layers = off?.layer === 'bottom-copper'
        ? ['bottom-copper']
        : off?.layer === 'both'
            ? ['top-copper', 'bottom-copper']
            : ['top-copper'];
    const w = off?.width || 1.2;
    const h = off?.height || 1.2;
    const shape = off?.shape || 'rect';
    // The pad's rendered group is rotated by the placement angle (and mirrored
    // for flips / bottom side). `pos` is the already-transformed world centre,
    // but a rect/oval drawn axis-aligned would point the wrong way under
    // rotation — rotate the highlight about its centre to match. A symmetric
    // shape's mirror is visually identical to a rotation, so the angle alone
    // (sign irrelevant for the centred box) keeps it aligned with the pad.
    const rot = pl.rotation || 0;
    const rotAttr = rot ? `rotate(${rot} ${pos.x} ${pos.y})` : '';
    for (const layerId of layers) {
        const parent = app.getLayerGroup(layerId);
        if (!parent) continue;
        let el;
        if (shape === 'ellipse') {
            el = document.createElementNS(NS, 'circle');
            el.setAttribute('cx', String(pos.x));
            el.setAttribute('cy', String(pos.y));
            el.setAttribute('r', String(Math.max(w, h) / 2));
        } else {
            el = document.createElementNS(NS, 'rect');
            el.setAttribute('x', String(pos.x - w / 2));
            el.setAttribute('y', String(pos.y - h / 2));
            el.setAttribute('width', String(w));
            el.setAttribute('height', String(h));
            if (shape === 'oval') {
                const r = Math.min(w, h) / 2;
                el.setAttribute('rx', String(r));
                el.setAttribute('ry', String(r));
            }
            if (rotAttr) el.setAttribute('transform', rotAttr);
        }
        el.setAttribute('class', cls);
        el.setAttribute('fill', HALO_COLOR);
        el.setAttribute('fill-opacity', String(opacity));
        el.setAttribute('stroke', 'none');
        el.setAttribute('pointer-events', 'none');
        parent.appendChild(el);
    }
}

function _removeHalos(app, cls) {
    const groups = app.existingLayerGroups?.();
    if (!groups) return;
    for (const g of groups.values()) {
        g.querySelectorAll(`.${cls}`).forEach((el) => el.remove());
    }
}

/* ── Public halo helpers (used by box-select multi-selection) ── */

/** Draw a selection halo over a track using the given CSS class. */
export function drawTrackHalo(app, track, cls, opacity = HALO_OPACITY_SELECTED) {
    _drawTrackHalo(app, track, cls, opacity);
}

/** Draw a selection halo over a via using the given CSS class. */
export function drawViaHalo(app, via, cls, opacity = HALO_OPACITY_SELECTED) {
    _drawViaHalo(app, via, cls, opacity);
}

export function drawStandalonePadHalo(app, pad, cls, opacity = HALO_OPACITY_SELECTED) {
    const parent = app.getLayerGroup?.('selection-overlay');
    if (!parent) return;
    const points = padOutline({ ...pad, x: 0, y: 0 });
    const polygon = document.createElementNS(NS, 'polygon');
    polygon.setAttribute('class', cls);
    polygon.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
    polygon.setAttribute('transform', `translate(${pad.x},${pad.y})`);
    polygon.setAttribute('fill', HALO_COLOR);
    polygon.setAttribute('fill-opacity', String(opacity));
    polygon.setAttribute('stroke', 'none');
    polygon.setAttribute('pointer-events', 'none');
    polygon.dataset.padId = pad.id;
    parent.appendChild(polygon);
}

/** Remove every halo with the given CSS class from all layers. */
export function removeHalosByClass(app, cls) {
    _removeHalos(app, cls);
}

/**
 * Delete the currently selected track or via, then reconcile ratlines
 * and update the properties panel.
 */
export function deleteSelectedTrack(app) {
    getPropertyEditor(app, 'track')?.cancel();
    // A single highlighted segment deletes just that edge (the rest of the
    // track survives as its remaining connected pieces). The focused edge is
    // explicit edit state, so verify its Track is still registry-selected.
    const selectedTrack = getSelectedTrack(app);
    if (app._trackEdit && selectedTrack === app._trackEdit.track) {
        const { track, edgeId, nodeId } = app._trackEdit;
        if (nodeId != null) {
            if (app._vertexDrag) {
                app._pcbSelectionInteraction = null;
                cancelVertexDrag(app);
            }
            if (track.nodes.has(nodeId)) deleteTrackNode(app, track, nodeId);
            app._trackEdit = null;
            if (app.tracks.includes(track)) showTrackSelectionProperties(app, track);
            else clearTrackSelection(app);
            app.setPcbStatus?.();
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
 * @param {object} app
 * @param {{type:'track', track:object}|{type:'via', via:object}} hit
 * @param {number} clientX
 * @param {number} clientY
 * @param {{x:number,y:number}} [worldPos] - cursor position, used to
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
                const adapter = createTrackSelectionAdapter(app, track, track.id);
                const anchor = adapter.getAnchors().find(item => item.id === `bulge:${edgeId}`);
                if (anchor) beginPcbAnchorInteraction(app, adapter, anchor, anchor, true);
            }
        },
        deleteObject: () => { clearTrackSelection(app); app.history.execute(new RemoveTrackCommand(app, track)); },
        label: 'track',
    });
    return showPathContextMenu('pcbTrackContextMenu', items, clientX, clientY, () => refreshTrackSelectionHalo(app));
}

/* ──────────────────────────── halos ──────────────────────────── */

function _drawTrackHalo(app, track, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    if (!trackIsVisible(track)) return;
    if (getPcbSelection(app).length === 1 && app._trackEdit?.track === canonicalTrack(app, track)
        && track.nodes.has(app._trackEdit.nodeId)) return;
    // Lay a translucent white overlay along each layer-run, at the same
    // width as the track itself, so it brightens the copper in place
    // instead of producing an outer glow that lags behind moves.
    const runs = buildTrackLayerRuns(track);
    for (const run of runs) {
        if (!isLayerVisible(run.layer)) continue;
        const parent = app.getLayerGroup(cls === HOVER_CLASS ? run.layer : 'selection-overlay');
        if (!parent) continue;
        const poly = document.createElementNS(NS, 'polyline');
        poly.setAttribute('class', cls);
        poly.setAttribute('points', run.points.map((p) => `${p.x},${p.y}`).join(' '));
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', HALO_COLOR);
        poly.setAttribute('stroke-width', String(run.width));
        poly.setAttribute('stroke-linecap', 'round');
        poly.setAttribute('stroke-linejoin', 'round');
        poly.setAttribute('stroke-opacity', String(opacity));
        poly.setAttribute('pointer-events', 'none');
        parent.appendChild(poly);
    }
    _drawPadHighlights(app, track, cls, opacity);
    // Draw draggable node handles only for the SELECTION halo (not hover),
    // so the user can see the vertices they can grab.
}

/**
 * Draw the selection halo for a single track edge (segment selection).
 * Overlays just that one edge plus handles at its two endpoints.
 */
function _drawSegmentHalo(app, track, edgeId, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    const e = track.edges?.get(edgeId);
    if (!e) return;
    const a = track.nodes.get(e.from);
    const b = track.nodes.get(e.to);
    if (!a || !b) return;
    const layerId = track.getEdgeLayer(edgeId) || 'top-copper';
    if (track.visible === false || !isLayerVisible(layerId)) return;
    const parent = app.getLayerGroup(cls === HOVER_CLASS ? layerId : 'selection-overlay');
    if (parent) {
        const line = document.createElementNS(NS, 'polyline');
        line.setAttribute('class', cls);
        line.setAttribute('points', resolveTrackEdgePaths(track).get(edgeId).map(point => `${point.x},${point.y}`).join(' '));
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke-linejoin', 'round');
        line.setAttribute('stroke', HALO_COLOR);
        line.setAttribute('stroke-width', String(track.getEdgeWidth(edgeId) || 0.2));
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('stroke-opacity', String(opacity));
        line.setAttribute('pointer-events', 'none');
        parent.appendChild(line);
    }
    _drawPadHighlights(app, track, cls, opacity);
}

/**
 * Highlight every pad the track is connected to with the same
 * translucent-white overlay, so the user can see which component pins
 * the track lands on.
 */
function _drawPadHighlights(app, track, cls, opacity) {
    if (!track.padConnections?.size || !app.placements) return;
    for (const conn of track.padConnections.values()) {
        const pl = app.placements.get(conn.componentId);
        if (!pl) continue;
        const off = pl.padOffsets?.find((p) => p.number === conn.pinNumber);
        const pos = pl.pads?.get(conn.pinNumber);
        if (!pos) continue;
        // Render on whichever copper layer(s) the pad lives on; default
        // to top if the layer info is missing.
        const layers = off?.layer === 'bottom-copper'
            ? ['bottom-copper']
            : off?.layer === 'both'
                ? ['top-copper', 'bottom-copper']
                : ['top-copper'];
        const w = off?.width || 1.2;
        const h = off?.height || 1.2;
        const shape = off?.shape || 'rect';
        for (const layerId of layers) {
            const parent = app.getLayerGroup(layerId);
            if (!parent) continue;
            let el;
            if (shape === 'ellipse') {
                el = document.createElementNS(NS, 'circle');
                el.setAttribute('cx', String(pos.x));
                el.setAttribute('cy', String(pos.y));
                el.setAttribute('r', String(Math.max(w, h) / 2));
            } else {
                el = document.createElementNS(NS, 'rect');
                el.setAttribute('x', String(pos.x - w / 2));
                el.setAttribute('y', String(pos.y - h / 2));
                el.setAttribute('width', String(w));
                el.setAttribute('height', String(h));
                if (shape === 'oval') {
                    const r = Math.min(w, h) / 2;
                    el.setAttribute('rx', String(r));
                    el.setAttribute('ry', String(r));
                }
            }
            el.setAttribute('class', cls);
            el.setAttribute('fill', HALO_COLOR);
            el.setAttribute('fill-opacity', String(opacity));
            el.setAttribute('stroke', 'none');
            el.setAttribute('pointer-events', 'none');
            parent.appendChild(el);
        }
    }
}

function _drawViaHalo(app, via, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    const layer = app.getLayerGroup('vias');
    if (!layer) return;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', String(via.x));
    c.setAttribute('cy', String(via.y));
    c.setAttribute('r', String(via.diameter / 2));
    c.setAttribute('fill', HALO_COLOR);
    c.setAttribute('fill-opacity', String(opacity));
    c.setAttribute('stroke', 'none');
    c.setAttribute('pointer-events', 'none');
    layer.appendChild(c);
}

/**
 * Draw a hole highlight with an inscribed "X" cross so the drilled centre is
 * unmistakable. The visual state is derived from `cls`:
 *   - hover  → just the X (the bore stays open)
 *   - select → the X plus a filled disc
 */
function _drawHoleHalo(app, hole, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    const layer = app.getLayerGroup('hole');
    if (!layer) return;
    const dia = hole.diameter || 0.8;
    const r = dia / 2;
    const selected = cls !== HOVER_CLASS;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', cls);
    g.setAttribute('pointer-events', 'none');

    if (selected) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', String(hole.x));
        c.setAttribute('cy', String(hole.y));
        c.setAttribute('r', String(r));
        c.setAttribute('fill', HALO_COLOR);
        c.setAttribute('fill-opacity', String(opacity));
        c.setAttribute('stroke', 'none');
        g.appendChild(c);
    }

    // Inscribed X: arms reach the disc edge (45° offsets).
    const d = r * Math.SQRT1_2;
    const sw = Math.max(0.03, dia * 0.07);
    const arms = [
        [hole.x - d, hole.y - d, hole.x + d, hole.y + d],
        [hole.x - d, hole.y + d, hole.x + d, hole.y - d],
    ];
    for (const [x1, y1, x2, y2] of arms) {
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('x1', String(x1));
        ln.setAttribute('y1', String(y1));
        ln.setAttribute('x2', String(x2));
        ln.setAttribute('y2', String(y2));
        ln.setAttribute('stroke', HALO_COLOR);
        ln.setAttribute('stroke-width', String(sw));
        ln.setAttribute('stroke-linecap', 'round');
        g.appendChild(ln);
    }
    layer.appendChild(g);
}

/* ──────────────────────────── properties panel ──────────────────────────── */

function trackCornerRadiusProperty(track, nodeId = null) {
    const radius = nodeId == null ? track.cornerRadius : track.nodeCornerRadius(nodeId);
    return `<div class="prop-row" data-prop="cornerRadius"><label>Corner Radius (mm)</label><input type="number" id="pcbPropTrackCornerRadius" min="0" step="0.5" value="${formatNumberInputValue(radius)}"></div>`;
}

function createTrackPropertyBinding(app, track, scope = {}) {
    getPropertyEditor(app, 'track')?.dispose();
    let preview = null;
    let field = null;
    let disposed = false;
    const fields = [];
    const layers = () => [...track.edges].filter(([id, edge]) => scope.edgeId != null
        ? id === scope.edgeId : scope.nodeId == null || edge.from === scope.nodeId || edge.to === scope.nodeId)
        .map(([id]) => track.getEdgeLayer(id));
    const editable = () => !disposed && isEditorActive(app)
        && layers().every(layer => isLayerVisible(layer) && !isLayerLocked(layer));
    const resetFields = () => {
        for (const { input, spec } of fields) {
            const value = spec.read(track);
            input.value = Number.isFinite(value) ? String(value) : '';
        }
    };
    // A node picked up from a midpoint "+" (or any unfinished drag) shows a preview
    // copy of this track on the board. Panel edits change the real track, so drop
    // the pickup first or the edit would miss (discrete fields) or fail (numeric fields).
    const dropPointerPreview = () => {
        if (app._vertexDrag?.original !== track) return;
        app._pcbSelectionInteraction = null;
        cancelVertexDrag(app);
        renderPcbSelectionAnchors(app);
    };
    const finish = commit => {
        if (!preview) return;
        commit = commit && Number.isFinite(field.spec.parse(field.input));
        const refreshFills = field.spec.fills;
        preview = null;
        field = null;
        let committed = false;
        try {
            finishTrackPropertyPreview(app, commit ? (before, after) => {
                app.history.execute(new ModifyTrackGraphCommand(app, track, before, after));
                committed = true;
            } : null);
        } finally {
            if (!committed) resetFields();
            refreshTrackSelectionHalo(app);
            if (!committed) {
                app.refreshClearanceHalos?.();
                if (refreshFills) app.refreshFills?.();
            }
        }
    };
    const binding = {
        track,
        get active() { return !!preview; },
        affectsLayer(layerId) { return layers().includes(layerId); },
        commit() { finish(editable()); },
        cancel() { finish(false); },
        dispose() {
            if (disposed) return;
            disposed = true;
            finish(false);
            releasePropertyEditor(app, 'track', binding);
        },
        prepare() {
            if (disposed) return false;
            dropPointerPreview();
            binding.commit();
            return true;
        },
        bind(id, spec) {
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
            if (!input) return;
            const entry = { input, spec };
            fields.push(entry);
            const update = () => {
                if (!editable()) { binding.cancel(); return; }
                dropPointerPreview();
                if (field && field !== entry) {
                    const text = input.value;
                    binding.commit();
                    input.value = text;
                }
                const value = spec.parse(input);
                if (!Number.isFinite(value)) return;
                const current = preview?.track || track;
                if (!spec.changed(current, value)) return;
                preview ||= beginTrackPropertyPreview(app, track, scope);
                field = entry;
                spec.apply(preview.track, value, preview.before);
                renderTrack(preview.track, layerId => app.getLayerGroup(layerId), { hideNetLabel: true });
                refreshTrackSelectionHalo(app);
                app.refreshClearanceHalos?.();
                if (spec.fills) app.refreshFills?.();
            };
            const commit = event => {
                if (disposed) return;
                if (event.type === 'change') update();
                const changed = !!preview;
                binding.commit();
                if (!Number.isFinite(spec.parse(input))) {
                    const value = spec.read(track);
                    input.value = Number.isFinite(value) ? String(value) : '';
                }
                if (changed && spec.rebuild) showTrackSelectionProperties(app, track);
            };
            input.addEventListener('input', update);
            input.addEventListener('change', commit);
            input.addEventListener('blur', () => {
                queueMicrotask(() => {
                    if (!disposed && field === entry) commit({ type: 'blur' });
                });
            });
            input.addEventListener('keydown', event => {
                if (disposed || event.key !== 'Escape') return;
                binding.cancel();
                event.preventDefault();
                event.stopPropagation();
            });
        },
    };
    setPropertyEditor(app, 'track', binding);
    return binding;
}

function bindTrackCornerRadius(binding, nodeId = null) {
    binding.bind('pcbPropTrackCornerRadius', {
        read: track => nodeId == null ? track.cornerRadius : track.nodeCornerRadius(nodeId),
        parse: input => Number.isFinite(input.valueAsNumber) ? Math.max(0, input.valueAsNumber) : NaN,
        changed: (track, radius) => Math.abs((nodeId == null ? track.cornerRadius : track.nodeCornerRadius(nodeId)) - radius) >= 1e-9
            || (nodeId == null && Object.keys(track.nodeCornerRadii || {}).length > 0),
        apply: (track, radius, before) => {
            if (nodeId == null) {
                track.cornerRadius = radius;
                track.nodeCornerRadii = {};
                track.invalidate();
            } else if (radius === (before.nodeCornerRadii[nodeId] ?? before.cornerRadius)) {
                if (Object.hasOwn(before.nodeCornerRadii, nodeId)) track.nodeCornerRadii[nodeId] = before.nodeCornerRadii[nodeId];
                else delete track.nodeCornerRadii[nodeId];
                track.invalidate();
            } else track.setNodeCornerRadius(nodeId, radius);
        },
        fills: true,
    });
}

function bindTrackWidth(binding, edgeId = null) {
    binding.bind('pcbPropTrackWidth', {
        read: track => edgeId == null ? track.width : track.getEdgeWidth(edgeId),
        parse: input => {
            const value = input.value.trim() === '' ? NaN : Number(input.value);
            return value > 0 ? value : NaN;
        },
        changed: (track, width) => edgeId == null
            ? track.width !== width || [...track.edges.keys()].some(id => track.getEdgeWidth(id) !== width)
            : track.getEdgeWidth(edgeId) !== width,
        apply: (track, width, before) => {
            const setWidth = id => {
                const edge = track.edges.get(id), original = before.edges[id];
                if (width === (original.width ?? before.width)) {
                    if (Object.hasOwn(original, 'width')) edge.width = original.width;
                    else delete edge.width;
                    track.invalidate();
                } else track.setEdgeAttr(id, 'width', width);
            };
            if (edgeId == null) {
                track.width = width;
                for (const id of track.edges.keys()) setWidth(id);
            } else setWidth(edgeId);
        },
    });
}

function _showTrackNodeProperties(app, track, nodeId) {
    const node = track.nodes.get(nodeId);
    const items = app.propertiesItems?.() || document.getElementById('pcbPropsItems');
    if (!items || !node) return;
    app.setPropertiesTitle?.('Track Node');
    items.innerHTML = `
        <div class="prop-row" data-prop="x"><label>X (mm)</label><span id="pcbPropTrackNodeX">${formatNumberInputValue(node.x)}</span></div>
        <div class="prop-row" data-prop="y"><label>Y (mm)</label><span id="pcbPropTrackNodeY">${formatNumberInputValue(node.y)}</span></div>
        ${trackCornerRadiusProperty(track, nodeId)}
    `;
    const binding = createTrackPropertyBinding(app, track, { nodeId });
    bindTrackCornerRadius(binding, nodeId);
    app.showPropertiesTab?.();
}

function _showTrackProperties(app, track) {
    const items = app.propertiesItems?.() || document.getElementById('pcbPropsItems');
    if (!items) return;
    app.setPropertiesTitle?.('Track');
    const layers = new Set();
    for (const eid of track.edges.keys()) layers.add(track.getEdgeLayer(eid));
    const mixed = layers.size > 1;
    const currentLayer = mixed ? '' : (layers.values().next().value || track.layer || 'top-copper');
    // Non-copper layers turn the track back into a board shape, which needs one line or loop.
    const movable = canMoveTrackToBoardLayer(track);
    const unmovableReason = mixed
        ? 'This track uses both copper layers. Only a track that is a single line or loop on one layer can move to a non-copper layer.'
        : 'This track branches. Only a track that is a single line or loop can move to a non-copper layer.';
    const layerOpts = PCB_LAYERS.filter((l) => !PROP_HIDDEN_LAYERS.has(l.id)).map((l) => {
        if (COPPER_LAYERS.includes(l)) {
            return `<option value="${l.id}"${l.id === currentLayer ? ' selected' : ''}>${_escape(l.name)}</option>`;
        }
        return movable
            ? pcbLayerOptionHtml(l.id, l.name)
            : `<option value="${l.id}" disabled title="${_escape(unmovableReason)}">${_escape(l.name)}</option>`;
    }).join('');
    // Removal modes add no copper, so they also turn the track back into a board shape.
    const unmovableModeReason = mixed
        ? 'This track uses both copper layers. Only a track that is a single line or loop on one layer can use a removal mode.'
        : 'This track branches. Only a track that is a single line or loop can use a removal mode.';
    const copperModeOpts = '<option value="add" selected>Add Copper</option>' + [
        ['remove-copper', 'Remove Copper'], ['remove-solder-mask', 'Remove Solder Mask'], ['remove-copper-mask', 'Remove Copper + Mask'],
    ].map(([value, label]) => `<option value="${value}"${movable ? '' : ` disabled title="${_escape(unmovableModeReason)}"`}>${label}</option>`).join('');
    const mixedOpt = mixed ? `<option value="" selected>Multiple</option>` : '';
    const netOptions = _netOptions(app, track.net || '');
    items.innerHTML = `
        <div class="prop-row" data-prop="layer"><label>Layer</label><select id="pcbPropTrackLayer">${mixedOpt}${layerOpts}</select></div>
        <div class="prop-row" data-prop="copperMode"><label>Copper Mode</label><select id="pcbPropTrackCopperMode">${copperModeOpts}</select></div>
        <div class="prop-row" data-prop="net"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropTrackNet" value="${_escape(track.net || '')}" placeholder="None"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${netOptions}</div></details></span></div>
        ${canFillTrackLoop(track) ? '<label class="prop-row prop-toggle" data-prop="fill"><input type="checkbox" id="pcbPropTrackFill"><span>Fill</span></label>' : ''}
        <div class="prop-row" data-prop="lineWidth"><label>Width (mm)</label><input type="number" id="pcbPropTrackWidth" value="${formatNumberInputValue(track.width)}" min="0.05" step="0.05"></div>
        ${trackCornerRadiusProperty(track)}
    `;
    const binding = createTrackPropertyBinding(app, track);
    bindTrackCornerRadius(binding);
    bindTrackWidth(binding);
    const fillEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackFill'));
    fillEl?.addEventListener('change', () => {
        // A filled loop is a copper area, which a Track cannot represent.
        if (!fillEl.checked || !binding.prepare()) return;
        clearTrackSelection(app);
        if (!fillTrackLoop(app, track)) fillEl.checked = false;
    });
    const baseline = { net: track.net || '' };
    const netEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackNet'));
    const netMenuEl = /** @type {HTMLDetailsElement|null} */ (document.querySelector('.prop-net-menu'));
    const netSeedEdgeId = hitTestTrackEdge(app, track, app._lastPointerWorld || {})?.edgeId
        || track.edges.keys().next().value;
    netEl?.addEventListener('change', () => {
        if (!binding.prepare()) return;
        const v = netEl.value.trim();
        if (v === baseline.net) return;
        if (_applyNetToBondedCopper(app, { track, edgeId: netSeedEdgeId }, v)) {
            baseline.net = v;
        } else {
            netEl.value = baseline.net; // refused — restore the field
        }
    });
    netEl?.addEventListener('input', () => {
        // The properties panel can be rebuilt before a blur emits `change`,
        // so commit clearing the Net immediately.
        if (!netEl.value.trim() && baseline.net) netEl.dispatchEvent(new Event('change'));
    });
    netMenuEl?.addEventListener('click', (event) => {
        const option = /** @type {HTMLButtonElement|null} */ (event.target instanceof Element ? event.target.closest('button[data-net]') : null);
        if (!option) return;
        netEl.value = option.dataset.net || '';
        netEl.dispatchEvent(new Event('change'));
        netMenuEl.open = false;
    });
    netMenuEl?.addEventListener('toggle', () => {
        if (!netMenuEl.open || !netEl) return;
        const current = netEl.value.trim();
        for (const option of /** @type {NodeListOf<HTMLElement>} */ (netMenuEl.querySelectorAll('button[data-net]'))) {
            option.toggleAttribute('aria-current', option.dataset.net === current);
        }
    });
    const layerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropTrackLayer'));
    const copperModeEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropTrackCopperMode'));
    copperModeEl?.addEventListener('change', () => {
        if (!binding.prepare()) return;
        const mode = copperModeEl.value;
        const layer = track.getEdgeLayer(track.edges.keys().next().value) || track.layer;
        if (mode === 'add' || isLayerLocked(layer) || !canMoveTrackToBoardLayer(track)) {
            copperModeEl.value = 'add';
            return;
        }
        clearTrackSelection(app);
        setTrackCopperMode(app, track, mode);
        reconcileRatsnest(app);
        app.showPropertiesTab?.();
    });
    layerEl?.addEventListener('change', () => {
        if (!binding.prepare()) return;
        const v = layerEl.value;
        if (!v) return; // the "Multiple" placeholder
        if (!COPPER_LAYERS.some((l) => l.id === v)) {
            if (isLayerLocked(v) || !canMoveTrackToBoardLayer(track)) {
                layerEl.value = currentLayer;
                return;
            }
            clearTrackSelection(app);
            moveTrackToBoardLayer(app, track, v);
            reconcileRatsnest(app);
            app.showPropertiesTab?.();
            return;
        }
        const before = track.captureState();
        // Move every edge of this track onto the chosen layer, then
        // re-normalise the whole bonded copper region into the canonical
        // via/node model. This mirrors the segment-layer handler: moving a
        // track onto a different layer than its neighbours inserts boundary
        // vias; moving it BACK onto a neighbour's layer fuses the tracks and
        // removes the now-superfluous vias.
        track.layer = v;
        for (const eid of track.edges.keys()) track.setEdgeAttr(eid, 'layer', v);
        const region = reconcileCopperRegion(app, track);
        // Restore the seed so its RemoveTrackCommand captures clean undo.
        track.applyState(before);
        // Drop the selection FIRST, while the original tracks are still
        // present and rendered (see the segment handler for why).
        clearTrackSelection(app);
        const cmds = [];
        for (const t of region.removeTracks) cmds.push(new RemoveTrackCommand(app, t));
        for (const vv of region.removeVias) cmds.push(new RemoveViaCommand(app, vv));
        for (const t of region.addTracks) cmds.push(new AddTrackCommand(app, t));
        for (const vv of region.addVias) cmds.push(new AddViaCommand(app, vv));
        if (cmds.length) app.history?.execute(new CompoundCommand(cmds));
        reconcileRatsnest(app);
        app.showPropertiesTab?.();
    });
    app.showPropertiesTab?.();
}

/**
 * Properties panel for a single selected track segment (one edge). The
 * Net is track-wide; the Layer and Width retarget only this edge so a
 * single segment can hop layers and change width independently.
 */
function _showTrackSegmentProperties(app, track, edgeId) {
    const items = app.propertiesItems?.() || document.getElementById('pcbPropsItems');
    if (!items) return;
    app.setPropertiesTitle?.(track.edges.get(edgeId)?.bulge ? 'Arc Segment' : 'Track Segment');
    const currentLayer = track.getEdgeLayer(edgeId) || 'top-copper';
    const segWidth = track.getEdgeWidth(edgeId);
    const layerOpts = COPPER_LAYERS.map(
        (l) => `<option value="${l.id}"${l.id === currentLayer ? ' selected' : ''}>${_escape(l.name)}</option>`
    ).join('');
    const netOptions = _netOptions(app, track.net || '');
    items.innerHTML = `
        <div class="prop-row" data-prop="layer"><label>Layer</label><select id="pcbPropSegLayer">${layerOpts}</select></div>
        <div class="prop-row" data-prop="net"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropTrackNet" value="${_escape(track.net || '')}" placeholder="None"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${netOptions}</div></details></span></div>
        <div class="prop-row" data-prop="lineWidth"><label>Width (mm)</label><input type="number" id="pcbPropTrackWidth" value="${formatNumberInputValue(segWidth)}" min="0.05" step="0.05"></div>
        ${track.edges.get(edgeId)?.bulge ? `<div class="prop-row" data-prop="bulge"><label>Bulge</label><input type="number" id="pcbPropTrackBulge" min="-1" max="1" step="0.05" value="${formatNumberInputValue(track.edges.get(edgeId).bulge)}"></div>` : ''}
    `;
    const binding = createTrackPropertyBinding(app, track, { edgeId });
    bindTrackWidth(binding, edgeId);
    binding.bind('pcbPropTrackBulge', {
        read: track => track.edges.get(edgeId)?.bulge || 0,
        parse: input => Number.isFinite(input.valueAsNumber)
            ? Number(formatNumberInputValue(Math.max(-1, Math.min(1, input.valueAsNumber)))) : NaN,
        changed: (track, bulge) => (track.edges.get(edgeId)?.bulge || 0) !== bulge,
        apply: (track, bulge) => track.setEdgeAttr(edgeId, 'bulge', bulge),
        fills: true, rebuild: true,
    });
    const baseline = { net: track.net || '' };
    const netEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackNet'));
    const netMenuEl = /** @type {HTMLDetailsElement|null} */ (document.querySelector('.prop-net-menu'));
    netEl?.addEventListener('change', () => {
        if (!binding.prepare()) return;
        const v = netEl.value.trim();
        if (v === baseline.net) return;
        if (_applyNetToBondedCopper(app, { track, edgeId }, v)) {
            baseline.net = v;
        } else {
            netEl.value = baseline.net;
        }
    });
    netEl?.addEventListener('input', () => {
        if (!netEl.value.trim() && baseline.net) netEl.dispatchEvent(new Event('change'));
    });
    netMenuEl?.addEventListener('click', (event) => {
        const option = /** @type {HTMLButtonElement|null} */ (event.target instanceof Element ? event.target.closest('button[data-net]') : null);
        if (!option) return;
        netEl.value = option.dataset.net || '';
        netEl.dispatchEvent(new Event('change'));
        netMenuEl.open = false;
    });
    netMenuEl?.addEventListener('toggle', () => {
        if (!netMenuEl.open || !netEl) return;
        const current = netEl.value.trim();
        for (const option of /** @type {NodeListOf<HTMLElement>} */ (netMenuEl.querySelectorAll('button[data-net]'))) {
            option.toggleAttribute('aria-current', option.dataset.net === current);
        }
    });
    const layerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropSegLayer'));
    layerEl?.addEventListener('change', () => {
        if (!binding.prepare()) return;
        const v = layerEl.value;
        if (!v) return;
        const before = track.captureState();
        track.setEdgeAttr(edgeId, 'layer', v);
        // Re-normalise the whole bonded copper region into the canonical
        // via/node model. This handles BOTH directions: a layer JUMP splits
        // the track and adds boundary vias; moving a segment BACK onto a
        // neighbour's layer fuses the tracks again and removes the now
        // superfluous via.
        const region = reconcileCopperRegion(app, track);
        // Restore the seed so its RemoveTrackCommand captures clean undo.
        track.applyState(before);
        // Drop the selection FIRST, while the original tracks are still
        // present and rendered. clearTrackSelection re-renders a selected
        // track whose labels can't be restored — and once RemoveTrackCommand
        // has stripped the original's SVG elements that re-render would
        // resurrect it as an orphan (a stale polyline). Clearing here avoids
        // that.
        clearTrackSelection(app);
        const cmds = [];
        for (const t of region.removeTracks) cmds.push(new RemoveTrackCommand(app, t));
        for (const vv of region.removeVias) cmds.push(new RemoveViaCommand(app, vv));
        for (const t of region.addTracks) cmds.push(new AddTrackCommand(app, t));
        for (const vv of region.addVias) cmds.push(new AddViaCommand(app, vv));
        if (cmds.length) app.history?.execute(new CompoundCommand(cmds));
        reconcileRatsnest(app);
        app.showPropertiesTab?.();
    });
    app.showPropertiesTab?.();
}

/**
 * Set net `v` on every track + via physically bonded to the seed copper
 * (one undoable compound command). Refuses with a dialog if the bonded
 * region touches a pad whose schematic-assigned net differs from `v`
 * (the schematic is authoritative — rename it there instead).
 *
 * @returns {boolean} true if applied (or a no-op), false if refused.
 */
export function _applyNetToBondedCopper(app, seed, v) {
    let replacement = null;
    let group;
    const components = seed.track?.connectedComponents?.() || [];
    if (seed.edgeId && components.length > 1) {
        const edge = seed.track.edges.get(seed.edgeId);
        const selectedNodes = edge
            ? components.find(nodes => nodes.has(edge.from) && nodes.has(edge.to))
            : null;
        if (selectedNodes) {
            const parts = components.map(nodes => seed.track.extractSubgraph(nodes));
            const selectedIndex = components.indexOf(selectedNodes);
            const selectedTrack = parts[selectedIndex];
            const tracks = (app.tracks || []).filter(track => track !== seed.track);
            tracks.push(...parts);
            group = collectBondedCopper({ ...app, tracks, vias: app.vias, pads: app.pads,
                boardShapes: app.boardShapes }, { track: selectedTrack });
            replacement = { original: seed.track, parts, selectedTrack };
        }
    }
    group ||= collectBondedCopper(app, seed);
    // Authoritative pad-net guard: if the bonded copper reaches a pad, that
    // pad's schematic net is the truth; renaming the copper to something
    // else would contradict it.
    const padNets = [...group.padNets].filter(Boolean);
    const conflict = padNets.find((pn) => pn !== v);
    if (conflict !== undefined) {
        showAlert(
            `This copper is connected to a pad on net "${conflict}" (assigned by the schematic). ` +
            `Rename the net in the schematic instead of editing the track.`,
            { title: 'Net Assigned by Schematic' }
        );
        return false;
    }
    const cmds = [];
    if (replacement) {
        replacement.selectedTrack.net = v;
        cmds.push(new RemoveTrackCommand(app, replacement.original));
        for (const part of replacement.parts) cmds.push(new AddTrackCommand(app, part));
    }
    for (const t of group.tracks) {
        if (t === replacement?.selectedTrack) continue;
        if ((t.net || '') !== v) cmds.push(new ModifyTrackCommand(app, t, { net: t.net || '' }, { net: v }));
    }
    for (const vi of group.vias) {
        if ((vi.net || '') !== v) cmds.push(new ModifyViaCommand(app, vi, { net: vi.net || '' }, { net: v }));
    }
    if (cmds.length) {
        if (replacement) clearTrackSelection(app);
        app.history?.execute(cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds));
    }
    return true;
}

/** Apply a net to all selected vias and the copper bonded to each of them. */
function _applyNetToSelectedVias(app, vias, v) {
    const tracks = new Set();
    const bondedVias = new Set();
    const padNets = new Set();
    for (const via of vias) {
        const group = collectBondedCopper(app, { via });
        for (const track of group.tracks) tracks.add(track);
        for (const bondedVia of group.vias) bondedVias.add(bondedVia);
        for (const padNet of group.padNets) if (padNet) padNets.add(padNet);
    }
    const conflict = [...padNets].find((padNet) => padNet !== v);
    if (conflict !== undefined) {
        showAlert(
            `This copper is connected to a pad on net "${conflict}" (assigned by the schematic). ` +
            `Rename the net in the schematic instead of editing the via.`,
            { title: 'Net Assigned by Schematic' },
        );
        return false;
    }
    const commands = [];
    for (const track of tracks) {
        if ((track.net || '') !== v) {
            commands.push(new ModifyTrackCommand(app, track, { net: track.net || '' }, { net: v }));
        }
    }
    const viaChanges = [...bondedVias]
        .filter((bondedVia) => (bondedVia.net || '') !== v)
        .map((bondedVia) => ({
            via: bondedVia,
            before: { net: bondedVia.net || '' },
            after: { net: v },
        }));
    if (viaChanges.length === 1) {
        const change = viaChanges[0];
        commands.push(new ModifyViaCommand(app, change.via, change.before, change.after));
    } else if (viaChanges.length > 1) {
        commands.push(new ModifyViasCommand(app, viaChanges));
    }
    if (commands.length) {
        app.history?.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
    }
    return true;
}

/** Apply a net to the union of copper bonded to selected tracks and vias. */
export function applyNetToCopperSelection(app, entries, v, additionalCommands = []) {
    const tracks = new Set();
    const vias = new Set();
    const padNets = new Set();
    const selectedPadKeys = new Set(entries
        .filter(entry => entry.kind === 'pad')
        .map(entry => `null|${entry.object.id}`));
    for (const entry of entries) {
        const seed = entry.kind === 'track' ? { track: entry.object }
            : entry.kind === 'via' ? { via: entry.object } : null;
        if (!seed) continue;
        const group = collectBondedCopper(app, seed);
        for (const track of group.tracks) tracks.add(track);
        for (const via of group.vias) vias.add(via);
        for (const [padKey, padNet] of group.padNetByKey) {
            if (padNet && !selectedPadKeys.has(padKey)) padNets.add(padNet);
        }
    }
    const conflict = [...padNets].find(padNet => padNet !== v);
    if (conflict !== undefined) {
        showAlert(
            `This copper is connected to a pad on net "${conflict}" (assigned by the schematic). ` +
            'Rename the net in the schematic instead of editing the selection.',
            { title: 'Net Assigned by Schematic' },
        );
        return false;
    }
    const commands = [...additionalCommands];
    for (const track of tracks) {
        if ((track.net || '') !== v) {
            commands.push(new ModifyTrackCommand(app, track, { net: track.net || '' }, { net: v }));
        }
    }
    const viaChanges = [...vias]
        .filter(via => (via.net || '') !== v)
        .map(via => ({ via, before: { net: via.net || '' }, after: { net: v } }));
    if (viaChanges.length === 1) {
        const change = viaChanges[0];
        commands.push(new ModifyViaCommand(app, change.via, change.before, change.after));
    } else if (viaChanges.length > 1) {
        commands.push(new ModifyViasCommand(app, viaChanges));
    }
    if (commands.length) {
        app.history?.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
    }
    return true;
}

export function showViaProperties(app, via) {
    const items = app.propertiesItems?.() || document.getElementById('pcbPropsItems');
    if (!items) return;
    via = canonicalVia(app, via);
    const selectedVias = getPcbSelection(app, 'via').map(target => canonicalVia(app, target));
    const vias = selectedVias.includes(via) && selectedVias.length ? selectedVias : [via];
    let preview = null;
    let activeProperty = null;
    let disposed = false;
    const mixedDiameter = vias.some((target) => target.diameter !== via.diameter);
    const mixedDrill = vias.some((target) => target.drill !== via.drill);
    const mixedNet = vias.some((target) => (target.net || '') !== (via.net || ''));
    const limits = () => ({
        minDiameter: Math.max(...vias.map(target => (preview?.copies.get(target) || target).drill)),
        maxDrill: Math.min(...vias.map(target => (preview?.copies.get(target) || target).diameter)),
    });
    const { minDiameter, maxDrill } = limits();
    app.setPropertiesTitle?.('Via');
    const netOptions = _netOptions(app, via.net || '');
    items.innerHTML = `
        <div class="prop-row" data-prop="net"><label>Net</label><span class="prop-net-control"><input type="text" id="pcbPropViaNet" value="${mixedNet ? '' : _escape(via.net || '')}" placeholder="${mixedNet ? 'Mixed' : 'None'}"><details class="prop-net-menu"><summary aria-label="Select existing net"></summary><div>${netOptions}</div></details></span></div>
        <div class="prop-row" data-prop="diameter"><label>Diameter (mm)</label><input type="number" id="pcbPropViaDia" value="${mixedDiameter ? '' : via.diameter}" placeholder="${mixedDiameter ? 'Mixed' : ''}" min="${minDiameter}" step="0.05"></div>
        <div class="prop-row" data-prop="drill"><label>Drill (mm)</label><input type="number" id="pcbPropViaDrill" value="${mixedDrill ? '' : via.drill}" placeholder="${mixedDrill ? 'Mixed' : ''}" min="0.05" max="${maxDrill}" step="0.05"></div>
    `;
    let renderFrame = null;
    const reRender = () => {
        if (renderFrame !== null) return;
        renderFrame = requestAnimationFrame(() => {
            renderFrame = null;
            for (const target of preview?.copies.values() || []) renderVia(target, (id) => app.getLayerGroup(id));
            // renderVia replaces the circles that the existing selection halo
            // was painted above, so rebuild that overlay after the redraw.
            refreshTrackSelectionHalo(app);
        });
    };
    const cancelLiveRender = () => {
        if (renderFrame === null) return;
        cancelAnimationFrame(renderFrame);
        renderFrame = null;
    };
    const validValue = (key, value) => {
        if (!Number.isFinite(value)) return NaN;
        const current = limits();
        return key === 'diameter'
            ? Math.max(value, current.minDiameter)
            : Math.min(value, current.maxDrill);
    };
    const updateLimits = () => {
        const current = limits();
        if (diaEl) diaEl.min = String(current.minDiameter);
        if (drlEl) drlEl.max = String(current.maxDrill);
    };
    const resetFields = () => {
        if (diaEl) diaEl.value = vias.some(target => target.diameter !== via.diameter) ? '' : String(via.diameter);
        if (drlEl) drlEl.value = vias.some(target => target.drill !== via.drill) ? '' : String(via.drill);
    };
    const finish = commit => {
        if (!preview) return;
        const input = activeProperty === 'diameter' ? diaEl : drlEl;
        const value = readValue(activeProperty, input);
        commit = commit && Number.isFinite(value) && value > 0;
        preview = null;
        activeProperty = null;
        cancelLiveRender();
        let committed = false;
        try {
            finishViaPropertyPreview(app, commit ? changes => {
                app.history.execute(changes.length === 1
                    ? new ModifyViaCommand(app, changes[0].via, changes[0].before, changes[0].after)
                    : new ModifyViasCommand(app, changes));
            } : undefined);
            committed = commit;
        } finally {
            if (!committed) resetFields();
            updateLimits();
            refreshTrackSelectionHalo(app);
        }
    };
    const editable = () => !disposed && isEditorActive(app) && !isViaLocked() && isViaVisible()
        && vias.every(target => !target.locked && target.visible !== false);
    const binding = {
        affectsLayer: layerId => layerId === 'vias',
        get active() { return preview !== null; },
        commit: () => finish(editable()),
        cancel: () => finish(false),
        dispose: () => {
            disposed = true;
            finish(false);
            cancelLiveRender();
        },
    };
    setPropertyEditor(app, 'via', binding);
    const readValue = (key, input) => validValue(key, input.value.trim() === '' ? NaN : Number(input.value));
    const live = (key) => (e) => {
        if (!editable()) {
            binding.cancel();
            return;
        }
        const input = /** @type {HTMLInputElement} */ (e.target);
        if (preview && activeProperty !== key) {
            const text = input.value;
            binding.commit();
            input.value = text;
        }
        const v = readValue(key, input);
        if (Number.isFinite(v) && v > 0) {
            if (Number(input.value) !== v) input.value = String(v);
            if (vias.every(target => (preview?.copies.get(target) || target)[key] === v)) return;
            preview ??= beginViaPropertyPreview(app, vias);
            activeProperty = key;
            for (const target of preview.copies.values()) target[key] = v;
            updateLimits();
            reRender();
        }
    };
    const diaEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropViaDia'));
    const drlEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropViaDrill'));
    for (const [input, key] of /** @type {Array<[HTMLInputElement|null, string]>} */ ([[diaEl, 'diameter'], [drlEl, 'drill']])) {
        const onInput = live(key);
        input?.addEventListener('input', onInput);
        input?.addEventListener('change', event => {
            onInput(event);
            binding.commit();
            if (!disposed && !(readValue(key, input) > 0)) resetFields();
        });
        input?.addEventListener('blur', () => {
            queueMicrotask(() => {
                if (!disposed && preview && activeProperty === key) binding.commit();
            });
        });
        input?.addEventListener('keydown', event => {
            if (disposed || event.key !== 'Escape') return;
            binding.cancel();
            event.preventDefault();
            event.stopPropagation();
        });
    }
    const netEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropViaNet'));
    const netMenuEl = /** @type {HTMLDetailsElement|null} */ (document.querySelector('.prop-net-menu'));
    netEl?.addEventListener('change', () => {
        if (!editable()) {
            binding.cancel();
            return;
        }
        let applied = false;
        try {
            binding.commit();
            const v = netEl.value.trim();
            applied = vias.every(target => (target.net || '') === v) || _applyNetToSelectedVias(app, vias, v);
        } finally {
            if (!applied) netEl.value = vias.some(target => target.net !== via.net) ? '' : via.net || '';
        }
    });
    netMenuEl?.addEventListener('click', (event) => {
        if (disposed) return;
        const option = /** @type {HTMLButtonElement|null} */ (event.target instanceof Element ? event.target.closest('button[data-net]') : null);
        if (!option) return;
        netEl.value = option.dataset.net || '';
        netEl.dispatchEvent(new Event('change'));
        netMenuEl.open = false;
    });
    netMenuEl?.addEventListener('toggle', () => {
        if (disposed || !netMenuEl.open || !netEl) return;
        const current = netEl.value.trim();
        for (const option of /** @type {NodeListOf<HTMLElement>} */ (netMenuEl.querySelectorAll('button[data-net]'))) {
            option.toggleAttribute('aria-current', option.dataset.net === current);
        }
    });
    app.showPropertiesTab?.();
}

function _escape(s) {
    return String(s).replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
}

function _netOptions(app, current = '') {
    const netNames = new Set((app.netlist || []).map((entry) => String(entry.net || '')).filter(Boolean));
    for (const source of [app.tracks, app.vias, app.boardShapes, app.copperFills]) {
        for (const item of source || []) {
            const net = String(item?.net || '');
            if (net) netNames.add(net);
        }
    }
    const names = [...netNames].sort();
    const selected = String(current || '');
    return `<button type="button" data-net="">None</button>${names.map((name) => `<button type="button" data-net="${_escape(name)}"${name === selected ? ' aria-current="true"' : ''}>${_escape(name)}</button>`).join('')}`;
}
