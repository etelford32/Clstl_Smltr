// Camera / observer state for the TON 618 observatory — Phase 0.5 god-mode.
//
// The fragment shader does the GR ray-tracing in 3D (8-D phase-space integration);
// this module describes WHERE the observer sits, HOW it moves, and HOW it is
// oriented in the local Lorentz frame. Two interaction styles are supported:
//
//   ORBIT mode (default):
//     - left-drag      = orbit around BH (theta/phi)
//     - shift-drag     = look-around (yaw/pitch about local frame)
//     - middle-drag    = roll
//     - wheel          = dolly r in/out
//     - WASD           = strafe theta/phi
//     - QE             = dolly r
//     - X/Z            = roll left/right
//
//   FREE-FLY mode:
//     - mouse drag     = mouse-look (yaw/pitch)
//     - WASD           = strafe along local forward / right
//     - QE             = dolly forward / back
//     - space/ctrl     = up / down along local up
//     - X/Z            = roll
//     - shift held     = boost speed 4x
//
// All translations move the observer through the *Schwarzschild coordinate*
// system, but the strafe directions are computed in the camera's tetrad frame
// and projected to coordinate displacements via the metric scale factors.
//
// The orientation is full 3-DOF (yaw + pitch + roll). The camera basis is an
// orthonormal triad expressed in the local tetrad basis (r-hat, theta-hat,
// phi-hat) and is uploaded to the shader as a 3x3 matrix.

import { lapse } from './physics.js';

const CAM_R_MIN = 2.05;          // never cross the static-tetrad horizon
const CAM_R_MAX = 5000.0;
const THETA_EPS = 0.02;

export const OBSERVER_TYPES = {
    static:    0,
    freefall:  1,
    zamo:      2,    // alias for static in Schwarzschild — kept for API parity with Kerr Phase 1
    keplerian: 3,
};

export const PRESETS = {
    'far-equator':  { r: 80,  theta: Math.PI / 2,        phi: 0,        yaw: 0, pitch: 0, roll: 0, fovY: 45 },
    'iconic':       { r: 22,  theta: Math.PI / 2 - 0.18, phi: 0,        yaw: 0, pitch: 0.08, roll: 0, fovY: 60 },
    'pole-down':    { r: 60,  theta: 0.20,               phi: 0,        yaw: 0, pitch: -1.30, roll: 0, fovY: 55 },
    'photon-graze': { r: 5.5, theta: Math.PI / 2,        phi: 0,        yaw: 0, pitch: 0, roll: 0, fovY: 90 },
    'horizon-skim': { r: 2.4, theta: Math.PI / 2,        phi: 0,        yaw: 0, pitch: 0, roll: 0, fovY: 120 },
    'isco-orbit':   { r: 6.0, theta: Math.PI / 2,        phi: 0,        yaw: -Math.PI/2, pitch: 0, roll: 0, fovY: 70 },
    'wide-survey':  { r: 200, theta: Math.PI / 2 - 0.4,  phi: 0,        yaw: 0, pitch: 0.2, roll: 0, fovY: 30 },
};

export function createCamera(opts = {}) {
    const cam = {
        // observer position in Schwarzschild coords (M = 1)
        r:     opts.r     ?? 30.0,
        theta: opts.theta ?? Math.PI / 2,
        phi:   opts.phi   ?? 0.0,
        // orientation: yaw/pitch/roll in radians. Defaults look toward origin.
        yaw:   opts.yaw   ?? 0.0,
        pitch: opts.pitch ?? 0.0,
        roll:  opts.roll  ?? 0.0,
        fovY:  opts.fovY  ?? (Math.PI / 4),

        // observer kinematic mode (used by shader to pick tetrad)
        observerType: OBSERVER_TYPES.static,

        // interaction mode
        flyMode: false,

        // velocity state for inertial smoothing (god-mode feel)
        vR:     0, vTheta: 0, vPhi: 0,
        vYaw:   0, vPitch: 0, vRoll: 0,
        // local-frame thrust intentions, set by input handlers each frame
        thrustForward: 0, thrustRight: 0, thrustUp: 0,    // free-fly
        thrustR: 0, thrustTheta: 0, thrustPhi: 0,         // orbit-mode keys
        thrustYaw: 0, thrustPitch: 0, thrustRoll: 0,

        // smooth transition target (for presets); null when idle
        transition: null,

        // cached basis (column-major: forward, up, right) in tetrad basis
        basis: new Float32Array(9),
    };
    rebuildBasis(cam);
    return cam;
}

