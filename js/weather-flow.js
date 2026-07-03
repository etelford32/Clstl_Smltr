/**
 * weather-flow.js — advective nowcasting + Lucas-Kanade optical flow
 *
 * Phase 3 of WEATHER_FORECAST_PLAN.md, since grown into the physics-model
 * home: semi-Lagrangian advection (single- and multi-level, RK2 variants),
 * horizontal eddy diffusion, thermal wind, and the microphysics source
 * terms. All forecasters register into the existing ForecastRegistry
 * alongside persistence + the precip + cloud + wind anomaly variants.
 * The original two:
 *
 *   1. WindAdvectionForecaster (semi-Lagrangian)
 *      Uses the stored U/V wind channels directly: at each forecast cell
 *      and horizon, walk backward along the wind for `h` hours to find
 *      the upwind origin, bilinearly sample the current field there,
 *      that's the forecast. Physical: this is the standard
 *      semi-Lagrangian transport scheme used in operational NWP — the
 *      wind already tells us where each parcel came from. Beats AR
 *      whenever a feature is *advected* across the grid (cold fronts,
 *      ridge axes, atmospheric rivers) because AR has no notion of
 *      space.
 *
 *   2. OpticalFlowForecaster (Lucas-Kanade)
 *      Estimates a pixel-velocity field from two consecutive frames of
 *      a "tracer" channel (default: total cloud cover) using the
 *      Lucas-Kanade method, then runs the same semi-Lagrangian step
 *      with that flow. Useful where feature motion ≠ wind motion (e.g.
 *      mid-level cloud bands moving with the steering flow aloft, not
 *      the surface wind we have stored). Also a useful cross-check on
 *      WindAdvection: if LK and U/V disagree by a lot at a cell, that
 *      cell's forecast carries more uncertainty than a single model
 *      would suggest.
 *
 * Both produce 9-channel CHW frames matching the schema PersistenceForecaster
 * already emits, so the WeatherForecastValidator scores them automatically
 * against persistence-v1 with no additional wiring.
 *
 * Why this isn't five files
 * ─────────────────────────
 * The plan budgets "~1 file" for Phase 3. The math (bilinear sampler,
 * coordinate helpers, LK kernel, semi-Lagrangian core) is small enough
 * to keep co-located, and bundling helps cross-referencing between the
 * forecasters and the primitives. We export the helpers separately so
 * tests / future modules can use them without instantiating a Forecaster.
 *
 * Coordinate convention
 * ─────────────────────
 * Lockstep with weather-history.js + the cron grid generator
 * (api/cron/refresh-weather-grid.js): coarse buffer is row-major, lat
 * slow, lat ASCENDING south → north. Cell (j=0, i=0) sits at
 * (-87.5° lat, -177.5° lon) for the default 72×36 grid. So:
 *
 *   latOfRow(j, gridH) = -90 + (j + 0.5) * (180 / gridH)
 *   lonOfColumn(i, gridW) = -180 + (i + 0.5) * (360 / gridW)
 *
 * U is eastward (positive → air moves east), V is northward (positive →
 * air moves north). Both in m/s, lockstep with weather-feed.js channel
 * 3/4 conventions.
 */

import { FORECAST_HORIZONS_H } from './weather-forecast.js';

const NUM_CHANNELS = 9;
const CH_U      = 3;
const CH_V      = 4;
const CH_LOW    = 5;
const CH_MID    = 6;
const CH_HIGH   = 7;
const CH_PRECIP = 8;

// ── Cloud → precipitation feedback ───────────────────────────────────────────
// Pure advection carries the precip channel like an inert dye: it preserves
// whatever precip/cloud relationship the initial frame had, but it never lets
// the *evolving* cloud field talk back to the rain. Over a multi-hour horizon
// that desynchronises the two — a precip cell drifts out from under the deck it
// fell from (rain in clear air), or a deck thickens into a region and produces
// no rain. This couples them in the model so the forecast stays physically
// consistent, the same coupling the cloud/precip shaders do visually:
//
//   • Suppression (the strong, safe half): rain cannot persist without a deck
//     to fall from. As the co-located low/mid cloud fraction thins below
//     `cloudDry`, advected precip is relaxed toward zero. Cirrus (high cloud)
//     is excluded — it doesn't rain.
//   • Generation (the gentle half): a thick deck that has outrun its rain seeds
//     light precip toward a thickness-scaled capacity, never fabricating more
//     than `genMax` (light rain) from cloud alone. Conservative on purpose —
//     overprediction is the failure mode to avoid.
//
// Both ramp in with lead time via 1 − e^(−h/relaxH): the τ=0 anchor and short
// horizons stay close to pure advection (which we trust early), and only the
// long tail — where advection is least reliable anyway — is fully reconciled.
export const DEFAULT_PRECIP_FEEDBACK = Object.freeze({
    enabled:  true,
    cloudDry: 0.25,   // deck fraction below which rain can't persist
    cloudWet: 0.55,   // deck fraction at which the suppression gate is fully open
    relaxH:   6,      // e-folding horizon (hours) for the lead-time ramp
    genMax:   0.8,    // mm/hr — most precip a thick deck alone will seed
    genOn:    0.65,   // deck fraction at which generation starts
    genRate:  0.5,    // fraction of the (capacity − current) shortfall filled at full ramp
});

