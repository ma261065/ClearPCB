import assert from 'node:assert/strict';
import { Text } from '../../src/shapes/text.js';
import { Wire } from '../../src/shapes/wire.js';
import { createRect, createLine } from '../../src/shapes/polyline.js';
import { distanceToSegment } from '../../src/core/geometry.js';
import { arcFromBulge } from '../../src/shapes/arc-edge.js';
import { attachLabelToTarget, getLabelAttachmentAnchorPoint } from '../../src/schematic/modules/label-attachment.js';

for (const shape of [
    createRect({ x: 0, y: 0, width: 20, height: 20, cornerRadius: 5 }),
    createLine({ points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] }),
    new Wire({ points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] }),
]) {
    if (shape.type === 'wire' || !shape.closed) shape.setEdgeAttr([...shape.edges.keys()][0], 'bulge', 0.5);
    const arcMidpoint = arcFromBulge({ x: 0, y: 0 }, { x: 20, y: 0 }, 0.5).bulgePoint;
    const probe = shape.closed ? { x: -5, y: -5 } : { x: arcMidpoint.x, y: arcMidpoint.y * 3 };
    const text = new Text({ ...probe, text: 'Curve annotation' });
    attachLabelToTarget(text, shape);
    const anchor = getLabelAttachmentAnchorPoint(text, probe);
    assert.ok(anchor);
    assert.ok(shape._strokeSegments().some(segment =>
        distanceToSegment(anchor, segment.start, segment.end) < 1e-8),
    'the guide terminates on the rendered curved path');
    if (shape.closed) {
        assert.ok(anchor.x > 0 && anchor.y > 0, 'a rounded corner does not target the removed square corner');
    } else {
        assert.ok(Math.abs(anchor.y) > 1, 'an arc guide does not target its invisible chord');
    }
}
console.log('PASS text attachment guides follow arc strokes and rounded corners instead of invisible chords');
