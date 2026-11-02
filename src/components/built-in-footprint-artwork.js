/**
 * Create a visible top-silkscreen perimeter around a built-in footprint.
 * The margin keeps the stroke outside the footprint's authored pad/body bounds.
 * @param {{x:number, y:number, width:number, height:number}} box
 * @param {number} [margin]
 * @returns {string[]}
 */
export function builtInSilkOutline(box, margin = 0.2) {
    const x1 = box.x - margin;
    const y1 = box.y - margin;
    const x2 = box.x + box.width + margin;
    const y2 = box.y + box.height + margin;
    /** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
    const line = (ax, ay, bx, by) => `SILK~LINE~${ax}~${ay}~${bx}~${by}~0.15~top`;
    return [
        line(x1, y1, x2, y1),
        line(x2, y1, x2, y2),
        line(x2, y2, x1, y2),
        line(x1, y2, x1, y1),
    ];
}
