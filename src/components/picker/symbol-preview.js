/**
 * ComponentPicker symbol preview owner. Renders symbol SVGs, thumbnails, package choices, and preview metadata.
 */

import { errorMessage } from '../../core/errors.js';
import { escapeHtml, sanitizeImageUrl } from '../../core/ui-helpers.js';
import { getBuiltInPackageOptions, withBuiltInPackage } from '../BuiltInPackages.js';
import { createSymbolGraphicElement, createSymbolPinElement } from '../symbol-svg.js';
import { set3dPreviewStatus, setFootprintPreviewStatus, update3dPreview, updateFootprintPreview } from './footprint-preview.js';

/** @typedef {import('../ComponentPicker.js').ComponentPicker} ComponentPicker */
/** @typedef {import('../ComponentPicker.js').LCSCSearchResult} LCSCSearchResult */
/** @typedef {import('../ComponentPicker.js').PickerComponentDefinition} PickerComponentDefinition */
/** @typedef {import('../ComponentPicker.js').SymbolDefinitionLike} SymbolDefinitionLike */
/** @typedef {import('../ComponentPicker.js').SymbolGraphicLike} SymbolGraphicLike */
/** @typedef {import('../ComponentPicker.js').SymbolPinLike} SymbolPinLike */

/**
 * Normalizes a component definition to ensure it has a consistent structure with a symbol property.
 * @param {PickerComponentDefinition|null|undefined} definition - The raw component definition.
 * @returns {PickerComponentDefinition|null|undefined} The normalized definition.
 */
export function normalizeDefinition(/** @type {ComponentPicker} */ picker, definition) {
    if (!definition || typeof definition !== 'object') return definition;

    if (definition.symbol && definition.symbol.graphics) {
        return definition;
    }

    if (definition.symbol && definition.symbol.symbol) {
        return { ...definition, symbol: definition.symbol.symbol };
    }

    if (!definition.symbol && (definition.graphics || definition.pins)) {
        return {
            name: definition.name || 'Component',
            description: definition.description || '',
            category: definition.category || 'Uncategorized',
            symbol: /** @type {import('../Component.js').ComponentSymbol} */ (/** @type {unknown} */ (definition))
        };
    }

    return definition;
}

/**
 * Creates a small SVG preview of a component for use in the list view.
 * @param {PickerComponentDefinition} comp - The component definition to preview.
 * @returns {Promise<string>} HTML string containing the SVG preview.
 */
export async function createMiniPreview(/** @type {ComponentPicker} */ picker, comp) {
    if (!comp.symbol) return '<span style="color:var(--text-muted)">?</span>';
    
    try {
        // Use the Component class to render the mini preview for consistency
        const { Component } = await import('../Component.js');
        const tempComponent = new Component(comp, { x: 0, y: 0 });
        
        const symbol = comp.symbol;
        const paddingX = 2;
        const paddingY = 2;
        
        // Get bounds from the Component class
        const localBounds = tempComponent._getLocalBounds();
        
        if (!Number.isFinite(localBounds.minX) || !Number.isFinite(localBounds.minY) ||
            !Number.isFinite(localBounds.maxX) || !Number.isFinite(localBounds.maxY)) {
            return '<span style="color:var(--text-muted)">?</span>';
        }
        
        // Create mini SVG using the same rendering as the actual component
        const viewBox = `${localBounds.minX - paddingX} ${localBounds.minY - paddingY} ${localBounds.maxX - localBounds.minX + paddingX * 2} ${localBounds.maxY - localBounds.minY + paddingY * 2}`;
        
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', viewBox);
        svg.setAttribute('width', '32');
        svg.setAttribute('height', '32');
        svg.setAttribute('style', 'overflow:visible');
        
        // Render graphics
        if (symbol.graphics && Array.isArray(symbol.graphics)) {
            for (const graphic of symbol.graphics) {
                const el = createSymbolGraphicElement(tempComponent, graphic, ns);
                if (el) svg.appendChild(el);
            }
        }
        
        // Render pins
        if (symbol.pins && Array.isArray(symbol.pins)) {
            for (const pin of symbol.pins) {
                const pinGroup = createSymbolPinElement(tempComponent, pin, ns);
                if (pinGroup) {
                    // Keep the pin line only; drop dots/labels for small previews.
                    pinGroup.querySelectorAll('text, circle').forEach(el => el.remove());
                    svg.appendChild(pinGroup);
                }
            }
        }
        
        return svg.outerHTML;
    } catch (error) {
        console.error('Error creating mini preview:', error);
        return '<span style="color:var(--text-muted)">?</span>';
    }
}

