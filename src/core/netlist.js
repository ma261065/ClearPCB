/**
 * Shared project queries: net-to-pin mappings and component placement data.
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
/** @typedef {{componentId?:string, pinNumber?:string|number|null}} PinConnection */
/** @typedef {{type?:string, net?:string, captureState?: () => object, pinConnections?:Map<string|number, PinConnection>|Iterable<[string|number, PinConnection]>}} NetShape */
/** @typedef {{number?:string|number|null, name?:string}} SymbolPin */
/** @typedef {import('../components/Component.js').ComponentDefinition} ComponentDefinition */
/** @typedef {{pins?:SymbolPin[], _source?:string}} ComponentSymbol */
/** @typedef {{id:string, reference?:string, value?:string, definition?:ComponentDefinition|null, symbol?:ComponentSymbol|null}} SchematicComponent */
/** @typedef {{shapes?:NetShape[], components?:SchematicComponent[]}} SchematicState */

/**
 * Extract a netlist from the schematic document's current state.
 *
 * @param {SchematicState|null|undefined} schematicApp - Schematic state exposing shapes and components.
 * @returns {NetlistEntry[]} Array of nets, each with a name and pin list
 */
export function extractNetlist(schematicApp) {
    if (!schematicApp?.shapes || !schematicApp?.components) return [];

    // Map: net name → Set of "componentId:pinNumber" (deduplicated)
    /** @type {Map<string, Set<string>>} */
    const netMap = new Map();
    // Every pin already placed on a wire net — these keep that net and must
    // not also receive a default single-pin net below.
    const wiredPins = new Set();

    for (const shape of schematicApp.shapes) {
        if (shape.type !== 'wire' || !shape.pinConnections) continue;

        const netName = shape.net || 'unconnected';
        if (!netMap.has(netName)) netMap.set(netName, new Set());
        const pinSet = /** @type {Set<string>} */ (netMap.get(netName));

        for (const [, conn] of shape.pinConnections) {
            if (!conn?.componentId || conn.pinNumber == null) continue;
            // Skip net-label "components" — they define the net name, not a physical pin
            const comp = schematicApp.components.find(c => c.id === conn.componentId);
            if (comp && comp.definition?.name === 'Net') continue;
            pinSet.add(`${conn.componentId}:${conn.pinNumber}`);
            wiredPins.add(`${conn.componentId}:${conn.pinNumber}`);
        }
    }

    // Convert to array form
    /** @type {NetlistEntry[]} */
    const netlist = [];
    for (const [net, pinSet] of netMap) {
        const pins = [];
        for (const key of pinSet) {
            const [componentId, pinNumber] = key.split(':');
            pins.push({ componentId, pinNumber });
        }
        netlist.push({ net, pins });
    }

    // Default nets for unconnected pins. A pin with no wire still belongs to a
    // net of its own, named "<Reference>.<PinNumber>" (e.g. R1.2). These are
    // single-pin nets — they carry the pad's net identity (used for pad/track
    // net inheritance and DRC clearance) but produce no rat line.
    for (const comp of schematicApp.components) {
        if (!comp.definition) continue;
        if (comp.definition.name === 'Net' || comp.definition.name === 'NoConnect') continue;
        const reference = comp.reference || 'U?';
        for (const pin of (comp.symbol?.pins || [])) {
            if (pin.number == null) continue;
            const pinNumber = String(pin.number);
            if (wiredPins.has(`${comp.id}:${pinNumber}`)) continue;
            netlist.push({ net: `${reference}.${pinNumber}`, pins: [{ componentId: comp.id, pinNumber }] });
        }
    }

    return netlist;
}

/**
 * Build a component summary from the schematic for footprint placement.
 *
 * @param {SchematicState|null|undefined} schematicApp - Schematic state exposing shapes and components.
 * @returns {Array<{id: string, reference: string, value: string, footprint: string, pins: Array<{number: string, name: string}>}>}
 */
export function extractComponents(schematicApp) {
    if (!schematicApp?.components) return [];

    /** @type {Array<{id: string, reference: string, value: string, footprint: string, footprintShapes:ComponentDefinition['footprintShapes'], footprintBBox:ComponentDefinition['footprintBBox'], source:string, model3dObj:string|null, model3dUrl:string|null, pins: Array<{number: string, name: string}>}>} */
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