// Hermite smoothstep, matching the GLSL the shaders use so the model and the
// render couple on the same curve.
function _smoothstep(edge0, edge1, x) {
    if (edge0 === edge1) return x < edge0 ? 0 : 1;
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * In-place reconcile the precip channel (8) of one advected CHW frame with its
 * co-located low/mid cloud channels (5,6). Pure given (frame, N, h, params);
 * mutates and returns `frame`. h ≤ 0 (the observation anchor) and a disabled
 * params object are no-ops, so the live frame is never altered.
 *
 * Cloud channels are percent [0,100], precip is mm/hr — the physical units the
 * coarse buffer stores (decode normalises later).
 */
export function reconcilePrecipWithCloud(frame, N, h, params = DEFAULT_PRECIP_FEEDBACK) {
    const p = params || DEFAULT_PRECIP_FEEDBACK;
    if (!p.enabled || h <= 0) return frame;

    const w     = 1 - Math.exp(-h / Math.max(0.5, p.relaxH));   // lead-time ramp 0..1
    const offL  = CH_LOW * N;
    const offM  = CH_MID * N;
    const offP  = CH_PRECIP * N;

    for (let k = 0; k < N; k++) {
        const deck = Math.max(frame[offL + k], frame[offM + k]) / 100;   // 0..1
        const pAdv = frame[offP + k];

        // Suppression: pAdv · mix(1, gate, w). gate → 0 under a vanished deck,
        // so precip decays out; gate → 1 under a solid deck leaves rain intact.
        const gate  = _smoothstep(p.cloudDry, p.cloudWet, deck);
        const pSupp = pAdv * (1 - w * (1 - gate));

        // Generation: fill part of the shortfall toward a thick-deck capacity.
        // Strictly additive (≥0), so heavy rain under thick cloud is untouched.
        const cap  = p.genMax * _smoothstep(p.genOn, 1.0, deck);
        const pOut = pSupp + Math.max(0, cap - pSupp) * w * p.genRate;

        frame[offP + k] = pOut;
    }
    return frame;
}

// ── Convergence-driven microphysics ──────────────────────────────────────────
// Advection alone is mass-conserving: it transports precip and cloud but never
// creates them. Real precipitation is non-conserved — it forms where the wind
// field CONVERGES (∇·V < 0). Converging air has nowhere to go but up; rising
// moist air cools, condenses into cloud, and rains out. This is the dynamical
// source term the pure-transport model was missing.
//
// For each forecast frame we compute the horizontal divergence of its own
// (advected) wind field and treat convergence (−∇·V > 0) as an uplift rate.
// Gated by moisture (RH) — converging *dry* air just subsides somewhere else
// and doesn't rain — it condenses cloud and produces precip together, so the
// pair stays consistent (and the cloud→precip reconcile that runs afterwards
// sees a deck that actually supports the new rain). Growth only: subsidence
// drying is left to advection + the reconcile's suppression, since a noisy
// divergence estimate shouldn't be trusted to actively destroy a real deck.
//
// The processed fraction is conv[1/s] · moisture · τ(h)[s], where
// τ(h) = satH·3600·(1 − e^(−h/satH)) saturates so a 24-h forecast can't run
// away. Synoptic convergence is ~1e-5/s, so with the default gains a strongly
// converging saturated region grows a few mm/hr and tens of percent of deck
// over a long horizon — both hard-capped against divergence-estimate noise.
export const DEFAULT_CONVERGENCE_GROWTH = Object.freeze({
    enabled:   true,
    satH:      6,      // τ saturation horizon (hours)
    kPrecip:   20.0,   // mm/hr per unit processed fraction
    kCloud:    320.0,  // cloud-cover points (%) per unit processed fraction
    precipMax: 8.0,    // mm/hr cap on convergence-generated rain
    cloudMax:  70.0,   // cap (%) on convergence-grown deck per horizon
    rhFloor:   0.40,   // below this RH fraction, converging air is too dry to rain
});

/**
 * In-place grow the precip (8) and low/mid cloud (5,6) channels of one
 * advected CHW frame wherever its own wind field (3,4) converges. Pure given
 * (frame, N, gridW, gridH, h, params); mutates and returns `frame`. h ≤ 0 and
 * disabled params are no-ops. Units: wind m/s, cloud %, precip mm/hr, RH %.
 *
 * Runs BEFORE reconcilePrecipWithCloud so the rain it creates is backed by a
 * deck it also creates, leaving the two channels physically consistent.
 */
export function applyConvergenceGrowth(frame, N, gridW, gridH, h, params = DEFAULT_CONVERGENCE_GROWTH) {
    const p = params || DEFAULT_CONVERGENCE_GROWTH;
    if (!p.enabled || h <= 0) return frame;

    const U   = frame.subarray(CH_U * N, (CH_U + 1) * N);
    const V   = frame.subarray(CH_V * N, (CH_V + 1) * N);
    const RH  = frame.subarray(2 * N, 3 * N);
    const offL = CH_LOW * N, offM = CH_MID * N, offP = CH_PRECIP * N;

    const tauSec = Math.max(0.5, p.satH) * 3600 * (1 - Math.exp(-h / Math.max(0.5, p.satH)));
    const dyM    = (180 / gridH) * M_PER_DEG_LAT;          // metres per grid row
    const dLonDeg = 360 / gridW;

    for (let j = 0; j < gridH; j++) {
        const lat    = latOfRow(j, gridH);
        const cosLat = Math.max(0.05, Math.abs(Math.cos(lat * Math.PI / 180)));
        const dxM    = dLonDeg * M_PER_DEG_LAT * cosLat;   // metres per grid column at this lat
        const jp = Math.min(gridH - 1, j + 1);
        const jm = Math.max(0, j - 1);
        const dySpan = (jp - jm) * dyM || dyM;

        for (let i = 0; i < gridW; i++) {
            const k  = j * gridW + i;
            const ip = (i + 1) % gridW;          // longitude wraps
            const im = (i - 1 + gridW) % gridW;

            const dUdx = (U[j * gridW + ip] - U[j * gridW + im]) / (2 * dxM);
            const dVdy = (V[jp * gridW + i]  - V[jm * gridW + i]) / dySpan;
            const conv = -(dUdx + dVdy);          // >0 where the flow converges
            if (conv <= 0) continue;              // growth only

            // Moisture gate: only converging *moist* air condenses and rains.
            const moist = _smoothstep(p.rhFloor, 1.0, RH[k] / 100);
            if (moist <= 0) continue;

            const processed = conv * moist * tauSec;   // dimensionless
            frame[offP + k] = Math.min(frame[offP + k] + Math.min(p.precipMax, p.kPrecip * processed), 50);
            const grow = Math.min(p.cloudMax, p.kCloud * processed);
            frame[offL + k] = Math.min(100, frame[offL + k] + grow);
            frame[offM + k] = Math.min(100, frame[offM + k] + grow * 0.7);
        }
    }
    return frame;
}

// ── Horizontal eddy diffusion ────────────────────────────────────────────────
// Semi-Lagrangian advection is transport-only: it moves features but never
// mixes them. Real synoptic fields also mix laterally — subgrid eddies smear
// gradients at a rate parameterised in every operational NWP core as a
// horizontal eddy diffusivity κ (m²/s), i.e. ∂F/∂t = κ∇²F. On this 5° grid the
// term is small for resolved features (√(2κ·24h) ≈ 150–250 km, under half a
// cell) but it does real work on the 2Δx checkerboard noise that back-
// trajectory resampling and the finite-difference divergence estimate inject —
// the Laplacian responds hardest exactly at that wavelength, so the operator
// is a scale-selective damper first and a physics term second.
//
// Discretisation: explicit FTCS, flux form in latitude with cos φ metric
// weights (so the operator conserves the global mean on the sphere), periodic
// in longitude, zero-flux across the poles. Stability of explicit diffusion
// requires r = κΔt/Δx² ≤ ~0.25; zonal Δx collapses near the poles, so κ is
// clamped per row to keep r ≤ rMax there — physically read: a row can't mix
// faster than one cell per step no matter how large κ is.
//
// κ per channel: momentum and mass fields (T, P, U, V) get the standard
// synoptic-scale value; moisture/cloud a little more (their small-scale
// variance is larger); precip the most — it is the noisiest channel and the
// one convergence growth feeds, so damping its grid-scale ringing before the
// microphysics reads the frame keeps the source terms honest.
export const DEFAULT_HORIZONTAL_DIFFUSION = Object.freeze({
    enabled: false,          // opt-in — wind-advection-rk2-v1 output stays byte-identical
    rMax:    0.20,           // per-row cap on κ·Δt/Δx² (explicit-scheme stability)
    // m²/s, indexed by channel [T, P, RH, U, V, cl_low, cl_mid, cl_high, precip]
    kappa: Object.freeze([1.5e5, 1.0e5, 2.5e5, 1.0e5, 1.0e5, 2.5e5, 2.5e5, 2.5e5, 4.0e5]),
});

/**
 * In-place apply `steps` explicit diffusion steps of Δt = dtHours each to
 * every channel of one CHW frame. Pure given (frame, N, gridW, gridH, steps,
 * dtHours, params); mutates and returns `frame`. Disabled params or steps ≤ 0
 * are no-ops. Runs BEFORE the microphysics source terms so the divergence
 * estimate in applyConvergenceGrowth sees the smoothed wind field.
 *
 * `numChannels` defaults to the 9-channel weather frame; pass a smaller count
 * (with a matching params.kappa) to diffuse other CHW stacks — the
 * pressure-level temperature pair in multilevelLevelsDense uses 2.
 */
export function applyHorizontalDiffusion(frame, N, gridW, gridH, steps, dtHours,
                                          params = DEFAULT_HORIZONTAL_DIFFUSION,
                                          numChannels = NUM_CHANNELS) {
    const p = params || DEFAULT_HORIZONTAL_DIFFUSION;
    if (!p.enabled || steps <= 0 || dtHours <= 0) return frame;

    const dtSec = dtHours * 3600;
    const dyM   = (180 / gridH) * M_PER_DEG_LAT;
    const dy2   = dyM * dyM;
    const rMax  = Math.max(0.01, Math.min(0.25, p.rMax ?? 0.20));

    // Per-row geometry, computed once: zonal spacing (shrinks poleward) and
    // the cos φ weights the flux form needs at the row interfaces.
    const dx2Row    = new Float64Array(gridH);
    const cosRow    = new Float64Array(gridH);
    const cosIfaceN = new Float64Array(gridH);   // interface toward j+1
    for (let j = 0; j < gridH; j++) {
        const lat = latOfRow(j, gridH);
        cosRow[j] = Math.max(0.02, Math.cos(lat * Math.PI / 180));
        const dxM = (360 / gridW) * M_PER_DEG_LAT * cosRow[j];
        dx2Row[j] = dxM * dxM;
    }
    for (let j = 0; j < gridH - 1; j++) {
        const latIface = -90 + (j + 1) * (180 / gridH);
        cosIfaceN[j] = Math.max(0.02, Math.cos(latIface * Math.PI / 180));
    }
    cosIfaceN[gridH - 1] = 0;   // zero-flux across the north pole

    const scratch = new Float32Array(N);
    const kappa   = p.kappa || DEFAULT_HORIZONTAL_DIFFUSION.kappa;

    for (let ch = 0; ch < numChannels; ch++) {
        const k0 = Number(kappa[ch]) || 0;
        if (k0 <= 0) continue;
        const F = frame.subarray(ch * N, (ch + 1) * N);

        for (let s = 0; s < steps; s++) {
            for (let j = 0; j < gridH; j++) {
                const row = j * gridW;
                // Stability clamp: zonal spacing is the binding constraint.
                const kEff = Math.min(k0, rMax * Math.min(dx2Row[j], dy2) / dtSec);
                const rx   = kEff * dtSec / dx2Row[j];
                const ry   = kEff * dtSec / dy2 / cosRow[j];
                const cN   = cosIfaceN[j];                       // toward j+1
                const cS   = j > 0 ? cosIfaceN[j - 1] : 0;       // toward j-1 (0 = pole)
                for (let i = 0; i < gridW; i++) {
                    const k  = row + i;
                    const ip = row + ((i + 1) % gridW);
                    const im = row + ((i - 1 + gridW) % gridW);
                    const f  = F[k];
                    const fluxX = F[ip] - 2 * f + F[im];
                    const fluxY = (j < gridH - 1 ? cN * (F[row + gridW + i] - f) : 0)
                                - (j > 0         ? cS * (f - F[row - gridW + i]) : 0);
                    scratch[k] = f + rx * fluxX + ry * fluxY;
                }
            }
            F.set(scratch.subarray(0, N));
        }
    }
    return frame;
}

// ── Thermal wind ─────────────────────────────────────────────────────────────
// The thermal-wind relation couples the vertical wind shear of a layer to the
// horizontal gradient of its mean temperature: geostrophic balance at two
// pressure levels differenced gives
//
//   ΔV(850→500) = (R_d · ln(p850/p500) / f) · k̂ × ∇T̄
//
// with T̄ the layer-mean temperature. NH check: colder poleward (∂T/∂y < 0)
// gives westerly shear increasing with height — the jet stream. We use it as
// the CONSISTENCY relation between the levels the multi-level forecaster
// advects: where an upstream gap leaves one level's wind NaN, the other
// level's wind plus the thermal shear reconstructs it from the temperatures
// we do have, instead of poisoning the trajectory with a zero-wind hole.
//
// Geostrophy fails where f → 0, so the shear is tapered to zero inside ±10°
// and f is evaluated no closer to the equator than ±15° — equatorial gaps
// fall back to "copy the other level's wind" (shear 0), which is the honest
// low-latitude answer anyway (weak rotational control).
const OMEGA_EARTH = 7.2921e-5;                       // rad/s
const RD_LN_P_RATIO = 287.05 * Math.log(850 / 500);  // R_d · ln(p1/p2) ≈ 152.3 J/(kg·K)
const THERMAL_SHEAR_CAP_MS = 60;                     // sanity cap vs noisy gradients

/**
 * Thermal-wind shear (850 → 500 hPa) from the two level temperatures.
 * @param {Float32Array} t850, t500  °C (gradients are Kelvin-identical)
 * @returns {{du: Float32Array, dv: Float32Array}}  m/s shear per cell
 */
export function thermalWindShear(t850, t500, gridW, gridH) {
    const N  = gridW * gridH;
    const du = new Float32Array(N);
    const dv = new Float32Array(N);
    const dyM     = (180 / gridH) * M_PER_DEG_LAT;
    const dLonDeg = 360 / gridW;

    for (let j = 0; j < gridH; j++) {
        const lat    = latOfRow(j, gridH);
        const absLat = Math.abs(lat);
        // Amplitude taper 10° → 20°; f floored at ±15° to bound 1/f.
        const taper = Math.max(0, Math.min(1, (absLat - 10) / 10));
        if (taper === 0) continue;                    // du/dv stay 0
        const fLat = Math.max(absLat, 15) * (lat < 0 ? -1 : 1);
        const f    = 2 * OMEGA_EARTH * Math.sin(fLat * Math.PI / 180);
        const K    = (RD_LN_P_RATIO / f) * taper;
        const cosLat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
        const dxM    = dLonDeg * M_PER_DEG_LAT * cosLat;
        const jp = Math.min(gridH - 1, j + 1);
        const jm = Math.max(0, j - 1);
        const dySpan = (jp - jm) * dyM || dyM;

        for (let i = 0; i < gridW; i++) {
            const k  = j * gridW + i;
            const ip = (i + 1) % gridW;
            const im = (i - 1 + gridW) % gridW;
            // Layer-mean T gradients (central differences; lon wraps).
            const Tbar = (idx) => (t850[idx] + t500[idx]) * 0.5;
            const dTdx = (Tbar(j * gridW + ip) - Tbar(j * gridW + im)) / (2 * dxM);
            const dTdy = (Tbar(jp * gridW + i) - Tbar(jm * gridW + i)) / dySpan;
            if (!Number.isFinite(dTdx) || !Number.isFinite(dTdy)) continue;
            // k̂ × ∇T = (−∂T/∂y, ∂T/∂x)
            du[k] = Math.max(-THERMAL_SHEAR_CAP_MS, Math.min(THERMAL_SHEAR_CAP_MS, -K * dTdy));
            dv[k] = Math.max(-THERMAL_SHEAR_CAP_MS, Math.min(THERMAL_SHEAR_CAP_MS,  K * dTdx));
        }
    }
    return { du, dv };
}

// Earth's radius in metres (mean) — used to convert m/s to deg/s.
// 1° lat ≈ 111_320 m at sea level; 1° lon shrinks by cos(lat).
const M_PER_DEG_LAT = 111_320;

// Clamp the latitude during sampling to avoid the cos(lat) singularity
// at the poles. ±89° is well past anywhere with active data on the
// 5° grid (the polar strip is at ±87.5°) so we lose nothing.
const LAT_CLAMP_DEG = 89.0;

// ── Coordinate helpers ─────────────────────────────────────────────────────

export function latOfRow(j, gridH) {
    return -90 + (j + 0.5) * (180 / gridH);
}
export function lonOfColumn(i, gridW) {
    return -180 + (i + 0.5) * (360 / gridW);
}

// Inverse: which row index does this lat fall into? Returns a fractional
// row so the bilinear sampler can interpolate. Latitude is clamped before
// the conversion so we never produce a row index outside [0, gridH-1].
function rowOfLat(latDeg, gridH) {
    const clamped = Math.max(-LAT_CLAMP_DEG, Math.min(LAT_CLAMP_DEG, latDeg));
    return (clamped + 90) * (gridH / 180) - 0.5;
}
function colOfLon(lonDeg, gridW) {
    // Longitude is periodic — wrap before converting so a back-step over
    // the dateline doesn't index into a phantom column.
    let l = ((lonDeg + 540) % 360) - 180;
    return (l + 180) * (gridW / 360) - 0.5;
}

// ── Bilinear sampler ───────────────────────────────────────────────────────
//
// Samples one channel of a CHW Float32 buffer at fractional (col, row)
// pixel coordinates. Wraps periodically in column (longitude is a
// circle); clamps in row (the field doesn't continue across the pole,
// the polar strip is the field's edge).

export function bilinearSample(field, gridW, gridH, col, row) {
    // Clamp row, wrap col.
    const r = Math.max(0, Math.min(gridH - 1.000001, row));
    const c = ((col % gridW) + gridW) % gridW;
    const r0 = Math.floor(r);
    const r1 = Math.min(gridH - 1, r0 + 1);
    const c0 = Math.floor(c);
    const c1 = (c0 + 1) % gridW;
    const fr = r - r0;
    const fc = c - c0;
    const v00 = field[r0 * gridW + c0];
    const v10 = field[r0 * gridW + c1];
    const v01 = field[r1 * gridW + c0];
    const v11 = field[r1 * gridW + c1];
    return (1 - fc) * (1 - fr) * v00
         +      fc  * (1 - fr) * v10
         + (1 - fc) *      fr  * v01
         +      fc  *      fr  * v11;
}

// ── Semi-Lagrangian advection ─────────────────────────────────────────────
//
// For each cell at the forecast time t+h, we ask: "where did the air
// here come from?" Walk backward along the (U, V) velocity at the
// destination cell for h hours to find the origin, then bilinearly
// sample the current field at that origin. Single-step backward Euler;
// good enough for h ≤ 6 h on a 5° grid where the wind doesn't reverse
// inside one step.
//
// `flowU`, `flowV`: m/s, eastward + northward respectively. They are
// SAMPLED AT THE DESTINATION CELL — that's the standard semi-Lagrangian
// approximation; for short horizons it's effectively first-order
// accurate. For h > 6 h the integrator should iterate (Euler →
// midpoint), but at h=24 the error from the steady-flow assumption
// already dominates so we don't bother.

/**
 * Advect one channel of `field` forward by `hoursAhead` hours using the
 * supplied (flowU, flowV) m/s velocity arrays. Returns a fresh
 * Float32Array(N).
 */
export function semiLagrangianAdvect({ field, flowU, flowV, gridW, gridH, hoursAhead }) {
    const N = gridW * gridH;
    const out = new Float32Array(N);
    const seconds = hoursAhead * 3600;

    for (let j = 0; j < gridH; j++) {
        const lat = latOfRow(j, gridH);
        const cosLat = Math.cos(lat * Math.PI / 180);
        // Avoid divide-by-zero at the poles — clamp the secant so a
        // stray "wind blowing through the pole" doesn't send the
        // origin index to ±∞. cos(89°) ≈ 0.0175, secant ≈ 57.3.
        const secLat = 1 / Math.max(0.02, Math.abs(cosLat));
        for (let i = 0; i < gridW; i++) {
            const k = j * gridW + i;
            const u = flowU[k] || 0;       // m/s east
            const v = flowV[k] || 0;       // m/s north
            // Origin in metres relative to (lat, lon):
            //   dx = u * dt   (eastward displacement OF THE PARCEL)
            //   dy = v * dt   (northward displacement)
            // Origin = destination − displacement.
            const dxMeters = u * seconds;
            const dyMeters = v * seconds;
            // Convert to degrees with appropriate metric.
            const dlatDeg = dyMeters / M_PER_DEG_LAT;
            const dlonDeg = dxMeters / M_PER_DEG_LAT * secLat;
            const latO = lat - dlatDeg;
            const lonO = lonOfColumn(i, gridW) - dlonDeg;
            const rowO = rowOfLat(latO, gridH);
            const colO = colOfLon(lonO, gridW);
            out[k] = bilinearSample(field, gridW, gridH, colO, rowO);
        }
    }
    return out;
}

// ── Lucas-Kanade flow ─────────────────────────────────────────────────────
//
// Classical 2-frame LK on a single tracer channel. For each cell, sum
// gradient products in a (2r+1) × (2r+1) window and solve a 2×2
// system for (u, v) in pixels-per-frame. Default window radius 2 →
// 5×5 = 25 samples, well-conditioned for a 72×36 grid.
//
// Output is in pixel-velocity (per frame). The forecaster converts
// pixels/frame → m/s before handing off to semiLagrangianAdvect:
//   U_ms = u * (360/gridW) deg-lon * (111320 * cos(lat)) / framePeriodSec
//   V_ms = v * (180/gridH) deg-lat * 111320            / framePeriodSec
//
// Window edges wrap in column (longitude periodic) and clamp in row
// (lat not periodic). Cells with a near-singular gradient matrix
// (|det| below a small threshold) get a (0, 0) flow — better than a
// noise-amplified explosion.

/**
 * @param {object} args
 * @param {Float32Array} args.prev    Previous frame, single channel slice (length gridW*gridH).
 * @param {Float32Array} args.curr    Current frame, same shape.
 * @param {number}       args.gridW
 * @param {number}       args.gridH
 * @param {number}       [args.windowRadius=2]   LK window half-size.
 * @returns {{ u: Float32Array, v: Float32Array }}  pixel-velocity per frame
 */
export function lucasKanadeFlow({ prev, curr, gridW, gridH, windowRadius = 2 }) {
    const N = gridW * gridH;
    const u = new Float32Array(N);
    const v = new Float32Array(N);

    // Pre-compute spatial gradients of `curr` once. Central differences
    // in pixel space; wrap in column, clamp in row.
    const Ix = new Float32Array(N);
    const Iy = new Float32Array(N);
    const It = new Float32Array(N);
    for (let j = 0; j < gridH; j++) {
        const jUp = Math.min(gridH - 1, j + 1);
        const jDn = Math.max(0, j - 1);
        for (let i = 0; i < gridW; i++) {
            const iE = (i + 1) % gridW;
            const iW = (i - 1 + gridW) % gridW;
            const k = j * gridW + i;
            Ix[k] = 0.5 * (curr[j * gridW + iE] - curr[j * gridW + iW]);
            // +Iy means "value increases with j" which means "increases
            // northward" given the south-first row convention.
            Iy[k] = 0.5 * (curr[jUp * gridW + i] - curr[jDn * gridW + i]);
            It[k] = curr[k] - prev[k];
        }
    }

    // For each cell, sum gradient products over the LK window and solve
    // [Sxx Sxy; Sxy Syy] [u v]^T = -[Sxt; Syt]. Window edges wrap in
    // column, clamp in row.
    const r = windowRadius;
    for (let j = 0; j < gridH; j++) {
        for (let i = 0; i < gridW; i++) {
            let Sxx = 0, Syy = 0, Sxy = 0, Sxt = 0, Syt = 0;
            for (let dj = -r; dj <= r; dj++) {
                const jj = Math.max(0, Math.min(gridH - 1, j + dj));
                for (let di = -r; di <= r; di++) {
                    const ii = ((i + di) % gridW + gridW) % gridW;
                    const kk = jj * gridW + ii;
                    const ix = Ix[kk], iy = Iy[kk], it = It[kk];
                    Sxx += ix * ix;
                    Syy += iy * iy;
                    Sxy += ix * iy;
                    Sxt += ix * it;
                    Syt += iy * it;
                }
            }
            const det = Sxx * Syy - Sxy * Sxy;
            // det threshold: a tiny window-sum det means the local
            // gradient field is degenerate (flat region — "aperture
            // problem"). Returning (0, 0) flow is the right call;
            // pretending we have flow info from a flat patch would
            // inject pure noise into the advection step.
            if (Math.abs(det) < 1e-6) { u[j * gridW + i] = 0; v[j * gridW + i] = 0; continue; }
            const invDet = 1 / det;
            // [u v] = -[Syy -Sxy; -Sxy Sxx]/det * [Sxt; Syt]
            u[j * gridW + i] = -(Syy * Sxt - Sxy * Syt) * invDet;
            v[j * gridW + i] = -(Sxx * Syt - Sxy * Sxt) * invDet;
        }
    }
    return { u, v };
}

/**
 * Convert LK pixel-velocity (per frame) into m/s on the (eastward,
 * northward) basis the U/V channels use. Cell-dependent because the
 * longitudinal pixel size shrinks with latitude.
 */
export function lkPixelsToMs({ u, v, gridW, gridH, framePeriodSec }) {
    const N = gridW * gridH;
    const Ums = new Float32Array(N);
    const Vms = new Float32Array(N);
    const dLonDegPerPx = 360 / gridW;
    const dLatDegPerPx = 180 / gridH;
    for (let j = 0; j < gridH; j++) {
        const lat = latOfRow(j, gridH);
        const cosLat = Math.cos(lat * Math.PI / 180);
        for (let i = 0; i < gridW; i++) {
            const k = j * gridW + i;
            // u pixels east → u * dLonDegPerPx degrees east → metres east via cos(lat).
            Ums[k] = u[k] * dLonDegPerPx * (M_PER_DEG_LAT * cosLat) / framePeriodSec;
            // v pixels north → v * dLatDegPerPx degrees north → metres north.
            Vms[k] = v[k] * dLatDegPerPx * M_PER_DEG_LAT / framePeriodSec;
        }
    }
    return { U: Ums, V: Vms };
}

// ── Forecasters ────────────────────────────────────────────────────────────

/**
 * Common scaffolding: builds full 9-channel CHW frames at every
 * FORECAST_HORIZONS_H, advecting each channel using the supplied
 * (flowU, flowV) velocity field. Used by both forecasters; only the
 * source of the velocity field differs between them.
 *
 * gainAtHour(h) is an optional per-horizon multiplier ∈ [0, 1] applied
 * to (flowU, flowV) before the advection step. It exists so the wind-
 * advection forecaster can blend toward persistence at long horizons
 * where the steady-flow assumption breaks; gainAtHour(h)=1 for every h
 * recovers the unscaled physics step. We scale by allocating a fresh
 * Float32Array only when the gain ≠ 1 — keeps the common case
 * allocation-free.
 */
function buildAdvectedHorizons({
    history, modelId, flowU, flowV, gainAtHour = null,
}) {
    const frames = history.all();
    if (frames.length === 0) return null;
    const newest = frames[frames.length - 1];
    const { t, gridW, gridH, coarse } = newest;
    const N = gridW * gridH;

    const out = {};
    const targets = {};
    const meta = gainAtHour ? { gain_per_horizon: {} } : null;
    for (const h of FORECAST_HORIZONS_H) {
        const targetMs = t + h * 3_600_000;
        targets[h] = targetMs;

        const gain = gainAtHour ? Math.max(0, Math.min(1, gainAtHour(h))) : 1;
        if (meta) meta.gain_per_horizon[h] = gain;
        let useU = flowU, useV = flowV;
        if (gain !== 1) {
            useU = new Float32Array(N);
            useV = new Float32Array(N);
            for (let k = 0; k < N; k++) { useU[k] = flowU[k] * gain; useV[k] = flowV[k] * gain; }
        }

        const frame = new Float32Array(N * NUM_CHANNELS);
        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
            const off = ch * N;
            const slice = coarse.subarray(off, off + N);
            const advected = semiLagrangianAdvect({
                field: slice, flowU: useU, flowV: useV, gridW, gridH, hoursAhead: h,
            });
            frame.set(advected, off);
        }
        out[h] = frame;
    }
    return {
        model_id: modelId, issued_ms: t,
        horizons: FORECAST_HORIZONS_H.slice(),
        gridW, gridH, frames: out, target_ms: targets,
        ...(meta ? { _meta: meta } : {}),
    };
}

