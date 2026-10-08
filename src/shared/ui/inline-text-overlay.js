const SVG_NS = 'http://www.w3.org/2000/svg';
const BLINK_MS = 530;
const ACTIVE_HOLD_MS = 400;

/** @typedef {import('../../core/Viewport.js').Point} Point */
/** @typedef {{x: number, y: number, width: number, height: number, caretX: number, caretTop?: number, caretBottom?: number, transform?: string}} InlineTextOverlayGeometry */
/** @typedef {{start: Point|null, end: Point|null}} TextConnectionGuide */
/** @typedef {{group: SVGGElement, box: SVGRectElement, caret: SVGLineElement, blinkEpoch: number, forceVisibleUntil: number, releasePending: boolean, blinkTimer: number|null, keepCaretVisible: () => void, updateGeometry: (geometry: InlineTextOverlayGeometry) => boolean, raise: () => void, destroy: () => void}} InlineTextOverlay */

/**
 * @param {HTMLInputElement|null|undefined} input
 * @param {boolean} active
 */
export function setInlineTextInputActive(input, active) {
    if (!input) return;
    input.readOnly = !active;
    if (!active) {
        if (document.activeElement === input) input.blur();
        return;
    }
    setTimeout(() => {
        if (input.isConnected && !input.readOnly) input.focus();
    }, 0);
}

/**
 * @param {(group: SVGGElement) => void} append
 * @param {{emphasized?: boolean}} [options]
 * @returns {InlineTextOverlay}
 */
export function createInlineTextOverlay(append, { emphasized = false } = {}) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'text-edit-overlay');
    group.setAttribute('pointer-events', 'none');

    const box = document.createElementNS(SVG_NS, 'rect');
    box.setAttribute('fill', emphasized ? 'var(--accent-color, #00ccff)' : 'none');
    if (emphasized) box.setAttribute('fill-opacity', '0.12');
    box.setAttribute('stroke', 'var(--accent-color, #00ccff)');
    box.setAttribute('stroke-width', emphasized ? '3' : '2');
    box.setAttribute('stroke-opacity', emphasized ? '1' : '0.5');
    if (emphasized) box.setAttribute('stroke-dasharray', '7 4');
    box.setAttribute('vector-effect', 'non-scaling-stroke');

    const caret = document.createElementNS(SVG_NS, 'line');
    caret.setAttribute('stroke', 'var(--accent-color, #00ccff)');
    caret.setAttribute('stroke-width', '2');
    caret.setAttribute('vector-effect', 'non-scaling-stroke');
    caret.setAttribute('stroke-linecap', 'butt');
    caret.style.opacity = '1';

    group.appendChild(box);
    group.appendChild(caret);
    append(group);

    /** @type {InlineTextOverlay} */
    const overlay = {
        group,
        box,
        caret,
        blinkEpoch: performance.now(),
        forceVisibleUntil: 0,
        releasePending: false,
        blinkTimer: null,
        keepCaretVisible() {
            this.forceVisibleUntil = performance.now() + ACTIVE_HOLD_MS;
            this.caret.style.opacity = '1';
        },
        updateGeometry({
            x,
            y,
            width,
            height,
            caretX,
            caretTop = y,
            caretBottom = y + height,
            transform = '',
        }) {
            const values = [x, y, width, height, caretX, caretTop, caretBottom];
            if (values.some(value => !Number.isFinite(value)) || width < 0 || height < 0) {
                this.group.style.display = 'none';
                return false;
            }

            this.group.style.display = '';
            if (transform) this.group.setAttribute('transform', transform);
            else this.group.removeAttribute('transform');
            this.box.setAttribute('x', String(x));
            this.box.setAttribute('y', String(y));
            this.box.setAttribute('width', String(width));
            this.box.setAttribute('height', String(height));

            this.caret.setAttribute('x1', String(caretX));
            this.caret.setAttribute('x2', String(caretX));
            this.caret.setAttribute('y1', String(caretTop));
            this.caret.setAttribute('y2', String(caretBottom));
            this.raise();
            return true;
        },
        raise() {
            if (this.group.parentNode) this.group.parentNode.appendChild(this.group);
        },
        destroy() {
            if (this.blinkTimer) clearInterval(this.blinkTimer);
            this.blinkTimer = null;
            this.group.remove();
        },
    };

    overlay.blinkTimer = setInterval(() => {
        const now = performance.now();
        const beat = (Math.floor((now - overlay.blinkEpoch) / BLINK_MS) % 2) === 0;
        let on = beat;
        if (now < overlay.forceVisibleUntil) {
            on = true;
            overlay.releasePending = true;
        } else if (overlay.releasePending) {
            on = true;
            if (beat) overlay.releasePending = false;
        }
        overlay.caret.style.opacity = on ? '1' : '0';
    }, 60);

    return overlay;
}

/**
 * @param {SVGLineElement} line
 * @param {TextConnectionGuide} connection
 * @param {string} [stroke]
 */
export function applyTextConnectionGuide(line, connection, stroke = 'var(--accent-color, #00ccff)') {
    // Callers build a guide only for complete connections; their temporary variables remain nullable.
    const end = /** @type {Point} */ (connection.end);
    const start = /** @type {Point} */ (connection.start);
    line.setAttribute('x1', String(end.x));
    line.setAttribute('y1', String(end.y));
    line.setAttribute('x2', String(start.x));
    line.setAttribute('y2', String(start.y));
    line.setAttribute('stroke', stroke);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-dasharray', '3 3');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.setAttribute('pointer-events', 'none');
}
