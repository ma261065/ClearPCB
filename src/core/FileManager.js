/**
 * FileManager - Handles save/load operations for schematic files
 * 
 * Uses File System Access API where available, falls back to download/upload
 */

import { zip, unzip, strToU8, strFromU8 } from '../../assets/vendor/fflate.module.js';

// ==================== Project (de)serialisation ====================
// .cpcb documents are ZIP containers (DEFLATE per entry) holding the project
// split into logical files:
//   manifest.json   — container format/version + the model index
//   options.json     — the document envelope (version/type/created + any other
//                       top-level option fields)
//   schematic.json  — the schematic section (settings/shapes/components/defs),
//                       with 3D meshes hoisted out of `defs`
//   pcb.json         — the board section (omitted when empty)
//   models/m*.obj    — one entry per unique 3D mesh (the bulk of the bytes)
// Splitting the heavy, static meshes into their own entries keeps the document
// body small and lets each part compress independently. The whole thing keeps
// the .cpcb extension.

/** Container manifest filename. */
const _MANIFEST_NAME = 'manifest.json';

/**
 * Promise wrapper around fflate's async `zip`.
 * @param {Record<string, Uint8Array>} files
 * @returns {Promise<Uint8Array>}
 */
function _zip(files) {
    return new Promise((resolve, reject) => {
        zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
    });
}

/**
 * Promise wrapper around fflate's async `unzip`.
 * @param {Uint8Array} bytes
 * @returns {Promise<Record<string, Uint8Array>>}
 */
function _unzip(bytes) {
    return new Promise((resolve, reject) => {
        unzip(bytes, (err, data) => (err ? reject(err) : resolve(data)));
    });
}

/**
 * Serialise a project to a ZIP-container Blob for on-disk storage. The document
 * is partitioned into separate entries (see file header) so the large, rarely-
 * changing 3D meshes live apart from the editable schematic/board data.
 * @param {any} data
 * @returns {Promise<Blob>}
 */
async function _serializeProject(data) {
    /** @type {Record<string, Uint8Array>} */
    const files = {};

    const { schematic, pcb, ...options } = data || {};

    // Hoist each definition's 3D mesh into its own entry, recording the
    // def-key → entry-path mapping in the manifest. Sequential filenames avoid
    // unsafe characters in def keys.
    /** @type {Record<string, string>} */
    const models = {};
    let sch = null;
    if (schematic) {
        sch = { ...schematic };
        if (sch.defs) {
            /** @type {Record<string, any>} */
            const defs = {};
            let i = 0;
            for (const [key, def] of Object.entries(sch.defs)) {
                if (def && /** @type {any} */ (def).model3dObj) {
                    const entry = `models/m${i++}.obj`;
                    files[entry] = strToU8(/** @type {any} */ (def).model3dObj);
                    models[key] = entry;
                    const { model3dObj, ...rest } = /** @type {any} */ (def);
                    defs[key] = rest;
                } else {
                    defs[key] = def;
                }
            }
            sch.defs = defs;
        }
    }

    const manifest = { format: 'clearpcb-zip', version: 1, models };
    files[_MANIFEST_NAME] = strToU8(JSON.stringify(manifest));
    files['options.json'] = strToU8(JSON.stringify(options));
    if (sch) files['schematic.json'] = strToU8(JSON.stringify(sch));
    if (pcb) files['pcb.json'] = strToU8(JSON.stringify(pcb));

    const zipped = await _zip(files);
    return new Blob([zipped], { type: 'application/zip' });
}

/**
 * Read a project File/Blob (ZIP container) back into the combined document
 * object. Exported so other entry points (e.g. the PWA launch-file handler)
 * decode documents the same way.
 * @param {Blob} file
 * @returns {Promise<any>}
 */
export async function readProjectFile(file) {
    return _deserializeProject(file);
}

/**
 * @param {Blob} file
 * @returns {Promise<any>}
 */
