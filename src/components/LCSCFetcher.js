/**
 * LCSCFetcher - Fetches component metadata from LCSC API
 * 
 * This module handles:
 * - Component search
 * - Pricing information
 * - Stock levels
 * - Basic/Extended part status
 * - Manufacturer part numbers (MPN)
 * - Datasheet links
 * 
 * Note: LCSC may block CORS proxy requests. If so, use KiCad library search instead.
 * Symbol and footprint data comes from KiCadFetcher.
 */

/**
 * Shrink an OBJ string for storage by rounding geometry coordinates to 4
 * decimal places (0.1 µm — far finer than the 3D viewer needs). Suppliers ship
 * 6-decimal vertices/normals, which bloats the serialised document for no
 * visual benefit. Only numeric data on geometry lines (v, vn, vt) is touched;
 * material/face/group lines pass through unchanged. Idempotent, so it is safe
 * to run again at save time on already-stored models.
 * @param {string} objText
 * @returns {string}
 */
export function compactObjText(objText) {
    if (!objText) return objText;
    const round = (/** @type {string} */ m) => {
        const n = Math.round(parseFloat(m) * 1e4) / 1e4;
        return Number.isFinite(n) ? String(n) : m;
    };
    return objText.split('\n').map((line) => {
        // Only geometry lines carry the high-precision coordinates worth
        // shrinking; leave faces, materials, groups, etc. untouched.
        if (/^(v|vn|vt) /.test(line)) {
            return line.replace(/-?\d+\.\d+(?:[eE][-+]?\d+)?/g, round);
        }
        return line;
    }).join('\n');
}

/**
 * Default mesh-decimation cell size (mm) applied to supplier 3D models on
 * fetch. 0.05 mm is visually lossless for typical SMD parts while removing
 * ~90% of the triangles. Raise for smaller files at the cost of facet detail.
 */
export const MODEL_SIMPLIFY_GRID_MM = 0.05;

/**
 * Aggressively shrink an OBJ string by mesh decimation (vertex clustering).
 *
 * Supplier 3D models are wildly over-tessellated for our use — a single
 * passive can ship 30-40k triangles where a few hundred render identically at
 * the sizes the board viewer shows. This collapses the mesh by snapping every
 * vertex to a {@link gridMm}-spaced grid, merging all vertices in a cell to
 * their centroid, and dropping triangles that collapse to a line. It also
 * discards the `vn`/`vt` lines and the `//` normal/texcoord refs on faces,
 * which {@link parseObjModel} and the renderer ignore entirely (the renderer
 * recomputes vertex normals), so they are pure dead weight.
 *
 * Inline materials (`newmtl`/`Kd`/`endmtl`) and per-face colours are preserved:
 * faces are re-grouped under their `usemtl` so region colours stay correct.
 * Lossy on geometry (a deliberate quality-for-size trade) — run at fetch time,
 * NOT idempotently at save (re-running shrinks further). Returns the input
 * unchanged if it cannot be parsed.
 *
 * @param {string} objText raw Wavefront OBJ text
 * @param {{gridMm?:number}} [opts] gridMm: cluster cell size in mm (bigger = smaller/coarser; 0.05 is near-lossless for typical parts)
 * @returns {string}
 */
