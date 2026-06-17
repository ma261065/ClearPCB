/**
 * FileManager - Handles save/load operations for schematic files
 * 
 * Uses File System Access API where available, falls back to download/upload
 */

/**
 * Briefly flash a small blue dot in the bottom-right corner to give a
 * visual confirmation that an auto-save just completed. The element is
 * created lazily on first use and reused thereafter.
 */
function _flashAutoSaveIndicator() {
    if (typeof document === 'undefined') return;
    let dot = document.getElementById('clearpcb-autosave-dot');
    if (!dot) {
        dot = document.createElement('div');
        dot.id = 'clearpcb-autosave-dot';
        dot.style.cssText = [
            'position:fixed', 'right:4px', 'bottom:4px',
            'width:4px', 'height:4px', 'border-radius:50%',
            'background:#3b9dff', 'box-shadow:0 0 4px #3b9dff',
            'opacity:0', 'pointer-events:none', 'z-index:99999',
            'transition:opacity 120ms ease-out',
        ].join(';');
        document.body.appendChild(dot);
    }
    dot.style.opacity = '1';
    clearTimeout(/** @type {any} */ (dot)._t);
    /** @type {any} */ (dot)._t = setTimeout(() => { dot.style.opacity = '0'; }, 250);
}

// ==================== FileSystemFileHandle persistence ====================
// A FileSystemFileHandle is structured-cloneable, so it can be stored in
// IndexedDB and retrieved after a page reload (its identity and permission
// grant survive). localStorage can't hold it (JSON-only), which is why an
// auto-save recovered after reload would otherwise lose the handle and force
// "Save As". We keep a tiny dedicated DB keyed by file name.
const HANDLE_DB_NAME = 'clearpcb-file-handles';
const HANDLE_STORE = 'handles';