async function _deserializeProject(file) {
    const buf = await file.arrayBuffer();
    const entries = await _unzip(new Uint8Array(buf));

    /** @param {string} name */
    const readJSON = (name) => (entries[name] ? JSON.parse(strFromU8(entries[name])) : null);

    const manifest = readJSON(_MANIFEST_NAME) || {};
    const options = readJSON('options.json') || {};
    const schematic = readJSON('schematic.json');
    const pcb = readJSON('pcb.json');

    // Re-attach the hoisted 3D meshes onto their definitions.
    if (schematic && schematic.defs && manifest.models) {
        for (const [key, entry] of Object.entries(manifest.models)) {
            const bytes = entries[/** @type {string} */ (entry)];
            if (bytes && schematic.defs[key]) {
                schematic.defs[key].model3dObj = strFromU8(bytes);
            }
        }
    }

    const doc = { ...options };
    if (schematic) doc.schematic = schematic;
    if (pcb) doc.pcb = pcb;
    return doc;
}

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
// ==================== Recent files + file handles (IndexedDB) ============
// One store, one source of truth. Each record is
//   { name, path, ts, handle }
// keyed by file name. The `handle` is a FileSystemFileHandle — structured-
// cloneable, so IndexedDB can persist it (identity + permission grant survive a
// reload); localStorage can't hold it (JSON-only). Keeping the recents metadata
// (path/ts) in the SAME record means the Open ▾ list and the re-openable handle
// can never disagree and there's no cross-store write race. The list is just
// every record sorted by `ts` (newest first), capped at MAX_RECENTS.
const HANDLE_DB_NAME = 'clearpcb-file-handles';
const HANDLE_STORE = 'handles';
const MAX_RECENTS = 10;

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

/**
 * Normalise a stored value to a record. Tolerates the legacy format where the
 * bare FileSystemFileHandle was stored directly (no metadata wrapper).
 * @returns {{name:string, path:string, ts:number, handle:any}|null}
 */
function _asRecord(name, value) {
    if (!value) return null;
    // New format: a wrapper object carrying the handle.
    if (value.handle) {
        return {
            name: value.name || name,
            path: value.path || value.name || name,
            ts: value.ts || 0,
            handle: value.handle,
        };
    }
    // Legacy format: the value IS the handle (has a `kind`/`getFile`).
    if (typeof value.getFile === 'function' || value.kind) {
        return { name, path: name, ts: 0, handle: value };
    }
    return null;
}

async function _idbGetRecord(name) {
    if (!name) return null;
    try {
        const db = await _openHandleDB();
        const value = await new Promise((resolve, reject) => {
            const tx = db.transaction(HANDLE_STORE, 'readonly');
            const r = tx.objectStore(HANDLE_STORE).get(name);
            r.onsuccess = () => resolve(r.result || null);
            r.onerror = () => reject(r.error);
        });
        db.close();
        return _asRecord(name, value);
    } catch { return null; }
}

async function _idbGetHandle(name) {
    const rec = await _idbGetRecord(name);
    return rec ? rec.handle : null;
}

/**
 * Upsert a recents record. Writes name/path/ts plus the handle in a single
 * transaction. If `handle` is omitted, the existing stored handle is preserved
 * (so bumping a recent's position never drops its handle).
 * @param {string} name
 * @param {{path?:string, handle?:any}} [opts]
 */
async function _idbPutRecord(name, { path, handle } = {}) {
    if (!name) return;
    try {
        const existing = await _idbGetRecord(name);
        const record = {
            name,
            path: path || existing?.path || name,
            ts: Date.now(),
            handle: handle || existing?.handle || null,
        };
        const db = await _openHandleDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(HANDLE_STORE, 'readwrite');
            tx.objectStore(HANDLE_STORE).put(record, name);
            tx.oncomplete = () => resolve(undefined);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('tx aborted'));
        });
        db.close();
        await _idbPruneRecents();
    } catch (e) { console.warn('[recents] failed to store record for', name, e); }
}

