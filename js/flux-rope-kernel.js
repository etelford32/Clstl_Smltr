/**
 * flux-rope-kernel.js — loader/wrapper for flux_rope_core.wasm.
 *
 * The kernel (rust-flux-rope/, crate flux-rope-core) is the Flux Rope
 * Simulator engine: 3DCORE-class tapered-torus CME rope, Gold-Hoyle /
 * Lundquist internal field, DBM kinematics, virtual-spacecraft in situ
 * synthesis, and a deterministic seeded ensemble (Bz percentile fans,
 * arrival distribution, threshold probabilities). Physics contract:
 * FLUX_ROPE_PHYSICS_SPEC.md. Gates: `cargo test` in rust-flux-rope/ and
 * `node tests/flux-rope-kernel-smoke.mjs` (pins the committed WASM against
 * the St. Patrick's 2015 hindcast).
 *
 * Loads from a URL (browser; instantiateStreaming with an ArrayBuffer
 * fallback) or from bytes (the Node smoke test). Every getter COPIES out of
 * WASM memory (.slice()) — ensemble runs may GROW wasm memory, which
 * invalidates held TypedArray views, so views are always taken fresh from
 * x.memory.buffer per call and copied immediately.
 *
 * Forecast output plugs into the universal driver contract via
 * `toDriverSeries()` → feed js/solar-wind-driver.js `fromArrays` with
 * source 'forecast'.
 */

export const ROPE_DEFAULTS = Object.freeze({
    lonDeg: 0, latDeg: 0, tiltDeg: 0,
    handedness: 1,          // ±1 chirality (+1 right-handed)
    twistTurns: 4,          // total field-line turns footpoint→footpoint
    b1AuNt: 20,             // axial field at 1 AU [nT]
    sigma1AuAu: 0.115,      // apex minor radius at 1 AU [AU]
    nB: 1.64,               // B falloff exponent
    nSigma: 1.14,           // expansion exponent
    d0Rsun: 21.5,           // launch apex distance [Rsun] (Enlil boundary)
    v0Kms: 800,             // launch apex speed [km/s]
    gammaPerKm: 0.2e-7,     // DBM drag Γ [km⁻¹]
    wKms: 400,              // ambient wind [km/s]
    profile: 'gold-hoyle',  // 'gold-hoyle' | 'lundquist'
});

export const SPREAD_DEFAULTS = Object.freeze({
    sigLonDeg: 8, sigLatDeg: 5, sigTiltDeg: 20, sigV0Kms: 100,
    lnsigB: 0.25, lnsigSigma: 0.18, lnsigGamma: 0.4,
    sigTwist: 1.0, pFlip: 0.08,
});

export const L1_OBSERVER = Object.freeze({ rAu: 0.99, lonDeg: 0, latDeg: 0 });