function _openHandleDB() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
        let req;
        try { req = indexedDB.open(HANDLE_DB_NAME, 1); }
        catch (e) { reject(e); return; }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function _idbPutHandle(fileName, handle) {
    if (!fileName || !handle) return;
    try {
        const db = await _openHandleDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(HANDLE_STORE, 'readwrite');
            tx.objectStore(HANDLE_STORE).put(handle, fileName);
            tx.oncomplete = () => resolve(undefined);
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch { /* IndexedDB unavailable (private mode etc.) — non-fatal */ }
}

async function _idbGetHandle(fileName) {
    if (!fileName) return null;
    try {
        const db = await _openHandleDB();
        const handle = await new Promise((resolve, reject) => {
            const tx = db.transaction(HANDLE_STORE, 'readonly');
            const r = tx.objectStore(HANDLE_STORE).get(fileName);
            r.onsuccess = () => resolve(r.result || null);
            r.onerror = () => reject(r.error);
        });
        db.close();
        return handle;
    } catch { return null; }
}

async function _idbDeleteHandle(fileName) {
    if (!fileName) return;
    try {
        const db = await _openHandleDB();
        await new Promise((resolve) => {
            const tx = db.transaction(HANDLE_STORE, 'readwrite');
            tx.objectStore(HANDLE_STORE).delete(fileName);
            tx.oncomplete = () => resolve(undefined);
            tx.onerror = () => resolve(undefined);
        });
        db.close();
    } catch { /* non-fatal */ }
}

export class FileManager {
    /** Initialises the file manager with default state (no file open). */
    constructor() {
        // Current file handle (for "Save" without prompting)
        this.fileHandle = null;
        this.fileName = 'untitled.cpcb';
        this.filePath = null;
        this.isDirty = false;
        
        // Auto-save key prefix for localStorage
        this.autoSavePrefix = 'clearpcb_autosave_';
        this.autoSaveInterval = 10000; // 10 seconds
        this.autoSaveTimer = null;
        
        // Callbacks
        this.onDirtyChanged = null;
        this.onFileNameChanged = null;
    }
    
    /**
     * Check if File System Access API is available
     */
    hasFileSystemAccess() {
        return 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
    }
    
    /**
     * Mark document as modified
     */
    setDirty(dirty = true) {
        if (this.isDirty !== dirty) {
            this.isDirty = dirty;
            if (this.onDirtyChanged) {
                this.onDirtyChanged(dirty);
            }
        }
    }
    
    /**
     * Set the current file name
     */
    setFileName(name) {
        this.fileName = name;
        if (this.onFileNameChanged) {
            this.onFileNameChanged(name);
        }
    }

    /**
     * Set the current file path, deriving fileName from the path if not already set.
     * @param {string|null} path - Full file path or name
     */
    setFilePath(path) {
        this.filePath = path;
        if (!this.fileName && path) {
            const parts = String(path).split(/[\\/]/);
            const name = parts[parts.length - 1];
            if (name) {
                this.setFileName(name);
            }
        }
    }
    
    // ==================== Save Operations ====================
    
    /**
     * Save to current file (or Save As if no file)
     */
    async save(data) {
        let oldFileName = this.fileName;
        let result;
        if (this.fileHandle) {
            // A handle restored from IndexedDB (e.g. after autosave recovery)
            // may have lost its write grant across the reload. Re-request it
            // now — this runs from a user gesture (Ctrl+S / Save button), so
            // the permission prompt is allowed. Only fall back to Save As if
            // the user actually denies access.
            const allowed = await this._ensureWritePermission(this.fileHandle);
            if (allowed) {
                // Ensure fileName is up to date
                if (this.fileHandle.name) this.setFileName(this.fileHandle.name);
                result = await this.saveToHandle(data, this.fileHandle);
            } else {
                result = await this.saveAs(data);
            }
        } else {
            result = await this.saveAs(data);
        }
        // Clear autosave after successful save — no recovery needed
        if (result && result.success) {
            this.clearAutoSave(this.fileName);
        }
        // If the file name changed from untitled.cpcb, delete the old autosave
        if (oldFileName && oldFileName !== this.fileName && oldFileName === 'untitled.cpcb') {
            this.clearAutoSave('untitled.cpcb');
        }
        return result;
    }
    
    /**
     * Save As - always prompts for location
     */
    async saveAs(data) {
        if (this.hasFileSystemAccess()) {
            const result = await this.saveWithFilePicker(data);
            // If the file name changed from untitled.cpcb, delete the old autosave
            if (this.fileName !== 'untitled.cpcb') {
                this.clearAutoSave('untitled.cpcb');
            }
            return result;
        } else {
            const result = await this.saveWithDownload(data);
            if (this.fileName !== 'untitled.cpcb') {
                this.clearAutoSave('untitled.cpcb');
            }
            return result;
        }
    }
    
    /**
     * Save using File System Access API (Chrome/Edge)
     */
    async saveWithFilePicker(data) {
        try {
            const options = {
                suggestedName: this.fileName,
                types: [{
                    description: 'ClearPCB Project',
                    accept: { 'application/x-clearpcb': ['.cpcb'] }
                }]
            };

            const handle = await /** @type {any} */ (window).showSaveFilePicker(options);
            await this.saveToHandle(data, handle);
            
            this.fileHandle = handle;
            this.setFileName(handle.name);
            this.setFilePath(handle.name);
            this.setDirty(false);
            // Persist the handle so it survives a reload + autosave recovery.
            _idbPutHandle(handle.name, handle);
            
            return { success: true, fileName: handle.name };
        } catch (err) {
            if (err.name === 'AbortError') {
                return { success: false, cancelled: true };
            }
            console.error('Save failed:', err);
            return { success: false, error: err.message };
        }
    }
    
    /**
     * Ensure we hold a write grant for a handle, requesting it if needed.
     * Must be called from a user gesture for the prompt to appear. Returns
     * true if writing is permitted, false if the user denied access.
     * @param {any} handle
     */
    async _ensureWritePermission(handle) {
        // Older/non-FSA handles have no permission API — assume writable.
        if (!handle || typeof handle.queryPermission !== 'function') return true;
        const opts = { mode: 'readwrite' };
        try {
            if (await handle.queryPermission(opts) === 'granted') return true;
            return await handle.requestPermission(opts) === 'granted';
        } catch {
            // If the permission API throws (e.g. handle no longer valid),
            // signal a fall back to Save As.
            return false;
        }
    }

    /**
     * Restore a previously persisted file handle for the given file name
     * (used after autosave recovery so "Save" writes back to the original
     * file instead of prompting). Does not request permission — that happens
     * lazily on the next save, which carries a user gesture.
     * @param {string} fileName
     * @returns {Promise<boolean>} true if a handle was restored
     */
    async restoreFileHandle(fileName) {
        const handle = await _idbGetHandle(fileName);
        if (handle) {
            this.fileHandle = handle;
            return true;
        }
        return false;
    }

    /**
     * Save to an existing file handle
     */
    async saveToHandle(data, handle) {
        try {
            const writable = await handle.createWritable();
            const json = JSON.stringify(data, null, 2);
            await writable.write(json);
            await writable.close();
            if (handle?.name) {
                this.setFilePath(handle.name);
            }
            this.setDirty(false);
            return { success: true, fileName: handle.name };
        } catch (err) {
            console.error('Save failed:', err);
            return { success: false, error: err.message };
        }
    }
    
    /**
     * Save using download (fallback for all browsers)
     */
    saveWithDownload(data) {
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = this.fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.setDirty(false);
        return { success: true, fileName: this.fileName };
    }
    
    // ==================== Load Operations ====================
    
    /**
     * Open file picker and load
     */
    async open() {
        if (this.hasFileSystemAccess()) {
            const result = await this.openWithFilePicker();
            if (result && result.fileName) this.setFileName(result.fileName);
            return result;
        } else {
            const result = await this.openWithInput();
            if (result && result.fileName) this.setFileName(result.fileName);
            return result;
        }
    }
    
    /**
     * Open using File System Access API (Chrome/Edge)
     */
    async openWithFilePicker() {
        try {
            const options = {
                types: [{
                    description: 'ClearPCB Project',
                    accept: { 'application/x-clearpcb': ['.cpcb'] }
                }]
            };

            const [handle] = await /** @type {any} */ (window).showOpenFilePicker(options);
            const file = await handle.getFile();
            const text = await file.text();
            const data = JSON.parse(text);
            
            this.fileHandle = handle;
            this.setFileName(handle.name);
            this.setFilePath(handle.name);
            this.setDirty(false);
            // Persist the handle so it survives a reload + autosave recovery.
            _idbPutHandle(handle.name, handle);
            // Immediately autosave the opened document
            this.autoSaveToStorage(data);
            
            return { success: true, data, fileName: handle.name };
        } catch (err) {
            if (err.name === 'AbortError') {
                return { success: false, cancelled: true };
            }
            console.error('Open failed:', err);
            return { success: false, error: err.message };
        }
    }
    
    /**
     * Open using file input (fallback for all browsers)
     */
    openWithInput() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.cpcb';
            
            input.onchange = async (e) => {
                const target = /** @type {HTMLInputElement|null} */ (e.target);
                const file = target?.files?.[0];
                if (!file) {
                    resolve({ success: false, cancelled: true });
                    return;
                }
                
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    
                    this.fileHandle = null; // Can't save back to same file with this method
                    this.setFileName(file.name);
                    this.setFilePath(file.name);
                    this.setDirty(false);
                    // Immediately autosave the opened document
                    this.autoSaveToStorage(data);
                    
                    resolve({ success: true, data, fileName: file.name });
                } catch (err) {
                    console.error('Open failed:', err);
                    resolve({ success: false, error: err.message });
                }
            };
            
            input.click();
        });
    }
    
    // ==================== Auto-save (localStorage) ====================
    
    /**
     * Start auto-save timer
     */
    startAutoSave(getDataFn, isDirtyFn) {
        this.stopAutoSave();
        this.autoSaveTimer = setInterval(() => {
            const dirty = this.isDirty || (typeof isDirtyFn === 'function' && isDirtyFn());
            if (dirty) {
                this.autoSaveToStorage(getDataFn());
            }
        }, this.autoSaveInterval);
    }
    
    /**
     * Stop auto-save timer
     */
    stopAutoSave() {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
    }
    
    /**
     * Save to localStorage
     */
    autoSaveToStorage(data) {
        try {
            const key = this.autoSavePrefix + encodeURIComponent(this.fileName || 'untitled');
            const json = JSON.stringify({
                timestamp: Date.now(),
                fileName: this.fileName,
                data: data
            });
            localStorage.setItem(key, json);
            // Update autosave index
            let index = [];
            try {
                index = JSON.parse(localStorage.getItem(this.autoSavePrefix + 'index')) || [];
            } catch {}
            const existing = index.find(i => i.fileName === this.fileName);
            if (!existing) {
                index.push({ fileName: this.fileName, key, timestamp: Date.now() });
            } else {
                existing.timestamp = Date.now();
            }
            localStorage.setItem(this.autoSavePrefix + 'index', JSON.stringify(index));
            console.log('Auto-saved to localStorage');
            _flashAutoSaveIndicator();
            // Keep the file handle (if any) persisted alongside the autosave so
            // a post-reload recovery can "Save" back to the original file.
            if (this.fileHandle && this.fileName) {
                _idbPutHandle(this.fileName, this.fileHandle);
            }
            // Reset failure-backoff state on success.
            this._autoSaveBackoffMs = 0;
            if (this._autoSaveErrorNotified) this._autoSaveErrorNotified = false;
        } catch (err) {
            console.error('Auto-save failed:', err);
            // Notify the user once per failure streak so they know their
            // work isn't being backed up (storage full, private mode, …).
            if (!this._autoSaveErrorNotified) {
                this._autoSaveErrorNotified = true;
                try {
                    globalThis.bootstrap?.schematicApp?._setStatus?.(
                        'Auto-save failed: storage full or unavailable');
                } catch { /* status bar may not exist */ }
            }
        }
    }
    
    /**
     * Check if there's an auto-saved document
     */
    hasAutoSave() {
        // Returns true if any autosave exists
        let index = [];
        try {
            index = JSON.parse(localStorage.getItem(this.autoSavePrefix + 'index')) || [];
        } catch {}
        return index.length > 0;
    }
    
    /**
     * Load auto-saved document
     */
    loadAutoSave(fileName) {
        // If fileName is provided, load that autosave; else load the most recent
        try {
            let key;
            if (fileName) {
                key = this.autoSavePrefix + encodeURIComponent(fileName);
            } else {
                // Load most recent from index
                let index = [];
                try {
                    index = JSON.parse(localStorage.getItem(this.autoSavePrefix + 'index')) || [];
                } catch {}
                if (index.length === 0) return null;
                // Sort by timestamp desc
                index.sort((a, b) => b.timestamp - a.timestamp);
                key = index[0].key;
            }
            const json = localStorage.getItem(key);
            if (!json) return null;
            const saved = JSON.parse(json);
            return {
                timestamp: saved.timestamp,
                fileName: saved.fileName,
                data: saved.data
            };
        } catch (err) {
            console.error('Failed to load auto-save:', err);
            return null;
        }
    }
    
    /**
     * Clear auto-saved document
     */
    clearAutoSave(fileName) {
        // Remove autosave for a specific file, or all if no fileName
        let index = [];
        try {
            index = JSON.parse(localStorage.getItem(this.autoSavePrefix + 'index')) || [];
        } catch {}
        if (fileName) {
            const key = this.autoSavePrefix + encodeURIComponent(fileName);
            localStorage.removeItem(key);
            index = index.filter(i => i.fileName !== fileName);
            _idbDeleteHandle(fileName);
        } else {
            // Remove all autosaves
            for (const entry of index) {
                localStorage.removeItem(entry.key);
                _idbDeleteHandle(entry.fileName);
            }
            index = [];
        }
        localStorage.setItem(this.autoSavePrefix + 'index', JSON.stringify(index));
    }
    
    // ==================== New Document ====================
    
    /**
     * Start a new document
     */
    newDocument() {
        this.fileHandle = null;
        this.setFileName('untitled.cpcb');
        this.setFilePath(null);
        this.setDirty(false);
        // Immediately autosave the new document
        this.autoSaveToStorage({ version: '2.0', type: 'clearpcb-project', schematic: { shapes: [], components: [] } });
        return { version: '2.0', type: 'clearpcb-project', schematic: { shapes: [], components: [] } };
    }
}