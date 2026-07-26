/**
 * tiga.js — Temporally Integrated Geomagnetic Assimilation.
 * ═══════════════════════════════════════════════════════════════════════════
 * A sequential Bayesian state estimator. Pure kernel: no DOM, no fetch, no
 * ambient time. `tests/geomag-tiga.mjs` is the gate.
 *
 * ── WHAT THIS IS, SAID PRECISELY ──────────────────────────────────────────
 *
 * A Kalman filter whose state is the degree-1 EXTERNAL Gauss coefficients
 * (q₁⁰, q₁¹, s₁¹) plus their rates, updated each minute from whichever
 * observatories reported.
 *
 * It is NOT a simulation. Nothing is integrated forward physically; the
 * "model" is an integrated random walk, which is a statistical prior, not
 * dynamics. It is NOT a forecast either: zero lead time. It is a NOWCAST —
 * what you have when L1 is unavailable — and it does not compete with
 * solar-wind-driven forecast models on their axis.
 *
 * ── AND SO IS Dst ─────────────────────────────────────────────────────────
 *
 * `classicalIndex` below is the same thing with one parameter, equal weights
 * and no memory. Retain only the zonal term and the cosine-weighted station
 * average IS the least-squares estimator of q₁⁰ — an algebraic identity,
 * exact to 10⁻¹⁴, checked here for every station subset. So the distinction
 * is not estimator-versus-index. Everything in this file is an estimator;
 * they differ in how many parameters they fit, how they weight stations, and
 * whether they carry a prior. Dst is the one-parameter, equal-weight,
 * no-memory degenerate case.
 *
 * That identity is load-bearing three ways:
 *
 *   • Dropout tolerance is ARCHITECTURAL, not trained. The observation
 *     operator H is rebuilt every epoch from whoever is present. That is why
 *     the dropout curve stays flat from 64 stations down to 3 — the knee sits
 *     at the fitted-parameter count, and there are three parameters.
 *   • There is an uncertainty to publish. A Bayesian estimator emits a
 *     posterior; neither Kyoto nor USGS publishes one. See the calibration
 *     warning on `TIGA` below — it is currently OPTIMISTIC and that is stated
 *     on the page, not hidden.
 *   • Estimation error can be separated from the index's own DEFINITION
 *     error, because the estimand is a physical coefficient rather than the
 *     index. In the OSSE that split is 4.30 nT of estimation error against
 *     11.36 nT of definition error. If TIGA estimated "SYM-H" directly the
 *     two would be inseparable.
 *
 * ── THE TRAP: TWO QUANTITIES ARE IN PLAY ──────────────────────────────────
 *
 * TIGA estimates q₁⁰. It gets SCORED against SYM-H — a specific six-station
 * arithmetic recipe that differs from q₁⁰ by ~11 nT of aliasing. Any results
 * table therefore carries TWO RMSEs, and CALIBRATION MUST BE JUDGED AGAINST
 * q₁⁰. Score a coefficient estimator against an index and you are measuring
 * the index.
 */

import { schmidtP } from './igrf.js';

const DEG = Math.PI / 180;

export { smLongitude, OMEGA_DEG_PER_MIN } from './dipole.js';

// ── Forward model ────────────────────────────────────────────────────────────

/**
 * One row of the forward model for the northward component X at the surface:
 *
 *     X = Σ_n Σ_m [ q_nm cos(mφ) + s_nm sin(mφ) ] dP_n^m/dθ
 *
 * Coefficients ordered [q10, q11, s11, q20, q21, s21, q22, s22, q30, …],
 * which is what `designRow(…, 3)` produces and what the OSSE truth field uses.
 *
 * At degree 1 this reduces to paper Eq. (1),
 *     X = −q₁⁰ cos λ + (q₁¹ cos φ + s₁¹ sin φ) sin λ,
 * and `tests/geomag-tiga.mjs` pins the reduction to 1e-12. That is not a
 * tautology: it checks the Schmidt recursion in igrf.js produces −cos λ and
 * sin λ where Eq. (1) says it should.
 *
 * @param {number} latDeg    DIPOLE latitude of the station
 * @param {number} smLonDeg  station longitude in the Sun-referenced frame
 * @param {number} [nmax=1]
 */