export function simplifyObjModel(objText, opts = {}) {
    if (!objText) return objText;
    const gridMm = opts.gridMm ?? 0.05;
    if (!(gridMm > 0)) return objText;

    /** @type {Array<[number,number,number]>} */
    const verts = [];
    /** Material definition blocks, emitted verbatim up front. */
    const mtlLines = [];
    /** @type {Map<string, Array<[number,number,number]>>} material name → triangles (vertex indices, 0-based) */
    const groups = new Map();
    let curMtl = '__default__';
    let inMtl = false;

    for (const raw of objText.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const sp = line.indexOf(' ');
        const kw = sp < 0 ? line : line.slice(0, sp);
        const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
        if (kw === 'v') {
            const p = rest.split(/\s+/);
            verts.push([+p[0], +p[1], +p[2]]);
        } else if (kw === 'newmtl') {
            inMtl = true;
            mtlLines.push(line);
        } else if (kw === 'Kd' || kw === 'Ka' || kw === 'Ks' || kw === 'Ns' || kw === 'd' || kw === 'Tr' || kw === 'illum' || kw === 'Ke' || kw === 'Ni') {
            if (inMtl) mtlLines.push(line);
        } else if (kw === 'endmtl') {
            inMtl = false;
            mtlLines.push(line);
        } else if (kw === 'usemtl') {
            curMtl = rest || '__default__';
            if (!groups.has(curMtl)) groups.set(curMtl, []);
        } else if (kw === 'f') {
            const p = rest.split(/\s+/);
            const idx = p.map((tok) => parseInt(tok.split('/')[0], 10) - 1);
            if (idx.length < 3 || idx.some((i) => i < 0 || Number.isNaN(i))) continue;
            let bucket = groups.get(curMtl);
            if (!bucket) { bucket = []; groups.set(curMtl, bucket); }
            // Fan-triangulate, matching parseObjModel.
            for (let i = 1; i + 1 < idx.length; i++) bucket.push([idx[0], idx[i], idx[i + 1]]);
        }
    }
    if (!verts.length || !groups.size) return objText;

    // Cluster vertices to a grid; each occupied cell becomes one centroid vertex.
    const inv = 1 / gridMm;
    /** @type {Map<string, number>} cell key → new vertex index (0-based) */
    const cellId = new Map();
    /** @type {Array<[number,number,number,number]>} accumulator [sx,sy,sz,count] */
    const acc = [];
    const remap = new Int32Array(verts.length);
    for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const key = Math.round(v[0] * inv) + ',' + Math.round(v[1] * inv) + ',' + Math.round(v[2] * inv);
        let id = cellId.get(key);
        if (id === undefined) {
            id = acc.length;
            cellId.set(key, id);
            acc.push([0, 0, 0, 0]);
        }
        remap[i] = id;
        const a = acc[id];
        a[0] += v[0]; a[1] += v[1]; a[2] += v[2]; a[3]++;
    }

    const r4 = (/** @type {number} */ n) => {
        const x = Math.round(n * 1e4) / 1e4;
        return Number.isFinite(x) ? String(x) : '0';
    };
    const out = [];
    for (const m of mtlLines) out.push(m);
    // Centroid vertex per cell (1-indexed in OBJ).
    for (const a of acc) {
        out.push('v ' + r4(a[0] / a[3]) + ' ' + r4(a[1] / a[3]) + ' ' + r4(a[2] / a[3]));
    }
    // Faces, grouped by material, remapped and de-degenerated.
    for (const [mtl, tris] of groups) {
        if (!tris.length) continue;
        let emittedUse = false;
        for (const t of tris) {
            const a = remap[t[0]], b = remap[t[1]], c = remap[t[2]];
            if (a === b || b === c || a === c) continue; // collapsed to a line/point
            if (!emittedUse && mtl !== '__default__') { out.push('usemtl ' + mtl); emittedUse = true; }
            out.push('f ' + (a + 1) + ' ' + (b + 1) + ' ' + (c + 1));
        }
    }
    return out.join('\n');
}

export class LCSCFetcher {
    /** Initialise API endpoints, CORS proxies and in-memory caches. */
    constructor() {
        // CORS proxy list (try multiple fallbacks)
        // Tokens: {encodedUrl}, {url}, {urlSansScheme}
        // Use dedicated Cloudflare Worker proxy provided by user
        this.corsProxies = [
            'https://clearpcb.mikealex.workers.dev/?url={encodedUrl}'
        ];
        this.lastWorkingProxy = null;
        
        // API endpoints
        this.searchUrl = 'https://wwwapi.lcsc.com/v1/search/global-search';
        this.easyedaSearchUrl = 'https://easyeda.com/api/components/search';
        this.easyedaUid = '0819f05c4eef4c71ace90d822a990e87';
        this.easyedaVersion = '6.5.51';
        this.easyedaDetailVersion = '6.4.19.5';
        
        // Cache for component metadata
        this.metadataCache = new Map();
        this.imageCache = new Map();
        
        // Track CORS status
        this.corsBlocked = false;
    }

