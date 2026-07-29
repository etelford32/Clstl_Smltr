/**
 * flux-rope-inversion.js — closed-form DBM inversion: per-event drag
 * retrieval for the daily trajectory-analysis ledger.
 *
 * The forward model (spec §5, Vršnak et al. 2013) is analytic:
 *   v(t) = w + Δv₀/(1 + Γ|Δv₀|t),  d(t) = d₀ + w·t + sgn·ln(1 + Γ|Δv₀|t)/Γ
 * so an OBSERVED transit inverts to the drag environment the CME actually
 * felt. Two modes:
 *
 *   invertGamma  — observed transit time T only, ambient w assumed:
 *                  the unique Γ ≥ 0 with d(T) = r_obs (1-D bisection).
 *   invertGammaW — transit time T AND arrival speed v_arr: solve the
 *                  (Γ, w) PAIR — the speed pins w through
 *                  Γ(w) = (Δv₀/Δv_arr − 1)/(|Δv₀|·T), the distance then
 *                  selects w (1-D bisection over w).
 *
 * Honesty rules: no solution → { ok:false, reason } (a ballistic
 * overshoot/undershoot the drag law cannot produce is REPORTED, never
 * forced); retrieval assumes the §5 single-regime transit, so events
 * flagged as §16/§19 interacting should be interpreted as the EFFECTIVE
 * drag environment (that is the point — the ledger's retrieved-Γ
 * distribution measures what the priors should have been).
 *
 * `retrievedPopulation` turns a season of retrievals into POPULATION
 * PRIORS: median + robust MAD spread of Γ (log-space, matching the
 * ensemble's log-normal Γ prior) and of w — the feedback loop that lets
 * the daily ledger recalibrate the engine's §7 spreads.
 *
 * Pure module: no DOM, no fetch, no ambient time. Node-gated by
 * tests/flux-rope-inversion.mjs (round-trips against the §5 closed form).
 */

export const AU_KM = 1.495978707e8;
export const RSUN_KM = 6.957e5;

/** Forward §5 closed form (mirror; the kernel remains the oracle). */
export function dbmApexKm(d0Km, v0Kms, wKms, gammaPerKm, tS) {
    const dv0 = v0Kms - wKms;
    if (Math.abs(gammaPerKm) < 1e-30 || dv0 === 0) return d0Km + v0Kms * tS;
    const sgn = Math.sign(dv0);
    return d0Km + wKms * tS + sgn * Math.log(1 + gammaPerKm * Math.abs(dv0) * tS) / gammaPerKm;
}

/** Forward §5 apex speed. */
export function dbmSpeedKms(v0Kms, wKms, gammaPerKm, tS) {
    const dv0 = v0Kms - wKms;
    if (Math.abs(gammaPerKm) < 1e-30 || dv0 === 0) return v0Kms;
    return wKms + dv0 / (1 + gammaPerKm * Math.abs(dv0) * tS);
}

const GAMMA_MAX = 5e-7;   // [km⁻¹] — far above the literature 2e-7 ceiling

/**
 * Mode 1: retrieve Γ from the observed transit time alone (w assumed).
 * @param {object} a { d0Km, v0Kms, wKms, transitS, rObsKm = 0.99 AU }
 * @returns {{ ok, gammaPerKm?, reason? }}
 */
export function invertGamma({ d0Km = 21.5 * RSUN_KM, v0Kms, wKms = 400, transitS, rObsKm = 0.99 * AU_KM }) {
    if (!(transitS > 0) || !Number.isFinite(v0Kms)) {
        return { ok: false, reason: 'bad-inputs' };
    }
    const d = (g) => dbmApexKm(d0Km, v0Kms, wKms, g, transitS);
    const d0 = d(0);            // ballistic (Γ = 0)
    const dMax = d(GAMMA_MAX);  // maximal drag
    // Deceleration case (v0 > w): distance decreases with Γ; acceleration
    // case: increases. Either way the reachable band is [min, max].
    const lo = Math.min(d0, dMax), hi = Math.max(d0, dMax);
    if (rObsKm > hi + 1) {
        return { ok: false, reason: 'transit-faster-than-ballistic' };
    }
    if (rObsKm < lo - 1) {
        return { ok: false, reason: 'transit-slower-than-max-drag' };
    }
    let gLo = 0, gHi = GAMMA_MAX;
    for (let i = 0; i < 200; i++) {
        const mid = 0.5 * (gLo + gHi);
        // Monotone toward rObs: pick the branch by the deceleration sign.
        if ((d(mid) > rObsKm) === (d0 > dMax)) gLo = mid;
        else gHi = mid;
    }
    return { ok: true, gammaPerKm: 0.5 * (gLo + gHi) };
}