export function designRow(latDeg, smLonDeg, nmax = 1) {
    const th = (90 - latDeg) * DEG;
    const ph = smLonDeg * DEG;
    const { dP } = schmidtP(nmax, th);
    const row = [];
    for (let n = 1; n <= nmax; n++) {
        for (let m = 0; m <= n; m++) {
            if (m === 0) row.push(dP[n][0]);
            else {
                row.push(Math.cos(m * ph) * dP[n][m]);
                row.push(Math.sin(m * ph) * dP[n][m]);
            }
        }
    }
    return row;
}

/**
 * dP for one station, computed once.
 *
 * The θ-derivatives depend ONLY on latitude, and a station's latitude does not
 * change — but its SM longitude does, every minute. Hoisting the Legendre
 * recursion out of the epoch loop is worth roughly an order of magnitude over
 * a multi-day assimilation and changes no result: `designRowFrom` and
 * `designRow` share the same `schmidtP`, and the gate asserts they agree
 * exactly rather than approximately.
 */
export function precomputeDP(latDeg, nmax = 1) {
    return schmidtP(nmax, (90 - latDeg) * DEG).dP;
}

/** `designRow` against a cached dP table. Identical output, no recursion. */
export function designRowFrom(dP, smLonDeg, nmax = 1) {
    const ph = smLonDeg * DEG;
    const row = [];
    for (let n = 1; n <= nmax; n++) {
        for (let m = 0; m <= n; m++) {
            if (m === 0) row.push(dP[n][0]);
            else {
                row.push(Math.cos(m * ph) * dP[n][m]);
                row.push(Math.sin(m * ph) * dP[n][m]);
            }
        }
    }
    return row;
}

/** Number of coefficients a degree-`nmax` external expansion carries. */
export function coeffCount(nmax) {
    let k = 0;
    for (let n = 1; n <= nmax; n++) k += 2 * n + 1;
    return k;
}

// ── The classical index, written as the estimator it is ──────────────────────

/**
 * The Dst / SYM-H recipe: mean(X) / mean(cos λ), negated to index sign.
 *
 * With zonal-only truth this returns exactly −q₁⁰ for EVERY station subset —
 * the T3 identity, which `tests/geomag-tiga.mjs` gates at 1e-10 (it lands
 * near 1e-14). The classical index is not an alternative to a least-squares
 * fit; it IS one, with the order-1 columns deleted.
 *
 * @param {number[]} dipLatDeg station dipole latitudes
 * @param {number[]} xNt       northward-component disturbance at each station
 */
export function classicalIndex(dipLatDeg, xNt) {
    if (!dipLatDeg.length) return NaN;
    let sx = 0, sc = 0;
    for (let i = 0; i < dipLatDeg.length; i++) {
        sx += xNt[i];
        sc += Math.cos(dipLatDeg[i] * DEG);
    }
    return (sx / dipLatDeg.length) / (sc / dipLatDeg.length);
}

/**
 * Closed-form amplitude and UT phase of the order-1 aliasing into a classical
 * index built on a given station set.
 *
 * A partial ring current is fixed in magnetic LOCAL TIME; the station set is
 * fixed to the EARTH. So an asymmetric ring current does not alias into SYM-H
 * as a constant offset — it aliases as a 24-HOUR SINUSOID IN UT:
 *
 *     bias(α) = −A · mean_i[ sin λ_i · cos(φ_i + α − φ_peak) ] / mean_i[cos λ_i]
 *
 * with α advancing 360°/day, so sweeping α is sweeping UT. Amplitude is
 * A · |mean_i[ sin λ_i e^{iφ_i} ]| / mean_i[cos λ_i].
 *
 * The driver is visible in one line of algebra: the numerator is
 * mean(sin λ · e^{iφ}), so SOUTHERN STATIONS ENTER WITH OPPOSITE SIGN and
 * cancel northern ones. Hemispheric balance, not station count, sets the
 * amplitude. For a 100 nT ASY-H the all-northern SYM-H six gives ±50 nT and a
 * balanced six gives ±30 nT.
 *
 * @returns {{perUnitAsymmetry:number, phaseDeg:number}} amplitude in nT of
 *          index bias per 1 nT of asymmetric forcing, and its UT phase.
 */
