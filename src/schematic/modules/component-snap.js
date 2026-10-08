/**
 * Where a component being placed or dragged lands: its pins snap onto wire ends and other
 * pins, and the grid otherwise.
 */
import { resolveWireSnapPosition, PIN_SNAP_TOL } from './wire-snap.js';
import { getSchematicDrag } from './drag.js';
import { getPlacingComponent } from './components.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../core/geometry.js').Point} Point */
/** @typedef {import('./wire-snap.js').ComponentPin} ComponentPin */
/** @typedef {import('./wire-snap.js').PinIdentity} PinIdentity */
/** @typedef {ReturnType<typeof resolveWireSnapPosition>} WireSnapResult */
/** @typedef {{excludePin?: PinIdentity|null, pinTolerance?: number, wireTolerance?: number}} PinSnapOptions */
/** @typedef {{pin?: ComponentPin, pinWorld: Point, resolved: WireSnapResult, distance: number}} ComponentSnapCandidate */

/**
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {PinSnapOptions} [options]
 */
export function resolvePinSnapPlacement(app, worldPos, options = {}) {
    const resolved = resolveWireSnapPosition(app, worldPos, {
        pinTolerance: PIN_SNAP_TOL,
        ...options
    });
    return { resolved, pos: { x: resolved.x, y: resolved.y } };
}

/**
 * @param {ComponentPin|null|undefined} pin
 * @returns {string|number|null}
 */
function getPinIdentityKey(pin) {
    return pin?._key || pin?._id || pin?.number || null;
}

/**
 * @param {ComponentPin|null|undefined} pin
 * @param {number} baseX
 * @param {number} baseY
 * @param {number} rotationDeg
 * @param {boolean} mirror
 * @returns {Point}
 */
function getPinWorldWithTransform(pin, baseX, baseY, rotationDeg, mirror) {
    const lx = Number(pin?.x) || 0;
    const ly = Number(pin?.y) || 0;
    const mx = mirror ? -lx : lx;
    const rad = (rotationDeg || 0) * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        x: baseX + (mx * cos - ly * sin),
        y: baseY + (mx * sin + ly * cos)
    };
}

/**
 * @param {SchematicEditor} app
 * @param {Point} placePos
 */
export function resolvePlacingComponentSnap(app, placePos) {
    const def = getPlacingComponent(app);
    if (!def?.symbol?.pins?.length) return { placePos, pinSnap: null };

    const rotation = app.componentRotation || 0;
    const mirror = !!app.componentMirror;
    /** @type {ComponentSnapCandidate|null} */
    let best = null;

    for (const pin of /** @type {ComponentPin[]} */ (def.symbol.pins)) {
        const pinWorld = getPinWorldWithTransform(pin, placePos.x, placePos.y, rotation, mirror);
        const { resolved } = resolvePinSnapPlacement(app, pinWorld);
        if (!resolved || resolved.snapType === 'grid') continue;
        const d = Math.hypot(resolved.x - pinWorld.x, resolved.y - pinWorld.y);
        if (!best || d < best.distance) {
            best = { pinWorld, resolved, distance: d };
        }
    }

    if (!best) return { placePos, pinSnap: null };

    return {
        placePos: {
            x: placePos.x + (best.resolved.x - best.pinWorld.x),
            y: placePos.y + (best.resolved.y - best.pinWorld.y)
        },
        pinSnap: best.resolved
    };
}

/**
 * @param {SchematicEditor} app
 * @param {Component} comp
 * @param {Point} snappedTarget
 * @param {Point} lastSnapped
 */
export function resolveDraggingComponentSnap(app, comp, snappedTarget, lastSnapped) {
    const pins = /** @type {ComponentPin[]} */ (comp.symbol?.pins || []);
    if (pins.length === 0) return { targetPos: snappedTarget, pinSnap: null };

    const SNAP_LOCK_ENGAGE_DISTANCE = 0.55;
    const SNAP_LOCK_RELEASE_DISTANCE = 0.9;

    const previewDx = snappedTarget.x - lastSnapped.x;
    const previewDy = snappedTarget.y - lastSnapped.y;
    const projectedX = comp.x + previewDx;
    const projectedY = comp.y + previewDy;

    if (!getSchematicDrag(app)._componentSnapState || getSchematicDrag(app)._componentSnapState.componentId !== comp.id) {
        getSchematicDrag(app)._componentSnapState = {
            componentId: comp.id,
            lockedPinKey: null,
            lastResult: null
        };
    }
    const snapState = getSchematicDrag(app)._componentSnapState;

    /** @param {ComponentPin} pin @returns {ComponentSnapCandidate|null} */
    const evaluatePin = (pin) => {
        const pinWorld = getPinWorldWithTransform(pin, projectedX, projectedY, comp.rotation || 0, !!comp.mirror);
        const { resolved } = resolvePinSnapPlacement(app, pinWorld, {
            excludePin: {
                component: comp,
                pin,
                pinKey: getPinIdentityKey(pin)
            }
        });
        if (!resolved || resolved.snapType === 'grid') return null;
        const distance = Math.hypot(resolved.x - pinWorld.x, resolved.y - pinWorld.y);
        return { pin, pinWorld, resolved, distance };
    };

    /** @param {ComponentSnapCandidate|null} candidate */
    const makeResult = (candidate) => {
        if (!candidate) return { targetPos: snappedTarget, pinSnap: null };
        return {
            targetPos: {
                x: snappedTarget.x + (candidate.resolved.x - candidate.pinWorld.x),
                y: snappedTarget.y + (candidate.resolved.y - candidate.pinWorld.y)
            },
            pinSnap: candidate.resolved
        };
    };

    // Keep a stable snap owner while it remains valid to prevent yellow-dot flicker.
    if (snapState.lockedPinKey) {
        const lockedPin = pins.find(pin => getPinIdentityKey(pin) === snapState.lockedPinKey) || null;
        if (lockedPin) {
            const lockedCandidate = evaluatePin(lockedPin);
            if (lockedCandidate && lockedCandidate.distance <= SNAP_LOCK_RELEASE_DISTANCE) {
                const lockedResult = makeResult(lockedCandidate);
                snapState.lastResult = lockedResult;
                return lockedResult;
            }
        }
        snapState.lockedPinKey = null;
    }

    /** @type {ComponentSnapCandidate|null} */
    let best = null;
    for (const pin of pins) {
        const candidate = evaluatePin(pin);
        if (!candidate) continue;
        if (!best || candidate.distance < best.distance) best = candidate;
    }

    if (!best) {
        const empty = { targetPos: snappedTarget, pinSnap: null };
        snapState.lastResult = empty;
        return empty;
    }

    // Avoid snap/no-snap chatter at boundary distances while dragging slowly.
    if (best.distance > SNAP_LOCK_ENGAGE_DISTANCE) {
        const empty = { targetPos: snappedTarget, pinSnap: null };
        snapState.lastResult = empty;
        return empty;
    }

    snapState.lockedPinKey = getPinIdentityKey(best.pin);
    const result = makeResult(best);
    snapState.lastResult = result;
    return result;
}
