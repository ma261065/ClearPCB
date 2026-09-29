/** Layers on which free-standing PCB text may be placed. */
export const TEXT_LAYERS = ['top-silk', 'bottom-silk', 'top-copper', 'bottom-copper', 'top-document', 'bottom-document'];

/**
 * @param {Partial<{id:string, content:string, x:number, y:number,
 *   size:number, rotation:number, layer:string, strokeWidth:number, border:boolean}>} opts
 */
export function createPcbText(opts = {}) {
    return {
        id: opts.id || `text-${Math.random().toString(36).slice(2, 10)}`,
        content: opts.content ?? 'Text',
        x: opts.x ?? 0,
        y: opts.y ?? 0,
        size: opts.size ?? 1.0,
        rotation: opts.rotation ?? 0,
        layer: TEXT_LAYERS.includes(opts.layer) ? opts.layer : 'top-silk',
        strokeWidth: opts.strokeWidth ?? 0.15,
        border: !!opts.border,
    };
}

/** Full-precision snapshot for undo and clipboard; file rounding belongs to PcbDocument. */
export function serializePcbText(text) {
    const saved = {
        id: text.id,
        content: text.content,
        x: text.x,
        y: text.y,
        size: text.size,
        rotation: text.rotation,
        layer: text.layer,
        strokeWidth: text.strokeWidth,
    };
    if (text.border) saved.border = true;
    return saved;
}
