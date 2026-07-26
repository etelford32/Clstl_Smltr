/**
 * osse.js — Observing System Simulation Experiment for TIGA.
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure kernel, fully deterministic (its own PRNG — no Math.random, no ambient
 * time). Gate: `tests/geomag-osse.mjs`.
 *
 * ── WHY THE TRUTH FIELD IS DEGREE 3 AND THE FILTER IS DEGREE 1 ────────────
 * That gap is deliberate. If the truth were degree 1 we would be testing the
 * linear solver, not the method — the "inverse crime". The residual therefore
 * contains a genuine REPRESENTATIVENESS ERROR (the price of truncation), which
 * is one of the numbers we actually want: it measures ~10.4 nT RMS, five times
 * the assumed instrument noise, and is correlated at 0.50 between stations.
 * That correlation is what forces the rank-1 common-mode term in tiga.js.
 *
 * ── AND WHY THE TARGET IS NOT −q₁⁰ ────────────────────────────────────────
 * The scoring target is Kyoto's RECIPE applied to the truth field:
 *     SYM-H_true(t) = mean_i X_i / mean_i cos λ_i   over six canonical stations.
 * That is what SYM-H actually IS, so the target inherits the UT-periodic
 * aliasing — and that aliasing becomes a FLOOR no estimator of q₁⁰ can beat.
 *
 * `definitionFloor()` measures it at 11.36 nT against 4.30 nT of TIGA
 * estimation error. THE INDEX COSTS 2.6× MORE THAN THE ESTIMATOR. No number of
 * extra stations and no reduction in latency touches the first number — it is
 * what SYM-H is.
 *
 * ── STATED LIMITATION, NOT A BUG ──────────────────────────────────────────
 * `makeNetwork` draws synthetic station latitude and longitude INDEPENDENTLY,
 * which loses the real island/continent correlation. That is a limitation of
 * the OSSE, not of TIGA, and it is the reason the eleven CANONICAL stations
 * are real coordinates from the primary source rather than draws. Rebuilding
 * the synthetic tail from an authoritative station list is open work — see
 * TIGA_PLAN.md.
 */

import { designRow, designRowFrom, precomputeDP, TIGA, classicalIndex } from './tiga.js';
import { KYOTO_TABLE1, SYMH6_TYPICAL } from './observatories.js';
import { smLongitude } from './dipole.js';

/** Degree of the synthetic truth field. The filter fits degree 1. */
export const TRUTH_NMAX = 3;

/** Deterministic PRNG (mulberry32) — reproducibility is a protocol requirement. */
export function makeRng(seed = 20260726) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    return {
        uniform: next,
        range: (lo, hi) => lo + (hi - lo) * next(),
        /** Box–Muller normal. */
        normal() {
            if (spare !== null) { const s = spare; spare = null; return s; }
            let u = 0, v = 0;
            while (u === 0) u = next();
            while (v === 0) v = next();
            const r = Math.sqrt(-2 * Math.log(u));
            spare = r * Math.sin(2 * Math.PI * v);
            return r * Math.cos(2 * Math.PI * v);
        },
        /** Index from a normalised probability vector. */
        choice(p) {
            const x = next();
            let c = 0;
            for (let i = 0; i < p.length; i++) { c += p[i]; if (x < c) return i; }
            return p.length - 1;
        },
    };
}

/** The eleven canonical stations, in DIPOLE coordinates from Kyoto Table 1. */
export const CANONICAL = Object.freeze(Object.entries(KYOTO_TABLE1).map(([code, v]) =>
    Object.freeze({ code, lat: v.gmLatDeg, lon: v.gmLonDeg, canonical: true })));

/** Measured June-2026 distribution of the 75 usable real-time observatories. */
const LAT_BINS = [[0, 10, 8], [10, 20, 10], [20, 30, 13], [30, 40, 13], [40, 50, 31]];
const LON_BINS = [22, 3, 6, 8, 10, 2, 2, 1, 4, 5, 5, 7];   // 12 sectors of 30°
const FRAC_NORTH = 49 / 75;

/**
 * Eleven real canonical stations plus synthetic ones drawn to match the
 * measured latitude and longitude histograms.
 *
 * Note what the longitude histogram says: 22 of 75 stations sit in ONE 30°
 * sector (Europe/Africa) and the Pacific quadrant holds a handful. Coverage is
 * LONGITUDINALLY limited, not latitudinally — which is precisely what temporal
 * integration is for, since Earth's rotation sweeps each station through every
 * magnetic local time and a filter carrying state forward accumulates coverage
 * no single epoch possesses.
 */
