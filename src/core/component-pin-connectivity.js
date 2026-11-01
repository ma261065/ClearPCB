/** @typedef {{x:number,y:number}} Point */
/** @typedef {{number?:string|number|null, hidden?:boolean, x?:number, y?:number}} SymbolPin */
/** @typedef {{id:string, reference?:string, definition?:{name?:string}|null, symbol?:{pins?:SymbolPin[]}|null, localToWorld?: (x:number,y:number) => Point}} PinComponent */
/** @typedef {{component:PinComponent,pin:SymbolPin,key:string,point:Point}} ComponentPinContact */
/** @typedef {{id?:string,type?:string,x?:number,y?:number,visible?:boolean,pinConnection?:{componentId:string,pinNumber:string|number}|null}} NetLabel */
/** @typedef {{values():Iterable<Point>, get(key:string):Point|undefined}} WireNodeMap */
/** @typedef {{values():Iterable<{from:string,to:string}>}} WireEdgeMap */
/** @typedef {NetLabel & {nodes?:WireNodeMap|null, edges?:WireEdgeMap|null}} WireShape */

export const SCHEMATIC_CONNECTION_TOLERANCE = 0.15;

/** @param {PinComponent} component */
const isPhysicalComponent = component => !!component?.definition
    && !['Net', 'NoConnect'].includes(component.definition.name || '');

/** @param {PinComponent[]|null|undefined} components */
function collectPhysicalPins(components) {
    /** @type {ComponentPinContact[]} */
    const contacts = [];
    for (const component of components || []) {
        if (!isPhysicalComponent(component) || !component.localToWorld) continue;
        for (const pin of component.symbol?.pins || []) {
            if (pin.number == null || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) continue;
            contacts.push({
                component,
                pin,
                key: `${component.id}:${pin.number}`,
                point: component.localToWorld(/** @type {number} */ (pin.x), /** @type {number} */ (pin.y)),
            });
        }
    }
    return contacts;
}

/**
 * Find visible NetLabels directly contacting physical component pins.
 * @param {PinComponent[]|null|undefined} components
 * @param {NetLabel[]|null|undefined} labels
 * @param {number} [tolerance]
 */
export function collectDirectPinLabelContacts(
    components,
    labels,
    tolerance = SCHEMATIC_CONNECTION_TOLERANCE,
) {
    return collectDirectPinMarkerContacts(components, labels, 'net', tolerance);
}

/**
 * Find visible No Connect markers on physical pins, respecting explicit bonds.
 * Legacy unbonded markers use the same physical contact tolerance as NetLabels.
 * @param {PinComponent[]|null|undefined} components
 * @param {NetLabel[]|null|undefined} markers
 * @param {number} [tolerance]
 */
export function collectDirectPinNoConnectContacts(
    components,
    markers,
    tolerance = SCHEMATIC_CONNECTION_TOLERANCE,
) {
    return collectDirectPinMarkerContacts(components, markers, 'noconnect', tolerance);
}

/**
 * Find visible No Connect markers sitting on a wire node or segment.
 * Purely geometric: the marker is not bonded to the wire and the contact
 * never creates an electrical connection.
 * @param {WireShape[]|null|undefined} shapes
 * @param {number} [tolerance]
 * @returns {{label:NetLabel,point:Point}[]}
 */
export function collectDirectWireNoConnectContacts(
    shapes,
    tolerance = SCHEMATIC_CONNECTION_TOLERANCE,
) {
    if (!(tolerance > 0)) return [];
    const all = shapes || [];
    const wires = all.filter(shape => shape.type === 'wire');
    if (!wires.length) return [];
    return all.filter(shape => shape.type === 'noconnect' && shape.visible !== false
        && Number.isFinite(shape.x) && Number.isFinite(shape.y))
        .flatMap(label => {
            const point = nearestWirePoint(wires, {
                x: /** @type {number} */ (label.x),
                y: /** @type {number} */ (label.y),
            }, tolerance);
            return point ? [{ label: /** @type {NetLabel} */ (label), point }] : [];
        });
}

/**
 * Closest point on any wire node or segment within tolerance of target.
 * @param {WireShape[]} wires
 * @param {Point} target
 * @param {number} tolerance
 * @returns {Point|null}
 */
