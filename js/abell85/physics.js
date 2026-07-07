// physics.js — semi-analytic SMBH binary evolution engine for the Abell 85 /
// Holm 15A / Abell 402-BCG "pair timeline" lab.
//
// The binary's orbital elements follow the standard staged model of massive
// black hole binary evolution (Begelman, Blandford & Rees 1980, Nature 287,
// 307; Merritt & Milosavljević 2005, Living Rev. Relativ. 8, 8):
//
//   1. approach   — Chandrasekhar (1943) dynamical friction sinks the nuclei
//   2. hardening  — three-body slingshot ejection, d(1/a)/dt = H·Gρ/σ
//                   (Quinlan 1996; Khan+ 2011/13; Vasiliev+ 2015 refill factor)
//   3. gw         — Peters (1964) orbit-averaged da/dt, de/dt
//   4. merger     — NR-calibrated remnant mass/spin (Hofmann+ fits) and
//                   recoil kick (González+ 2007 non-spinning; superkick cap
//                   from Campanelli+ 2007 / Lousto & Zlochower 2011)
//   5. recoil     — damped oscillation of the remnant through the cored
//                   potential (Gualandris & Merritt 2008)
//
// Stages 2 and 3 are summed continuously (da/dt = da/dt|stars + da/dt|gw)
// rather than hard-switched, which is how modern semi-analytic models treat
// the handoff. All numbers are in (pc, km/s, Msun, Myr) — see units.js.
//
// This module is DOM-free: it runs under plain Node for the unit tests in
// tests/abell85-physics.mjs.

import {
    G, C_KMS, KMS_MYR, MYR_S,
    keplerPeriodMyr, vCircKms, fGwHz, strainCircular, rGrav,
} from './units.js';

// ── Host galaxy: Dehnen (1993) sphere ───────────────────────────────────────
// ρ(r) = (3−γ) M a / (4π r^γ (r+a)^(4−γ)),  M(<r) = M (r/(r+a))^(3−γ)
// Closed forms keep the star-cluster module cheap and the maths checkable.

export function makeDehnen(mStar, aScale, gamma) {
    const g = Math.min(Math.max(gamma, 0), 1.99);
    const m3g = 3 - g;
    return {
        mStar, aScale, gamma: g,
        rho(r) {
            const rr = Math.max(r, 1e-6);
            return (m3g * mStar * aScale) /
                (4 * Math.PI * Math.pow(rr, g) * Math.pow(rr + aScale, 4 - g));
        },
        menc(r) {
            const rr = Math.max(r, 0);
            return mStar * Math.pow(rr / (rr + aScale), m3g);
        },
        phi(r) {
            // Dehnen (1993) eq. 5, γ ≠ 2
            const rr = Math.max(r, 1e-6);
            const x = rr / (rr + aScale);
            return -(G * mStar / aScale) * (1 / (2 - g)) * (1 - Math.pow(x, 2 - g));
        },
        vCirc(r) {
            const rr = Math.max(r, 1e-6);
            return Math.sqrt(G * this.menc(rr) / rr);
        },
        // Inverse of the cumulative mass fraction — used by the sampler.
        rOfMassFrac(f) {
            const y = Math.pow(Math.min(Math.max(f, 1e-9), 1 - 1e-9), 1 / m3g);
            return aScale * y / (1 - y);
        },
    };
}

/**
 * Pick the Dehnen scale radius so the enclosed stellar mass at rFit matches
 * an isothermal-sphere estimate M(<r) = 2 σ² r / G — this ties the analytic
 * host to the *measured* velocity dispersion instead of hand-tuning.
 */
export function fitDehnenScale(mStar, gamma, sigma, rFitPc = 3000) {
    const mTarget = Math.min(2 * sigma * sigma * rFitPc / G, 0.5 * mStar);
    const frac = mTarget / mStar;
    // M(<r)/M = (r/(r+a))^(3−γ)  →  a = r (1 − f^(1/(3−γ))) / f^(1/(3−γ))
    const y = Math.pow(frac, 1 / (3 - gamma));
    return rFitPc * (1 - y) / y;
}

