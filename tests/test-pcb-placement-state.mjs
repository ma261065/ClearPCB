import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { PcbPlacementState } from '../src/core/PcbPlacementState.js';

assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
const project = new ProjectDocument();
const state = project.pcbPlacementState;
const overrides = state.overrides;
const artwork = {};
artwork.self = artwork;
const placement = { x: Math.PI, y: -1 / 3, rotation: 37, locked: true, mirror: true,
    side: 'bottom', refVisible: false, refDx: 2.345678, refDy: -4.567891, refRot: -90,
    refSize: 1.234567, refStrokeWidth: 0.234567, element: artwork, pads: new Map(), reference: 'R1' };
state.record('part', placement);
assert.notEqual(overrides.get('part'), placement, 'Saved state does not retain the generated placement');
assert.equal(overrides.get('part').x, Math.PI, 'Recording never rounds live geometry');
assert.equal(overrides.get('part').refRot, 270);
const saved = state.serialize();
assert.deepEqual(saved, { part: {
    x: 3.1416, y: -0.3333, rotation: 37, locked: true, mirror: true, side: 'bottom',
    refVisible: false, refDx: 2.3457, refDy: -4.5679, refRot: 270,
    refSize: 1.2346, refStrokeWidth: 0.2346,
} }, 'Persistence keeps existing precision/fields and excludes artwork, pads and schematic references');
assert.doesNotThrow(() => JSON.stringify(saved));
assert.equal(overrides.get('part').x, Math.PI, 'Serialization never rounds the live model');
const reloaded = new PcbPlacementState();
reloaded.load(saved);
assert.deepEqual(reloaded.serialize(), saved);
saved.part.x = 99;
placement.x = 88;
assert.equal(overrides.get('part').x, Math.PI, 'Neither generated artwork nor serialized copies alias saved state');
assert.equal(reloaded.overrides.get('part').x, 3.1416);
state.load({ minimal: { x: '2.5', y: '-3', refRot: '-450' }, skipped: null });
assert.equal(state.overrides, overrides, 'Loading preserves the map used by the editor');
assert.equal(overrides.has('part'), false);
assert.equal(overrides.has('skipped'), false);
assert.deepEqual(overrides.get('minimal'), {
    x: 2.5, y: -3, rotation: 0, locked: false, mirror: false, side: 'top',
    refVisible: true, refDx: 0, refDy: 0, refRot: 270, refSize: 0.9, refStrokeWidth: 0.15,
});
state.record('default', { x: 0, y: 0 });
assert.deepEqual(state.serialize().default, { x: 0, y: 0, rotation: 0 },
    'Default reference styling/visibility is omitted from the saved file');
state.load(null);
assert.equal(state.overrides, overrides);
assert.equal(overrides.size, 0, 'Clearing the saved state does not replace its map');
assert.equal(new ProjectDocument().pcbPlacementState.overrides.size, 0, 'Projects have independent placement state');
console.log('PASS DOM-free project placement state, metadata isolation, legacy defaults, precision and reload identity');