/**
 * Forecast = displace the current frame backward along the stored
 * U/V wind vectors. Physical: standard semi-Lagrangian transport.
 *
 * Honest limitations of the bare physics step:
 *   - Single-step backward Euler with steady-state flow assumption.
 *     For h > 6 h the wind itself evolves more than the back-trajectory
 *     accounts for, and the forecast can become *worse than persistence*.
 *   - Wind is sampled at the destination cell, not along the
 *     trajectory. Mid-point or RK2 integration would be a small
 *     accuracy bump; not yet justified by skill scores.
 *
 * Learned gain + runtime modulator
 * ────────────────────────────────
 * To address the long-horizon failure mode without dropping the model
 * entirely, the forecaster scales (U, V) by a horizon-specific gain
 * before advecting:
 *
 *   α_eff(h) = α_learned[h] · steadiness
 *
 * Where:
 *   α_learned[h] is a per-horizon scalar in [0, 1] tuned by the
 *   validator's MSE feedback (AdvectionGainTracker). Drifts toward 1
 *   when advection beats persistence; toward 0 when it loses.
 *   steadiness is a runtime "Bz-style" scalar from WindShearProxy.
 *   1 = wind has been steady the past few hours; 0 = wildly shifting.
 *
 * α_eff = 0 walks back zero distance ⇒ forecast ≡ current frame ≡
 * persistence baseline. α_eff = 1 is the original physics step.
 *
 * Both knobs are optional — the forecaster degrades gracefully to the
 * pure physics step when neither is supplied (gain = 1 for all h).
 */