// ── Scenario definitions ─────────────────────────────────────────────────────
// Observational anchors are cited inline; see ABELL85_PAIR_RESEARCH.md for the
// full provenance chain (and for why the "60-billion pair" is Abell 402-BCG,
// not Abell 85).

export const SCENARIOS = {
    // Abell 402-BCG candidate ultramassive pair (McDonald et al. 2026,
    // ApJL 1002, L19): total 60 ± 20 ×10⁹ M☉ (binary interpretation),
    // starless cavity ~1 kpc, flattened 2.2 kpc core, AGN relative velocity
    // ~370 km/s, ~4.4 Gly. σ and M* are NOT published — Holm 15A-like values
    // are adopted and flagged in the UI.
    a402: {
        id: 'a402',
        name: 'Abell 402-BCG — candidate pair (present day)',
        mTot: 6.0e10, q: 1.0,
        sigma: 340,               // ASSUMED (Holm 15A-like BCG)
        mStar: 2.0e12,            // ASSUMED (giant BCG)
        gamma0: 0.8,              // mildly cuspy pre-scouring remnant
        dMpc: 1350,               // ~4.4 Gly light-travel ≈ D_L ~ 1.35 Gpc scale
        a0: 1500,                 // pc — consistent with v_rel ≈ 370 km/s (projected)
        e0: 0.3,
        tPresentAtA0: true,       // t = 0 is "today", binary caught at a0
        refill: 0.6,              // triaxial loss-cone refill efficiency (0..1)
        eccH: 0.3,                // eccentricity carried through the hard phase
        kick: 'nonspinning',
        firstEncounterMyr: -600,  // nuclei begin sinking 600 Myr before present
    },
    // Holm 15A (Abell 85 BCG) reconstructed history. Present day = single
    // remnant. Progenitor binary mass is reverse-engineered so that
    // M_remnant(after GW losses) equals the measured mass.
    //   massModel 'liepold2025': 2.16e10 (triaxial, Keck KCWI — preferred)
    //   massModel 'mehrgan2019': 4.0e10  (axisymmetric, VLT/MUSE)
    holm15a: {
        id: 'holm15a',
        name: 'Holm 15A (Abell 85) — reconstructed history',
        massModel: 'liepold2025',
        mRemnantObs: 2.16e10,
        q: 1.0,
        sigma: 346,               // Mehrgan et al. 2019
        mStar: 2.0e12,            // Mehrgan et al. 2019
        gamma0: 1.0,              // pre-merger cusp being carved down
        dMpc: 250,                // z = 0.0555 → D_L ≈ 250 Mpc
        e0: 0.3,
        refill: 0.75,             // must be high enough to beat the final-parsec stall
        eccH: 0.3,
        kick: 'nonspinning',
        firstEncounterMyr: -8000, // last major dry merger ~8 Gyr ago (Rantala-like)
    },
    // B2 0402+379 / 4C+37.11 — the confirmed, *stalled* pair (Surti, Romani
    // et al. 2024: 2.8e10 combined at 7.3 pc, stalled ≳3 Gyr). Included as a
    // falsification preset: with spherical loss cones the model must stall too.
    b20402: {
        id: 'b20402',
        name: 'B2 0402+379 — the stalled pair (control)',
        mTot: 2.8e10, q: 1.0,
        sigma: 320,
        mStar: 1.5e12,
        gamma0: 0.6,
        dMpc: 230,
        a0: 7.3,
        e0: 0.1,
        tPresentAtA0: true,
        refill: 0.02,             // depleted spherical loss cone → stall
        eccH: 0.1,
        kick: 'nonspinning',
        firstEncounterMyr: -4000,
    },
};