    /**
     * Normalise a search query — trims whitespace and upper-cases LCSC part numbers.
     * @param {string} query
     * @returns {string}
     */
    _normalizeQuery(query) {
        const trimmed = (query || '').trim();
        if (/^c\d+$/i.test(trimmed)) {
            return trimmed.toUpperCase();
        }
        return trimmed;
    }

    /**
     * Normalize an LCSC part number for case-insensitive comparisons.
     * @param {string} partNumber
     * @returns {string}
     */
    _normalizePartLookupKey(partNumber) {
        return this._normalizeQuery(partNumber).toUpperCase();
    }

    /**
     * Find exact LCSC part match in search results.
     * @param {Array} results
     * @param {string} normalizedPart
     * @returns {Object|undefined}
     */
    _findExactLCSCResult(results, normalizedPart) {
        const expectedPartKey = this._normalizePartLookupKey(normalizedPart);
        return results.find(item =>
            this._normalizePartLookupKey(item.lcscPartNumber || '') === expectedPartKey
        );
    }

    /**
     * Read metadata cache entry only when it already contains useful symbol/footprint/3D data.
     * Invalid cached placeholders are removed.
     * @param {string} normalizedPart
     * @returns {Object|null}
     */
    _getCachedMetadataIfComplete(normalizedPart) {
        if (!this.metadataCache.has(normalizedPart)) {
            return null;
        }

        const cached = this.metadataCache.get(normalizedPart);
        if (cached?.hasEasyedaSymbol || cached?.hasFootprint || cached?.has3d) {
            return cached;
        }

        this.metadataCache.delete(normalizedPart);
        return null;
    }

    /**
     * Returns proxy order, optionally prioritising the last known working proxy.
     * @param {boolean} [preferLastWorking=true]
     * @returns {string[]}
     */
    _getProxyOrder(preferLastWorking = true) {
        if (!preferLastWorking || !this.lastWorkingProxy) {
            return [...this.corsProxies];
        }
        return [this.lastWorkingProxy, ...this.corsProxies.filter(p => p !== this.lastWorkingProxy)];
    }

    /**
     * Expand proxy template tokens for a target URL.
     * @param {string} proxy
     * @param {string} targetUrl
     * @returns {string}
     */
    _buildProxyUrl(proxy, targetUrl) {
        const encodedUrl = encodeURIComponent(targetUrl);
        const urlSansScheme = targetUrl.replace(/^https?:\/\//, '');
        return proxy
            .replace('{encodedUrl}', encodedUrl)
            .replace('{urlSansScheme}', urlSansScheme)
            .replace('{url}', targetUrl);
    }

    /**
     * Fetch text from a target URL through a specific proxy template.
     * @param {string} proxy
     * @param {string} targetUrl
     * @param {RequestInit} [options]
     * @returns {Promise<{text?: string, status?: number, error?: Error}>}
     */
    async _fetchProxyText(proxy, targetUrl, options = {}) {
        const proxyUrl = this._buildProxyUrl(proxy, targetUrl);
        try {
            const response = await fetch(proxyUrl, options);
            if (!response.ok) {
                return { status: response.status };
            }

            const text = await response.text();
            return { text };
        } catch (error) {
            return { error };
        }
    }

    /**
     * Parse JSON from response text with fallback for prefixed proxy content.
     * Only accepts objects/arrays — bare primitives (number, string, null) are
     * rejected because they always indicate a corrupted or non-JSON response
     * from a misbehaving proxy.
     * @param {string} text
     * @returns {{data?: any, error?: Error}}
     */
    _parseJsonWithRecovery(text) {
        const accept = (value) => {
            if (value === null || typeof value !== 'object') {
                return { error: new Error('LCSC: expected JSON object, got ' + typeof value) };
            }
            return { data: value };
        };
        try {
            return accept(JSON.parse(text));
        } catch (parseError) {
            const jsonStart = text.indexOf('{');
            if (jsonStart !== -1) {
                try {
                    return accept(JSON.parse(text.slice(jsonStart)));
                } catch (retryError) {
                    return { error: retryError };
                }
            }
            return { error: parseError };
        }
    }

    /**
     * Fetch JSON from a target URL through the CORS proxy list.
     * Tries proxies in order; returns `{ data }` on success or `{ error }` on failure.
     * @param {string} targetUrl
     * @param {RequestInit} [options]
     * @returns {Promise<{data?: any, error?: Error}>}
     */
    async _fetchJsonWithProxies(targetUrl, options = {}) {
        const proxies = this._getProxyOrder(true);

        let lastError = null;

        for (const proxy of proxies) {
            const result = await this._fetchProxyText(proxy, targetUrl, options);
            if (typeof result.status === 'number') {
                lastError = new Error(`HTTP ${result.status}`);
                continue;
            }
            if (result.error) {
                lastError = result.error;
                continue;
            }
            if (typeof result.text !== 'string') {
                continue;
            }

            const parsed = this._parseJsonWithRecovery(result.text);
            if (parsed.error) {
                lastError = parsed.error;
                continue;
            }

            this.corsBlocked = false;
            this.lastWorkingProxy = proxy;
            return { data: parsed.data };
        }

        this.corsBlocked = true;
        return { error: lastError };
    }

    /**
     * Search the EasyEDA component API.
     * @param {string} query
     * @returns {Promise<Array>} Normalised search result objects
     */
    async _searchEasyEDA(query) {
        const normalizedQuery = this._normalizeQuery(query);

        const formBody = new URLSearchParams({
            type: '3',
            'doctype[]': '2',
            uid: this.easyedaUid,
            returnListStyle: 'classifyarr',
            wd: normalizedQuery,
            version: this.easyedaVersion
        }).toString();

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': 'application/json'
            },
            body: formBody
        };

