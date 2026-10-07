import assert from 'node:assert/strict';
import * as THREE from '../../assets/vendor/three.module.js';

globalThis.window = { addEventListener() {} };
globalThis.localStorage = { getItem() { return null; }, removeItem() {} };
globalThis.document = { body: { contains() { return false; } } };
const { updateBoardCameraClipping } = await import('../../src/pcb/modules/board3d.js');

// Bounds and chip height reproduced from 3ddebug.cpcb; no supplier mesh is needed.
const bounds = new THREE.Box3(
    new THREE.Vector3(0, -1.6, -70.245),
    new THREE.Vector3(90.498, 10.14, 0),
);
const target = new THREE.Vector3(46, 1.6, -23);
const chip = new THREE.Vector3(46, 2.6483, -23);
const maskBias = 52;

function boardDepthGap(camera, modelPoint, boardY, depthBits) {
    const ray = modelPoint.clone().sub(camera.position);
    const distance = (boardY - camera.position.y) / ray.y;
    const boardPoint = camera.position.clone().addScaledVector(ray, distance);
    return (boardPoint.project(camera).z - modelPoint.clone().project(camera).z)
        / 2 * (2 ** depthBits - 1);
}

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
const tilt = 50 * Math.PI / 180, yaw = 220 * Math.PI / 180;
camera.position.copy(target).addScaledVector(new THREE.Vector3(
    Math.sin(tilt) * Math.cos(yaw), Math.cos(tilt), Math.sin(tilt) * Math.sin(yaw),
), 55);
camera.lookAt(target);
assert.ok(bounds.distanceToPoint(camera.position) > 20, 'Camera is well outside the scene');
updateBoardCameraClipping(camera, bounds, 16);
assert.ok(camera.near > 1, 'Off-screen corners behind the eye must not collapse depth precision');
assert.ok(boardDepthGap(camera, chip, 1.6, 16) > maskBias * 2,
    'Mask cannot punch through the chip when the depth buffer has 16 bits');

const samples = [];
for (const axis of ['x', 'y', 'z']) {
    for (const edge of [bounds.min[axis], bounds.max[axis]]) {
        const other = ['x', 'y', 'z'].filter(key => key !== axis);
        for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
            const point = new THREE.Vector3();
            point[axis] = edge;
            point[other[0]] = bounds.min[other[0]] + (bounds.max[other[0]] - bounds.min[other[0]]) * i / 8;
            point[other[1]] = bounds.min[other[1]] + (bounds.max[other[1]] - bounds.min[other[1]]) * j / 8;
            samples.push(point);
        }
    }
}
let views = 0;
for (const depthBits of [16, 24, 32]) for (const aspect of [0.5, 1, 2]) {
    for (const distance of [20, 40, 55, 80, 200]) for (const angle of [0, 30, 50, 70]) {
        for (const azimuth of [0, 90, 220]) for (const side of [1, -1]) {
            const boardY = side > 0 ? 1.6 : 0;
            const focus = new THREE.Vector3(46, boardY, -23);
            const point = new THREE.Vector3(46, boardY + side * 1.0483, -23);
            const tilt = angle * Math.PI / 180, yaw = azimuth * Math.PI / 180;
            const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 20000);
            camera.position.copy(focus).addScaledVector(new THREE.Vector3(
                Math.sin(tilt) * Math.cos(yaw), side * Math.cos(tilt), Math.sin(tilt) * Math.sin(yaw),
            ), distance);
            camera.lookAt(focus);
            const position = camera.position.toArray(), orientation = camera.quaternion.toArray();
            updateBoardCameraClipping(camera, bounds, depthBits);
            assert.deepEqual(camera.position.toArray(), position);
            assert.deepEqual(camera.quaternion.toArray(), orientation);
            for (const sample of samples) {
                const depth = -sample.clone().applyMatrix4(camera.matrixWorldInverse).z;
                if (depth <= 0) continue;
                const projected = sample.clone().project(camera);
                if (Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1) {
                    assert.ok(depth > camera.near && depth < camera.far, 'Visible geometry is not clipped');
                }
            }
            if (bounds.distanceToPoint(camera.position) > 5) {
                assert.ok(boardDepthGap(camera, point, boardY, depthBits) > maskBias * 2,
                    `Component occlusion: ${depthBits} bits, aspect ${aspect}, ${distance} mm, ${angle}/${azimuth}, side ${side}`);
            }
            views++;
        }
    }
}

camera.position.set(46, 5, -23);
camera.lookAt(65, 5, -23);
updateBoardCameraClipping(camera, bounds);
assert.equal(camera.near, 0.01, 'Inside the bounds retains conservative near clipping');
console.log(`PASS: chip/mask depth separation and visible geometry across ${views} camera configurations`);