export class WindAdvectionForecaster {
    static id = 'wind-advection-v1';
    /**
     * @param {object} [opts]
     * @param {object} [opts.gainTracker]  AdvectionGainTracker instance.
     *   If present, α_learned[h] is read per-forecast via getGain(h).
     * @param {object} [opts.shearProxy]   WindShearProxy instance. If
     *   present, refresh()'d once per forecast and the resulting
     *   steadiness scalar multiplies α_learned[h].
     */
    constructor({ gainTracker = null, shearProxy = null } = {}) {
        this.id           = WindAdvectionForecaster.id;
        this._gainTracker = gainTracker;
        this._shearProxy  = shearProxy;
        // Diagnostic — last computed (steadiness, α_learned, α_eff)
        // exposed for the SW-panel HUD or dev console.
        this._lastDiag = null;
    }

    /** Last applied effective-gain diagnostic, or null if no forecast yet. */
    getLastDiag() { return this._lastDiag; }

    forecast({ history }) {
        const frames = history.all();
        if (frames.length === 0) return null;
        const newest = frames[frames.length - 1];
        const { gridW, gridH, coarse } = newest;
        const N = gridW * gridH;
        // Pull U, V slices straight from the latest frame — no derivation
        // needed, the channels are already in m/s.
        const flowU = coarse.subarray(CH_U * N, (CH_U + 1) * N);
        const flowV = coarse.subarray(CH_V * N, (CH_V + 1) * N);

        // Compose the per-horizon gain. Refresh the shear proxy once
        // per forecast call (≤ 1 per cron cycle) — the steadiness
        // scalar is the same for every horizon, modulating each by
        // the same multiplier. Per-horizon variation comes from the
        // learned α_learned[h].
        const steadiness = this._shearProxy
            ? this._shearProxy.refresh(history)
            : 1.0;
        const gainTracker = this._gainTracker;
        const gainAtHour = (h) => {
            const learned = gainTracker ? gainTracker.getGain(h) : 1.0;
            return learned * steadiness;
        };
        // Stash diagnostics — actual numbers populate after the
        // helper runs and we read its _meta hook.
        const result = buildAdvectedHorizons({
            history, modelId: this.id, flowU, flowV, gainAtHour,
        });
        if (result) {
            this._lastDiag = {
                steadiness,
                shear_ms:    this._shearProxy?.diagnostics().shear_ms ?? null,
                alpha_per_h: result._meta?.gain_per_horizon ?? null,
                alpha_learned_per_h: gainTracker
                    ? gainTracker.getAllGains()
                    : null,
                t: Date.now(),
            };
        }
        return result;
    }
}

// ── RK2 multi-substep semi-Lagrangian, time-evolving wind ───────────────────
//
// wind-advection-rk2-v1 — the "new model" successor to wind-advection-v1.
// Two upgrades target v1's documented failure mode (a single Euler jump
// with frozen wind sampled only at the destination, which "can become
// worse than persistence" past ~6 h):
//
//   1. Multi-substep RK2 (midpoint) back-trajectory. Instead of one
//      h-hour Euler jump, walk back in ~1-hour substeps, taking a
//      midpoint velocity estimate each substep and re-sampling the wind
//      ALONG the curving path. Curved flow (troughs, rotating lows) that
//      a straight Euler jump flies past is now followed. The secant-
//      latitude metric is recomputed at the trajectory's current
//      latitude each substep, not frozen at the destination.
//
//   2. Time-evolving wind. The wind is extrapolated along the trajectory
//      from the most recent hourly tendency ΔW = W(t) − W(t−1h):
//
//         W_eff(lead τ) = W(t) + τ_eff · ΔW,
//         τ_eff = T · (1 − e^(−τ/T))          (T = tendencyHorizonH, ~3 h)
//
//      τ_eff saturates at T so a 24-hour extrapolation can't run away —
//      trust the recent trend for the first few hours, then hold. With
//      only one frame in the ring (no tendency yet) ΔW = 0 and the model
//      degrades to frozen-wind RK2, still strictly better than v1's
//      single Euler step.
//
// Shares v1's gain/shear hooks: gainAtHour(h) ∈ [0,1] scales the whole
// wind for horizon h, so gain → 0 recovers the persistence baseline.