function nearestWirePoint(wires, target, tolerance) {
    /** @type {Point|null} */
    let best = null;
    let bestDistance = tolerance;
    for (const wire of wires) {
        for (const node of wire.nodes?.values() || []) {
            const distance = Math.hypot(node.x - target.x, node.y - target.y);
            if (distance < bestDistance) { bestDistance = distance; best = { x: node.x, y: node.y }; }
        }
        for (const edge of wire.edges?.values() || []) {
            const from = wire.nodes?.get(edge.from), to = wire.nodes?.get(edge.to);
            if (!from || !to) continue;
            const dx = to.x - from.x, dy = to.y - from.y;
            const lengthSq = dx * dx + dy * dy;
            if (!lengthSq) continue;
            const t = Math.max(0, Math.min(1,
                ((target.x - from.x) * dx + (target.y - from.y) * dy) / lengthSq));
            const x = from.x + t * dx, y = from.y + t * dy;
            const distance = Math.hypot(x - target.x, y - target.y);
            if (distance < bestDistance) { bestDistance = distance; best = { x, y }; }
        }
    }
    return best;
}

/** @param {PinComponent[]|null|undefined} components
 * @param {NetLabel[]|null|undefined} labels
 * @param {string} type
 * @param {number} tolerance
 */
function collectDirectPinMarkerContacts(components, labels, type, tolerance) {
    if (!(tolerance > 0)) return [];
    const pins = collectPhysicalPins(components);
    const visibleLabels = (labels || []).filter(label => label.type === type && label.visible !== false
        && Number.isFinite(label.x) && Number.isFinite(label.y));
    return visibleLabels.flatMap(label => pins.filter(pin =>
        (type !== 'noconnect' || !label.pinConnection
            || label.pinConnection.componentId === pin.component.id
            && String(label.pinConnection.pinNumber) === String(pin.pin.number))
        && (type !== 'noconnect' || !pin.pin.hidden)
        && Math.hypot(pin.point.x - /** @type {number} */ (label.x),
            pin.point.y - /** @type {number} */ (label.y)) < tolerance)
        .map(pin => ({ label, pin, point: pin.point })));
}

/**
 * Group physical component pins that occupy the same schematic point.
 * @param {PinComponent[]|null|undefined} components
 * @param {number} [tolerance]
 * @returns {{point:Point,pins:ComponentPinContact[]}[]}
 */
export function collectCoincidentComponentPins(
    components,
    tolerance = SCHEMATIC_CONNECTION_TOLERANCE,
) {
    const contacts = collectPhysicalPins(components);
    if (contacts.length < 2 || !(tolerance > 0)) return [];

    const parents = contacts.map((_, index) => index);
    /** @param {number} index */
    const find = index => {
        while (parents[index] !== index) {
            parents[index] = parents[parents[index]];
            index = parents[index];
        }
        return index;
    };
    /** @param {number} first @param {number} second */
    const join = (first, second) => {
        const firstRoot = find(first), secondRoot = find(second);
        if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot;
    };
    const cellSize = tolerance;
    /** @type {Map<string, number[]>} */
    const cells = new Map();
    for (let index = 0; index < contacts.length; index++) {
        const { point } = contacts[index];
        const cellX = Math.floor(point.x / cellSize);
        const cellY = Math.floor(point.y / cellSize);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const other of cells.get(`${cellX + dx},${cellY + dy}`) || []) {
                if (contacts[other].component === contacts[index].component) continue;
                const otherPoint = contacts[other].point;
                if (Math.hypot(point.x - otherPoint.x, point.y - otherPoint.y) < tolerance) {
                    join(index, other);
                }
            }
        }
        const key = `${cellX},${cellY}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key)?.push(index);
    }

    /** @type {Map<number, ComponentPinContact[]>} */
    const grouped = new Map();
    for (let index = 0; index < contacts.length; index++) {
        const root = find(index);
        if (!grouped.has(root)) grouped.set(root, []);
        grouped.get(root)?.push(contacts[index]);
    }
    return [...grouped.values()]
        .filter(pins => pins.length > 1)
        .map(pins => ({
            point: {
                x: pins.reduce((sum, pin) => sum + pin.point.x, 0) / pins.length,
                y: pins.reduce((sum, pin) => sum + pin.point.y, 0) / pins.length,
            },
            pins,
        }));
}
