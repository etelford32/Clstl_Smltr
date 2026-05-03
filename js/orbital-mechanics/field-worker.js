/**
 * field-worker.js — Compute |g| on a 2-D ecliptic-plane grid for a
 * snapshot of the solar system, off the main thread.
 *
 * Protocol
 * ────────
 *   main → worker  { type:'compute', jd, resolution, gridHalfRender,
 *                    RADIAL_K, RADIAL_P,
 *                    mode:'total'|'noSun'|'jacobi',
 *                    bodies:Float32Array(N*4)  (x,y,z,gm) per body,
 *                    sunIndex:int,
 *                    // jacobi-only:
 *                    secondaryIndex:int,
 *                    meanMotion2:number     // n² in rad²/day²
 *                  }
 *   worker → main  { type:'field', jd, resolution, mode,
 *                    gMag:Float32Array(R²),  // |g| in AU/day²
 *                    gMin, gMax, gMean,      // already log-stretched bounds
 *                    domIdx:Uint8Array(R²),  // index of body that dominated each cell
 *                    runtimeMs }
 *   worker → main  { type:'error', message }
 *
 * The grid spans scene-X,Z ∈ [-gridHalfRender, +gridHalfRender] with
 * cell centres at half-step offsets. Each cell projects through the
 * inverse log-radial scale (r_AU = (r_render/K)^(1/P)) to recover the
 * heliocentric ecliptic point at z_AU = 0, then sums Newtonian
 * acceleration from every body in the snapshot.
 *
 * Modes
 * ─────
 *   'total'   — Σᵢ |GMᵢ (rᵢ−P)/|rᵢ−P|³|.  Dominated by the Sun.
 *   'noSun'   — same sum with sunIndex excluded.  Shows the planetary
 *               perturbative field (Jupiter / Saturn signatures pop).
 *   'jacobi'  — circular-restricted three-body effective field:
 *                  g_eff = g_grav(Sun+secondary) + n²·(Pₓ,P_y,0)
 *               The centrifugal term is added in the inertial frame
 *               using the secondary's current orbital mean motion n
 *               (n² supplied by the caller). Lagrange points are zeros
 *               of g_eff, so they appear as DARK spots in the log-
 *               stretched viridis colour map: L1/L2/L3 along the
 *               Sun–secondary line (saddles), L4/L5 60° ahead/behind
 *               (maxima of Φ_eff). Other planets/asteroids are
 *               intentionally excluded so the canonical CR3BP
 *               topology stays clean.
 */

self.onmessage = ev => {
    const m = ev.data;
    if (m.type !== 'compute') return;
    try {
        compute(m);
    } catch (err) {
        self.postMessage({ type:'error', message: err && err.message || String(err) });
    }
};

