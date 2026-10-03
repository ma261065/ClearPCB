import assert from 'node:assert/strict';

globalThis.window ??= { addEventListener() {} };
const { isExactNameMatch, pickerResultNames } = await import('../src/components/ComponentPicker.js');

assert.equal(isExactNameMatch('C46749', ['NE555P', 'C46749']), true, 'an LCSC part number matches exactly');
assert.equal(isExactNameMatch('C46749', ['NE555P', 'C467490']), false, 'a longer part sharing the prefix does not match');
assert.equal(isExactNameMatch(' ne555p ', ['NE555P']), true, 'case and surrounding spaces are ignored');
assert.equal(isExactNameMatch('NE555', ['NE555P', 'NE555DR']), false, 'a prefix of the name is not an exact match');
assert.equal(isExactNameMatch('', ['']), false, 'an empty query matches nothing');
assert.equal(isExactNameMatch('R', [null, undefined, 'R']), true, 'missing names are skipped');

const online = [
    { mpn: 'NE555P', lcscPartNumber: 'C46749' },
    { mpn: 'NE555PWR', lcscPartNumber: 'C467490' },
    { lcscPartNumber: 'C4674' },
];
assert.deepEqual(online.filter(item => isExactNameMatch('c46749', pickerResultNames.online(item))), [online[0]],
    'online results match on part number');
assert.deepEqual(online.filter(item => isExactNameMatch('NE555P', pickerResultNames.online(item))), [online[0]],
    'online results match on manufacturer part number');
assert.deepEqual(pickerResultNames.kicad({ name: 'NE555P', library: 'Timer' }), ['NE555P']);
assert.deepEqual(pickerResultNames.local({ name: 'Resistor', description: 'R' }), ['Resistor']);

console.log('PASS component picker exact match: part number / MPN / name equality, case-insensitive, prefixes excluded');
