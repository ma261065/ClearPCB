/**
 * KiCad symbol parser owns S-expression parsing and conversion of KiCad symbol
 * units into ClearPCB symbol objects. Primitive graphics parsing is delegated.
 */

import { SYMBOL_LIBRARY_MARKER } from './constants.js';

/** @typedef {import('../Component.js').ComponentDefinition} ComponentDefinition */
/** @typedef {import('../Component.js').ComponentProperties} ComponentProperties */
/** @typedef {import('../Component.js').ComponentSymbol} ComponentSymbol */
/** @typedef {import('../Component.js').ComponentSymbolGraphic} ComponentSymbolGraphic */
/** @typedef {import('../Component.js').ComponentSymbolPin} ComponentSymbolPin */
/** @typedef {import('./sexp-parser.js').SExprList} SExprList */


    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse KiCad S-expression format and extract a symbol
     * @param {string} content - Library file content
     * @param {string} symbolName - Name of symbol to extract
     * @returns {ComponentDefinition|null} ClearPCB symbol definition
     */
export function _parseSymbolFromLibrary(fetcher, content, symbolName) {
    console.log(`Parsing library for symbol: ${symbolName}`);
    console.log(`Content starts with: ${content.substring(0, 100)}`);

    // Parse S-expression
    const sexp = fetcher._parseSExp(content);

    if (!sexp) {
        console.error('S-expression parsing returned null');
        return null;
    }

    console.log(`Parsed S-exp type: ${sexp[0]}`);

    if (sexp[0] !== SYMBOL_LIBRARY_MARKER) {
        console.error('Invalid KiCad symbol library format, got:', sexp[0]);
        return null;
    }

    // Collect all symbol names for debugging
    const symbolNames = [];
    for (const item of sexp) {
        if (Array.isArray(item) && item[0] === 'symbol') {
            const name = item[1];
            const cleanName = name ? name.replace(/^"|"$/g, '') : '';
            // Only collect top-level symbols (not sub-units like "NE555_1_1")
            if (cleanName && !cleanName.includes('_1_') && !cleanName.includes('_0_')) {
                symbolNames.push(cleanName);
            }
        }
    }
    console.log('Available symbols in library:', symbolNames.slice(0, 20));

    // Find the symbol - try multiple matching strategies
    const searchName = symbolName.toUpperCase();

    for (const item of sexp) {
        if (Array.isArray(item) && item[0] === 'symbol') {
            const name = item[1];
            if (!name) continue;

            const cleanName = name.replace(/^"|"$/g, '');
            const upperName = cleanName.toUpperCase();

            // Skip sub-units (like "NE555_1_1")
            if (cleanName.includes('_1_') || cleanName.includes('_0_')) {
                continue;
            }

            // Exact match
            if (upperName === searchName) {
                console.log('Found exact match:', cleanName);
                const symbol = fetcher._convertKiCadSymbol(item);
                if (!symbol) continue;
                symbol.kicadName = cleanName;
                return symbol;
            }

            // Match without library prefix (e.g., "Timer:NE555" matches "NE555")
            if (upperName.endsWith(':' + searchName)) {
                console.log('Found prefixed match:', cleanName);
                const symbol = fetcher._convertKiCadSymbol(item);
                if (!symbol) continue;
                symbol.kicadName = cleanName;
                return symbol;
            }

            // Partial match (e.g., "NE555" matches "NE555P")
            if (upperName.startsWith(searchName) || upperName.includes(searchName)) {
                console.log('Found partial match:', cleanName);
                const symbol = fetcher._convertKiCadSymbol(item);
                if (!symbol) continue;
                symbol.kicadName = cleanName;
                return symbol;
            }
        }
    }

    console.warn(`Symbol ${symbolName} not found in library. Available: ${symbolNames.join(', ')}`);
    return null;
}


    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * If a parsed symbol has no pins or graphics, try to rebuild it
     * from its unit sub-symbols (e.g. `NE555_1_1`).
     * @param {SExprList} sexp - Parsed S-expression of the library
     * @param {ComponentSymbol} symbol - Already-converted symbol object
     * @param {string} baseName - Symbol base name (without unit suffix)
     * @returns {ComponentSymbol} Original or rebuilt symbol
     */
