/**
 * ionosphere-fountain.js — equatorial fountain & plasma-bubble kernel
 * (Track A of IONOSPHERE_EXPLORATION_PLAN.md)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions + one small class: no DOM, no THREE, no fetch.
 * tests/ionosphere-fountain.mjs runs this exact module under node — the
 * particles-kernel pattern (JS-first; WASM only if it ever gets hot).
 *
 * ── What is modeled ─────────────────────────────────────────────────────────
 * 72 longitude cells (5°) along the magnetic dip equator. Per cell:
 *
 *   hF        bottomside F-layer height (km) — advanced by the E×B vertical
 *             drift v(t, lon), relaxing toward a climatological height
 *   crest     Appleton-anomaly crest intensity (0..~1) — daytime fountain
 *             flux integrates it up, night decays it (τ ≈ 2.5 h). Crest
 *             magnetic latitude grows ±10° → ±18° with intensity.
 *   growth    post-sunset Rayleigh–Taylor e-folding integral ∫max(0,γ)dt
 *   bubbles[] depleted field-aligned wedges spawned when `growth` crosses a
 *             deterministically-seeded threshold — rise to ~1200 km apex,
 *             drift east ~120 m/s, decay in 1–2 h
 *
 * The vertical drift is the M-I coupling readout (the point of Track A):
 *
 *   v(t, lon) = v_clim(LT)  +  K_PEN·ΔA·g(LT)  −  K_DD·dd(t)·g(LT)
 *
 *   v_clim    Scherliess–Fejer-style diurnal shape: ~20 m/s up by day,
 *             down at night, with the pre-reversal enhancement (PRE) peak
 *             at ~18.9 LT (fitted analytic curve, cited below)
 *   ΔA        prompt-penetration term from the Track-0 shielding ODE
 *             (ring-current-efield.js). ΔA > 0 (undershielding) with
 *             g(LT) > 0 on the day/dusk side ⇒ SUPER-FOUNTAIN; ΔA < 0
 *             (overshielding) ⇒ suppression. K_PEN ≈ 45 (m/s per kV/R_E²)
 *             puts a strong southward turning at +25–40 m/s extra dusk
 *             drift — the observed super-fountain range.
 *   dd(t)     disturbance dynamo: a τ_DD ≈ 4 sim-h low-pass of the Kp
 *             excess over quiet. Joule-heated winds re-polarize the
 *             low-latitude dynamo HOURS after onset with the OPPOSITE
 *             polarity — so a storm first raises the fountain (prompt
 *             penetration) and later suppresses it. The real two-phase
 *             story, on screen.
 *   g(LT)     penetration LT polarity: eastward through day/dusk (peak
 *             ~16 LT), westward post-midnight — cos((LT−16)·π/12).
 *
 * Rayleigh–Taylor growth (per cell, after local sunset):
 *
 *   γ = g_e / (ν_in(hF) · L_n) − β_rec
 *
 * ν_in falls exponentially with height, so a PRE- or penetration-lofted
 * bottomside (larger hF) grows orders faster — bubbles follow the lifted
 * evenings, which is exactly the coupling the plan wants visible. Bubble
 * seeding is a deterministic hash of (cell, sim-date): the same evening
 * replays identically at any τ or frame rate.
 *
 * ── References (shapes, not solvers — this is a VIZ-grade kernel) ───────────
 *   Scherliess & Fejer (1999) JGR 104 6829 — quiet-time vertical drift climo
 *   Fejer et al. (2008) JGR 113 A05304     — PRE magnitude & LT
 *   Kelley (2009) The Earth's Ionosphere   — generalized R-T growth rate
 *   Fejer & Scherliess (1997)              — penetration vs dynamo polarity
 *   Sultan (1996) JGR 101 26875            — flux-tube-integrated γ
 */

// ── Grid ─────────────────────────────────────────────────────────────────────
export const N_CELLS = 72;                       // 5° longitude cells
export const CELL_DEG = 360 / N_CELLS;

// IGRF-13 dipole pole (epoch 2025.0) — SAME constants as js/geo/coords.js
// (kept literal here: this module must stay THREE-free for node tests).
const POLE_LAT = 80.65 * Math.PI / 180;
const POLE_LON = -72.68 * Math.PI / 180;

