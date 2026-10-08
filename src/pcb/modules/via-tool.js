import { pcbToolBlockNotice } from './tool-lifecycle.js';
import { commitDesignValue, renderDesignSettings } from './design-settings.js';
import { resolveTrackSnap } from './track-snap.js';
import { AddTrackCommand, AddViaCommand, CompoundCommand, RemoveTrackCommand } from './track-commands.js';
import { findSplittableTrackEdge, splitTrackObjectAtPoint } from './track-edits.js';
import { Via } from '../../shapes/via.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/track.js').Track} Track */
/** @typedef {{x: number, y: number}} Point */

/** @typedef {ReturnType<import('../../core/PcbDesignSettings.js').PcbDesignSettings['getRoutingParams']>} RoutingParams */

/** @type {WeakMap<PcbEditor, string>} */
const viaToolNets = new WeakMap();
/** @type {WeakMap<PcbEditor, SVGGElement|null>} */
const viaRingGroups = new WeakMap();
/** @type {WeakMap<PcbEditor, Point>} */
const viaPreviewWorlds = new WeakMap();

/** @param {PcbEditor} app */
export function getViaToolNet(app) {
    return viaToolNets.get(app);
}

/** @param {PcbEditor} app @param {string} net */
export function setViaToolNet(app, net) {
    viaToolNets.set(app, net);
}

/**
 * Via tool preview: crosshair + outlined via (ring + drill) at the
 * snapped cursor position.
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function updateViaPreview(app, worldPos) {
    if (!app.viewport) return;
    const snap = resolveTrackSnap(app, worldPos, {});
    viaPreviewWorlds.set(app, { x: worldPos.x, y: worldPos.y });
    app.viewport.setCrosshair({ x: snap.x, y: snap.y });
    const svg = app.viewport?.svg;
    if (!svg) return;
    const p = /** @type {Partial<RoutingParams>} */ (app.getRoutingParams() || {});
    const viaDiameter = p.viaDiameter;
    const viaDrill = p.viaDrill;
    const dia = typeof viaDiameter === 'number' && Number.isFinite(viaDiameter) && viaDiameter > 0 ? viaDiameter : 0.6;
    const drill = typeof viaDrill === 'number' && Number.isFinite(viaDrill) && viaDrill > 0 ? viaDrill : 0.3;
    const scale = app.viewport.scale || 1;
    const stroke = 1 / scale;

    let g = viaRingGroups.get(app);
    if (!g) {
        const NS = 'http://www.w3.org/2000/svg';
        // Read the accent color once per preview group; getComputedStyle
        // forces a style resolve and this runs on every mousemove.
        const accent = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent-color').trim() || '#0098ff';
        g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'pcb-via-preview');
        g.setAttribute('pointer-events', 'none');
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('data-role', 'ring');
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', accent);
        const hole = document.createElementNS(NS, 'circle');
        hole.setAttribute('data-role', 'hole');
        hole.setAttribute('fill', 'none');
        hole.setAttribute('stroke', accent);
        g.appendChild(ring);
        g.appendChild(hole);
        svg.appendChild(g);
        viaRingGroups.set(app, g);
    }
    const ring = /** @type {SVGCircleElement} */ (g.querySelector('[data-role="ring"]'));
    const hole = /** @type {SVGCircleElement} */ (g.querySelector('[data-role="hole"]'));
    ring.setAttribute('cx', String(snap.x));
    ring.setAttribute('cy', String(snap.y));
    ring.setAttribute('r', String(dia / 2));
    ring.setAttribute('stroke-width', String(stroke * 1.5));
    hole.setAttribute('cx', String(snap.x));
    hole.setAttribute('cy', String(snap.y));
    hole.setAttribute('r', String(drill / 2));
    hole.setAttribute('stroke-width', String(stroke));
}

/** @param {PcbEditor} app */
export function clearViaRing(app) {
    const group = viaRingGroups.get(app);
    if (group) {
        group.remove();
        viaRingGroups.set(app, null);
    }
    viaPreviewWorlds.delete(app);
}

/** @param {PcbEditor} app */
export function getViaPreviewWorld(app) {
    return viaPreviewWorlds.get(app) || null;
}

/** @param {PcbEditor} app */
export function clearViaPreview(app) {
    clearViaRing(app);
    app.viewport?.hideCrosshair();
}

/**
 * Show Via placement defaults in Properties.
 * @param {PcbEditor} app
 */