async function _idbDeleteRecord(name) {
    if (!name) return;
    try {
        const db = await _openHandleDB();
        await new Promise((resolve) => {
            const tx = db.transaction(HANDLE_STORE, 'readwrite');
            tx.objectStore(HANDLE_STORE).delete(name);
            tx.oncomplete = () => resolve(undefined);
            tx.onerror = () => resolve(undefined);
        });
        db.close();
    } catch { /* non-fatal */ }
}

/** Drop the oldest records beyond MAX_RECENTS so the store stays bounded. */
async function _idbPruneRecents() {
    try {
        const db = await _openHandleDB();
        const entries = await new Promise((resolve) => {
            const tx = db.transaction(HANDLE_STORE, 'readonly');
            const store = tx.objectStore(HANDLE_STORE);
            const rv = store.getAll();
            const rk = store.getAllKeys();
            let values = [], keys = [];
            rv.onsuccess = () => { values = rv.result || []; };
            rk.onsuccess = () => { keys = rk.result || []; };
            tx.oncomplete = () => resolve(keys.map((k, i) => ({ key: k, ts: (values[i] && values[i].ts) || 0 })));
            tx.onerror = () => resolve([]);
        });
        const stale = entries
            .sort((a, b) => b.ts - a.ts)
            .slice(MAX_RECENTS);
        if (stale.length) {
            await new Promise((resolve) => {
                const tx = db.transaction(HANDLE_STORE, 'readwrite');
                const store = tx.objectStore(HANDLE_STORE);
                for (const e of stale) store.delete(e.key);
                tx.oncomplete = () => resolve(undefined);
                tx.onerror = () => resolve(undefined);
            });
        }
        db.close();
    } catch { /* non-fatal */ }
}

/**
 * Return all recents records, newest first, capped at MAX_RECENTS.
 * @returns {Promise<Array<{name:string, path:string, ts:number}>>}
 */
