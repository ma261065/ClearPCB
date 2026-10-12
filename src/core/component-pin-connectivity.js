/** @typedef {{x:number,y:number}} Point */
/** @typedef {{number?:string|number|null, hidden?:boolean, x?:number, y?:number}} SymbolPin */
/** @typedef {{id:string, reference?:string, definition?:{name?:string}|null, symbol?:{pins?:SymbolPin[]}|null, localToWorld?: (x:number,y:number) => Point}} PinComponent */
/** @typedef {{component:PinComponent,pin:SymbolPin,key:string,point:Point}} ComponentPinContact */
/** @typedef {{id?:string,type?:string,x?:number,y?:number,visible?:boolean}} NetLabel */

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
    if (!(tolerance > 0)) return [];
    const pins = collectPhysicalPins(components);
    const visibleLabels = (labels || []).filter(label => label.type === 'net' && label.visible !== false
        && Number.isFinite(label.x) && Number.isFinite(label.y));
    return visibleLabels.flatMap(label => pins.filter(pin =>
        Math.hypot(pin.point.x - /** @type {number} */ (label.x),
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