// ---------------------------------------------------------------------------
// Build the 3x3 orientation matrix in the local tetrad basis from yaw/pitch/roll.
// ---------------------------------------------------------------------------
//   - "Home" orientation: forward = -r-hat (look inward), up = +theta-hat,
//     right = +phi-hat. yaw=pitch=roll=0 reproduces this.
//   - Yaw rotates about the up axis (toward +phi).
//   - Pitch rotates about the right axis (look up/down toward poles).
//   - Roll rotates about the forward axis.
export function rebuildBasis(cam) {
    const cy = Math.cos(cam.yaw),   sy = Math.sin(cam.yaw);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const cr = Math.cos(cam.roll),  sr = Math.sin(cam.roll);

    // Start with the default basis (rows = r-hat, theta-hat, phi-hat components).
    // forward0 = (-1, 0, 0), up0 = (0, 1, 0), right0 = (0, 0, 1).
    // Apply yaw (about up0), then pitch (about right'), then roll (about forward'').

    // After yaw:
    //   forward = (-cy,  0,  sy)
    //   right   = ( sy,  0,  cy)
    //   up      = (  0,  1,   0)
    let fx = -cy, fy = 0,   fz = sy;
    let rx =  sy, ry = 0,   rz = cy;
    let ux =  0,  uy = 1,   uz = 0;

    // Apply pitch about right:
    //   forward' = cp*forward + sp*up
    //   up'      = cp*up      - sp*forward
    {
        const fxp = cp * fx + sp * ux;
        const fyp = cp * fy + sp * uy;
        const fzp = cp * fz + sp * uz;
        const uxp = cp * ux - sp * fx;
        const uyp = cp * uy - sp * fy;
        const uzp = cp * uz - sp * fz;
        fx = fxp; fy = fyp; fz = fzp;
        ux = uxp; uy = uyp; uz = uzp;
    }

    // Apply roll about forward:
    //   right'' = cr*right - sr*up
    //   up''    = cr*up    + sr*right
    {
        const rxp = cr * rx - sr * ux;
        const ryp = cr * ry - sr * uy;
        const rzp = cr * rz - sr * uz;
        const uxp = cr * ux + sr * rx;
        const uyp = cr * uy + sr * ry;
        const uzp = cr * uz + sr * rz;
        rx = rxp; ry = ryp; rz = rzp;
        ux = uxp; uy = uyp; uz = uzp;
    }

    const b = cam.basis;
    b[0] = fx; b[1] = fy; b[2] = fz;     // col 0 = forward
    b[3] = ux; b[4] = uy; b[5] = uz;     // col 1 = up
    b[6] = rx; b[7] = ry; b[8] = rz;     // col 2 = right
}

// Pack camera state for the shader.
export function cameraUniforms(cam, resolution) {
    rebuildBasis(cam);
    return {
        width:    resolution.width,
        height:   resolution.height,
        fovY:     cam.fovY,
        camPos:   [0.0, cam.r, cam.theta, cam.phi],
        camBasis: Array.from(cam.basis),
    };
}

// ---------------------------------------------------------------------------
// Per-frame integration: blend thrust, decay velocity, advance position.
// dt: real-world seconds since last frame.
// Returns true if the camera moved (caller should mark dirty).
// ---------------------------------------------------------------------------
const POS_DRAG = 6.0;       // 1/seconds — exponential decay of positional velocity
const ANG_DRAG = 8.0;
const ACCEL    = 7.0;

