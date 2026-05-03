/**
 * streamlines-worker.js — Trace integral curves of the gravity / Jacobi
 * field by RK4 in scene-space, off the main thread.
 *
 * Each streamline is a polyline integrated from a seed point in two
 * directions (forward and backward) along the unit-normalised field
 *
 *     d r̂(s) / ds = ĝ(r̂(s))
 *
 * with fixed step h in scene units. Using the *unit* field gives
 * visually clean lines with constant arc length per step regardless
 * of |g| — bright attractors (planets, Lagrange points) sit at line
 * convergences without "speeding up" the curve.
 *
 * Each integration step traces a 4-stage RK4:
 *
 *     k1 = ĝ(P)
 *     k2 = ĝ(P + h·k1/2)
 *     k3 = ĝ(P + h·k2/2)
 *     k4 = ĝ(P + h·k3)
 *     P_next = P + (h/6)(k1 + 2k2 + 2k3 + k4)
 *
 * Stops on:
 *   • step count limit
 *   • leaving the bounding scene-space radius
 *   • approaching the Sun or any body within `proximity` scene units
 *   • |g| → 0 (we hit a Lagrange point or saddle)
 *
 * Protocol
 * ────────
 *   main → worker  { type:'compute', jd, mode, sunIndex, secondaryIndex,
 *                    meanMotion2, bodies:Float32Array(N*4),
 *                    seeds:Float32Array(K*2),    // (sX, sZ) per seed
 *                    hStep, maxSteps,
 *                    RADIAL_K, RADIAL_P,
 *                    boundsR, proximity }
 *   worker → main  { type:'streamlines', jd, mode,
 *                    vertices:Float32Array(M*3),  // sequential pairs of
 *                                                  //   (x,y,z) endpoints
 *                                                  //   per LineSegments
 *                    segCount, runtimeMs }
 *   worker → main  { type:'error', message }
 */

self.onmessage = ev => {
    const m = ev.data;
    if (m.type !== 'compute') return;
    try { compute(m); }
    catch (err) {
        self.postMessage({ type:'error', message: err && err.message || String(err) });
    }
};

