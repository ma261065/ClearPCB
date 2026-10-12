/**
 * LazyLoader - Renders DOM elements only when they become visible
 * 
 * Reduces memory and rendering overhead for large lists by using
 * IntersectionObserver to render items only when scrolled into view.
 * 
 * Features:
 * - Automatic visibility detection
 * - Configurable render/unrender thresholds
 * - Scroll performance optimization
 * - Graceful degradation for older browsers
 */

/**
 * @typedef {{element: Element, data: unknown, rendered: boolean}} LazyItem
 * @typedef {{element: Element, item: LazyItem}} RenderQueueItem
 * @typedef {(element: Element, item: LazyItem) => void|Promise<void>} LazyCallback
 * @typedef {object} LazyLoaderOptions
 * @property {Element} [container]
 * @property {LazyCallback} [renderCallback]
 * @property {LazyCallback} [unrenderCallback]
 * @property {number} [threshold]
 * @property {string} [rootMargin]
 * @property {number} [batchSize]
 */

export class LazyLoader {
    /**
     * Create a new LazyLoader.
     * @param {LazyLoaderOptions} [options]
     */
    constructor(options = {}) {
        this.container = options.container || null;
        this.renderCallback = options.renderCallback || (() => {});
        this.unrenderCallback = options.unrenderCallback || (() => {});
        this.threshold = options.threshold || 0.1; // 10% visible
        this.rootMargin = options.rootMargin || '50px'; // Load 50px before/after viewport
        this.batchSize = options.batchSize || 10; // Render items in batches
        
        /** @type {IntersectionObserver|null} */
        this.observer = null;
        /** @type {Map<Element, LazyItem>} */
        this.items = new Map();
        /** @type {RenderQueueItem[]} */
        this.renderQueue = [];
        /** @type {number|null} */
        this.renderTimer = null;
        this.isSupported = 'IntersectionObserver' in window;
        
        if (this.isSupported && this.container) {
            this._initObserver();
        }
    }

    /**
     * Initialize the IntersectionObserver
     */
    _initObserver() {
        const options = {
            root: this.container,
            threshold: this.threshold,
            rootMargin: this.rootMargin
        };

        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const item = this.items.get(entry.target);
                if (!item) return;

                if (entry.isIntersecting) {
                    this._queueRender(entry.target, item);
                } else if (item.rendered) {
                    // Unrender when out of view (optional, saves memory)
                    if (this.unrenderCallback) {
                        this.unrenderCallback(entry.target, item);
                        item.rendered = false;
                    }
                }
            });
        }, options);
    }

    /**
     * Queue an item for rendering (batches renders for efficiency)
     */
    /**
     * @param {Element} element
     * @param {LazyItem} item
     */
    _queueRender(element, item) {
        if (item.rendered) return;

        this.renderQueue.push({ element, item });

        // Process batch if we've accumulated enough items
        if (this.renderQueue.length >= this.batchSize) {
            this._processBatch();
        } else if (!this.renderTimer) {
            // Defer processing to next frame
            this.renderTimer = requestAnimationFrame(() => {
                this._processBatch();
            });
        }
    }

    /**
     * Process queued render items
     */
    _processBatch() {
        if (this.renderTimer) {
            cancelAnimationFrame(this.renderTimer);
            this.renderTimer = null;
        }

        while (this.renderQueue.length > 0) {
            const { element, item } = /** @type {RenderQueueItem} */ (this.renderQueue.shift());
            
            try {
                this.renderCallback(element, item);
                item.rendered = true;
            } catch (error) {
                console.error('LazyLoader: Error rendering item:', error);
            }
        }
    }

    /**
     * Register an item for lazy loading
     * @param {Element} element - The DOM element to observe
     * @param {unknown} data - Associated data (passed to callbacks)
     */
    register(element, data = null) {
        if (!this.isSupported) {
            // Fallback: render immediately if IntersectionObserver not available
            this.renderCallback(element, /** @type {LazyItem} */ ({ data, rendered: false }));
            return;
        }

        const item = { element, data, rendered: false };
        this.items.set(element, item);
        /** @type {IntersectionObserver} */ (this.observer).observe(element);
    }

    /**
     * Unregister an item and stop observing
     * @param {Element} element
     */
    unregister(element) {
        if (this.observer) {
            this.observer.unobserve(element);
        }
        this.items.delete(element);
    }

    /**
     * Destroy the lazy loader and cleanup
     */
    destroy() {
        if (this.renderTimer) {
            cancelAnimationFrame(this.renderTimer);
        }

        if (this.observer) {
            this.observer.disconnect();
        }

        this.items.clear();
        this.renderQueue = [];
    }

    /**
     * Get statistics about rendered items
     */
    /** @returns {{rendered:number,total:number,queued:number}} */
    getStats() {
        let rendered = 0;
        let total = 0;

        for (const item of this.items.values()) {
            total++;
            if (item.rendered) rendered++;
        }

        return { rendered, total, queued: this.renderQueue.length };
    }

    /**
     * Force render all items (useful for testing or finalization)
     */
    renderAll() {
        for (const item of this.items.values()) {
            if (!item.rendered) {
                this.renderCallback(item.element, item);
                item.rendered = true;
            }
        }
        this.renderQueue = [];
    }

    /**
     * Force unrender all items
     */
    unrenderAll() {
        for (const item of this.items.values()) {
            if (item.rendered) {
                this.unrenderCallback(item.element, item);
                item.rendered = false;
            }
        }
    }
}
