/**
 * Shared sticky-wire update logic used by interaction code and undo commands.
 */
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../shapes/wire.js').Wire} Wire */
/** @typedef {import('../../shapes/noconnect.js').NoConnect} NoConnect */
/** @typedef {import('../../components/Component.js').Component} Component */

/** @param {unknown} item @returns {item is Component} */
const hasPinPosition = item => !!item && typeof item === 'object' && typeof /** @type {{getPinPosition?: unknown}} */ (item).getPinPosition === 'function';

/**
 * Update wire-pin and NoConnect-pin attachments after component movement.
 * Pin nodes follow their component pins; bridge nodes (inserted at drag
 * start) stay in place so the wire maintains its shape.
 *
 * @param {SchematicEditor} app
 * @param {{ movedIds?: Set<string> }} [options]
 */
export function applyStickyConnections(app, options = {}) {
    const { movedIds = null } = options;

    for (const shape of app.shapes) {
        if (shape.type === 'wire') {
            const wire = shape;
            for (const [nodeId, conn] of wire.pinConnections) {
                if (movedIds && !movedIds.has(conn.componentId)) continue;
                const shapeComp = app.shapes.find(s => s.id === conn.componentId && hasPinPosition(s));
                const comp = app.components.find(c => c.id === conn.componentId)
                    || /** @type {Component|null} */ (shapeComp || null);
                if (!comp) continue;
                const pos = comp.getPinPosition(conn.pinNumber);
                if (!pos) continue;
                const node = wire.nodes.get(nodeId);
                if (!node) continue;
                if (node.x !== pos.x || node.y !== pos.y) {
                    node.x = pos.x;
                    node.y = pos.y;
                    // Slide each bridge node along its wire axis to stay
                    // orthogonal with the pin.  The bridge connects to exactly
                    // one wire neighbor — that edge determines the axis.
                    for (const { otherNode: bridgeId } of wire.incidentEdges(nodeId)) {
                        if (wire.pinConnections.has(bridgeId)) continue;
                        const bp = wire.nodes.get(bridgeId);
                        if (!bp) continue;
                        if (bp._pinDetachJunction) continue;
                        // Only move explicit sticky bridge nodes created for this pin's owner.
                        const isStickyBridge = !!(bp._stickyBridge || bp._staggerAxis || bp._staggerBendId);
                        if (!isStickyBridge) continue;
                        if (bp._stickyOwnerCompId && bp._stickyOwnerCompId !== conn.componentId) continue;
                        for (const { otherNode: wireNbr } of wire.incidentEdges(bridgeId)) {
                            if (wireNbr === nodeId) continue;
                            const wp = wire.nodes.get(wireNbr);
                            if (!wp) continue;
                            const edx = Math.abs(wp.x - bp.x);
                            const edy = Math.abs(wp.y - bp.y);
                            let neighborPos = wp;
                            if (bp._staggerBendId) {
                                const bend = wire.nodes.get(bp._staggerBendId);
                                if (bend?. _staggerWireNeighbor) {
                                    const wpos = wire.nodes.get(bend._staggerWireNeighbor);
                                    if (wpos) neighborPos = wpos;
                                }
                            }
                            if (bp._staggerAxis === 'x') {
                                const desiredDelta = (neighborPos?.x ?? bp.x) - pos.x;
                                const offsetMag = Math.abs(bp._staggerOffset || 0);
                                const clamped = Math.min(offsetMag, Math.abs(desiredDelta));
                                const sign = desiredDelta === 0 ? 0 : Math.sign(desiredDelta);
                                bp.x = pos.x + sign * clamped;
                                bp.y = pos.y;
                                if (bp._staggerBendId) {
                                    const bend = wire.nodes.get(bp._staggerBendId);
                                    if (bend) {
                                        bend.x = bp.x;
                                        if (bend._staggerWireNeighbor) {
                                            const wpos = wire.nodes.get(bend._staggerWireNeighbor);
                                            if (wpos) bend.y = wpos.y;
                                        }
                                    }
                                }
                                if (bp._staggerBendId) {
                                    const bend = wire.nodes.get(bp._staggerBendId);
                                    const jogId = bend?._staggerWireNeighbor;
                                    if (bend && jogId) {
                                        const jogPos = wire.nodes.get(jogId);
                                        if (jogPos) {
                                            let jogOtherId = null;
                                            for (const { otherNode } of wire.incidentEdges(jogId)) {
                                                if (otherNode !== bp._staggerBendId) { jogOtherId = otherNode; break; }
                                            }
                                            if (jogOtherId) {
                                                const jogOtherPos = wire.nodes.get(jogOtherId);
                                                if (jogOtherPos && Math.abs(jogPos.x - jogOtherPos.x) < 0.001) {
                                                    const minY = Math.min(pos.y, jogOtherPos.y);
                                                    const maxY = Math.max(pos.y, jogOtherPos.y);
                                                    jogPos.y = Math.min(maxY, Math.max(minY, pos.y));
                                                    bend.y = jogPos.y;
                                                }
                                            }
                                        }
                                    }
                                }
                            } else if (bp._staggerAxis === 'y') {
                                const desiredDelta = (neighborPos?.y ?? bp.y) - pos.y;
                                const offsetMag = Math.abs(bp._staggerOffset || 0);
                                const clamped = Math.min(offsetMag, Math.abs(desiredDelta));
                                const sign = desiredDelta === 0 ? 0 : Math.sign(desiredDelta);
                                bp.y = pos.y + sign * clamped;
                                bp.x = pos.x;
                                if (bp._staggerBendId) {
                                    const bend = wire.nodes.get(bp._staggerBendId);
                                    if (bend) {
                                        bend.y = bp.y;
                                        if (bend._staggerWireNeighbor) {
                                            const wpos = wire.nodes.get(bend._staggerWireNeighbor);
                                            if (wpos) bend.x = wpos.x;
                                        }
                                    }
                                }
                                if (bp._staggerBendId) {
                                    const bend = wire.nodes.get(bp._staggerBendId);
                                    const jogId = bend?._staggerWireNeighbor;
                                    if (bend && jogId) {
                                        const jogPos = wire.nodes.get(jogId);
                                        if (jogPos) {
                                            let jogOtherId = null;
                                            for (const { otherNode } of wire.incidentEdges(jogId)) {
                                                if (otherNode !== bp._staggerBendId) { jogOtherId = otherNode; break; }
                                            }
                                            if (jogOtherId) {
                                                const jogOtherPos = wire.nodes.get(jogOtherId);
                                                if (jogOtherPos && Math.abs(jogPos.y - jogOtherPos.y) < 0.001) {
                                                    const minX = Math.min(pos.x, jogOtherPos.x);
                                                    const maxX = Math.max(pos.x, jogOtherPos.x);
                                                    jogPos.x = Math.min(maxX, Math.max(minX, pos.x));
                                                    bend.x = jogPos.x;
                                                }
                                            }
                                        }
                                    }
                                }
                            } else if (edx > edy) {
                                bp.x = pos.x;   // horizontal wire → track pin X
                            } else {
                                bp.y = pos.y;   // vertical wire  → track pin Y
                            }
                        }
                    }
                    wire.invalidate();
                }
            }
        } else if (shape.type === 'noconnect') {
            const noConnect = /** @type {NoConnect} */ (shape);
            const pinConnection = noConnect.pinConnection;
            if (!pinConnection) continue;
            if (movedIds && movedIds.has(shape.id)) continue;
            const comp = app.components.find(c => c.id === pinConnection.componentId);
            if (!comp) continue;
            const pos = comp.getPinPosition(pinConnection.pinNumber);
            if (!pos) continue;
            noConnect.x = pos.x;
            noConnect.y = pos.y;
            noConnect.invalidate();
        }
    }
}
