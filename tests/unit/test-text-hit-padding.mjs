import assert from 'node:assert/strict';
import { Text, setTextMeasurer } from '../../src/shapes/text.js';
import { SelectionManager } from '../../src/core/SelectionManager.js';

setTextMeasurer(() => ({ x: 10, y: 18, width: 8, height: 2 }));
for (const rotation of [0, 90, 180, 270]) {
    for (const scale of [1, 10, 100]) {
        const text = new Text({ x: 10, y: 20, fontSize: 2, text: 'Text', rotation, border: true });
        const selection = new SelectionManager({ getScale: () => scale });
        selection.setShapes([text]);
        const radians = rotation * Math.PI / 180;
        const point = (x, y) => ({
            x: 10 + (x - 10) * Math.cos(radians) - (y - 20) * Math.sin(radians),
            y: 20 + (x - 10) * Math.sin(radians) + (y - 20) * Math.cos(radians),
        });
        assert.equal(selection.hitTest(point(14, 19)), text, 'text interior remains selectable');
        assert.equal(selection.hitTest(point(18.1, 19)), text, 'a small edge allowance remains');
        assert.equal(selection.hitTest(point(18.3, 19)), null, 'outside the small allowance is not selectable');
        assert.equal(selection.hitTest(point(14, 17.7)), null, 'padding does not expand above text');
        assert.equal(selection.hitTest(point(14, 20.3)), null, 'padding does not expand below text');
        assert.equal(text.hitTestAnchor(point(9, 20), scale), null,
            'the invisible text origin does not create a grab area left of the text');
        assert.equal(text.hitTestAnchor(point(10, 21), scale), null,
            'the invisible text origin does not create a grab area below the text');
    }
}
setTextMeasurer(null);
console.log('PASS text hit padding stays close to its bounds at every zoom and quarter-turn orientation');
