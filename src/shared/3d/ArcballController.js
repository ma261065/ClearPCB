import * as THREE from '../../../assets/vendor/three.module.js';

export class ArcballController {
    /**
     * @param {any} camera THREE.PerspectiveCamera
     * @param {HTMLElement} domElement
     */
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.target = new THREE.Vector3();

        this.rotateSpeed = 1.0;
        this.zoomSpeed = 1.0;
        this.panSpeed = 1.0;
        this.minDistance = 1;
        this.maxDistance = Infinity;
        this.enabled = true;

        // Solid-geometry keep-out volume (set via setBounds). The camera is
        // never allowed inside it, so panning/zooming can't punch through the
        // board slab or dive into a component — update() pushes the camera back
        // out to the nearest face each frame. `minDistance` alone can't prevent
        // this because it only limits distance-to-target, and panning moves the
        // whole rig (camera + target) together.
        /** @type {any} */
        this.boundingBox = null;

        /** @type {Record<string, Array<() => void>>} */
        this._listeners = { start: [], end: [], change: [] };

        // The vendored three.js bundle is tree-shaken and does NOT export
        // `Quaternion` (or `Vector2`); only the camera's own `.quaternion`
        // instance is reachable. Clone it to mint fresh, identity quaternions.
        this._newQuat = () => camera.quaternion.clone().identity();

        // Rotation state. `_q0` is the camera orientation at mouse-down; the
        // live orientation while dragging is `_q0 · delta`, where `delta` is the
        // single arcball rotation from the current sphere-point to the anchor.
        this._q0 = this._newQuat();             // camera orientation at drag start
        this._anchor = new THREE.Vector3();     // sphere point under mouse-down

        this._mode = 0; // 0 none, 1 rotate, 2 pan
        this._rect = domElement.getBoundingClientRect();
        this._panStartX = 0;
        this._panStartY = 0;
        this._panDepth = 0;
        /** @type {THREE.Vector3|null} World point grabbed on the pan plane. */
        this._panGrab = null;
        // Stable world-space Y plane used to estimate pan depth under cursor.
        // Keep this fixed to the board slab (set from ThreeScene) so repeated
        // panning cannot drag the depth reference away from the board.
        this._panPlaneY = 0;
        this._needsUpdate = false;

        // ── Smoothing / inertia ──────────────────────────────────────────────
        // Rotation momentum: a flick-and-release keeps the board coasting along
        // the same arc and eases out, instead of stopping dead.
        // Disabled — rotation stops immediately on release.
        this.enableDamping = false;
        this.dampingFactor = 0.9;            // spin velocity retained per frame
        this._spinAxis = new THREE.Vector3(0, 1, 0); // world axis of the coast
        this._spinVel = 0;                   // radians per frame
        this._spinning = false;
        this._qPrev = this._newQuat();       // orientation last rotate frame
        // Eased zoom-to-cursor: the wheel sets a goal camera/target pair and
        // update() glides the live rig toward it, scaling about the world point
        // under the cursor so that point stays pinned on screen.
        this.zoomDamping = 0.22;             // fraction of the gap closed/frame
        /** @type {THREE.Vector3|null} */
        this._zoomGoalCam = null;
        /** @type {THREE.Vector3|null} */
        this._zoomGoalTarget = null;

        // The viewer lives in a pop-up window, so listen on *that* window — the
        // module-global `window` is the opener and would never see the events.
        this._win = domElement.ownerDocument?.defaultView || window;

        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        this._onWheel = this._onWheel.bind(this);
        this._onContextMenu = (/** @type {Event} */ e) => e.preventDefault();