export function aliasAmplitude(dipLatDeg, dipLonDeg) {
    let re = 0, im = 0, den = 0;
    for (let i = 0; i < dipLatDeg.length; i++) {
        const s = Math.sin(dipLatDeg[i] * DEG);
        re += s * Math.cos(dipLonDeg[i] * DEG);
        im += s * Math.sin(dipLonDeg[i] * DEG);
        den += Math.cos(dipLatDeg[i] * DEG);
    }
    const n = dipLatDeg.length;
    return {
        perUnitAsymmetry: Math.hypot(re / n, im / n) / (den / n),
        phaseDeg: ((Math.atan2(im, re) / DEG) % 360 + 360) % 360,
    };
}

// ── Small dense linear algebra (module-private) ──────────────────────────────

/** Solve A·X = B in place-safe fashion. A is n×n, B is n×m. Returns X (n×m). */
function solve(A, B, n, m) {
    const a = Float64Array.from(A);
    const b = Float64Array.from(B);
    for (let col = 0; col < n; col++) {
        let piv = col, best = Math.abs(a[col * n + col]);
        for (let r = col + 1; r < n; r++) {
            const v = Math.abs(a[r * n + col]);
            if (v > best) { best = v; piv = r; }
        }
        if (best < 1e-300) throw new Error('tiga: singular innovation covariance');
        if (piv !== col) {
            for (let k = 0; k < n; k++) { const t = a[col * n + k]; a[col * n + k] = a[piv * n + k]; a[piv * n + k] = t; }
            for (let k = 0; k < m; k++) { const t = b[col * m + k]; b[col * m + k] = b[piv * m + k]; b[piv * m + k] = t; }
        }
        const d = a[col * n + col];
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = a[r * n + col] / d;
            if (f === 0) continue;
            for (let k = col; k < n; k++) a[r * n + k] -= f * a[col * n + k];
            for (let k = 0; k < m; k++) b[r * m + k] -= f * b[col * m + k];
        }
    }
    for (let r = 0; r < n; r++) {
        const d = a[r * n + r];
        for (let k = 0; k < m; k++) b[r * m + k] /= d;
    }
    return b;
}

// ── The filter ───────────────────────────────────────────────────────────────

export const STATE_LABELS = Object.freeze(['q10', 'q11', 's11', 'dq10', 'dq11', 'ds11']);

/**
 * Default process-noise on the coefficient RATES, nT/min, one per coefficient.
 *
 * The order-1 terms are allowed to move faster than the zonal term because the
 * partial ring current evolves faster.
 *
 * ── DO NOT RETUNE THESE WITHOUT READING THIS ──────────────────────────────
 * These values were chosen BEFORE any result was seen, and four subsequent
 * refits — static equal-weight, static decoupled, innovation-adaptive, and a
 * held-out re-selection — all FAILED to beat a memoryless control on both the
 * zonal and the order-1 terms simultaneously. Every refit traded one for the
 * other. Loosening enough to track a partial ring current that develops in
 * ~40 minutes makes the zonal term too free; tightening back reinstates the
 * order-1 lag.
 *
 * The diagnosis is that the OPTIMAL process noise scales with storm amplitude,
 * so a value tuned on one storm does not transfer to a storm of a different
 * size. That is a defect in the SELECTION DESIGN, not in any particular value,
 * and the fix is a causal activity proxy trained on a multi-storm set — not a
 * new constant here. See TIGA_PLAN.md §Open problems.
 *
 * The original tuning is retained because it is the best of the candidates for
 * the ZONAL term, which is what SYM-H is, and because keeping a pre-registered
 * value is not overfitting.
 */
