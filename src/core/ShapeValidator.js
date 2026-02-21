/**
 * ShapeValidator - Validates shape properties and prevents invalid states
 * 
 * Provides:
 * - Property validation (type, range, format)
 * - Coordinate validation
 * - Dimension validation
 * - Automatic coercion to valid values
 * - Clear error messages
 */

export class ShapeValidator {
    /**
     * Validate a numeric coordinate or dimension
     * @param {*} value - The value to validate
     * @param {object} options - Validation options
     * @returns {number} Valid coordinate/dimension
     * @throws {Error} If validation fails and coercion disabled
     */
    static validateNumber(value, options = {}) {
        const {
            min = -Infinity,
            max = Infinity,
            default: defaultValue = 0,
            coerce = true,
            name = 'value'
        } = options;

        // Convert to number
        const num = Number(value);

        // Check for NaN
        if (isNaN(num)) {
            if (coerce) {
                console.warn(`ShapeValidator: Invalid ${name} "${value}", using default ${defaultValue}`);
                return defaultValue;
            }
            throw new Error(`Invalid ${name}: "${value}" is not a number`);
        }

        // Check infinity
        if (!isFinite(num)) {
            if (coerce) {
                console.warn(`ShapeValidator: ${name} is infinite, using default ${defaultValue}`);
                return defaultValue;
            }
            throw new Error(`Invalid ${name}: must be finite`);
        }

        // Clamp to range
        if (num < min || num > max) {
            if (coerce) {
                const clamped = Math.max(min, Math.min(max, num));
                if (Math.abs(clamped - num) > 0.0001) {
                    console.warn(`ShapeValidator: ${name} ${num} outside range [${min}, ${max}], clamping to ${clamped}`);
                }
                return clamped;
            }
            throw new Error(`Invalid ${name}: ${num} outside range [${min}, ${max}]`);
        }

        return num;
    }

    /**
     * Validate line width
     */
    static validateLineWidth(value, options = {}) {
        return this.validateNumber(value, {
            min: 0.01,      // Minimum 0.01mm
            max: 100,       // Maximum 100mm
            default: 0.2,
            name: 'lineWidth',
            ...options
        });
    }

    /**
     * Validate radius
     */
    static validateRadius(value, options = {}) {
        return this.validateNumber(value, {
            min: 0.01,      // Minimum 0.01mm
            max: 10000,     // Maximum 10000mm
            default: 1,
            name: 'radius',
            ...options
        });
    }

    /**
     * Validate a coordinate (X or Y)
     */
    static validateCoordinate(value, options = {}) {
        return this.validateNumber(value, {
            min: -100000,   // World bounds
            max: 100000,
            default: 0,
            name: 'coordinate',
            ...options
        });
    }

    /**
     * Validate color (hex format)
     */
    static validateColor(value, options = {}) {
        const {
            coerce = true,
            default: defaultColor = '#000000'
        } = options;

        // Check if it's a valid hex color
        if (typeof value === 'string' && /^#[0-9A-F]{6}$/i.test(value)) {
            return value;
        }

        // Check CSS color variable
        if (typeof value === 'string' && value.startsWith('var(')) {
            return value;
        }

        if (coerce) {
            console.warn(`ShapeValidator: Invalid color "${value}", using ${defaultColor}`);
            return defaultColor;
        }

        throw new Error(`Invalid color: "${value}" must be hex format (#RRGGBB) or CSS variable`);
    }

    /**
     * Validate layer name
     */
    static validateLayer(value, options = {}) {
        const validLayers = ['top', 'bottom', 'silkscreen', 'copper', 'outline'];
        const {
            coerce = true,
            default: defaultLayer = 'top'
        } = options;

        if (validLayers.includes(value)) {
            return value;
        }

        if (coerce) {
            console.warn(`ShapeValidator: Invalid layer "${value}", using ${defaultLayer}`);
            return defaultLayer;
        }

        throw new Error(`Invalid layer: "${value}" must be one of ${validLayers.join(', ')}`);
    }

}
