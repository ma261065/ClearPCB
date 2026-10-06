// AppBootstrap.js - Shared application bootstrap for schematic + PCB modes

import SchematicApp from './SchematicApp.js';
import PCBApp from './PCBApp.js';
import { ProjectDocument } from '../core/ProjectDocument.js';
import { readProjectFile } from '../core/FileManager.js';
import { duplicateIdRepairMessage, repairDuplicateIds } from '../core/project-format.js';
import { installNumberInputFormatting } from '../core/number-inputs.js';
import { installLockedEditErrorFilter } from '../core/edit-guard.js';
import { ModalManager } from '../core/ModalManager.js';
import { renderRecentFiles } from '../shared/ui/recents.js';
import { flushSettledChanges } from '../shared/ui/settled-input.js';
import { McpBridge } from '../core/McpBridge.js';
import { createMcpSessionUi } from './mcp-session.js';

const DEFAULT_SERVICES = { ProjectDocument, PCBApp, SchematicApp, McpBridge, createMcpSessionUi };

export class AppBootstrap {
    /** @param {Partial<typeof DEFAULT_SERVICES>} [services] Collaborators; tests substitute headless ones. */
    constructor(services = {}) {
        this._services = { ...DEFAULT_SERVICES, ...services };
        this.modeTabs = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('.mode-tab')));
        this.slider = document.querySelector('.app-slider');
        this.ribbonSchematic = document.getElementById('ribbonSchematic');
        this.ribbonPCB = document.getElementById('ribbonPCB');
        this.startupSplash = document.getElementById('startupSplash');
        this.startupRecents = document.getElementById('startupRecents');
        this.startupOpen = document.getElementById('startupOpen');
        this.startupContinue = document.getElementById('startupContinue');
        this._pcbPreloadHandle = null;
        /**
         * Startup in progress: set when initialize() starts, and settles once startup has
         * finished, including the decision to show the startup splash.
         * @type {Promise<void>|null}
         */
        this.ready = null;

        /** The neutral owner of the single project document. */
        this.project = new this._services.ProjectDocument();
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
        installLockedEditErrorFilter(window);
        this._registerServiceWorker();

        this.pcbApp = new this._services.PCBApp(this.project);
        this.pcbApp.initialize();
        // Register the PCB editor as a project view (contributes doc.pcb).
        this.project.registerView('pcb', this.pcbApp);
        this.mcpBridge = new this._services.McpBridge(this.project);
        this.mcpSessionUi = this._services.createMcpSessionUi(this.mcpBridge);

        // Install the dispatcher BEFORE SchematicApp constructs so that
        // it occupies an earlier slot in window-capture order than the
        // schematic shortcut listener, and so always gets first crack
        // at every keydown.
        this._bindKeyboardDispatcher();

        // The schematic editor registers itself as the project's UI-host
        // view (and injects the file lifecycle) from its constructor.
        this.schematicApp = new this._services.SchematicApp(this.project);

        this._bindModeTabs();
        await this.schematicApp._recoverAutoSave?.();
        await this._initializeStartupSplash();

        // Both views are registered — start project-driven autosave so
        // edits in EITHER editor are captured into the one document.
        this.project.startAutoSave();

        this._setupLaunchQueue();
        this._schedulePcbPreload();
    }

    _isProjectBlank() {
        const schematic = this.schematicApp;
        const pcb = this.pcbApp;
        const schematicBlank = !schematic?.shapes?.length && !schematic?.components?.length;
        const pcbBlank = !pcb?.tracks?.length
            && !pcb?.vias?.length
            && !pcb?.boardShapes?.length
            && !pcb?.texts?.size
            && !pcb?._placementOverrides?.size
            && !pcb?.isBoardOutlineDrawn();
        return schematicBlank && pcbBlank;
    }

    async _initializeStartupSplash() {
        if (!this.startupSplash || !this._isProjectBlank()) {
            this._hideStartupSplash();
            return;
        }

        this.startupOpen?.addEventListener('click', async () => {
            await this.project.open();
            if (!this._isProjectBlank()) this._hideStartupSplash();
        });
        this.startupContinue?.addEventListener('click', () => this._hideStartupSplash());
        this.startupSplash.addEventListener('keydown', event => this._trapStartupSplashFocus(event));

        await renderRecentFiles({
            container: this.startupRecents,
            getFileManager: () => this.project.fileManager,
            openRecent: async (name) => {
                await this.project.openRecent(name);
                if (!this._isProjectBlank()) this._hideStartupSplash();
            },
        });
        this.startupSplash.hidden = false;
        ModalManager.push('startup-splash', () => this._hideStartupSplash());
        this.startupOpen?.focus();
    }

    _hideStartupSplash() {
        if (this.startupSplash) this.startupSplash.hidden = true;
        ModalManager.pop('startup-splash');
    }

    _trapStartupSplashFocus(event) {
        if (event.key !== 'Tab' || !this.startupSplash || this.startupSplash.hidden) return;
        const focusable = /** @type {HTMLElement[]} */ (Array.from(this.startupSplash.querySelectorAll(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )));
        if (!focusable.length) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
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
        this.slider?.addEventListener('transitionend', (event) => {
            if (/** @type {TransitionEvent} */ (event).propertyName !== 'transform') return;
            this.schematicApp?.viewport?.invalidateLayoutCache?.();
            this.pcbApp?.viewport?.invalidateLayoutCache?.();
        });
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
        if (this._pcbPreloadHandle) {
            const { type, id } = this._pcbPreloadHandle;
            if (type === 'idle') window.cancelIdleCallback?.(id);
            else if (type === 'frame') window.cancelAnimationFrame(id);
            else clearTimeout(id);
            this._pcbPreloadHandle = null;
        }
        this._setTabsLoading(false, 'pcb');
    }

    _schedulePcbPreload() {
        if (!this.pcbApp?._stale || this.pcbApp._active) return;
        this._cancelPcbPreload();
        const render = () => {
            this._pcbPreloadHandle = null;
            // The spinner was shown in prepare(); clear it on every exit, including
            // when the PCB was rendered or a load started in the meantime.
            try {
                if (this.project.fileManager.loading || this.pcbApp?._active || !this.pcbApp?._stale) return;
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
        // The editor being left keeps a number field's settling value.
        flushSettledChanges();
        this._cancelPcbPreload();
        const isPcb = mode === 'pcb';

        this.modeTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.mode === mode);
        });

        this.slider?.classList.toggle('show-pcb', isPcb);
        this.ribbonSchematic?.classList.toggle('ribbon-hidden', isPcb);
        this.ribbonPCB?.classList.toggle('ribbon-hidden', !isPcb);
        this.schematicApp?.viewport?.invalidateLayoutCache?.();
        this.pcbApp?.viewport?.invalidateLayoutCache?.();

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
                this.schematicApp?.retainRibbonHeight?.();
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
                app.alert('Wait for the current file operation to finish.', { title: 'Open Failed' });
                return;
            }
            if ((this.project?.isDirty ?? app.fileManager.isDirty)
                && !await app.confirm('You have unsaved changes. Open another file anyway?',
                    { title: 'Unsaved Changes', okText: 'Yes', cancelText: 'No', defaultCancel: true })) return;
            try {
                const repaired = repairDuplicateIds(data);
                await this.project.load(repaired.data);
                await app.fileManager.adoptOpen({ handle: fileHandle, fileName: fileHandle.name });
                this._hideStartupSplash();
                this.switchMode('schematic');
                app.fitToContent?.();
                this.project.notifyDocumentReplaced('open');
                const message = duplicateIdRepairMessage(repaired);
                if (message) {
                    app.fileManager.setDirty(true);
                    await app.alert(`Opened ${fileHandle.name}. ${message}`, { title: 'File Repaired' });
                }
            } catch (error) {
                app.alert('Failed to open file: ' + error.message, { title: 'Open Failed' });
            }
        };

        void tryLoad();
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const bootstrap = new AppBootstrap();
    // Console inspection only; application code receives its dependencies explicitly.
    /** @type {any} */ (window).bootstrap = bootstrap;
    bootstrap.ready = bootstrap.initialize();
    await bootstrap.ready;
});
