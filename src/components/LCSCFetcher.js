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

export class LCSCFetcher {
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

    _normalizeQuery(query) {
        const trimmed = (query || '').trim();
        if (/^c\d+$/i.test(trimmed)) {
            return trimmed.toUpperCase();
        }
        return trimmed;
    }


    async _fetchJsonWithProxies(targetUrl, options = {}) {
        const proxies = this.lastWorkingProxy
            ? [this.lastWorkingProxy, ...this.corsProxies.filter(p => p !== this.lastWorkingProxy)]
            : [...this.corsProxies];

        let lastError = null;

        const encodedUrl = encodeURIComponent(targetUrl);
        const urlSansScheme = targetUrl.replace(/^https?:\/\//, '');

        for (const proxy of proxies) {
            const url = proxy
                .replace('{encodedUrl}', encodedUrl)
                .replace('{urlSansScheme}', urlSansScheme)
                .replace('{url}', targetUrl);
            try {
                const response = await fetch(url, options);

                if (!response.ok) {
                    lastError = new Error(`HTTP ${response.status}`);
                    continue;
                }

                const text = await response.text();
                let data;
                try {
                    data = JSON.parse(text);
                } catch (parseError) {
                    // Some proxies prepend text before JSON; try to recover
                    const jsonStart = text.indexOf('{');
                    if (jsonStart !== -1) {
                        try {
                            data = JSON.parse(text.slice(jsonStart));
                        } catch (retryError) {
                            lastError = retryError;
                            continue;
                        }
                    } else {
                        lastError = parseError;
                        continue;
                    }
                }
                this.corsBlocked = false;
                this.lastWorkingProxy = proxy;
                return { data };
            } catch (error) {
                lastError = error;
            }
        }

        this.corsBlocked = true;
        return { error: lastError };
    }

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

    async _fetchEasyEDADetail(lcscPartNumber) {
        const normalizedPart = this._normalizeQuery(lcscPartNumber);
        const targetUrl = `https://easyeda.com/api/products/${encodeURIComponent(normalizedPart)}/components?version=${this.easyedaDetailVersion}`;
        const result = await this._fetchJsonWithProxies(targetUrl);
        if (result?.data?.result) {
            return result.data.result;
        }
        return null;
    }

    async _fetchEasyEDA3DModel(uuid3d, datastrid) {
        // EasyEDA stores 3D models in OBJ format at modules.easyeda.com
        if (uuid3d) {
            try {
                const url = `https://modules.easyeda.com/3dmodel/${uuid3d}`;
                console.log('Fetching EasyEDA 3D model from:', url);
                
                // Fetch as text since it's OBJ format, not JSON
                const fetchUrl = this.corsProxy ? `${this.corsProxy}${encodeURIComponent(url)}` : url;
                const response = await fetch(fetchUrl);
                
                if (!response.ok) {
                    console.log('3D model not found (HTTP', response.status, ')');
                    return null;
                }
                
                const objText = await response.text();
                if (objText && objText.includes('v ')) { // OBJ files start with vertex lines
                    console.log('Successfully fetched OBJ file, size:', objText.length);
                    return objText;
                }
            } catch (error) {
                console.log('Failed to fetch EasyEDA 3D model:', error.message);
            }
        }
        return null;
    }

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

    _formatEasyEDASearchResults(items) {
        return items.map(item => {
            const lcscPartNumber = item?.lcsc?.number || item?.szlcsc?.number || item.lcscPartNumber || item.lcsc_part_number || item.lcsc || item.productCode || item.product_code || item.component_code || item.componentCode || item.lcsc_number || '';
            const imageUrl = this._normalizeEasyedaUrl(item?.szlcsc?.image || item.imageUrl || item.image || item.productImageUrl || item.productImageUrlBig || '');
            const thumbUrl = this._normalizeEasyedaUrl(item.thumb || item.thumbUrl || item.thumbnail || '');
            const fallbackThumb = lcscPartNumber
                ? `https://easyeda.com/api/eda/product/img/${encodeURIComponent(lcscPartNumber)}?version=${this.easyedaVersion}`
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
                productUrl: item?.lcsc?.url || item?.szlcsc?.url || item.productUrl || item.url || (lcscPartNumber
                    ? `https://www.lcsc.com/product-detail/${lcscPartNumber}.html`
                    : '')
            };
        });
    }