/**
 * Checks whether a URL points directly to an image file.
 * @param {string} url - The URL to test.
 * @returns {boolean} True if the URL ends with a common image extension.
 */
export function isDirectImageUrl(/** @type {ComponentPicker} */ picker, url) {
    if (!url || typeof url !== 'string') return false;
    return /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(url);
}

/**
 * Build a thumbnail <img> element safely (no innerHTML interpolation,
 * no inline onerror) and mount it in `container`. On image-load error
 * the container is replaced with `fallbackHTML` (a hard-coded literal
 * — never user data).
 * @param {HTMLElement} container
 * @param {string} url
 * @param {string} [fallbackHTML='<span>📦</span>']
 */
export function mountThumbnail(/** @type {ComponentPicker} */ picker, container, url, fallbackHTML = '<span>📦</span>') {
    const safeUrl = sanitizeImageUrl(url);
    if (!safeUrl) { container.innerHTML = fallbackHTML; return; }
    const img = document.createElement('img');
    img.alt = '';
    img.onerror = () => { container.innerHTML = fallbackHTML; };
    img.src = safeUrl;
    container.innerHTML = '';
    container.appendChild(img);
}

/**
 * Applies an LCSC product thumbnail image to the given icon element.
 * @param {HTMLElement} iconEl - The icon container element.
 * @param {LCSCSearchResult} result - The LCSC result with thumbnail URL data.
 * @returns {Promise<void>}
 */
export async function applyLCSCThumbnail(/** @type {ComponentPicker} */ picker, iconEl, result) {
    const thumbUrl = result.thumbUrl || result.imageUrl || '';
    if (!thumbUrl) return;

    if (isDirectImageUrl(picker, thumbUrl)) {
        mountThumbnail(picker, iconEl, thumbUrl);
        return;
    }

    if (!result.lcscPartNumber || !picker.library?.lcscFetcher) return;

    if (!result._thumbPromise) {
        result._thumbPromise = picker.library.lcscFetcher.fetchEasyedaProductImage(result.lcscPartNumber);
    }

    try {
        const resolvedUrl = await result._thumbPromise;
        result._thumbPromise = null;
        // Bail out if the search results were re-rendered while we were
        // waiting: stamping a thumbnail on a detached node leaks and may
        // race with a newer fetch on a recycled element.
        if (!iconEl.isConnected) return;
        if (resolvedUrl && isDirectImageUrl(picker, resolvedUrl)) {
            mountThumbnail(picker, iconEl, resolvedUrl);
        }
    } catch (error) {
        result._thumbPromise = null;
    }
}

/**
 * Attempts to apply an LCSC thumbnail; returns whether a photo was successfully applied.
 * @param {HTMLElement} iconEl - The icon container element.
 * @param {LCSCSearchResult} result - The LCSC result with thumbnail URL data.
 * @returns {Promise<boolean>} True if a photo thumbnail was applied.
 */
export async function tryApplyLCSCThumbnail(/** @type {ComponentPicker} */ picker, iconEl, result) {
    const thumbUrl = result.thumbUrl || result.imageUrl || '';
    if (!thumbUrl && (!result.lcscPartNumber || !picker.library?.lcscFetcher)) {
        return false;
    }

    if (thumbUrl && isDirectImageUrl(picker, thumbUrl)) {
        mountThumbnail(picker, iconEl, thumbUrl);
        return true;
    }

    if (!result.lcscPartNumber || !picker.library?.lcscFetcher) {
        return false;
    }

    if (!result._thumbPromise) {
        result._thumbPromise = picker.library.lcscFetcher.fetchEasyedaProductImage(result.lcscPartNumber);
    }

    try {
        const resolvedUrl = await result._thumbPromise;
        result._thumbPromise = null;
        if (!iconEl.isConnected) return false;
        if (resolvedUrl && isDirectImageUrl(picker, resolvedUrl)) {
            mountThumbnail(picker, iconEl, resolvedUrl);
            return true;
        }
    } catch (error) {
        result._thumbPromise = null;
    }
    
    return false;
}

