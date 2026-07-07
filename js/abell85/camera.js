// camera.js — god-mode camera for the Abell 85 pair lab.
//
// Two modes sharing one orientation convention (so drag feels identical):
//   orbit — spherical rig around a target point; wheel dollies the radius.
//   fly   — free 6-DOF inertial flight: WASD thrust in the view frame,
//           Q/E vertical, Shift boost, drag to look, wheel scales speed.
//
// The load-bearing trick for exploring 30 kpc → 0.006 pc in one scheme is
// DISTANCE-ADAPTIVE SPEED: thrust is proportional to the distance to the
// nearest black hole (clamped), so approaching a hole automatically
// decelerates from kpc/s to AU/s — the same scheme Gaia Sky / space engines
// use to span astronomical dynamic ranges.
//
// Positions are kept in double precision (plain JS numbers); the renderer
// subtracts the eye on CPU (floating origin) so float32 never sees large
// world coordinates at horizon zoom.

const EASE_RATE = 4;          // 1/s — exponential approach for transitions
const DAMP_RATE = 5;          // 1/s — velocity damping in fly mode
const THRUST_GAIN = 6;        // accel = gain × targetSpeed
const INERTIA_DAMP = 3.2;     // 1/s — orbit-drag release momentum decay

export class GodCamera {
    constructor() {
        this.mode = 'orbit';
        this.fov = 55 * Math.PI / 180;
        // shared orientation (spherical convention; forward = -radial)
        this.yaw = 0.7;
        this.pitch = 0.35;
        // orbit rig
        this.target = [0, 0, 0];
        this.dist = 12000;
        this.goalDist = null;
        // fly rig
        this.pos = [0, 0, 0];
        this.vel = [0, 0, 0];
        this.speedMult = 1;         // user wheel-adjustable in fly mode
        this.keys = new Set();
        this.distClamp = [1e-4, 6e4];
    }

    /** Radial unit vector from target toward the (orbit) eye. */
    _radial() {
        const cp = Math.cos(this.pitch);
        return [cp * Math.cos(this.yaw), Math.sin(this.pitch), cp * Math.sin(this.yaw)];
    }

    eye() {
        if (this.mode === 'fly') return this.pos;
        const r = this._radial();
        return [
            this.target[0] + this.dist * r[0],
            this.target[1] + this.dist * r[1],
            this.target[2] + this.dist * r[2],
        ];
    }

    /** View basis: forward, right, up (world frame, right-handed). */
    basis() {
        const r = this._radial();
        const fwd = [-r[0], -r[1], -r[2]];
        // right = fwd × worldUp(0,1,0) = (−f_z, 0, f_x), renormalized
        let rx = -fwd[2], rz = fwd[0];
        const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
        const right = [rx, 0, rz];
        const up = [                                       // up = right × fwd
            right[1] * fwd[2] - right[2] * fwd[1],
            right[2] * fwd[0] - right[0] * fwd[2],
            right[0] * fwd[1] - right[1] * fwd[0],
        ];
        return { fwd, right, up };
    }

    /** Grab: kill any residual release-spin so the rig feels planted. */
    onDragStart() {
        this._vYaw = 0; this._vPitch = 0;
        this._dragT = performance.now();
        this.dragging = true;
    }

    onDragEnd() { this.dragging = false; }

    onDrag(dx, dy) {
        const s = this.mode === 'fly' ? -1 : 1;   // fly = mouse-look, orbit = grab
        this.yaw += s * dx * 0.005;
        this.pitch = Math.min(Math.max(this.pitch + s * dy * 0.005, -1.45), 1.45);
        // Inertia bookkeeping (orbit mode): smoothed per-event angular rate,
        // released as momentum in update() when the pointer lets go.
        const now = performance.now();
        const dtE = Math.min(Math.max((now - (this._dragT ?? now)) / 1000, 1e-3), 0.1);
        this._dragT = now;
        const k = 0.35;
        this._vYaw = (1 - k) * (this._vYaw ?? 0) + k * (s * dx * 0.005) / dtE;
        this._vPitch = (1 - k) * (this._vPitch ?? 0) + k * (s * dy * 0.005) / dtE;
    }

    onWheel(deltaY) {
        if (this.mode === 'fly') {
            this.speedMult = Math.min(Math.max(
                this.speedMult * Math.exp(-deltaY * 0.0015), 0.02), 50);
        } else {
            this.goalDist = null;
            this.dist = Math.min(Math.max(
                this.dist * Math.exp(deltaY * 0.0012), this.distClamp[0]), this.distClamp[1]);
        }
    }

    toggleMode() {
        if (this.mode === 'orbit') {
            this.pos = this.eye().slice();
            this.vel = [0, 0, 0];
            this.mode = 'fly';
        } else {
            // re-anchor the orbit rig on the current view ray toward the target
            const e = this.pos;
            this.dist = Math.max(Math.hypot(
                e[0] - this.target[0], e[1] - this.target[1], e[2] - this.target[2]),
                this.distClamp[0]);
            // yaw/pitch already describe the radial direction; snap eye onto rig
            this.mode = 'orbit';
        }
        return this.mode;
    }

