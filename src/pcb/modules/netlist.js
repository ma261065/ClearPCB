/**
 * Netlist extraction – builds a net-to-pin mapping from the schematic.
 *
 * Walks all Wire shapes and their pinConnections to determine which
 * component pins share electrical connectivity (same net).
 *
 * Also gathers connected Net-label shapes so that named power nets
 * (VCC, GND, etc.) propagate to their wires.
 */

/**
 * @typedef {Object} PinRef
 * @property {string} componentId - Component instance ID (e.g. 'comp_1')
 * @property {string} pinNumber   - Pin number/name on that component
 */

/**
 * @typedef {Object} NetlistEntry
 * @property {string} net       - Net name (e.g. 'VCC', 'Net0001')
 * @property {PinRef[]} pins    - Array of component-pin references on this net
 */

/**
 * Extract a netlist from the schematic app's current state.
 *
 * @param {object} schematicApp - The SchematicApp instance (window.app)
 * @returns {NetlistEntry[]} Array of nets, each with a name and pin list
 */
export function extractNetlist(schematicApp) {
    if (!schematicApp?.shapes || !schematicApp?.components) return [];

    // Map: net name → Set of "componentId:pinNumber" (deduplicated)
    const netMap = new Map();

    for (const shape of schematicApp.shapes) {
        if (shape.type !== 'wire' || !shape.pinConnections) continue;

        const netName = shape.net || 'unconnected';
        if (!netMap.has(netName)) netMap.set(netName, new Set());
        const pinSet = netMap.get(netName);

        for (const [, conn] of shape.pinConnections) {
            if (!conn?.componentId || conn.pinNumber == null) continue;
            // Skip net-label "components" — they define the net name, not a physical pin
            const comp = schematicApp.components.find(c => c.id === conn.componentId);
            if (comp && comp.definition?.name === 'Net') continue;
            pinSet.add(`${conn.componentId}:${conn.pinNumber}`);
        }
    }

    // Convert to array form
    const netlist = [];
    for (const [net, pinSet] of netMap) {
        if (pinSet.size < 2) continue;  // single-pin nets have no rat lines
        const pins = [];
        for (const key of pinSet) {
            const [componentId, pinNumber] = key.split(':');
            pins.push({ componentId, pinNumber });
        }
        netlist.push({ net, pins });
    }

    return netlist;
}

/**
 * Build a component summary from the schematic for footprint placement.
 *
 * @param {object} schematicApp - The SchematicApp instance
 * @returns {Array<{id: string, reference: string, value: string, footprint: string, pins: Array<{number: string, name: string}>}>}
 */
export function extractComponents(schematicApp) {
    if (!schematicApp?.components) return [];

    const result = [];
    for (const comp of schematicApp.components) {
        // Skip net labels and other non-physical components
        if (!comp.definition) continue;
        if (comp.definition.name === 'Net') continue;
        if (comp.definition.name === 'NoConnect') continue;

        const footprint = comp.definition.footprint || comp.definition.footprintName || '';
        const pins = (comp.symbol?.pins || []).map(p => ({
            number: String(p.number),
            name: p.name || String(p.number)
        }));

        result.push({
            id: comp.id,
            reference: comp.reference || 'U?',
            value: comp.value || '',
            footprint,
            footprintShapes: comp.definition.footprintShapes || null,
            footprintBBox: comp.definition.footprintBBox || null,
            source: comp.definition._source || comp.symbol?._source || 'Built-in',
            model3dObj: comp.definition.model3dObj || null,
            model3dUrl: comp.definition.model3dUrl || null,
            pins
        });
    }
    return result;
}