async function _idbGetAllRecents() {
    try {
        const db = await _openHandleDB();
        const values = await new Promise((resolve, reject) => {
            const tx = db.transaction(HANDLE_STORE, 'readonly');
            const r = tx.objectStore(HANDLE_STORE).getAll();
            r.onsuccess = () => resolve(r.result || []);
            r.onerror = () => reject(r.error);
        });
        const keys = await new Promise((resolve) => {
            const tx = db.transaction(HANDLE_STORE, 'readonly');
            const r = tx.objectStore(HANDLE_STORE).getAllKeys();
            r.onsuccess = () => resolve(r.result || []);
            r.onerror = () => resolve([]);
        });
        db.close();
        return values
            .map((v, i) => _asRecord(String(keys[i]), v))
            .filter((r) => r)
            .sort((a, b) => b.ts - a.ts)
            .slice(0, MAX_RECENTS)
            .map(({ name, path, ts }) => ({ name, path, ts }));
    } catch { return []; }
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
        this.autoSaveSize = null;
        
        // Callbacks
        this.onDirtyChanged = null;
        this.onFileNameChanged = null;
        this.onAutoSaveChanged = null;
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
            // Persist the handle + recents metadata in one record so it survives
            // a reload (autosave recovery) and shows in the Open ▾ list.
            await this._recordRecent(handle.name, handle.name, handle);
            
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
            const blob = await _serializeProject(data);
            await writable.write(blob);
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
    async saveWithDownload(data) {
        const blob = await _serializeProject(data);
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
            const data = await _deserializeProject(file);
            
            this.fileHandle = handle;
            this.setFileName(handle.name);
            this.setFilePath(handle.name);
            this.setDirty(false);
            // Persist the handle + recents metadata in one record so it survives
            // a reload (autosave recovery) and shows in the Open ▾ list.
            await this._recordRecent(handle.name, handle.name, handle);
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

    // ==================== Recent files ====================

    /**
     * Return the most-recently-used file list (newest first), as stored for
     * the Open button's dropdown. Each entry is `{name, path, ts}`.
     * @returns {Promise<Array<{name:string, path:string, ts:number}>>}
     */
    getRecentFiles() {
        return _idbGetAllRecents();
    }

    /**
     * Record (or bump to the top of) a file in the recents list, persisting its
     * handle in the same record. Called after a successful open/save.
     * @param {string} name File name (the IndexedDB record key).
     * @param {string} [path] Display path (defaults to name).
     * @param {any} [handle] FileSystemFileHandle (preserved if omitted).
     */
    _recordRecent(name, path, handle) {
        if (!name) return Promise.resolve();
        return _idbPutRecord(name, { path, handle });
    }

    /**
     * Remove a file from the recents list (which also drops its stored handle,
     * since both live in one record).
     * @param {string} name
     */
    removeRecent(name) {
        if (!name) return;
        _idbDeleteRecord(name);
    }

    /**
     * Re-open a file straight from a stored handle (a recents-menu click),
     * skipping the file picker. The click supplies the user gesture needed to
     * (re)request read permission. Mirrors {@link openWithFilePicker}'s result
     * shape so callers can run the same load pipeline.
     * @param {string} name The recents entry / handle key.
     * @returns {Promise<{success:boolean, data?:any, fileName?:string, error?:string, missingHandle?:boolean}>}
     */
    async openRecent(name) {
        if (!name) return { success: false, error: 'No file specified' };
        const handle = await _idbGetHandle(name);
        if (!handle) {
            // No stored handle for this entry. This happens when the file was
            // opened via the input fallback, or when the browser couldn't
            // persist the FileSystemFileHandle (some configs can't structured-
            // clone it). The file itself may well still exist, so don't claim
            // it's gone or drop the recent — just fall back to the normal
            // picker so the user can re-open it (which re-stores the handle).
            return this.openWithFilePicker();
        }
        try {
            if (typeof handle.queryPermission === 'function') {
                const opts = { mode: 'read' };
                if (await handle.queryPermission(opts) !== 'granted'
                    && await handle.requestPermission(opts) !== 'granted') {
                    return { success: false, error: 'Permission to read the file was denied.' };
                }
            }
            const file = await handle.getFile();
            const data = await _deserializeProject(file);

            this.fileHandle = handle;
            this.setFileName(handle.name || name);
            this.setFilePath(handle.name || name);
            this.setDirty(false);
            await this._recordRecent(this.fileName, this.filePath, handle);
            // Immediately autosave the opened document
            this.autoSaveToStorage(data);

            return { success: true, data, fileName: this.fileName };
        } catch (err) {
            if (err && err.name === 'NotFoundError') {
                // The file was moved or deleted — drop the dead recent.
                this.removeRecent(name);
                return { success: false, error: 'The file could not be found (it may have been moved or deleted).' };
            }
            if (err && err.name === 'NotAllowedError') {
                return { success: false, error: 'Permission to read the file was denied.' };
            }
            console.error('Open recent failed:', err);
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
                    const data = await _deserializeProject(file);
                    
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
            this.autoSaveSize = new TextEncoder().encode(json).byteLength;
            this.onAutoSaveChanged?.(this.autoSaveSize);
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
            // Keep the file handle (if any) persisted in its recents record so
            // a post-reload recovery can "Save" back to the original file.
            if (this.fileHandle && this.fileName) {
                _idbPutRecord(this.fileName, { path: this.filePath || this.fileName, handle: this.fileHandle });
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
            this.autoSaveSize = new TextEncoder().encode(json).byteLength;
            this.onAutoSaveChanged?.(this.autoSaveSize);
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
            // NOTE: the file's recents record (and its handle) is intentionally
            // NOT removed here — clearing a recovery snapshot must not evict the
            // file from the Open ▾ list. Recents are pruned/removed separately.
        } else {
            // Remove all autosaves
            for (const entry of index) {
                localStorage.removeItem(entry.key);
            }
            index = [];
        }
        localStorage.setItem(this.autoSavePrefix + 'index', JSON.stringify(index));
        const clearedCurrent = !fileName || fileName === this.fileName;
        if (clearedCurrent) {
            this.autoSaveSize = null;
            this.onAutoSaveChanged?.(null);
        }
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