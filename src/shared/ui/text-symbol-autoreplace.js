/**
 * Single source of truth for insertable text symbols. `shortcut` drives both
 * the typed `(x)` autoreplacement and the label shown in the Insert dropdown,
 * so the advertised shortcut always matches the one that actually fires.
 * Every `char` also needs a PCB stroke glyph in `shared/pcb/stroke-font-extras.js`.
 * @type {ReadonlyArray<{char:string, name:string, shortcut?:string}>}
 */
export const TEXT_SYMBOLS = Object.freeze([
    { char: '\u00A9', name: 'Copyright', shortcut: 'c' },
    { char: '\u00AE', name: 'Registered', shortcut: 'r' },
    { char: '\u2122', name: 'Trademark', shortcut: 'tm' },
    { char: '\u00B0', name: 'Degree' },
    { char: '\u00B5', name: 'Micro', shortcut: 'u' },
    { char: '\u03A9', name: 'Ohm', shortcut: 'o' },
    { char: '\u20AC', name: 'Euro', shortcut: 'E' },
    { char: '\u00A3', name: 'Pound', shortcut: 'L' },
    { char: '\u00A5', name: 'Yen', shortcut: 'Y' },
    { char: '\u00B1', name: 'Plus-minus' },
    { char: '\u00D7', name: 'Times' },
    { char: '\u00F7', name: 'Divide' },
]);

/** Typed tokens accept either case, so `(e)` and `(E)` both insert €. */
export const TEXT_SYMBOL_AUTOREPLACE = Object.freeze(TEXT_SYMBOLS.flatMap(({ char, shortcut }) =>
    (shortcut ? [...new Set([shortcut.toLowerCase(), shortcut.toUpperCase()])] : [])
        .map(token => /** @type {[string, string]} */ ([`(${token})`, char]))));

export const TEXT_SYMBOL_OPTIONS = Object.freeze([
    { value: '', label: 'Symbol\u2026' },
    ...TEXT_SYMBOLS.map(({ char, name, shortcut }) => ({
        value: char,
        label: shortcut ? `${char} ${name} (${shortcut})` : `${char} ${name}`,
    })),
]);

/**
 * Shared Properties field for inserting symbols into an active text edit.
 * @param {{id:string,disabled?:boolean,insert:(symbol:string)=>void}} options
 * @returns {import('./property-fields.js').PropertyField}
 */
export function textSymbolPickerField({ id, disabled = false, insert }) {
    return {
        key: 'insert',
        id,
        type: 'select',
        label: 'Insert',
        value: '',
        disabled,
        options: [...TEXT_SYMBOL_OPTIONS],
        commit: /** @param {string} symbol */ symbol => {
            if (symbol && !disabled) insert(symbol);
        },
    };
}

/**
 * Find a symbol token ending at the caret.
 * @param {string} text
 * @param {number} caret
 * @returns {{start:number,end:number,text:string}|null}
 */
export function textSymbolReplacementAtCaret(text, caret) {
    for (const [from, to] of TEXT_SYMBOL_AUTOREPLACE) {
        if (caret >= from.length && text.slice(caret - from.length, caret) === from) {
            return { start: caret - from.length, end: caret, text: to };
        }
    }
    return null;
}
