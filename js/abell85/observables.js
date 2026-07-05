// observables.js — "what would a telescope see?" Mock observations computed
// from the live star cluster, so the simulation can be compared against the
// actual measurements of Holm 15A / Abell 402-BCG on their own terms:
//
//   · projected surface density Σ(R) (photometry, LOS = world z-axis)
//   · cusp radius r_γ — the radius where the projected log-slope reaches −1/2,
//     the Lauer/Carollo definition used by López-Cruz et al. (2014) to call
//     Holm 15A's r_γ = 4.57 kpc the largest core known
//   · IFU-style line-of-sight mean-velocity and dispersion maps (MUSE/KCWI
//     analogue) and an annular σ_LOS(R) profile
//
// All quantities are mass-weighted (constant M/L assumed — stated in the
// methods panel). DOM-free; unit-tested in Node.

import { mulberry32 } from './nbody.js';

/** Projected surface density of the live bound stars, log-R annuli.
 *  Returns [{R, sigma}] with Σ in Msun/pc². LOS = z; sky plane = (x, y). */
export function surfaceDensity(cluster, nBins = 26) {
    const rMin = Math.max(0.02 * cluster.sc.rInfl, 2);
    const rMax = cluster.rMax;
    const lgMin = Math.log10(rMin), lgMax = Math.log10(rMax);
    const counts = new Float64Array(nBins);
    const { pos, flags, n } = cluster;
    for (let i = 0; i < n; i++) {
        if (flags[i] === 1 || flags[i] === 2) continue;
        const j = i * 3;
        const R = Math.hypot(pos[j], pos[j + 1]);
        const b = Math.floor((Math.log10(Math.max(R, 1e-3)) - lgMin) / (lgMax - lgMin) * nBins);
        if (b >= 0 && b < nBins) counts[b]++;
    }
    return binsToSigma(counts, cluster.mParticle, nBins, lgMin, lgMax);
}

/** Σ(R) of the un-scoured initial model — deterministic sampling of the
 *  analytic host so the "before" curve is smooth and reproducible. */
export function initialSurfaceDensity(sc, rMax, nSamples = 16384, nBins = 26) {
    const rand = mulberry32(4157);
    const host = sc.host;
    const fMax = host.menc(rMax) / host.mStar;
    const rMin = Math.max(0.02 * sc.rInfl, 2);
    const lgMin = Math.log10(rMin), lgMax = Math.log10(rMax);
    const counts = new Float64Array(nBins);
    for (let i = 0; i < nSamples; i++) {
        const r = host.rOfMassFrac(rand() * fMax);
        const u = 2 * rand() - 1;                     // isotropic direction
        const R = r * Math.sqrt(1 - u * u);           // projected radius
        const b = Math.floor((Math.log10(Math.max(R, 1e-3)) - lgMin) / (lgMax - lgMin) * nBins);
        if (b >= 0 && b < nBins) counts[b]++;
    }
    const mPart = host.menc(rMax) / nSamples;
    return binsToSigma(counts, mPart, nBins, lgMin, lgMax);
}

function binsToSigma(counts, mParticle, nBins, lgMin, lgMax) {
    const out = [];
    for (let b = 0; b < nBins; b++) {
        const R0 = Math.pow(10, lgMin + (b / nBins) * (lgMax - lgMin));
        const R1 = Math.pow(10, lgMin + ((b + 1) / nBins) * (lgMax - lgMin));
        const area = Math.PI * (R1 * R1 - R0 * R0);
        out.push({ R: Math.sqrt(R0 * R1), sigma: counts[b] * mParticle / area, count: counts[b] });
    }
    return out;
}

/**
 * Cusp radius r_γ: the radius where the local projected log-slope
 * d ln Σ / d ln R first steepens through −1/2, walking outward. Slopes are
 * measured over a ±2-bin window to beat shot noise. NaN if never crossed.
 */
export function cuspRadius(prof) {
    const pts = prof.filter(p => p.sigma > 0 && p.count >= 5);
    if (pts.length < 6) return NaN;
    let prevSlope = null, prevR = null;
    for (let i = 2; i < pts.length - 2; i++) {
        const s = (Math.log10(pts[i + 2].sigma) - Math.log10(pts[i - 2].sigma)) /
            (Math.log10(pts[i + 2].R) - Math.log10(pts[i - 2].R));
        const R = pts[i].R;
        if (prevSlope !== null && prevSlope > -0.5 && s <= -0.5) {
            // log-interpolate the crossing
            const f = (-0.5 - prevSlope) / (s - prevSlope);
            return Math.pow(10, Math.log10(prevR) + f * (Math.log10(R) - Math.log10(prevR)));
        }
        prevSlope = s; prevR = R;
    }
    return NaN;
}