const DEG2RAD = Math.PI / 180;

/**
 * Build advected frames at the requested horizons using RK2 substeps and
 * a time-evolving wind. The back-trajectory origin is computed once per
 * (cell, horizon) and reused across all 9 channels. h ≤ 0 yields the
 * identity (current observation) — used as the τ=0 paint anchor.
 *
 * @returns {null | { model_id, issued_ms, horizons, gridW, gridH,
 *                     frames, target_ms, _meta? }}
 */
/**
 * Back-trajectory origin field for ONE wind level — the RK2/midpoint kernel
 * extracted from rk2BuildHorizons so multi-level forecasters can run it once
 * per steering flow. For every destination cell, walks backward along the
 * (time-evolving) wind for `h` hours and records the fractional (col, row)
 * origin. Sampling any scalar at {colO[k], rowO[k]} advects it with this wind.
 *
 * @param {object} p
 * @param {Float32Array} p.u, p.v          wind at lead 0 (m/s, grid order)
 * @param {?Float32Array} p.tendU, p.tendV hourly tendency (null → frozen wind)
 * @param {number} p.gain                  α scaling the whole wind (0 → identity)
 * @param {?{colO,rowO}} p.scratch         reusable output buffers (N each)
 * @returns {{colO:Float32Array, rowO:Float32Array, steps:number, dh:number}}
 */
export function rk2OriginField({
    u, v, tendU = null, tendV = null, gridW, gridH,
    h, substepH = 1, tendencyHorizonH = 3, gain = 1, scratch = null,
}) {
    const N = gridW * gridH;
    const colO = scratch?.colO ?? new Float32Array(N);
    const rowO = scratch?.rowO ?? new Float32Array(N);
    const Tsat = Math.max(0.5, tendencyHorizonH);

    // Wind (m/s) at fractional grid position (col,row) and lead time
    // `leadH` hours, scaled by `gain`. Up to four bilinear samples.
    const windAt = (col, row, leadH) => {
        let wu = bilinearSample(u, gridW, gridH, col, row);
        let wv = bilinearSample(v, gridW, gridH, col, row);
        if (tendU) {
            const te = Tsat * (1 - Math.exp(-Math.max(0, leadH) / Tsat));
            wu += te * bilinearSample(tendU, gridW, gridH, col, row);
            wv += te * bilinearSample(tendV, gridW, gridH, col, row);
        }
        return { u: wu * gain, v: wv * gain };
    };

    const steps = Math.max(1, Math.round(h / substepH));
    const dh    = h / steps;          // hours per substep
    const dsec  = dh * 3600;

    for (let j = 0; j < gridH; j++) {
        const lat0 = latOfRow(j, gridH);
        for (let i = 0; i < gridW; i++) {
            // Walk the parcel backward from (lat,lon) at lead h to its
            // origin at lead 0, RK2/midpoint per substep.
            let lat = lat0;
            let lon = lonOfColumn(i, gridW);
            let lead = h;
            for (let s = 0; s < steps; s++) {
                const w1   = windAt(colOfLon(lon, gridW), rowOfLat(lat, gridH), lead);
                const sec1 = 1 / Math.max(0.02, Math.abs(Math.cos(lat * DEG2RAD)));
                const latM = lat - 0.5 * (w1.v * dsec) / M_PER_DEG_LAT;
                const lonM = lon - 0.5 * (w1.u * dsec) / M_PER_DEG_LAT * sec1;
                const w2   = windAt(colOfLon(lonM, gridW), rowOfLat(latM, gridH), lead - 0.5 * dh);
                const secM = 1 / Math.max(0.02, Math.abs(Math.cos(latM * DEG2RAD)));
                lat = lat - (w2.v * dsec) / M_PER_DEG_LAT;
                lon = lon - (w2.u * dsec) / M_PER_DEG_LAT * secM;
                lead -= dh;
            }
            const dst = j * gridW + i;
            colO[dst] = colOfLon(lon, gridW);
            rowO[dst] = rowOfLat(lat, gridH);
        }
    }
    return { colO, rowO, steps, dh };
}

// Per-cell hourly tendency between two same-shape fields (cur − prev), or
// null when either is missing. Shared by the surface path (frames from the
// history ring) and the level path (frames from the pressure-level feed).
export function fieldTendency(cur, prev, N) {
    if (!cur || !prev || cur.length !== prev.length) return null;
    const d = new Float32Array(N);
    for (let k = 0; k < N; k++) d[k] = cur[k] - prev[k];
    return d;
}

export function rk2BuildHorizons({
    history, modelId, horizonsH, substepH = 1, tendencyHorizonH = 3, gainAtHour = null,
    precipFeedback = DEFAULT_PRECIP_FEEDBACK, convergenceGrowth = DEFAULT_CONVERGENCE_GROWTH,
    horizontalDiffusion = DEFAULT_HORIZONTAL_DIFFUSION,
}) {
    const frames = history.all();
    if (frames.length === 0) return null;
    const newest = frames[frames.length - 1];
    const { t, gridW, gridH, coarse } = newest;
    const N = gridW * gridH;

    const Ut = coarse.subarray(CH_U * N, (CH_U + 1) * N);
    const Vt = coarse.subarray(CH_V * N, (CH_V + 1) * N);

    // Hourly wind tendency from the previous frame, when present and
    // grid-compatible. A per-cell delta — no global mean to remove.
    let tendU = null, tendV = null;
    if (frames.length >= 2) {
        const prev = frames[frames.length - 2];
        if (prev.gridW === gridW && prev.gridH === gridH
            && prev.coarse?.length === coarse.length) {
            tendU = fieldTendency(Ut, prev.coarse.subarray(CH_U * N, (CH_U + 1) * N), N);
            tendV = fieldTendency(Vt, prev.coarse.subarray(CH_V * N, (CH_V + 1) * N), N);
        }
    }

    const out     = {};
    const targets = {};
    const meta    = gainAtHour ? { gain_per_horizon: {} } : null;
    const scratch = { colO: new Float32Array(N), rowO: new Float32Array(N) };

    for (const h of horizonsH) {
        targets[h] = t + h * 3_600_000;
        const gain = gainAtHour ? Math.max(0, Math.min(1, gainAtHour(h))) : 1;
        if (meta) meta.gain_per_horizon[h] = gain;

        const frame = new Float32Array(N * NUM_CHANNELS);
        if (h <= 0) { frame.set(coarse); out[h] = frame; continue; }

        const { colO, rowO, steps, dh } = rk2OriginField({
            u: Ut, v: Vt, tendU, tendV, gridW, gridH,
            h, substepH, tendencyHorizonH, gain, scratch,
        });
        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
            const slice = coarse.subarray(ch * N, (ch + 1) * N);
            for (let k = 0; k < N; k++) {
                frame[ch * N + k] = bilinearSample(slice, gridW, gridH, colO[k], rowO[k]);
            }
        }
        // Lateral mixing before the source terms: diffusing U/V first means the
        // finite-difference divergence inside applyConvergenceGrowth reads the
        // smoothed wind, not its grid-scale ringing (no-op unless enabled).
        applyHorizontalDiffusion(frame, N, gridW, gridH, steps, dh, horizontalDiffusion);
        // Microphysics, in physical order: convergence first lifts moist air
        // into new cloud + rain, then the cloud→precip reconcile gates the
        // result so rain and deck stay consistent (both no-ops for h ≤ 0).
        applyConvergenceGrowth(frame, N, gridW, gridH, h, convergenceGrowth);
        // Cloud → precip feedback: keep the advected rain consistent with the
        // advected deck at this horizon (no-op for h ≤ 0, handled above).
        reconcilePrecipWithCloud(frame, N, h, precipFeedback);
        out[h] = frame;
    }
    return {
        model_id: modelId, issued_ms: t,
        horizons: horizonsH.slice(),
        gridW, gridH, frames: out, target_ms: targets,
        ...(meta ? { _meta: meta } : {}),
    };
}

export class WindAdvectionRK2Forecaster {
    static id = 'wind-advection-rk2-v1';
    /**
     * @param {object} [opts]
     * @param {object} [opts.gainTracker]       AdvectionGainTracker (its own
     *   modelId), read per-forecast via getGain(h).
     * @param {object} [opts.shearProxy]        WindShearProxy; refresh()'d
     *   once per forecast, multiplies the learned gain.
     * @param {number} [opts.tendencyHorizonH=3]  τ_eff saturation horizon.
     * @param {number} [opts.substepH=1]           Hours per RK2 substep.
     * @param {object} [opts.horizontalDiffusion]  DEFAULT_HORIZONTAL_DIFFUSION-
     *   shaped config. Disabled by default; pass {enabled:true,…} to add the
     *   lateral-mixing term (see applyHorizontalDiffusion).
     * @param {string} [opts.modelId]  Registry id override, so an instance with
     *   different physics (e.g. diffusion on) competes under its own name
     *   instead of polluting wind-advection-rk2-v1's skill history.
     */
    constructor({ gainTracker = null, shearProxy = null, tendencyHorizonH = 3, substepH = 1,
                  precipFeedback = DEFAULT_PRECIP_FEEDBACK,
                  convergenceGrowth = DEFAULT_CONVERGENCE_GROWTH,
                  horizontalDiffusion = DEFAULT_HORIZONTAL_DIFFUSION,
                  modelId = WindAdvectionRK2Forecaster.id } = {}) {
        this.id                  = modelId;
        this._gainTracker        = gainTracker;
        this._shearProxy         = shearProxy;
        this._tendencyHorizonH   = tendencyHorizonH;
        this._substepH           = substepH;
        this._precipFeedback     = precipFeedback;
        this._convergenceGrowth  = convergenceGrowth;
        this._horizontalDiffusion = horizontalDiffusion;
        this._lastDiag           = null;
    }