/** Geographic latitude (rad) of the magnetic dip equator at geographic
 *  longitude lonRad — centered tilted dipole: the equator SNAKES ±9.4°,
 *  south over the Americas, north over southeast Asia. */
export function dipEquatorLat(lonRad) {
    return Math.atan(-(Math.cos(POLE_LAT) / Math.sin(POLE_LAT)) * Math.cos(lonRad - POLE_LON));
}

// ── Drift model constants ────────────────────────────────────────────────────
export const K_PEN = 45;         // m/s per kV/R_E² of penetration ΔA
export const K_DD = 6;           // m/s per Kp unit of dynamo excess
export const TAU_DD_S = 4 * 3600;    // disturbance-dynamo lag (sim-s)
export const DD_KP_QUIET = 2;    // dynamo only winds up above this Kp

// R-T growth constants: g_e = 8.9 m/s² at ~300 km; ν_in(300 km) ≈ 0.55 s⁻¹
// falling on a 50 km scale height; L_n ≈ 20 km bottomside gradient length;
// β_rec ≈ 5.5×10⁻⁴ s⁻¹ recombination. CALIBRATION (the storm/quiet contrast
// the page renders; re-derive with tests/ionosphere-fountain.mjs group 3):
// the quiet PRE loft peaks hF ≈ 326 ⇒ γ up to ~8×10⁻⁴ s⁻¹ for a ~3.1-e-fold
// evening, right AT the bottom of the seeded 3–6 threshold band — quiet
// nights bubble in a few hash-picked sectors only. A +0.6 kV/R_E²
// undershielding step lofts hF to ~350 ⇒ γ ≈ 1.6×10⁻³ s⁻¹ (~10 min e-fold,
// ~7 e-folds) — the dusk swath erupts. Overshielding pins the loft down:
// γ never clears recombination, zero bubbles. The settled night layer
// (hF ≈ 290) sits at γ ≈ 0 — spawning is a POST-SUNSET phenomenon, not an
// all-night drizzle.
const G_E = 8.9, NU0 = 0.55, NU_H_KM = 50, NU_REF_KM = 300, L_N_M = 20e3, BETA_REC = 5.5e-4;

const BUBBLE_APEX_CAP_KM = 1200;
const BUBBLE_RISE_MS = 250;      // initial rise m/s, decelerating to the cap
const BUBBLE_DRIFT_MS = 120;     // eastward drift m/s (≈ 3.9°/h)
const DEG_PER_M = 1 / 111320;    // equatorial metres → degrees longitude

/** 630 nm airglow shell altitude (km) — the surface the bubbles bite into. */
export const AIRGLOW_ALT_KM = 250;
const R_E_KM = 6371;

// ── Pure pieces (unit-tested directly) ───────────────────────────────────────

/** Hoskins-style trig-free hash — same formula family as
 *  ring-current-particles.js hash1 (deterministic across platforms). */
export function hash1(p) {
    p = (p * 0.1031) % 1;
    if (p < 0) p += 1;
    p *= p + 33.33;
    p *= p + p;
    return p % 1;
}

/**
 * Quiet-time climatological vertical E×B drift (m/s) at local time LT
 * (hours). Diurnal sine (up by day, peak ~+22 near 13 LT, down at night)
 * plus the PRE Gaussian at 18.9 LT — total peaks 40–60 m/s in the
 * 18–19.5 LT trigger window (Scherliess–Fejer / Fejer 2008 shapes).
 */
export function climatologyDrift(lt) {
    const t = ((lt % 24) + 24) % 24;
    const diurnal = 22 * Math.sin((t - 7) * Math.PI / 12);
    const dPre = t - 18.9;
    const pre = 42 * Math.exp(-(dPre * dPre) / (0.8 * 0.8));
    return diurnal + pre;
}

/** Production/recombination equilibrium height (km) the layer relaxes
 *  toward — deliberately PRE-free: the post-sunset loft EMERGES from
 *  integrating the drift itself (climatologyDrift's PRE term), it is not
 *  painted into the target. Mild diurnal: slightly higher by night (the
 *  bottomside decays upward as the E region vanishes). */
export function climatologyHF(lt) {
    const t = ((lt % 24) + 24) % 24;
    return 285 + 10 * Math.cos((t - 1) * Math.PI / 12);
}

/** Penetration/dynamo LT polarity g(LT): eastward (+) through day and dusk
 *  peaking ~16 LT, westward (−) post-midnight peaking ~04 LT. */
