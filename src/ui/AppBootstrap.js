// AppBootstrap.js - Shared application bootstrap for schematic + PCB modes

import SchematicApp from './SchematicApp.js';
import PCBApp from './PCBApp.js';
import { ProjectDocument } from '../core/ProjectDocument.js';
import { readProjectFile } from '../core/FileManager.js';
import { installNumberInputFormatting } from '../core/number-inputs.js';
import { ModalManager } from '../core/ModalManager.js';

class AppBootstrap {
    constructor() {
        this.modeTabs = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('.mode-tab')));
        this.slider = document.querySelector('.app-slider');
        this.ribbonSchematic = document.getElementById('ribbonSchematic');
        this.ribbonPCB = document.getElementById('ribbonPCB');
        this._pcbPreloadHandle = null;

        /** The neutral owner of the single project document. */
        this.project = new ProjectDocument();
        this.project.onLoadingChange = (loading) => {
            if (loading) this._cancelPcbPreload();
            this._setTabsLoading(loading);
            if (loading) return new Promise(resolve => setTimeout(resolve, 0));
            this._schedulePcbPreload();
        };
        this.schematicApp = null;
        this.pcbApp = null;
        this._switchingMode = false;
    }

    async initialize() {
        installNumberInputFormatting();
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

        this._bindModeTabs();
        await this.schematicApp._recoverAutoSave?.();

        // Both views are registered — start project-driven autosave so
        // edits in EITHER editor are captured into the one document.
        this.project.startAutoSave();

        this._setupLaunchQueue();
        this._schedulePcbPreload();
    }

    /**
     * Single window-capture keydown listener that routes keys to the
    * active mode after handling shared mode cycling. PCB consumes its
    * shortcuts here; the later schematic listener handles schematic keys.
     */
    _bindKeyboardDispatcher() {
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && !e.defaultPrevented) {
                const modal = ModalManager.top();
                if (modal && modal.id !== 'text-edit' && modal.id !== 'componentPicker') return;
                e.preventDefault();
                e.stopImmediatePropagation();
                const active = this.modeTabs.find(tab => tab.classList.contains('active'));
                const isPcb = active ? active.dataset.mode === 'pcb' : this.pcbApp?._active;
                this.switchMode(isPcb ? 'schematic' : 'pcb');
                return;
            }
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

    _setTabsLoading(loading, mode = null) {
        this.modeTabs.forEach(tab => {
            const tabLoading = loading && (!mode || tab.dataset.mode === mode);
            tab.classList.toggle('loading', tabLoading);
            if (tabLoading) tab.setAttribute('aria-busy', 'true');
            else tab.removeAttribute('aria-busy');
        });
    }

    _cancelPcbPreload() {
        if (!this._pcbPreloadHandle) return;
        const { type, id } = this._pcbPreloadHandle;
        if (type === 'idle') window.cancelIdleCallback?.(id);
        else if (type === 'frame') window.cancelAnimationFrame(id);
        else clearTimeout(id);
        this._pcbPreloadHandle = null;
        this._setTabsLoading(false, 'pcb');
    }

    _schedulePcbPreload() {
        if (!this.pcbApp?._stale || this.pcbApp._active) return;
        this._cancelPcbPreload();
        const render = () => {
            this._pcbPreloadHandle = null;
            if (this.project.fileManager.loading || this.pcbApp?._active || !this.pcbApp?._stale) return;
            try {
                this.pcbApp.preload?.();
            } finally {
                this._setTabsLoading(false, 'pcb');
            }
        };
        const prepare = () => {
            this._setTabsLoading(true, 'pcb');
            this._pcbPreloadHandle = {
                type: 'frame',
                id: window.requestAnimationFrame(() => {
                    this._pcbPreloadHandle = {
                        type: 'frame',
                        id: window.requestAnimationFrame(render),
                    };
                }),
            };
        };
        if ('requestIdleCallback' in window) {
            this._pcbPreloadHandle = { type: 'idle', id: window.requestIdleCallback(prepare) };
        } else {
            this._pcbPreloadHandle = { type: 'timeout', id: setTimeout(prepare, 250) };
        }
    }

    async switchMode(mode) {
        if (this.project.fileManager.loading || this._switchingMode) return;
        this._cancelPcbPreload();
        const isPcb = mode === 'pcb';

        this.modeTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.mode === mode);
        });

        this.slider?.classList.toggle('show-pcb', isPcb);
        this.ribbonSchematic?.classList.toggle('ribbon-hidden', isPcb);
        this.ribbonPCB?.classList.toggle('ribbon-hidden', !isPcb);

        const needsPcbRender = isPcb && this.pcbApp?._stale;
        if (needsPcbRender) {
            this._switchingMode = true;
            this._setTabsLoading(true, 'pcb');
            await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
        }

        try {
            if (isPcb) {
                this.pcbApp?.activate();
            } else {
                this.pcbApp?.deactivate();
            }
        } finally {
            if (needsPcbRender) {
                this._setTabsLoading(false, 'pcb');
                this._switchingMode = false;
            }
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

            try {
                const data = await readProjectFile(file);
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

            const app = this.schematicApp;
            if (app.fileManager.saving || app.fileManager.loading) {
                app._alert('Wait for the current file operation to finish.', { title: 'Open Failed' });
                return;
            }
            if ((this.project?.isDirty ?? app.fileManager.isDirty)
                && !await app._confirm('You have unsaved changes. Open another file anyway?',
                    { title: 'Unsaved Changes', okText: 'Yes', cancelText: 'No', defaultCancel: true })) return;
            try {
                await app._loadDocument(data);
                await app.fileManager.adoptOpen({ handle: fileHandle, fileName: fileHandle.name });
                this.switchMode('schematic');
                app._fitToContent?.();
            } catch (error) {
                app._alert('Failed to open file: ' + error.message, { title: 'Open Failed' });
            }
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