export function integrate(cam, dt) {
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.1);    // clamp big tab-stalls

    const beforeKey = posKey(cam);

    // Blend transition target if active.
    if (cam.transition) advanceTransition(cam, dt);

    // ── translational thrust → position-space velocities ───────────────
    if (cam.flyMode) {
        // Map local-frame thrust into Schwarzschild coordinate rates.
        // Tetrad basis vectors have coordinate components (1, 1/r, 1/(r sin theta))
        // along (r, theta, phi). So a unit-speed motion along forward in local
        // frame moves coordinate r at rate forward.r, coordinate theta at
        // forward.theta / r, coordinate phi at forward.phi / (r sin theta).
        const fwd = subVec(cam.basis, 0);
        const up  = subVec(cam.basis, 1);
        const rgt = subVec(cam.basis, 2);
        const sinT = Math.max(Math.abs(Math.sin(cam.theta)), 1e-3);
        const r = Math.max(cam.r, CAM_R_MIN);

        // Combine thrusts into a single tetrad-frame velocity vector.
        const tx = cam.thrustForward * fwd[0] + cam.thrustRight * rgt[0] + cam.thrustUp * up[0];
        const ty = cam.thrustForward * fwd[1] + cam.thrustRight * rgt[1] + cam.thrustUp * up[1];
        const tz = cam.thrustForward * fwd[2] + cam.thrustRight * rgt[2] + cam.thrustUp * up[2];

        // Drive accelerations on coordinate velocities.
        cam.vR     += (tx)         * ACCEL * dt;
        cam.vTheta += (ty / r)     * ACCEL * dt;
        cam.vPhi   += (tz / (r * sinT)) * ACCEL * dt;
    } else {
        // Orbit-mode keyboard nudges directly drive coordinate velocities.
        cam.vR     += cam.thrustR     * ACCEL * dt;
        cam.vTheta += cam.thrustTheta * ACCEL * dt;
        cam.vPhi   += cam.thrustPhi   * ACCEL * dt;
    }

    // ── angular thrust ─────────────────────────────────────────────────
    cam.vYaw   += cam.thrustYaw   * ACCEL * dt;
    cam.vPitch += cam.thrustPitch * ACCEL * dt;
    cam.vRoll  += cam.thrustRoll  * ACCEL * dt;

    // ── apply drag (exponential decay) ─────────────────────────────────
    const posDecay = Math.exp(-POS_DRAG * dt);
    const angDecay = Math.exp(-ANG_DRAG * dt);
    cam.vR *= posDecay; cam.vTheta *= posDecay; cam.vPhi *= posDecay;
    cam.vYaw *= angDecay; cam.vPitch *= angDecay; cam.vRoll *= angDecay;

    // ── advance state ──────────────────────────────────────────────────
    cam.r     += cam.vR     * dt;
    cam.theta += cam.vTheta * dt;
    cam.phi   += cam.vPhi   * dt;
    cam.yaw   += cam.vYaw   * dt;
    cam.pitch += cam.vPitch * dt;
    cam.roll  += cam.vRoll  * dt;

    // ── clamp to safe domain ───────────────────────────────────────────
    cam.r     = clamp(cam.r,     CAM_R_MIN, CAM_R_MAX);
    cam.theta = clamp(cam.theta, THETA_EPS, Math.PI - THETA_EPS);
    cam.phi   = wrap(cam.phi);
    cam.pitch = clamp(cam.pitch, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
    // yaw and roll are free.

    return posKey(cam) !== beforeKey;
}

