import {
    collectCoincidentComponentPins,
    collectDirectPinLabelContacts,
    SCHEMATIC_CONNECTION_TOLERANCE,
} from '../../core/component-pin-connectivity.js';
import { WIRE_COLOR } from '../../shapes/wire.js';
import { schematicConnectionDotRadius } from '../render/connection-dot.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */

const NS = 'http://www.w3.org/2000/svg';
const states = new WeakMap();

/** @param {SchematicEditor} app */
function junctionGroup(app) {
    let group = states.get(app);
    if (!group) {
        group = document.createElementNS(NS, 'g');
        group.setAttribute('class', 'component-pin-junctions');
        group.setAttribute('pointer-events', 'none');
        states.set(app, group);
    }
    app.viewport.contentLayer.appendChild(group);
    group.replaceChildren();
    return group;
}

/**
 * Render derived dots for direct physical component-pin joins.
 * @param {SchematicEditor} app
 */
export function renderComponentPinJunctions(app) {
    if (typeof app.viewport?.contentLayer?.appendChild !== 'function') return;
    const group = junctionGroup(app);
    const scale = Math.max(0.01, app.viewport.scale || 1);
    const radius = schematicConnectionDotRadius(scale);
    const points = collectCoincidentComponentPins(app.components)
        .filter(contact => contact.pins.filter(({ pin }) => !pin.hidden).length >= 2)
        .map(contact => contact.point);
    for (const contact of collectDirectPinLabelContacts(app.components, app.shapes)) {
        if (!points.some(point => Math.hypot(point.x - contact.point.x,
            point.y - contact.point.y) < SCHEMATIC_CONNECTION_TOLERANCE)) {
            points.push(contact.point);
        }
    }
    for (const point of points) {
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', String(point.x));
        dot.setAttribute('cy', String(point.y));
        dot.setAttribute('r', String(radius));
        dot.setAttribute('fill', WIRE_COLOR);
        dot.setAttribute('stroke', 'none');
        dot.setAttribute('pointer-events', 'none');
        dot.setAttribute('class', 'direct-pin-junction-dot');
        group.appendChild(dot);
    }
}
