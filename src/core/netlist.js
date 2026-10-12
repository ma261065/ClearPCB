/**
 * Shared project queries: net-to-pin mappings and component placement data.
 *
 * Walks all Wire shapes and their pinConnections to determine which
 * component pins share electrical connectivity (same net).
 *
 * Net labels directly touching component pins name those pins and their
 * connected wire nets, without needing an extra wire.
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
/** @typedef {{id?:string, type?:string, net?:string, x?:number, y?:number, nodes?:{values:() => IterableIterator<{x:number,y:number}>}, captureState?: () => object, pinConnections?:Map<string|number, PinConnection>|Iterable<[string|number, PinConnection]>}} NetShape */
/** @typedef {{number?:string|number|null, name?:string, x?:number, y?:number}} SymbolPin */
/** @typedef {import('../components/Component.js').ComponentDefinition} ComponentDefinition */
/** @typedef {{pins?:SymbolPin[], _source?:string}} ComponentSymbol */
/** @typedef {{id:string, reference?:string, value?:string, definition?:ComponentDefinition|null, symbol?:ComponentSymbol|null, localToWorld?: (x:number,y:number) => {x:number,y:number}}} SchematicComponent */
/** @typedef {{shapes?:NetShape[], components?:SchematicComponent[]}} SchematicState */

/** Matches the schematic pin/wire attachment tolerance. */
export const SCHEMATIC_CONNECTION_TOLERANCE = 0.15;

/**
 * Extract a netlist from the schematic document's current state.
 *
 * @param {SchematicState|null|undefined} schematicApp - Schematic state exposing shapes and components.
 * @returns {NetlistEntry[]} Array of nets, each with a name and pin list
 */
export function extractNetlist(schematicApp) {
    if (!schematicApp?.shapes || !schematicApp?.components) return [];

    const components = new Map(schematicApp.components.map(component => [component.id, component]));
    const labels = schematicApp.shapes.filter(shape => shape.type === 'net' && shape.net
        && Number.isFinite(shape.x) && Number.isFinite(shape.y));
    const labelIds = new Set(schematicApp.shapes.filter(shape => shape.type === 'net').map(label => label.id));
    /** @type {Map<string, {net:string, point:{x:number,y:number}}>} */
    const labeledPins = new Map();
    for (const component of labels.length ? schematicApp.components : []) {
        if (!component.localToWorld || !component.definition
            || ['Net', 'NoConnect'].includes(component.definition.name)) continue;
        for (const pin of component.symbol?.pins || []) {
            if (pin.number == null || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) continue;
            const point = component.localToWorld(/** @type {number} */ (pin.x), /** @type {number} */ (pin.y));
            for (const label of labels) {
                if (Math.hypot(point.x - /** @type {number} */ (label.x),
                    point.y - /** @type {number} */ (label.y)) >= SCHEMATIC_CONNECTION_TOLERANCE) continue;
                const key = `${component.id}:${pin.number}`;
                const previous = labeledPins.get(key);
                if (previous && previous.net !== label.net) {
                    throw new Error(`Conflicting Net labels "${previous.net}" and "${label.net}" on ${component.reference || component.id}.${pin.number}.`);
                }
                labeledPins.set(key, { net: /** @type {string} */ (label.net), point });
            }
        }
    }

    // Map: wire net name → physical component-pin identities.
    /** @type {Map<string, Set<string>>} */
    const wireNets = new Map();
    const wiredPins = new Set();

    for (const shape of schematicApp.shapes) {
        if (shape.type !== 'wire' || !shape.pinConnections) continue;

        const netName = shape.net || 'unconnected';
        if (!wireNets.has(netName)) wireNets.set(netName, new Set());
        const pinSet = /** @type {Set<string>} */ (wireNets.get(netName));

        for (const [, conn] of shape.pinConnections) {
            if (!conn?.componentId || conn.pinNumber == null) continue;
            // Skip net-label "components" — they define the net name, not a physical pin
            const comp = components.get(conn.componentId);
            if (labelIds.has(conn.componentId) || ['Net', 'NoConnect'].includes(comp?.definition?.name || '')) continue;
            pinSet.add(`${conn.componentId}:${conn.pinNumber}`);
            wiredPins.add(`${conn.componentId}:${conn.pinNumber}`);
        }
        // A Net label can own the wire's node attachment instead of the
        // coincident component pin. Restore that physical pin in the export.
        for (const [key, { point }] of labeledPins) {
            if (![...(shape.nodes?.values() || [])].some(node =>
                Math.hypot(node.x - point.x, node.y - point.y) < SCHEMATIC_CONNECTION_TOLERANCE)) continue;
            pinSet.add(key);
            wiredPins.add(key);
        }
    }

    /** @type {Map<string, Set<string>>} */
    const netMap = new Map();
    /** @param {string} name @param {Iterable<string>} pins */
    const addPins = (name, pins) => {
        if (!netMap.has(name)) netMap.set(name, new Set());
        const target = /** @type {Set<string>} */ (netMap.get(name));
        for (const pin of pins) target.add(pin);
    };
    for (const [name, pins] of wireNets) {
        const names = new Set([...pins].map(pin => labeledPins.get(pin)?.net).filter(Boolean));
        if (names.size > 1) {
            throw new Error(`Conflicting Net labels ${[...names].map(net => `"${net}"`).join(' and ')} on connected net "${name}".`);
        }
        addPins(names.size ? /** @type {string} */ ([...names][0]) : name, pins);
    }
    for (const [key, { net }] of labeledPins) {
        if (!wiredPins.has(key)) addPins(net, [key]);
        wiredPins.add(key);
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

    // Default nets for unconnected pins. A pin with no wire or label still belongs to a
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
