import { refreshBoardView } from './refresh-state.js';
import { PCB_DESIGN_MAX_MM, clampDesignDimensions } from '../../core/PcbDesignSettings.js';

const STORAGE_KEY = 'clearpcb_pcb_design_params';
const INPUTS = {
    trackWidth: 'pcbTrackWidth', clearance: 'pcbClearance',
    viaDiameter: 'pcbViaDiameter', viaDrill: 'pcbViaDrill',
};
const MINIMUM_MM = { trackWidth: 0.05, clearance: 0.05, viaDiameter: 0.1, viaDrill: 0.05 };

const input = id => /** @type {HTMLInputElement|null} */ (document.getElementById(id));

function saveDefaults(app) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(app.designSettings.values));
    } catch (error) {
        console.warn('Could not save PCB design defaults:', error);
    }
}

export function renderDesignSettings(app) {
    const values = app.designSettings.values;
    const factor = values.units === 'inch' ? 1 / 25.4 : 1;
    const digits = values.units === 'inch' ? 4 : 3;
    const units = input('pcbRouteUnits'), router = input('pcbRouterMode');
    if (units) units.value = values.units;
    if (router) router.value = values.router;
    for (const [key, id] of Object.entries(INPUTS)) {
        const element = input(id);
        if (!element) continue;
        element.value = String(Number((values[key] * factor).toFixed(digits)));
        element.step = values.units === 'inch' ? '0.001' : '0.01';
        element.min = String(MINIMUM_MM[key] * factor);
        element.max = String(Number((PCB_DESIGN_MAX_MM[key] * factor).toFixed(digits)));
        element.setCustomValidity('');
    }
}

/** Refresh controls and local defaults after model adoption, without editing data. */
export function refreshDesignSettings(app) {
    renderDesignSettings(app);
    saveDefaults(app);
}

/** Bind presentation to the model; never read rounded controls back on unit changes. */
export function bindDesignSettings(app) {
    const units = input('pcbRouteUnits'), router = input('pcbRouterMode');
    if (!units && !router && !Object.values(INPUTS).some(id => input(id))) return;
    try {
        const stored = app.designSettings.hasAppliedSettings
            ? null : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (stored) {
            const restored = { units: stored.units || 'mm', router: stored.router || 'maze' };
            const factor = restored.units === 'inch' ? 25.4 : 1;
            for (const [key, id] of Object.entries(INPUTS)) {
                if (stored[key] !== undefined) restored[key] = stored[key];
                else if (stored[id] != null && stored[id] !== '') restored[key] = Number(stored[id]) * factor;
            }
            app.designSettings.update(clampDesignDimensions(restored));
        }
    } catch (error) {
        console.warn('Could not restore PCB design defaults:', error);
    }
    renderDesignSettings(app);

    units?.addEventListener('change', () => {
        if (!app.designSettings.update({ units: units.value })) return;
        renderDesignSettings(app);
        saveDefaults(app);
        app._markDirty?.();
    });
    router?.addEventListener('change', () => {
        if (!app.designSettings.update({ router: router.value })) return;
        saveDefaults(app);
        app._markDirty?.();
    });

    for (const [key, id] of Object.entries(INPUTS)) {
        const element = input(id);
        if (!element) continue;
        element.addEventListener('input', () => {
            commitDesignInput(app, key, element, app.designSettings.values.units);
        });
        element.addEventListener('change', () => {
            if (readDesignInput(element, app.designSettings.values.units, key) === null) element.reportValidity();
        });
    }
}

function readDesignInput(element, units, key) {
    const value = Number(element.value) * (units === 'inch' ? 25.4 : 1);
    const maximum = PCB_DESIGN_MAX_MM[key];
    let message = '';
    if (!Number.isFinite(value) || value <= 0) message = 'Enter a positive finite number.';
    // A small tolerance accepts the rounded inch display of the maximum itself.
    else if (value > maximum + 0.01) {
        message = units === 'inch'
            ? `Enter a value no larger than ${Number((maximum / 25.4).toFixed(4))} in.`
            : `Enter a value no larger than ${maximum} mm.`;
    }
    element.setCustomValidity(message);
    return message ? null : Math.min(value, maximum);
}

/** Both ribbon and drawing-tool editors commit through the same mm conversion. */
export function commitDesignInput(app, key, element, units) {
    const value = readDesignInput(element, units, key);
    if (value === null) return false;
    if (app.designSettings.update({ [key]: value })) {
        saveDefaults(app);
        app._markDirty?.();
        if (app._clearancesVisible) app.showClearances?.(true);
        app.refreshFills?.();
        refreshBoardView(app);
    }
    return true;
}