function compute(req) {
    const t0 = performance.now();
    const {
        jd, mode = 'total',
        sunIndex = 0, secondaryIndex = -1, meanMotion2 = 0,
        bodies, seeds, hStep = 0.4, maxSteps = 240,
        RADIAL_K, RADIAL_P,
        boundsR = 50, proximity = 0.6,
    } = req;

    const N = bodies.length / 4;
    const K = seeds.length / 2;

    // Each seed contributes up to 2 directions × maxSteps segments,
    // each segment = 2 vertices × 3 floats.
    const maxFloats = K * 2 * maxSteps * 6;
    const verts = new Float32Array(maxFloats);
    let vIdx = 0, segCount = 0;

    const skipSun  = mode === 'noSun';
    const isJacobi = mode === 'jacobi';

    // Pre-fetch CR3BP body params for speed
    const sunGM = bodies[sunIndex * 4 + 3];
    const secX  = (isJacobi && secondaryIndex >= 0) ? bodies[secondaryIndex * 4 + 0] : 0;
    const secY  = (isJacobi && secondaryIndex >= 0) ? bodies[secondaryIndex * 4 + 1] : 0;
    const secGM = (isJacobi && secondaryIndex >= 0) ? bodies[secondaryIndex * 4 + 3] : 0;

    // Cache scene-space body positions for proximity culls (xy-only since
    // streamlines live on the ecliptic Y_scene = 0 slice).
    const bodySceneXY = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
        const auX = bodies[i*4 + 0], auY = bodies[i*4 + 1];
        const r_AU = Math.hypot(auX, auY);
        if (r_AU < 1e-9) { bodySceneXY[i*2] = 0; bodySceneXY[i*2+1] = 0; continue; }
        const r_render = Math.pow(r_AU, RADIAL_P) * RADIAL_K;
        const k = r_render / r_AU;
        bodySceneXY[i*2 + 0] =  auX * k;     // scene X
        bodySceneXY[i*2 + 1] = -auY * k;     // scene Z (note flip from auToScene)
    }

    // ── g at scene point in ecliptic (Y_scene = 0) ──
    function gAtScene(sX, sZ, out) {
        const rr2 = sX * sX + sZ * sZ;
        if (rr2 < 0.0001) { out.gx = 0; out.gz = 0; return; }
        const rr   = Math.sqrt(rr2);
        const r_AU = Math.pow(rr / RADIAL_K, 1 / RADIAL_P);
        const k    = rr / r_AU;
        const auX  =  sX / k;
        const auY  = -sZ / k;

        let gx = 0, gy = 0;

        if (isJacobi) {
            // Sun
            {
                const dx = -auX, dy = -auY;
                const r2 = dx*dx + dy*dy;
                if (r2 > 1e-12) {
                    const r1 = Math.sqrt(r2);
                    const inv = 1 / (r2 * r1);
                    gx += sunGM * dx * inv;
                    gy += sunGM * dy * inv;
                }
            }
            // Secondary
            if (secondaryIndex >= 0) {
                const dx = secX - auX, dy = secY - auY;
                const r2 = dx*dx + dy*dy;
                if (r2 > 1e-12) {
                    const r1 = Math.sqrt(r2);
                    const inv = 1 / (r2 * r1);
                    gx += secGM * dx * inv;
                    gy += secGM * dy * inv;
                }
            }
            gx += meanMotion2 * auX;
            gy += meanMotion2 * auY;
        } else {
            for (let i = 0; i < N; i++) {
                if (skipSun && i === sunIndex) continue;
                const bx = bodies[i*4 + 0];
                const by = bodies[i*4 + 1];
                const gm = bodies[i*4 + 3];
                const dx = bx - auX;
                const dy = by - auY;
                const r2 = dx*dx + dy*dy;
                if (r2 < 1e-10) continue;
                const r1 = Math.sqrt(r2);
                const inv = 1 / (r2 * r1);
                gx += gm * dx * inv;
                gy += gm * dy * inv;
            }
        }
        // Convert AU direction → scene direction (auToScene swaps Y↔Z and
        // flips Y; for the in-plane part we just flip the second axis).
        out.gx =  gx;
        out.gz = -gy;
    }

    function nearAnyBody(sX, sZ) {
        for (let i = 0; i < N; i++) {
            const bx = bodySceneXY[i*2], bz = bodySceneXY[i*2 + 1];
            const dx = sX - bx, dz = sZ - bz;
            if (dx*dx + dz*dz < proximity * proximity) return true;
        }
        // Also Sun at origin (just the absolute scene-zero check)
        if (sX*sX + sZ*sZ < proximity * proximity) return true;
        return false;
    }

    const tmp = { gx:0, gz:0 };

    function trace(startX, startZ, hSign) {
        let x = startX, z = startZ;
        const h = hSign * hStep;

        for (let i = 0; i < maxSteps; i++) {
            // RK4 of unit-normalised field
            gAtScene(x, z, tmp);
            let m1 = Math.hypot(tmp.gx, tmp.gz);
            if (m1 < 1e-30) return;
            const k1x = tmp.gx / m1, k1z = tmp.gz / m1;

            gAtScene(x + h*k1x/2, z + h*k1z/2, tmp);
            let m2 = Math.hypot(tmp.gx, tmp.gz);
            if (m2 < 1e-30) return;
            const k2x = tmp.gx / m2, k2z = tmp.gz / m2;

            gAtScene(x + h*k2x/2, z + h*k2z/2, tmp);
            let m3 = Math.hypot(tmp.gx, tmp.gz);
            if (m3 < 1e-30) return;
            const k3x = tmp.gx / m3, k3z = tmp.gz / m3;

            gAtScene(x + h*k3x, z + h*k3z, tmp);
            let m4 = Math.hypot(tmp.gx, tmp.gz);
            if (m4 < 1e-30) return;
            const k4x = tmp.gx / m4, k4z = tmp.gz / m4;

            const dx = (h/6) * (k1x + 2*k2x + 2*k3x + k4x);
            const dz = (h/6) * (k1z + 2*k2z + 2*k3z + k4z);
            const nx = x + dx, nz = z + dz;

            // Termination
            const newR2 = nx*nx + nz*nz;
            if (newR2 > boundsR * boundsR) return;
            if (nearAnyBody(nx, nz)) return;

            if (vIdx + 6 > maxFloats) return;
            // Emit segment (line segment from current to next point)
            verts[vIdx++] = x ; verts[vIdx++] = 0.06; verts[vIdx++] = z;
            verts[vIdx++] = nx; verts[vIdx++] = 0.06; verts[vIdx++] = nz;
            segCount++;

            x = nx; z = nz;
        }
    }

    for (let s = 0; s < K; s++) {
        const sx = seeds[s*2], sz = seeds[s*2 + 1];
        trace(sx, sz, +1);
        trace(sx, sz, -1);
    }

    // Slice to populated prefix and ship without transferring the parent
    // buffer (we still need the rest of the allocation to be GC'd cleanly).
    const out = verts.slice(0, vIdx);
    self.postMessage(
        {
            type: 'streamlines',
            jd, mode,
            vertices: out,
            segCount,
            runtimeMs: performance.now() - t0,
        },
        [out.buffer],
    );
}
