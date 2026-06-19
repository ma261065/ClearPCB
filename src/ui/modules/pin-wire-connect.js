import { VERTEX_EPSILON } from './wire.js';

export const PIN_ATTACH_TOL = VERTEX_EPSILON;

/**
 * Connect arbitrary pin-like points to wires by node hit or edge split.
 *
 * @param {object} app
 * @param {Array<{x:number,y:number,pinNumber:string|number}>} pinTargets
 * @param {{ ownerId: string, connectPinConnections?: boolean, tolerance?: number, onConnectedWire?: (wire: object) => void }} options
 */
export function connectPinsToWires(app, pinTargets, options) {
    const {
        ownerId,
        connectPinConnections = false,
        tolerance = PIN_ATTACH_TOL,
        onConnectedWire = null
    } = options || {};

    if (!ownerId || !Array.isArray(pinTargets) || pinTargets.length === 0) return;

    for (const target of pinTargets) {
        const pos = { x: Number(target?.x), y: Number(target?.y) };
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;

        for (const wire of app.shapes) {
            if (wire.type !== 'wire') continue;

            let hitNodeId = null;
            for (const [nodeId, nodePos] of wire.nodes) {
                if (Math.hypot(pos.x - nodePos.x, pos.y - nodePos.y) < tolerance) {
                    hitNodeId = nodeId;
                    break;
                }
            }

            if (hitNodeId) {
                if (connectPinConnections) {
                    wire.pinConnections.set(hitNodeId, {
                        componentId: ownerId,
                        pinNumber: target.pinNumber
                    });
                    wire.invalidate?.();
                }
                onConnectedWire?.(wire);
                break;
            }

            if (typeof wire.closestEdge === 'function') {
                const edge = wire.closestEdge(pos);
                if (edge && edge.distance < tolerance) {
                    const split = wire.splitEdge(edge.edgeId, pos);
                    if (split?.newNodeId) {
                        if (connectPinConnections) {
                            wire.pinConnections.set(split.newNodeId, {
                                componentId: ownerId,
                                pinNumber: target.pinNumber
                            });
                        }
                        wire.invalidate?.();
                        onConnectedWire?.(wire);
                        break;
                    }
                }
            }
        }
    }
}

/**
 * Connect component pins to wires by node hit or edge split.
 *
 * - If a pin lands on an existing wire node, optionally writes pinConnections.
 * - If a pin lands on a wire segment interior, splitEdge creates a node there,
 *   and optionally writes pinConnections for the new node.
 *
 * @param {object} app
 * @param {object} component
 * @param {{ connectPinConnections?: boolean, tolerance?: number }} [options]
 */
export function connectComponentPinsToWires(app, component, options = {}) {
    const {
        connectPinConnections = false,
        tolerance = PIN_ATTACH_TOL
    } = options;

    if (!component?.symbol?.pins?.length || typeof component.getPinPosition !== 'function') return;

    const pinTargets = [];
    for (const pin of component.symbol.pins) {
        const pos = component.getPinPosition(pin.number);
        if (!pos) continue;
        pinTargets.push({ x: pos.x, y: pos.y, pinNumber: pin.number });
    }

    connectPinsToWires(app, pinTargets, {
        ownerId: component.id,
        connectPinConnections,
        tolerance
    });
}
