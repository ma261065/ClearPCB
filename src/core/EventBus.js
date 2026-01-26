/**
 * EventBus - Simple pub/sub system for decoupled communication
 * 
 * Usage:
 *   eventBus.on('component:added', (component) => { ... });
 *   eventBus.emit('component:added', component);
 *   eventBus.off('component:added', handler);
 */

export class EventBus {
    constructor() {
        this.listeners = new Map();
    }

    /**
     * Subscribe to an event
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);
        
        // Return unsubscribe function
        return () => this.off(event, callback);
    }

    /**
     * Subscribe to an event, but only fire once
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     */
    once(event, callback) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            callback(...args);
        };
        this.on(event, wrapper);
    }

    /**
     * Unsubscribe from an event
     * @param {string} event - Event name
     * @param {Function} callback - Handler to remove
     */
    off(event, callback) {
        const handlers = this.listeners.get(event);
        if (handlers) {
            handlers.delete(callback);
        }
    }

    /**
     * Emit an event to all subscribers
     * @param {string} event - Event name
     * @param {...any} args - Arguments to pass to handlers
     */
    emit(event, ...args) {
        const handlers = this.listeners.get(event);
        if (handlers) {
            handlers.forEach(callback => {
                try {
                    callback(...args);
                } catch (error) {
                    console.error(`Error in event handler for "${event}":`, error);
                }
            });
        }
    }

    /**
     * Remove all listeners for an event, or all listeners if no event specified
     * @param {string} [event] - Event name (optional)
     */
    clear(event) {
        if (event) {
            this.listeners.delete(event);
        } else {
            this.listeners.clear();
        }
    }

    /**
     * Get the number of listeners for an event
     * @param {string} event - Event name
     * @returns {number}
     */
    listenerCount(event) {
        const handlers = this.listeners.get(event);
        return handlers ? handlers.size : 0;
    }
}

// Standard events used throughout the application
export const Events = {
    // Document events
    DOCUMENT_CREATED: 'document:created',
    DOCUMENT_OPENED: 'document:opened',
    DOCUMENT_SAVED: 'document:saved',
    DOCUMENT_MODIFIED: 'document:modified',
    
    // Selection events
    SELECTION_CHANGED: 'selection:changed',
    SELECTION_CLEARED: 'selection:cleared',
    
    // Component events
    COMPONENT_ADDED: 'component:added',
    COMPONENT_REMOVED: 'component:removed',
    COMPONENT_MODIFIED: 'component:modified',
    COMPONENT_MOVED: 'component:moved',
    
    // Wire/net events
    WIRE_ADDED: 'wire:added',
    WIRE_REMOVED: 'wire:removed',
    NET_HIGHLIGHTED: 'net:highlighted',
    NET_RENAMED: 'net:renamed',
    
    // Tool events
    TOOL_CHANGED: 'tool:changed',
    TOOL_ACTIVATED: 'tool:activated',
    TOOL_DEACTIVATED: 'tool:deactivated',
    
    // View events
    VIEW_CHANGED: 'view:changed',
    ZOOM_CHANGED: 'zoom:changed',
    LAYER_VISIBILITY_CHANGED: 'layer:visibility',
    
    // History events
    HISTORY_CHANGED: 'history:changed',
    UNDO: 'history:undo',
    REDO: 'history:redo',
    
    // UI events
    PANEL_OPENED: 'panel:opened',
    PANEL_CLOSED: 'panel:closed',
    DIALOG_OPENED: 'dialog:opened',
    DIALOG_CLOSED: 'dialog:closed',
    
    // Library events
    LIBRARY_LOADED: 'library:loaded',
    SYMBOL_SELECTED: 'symbol:selected',
    FOOTPRINT_SELECTED: 'footprint:selected',
};

// Global event bus instance
export const globalEventBus = new EventBus();