export function penetrationGate(lt) {
    return Math.cos(((((lt % 24) + 24) % 24) - 16) * Math.PI / 12);
}

/** Generalized R-T linear growth rate (s⁻¹) for bottomside height hF (km).
 *  Negative = stable (recombination wins). */
export function rtGrowthRate(hFKm) {
    const nu = NU0 * Math.exp(-(hFKm - NU_REF_KM) / NU_H_KM);
    return G_E / (nu * L_N_M) - BETA_REC;
}

/** Total vertical drift (m/s) at LT under penetration ΔA (kV/R_E²) and
 *  disturbance-dynamo state dd (low-passed Kp excess, ≥ 0). */
export function verticalDrift(lt, dA = 0, dd = 0) {
    const g = penetrationGate(lt);
    return climatologyDrift(lt) + K_PEN * (Number.isFinite(dA) ? dA : 0) * g
        - K_DD * Math.max(0, dd) * g;
}

// ── The kernel ───────────────────────────────────────────────────────────────

export class IonosphereFountain {
    constructor(opts = {}) {
        this.cells = [];
        for (let i = 0; i < N_CELLS; i++) {
            const lonDeg = -180 + (i + 0.5) * CELL_DEG;
            this.cells.push({
                i,
                lonDeg,
                dipLatDeg: dipEquatorLat(lonDeg * Math.PI / 180) * 180 / Math.PI,
                hF: 290,
                crest: 0,
                growth: 0,
                nextThreshold: null,   // armed at sunset from the daily hash
                spawnCount: 0,
                v: 0,                  // last vertical drift (m/s) — render cue
                bubbles: [],
            });
        }
        this._dd = 0;                  // disturbance-dynamo low-pass state
        this._kp = Number.isFinite(opts.kp) ? opts.kp : 1;
        this._maxStepS = 60;           // integration substep cap (sim-s)
    }

    /** Live Kp for the disturbance dynamo (partial updates keep the last). */
    setDriver({ kp } = {}) {
        if (Number.isFinite(kp)) this._kp = kp;
    }

    /** Disturbance-dynamo state (low-passed Kp excess over quiet, ≥ 0). */
    get dynamo() { return this._dd; }

    /**
     * Advance the model to simMs by dtSimSec sim-seconds (the SimClock's
     * dSim — 0 while paused). ΔA is the live penetration amplitude from
     * ring-current-efield.js. Internally substeps at ≤ 60 sim-s so a τ=1000
     * frame or a scrub jump integrates the same curve a ×1 frame does
     * (determinism across compression — pinned in tests).
     */
    tick(simMs, dtSimSec, { dA = 0 } = {}) {
        if (!Number.isFinite(simMs) || !Number.isFinite(dtSimSec) || dtSimSec <= 0) return;
        let remaining = dtSimSec;
        let t = simMs - dtSimSec * 1000;
        while (remaining > 0) {
            const dt = Math.min(this._maxStepS, remaining);
            t += dt * 1000;
            this._step(t, dt, dA);
            remaining -= dt;
        }
    }

