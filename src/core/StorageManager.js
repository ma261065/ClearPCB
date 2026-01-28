/**
 * StorageManager - Centralized localStorage access with TTL support
 * 
 * Provides:
 * - Automatic expiration based on TTL
 * - Consistent error handling
 * - Easy to test/mock
 */

export class StorageManager {
    constructor(ttlMs = 24 * 60 * 60 * 1000) {
        this.ttlMs = ttlMs; // Default 24 hours
    }

    /**
     * Set a value with automatic expiration
     * @param {string} key - Storage key
     * @param {any} value - Value to store (will be JSON serialized)
     * @param {number} [ttlMs] - Optional custom TTL in milliseconds
     */
    set(key, value, ttlMs = null) {
        try {
            const ttl = ttlMs !== null ? ttlMs : this.ttlMs;
            const payload = {
                data: value,
                expires: Date.now() + ttl
            };
            localStorage.setItem(key, JSON.stringify(payload));
            return true;
        } catch (error) {
            console.warn(`StorageManager.set failed for key "${key}":`, error);
            return false;
        }
    }

    /**
     * Get a value, automatically checking expiration
     * Handles both new StorageManager format and legacy raw values
     * @param {string} key - Storage key
     * @returns {any|null} The stored value, or null if expired/missing
     */
    get(key) {
        try {
            const item = localStorage.getItem(key);
            if (!item) return null;

            // Try parsing as StorageManager format (with TTL)
            try {
                const parsed = JSON.parse(item);
                if (parsed && typeof parsed === 'object' && 'data' in parsed && 'expires' in parsed) {
                    // Check if expired
                    if (Date.now() > parsed.expires) {
                        localStorage.removeItem(key);
                        return null;
                    }
                    return parsed.data;
                }
            } catch (e) {
                // Not StorageManager format, fall through to legacy handling
            }

            // Handle legacy format (raw value, possibly JSON string)
            // Try to parse as JSON first
            try {
                return JSON.parse(item);
            } catch (e) {
                // Return as plain string
                return item;
            }
        } catch (error) {
            console.warn(`StorageManager.get failed for key "${key}":`, error);
            return null;
        }
    }

    /**
     * Remove a key
     * @param {string} key - Storage key
     */
    remove(key) {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (error) {
            console.warn(`StorageManager.remove failed for key "${key}":`, error);
            return false;
        }
    }

    /**
     * Check if a key exists and is not expired
     * @param {string} key - Storage key
     * @returns {boolean}
     */
    has(key) {
        return this.get(key) !== null;
    }

    /**
     * Clear all storage
     */
    clear() {
        try {
            localStorage.clear();
            return true;
        } catch (error) {
            console.warn('StorageManager.clear failed:', error);
            return false;
        }
    }

    /**
     * Get all non-expired keys
     * @returns {string[]}
     */
    keys() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (this.has(key)) {
                keys.push(key);
            }
        }
        return keys;
    }
}

// Singleton instance
export const storageManager = new StorageManager();
