/**
 * One control order for every Properties panel (PCB and schematic), so a property
 * sits in the same place whichever object is selected. Panels only show the rows
 * that apply; whatever is shown follows this order.
 *
 * Controls that decide which other controls apply come first: Locked disables the
 * rest, Layer decides whether Copper Mode and Net exist, Copper Mode decides Net,
 * Fill decides whether a line width exists.
 */
export const PROPERTY_ORDER = Object.freeze([
    // 1. Editability
    'locked',
    // 2. What the object is
    'reference', 'showReference', 'refVisible', 'value', 'showValue', 'text', 'insert', 'padShape', 'shapeKind', 'outline',
    'source', 'supplierPartNumber', 'packageId',
    // 3-5. Where it is and what it connects to
    'layer', 'copperMode', 'net',
    // 6. Fill and holes
    'fill', 'plated',
    // 7. Position and size
    'x', 'y', 'width', 'height', 'size', 'ratio', 'fontSize', 'diameter', 'drill',
    // 8. Line and corners. A stroked circle's outer diameter includes the line
    // width, so it follows the width it depends on.
    'lineWidth', 'outerDiameter', 'cornerRadius', 'bulge',
    // 9. Orientation
    'rotation', 'flipHorizontal', 'flipVertical', 'orientation',
    // 10. Appearance
    'border', 'invert', 'style',
]);

const RANK = new Map(PROPERTY_ORDER.map((key, index) => [key, index]));

/**
 * Position of a property key in the canonical order; unknown keys sort last.
 * @param {string|undefined} key
 * @returns {number}
 */
export function propertyRank(key) {
    const rank = key === undefined ? undefined : RANK.get(key);
    return rank ?? PROPERTY_ORDER.length;
}

/**
 * Stable sort of items into the canonical property order.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string|undefined} [keyOf]
 * @returns {T[]}
 */
export function sortByPropertyOrder(items, keyOf = item => /** @type {any} */ (item).key) {
    return items
        .map((item, index) => ({ item, index, rank: propertyRank(keyOf(item)) }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(entry => entry.item);
}
