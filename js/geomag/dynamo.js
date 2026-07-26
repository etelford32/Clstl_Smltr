/**
 * dynamo.js — two REDUCED dynamo models. Not a geodynamo simulation.
 * ═══════════════════════════════════════════════════════════════════════════
 * Honest label, stated once and meant: a real 3-D MHD geodynamo needs a
 * supercomputer, and the best published runs still sit eight orders of
 * magnitude from Earth's Ekman number (core-model.js prints it: E ≈ 10⁻¹⁵,
 * Pm ≈ 10⁻⁶). Nothing in this file simulates the geodynamo. Both models are
 * small enough to run in a browser tab precisely BECAUSE they throw away
 * almost all of the physics — and both still answer a real question.
 *
 *   1. RIKITAKE two-disk dynamo. Three ODEs. The minimal system that
 *      self-excites and then reverses chaotically. Answers: does a reversal
 *      need a trigger? (No.)
 *
 *   2. αΩ MEAN-FIELD dynamo, a linear stability problem in latitude. A
 *      CONTROLLED EXPERIMENT: flip the equatorial symmetry of the α-effect and
 *      watch which magnetic parity is preferred. Answers: why a DIPOLE, and
 *      why AXIAL? (Rotation — but only inside a one-decade window.)
 *
 * Gate: `tests/geomag-dynamo.mjs`, pinned against the SciPy eigensolver the
 * research code used.
 */

// ── 1. Rikitake two-disk dynamo ──────────────────────────────────────────────

/**
 * ẋ = −μx + zy,   ẏ = −μy + (z−a)x,   ż = 1 − xy
 *
 * Classical RK4 at fixed step. The research code used adaptive RK45 at
 * rtol 1e-9 and counted 60 reversals over T = 500.
 *
 * ── WHY THE TEST DOES NOT PIN "60" ────────────────────────────────────────
 * This system is CHAOTIC. Trajectories with different integrators — or the
 * same integrator at a different tolerance — separate exponentially, so the
 * exact reversal count over t = 500 is not portable and pinning it would be
 * pinning an artefact of one solver. What IS portable, and what the test
 * gates, is the statistics: reversals happen without any forcing, chron
 * lengths are wildly irregular (max/min of order 5–10), and there is no
 * periodicity. That irregularity is the result.
 */