export function makeScenario(id, overrides = {}) {
    const base = SCENARIOS[id];
    if (!base) throw new Error(`unknown scenario ${id}`);
    const sc = { ...base, ...overrides };

    if (sc.id === 'holm15a') {
        const obs = sc.massModel === 'mehrgan2019' ? 4.0e10 : 2.16e10;
        sc.mRemnantObs = overrides.mRemnantObs ?? obs;
        // Reverse-engineer the progenitor binary total from the measured
        // remnant: M_bin = M_obs / (1 − E_rad/Mc²).
        const eta = sc.q / Math.pow(1 + sc.q, 2);
        sc.mTot = sc.mRemnantObs / (1 - radiatedFraction(eta));
    }

    sc.m1 = sc.mTot / (1 + sc.q);
    sc.m2 = sc.mTot - sc.m1;                       // m2 ≤ m1
    sc.host = makeDehnen(sc.mStar, fitDehnenScale(sc.mStar, sc.gamma0, sc.sigma), sc.gamma0);
    sc.rInfl = G * sc.mTot / (sc.sigma * sc.sigma);            // pc
    sc.aHard = G * sc.m2 / (4 * sc.sigma * sc.sigma);          // Quinlan (1996)
    sc.aPlunge = 6 * rGrav(sc.mTot);                           // schematic ISCO handoff
    // Central escape speed: host (finite for γ<2) + BH potential evaluated at
    // a tenth of the influence radius (the scale a kicked remnant must climb
    // out of). Gives ~2000 km/s for Holm 15A-like parameters.
    sc.vEsc = Math.sqrt(2 * (Math.abs(sc.host.phi(1e-6))
        + G * sc.mTot / Math.max(0.1 * sc.rInfl, 1)));
    return sc;
}

// ── Merger remnant fits (non-spinning progenitors) ──────────────────────────

/** Radiated energy fraction E_rad/Mc² — quadratic-in-η fit to NR results
 *  (≈4.8% at q=1). */
export function radiatedFraction(eta) {
    return 0.0559 * eta + 0.478 * eta * eta;
}

/** Remnant dimensionless spin for non-spinning progenitors
 *  (cubic-in-η fit; 0.686 at q=1). */
export function remnantSpin(eta) {
    return 2 * Math.sqrt(3) * eta - 3.5171 * eta * eta + 2.5763 * eta * eta * eta;
}

/** Recoil kick magnitude [km/s].
 *  'nonspinning' — González et al. (2007) mass-asymmetry fit (0 at q=1,
 *  max ≈175 km/s near q≈0.36). 'superkick' — user-set magnitude standing in
 *  for in-plane anti-aligned spins (Campanelli+ 2007, up to ~4000–5000 km/s). */
export function recoilKick(eta, mode, superkickKms = 3000) {
    if (mode === 'superkick') return superkickKms;
    const dq = Math.sqrt(Math.max(0, 1 - 4 * eta));
    return 1.2e4 * eta * eta * dq * (1 - 0.93 * eta);
}

// ── Peters (1964) orbit-averaged GW decay ────────────────────────────────────

export function petersBeta(m1, m2) {
    // β = (64/5) G³ m1 m2 (m1+m2) / c⁵   [pc³ · km/s]
    const M = m1 + m2;
    return (64 / 5) * Math.pow(G, 3) * m1 * m2 * M / Math.pow(C_KMS, 5);
}

export function petersDaDt(a, e, beta) {   // pc/Myr (negative)
    const f = (1 + (73 / 24) * e * e + (37 / 96) * Math.pow(e, 4)) /
        Math.pow(1 - e * e, 3.5);
    return -(beta / (a * a * a)) * f * KMS_MYR;
}

export function petersDeDt(a, e, m1, m2) { // 1/Myr (negative)
    if (e <= 0) return 0;
    const M = m1 + m2;
    const k = (304 / 15) * Math.pow(G, 3) * m1 * m2 * M / Math.pow(C_KMS, 5);
    const f = (1 + (121 / 304) * e * e) / Math.pow(1 - e * e, 2.5);
    return -(k / Math.pow(a, 4)) * e * f * KMS_MYR;
}

/** Closed-form circular-orbit coalescence time [Myr] — validation target. */
export function petersTcMyr(a, m1, m2) {
    return Math.pow(a, 4) / (4 * petersBeta(m1, m2)) / KMS_MYR;
}

// ── Stage rates ──────────────────────────────────────────────────────────────

