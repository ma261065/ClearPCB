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
        // CORS proxy - codetabs seems to work better than others
        this.corsProxy = 'https://api.codetabs.com/v1/proxy?quest=';
        
        // API endpoint
        this.searchUrl = 'https://wwwapi.lcsc.com/v1/search/global-search';
        
        // Cache for component metadata
        this.metadataCache = new Map();
        
        // Track CORS status
        this.corsBlocked = false;
    }

    /**
     * Search for components on LCSC
     * @param {string} query - Search query
     * @returns {Promise<Array>} Search results
     */
    async search(query) {
        console.log('LCSC search for:', query);
        
        // If CORS is known to be blocked, return message immediately
        if (this.corsBlocked) {
            return [{
                error: true,
                message: 'LCSC search unavailable due to CORS restrictions. Use local library or KiCad symbols.'
            }];
        }
        
        const targetUrl = `${this.searchUrl}?keyword=${encodeURIComponent(query)}`;
        const url = this.corsProxy + targetUrl;
        
        console.log('Search URL:', url);
        
        try {
            const response = await fetch(url);
            console.log('Response status:', response.status);
            
            if (!response.ok) {
                this.corsBlocked = true;
                return [{
                    error: true,
                    message: `LCSC search failed (${response.status}). CORS proxy may be blocked.`
                }];
            }
            
            const data = await response.json();
            console.log('LCSC response:', data);
            
            // The global search API returns productSearchResultVO.productList
            if (data.productSearchResultVO && data.productSearchResultVO.productList) {
                const results = this._formatSearchResults(data.productSearchResultVO.productList);
                console.log('Formatted results:', results.length);
                return results;
            }
            
            return [];
            
        } catch (error) {
            console.error('LCSC search error:', error);
            this.corsBlocked = true;
            return [{
                error: true,
                message: 'LCSC search unavailable. Network error or CORS blocked.'
            }];
        }
    }
    
    /**
     * Fetch detailed metadata for a specific component
     * @param {string} lcscPartNumber - LCSC part number (e.g., "C46749")
     * @returns {Promise<object>} Component metadata
     */
    async fetchComponentMetadata(lcscPartNumber) {
        // Check cache first
        if (this.metadataCache.has(lcscPartNumber)) {
            return this.metadataCache.get(lcscPartNumber);
        }
        
        if (this.corsBlocked) {
            return null;
        }
        
        const targetUrl = `${this.searchUrl}?keyword=${encodeURIComponent(lcscPartNumber)}`;
        const url = this.corsProxy + targetUrl;
        
        console.log('Fetching metadata from:', url);
        
        try {
            const response = await fetch(url);
            console.log('Metadata response status:', response.status);
            
            if (!response.ok) {
                this.corsBlocked = true;
                return null;
            }
            
            const data = await response.json();
            console.log('Metadata response:', data);
            
            // Find the exact part in results
            if (data.productSearchResultVO && data.productSearchResultVO.productList) {
                const product = data.productSearchResultVO.productList.find(
                    p => p.productCode === lcscPartNumber
                );
                
                if (product) {
                    const metadata = this._extractMetadataFromProduct(product);
                    this.metadataCache.set(lcscPartNumber, metadata);
                    return metadata;
                }
            }
            
            return null;
            
        } catch (error) {
            console.error(`Failed to fetch LCSC component ${lcscPartNumber}:`, error);
            this.corsBlocked = true;
            return null;
        }
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