export function _rebuildSymbolFromUnitsIfNeeded(fetcher, sexp, symbol, baseName) {
    if ((symbol?.pins?.length || 0) > 0 || (symbol?.graphics?.length || 0) > 0) {
        return symbol;
    }

    const rebuilt = fetcher._buildSymbolFromUnits(sexp, baseName);
    if (rebuilt) {
        rebuilt.properties = symbol.properties || {};
        rebuilt.kicadName = symbol.kicadName || baseName;
        return rebuilt;
    }

    return symbol;
}


    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Build a complete symbol by locating and merging all unit sub-symbols
     * (e.g. `SymbolName_1_1`, `_1_2`, ...) from a library S-expression.
     * @param {SExprList} sexp - Parsed library S-expression
     * @param {string} baseName - Symbol base name
     * @returns {ComponentSymbol|null} Merged symbol or null
     */
export function _buildSymbolFromUnits(fetcher, sexp, baseName) {
    if (!Array.isArray(sexp) || !baseName) return null;
    const cleanBase = baseName.replace(/^"|"$/g, '');
    const prefix = `${cleanBase}_`;

    const unitSymbols = sexp.filter(item => {
        if (!Array.isArray(item) || item[0] !== 'symbol' || typeof item[1] !== 'string') return false;
        const name = item[1].replace(/^"|"$/g, '');
        return name.startsWith(prefix);
    });

    if (unitSymbols.length === 0) {
        console.log('KiCad unit symbols not found for', cleanBase);
        const nearby = sexp
            .filter(item => Array.isArray(item) && item[0] === 'symbol' && typeof item[1] === 'string')
            .map(item => item[1].replace(/^"|"$/g, ''))
            .filter(name => name.includes(cleanBase))
            .slice(0, 20);
        console.log('KiCad symbols containing base name:', cleanBase, nearby);
        return null;
    }

    console.log('KiCad unit symbols found for', cleanBase, unitSymbols.map(u => (typeof u[1] === 'string' ? u[1].replace(/^"|"$/g, '') : u[1])));

    /** @type {ComponentSymbol & {graphics: ComponentSymbolGraphic[], pins: ComponentSymbolPin[], properties: ComponentProperties}} */
    const symbol = {
        width: 20,
        height: 20,
        origin: { x: 10, y: 10 },
        graphics: [],
        pins: [],
        properties: {},
        _source: 'KiCad'
    };

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const unit of unitSymbols) {
        const unitResult = fetcher._processSymbolUnit(unit);
        symbol.graphics.push(...unitResult.graphics);
        symbol.pins.push(...unitResult.pins);

        if (unitResult.minX < minX) minX = unitResult.minX;
        if (unitResult.minY < minY) minY = unitResult.minY;
        if (unitResult.maxX > maxX) maxX = unitResult.maxX;
        if (unitResult.maxY > maxY) maxY = unitResult.maxY;
    }

    if (minX !== Infinity) {
        const offsetX = minX;
        const offsetY = minY;

        for (const g of symbol.graphics) {
            fetcher._offsetGraphic(g, -offsetX, -offsetY);
        }

        for (const p of symbol.pins) {
            p.x -= offsetX;
            p.y -= offsetY;
        }

        symbol.width = maxX - minX;
        symbol.height = maxY - minY;
        symbol.origin = {
            x: symbol.width / 2,
            y: symbol.height / 2
        };

        const centerX = symbol.width / 2;
        const topEdge = 0;
        symbol.graphics.push({
            type: 'text',
            x: centerX,
            y: topEdge - 2.1,
            text: '${REF}',
            fontSize: 1.2,
            anchor: 'middle',
            baseline: 'middle'
        });
        symbol.graphics.push({
            type: 'text',
            x: centerX,
            y: topEdge - 0.7,
            text: '${VALUE}',
            fontSize: 1.0,
            anchor: 'middle',
            baseline: 'middle'
        });
    }

    return symbol;
}


    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Convert KiCad symbol to ClearPCB format
     * @param {SExprList} symbolSexp - Parsed symbol S-expression
     * @returns {ComponentDefinition|null} ClearPCB symbol definition
     */
