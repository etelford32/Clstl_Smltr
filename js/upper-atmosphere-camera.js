/**
 * upper-atmosphere-camera.js — orbit ⇄ free-fly camera controller
 * ═══════════════════════════════════════════════════════════════════════════
 * Wraps OrbitControls + a hand-rolled WASD/mouse-look fly mode behind a
 * single setMode() switch. The motivation: the upper-atmosphere page wants
 * users to *enter* the layers, not just orbit them — but the orbit camera
 * is still the right default for first-paint and for the satellite-ring
 * readouts. This controller keeps both alive and only one active.
 *
 * Modes
 *   'orbit'    — OrbitControls around the planet centre. Default.
 *   'fly'      — Free 6-DOF camera. WASD pans relative to look-direction,
 *                Q/E descend/ascend in world frame, Space/Shift accelerate
 *                /decelerate base speed, mouse-drag rotates view (no
 *                pointer-lock — keeps the click-to-fly affordance working
 *                against satellites).
 *
 * Public surface
 *   new CameraController(camera, domElement)
 *   .setMode('orbit'|'fly')                  switch active mode
 *   .getMode()
 *   .update(dt)                              call once per frame
 *   .flyTo(targetVec3, lookAtVec3?)          smooth camera move
 *   .getAltitudeKm()                         |camera position| → km above 1 R⊕
 *   .dispose()
 *
 * Notes for callers
 *   • Don't share OrbitControls.update() with this — call .update(dt) and
 *     it dispatches to whichever mode is active.
 *   • flyTo() works in any mode; in orbit mode it animates the orbit
 *     target + distance; in fly mode it animates the camera position +
 *     forward vector.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const R_EARTH_KM = 6371;

// Fly-mode tuning — base speed in R⊕/s, scaled by an exponential of the
// camera's distance from Earth so users can both crawl through a 50-km
// layer band and zip across the magnetosphere with the same key.
const FLY_BASE_SPEED  = 0.45;     // R⊕/s
const FLY_SHIFT_BOOST = 4.0;      // hold-Shift multiplier
const FLY_CRAWL       = 0.18;     // hold-Ctrl/Alt multiplier
// Mouse sensitivity in radians per pixel of drag. Tuned so a full
// monitor-width drag completes ~half a turn.
const FLY_LOOK_SENS   = 0.0035;

export class CameraController {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {HTMLElement} domElement   pointer-event source (canvas)
     */
    constructor(camera, domElement) {
        this.camera = camera;
        this.dom = domElement;

        // OrbitControls owns the orbit-mode bookkeeping. We keep its
        // damping enabled so the transition feels consistent with the
        // page's existing behaviour.
        this._orbit = new OrbitControls(camera, domElement);
        this._orbit.enableDamping = true;
        this._orbit.dampingFactor = 0.08;
        this._orbit.minDistance = 1.05;       // allow grazing the surface
        this._orbit.maxDistance = 28;
        this._orbit.enablePan = false;
        this._orbit.rotateSpeed = 0.55;

        // Fly-mode state.
        this._mode = 'orbit';
        this._yaw = 0;
        this._pitch = 0;
        this._velocity = new THREE.Vector3();
        this._keys = new Set();
        this._dragging = false;
        this._lastMouse = { x: 0, y: 0 };

        // Smooth flyTo() animation.
        this._anim = null;

        // Cached camera basis — recomputed whenever yaw/pitch change.
        this._fwd   = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._up    = new THREE.Vector3(0, 1, 0);

        this._bindFly();
    }

    setMode(mode) {
        if (mode !== 'orbit' && mode !== 'fly') return;
        if (mode === this._mode) return;

        if (mode === 'fly') {
            // Seed yaw/pitch from the camera's current orientation so the
            // transition is invisible. Compute from the camera's forward
            // vector (-Z in local space, transformed by world matrix).
            const fwd = new THREE.Vector3(0, 0, -1)
                .applyQuaternion(this.camera.quaternion);
            this._pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
            // _stepFly() builds forward as (sy·cp, sp, -cy·cp), so
            // inverting requires atan2(x, -z) not atan2(x, z).
            this._yaw   = Math.atan2(fwd.x, -fwd.z);
            // Stop any orbit damping motion.
            this._orbit.enabled = false;
            this.dom.style.cursor = 'crosshair';
        } else {
            // Re-aim orbit at planet centre while preserving camera
            // position so the user doesn't get yanked.
            this._orbit.target.set(0, 0, 0);
            this._orbit.enabled = true;
            this._orbit.update();
            this.dom.style.cursor = 'grab';
        }
        this._mode = mode;
    }

    getMode() { return this._mode; }

    /** Total camera distance from Earth centre, expressed in km. */
    getAltitudeKm() {
        return (this.camera.position.length() - 1) * R_EARTH_KM;
    }

    /**
     * Animate the camera to `targetPos`, optionally pointing at
     * `lookAtPos`. Works in both modes.
     *
     * @param {THREE.Vector3} targetPos
     * @param {THREE.Vector3} [lookAtPos]
     * @param {number}        [durationSec=1.4]
     */
    flyTo(targetPos, lookAtPos = null, durationSec = 1.4) {
        // Snapshot start state.
        const start = {
            pos:  this.camera.position.clone(),
            quat: this.camera.quaternion.clone(),
        };
        // For end orientation: build a quaternion that points at lookAt.
        const endQuat = new THREE.Quaternion();
        if (lookAtPos) {
            const m = new THREE.Matrix4().lookAt(targetPos, lookAtPos, this._up);
            endQuat.setFromRotationMatrix(m);
        } else {
            endQuat.copy(start.quat);
        }
        this._anim = {
            t0:        performance.now() / 1000,
            duration:  durationSec,
            startPos:  start.pos,
            endPos:    targetPos.clone(),
            startQuat: start.quat,
            endQuat,
            lookAt:    lookAtPos?.clone() || null,
        };
    }

    /** Per-frame update — call from the host's animate() loop. */
    update(dt) {
        // While a flyTo() animation is in progress we don't run mode-
        // specific update logic — the anim owns the camera. In orbit
        // mode in particular, OrbitControls would fight the anim by
        // pulling the camera back toward target every frame.
        if (this._anim) {
            this._stepAnim();
            return;
        }

        if (this._mode === 'orbit') {
            this._orbit.update();
        } else {
            this._stepFly(dt);
        }
    }

    dispose() {
        this._unbindFly?.();
        this._orbit.dispose();
    }

    // ── Fly-mode internals ──────────────────────────────────────────────

    _bindFly() {
        const onKey = (down) => (e) => {
            // Don't capture keys while user is typing in form fields.
            const tag = (e.target?.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            const key = e.key.toLowerCase();
            if (down) this._keys.add(key);
            else      this._keys.delete(key);
            // Don't preventDefault — that would block tabbing/copy etc.
        };
        const onMouseDown = (e) => {
            if (this._mode !== 'fly') return;
            // Left button only — leave middle/right alone for browser UI.
            if (e.button !== 0) return;
            this._dragging = true;
            this._lastMouse.x = e.clientX;
            this._lastMouse.y = e.clientY;
            this.dom.style.cursor = 'grabbing';
        };
        const onMouseUp = () => {
            this._dragging = false;
            if (this._mode === 'fly') this.dom.style.cursor = 'crosshair';
        };
        const onMouseMove = (e) => {
            if (!this._dragging || this._mode !== 'fly') return;
            const dx = e.clientX - this._lastMouse.x;
            const dy = e.clientY - this._lastMouse.y;
            this._lastMouse.x = e.clientX;
            this._lastMouse.y = e.clientY;
            this._yaw   -= dx * FLY_LOOK_SENS;
            this._pitch -= dy * FLY_LOOK_SENS;
            // Clamp pitch a hair below the poles to avoid gimbal flip.
            const lim = Math.PI / 2 - 0.05;
            if (this._pitch >  lim) this._pitch =  lim;
            if (this._pitch < -lim) this._pitch = -lim;
        };

        const onKD = onKey(true);
        const onKU = onKey(false);

        window.addEventListener('keydown', onKD);
        window.addEventListener('keyup',   onKU);
        this.dom.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mousemove', onMouseMove);
        this._unbindFly = () => {
            window.removeEventListener('keydown', onKD);
            window.removeEventListener('keyup',   onKU);
            this.dom.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('mousemove', onMouseMove);
        };
    }

    _stepFly(dt) {
        // While a flyTo() animation owns the camera, defer to it
        // entirely — both position AND orientation come from the anim.
        // Once the anim ends, _stepAnim() seeds yaw/pitch back into
        // this controller so user input picks up cleanly.
        if (this._anim) return;

        // Build forward / right from yaw + pitch.
        const cy = Math.cos(this._yaw),   sy = Math.sin(this._yaw);
        const cp = Math.cos(this._pitch), sp = Math.sin(this._pitch);
        // Forward: yaw rotates around world-Y, pitch around camera-right.
        // With our convention (yaw=0, pitch=0 → looking at -Z):
        this._fwd.set(sy * cp, sp, -cy * cp).normalize();
        this._right.set(cy, 0, sy).normalize();    // perpendicular to fwd & up

        // Apply orientation. Use lookAt with an explicit target so up
        // stays world-Y (no roll).
        const tgt = this.camera.position.clone().add(this._fwd);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(tgt);

        // Distance-scaled base speed: when very close to Earth, slow down
        // so users can actually park inside a 50-km-thick layer band.
        const r = this.camera.position.length();
        const distScale = 0.30 + Math.min(2.5, r);
        let speed = FLY_BASE_SPEED * distScale;
        if (this._keys.has('shift')) speed *= FLY_SHIFT_BOOST;
        if (this._keys.has('control') || this._keys.has('alt')) speed *= FLY_CRAWL;

        // Translation accumulator (R⊕).
        const move = new THREE.Vector3();
        if (this._keys.has('w')) move.add(this._fwd);
        if (this._keys.has('s')) move.sub(this._fwd);
        if (this._keys.has('d')) move.add(this._right);
        if (this._keys.has('a')) move.sub(this._right);
        // Q/E descend/ascend in WORLD frame so users can climb out of a
        // layer regardless of where they're looking.
        if (this._keys.has('e')) move.y += 1;
        if (this._keys.has('q')) move.y -= 1;

        if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(speed * dt);
            this.camera.position.add(move);
        }

        // Soft floor: never let the camera go inside the planet — push it
        // back to 1.005 R⊕ if the user runs into the surface.
        const dist = this.camera.position.length();
        if (dist < 1.005) {
            this.camera.position.multiplyScalar(1.005 / dist);
        }
        // And a soft ceiling at 30 R⊕ so users can't get lost.
        if (dist > 30) {
            this.camera.position.multiplyScalar(30 / dist);
        }
    }

    _stepAnim() {
        const a = this._anim;
        const now = performance.now() / 1000;
        const t = Math.min(1, (now - a.t0) / a.duration);
        // Ease in/out (smoothstep).
        const k = t * t * (3 - 2 * t);

        this.camera.position.lerpVectors(a.startPos, a.endPos, k);
        this.camera.quaternion.slerpQuaternions(a.startQuat, a.endQuat, k);

        if (t >= 1) {
            // On completion, sync the active mode so user-input picks up
            // cleanly from the new pose.
            if (this._mode === 'fly' && a.lookAt) {
                const fwd = a.lookAt.clone().sub(a.endPos).normalize();
                this._pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
                this._yaw   = Math.atan2(fwd.x, -fwd.z);
            } else if (this._mode === 'orbit') {
                this._orbit.target.set(0, 0, 0);
                this._orbit.update();
            }
            this._anim = null;
        }
    }
}
