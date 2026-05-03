/**
 * field-worker.js — Compute |g| on a 2-D ecliptic-plane grid for a
 * snapshot of the solar system, off the main thread.
 *
 * Protocol
 * ────────
 *   main → worker  { type:'compute', jd, resolution, gridHalfRender,
 *                    RADIAL_K, RADIAL_P, mode:'total'|'noSun',
 *                    bodies:Float32Array(N*4)  (x,y,z,gm) per body,
 *                    sunIndex:int }
 *   worker → main  { type:'field', jd, resolution,
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
 * `mode:'noSun'` excludes the body at index `sunIndex` so the colour
 * map shows only the planetary perturbative field — visually much
 * more striking than the dominant-Sun 1/r² wash.
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
            jd, resolution: R,
            gMag: out, domIdx: dom,
            gMin, gMax, gMean,
            runtimeMs: performance.now() - t0,
        },
        [out.buffer, dom.buffer],
    );
}