/** Chandrasekhar sink: separation of the two nuclei during the approach
 *  phase, isothermal-sphere closed form r(t) = r0 √(1 − t/t_df).
 *  t_df ≈ (19 Gyr / lnΛ)(r0/5 kpc)² (σ/200)(1e8/M)  (Binney & Tremaine). */
export function dynamicalFrictionTime(r0Pc, sigma, mSink, lnLambda = 8) {
    return (19000 / lnLambda) * Math.pow(r0Pc / 5000, 2)
        * (sigma / 200) * (1e8 / mSink);
}

/** Stellar-slingshot hardening rate s = d(1/a)/dt = H_eff G ρ_i / σ  [1/(pc·Myr)].
 *  H ≈ 16 (Quinlan 1996; Sesana & Khan 2015); `refill` ∈ (0,1] encodes how
 *  efficiently the loss cone is refilled (Vasiliev, Antonini & Merritt 2015:
 *  ~1 for triaxial, ≪1 for spherical — this is the final-parsec dial). */
export function hardeningRate(sc) {
    const rhoI = sc.host.rho(sc.rInfl);       // Msun/pc³
    const H = 16;
    return H * sc.refill * G * rhoI / sc.sigma * KMS_MYR;
}

// ── History builder ──────────────────────────────────────────────────────────
// Integrates the staged model over the full timeline and returns an array of
// adaptively spaced samples (dense where things change fast — which also makes
// the timeline scrubber "adaptive" for free) plus the merger/remnant record.

export const STAGE = {
    APPROACH: 'approach', HARDENING: 'hardening', GW: 'gw inspiral',
    MERGER: 'merger', RECOIL: 'recoil ringdown', QUIESCENT: 'quiescent',
    STALLED: 'stalled',
};

const MAX_SAMPLES = 24000;
const T_END_CAP = 14000;   // Myr past first encounter — Hubble-time cap

