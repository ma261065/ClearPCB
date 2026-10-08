/**
 * @typedef {object} PanelSettings
 * @property {number} rows @property {number} columns @property {number} rowSpacing @property {number} columnSpacing
 * @property {'tabs'|'vcut'} separation
 * @property {number} railTop @property {number} railBottom @property {number} railLeft @property {number} railRight
 * @property {number} tabWidth @property {number} holeDiameter @property {number} holePitch
 * @property {number} verticalTabsPerEdge @property {number} horizontalTabsPerEdge
 * @property {number} verticalTabOffset @property {number} horizontalTabOffset
 * @property {boolean} horizontalPositioningHoles @property {boolean} horizontalFiducials
 * @property {boolean} verticalPositioningHoles @property {boolean} verticalFiducials
 * @property {boolean} [noteCreated] the panel note text has been added to the board
 */

/** @type {Readonly<PanelSettings>} */
export const PANEL_DEFAULTS = Object.freeze({
    rows: 2, columns: 2, rowSpacing: 2, columnSpacing: 2,
    separation: 'tabs', railTop: 5, railBottom: 5, railLeft: 0, railRight: 0,
    tabWidth: 3, holeDiameter: 0.5, holePitch: 0.8,
    verticalTabsPerEdge: 2, horizontalTabsPerEdge: 2, verticalTabOffset: 0, horizontalTabOffset: 0,
    horizontalPositioningHoles: false, horizontalFiducials: false,
    verticalPositioningHoles: false, verticalFiducials: false,
});

/** @typedef {keyof PanelSettings} PanelSettingKey */
/** @typedef {Extract<PanelSettingKey, 'rows'|'columns'|'verticalTabsPerEdge'|'horizontalTabsPerEdge'|'verticalTabOffset'|'horizontalTabOffset'|'rowSpacing'|'columnSpacing'|'railTop'|'railBottom'|'railLeft'|'railRight'|'tabWidth'|'holeDiameter'|'holePitch'>} NumericPanelSettingKey */
/** @typedef {Extract<PanelSettingKey, 'horizontalPositioningHoles'|'horizontalFiducials'|'verticalPositioningHoles'|'verticalFiducials'>} BooleanPanelSettingKey */

/**
 * @param {Partial<PanelSettings>|unknown} value
 * @returns {PanelSettings}
 */
export function panelSettings(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid panel settings.');
    const source = /** @type {Partial<PanelSettings>} */ (value);
    /** @type {PanelSettings} */
    const settings = { ...PANEL_DEFAULTS };
    for (const key of /** @type {PanelSettingKey[]} */ (Object.keys(settings))) {
        if (source[key] !== undefined) settings[key] = /** @type {never} */ (source[key]);
    }
    for (const key of /** @type {NumericPanelSettingKey[]} */ (['rows', 'columns'])) {
        if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 20) {
            throw new Error('Rows and columns must be whole numbers from 1 to 20.');
        }
    }
    if (settings.rows * settings.columns > 100) throw new Error('A panel can contain at most 100 boards.');
    for (const key of /** @type {NumericPanelSettingKey[]} */ (['verticalTabsPerEdge', 'horizontalTabsPerEdge'])) {
        if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 20) {
            throw new Error('Tabs per edge must be a whole number from 1 to 20.');
        }
    }
    for (const key of /** @type {NumericPanelSettingKey[]} */ (['verticalTabOffset', 'horizontalTabOffset'])) {
        if (!Number.isFinite(settings[key]) || Math.abs(settings[key]) > 100) {
            throw new Error('Tab offsets must be between -100 and 100 mm.');
        }
    }
    for (const key of /** @type {NumericPanelSettingKey[]} */ (['rowSpacing', 'columnSpacing', 'railTop', 'railBottom', 'railLeft', 'railRight'])) {
        if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 100) {
            throw new Error('Spacing and rail widths must be between 0 and 100 mm.');
        }
    }
    if (!['tabs', 'vcut'].includes(settings.separation)) throw new Error('Unknown panel separation method.');
    for (const key of /** @type {BooleanPanelSettingKey[]} */ (['horizontalPositioningHoles', 'horizontalFiducials', 'verticalPositioningHoles', 'verticalFiducials'])) {
        if (typeof settings[key] !== 'boolean') throw new Error('Rail feature options must be boolean values.');
    }
    for (const key of /** @type {NumericPanelSettingKey[]} */ (['tabWidth', 'holeDiameter', 'holePitch'])) {
        if (!Number.isFinite(settings[key]) || settings[key] <= 0 || settings[key] > 20) {
            throw new Error('Tab and drill dimensions must be greater than zero and at most 20 mm.');
        }
    }
    if (settings.holePitch <= settings.holeDiameter) throw new Error('Hole pitch must exceed hole diameter.');
    if (settings.tabWidth < settings.holePitch * 2) throw new Error('Tabs must be at least two hole pitches wide.');
    return source.noteCreated === true ? { ...settings, noteCreated: true } : settings;
}
