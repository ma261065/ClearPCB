export const PANEL_DEFAULTS = Object.freeze({
    rows: 2, columns: 2, rowSpacing: 2, columnSpacing: 2,
    separation: 'tabs', railTop: 5, railBottom: 5, railLeft: 0, railRight: 0,
    tabWidth: 3, holeDiameter: 0.5, holePitch: 0.8,
    verticalTabsPerEdge: 2, horizontalTabsPerEdge: 2, verticalTabOffset: 0, horizontalTabOffset: 0,
    horizontalPositioningHoles: false, horizontalFiducials: false,
    verticalPositioningHoles: false, verticalFiducials: false,
});

export function panelSettings(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid panel settings.');
    const settings = { ...PANEL_DEFAULTS };
    for (const key of Object.keys(settings)) {
        if (value[key] !== undefined) settings[key] = value[key];
    }
    for (const key of ['rows', 'columns']) {
        if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 20) {
            throw new Error('Rows and columns must be whole numbers from 1 to 20.');
        }
    }
    if (settings.rows * settings.columns > 100) throw new Error('A panel can contain at most 100 boards.');
    for (const key of ['verticalTabsPerEdge', 'horizontalTabsPerEdge']) {
        if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 20) {
            throw new Error('Tabs per edge must be a whole number from 1 to 20.');
        }
    }
    for (const key of ['verticalTabOffset', 'horizontalTabOffset']) {
        if (!Number.isFinite(settings[key]) || Math.abs(settings[key]) > 100) {
            throw new Error('Tab offsets must be between -100 and 100 mm.');
        }
    }
    for (const key of ['rowSpacing', 'columnSpacing', 'railTop', 'railBottom', 'railLeft', 'railRight']) {
        if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 100) {
            throw new Error('Spacing and rail widths must be between 0 and 100 mm.');
        }
    }
    if (!['tabs', 'vcut'].includes(settings.separation)) throw new Error('Unknown panel separation method.');
    for (const key of ['horizontalPositioningHoles', 'horizontalFiducials', 'verticalPositioningHoles', 'verticalFiducials']) {
        if (typeof settings[key] !== 'boolean') throw new Error('Rail feature options must be boolean values.');
    }
    for (const key of ['tabWidth', 'holeDiameter', 'holePitch']) {
        if (!Number.isFinite(settings[key]) || settings[key] <= 0 || settings[key] > 20) {
            throw new Error('Tab and drill dimensions must be greater than zero and at most 20 mm.');
        }
    }
    if (settings.holePitch <= settings.holeDiameter) throw new Error('Hole pitch must exceed hole diameter.');
    if (settings.tabWidth < settings.holePitch * 2) throw new Error('Tabs must be at least two hole pitches wide.');
    return value.noteCreated === true ? { ...settings, noteCreated: true } : settings;
}
