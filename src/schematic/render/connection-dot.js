const NOMINAL_RADIUS_MM = 0.4;
export const CONNECTION_DOT_MIN_RADIUS_PX = 2.5;
export const CONNECTION_DOT_MAX_RADIUS_PX = 8;

/**
 * Schematic connection-dot radius in world units.
 * @param {number} scale screen pixels per world millimetre
 */
export function schematicConnectionDotRadius(scale) {
    const safeScale = Math.max(0.01, Number(scale) || 1);
    return Math.max(CONNECTION_DOT_MIN_RADIUS_PX / safeScale,
        Math.min(NOMINAL_RADIUS_MM, CONNECTION_DOT_MAX_RADIUS_PX / safeScale));
}