    getLastDiag() { return this._lastDiag; }

    /**
     * Which non-conserved microphysics terms are active, for UI/HUD display.
     * Reflects the live constructor config rather than the module defaults, so
     * a forecaster built with either term disabled reports honestly.
     */
    microphysicsStatus() {
        return {
            convergenceGrowth:   !!(this._convergenceGrowth   && this._convergenceGrowth.enabled),
            precipFeedback:      !!(this._precipFeedback      && this._precipFeedback.enabled),
            horizontalDiffusion: !!(this._horizontalDiffusion && this._horizontalDiffusion.enabled),
        };
    }

    // Compose the per-horizon gain (learned α[h] × runtime steadiness),
    // mirroring WindAdvectionForecaster. Returns { fn, steadiness }.
    _gainFn(history) {
        const steadiness = this._shearProxy ? this._shearProxy.refresh(history) : 1.0;
        const gt = this._gainTracker;
        return {
            fn: (h) => (gt ? gt.getGain(h) : 1.0) * steadiness,
            steadiness,
        };
    }

    /** Standard scored horizons (FORECAST_HORIZONS_H) for the validator. */
    forecast({ history }) {
        const { fn, steadiness } = this._gainFn(history);
        const result = rk2BuildHorizons({
            history, modelId: this.id, horizonsH: FORECAST_HORIZONS_H,
            substepH: this._substepH, tendencyHorizonH: this._tendencyHorizonH,
            gainAtHour: fn, precipFeedback: this._precipFeedback,
            convergenceGrowth: this._convergenceGrowth,
            horizontalDiffusion: this._horizontalDiffusion,
        });
        if (result) {
            this._lastDiag = {
                steadiness,
                shear_ms:    this._shearProxy?.diagnostics().shear_ms ?? null,
                alpha_per_h: result._meta?.gain_per_horizon ?? null,
                alpha_learned_per_h: this._gainTracker ? this._gainTracker.getAllGains() : null,
                t: Date.now(),
            };
        }
        return result;
    }

    /**
     * Dense hourly horizons (0..maxHorizonH) for the paint provider. h=0
     * is the current observation, giving a seamless live→forecast handoff.
     * Not scored — the validator only consumes forecast()'s standard
     * horizons.
     */
    forecastDense({ history, maxHorizonH = 24 }) {
        const { fn } = this._gainFn(history);
        const horizons = [];
        for (let h = 0; h <= maxHorizonH; h++) horizons.push(h);
        return rk2BuildHorizons({
            history, modelId: this.id, horizonsH: horizons,
            substepH: this._substepH, tendencyHorizonH: this._tendencyHorizonH,
            gainAtHour: fn, precipFeedback: this._precipFeedback,
            convergenceGrowth: this._convergenceGrowth,
            horizontalDiffusion: this._horizontalDiffusion,
        });
    }

    /**
     * Serializable inputs for running the dense forecast off the main thread
     * (see js/weather-forecast-worker.js). Everything the worker's
     * rk2BuildHorizons() call needs, computed on the main thread where the
     * learned gain/shear state lives:
     *   - frames: only the newest two (rk2 reads `newest` + `prev` for the
     *     wind tendency), so the postMessage clone is ~2×93 KB, not the whole
     *     ring.
     *   - gains: the per-horizon α[h] evaluated here (gainTracker + shearProxy
     *     stay main-thread; the worker just indexes the array).
     *   - microphysics config + step params (plain data).
     * Returns null when there's no observation to seed from.
     */
    denseInputs({ history, maxHorizonH = 24 }) {
        const frames = history.all();
        if (!frames || frames.length === 0) return null;
        const { fn } = this._gainFn(history);
        const gains = new Array(maxHorizonH + 1);
        for (let h = 0; h <= maxHorizonH; h++) gains[h] = fn(h);
        const tail = frames.slice(-2).map(f => ({
            t: f.t, gridW: f.gridW, gridH: f.gridH, coarse: f.coarse,
        }));
        return {
            modelId:             this.id,
            frames:              tail,
            gains,
            substepH:            this._substepH,
            tendencyHorizonH:    this._tendencyHorizonH,
            precipFeedback:      this._precipFeedback,
            convergenceGrowth:   this._convergenceGrowth,
            horizontalDiffusion: this._horizontalDiffusion,
            maxHorizonH,
        };
    }
}

// ── Multi-level advection ────────────────────────────────────────────────────
// The single-level models advect every channel with the 10 m surface wind —
// the documented weakness the optical-flow forecaster exists to patch ("mid-
// level cloud bands moving with the steering flow aloft, not the surface wind
// we have stored"). With the pressure-level feed supplying real 850/500 hPa
// winds, each channel can ride its own physically-correct steering flow:
//
//   surface flow (10 m) : T, P, RH, U, V — surface fields
//   850 hPa flow        : low cloud — boundary-layer decks
//   500 hPa flow        : mid + high cloud — the steering flow aloft
//   850/500 mean        : precipitation — the classic ~700 hPa echo-steering
//                         level radar meteorology uses for cell motion
//
// The thermal-wind relation (thermalWindShear above) is the consistency
// coupling between levels: upstream NaN gaps in one level's wind are
// reconstructed from the other level plus the shear implied by the two
// temperature fields, so a data hole degrades to balanced physics instead of
// a zero-wind sink. Everything else — RK2 back-trajectories with saturating
// tendency extrapolation, horizontal diffusion, convergence growth, the
// cloud→precip reconcile, learned gain/shear hooks — is the exact machinery
// the single-level models run, reused per level via rk2OriginField.

// Which channels ride which steering flow (see rationale above).
const LEVEL_CHANNEL_MAP = Object.freeze([
    { flow: 'sfc',   channels: Object.freeze([0, 1, 2, CH_U, CH_V]) },
    { flow: 'w850',  channels: Object.freeze([CH_LOW]) },
    { flow: 'w500',  channels: Object.freeze([CH_MID, CH_HIGH]) },
    { flow: 'steer', channels: Object.freeze([CH_PRECIP]) },
]);

// Fill NaN holes in the level winds via thermal-wind balance (copy-on-write —
// untouched arrays pass through). Cells where neither level has wind AND the
// shear is unusable fall to 0 (the pre-multilevel behaviour, now rare).
function fillLevelWinds({ t850, t500, u850, v850, u500, v500 }, gridW, gridH) {
    const N = gridW * gridH;
    let hasGap = false;
    for (let k = 0; k < N; k++) {
        if (!Number.isFinite(u850[k]) || !Number.isFinite(v850[k])
            || !Number.isFinite(u500[k]) || !Number.isFinite(v500[k])) { hasGap = true; break; }
    }
    if (!hasGap) return { u850, v850, u500, v500, filled: 0 };

    const { du, dv } = thermalWindShear(t850, t500, gridW, gridH);
    const out = {
        u850: new Float32Array(u850), v850: new Float32Array(v850),
        u500: new Float32Array(u500), v500: new Float32Array(v500),
    };
    let filled = 0;
    for (let k = 0; k < N; k++) {
        const ok850 = Number.isFinite(out.u850[k]) && Number.isFinite(out.v850[k]);
        const ok500 = Number.isFinite(out.u500[k]) && Number.isFinite(out.v500[k]);
        if (ok850 && ok500) continue;
        filled++;
        if (ok850) {          // reconstruct 500 = 850 + thermal shear
            out.u500[k] = out.u850[k] + du[k];
            out.v500[k] = out.v850[k] + dv[k];
        } else if (ok500) {   // reconstruct 850 = 500 − thermal shear
            out.u850[k] = out.u500[k] - du[k];
            out.v850[k] = out.v500[k] - dv[k];
        } else {
            out.u850[k] = 0; out.v850[k] = 0;
            out.u500[k] = 0; out.v500[k] = 0;
        }
    }
    return { ...out, filled };
}

/**
 * Multi-level semi-Lagrangian advection-diffusion, id multilevel-advection-v1.
 *
 * `levelWinds` is a provider function returning the newest pressure-level
 * snapshot (or null while the feed is cold):
 *   { t, t850, t500, u850, v850, u500, v500,
 *     tendU850, tendV850, tendU500, tendV500 }   // tendencies optional
 * All Float32Array(N) in the observation grid's order. The forecaster
 * returns null (registry shows "warming up") until the provider delivers,
 * and refuses snapshots older than `maxLevelAgeMs` (default 6 h) — advecting
 * with yesterday's steering flow would silently degrade below rk2.
 */
export class MultiLevelAdvectionForecaster {
    static id = 'multilevel-advection-v1';
    constructor({ levelWinds = null, gainTracker = null, shearProxy = null,
                  tendencyHorizonH = 3, substepH = 1,
                  precipFeedback = DEFAULT_PRECIP_FEEDBACK,
                  convergenceGrowth = DEFAULT_CONVERGENCE_GROWTH,
                  horizontalDiffusion = DEFAULT_HORIZONTAL_DIFFUSION,
                  maxLevelAgeMs = 6 * 3_600_000,
                  modelId = MultiLevelAdvectionForecaster.id } = {}) {
        this.id                   = modelId;
        this._levelWinds          = levelWinds;
        this._gainTracker         = gainTracker;
        this._shearProxy          = shearProxy;
        this._tendencyHorizonH    = tendencyHorizonH;
        this._substepH            = substepH;
        this._precipFeedback      = precipFeedback;
        this._convergenceGrowth   = convergenceGrowth;
        this._horizontalDiffusion = horizontalDiffusion;
        this._maxLevelAgeMs       = maxLevelAgeMs;
        this._lastDiag            = null;
    }

    getLastDiag() { return this._lastDiag; }

