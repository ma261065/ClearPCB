/**
 * Value Dialog — asks for component value when placing passive components.
 *
 * Shows a compact dialog near the cursor with a text input and a unit
 * dropdown.  Typing shorthand like "10k", "4.7u", "100n" auto-selects
 * the correct multiplier in the dropdown.
 */

import { ModalManager } from '../../core/ModalManager.js';

// ── Unit definitions per reference prefix ─────────────────────────
const UNIT_TABLES = {
    'R': {
        base: 'Ω',
        label: 'Resistance',
        units: [
            { suffix: 'mΩ', mult: 1e-3, aliases: [] },
            { suffix: 'Ω',  mult: 1,    aliases: ['r', 'ohm'] },
            { suffix: 'kΩ', mult: 1e3,  aliases: ['k'] },
            { suffix: 'MΩ', mult: 1e6,  aliases: ['m', 'meg'] },
            { suffix: 'GΩ', mult: 1e9,  aliases: ['g'] },
        ],
        defaultIdx: 2,  // kΩ
    },
    'C': {
        base: 'F',
        label: 'Capacitance',
        units: [
            { suffix: 'pF', mult: 1e-12, aliases: ['p'] },
            { suffix: 'nF', mult: 1e-9,  aliases: ['n'] },
            { suffix: 'µF', mult: 1e-6,  aliases: ['u', 'uf'] },
            { suffix: 'mF', mult: 1e-3,  aliases: [] },
            { suffix: 'F',  mult: 1,     aliases: ['f'] },
        ],
        defaultIdx: 1,  // nF
    },
    'L': {
        base: 'H',
        label: 'Inductance',
        units: [
            { suffix: 'nH', mult: 1e-9,  aliases: ['n'] },
            { suffix: 'µH', mult: 1e-6,  aliases: ['u', 'uh'] },
            { suffix: 'mH', mult: 1e-3,  aliases: ['m'] },
            { suffix: 'H',  mult: 1,     aliases: [] },
        ],
        defaultIdx: 1,  // µH
    },
};

/**
 * Determine which unit table applies to a component definition.
 * Returns null if this component type should not get a value dialog.
 */
function getUnitTable(definition) {
    const ref = (definition.defaultReference || '').replace(/[^A-Z]/gi, '').toUpperCase();
    return UNIT_TABLES[ref] || null;
}

/**
 * Parse a freeform value string like "10k", "4.7u", "100", "2.2M".
 * Returns { number: string, unitIdx: number } or null if unparseable.
 */
function parseValueInput(raw, table) {
    const s = raw.trim();
    if (!s) return null;

    // Try to split into numeric prefix + alpha suffix
    const m = s.match(/^([0-9]*\.?[0-9]+)\s*([a-zA-ZΩµ]*)$/);
    if (!m) return null;

    const numStr = m[1];
    const suffix = m[2].toLowerCase();
    if (!suffix) return { number: numStr, unitIdx: -1 };  // no suffix — keep current dropdown

    // Match suffix against aliases / suffix labels
    for (let i = 0; i < table.units.length; i++) {
        const u = table.units[i];
        const lbl = u.suffix.toLowerCase();
        if (suffix === lbl || u.aliases.includes(suffix)) {
            return { number: numStr, unitIdx: i };
        }
    }
    return { number: numStr, unitIdx: -1 };  // unknown suffix, keep current
}

/**
 * Format the dialog result into a display string like "10kΩ", "100nF".
 */
function formatValue(numStr, unitEntry) {
    // Strip trailing zeros after decimal
    let n = numStr;
    if (n.includes('.')) {
        n = n.replace(/\.?0+$/, '');
    }
    return n + unitEntry.suffix;
}

// ── Dialog lifecycle ──────────────────────────────────────────────

/**
 * Show the value dialog at a screen position.
 * Returns a Promise that resolves to the value string, or null if cancelled.
 *
 * @param {object} definition - Component definition (has defaultReference, defaultValue)
 * @param {number} screenX - Approximate screen X to place dialog near
 * @param {number} screenY - Approximate screen Y to place dialog near
 * @param {object} [opts] - Options
 * @param {string} [opts.currentValue] - Current value to seed (overrides definition.defaultValue)
 * @param {boolean} [opts.allowEscape=false] - Whether Escape dismisses the dialog
 * @returns {Promise<string|null>}
 */