export function makeNetwork(nTotal = 75, rng = makeRng()) {
    const st = CANONICAL.map((s) => ({ ...s }));
    const latP = LAT_BINS.map((b) => b[2]);
    const latSum = latP.reduce((a, b) => a + b, 0);
    const lonSum = LON_BINS.reduce((a, b) => a + b, 0);
    const latProb = latP.map((v) => v / latSum);
    const lonProb = LON_BINS.map((v) => v / lonSum);
    // Count the synthetic tail up front — `nTotal - st.length` as a loop bound
    // shrinks as the array fills and silently builds a 43-station network.
    const nSynthetic = Math.max(0, nTotal - st.length);
    for (let i = 0; i < nSynthetic; i++) {
        const b = LAT_BINS[rng.choice(latProb)];
        const mag = rng.range(b[0], b[1]);
        const lat = rng.uniform() < FRAC_NORTH ? mag : -mag;
        const k = rng.choice(lonProb);
        const lon = (k * 30 + rng.range(0, 30)) % 360;
        st.push({ code: `S${String(i).padStart(2, '0')}`, lat, lon, canonical: false });
    }
    return st;
}

/**
 * Degree-3 external truth field in the SM frame.
 *
 * Fully deterministic — no RNG. Returns a Float64Array laid out
 * [t][coeff] with 15 coefficients per epoch, ordered to match
 * `designRow(…, 3)`: [q10, q11, s11, q20, q21, s21, q22, s22, q30, …].
 *
 * The storm profile is a standard main-phase/recovery shape; the order-1 terms
 * peak at DUSK (SM longitude 270°) and decay faster than the zonal term,
 * because a partial ring current develops in ~40 minutes and dies sooner than
 * the symmetric ring.
 */
export function stormTruth(minutes, { stormPeak = -150 } = {}) {
    const T = minutes.length;
    const C = new Float64Array(T * 15);
    const t0 = 240, tauM = 55, tauR = 640;

    const shape = new Float64Array(T);
    let shapeMax = 0;
    const asyRaw = new Float64Array(T);
    let asyMax = 0;
    for (let i = 0; i < T; i++) {
        const u = Math.max(minutes[i] - t0, 0);
        shape[i] = (1 - Math.exp(-u / tauM)) * Math.exp(-u / tauR);
        if (shape[i] > shapeMax) shapeMax = shape[i];
        asyRaw[i] = (1 - Math.exp(-u / 40)) * Math.exp(-u / 260);
        if (asyRaw[i] > asyMax) asyMax = asyRaw[i];
    }

    const amp = -stormPeak;
    const php = (270 * Math.PI) / 180;
    const hiTerms = [
        [3, 0.0, 0.9], [4, 1.1, 0.6], [5, 2.0, 0.6], [6, 0.4, 0.4], [7, 2.7, 0.4],
        [8, 1.5, 0.35], [9, 0.8, 0.3], [10, 2.2, 0.3], [11, 0.2, 0.22],
        [12, 1.9, 0.22], [13, 2.5, 0.16], [14, 0.6, 0.16],
    ];
    for (let i = 0; i < T; i++) {
        const t = minutes[i];
        const s = shape[i] / shapeMax;
        C[i * 15 + 0] = amp * s + 6 * Math.sin((2 * Math.PI * t) / 1440) + 3;
        const asy = (asyRaw[i] / Math.max(asyMax, 1e-9)) * 0.55 * amp;
        C[i * 15 + 1] = asy * Math.cos(php);
        C[i * 15 + 2] = asy * Math.sin(php);
        // Degree 2 and 3: the structure a degree-1 filter CANNOT represent.
        const hi = 0.18 * amp * s;
        for (const [j, ph, sc] of hiTerms) {
            C[i * 15 + j] = sc * hi * Math.cos((2 * Math.PI * t) / (1440 * 1.7) + ph);
        }
    }
    return C;
}

