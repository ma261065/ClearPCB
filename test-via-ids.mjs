/** Headless regression tests for unique Via IDs after loading. */

const { Via, resetViaIdCounter } = await import('./src/shapes/via.js');

let failures = 0;

function expect(name, condition) {
    if (condition) console.log(`PASS: ${name}`);
    else {
        failures++;
        console.error(`FAIL: ${name}`);
    }
}

resetViaIdCounter();
const loaded = Via.fromJSON({ id: 'via_8', x: 1, y: 2, d: 0.6, dr: 0.3 });
const createdAfterLoad = new Via({ x: 3, y: 4 });

expect('loaded Via retains its persisted ID', loaded.id === 'via_8');
expect('new Via does not reuse a loaded ID', createdAfterLoad.id === 'via_9');

if (failures) process.exitCode = 1;