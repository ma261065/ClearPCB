/**
 * FileManager - Handles save/load operations for schematic files
 * 
 * Uses File System Access API where available, falls back to download/upload
 */

export class FileManager {
    constructor() {
        // Current file handle (for "Save" without prompting)
        this.fileHandle = null;
        this.fileName = 'untitled.json';
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
            // Ensure fileName is up to date
            if (this.fileHandle.name) this.setFileName(this.fileHandle.name);
            result = await this.saveToHandle(data, this.fileHandle);
        } else {
            result = await this.saveAs(data);
        }
        // Persist a clean-state autosave after successful save
        if (result && result.success) {
            this.autoSaveToStorage(data);
        }
        // If the file name changed from untitled.json, delete the old autosave
        if (oldFileName && oldFileName !== this.fileName && oldFileName === 'untitled.json') {
            this.clearAutoSave('untitled.json');
        }
        return result;
    }
    
    /**
     * Save As - always prompts for location
     */
    async saveAs(data) {
        if (this.hasFileSystemAccess()) {
            const result = await this.saveWithFilePicker(data);
            // If the file name changed from untitled.json, delete the old autosave
            if (this.fileName !== 'untitled.json') {
                this.clearAutoSave('untitled.json');
            }
            return result;
        } else {
            const result = await this.saveWithDownload(data);
            if (this.fileName !== 'untitled.json') {
                this.clearAutoSave('untitled.json');
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
                    description: 'ClearPCB Schematic',
                    accept: { 'application/json': ['.json'] }
                }]
            };
            
            const handle = await window.showSaveFilePicker(options);
            await this.saveToHandle(data, handle);
            
            this.fileHandle = handle;
            this.setFileName(handle.name);
            this.setFilePath(handle.name);
            this.setDirty(false);
            
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
                    description: 'ClearPCB Schematic',
                    accept: { 'application/json': ['.json'] }
                }]
            };
            
            const [handle] = await window.showOpenFilePicker(options);
            const file = await handle.getFile();
            const text = await file.text();
            const data = JSON.parse(text);
            
            this.fileHandle = handle;
            this.setFileName(handle.name);
            this.setFilePath(handle.name);
            this.setDirty(false);
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
            input.accept = '.json';
            
            input.onchange = async (e) => {
                const file = e.target.files[0];
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
    startAutoSave(getDataFn) {
        this.stopAutoSave();
        this.autoSaveTimer = setInterval(() => {
            if (this.isDirty) {
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
        } catch (err) {
            console.error('Auto-save failed:', err);
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
        } else {
            // Remove all autosaves
            for (const entry of index) {
                localStorage.removeItem(entry.key);
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
        this.setFileName('untitled.json');
        this.setFilePath(null);
        this.setDirty(false);
        // Immediately autosave the new document
        this.autoSaveToStorage({ shapes: [], version: 1 });
        return { shapes: [], version: 1 };
    }
}