export const DEFAULT_Q_RATE = Object.freeze([0.9, 2.2, 2.2]);

export class TIGA {
    /**
     * @param {object} [opts]
     * @param {number} [opts.dtMin=1]      epoch spacing, minutes
     * @param {number[]} [opts.qRate]      rate process-noise std, nT/min
     * @param {number} [opts.qPos=0]       extra position process noise
     * @param {number} [opts.rho=0.999]    rate damping, so the state cannot run
     *                                     away through a long data gap
     * @param {number} [opts.huber=2.5]    robust reweighting threshold, σ units
     * @param {boolean} [opts.memoryless=false]
     *        Inflate process noise ~10⁶ so the prior holds nothing, reducing
     *        the Kalman update to per-epoch weighted least squares — which is
     *        what RC, VMD and every classical index do. This is THE CONTROL,
     *        and it is not optional scaffolding: a penalty that fades over
     *        48 h looked like a temporal-integration effect until the
     *        memoryless control faded identically. Build the null first.
     */
    constructor({ dtMin = 1, qRate = DEFAULT_Q_RATE, qPos = 0, rho = 0.999,
        huber = 2.5, memoryless = false } = {}) {
        this.dt = dtMin;
        this.rho = rho;
        this.huber = huber;
        this.memoryless = memoryless;
        this.qRate = memoryless ? qRate.map((s) => s * 1e3) : qRate.slice();

        // F: integrated random walk. Position advances by rate·dt; rate decays.
        // The rate term is what lets the estimate COAST along a trend through a
        // data gap instead of freezing — which matters most in storm main phase.
        const F = new Float64Array(36);
        for (let i = 0; i < 6; i++) F[i * 6 + i] = 1;
        for (let i = 0; i < 3; i++) F[i * 6 + (3 + i)] = dtMin;
        for (let i = 3; i < 6; i++) F[i * 6 + i] = memoryless ? 0 : rho;
        this.F = F;

        const Q = new Float64Array(36);
        for (let i = 0; i < 3; i++) {
            const s = this.qRate[i];
            Q[(3 + i) * 6 + (3 + i)] = s * s;
            Q[i * 6 + i] = (s * dtMin) ** 2 + qPos * qPos;
            Q[i * 6 + (3 + i)] = Q[(3 + i) * 6 + i] = 0.5 * s * s * dtMin;
        }
        this.Q = Q;

        this.x = new Float64Array(6);
        this.P = new Float64Array(36);
        const p0 = [1e4, 1e4, 1e4, 1e2, 1e2, 1e2];
        for (let i = 0; i < 6; i++) this.P[i * 6 + i] = p0[i];

        this.lastInnovation = null;
        this.lastUsed = 0;
    }

