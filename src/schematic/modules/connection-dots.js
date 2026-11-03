import {
    collectCoincidentComponentPins,
    collectDirectPinLabelContacts,
    collectDirectPinNoConnectContacts,
    collectDirectWireNoConnectContacts,
    SCHEMATIC_CONNECTION_TOLERANCE,
} from '../../core/component-pin-connectivity.js';
import { WIRE_COLOR } from '../../shapes/wire.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{point:Point,classes:Set<string>}} ConnectionDot */

const NS = 'http://www.w3.org/2000/svg';
const states = new WeakMap();
const CONNECTION_DOT_SHAPE_TYPES = new Set(['net', 'noconnect', 'wire']);

/**
 * Whether a shape's presence or geometry can change the derived connection dots.
 * @param {{type?:string}|null|undefined} shape
 */
export function affectsConnectionDots(shape) {
    return !!shape && CONNECTION_DOT_SHAPE_TYPES.has(shape.type || '');
}

/** @param {SchematicEditor} app */
function connectionDotGroup(app) {
    let group = states.get(app);
    if (!group) {
        group = document.createElementNS(NS, 'g');
        group.setAttribute('class', 'schematic-connection-dots');
        group.setAttribute('pointer-events', 'none');
        states.set(app, group);
    }
    app.viewport.contentLayer.appendChild(group);
    group.replaceChildren();
    return group;
}

/**
 * Clear all derived connection dots immediately when the document is replaced.
 * @param {SchematicEditor} app
 */
export function clearConnectionDots(app) {
    states.get(app)?.replaceChildren();
}

/**
 * Add a point to the deduplicated connection-dot set.
 * @param {ConnectionDot[]} dots
 * @param {Point} point
 * @param {string} sourceClass
 */
function addConnectionDot(dots, point, sourceClass) {
    const existing = dots.find(dot => Math.hypot(dot.point.x - point.x,
        dot.point.y - point.y) < SCHEMATIC_CONNECTION_TOLERANCE);
    if (existing) {
        existing.classes.add(sourceClass);
        return;
    }
    dots.push({ point, classes: new Set([sourceClass]) });
}

/**
 * Render every schematic connection indicator in one derived overlay:
 * wire graph junctions, wire-to-pin bonds, coincident physical pins,
 * direct NetLabel contacts and No Connect contacts.
 * @param {SchematicEditor} app
 */
export function renderConnectionDots(app) {
    if (typeof app.viewport?.contentLayer?.appendChild !== 'function') return;
    const group = connectionDotGroup(app);
    const scale = Math.max(0.01, app.viewport.scale || 1);
    const radius = Math.max(0.4, 2.5 / scale);
    /** @type {ConnectionDot[]} */
    const dots = [];
    for (const shape of app.shapes) {
        if (shape.type !== 'wire' || shape.visible === false) continue;
        for (const [nodeId, point] of shape.nodes) {
            if (shape.degree(nodeId) >= 3) addConnectionDot(dots, point, 'junction-dot');
        }
        for (const nodeId of shape.pinConnections?.keys() || []) {
            const point = shape.nodes.get(nodeId);
            if (point) addConnectionDot(dots, point, 'pin-connection-dot');
        }
    }
    for (const contact of collectCoincidentComponentPins(app.components)
        .filter(contact => contact.pins.filter(({ pin }) => !pin.hidden).length >= 2)) {
        addConnectionDot(dots, contact.point, 'direct-pin-junction-dot');
    }
    for (const contact of [
        ...collectDirectPinLabelContacts(app.components, app.shapes),
        ...collectDirectPinNoConnectContacts(app.components, app.shapes),
        ...collectDirectWireNoConnectContacts(app.shapes),
    ]) {
        addConnectionDot(dots, contact.point, 'direct-pin-junction-dot');
    }
    for (const { point, classes } of dots) {
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', String(point.x));
        dot.setAttribute('cy', String(point.y));
        dot.setAttribute('r', String(radius));
        dot.setAttribute('fill', WIRE_COLOR);
        dot.setAttribute('stroke', 'none');
        dot.setAttribute('pointer-events', 'none');
        dot.setAttribute('class', ['schematic-connection-dot', ...classes].join(' '));
        group.appendChild(dot);
    }
}