/**
 * Updates the preview panel's product image for an LCSC result.
 * @param {LCSCSearchResult} result - The LCSC result to display the image for.
 * @returns {Promise<void>}
 */
export async function updateLCSCPreviewImage(/** @type {ComponentPicker} */ picker, result) {
    if (!picker.previewImage) return;

    picker.previewImage.innerHTML = '<div class="cp-preview-placeholder">Loading image...</div>';

    const directUrl = result.imageUrl || result.thumbUrl || '';
    if (directUrl && isDirectImageUrl(picker, directUrl)) {
        mountThumbnail(picker, picker.previewImage, directUrl, '');
        return;
    }

    if (!result.lcscPartNumber || !picker.library?.lcscFetcher) {
        picker.previewImage.innerHTML = '';
        return;
    }

    try {
        const resolvedUrl = await picker.library.lcscFetcher.fetchEasyedaProductImage(result.lcscPartNumber);
        if (resolvedUrl) {
            mountThumbnail(picker, picker.previewImage, resolvedUrl, '');
        } else {
            picker.previewImage.innerHTML = '';
        }
    } catch (error) {
        picker.previewImage.innerHTML = '';
    }
}

/**
 * @param {PickerComponentDefinition|null|undefined} definition
 */
export function updatePackageSelector(/** @type {ComponentPicker} */ picker, definition) {
    if (!definition) picker._previewVersion = (picker._previewVersion || 0) + 1;
    if (!picker.packageSelect) return;
    const packages = getBuiltInPackageOptions(definition);
    picker.packageSelect.replaceChildren();
    picker.packageRow.style.display = packages.length ? 'block' : 'none';
    for (const item of packages) {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        picker.packageSelect.appendChild(option);
    }
    picker.packageSelect.value = definition?.packageId || 'default';
}

/**
 * @param {string} packageId
 */
export function selectBuiltInPackage(/** @type {ComponentPicker} */ picker, packageId) {
    if (!picker.selectedComponent) return;
    picker.selectedComponent = withBuiltInPackage(picker.selectedComponent, packageId);
    updatePreview(picker, picker.selectedComponent);
}

/**
 * Updates the full symbol preview SVG and info panel for a component.
 * @param {PickerComponentDefinition|null|undefined} comp - The component definition to preview.
 * @param {Object} [options] - Preview options.
 * @param {boolean} [options.skipFootprint3d] - Whether to skip footprint/3D updates.
 * @returns {Promise<void>}
 */