    microphysicsStatus() {
        return {
            convergenceGrowth:   !!(this._convergenceGrowth   && this._convergenceGrowth.enabled),
            precipFeedback:      !!(this._precipFeedback      && this._precipFeedback.enabled),
            horizontalDiffusion: !!(this._horizontalDiffusion && this._horizontalDiffusion.enabled),
        };
    }

    _gainFn(history) {
        const steadiness = this._shearProxy ? this._shearProxy.refresh(history) : 1.0;
        const gt = this._gainTracker;
        return {
            fn: (h) => (gt ? gt.getGain(h) : 1.0) * steadiness,
            steadiness,
        };
    }

    // Usable level snapshot for the newest observation, or null.
    _usableLevels(newestT, N) {
        const lw = this._levelWinds ? this._levelWinds() : null;
        if (!lw || !lw.u850 || lw.u850.length !== N) return null;
        if (Math.abs(newestT - lw.t) > this._maxLevelAgeMs) return null;
        return lw;
    }

    /** Standard scored horizons (FORECAST_HORIZONS_H) for the validator. */
    forecast({ history }) {
        const frames = history.all();
        if (!frames || frames.length === 0) return null;
        const newest = frames[frames.length - 1];
        const { t, gridW, gridH, coarse } = newest;
        const N = gridW * gridH;

        const lw = this._usableLevels(t, N);
        if (!lw) return null;

        const { fn: gainFn, steadiness } = this._gainFn(history);

        // Surface flow + tendency — identical to the rk2 model's inputs.
        const Ut = coarse.subarray(CH_U * N, (CH_U + 1) * N);
        const Vt = coarse.subarray(CH_V * N, (CH_V + 1) * N);
        let sfcTendU = null, sfcTendV = null;
        if (frames.length >= 2) {
            const prev = frames[frames.length - 2];
            if (prev.gridW === gridW && prev.gridH === gridH
                && prev.coarse?.length === coarse.length) {
                sfcTendU = fieldTendency(Ut, prev.coarse.subarray(CH_U * N, (CH_U + 1) * N), N);
                sfcTendV = fieldTendency(Vt, prev.coarse.subarray(CH_V * N, (CH_V + 1) * N), N);
            }
        }

        // Level flows, thermal-wind gap-filled; precip steering = 850/500 mean.
        const lvl = fillLevelWinds(lw, gridW, gridH);
        const uSteer = new Float32Array(N), vSteer = new Float32Array(N);
        for (let k = 0; k < N; k++) {
            uSteer[k] = 0.5 * (lvl.u850[k] + lvl.u500[k]);
            vSteer[k] = 0.5 * (lvl.v850[k] + lvl.v500[k]);
        }
        const steerTendU = (lw.tendU850 && lw.tendU500)
            ? Float32Array.from(lw.tendU850, (x, k) => 0.5 * (x + lw.tendU500[k])) : null;
        const steerTendV = (lw.tendV850 && lw.tendV500)
            ? Float32Array.from(lw.tendV850, (x, k) => 0.5 * (x + lw.tendV500[k])) : null;

        const FLOWS = {
            sfc:   { u: Ut,       v: Vt,       tendU: sfcTendU,     tendV: sfcTendV },
            w850:  { u: lvl.u850, v: lvl.v850, tendU: lw.tendU850,  tendV: lw.tendV850 },
            w500:  { u: lvl.u500, v: lvl.v500, tendU: lw.tendU500,  tendV: lw.tendV500 },
            steer: { u: uSteer,   v: vSteer,   tendU: steerTendU,   tendV: steerTendV },
        };

        const out = {}, targets = {};
        const meta = { gain_per_horizon: {}, level_gap_cells: lvl.filled ?? 0 };
        const scratch = { colO: new Float32Array(N), rowO: new Float32Array(N) };

        for (const h of FORECAST_HORIZONS_H) {
            targets[h] = t + h * 3_600_000;
            const gain = Math.max(0, Math.min(1, gainFn(h)));
            meta.gain_per_horizon[h] = gain;

            const frame = new Float32Array(N * NUM_CHANNELS);
            if (h <= 0) { frame.set(coarse); out[h] = frame; continue; }

            let steps = 1, dh = h;
            for (const { flow, channels } of LEVEL_CHANNEL_MAP) {
                const f = FLOWS[flow];
                const o = rk2OriginField({
                    u: f.u, v: f.v, tendU: f.tendU, tendV: f.tendV,
                    gridW, gridH, h, substepH: this._substepH,
                    tendencyHorizonH: this._tendencyHorizonH, gain, scratch,
                });
                steps = o.steps; dh = o.dh;
                for (const ch of channels) {
                    const slice = coarse.subarray(ch * N, (ch + 1) * N);
                    for (let k = 0; k < N; k++) {
                        frame[ch * N + k] = bilinearSample(slice, gridW, gridH, o.colO[k], o.rowO[k]);
                    }
                }
            }
            // Same operator order as rk2BuildHorizons: mix, then sources.
            applyHorizontalDiffusion(frame, N, gridW, gridH, steps, dh, this._horizontalDiffusion);
            applyConvergenceGrowth(frame, N, gridW, gridH, h, this._convergenceGrowth);
            reconcilePrecipWithCloud(frame, N, h, this._precipFeedback);
            out[h] = frame;
        }

        this._lastDiag = {
            steadiness,
            level_t: lw.t,
            level_gap_cells: lvl.filled ?? 0,
            alpha_per_h: meta.gain_per_horizon,
            t: Date.now(),
        };
        return {
            model_id: this.id, issued_ms: t,
            horizons: FORECAST_HORIZONS_H.slice(),
            gridW, gridH, frames: out, target_ms: targets, _meta: meta,
        };
    }

    /**
     * Serializable inputs for multilevelLevelsDense (worker-friendly, same
     * contract style as WindAdvectionRK2Forecaster.denseInputs). Null while
     * the level provider is cold.
     */
    levelsDenseInputs({ history, maxHorizonH = 24 } = {}) {
        const frames = history?.all?.() ?? null;
        const newestT = frames?.length ? frames[frames.length - 1].t : Date.now();
        const lw = this._levelWinds ? this._levelWinds() : null;
        if (!lw) return null;
        if (Math.abs(newestT - lw.t) > this._maxLevelAgeMs) return null;
        const { fn } = this._gainFn(history ?? { all: () => [] });
        const gains = new Array(maxHorizonH + 1);
        for (let h = 0; h <= maxHorizonH; h++) gains[h] = fn(h);
        return {
            issuedMs: lw.t,
            gridW: lw.gridW, gridH: lw.gridH,
            t850: lw.t850, t500: lw.t500,
            u850: lw.u850, v850: lw.v850, u500: lw.u500, v500: lw.v500,
            tendU850: lw.tendU850, tendV850: lw.tendV850,
            tendU500: lw.tendU500, tendV500: lw.tendV500,
            substepH: this._substepH, tendencyHorizonH: this._tendencyHorizonH,
            horizontalDiffusion: this._horizontalDiffusion,
            gains, maxHorizonH,
        };
    }
}

/**
 * Dense hourly advection of the two level-temperature fields by their own
 * winds — what the 3-D temperature volume paints for the model-owned near
 * term. Pure and worker-safe (plain data in, transferable Float32Arrays
 * out); the inline fallback path calls it directly on the main thread.
 *
 * @returns {null | { issued_ms, gridW, gridH,
 *                    frames: [{h, target_ms, t850, t500}] }}
 */
export function multilevelLevelsDense({
    issuedMs, gridW, gridH, t850, t500, u850, v850, u500, v500,
    tendU850 = null, tendV850 = null, tendU500 = null, tendV500 = null,
    substepH = 1, tendencyHorizonH = 3, gains = null, maxHorizonH = 24,
    horizontalDiffusion = DEFAULT_HORIZONTAL_DIFFUSION,
}) {
    if (!t850 || !t500 || !u850) return null;
    const N = gridW * gridH;
    const lvl = fillLevelWinds({ t850, t500, u850, v850, u500, v500 }, gridW, gridH);
    // Two-channel diffusion config: both are temperature fields, reuse κ_T.
    const hd = horizontalDiffusion || DEFAULT_HORIZONTAL_DIFFUSION;
    const kT = (hd.kappa && Number(hd.kappa[0])) || 0;
    const levelDiffusion = { enabled: !!hd.enabled, rMax: hd.rMax, kappa: [kT, kT] };

    const lastGain = (gains && gains.length) ? gains[gains.length - 1] : 1;
    const gainAt   = (h) => (gains && h >= 0 && h < gains.length ? gains[h] : lastGain);

    const scratch = { colO: new Float32Array(N), rowO: new Float32Array(N) };
    const frames = [];
    for (let h = 0; h <= maxHorizonH; h++) {
        const f850 = new Float32Array(N);
        const f500 = new Float32Array(N);
        if (h === 0) {
            f850.set(t850); f500.set(t500);
            frames.push({ h, target_ms: issuedMs, t850: f850, t500: f500 });
            continue;
        }
        const gain = Math.max(0, Math.min(1, gainAt(h)));
        const o850 = rk2OriginField({
            u: lvl.u850, v: lvl.v850, tendU: tendU850, tendV: tendV850,
            gridW, gridH, h, substepH, tendencyHorizonH, gain, scratch,
        });
        for (let k = 0; k < N; k++) f850[k] = bilinearSample(t850, gridW, gridH, o850.colO[k], o850.rowO[k]);
        const o500 = rk2OriginField({
            u: lvl.u500, v: lvl.v500, tendU: tendU500, tendV: tendV500,
            gridW, gridH, h, substepH, tendencyHorizonH, gain, scratch,
        });
        for (let k = 0; k < N; k++) f500[k] = bilinearSample(t500, gridW, gridH, o500.colO[k], o500.rowO[k]);

        // Pack the pair CHW-style for the shared diffusion operator.
        const pair = new Float32Array(N * 2);
        pair.set(f850, 0); pair.set(f500, N);
        applyHorizontalDiffusion(pair, N, gridW, gridH, o850.steps, o850.dh, levelDiffusion, 2);
        f850.set(pair.subarray(0, N)); f500.set(pair.subarray(N, 2 * N));

        frames.push({ h, target_ms: issuedMs + h * 3_600_000, t850: f850, t500: f500 });
    }
    return { issued_ms: issuedMs, gridW, gridH, frames };
}

