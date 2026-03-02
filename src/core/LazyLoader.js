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

export class LazyLoader {
    /**
     * Create a new LazyLoader.
     * @param {Object} [options]
     * @param {HTMLElement} [options.container] - Scroll container to observe
     * @param {Function} [options.renderCallback] - Called when an item becomes visible
     * @param {Function} [options.unrenderCallback] - Called when an item leaves the viewport
     * @param {number} [options.threshold=0.1] - Intersection ratio to trigger rendering
     * @param {string} [options.rootMargin='50px'] - Margin around the root for early loading
     * @param {number} [options.batchSize=10] - Number of items to render per batch
     */
    constructor(options = {}) {
        this.container = options.container || null;
        this.renderCallback = options.renderCallback || (() => {});
        this.unrenderCallback = options.unrenderCallback || (() => {});
        this.threshold = options.threshold || 0.1; // 10% visible
        this.rootMargin = options.rootMargin || '50px'; // Load 50px before/after viewport
        this.batchSize = options.batchSize || 10; // Render items in batches
        
        this.observer = null;
        this.items = new Map();
        this.renderQueue = [];
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
            const { element, item } = this.renderQueue.shift();
            
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
     * @param {HTMLElement} element - The DOM element to observe
     * @param {*} data - Associated data (passed to callbacks)
     */
    register(element, data = null) {
        if (!this.isSupported) {
            // Fallback: render immediately if IntersectionObserver not available
            this.renderCallback(element, { data, rendered: false });
            return;
        }

        const item = { element, data, rendered: false };
        this.items.set(element, item);
        this.observer.observe(element);
    }

    /**
     * Unregister an item and stop observing
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