export function rikitakeStep(s, mu, a, dt) {
    const f = (v) => [
        -mu * v[0] + v[2] * v[1],
        -mu * v[1] + (v[2] - a) * v[0],
        1 - v[0] * v[1],
    ];
    const k1 = f(s);
    const s2 = [s[0] + 0.5 * dt * k1[0], s[1] + 0.5 * dt * k1[1], s[2] + 0.5 * dt * k1[2]];
    const k2 = f(s2);
    const s3 = [s[0] + 0.5 * dt * k2[0], s[1] + 0.5 * dt * k2[1], s[2] + 0.5 * dt * k2[2]];
    const k3 = f(s3);
    const s4 = [s[0] + dt * k3[0], s[1] + dt * k3[1], s[2] + dt * k3[2]];
    const k4 = f(s4);
    return [
        s[0] + (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
        s[1] + (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
        s[2] + (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]),
    ];
}

/**
 * Run the Rikitake dynamo and report its polarity history.
 *
 * @returns {{t:Float64Array, x:Float64Array, y:Float64Array, z:Float64Array,
 *            reversals:number, chrons:number[], meanChron:number,
 *            minChron:number, maxChron:number, irregularity:number}}
 */
export function runRikitake({ mu = 1, a = 5, T = 500, dt = 0.0025,
    s0 = [1, 1, 1], sample = 1, settle = 0.1 } = {}) {
    const nSteps = Math.round(T / dt);
    const nOut = Math.floor(nSteps / sample) + 1;
    const t = new Float64Array(nOut);
    const X = new Float64Array(nOut);
    const Y = new Float64Array(nOut);
    const Z = new Float64Array(nOut);
    let s = s0.slice();
    let k = 0;
    t[0] = 0; X[0] = s[0]; Y[0] = s[1]; Z[0] = s[2];
    for (let i = 1; i <= nSteps; i++) {
        s = rikitakeStep(s, mu, a, dt);
        if (i % sample === 0 && k + 1 < nOut) {
            k++;
            t[k] = i * dt; X[k] = s[0]; Y[k] = s[1]; Z[k] = s[2];
        }
    }

    const i0 = Math.floor(k * settle);
    const crossings = [];
    for (let i = i0 + 1; i <= k; i++) {
        if (X[i - 1] * X[i] < 0) crossings.push(t[i]);
    }
    const chrons = [];
    for (let i = 1; i < crossings.length; i++) chrons.push(crossings[i] - crossings[i - 1]);
    const mean = chrons.length ? chrons.reduce((p, c) => p + c, 0) / chrons.length : 0;
    const min = chrons.length ? Math.min(...chrons) : 0;
    const max = chrons.length ? Math.max(...chrons) : 0;
    return {
        t: t.subarray(0, k + 1), x: X.subarray(0, k + 1),
        y: Y.subarray(0, k + 1), z: Z.subarray(0, k + 1),
        reversals: crossings.length, chrons,
        meanChron: mean, minChron: min, maxChron: max,
        irregularity: min > 0 ? max / min : Infinity,
    };
}

// ── 2. αΩ mean-field parity selection ────────────────────────────────────────

/**
 * The model, on θ ∈ (0, π) with A = B = 0 at both poles:
 *
 *     ∂A/∂t = α(θ)·B + A″
 *     ∂B/∂t = D·A′    + B″
 *
 *   α(θ) = cos θ        antisymmetric about the equator — which is what
 *                       Coriolis-driven helicity actually gives, opposite
 *                       handedness in the two hemispheres.
 *   α(θ) = |cos θ|      symmetric. A deliberately UNPHYSICAL control. Without
 *                       it, "antisymmetric α gives a dipole" is an observation
 *                       about one run rather than a controlled result.
 *
 * ── HOW THE LEADING MODE IS FOUND, AND WHY NOT AN EIGENSOLVER ─────────────
 *
 * The research code called a dense LAPACK eigensolver on the 2N×2N matrix.
 * That is not available in a browser and a hand-rolled QR on an 800×800 matrix
 * would be both slow and a lot of code to get wrong.
 *
 * Instead this exploits a symmetry that is exact here. The operator commutes
 * with S: (A, B) → (A(π−θ), −B(π−θ)). So every mode is parity-PURE and the
 * spectrum splits cleanly into two families:
 *
 *     S = +1  →  A symmetric,  B antisymmetric  →  DIPOLE family
 *     S = −1  →  A antisymmetric, B symmetric   →  QUADRUPOLE family
 *
 * (This is why the reference eigensolver returns parity ±1.0000 and never
 * anything in between for the antisymmetric-α case.)
 *
 * Each family is an INVARIANT subspace, so the two are integrated separately
 * by explicit RK4 with re-projection onto the family every step, and the
 * leading growth rate of each is read off by power iteration. Which family
 * wins IS the parity result — and getting both growth rates separately is
 * strictly better than one eigensolve, because the window boundary is exactly
 * where the two cross, so `dipoleWindow()` can bisect on a smooth difference
 * instead of on a discontinuous parity flag.
 *
 * ── THE SPLIT DOES NOT HOLD FOR THE SYMMETRIC-α CONTROL ──────────────────
 * With α = |cos θ| the operator no longer commutes with S — the α term picks
 * up the wrong sign under reflection — and the modes are genuinely MIXED. The
 * reference eigensolver shows it: parity comes back 0.45, 0.03, 0.00 rather
 * than ±1. So `alphaOmegaParity` runs the symmetric case UNPROJECTED and
 * measures the parity of whatever mode wins, via `parityOf`. Projecting it
 * anyway does not merely bias the answer, it annihilates the solution and
 * reports a growth rate of exactly zero — which is how this was caught.
 *
 * Explicit RK4 is used rather than an implicit scheme on purpose: its
 * amplification factor tracks e^{λdt} to fourth order, so power iteration
 * converges to the mode of largest REAL part — the physically correct one.
 * An implicit scheme's amplification factor ranks modes by
 * σ − (dt/2)ω² instead, and would silently prefer a slower-growing,
 * slower-oscillating mode.
 */

/** Assemble α(θ) and the grid. */
function alphaGrid(N, alphaSym) {
    const h = Math.PI / (N + 1);
    const th = new Float64Array(N);
    const al = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        th[i] = (i + 1) * h;
        const c = Math.cos(th[i]);
        al[i] = alphaSym === 'symmetric' ? Math.abs(c) : c;
    }
    return { h, th, al };
}

