import { findNearbyWirePoint, VERTEX_EPSILON } from './wire.js';

function normalizeNetName(name) {
    return String(name || '').trim().toUpperCase();
}

function getAttachedWire(app, point) {
    const hit = findNearbyWirePoint(app, point, VERTEX_EPSILON);
    if (!hit || hit.wire?.type !== 'wire') return null;
    return hit.wire;
}

function getConnectedWires(app, seedWire) {
    const visited = new Set([seedWire]);
    const queue = [seedWire];

    while (queue.length > 0) {
        const wire = queue.shift();
        for (const pos of wire.nodes.values()) {
            for (const other of app.shapes) {
                if (other.type !== 'wire' || visited.has(other)) continue;
                if (other.nodeAt(pos, VERTEX_EPSILON)) {
                    visited.add(other);
                    queue.push(other);
                }
            }
        }
    }

    return visited;
}

/**
 * Validate whether a Net name can be used at a point.
 * If the point is attached to a wire-network, all existing nets on that
 * connected network must either be absent or have the same net name.
 *
 * @param {object} app
 * @param {{x:number,y:number}} point
 * @param {string} proposedName
 * @param {string|null} [excludeNetId]
 * @returns {{ ok: boolean, attached: boolean, conflictWith?: string }}
 */
export function validateNetNameAtPoint(app, point, proposedName, excludeNetId = null) {
    const attachedWire = getAttachedWire(app, point);
    if (!attachedWire) return { ok: true, attached: false };

    const connected = getConnectedWires(app, attachedWire);
    const proposed = normalizeNetName(proposedName);
    const existingNames = new Set();

    for (const shape of app.shapes) {
        if (shape.type !== 'net') continue;
        if (excludeNetId && shape.id === excludeNetId) continue;

        const otherWire = getAttachedWire(app, { x: shape.x, y: shape.y });
        if (!otherWire || !connected.has(otherWire)) continue;

        const nameNorm = normalizeNetName(shape.net);
        if (nameNorm) existingNames.add(nameNorm);
    }

    if (existingNames.size === 0 || (existingNames.size === 1 && existingNames.has(proposed))) {
        return { ok: true, attached: true };
    }

    return { ok: false, attached: true, conflictWith: Array.from(existingNames)[0] || '' };
}