export function showViaToolProperties(app) {
    let diameterError = '', drillError = '';
    const routing = () => /** @type {Partial<RoutingParams>} */ (app.getRoutingParams() || {});
    const currentDiameter = () => {
        const p = routing();
        const diameter = p.viaDiameter;
        return typeof diameter === 'number' && Number.isFinite(diameter) && diameter > 0 ? diameter : 0.6;
    };
    const currentDrill = () => {
        const p = routing();
        const drill = p.viaDrill;
        return typeof drill === 'number' && Number.isFinite(drill) && drill > 0 ? drill : 0.3;
    };
    const refresh = () => app.refreshPropertyPanel(describe());
    const updatePreview = () => {
        renderDesignSettings(app);
        const world = getViaPreviewWorld(app);
        if (world) updateViaPreview(app, world);
    };
    /** @param {number} value */
    const setDiameter = value => {
        const next = Number.isFinite(value) && value > 0 ? Math.max(value, currentDrill()) : value;
        const hadError = !!diameterError;
        const result = commitDesignValue(app, 'viaDiameter', next, 'mm');
        diameterError = result.message;
        if (result.message) refresh();
        if (!result.ok) return;
        updatePreview();
        if (hadError) refresh();
    };
    /** @param {number} value */
    const setDrill = value => {
        const next = Number.isFinite(value) && value > currentDiameter() ? currentDiameter() : value;
        const hadError = !!drillError;
        const result = commitDesignValue(app, 'viaDrill', next, 'mm');
        drillError = result.message;
        if (result.message) refresh();
        if (!result.ok) return;
        updatePreview();
        if (hadError) refresh();
    };
    /** @returns {import('../../shared/ui/property-fields.js').PropertyPanel} */
    const describe = () => ({
        title: 'New Via',
        actions: pcbToolBlockNotice(app, 'via').actions,
        fields: [
            { key: 'net', id: 'pcbPropViaToolNet', type: 'net', label: 'Net', value: String(getViaToolNet(app) || ''),
                nets: app.netNames(), commit: value => { setViaToolNet(app, value); refresh(); } },
            { key: 'diameter', id: 'pcbPropViaToolDiameter', type: 'number', label: 'Diameter (mm)',
                value: currentDiameter(), min: currentDrill(), step: 0.05, numberFormat: 'precise',
                error: diameterError, normalize: value => value > 0 ? Math.max(value, currentDrill()) : value,
                preview: setDiameter, commit: setDiameter },
            { key: 'drill', id: 'pcbPropViaToolDrill', type: 'number', label: 'Drill (mm)',
                value: currentDrill(), min: 0.05, max: currentDiameter(), step: 0.05, numberFormat: 'precise',
                error: drillError, normalize: value => value > currentDiameter() ? currentDiameter() : value,
                preview: setDrill, commit: setDrill },
        ],
    });
    app.openPropertyPanel(describe());
}

/**
 * A primary press with the Via tool: place a via at the pointer. On a pad or track node it
 * joins that copper and takes its net; mid-segment it splits the track so the via sits on
 * a node of both halves; elsewhere it stands alone. A net chosen in the tool wins.
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function pressViaTool(app, worldPos) {
    const snap = resolveTrackSnap(app, worldPos, {});
    const p = /** @type {Partial<RoutingParams>} */ (app.getRoutingParams() || {});
    const viaDiameter = p.viaDiameter;
    const viaDrill = p.viaDrill;
    const diameter = typeof viaDiameter === 'number' && Number.isFinite(viaDiameter) && viaDiameter > 0 ? viaDiameter : 0.6;
    const drill = typeof viaDrill === 'number' && Number.isFinite(viaDrill) && viaDrill > 0 ? viaDrill : 0.3;
    const selectedNet = String(getViaToolNet(app) || '').trim();

    if (snap.snapType === 'pad' || snap.snapType === 'track-node') {
        const net = selectedNet || snap.pad?.net || snap.trackNode?.track?.net || '';
        app.history.execute(new AddViaCommand(app, new Via({ x: snap.x, y: snap.y, diameter, drill, net })));
        return;
    }
    const split = findSplittableTrackEdge(app, worldPos);
    if (!split) {
        app.history.execute(new AddViaCommand(app, new Via({ x: snap.x, y: snap.y, diameter, drill, net: selectedNet })));
        return;
    }
    const splitTrack = /** @type {Track} */ (split.track);
    const via = new Via({ x: split.px, y: split.py, diameter, drill, net: selectedNet || splitTrack.net || '' });
    const parts = splitTrackObjectAtPoint(split.track, split.edgeId, { x: split.px, y: split.py });
    if (!parts?.length) {
        app.history.execute(new AddViaCommand(app, via));
        return;
    }
    /** @type {any[]} */
    const commands = [new RemoveTrackCommand(app, split.track)];
    for (const part of parts) commands.push(new AddTrackCommand(app, part));
    commands.push(new AddViaCommand(app, via));
    app.history.execute(new CompoundCommand(commands));
}
