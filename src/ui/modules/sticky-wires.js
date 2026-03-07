/**
 * Shared sticky-wire update logic used by interaction code and undo commands.
 */

/**
 * Update wire-pin and NoConnect-pin attachments after component movement.
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
                if (node) {
                    node.x = pos.x;
                    node.y = pos.y;
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
