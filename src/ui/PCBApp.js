// PCBApp.js - PCB Editor Application (scaffold)

import { bindPcbControls } from '../pcb/modules/controls.js';
import { loadAndApplyTheme, toggleTheme as toggleSharedTheme, syncThemeToggleButtons } from '../shared/ui/theme.js';

/**
 * Minimal PCB app scaffold used by the shared bootstrap.
 *
 * This class owns PCB-mode UI wiring (ribbon tabs, theme toggle,
 * mode activation hooks) so future PCB editing logic can be added
 * without touching schematic modules.
 */
export default class PCBApp {
    constructor() {
        this.ribbon = document.getElementById('ribbonPCB');
        this.themeToggle = document.getElementById('pcbThemeToggle');
        this.placeholderText = document.querySelector('.pcb-placeholder-text');

        this._initialized = false;
        this._active = false;
        this.currentTool = 'select';
        this.activeLayer = 'top';
    }

    initialize() {
        if (this._initialized) return;

        this._bindRibbonTabs();
        bindPcbControls(this);
        this._bindThemeToggle();
        loadAndApplyTheme();
        syncThemeToggleButtons(['themeToggle', 'pcbThemeToggle']);

        this._initialized = true;
    }

    activate() {
        this.initialize();
        this._active = true;

        if (this.placeholderText) {
            this._setPcbStatus();
        }
    }

    deactivate() {
        this._active = false;
    }

    _setPcbStatus() {
        if (!this.placeholderText) return;
        const toolLabel = this.currentTool === 'pan' ? 'Pan' : 'Select';
        const layerLabel = this.activeLayer === 'bottom' ? 'Bottom Layer' : 'Top Layer';
        this.placeholderText.textContent = `Active: ${toolLabel} | ${layerLabel}`;
    }

    _bindRibbonTabs() {
        if (!this.ribbon) return;

        const tabs = this.ribbon.querySelectorAll('.ribbon-tab[data-tab]');
        const panels = this.ribbon.querySelectorAll('.ribbon-panel');

        const setActive = (tabId) => {
            tabs.forEach(tab => {
                const tabEl = /** @type {HTMLElement} */ (tab);
                tabEl.classList.toggle('active', tabEl.dataset.tab === tabId);
            });

            panels.forEach(panel => {
                const panelEl = /** @type {HTMLElement} */ (panel);
                panelEl.classList.toggle('active', panelEl.dataset.panel === tabId);
            });
        };

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabEl = /** @type {HTMLElement} */ (tab);
                if (!tabEl.dataset.tab) return;
                setActive(tabEl.dataset.tab);
            });
        });
    }

    _bindThemeToggle() {
        if (!this.themeToggle) return;

        this.themeToggle.addEventListener('click', () => {
            const newTheme = toggleSharedTheme();
            syncThemeToggleButtons(['themeToggle', 'pcbThemeToggle'], newTheme);
        });
    }
}
