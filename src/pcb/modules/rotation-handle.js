const cursorArrow = 'M 25 12 A 10 10 0 1 0 26 19 M 25 5 V 12 H 18';
const cursorSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${cursorArrow}" stroke="white" stroke-width="5"/><path d="${cursorArrow}" stroke="black" stroke-width="2.5"/></g></svg>`;
export const ROTATION_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(cursorSvg)}") 16 16, crosshair`;

export function rotationHandleAnchor(bounds, scale) {
    const offset = 28 / Math.max(0.01, scale || 1);
    return {
        id: 'rotate', symbol: 'rotate', round: true, sizePx: 22, cursor: 'grab',
        x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY - offset,
    };
}

export function pointerRotation(center, start, current, initialRotation) {
    if (Math.hypot(current.x - center.x, current.y - center.y) < 1e-9) return initialRotation;
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const angle = Math.atan2(current.y - center.y, current.x - center.x);
    return ((Math.round(initialRotation - (angle - startAngle) * 180 / Math.PI) % 360) + 360) % 360;
}

export function rotatedImagePoints(points, center, degrees) {
    const radians = -degrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return points.map(point => ({
        x: center.x + (point.x - center.x) * cosine - (point.y - center.y) * sine,
        y: center.y + (point.x - center.x) * sine + (point.y - center.y) * cosine,
    }));
}