export function buildHistory(sc) {
    const samples = [];
    const events = { firstEncounter: sc.firstEncounterMyr };
    const beta = petersBeta(sc.m1, sc.m2);
    const sHard = hardeningRate(sc);
    const eta = sc.m1 * sc.m2 / (sc.mTot * sc.mTot);

    let t = sc.firstEncounterMyr;
    let stage = STAGE.APPROACH;
    let e = sc.e0;
    let phase = 0, peri = 0;
    let mej = 0;                       // ejected stellar mass, Msun

    // Approach phase: nuclei sink from r0 to the binary-formation radius.
    const r0 = sc.tPresentAtA0 && sc.a0 > sc.rInfl ? Math.max(5000, sc.a0 * 2) : 5000;
    const aBound = Math.min(sc.rInfl, r0);       // binary "forms" at ~r_infl
    const tDf = dynamicalFrictionTime(r0, sc.sigma, sc.m2);
    let a = r0;

    const push = (extra = {}) => {
        if (samples.length >= MAX_SAMPLES) return;
        const live = stage !== STAGE.APPROACH && a > 0 &&
            stage !== STAGE.RECOIL && stage !== STAGE.QUIESCENT;
        samples.push({
            t, a, e, stage, phase, peri, mej,
            // orbital period at this sample: lets sampleAt() extend the
            // accumulated phase WITHIN a segment, so the rendered orbital
            // phase is a pure deterministic function of t (no per-frame
            // accumulation → no wall-clock cadence dependence)
            p: a > 0 ? keplerPeriodMyr(a, sc.mTot) : 0,
            fgw: live ? fGwHz(a, sc.mTot) : 0,
            h: live ? strainCircular(sc.m1, sc.m2, a, sc.dMpc) : 0,
            ...extra,
        });
    };

    // — Stage 1: dynamical friction —
    {
        const nDf = 160;
        let tPrev = t;
        for (let i = 0; i <= nDf; i++) {
            const f = i / nDf;
            // r(t) = r0 √(1 − t/tDf), stop where r = aBound
            const fEnd = 1 - Math.pow(aBound / r0, 2);
            const tf = f * fEnd * tDf;
            t = sc.firstEncounterMyr + tf;
            a = r0 * Math.sqrt(Math.max(1 - tf / tDf, Math.pow(aBound / r0, 2)));
            // the sinking nuclei orbit as they spiral: accumulate their
            // circling deterministically at build time (same rule as the
            // hardening loop) instead of per rendered frame
            phase = (phase + 2 * Math.PI * (t - tPrev) /
                keplerPeriodMyr(Math.max(a, 1e-6), sc.mTot)) % (2 * Math.PI);
            tPrev = t;
            push();
        }
        events.binaryForms = t;
        stage = STAGE.HARDENING;
    }

    // — Stages 2+3: hardening + GW, summed continuously —
    // The expected cumulative scouring deficit is spread logarithmically over
    // the hard phase, totalling ~0.5 M_bin by GW handoff (Merritt 2006).
    e = sc.eccH;
    // handoff radius where |da/dt|_gw = |da/dt|_stars:  a^5 = β·KMS_MYR / s
    const aGwEqual = Math.pow(beta * KMS_MYR / Math.max(sHard, 1e-30), 1 / 5);
    const lnSpan = Math.max(Math.log(sc.aHard / Math.max(aGwEqual, sc.aPlunge)), 0.5);
    let stalled = false;

    let dtGuard = 0;
    while (a > sc.aPlunge && t < sc.firstEncounterMyr + T_END_CAP) {
        const daHard = -sHard * a * a;                       // d a/dt from d(1/a)/dt = s
        const daGw = petersDaDt(a, e, beta);
        const daTot = daHard + daGw;
        stage = Math.abs(daGw) > Math.abs(daHard) ? STAGE.GW : STAGE.HARDENING;
        if (stage === STAGE.GW && !events.gwTakeover) events.gwTakeover = t;

        // adaptive step: ≤1.5% change in a, capped
        let dt = Math.min(Math.abs(0.015 * a / daTot), 40);
        dt = Math.max(dt, 1e-9);
        if (++dtGuard > 400000) break;

        // eccentricity: constant through hardening, Peters decay once GW leads
        const de = stage === STAGE.GW ? petersDeDt(a, e, sc.m1, sc.m2) * dt : 0;
        // scouring bookkeeping (expected value; the live N-body measures its own)
        if (a <= sc.aHard && stage === STAGE.HARDENING) {
            const dLn = Math.abs(daTot * dt / a);
            mej = Math.min(mej + 0.5 * sc.mTot * dLn / lnSpan, 1.2 * sc.mTot);
        }

        const p = keplerPeriodMyr(a, sc.mTot);
        phase = (phase + 2 * Math.PI * dt / p) % (2 * Math.PI);
        // 1PN periapsis advance: Δϖ = 6πGM/(c²a(1−e²)) per orbit
        peri = (peri + (6 * Math.PI * G * sc.mTot /
            (C_KMS * C_KMS * a * (1 - e * e))) * (dt / p)) % (2 * Math.PI);

        a += daTot * dt;
        e = Math.max(0, Math.min(0.95, e + de));
        t += dt;

        // decimate: keep sample if a moved ≥0.4% or 60 Myr elapsed
        const last = samples[samples.length - 1];
        if (!last || Math.abs(a - last.a) / a > 0.004 || t - last.t > 60) push();
    }

    if (a > sc.aPlunge) {
        // Never reached coalescence inside the cap: the final-parsec stall.
        stage = STAGE.STALLED;
        stalled = true;
        events.stalledAt = { t, a };
        push();
        // pad a flat tail so the timeline shows the stall persisting
        for (let i = 1; i <= 40; i++) {
            t += 100; push();
        }
    } else {
        // — Stage 4: merger event —
        stage = STAGE.MERGER;
        events.merger = t;
        const eRad = radiatedFraction(eta);
        const mRem = sc.mTot * (1 - eRad);
        const spin = remnantSpin(eta);
        const vk = recoilKick(eta, sc.kick, sc.superkickKms);
        events.remnant = { mass: mRem, spin, kickKms: vk, eRadFrac: eRad };
        a = Math.min(a, sc.aPlunge); e = 0;
        push({ merger: true });
        a = 0;                      // binary no longer exists past this sample

        // — Stage 5: recoil oscillation (Gualandris & Merritt 2008 phase I–III,
        //   modeled as a damped harmonic oscillator in the cored potential) —
        stage = STAGE.RECOIL;
        const rhoCore = sc.host.rho(Math.max(0.5 * sc.rInfl, 100));
        const omega = Math.sqrt((4 * Math.PI / 3) * G * rhoCore) * KMS_MYR / 1; // 1/Myr-ish
        const tau = 300;                                    // Myr damping (DF)
        const ampl = vk / Math.max(omega, 1e-6) / KMS_MYR;  // pc
        events.recoil = { omega, tau, amplPc: ampl };
        const tRec = Math.min(6 * tau, 2500);
        for (let i = 1; i <= 160; i++) {
            t += tRec / 160;
            push({ remnantOffset: ampl * Math.exp(-(t - events.merger) / tau) });
        }

        // — quiescent tail to "now + a bit" —
        stage = STAGE.QUIESCENT;
        const tail = Math.max((sc.tPresentAtA0 ? t + 2000 : 500) - t, 500);
        for (let i = 1; i <= 24; i++) { t += tail / 24; push(); }
    }

    events.stalled = stalled;
    events.tEnd = t;
    // Timeline origin: scenarios anchored "at present" shift so t=0 is where
    // the binary matches the observed separation a0; history scenarios keep
    // t=0 at the merger-relative present set by firstEncounterMyr → i.e. the
    // samples already span [firstEncounter, end] with 0 = today.
    if (sc.tPresentAtA0 && sc.a0) {
        let tAt = samples[samples.length - 1].t;
        for (let i = 1; i < samples.length; i++) {
            if (samples[i].a <= sc.a0) { tAt = samples[i].t; break; }
        }
        for (const s of samples) s.t -= tAt;
        for (const k of ['binaryForms', 'gwTakeover', 'merger', 'tEnd']) {
            if (events[k] !== undefined) events[k] -= tAt;
        }
        if (events.stalledAt) events.stalledAt.t -= tAt;
        events.firstEncounter = samples[0].t;
    }
    return { samples, events, scenario: sc };
}

