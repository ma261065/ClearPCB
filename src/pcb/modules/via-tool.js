import { pcbToolBlockNotice } from './tool-lifecycle.js';
import { commitDesignValue, renderDesignSettings } from './design-settings.js';
import { resolveTrackSnap } from './track-draw.js';

/** @typedef {ReturnType<import('../../core/PcbDesignSettings.js').PcbDesignSettings['getRoutingParams']>} RoutingParams */

const viaToolNets = new WeakMap();
const viaRingGroups = new WeakMap();
const viaPreviewWorlds = new WeakMap();

export function getViaToolNet(app) {
    return viaToolNets.get(app);
}

export function setViaToolNet(app, net) {
    viaToolNets.set(app, net);
}

/**
 * Via tool preview: crosshair + outlined via (ring + drill) at the
 * snapped cursor position.
 */
export function updateViaPreview(app, worldPos) {
    if (!app.viewport) return;
    const snap = resolveTrackSnap(app, worldPos, {});
    viaPreviewWorlds.set(app, { x: worldPos.x, y: worldPos.y });
    app.viewport.setCrosshair({ x: snap.x, y: snap.y });
    const svg = app.viewport?.svg;
    if (!svg) return;
    const p = /** @type {Partial<RoutingParams>} */ (app.getRoutingParams?.() || {});
    const dia = Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
    const drill = Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;
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
    const ring = g.querySelector('[data-role="ring"]');
    const hole = g.querySelector('[data-role="hole"]');
    ring.setAttribute('cx', String(snap.x));
    ring.setAttribute('cy', String(snap.y));
    ring.setAttribute('r', String(dia / 2));
    ring.setAttribute('stroke-width', String(stroke * 1.5));
    hole.setAttribute('cx', String(snap.x));
    hole.setAttribute('cy', String(snap.y));
    hole.setAttribute('r', String(drill / 2));
    hole.setAttribute('stroke-width', String(stroke));
}

export function clearViaRing(app) {
    const group = viaRingGroups.get(app);
    if (group) {
        group.remove();
        viaRingGroups.set(app, null);
    }
    viaPreviewWorlds.delete(app);
}

export function getViaPreviewWorld(app) {
    return viaPreviewWorlds.get(app) || null;
}

export function clearViaPreview(app) {
    clearViaRing(app);
    app.viewport?.hideCrosshair();
}

/** Show Via placement defaults in Properties. */
export function showViaToolProperties(app) {
    let diameterError = '', drillError = '';
    const routing = () => /** @type {Partial<RoutingParams>} */ (app.getRoutingParams?.() || {});
    const currentDiameter = () => {
        const p = routing();
        return Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
    };
    const currentDrill = () => {
        const p = routing();
        return Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;
    };
    const refresh = () => app.refreshPropertyPanel(describe());
    const updatePreview = () => {
        renderDesignSettings(app);
        const world = getViaPreviewWorld(app);
        if (world) updateViaPreview(app, world);
    };
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