        domElement.addEventListener('pointerdown', this._onPointerDown);
        domElement.addEventListener('wheel', this._onWheel, { passive: false });
        domElement.addEventListener('contextmenu', this._onContextMenu);
    }

    /** @param {'start'|'end'|'change'} type @param {() => void} fn */
    addEventListener(type, fn) {
        (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    }

    /** @param {string} type */
    _emit(type) {
        for (const fn of this._listeners[type] || []) fn();
    }

    handleResize() {
        this._rect = this.domElement.getBoundingClientRect();
    }

    /** @param {number} y */
    setPanReferencePlaneY(y) {
        const n = Number(y);
        if (Number.isFinite(n)) this._panPlaneY = n;
    }

    /**
     * Map a client point to a vector on the virtual arcball (unit sphere with a
     * hyperbolic-sheet falloff outside r=1, per Holroyd/Shoemake) in the
     * camera's eye space. Returns a normalised direction.
     * @param {number} clientX @param {number} clientY
     * @returns {THREE.Vector3}
     */
    _ballPoint(clientX, clientY) {
        const r = this._rect;
        const px = ((clientX - r.left) / r.width) * 2 - 1;
        const py = -(((clientY - r.top) / r.height) * 2 - 1);
        const v = new THREE.Vector3(px, py, 0);
        const len2 = px * px + py * py;
        if (len2 <= 1) {
            v.z = Math.sqrt(1 - len2);          // on the sphere
        } else {
            v.normalize();                       // hyperbolic sheet → rim
            v.z = 0;
        }
        return v;
    }

    /** @param {PointerEvent} e */
    _onPointerDown(e) {
        if (!this.enabled) return;
        this._rect = this.domElement.getBoundingClientRect();
        // A fresh grab cancels any in-flight coast spin / zoom glide.
        this._spinning = false;
        this._spinVel = 0;
        this._zoomGoalCam = null;
        this._zoomGoalTarget = null;
        const pan = e.button === 2 || e.button === 1 || e.shiftKey;
        this._mode = pan ? 2 : 1;
        if (this._mode === 1) {
            this._q0.copy(this.camera.quaternion);
            this._qPrev.copy(this.camera.quaternion);
            this._anchor.copy(this._ballPoint(e.clientX, e.clientY));
        } else {
            this._panStartX = e.clientX;
            this._panStartY = e.clientY;
            // Plane-drag pan: remember the world point on the pan-reference
            // plane under the cursor at grab time. Each move re-solves an
            // in-plane translation that keeps this point glued to the pointer,
            // so the look target never drifts vertically off the board and the
            // next gesture starts clean (no snap-back jump).
            this._panGrab = this._planePoint(e.clientX, e.clientY);
            // Fallback scale for the rare edge-on view where the cursor ray
            // misses the plane and screen-space panning takes over.
            this._panDepth = this._grabDepth(e.clientX, e.clientY);
        }
        this.domElement.setPointerCapture?.(e.pointerId);
        // Resolve the window from the canvas's CURRENT document each time: the
        // canvas can be re-homed between the in-page panel and a torn-off pop-up
        // (document.adoptNode), so a window captured at construction would go
        // stale and miss pointer events in the other document.
        this._activeWin = this.domElement.ownerDocument?.defaultView || this._win;
        this._activeWin.addEventListener('pointermove', this._onPointerMove);
        this._activeWin.addEventListener('pointerup', this._onPointerUp);
        this._emit('start');
    }

    /** @param {PointerEvent} e */
    _onPointerMove(e) {
        if (this._mode === 1) this._rotateTo(e.clientX, e.clientY);
        else if (this._mode === 2) this._panBy(e.clientX, e.clientY);
    }

    /** @param {PointerEvent} e */
    _onPointerUp(e) {
        const wasRotate = this._mode === 1;
        this._mode = 0;
        this.domElement.releasePointerCapture?.(e.pointerId);
        const win = this._activeWin || this._win;
        win.removeEventListener('pointermove', this._onPointerMove);
        win.removeEventListener('pointerup', this._onPointerUp);
        // Coast: if the release ended a quick rotate flick, keep spinning and
        // defer 'end' until the momentum decays (update() emits it) so the host
        // keeps rendering through the glide. Otherwise settle immediately.
        if (wasRotate && this.enableDamping && this._spinVel > 0.004) {
            this._spinning = true;
        } else {
            this._spinVel = 0;
            this._emit('end');
        }
    }

    /**
     * Absolute arcball rotation: orient the camera as `q0 · delta`, where
     * `delta` is the eye-space rotation taking the current sphere point back to
     * the mouse-down anchor (so the model follows the cursor). Because it is
     * always measured from the fixed anchor, never accumulated, looping the
     * mouse cannot drift.
     * @param {number} clientX @param {number} clientY
     */
    _rotateTo(clientX, clientY) {
        const cur = this._ballPoint(clientX, clientY);
        // Scale the swing angle for rotateSpeed by pushing `cur` further along
        // the great-circle arc from the anchor.
        if (this.rotateSpeed !== 1) {
            const dot = Math.max(-1, Math.min(1, this._anchor.dot(cur)));
            const ang = Math.acos(dot);
            if (ang > 1e-6) {
                const axis = new THREE.Vector3().crossVectors(this._anchor, cur).normalize();
                const q = this._newQuat().setFromAxisAngle(axis, ang * this.rotateSpeed);
                cur.copy(this._anchor).applyQuaternion(q);
            }
        }
        // Eye-space delta mapping current → anchor, applied in the camera's
        // local frame on top of the start orientation.
        const deltaEye = this._newQuat().setFromUnitVectors(cur, this._anchor);
        const q = this._q0.clone().multiply(deltaEye);
        // Seed coast momentum from the per-frame change in orientation so a
        // flick-and-release keeps spinning briefly along the same arc.
        this._seedSpin(q);
        this._setOrientation(q);
        this._needsUpdate = true;
        this._emit('change');
    }

    /**
     * Place the camera on the orbit sphere for orientation `q` (position, up and
     * quaternion). `update()`'s lookAt re-derives the orientation from position
     * and up, so carrying `up` with the rotation lets the board flip past the
     * poles without the gimbal lock a fixed +Y up imposes.
     * @param {THREE.Quaternion} q
     */
    _setOrientation(q) {
        const dist = this.camera.position.distanceTo(this.target);
        const offset = new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(dist);
        this.camera.position.copy(this.target).add(offset);
        this.camera.up.set(0, 1, 0).applyQuaternion(q);
        this.camera.quaternion.copy(q);
    }

    /**
     * Record the world-space rotation between the previous rotate frame and the
     * new orientation `q` as the coast spin axis/velocity, then store `q` for
     * the next frame. Velocity is clamped so a fast flick can't fling the view.
     * @param {THREE.Quaternion} q
     */
    _seedSpin(q) {
        const incr = q.clone().multiply(this._qPrev.clone().invert());
        const v = new THREE.Vector3(incr.x, incr.y, incr.z);
        const len = v.length();
        let angle = 2 * Math.atan2(len, incr.w);
        if (angle > Math.PI) angle -= 2 * Math.PI; // shortest arc
        if (len > 1e-6 && Math.abs(angle) > 1e-5) {
            this._spinAxis.copy(v).divideScalar(len);
            if (angle < 0) { angle = -angle; this._spinAxis.negate(); }
            this._spinVel = Math.min(angle, 0.12);
        } else {
            this._spinVel = 0;
        }
        this._qPrev.copy(q);
    }

    /**
     * World point where the cursor ray intersects the fixed pan-reference
     * board plane (world +Y normal). Returns null when the ray is parallel to
     * the plane or intersects behind the camera.
     * @param {number} clientX @param {number} clientY
     * @returns {THREE.Vector3|null}
     */
    _planePoint(clientX, clientY) {
        const rect = this._rect;
        if (!rect || !rect.height) return null;
        const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
        const tanHalfV = Math.tan((this.camera.fov * Math.PI) / 180 / 2);
        const aspect = this.camera.aspect || (rect.width / rect.height);
        const cam = this.camera.position;
        const forward = this.target.clone().sub(cam).normalize();
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        const dir = forward.clone()
            .add(right.multiplyScalar(nx * tanHalfV * aspect))
            .add(up.multiplyScalar(ny * tanHalfV))
            .normalize();
        if (Math.abs(dir.y) < 1e-4) return null;
        const planeY = Number.isFinite(this._panPlaneY) ? this._panPlaneY : this.target.y;
        const t = (planeY - cam.y) / dir.y;
        if (!(t > 0) || !isFinite(t)) return null;
        return cam.clone().add(dir.multiplyScalar(t));
    }

    /**
     * Screen-space pan: shift both camera and target in the camera's right/up
     * plane so the grabbed point tracks the cursor.
     * @param {number} clientX @param {number} clientY
     */
    _panBy(clientX, clientY) {
        // Primary path: drag the board plane so the grabbed world point tracks
        // the cursor 1:1. The translation lies in the pan-reference plane (both
        // endpoints share planeY), so the look target keeps a constant height
        // above the board — no vertical drift, hence no re-anchor jump.
        if (this._panGrab) {
            const now = this._planePoint(clientX, clientY);
            if (now) {
                const move = this._panGrab.clone().sub(now);
                this.camera.position.add(move);
                this.target.add(move);
                this._panStartX = clientX;
                this._panStartY = clientY;
                this._needsUpdate = true;
                this._emit('change');
                return;
            }
        }
        // Fallback: screen-space pan for edge-on views where the cursor ray
        // never meets the plane.
        const dx = clientX - this._panStartX;
        const dy = clientY - this._panStartY;
        this._panStartX = clientX;
        this._panStartY = clientY;
        // Pan in the camera right/up plane (no forward component), so dragging
        // does not feel like a dolly-zoom. Depth is sampled from the fixed
        // board plane at pan-start to keep off-centre grabs tracking correctly.
        const dist = this._panDepth || this.camera.position.distanceTo(this.target);
        const fov = (this.camera.fov * Math.PI) / 180;
        const worldPerPx = (2 * dist * Math.tan(fov / 2)) / this._rect.height;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        const move = right.multiplyScalar(-dx * worldPerPx * this.panSpeed)
            .add(up.multiplyScalar(dy * worldPerPx * this.panSpeed));
        this.camera.position.add(move);
        this.target.add(move);
        this._needsUpdate = true;
        this._emit('change');
    }

    /**
     * Forward-axis depth (camera → content) of the board surface under the
     * cursor. Pan scales world motion by this depth so the grabbed point tracks
     * the pointer 1:1. Intersects against the fixed pan-reference plane.
     * @param {number} clientX @param {number} clientY @returns {number}
     */
    _grabDepth(clientX, clientY) {
        const cam = this.camera.position;
        const fallback = cam.distanceTo(this.target);
        const hit = this._planePoint(clientX, clientY);
        if (!hit) return fallback;
        const forward = this.target.clone().sub(cam).normalize();
        const depth = hit.sub(cam).dot(forward);
        return depth > 0 && isFinite(depth) ? depth : fallback;
    }

    /** @param {WheelEvent} e */
    _onWheel(e) {
        if (!this.enabled) return;
        // Ignore horizontal-wheel / tilt-wheel input: a second scroll wheel
        // reports motion on deltaX (deltaY ~ 0), which would otherwise fall
        // into the zoom-out branch below and jump the camera on a light touch.
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        this._rect = this.domElement.getBoundingClientRect();
        const dir = e.deltaY < 0 ? 1 : -1;   // +1 = zoom in, -1 = zoom out
        const rawFactor = Math.pow(0.95, this.zoomSpeed * dir);
        // Zoom about the world point under the cursor (falls back to the look
        // target when the ray misses the board plane) so the spot under the
        // pointer stays fixed on screen — "zoom to cursor".
        const pivot = this._planePoint(e.clientX, e.clientY) || this.target.clone();
        // Accumulate onto the current GOAL (not the live rig) so rapid wheel
        // ticks compound smoothly instead of fighting the in-flight glide.
        const goalCam = (this._zoomGoalCam || this.camera.position).clone();
        const goalTarget = (this._zoomGoalTarget || this.target).clone();
        // Pure multiplicative zoom moves the camera by a FRACTION OF DISTANCE,
        // so each tick crawls when zoomed in and flies when zoomed out. Even out
        // the feel by clamping the per-tick distance change to a band tied to the
        // framed view size: close-up zoom keeps making real progress and far-out
        // zoom stays calm.
        const dist0 = goalCam.distanceTo(goalTarget) || 1;
        const ref = Number.isFinite(this.maxDistance) ? this.maxDistance / 5 : dist0;
        const minStep = ref * 0.05;
        const maxStep = ref * 0.40;
        const mag = Math.min(maxStep, Math.max(minStep, Math.abs(dist0 * rawFactor - dist0)));
        const newDist = Math.max(
            this.minDistance,
            Math.min(this.maxDistance, dist0 - dir * mag),
        );
        const factor = newDist / dist0;      // effective scale about the pivot
        goalCam.sub(pivot).multiplyScalar(factor).add(pivot);
        goalTarget.sub(pivot).multiplyScalar(factor).add(pivot);
        // Re-seat the orbit distance exactly (guards float rounding in the scale).
        const off = goalCam.clone().sub(goalTarget).setLength(newDist);
        goalCam.copy(goalTarget).add(off);
        this._zoomGoalCam = goalCam;
        this._zoomGoalTarget = goalTarget;
        this._needsUpdate = true;
        // Kick the host's render loop; update() glides to the goal and emits
        // 'end' once it arrives.
        this._emit('start');
        this._emit('change');
    }

    /** Keep the camera looking at the target; clamp distance. */
    update() {
        let settling = false;
        // ── Coast spin (rotation momentum) ──
        if (this._spinning) {
            const q = this.camera.quaternion.clone();
            const dq = this._newQuat().setFromAxisAngle(this._spinAxis, this._spinVel);
            q.premultiply(dq);                 // incremental world-space spin
            this._setOrientation(q);
            this._qPrev.copy(q);
            this._spinVel *= this.dampingFactor;
            if (this._spinVel < 0.0008) {
                this._spinning = false;
                this._spinVel = 0;
                if (!this._zoomGoalCam) this._emit('end');
            } else {
                settling = true;
                this._emit('change');
            }
        }
        // ── Eased zoom-to-cursor glide ──
        if (this._zoomGoalCam && this._zoomGoalTarget) {
            this.camera.position.lerp(this._zoomGoalCam, this.zoomDamping);
            this.target.lerp(this._zoomGoalTarget, this.zoomDamping);
            if (this.camera.position.distanceToSquared(this._zoomGoalCam) < 1e-6
                && this.target.distanceToSquared(this._zoomGoalTarget) < 1e-6) {
                this.camera.position.copy(this._zoomGoalCam);
                this.target.copy(this._zoomGoalTarget);
                this._zoomGoalCam = null;
                this._zoomGoalTarget = null;
                if (!this._spinning) this._emit('end');
            } else {
                settling = true;
                this._emit('change');
            }
        }
        const offset = this.camera.position.clone().sub(this.target);
        let dist = offset.length();
        const clamped = Math.max(this.minDistance, Math.min(this.maxDistance, dist));
        if (clamped !== dist) {
            offset.setLength(clamped);
            this.camera.position.copy(this.target).add(offset);
        }
        this._ejectFromBounds();
        this.camera.lookAt(this.target);
        this._needsUpdate = false;
        return settling;
    }

    /**
     * Define the solid keep-out volume the camera may not enter (the board +
     * components bounding box). A small margin keeps the camera just clear of
     * surfaces. Pass null to disable.
     * @param {any} box THREE.Box3 in world space, or null
     * @param {number} [margin] outward expansion in mm
     */
    setBounds(box, margin = 0.5) {
        if (!box || box.isEmpty()) { this.boundingBox = null; return; }
        this.boundingBox = box.clone().expandByScalar(margin);
    }

    /**
     * If the camera sits inside the keep-out box, shove it out through the
     * nearest face. Run every frame from update() so pan/zoom/rotate feel like
     * they hit a solid wall at the board/component surface.
     */
    _ejectFromBounds() {
        const bb = this.boundingBox;
        const p = this.camera.position;
        if (!bb || !bb.containsPoint(p)) return;
        const dxMin = p.x - bb.min.x, dxMax = bb.max.x - p.x;
        const dyMin = p.y - bb.min.y, dyMax = bb.max.y - p.y;
        const dzMin = p.z - bb.min.z, dzMax = bb.max.z - p.z;
        const m = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
        if (m === dyMax) p.y = bb.max.y;
        else if (m === dyMin) p.y = bb.min.y;
        else if (m === dxMax) p.x = bb.max.x;
        else if (m === dxMin) p.x = bb.min.x;
        else if (m === dzMax) p.z = bb.max.z;
        else p.z = bb.min.z;
    }

    dispose() {
        this.domElement.removeEventListener('pointerdown', this._onPointerDown);
        this.domElement.removeEventListener('wheel', this._onWheel);
        this.domElement.removeEventListener('contextmenu', this._onContextMenu);
        this._win.removeEventListener('pointermove', this._onPointerMove);
        this._win.removeEventListener('pointerup', this._onPointerUp);
    }
}