/**
 * Estimate a 2D pixel-velocity flow from the last two frames of a
 * weighted tracer-channel blend using Lucas-Kanade, convert to m/s,
 * then run the same semi-Lagrangian step as WindAdvection.
 *
 * Tracer-blend weighting
 * ──────────────────────
 * The tracer fed into LK is `Σ w_ch · channel_ch`, summed over the
 * configured tracer channels. The weights have three sources, multiplied
 * together and renormalised to sum to 1:
 *
 *   priorWeights     constructor-supplied per-channel prior. Defaults to
 *                    [0.20, 0.45, 0.35] for [low, mid, high] cloud —
 *                    storm-scale features track mid + high clouds (the
 *                    steering flow aloft) far better than low. Equal
 *                    weights effectively dilute the signal.
 *   skillTracker     optional TracerSkillTracker. Folds in the
 *                    forecaster's own per-channel MAE history at a target
 *                    horizon: channels the LK flow has historically
 *                    predicted accurately get more weight; channels that
 *                    keep missing get less. Adapts the blend to the
 *                    actual data over many forecast cycles.
 *   variance         per-frame spatial standard deviation of each
 *                    channel. Amplifies whatever channel happens to have
 *                    the most texture *right now* — flat featureless
 *                    fields make for under-determined LK gradient
 *                    matrices, so de-emphasising them tightens the fit.
 *
 * The variance multiplier is intentionally clipped to a narrow range
 * [0.5, 2.0] so a single quiet-channel snapshot can't completely
 * suppress that channel's contribution — the prior + long-term skill
 * keep the floor.
 */
export class OpticalFlowForecaster {
    static id = 'optical-flow-v1';
    /**
     * @param {object} [opts]
     * @param {number[]} [opts.tracerChannels]
     * @param {number}   [opts.windowRadius=2]
     * @param {number[]} [opts.priorWeights]   Default [0.20, 0.45, 0.35].
     * @param {object}   [opts.skillTracker]   TracerSkillTracker instance.
     * @param {boolean}  [opts.varianceAware=true]
     */
    constructor({
        tracerChannels = [CH_LOW, CH_MID, CH_HIGH],
        windowRadius = 2,
        priorWeights,
        skillTracker = null,
        varianceAware = true,
    } = {}) {
        this.id            = OpticalFlowForecaster.id;
        this._tracerChs    = tracerChannels.slice();
        this._windowRadius = windowRadius;
        // Meteorological prior: low cloud (boundary-layer-bound) is the
        // worst single-channel proxy for synoptic-scale motion; mid and
        // high (driven by the steering flow at 500 hPa and above) are
        // far better. The 0.20/0.45/0.35 split was reverse-engineered
        // from the typical balance of inverse-MSE you see after a few
        // weeks of an LK forecaster running with equal weights — it's
        // a useful starting point but not a fixed truth, hence the
        // skillTracker layer that learns the actual ratio per session.
        const defaultPrior = (this._tracerChs.length === 3)
            ? [0.20, 0.45, 0.35]
            : new Array(this._tracerChs.length).fill(1 / this._tracerChs.length);
        this._priorWeights = (Array.isArray(priorWeights) && priorWeights.length === this._tracerChs.length)
            ? priorWeights.slice()
            : defaultPrior;
        this._skillTracker = skillTracker;
        this._varianceAware = varianceAware !== false;
        // Most-recent applied weights — exposed for debug HUDs and
        // skill-validation diagnostics.
        this._lastWeights = null;
    }

    /** Diagnostic: latest normalised tracer weights (or null if none yet). */
    getLastWeights() { return this._lastWeights ? this._lastWeights.slice() : null; }

    forecast({ history }) {
        const frames = history.all();
        // Need at least two frames to estimate flow. If we have only
        // one we can't build the temporal gradient — bail and let
        // WindAdvection / persistence carry the load.
        if (frames.length < 2) return null;
        const prev = frames[frames.length - 2];
        const curr = frames[frames.length - 1];
        if (prev.gridW !== curr.gridW || prev.gridH !== curr.gridH) return null;
        const { gridW, gridH, coarse } = curr;
        const N = gridW * gridH;

        // Compute final per-channel weights for this forecast cycle.
        const weights = this._computeBlendWeights(curr);
        this._lastWeights = weights;

        // Build the weighted tracer. Multiply each channel's slice by
        // its weight and accumulate. This is the same shape as the
        // previous "equal-sum" tracer but with non-uniform contribution
        // — sharper signal where it matters.
        const prevTracer = new Float32Array(N);
        const currTracer = new Float32Array(N);
        for (let c = 0; c < this._tracerChs.length; c++) {
            const ch = this._tracerChs[c];
            const w = weights[c];
            const off = ch * N;
            const ps = prev.coarse.subarray(off, off + N);
            const cs = curr.coarse.subarray(off, off + N);
            for (let k = 0; k < N; k++) {
                prevTracer[k] += w * ps[k];
                currTracer[k] += w * cs[k];
            }
        }

        const { u, v } = lucasKanadeFlow({
            prev: prevTracer, curr: currTracer,
            gridW, gridH, windowRadius: this._windowRadius,
        });
        // Frames in the history ring are 1-hour-spaced (cron cadence);
        // cells with NaN flow already became 0 in lucasKanadeFlow's
        // det-threshold branch, so we don't need to scrub here.
        const { U: flowU, V: flowV } = lkPixelsToMs({
            u, v, gridW, gridH, framePeriodSec: 3600,
        });

        return buildAdvectedHorizons({
            history,
            modelId: this.id,
            flowU, flowV,
        });
    }

    // ── Internal: weight composition ──────────────────────────────────
    //
    // Combine prior × skill × variance multipliers into a single
    // normalised weight vector. Each multiplier is independently
    // clipped/floored so a runaway value in one source can't crowd out
    // the others.

    _computeBlendWeights(currFrame) {
        const C = this._tracerChs.length;
        // 1. Prior — the meteorological default or constructor override.
        const prior = this._priorWeights;

        // 2. Skill multiplier — pulled from the validator-fed tracker
        //    when one is wired. Already a normalised weight vector
        //    summing to 1; we use it as a multiplier here, so the
        //    final weight ∝ prior × skill (Bayes-flavoured combination
        //    of the strong prior with empirical evidence). Without a
        //    skillTracker, we use uniform = 1/C so prior survives
        //    unchanged.
        const skill = this._skillTracker
            ? this._skillTracker.getWeights()
            : new Array(C).fill(1 / C);
        // Defensive shape check — a tracker built for a different
        // channel set shouldn't be allowed to scramble these weights.
        const skillSafe = (skill?.length === C) ? skill : new Array(C).fill(1 / C);

        // 3. Variance multiplier — channels with more spatial texture
        //    contribute better-conditioned LK gradient matrices.
        //    Compute population stddev per channel on the current
        //    frame, normalise to a multiplier in [0.5, 2.0] so a
        //    quiet-channel snapshot can't fully suppress contribution
        //    (the prior + skill keep the floor).
        let varMult = new Array(C).fill(1);
        if (this._varianceAware) {
            const sds = new Float64Array(C);
            const N = currFrame.gridW * currFrame.gridH;
            for (let c = 0; c < C; c++) {
                const ch = this._tracerChs[c];
                const off = ch * N;
                let sum = 0, sumSq = 0;
                for (let k = 0; k < N; k++) {
                    const v = currFrame.coarse[off + k];
                    if (!Number.isFinite(v)) continue;
                    sum += v;
                    sumSq += v * v;
                }
                const mean = sum / N;
                const variance = Math.max(0, sumSq / N - mean * mean);
                sds[c] = Math.sqrt(variance);
            }
            // Normalise around the mean stddev. Clipped multiplier
            // range matters more than absolute scale because we re-
            // normalise at the end anyway.
            let meanSd = 0;
            for (let c = 0; c < C; c++) meanSd += sds[c];
            meanSd /= C;
            for (let c = 0; c < C; c++) {
                const r = meanSd > 1e-6 ? (sds[c] / meanSd) : 1;
                varMult[c] = Math.min(2.0, Math.max(0.5, r));
            }
        }

        // Combine: prior × skill × variance, then normalise.
        const combined = new Float32Array(C);
        let sum = 0;
        for (let c = 0; c < C; c++) {
            combined[c] = (prior[c] || 0) * (skillSafe[c] || 0) * (varMult[c] || 0);
            sum += combined[c];
        }
        if (sum <= 0) {
            // Pathological all-zero combination → fall back to uniform.
            const u = 1 / C;
            for (let c = 0; c < C; c++) combined[c] = u;
            return combined;
        }
        for (let c = 0; c < C; c++) combined[c] /= sum;
        return combined;
    }
}

/**
 * Convenience: spawn both forecasters with sensible defaults.
 *
 * @param {object} [opts]
 * @param {object} [opts.skillTracker]  TracerSkillTracker for the
 *   OpticalFlowForecaster. Without it, the forecaster falls back to
 *   meteorological prior + per-frame variance weighting only.
 * @param {object} [opts.gainTracker]   AdvectionGainTracker for the
 *   WindAdvectionForecaster. Without it, the forecaster runs the bare
 *   physics step (gain = 1 at every horizon).
 * @param {object} [opts.shearProxy]    WindShearProxy. Without it,
 *   steadiness = 1 (no runtime modulation of the gain).
 */
export function makeWeatherFlowForecasters({
    skillTracker = null,
    gainTracker  = null,
    shearProxy   = null,
} = {}) {
    return [
        new WindAdvectionForecaster({ gainTracker, shearProxy }),
        new OpticalFlowForecaster({ skillTracker }),
    ];
}

export default makeWeatherFlowForecasters;
