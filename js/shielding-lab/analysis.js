/**
 * analysis.js — pure analysis helpers for the Shielding Lab toolchain.
 *
 * The kernel's own SAPS probe is pinned to 21 MLT (diagnostics.rs
 * saps_profile — the Foster & Vo benchmark meridian). The MLT-selectable
 * profile cut here lets the user sweep the meridian anywhere; the math
 * MIRRORS diagnostics.rs exactly (westward = −v_east, peak search
 * restricted to the 50–70° subauroral band, half-max width walk) so that
 * at 21 MLT the JS cut and the kernel probe agree — the kernel stays the
 * oracle, this is the exploration tool.
 *
 * Pure: no DOM, no kernel handle — takes the frame views + grid meta.
 * Node-tested in tests/shielding-verdict.mjs.
 */

/** Nearest grid column at an MLT (matches grid.rs col_at_mlt rounding). */
export function colAtMlt(mltHrs, nmlt) {
    const dmlt = 24 / nmlt;
    const j = Math.round(mltHrs / dmlt - 0.5);
    return ((j % nmlt) + nmlt) % nmlt;
}

/**
 * Westward-flow latitude profile at an arbitrary MLT meridian.
 * vE: Float32Array [iLat*nmlt + j]; returns Float64Array per lat row.
 */
export function westwardProfileAt(vE, { nlat, nmlt }, mltHrs) {
    const j = colAtMlt(mltHrs, nmlt);
    const out = new Float64Array(nlat);
    for (let i = 0; i < nlat; i++) out[i] = -vE[i * nmlt + j];
    return out;
}

/**
 * Peak/width summary of a westward profile — diagnostics.rs semantics:
 * peak searched in the 50–70° subauroral band only, width is the
 * half-max crossing span in latitude.
 */
export function profileSummary(profile, { latMinDeg, dlatDeg }) {
    const nlat = profile.length;
    const iLo = Math.max(0, Math.floor((50 - latMinDeg) / dlatDeg));
    const iHi = Math.min(nlat - 1, Math.floor((70 - latMinDeg) / dlatDeg));
    let peak = 0, ipk = iLo;
    for (let i = iLo; i <= iHi; i++) {
        if (profile[i] > peak) { peak = profile[i]; ipk = i; }
    }
    if (peak <= 0) return { peakMs: 0, peakLatDeg: 0, widthDeg: 0 };
    const half = peak / 2;
    let lo = ipk;
    while (lo > 0 && profile[lo] > half) lo--;
    let hi = ipk;
    while (hi + 1 < nlat && profile[hi] > half) hi++;
    return {
        peakMs: peak,
        peakLatDeg: latMinDeg + (ipk + 0.5) * dlatDeg,
        widthDeg: (hi - lo) * dlatDeg,
    };
}