    /** Smooth cinematic move (orbit mode) to a given radius, optionally
     *  re-targeting the rig (fly-between for depth-separated systems). */
    transitionTo(dist, target = null) {
        if (this.mode === 'fly') this.toggleMode();
        this.goalDist = Math.min(Math.max(dist, this.distClamp[0]), this.distClamp[1]);
        if (target) this.goalTarget = [target[0], target[1], target[2]];
    }

    /**
     * Per-frame integration.
     * @param dt        wall seconds
     * @param dNearest  distance from the eye to the nearest black hole (pc)
     */
    update(dt, dNearest) {
        if (this.mode === 'orbit') {
            if (this.goalDist != null) {
                const k = 1 - Math.exp(-EASE_RATE * dt);
                this.dist += (this.goalDist - this.dist) * k;
                if (Math.abs(this.dist - this.goalDist) / this.goalDist < 0.005) {
                    this.dist = this.goalDist; this.goalDist = null;
                }
            }
            if (this.goalTarget) {
                const k = 1 - Math.exp(-EASE_RATE * dt);
                const g = this.goalTarget, t = this.target;
                let d2 = 0;
                for (let i = 0; i < 3; i++) {
                    t[i] += (g[i] - t[i]) * k;
                    d2 += (g[i] - t[i]) ** 2;
                }
                // finish threshold scales with the rig radius, not absolutes —
                // the same rig spans kpc scenes and sub-pc horizon zooms
                if (d2 < (this.dist * 0.002) ** 2) {
                    this.target = [g[0], g[1], g[2]];
                    this.goalTarget = null;
                }
            }
            // drag inertia — ONLY for callers using the onDragStart/onDragEnd
            // protocol (this.dragging !== undefined); pages that wire onDrag
            // alone (main.js, cinema.js, twin.js) keep the pre-inertia feel.
            // While the pointer is held STILL the smoothed rate decays fast
            // (a long hold releases planted, not spinning); once released,
            // the residual rate coasts and damps out.
            if (this.dragging === undefined) return;
            const idleMs = performance.now() - (this._dragT ?? -1e9);
            if (this.dragging) {
                if (idleMs > 60) {
                    const d = Math.exp(-12 * dt);
                    this._vYaw = (this._vYaw ?? 0) * d;
                    this._vPitch = (this._vPitch ?? 0) * d;
                }
            } else if ((Math.abs(this._vYaw ?? 0) + Math.abs(this._vPitch ?? 0)) > 1e-3) {
                this.yaw += this._vYaw * dt;
                this.pitch = Math.min(Math.max(this.pitch + this._vPitch * dt, -1.45), 1.45);
                const d = Math.exp(-INERTIA_DAMP * dt);
                this._vYaw *= d; this._vPitch *= d;
            }
            return;
        }
        // fly mode: distance-adaptive target speed (pc per wall-second)
        const scale = Math.min(Math.max(dNearest, 1e-4), 3e4);
        const boost = this.keys.has('shift') ? 5 : 1;
        const speed = this.speedMult * boost * scale * 0.9;
        const { fwd, right, up } = this.basis();
        let ax = 0, ay = 0, az = 0;
        const add = (v, s) => { ax += v[0] * s; ay += v[1] * s; az += v[2] * s; };
        if (this.keys.has('w')) add(fwd, 1);
        if (this.keys.has('s')) add(fwd, -1);
        if (this.keys.has('d')) add(right, 1);
        if (this.keys.has('a')) add(right, -1);
        if (this.keys.has('e')) add(up, 1);
        if (this.keys.has('q')) add(up, -1);
        const al = Math.hypot(ax, ay, az);
        if (al > 0) {
            const g = THRUST_GAIN * speed * dt / al;
            this.vel[0] += ax * g; this.vel[1] += ay * g; this.vel[2] += az * g;
        }
        // cap |vel| at the adaptive speed, damp toward rest
        const vl = Math.hypot(...this.vel);
        if (vl > speed) {
            const f = speed / vl;
            this.vel[0] *= f; this.vel[1] *= f; this.vel[2] *= f;
        }
        const damp = Math.exp(-DAMP_RATE * dt * (al > 0 ? 0.15 : 1));
        this.vel[0] *= damp; this.vel[1] *= damp; this.vel[2] *= damp;
        this.pos[0] += this.vel[0] * dt;
        this.pos[1] += this.vel[1] * dt;
        this.pos[2] += this.vel[2] * dt;
    }

    /** Current speed magnitude (pc/s wall) for the HUD; 0 in orbit mode. */
    speed() { return this.mode === 'fly' ? Math.hypot(...this.vel) : 0; }
}