    _normalizeEasyedaUrl(url) {
        if (!url || typeof url !== 'string') return '';
        if (url.startsWith('//')) return `https:${url}`;
        return url;
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
     * Fetch detailed metadata for a specific component
     * @param {string} lcscPartNumber - LCSC part number (e.g., "C46749")
     * @returns {Promise<object>} Component metadata
     */
    async fetchComponentMetadata(lcscPartNumber) {
        const normalizedPart = this._normalizeQuery(lcscPartNumber);
        // Check cache first
        if (this.metadataCache.has(normalizedPart)) {
            const cached = this.metadataCache.get(normalizedPart);
            if (cached?.hasEasyedaSymbol || cached?.hasFootprint || cached?.has3d) {
                return cached;
            }
            this.metadataCache.delete(normalizedPart);
        }

        // Try EasyEDA search first
        try {
            const easyedaResults = await this._searchEasyEDA(normalizedPart);
            const exact = easyedaResults.find(item =>
                (item.lcscPartNumber || '').toUpperCase() === normalizedPart.toUpperCase()
            );

            if (exact) {
                // Fetch detail to get footprint + 3D data
                const detail = await this._fetchEasyEDADetail(normalizedPart);
                
                if (detail?.dataStr && Array.isArray(detail.dataStr.shape)) {
                    exact.easyedaSymbolData = detail.dataStr;
                    exact.easyedaSymbolBBox = detail.dataStr.BBox || detail.dataStr.bbox || null;
                    exact.hasEasyedaSymbol = true;
                } else {
                    exact.hasEasyedaSymbol = false;
                }

                if (detail?.packageDetail?.dataStr) {
                    const dataStr = detail.packageDetail.dataStr;
                    exact.footprintName = detail.packageDetail.title || dataStr?.head?.c_para?.package || '';
                    exact.footprintShapes = Array.isArray(dataStr.shape) ? dataStr.shape : [];
                    exact.footprintBBox = dataStr.BBox || dataStr.bbox || null;
                    exact.model3dName = dataStr?.head?.c_para?.['3DModel'] || '';
                    exact.hasFootprint = exact.footprintShapes.length > 0;
                    exact.has3d = !!exact.model3dName;
                    
                    // Fetch EasyEDA 3D model data (OBJ format) if available
                    if (exact.has3d) {
                        // Find the SVGNODE in the shape array and extract its uuid
                        let model3dUuid = null;
                        if (Array.isArray(dataStr.shape)) {
                            for (const shape of dataStr.shape) {
                                if (typeof shape === 'string' && shape.startsWith('SVGNODE~')) {
                                    try {
                                        const jsonStr = shape.substring(8); // Remove 'SVGNODE~' prefix
                                        const svgData = JSON.parse(jsonStr);
                                        model3dUuid = svgData?.attrs?.uuid;
                                        if (model3dUuid) break;
                                    } catch (e) {
                                        console.warn('Failed to parse SVGNODE:', e);
                                    }
                                }
                            }
                        }
                        
                        if (model3dUuid) {
                            console.log('Fetching 3D model for uuid:', model3dUuid);
                            const model3dData = await this._fetchEasyEDA3DModel(model3dUuid);
                            if (model3dData) {
                                console.log('Successfully fetched 3D model data (OBJ format)');
                                exact.model3dObj = model3dData; // Store as OBJ format
                            }
                        } else {
                            console.log('No 3D model UUID found in SVGNODE');
                        }
                    }
                } else {
                    exact.hasFootprint = false;
                    exact.has3d = false;
                }

                this.metadataCache.set(normalizedPart, exact);
                return exact;
            }
        } catch (error) {
            console.error('EasyEDA metadata fetch error:', error);
        }

        return null;
    }

    async fetchEasyedaProductImage(lcscPartNumber) {
        const normalizedPart = this._normalizeQuery(lcscPartNumber);
        if (!normalizedPart) return '';

        if (this.imageCache.has(normalizedPart)) {
            return this.imageCache.get(normalizedPart);
        }

        const targetUrl = `https://easyeda.com/api/eda/product/img/${encodeURIComponent(normalizedPart)}?version=${this.easyedaVersion}`;
        const result = await this._fetchJsonWithProxies(targetUrl);
        const url = result?.data?.result || '';
        if (url) {
            this.imageCache.set(normalizedPart, url);
        }
        return url;
    }
    
    /**
     * Format search results from LCSC API
     */
    _formatSearchResults(products) {
        return products.map(product => ({
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
            productUrl: `https://www.lcsc.com/product-detail/${product.productCode}.html`
        }));
    }
    
    /**
     * Extract metadata from a single product
     */
    _extractMetadataFromProduct(product) {
        return {
            lcscPartNumber: product.productCode || '',
            mpn: product.productModel || '',
            manufacturer: product.brandNameEn || '',
            description: product.productIntroEn || product.productDescEn || '',
            category: product.parentCatalogName || product.catalogName || '',
            package: product.encapStandard || '',
            stock: product.stockNumber || 0,
            price: this._extractPriceFromProduct(product),
            priceBreaks: this._extractPriceBreaksFromProduct(product),
            isBasic: product.isEnvironment === true,
            isPreferred: product.isHot === true,
            imageUrl: product.productImageUrl || product.productImageUrlBig || '',
            datasheet: product.pdfUrl || '',
            productUrl: `https://www.lcsc.com/product-detail/${product.productCode}.html`,
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