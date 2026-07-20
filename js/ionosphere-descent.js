/**
 * ionosphere-descent.js — disclosed vertical exaggeration + column profile
 * (Track C of IONOSPHERE_EXPLORATION_PLAN.md, M3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions only: no DOM, no THREE, no fetch.
 * tests/ionosphere-descent.mjs runs this exact module under node.
 *
 * ── The problem & the contract ──────────────────────────────────────────────
 * The explorable atmosphere (60–1000 km) is 0.01–0.16 R_E thick — sub-pixel
 * at magnetosphere framing. Rendering it honestly at every scale is
 * impossible, so the fix is DISCLOSED, like the ×1 bounce exception: as the
 * camera descends below ~ENGAGE_FAR R_E, a vertical exaggeration factor
 * E(d) tweens 1 → EXAG_MAX and every atmosphere-anchored radius renders as
 *
 *   r_drawn = 1 + (r_true − 1) · E
 *
 * It is a RENDERING TRANSFORM ONLY — no physics state ever sees E. The HUD
 * shows the live factor while engaged ("vertical ×18 — the atmosphere is
 * really 1/18th this thick"); SCALE.ATMOSPHERE_VERTICAL in sim-clock.js is
 * the registry entry.
 *
 * Field lines need their own remap: a footpoint slope of E with an
 * UNTOUCHED cage cannot be monotone across a narrow blend — the drawn line
 * would hairpin back through radii it already visited (the node test's
 * fold check catches exactly this). So the field-line lift SATURATES: it
 * matches the atmosphere remap's slope at the footpoint, caps at
 * FL_LIFT_CAP (≈300 km of true altitude — the whole curtain span), and
 * releases smoothly across [FL_BLEND_LO, FL_BLEND_HI], which keeps the map
 * strictly monotone at every E. The aurora CURTAINS are drawn with THIS
 * remap too, so "curtains meet their arcs" holds exactly by construction —
 * the small compression vs the shell remap near the curtain tops is the
 * disclosed compromise that buys a fold-free cage (plan §C.2).
 *
 * ── Column profile (the layer diagram, live) ────────────────────────────────
 * columnProfile(lt, kp) is the D/E/F vertical stack at a location — the
 * descent inspector's "column mode". VIZ-grade Chapman behavior with the
 * two facts every textbook plot shows:
 *   · D (~75 km) exists in DAYLIGHT ONLY (photochemical, recombines in
 *     minutes at sunset) — the HF-absorption layer
 *   · E (~108 km) weakens ~an order of magnitude at night but persists
 *   · F1 (~180 km) is a daytime ledge that merges into F2 after sunset
 *   · F2 (~250–330 km) persists all night, rises after sunset, and takes
 *     the mid-latitude "negative storm" density hit at high Kp
 *
 * ── References ──────────────────────────────────────────────────────────────
 *   Hargreaves (1992) The Solar-Terrestrial Environment — layer climatology
 *   Rishbeth & Garriott (1969) — Chapman layer theory
 *   Prölss (1995) — negative storm effects (O/N₂ depletion)
 */

// ── Exaggeration tween ───────────────────────────────────────────────────────

export const EXAG_MAX = 18;
export const ENGAGE_FAR = 3.0;    // camera distance (R_E) where E starts rising
export const ENGAGE_NEAR = 1.5;   // fully engaged at/below this distance
export const FL_BLEND_LO = 1.2;   // field-line lift release starts here…
export const FL_BLEND_HI = 2.6;   // …gone by here (wide = fold-free at E=18)
export const FL_LIFT_CAP = 0.047; // lift saturation scale (R_E) ≈ 300 km —
                                  // the full aurora-curtain altitude span
export const R_E_KM = 6371;

const smooth01 = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** Vertical exaggeration E for a camera at geocentric distance d (R_E):
 *  1 beyond ENGAGE_FAR, EXAG_MAX at/below ENGAGE_NEAR, smooth between. */
export function exaggeration(dCam) {
    if (!Number.isFinite(dCam)) return 1;
    const t = smooth01((ENGAGE_FAR - dCam) / (ENGAGE_FAR - ENGAGE_NEAR));
    return 1 + (EXAG_MAX - 1) * t;
}

