// AppBootstrap.js - Shared application bootstrap for schematic + PCB modes

import SchematicApp from './SchematicApp.js';
import PCBApp from './PCBApp.js';

class AppBootstrap {
    constructor() {
        this.modeTabs = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('.mode-tab')));
        this.slider = document.querySelector('.app-slider');
        this.ribbonSchematic = document.getElementById('ribbonSchematic');
        this.ribbonPCB = document.getElementById('ribbonPCB');

        this.schematicApp = null;
        this.pcbApp = null;
    }

    async initialize() {
        this._registerServiceWorker();

        this.pcbApp = new PCBApp();
        this.pcbApp.initialize();

        /** @type {any} */ (window).app = new SchematicApp();
        this.schematicApp = /** @type {any} */ (window).app;

        await this.schematicApp._recoverAutoSave?.();

        this._bindModeTabs();
        this._setupLaunchQueue();
    }

    _bindModeTabs() {
        this.modeTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const mode = tab.dataset.mode === 'pcb' ? 'pcb' : 'schematic';
                this.switchMode(mode);
            });
        });
    }

    switchMode(mode) {
        const isPcb = mode === 'pcb';

        this.modeTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.mode === mode);
        });

        this.slider?.classList.toggle('show-pcb', isPcb);
        this.ribbonSchematic?.classList.toggle('ribbon-hidden', isPcb);
        this.ribbonPCB?.classList.toggle('ribbon-hidden', !isPcb);

        if (isPcb) {
            this.pcbApp?.activate();
        } else {
            this.pcbApp?.deactivate();
        }
    }

    _registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    _setupLaunchQueue() {
        if (!('launchQueue' in window)) return;

        const launchQueue = /** @type {any} */ (window.launchQueue);
        launchQueue.setConsumer(async (launchParams) => {
            if (!launchParams.files?.length) return;

            // Signal to SchematicApp to skip auto-save recovery path for launch-open flow.
            /** @type {any} */ (window)._launchFile = true;

            const fileHandle = launchParams.files[0];
            const file = await fileHandle.getFile();
            const text = await file.text();

            try {
                const data = JSON.parse(text);
                this._loadLaunchDocument(fileHandle, data);
            } catch (error) {
                console.error('Failed to open file:', error);
            }
        });
    }

    _loadLaunchDocument(fileHandle, data) {
        const tryLoad = async () => {
            if (!this.schematicApp?.fileManager) {
                setTimeout(tryLoad, 100);
                return;
            }

            this.switchMode('schematic');

            this.schematicApp.fileManager.fileHandle = fileHandle;
            this.schematicApp.fileManager.setFileName(fileHandle.name);
            this.schematicApp.fileManager.setFilePath(fileHandle.name);
            await this.schematicApp._loadDocument(data);
            this.schematicApp._fitToContent?.();
            this.schematicApp.fileManager.setDirty(false);
        };

        void tryLoad();
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const bootstrap = new AppBootstrap();
    await bootstrap.initialize();
    /** @type {any} */ (window).bootstrap = bootstrap;
});
