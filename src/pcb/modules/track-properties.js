/**
 * The Properties panel for selected tracks (a whole track, a node or a segment): width,
 * corner radius, layer, net and lock, with live previews that commit as one undoable edit.
 * Also applying a net to selected copper and to everything bonded to it.
 */
import { noteEditSettled } from './refresh-state.js';
import { renderTrack } from './track-render.js';
import { reconcileRatsnest } from './ratsnest.js';
import { collectBondedCopper } from './track-connections.js';
import { copperBoardWith } from './track-connections.js';
import { hitTestTrackEdge } from './track-edits.js';
import { cancelVertexDrag, isDraggingTrack } from './track-drag.js';
import { reconcileCopperRegion } from './track-drop.js';
import { RemoveTrackCommand, RemoveViaCommand, AddTrackCommand, AddViaCommand, CompoundCommand, ModifyTrackCommand, ModifyTrackGraphCommand, ModifyViaCommand, ModifyViasCommand, canonicalTrack, beginTrackPropertyPreview, finishTrackPropertyPreview } from './track-commands.js';
import { setSelectionInteraction } from './selection-interaction.js';
import { PCB_LAYERS, isLayerLocked, isLayerVisible, pcbLayerOption } from './layers.js';
import { isPcbObjectLocked, lockedProperty } from './object-locks.js';
import { canFillTrackLoop, fillTrackLoop, canMoveTrackToBoardLayer, moveTrackToBoardLayer, setTrackCopperMode } from './track-shape-conversion.js';
import { PROP_HIDDEN_LAYERS } from './board-shape-properties.js';
import { showAlert } from '../../shared/ui/modal.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { getLastPointerWorld } from './cursor-state.js';
import { formatNumberInputValue } from '../../core/number-inputs.js';
import { releasePropertyEditor, setPropertyEditor } from './property-editors.js';
import { isEditorActive } from './pcb-editor-api.js';
import { clearTrackSelection, getTrackEdit, selectTrackOrVia } from './track-select.js';
import { refreshTrackSelectionHalo } from './copper-halos.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyField} PropertyField */
/** @typedef {import('../../shared/ui/property-fields.js').PropertyPanel} PropertyPanel */
/** @typedef {import('../../shapes/track.js').Track} Track */
/** @typedef {import('../../shapes/via.js').Via} Via */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {import('./track-commands.js').TrackPropertyScope} TrackPropertyScope */
/** @typedef {import('./track-commands.js').TrackPropertyPreview} TrackPropertyPreview */
/** @typedef {import('../../core/pcb-track-commands.js').TrackState} TrackState */
/** @typedef {{read: (track: Track) => number, changed: (track: Track, value: number) => boolean, apply: (track: Track, value: number, before: TrackState) => void, fills?: boolean, rebuild?: boolean}} TrackNumberSpec */
/** @typedef {{track: Track, active: boolean, disposed: boolean, affectsLayer: (layerId: string) => boolean, commit: () => void, cancel: () => void, dispose: () => void, prepare: () => boolean, refresh: () => void, numberField: (key: string, id: string, label: string, spec: TrackNumberSpec, extra?: TrackNumberExtra) => PropertyField}} TrackPropertyBinding */
/** @typedef {{kind:'track', object: Track}|{kind:'via', object: Via}|{kind:'pad', object: Pad}} CopperSelectionEntry */
/** @typedef {{tracks: Set<Track>, vias: Set<Via>, padNets: Set<string>, padNetByKey: Map<string, string>}} BondedCopperGroup */
/** @typedef {import('../../core/CommandHistory.js').HistoryCommand} HistoryCommand */
/** @typedef {import('../../shapes/pad.js').Pad} Pad */
/** @typedef {{min?: number, max?: number, step?: number, normalize?: (value: number) => number}} TrackNumberExtra */

const COPPER_LAYERS = PCB_LAYERS.filter((layer) => layer.id === 'top-copper' || layer.id === 'bottom-copper');

/**
 * @param {PcbEditor} app
 * @param {Track} track
 */