/** Forward-model the northward disturbance at every station, every epoch. */
export function observe(stations, minutes, C, { noiseNt = 2, spikeRate = 1 / 4000,
    rng = makeRng(11) } = {}) {
    const T = minutes.length;
    const S = stations.length;
    const sig = new Float64Array(S);
    for (let j = 0; j < S; j++) sig[j] = rng.range(0.6, 1.8) * noiseNt;
    const out = new Float64Array(T * S);
    const dPc = stations.map((s2) => precomputeDP(s2.lat, TRUTH_NMAX));
    for (let i = 0; i < T; i++) {
        for (let j = 0; j < S; j++) {
            const row = designRowFrom(dPc[j], smLongitude(stations[j].lon, minutes[i]), TRUTH_NMAX);
            let v = 0;
            for (let k = 0; k < row.length; k++) v += row[k] * C[i * 15 + k];
            v += rng.normal() * sig[j];
            // Ground magnetometers throw isolated spikes. The Huber pass in
            // tiga.js exists because of these; without them it is untested.
            if (rng.uniform() < spikeRate) v += rng.normal() * 60;
            out[i * S + j] = v;
        }
    }
    return { obs: out, sigma: sig };
}

/** Kyoto's recipe applied to the truth field over the six canonical stations. */
export function trueSymH(stations, minutes, C, six = SYMH6_TYPICAL) {
    const idx = [];
    for (let j = 0; j < stations.length; j++) if (six.includes(stations[j].code)) idx.push(j);
    const lat = idx.map((j) => stations[j].lat);
    const dPc = new Map(idx.map((j) => [j, precomputeDP(stations[j].lat, TRUTH_NMAX)]));
    const out = new Float64Array(minutes.length);
    for (let i = 0; i < minutes.length; i++) {
        const X = idx.map((j) => {
            const row = designRowFrom(dPc.get(j), smLongitude(stations[j].lon, minutes[i]), TRUTH_NMAX);
            let v = 0;
            for (let k = 0; k < row.length; k++) v += row[k] * C[i * 15 + k];
            return v;
        });
        out[i] = classicalIndex(lat, X);
    }
    return out;
}

/** What SYM-H would be if the index were a perfect degree-1 zonal measure. */
export function zonalTruth(C, T) {
    const out = new Float64Array(T);
    for (let i = 0; i < T; i++) out[i] = -C[i * 15 + 0];
    return out;
}

/**
 * THE INDEX DEFINITION FLOOR: RMS(Kyoto recipe − pure zonal), both computed
 * from the SAME truth field.
 *
 * 11.36 nT. Irreducible. This is the aliasing of the order-1 and degree-2/3
 * field into a six-station average, and it is the single most important number
 * on the page, because it means the estimator's own error (4.30 nT) is 2.6×
 * SMALLER than the error in the definition it is scored against.
 *
 * Deterministic: it depends only on the six canonical stations' real
 * coordinates and the deterministic truth field, so it reproduces exactly.
 */
export function definitionFloor(stations, minutes, C, six = SYMH6_TYPICAL) {
    const y = trueSymH(stations, minutes, C, six);
    const z = zonalTruth(C, minutes.length);
    let s = 0, mx = 0;
    for (let i = 0; i < y.length; i++) {
        const d = y[i] - z[i];
        s += d * d;
        mx = Math.max(mx, Math.abs(d));
    }
    return { rmsNt: Math.sqrt(s / y.length), maxAbsNt: mx };
}

// ── The experiment ───────────────────────────────────────────────────────────

/** Least-squares affine fit y ≈ a·x + b over the first k samples. */
function affineFit(x, y, k) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < k; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
    const det = k * sxx - sx * sx;
    if (Math.abs(det) < 1e-300) return [1, 0];
    return [(k * sxy - sx * sy) / det, (sxx * sy - sx * sxy) / det];
}

/**
 * Run TIGA over the OSSE.
 *
 * ── THE FROZEN-CALIBRATION PROTOCOL IS LOAD-BEARING ──────────────────────
 * The affine calibration is fitted ONCE, on the training half of a reference
 * configuration, and then held FIXED for every other configuration — pass the
 * returned `calib` / `calibQ` back in.
 *
 * Refitting it per configuration lets the calibration silently absorb
 * dropout-induced bias. That is not hypothetical: on the first pass it
 * produced a dropout curve that IMPROVED as stations were removed. Freezing it
 * produced the real result — flat RMSE with a monotonically growing bias.
 * Bias, not variance, is the dropout signature.
 *
 * @param {object} cfg
 * @param {number} [cfg.dropProbability=0]  per-epoch random station dropout
 * @param {boolean[]} [cfg.permitted]       permanently permitted station mask
 * @param {number[]} [cfg.calib]            FROZEN index calibration [a, b]
 * @param {number[]} [cfg.calibQ]           FROZEN q₁⁰ calibration [a, b]
 * @param {boolean} [cfg.memoryless=false]  run THE CONTROL instead
 */
