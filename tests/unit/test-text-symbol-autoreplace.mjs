import assert from 'node:assert/strict';
import { textSymbolReplacementAtCaret } from '../../src/shared/ui/text-symbol-autoreplace.js';

assert.deepEqual(textSymbolReplacementAtCaret('label (c)', 9), { start: 6, end: 9, text: '©' });
assert.deepEqual(textSymbolReplacementAtCaret('(R)', 3), { start: 0, end: 3, text: '®' });
assert.deepEqual(textSymbolReplacementAtCaret('x(TM)y', 5), { start: 1, end: 5, text: '™' });
assert.deepEqual(textSymbolReplacementAtCaret('(u)', 3), { start: 0, end: 3, text: 'µ' });
assert.deepEqual(textSymbolReplacementAtCaret('(O)', 3), { start: 0, end: 3, text: 'Ω' });
assert.equal(textSymbolReplacementAtCaret('(tm)', 3), null, 'replacement waits until the closing parenthesis');
assert.equal(textSymbolReplacementAtCaret('plain', 5), null);

console.log('PASS shared PCB/schematic text symbol autoreplacement');