/** y = M·v, with v laid out [A_0…A_{N−1}, B_0…B_{N−1}]. */
function applyM(v, out, N, h, al, D) {
    const ih2 = 1 / (h * h);
    const i2h = 1 / (2 * h);
    for (let i = 0; i < N; i++) {
        const am = i > 0 ? v[i - 1] : 0;
        const ap = i < N - 1 ? v[i + 1] : 0;
        const bm = i > 0 ? v[N + i - 1] : 0;
        const bp = i < N - 1 ? v[N + i + 1] : 0;
        out[i] = (am - 2 * v[i] + ap) * ih2 + al[i] * v[N + i];
        out[N + i] = D * (ap - am) * i2h + (bm - 2 * v[N + i] + bp) * ih2;
    }
}

/** Project onto the dipole (S=+1) or quadrupole (S=−1) family, in place. */
function projectFamily(v, N, family) {
    const dipole = family === 'dipole';
    for (let i = 0, j = N - 1; i <= j; i++, j--) {
        const a1 = v[i], a2 = v[j];
        const b1 = v[N + i], b2 = v[N + j];
        // A: symmetric for dipole, antisymmetric for quadrupole.
        const as = 0.5 * (a1 + a2);
        const aa = 0.5 * (a1 - a2);
        // B: antisymmetric for dipole, symmetric for quadrupole.
        const bs = 0.5 * (b1 + b2);
        const ba = 0.5 * (b1 - b2);
        if (dipole) {
            v[i] = as; v[j] = as;
            v[N + i] = ba; v[N + j] = -ba;
        } else {
            v[i] = aa; v[j] = -aa;
            v[N + i] = bs; v[N + j] = bs;
        }
    }
}

function norm(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s);
}

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

/** ρ(M) by power iteration — 40 matvecs, used only to size the RK4 step. */
function spectralRadius(n, N, h, al, D) {
    let v = seedVector(n);
    const w = new Float64Array(n);
    let r = 0;
    for (let it = 0; it < 40; it++) {
        applyM(v, w, N, h, al, D);
        r = norm(w);
        if (!(r > 0)) return 4 / (h * h);
        for (let i = 0; i < n; i++) v[i] = w[i] / r;
    }
    return r;
}

/** Deterministic pseudo-random seed vector — no Math.random anywhere. */
function seedVector(n) {
    const v = new Float64Array(n);
    let s = 20260726;
    for (let i = 0; i < n; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        v[i] = s / 0x7fffffff - 0.5;
    }
    return v;
}

/**
 * Symmetry of the TOROIDAL field about the equator, as an energy fraction:
 * +1 fully symmetric (quadrupole family), −1 fully antisymmetric (dipole
 * family), 0 an even mix.
 *
 * ── WHY THIS TAKES A SUBSPACE, NOT A VECTOR ──────────────────────────────
 * These modes OSCILLATE (Im λ ≈ 10–46, they are dynamo waves), so the leading
 * mode spans a 2-D real invariant subspace and any single real snapshot of it
 * is one phase of a rotation. For a parity-PURE mode that does not matter —
 * every phase is equally antisymmetric. For a MIXED mode it matters a lot: the
 * parity of one snapshot swings with time and is not a property of the mode.
 * Measuring symmetric-vs-antisymmetric ENERGY over an orthonormalised basis of
 * the subspace is phase-invariant, so it is well defined in both cases.
 *
 * @param {Float64Array[]} basis one or two real vectors spanning the mode
 */
export function parityOf(basis, N) {
    const vs = Array.isArray(basis) ? basis : [basis];
    // Gram–Schmidt so the energy ratio does not depend on how the two
    // snapshots happen to be scaled or skewed relative to each other.
    const orth = [];
    for (const v0 of vs) {
        const v = Float64Array.from(v0);
        for (const u of orth) {
            const d = dot(u, v);
            for (let i = 0; i < v.length; i++) v[i] -= d * u[i];
        }
        const nv = norm(v);
        if (nv > 1e-10) {
            for (let i = 0; i < v.length; i++) v[i] /= nv;
            orth.push(v);
        }
    }
    let sym = 0, anti = 0;
    for (const v of orth) {
        for (let i = 0; i < N; i++) {
            const b = v[N + i];
            const bR = v[N + (N - 1 - i)];
            sym += (0.5 * (b + bR)) ** 2;
            anti += (0.5 * (b - bR)) ** 2;
        }
    }
    const tot = sym + anti;
    return tot > 0 ? (sym - anti) / tot : 0;
}