export async function loadFluxRopeKernel(source) {
    let instance;
    if (typeof source === 'string' || source instanceof URL) {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error(`flux-rope kernel fetch: HTTP ${resp.status}`);
        try {
            instance = (await WebAssembly.instantiateStreaming(resp.clone(), {})).instance;
        } catch {
            instance = (await WebAssembly.instantiate(await resp.arrayBuffer(), {})).instance;
        }
    } else {
        instance = (await WebAssembly.instantiate(source, {})).instance;
    }
    const x = instance.exports;
    x.fr_init();

    // Fresh view + copy per call — see header re: memory growth.
    const copyF32 = (ptr, n) => {
        if (!ptr) return new Float32Array(0);
        return new Float32Array(x.memory.buffer, ptr, n).slice();
    };

    return {
        maxSteps: x.fr_max_steps(),

        reset() { x.fr_init(); },

        /** Set the rope fit. Accepts a partial object over ROPE_DEFAULTS. */
        setRope(p = {}) {
            const r = { ...ROPE_DEFAULTS, ...p };
            x.fr_set_rope(
                r.lonDeg, r.latDeg, r.tiltDeg, r.handedness, r.twistTurns,
                r.b1AuNt, r.sigma1AuAu, r.nB, r.nSigma, r.d0Rsun,
                r.v0Kms, r.gammaPerKm, r.wKms,
                r.profile === 'lundquist' ? 1 : 0,
            );
            return r;
        },

        // Kinematics probes (page HUD + GLSL uniforms). t = seconds after launch.
        apexKm(tS) { return x.fr_apex_km(tS); },
        apexVKms(tS) { return x.fr_apex_v_kms(tS); },
        sigmaApexKm(tS) { return x.fr_sigma_apex_km(tS); },

        /**
         * Sample the rope field at a heliocentric point [km] (HELIOCENTRIC
         * frame, not GSE — this is the 3D view's oracle).
         * → { bx, by, bz, inside }
         */
        fieldAt(tS, xKm, yKm, zKm) {
            const v = copyF32(x.fr_field_at(tS, xKm, yKm, zKm), 4);
            return { bx: v[0], by: v[1], bz: v[2], inside: v[3] === 1 };
        },

        /**
         * Deterministic virtual-spacecraft series: nSteps GSE samples from
         * t0S (seconds after launch) at dtS spacing.
         * → { bx, by, bz, inside: Float32Arrays, hits }
         */
        series(t0S, dtS, nSteps, obs = L1_OBSERVER) {
            const n = Math.min(nSteps, this.maxSteps);
            const hits = x.fr_series(t0S, dtS, n, obs.rAu, obs.lonDeg, obs.latDeg);
            const raw = copyF32(x.fr_series_ptr(), 4 * n);
            const bx = new Float32Array(n), by = new Float32Array(n),
                bz = new Float32Array(n), inside = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                bx[i] = raw[4 * i];
                by[i] = raw[4 * i + 1];
                bz[i] = raw[4 * i + 2];
                inside[i] = raw[4 * i + 3];
            }
            return { bx, by, bz, inside, hits };
        },

        /** Set ensemble prior spreads (partial over SPREAD_DEFAULTS). */
        setSpreads(s = {}) {
            const v = { ...SPREAD_DEFAULTS, ...s };
            x.fr_set_spreads(
                v.sigLonDeg, v.sigLatDeg, v.sigTiltDeg, v.sigV0Kms,
                v.lnsigB, v.lnsigSigma, v.lnsigGamma, v.sigTwist, v.pFlip,
            );
            return v;
        },

        /**
         * Run the seeded ensemble on the same grid as series().
         * → { members, steps, pHit, bzPct: {p5,p25,p50,p75,p95}, btMed,
         *     hitFrac, arrivalH, minBz, pMinBzBelow(thr) }
         */
        ensembleRun(seed, nMembers, t0S, dtS, nSteps, obs = L1_OBSERVER) {
            const n = Math.min(nSteps, this.maxSteps);
            const members = x.fr_ens_run(seed, nMembers, t0S, dtS, n, obs.rAu, obs.lonDeg, obs.latDeg);
            const steps = x.fr_ens_steps();
            const stride = x.fr_ens_member_stride();
            const pct = (k) => copyF32(x.fr_ens_bz_pct_ptr(k), steps);
            return {
                members, steps,
                pHit: x.fr_ens_p_hit(),
                bzPct: { p5: pct(0), p25: pct(1), p50: pct(2), p75: pct(3), p95: pct(4) },
                btMed: copyF32(x.fr_ens_bt_med_ptr(), steps),
                hitFrac: copyF32(x.fr_ens_hit_frac_ptr(), steps),
                arrivalH: copyF32(x.fr_ens_arrival_ptr(), members),
                minBz: copyF32(x.fr_ens_minbz_ptr(), members),
                // Per-member sampled params for envelope rendering:
                // [lonDeg, latDeg, tiltDeg, v0Kms, gammaPerKm, sigma1AuAu,
                //  handedness] × members.
                memberStride: stride,
                memberParams: copyF32(x.fr_ens_member_params_ptr(), members * stride),
                pMinBzBelow: (thr) => x.fr_ens_p_minbz_below(thr),
            };
        },

        /**
         * Bridge to the universal driver contract: median-forecast samples
         * shaped for js/solar-wind-driver.js `fromArrays` (t in epoch ms via
         * launchEpochMs + grid).
         */
        toDriverSeries(ens, launchEpochMs, t0S, dtS) {
            const steps = ens.steps;
            const t = new Array(steps);
            for (let i = 0; i < steps; i++) t[i] = launchEpochMs + (t0S + i * dtS) * 1000;
            return { t, bz: Array.from(ens.bzPct.p50) };
        },
    };
}
