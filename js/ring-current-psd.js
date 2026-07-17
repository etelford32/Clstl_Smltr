/**
 * Phase-space-density radial profiles from the ring-current transport core —
 * the RBSP-era diagnostic that separates RADIAL TRANSPORT from LOCAL
 * ACCELERATION (Green & Kivelson 2004; Reeves et al. 2013):
 *
 *   At fixed first invariant μ = E/B, plot f(μ; L) = c(E_μ(L), L) / p²:
 *   • monotonic ↑ outward  → inward radial diffusion from an external
 *     (plasma-sheet) source — the ring current's normal supply path;
 *   • a local peak         → in-situ acceleration at the peak L;
 *   • a deepening minimum  → localized loss (charge exchange / shadowing).
 *
 * Works on the JS reference transport's public per-channel state
 * (C[s][k], eKev, L — read-only; NO core edits, Rust/WASM parity untouched).
 * The WASM kernel (opt-in ?rcwasm=1) exposes only summed maps, so callers
 * must capability-check with psdCapable() and degrade gracefully.
 *
 * Units: μ expressed as keV/nT with the equatorial dipole B(L) = B0_NT/L³;
 * E_μ(L) = μ·B(L) keV. Non-relativistic p² ∝ E at ring energies, and the
 * profile is shape-normalised by the caller, so constant factors drop out.
 */

import { PHYS } from './ring-current-model.js';

const B0_NT = PHYS.B0_NT;   // 31 100 nT equatorial surface field

/** True when this transport exposes the per-channel state PSD needs. */
export function psdCapable(t) {
    return !!(t && Array.isArray(t.C) && t.eKev && t.L && typeof t.idx === 'function');
}

/** Equatorial dipole |B| (nT) at L. */
export function bEqNt(L) { return B0_NT / (L * L * L); }

/** μ (keV/nT) that lands E_μ = eKev at shell L — for picking display values. */
export function muForEnergyAtL(eKev, L) { return eKev / bEqNt(L); }

/**
 * f(μ; L) profile for one μ (keV/nT), MLT-averaged, summed over ion species.
 * Log-log interpolation between the transport's log-spaced energy channels;
 * NaN outside the channel span (the honest "no coverage" marker — real PSD
 * plots have exactly these gaps).
 *
 * @returns {{ L: Float64Array, f: Float64Array, eKevAt: Float64Array }}
 */
export function psdProfile(t, mu) {
    const nL = t.nL, nMlt = t.nMlt, nE = t.nE ?? t.eKev.length;
    const L = new Float64Array(nL), f = new Float64Array(nL), eAt = new Float64Array(nL);
    const eMin = t.eKev[0], eMax = t.eKev[nE - 1];
    for (let i = 0; i < nL; i++) {
        L[i] = t.L[i];
        const E = mu * bEqNt(L[i]);
        eAt[i] = E;
        if (!(E >= eMin && E <= eMax)) { f[i] = NaN; continue; }
        // Bracket E in the channel ladder (log-spaced).
        let k = 0;
        while (k < nE - 2 && t.eKev[k + 1] < E) k++;
        const e0 = t.eKev[k], e1 = t.eKev[k + 1];
        // MLT-averaged content in the two bracketing channels, all species.
        let c0 = 0, c1 = 0;
        for (let s = 0; s < t.C.length; s++) {
            const A0 = t.C[s][k], A1 = t.C[s][k + 1];
            for (let j = 0; j < nMlt; j++) {
                const n = t.idx(i, j);
                c0 += A0[n]; c1 += A1[n];
            }
        }
        c0 /= nMlt; c1 /= nMlt;
        // Log-log interpolation (fall back to linear when a side is empty).
        const w = Math.log(E / e0) / Math.log(e1 / e0);
        const c = (c0 > 0 && c1 > 0)
            ? Math.exp((1 - w) * Math.log(c0) + w * Math.log(c1))
            : (1 - w) * c0 + w * c1;
        f[i] = c > 0 ? c / E : 0;      // p² ∝ E (non-relativistic)
    }
    return { L, f, eKevAt: eAt };
}

/**
 * Classify a profile's shape over its valid span: 'inward-diffusion'
 * (monotonic-ish growth outward), 'local-peak' (interior max ≥ 25% above
 * both ends), or 'flat' (nothing distinguishable). A compact label for the
 * analytics dock — the plot itself is the evidence.
 */
export function psdShape(profile) {
    const { f } = profile;
    const v = [];
    for (let i = 0; i < f.length; i++) if (Number.isFinite(f[i]) && f[i] > 0) v.push(f[i]);
    if (v.length < 4) return 'flat';
    const first = v[0], last = v[v.length - 1], max = Math.max(...v);
    const iMax = v.indexOf(max);
    if (iMax > 0 && iMax < v.length - 1 && max > 1.25 * first && max > 1.25 * last) return 'local-peak';
    if (last > 2 * first) return 'inward-diffusion';
    return 'flat';
}