/** Engagement fraction 0..1 — drives layer-shell fade-ins and the LOD gate. */
export function engagement(E) {
    return Math.min(1, Math.max(0, (E - 1) / (EXAG_MAX - 1)));
}

/** Atmosphere-anchored radius under exaggeration (r_true in R_E). */
export function remapRadius(rTrue, E) {
    return 1 + (rTrue - 1) * E;
}

/** Field-line remap weight: 1 below FL_BLEND_LO, 0 above FL_BLEND_HI. */
export function fieldLineWeight(r) {
    return 1 - smooth01((r - FL_BLEND_LO) / (FL_BLEND_HI - FL_BLEND_LO));
}

/** Field-line radius under exaggeration — saturating tanh lift (slope E at
 *  the footpoint, capped at (E−1)·FL_LIFT_CAP), released across the blend
 *  band. Strictly monotone in r for any E ≤ EXAG_MAX (fold-free, pinned by
 *  tests). Curtain geometry uses THIS remap so arcs and curtains agree. */
export function remapFieldLineRadius(r, E) {
    const lift = (E - 1) * FL_LIFT_CAP * Math.tanh((r - 1) / FL_LIFT_CAP);
    return r + lift * fieldLineWeight(r);
}

/** TRUE altitude (km) of a camera at drawn distance d under exaggeration E —
 *  the number the HUD discloses ("alt ≈ 124 km real"). */
export function realAltitudeKm(dCam, E) {
    if (!(E > 0)) return null;
    return Math.max(0, (dCam - 1) / E) * R_E_KM;
}

/** Ground-track speed (km/s) of a camera hovering over latitude latDeg on
 *  the rotating Earth — Ω_E·R_E·cos(λ) ≈ 0.465·cos(λ). Apparent speed on
 *  screen is ×τ (the one-clock invariant; the HUD prints both). */
export function groundSpeedKmS(latDeg) {
    const l = Number.isFinite(latDeg) ? latDeg * Math.PI / 180 : 0;
    return 0.4651 * Math.abs(Math.cos(l));
}

// ── Column profile ───────────────────────────────────────────────────────────

/** Day factor from local solar time: 1 at noon, 0 at/after the terminator
 *  (cosine solar-elevation proxy — the same mean-sun LT the fountain uses). */
export function dayFactor(lt) {
    return Math.max(0, Math.cos(((((lt % 24) + 24) % 24) - 12) * Math.PI / 12));
}

/**
 * The local vertical D/E/F stack at local time lt (hours) under Kp.
 * Returns layers bottom-up: { key, name, altKm, density (0..1), note }.
 * density 0 = layer absent (D at night, F1 at night).
 */
export function columnProfile(lt, kp = 1) {
    const day = dayFactor(lt);
    const k = Number.isFinite(kp) ? Math.max(0, Math.min(9, kp)) : 1;
    // Mid-latitude negative storm: O/N₂ depletion eats F-region density.
    const stormLoss = 0.3 * Math.max(0, (k - 5) / 4);
    return [
        {
            key: 'D', name: 'D layer', altKm: 75,
            density: 0.55 * day,
            note: day > 0.05 ? 'daytime photochemistry — HF absorption'
                : 'gone — recombines within minutes of sunset',
        },
        {
            key: 'E', name: 'E layer', altKm: 108,
            density: 0.12 + 0.68 * day,
            note: day > 0.05 ? 'solar EUV + the Sq dynamo' : 'weak nighttime residual',
        },
        {
            key: 'F1', name: 'F1 ledge', altKm: 180,
            density: 0.5 * day,
            note: day > 0.05 ? 'daytime ledge' : 'merged into F2 after sunset',
        },
        {
            key: 'F2', name: 'F2 peak', altKm: Math.round(255 + 55 * (1 - day) + 6 * k),
            density: Math.max(0.05, (0.65 + 0.35 * day) * (1 - stormLoss)),
            note: stormLoss > 0.05 ? 'negative storm — O/N₂ depletion'
                : 'the main F2 peak (persists all night)',
        },
    ];
}