export async function updatePreview(/** @type {ComponentPicker} */ picker, comp, options = {}) {
    updatePackageSelector(picker, comp);
    const version = picker._previewVersion = (picker._previewVersion || 0) + 1;
    try {
        if (!comp || !comp.symbol) {
            picker.previewSvg.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">No symbol</div>';
            picker.previewInfo.innerHTML = '';
            if (!options.skipFootprint3d) {
                setFootprintPreviewStatus(picker, 'No footprint data', false);
                set3dPreviewStatus(picker, 'No 3D model', false);
            }
            return;
        }
        
        // Use the Component class to render the preview for consistency
        const { Component } = await import('../Component.js');
        if (version !== picker._previewVersion) return;
        const tempComponent = new Component(comp, { x: 0, y: 0 });
        
        const symbol = comp.symbol;
        const paddingX = 6;
        const paddingY = 10;
        
        // Get bounds from the Component class
        const localBounds = tempComponent._getLocalBounds();
        
        // Validate numeric values
        if (!Number.isFinite(localBounds.minX) || !Number.isFinite(localBounds.minY) ||
            !Number.isFinite(localBounds.maxX) || !Number.isFinite(localBounds.maxY)) {
            throw new Error('Invalid symbol bounds');
        }
        
        // Create preview SVG using the same rendering as the actual component
        const viewBox = `${localBounds.minX - paddingX} ${localBounds.minY - paddingY} ${localBounds.maxX - localBounds.minX + paddingX * 2} ${localBounds.maxY - localBounds.minY + paddingY * 2}`;
        
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', viewBox);
        svg.setAttribute('style', 'width:100%;height:100%;max-height:150px');
        
        // Render graphics
        if (symbol.graphics && Array.isArray(symbol.graphics)) {
            for (const graphic of symbol.graphics) {
                const el = createSymbolGraphicElement(tempComponent, graphic, ns);
                if (el) svg.appendChild(el);
            }
        }
        
        // Render pins
        if (symbol.pins && Array.isArray(symbol.pins)) {
            for (const pin of symbol.pins) {
                const pinGroup = createSymbolPinElement(tempComponent, pin, ns);
                if (pinGroup) svg.appendChild(pinGroup);
            }
        }
        
        picker.previewSvg.innerHTML = '';
        picker.previewSvg.appendChild(svg);
        
        // Update info
        let info = `<strong>${escapeHtml(comp.name || 'Component')}</strong>`;
        if (comp.description) {
            info += `<br><span style="color:var(--text-secondary)">${escapeHtml(comp.description)}</span>`;
        }
        if (symbol.pins) {
            info += `<br><span style="color:var(--text-muted)">${symbol.pins.length} pins</span>`;
        }
        if (comp.category) {
            info += `<br><span style="color:var(--text-muted)">${escapeHtml(comp.category)}</span>`;
        }
        picker.previewInfo.innerHTML = info;

        if (!options.skipFootprint3d) {
            updateFootprintPreview(picker, comp);
            update3dPreview(picker, comp);
        }
    } catch (error) {
        console.error('Error updating preview:', error);
        picker.previewSvg.innerHTML = '<div style="color:var(--accent-color);text-align:center;padding:20px">Preview error</div>';
        picker.previewInfo.innerHTML = `<span style="color:var(--accent-color);font-size:12px">${escapeHtml(errorMessage(error))}</span>`;
        if (!options.skipFootprint3d) {
            setFootprintPreviewStatus(picker, 'Footprint preview error', false);
            set3dPreviewStatus(picker, '3D preview error', false);
        }
    }
}

/**
 * Computes the bounding box of a symbol's graphics and pins.
 * @param {SymbolDefinitionLike|null|undefined} symbol - The symbol definition with graphics and pins arrays.
 * @returns {{minX:number, minY:number, maxX:number, maxY:number, width:number, height:number}|null} Bounds object with minX, minY, maxX, maxY, width, height, or null if invalid.
 */
