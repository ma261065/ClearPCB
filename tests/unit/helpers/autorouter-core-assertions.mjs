import assert from 'node:assert/strict';
import {
    insertCopperObstacles,
    padSegmentBlocked,
    segmentToSegmentDist,
    SpatialHash,
} from '../../../src/pcb/modules/autorouter-common.js';

export const TEST_RULES = Object.freeze({
    trackWidth: 0.2,
    clearance: 0.2,
    viaDiameter: 0.6,
    gridStep: 0.5,
});

export function routeInput({ connections, bounds, allObstaclePads = undefined, copperObstacles = undefined }) {
    return {
        ...TEST_RULES,
        bounds,
        connections,
        ...(allObstaclePads ? { allObstaclePads } : {}),
        ...(copperObstacles ? { copperObstacles } : {}),
    };
}

export function pad(x, y, options = {}) {
    return {
        x,
        y,
        width: options.width ?? 1,
        height: options.height ?? options.width ?? 1,
        layer: options.layer ?? 'top',
        shape: options.shape ?? 'rect',
        ...(options.alternates ? { alternates: options.alternates } : {}),
    };
}

export function twoPadConnection(net, from, to) {
    return { net, pads: [from, to] };
}

export function assertPointOnGrid(point, gridStep = TEST_RULES.gridStep) {
    assert.ok(Math.abs(point.x / gridStep - Math.round(point.x / gridStep)) < 1e-9,
        `x=${point.x} is not on the ${gridStep} mm routing grid`);
    assert.ok(Math.abs(point.y / gridStep - Math.round(point.y / gridStep)) < 1e-9,
        `y=${point.y} is not on the ${gridStep} mm routing grid`);
}

export function assertRouteOnGrid(result, gridStep = TEST_RULES.gridStep) {
    for (const track of result.tracks) {
        for (const point of track.points) assertPointOnGrid(point, gridStep);
    }
    for (const via of result.vias || []) assertPointOnGrid(via, gridStep);
}

export function assertRouteInsideBounds(result, bounds) {
    for (const track of result.tracks) {
        for (const point of track.points) {
            assert.ok(point.x >= bounds.minX && point.x <= bounds.maxX,
                `route point x=${point.x} is outside ${bounds.minX}..${bounds.maxX}`);
            assert.ok(point.y >= bounds.minY && point.y <= bounds.maxY,
                `route point y=${point.y} is outside ${bounds.minY}..${bounds.maxY}`);
        }
    }
    for (const via of result.vias || []) {
        assert.ok(via.x >= bounds.minX && via.x <= bounds.maxX,
            `via x=${via.x} is outside ${bounds.minX}..${bounds.maxX}`);
        assert.ok(via.y >= bounds.minY && via.y <= bounds.maxY,
            `via y=${via.y} is outside ${bounds.minY}..${bounds.maxY}`);
    }
}

export function assertRouteConnects(result, net, from, to) {
    const adjacency = new Map();
    const addNode = key => {
        if (!adjacency.has(key)) adjacency.set(key, new Set());
    };
    const addEdge = (a, b) => {
        addNode(a);
        addNode(b);
        adjacency.get(a).add(b);
        adjacency.get(b).add(a);
    };
    const key = (x, y, layer) => `${roundCoord(x)},${roundCoord(y)},${layer}`;

    for (const track of result.tracks.filter(track => track.net === net)) {
        for (let i = 0; i < track.points.length - 1; i++) {
            addEdge(key(track.points[i].x, track.points[i].y, track.layer),
                key(track.points[i + 1].x, track.points[i + 1].y, track.layer));
        }
    }
    for (const via of (result.vias || []).filter(via => !via.net || via.net === net)) {
        addEdge(key(via.x, via.y, 'top'), key(via.x, via.y, 'bottom'));
    }
    for (const track of result.tracks.filter(track => track.net === net)) {
        for (const via of track.vias || []) {
            addEdge(key(via.x, via.y, 'top'), key(via.x, via.y, 'bottom'));
        }
    }

    const startKeys = padLayers(from).map(layer => key(from.x, from.y, layer));
    const endKeys = new Set(padLayers(to).map(layer => key(to.x, to.y, layer)));
    const queue = startKeys.filter(startKey => adjacency.has(startKey));
    const seen = new Set(queue);
    while (queue.length) {
        const current = queue.shift();
        if (endKeys.has(current)) return;
        for (const next of adjacency.get(current) || []) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    assert.fail(`routed tracks for ${net} do not connect (${from.x},${from.y}) to (${to.x},${to.y})`);
}

export function assertTracksAvoidPad(result, obstaclePad, message = 'route clears foreign pad') {
    const obstacle = {
        cx: obstaclePad.x,
        cy: obstaclePad.y,
        hw: obstaclePad.width / 2,
        hh: obstaclePad.height / 2,
        shape: obstaclePad.shape || 'rect',
    };
    const totalClear = TEST_RULES.trackWidth / 2 + TEST_RULES.clearance;
    for (const track of result.tracks) {
        if (!layersOverlap(track.layer, obstaclePad.layer || 'both')) continue;
        for (let i = 0; i < track.points.length - 1; i++) {
            const a = track.points[i], b = track.points[i + 1];
            assert.equal(padSegmentBlocked(a.x, a.y, b.x, b.y, obstacle, totalClear), false, message);
        }
    }
}

export function assertTracksAvoidCopper(result, copperObstacles, message = 'route clears fixed copper') {
    const hash = new SpatialHash(Math.max(TEST_RULES.gridStep * 4, 2.0));
    insertCopperObstacles(hash, copperObstacles);
    const totalClear = TEST_RULES.trackWidth / 2 + TEST_RULES.clearance;
    for (const track of result.tracks) {
        for (let i = 0; i < track.points.length - 1; i++) {
            const a = track.points[i], b = track.points[i + 1];
            assert.equal(hash.isSegmentBlocked(a.x, a.y, b.x, b.y, totalClear, new Set(), track.layer, track.net),
                false, message);
        }
    }
}

export function assertNoForeignTrackClearanceViolations(result) {
    const totalClear = TEST_RULES.trackWidth + TEST_RULES.clearance;
    const segments = [];
    for (const track of result.tracks) {
        for (let i = 0; i < track.points.length - 1; i++) {
            segments.push({ net: track.net, layer: track.layer, a: track.points[i], b: track.points[i + 1] });
        }
    }
    for (let i = 0; i < segments.length; i++) {
        for (let j = i + 1; j < segments.length; j++) {
            const first = segments[i], second = segments[j];
            if (first.net === second.net || first.layer !== second.layer) continue;
            const distance = segmentToSegmentDist(first.a.x, first.a.y, first.b.x, first.b.y,
                second.a.x, second.a.y, second.b.x, second.b.y);
            assert.ok(distance >= totalClear - 1e-9,
                `${first.net} and ${second.net} are ${distance} mm apart on ${first.layer}`);
        }
    }
}

function padLayers(pad) {
    if ((pad.layer || 'top') === 'both') return ['top', 'bottom'];
    return [pad.layer || 'top'];
}

function layersOverlap(a, b) {
    return a === 'both' || b === 'both' || a === b;
}

function roundCoord(value) {
    return Math.round(value * 1e6) / 1e6;
}
