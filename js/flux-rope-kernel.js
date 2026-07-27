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
    // Sheath (spec §14) — 0 δ disables the model entirely.
    sheathDeltaNt: 0,       // ambient Bz variability δ the shock compresses [nT]
    sheathK: 0.8,           // sheath thickness as a fraction of the rope radius
    bAmb1AuNt: 5,           // ambient Parker |B| at 1 AU [nT]
    frontC: 0,              // leading-edge compression c (spec §15) — 0 = off
    // Mach-dependent standoff η (spec §17): shell thickness becomes
    // η·FR(M)·√(σ_eff·d/2) and sheathK is ignored. 0 = legacy fixed-k
    // shell; literature anchor ≈ 1.1 for a quiet-wind blunt body.
    sheathEta: 0,
    // Pancaking aspect A (spec §18): elliptical cross-section with
    // semi-axes σ/√A (radial) and σ·√A (transverse). Area-preserving —
    // no field boost. 1 = circular; literature 1 AU aspects ~2–6.
    pancakeA: 1,
});

export const SPREAD_DEFAULTS = Object.freeze({
    sigLonDeg: 8, sigLatDeg: 5, sigTiltDeg: 20, sigV0Kms: 100,
    lnsigB: 0.25, lnsigSigma: 0.18, lnsigGamma: 0.4,
    sigTwist: 1.0, pFlip: 0.08,
});