/**
 * IFU-analogue kinematic maps: mean line-of-sight velocity and dispersion on
 * an nPix×nPix grid covering ±extent pc in the sky plane.
 * Returns { v, disp, count, nPix, extent, vScale } (v, disp in km/s).
 */
export function losKinematics(cluster, extent, nPix = 23) {
    const v = new Float64Array(nPix * nPix);
    const v2 = new Float64Array(nPix * nPix);
    const count = new Int32Array(nPix * nPix);
    const { pos, vel, flags, n } = cluster;
    for (let i = 0; i < n; i++) {
        if (flags[i] === 1 || flags[i] === 2) continue;
        const j = i * 3;
        const px = Math.floor(((pos[j] + extent) / (2 * extent)) * nPix);
        const py = Math.floor(((pos[j + 1] + extent) / (2 * extent)) * nPix);
        if (px < 0 || px >= nPix || py < 0 || py >= nPix) continue;
        const k = py * nPix + px;
        v[k] += vel[j + 2]; v2[k] += vel[j + 2] * vel[j + 2]; count[k]++;
    }
    let vScale = 0;
    const disp = new Float64Array(nPix * nPix);
    for (let k = 0; k < nPix * nPix; k++) {
        if (count[k] >= 3) {
            v[k] /= count[k];
            disp[k] = Math.sqrt(Math.max(v2[k] / count[k] - v[k] * v[k], 0));
            vScale = Math.max(vScale, Math.abs(v[k]));
        } else { v[k] = NaN; disp[k] = NaN; }
    }
    return { v, disp, count, nPix, extent, vScale };
}

/** Annular σ_LOS(R) profile + central (innermost populated bins) value —
 *  the number a long-slit/IFU observer quotes as "the velocity dispersion". */
export function sigmaLosProfile(cluster, nBins = 14) {
    const rMin = Math.max(0.05 * cluster.sc.rInfl, 5);
    const rMax = cluster.rMax;
    const lgMin = Math.log10(rMin), lgMax = Math.log10(rMax);
    const sum = new Float64Array(nBins), sum2 = new Float64Array(nBins);
    const cnt = new Int32Array(nBins);
    const { pos, vel, flags, n } = cluster;
    for (let i = 0; i < n; i++) {
        if (flags[i] === 1 || flags[i] === 2) continue;
        const j = i * 3;
        const R = Math.hypot(pos[j], pos[j + 1]);
        let b = Math.floor((Math.log10(Math.max(R, 1e-3)) - lgMin) / (lgMax - lgMin) * nBins);
        if (b < 0) b = 0;
        if (b >= nBins) continue;
        sum[b] += vel[j + 2]; sum2[b] += vel[j + 2] * vel[j + 2]; cnt[b]++;
    }
    const out = [];
    for (let b = 0; b < nBins; b++) {
        if (cnt[b] < 8) { out.push({ R: NaN, sigma: NaN }); continue; }
        const mean = sum[b] / cnt[b];
        const sig = Math.sqrt(Math.max(sum2[b] / cnt[b] - mean * mean, 0));
        const R = Math.pow(10, lgMin + ((b + 0.5) / nBins) * (lgMax - lgMin));
        out.push({ R, sigma: sig });
    }
    // quotable central dispersion: aggregate over the inner aperture
    // (R < ½ r_infl) so a sparse innermost bin can't dominate the quote
    let cSum = 0, cSum2 = 0, cN = 0;
    const rAp = Math.max(0.5 * cluster.sc.rInfl, rMin * 2);
    for (let i = 0; i < n; i++) {
        if (flags[i] === 1 || flags[i] === 2) continue;
        const j = i * 3;
        if (Math.hypot(pos[j], pos[j + 1]) > rAp) continue;
        cSum += vel[j + 2]; cSum2 += vel[j + 2] * vel[j + 2]; cN++;
    }
    const central = cN >= 30
        ? Math.sqrt(Math.max(cSum2 / cN - (cSum / cN) ** 2, 0))
        : (out.find(p => Number.isFinite(p.sigma))?.sigma ?? NaN);
    return { profile: out, central, centralN: cN };
}

/**
 * Schematic PTA single-source sensitivity (order-of-magnitude, labeled
 * "approx." in the UI): best reach h ≈ 2×10⁻¹⁵ near f ≈ 4 nHz, degrading
 * ∝ f⁻¹·⁵ toward low frequencies (timing-model subtraction) and ∝ f^0.5
 * toward high frequencies (cadence). Anchored to the NANOGrav 15-yr scale
 * (Agazie et al. 2023).
 */
export function ptaSensitivity(fHz) {
    const fBest = 4e-9, hBest = 2e-15;
    if (!(fHz > 0)) return Infinity;
    return hBest * Math.max(Math.pow(fBest / fHz, 1.5), Math.pow(fHz / fBest, 0.5));
}
