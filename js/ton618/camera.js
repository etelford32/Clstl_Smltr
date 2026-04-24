// Camera / observer state for the TON 618 observatory.
//
// Internally the observer position is spherical (r, theta, phi) in geometrized
// units (M = 1, horizon at r = 2). The camera orientation is built in the local
// orthonormal tetrad {r-hat, theta-hat, phi-hat}:
//
//   forward -> points into the scene (toward r = 0 by default)
//   up      -> theta-hat (toward north pole when looking inward)
//   right   -> phi-hat
//
// All three are expressed as 3-vectors in the tetrad basis. The fragment
// shader transforms each pixel ray through these, then applies the static
// observer tetrad to map to coordinate k^mu.

export function createCamera(opts = {}) {
    const state = {
        r:     opts.r     ?? 20.0,    // outside horizon, ~10 r_s
        theta: opts.theta ?? Math.PI / 2,  // equatorial
        phi:   opts.phi   ?? 0.0,
        fovY:  opts.fovY  ?? (Math.PI / 3),  // 60 deg vertical
        // camera yaw/pitch relative to "look at origin"
        yaw:   0.0,
        pitch: 0.0,
        // internal: cached orthonormal basis (forward, up, right) in tetrad basis
        basis: new Float32Array(9),
    };
    rebuildBasis(state);
    return state;
}

function rebuildBasis(cam) {
    // Start with forward pointing radially inward (-r-hat) and up along +theta-hat.
    // Apply yaw (rotation about up) then pitch (rotation about right).
    const cy = Math.cos(cam.yaw),   sy = Math.sin(cam.yaw);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);

    // base vectors in tetrad frame (r-hat, theta-hat, phi-hat)
    //   forward_0 = (-1, 0, 0)
    //   up_0      = ( 0, 1, 0)
    //   right_0   = ( 0, 0, 1)
    //
    // yaw rotates forward/right about up:
    //   forward = (-cy,  0,  sy)   (pulled toward +phi as yaw increases)
    //   right   = ( sy,  0,  cy)
    // pitch rotates forward/up about right:
    //   forward' = cp * forward + sp * up
    //   up'      = cp * up      - sp * forward

    const fwd0_r  = -cy;
    const fwd0_th = 0.0;
    const fwd0_ph = sy;

    const up0_r   = 0.0;
    const up0_th  = 1.0;
    const up0_ph  = 0.0;

    const right_r  = sy;
    const right_th = 0.0;
    const right_ph = cy;

    const fwd_r  = cp * fwd0_r  + sp * up0_r;
    const fwd_th = cp * fwd0_th + sp * up0_th;
    const fwd_ph = cp * fwd0_ph + sp * up0_ph;

    const up_r   = cp * up0_r   - sp * fwd0_r;
    const up_th  = cp * up0_th  - sp * fwd0_th;
    const up_ph  = cp * up0_ph  - sp * fwd0_ph;

    // GL expects column-major; we pass as 9-float array interpreted that way.
    // Column 0 = forward, col 1 = up, col 2 = right.
    const b = cam.basis;
    b[0] = fwd_r;   b[1] = fwd_th;  b[2] = fwd_ph;
    b[3] = up_r;    b[4] = up_th;   b[5] = up_ph;
    b[6] = right_r; b[7] = right_th; b[8] = right_ph;
}

// Pack camera state for the shader.
export function cameraUniforms(cam, resolution) {
    rebuildBasis(cam);
    return {
        width:   resolution.width,
        height:  resolution.height,
        fovY:    cam.fovY,
        camPos:  [0.0, cam.r, cam.theta, cam.phi],
        camBasis: Array.from(cam.basis),
    };
}

// ---------------------------------------------------------------------------
// Input handling: god-mode orbit / dolly / pan / crash.
// ---------------------------------------------------------------------------
export function attachControls(canvas, cam, onChange) {
    let dragging = false;
    let panning  = false;
    let px = 0, py = 0;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('mousedown', (e) => {
        dragging = true;
        panning  = e.shiftKey || e.button === 2;
        px = e.clientX;
        py = e.clientY;
    });

    window.addEventListener('mouseup', () => { dragging = false; panning = false; });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - px;
        const dy = e.clientY - py;
        px = e.clientX;
        py = e.clientY;

        if (panning) {
            // Pan: rotate camera yaw/pitch without moving observer.
            cam.yaw   += dx * 0.004;
            cam.pitch += dy * 0.004;
            cam.pitch = clamp(cam.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
        } else {
            // Orbit around BH: move phi (azimuth) and theta (polar).
            cam.phi   -= dx * 0.005;
            cam.theta -= dy * 0.005;
            cam.theta = clamp(cam.theta, 0.02, Math.PI - 0.02);
        }
        onChange?.();
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.001);
        cam.r *= factor;
        // Phase 0 observer tetrad is static, only valid outside horizon.
        cam.r = clamp(cam.r, 2.02, 5000.0);
        onChange?.();
    }, { passive: false });

    // Keyboard: WASD strafe (fast), QE dolly radial, R reset.
    window.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 0.2 : 0.05;
        switch (e.key.toLowerCase()) {
            case 'w': cam.theta = clamp(cam.theta - step, 0.02, Math.PI - 0.02); break;
            case 's': cam.theta = clamp(cam.theta + step, 0.02, Math.PI - 0.02); break;
            case 'a': cam.phi  -= step; break;
            case 'd': cam.phi  += step; break;
            case 'q': cam.r = Math.max(2.02, cam.r * (1 - step)); break;
            case 'e': cam.r = Math.min(5000, cam.r * (1 + step)); break;
            case 'r':
                cam.r = 20; cam.theta = Math.PI / 2; cam.phi = 0;
                cam.yaw = 0; cam.pitch = 0;
                break;
            default: return;
        }
        onChange?.();
    });
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
