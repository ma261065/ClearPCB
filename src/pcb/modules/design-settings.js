import { refreshBoardView } from './refresh-state.js';
import { PCB_DESIGN_MAX_MM, clampDesignDimensions } from '../../core/PcbDesignSettings.js';
import { areClearancesVisible } from './clearance-overlay.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

const STORAGE_KEY = 'clearpcb_pcb_design_params';
const INPUTS = {
    trackWidth: 'pcbTrackWidth', clearance: 'pcbClearance',
    viaDiameter: 'pcbViaDiameter', viaDrill: 'pcbViaDrill',
};
const MINIMUM_MM = { trackWidth: 0.05, clearance: 0.05, viaDiameter: 0.1, viaDrill: 0.05 };

/** @param {PcbEditor} app */
function saveDefaults(app) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(app.designSettings.values));
    } catch (error) {
        console.warn('Could not save PCB design defaults:', error);
    }
}

/** @param {PcbEditor} app */
export function renderDesignSettings(app) {
    app.refreshPcbRibbon?.();
}

/**
 * Refresh controls and local defaults after model adoption, without editing data.
 * @param {PcbEditor} app
 */
export function refreshDesignSettings(app) {
    renderDesignSettings(app);
    saveDefaults(app);
}

/**
 * Bind presentation to the model; never read rounded controls back on unit changes.
 * @param {PcbEditor} app
 */
export function bindDesignSettings(app) {
    if (!app.designSettings) return;
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
}

function readDesignValue(key, rawValue, units) {
    const value = Number(rawValue) * (units === 'inch' ? 25.4 : 1);
    const maximum = PCB_DESIGN_MAX_MM[key];
    let message = '';
    if (!Number.isFinite(value) || value <= 0) message = 'Enter a positive finite number.';
    // A small tolerance accepts the rounded inch display of the maximum itself.
    else if (value > maximum + 0.01) {
        message = units === 'inch'
            ? `Enter a value no larger than ${Number((maximum / 25.4).toFixed(4))} in.`
            : `Enter a value no larger than ${maximum} mm.`;
    }
    return { value: message ? null : Math.min(value, maximum), message };
}

function readDesignInput(element, units, key) {
    const result = readDesignValue(key, element.value, units);
    element.setCustomValidity(result.message);
    return result.value;
}

/** @param {PcbEditor} app */
function commitDesignUpdate(app, key, value) {
    if (app.designSettings.update({ [key]: value })) {
        saveDefaults(app);
        app.markDirty?.();
        if (areClearancesVisible(app)) app.showClearances?.(true);
        app.refreshFills?.();
        refreshBoardView(app);
    }
}

/**
 * Both ribbon and drawing-tool editors commit through the same mm conversion.
 * @param {PcbEditor} app
 */
export function commitDesignInput(app, key, element, units) {
    const value = readDesignInput(element, units, key);
    if (value === null) return false;
    commitDesignUpdate(app, key, value);
    return true;
}

/**
 * Commit a design value without a DOM input; returns the validation message for panels.
 * @param {PcbEditor} app
 */
export function commitDesignValue(app, key, rawValue, units = 'mm', onError = null) {
    const { value, message } = readDesignValue(key, rawValue, units);
    if (value === null) {
        onError?.(message);
        app.setStatus?.(message);
        return { ok: false, message };
    }
    commitDesignUpdate(app, key, value);
    return { ok: true, message: '' };
}