export function showTrackSelectionProperties(app, track) {
    track = canonicalTrack(app, track);
    const edit = getTrackEdit(app);
    if (edit?.track === track && track.nodes.has(edit.nodeId)) {
        showTrackNodeProperties(app, track, edit.nodeId);
    } else if (edit?.track === track && track.edges.has(edit.edgeId)) {
        showTrackSegmentProperties(app, track, edit.edgeId);
    } else selectTrackOrVia(app, { type: 'track', track });
}

/* ──────────────────────────── properties panel ──────────────────────────── */

/**
 * A layer change rebuilds the bonded copper region, removing and re-adding its
 * other tracks and vias; refuse it when that would rewrite a locked one.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {{removeTracks: object[], removeVias: object[]}} region
 */
function regionRewritesLockedCopper(app, track, region) {
    const locked = region.removeTracks.some((other) => other !== track && isPcbObjectLocked(app, 'track', other))
        || region.removeVias.some((via) => isPcbObjectLocked(app, 'via', via));
    if (locked) app.setStatus('Connected copper is locked. Unlock it to change this layer.');
    return locked;
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {TrackPropertyScope} [scope]
 * @param {() => void} [refresh]
 * @returns {TrackPropertyBinding}
 */
function createTrackPropertyBinding(app, track, scope = {}, refresh = () => {}) {
    /** @type {TrackPropertyPreview|null} */
    let preview = null;
    /** @type {TrackNumberSpec|null} */
    let activeSpec = null;
    /** @type {string|null} */
    let activeKey = null;
    let disposed = false;
    const layers = () => [...track.edges].filter(([id, edge]) => scope.edgeId != null
        ? id === scope.edgeId : scope.nodeId == null || edge.from === scope.nodeId || edge.to === scope.nodeId)
        .map(([id]) => track.getEdgeLayer(id));
    const editable = () => !disposed && isEditorActive(app) && !track.locked
        && layers().every(layer => isLayerVisible(layer) && !isLayerLocked(layer));
    const currentTrack = () => preview?.track || track;
    // A node picked up from a midpoint "+" (or any unfinished drag) shows a preview
    // copy of this track on the board. Panel edits change the real track, so drop
    // the pickup first or the edit would miss (discrete fields) or fail (numeric fields).
    const dropPointerPreview = () => {
        if (!isDraggingTrack(app, track)) return;
        setSelectionInteraction(app, null);
        cancelVertexDrag(app);
        renderPcbSelectionAnchors(app);
    };
    /** @param {boolean} commit */
    const finish = commit => {
        if (!preview) return;
        const refreshFills = activeSpec?.fills;
        preview = null;
        noteEditSettled(app);
        activeSpec = null;
        activeKey = null;
        let committed = false;
        try {
            finishTrackPropertyPreview(app, commit ? /** @param {TrackState} before @param {TrackState} after */ (before, after) => {
                app.history.execute(new ModifyTrackGraphCommand(app, track, before, after));
                committed = true;
            } : undefined);
        } finally {
            refreshTrackSelectionHalo(app);
            if (!committed) {
                app.refreshClearanceHalos();
                if (refreshFills) app.refreshFills();
            }
            refresh();
        }
    };
    /**
     * @param {string} key
     * @param {TrackNumberSpec} spec
     * @param {number} value
     */
    const previewNumber = (key, spec, value) => {
        if (!Number.isFinite(value)) return;
        if (!editable()) { binding.cancel(); return; }
        dropPointerPreview();
        if (activeKey && activeKey !== key) binding.commit();
        const current = currentTrack();
        if (!spec.changed(current, value)) return;
        preview ||= beginTrackPropertyPreview(app, track, scope);
        activeSpec = spec;
        activeKey = key;
        spec.apply(preview.track, value, preview.before);
        renderTrack(preview.track, /** @param {string} layerId */ layerId => app.getLayerGroup(layerId), { hideNetLabel: true });
        refreshTrackSelectionHalo(app);
        app.refreshClearanceHalos();
        if (spec.fills) app.refreshFills();
        refresh();
    };
    /** @type {TrackPropertyBinding} */
    const binding = {
        track,
        get active() { return !!preview; },
        get disposed() { return disposed; },
        /** @param {string} layerId */
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
        refresh,
        numberField(key, id, label, spec, extra = {}) {
            return {
                key, id, type: 'number', label,
                value: spec.read(currentTrack()),
                disabled: !editable(),
                preview: /** @param {number} value */ value => previewNumber(key, spec, value),
                commit: () => {
                    const changed = !!preview;
                    binding.commit();
                    if (changed && spec.rebuild && !disposed) showTrackSelectionProperties(app, track);
                },
                cancel: () => {
                    const active = !!preview;
                    binding.cancel();
                    return active;
                },
                ...extra,
            };
        },
    };
    return binding;
}

/**
 * @param {TrackPropertyBinding} binding
 * @param {string|null} [nodeId]
 */
function trackCornerRadiusProperty(binding, nodeId = null) {
    return binding.numberField('cornerRadius', 'pcbPropTrackCornerRadius', 'Corner Radius (mm)', {
        read: (track) => nodeId == null ? track.cornerRadius : track.nodeCornerRadius(nodeId),
        changed: (track, radius) => Math.abs((nodeId == null ? track.cornerRadius : track.nodeCornerRadius(nodeId)) - radius) >= 1e-9
            || (nodeId == null && Object.keys(track.nodeCornerRadii || {}).length > 0),
        apply: (track, radius, before) => {
            const beforeRadii = before.nodeCornerRadii || {};
            if (nodeId == null) {
                track.cornerRadius = radius;
                track.nodeCornerRadii = {};
                track.invalidate();
            } else if (radius === (beforeRadii[nodeId] ?? before.cornerRadius)) {
                if (Object.hasOwn(beforeRadii, nodeId)) track.nodeCornerRadii[nodeId] = beforeRadii[nodeId];
                else delete track.nodeCornerRadii[nodeId];
                track.invalidate();
            } else track.setNodeCornerRadius(nodeId, radius);
        },
        fills: true,
    }, { min: 0, step: 0.5, normalize: (value) => Math.max(0, value) });
}

/**
 * @param {TrackPropertyBinding} binding
 * @param {string|null} [nodeId]
 */
function bindTrackCornerRadius(binding, nodeId = null) {
    return trackCornerRadiusProperty(binding, nodeId);
}

/**
 * @param {TrackPropertyBinding} binding
 * @param {string|null} [edgeId]
 */
function bindTrackWidth(binding, edgeId = null) {
    return binding.numberField('lineWidth', 'pcbPropTrackWidth', 'Width (mm)', {
        read: (track) => edgeId == null ? track.width : track.getEdgeWidth(edgeId),
        changed: (track, width) => edgeId == null
            ? track.width !== width || [...track.edges.keys()].some(id => track.getEdgeWidth(id) !== width)
            : track.getEdgeWidth(edgeId) !== width,
        apply: (track, width, before) => {
            /** @param {string} id */
            const setWidth = id => {
                const edge = track.edges.get(id), original = /** @type {Record<string, any>} */ (before.edges?.[id] || {});
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
    }, { min: 0.05, step: 0.05, normalize: (value) => value > 0 ? value : NaN });
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} nodeId
 */
export function showTrackNodeProperties(app, track, nodeId) {
    const node = track.nodes.get(nodeId);
    if (!node) return;
    /** @type {TrackPropertyBinding} */
    let binding;
    /** @returns {PropertyPanel} */
    const describe = () => {
        const current = track.nodes.get(nodeId);
        return {
            title: 'Track Node',
            fields: [
                { key: 'x', id: 'pcbPropTrackNodeX', type: 'readout', label: 'X (mm)',
                    value: current ? formatNumberInputValue(current.x) : '' },
                { key: 'y', id: 'pcbPropTrackNodeY', type: 'readout', label: 'Y (mm)',
                    value: current ? formatNumberInputValue(current.y) : '' },
                bindTrackCornerRadius(binding, nodeId),
            ],
        };
    };
    const refresh = () => { if (!binding.disposed) app.refreshPropertyPanel(describe()); };
    binding = createTrackPropertyBinding(app, track, { nodeId }, refresh);
    if (!app.openPropertyPanel(describe(), track)) { binding.dispose(); return; }
    setPropertyEditor(app, 'track', binding);
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 */
export function showTrackProperties(app, track) {
    /** @type {TrackPropertyBinding} */
    let binding;
    const layers = new Set();
    for (const eid of track.edges.keys()) layers.add(track.getEdgeLayer(eid));
    const mixed = layers.size > 1;
    const currentLayer = mixed ? '' : (layers.values().next().value || track.layer || 'top-copper');
    // Non-copper layers turn the track back into a board shape, which needs one line or loop.
    const movable = canMoveTrackToBoardLayer(track);
    const unmovableReason = mixed
        ? 'This track uses both copper layers. Only a track that is a single line or loop on one layer can move to a non-copper layer.'
        : 'This track branches. Only a track that is a single line or loop can move to a non-copper layer.';
    // Removal modes add no copper, so they also turn the track back into a board shape.
    const unmovableModeReason = mixed
        ? 'This track uses both copper layers. Only a track that is a single line or loop on one layer can use a removal mode.'
        : 'This track branches. Only a track that is a single line or loop can use a removal mode.';
    const lockEntries = [{ kind: 'track', object: track }];
    const netSeedEdgeId = hitTestTrackEdge(app, track, /** @type {Point} */ (getLastPointerWorld(app) || {}))?.edgeId
        || track.edges.keys().next().value;
    /** @param {string} value */
    const applyNet = value => {
        if (!binding.prepare()) return;
        const v = String(value || '').trim();
        if (v === (track.net || '')) return;
        if (applyNetToBondedCopper(app, { track, edgeId: netSeedEdgeId }, v)) {
            showTrackSelectionProperties(app, track);
        } else showTrackSelectionProperties(app, track);
    };
    /** @param {string} mode */
    const applyCopperMode = mode => {
        if (!binding.prepare()) return;
        const firstEdgeId = track.edges.keys().next().value;
        const layer = firstEdgeId ? track.getEdgeLayer(firstEdgeId) || track.layer : track.layer;
        if (mode === 'add' || isLayerLocked(layer) || !canMoveTrackToBoardLayer(track)) {
            showTrackSelectionProperties(app, track);
            return;
        }
        clearTrackSelection(app);
        setTrackCopperMode(app, track, mode);
        reconcileRatsnest(app);
        app.showPropertiesTab();
    };
    /** @param {string} v */
    const applyLayer = v => {
        if (!binding.prepare()) return;
        if (!v) return; // the Mixed placeholder
        if (!COPPER_LAYERS.some((l) => l.id === v)) {
            if (isLayerLocked(v) || !canMoveTrackToBoardLayer(track)) {
                showTrackSelectionProperties(app, track);
                return;
            }
            clearTrackSelection(app);
            moveTrackToBoardLayer(app, track, v);
            reconcileRatsnest(app);
            app.showPropertiesTab();
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
        if (regionRewritesLockedCopper(app, track, region)) {
            showTrackSelectionProperties(app, track);
            return;
        }
        // Drop the selection FIRST, while the original tracks are still
        // present and rendered (see the segment handler for why).
        clearTrackSelection(app);
        const cmds = [];
        for (const t of region.removeTracks) cmds.push(new RemoveTrackCommand(app, /** @type {Track} */ (t)));
        for (const vv of region.removeVias) cmds.push(new RemoveViaCommand(app, /** @type {Via} */ (vv)));
        for (const t of region.addTracks) cmds.push(new AddTrackCommand(app, /** @type {Track} */ (t)));
        for (const vv of region.addVias) cmds.push(new AddViaCommand(app, /** @type {Via} */ (vv)));
        if (cmds.length) app.history?.execute(new CompoundCommand(cmds));
        reconcileRatsnest(app);
        app.showPropertiesTab();
    };
    /** @returns {PropertyPanel} */
    const describe = () => {
        const lock = lockedProperty(app, lockEntries);
        const readOnly = lock.readOnly;
        const fields = /** @type {PropertyField[]} */ ([
            lock.field,
            { key: 'layer', id: 'pcbPropTrackLayer', type: 'select', label: 'Layer',
                value: currentLayer, mixed, disabled: readOnly,
                options: PCB_LAYERS.filter((l) => !PROP_HIDDEN_LAYERS.has(l.id)).map((l) => {
                    if (COPPER_LAYERS.includes(l)) return pcbLayerOption(l.id, l.name);
                    return movable ? pcbLayerOption(l.id, l.name)
                        : { value: l.id, label: l.name, disabled: true, title: unmovableReason };
                }),
                commit: applyLayer },
            { key: 'copperMode', id: 'pcbPropTrackCopperMode', type: 'select', label: 'Copper Mode',
                value: 'add', disabled: readOnly,
                options: [
                    { value: 'add', label: 'Add Copper' },
                    ...[['remove-copper', 'Remove Copper'], ['remove-solder-mask', 'Remove Solder Mask'], ['remove-copper-mask', 'Remove Copper + Mask']]
                        .map(([value, label]) => ({ value, label, disabled: !movable,
                            title: movable ? undefined : unmovableModeReason })),
                ],
                commit: applyCopperMode },
            { key: 'net', id: 'pcbPropTrackNet', type: 'net', label: 'Net', value: track.net || '',
                disabled: readOnly, nets: app.netNames(), commit: applyNet },
            ...(canFillTrackLoop(track) ? /** @type {PropertyField[]} */ ([{ key: 'fill', id: 'pcbPropTrackFill', type: 'checkbox', label: 'Fill',
                disabled: readOnly, value: false, commit: checked => {
                    if (!checked || !binding.prepare()) return;
                    clearTrackSelection(app);
                    if (!fillTrackLoop(app, track)) showTrackSelectionProperties(app, track);
                } }]) : []),
            bindTrackWidth(binding),
            bindTrackCornerRadius(binding),
        ]);
        for (const field of fields) if (field.key !== 'locked') field.disabled ||= readOnly;
        return { title: 'Track', fields };
    };
    const refresh = () => { if (!binding.disposed) app.refreshPropertyPanel(describe()); };
    binding = createTrackPropertyBinding(app, track, {}, refresh);
    if (!app.openPropertyPanel(describe(), track)) { binding.dispose(); return; }
    setPropertyEditor(app, 'track', binding);
}

/**
 * Properties panel for a single selected track segment (one edge). The
 * Net is track-wide; the Layer and Width retarget only this edge so a
 * single segment can hop layers and change width independently.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} edgeId
 */
export function showTrackSegmentProperties(app, track, edgeId) {
    /** @type {TrackPropertyBinding} */
    let binding;
    const currentLayer = track.getEdgeLayer(edgeId) || 'top-copper';
    const bulgeField = () => binding.numberField('bulge', 'pcbPropTrackBulge', 'Bulge', {
        read: (track) => track.edges.get(edgeId)?.bulge || 0,
        changed: (track, bulge) => (track.edges.get(edgeId)?.bulge || 0) !== bulge,
        apply: (track, bulge) => track.setEdgeAttr(edgeId, 'bulge', bulge),
        fills: true, rebuild: true,
    }, { min: -1, max: 1, step: 0.05, normalize: (value) => Number(formatNumberInputValue(Math.max(-1, Math.min(1, value)))) });
    /** @param {string} value */
    const applyNet = value => {
        if (!binding.prepare()) return;
        const v = String(value || '').trim();
        if (v === (track.net || '')) return;
        if (applyNetToBondedCopper(app, { track, edgeId }, v)) {
            showTrackSelectionProperties(app, track);
        } else showTrackSelectionProperties(app, track);
    };
    /** @param {string} v */
    const applyLayer = v => {
        if (!binding.prepare()) return;
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
        if (regionRewritesLockedCopper(app, track, region)) {
            showTrackSelectionProperties(app, track);
            return;
        }
        // Drop the selection FIRST, while the original tracks are still
        // present and rendered. clearTrackSelection re-renders a selected
        // track whose labels can't be restored — and once RemoveTrackCommand
        // has stripped the original's SVG elements that re-render would
        // resurrect it as an orphan (a stale polyline). Clearing here avoids
        // that.
        clearTrackSelection(app);
        const cmds = [];
        for (const t of region.removeTracks) cmds.push(new RemoveTrackCommand(app, /** @type {Track} */ (t)));
        for (const vv of region.removeVias) cmds.push(new RemoveViaCommand(app, /** @type {Via} */ (vv)));
        for (const t of region.addTracks) cmds.push(new AddTrackCommand(app, /** @type {Track} */ (t)));
        for (const vv of region.addVias) cmds.push(new AddViaCommand(app, /** @type {Via} */ (vv)));
        if (cmds.length) app.history?.execute(new CompoundCommand(cmds));
        reconcileRatsnest(app);
        app.showPropertiesTab();
    };
    /** @returns {PropertyPanel} */
    const describe = () => {
        const fields = /** @type {PropertyField[]} */ ([
            { key: 'layer', id: 'pcbPropSegLayer', type: 'select', label: 'Layer',
                value: track.getEdgeLayer(edgeId) || 'top-copper', disabled: !binding.affectsLayer(currentLayer),
                options: COPPER_LAYERS.map((l) => pcbLayerOption(l.id, l.name)), commit: applyLayer },
            { key: 'net', id: 'pcbPropTrackNet', type: 'net', label: 'Net', value: track.net || '',
                nets: app.netNames(), commit: applyNet },
            bindTrackWidth(binding, edgeId),
        ]);
        if (track.edges.get(edgeId)?.bulge) fields.push(bulgeField());
        return { title: track.edges.get(edgeId)?.bulge ? 'Arc Segment' : 'Track Segment', fields };
    };
    const refresh = () => { if (!binding.disposed) app.refreshPropertyPanel(describe()); };
    binding = createTrackPropertyBinding(app, track, { edgeId }, refresh);
    if (!app.openPropertyPanel(describe(), track)) { binding.dispose(); return; }
    setPropertyEditor(app, 'track', binding);
}

/**
 * Set net `v` on every track + via physically bonded to the seed copper
 * (one undoable compound command). Refuses with a dialog if the bonded
 * region touches a pad whose schematic-assigned net differs from `v`
 * (the schematic is authoritative — rename it there instead).
 *
 * @param {PcbEditor} app
 * @param {{track: Track, edgeId?: string}} seed
 * @param {string} v
 * @returns {boolean} true if applied (or a no-op), false if refused.
 */
export function applyNetToBondedCopper(app, seed, v) {
    let replacement = null;
    /** @type {BondedCopperGroup|undefined} */
    let group;
    const components = seed.track?.connectedComponents?.() || [];
    if (seed.edgeId && components.length > 1) {
        const edge = seed.track.edges.get(seed.edgeId);
        const selectedNodes = edge
            ? components.find(/** @param {Set<string>} nodes */ nodes => nodes.has(edge.from) && nodes.has(edge.to))
            : null;
        if (selectedNodes) {
            const parts = /** @type {Track[]} */ (components.map(/** @param {Set<string>} nodes */ nodes => seed.track.extractSubgraph(nodes)));
            const selectedIndex = components.indexOf(selectedNodes);
            const selectedTrack = parts[selectedIndex];
            const tracks = (app.tracks || []).filter(/** @param {Track} track */ (track) => track !== seed.track);
            tracks.push(...parts);
            group = /** @type {BondedCopperGroup} */ (collectBondedCopper(copperBoardWith(app, { tracks }), { track: selectedTrack }));
            replacement = { original: seed.track, parts, selectedTrack };
        }
    }
    group ||= /** @type {BondedCopperGroup} */ (collectBondedCopper(app, seed));
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
    /** @type {HistoryCommand[]} */
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

/**
 * Apply a net to the union of copper bonded to selected tracks and vias.
 * @param {PcbEditor} app
 * @param {CopperSelectionEntry[]} entries
 * @param {string} v
 * @param {HistoryCommand[]} [additionalCommands]
 */
export function applyNetToCopperSelection(app, entries, v, additionalCommands = []) {
    const tracks = new Set();
    const vias = new Set();
    const padNets = new Set();
    const selectedPadKeys = new Set(entries
        .filter((entry) => entry.kind === 'pad')
        .map((entry) => `null|${entry.object.id}`));
    for (const entry of entries) {
        const seed = entry.kind === 'track' ? { track: entry.object }
            : entry.kind === 'via' ? { via: entry.object } : null;
        if (!seed) continue;
        const group = /** @type {BondedCopperGroup} */ (collectBondedCopper(app, seed));
        for (const track of group.tracks) tracks.add(track);
        for (const via of group.vias) vias.add(via);
        for (const [padKey, padNet] of group.padNetByKey) {
            if (padNet && !selectedPadKeys.has(padKey)) padNets.add(padNet);
        }
    }
    const conflict = [...padNets].find((padNet) => padNet !== v);
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
        .filter((via) => (via.net || '') !== v)
        .map((via) => ({ via, before: { net: via.net || '' }, after: { net: v } }));
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

