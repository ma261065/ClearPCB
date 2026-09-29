let padIdCounter = 0;
const round4 = value => Math.round(value * 10000) / 10000;

export const PAD_SHAPES = ['round', 'stadium', 'square', 'rectangle', 'oval'];
export const PAD_LAYERS = ['top-copper', 'bottom-copper', 'both'];

export function resetPadIdCounter() {
    padIdCounter = 0;
}

export function updatePadIdCounter(id) {
    const match = typeof id === 'string' ? id.match(/^pad_(\d+)$/) : null;
    if (match) padIdCounter = Math.max(padIdCounter, Number(match[1]));
}

export class Pad {
    constructor(options = {}) {
        this.id = options.id || `pad_${++padIdCounter}`;
        updatePadIdCounter(this.id);
        this.type = 'pad';
        this.x = Number(options.x) || 0;
        this.y = Number(options.y) || 0;
        this.shape = PAD_SHAPES.includes(options.shape) ? options.shape : 'round';
        this.size = Number.isFinite(options.size) && options.size > 0 ? options.size : 1.5;
        this.drill = Math.min(
            Number.isFinite(options.drill) && options.drill > 0 ? options.drill : 0.8,
            this.size,
        );
        this.ratio = Number.isFinite(options.ratio) && options.ratio >= 1 ? options.ratio : 2;
        this.rotation = ((Number(options.rotation) || 0) % 360 + 360) % 360;
        this.layers = PAD_LAYERS.includes(options.layers) ? options.layers : 'both';
        this.net = typeof options.net === 'string' ? options.net : '';
        this.locked = !!options.locked;
        this.visible = options.visible !== false;
    }

    get width() {
        return ['stadium', 'rectangle', 'oval'].includes(this.shape)
            ? this.size * this.ratio : this.size;
    }

    get height() {
        return this.size;
    }

    move(dx, dy) {
        this.x += dx;
        this.y += dy;
    }

    captureState() {
        return {
            id: this.id, x: this.x, y: this.y, shape: this.shape,
            size: this.size, drill: this.drill, ratio: this.ratio,
            rotation: this.rotation, layers: this.layers, net: this.net,
            locked: this.locked, visible: this.visible,
        };
    }

    applyState(state) {
        Object.assign(this, new Pad({ ...this.captureState(), ...state, id: this.id }));
    }

    clone() {
        return new Pad({ ...this.captureState(), id: undefined });
    }

    toJSON() {
        const out = {
            type: 'pad', id: this.id, x: round4(this.x), y: round4(this.y),
            sh: this.shape, s: round4(this.size), dr: round4(this.drill),
            ls: this.layers,
        };
        if (['stadium', 'rectangle', 'oval'].includes(this.shape)) out.ra = round4(this.ratio);
        if (this.rotation) out.rot = round4(this.rotation);
        if (this.net) out.n = this.net;
        if (this.locked) out.lk = true;
        if (!this.visible) out.v = false;
        return out;
    }

    static fromJSON(data) {
        return new Pad({
            id: data.id, x: data.x, y: data.y, shape: data.sh,
            size: data.s, drill: data.dr, ratio: data.ra,
            rotation: data.rot, layers: data.ls, net: data.n,
            locked: data.lk, visible: data.v,
        });
    }
}
