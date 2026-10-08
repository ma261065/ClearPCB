/** Layers on which free-standing PCB text may be placed. */
export const TEXT_LAYERS = ['top-silk', 'bottom-silk', 'top-copper', 'bottom-copper', 'top-document', 'bottom-document'];

/** @typedef {{id: string, content: string, x: number, y: number, size: number, rotation: number, layer: string, strokeWidth: number, border: boolean, locked?: boolean}} PcbText */

/**
 * @param {Partial<{id:string, content:string, x:number, y:number,
 *   size:number, rotation:number, layer:string, strokeWidth:number, border:boolean,
 *   locked:boolean}>} opts
 * @returns {PcbText}
 */
export function createPcbText(opts = {}) {
    return {
        id: opts.id || `text-${Math.random().toString(36).slice(2, 10)}`,
        content: opts.content ?? 'Text',
        x: opts.x ?? 0,
        y: opts.y ?? 0,
        size: opts.size ?? 1.0,
        rotation: opts.rotation ?? 0,
        layer: typeof opts.layer === 'string' && TEXT_LAYERS.includes(opts.layer) ? opts.layer : 'top-silk',
        strokeWidth: opts.strokeWidth ?? 0.15,
        border: !!opts.border,
        ...(opts.locked ? { locked: true } : {}),
    };
}

/** Full-precision snapshot for undo and clipboard; file rounding belongs to PcbDocument. */
/** @param {PcbText} text @returns {Partial<PcbText> & {id: string, content: string, x: number, y: number, size: number, rotation: number, layer: string, strokeWidth: number}} */
export function serializePcbText(text) {
    const saved = /** @type {Partial<PcbText> & {id: string, content: string, x: number, y: number, size: number, rotation: number, layer: string, strokeWidth: number}} */ ({
        id: text.id,
        content: text.content,
        x: text.x,
        y: text.y,
        size: text.size,
        rotation: text.rotation,
        layer: text.layer,
        strokeWidth: text.strokeWidth,
    });
    if (text.border) saved.border = true;
    if (text.locked) saved.locked = true;
    return saved;
}