/** Binary-search interpolation of the history at time t. */
export function sampleAt(history, t) {
    const s = history.samples;
    if (t <= s[0].t) return { ...s[0] };
    if (t >= s[s.length - 1].t) return { ...s[s.length - 1] };
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (s[mid].t <= t) lo = mid; else hi = mid;
    }
    const A = s[lo], B = s[hi];
    const f = (t - A.t) / Math.max(B.t - A.t, 1e-12);
    const lerp = (x, y) => x + (y - x) * f;
    return {
        t,
        // a=0 marks "merged": never interpolate across the merger boundary
        a: (A.a <= 0 || B.a <= 0) ? 0
            : Math.exp(lerp(Math.log(A.a), Math.log(B.a))),
        e: lerp(A.e, B.e),
        mej: lerp(A.mej, B.mej),
        fgw: lerp(A.fgw, B.fgw),
        h: lerp(A.h, B.h),
        // phase: extend the build-time accumulation within the segment at
        // the segment's Kepler period — a pure function of t, so scrubbing
        // or replaying to the same epoch always shows the same orbital
        // configuration regardless of frame cadence or playback speed
        phase: A.p > 0
            ? (A.phase + 2 * Math.PI * (t - A.t) / A.p) % (2 * Math.PI)
            : B.phase,
        peri: B.peri,
        stage: f < 0.5 ? A.stage : B.stage,
        remnantOffset: lerp(A.remnantOffset ?? 0, B.remnantOffset ?? 0),
    };
}

/** Remaining Peters coalescence time from the current state (circular estimate
 *  corrected by the eccentricity enhancement factor). */
export function timeToCoalescence(sc, a, e) {
    const tc = petersTcMyr(a, sc.m1, sc.m2);
    return tc * Math.pow(1 - e * e, 3.5);
}
