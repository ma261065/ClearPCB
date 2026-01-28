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
        this.isDirty = false;
        
        // Auto-save key for localStorage
        this.autoSaveKey = 'clearpcb_autosave';
        this.autoSaveInterval = 30000; // 30 seconds
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
    
    // ==================== Save Operations ====================
    
    /**
     * Save to current file (or Save As if no file)
     */
    async save(data) {
        if (this.fileHandle) {
            return this.saveToHandle(data, this.fileHandle);
        } else {
            return this.saveAs(data);
        }
    }
    
    /**
     * Save As - always prompts for location
     */
    async saveAs(data) {
        if (this.hasFileSystemAccess()) {
            return this.saveWithFilePicker(data);
        } else {
            return this.saveWithDownload(data);
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
            return this.openWithFilePicker();
        } else {
            return this.openWithInput();
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
            this.setDirty(false);
            
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
                    this.setDirty(false);
                    
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
            const json = JSON.stringify({
                timestamp: Date.now(),
                fileName: this.fileName,
                data: data
            });
            localStorage.setItem(this.autoSaveKey, json);
            console.log('Auto-saved to localStorage');
        } catch (err) {
            console.error('Auto-save failed:', err);
        }
    }
    
    /**
     * Check if there's an auto-saved document
     */
    hasAutoSave() {
        return localStorage.getItem(this.autoSaveKey) !== null;
    }
    
    /**
     * Load auto-saved document
     */
    loadAutoSave() {
        try {
            const json = localStorage.getItem(this.autoSaveKey);
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
    clearAutoSave() {
        localStorage.removeItem(this.autoSaveKey);
    }
    
    // ==================== New Document ====================
    
    /**
     * Start a new document
     */
    newDocument() {
        this.fileHandle = null;
        this.setFileName('untitled.json');
        this.setDirty(false);
        return { shapes: [], version: 1 };
    }
}