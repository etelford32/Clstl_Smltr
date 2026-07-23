/**
 * stage/scale.js — the Stage's disclosed spatial dishonesty, in one place
 * (SPACE_WEATHER_DASHBOARD_PLAN.md §5.3 "scale honesty", phase S1).
 *
 * True Sun–Earth scale is unusable on screen (Earth sub-pixel), so the
 * corridor uses a PIECEWISE-COMPRESSED radial map from the Sun:
 *
 *   near-Sun  r ∈ [0, R1]   linear ×A        (launch zone near-true)
 *   corridor  r ∈ [R1, R2]  log-compressed   (the long empty middle)
 *   near-Earth r ∈ [R2, ∞)  linear ×A        (arrival zone near-true)
 *
 * Constants are chosen so Earth (1 AU) lands at exactly EARTH_S stage
 * units with C0 continuity at both breakpoints. A `mix` parameter blends
 * toward the fully linear map s = EARTH_S·r (the "true scale" toggle —
 * the compression must be REMOVABLE on demand, that is the honesty).
 *
 * Two further disclosed exaggerations live here so no renderer invents
 * its own: BODY radii (Sun/Earth are drawn ~×15–1500 real size — every
 * sim does this; ours says so) and the EARTH-LOCAL frame, where
 * magnetosphere-scale elements render at 1 stage unit = EARTH_LOCAL_RE
 * Earth radii around Earth's position (the sim-clock SCALE registry
 * precedent: compression enters through an explicit mapping, never
 * smuggled into geometry).
 *
 * PURE — no DOM, no THREE. Node gate: tests/stage-scale.mjs.
 */

export const AU_KM = 1.495978707e8;
export const RSUN_KM = 6.957e5;
export const RE_KM = 6371.2;

// Corridor map constants. With A=4, R1=0.1, R2=0.9, B=1:
// s(1 AU) = 0.4 + ln(9) + 0.4 = 2.9972... — pinned ≡ EARTH_S by solving
// B from the other three, so Earth's stage position is EXACT by
// construction, not approximately.
export const R1 = 0.1;
export const R2 = 0.9;
export const A = 4;
export const EARTH_S = 3.0;
export const B = (EARTH_S - A * R1 - A * (1 - R2)) / Math.log(R2 / R1);

/** Compressed radial map: heliocentric r [AU] → stage units. mix ∈ [0,1]
 *  blends to the true-linear map (mix=1 ⇒ s = EARTH_S·r). Monotone in r
 *  for every mix. */
export function stageRadius(rAu, mix = 0) {
    const r = Math.max(0, rAu);
    let s;
    if (r <= R1) s = A * r;
    else if (r <= R2) s = A * R1 + B * Math.log(r / R1);
    else s = A * R1 + B * Math.log(R2 / R1) + A * (r - R2);
    const m = Math.min(1, Math.max(0, mix));
    return (1 - m) * s + m * EARTH_S * r;
}

/** Inverse of stageRadius at mix=0 (closed form; used by picking and the
 *  ruler). For mix≠0 invert numerically in the caller if ever needed. */
export function stageRadiusInv(s) {
    if (s <= 0) return 0;
    const s1 = A * R1;
    const s2 = s1 + B * Math.log(R2 / R1);
    if (s <= s1) return s / A;
    if (s <= s2) return R1 * Math.exp((s - s1) / B);
    return R2 + (s - s2) / A;
}

/** Mix-aware inverse of stageRadius — bisection over the (monotone) blend.
 *  Closed form covers mix=0; the probe picker needs the inverse at ANY mix
 *  so a dropped virtual monitor reads the same true AU under the scale
 *  toggle. ~40 iterations ≪ one raycast; called only on click. */
export function stageRadiusInvMix(s, mix = 0) {
    const m = Math.min(1, Math.max(0, mix));
    if (m === 0) return stageRadiusInv(s);
    if (s <= 0) return 0;
    let lo = 0, hi = 2;
    while (stageRadius(hi, m) < s && hi < 64) hi *= 2;
    for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        if (stageRadius(mid, m) < s) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/** Map a physical heliocentric point [AU]³ through the radial compression
 *  (direction preserved — compression is purely radial). */
export function stagePoint(pAu, mix = 0, out = [0, 0, 0]) {
    const r = Math.hypot(pAu[0], pAu[1], pAu[2]);
    if (r < 1e-12) { out[0] = out[1] = out[2] = 0; return out; }
    const k = stageRadius(r, mix) / r;
    out[0] = pAu[0] * k; out[1] = pAu[1] * k; out[2] = pAu[2] * k;
    return out;
}

/** Ruler ticks: labeled true-AU marks at their current stage positions —
 *  the persistent disclosure of the compression. */
export const RULER_AU = Object.freeze([0.1, 0.25, 0.5, 0.75, 1.0]);
export function rulerTicks(mix = 0) {
    return RULER_AU.map((rAu) => ({ rAu, s: stageRadius(rAu, mix) }));
}

/* ── Disclosed body / local-frame exaggerations ───────────────────────── */

// Earth-local frame: 1 stage unit = EARTH_LOCAL_RE R_E around Earth's
// stage position. Chosen so the quiet magnetopause nose (~10 R_E) sits
// well clear of the drawn Earth and a storm-compressed nose (~5.4 R_E)
// visibly bites inside GEO (6.6 R_E).
export const EARTH_LOCAL_RE = 55;   // R_E per stage unit
export const reToUnits = (re) => re / EARTH_LOCAL_RE;

// ── The Stage's one TEMPORAL dishonesty (S5a, plan §15.2) ──────────────
// At wall clock a 450 km/s parcel takes ~4 days Sun→Earth — imperceptible.
// The ambient particle flow therefore renders at a TIME-LAPSE: one transit
// ≈ 100 s on screen at the default. Same doctrine as the spatial map:
// declared here (never smuggled into the renderer), disclosed on-stage,
// and REMOVABLE — the true-scale toggle blends it to ×1 via flowLapse(mix),
// an honestly motionless corridor. τ-playback/scrubbing move the CLOCK
// instead and are not affected by this constant.
export const FLOW = Object.freeze({
    TIME_LAPSE: 3600,            // ambient flow speedup at mix=0
});

/** Effective flow time-lapse at compression mix (mix=1 ⇒ ×1, honest). */
export function flowLapse(mix = 0) {
    const m = Math.min(1, Math.max(0, mix));
    return (1 - m) * FLOW.TIME_LAPSE + m * 1;
}

export const BODY = Object.freeze({
    // Stage-unit draw radii. Real: Sun 0.00465 AU → 0.014 stage units at
    // A=4; Earth 4.26e-5 AU → invisible. Factors stated for the HUD line.
    // The drawn Earth is EXACTLY 1 R_E in the Earth-local frame (S2):
    // surface features (pin, oval band), orbital shells, and the Shue
    // magnetopause all share ONE local scale — no second Earth size.
    sunRadiusUnits: 0.12,
    earthRadiusUnits: 1 / EARTH_LOCAL_RE,
    sunExaggeration: 0.12 / (A * (RSUN_KM / AU_KM)),                    // ≈ ×6.5
    earthExaggeration: (1 / EARTH_LOCAL_RE) / (A * (RE_KM / AU_KM)),    // ≈ ×107
});