/** CME–CME interaction config (spec §16) — engine-level, off by default. */
export const INTERACTION_DEFAULTS = Object.freeze({
    enabled: false,
    wakeGammaFrac: 0.5,   // follower drag reduction inside the leader's wake
    compC: 1.0,           // scale on the R–H-derived rear-compression amplitude
    compReach: 1.5,       // rear-compression gap ramp reach [units of leader σ̂]
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
        maxRopes: x.fr_max_ropes(),

        reset() { x.fr_init(); },

        /** Reset to a SINGLE rope launched at t=0 (v1 API, back-compat). */
        setRope(p = {}) {
            const r = { ...ROPE_DEFAULTS, ...p };
            x.fr_set_rope(
                r.lonDeg, r.latDeg, r.tiltDeg, r.handedness, r.twistTurns,
                r.b1AuNt, r.sigma1AuAu, r.nB, r.nSigma, r.d0Rsun,
                r.v0Kms, r.gammaPerKm, r.wKms,
                r.profile === 'lundquist' ? 1 : 0,
                r.sheathDeltaNt, r.sheathK, r.bAmb1AuNt, r.frontC, r.sheathEta, r.pancakeA,
            );
            return r;
        },

        // ── Rope trains (spec §10) ──────────────────────────────────────────
        clearRopes() { x.fr_clear_ropes(); },
        /** Append one rope; `launchOffsetS` is seconds after the reference
         *  epoch (t = 0). Returns the train size (capped at maxRopes). */
        pushRope(p = {}) {
            const r = { ...ROPE_DEFAULTS, launchOffsetS: 0, ...p };
            const n = x.fr_push_rope(
                r.lonDeg, r.latDeg, r.tiltDeg, r.handedness, r.twistTurns,
                r.b1AuNt, r.sigma1AuAu, r.nB, r.nSigma, r.d0Rsun,
                r.v0Kms, r.gammaPerKm, r.wKms,
                r.profile === 'lundquist' ? 1 : 0,
                r.sheathDeltaNt, r.sheathK, r.bAmb1AuNt, r.frontC, r.sheathEta, r.pancakeA,
                r.launchOffsetS,
            );
            return n;
        },
        /** Replace the whole train in one call. */
        setRopes(ropes) {
            x.fr_clear_ropes();
            for (const r of ropes) this.pushRope(r);
            return x.fr_rope_count();
        },
        ropeCount() { return x.fr_rope_count(); },
        ropeLaunchS(i) { return x.fr_rope_t_launch_s(i); },

        // ── CME–CME interaction (spec §16) ──────────────────────────────────
        /**
         * Configure interaction for ALL subsequent series/probe/ensemble
         * calls: wake kinematics for followers, dynamic rear compression of
         * leaders, wake-conditioned follower sheaths. Independent of the
         * rope list — set it per event; disabled is bit-identical to the
         * non-interacting train.
         */
        setInteraction(cfg = {}) {
            const c = { ...INTERACTION_DEFAULTS, ...cfg };
            x.fr_set_interaction(c.enabled ? 1 : 0, c.wakeGammaFrac, c.compC, c.compReach);
            return c;
        },
        /** EFFECTIVE ambient wind [km/s] of rope i (wake speed for a follower). */
        ropeWEffKms(i) { return x.fr_rope_w_eff_kms(i); },
        /** EFFECTIVE drag Γ [km⁻¹] of rope i (wake-reduced for a follower). */
        ropeGammaEff(i) { return x.fr_rope_gamma_eff(i); },

        // ── §16 compounding-analyzer probes (read-only) ─────────────────────
        /** Index of rope i's §16 leader (−1 = none; NaN out of range). */
        ropeLeader(i) { return x.fr_rope_leader(i); },
        /** Live §16 rear-compression amplitude on rope i at train time tS. */
        rearCAt(i, tS) { return x.fr_rear_c_at(i, tS); },
        /** Upstream flow [km/s] rope i's sheath Mach runs against at tS
         *  (the leader's live wake for a follower, own ambient otherwise). */
        upstreamKmsAt(i, tS) { return x.fr_upstream_kms_at(i, tS); },
        /** Fast-magnetosonic speed V_MS [km/s] (spec §14 constant). */
        vMsKms() { return x.fr_v_ms_kms(); },

        // Kinematics probes (page HUD + GLSL uniforms). t = seconds after the
        // reference epoch; index-free forms probe rope 0.
        apexKm(tS) { return x.fr_apex_km(tS); },
        apexVKms(tS) { return x.fr_apex_v_kms(tS); },
        sigmaApexKm(tS) { return x.fr_sigma_apex_km(tS); },
        apexKmAt(i, tS) { return x.fr_apex_km_at(i, tS); },
        apexVKmsAt(i, tS) { return x.fr_apex_v_kms_at(i, tS); },
        sigmaApexKmAt(i, tS) { return x.fr_sigma_apex_km_at(i, tS); },

        /**
         * Sample the TRAIN's superposed field at a heliocentric point [km]
         * (HELIOCENTRIC frame, not GSE — this is the 3D view's oracle).
         * → { bx, by, bz, count, inside } — count ≥ 2 flags rope overlap.
         */
        fieldAt(tS, xKm, yKm, zKm) {
            const v = copyF32(x.fr_field_at(tS, xKm, yKm, zKm), 4);
            return { bx: v[0], by: v[1], bz: v[2], count: v[3], inside: v[3] >= 1 };
        },

        /**
         * Deterministic virtual-spacecraft series: nSteps GSE samples from
         * t0S (seconds after the reference epoch) at dtS spacing.
         * → { bx, by, bz, inside: Float32Arrays, hits } — `inside` carries
         * the per-step rope-containment COUNT (0/1 for single ropes; ≥ 2
         * marks where the v1 no-interaction assumption breaks on trains).
         */
        series(t0S, dtS, nSteps, obs = L1_OBSERVER) {
            const n = Math.min(nSteps, this.maxSteps);
            const hits = x.fr_series(t0S, dtS, n, obs.rAu, obs.lonDeg, obs.latDeg);
            const raw = copyF32(x.fr_series_ptr(), 4 * n);
            const bx = new Float32Array(n), by = new Float32Array(n),
                bz = new Float32Array(n), inside = new Float32Array(n),
                sheath = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                bx[i] = raw[4 * i];
                by[i] = raw[4 * i + 1];
                bz[i] = raw[4 * i + 2];
                // count code = rope_count + 100·sheath_count (spec §14).
                const code = raw[4 * i + 3];
                inside[i] = code % 100;
                sheath[i] = Math.floor(code / 100);
            }
            return { bx, by, bz, inside, sheath, hits };
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
            const ropesPerMember = x.fr_ens_ropes_per_member();
            const pct = (k) => copyF32(x.fr_ens_bz_pct_ptr(k), steps);
            return {
                members, steps, ropesPerMember,
                pHit: x.fr_ens_p_hit(),
                bzPct: { p5: pct(0), p25: pct(1), p50: pct(2), p75: pct(3), p95: pct(4) },
                btMed: copyF32(x.fr_ens_bt_med_ptr(), steps),
                hitFrac: copyF32(x.fr_ens_hit_frac_ptr(), steps),
                arrivalH: copyF32(x.fr_ens_arrival_ptr(), members),
                minBz: copyF32(x.fr_ens_minbz_ptr(), members),
                // Per-member sampled params for envelope rendering:
                // [lonDeg, latDeg, tiltDeg, v0Kms, gammaPerKm, sigma1AuAu,
                //  handedness] × (members × ropesPerMember), member-major —
                // record (m, r) at (m·ropesPerMember + r)·stride.
                memberStride: stride,
                memberParams: copyF32(x.fr_ens_member_params_ptr(), members * ropesPerMember * stride),
                pMinBzBelow: (thr) => x.fr_ens_p_minbz_below(thr),
            };
        },

        /**
         * Particle-filter assimilation step (spec §11): condition the LAST
         * ensembleRun on observed Bz over grid indices [i0, i1). `obsBz` is
         * aligned index-for-index with the run's time grid (NaN = gap).
         * Gaussian reweighting with observation error sigmaNt (default 4 nT
         * — must also absorb the unmodeled ambient IMF). Reweight-only:
         * every call re-conditions the ORIGINAL prior on the full window,
         * so repeated calls (the advancing now-line) never accumulate
         * degeneracy. Returns the weighted fan + weights + ESS; call
         * assimReset() to drop back to the prior (bit-identical stats).
         */
        assimilate({ obsBz, i0 = 0, i1 = obsBz.length, sigmaNt = 4, essFloorFrac = 0.1 }) {
            const nWrite = Math.min(obsBz.length, this.maxSteps);
            // Fresh view per write — memory growth invalidates held views.
            new Float32Array(x.memory.buffer, x.fr_obs_ptr(), nWrite).set(obsBz.subarray(0, nWrite));
            const ess = x.fr_assimilate(i0, Math.min(i1, nWrite), sigmaNt, essFloorFrac);
            const steps = x.fr_ens_steps();
            const members = x.fr_ens_members();
            const pct = (k) => copyF32(x.fr_ens_bz_pct_ptr(k), steps);
            return {
                ess, members, steps,
                // λ ∈ (0,1]: <1 means the correlated-obs likelihood was
                // annealed to hold the ESS floor — show it, never hide it.
                temperature: x.fr_assim_temperature(),
                pHit: x.fr_ens_p_hit(),
                bzPct: { p5: pct(0), p25: pct(1), p50: pct(2), p75: pct(3), p95: pct(4) },
                btMed: copyF32(x.fr_ens_bt_med_ptr(), steps),
                hitFrac: copyF32(x.fr_ens_hit_frac_ptr(), steps),
                weights: copyF32(x.fr_ens_weights_ptr(), members),
                pMinBzBelow: (thr) => x.fr_ens_p_minbz_below(thr),
            };
        },

        /**
         * Auxiliary observer (STEREO-A, spec §13): set BEFORE ensembleRun so
         * member Bz at that position is recorded for joint conditioning.
         * Recording is RNG-free — the L1 prior is bit-identical either way.
         */
        setAuxObserver({ rAu, lonDeg, latDeg }) { x.fr_aux_set(rAu, lonDeg, latDeg); },
        clearAuxObserver() { x.fr_aux_clear(); },
        ensHasAux() { return x.fr_ens_has_aux() === 1; },

        /**
         * JOINT particle-filter update (spec §13): primary (L1) obs over
         * [i0, i1) PLUS auxiliary (STEREO-A) obs over [auxI0, auxI1) —
         * log-likelihoods summed, tempered once. Either window may be empty.
         * Same result shape as assimilate().
         */
        assimilateJoint({
            obsBz = null, i0 = 0, i1 = 0, sigmaNt = 4,
            auxObsBz = null, auxI0 = 0, auxI1 = 0, auxSigmaNt = 4,
            essFloorFrac = 0.1,
        }) {
            if (obsBz) {
                const nW = Math.min(obsBz.length, this.maxSteps);
                new Float32Array(x.memory.buffer, x.fr_obs_ptr(), nW).set(obsBz.subarray(0, nW));
                i1 = Math.min(i1, nW);
            }
            if (auxObsBz) {
                const nW = Math.min(auxObsBz.length, this.maxSteps);
                new Float32Array(x.memory.buffer, x.fr_obs_aux_ptr(), nW).set(auxObsBz.subarray(0, nW));
                auxI1 = Math.min(auxI1, nW);
            }
            const ess = x.fr_assimilate_joint(i0, obsBz ? i1 : 0, sigmaNt,
                auxI0, auxObsBz ? auxI1 : 0, auxSigmaNt, essFloorFrac);
            const steps = x.fr_ens_steps();
            const members = x.fr_ens_members();
            const pct = (k) => copyF32(x.fr_ens_bz_pct_ptr(k), steps);
            return {
                ess, members, steps,
                temperature: x.fr_assim_temperature(),
                pHit: x.fr_ens_p_hit(),
                bzPct: { p5: pct(0), p25: pct(1), p50: pct(2), p75: pct(3), p95: pct(4) },
                btMed: copyF32(x.fr_ens_bt_med_ptr(), steps),
                hitFrac: copyF32(x.fr_ens_hit_frac_ptr(), steps),
                weights: copyF32(x.fr_ens_weights_ptr(), members),
                pMinBzBelow: (thr) => x.fr_ens_p_minbz_below(thr),
            };
        },

        /** Drop assimilation weights → uniform prior (bit-identical stats). */
        assimReset() {
            x.fr_assim_reset();
        },

        /** Current effective sample size (member count when unweighted). */
        ess() { return x.fr_ens_ess(); },

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
