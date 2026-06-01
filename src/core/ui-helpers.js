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
    hit.setAttribute('x', String(x - pad));
    hit.setAttribute('y', String(y - pad));
    hit.setAttribute('width', String(bodyW + pad * 2));
    hit.setAttribute('height', String(bodyH + LOCK_SIZE * 0.5 + pad));
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('stroke', 'none');
    g.appendChild(hit);

    // Body
    const body = document.createElementNS(NS, 'rect');
    body.setAttribute('x', String(x));
    body.setAttribute('y', String(bodyY));
    body.setAttribute('width', String(bodyW));
    body.setAttribute('height', String(bodyH));
    body.setAttribute('rx', String(LOCK_SIZE * 0.12));
    body.setAttribute('fill', 'var(--lock-icon, #666666)');
    body.setAttribute('stroke', 'var(--lock-icon, #666666)');
    body.setAttribute('stroke-width', String(LOCK_STROKE));
    g.appendChild(body);

    // Shackle
    const r = bodyW * 0.35;
    const shackleY = y + bodyH * 0.25;
    const cx = x + bodyW / 2;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M ${cx - r} ${shackleY} A ${r} ${r} 0 0 1 ${cx + r} ${shackleY}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--lock-icon, #666666)');
    path.setAttribute('stroke-width', String(LOCK_STROKE));
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

/**
 * Build the full anchors SVG group for a points-based shape (Line, Polygon).
 * Renders point anchors as white/red squares and midpoint anchors as white/blue
 * circles with a "+" sign.
 *
 * @param {object} shape   Shape instance (must have getAnchors(), locked, element)
 * @param {number} scale   Current viewport scale
 */
export function buildPointAnchorsGroup(shape, scale) {
    const anchors = shape.getAnchors();
    const pointAnchors = anchors.filter(a => !a.midpoint);
    const midAnchors = anchors.filter(a => a.midpoint);
    const size = 8 / scale;
    const midR = 5.5 / scale;
    const strokeW = 1 / scale;

    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'shape-anchors');
    const rects = [];

    // Regular point anchors (squares)
    for (const anchor of pointAnchors) {
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String(anchor.x - size / 2));
        rect.setAttribute('y', String(anchor.y - size / 2));
        rect.setAttribute('width', String(size));
        rect.setAttribute('height', String(size));
        rect.setAttribute('fill', '#fff');
        rect.setAttribute('stroke', '#e94560');
        rect.setAttribute('stroke-width', String(strokeW));
        rect.setAttribute('data-anchor-id', anchor.id);
        g.appendChild(rect);
        rects.push(rect);
    }

    // Midpoint anchors (circle with +)
    for (const anchor of midAnchors) {
        const mg = document.createElementNS(NS, 'g');
        mg.setAttribute('data-anchor-id', anchor.id);

        const circle = document.createElementNS(NS, 'circle');
        circle.setAttribute('cx', String(anchor.x));
        circle.setAttribute('cy', String(anchor.y));
        circle.setAttribute('r', String(midR));
        circle.setAttribute('fill', '#fff');
        circle.setAttribute('stroke', '#4aa3df');
        circle.setAttribute('stroke-width', String(strokeW));
        mg.appendChild(circle);

        const plusLen = midR * 1.1;
        const plusH = document.createElementNS(NS, 'line');
        plusH.setAttribute('x1', String(anchor.x - plusLen));
        plusH.setAttribute('y1', String(anchor.y));
        plusH.setAttribute('x2', String(anchor.x + plusLen));
        plusH.setAttribute('y2', String(anchor.y));
        plusH.setAttribute('stroke', '#4aa3df');
        plusH.setAttribute('stroke-width', String(strokeW * 1.5));
        plusH.setAttribute('stroke-linecap', 'round');
        mg.appendChild(plusH);

        const plusV = document.createElementNS(NS, 'line');
        plusV.setAttribute('x1', String(anchor.x));
        plusV.setAttribute('y1', String(anchor.y - plusLen));
        plusV.setAttribute('x2', String(anchor.x));
        plusV.setAttribute('y2', String(anchor.y + plusLen));
        plusV.setAttribute('stroke', '#4aa3df');
        plusV.setAttribute('stroke-width', String(strokeW * 1.5));
        plusV.setAttribute('stroke-linecap', 'round');
        mg.appendChild(plusV);

        g.appendChild(mg);
    }

    // Lock icon when locked
    if (shape.locked && pointAnchors.length > 0) {
        const primary = pointAnchors[0];
        const offset = 0.6;
        const lockX = primary.x + offset;
        const lockY = primary.y - offset - LOCK_SIZE * 0.6;
        g.appendChild(createLockIcon(lockX, lockY, shape, 'lock-icon'));
    }

    return { group: g, rects };
}

/**
 * Escape a string for safe interpolation into HTML/SVG markup (innerHTML).
 * Prevents XSS when rendering untrusted text such as error messages or
 * data fetched from remote APIs.
 * @param {*} str
 * @returns {string}
 */
export function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Validate a URL intended to be used as an image source (e.g. remote
 * thumbnails from LCSC/EasyEDA). Returns the URL if it uses a safe scheme
 * and (for http/https) an allowed host, otherwise null.
 * @param {*} url
 * @param {string[]} [allowedHostSuffixes] Permitted host suffixes for http(s) URLs.
 * @returns {string|null}
 */
export function sanitizeImageUrl(url, allowedHostSuffixes = ['lceda.cn', 'easyeda.com', 'lcsc.com', 'gitlab.com']) {
    if (typeof url !== 'string' || !url) return null;
    let u;
    try {
        u = new URL(url, window.location.href);
    } catch {
        return null;
    }
    if (u.protocol === 'data:') {
        return /^data:image\//i.test(u.href) ? url : null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase();
    const ok = allowedHostSuffixes.some(suffix => host === suffix || host.endsWith('.' + suffix));
    return ok ? url : null;
}