/**
 * Mode 2: retrieve the (Γ, w) PAIR from transit time + arrival speed.
 * The arrival speed gives Γ as a function of w in closed form:
 *   Δv_arr = Δv₀/(1 + Γ|Δv₀|T)  ⇒  Γ(w) = (Δv₀/Δv_arr − 1)/(|Δv₀|·T)
 * valid while Δv₀ and Δv_arr share a sign and |Δv_arr| ≤ |Δv₀| (drag only
 * moves v TOWARD w). The transit distance then selects w by bisection.
 * @param {object} a { d0Km, v0Kms, transitS, vArrKms, rObsKm,
 *                     wLoKms = 250, wHiKms = 750 }
 */
export function invertGammaW({
    d0Km = 21.5 * RSUN_KM, v0Kms, transitS, vArrKms, rObsKm = 0.99 * AU_KM,
    wLoKms = 250, wHiKms = 750,
}) {
    if (!(transitS > 0) || !Number.isFinite(v0Kms) || !Number.isFinite(vArrKms)) {
        return { ok: false, reason: 'bad-inputs' };
    }
    // Drag moves v monotonically toward w: w must sit on the far side of
    // v_arr from v0 (or equal). Constrain the bracket accordingly.
    let lo = wLoKms, hi = wHiKms;
    if (v0Kms > vArrKms) hi = Math.min(hi, vArrKms - 1);        // decelerated
    else if (v0Kms < vArrKms) lo = Math.max(lo, vArrKms + 1);   // accelerated
    else return { ok: false, reason: 'zero-net-drag-degenerate' };
    if (!(lo < hi)) return { ok: false, reason: 'arrival-speed-outside-ambient-band' };

    const gammaOf = (w) => {
        const dv0 = v0Kms - w, dva = vArrKms - w;
        if (dv0 === 0 || dva === 0 || Math.sign(dv0) !== Math.sign(dva)) return NaN;
        const g = (dv0 / dva - 1) / (Math.abs(dv0) * transitS);
        return g >= 0 && g <= GAMMA_MAX ? g : NaN;
    };
    const dist = (w) => {
        const g = gammaOf(w);
        return Number.isFinite(g) ? dbmApexKm(d0Km, v0Kms, w, g, transitS) : NaN;
    };
    // Γ(w) diverges as w → v_arr (the bracket edge), so d(w) is only
    // defined on a SUB-bracket: scan for a sign change of d − r_obs over
    // the valid points, then bisect inside it. No crossing → honest
    // refusal (the observed transit/speed pair is outside what a §5 drag
    // law can produce).
    const N = 128;
    let prev = null;
    let w = NaN;
    for (let k = 0; k <= N; k++) {
        const wk = lo + ((hi - lo) * k) / N;
        const dk = dist(wk);
        if (!Number.isFinite(dk)) { prev = null; continue; }
        if (prev && (prev.d - rObsKm) * (dk - rObsKm) <= 0) {
            const incr = dk > prev.d;
            let a = prev.w, b = wk;
            for (let i = 0; i < 200; i++) {
                const mid = 0.5 * (a + b);
                const dm = dist(mid);
                if (!Number.isFinite(dm)) { b = mid; continue; }
                if ((dm < rObsKm) === incr) a = mid;
                else b = mid;
            }
            w = 0.5 * (a + b);
            break;
        }
        prev = { w: wk, d: dk };
    }
    if (!Number.isFinite(w)) {
        return { ok: false, reason: 'distance-outside-reachable-band' };
    }
    const g = gammaOf(w);
    if (!Number.isFinite(g)) return { ok: false, reason: 'no-consistent-drag-solution' };
    return { ok: true, gammaPerKm: g, wKms: w };
}

/** Median of finite values (NaN on empty). */
function median(vals) {
    const a = vals.filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/**
 * Population priors from a season of retrievals: median + robust MAD-σ of
 * ln Γ (matching the ensemble's log-normal Γ prior — `lnsigGamma` is
 * directly comparable to SPREAD_DEFAULTS.lnsigGamma) and of w. Needs ≥
 * `minEvents` ok-retrievals to speak at all.
 */
export function retrievedPopulation(retrievals, { minEvents = 5 } = {}) {
    const ok = (retrievals ?? []).filter((r) => r?.ok && Number.isFinite(r.gammaPerKm));
    if (ok.length < minEvents) {
        return { ok: false, n: ok.length, reason: `need ≥${minEvents} retrievals` };
    }
    const lnG = ok.map((r) => Math.log(Math.max(1e-12, r.gammaPerKm)));
    const gMed = median(lnG);
    const lnsigGamma = 1.4826 * median(lnG.map((v) => Math.abs(v - gMed)));
    const ws = ok.map((r) => r.wKms).filter(Number.isFinite);
    const wMed = median(ws);
    const sigW = ws.length >= minEvents
        ? 1.4826 * median(ws.map((v) => Math.abs(v - wMed)))
        : NaN;
    return {
        ok: true,
        n: ok.length,
        gammaMedianPerKm: Math.exp(gMed),
        lnsigGamma,
        wMedianKms: wMed,
        sigWKms: sigW,
    };
}
