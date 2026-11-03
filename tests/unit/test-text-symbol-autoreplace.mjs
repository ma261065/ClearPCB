import assert from 'node:assert/strict';
import { textSymbolReplacementAtCaret, TEXT_SYMBOLS, TEXT_SYMBOL_OPTIONS } from '../../src/shared/ui/text-symbol-autoreplace.js';
import { GLYPHS } from '../../src/shared/pcb/stroke-font.js';

assert.deepEqual(textSymbolReplacementAtCaret('label (c)', 9), { start: 6, end: 9, text: '©' });
assert.deepEqual(textSymbolReplacementAtCaret('(R)', 3), { start: 0, end: 3, text: '®' });
assert.deepEqual(textSymbolReplacementAtCaret('x(TM)y', 5), { start: 1, end: 5, text: '™' });
assert.deepEqual(textSymbolReplacementAtCaret('(u)', 3), { start: 0, end: 3, text: 'µ' });
assert.deepEqual(textSymbolReplacementAtCaret('(O)', 3), { start: 0, end: 3, text: 'Ω' });
assert.equal(textSymbolReplacementAtCaret('(tm)', 3), null, 'replacement waits until the closing parenthesis');
assert.equal(textSymbolReplacementAtCaret('plain', 5), null);

assert.deepEqual(textSymbolReplacementAtCaret('(E)', 3), { start: 0, end: 3, text: '€' });
assert.deepEqual(textSymbolReplacementAtCaret('(L)', 3), { start: 0, end: 3, text: '£' });
assert.deepEqual(textSymbolReplacementAtCaret('(Y)', 3), { start: 0, end: 3, text: '¥' });
assert.deepEqual(textSymbolReplacementAtCaret('5 (e)', 5), { start: 2, end: 5, text: '€' },
    'currency shortcuts accept either case like the existing tokens');
assert.deepEqual(textSymbolReplacementAtCaret('(l)', 3), { start: 0, end: 3, text: '£' });
assert.deepEqual(textSymbolReplacementAtCaret('(y)', 3), { start: 0, end: 3, text: '¥' });

const labels = new Map(TEXT_SYMBOL_OPTIONS.map(option => [option.value, option.label]));
assert.equal(labels.get('€'), '€ Euro (E)');
assert.equal(labels.get('£'), '£ Pound (L)');
assert.equal(labels.get('¥'), '¥ Yen (Y)');
assert.equal(labels.get('©'), '© Copyright (c)', 'existing symbols advertise their shortcut too');
assert.equal(labels.get('°'), '° Degree', 'symbols without a shortcut stay unadorned');

for (const { char, name, shortcut } of TEXT_SYMBOLS) {
    assert.ok(GLYPHS[char], `${name} needs a PCB stroke glyph`);
    if (!shortcut) continue;
    const token = `(${shortcut})`;
    assert.deepEqual(textSymbolReplacementAtCaret(token, token.length),
        { start: 0, end: token.length, text: char }, `${name} shortcut ${token} inserts its symbol`);
}

console.log('PASS shared PCB/schematic text symbol autoreplacement');