    _step(simMs, dtS, dA) {
        // Disturbance dynamo: low-pass the Kp excess (τ_DD ≈ 4 h).
        const kpExcess = Math.max(0, this._kp - DD_KP_QUIET);
        this._dd += (kpExcess - this._dd) * (1 - Math.exp(-dtS / TAU_DD_S));

        const utH = (simMs / 3.6e6) % 24;
        const dayN = Math.floor(simMs / 86400000);

        for (const c of this.cells) {
            const lt = (utH + c.lonDeg / 15 + 24) % 24;
            const v = verticalDrift(lt, dA, this._dd);
            c.v = v;

            // Bottomside height: drift-driven, relaxing toward the PRE-free
            // equilibrium (τ ≈ 20 min — production/recombination pull the
            // profile back). The post-sunset loft EMERGES from the drift:
            // quiet PRE peaks hF ≈ 320–330; a penetration step rides on top.
            const hClim = climatologyHF(lt);
            c.hF += v * 1e-3 * dtS - (c.hF - hClim) * (1 - Math.exp(-dtS / 1200));
            c.hF = Math.max(200, Math.min(600, c.hF));

            // Crest intensity: daytime upward flux integrates up (the
            // fountain feeds the crests), τ ≈ 2.5 h decay carries them
            // through the evening; PRE gives the post-sunset brightening.
            const feed = Math.max(0, v) / 30;                    // ~1 at 30 m/s up
            c.crest += (feed - c.crest) * (1 - Math.exp(-dtS / 9000));

            // R-T growth integral, armed through the POST-SUNSET window only
            // (18:45–24 LT — where real EPB seeding lives; the post-midnight
            // reversed-polarity channel is deliberately out of scope so the
            // dusk under/overshielding contrast stays legible).
            const postSunset = lt > 18.75;
            if (postSunset) {
                if (c.nextThreshold === null) {
                    // Arm at sunset: threshold ~ ln(1/seed) e-folds, hash-
                    // jittered per (cell, sim-date) — same evening, same seeds.
                    const h = hash1(c.i * 13.37 + dayN * 61.7);
                    c.nextThreshold = 3 + 3 * h;
                    c.spawnCount = 0;
                }
                c.growth += Math.max(0, rtGrowthRate(c.hF)) * dtS;
                if (c.growth > c.nextThreshold && c.bubbles.length < 3) {
                    this._spawnBubble(c, simMs, dayN);
                    // Re-arm: the next wedge needs meaningfully more growth.
                    const h2 = hash1(c.i * 7.91 + dayN * 61.7 + (c.spawnCount + 1) * 3.7);
                    c.nextThreshold = c.growth + 1.5 + 2 * h2;
                }
            } else if (lt > 6 && lt < 18) {
                c.growth = 0;
                c.nextThreshold = null;   // re-arm at the next sunset
            }

            // Bubble lifecycle: decelerating rise to the apex cap, eastward
            // drift, hard TTL. Iterate backwards for splice.
            for (let b = c.bubbles.length - 1; b >= 0; b--) {
                const bub = c.bubbles[b];
                bub.ageS += dtS;
                if (bub.ageS > bub.ttlS) { c.bubbles.splice(b, 1); continue; }
                const rise = BUBBLE_RISE_MS * Math.max(0.12, 1 - bub.apexKm / BUBBLE_APEX_CAP_KM);
                bub.apexKm = Math.min(BUBBLE_APEX_CAP_KM, bub.apexKm + rise * 1e-3 * dtS);
                bub.lonDeg += BUBBLE_DRIFT_MS * DEG_PER_M * dtS;
                if (bub.lonDeg > 180) bub.lonDeg -= 360;
            }
        }
    }

    _spawnBubble(c, simMs, dayN) {
        c.spawnCount++;
        const h = hash1(c.i * 29.17 + dayN * 61.7 + c.spawnCount * 11.3);
        c.bubbles.push({
            id: `${dayN}-${c.i}-${c.spawnCount}`,
            lonDeg: c.lonDeg + (h - 0.5) * CELL_DEG,   // jitter within the cell
            apexKm: c.hF + 30,
            ageS: 0,
            ttlS: 3600 + 3600 * hash1(h * 97.3),        // 1–2 h
            strength: 0.6 + 0.4 * hash1(h * 51.9),
        });
    }

    /** Crest magnetic latitude (deg) for a cell — ±10° quiet → ±18° at a
     *  strong fountain (Appleton range). */
    crestLatDeg(c) {
        return 10 + 8 * Math.min(1, c.crest);
    }

    /** Flat live-bubble list (render + situation chips). */
    allBubbles() {
        const out = [];
        for (const c of this.cells) {
            for (const b of c.bubbles) {
                out.push({
                    ...b,
                    cell: c.i,
                    rise01: Math.min(1, (b.apexKm - 250) / (BUBBLE_APEX_CAP_KM - 250)),
                    // Field-aligned extent: where the depleted flux tube
                    // (dipole, apex L_apex) crosses the AIRGLOW SHELL —
                    // r_shell = L_apex·cos²λ. Young bubble ≈ ±5°, full apex
                    // ≈ ±20° maglat (the imaged wedge range).
                    latExtentDeg: Math.acos(Math.sqrt(Math.min(1,
                        (1 + AIRGLOW_ALT_KM / R_E_KM) / (1 + b.apexKm / R_E_KM)))) * 180 / Math.PI,
                    fade: Math.min(1, Math.min(b.ageS / 300, (b.ttlS - b.ageS) / 900)),
                });
            }
        }
        return out;
    }
}
