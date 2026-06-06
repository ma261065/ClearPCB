// AppBootstrap.js - Shared application bootstrap for schematic + PCB modes

import SchematicApp from './SchematicApp.js';
import PCBApp from './PCBApp.js';
import { ProjectDocument } from '../core/ProjectDocument.js';

class AppBootstrap {
    constructor() {
        this.modeTabs = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('.mode-tab')));
        this.slider = document.querySelector('.app-slider');
        this.ribbonSchematic = document.getElementById('ribbonSchematic');
        this.ribbonPCB = document.getElementById('ribbonPCB');

        /** The neutral owner of the single project document. */
        this.project = new ProjectDocument();
        this.schematicApp = null;
        this.pcbApp = null;
    }

    async initialize() {
        this._registerServiceWorker();

        this.pcbApp = new PCBApp();
        this.pcbApp.initialize();
        // Register the PCB editor as a project view (contributes doc.pcb).
        this.pcbApp.project = this.project;
        this.project.registerView('pcb', this.pcbApp);

        // Install the dispatcher BEFORE SchematicApp constructs so that
        // it occupies an earlier slot in window-capture order than the
        // schematic shortcut listener, and so always gets first crack
        // at every keydown.
        this._bindKeyboardDispatcher();

        // The schematic editor registers itself as the project's UI-host
        // view (and injects the file lifecycle) from its constructor.
        /** @type {any} */ (window).app = new SchematicApp(this.project);
        this.schematicApp = /** @type {any} */ (window).app;

        await this.schematicApp._recoverAutoSave?.();

        // Both views are registered — start project-driven autosave so
        // edits in EITHER editor are captured into the one document.
        this.project.startAutoSave();

        this._bindModeTabs();
        this._setupLaunchQueue();
    }

    /**
     * Single window-capture keydown listener that routes keys to the
     * active mode. PCB shortcuts get first crack when PCB is active;
     * the schematic listener (also bound on window-capture, but later)
     * still runs as a fallback for global keys (Ctrl+S, Ctrl+Tab, etc.)
     * unless PCB consumed the event.
     */
    _bindKeyboardDispatcher() {
        window.addEventListener('keydown', (e) => {
            if (this.pcbApp?._active && typeof this.pcbApp.handleKeyDown === 'function') {
                if (this.pcbApp.handleKeyDown(e)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            }
        }, { capture: true });
    }

    _bindModeTabs() {
        this.modeTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const mode = tab.dataset.mode === 'pcb' ? 'pcb' : 'schematic';
                this.switchMode(mode);
                // Don't let the tab keep DOM focus — otherwise the next
                // keypress (e.g. Escape) promotes it to :focus-visible and
                // paints a stray outline. The active-tab styling already
                // conveys which mode is selected. Genuine keyboard Tab
                // navigation still focuses (and rings) the tab afresh.
                tab.blur();
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
        navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.warn('Service worker registration failed:', err);
        });
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
    // Expose BEFORE initialize() so autosave-recovery (which runs
    // inside initialize()) can reach bootstrap.project to restore the
    // PCB section of the document.
    /** @type {any} */ (window).bootstrap = bootstrap;
    await bootstrap.initialize();
});
