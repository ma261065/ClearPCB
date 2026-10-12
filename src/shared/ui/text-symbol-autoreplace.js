export const TEXT_SYMBOL_AUTOREPLACE = Object.freeze([
    ['(c)', '\u00A9'],
    ['(C)', '\u00A9'],
    ['(r)', '\u00AE'],
    ['(R)', '\u00AE'],
    ['(tm)', '\u2122'],
    ['(TM)', '\u2122'],
    ['(u)', '\u00B5'],
    ['(U)', '\u00B5'],
    ['(o)', '\u03A9'],
    ['(O)', '\u03A9'],
]);

export const TEXT_SYMBOL_OPTIONS = Object.freeze([
    { value: '', label: 'Symbol\u2026' },
    { value: '\u00A9', label: '\u00A9 Copyright' },
    { value: '\u00AE', label: '\u00AE Registered' },
    { value: '\u2122', label: '\u2122 Trademark' },
    { value: '\u00B0', label: '\u00B0 Degree' },
    { value: '\u00B5', label: '\u00B5 Micro' },
    { value: '\u03A9', label: '\u03A9 Ohm' },
    { value: '\u00B1', label: '\u00B1 Plus-minus' },
    { value: '\u00D7', label: '\u00D7 Times' },
    { value: '\u00F7', label: '\u00F7 Divide' },
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