function subVec(b, col) { return [b[col*3], b[col*3+1], b[col*3+2]]; }
function posKey(cam) {
    return `${cam.r.toFixed(4)}|${cam.theta.toFixed(5)}|${cam.phi.toFixed(5)}|${cam.yaw.toFixed(5)}|${cam.pitch.toFixed(5)}|${cam.roll.toFixed(5)}|${cam.fovY.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Cinematic transitions (preset jumps).
// ---------------------------------------------------------------------------
export function startTransition(cam, target, durationSec = 1.4) {
    cam.transition = {
        from: snapshot(cam),
        to:   { ...snapshot(cam), ...target },
        t:    0,
        T:    Math.max(0.1, durationSec),
    };
    // zero velocities so we don't fight the lerp.
    cam.vR = cam.vTheta = cam.vPhi = 0;
    cam.vYaw = cam.vPitch = cam.vRoll = 0;
}

function snapshot(cam) {
    return {
        r: cam.r, theta: cam.theta, phi: cam.phi,
        yaw: cam.yaw, pitch: cam.pitch, roll: cam.roll,
        fovY: cam.fovY,
    };
}

function advanceTransition(cam, dt) {
    const tr = cam.transition;
    tr.t = Math.min(tr.T, tr.t + dt);
    const x = tr.t / tr.T;
    // smootherstep easing
    const e = x * x * x * (x * (x * 6 - 15) + 10);

    // r interpolated logarithmically so wide-to-close moves feel uniform.
    const lr = Math.log(tr.from.r) + (Math.log(tr.to.r) - Math.log(tr.from.r)) * e;
    cam.r = Math.exp(lr);

    cam.theta = lerp(tr.from.theta, tr.to.theta, e);
    cam.phi   = lerpAngle(tr.from.phi,   tr.to.phi,   e);
    cam.yaw   = lerpAngle(tr.from.yaw,   tr.to.yaw,   e);
    cam.pitch = lerp(tr.from.pitch, tr.to.pitch, e);
    cam.roll  = lerpAngle(tr.from.roll,  tr.to.roll,  e);
    cam.fovY  = lerp(tr.from.fovY,  tr.to.fovY,  e);

    if (tr.t >= tr.T) cam.transition = null;
}

// ---------------------------------------------------------------------------
// Input handling — orbit mode + free-fly mode.
// ---------------------------------------------------------------------------
export function attachControls(canvas, cam, onChange) {
    const keys = new Set();
    let dragging = false;
    let dragMode = 'orbit';   // 'orbit' | 'pan' | 'roll'
    let px = 0, py = 0;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('mousedown', (e) => {
        dragging = true;
        if (e.button === 1)            dragMode = 'roll';
        else if (e.shiftKey)            dragMode = 'pan';
        else                            dragMode = 'orbit';
        px = e.clientX;
        py = e.clientY;
        e.preventDefault();
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - px;
        const dy = e.clientY - py;
        px = e.clientX;
        py = e.clientY;

        if (cam.flyMode) {
            // Mouse-look: yaw/pitch.
            cam.yaw   -= dx * 0.0035;
            cam.pitch -= dy * 0.0035;
            cam.pitch = clamp(cam.pitch, -Math.PI/2 + 0.005, Math.PI/2 - 0.005);
            cam.transition = null;
            onChange?.();
            return;
        }

        if (dragMode === 'roll') {
            cam.roll += dx * 0.005;
        } else if (dragMode === 'pan') {
            // Pan = look around (yaw/pitch in local frame, observer fixed)
            cam.yaw   += dx * 0.004;
            cam.pitch -= dy * 0.004;
            cam.pitch = clamp(cam.pitch, -Math.PI/2 + 0.01, Math.PI/2 - 0.01);
        } else {
            // Orbit around BH.
            cam.phi   -= dx * 0.005;
            cam.theta -= dy * 0.005;
            cam.theta = clamp(cam.theta, THETA_EPS, Math.PI - THETA_EPS);
        }
        cam.transition = null;
        onChange?.();
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.0009);
        cam.r = clamp(cam.r * factor, CAM_R_MIN, CAM_R_MAX);
        cam.transition = null;
        onChange?.();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
        const k = e.key.toLowerCase();
        if (k === 'f') {
            cam.flyMode = !cam.flyMode;
            onChange?.();
            return;
        }
        if (k === 'r' && !e.repeat) {
            // Reset to default home view.
            startTransition(cam, PRESETS['far-equator'], 1.0);
            onChange?.();
            return;
        }
        keys.add(k);
    });
    window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => keys.clear());

    // Per-frame: read keyboard, push thrusts into camera.
    const pumpThrust = () => {
        const boost = keys.has('shift') ? 4.0 : 1.0;
        const T_pos = (cam.flyMode ? 1.0 : 0.6) * boost;
        const T_ang = 1.6 * boost;

        // Reset thrusts each frame.
        cam.thrustForward = cam.thrustRight = cam.thrustUp = 0;
        cam.thrustR = cam.thrustTheta = cam.thrustPhi = 0;
        cam.thrustYaw = cam.thrustPitch = cam.thrustRoll = 0;

        if (cam.flyMode) {
            if (keys.has('w')) cam.thrustForward += T_pos;
            if (keys.has('s')) cam.thrustForward -= T_pos;
            if (keys.has('d')) cam.thrustRight   += T_pos;
            if (keys.has('a')) cam.thrustRight   -= T_pos;
            if (keys.has(' ')) cam.thrustUp      += T_pos;
            if (keys.has('control') || keys.has('c')) cam.thrustUp -= T_pos;
            if (keys.has('e')) cam.thrustForward += T_pos * 1.5;
            if (keys.has('q')) cam.thrustForward -= T_pos * 1.5;
        } else {
            if (keys.has('w')) cam.thrustTheta -= T_pos;
            if (keys.has('s')) cam.thrustTheta += T_pos;
            if (keys.has('a')) cam.thrustPhi   -= T_pos;
            if (keys.has('d')) cam.thrustPhi   += T_pos;
            if (keys.has('q')) cam.thrustR     -= T_pos * 4.0;   // dolly inward
            if (keys.has('e')) cam.thrustR     += T_pos * 4.0;   // dolly outward
        }

        // Roll keys (always available).
        if (keys.has('z')) cam.thrustRoll -= T_ang;
        if (keys.has('x')) cam.thrustRoll += T_ang;
        // Arrow keys: yaw/pitch nudges
        if (keys.has('arrowleft'))  cam.thrustYaw   -= T_ang;
        if (keys.has('arrowright')) cam.thrustYaw   += T_ang;
        if (keys.has('arrowup'))    cam.thrustPitch += T_ang;
        if (keys.has('arrowdown'))  cam.thrustPitch -= T_ang;
    };

    return { pumpThrust, isFlyMode: () => cam.flyMode };
}

// ---------------------------------------------------------------------------
// Numerical helpers
// ---------------------------------------------------------------------------
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function lerp(a, b, t)    { return a + (b - a) * t; }
function lerpAngle(a, b, t) {
    let d = ((b - a) + Math.PI) % (2 * Math.PI) - Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return a + d * t;
}
function wrap(a) {
    const tau = 2 * Math.PI;
    a = a % tau;
    if (a > Math.PI)  a -= tau;
    if (a < -Math.PI) a += tau;
    return a;
}

// Used by HUD / mini-map: convert observer to a "god-frame" Cartesian point.
export function observerCartesian(cam) {
    const sT = Math.sin(cam.theta), cT = Math.cos(cam.theta);
    const sP = Math.sin(cam.phi),   cP = Math.cos(cam.phi);
    return [cam.r * sT * cP, cam.r * cT, cam.r * sT * sP];
}

// Forward direction in Cartesian (god-frame) — used by mini-map frustum.
export function forwardCartesian(cam) {
    rebuildBasis(cam);
    const sT = Math.sin(cam.theta), cT = Math.cos(cam.theta);
    const sP = Math.sin(cam.phi),   cP = Math.cos(cam.phi);
    // Tetrad basis vectors in Cartesian:
    //   e_r     = (sT cP, cT, sT sP)
    //   e_theta = (cT cP, -sT, cT sP)
    //   e_phi   = (-sP, 0, cP)
    const f = [cam.basis[0], cam.basis[1], cam.basis[2]];
    const ex_r  = sT * cP, ey_r  = cT,  ez_r  = sT * sP;
    const ex_th = cT * cP, ey_th = -sT, ez_th = cT * sP;
    const ex_ph = -sP,     ey_ph = 0,   ez_ph = cP;
    return [
        f[0] * ex_r + f[1] * ex_th + f[2] * ex_ph,
        f[0] * ey_r + f[1] * ey_th + f[2] * ey_ph,
        f[0] * ez_r + f[1] * ez_th + f[2] * ez_ph,
    ];
}