export function _convertKiCadSymbol(fetcher, symbolSexp) {
    const name = symbolSexp[1].replace(/^"|"$/g, '');

    /** @type {ComponentSymbol & {graphics: ComponentSymbolGraphic[], pins: ComponentSymbolPin[], properties: ComponentProperties}} */
    const symbol = {
        width: 20,
        height: 20,
        origin: { x: 10, y: 10 },
        graphics: [],
        pins: [],
        properties: {},
        _source: 'KiCad'
    };

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    // Process symbol elements
    for (let i = 2; i < symbolSexp.length; i++) {
        const item = symbolSexp[i];
        if (!Array.isArray(item)) continue;

        const type = item[0];

        switch (type) {
            case 'symbol':
                // Nested symbol (unit) - process its contents
                const unitResult = fetcher._processSymbolUnit(item);
                symbol.graphics.push(...unitResult.graphics);
                symbol.pins.push(...unitResult.pins);
                // Update bounds
                if (unitResult.minX < minX) minX = unitResult.minX;
                if (unitResult.minY < minY) minY = unitResult.minY;
                if (unitResult.maxX > maxX) maxX = unitResult.maxX;
                if (unitResult.maxY > maxY) maxY = unitResult.maxY;
                break;

            case 'property':
                const prop = fetcher._parseKiCadProperty(item);
                if (prop && prop.name) {
                    const existing = symbol.properties[prop.name];
                    const next = prop.value;
                    if (!existing && next) {
                        symbol.properties[prop.name] = next;
                    } else if (existing && !next) {
                        // keep existing non-empty value
                    } else if (!existing) {
                        symbol.properties[prop.name] = next;
                    }
                }
                break;

            case 'pin':
                const pin = fetcher._parseKiCadPin(item);
                if (pin) {
                    symbol.pins.push(pin);
                    minX = Math.min(minX, pin.x);
                    maxX = Math.max(maxX, pin.x);
                    minY = Math.min(minY, pin.y);
                    maxY = Math.max(maxY, pin.y);
                }
                break;

            case 'rectangle':
                const rect = fetcher._parseKiCadRectangle(item);
                if (rect) {
                    symbol.graphics.push(rect);
                    minX = Math.min(minX, rect.x);
                    maxX = Math.max(maxX, rect.x + rect.width);
                    minY = Math.min(minY, rect.y);
                    maxY = Math.max(maxY, rect.y + rect.height);
                }
                break;

            case 'polyline':
                const polyline = fetcher._parseKiCadPolyline(item);
                if (polyline) {
                    symbol.graphics.push(polyline);
                    for (const p of polyline.points) {
                        minX = Math.min(minX, p[0]);
                        maxX = Math.max(maxX, p[0]);
                        minY = Math.min(minY, p[1]);
                        maxY = Math.max(maxY, p[1]);
                    }
                }
                break;

            case 'circle':
                const circle = fetcher._parseKiCadCircle(item);
                if (circle) {
                    symbol.graphics.push(circle);
                    minX = Math.min(minX, circle.cx - circle.r);
                    maxX = Math.max(maxX, circle.cx + circle.r);
                    minY = Math.min(minY, circle.cy - circle.r);
                    maxY = Math.max(maxY, circle.cy + circle.r);
                }
                break;

            case 'arc':
                const arc = fetcher._parseKiCadArc(item);
                if (arc) {
                    symbol.graphics.push(arc);
                    // Approximate bounds for arc
                    minX = Math.min(minX, arc.cx - arc.r);
                    maxX = Math.max(maxX, arc.cx + arc.r);
                    minY = Math.min(minY, arc.cy - arc.r);
                    maxY = Math.max(maxY, arc.cy + arc.r);
                }
                break;

            case 'text':
                // Skip text for now
                break;

            case 'extends':
                // Symbol inherits graphics/pins from a base symbol
                // (e.g., NE555P extends NE555)
                symbol._extends = (item[1] || '').replace(/^"|"$/g, '');
                break;
        }
    }

    // If no graphics/pins were found (and not an extends symbol),
    // attempt to rebuild from nested units
    if (symbol.pins.length === 0 && symbol.graphics.length === 0 && !symbol._extends) {
        const nestedCount = symbolSexp.filter(item => Array.isArray(item) && item[0] === 'symbol').length;
        console.log('KiCad nested unit count for symbol', name, nestedCount);
        const rebuilt = fetcher._buildSymbolFromNestedUnits(symbolSexp);
        if (rebuilt) {
            return rebuilt;
        }
    }

    // Deduplicate pins that share the same position and number
    if (symbol.pins.length > 1) {
        const seen = new Set();
        symbol.pins = symbol.pins.filter(pin => {
            const key = pin._coordKey || `${pin.x},${pin.y}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    // Calculate dimensions
    if (minX !== Infinity) {
        // Normalize coordinates
        const offsetX = minX;
        const offsetY = minY;

        for (const g of symbol.graphics) {
            fetcher._offsetGraphic(g, -offsetX, -offsetY);
        }

        for (const p of symbol.pins) {
            p.x -= offsetX;
            p.y -= offsetY;
        }

        symbol.width = maxX - minX;
        symbol.height = maxY - minY;
        symbol.origin = {
            x: symbol.width / 2,
            y: symbol.height / 2
        };

        // Add reference and value text above the symbol (centered)
        const centerX = symbol.width / 2;
        const topEdge = 0;
        symbol.graphics.push({
            type: 'text',
            x: centerX,
            y: topEdge - 2.1,
            text: '${REF}',
            fontSize: 1.2,
            anchor: 'middle',
            baseline: 'middle'
        });
        symbol.graphics.push({
            type: 'text',
            x: centerX,
            y: topEdge - 0.7,
            text: '${VALUE}',
            fontSize: 1.0,
            anchor: 'middle',
            baseline: 'middle'
        });
    }

    return {
        name: name.split(':').pop(),
        description: '',
        category: 'KiCad',
        symbol: symbol,
        _source: 'KiCad'
    };
}


    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Build a symbol from nested `(symbol ...)` unit elements within a
     * top-level symbol S-expression. Deduplicates pins and normalises
     * coordinates to a shared origin.
     * @param {SExprList} symbolSexp - Top-level symbol S-expression
     * @returns {ComponentDefinition|null} Symbol with graphics, pins, and computed bounds
     */
export function _buildSymbolFromNestedUnits(fetcher, symbolSexp) {
    if (!Array.isArray(symbolSexp)) return null;

    /** @type {ComponentSymbol & {graphics: ComponentSymbolGraphic[], pins: ComponentSymbolPin[], properties: ComponentProperties}} */
    const symbol = {
        width: 20,
        height: 20,
        origin: { x: 10, y: 10 },
        graphics: [],
        pins: [],
        properties: {},
        _source: 'KiCad'
    };

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (let i = 2; i < symbolSexp.length; i++) {
        const item = symbolSexp[i];
        if (!Array.isArray(item) || item[0] !== 'symbol') continue;

        const unitResult = fetcher._processSymbolUnit(item);
        symbol.graphics.push(...unitResult.graphics);
        symbol.pins.push(...unitResult.pins);

        if (unitResult.minX < minX) minX = unitResult.minX;
        if (unitResult.minY < minY) minY = unitResult.minY;
        if (unitResult.maxX > maxX) maxX = unitResult.maxX;
        if (unitResult.maxY > maxY) maxY = unitResult.maxY;
    }

    if (symbol.pins.length === 0 && symbol.graphics.length === 0) {
        return null;
    }

    if (symbol.pins.length > 1) {
        const seen = new Set();
        symbol.pins = symbol.pins.filter(pin => {
            const key = pin._coordKey || `${pin.x},${pin.y}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    if (minX !== Infinity) {
        const offsetX = minX;
        const offsetY = minY;

        for (const g of symbol.graphics) {
            fetcher._offsetGraphic(g, -offsetX, -offsetY);
        }

        for (const p of symbol.pins) {
            p.x -= offsetX;
            p.y -= offsetY;
        }

        symbol.width = maxX - minX;
        symbol.height = maxY - minY;
        symbol.origin = {
            x: symbol.width / 2,
            y: symbol.height / 2
        };

        const centerX = symbol.width / 2;
        const topEdge = 0;
        symbol.graphics.push({
            type: 'text',
            x: centerX,
            y: topEdge - 2.1,
            text: '${REF}',
            fontSize: 1.2,
            anchor: 'middle',
            baseline: 'middle'
        });
        symbol.graphics.push({
            type: 'text',
            x: centerX,
            y: topEdge - 0.7,
            text: '${VALUE}',
            fontSize: 1.0,
            anchor: 'middle',
            baseline: 'middle'
        });
    }

    return {
        name: symbolSexp[1]?.replace(/^"|"$/g, '').split(':').pop(),
        description: '',
        category: 'KiCad',
        symbol: symbol,
        _source: 'KiCad'
    };
}

    /**
     * Resolve an `extends` reference by fetching the base symbol and
     * copying its graphics/pins into the extending symbol.
     * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * @param {ComponentDefinition} result - Parsed symbol result from _convertKiCadSymbol
     * @param {string} library - Library name (e.g., "Timer")
     * @param {number} depth - Recursion depth guard
     * @returns {Promise<ComponentDefinition>} result with graphics/pins populated from base
     */
export async function _resolveExtends(fetcher, result, library, depth = 0) {
    const extendsName = result?.symbol?._extends;
    if (!extendsName || depth > 3) return result;

    // Strip library prefix if present (e.g., "Timer:NE555" → "NE555")
    const baseName = (extendsName.includes(':') ? extendsName.split(':').pop() : extendsName) || '';
    console.log(`KiCadFetcher: Resolving extends ${result.name} → ${baseName}`);

    // Try to fetch the base symbol from the same library's symdir
    const directSymDir = `${library}.kicad_symdir`;
    const baseContent = await fetcher._fetchSymbolFile(directSymDir, baseName);
    if (!baseContent) return result;

    const baseResult = fetcher._parseSymbolFromLibrary(baseContent, baseName);
    if (!baseResult?.symbol) return result;

    // Recursively resolve if the base also extends another symbol
    if (baseResult.symbol._extends) {
        await fetcher._resolveExtends(baseResult, library, depth + 1);
    }

    // Copy visual data from base, keep extending symbol's own properties
    if (!result.symbol) return result;
    result.symbol.graphics = baseResult.symbol.graphics;
    result.symbol.pins = baseResult.symbol.pins;
    result.symbol.width = baseResult.symbol.width;
    result.symbol.height = baseResult.symbol.height;
    result.symbol.origin = baseResult.symbol.origin;
    delete result.symbol._extends;

    return result;
}


    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Process a single symbol unit sub-element, extracting its pins,
     * rectangles, polylines, circles and arcs, and tracking min/max bounds.
     * @param {SExprList} unitSexp - Unit S-expression
     * @returns {{graphics: ComponentSymbolGraphic[], pins: ComponentSymbolPin[], minX: number, minY: number, maxX: number, maxY: number}}
     */
export function _processSymbolUnit(fetcher, unitSexp) {
    /** @type {{ graphics: ComponentSymbolGraphic[], pins: ComponentSymbolPin[], minX: number, minY: number, maxX: number, maxY: number }} */
    const result = {
        graphics: [],
        pins: [],
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };

    for (let i = 2; i < unitSexp.length; i++) {
        const item = unitSexp[i];
        if (!Array.isArray(item)) continue;

        const type = item[0];

        switch (type) {
            case 'pin':
                const pin = fetcher._parseKiCadPin(item);
                if (pin) {
                    result.pins.push(pin);
                    result.minX = Math.min(result.minX, pin.x);
                    result.maxX = Math.max(result.maxX, pin.x);
                    result.minY = Math.min(result.minY, pin.y);
                    result.maxY = Math.max(result.maxY, pin.y);
                }
                break;

            case 'rectangle':
                const rect = fetcher._parseKiCadRectangle(item);
                if (rect) {
                    result.graphics.push(rect);
                    result.minX = Math.min(result.minX, rect.x);
                    result.maxX = Math.max(result.maxX, rect.x + rect.width);
                    result.minY = Math.min(result.minY, rect.y);
                    result.maxY = Math.max(result.maxY, rect.y + rect.height);
                }
                break;

            case 'polyline':
                const polyline = fetcher._parseKiCadPolyline(item);
                if (polyline) {
                    result.graphics.push(polyline);
                    for (const p of polyline.points) {
                        result.minX = Math.min(result.minX, p[0]);
                        result.maxX = Math.max(result.maxX, p[0]);
                        result.minY = Math.min(result.minY, p[1]);
                        result.maxY = Math.max(result.maxY, p[1]);
                    }
                }
                break;

            case 'circle':
                const circle = fetcher._parseKiCadCircle(item);
                if (circle) {
                    result.graphics.push(circle);
                    result.minX = Math.min(result.minX, circle.cx - circle.r);
                    result.maxX = Math.max(result.maxX, circle.cx + circle.r);
                    result.minY = Math.min(result.minY, circle.cy - circle.r);
                    result.maxY = Math.max(result.maxY, circle.cy + circle.r);
                }
                break;

            case 'arc':
                const arc = fetcher._parseKiCadArc(item);
                if (arc) {
                    result.graphics.push(arc);
                    result.minX = Math.min(result.minX, arc.cx - arc.r);
                    result.maxX = Math.max(result.maxX, arc.cx + arc.r);
                    result.minY = Math.min(result.minY, arc.cy - arc.r);
                    result.maxY = Math.max(result.maxY, arc.cy + arc.r);
                }
                break;
        }
    }

    return result;
}
