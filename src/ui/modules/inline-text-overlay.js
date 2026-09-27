const SVG_NS = 'http://www.w3.org/2000/svg';
const BLINK_MS = 530;
const ACTIVE_HOLD_MS = 400;

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

export function createInlineTextOverlay(append) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'text-edit-overlay');
    group.setAttribute('pointer-events', 'none');

    const box = document.createElementNS(SVG_NS, 'rect');
    box.setAttribute('fill', 'none');
    box.setAttribute('stroke', 'var(--accent-color, #00ccff)');
    box.setAttribute('stroke-width', '2');
    box.setAttribute('stroke-opacity', '0.5');
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

export function applyTextConnectionGuide(line, connection, stroke = 'var(--accent-color, #00ccff)') {
    line.setAttribute('x1', String(connection.end.x));
    line.setAttribute('y1', String(connection.end.y));
    line.setAttribute('x2', String(connection.start.x));
    line.setAttribute('y2', String(connection.start.y));
    line.setAttribute('stroke', stroke);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-dasharray', '3 3');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.setAttribute('pointer-events', 'none');
}