export function runOsse({
    stations, minutes, C, target, obs, sigma,
    permitted = null, dropProbability = 0, cutoffMin = null, lags = null,
    repVar = 54, commonVar = 54, trainFraction = 0.5,
    calib = null, calibQ = null, memoryless = false, rng = makeRng(1),
} = {}) {
    const T = minutes.length;
    const S = stations.length;
    const filter = new TIGA({ memoryless });
    const est = new Float64Array(T);
    const variance = new Float64Array(T);
    const used = new Float64Array(T);

    const base = new Array(S);
    for (let j = 0; j < S; j++) {
        base[j] = (permitted ? permitted[j] : true)
            && (cutoffMin === null || lags === null || lags[j] <= cutoffMin);
    }

    const dPc = stations.map((s2) => precomputeDP(s2.lat, 1));
    for (let i = 0; i < T; i++) {
        filter.predict();
        const H3 = [], d = [], r = [];
        for (let j = 0; j < S; j++) {
            if (!base[j]) continue;
            if (dropProbability > 0 && rng.uniform() <= dropProbability) continue;
            H3.push(designRowFrom(dPc[j], smLongitude(stations[j].lon, minutes[i]), 1));
            d.push(obs[i * S + j]);
            r.push(sigma[j] * sigma[j] + repVar);
        }
        if (d.length) filter.update(H3, d, r, commonVar);
        est[i] = -filter.x[0];
        variance[i] = filter.P[0];
        used[i] = d.length;
    }

    const k = Math.floor(T * trainFraction);
    const q10Truth = zonalTruth(C, T);
    const ab = calib ?? affineFit(est, target, k);
    const abq = calibQ ?? affineFit(est, q10Truth, k);

    let se = 0, sb = 0, seq = 0, sbq = 0, cov68 = 0, cov95 = 0, cov68Idx = 0, nUsed = 0;
    const n = T - k;
    const pred = new Float64Array(T);
    const sd = new Float64Array(T);
    for (let i = 0; i < T; i++) {
        pred[i] = ab[0] * est[i] + ab[1];
        sd[i] = Math.abs(abq[0]) * Math.sqrt(Math.max(variance[i], 0));
    }
    for (let i = k; i < T; i++) {
        const r = pred[i] - target[i];
        se += r * r; sb += r;
        const rq = (abq[0] * est[i] + abq[1]) - q10Truth[i];
        seq += rq * rq; sbq += rq;
        if (Math.abs(rq) <= sd[i]) cov68++;
        if (Math.abs(rq) <= 1.96 * sd[i]) cov95++;
        if (Math.abs(r) <= sd[i]) cov68Idx++;
        nUsed += used[i];
    }

    return {
        // Two RMSEs, always. The first is scored against Kyoto's six-station
        // recipe and therefore inherits that recipe's own aliasing; the second
        // is scored against the physical coefficient TIGA actually estimates.
        rmseIndexNt: Math.sqrt(se / n),
        biasIndexNt: sb / n,
        rmseQ10Nt: Math.sqrt(seq / n),
        biasQ10Nt: sbq / n,
        // Coverage is judged against q₁⁰. Judging it against the index would
        // charge the filter for the index's own definition error.
        coverage68: cov68 / n,
        coverage95: cov95 / n,
        coverage68AgainstIndex: cov68Idx / n,
        meanStations: nUsed / n,
        calib: ab, calibQ: abq, pred, sd, est, trainSamples: k,
    };
}

/** Measured June-2026 median-lag buckets: [minutes, station count]. */
export const LAG_BUCKETS = Object.freeze([[2, 15], [5, 19], [10, 19], [30, 12], [60, 2], [4320, 3]]);

/**
 * Assign each station a delivery lag.
 *
 * Latency is DELIVERY-limited, not compute-limited: two of the five
 * observatories behind the canonical real-time index show multi-day median lag
 * and must be reached bilaterally. The canonical index is slow because two of
 * its stations are slow — which makes latency and dropout tolerance ONE
 * trade-off surface, not two properties.
 */
export function assignLags(stations, rng = makeRng(4242)) {
    const total = LAG_BUCKETS.reduce((a, b) => a + b[1], 0);
    const p = LAG_BUCKETS.map((b) => b[1] / total);
    return stations.map(() => LAG_BUCKETS[rng.choice(p)][0]);
}
