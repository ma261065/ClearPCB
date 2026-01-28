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
     * Validate a point object {x, y}
     */
    static validatePoint(point, options = {}) {
        const {
            coerce = true,
            name = 'point'
        } = options;

        if (!point || typeof point !== 'object') {
            if (coerce) {
                console.warn(`ShapeValidator: Invalid ${name}, using {0, 0}`);
                return { x: 0, y: 0 };
            }
            throw new Error(`Invalid ${name}: must be an object with x and y properties`);
        }

        return {
            x: this.validateCoordinate(point.x, { coerce, name: `${name}.x` }),
            y: this.validateCoordinate(point.y, { coerce, name: `${name}.y` })
        };
    }

    /**
     * Validate bounds object
     */
    static validateBounds(bounds, options = {}) {
        const {
            coerce = true
        } = options;

        if (!bounds || typeof bounds !== 'object') {
            if (coerce) {
                return { x: 0, y: 0, width: 0, height: 0 };
            }
            throw new Error('Invalid bounds object');
        }

        return {
            x: this.validateCoordinate(bounds.x, { coerce }),
            y: this.validateCoordinate(bounds.y, { coerce }),
            width: this.validateNumber(bounds.width, { min: 0, coerce }),
            height: this.validateNumber(bounds.height, { min: 0, coerce })
        };
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

    /**
     * Validate entire shape configuration
     */
    static validateShapeConfig(config, shapeType = 'generic', options = {}) {
        const {
            coerce = true
        } = options;

        const validated = {};

        // Common properties
        if ('id' in config) {
            validated.id = String(config.id).substring(0, 256);
        }

        if ('color' in config) {
            validated.color = this.validateColor(config.color, { coerce });
        }

        if ('lineWidth' in config) {
            validated.lineWidth = this.validateLineWidth(config.lineWidth, { coerce });
        }

        if ('layer' in config) {
            validated.layer = this.validateLayer(config.layer, { coerce });
        }

        // Shape-specific properties
        switch (shapeType) {
            case 'line':
                if ('x1' in config) validated.x1 = this.validateCoordinate(config.x1, { coerce });
                if ('y1' in config) validated.y1 = this.validateCoordinate(config.y1, { coerce });
                if ('x2' in config) validated.x2 = this.validateCoordinate(config.x2, { coerce });
                if ('y2' in config) validated.y2 = this.validateCoordinate(config.y2, { coerce });
                break;

            case 'circle':
                if ('cx' in config) validated.cx = this.validateCoordinate(config.cx, { coerce });
                if ('cy' in config) validated.cy = this.validateCoordinate(config.cy, { coerce });
                if ('r' in config) validated.r = this.validateRadius(config.r, { coerce });
                break;

            case 'rect':
                if ('x' in config) validated.x = this.validateCoordinate(config.x, { coerce });
                if ('y' in config) validated.y = this.validateCoordinate(config.y, { coerce });
                if ('width' in config) {
                    validated.width = this.validateNumber(config.width, { min: 0, coerce, name: 'width' });
                }
                if ('height' in config) {
                    validated.height = this.validateNumber(config.height, { min: 0, coerce, name: 'height' });
                }
                break;

            case 'arc':
                if ('x' in config) validated.x = this.validateCoordinate(config.x, { coerce });
                if ('y' in config) validated.y = this.validateCoordinate(config.y, { coerce });
                if ('radius' in config) validated.radius = this.validateRadius(config.radius, { coerce });
                if ('startAngle' in config) {
                    validated.startAngle = this.validateNumber(config.startAngle, { 
                        min: -Math.PI * 2, 
                        max: Math.PI * 2, 
                        coerce, 
                        name: 'startAngle' 
                    });
                }
                if ('endAngle' in config) {
                    validated.endAngle = this.validateNumber(config.endAngle, { 
                        min: -Math.PI * 2, 
                        max: Math.PI * 2, 
                        coerce, 
                        name: 'endAngle' 
                    });
                }
                break;

            case 'polygon':
                if ('points' in config && Array.isArray(config.points)) {
                    validated.points = config.points.map((p, i) => {
                        if (!Array.isArray(p) || p.length < 2) {
                            if (coerce) {
                                console.warn(`ShapeValidator: Invalid polygon point ${i}`);
                                return [0, 0];
                            }
                            throw new Error(`Invalid polygon point ${i}`);
                        }
                        return [
                            this.validateCoordinate(p[0], { coerce }),
                            this.validateCoordinate(p[1], { coerce })
                        ];
                    });
                }
                break;

            case 'via':
                if ('x' in config) validated.x = this.validateCoordinate(config.x, { coerce });
                if ('y' in config) validated.y = this.validateCoordinate(config.y, { coerce });
                if ('diameter' in config) {
                    validated.diameter = this.validateNumber(config.diameter, { min: 0.1, max: 100, coerce, name: 'diameter' });
                }
                if ('hole' in config) {
                    validated.hole = this.validateNumber(config.hole, { min: 0.01, max: 50, coerce, name: 'hole' });
                }
                break;

            case 'pad':
                if ('x' in config) validated.x = this.validateCoordinate(config.x, { coerce });
                if ('y' in config) validated.y = this.validateCoordinate(config.y, { coerce });
                if ('width' in config) {
                    validated.width = this.validateNumber(config.width, { min: 0.1, coerce, name: 'width' });
                }
                if ('height' in config) {
                    validated.height = this.validateNumber(config.height, { min: 0.1, coerce, name: 'height' });
                }
                break;
        }

        return validated;
    }

    /**
     * Check if two values are approximately equal (floating point safe)
     */
    static approxEqual(a, b, epsilon = 0.0001) {
        return Math.abs(a - b) < epsilon;
    }

    /**
     * Sanitize a value for use in user-facing contexts
     */
    static sanitizeForDisplay(value, decimals = 2) {
        if (typeof value !== 'number' || !isFinite(value)) {
            return 'N/A';
        }
        return value.toFixed(decimals);
    }
}

/**
 * Higher-order function to wrap shape properties with validation
 * @example
 * const shape = new Line({ x1: NaN, x2: '100' });  // Would fail
 * const validated = validateShapeProperties(Line, config);
 */
export function validateShapeProperties(ShapeClass, config) {
    return ShapeValidator.validateShapeConfig(config, ShapeClass.prototype.type || 'generic');
}
