/**
 * StorageManager - Centralized cache with TTL support.
 *
 * Uses IndexedDB for persistence (much higher quota than localStorage)
 * with an in-memory Map for synchronous reads.
 *
 * API is synchronous for reads (served from memory) and fire-and-forget
 * for writes (async IndexedDB persistence in background).
 *
 * Call await storageManager.ready before first use (done in SchematicApp init).
 */

const DB_NAME = 'clearpcb_cache';
const DB_VERSION = 1;
const STORE_NAME = 'cache';

export class StorageManager {
    /**
     * @param {number} [ttlMs=86400000] - Default TTL (24 hours)
     */
    constructor(ttlMs = 24 * 60 * 60 * 1000) {
        this.ttlMs = ttlMs;
        /** @type {Map<string, {data: any, expires: number}>} */
        this._mem = new Map();
        /** @type {IDBDatabase|null} */
        this._db = null;
        this._dbReady = this._openDB();
    }

    /** Resolves when IndexedDB is loaded into memory. */
    get ready() { return this._dbReady; }

    //  Internal: IndexedDB 

    async _openDB() {
        try {
            this._db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME);
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            // Hydrate in-memory cache from IndexedDB
            await this._hydrate();
        } catch (e) {
            console.warn('StorageManager: IndexedDB unavailable, using memory only', e);
            this._db = null;
            // Also try to migrate any existing localStorage data
            this._migrateFromLocalStorage();
        }
    }

    async _hydrate() {
        if (!this._db) return;
        const tx = this._db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        await new Promise((resolve, reject) => {
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) { resolve(undefined); return; }
                const key = /** @type {string} */ (cursor.key);
                const val = cursor.value;
                if (val && typeof val === 'object' && 'data' in val && 'expires' in val) {
                    this._mem.set(key, val);
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    _migrateFromLocalStorage() {
        // One-time migration: move cache entries from localStorage to memory
        try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                // Only migrate cache-like keys (kicad_, easyeda_, clearpcb-theme, etc.)
                // Skip autosave keys
                if (key.startsWith('clearpcb_autosave_') || key === 'clearpcb_tool_options') continue;
                try {
                    const raw = localStorage.getItem(key);
                    if (!raw) continue;
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object' && 'data' in parsed && 'expires' in parsed) {
                        if (Date.now() <= parsed.expires) {
                            this._mem.set(key, parsed);
                        }
                        keysToRemove.push(key);
                    }
                } catch {}
            }
            // Remove migrated entries from localStorage to free space
            for (const key of keysToRemove) {
                localStorage.removeItem(key);
            }
            // Persist migrated data to IndexedDB
            if (keysToRemove.length > 0) {
                this._persistAll();
                console.log('StorageManager: migrated', keysToRemove.length, 'entries from localStorage to IndexedDB');
            }
        } catch {}
    }

    _persistToIDB(key, value) {
        if (!this._db) return;
        try {
            const tx = this._db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(value, key);
            tx.oncomplete = () => {};
            tx.onerror = (e) => console.warn('StorageManager: IDB write error for', key, e);
        } catch (e) {
            console.warn('StorageManager: IDB persist failed for', key, e);
        }
    }

    _removeFromIDB(key) {
        if (!this._db) return;
        try {
            const tx = this._db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(key);
        } catch {}
    }

    _persistAll() {
        if (!this._db) return;
        try {
            const tx = this._db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const [key, val] of this._mem) {
                store.put(val, key);
            }
        } catch {}
    }

    //  Public API (sync reads, async writes) 

    /**
     * Store a value with TTL.
     * @param {string} key
     * @param {any} value
     * @param {number} [ttlMs]
     * @returns {boolean}
     */
    set(key, value, ttlMs = null) {
        const ttl = ttlMs !== null ? ttlMs : this.ttlMs;
        const payload = { data: value, expires: Date.now() + ttl };
        this._mem.set(key, payload);
        this._persistToIDB(key, payload);
        return true;
    }

    /**
     * Get a value (sync, from memory).
     * @param {string} key
     * @returns {any|null}
     */
    get(key) {
        const entry = this._mem.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expires) {
            this._mem.delete(key);
            this._removeFromIDB(key);
            return null;
        }
        return entry.data;
    }

    /**
     * Remove a key.
     * @param {string} key
     * @returns {boolean}
     */
    remove(key) {
        this._mem.delete(key);
        this._removeFromIDB(key);
        return true;
    }

    /**
     * Check if key exists and is not expired.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return this.get(key) !== null;
    }

    /**
     * Get value with expiry status without deleting expired entries.
     * @param {string} key
     * @returns {{ data: any, expired: boolean } | null}
     */
    getRaw(key) {
        const entry = this._mem.get(key);
        if (!entry) return null;
        return { data: entry.data, expired: Date.now() > entry.expires };
    }

    /**
     * Clear all cache entries.
     * @returns {boolean}
     */
    clear() {
        this._mem.clear();
        if (this._db) {
            try {
                const tx = this._db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).clear();
            } catch {}
        }
        return true;
    }

    /**
     * Get all non-expired keys.
     * @returns {string[]}
     */
    keys() {
        const result = [];
        const now = Date.now();
        for (const [key, val] of this._mem) {
            if (now <= val.expires) result.push(key);
        }
        return result;
    }
}

// Singleton instance
export const storageManager = new StorageManager();