export function showValueDialog(definition, screenX, screenY, opts = {}) {
    const { currentValue, allowEscape = false } = opts;
    const table = getUnitTable(definition);
    if (!table) return Promise.resolve(null);  // not a passive — skip dialog

    return new Promise(resolve => {
        // Parse current or default value to seed input + dropdown
        const defaultVal = currentValue ?? definition.defaultValue ?? '';
        const parsed = parseValueInput(defaultVal, table);
        const seedNum = parsed ? parsed.number : '';
        const seedUnit = (parsed && parsed.unitIdx >= 0) ? parsed.unitIdx : table.defaultIdx;

        // ── Build DOM ─────────────────────────────────────────
        const overlay = document.createElement('div');
        overlay.className = 'value-dialog-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'value-dialog';

        // Position near cursor (keep on screen)
        const posX = Math.min(screenX, window.innerWidth - 260);
        const posY = Math.min(screenY + 10, window.innerHeight - 130);
        dialog.style.left = posX + 'px';
        dialog.style.top = posY + 'px';

        const title = document.createElement('div');
        title.className = 'value-dialog-title';
        title.textContent = table.label;

        const row = document.createElement('div');
        row.className = 'value-dialog-row';

        const input = document.createElement('input');
        input.className = 'value-dialog-input';
        input.type = 'text';
        input.placeholder = 'Value';
        input.value = seedNum;
        input.setAttribute('autocomplete', 'off');

        const select = document.createElement('select');
        select.className = 'value-dialog-select';
        for (let i = 0; i < table.units.length; i++) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = table.units[i].suffix;
            select.appendChild(opt);
        }
        select.value = String(seedUnit);

        row.appendChild(input);
        row.appendChild(select);

        const buttons = document.createElement('div');
        buttons.className = 'value-dialog-buttons';

        const okBtn = document.createElement('button');
        okBtn.className = 'value-dialog-btn primary';
        okBtn.textContent = 'OK';

        buttons.appendChild(okBtn);

        dialog.appendChild(title);
        dialog.appendChild(row);
        dialog.appendChild(buttons);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // ── Auto-detect units as user types ───────────────────
        let lastNumeric = seedNum;  // track last valid numeric content

        input.addEventListener('input', () => {
            const p = parseValueInput(input.value, table);
            if (p && p.unitIdx >= 0) {
                select.value = String(p.unitIdx);
                lastNumeric = p.number;
                input.value = p.number;
                input.setSelectionRange(p.number.length, p.number.length);
            } else {
                // Strip any non-numeric characters (letters that didn't match a unit)
                const cleaned = input.value.replace(/[^0-9.]/g, '');
                if (cleaned !== input.value) {
                    // If input was purely a suffix (no digits), check for unit match
                    // and restore the previous number (handles select-all then type "p")
                    const pureAlpha = input.value.trim().replace(/[0-9.]/g, '').toLowerCase();
                    if (!cleaned && pureAlpha) {
                        for (let i = 0; i < table.units.length; i++) {
                            const u = table.units[i];
                            if (u.suffix.toLowerCase() === pureAlpha || u.aliases.includes(pureAlpha)) {
                                select.value = String(i);
                                input.value = lastNumeric;
                                input.setSelectionRange(lastNumeric.length, lastNumeric.length);
                                return;
                            }
                        }
                    }
                    const pos = Math.max(0, input.selectionStart - (input.value.length - cleaned.length));
                    input.value = cleaned;
                    input.setSelectionRange(pos, pos);
                }
                if (cleaned) lastNumeric = cleaned;
            }
        });

        // ── Confirm ────────────────────────────────────────────
        function confirm() {
            const raw = input.value.trim();
            // Re-parse in case user typed a full value with suffix
            const p = parseValueInput(raw, table);
            let numStr, unitIdx;
            if (p) {
                numStr = p.number;
                unitIdx = p.unitIdx >= 0 ? p.unitIdx : parseInt(select.value, 10);
            } else {
                numStr = raw || seedNum;
                unitIdx = parseInt(select.value, 10);
            }
            ModalManager.pop('valueDialog');
            overlay.remove();
            if (!numStr) {
                resolve(defaultVal || null);
            } else {
                resolve(formatValue(numStr, table.units[unitIdx]));
            }
        }

        okBtn.addEventListener('click', confirm);

        function dismiss() {
            ModalManager.pop('valueDialog');
            overlay.remove();
            resolve(null);
        }

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirm();
            } else if (e.key === 'Escape' && allowEscape) {
                e.preventDefault();
                dismiss();
            }
            e.stopPropagation();   // don't let app shortcuts fire
        });

        // Stop all keydown propagation from dialog elements
        select.addEventListener('keydown', (e) => e.stopPropagation());
        overlay.addEventListener('keydown', (e) => e.stopPropagation());

        ModalManager.push('valueDialog', allowEscape ? dismiss : () => {});

        // Focus + select all after a tick so the dialog is rendered
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    });
}

/**
 * Returns true if the component definition should show a value dialog.
 */
export function needsValueDialog(definition) {
    return getUnitTable(definition) !== null;
}
