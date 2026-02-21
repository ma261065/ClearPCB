/**
 * Shared UI helpers for SVG rendering used by Shape and Component.
 */

const NS = 'http://www.w3.org/2000/svg';
export const LOCK_SIZE = 1.2;   // world units
const LOCK_STROKE = 0.2;

/**
 * Create a lock-icon SVG group with click-to-unlock behaviour.
 * @param {number} x       Left edge of the lock body in local coordinates
 * @param {number} y       Top edge of the lock (above the body)
 * @param {object} item    Shape or Component that owns the lock
 * @param {string} cls     CSS class name for the group
 * @returns {SVGGElement}
 */
export function createLockIcon(x, y, item, cls) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', cls);
    g.style.cursor = 'pointer';

    const bodyW = LOCK_SIZE;
    const bodyH = LOCK_SIZE * 0.7;
    const bodyY = y + bodyH * 0.25;

    // Invisible hit area (slightly larger for easier clicking)
    const pad = LOCK_SIZE * 0.15;
    const hit = document.createElementNS(NS, 'rect');
    hit.setAttribute('x', x - pad);
    hit.setAttribute('y', y - pad);
    hit.setAttribute('width', bodyW + pad * 2);
    hit.setAttribute('height', bodyH + LOCK_SIZE * 0.5 + pad);
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('stroke', 'none');
    g.appendChild(hit);

    // Body
    const body = document.createElementNS(NS, 'rect');
    body.setAttribute('x', x);
    body.setAttribute('y', bodyY);
    body.setAttribute('width', bodyW);
    body.setAttribute('height', bodyH);
    body.setAttribute('rx', LOCK_SIZE * 0.12);
    body.setAttribute('fill', 'var(--lock-icon, #666666)');
    body.setAttribute('stroke', 'var(--lock-icon, #666666)');
    body.setAttribute('stroke-width', LOCK_STROKE);
    g.appendChild(body);

    // Shackle
    const r = bodyW * 0.35;
    const shackleY = y + bodyH * 0.25;
    const cx = x + bodyW / 2;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M ${cx - r} ${shackleY} A ${r} ${r} 0 0 1 ${cx + r} ${shackleY}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--lock-icon, #666666)');
    path.setAttribute('stroke-width', LOCK_STROKE);
    g.appendChild(path);

    // Click-to-unlock
    g.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); });
    g.addEventListener('click', (e) => {
        e.stopPropagation();
        item.element.dispatchEvent(new CustomEvent('unlock-shape', {
            bubbles: true,
            detail: { shape: item }
        }));
    });

    return g;
}
