/** Physical pad geometry in SVG-Y-down millimetres; no rendering or file output. */

function flashShape(pad) {
    if (pad.shape === 'round') return 'circle';
    if (pad.shape === 'oval') return 'ellipse';
    if (pad.shape === 'stadium') return 'oval';
    return 'rect';
}

export function padLayers(pad) {
    if (pad.layers === 'both') return ['top-copper', 'bottom-copper'];
    return [pad.layers];
}

/** Geometric aperture descriptor, also usable with detached plain pad data. */
export function padFlash(pad) {
    const ratio = ['stadium', 'rectangle', 'oval'].includes(pad.shape) ? pad.ratio || 2 : 1;
    return {
        x: pad.x, y: pad.y,
        w: Number.isFinite(pad.width) ? pad.width : pad.size * ratio,
        h: Number.isFinite(pad.height) ? pad.height : pad.size,
        shape: flashShape(pad), rotation: pad.rotation,
        rad: -(pad.rotation || 0) * Math.PI / 180,
    };
}

/** Sample a pad flash; enclosing outlines are conservative pour obstacles. */
export function padFlashOutline(flash, tolerance = 0.001, enclose = false) {
    const halfWidth = flash.w / 2;
    const halfHeight = flash.h / 2;
    const cosine = Math.cos(flash.rad || 0), sine = Math.sin(flash.rad || 0);
    const transform = (x, y) => ({ x: flash.x + x * cosine - y * sine,
        y: flash.y + x * sine + y * cosine });
    if (!['ellipse', 'oval', 'circle', 'round'].includes(flash.shape)) {
        return [[-halfWidth, -halfHeight], [halfWidth, -halfHeight],
            [halfWidth, halfHeight], [-halfWidth, halfHeight]].map(([x, y]) => transform(x, y));
    }
    const radius = Math.min(halfWidth, halfHeight);
    const maxRadius = Math.max(halfWidth, halfHeight);
    const steps = Math.max(16, Math.ceil(Math.PI / Math.acos(1 - Math.min(tolerance / maxRadius, 1)) / 4) * 4);
    const enclosure = enclose ? 1 / Math.cos(Math.PI / steps) : 1;
    if (flash.shape === 'oval' && halfWidth !== halfHeight) {
        const horizontal = halfWidth > halfHeight;
        const offset = maxRadius - radius;
        const start = horizontal ? -Math.PI / 2 : 0;
        const points = [];
        // Include both endpoints of each semicircle so the straight sides meet
        // the caps at their tangencies, rather than cutting across the joins.
        for (const side of [1, -1]) {
            const centreX = horizontal ? side * offset : 0;
            const centreY = horizontal ? 0 : side * offset;
            for (let index = 0; index <= steps / 2; index++) {
                const angle = start + (side === 1 ? 0 : Math.PI) + index * 2 * Math.PI / steps;
                points.push(transform(centreX + radius * enclosure * Math.cos(angle),
                    centreY + radius * enclosure * Math.sin(angle)));
            }
        }
        return points;
    }
    return Array.from({ length: steps }, (_, index) => {
        const angle = index * 2 * Math.PI / steps;
        const horizontal = Math.cos(angle), vertical = Math.sin(angle);
        return transform(halfWidth * enclosure * horizontal, halfHeight * enclosure * vertical);
    });
}

/** Outer copper outline; drill cutouts are handled by each rendering/export consumer. */
export function padOutline(pad) {
    return padFlashOutline(padFlash(pad));
}

export function padBounds(pad) {
    const points = padOutline(pad);
    const radius = pad.drill / 2;
    return {
        minX: Math.min(pad.x - radius, ...points.map(point => point.x)),
        minY: Math.min(pad.y - radius, ...points.map(point => point.y)),
        maxX: Math.max(pad.x + radius, ...points.map(point => point.x)),
        maxY: Math.max(pad.y + radius, ...points.map(point => point.y)),
    };
}

export function padHitTest(pad, point) {
    const angle = (pad.rotation || 0) * Math.PI / 180;
    const dx = point.x - pad.x;
    const dy = point.y - pad.y;
    const x = dx * Math.cos(angle) - dy * Math.sin(angle);
    const y = dx * Math.sin(angle) + dy * Math.cos(angle);
    const ratio = ['stadium', 'rectangle', 'oval'].includes(pad.shape) ? pad.ratio || 2 : 1;
    const halfWidth = (Number.isFinite(pad.width) ? pad.width : pad.size * ratio) / 2;
    const halfHeight = (Number.isFinite(pad.height) ? pad.height : pad.size) / 2;
    if (pad.shape === 'round' || pad.shape === 'oval') {
        return (x / halfWidth) ** 2 + (y / halfHeight) ** 2 <= 1;
    }
    if (pad.shape === 'stadium') {
        const radius = halfHeight;
        const straight = Math.max(0, halfWidth - radius);
        const nearestX = Math.max(-straight, Math.min(straight, x));
        return Math.hypot(x - nearestX, y) <= radius;
    }
    return Math.abs(x) <= halfWidth && Math.abs(y) <= halfHeight;
}
