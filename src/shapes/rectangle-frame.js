/** @typedef {{x: number, y: number}} Point */
/** @typedef {{x: number, y: number, width: number, height: number, rotation: number, reversed?: boolean}} RectangleFrame */

/** @param {number} value */
const round4 = value => {
    const rounded = Math.round(value * 10000) / 10000;
    return rounded === 0 ? 0 : rounded;
};
const frameFields = ['x', 'y', 'width', 'height', 'rotation'];

/** @param {any} value */
export function hasRectangleFrame(value) {
    return ['width', 'height', 'rotation', 'reversed'].some(key => Object.hasOwn(value, key));
}

/** @param {any} frame */
export function validateRectangleFrame(frame) {
    if (!frame || !frameFields.every(key => Number.isFinite(frame[key]))
        || frame.width <= 0 || frame.height <= 0
        || (frame.reversed !== undefined && typeof frame.reversed !== 'boolean')) {
        throw new Error('Rectangle frame requires finite centre coordinates, positive width/height and a finite rotation.');
    }
}

/** Reconstruct source-corner order; reversed winding must not mirror image artwork or edge metadata. */
/** @param {Record<string, any>} frame - checked by validateRectangleFrame */
export function rectangleFramePoints(frame) {
    validateRectangleFrame(frame);
    const angle = -(frame.rotation % 360) * Math.PI / 180;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const direction = frame.reversed ? -1 : 1;
    const ux = cosine * frame.width / 2, uy = sine * frame.width / 2;
    const vx = -sine * frame.height / 2 * direction, vy = cosine * frame.height / 2 * direction;
    const points = [
        { x: frame.x - ux - vx, y: frame.y - uy - vy },
        { x: frame.x + ux - vx, y: frame.y + uy - vy },
        { x: frame.x + ux + vx, y: frame.y + uy + vy },
        { x: frame.x - ux + vx, y: frame.y - uy + vy },
    ];
    validateRectanglePoints(points);
    return points;
}

/**
 * @param {Point[]} points
 * @param {{coordinateTolerance?: number}} [options]
 * @returns {string|null}
 */
function rectanglePointsError(points, { coordinateTolerance = 0 } = {}) {
    if (!Array.isArray(points) || points.length !== 4
        || !points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))) {
        return 'Rectangle bounds require four finite corners.';
    }
    const u = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
    const v = { x: points[3].x - points[0].x, y: points[3].y - points[0].y };
    const width = Math.hypot(u.x, u.y), height = Math.hypot(v.x, v.y);
    const edgeError = 2 * Math.SQRT2 * coordinateTolerance;
    const cross = u.x * v.y - u.y * v.x;
    if (!Number.isFinite(width + height) || width < 1e-9 || height < 1e-9 || Math.abs(cross) <= 1e-12 * width * height
        || Math.abs(u.x * v.x + u.y * v.y) > 1e-6 * width * height + edgeError * (width + height) + edgeError ** 2
        || Math.hypot(points[2].x - points[1].x - v.x, points[2].y - points[1].y - v.y)
            > 1e-6 * Math.max(width, height) + 2 * edgeError) {
        return 'Rectangle bounds must form a nonempty rectangle.';
    }
    return null;
}

/** @param {Point[]} points */
export function pointsFormRectangle(points) {
    return rectanglePointsError(points) === null;
}

/**
 * @param {Point[]} points
 * @param {{coordinateTolerance?: number}} [options]
 */
export function validateRectanglePoints(points, options = {}) {
    const error = rectanglePointsError(points, options);
    if (error) throw new Error(error);
}

/**
 * @param {Point[]} points
 * @param {{coordinateTolerance?: number}} [options]
 */
export function normalizeRectanglePoints(points, options = {}) {
    validateRectanglePoints(points, options);
    const horizontal = {
        x: ((points[1].x - points[0].x) + (points[2].x - points[3].x)) / 2,
        y: ((points[1].y - points[0].y) + (points[2].y - points[3].y)) / 2,
    };
    const vertical = {
        x: ((points[3].x - points[0].x) + (points[2].x - points[1].x)) / 2,
        y: ((points[3].y - points[0].y) + (points[2].y - points[1].y)) / 2,
    };
    const width = Math.hypot(horizontal.x, horizontal.y);
    const height = Math.hypot(vertical.x, vertical.y);
    const unitX = { x: horizontal.x / width, y: horizontal.y / width };
    const direction = horizontal.x * vertical.y - horizontal.y * vertical.x < 0 ? -1 : 1;
    const unitY = { x: -unitX.y * direction, y: unitX.x * direction };
    const center = points.reduce((result, point) => ({
        x: result.x + point.x / 4, y: result.y + point.y / 4,
    }), { x: 0, y: 0 });
    const halfX = { x: unitX.x * width / 2, y: unitX.y * width / 2 };
    const halfY = { x: unitY.x * height / 2, y: unitY.y * height / 2 };
    return [
        { x: center.x - halfX.x - halfY.x, y: center.y - halfX.y - halfY.y },
        { x: center.x + halfX.x - halfY.x, y: center.y + halfX.y - halfY.y },
        { x: center.x + halfX.x + halfY.x, y: center.y + halfX.y + halfY.y },
        { x: center.x - halfX.x + halfY.x, y: center.y - halfX.y + halfY.y },
    ];
}

/** Fit only rectangular corners, allowing the bounded noise in legacy four-decimal records. */
/** @param {Point[]} points */
export function rectangleFrameFromPoints(points) {
    const normalized = normalizeRectanglePoints(points, { coordinateTolerance: 0.0001 });
    const horizontal = { x: normalized[1].x - normalized[0].x, y: normalized[1].y - normalized[0].y };
    const vertical = { x: normalized[3].x - normalized[0].x, y: normalized[3].y - normalized[0].y };
    const frame = {
        x: round4(points.reduce((sum, point) => sum + point.x / 4, 0)),
        y: round4(points.reduce((sum, point) => sum + point.y / 4, 0)),
        width: round4(Math.hypot(horizontal.x, horizontal.y)),
        height: round4(Math.hypot(vertical.x, vertical.y)),
        rotation: round4(((-Math.atan2(horizontal.y, horizontal.x) * 180 / Math.PI) % 360 + 360) % 360) % 360,
        ...(horizontal.x * vertical.y - horizontal.y * vertical.x < 0 ? { reversed: true } : {}),
    };
    rectangleFramePoints(frame);
    return frame;
}
