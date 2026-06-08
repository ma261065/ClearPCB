/**
 * Assembly export for ClearPCB: Bill of Materials (BOM) and
 * Pick-and-Place (centroid) files.
 *
 * Both outputs are plain CSV so they import cleanly into spreadsheets and
 * the assembly tools used by board houses (JLCPCB, PCBWay, etc.).
 *
 * Coordinate system: ClearPCB stores placement geometry in SVG-Y-down
 * millimetres (positive Y points down on screen). Pick-and-place files use
 * the conventional Y-up board space, so the centroid exporter negates every
 * Y value at emission time — matching the Gerber exporter's convention.
 */

/**
 * Quote a CSV field if it contains a comma, quote, or newline. Embedded
 * quotes are doubled per RFC 4180.
 * @param {string|number} value
 * @returns {string}
 */
function csvField(value) {
    const s = String(value ?? '');
    if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

/**
 * Join a row of fields into a CSV line.
 * @param {Array<string|number>} fields
 * @returns {string}
 */
function csvRow(fields) {
    return fields.map(csvField).join(',');
}

/**
 * Natural-order comparison for reference designators so that "R2" sorts
 * before "R10" (numeric suffixes compared as numbers, not strings).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareRefs(a, b) {
    const ma = /^([^\d]*)(\d*)$/.exec(a) || [a, a, ''];
    const mb = /^([^\d]*)(\d*)$/.exec(b) || [b, b, ''];
    if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
    const na = ma[2] === '' ? -1 : parseInt(ma[2], 10);
    const nb = mb[2] === '' ? -1 : parseInt(mb[2], 10);
    if (na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build a Bill of Materials CSV from the current placements.
 *
 * Identical parts (same value + footprint) are grouped into a single line
 * with an aggregate quantity and a comma-separated designator list.
 *
 * @param {Map<string, {reference?: string, value?: string, footprint?: string}>} placements
 * @returns {string} CSV text (with header row)
 */
export function generateBOM(placements) {
    /** @type {Map<string, {value: string, footprint: string, refs: string[]}>} */
    const groups = new Map();

    for (const [, pl] of placements) {
        const value = pl.value || '';
        const footprint = pl.footprint || '';
        const reference = pl.reference || '';
        const key = `${value}\u0000${footprint}`;
        let g = groups.get(key);
        if (!g) {
            g = { value, footprint, refs: [] };
            groups.set(key, g);
        }
        if (reference) g.refs.push(reference);
    }

    const lines = ['Item,Quantity,Value,Footprint,Designators'];
    const sorted = [...groups.values()].sort((a, b) => {
        if (a.value !== b.value) return a.value < b.value ? -1 : 1;
        return a.footprint < b.footprint ? -1 : a.footprint > b.footprint ? 1 : 0;
    });

    let item = 1;
    for (const g of sorted) {
        const refs = g.refs.sort(compareRefs);
        lines.push(csvRow([item, refs.length, g.value, g.footprint, refs.join(', ')]));
        item++;
    }

    return lines.join('\r\n') + '\r\n';
}

/**
 * Build a Pick-and-Place (centroid) CSV from the current placements.
 *
 * Coordinates are the component centre (placement origin), emitted in Y-up
 * millimetres. Rotation is in degrees. Layer is reported as Top/Bottom.
 *
 * @param {Map<string, {reference?: string, value?: string, footprint?: string, x?: number, y?: number, rotation?: number, side?: string}>} placements
 * @returns {string} CSV text (with header row)
 */
export function generatePickAndPlace(placements) {
    const lines = ['Designator,Val,Package,Mid X,Mid Y,Rotation,Layer'];

    const rows = [...placements.values()].sort((a, b) =>
        compareRefs(a.reference || '', b.reference || ''));

    for (const pl of rows) {
        const layer = pl.side === 'bottom' ? 'Bottom' : 'Top';
        const x = (pl.x || 0).toFixed(4);
        // App stores Y-down; pick-and-place files are Y-up.
        const y = (-(pl.y || 0)).toFixed(4);
        const rot = ((pl.rotation || 0) % 360).toFixed(2);
        lines.push(csvRow([
            pl.reference || '',
            pl.value || '',
            pl.footprint || '',
            x, y, rot, layer,
        ]));
    }

    return lines.join('\r\n') + '\r\n';
}