export function computeSymbolBounds(/** @type {ComponentPicker} */ picker, symbol) {
    if (!symbol) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    /**
     * @param {number|undefined} x
     * @param {number|undefined} y
     */
    const includePoint = (x, y) => {
        const nx = Number(x);
        const ny = Number(y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        if (nx < minX) minX = nx;
        if (ny < minY) minY = ny;
        if (nx > maxX) maxX = nx;
        if (ny > maxY) maxY = ny;
    };

    if (Array.isArray(symbol.graphics)) {
        for (const g of symbol.graphics) {
            if (!g || typeof g !== 'object') continue;
            switch (g.type) {
                case 'line':
                    includePoint(g.x1, g.y1);
                    includePoint(g.x2, g.y2);
                    break;
                case 'rect':
                    includePoint(g.x, g.y);
                    includePoint(/** @type {number} */ (g.x) + /** @type {number} */ (g.width), /** @type {number} */ (g.y) + /** @type {number} */ (g.height));
                    break;
                case 'circle':
                    includePoint(/** @type {number} */ (g.cx) - /** @type {number} */ (g.r), /** @type {number} */ (g.cy) - /** @type {number} */ (g.r));
                    includePoint(/** @type {number} */ (g.cx) + /** @type {number} */ (g.r), /** @type {number} */ (g.cy) + /** @type {number} */ (g.r));
                    break;
                case 'arc':
                    includePoint(/** @type {number} */ (g.cx) - /** @type {number} */ (g.r), /** @type {number} */ (g.cy) - /** @type {number} */ (g.r));
                    includePoint(/** @type {number} */ (g.cx) + /** @type {number} */ (g.r), /** @type {number} */ (g.cy) + /** @type {number} */ (g.r));
                    break;
                case 'polyline':
                case 'polygon':
                    if (Array.isArray(g.points)) {
                        for (const p of g.points) {
                            if (Array.isArray(p) && p.length >= 2) {
                                includePoint(p[0], p[1]);
                            }
                        }
                    }
                    break;
                case 'text':
                    includePoint(g.x, g.y);
                    break;
            }
        }
    }

    if (Array.isArray(symbol.pins)) {
        for (const pin of symbol.pins) {
            if (!pin || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) continue;

            includePoint(pin.x, pin.y);

            const length = Number.isFinite(pin.length) ? /** @type {number} */ (pin.length) : 2.54;
            let x2 = pin.x;
            let y2 = pin.y;

            switch (pin.orientation) {
                case 'right':
                    x2 = pin.x + length;
                    break;
                case 'left':
                    x2 = pin.x - length;
                    break;
                case 'up':
                    y2 = pin.y - length;
                    break;
                case 'down':
                    y2 = pin.y + length;
                    break;
                default:
                    x2 = pin.x + length;
            }

            includePoint(x2, y2);
        }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
    }

    return {
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX,
        height: maxY - minY
    };
}

/**
 * Renders an array of graphic primitives into SVG markup strings.
 * @param {SymbolGraphicLike[]|null|undefined} graphics - Array of graphic objects (line, rect, circle, etc.).
 * @param {number} [defaultStrokeWidth=0.254] - Default stroke width for rendered elements.
 * @returns {string} Concatenated SVG element strings.
 */
export function renderGraphicsToSVG(/** @type {ComponentPicker} */ picker, graphics, defaultStrokeWidth = 0.254) {
    try {
        if (!graphics || !Array.isArray(graphics)) return '';
        
        let svg = '';
        for (const g of graphics) {
            try {
                // Use theme colors - replace black with CSS variable
                let stroke = g.stroke || '#000000';
                if (stroke === '#000000' || stroke === '#000' || stroke === 'black') {
                    stroke = 'var(--schematic-component, #00cc66)';
                }
                const strokeWidth = g.strokeWidth || defaultStrokeWidth;
                let fill = g.fill || 'none';
                if (fill === '#000000' || fill === '#000' || fill === 'black') {
                    fill = 'var(--schematic-component, #00cc66)';
                }
                
                switch (g.type) {
                    case 'line':
                        svg += `<line x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" 
                                      stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
                        break;
                        
                    case 'rect':
                        svg += `<rect x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}"
                                      stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"
                                      ${g.rx ? `rx="${g.rx}"` : ''}/>`;
                        break;
                        
                    case 'circle':
                        svg += `<circle cx="${g.cx}" cy="${g.cy}" r="${g.r}"
                                        stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                        break;
                        
                    case 'ellipse':
                        svg += `<ellipse cx="${g.cx}" cy="${g.cy}" rx="${g.rx}" ry="${g.ry}"
                                         stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                        break;
                        
                    case 'polyline':
                        if (g.points && Array.isArray(g.points)) {
                            const polylinePoints = g.points.map(p => `${p[0]},${p[1]}`).join(' ');
                            svg += `<polyline points="${polylinePoints}"
                                              stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                        }
                        break;
                        
                    case 'polygon':
                        if (g.points && Array.isArray(g.points)) {
                            const polygonPoints = g.points.map(p => `${p[0]},${p[1]}`).join(' ');
                            svg += `<polygon points="${polygonPoints}"
                                             stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                        }
                        break;
                        
                    case 'path':
                        if (g.d) {
                            svg += `<path d="${g.d}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}"/>`;
                        }
                        break;
                        
                    case 'text':
                        // Skip text in mini previews, show in full preview
                        if (defaultStrokeWidth > 0.2 && g.text) {
                            const anchor = g.anchor || 'start';
                            const baseline = g.baseline || 'middle';
                            let text = g.text.replace('${REF}', 'U1').replace('${VALUE}', '').replace('${NAME}', '');
                            let textColor = g.color || '#000';
                            if (textColor === '#000000' || textColor === '#000' || textColor === 'black') {
                                textColor = 'var(--schematic-text, #cccccc)';
                            }
                            svg += `<text x="${g.x}" y="${g.y}" font-size="${g.fontSize || 1.27}" 
                                          font-family="sans-serif" fill="${textColor}"
                                          text-anchor="${anchor}" dominant-baseline="${baseline}">${text}</text>`;
                        }
                        break;
                }
            } catch (itemError) {
                console.warn('Error rendering graphic item:', itemError, g);
                // Skip this item and continue with others
            }
        }
        return svg;
    } catch (error) {
        console.error('Error rendering graphics:', error);
        return '';
    }
}

/**
 * Renders a single component pin as SVG markup including its connection line and endpoint dot.
 * @param {SymbolPinLike|null|undefined} pin - The pin object with x, y coordinates and optional path data.
 * @returns {string} SVG markup string for the pin.
 */
export function renderPinToSVG(/** @type {ComponentPicker} */ picker, pin) {
    try {
        if (!pin || typeof pin.x !== 'number' || typeof pin.y !== 'number') {
            return '';
        }
        
        const strokeWidth = 0.2;
        let svg = '';
        
        // Parse the actual path from pin data if available
        let lineX1, lineY1, lineX2, lineY2;
        
        if (pin._pathData) {
            // Parse SVG path commands (M x y h dx, M x y v dy, M x y L x2 y2)
            const pathMatch = pin._pathData.match(/M\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*([hvL])\s*(-?\d+(?:\.\d+)?)/i);
            if (pathMatch) {
                lineX1 = Number(pathMatch[1]);
                lineY1 = Number(pathMatch[2]);
                const cmd = pathMatch[3].toLowerCase();
                const value = Number(pathMatch[4]);
                
                if (cmd === 'h') {
                    lineX2 = lineX1 + value;
                    lineY2 = lineY1;
                } else if (cmd === 'v') {
                    lineX2 = lineX1;
                    lineY2 = lineY1 + value;
                } else if (cmd === 'l') {
                    lineX2 = lineX1 + value;
                    lineY2 = lineY1;
                }
            } else {
                // Try alternate format without spaces: M345,285h10
                const pathMatch2 = pin._pathData.match(/M(-?\d+(?:\.\d+)?)[,\s](-?\d+(?:\.\d+)?)([hvL])(-?\d+(?:\.\d+)?)/i);
                if (pathMatch2) {
                    lineX1 = Number(pathMatch2[1]);
                    lineY1 = Number(pathMatch2[2]);
                    const cmd = pathMatch2[3].toLowerCase();
                    const value = Number(pathMatch2[4]);
                    
                    if (cmd === 'h') {
                        lineX2 = lineX1 + value;
                        lineY2 = lineY1;
                    } else if (cmd === 'v') {
                        lineX2 = lineX1;
                        lineY2 = lineY1 + value;
                    } else if (cmd === 'l') {
                        lineX2 = lineX1 + value;
                        lineY2 = lineY1;
                    }
                }
            }
        }
        
        // If we successfully parsed the path, render it
        if (Number.isFinite(lineX1) && Number.isFinite(lineY1) && 
            Number.isFinite(lineX2) && Number.isFinite(lineY2)) {
            svg += `<line x1="${lineX1}" y1="${lineY1}" x2="${lineX2}" y2="${lineY2}" 
                          stroke="var(--schematic-component, #00cc66)" stroke-width="${strokeWidth}"/>`;
        }
        
        // Pin endpoint dot at connection point (pin.x, pin.y)
        svg += `<circle cx="${pin.x}" cy="${pin.y}" r="0.4" fill="var(--schematic-pin, #e94560)" stroke="none"/>`;
        
        return svg;
    } catch (error) {
        console.warn('Error rendering pin:', error, pin);
        return '';
    }
}