    /** Time update. */
    predict() {
        const { F, Q, P } = this;
        const x2 = new Float64Array(6);
        for (let i = 0; i < 6; i++) {
            let s = 0;
            for (let j = 0; j < 6; j++) s += F[i * 6 + j] * this.x[j];
            x2[i] = s;
        }
        this.x = x2;

        const FP = new Float64Array(36);
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++) s += F[i * 6 + k] * P[k * 6 + j];
            FP[i * 6 + j] = s;
        }
        const P2 = new Float64Array(36);
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++) s += FP[i * 6 + k] * F[j * 6 + k];
            P2[i * 6 + j] = s + Q[i * 6 + j];
        }
        this.P = P2;
    }

    /**
     * Measurement update from whichever stations reported this epoch.
     *
     * @param {number[][]} H3   (k×3) geometry rows for [q10, q11, s11]
     * @param {number[]}   d    (k) observed X disturbance, nT
     * @param {number[]}   rDiag (k) per-station observation variance, nT²
     * @param {number} [commonVar=0]
     *        Variance of the COMMON-MODE observation error, added as a rank-1
     *        term  R = diag(rDiag) + commonVar·11ᵀ.
     *
     *        ── THIS IS NOT A TUNING KNOB, IT IS A CORRECTNESS FIX ──
     *        Representativeness error — the degree≥2 field a degree-1 model
     *        cannot represent — measures ~10.4 nT RMS in the OSSE, five times
     *        the assumed instrument noise, and is CORRELATED AT 0.50 BETWEEN
     *        STATIONS. With a purely diagonal R the filter believes it averages
     *        that error down by √k. It does not, and the posterior becomes
     *        wildly overconfident: nominal 68% intervals covered 2.7%. Adding
     *        this rank-1 term (and scoring calibration against q₁⁰ rather than
     *        against the index) brought coverage to 44.6% / 98.4% for nominal
     *        68% / 95%.
     *
     *        Still optimistic at one sigma. That gap is the headline open
     *        problem and the page says so rather than quietly widening the bars.
     * @returns {number} stations used
     */
    update(H3, d, rDiag, commonVar = 0) {
        const k = d.length;
        this.lastUsed = k;
        if (k === 0) { this.lastInnovation = null; return 0; }

        const H = new Float64Array(k * 6);
        for (let i = 0; i < k; i++) for (let j = 0; j < 3; j++) H[i * 6 + j] = H3[i][j];

        let r = Float64Array.from(rDiag);

        // HP (k×6) then S (k×k) — recomputed inside the IRLS loop because r moves.
        const HP = new Float64Array(k * 6);
        const buildHP = () => {
            for (let i = 0; i < k; i++) for (let j = 0; j < 6; j++) {
                let s = 0;
                for (let m = 0; m < 6; m++) s += H[i * 6 + m] * this.P[m * 6 + j];
                HP[i * 6 + j] = s;
            }
        };
        buildHP();
        const buildS = (rr) => {
            const S = new Float64Array(k * k);
            for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
                let s = 0;
                for (let m = 0; m < 6; m++) s += HP[i * 6 + m] * H[j * 6 + m];
                S[i * k + j] = s + commonVar + (i === j ? rr[i] : 0);
            }
            return S;
        };

        const resid = new Float64Array(k);
        const residual = () => {
            for (let i = 0; i < k; i++) {
                let s = 0;
                for (let m = 0; m < 6; m++) s += H[i * 6 + m] * this.x[m];
                resid[i] = d[i] - s;
            }
        };
        residual();

        // ── IRLS Huber reweighting, two passes ──────────────────────────────
        // Ground magnetometers throw isolated spikes (lightning, spacecraft
        // charging events, a technician's screwdriver). A Gaussian filter chases
        // them. Down-weighting by inflating that station's variance keeps the
        // station in the fit instead of hard-rejecting it, which matters when
        // there are only three parameters and the network is thin.
        for (let pass = 0; pass < 2; pass++) {
            const S = buildS(r);
            const rNext = new Float64Array(k);
            for (let i = 0; i < k; i++) {
                const sd = Math.sqrt(Math.max(S[i * k + i], 1e-12));
                const w = Math.min(this.huber / Math.max(Math.abs(resid[i]) / sd, 1e-9), 1);
                rNext[i] = r[i] / Math.max(w, 1e-3);
            }
            r = rNext;
        }

        const S = buildS(r);
        // K = P Hᵀ S⁻¹ , obtained as (S⁻¹ H P)ᵀ = solve(S, HP)ᵀ.
        const SinvHP = solve(S, HP, k, 6);          // (k×6)
        const K = new Float64Array(6 * k);
        for (let i = 0; i < 6; i++) for (let j = 0; j < k; j++) K[i * k + j] = SinvHP[j * 6 + i];

        for (let i = 0; i < 6; i++) {
            let s = 0;
            for (let j = 0; j < k; j++) s += K[i * k + j] * resid[j];
            this.x[i] += s;
        }

        // Joseph form: P = (I−KH) P (I−KH)ᵀ + K R Kᵀ. Symmetric and positive
        // definite even when K is not the optimal gain — which it is not here,
        // because the IRLS pass moved R after K was computed.
        const IKH = new Float64Array(36);
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
            let s = i === j ? 1 : 0;
            for (let m = 0; m < k; m++) s -= K[i * k + m] * H[m * 6 + j];
            IKH[i * 6 + j] = s;
        }
        const A = new Float64Array(36);
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
            let s = 0;
            for (let m = 0; m < 6; m++) s += IKH[i * 6 + m] * this.P[m * 6 + j];
            A[i * 6 + j] = s;
        }
        const P2 = new Float64Array(36);
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
            let s = 0;
            for (let m = 0; m < 6; m++) s += A[i * 6 + m] * IKH[j * 6 + m];
            P2[i * 6 + j] = s;
        }
        // + K R Kᵀ with R = diag(r) + commonVar·11ᵀ
        for (let i = 0; i < 6; i++) {
            let ci = 0;
            for (let m = 0; m < k; m++) ci += K[i * k + m];
            for (let j = 0; j < 6; j++) {
                let s = 0;
                for (let m = 0; m < k; m++) s += K[i * k + m] * r[m] * K[j * k + m];
                let cj = 0;
                for (let m = 0; m < k; m++) cj += K[j * k + m];
                P2[i * 6 + j] += s + commonVar * ci * cj;
            }
        }
        this.P = P2;

        this.lastInnovation = Math.sqrt(resid.reduce((a, v) => a + v * v, 0) / k);
        return k;
    }

    /** [q10, q11, s11] in nT. */
    get coeffs() { return [this.x[0], this.x[1], this.x[2]]; }

    /** [dq10, dq11, ds11] in nT/min. */
    get rates() { return [this.x[3], this.x[4], this.x[5]]; }

    /** Posterior standard deviations of the three coefficients, nT. */
    get coeffSigma() {
        return [0, 1, 2].map((i) => Math.sqrt(Math.max(this.P[i * 6 + i], 0)));
    }

    /** Full 3×3 posterior covariance of [q10, q11, s11], row-major. */
    get coeffCov() {
        const C = new Float64Array(9);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] = this.P[i * 6 + j];
        return C;
    }

    /**
     * The zonal estimate expressed on the index's sign convention, with its
     * posterior. This is the number a nowcast publishes — and the σ is the
     * thing neither Kyoto nor USGS emits.
     *
     * The value is −q₁⁰, NOT "SYM-H": those differ by the index's own
     * definition error. Anything that compares the two must say which it means.
     */
    get zonalNt() { return -this.x[0]; }
    get zonalSigmaNt() { return Math.sqrt(Math.max(this.P[0], 0)); }

    /** Amplitude of the fitted asymmetry, nT — the order-1 (ASY-H-like) family. */
    get asymmetryNt() { return Math.hypot(this.x[1], this.x[2]); }

    /**
     * Magnetic local time, in hours, of the fitted partial-ring-current peak.
     * Storm-time values cluster near dusk, which is where the physics puts it —
     * an emergent check, not something the filter is told.
     */
    get asymmetryMlt() {
        const phi = Math.atan2(this.x[2], this.x[1]) / DEG;
        return (((phi + 360) % 360) / 15 + 12) % 24;
    }
}

/**
 * Run one epoch end to end: rebuild H from whoever is present, then update.
 *
 * Rebuilding H every epoch from the CURRENT roster is the whole dropout story.
 * Nothing here is trained on a station list, so losing stations degrades the
 * estimate and widens the posterior rather than breaking anything.
 *
 * @param {TIGA} filter
 * @param {Array<{dipLatDeg:number, dipLonDeg:number, xNt:number, varNt2:number}>} present
 * @param {number} minute  minutes since the run epoch, for the SM rotation
 * @param {number} commonVar
 */
export function assimilateEpoch(filter, present, minute, commonVar = 0) {
    filter.predict();
    if (!present.length) return 0;
    const H3 = [];
    const d = [];
    const r = [];
    for (const s of present) {
        const lon = ((s.dipLonDeg + (360 / 1440) * minute) % 360 + 360) % 360;
        H3.push(designRow(s.dipLatDeg, lon, 1));
        d.push(s.xNt);
        r.push(s.varNt2);
    }
    return filter.update(H3, d, r, commonVar);
}