function compute(req) {
    const t0 = performance.now();
    const {
        jd, resolution, gridHalfRender,
        RADIAL_K, RADIAL_P,
        mode = 'total', bodies, sunIndex = 0,
        secondaryIndex = -1, meanMotion2 = 0,
    } = req;

    const R   = resolution;
    const N   = bodies.length / 4;
    const out = new Float32Array(R * R);
    const dom = new Uint8Array(R * R);

    const step  = (gridHalfRender * 2) / R;
    const start = -gridHalfRender + step / 2;

    let gMin =  Infinity;
    let gMax = -Infinity;
    let gSum = 0, gCount = 0;

    const skipSun = mode === 'noSun';
    const isJacobi = mode === 'jacobi';
    // Pre-fetch CR3BP body parameters for the inner loop.
    const sunX  = isJacobi ? bodies[sunIndex*4 + 0] : 0;
    const sunY  = isJacobi ? bodies[sunIndex*4 + 1] : 0;
    const sunZ  = isJacobi ? bodies[sunIndex*4 + 2] : 0;
    const sunGM = isJacobi ? bodies[sunIndex*4 + 3] : 0;
    const secX  = (isJacobi && secondaryIndex >= 0) ? bodies[secondaryIndex*4 + 0] : 0;
    const secY  = (isJacobi && secondaryIndex >= 0) ? bodies[secondaryIndex*4 + 1] : 0;
    const secZ  = (isJacobi && secondaryIndex >= 0) ? bodies[secondaryIndex*4 + 2] : 0;
    const secGM = (isJacobi && secondaryIndex >= 0) ? bodies[secondaryIndex*4 + 3] : 0;

    for (let iy = 0; iy < R; iy++) {
        const sZ = start + iy * step;
        for (let ix = 0; ix < R; ix++) {
            const sX  = start + ix * step;
            const rr2 = sX * sX + sZ * sZ;
            const cell = iy * R + ix;

            if (rr2 < 0.0001) {
                out[cell] = 0;
                dom[cell] = sunIndex;
                continue;
            }
            const rr   = Math.sqrt(rr2);
            const r_AU = Math.pow(rr / RADIAL_K, 1 / RADIAL_P);
            const k    = rr / r_AU;
            const auX  =  sX / k;
            const auY  = -sZ / k;
            // au_z = 0 — ecliptic slice

            let gx = 0, gy = 0, gz = 0;
            let domMag = 0, domI = 0;

            if (isJacobi) {
                // Sun
                {
                    const dx = sunX - auX, dy = sunY - auY, dz = sunZ;
                    const r2 = dx*dx + dy*dy + dz*dz;
                    if (r2 > 1e-12) {
                        const r1 = Math.sqrt(r2);
                        const inv_r3 = 1 / (r2 * r1);
                        const ax = sunGM * dx * inv_r3;
                        const ay = sunGM * dy * inv_r3;
                        const az = sunGM * dz * inv_r3;
                        gx += ax; gy += ay; gz += az;
                        const mag = Math.sqrt(ax*ax + ay*ay + az*az);
                        if (mag > domMag) { domMag = mag; domI = sunIndex; }
                    }
                }
                // Secondary
                if (secondaryIndex >= 0) {
                    const dx = secX - auX, dy = secY - auY, dz = secZ;
                    const r2 = dx*dx + dy*dy + dz*dz;
                    if (r2 > 1e-12) {
                        const r1 = Math.sqrt(r2);
                        const inv_r3 = 1 / (r2 * r1);
                        const ax = secGM * dx * inv_r3;
                        const ay = secGM * dy * inv_r3;
                        const az = secGM * dz * inv_r3;
                        gx += ax; gy += ay; gz += az;
                        const mag = Math.sqrt(ax*ax + ay*ay + az*az);
                        if (mag > domMag) { domMag = mag; domI = secondaryIndex; }
                    }
                }
                // Centrifugal:  +n² (P_x, P_y, 0)
                gx += meanMotion2 * auX;
                gy += meanMotion2 * auY;
                // gz unchanged — rotation axis is ẑ
            } else {
                for (let i = 0; i < N; i++) {
                    if (skipSun && i === sunIndex) continue;
                    const bx = bodies[i*4 + 0];
                    const by = bodies[i*4 + 1];
                    const bz = bodies[i*4 + 2];
                    const gm = bodies[i*4 + 3];
                    const dx = bx - auX;
                    const dy = by - auY;
                    const dz = bz;          // au_z = 0
                    const r2 = dx*dx + dy*dy + dz*dz;
                    if (r2 < 1e-12) continue;     // avoid divergence at body centre
                    const r1 = Math.sqrt(r2);
                    const inv_r3 = 1 / (r2 * r1);
                    const ax = gm * dx * inv_r3;
                    const ay = gm * dy * inv_r3;
                    const az = gm * dz * inv_r3;
                    gx += ax; gy += ay; gz += az;
                    const mag = Math.sqrt(ax*ax + ay*ay + az*az);
                    if (mag > domMag) { domMag = mag; domI = i; }
                }
            }

            const g = Math.sqrt(gx*gx + gy*gy + gz*gz);
            out[cell] = g;
            dom[cell] = domI;
            if (g > 0) {
                if (g < gMin) gMin = g;
                if (g > gMax) gMax = g;
                gSum += Math.log(g);
                gCount++;
            }
        }
    }

    const gMean = gCount > 0 ? Math.exp(gSum / gCount) : 0;

    self.postMessage(
        {
            type: 'field',
            jd, resolution: R, mode,
            gMag: out, domIdx: dom,
            gMin, gMax, gMean,
            runtimeMs: performance.now() - t0,
        },
        [out.buffer, dom.buffer],
    );
}
