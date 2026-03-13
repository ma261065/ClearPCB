/**
 * Shared sticky-wire update logic used by interaction code and undo commands.
 */

/**
 * Update wire-pin and NoConnect-pin attachments after component movement.
 * Pin nodes follow their component pins; bridge nodes (inserted at drag
 * start) stay in place so the wire maintains its shape.
 *
 * @param {object} app
 * @param {{ movedIds?: Set<string> }} [options]
 */
export function applyStickyConnections(app, options = {}) {
    const { movedIds = null } = options;

    for (const shape of app.shapes) {
        if (shape.type === 'wire') {
            for (const [nodeId, conn] of shape.pinConnections) {
                const comp = app.components.find(c => c.id === conn.componentId);
                if (!comp) continue;
                const pos = comp.getPinPosition(conn.pinNumber);
                if (!pos) continue;
                const node = shape.nodes.get(nodeId);
                if (!node) continue;
                if (node.x !== pos.x || node.y !== pos.y) {
                    node.x = pos.x;
                    node.y = pos.y;
                    // Slide each bridge node along its wire axis to stay
                    // orthogonal with the pin.  The bridge connects to exactly
                    // one wire neighbor — that edge determines the axis.
                    for (const { otherNode: bridgeId } of shape.incidentEdges(nodeId)) {
                        if (shape.pinConnections.has(bridgeId)) continue;
                        const bp = shape.nodes.get(bridgeId);
                        if (!bp) continue;
                        for (const { otherNode: wireNbr } of shape.incidentEdges(bridgeId)) {
                            if (wireNbr === nodeId) continue;
                            const wp = shape.nodes.get(wireNbr);
                            if (!wp) continue;
                            const edx = Math.abs(wp.x - bp.x);
                            const edy = Math.abs(wp.y - bp.y);
                            if (edx > edy) bp.x = pos.x;   // horizontal wire → track pin X
                            else            bp.y = pos.y;   // vertical wire  → track pin Y
                        }
                    }
                    shape.invalidate();
                }
            }
        } else if (shape.type === 'noconnect' && shape.pinConnection) {
            if (movedIds && movedIds.has(shape.id)) continue;
            const comp = app.components.find(c => c.id === shape.pinConnection.componentId);
            if (!comp) continue;
            const pos = comp.getPinPosition(shape.pinConnection.pinNumber);
            if (!pos) continue;
            shape.x = pos.x;
            shape.y = pos.y;
            shape.invalidate();
        }
    }
}
