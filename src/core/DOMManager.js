/**
 * DOMManager - Centralized DOM access and query wrapper
 * 
 * Provides:
 * - Single point for DOM queries
 * - Easier to test/mock
 * - Consistent error handling
 */

export class DOMManager {
    /**
     * Get element by ID
     * @param {string} id - Element ID
     * @returns {HTMLElement|null}
     */
    static getElementById(id) {
        const el = document.getElementById(id);
        if (!el) {
            console.warn(`DOMManager: Element with id "${id}" not found`);
        }
        return el;
    }

    /**
     * Query selector (single element)
     * @param {string} selector - CSS selector
     * @returns {HTMLElement|null}
     */
    static querySelector(selector) {
        return document.querySelector(selector);
    }

    /**
     * Query selector all (multiple elements)
     * @param {string} selector - CSS selector
     * @returns {NodeList}
     */
    static querySelectorAll(selector) {
        return document.querySelectorAll(selector);
    }

    /**
     * Create element
     * @param {string} tag - Tag name
     * @returns {HTMLElement}
     */
    static createElement(tag) {
        return document.createElement(tag);
    }

    /**
     * Create element with class
     * @param {string} tag - Tag name
     * @param {string} className - Class name
     * @returns {HTMLElement}
     */
    static createElementWithClass(tag, className) {
        const el = document.createElement(tag);
        el.className = className;
        return el;
    }

    /**
     * Add event listener
     * @param {HTMLElement|Window} target - Target element or window
     * @param {string} event - Event type
     * @param {Function} handler - Event handler
     */
    static on(target, event, handler) {
        if (target) {
            target.addEventListener(event, handler);
        }
    }

    /**
     * Remove event listener
     * @param {HTMLElement|Window} target - Target element or window
     * @param {string} event - Event type
     * @param {Function} handler - Event handler
     */
    static off(target, event, handler) {
        if (target) {
            target.removeEventListener(event, handler);
        }
    }

    /**
     * Set inner HTML (with warning about security)
     * @param {HTMLElement} el - Element
     * @param {string} html - HTML content
     */
    static setHTML(el, html) {
        if (el) {
            el.innerHTML = html;
        }
    }

    /**
     * Set text content
     * @param {HTMLElement} el - Element
     * @param {string} text - Text content
     */
    static setText(el, text) {
        if (el) {
            el.textContent = text;
        }
    }

    /**
     * Add class
     * @param {HTMLElement} el - Element
     * @param {string} className - Class name
     */
    static addClass(el, className) {
        if (el) {
            el.classList.add(className);
        }
    }

    /**
     * Remove class
     * @param {HTMLElement} el - Element
     * @param {string} className - Class name
     */
    static removeClass(el, className) {
        if (el) {
            el.classList.remove(className);
        }
    }

    /**
     * Toggle class
     * @param {HTMLElement} el - Element
     * @param {string} className - Class name
     */
    static toggleClass(el, className) {
        if (el) {
            el.classList.toggle(className);
        }
    }

    /**
     * Set attribute
     * @param {HTMLElement} el - Element
     * @param {string} attr - Attribute name
     * @param {string} value - Attribute value
     */
    static setAttribute(el, attr, value) {
        if (el) {
            el.setAttribute(attr, value);
        }
    }

    /**
     * Get attribute
     * @param {HTMLElement} el - Element
     * @param {string} attr - Attribute name
     * @returns {string|null}
     */
    static getAttribute(el, attr) {
        return el ? el.getAttribute(attr) : null;
    }

    /**
     * Append child
     * @param {HTMLElement} parent - Parent element
     * @param {HTMLElement} child - Child element
     */
    static append(parent, child) {
        if (parent && child) {
            parent.appendChild(child);
        }
    }

    /**
     * Remove element
     * @param {HTMLElement} el - Element to remove
     */
    static remove(el) {
        if (el && el.parentNode) {
            el.parentNode.removeChild(el);
        }
    }

    /**
     * Clear element children
     * @param {HTMLElement} el - Element
     */
    static clear(el) {
        if (el) {
            el.innerHTML = '';
        }
    }
}