/**
 * A mode counts as the dipole family only if it is CLEANLY antisymmetric.
 * Antisymmetric α produces parity −1.000; the symmetric control never gets
 * anywhere near it, landing mixed (|parity| ≲ 0.5) or frankly quadrupolar.
 * "Mixed" is not "dipole", and this threshold is what stops it being reported
 * as one.
 */
export const DIPOLE_PARITY_THRESHOLD = -0.5;

/**
 * Leading complex growth rate, optionally confined to one parity family.
 *
 * @param {number} D dynamo number
 * @param {object} [opts]
 * @param {'dipole'|'quadrupole'|null} [opts.family='dipole']
 *        null runs UNPROJECTED — required for the symmetric-α control, where
 *        the families do not decouple.
 * @param {number} [opts.tolerance=2e-3] relative agreement required between two
 *        successive estimates before the growth rate is called converged.
 * @returns {{growth:number, frequency:number, parity:number, converged:boolean,
 *            integratedTime:number, vector:Float64Array, N:number}}
 *          growth = Re λ, frequency = |Im λ| (a dynamo WAVE — these modes are
 *          oscillatory, which is why the reference eigenvalues are complex).
 *          `converged` false means the answer is NOT trustworthy; callers must
 *          say so rather than plot it.
 */
export function familyGrowth(D, {
    N = 160, alphaSym = 'antisymmetric', family = 'dipole',
    tSettle = 8, sampleDt = 0.02, tolerance = 2e-3, chunk = 6, maxRounds = 8,
} = {}) {
    const { h, al } = alphaGrid(N, alphaSym);
    const n = 2 * N;

    // ── Timestep from the MEASURED spectral radius, not from a guess ──────
    // RK4 is stable on the negative real axis out to |z| ≈ 2.785, and this
    // operator's spectrum is dominated by the diffusion blocks, so the step is
    // set by ρ(M). An analytic bound was tried first and was marginally WRONG:
    // 4/h² + |D|/h looks conservative but the variable α and the Dirichlet
    // boundaries push ρ above the constant-coefficient symbol estimate, and
    // the resulting step was stable to t ≈ 8 and blew up by t ≈ 30 — a Nyquist
    // grid mode masquerading as a growth rate of +69. Measuring ρ removes the
    // guess; 2.2 keeps ~20% margin.
    const rho = spectralRadius(n, N, h, al, D);
    const dt = Math.min(2.2 / rho, sampleDt / 4);

    let v = seedVector(n);
    if (family) projectFamily(v, N, family);
    const k1 = new Float64Array(n), k2 = new Float64Array(n);
    const k3 = new Float64Array(n), k4 = new Float64Array(n);
    const tmp = new Float64Array(n);

    const step = (u) => {
        applyM(u, k1, N, h, al, D);
        for (let i = 0; i < n; i++) tmp[i] = u[i] + 0.5 * dt * k1[i];
        applyM(tmp, k2, N, h, al, D);
        for (let i = 0; i < n; i++) tmp[i] = u[i] + 0.5 * dt * k2[i];
        applyM(tmp, k3, N, h, al, D);
        for (let i = 0; i < n; i++) tmp[i] = u[i] + dt * k3[i];
        applyM(tmp, k4, N, h, al, D);
        for (let i = 0; i < n; i++) {
            u[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
        }
        // Re-projection every step: the family is invariant analytically, so
        // this only removes round-off leakage into the other parity — but that
        // leakage grows exponentially if the other family is the faster one.
        if (family) projectFamily(u, N, family);
    };

    const advance = (t) => {
        const steps = Math.round(t / dt);
        for (let i = 0; i < steps; i++) {
            step(v);
            if ((i & 63) === 0) {
                const nv = norm(v);
                if (nv > 0) for (let j = 0; j < n; j++) v[j] /= nv;
            }
        }
        const nv0 = norm(v);
        if (nv0 > 0) for (let j = 0; j < n; j++) v[j] /= nv0;
    };

    const snapSteps = Math.max(1, Math.round(sampleDt / dt));
    const dtEff = snapSteps * dt;

    /** One estimate: three snapshots, sampleDt apart, on a COMMON scale. */
    const estimate = () => {
        const y0 = Float64Array.from(v);
        for (let i = 0; i < snapSteps; i++) step(v);
        const y1 = Float64Array.from(v);
        for (let i = 0; i < snapSteps; i++) step(v);
        const y2 = Float64Array.from(v);

        // Least squares for y2 = a·y1 + b·y0. The dominant conjugate pair spans
        // a 2-D real invariant subspace, so this recurrence is exact in it and
        // the roots of z² − az − b are e^{λΔt} and its conjugate.
        const m11 = dot(y1, y1), m12 = dot(y1, y0), m22 = dot(y0, y0);
        const r1 = dot(y1, y2), r2 = dot(y0, y2);
        const det = m11 * m22 - m12 * m12;
        // Collinearity of the two snapshots. A NON-oscillatory leading mode
        // makes y0 and y1 parallel, the 2×2 system singular, and the
        // least-squares branch pure noise — it returned μ = 1 exactly (growth 0)
        // for a mode genuinely decaying at −0.53. Guard on the CORRELATION, not
        // on |det|: a relative-|det| test misses it because det lands near
        // 1e-16, far above any absolute floor.
        const cosSq = (m12 * m12) / Math.max(m11 * m22, 1e-300);
        let growth, frequency;
        if (cosSq > 1 - 1e-9) {
            const mu = r1 / Math.max(m11, 1e-300);
            growth = Math.log(Math.max(Math.abs(mu), 1e-300)) / dtEff;
            frequency = 0;
        } else {
            const a = (r1 * m22 - r2 * m12) / det;
            const b = (m11 * r2 - m12 * r1) / det;
            const disc = a * a + 4 * b;
            if (disc >= 0) {
                const s = Math.sqrt(disc);
                const mu = Math.abs(0.5 * (a + s)) >= Math.abs(0.5 * (a - s))
                    ? 0.5 * (a + s) : 0.5 * (a - s);
                growth = Math.log(Math.abs(mu)) / dtEff;
                frequency = mu < 0 ? Math.PI / dtEff : 0;
            } else {
                const re = 0.5 * a;
                const im = 0.5 * Math.sqrt(-disc);
                growth = Math.log(Math.hypot(re, im)) / dtEff;
                frequency = Math.abs(Math.atan2(im, re)) / dtEff;
            }
        }
        return { growth, frequency, basis: [y1, y2] };
    };

    // ── Convergence loop, not a fixed settle budget ───────────────────────
    // A FIXED tSettle is not safe here. Where two real eigenvalues of one
    // family collide into a complex pair — for the quadrupole family that is
    // near |D| ≈ 220 — their separation vanishes and power iteration converges
    // arbitrarily slowly. At tSettle = 8 that produced a quadrupole growth rate
    // of +3.76 where the converged value is about −0.5, which inverted the
    // dipole/quadrupole comparison and put a SPURIOUS window edge at |D| ≈ 185
    // in a coarse sweep. Iterating until two successive estimates agree, and
    // reporting `converged` when they never do, is what stops that reaching a
    // caller as a confident number.
    advance(tSettle);
    let est = estimate();
    let converged = false;
    let elapsed = tSettle;
    for (let round = 0; round < maxRounds; round++) {
        advance(chunk);
        elapsed += chunk;
        const next = estimate();
        const scaleRef = Math.max(1, Math.abs(next.growth), Math.abs(est.growth));
        if (Math.abs(next.growth - est.growth) <= tolerance * scaleRef) {
            est = next;
            converged = true;
            break;
        }
        est = next;
    }

    return {
        growth: est.growth,
        frequency: est.frequency,
        vector: est.basis[1],
        basis: est.basis,
        parity: parityOf(est.basis, N),
        converged,
        integratedTime: elapsed,
        N,
    };
}

/**
 * THE CONTROLLED EXPERIMENT. Which magnetic parity does this α symmetry
 * prefer at this dynamo number?
 *
 * @returns {{preferred:'DIPOLE'|'QUADRUPOLE', parity:number,
 *            dipoleGrowth:number, quadrupoleGrowth:number,
 *            dipoleFrequency:number, quadrupoleFrequency:number, margin:number}}
 *          `parity` is −1 for the dipole family and +1 for the quadrupole
 *          family, matching the reference eigensolver's convention (it is the
 *          symmetry of the TOROIDAL field about the equator).
 */
export function alphaOmegaParity(D, opts = {}) {
    // Symmetric α: the families are coupled, so there is nothing to project
    // onto. Run once, unprojected, and measure the parity of whatever wins.
    if (opts.alphaSym === 'symmetric') {
        const r = familyGrowth(D, { ...opts, family: null });
        const p = r.parity;
        return {
            preferred: p < DIPOLE_PARITY_THRESHOLD ? 'DIPOLE' : 'QUADRUPOLE',
            parity: p,
            dipoleGrowth: NaN,
            quadrupoleGrowth: NaN,
            dipoleFrequency: NaN,
            quadrupoleFrequency: NaN,
            margin: NaN,
            growth: r.growth,
            frequency: r.frequency,
            converged: r.converged,
            mixed: true,
        };
    }
    const dip = familyGrowth(D, { ...opts, family: 'dipole' });
    const quad = familyGrowth(D, { ...opts, family: 'quadrupole' });
    const dipoleWins = dip.growth > quad.growth;
    return {
        preferred: dipoleWins ? 'DIPOLE' : 'QUADRUPOLE',
        parity: dipoleWins ? -1 : 1,
        dipoleGrowth: dip.growth,
        quadrupoleGrowth: quad.growth,
        dipoleFrequency: dip.frequency,
        quadrupoleFrequency: quad.frequency,
        margin: dip.growth - quad.growth,
        growth: dipoleWins ? dip.growth : quad.growth,
        frequency: dipoleWins ? dip.frequency : quad.frequency,
        // BOTH families must have converged before the comparison means
        // anything — the margin is a difference, so one bad estimate poisons it.
        converged: dip.converged && quad.converged,
        mixed: false,
    };
}

/**
 * The window of dynamo number in which an antisymmetric α actually prefers the
 * dipole — bisected on σ_dipole − σ_quadrupole, which is smooth and crosses
 * zero cleanly at each edge.
 *
 * ── THE RESULT, AND WHY IT MATTERS ────────────────────────────────────────
 * Roughly |D| = 116 to 1166. ONE DECADE. Weaker or stronger driving both give
 * a quadrupole.
 *
 * So a dipole is NOT inevitable. It requires the right symmetry AND the right
 * strength, and Earth happens to sit in the window. That is the same message
 * as the dipolar/multipolar transition found in full 3-D simulations, reached
 * here from a model that runs in a browser tab in under a second — which is
 * the honest version of "you can explore the dynamo", as opposed to claiming
 * to simulate one.
 *
 * A corollary worth stating on the page: the field's magnetism is
 * electromagnetic (currents, no permanent magnetisation anywhere below the
 * crust — see core-model.js CURIE_K), but its DIPOLARITY AND AXIALITY are
 * rotational. Coriolis → columnar flow → helicity of opposite sign per
 * hemisphere → antisymmetric α → dipole family. Remove the rotation and you
 * keep a magnetic field but lose the axial dipole.
 */
export function dipoleWindow({ N = 120, tolerance = 0.05, tSettle = 8,
    loBracket = [20, 400], hiBracket = [700, 2500] } = {}) {
    const margin = (D) => alphaOmegaParity(-Math.abs(D),
        { N, tSettle, alphaSym: 'antisymmetric' }).margin;
    const bisect = ([a, b]) => {
        let fa = margin(a);
        let lo = a, hi = b;
        for (let i = 0; i < 60 && hi - lo > tolerance; i++) {
            const mid = 0.5 * (lo + hi);
            const fm = margin(mid);
            if (fa * fm <= 0) { hi = mid; } else { lo = mid; fa = fm; }
        }
        return 0.5 * (lo + hi);
    };
    return { lower: bisect(loBracket), upper: bisect(hiBracket) };
}