        const result = await this._fetchJsonWithProxies(this.easyedaSearchUrl, options);
        if (result?.data) {
            const data = result.data;
            const list = this._extractEasyEDAList(data);
            if (list.length > 0) {
                return this._formatEasyEDASearchResults(list);
            }
        }

        return [];
    }

    /**
     * Fetch detailed component data (symbol, footprint, 3D) from EasyEDA.
     * @param {string} lcscPartNumber - e.g. 'C46749'
     * @returns {Promise<Object|null>} Component detail or null
     */
    async _fetchEasyEDADetail(lcscPartNumber) {
        const normalizedPart = this._normalizeQuery(lcscPartNumber);
        const targetUrl = `https://easyeda.com/api/products/${encodeURIComponent(normalizedPart)}/components?version=${this.easyedaDetailVersion}`;
        const result = await this._fetchJsonWithProxies(targetUrl);
        if (result?.data?.result) {
            return result.data.result;
        }
        return null;
    }

    /**
     * Fetch a 3D model (OBJ format) from the EasyEDA modules API.
     * @param {string} uuid3d - Model UUID
     * @param {string} [datastrid] - Data string ID (unused, reserved)
     * @returns {Promise<string|null>} OBJ text or null
     */
    async _fetchEasyEDA3DModel(uuid3d, datastrid) {
        // EasyEDA stores 3D models in OBJ format at modules.easyeda.com
        if (uuid3d) {
            const targetUrl = `https://modules.easyeda.com/3dmodel/${uuid3d}`;
            console.log('Fetching EasyEDA 3D model from:', targetUrl);

            for (const proxy of this._getProxyOrder(false)) {
                const result = await this._fetchProxyText(proxy, targetUrl);
                if (typeof result.status === 'number') {
                    console.log('3D model not found (HTTP', result.status, ')');
                    continue;
                }
                if (result.error) {
                    console.log('Failed to fetch EasyEDA 3D model:', result.error.message);
                    continue;
                }

                const objText = result.text;
                if (objText && objText.includes('v ')) {
                    console.log('Successfully fetched OBJ file, size:', objText.length);
                    // Supplier models are wildly over-tessellated (a TSSOP ships
                    // ~38k triangles, ~1.3 MB). Decimate once on entry: a 0.05 mm
                    // cluster grid is visually lossless at the sizes the board
                    // viewer shows yet shrinks the stored model ~90%, which flows
                    // straight through to the saved .cpcb document.
                    const simplified = simplifyObjModel(objText, { gridMm: MODEL_SIMPLIFY_GRID_MM });
                    console.log('Simplified OBJ size:', simplified.length, `(${(simplified.length / objText.length * 100).toFixed(0)}% of original)`);
                    return simplified;
                }
            }
        }
        return null;
    }

    /**
     * Extract the component list array from various EasyEDA response shapes.
     * @param {Object|Array} data - Raw EasyEDA API response
     * @returns {Array}
     */
    _extractEasyEDAList(data) {
        if (!data) return [];
        if (Array.isArray(data)) return data;

        // EasyEDA response shape: { success, result: { lists: { lcsc: [...] } } }
        if (data.result && data.result.lists) {
            if (Array.isArray(data.result.lists.lcsc)) return data.result.lists.lcsc;
            if (Array.isArray(data.result.lists.szlcs)) return data.result.lists.szlcs;
        }

        const candidates = [
            data.result,
            data.data,
            data.list,
            data.items,
            data.productList,
            data.success && data.result ? data.result : null
        ];

        for (const candidate of candidates) {
            if (Array.isArray(candidate)) return candidate;
            if (candidate && Array.isArray(candidate.list)) return candidate.list;
            if (candidate && Array.isArray(candidate.items)) return candidate.items;
        }

        return [];
    }

    /**
     * Map raw EasyEDA search items to normalised result objects.
     * @param {Array} items - Raw result items
     * @returns {Array<Object>} Normalised results with lcscPartNumber, mpn, etc.
     */
    _formatEasyEDASearchResults(items) {
        return items.map(item => {
            const lcscPartNumber = item?.lcsc?.number || item?.szlcsc?.number || item.lcscPartNumber || item.lcsc_part_number || item.lcsc || item.productCode || item.product_code || item.component_code || item.componentCode || item.lcsc_number || '';
            const imageUrl = this._normalizeEasyedaUrl(item?.szlcsc?.image || item.imageUrl || item.image || item.productImageUrl || item.productImageUrlBig || '');
            const thumbUrl = this._normalizeEasyedaUrl(item.thumb || item.thumbUrl || item.thumbnail || '');
            const fallbackThumb = lcscPartNumber
                ? this._buildEasyedaProductImageUrl(lcscPartNumber)
                : '';

            return {
                lcscPartNumber,
                mpn: item?.dataStr?.head?.c_para?.['Manufacturer Part'] || item.mpn || item.productModel || item.model || item.part_number || item.partNumber || item.title || '',
                manufacturer: item?.dataStr?.head?.c_para?.Manufacturer || item.manufacturer || item.brand || item.brandName || item.brand_name || '',
                description: item?.dataStr?.head?.c_para?.Value || item.description || item.intro || item.productIntro || item.productIntroEn || item.productDesc || item.productDescEn || item.title || '',
                category: item.category || item.catalog || item.catalogName || item.parentCatalogName || item.class || '',
                package: item?.dataStr?.head?.c_para?.package || item.package || item.encapStandard || item.footprint || '',
                stock: item?.lcsc?.stock || item?.szlcsc?.stock || item.stock || item.stockNumber || item.stock_number || 0,
                price: item?.lcsc?.price || item?.szlcsc?.price || item.price || item.unitPrice || item.usdPrice || null,
                isBasic: item.isBasic || item.is_basic || false,
                isPreferred: item.isPreferred || item.is_preferred || false,
                imageUrl,
                thumbUrl: thumbUrl || imageUrl || fallbackThumb,
                datasheet: item.datasheet || item.pdf || item.pdfUrl || '',
                productUrl: item?.lcsc?.url || item?.szlcsc?.url || item.productUrl || item.url || this._buildLCSCProductUrl(lcscPartNumber)
            };
        });
    }

    /**
     * Convert protocol-relative URLs to absolute HTTPS.
     * @param {string} url
     * @returns {string}
     */
    _normalizeEasyedaUrl(url) {
        if (!url || typeof url !== 'string') return '';
        if (url.startsWith('//')) return `https:${url}`;
        return url;
    }

    /**
     * Build LCSC product-detail URL for a part number.
     * @param {string} partNumber
     * @returns {string}
     */
    _buildLCSCProductUrl(partNumber) {
        return partNumber ? `https://www.lcsc.com/product-detail/${partNumber}.html` : '';
    }

    /**
     * Build EasyEDA product-image API URL for a part number.
     * @param {string} partNumber
     * @returns {string}
     */
    _buildEasyedaProductImageUrl(partNumber) {
        if (!partNumber) {
            return '';
        }
        return `https://easyeda.com/api/eda/product/img/${encodeURIComponent(partNumber)}?version=${this.easyedaVersion}`;
    }

    /**
     * Search for components on LCSC
     * @param {string} query - Search query
     * @returns {Promise<Array>} Search results
     */
    async search(query) {
        const normalizedQuery = this._normalizeQuery(query);
        console.log('EasyEDA search for:', normalizedQuery);

        try {
            const easyedaResults = await this._searchEasyEDA(normalizedQuery);
            if (easyedaResults.length > 0) {
                return easyedaResults;
            }
        } catch (error) {
            console.error('EasyEDA search error:', error);
        }

        return [];
    }

    /**
     * Extract a 3D model UUID from EasyEDA shape data.
     * @param {Array} shapeList
     * @returns {string|null}
     */
    _extractModel3DUuidFromShapes(shapeList) {
        if (!Array.isArray(shapeList)) {
            return null;
        }

        for (const shape of shapeList) {
            if (typeof shape !== 'string' || !shape.startsWith('SVGNODE~')) {
                continue;
            }

            try {
                const jsonStr = shape.substring(8);
                const svgData = JSON.parse(jsonStr);
                const uuid = svgData?.attrs?.uuid;
                if (uuid) {
                    return uuid;
                }
            } catch (error) {
                console.warn('Failed to parse SVGNODE:', error);
            }
        }

        return null;
    }

    /**
     * Apply EasyEDA detail response to a normalized result item.
     * @param {Object} exact
     * @param {Object|null} detail
     * @returns {Promise<void>}
     */
    async _applyEasyEDADetailToMetadata(exact, detail) {
        if (detail?.dataStr && Array.isArray(detail.dataStr.shape)) {
            exact.easyedaSymbolData = detail.dataStr;
            exact.easyedaSymbolBBox = detail.dataStr.BBox || detail.dataStr.bbox || null;
            exact.hasEasyedaSymbol = true;
        } else {
            exact.hasEasyedaSymbol = false;
        }

        if (!detail?.packageDetail?.dataStr) {
            exact.hasFootprint = false;
            exact.has3d = false;
            return;
        }

        const dataStr = detail.packageDetail.dataStr;
        exact.footprintName = detail.packageDetail.title || dataStr?.head?.c_para?.package || '';
        exact.footprintShapes = Array.isArray(dataStr.shape) ? dataStr.shape : [];
        exact.footprintBBox = dataStr.BBox || dataStr.bbox || null;
        exact.model3dName = dataStr?.head?.c_para?.['3DModel'] || '';
        exact.hasFootprint = exact.footprintShapes.length > 0;
        exact.has3d = !!exact.model3dName;

        if (!exact.has3d) {
            return;
        }

        const model3dUuid = this._extractModel3DUuidFromShapes(dataStr.shape);
        if (!model3dUuid) {
            console.log('No 3D model UUID found in SVGNODE');
            return;
        }

        console.log('Fetching 3D model for uuid:', model3dUuid);
        const model3dData = await this._fetchEasyEDA3DModel(model3dUuid);
        if (model3dData) {
            console.log('Successfully fetched 3D model data (OBJ format)');
            exact.model3dObj = model3dData;
        }
    }
    
    /**
     * Fetch detailed metadata for a specific component
     * @param {string} lcscPartNumber - LCSC part number (e.g., "C46749")
     * @returns {Promise<object>} Component metadata
     */
    async fetchComponentMetadata(lcscPartNumber) {
        const normalizedPart = this._normalizeQuery(lcscPartNumber);
        const cached = this._getCachedMetadataIfComplete(normalizedPart);
        if (cached) {
            return cached;
        }

        // Try EasyEDA search first
        try {
            const easyedaResults = await this._searchEasyEDA(normalizedPart);
            const exact = this._findExactLCSCResult(easyedaResults, normalizedPart);

            if (exact) {
                // Fetch detail to get footprint + 3D data
                const detail = await this._fetchEasyEDADetail(normalizedPart);
                await this._applyEasyEDADetailToMetadata(exact, detail);

                this.metadataCache.set(normalizedPart, exact);
                return exact;
            }
        } catch (error) {
            console.error('EasyEDA metadata fetch error:', error);
        }

        return null;
    }

    /**
     * Fetch a product image URL from the EasyEDA product image API.
     * Results are cached by normalised part number.
     * @param {string} lcscPartNumber
     * @returns {Promise<string>} Image URL or empty string
     */
    async fetchEasyedaProductImage(lcscPartNumber) {
        const normalizedPart = this._normalizeQuery(lcscPartNumber);
        if (!normalizedPart) return '';

        if (this.imageCache.has(normalizedPart)) {
            return this.imageCache.get(normalizedPart);
        }

        const targetUrl = this._buildEasyedaProductImageUrl(normalizedPart);
        const result = await this._fetchJsonWithProxies(targetUrl);
        const url = result?.data?.result || '';
        if (url) {
            this.imageCache.set(normalizedPart, url);
        }
        return url;
    }

    /**
     * Build normalized metadata fields shared by LCSC search and detail records.
     * @param {Object} product
     * @returns {Object}
     */
    _buildBaseProductMetadata(product) {
        return {
            lcscPartNumber: product.productCode || '',
            mpn: product.productModel || '',
            manufacturer: product.brandNameEn || '',
            description: product.productIntroEn || product.productDescEn || '',
            category: product.parentCatalogName || product.catalogName || '',
            package: product.encapStandard || '',
            stock: product.stockNumber || 0,
            price: this._extractPriceFromProduct(product),
            isBasic: product.isEnvironment === true,
            isPreferred: product.isHot === true,
            imageUrl: product.productImageUrl || product.productImageUrlBig || '',
            datasheet: product.pdfUrl || '',
            productUrl: this._buildLCSCProductUrl(product.productCode)
        };
    }
    
    /**
     * Format search results from LCSC API
     */
    _formatSearchResults(products) {
        return products.map(product => this._buildBaseProductMetadata(product));
    }
    
    /**
     * Extract metadata from a single product
     */
    _extractMetadataFromProduct(product) {
        return {
            ...this._buildBaseProductMetadata(product),
            priceBreaks: this._extractPriceBreaksFromProduct(product),
            minOrderQty: product.minBuyNumber || 1,
            stockStatus: product.stockNumber > 0 ? 'In Stock' : 'Out of Stock'
        };
    }
    
    /**
     * Extract best price from product
     */
    _extractPriceFromProduct(product) {
        if (product.productPriceList && product.productPriceList.length > 0) {
            return product.productPriceList[0].usdPrice || product.productPriceList[0].currencyPrice;
        }
        return null;
    }
    
    /**
     * Extract price breaks from product
     */
    _extractPriceBreaksFromProduct(product) {
        if (!product.productPriceList || product.productPriceList.length === 0) {
            return [];
        }
        
        return product.productPriceList.map(tier => ({
            quantity: tier.ladder,
            price: tier.usdPrice || tier.currencyPrice
        }));
    }
    
    /**
     * Get suggested KiCad library and symbol name for an MPN
     * @param {string} mpn - Manufacturer part number
     * @param {string} category - LCSC category
     * @returns {object} Suggested library and symbol
     */
    suggestKiCadMapping(mpn, category) {
        const mpnUpper = mpn.toUpperCase();
        const catLower = (category || '').toLowerCase();
        
        // Timer ICs
        if (mpnUpper.includes('555') || mpnUpper.includes('556')) {
            return { library: 'Timer', symbol: mpnUpper.includes('NE') ? 'NE555' : 'LM555' };
        }
        
        // Voltage regulators
        if (mpnUpper.match(/^(LM|L)?78\d{2}/)) {
            const voltage = mpnUpper.match(/78(\d{2})/)?.[1];
            return { library: 'Regulator_Linear', symbol: `LM78${voltage || '05'}` };
        }
        if (mpnUpper.match(/^(LM|L)?79\d{2}/)) {
            const voltage = mpnUpper.match(/79(\d{2})/)?.[1];
            return { library: 'Regulator_Linear', symbol: `LM79${voltage || '05'}` };
        }
        if (mpnUpper.includes('LM317') || mpnUpper.includes('LM1117') || mpnUpper.includes('AMS1117')) {
            if (mpnUpper.includes('1117')) {
                return { library: 'Regulator_Linear', symbol: 'LM1117' };
            }
            return { library: 'Regulator_Linear', symbol: 'LM317' };
        }
        
        // Op-amps
        if (mpnUpper.match(/^LM3(24|58)/)) {
            return { library: 'Amplifier_Operational', symbol: mpnUpper.includes('324') ? 'LM324' : 'LM358' };
        }
        if (mpnUpper.match(/^TL07[24]/)) {
            return { library: 'Amplifier_Operational', symbol: mpnUpper.includes('074') ? 'TL074' : 'TL072' };
        }
        
        // Microcontrollers
        if (mpnUpper.includes('ATMEGA328')) {
            return { library: 'MCU_Microchip_ATmega', symbol: 'ATmega328P' };
        }
        if (mpnUpper.includes('ATTINY85')) {
            return { library: 'MCU_Microchip_ATtiny', symbol: 'ATtiny85' };
        }
        if (mpnUpper.includes('STM32F103')) {
            return { library: 'MCU_ST_STM32F1', symbol: 'STM32F103C8' };
        }
        if (mpnUpper.includes('ESP32')) {
            return { library: 'MCU_Espressif_ESP32', symbol: 'ESP32-WROOM-32' };
        }
        if (mpnUpper.includes('ESP8266') || mpnUpper.includes('ESP-12')) {
            return { library: 'MCU_Espressif_ESP8266', symbol: 'ESP-12E' };
        }
        
        // Transistors
        if (mpnUpper.match(/^2N222[12]/)) {
            return { library: 'Transistor_BJT', symbol: '2N2222' };
        }
        if (mpnUpper.includes('2N3904')) {
            return { library: 'Transistor_BJT', symbol: '2N3904' };
        }
        if (mpnUpper.includes('2N3906')) {
            return { library: 'Transistor_BJT', symbol: '2N3906' };
        }
        if (mpnUpper.includes('BC547')) {
            return { library: 'Transistor_BJT', symbol: 'BC547' };
        }
        if (mpnUpper.includes('2N7000')) {
            return { library: 'Transistor_FET', symbol: '2N7000' };
        }
        if (mpnUpper.includes('IRLZ44')) {
            return { library: 'Transistor_FET', symbol: 'IRLZ44N' };
        }
        
        // Diodes
        if (mpnUpper.includes('1N4148')) {
            return { library: 'Diode', symbol: '1N4148' };
        }
        if (mpnUpper.includes('1N4007') || mpnUpper.includes('1N400')) {
            return { library: 'Diode', symbol: '1N4007' };
        }
        if (mpnUpper.includes('1N5819')) {
            return { library: 'Diode', symbol: '1N5819' };
        }
        
        // Category-based fallbacks
        if (catLower.includes('resistor')) {
            return { library: 'Device', symbol: 'R' };
        }
        if (catLower.includes('capacitor')) {
            return { library: 'Device', symbol: 'C' };
        }
        if (catLower.includes('inductor')) {
            return { library: 'Device', symbol: 'L' };
        }
        if (catLower.includes('led')) {
            return { library: 'LED', symbol: 'LED' };
        }
        if (catLower.includes('crystal')) {
            return { library: 'Device', symbol: 'Crystal' };
        }
        
        // No mapping found
        return null;
    }
}

export default LCSCFetcher;