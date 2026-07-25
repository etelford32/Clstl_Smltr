/**
 * msis-drag.js — NRLMSISE-00-grade orbit decay for the Operations console.
 * ═══════════════════════════════════════════════════════════════════════════
 * Replaces the King-Hele lifetime surrogate (OPERATIONS_STATUS.md roadmap
 * items #13 + #14) with a real per-orbit decay integration:
 *
 *   • Density comes from the vendored NRLMSISE-00 Rust/WASM kernel — the
 *     same committed build the upper-atmosphere lab uses via
 *     js/nrlmsise00-bridge.js. One profile call per index state, then
 *     log-linear interpolation in pure JS, so the render path never
 *     blocks on WASM per-point evaluations.
 *   • The ballistic coefficient B = C_D·A/m is read from the TLE's own
 *     B* field (line 1, cols 54–61) via B = 12.741621 · B*  [m²/kg per
 *     R_E⁻¹] — the standard SGP4 reference-atmosphere conversion
 *     (ρ₀ = 0.15696615 kg·m⁻²·R_E⁻¹, B = 2·B* / ρ₀).
 *   • The integrator orbit-averages the Gauss variational equations for
 *     a tangential drag decel f_t = −½ρv²B:
 *         da/dt = −a²ρv³B/μ          (energy method; no stray ½)
 *         de/dt = −(e + cos ν)·ρvB
 *     sampled at N points of eccentric anomaly with dt ∝ (1 − e·cosE)
 *     weighting, then steps (a, e) forward until perigee reaches the
 *     ~100 km reentry interface or the horizon cap.
 *
 * HONESTY CAVEATS (these are load-bearing; keep them in the provenance):
 *   • TLE B* is a fit parameter of SGP4's power-law atmosphere, not a
 *     physical measurement — it absorbs density-model bias, solar
 *     radiation pressure, and maneuver residue, and is routinely a
 *     factor ~2 from the physical C_D·A/m (ISS is the canonical
 *     example). σ carries ±35 % for TLE-sourced B and ±60 % for the
 *     default fallback; lifetime ∝ 1/B exactly under a fixed profile,
 *     so that σ term is analytic, not another integration.
 *   • B* ≤ 0 or absurd values (empty field, GEO fit artifacts) fall
 *     back to DEFAULT_BC with the wider σ — never to a crash.
 *   • Density is evaluated on an equatorial day/night-averaged profile
 *     (two MSIS profiles at LST 0 and 12, averaged). Latitude and
 *     per-pass local-time structure are real second-order effects the
 *     triage number deliberately averages over.
 *   • This is still triage, not flight dynamics — the provenance
 *     records say so, exactly like the surrogate's did.
 *
 * FALLBACK LADDER: no provider registered (WASM missing / init failed /
 * node without injection) → every msis* entry point returns null and
 * decision-deck.js falls through to the King-Hele surrogate unchanged.
 * The drag SHELL + prop budget (sw-model.js drag.rho450) intentionally
 * stay on the Bates surrogate this sprint: the shell's colour ramp and
 * RHO_REF_450 normalise against each other inside one model, and mixing
 * an MSIS numerator with a Bates reference would silently skew the
 * "×N vs quiet" overhead. Migrate them together or not at all.
 *
 * PURITY: everything above startMsisDecay() is DOM-free and WASM-free —
 * the density provider is injected, so tests/operations-msis-drag.mjs
 * exercises the integrator with an analytic atmosphere AND with the real
 * committed WASM. Run it after ANY edit here.
 */

const RE_KM   = 6378.135;      // WGS-72, matches satellite-tracker / SGP4
const MU_SI   = 3.986008e14;   // WGS-72 μ, m³/s² (matches orbit-inspector)
const DAY_S   = 86400;

// B [m²/kg] per unit B* [1/R_E]: 2 / ρ₀ with ρ₀ = 0.15696615 kg·m⁻²·R_E⁻¹.
export const BSTAR_TO_BC = 12.741621;

// Fallback C_D·A/m when the TLE's B* is unusable — a mid-catalog payload
// (C_D 2.2, A/m ≈ 0.007 m²/kg). Deliberately generic; σ carries the doubt.
export const DEFAULT_BC = 0.015;

const SIGMA_FRAC_TLE     = 0.35;   // ±35 % on B when read from TLE B*
const SIGMA_FRAC_DEFAULT = 0.60;   // ±60 % when we guessed B

// Density-profile grid the provider fills: 90 → 1590 km at 10-km steps.
// Above the grid the interpolator extrapolates on the last log-slope;
// perigees above STABLE_PERIGEE_KM shortcut to "effectively stable"
// without touching the provider at all.
export const PROFILE_MIN_KM  = 90;
export const PROFILE_MAX_KM  = 1590;
export const PROFILE_NPOINTS = 151;
const STABLE_PERIGEE_KM      = 1400;

const REENTRY_KM   = 100;      // integration stops here; below is hours
const MAX_DAYS     = 36525;    // 100 yr horizon → report Infinity beyond
const RHO_FLOOR    = 1e-19;    // kg/m³ — extrapolation floor

/* ─── TLE B* parsing ─────────────────────────────────────────────── */

/**
 * Parse the B* drag term from TLE line 1 (columns 54–61, 1-indexed).
 * Format is a packed scientific decimal: ` 34123-4` → +0.34123e-4,
 * `-11606-4` → −0.11606e-4, ` 00000+0` → 0. Returns null when the
 * field is absent or unparseable — never throws.
 */
export function parseBstar(line1) {
    if (typeof line1 !== 'string' || line1.length < 61) return null;
    const field = line1.substring(53, 61);
    const m = field.match(/^([ +-])(\d{5})([+-])(\d)$/);
    if (!m) return null;
    const mantissa = Number(`0.${m[2]}`) * (m[1] === '-' ? -1 : 1);
    const exp      = Number(m[4]) * (m[3] === '-' ? -1 : 1);
    const v = mantissa * Math.pow(10, exp);
    return Number.isFinite(v) ? v : null;
}

/** B* [1/R_E] → ballistic coefficient C_D·A/m [m²/kg]. */
export function bstarToBallistic(bstar) {
    return BSTAR_TO_BC * bstar;
}

/**
 * Resolve the ballistic coefficient for a TLE record. Prefers the TLE's
 * own B* when it's physically plausible; otherwise the generic default
 * with a wider σ. Bounds: B* below 1e-9 R_E⁻¹ is indistinguishable from
 * a zero-fill (GEO / fresh objects), above 0.5 it's a fit artifact.
 */
export function ballisticFromTle(tle) {
    const bstar = tle?.line1 ? parseBstar(tle.line1) : null;
    if (Number.isFinite(bstar) && bstar > 1e-9 && bstar < 0.5) {
        return { bc: bstarToBallistic(bstar), bstar, source: 'tle-bstar', sigmaFrac: SIGMA_FRAC_TLE };
    }
    return { bc: DEFAULT_BC, bstar, source: 'default', sigmaFrac: SIGMA_FRAC_DEFAULT };
}

/* ─── Density profile provider + interpolation ───────────────────── */

// Injected by startMsisDecay() in the browser, or directly by tests.
// Signature: ({ f107, ap, dateMs }) → { alt0, step, rho: Float64Array } | null
let _provider  = null;
let _dateMs    = null;          // () => ms; page wires the operations timeBus
let _readySubs = new Set();
let _warned    = false;

export function setDensityProvider(fn, { getDateMs } = {}) {
    _provider = typeof fn === 'function' ? fn : null;
    if (typeof getDateMs === 'function') _dateMs = getDateMs;
    if (_provider) for (const s of _readySubs) { try { s(); } catch (_) {} }
}

export function hasMsisProvider() { return _provider !== null; }

/** Subscribe to "MSIS decay became available"; returns unsubscribe. */
export function onMsisReady(fn) {
    _readySubs.add(fn);
    if (_provider) { try { fn(); } catch (_) {} }
    return () => _readySubs.delete(fn);
}

function nowMs() { return _dateMs ? _dateMs() : Date.now(); }

// Profile cache: index state changes at most every provStore republish;
// all fleet assets share one (f107, ap, 3-h time bucket) key, so a Decay
// Watch recompute costs at most 3 provider calls (mid / +σ / −σ).
const _cache = new Map();
const CACHE_MAX = 12;

function getProfile(f107, ap, dateMs) {
    if (!_provider) return null;
    const key = `${Math.round(f107)}|${Math.round(ap)}|${Math.floor(dateMs / (3 * 3600e3))}`;
    let p = _cache.get(key);
    if (p !== undefined) return p;
    try {
        p = _provider({ f107, ap, dateMs }) ?? null;
    } catch (err) {
        if (!_warned) { console.warn('[msis-drag] density provider threw:', err); _warned = true; }
        p = null;
    }
    if (_cache.size >= CACHE_MAX) _cache.clear();
    _cache.set(key, p);
    return p;
}

/**
 * Build a ρ(altKm) interpolator over a profile: log-linear inside the
 * grid, log-slope extrapolation off either end, floored at RHO_FLOOR.
 */
export function makeRhoInterp(profile) {
    const { alt0, step, rho } = profile;
    const n = rho.length;
    const logRho = new Float64Array(n);
    for (let i = 0; i < n; i++) logRho[i] = Math.log(Math.max(RHO_FLOOR, rho[i]));
    const loSlope = (logRho[1] - logRho[0]) / step;
    const hiSlope = (logRho[n - 1] - logRho[n - 2]) / step;
    const altMax  = alt0 + (n - 1) * step;
    return (altKm) => {
        let lr;
        if (altKm <= alt0) {
            lr = logRho[0] + loSlope * (altKm - alt0);
        } else if (altKm >= altMax) {
            lr = logRho[n - 1] + hiSlope * (altKm - altMax);
        } else {
            const x = (altKm - alt0) / step;
            const i = Math.floor(x);
            const f = x - i;
            lr = logRho[i] * (1 - f) + logRho[i + 1] * f;
        }
        return Math.max(RHO_FLOOR, Math.exp(lr));
    };
}

/* ─── Orbit-averaged decay integration (pure) ────────────────────── */

/**
 * Time-weighted orbit average of the drag rates at (aKm, e).
 * Returns { adotKmDay, edotPerDay } — both ≤ 0 for a decaying orbit.
 */
export function orbitAverageRates(aKm, e, bc, rhoAt, nSamples = 24) {
    const aM = aKm * 1000;
    let sumW = 0, sumA = 0, sumE = 0;
    for (let k = 0; k < nSamples; k++) {
        const E    = (2 * Math.PI * k) / nSamples;
        const cosE = Math.cos(E);
        const w    = 1 - e * cosE;                 // dt ∝ (1 − e·cosE) dE
        const rKm  = aKm * w;
        const alt  = rKm - RE_KM;
        const rho  = rhoAt(alt);
        const rM   = rKm * 1000;
        const v2   = MU_SI * (2 / rM - 1 / aM);    // vis-viva, (m/s)²
        if (!(v2 > 0)) continue;
        const v    = Math.sqrt(v2);
        const adot = -(aM * aM) * rho * v * v2 * bc / MU_SI;   // m/s
        const cosNu = (cosE - e) / w;
        const edot  = -(e + cosNu) * rho * v * bc;             // 1/s
        sumW += w; sumA += w * adot; sumE += w * edot;
    }
    if (sumW === 0) return { adotKmDay: 0, edotPerDay: 0 };
    return {
        adotKmDay:  (sumA / sumW) * DAY_S / 1000,
        edotPerDay: (sumE / sumW) * DAY_S,
    };
}

/**
 * Integrate (a, e) forward under orbit-averaged drag until the perigee
 * altitude reaches `reentryKm` or `maxDays` elapses. Step size targets
 * a ≤ `stepAKm` semi-major change per step so the density gradient is
 * always resolved; a quiet high orbit therefore exits in a handful of
 * giant steps rather than thousands of tiny ones.
 *
 * Pure: density arrives as rhoAt(altKm) → kg/m³. Returns
 *   { lifetimeDays, dadtKmDay, finalE, steps, reentered }
 * with lifetimeDays = Infinity when the orbit survives the horizon.
 */
export function integrateDecay({
    perigeeKm, apogeeKm, bc, rhoAt,
    maxDays = MAX_DAYS, reentryKm = REENTRY_KM,
    nSamples = 24, stepAKm = 2, maxSteps = 6000,
}) {
    let aKm = RE_KM + (perigeeKm + apogeeKm) / 2;
    let e   = Math.max(0, (apogeeKm - perigeeKm) / (2 * aKm));
    let t   = 0;
    let dadt0 = null;
    let steps = 0;

    while (steps < maxSteps) {
        const perAlt = aKm * (1 - e) - RE_KM;
        if (perAlt <= reentryKm) {
            return { lifetimeDays: t, dadtKmDay: dadt0 ?? 0, finalE: e, steps, reentered: true };
        }
        const { adotKmDay, edotPerDay } = orbitAverageRates(aKm, e, bc, rhoAt, nSamples);
        if (dadt0 === null) dadt0 = adotKmDay;
        if (!(adotKmDay < -1e-12)) {
            // No meaningful decay at this state — stable within the horizon.
            return { lifetimeDays: Infinity, dadtKmDay: dadt0 ?? 0, finalE: e, steps, reentered: false };
        }
        let dt = stepAKm / Math.abs(adotKmDay);              // days
        dt = Math.max(1e-4, Math.min(dt, maxDays - t + 1));
        aKm += adotKmDay * dt;
        e    = Math.max(0, e + edotPerDay * dt);
        t   += dt;
        steps++;
        if (t >= maxDays) {
            return { lifetimeDays: Infinity, dadtKmDay: dadt0, finalE: e, steps, reentered: false };
        }
    }
    // Step-budget exhausted (defensive; ~6000 × 2 km ≫ any LEO descent).
    return { lifetimeDays: t, dadtKmDay: dadt0 ?? 0, finalE: e, steps, reentered: false };
}

/* ─── Console-facing API (same shapes decision-deck consumes) ────── */

function clampF107(v) { return Math.max(60, Math.min(400, v)); }
function clampAp(v)   { return Math.max(2,  Math.min(400, v)); }

function integrateAt(tle, bc, f107, ap, dateMs) {
    const profile = getProfile(f107, ap, dateMs);
    if (!profile) return null;
    return integrateDecay({
        perigeeKm: tle.perigee_km,
        apogeeKm:  Number.isFinite(tle.apogee_km) ? tle.apogee_km : tle.perigee_km,
        bc,
        rhoAt: makeRhoInterp(profile),
    });
}

/**
 * MSIS-grade drop-in for decision-deck's decayWithSigma. Returns null
 * whenever the MSIS path can't run (no provider, bad TLE, provider
 * failure) — the caller falls back to the surrogate.
 *
 * σ combines the index-forecast spread (two extra integrations at ±σ
 * indices) with the ballistic-coefficient doubt (analytic: lifetime is
 * exactly ∝ 1/B under a fixed profile) in quadrature — the same recipe
 * the surrogate used, with the ±25 % blanket replaced by per-source
 * B* uncertainty.
 */
export function msisDecayWithSigma(tle, f107Mid, sigF107, apMid, sigAp) {
    if (!_provider || !Number.isFinite(tle?.perigee_km)) return null;
    const perigee = tle.perigee_km;
    const { bc, bstar, source, sigmaFrac } = ballisticFromTle(tle);

    if (perigee >= STABLE_PERIGEE_KM) {
        return {
            lifetime_days: Infinity, sigma_days: 0, perigee_km: perigee,
            dadt_km_day: 0, model: 'msis', bstar, bc, bcSource: source,
        };
    }

    const dateMs = nowMs();
    const mid = integrateAt(tle, bc, f107Mid, apMid, dateMs);
    if (!mid) return null;

    if (!Number.isFinite(mid.lifetimeDays)) {
        return {
            lifetime_days: Infinity, sigma_days: 0, perigee_km: perigee,
            dadt_km_day: mid.dadtKmDay, model: 'msis', bstar, bc, bcSource: source,
        };
    }

    const hi = integrateAt(tle, bc, clampF107(f107Mid + sigF107), clampAp(apMid + sigAp), dateMs);
    const lo = integrateAt(tle, bc, clampF107(f107Mid - sigF107), clampAp(apMid - sigAp), dateMs);
    const sigIdx = (hi && lo && Number.isFinite(hi.lifetimeDays) && Number.isFinite(lo.lifetimeDays))
        ? Math.abs(lo.lifetimeDays - hi.lifetimeDays) / 2
        : mid.lifetimeDays * 0.5;
    const sigBc = mid.lifetimeDays * sigmaFrac;

    return {
        lifetime_days: mid.lifetimeDays,
        sigma_days:    Math.sqrt(sigIdx * sigIdx + sigBc * sigBc),
        perigee_km:    perigee,
        dadt_km_day:   mid.dadtKmDay,
        model: 'msis', bstar, bc, bcSource: source,
    };
}

/**
 * MSIS-grade drop-in for decision-deck's deltaAPerDay: the instantaneous
 * orbit-averaged dā/dt (km/day, ≤ 0) at the current elements. Null when
 * the MSIS path can't run.
 */
export function msisDeltaAPerDay(tle, f107, ap) {
    if (!_provider || !Number.isFinite(tle?.perigee_km)) return null;
    if (tle.perigee_km >= STABLE_PERIGEE_KM) return 0;
    const profile = getProfile(f107, ap, nowMs());
    if (!profile) return null;
    const apo = Number.isFinite(tle.apogee_km) ? tle.apogee_km : tle.perigee_km;
    const aKm = RE_KM + (tle.perigee_km + apo) / 2;
    const e   = Math.max(0, (apo - tle.perigee_km) / (2 * aKm));
    const bc  = ballisticFromTle(tle).bc;
    return orbitAverageRates(aKm, e, bc, makeRhoInterp(profile)).adotKmDay;
}

/**
 * Point density from the cached MSIS profile (kg/m³), for panels that
 * quote ρ at a specific altitude. Null when unavailable — callers keep
 * their surrogate fallback.
 */
export function msisRhoAt(altKm, f107, ap) {
    if (!_provider || !Number.isFinite(altKm)) return null;
    const profile = getProfile(f107, ap, nowMs());
    if (!profile) return null;
    return makeRhoInterp(profile)(altKm);
}

/* ─── Browser boot glue ──────────────────────────────────────────── */

/**
 * Load the NRLMSISE-00 bridge (dynamic import keeps this module's static
 * graph pure for node tests), await the shared WASM, and register the
 * day/night-averaged equatorial profile provider. `getDateMs` should be
 * the operations timeBus sim time so a scrub into a forecast window
 * evaluates MSIS at the sim date (season + UT matter to the model).
 * Resolves true when the MSIS path is live, false on any failure —
 * failure leaves the surrogate in charge, never a broken page.
 */
export async function startMsisDecay({ getDateMs } = {}) {
    try {
        const bridge = await import('../nrlmsise00-bridge.js');
        const ok = await bridge.ensureMsisReady();
        if (!ok) return false;

        const step = (PROFILE_MAX_KM - PROFILE_MIN_KM) / (PROFILE_NPOINTS - 1);
        setDensityProvider(({ f107, ap, dateMs }) => {
            const date = new Date(dateMs);
            const utHr = date.getUTCHours() + date.getUTCMinutes() / 60;
            // Two profiles at local solar noon and midnight (via longitude
            // choice), averaged — the diurnal density swing is a factor
            // ~2–3 at 400 km and an orbit passes through both sides.
            const lonForLst = lst => ((lst - utHr) * 15 + 540) % 360 - 180;
            const halves = [0, 12].map(lst => bridge.sampleProfileMSIS({
                f107Sfu: f107, ap,
                minKm: PROFILE_MIN_KM, maxKm: PROFILE_MAX_KM, nPoints: PROFILE_NPOINTS,
                latDeg: 0, lonDeg: lonForLst(lst), nowDate: date,
            }));
            if (!halves[0] || !halves[1]) return null;
            const rho = new Float64Array(PROFILE_NPOINTS);
            for (let i = 0; i < PROFILE_NPOINTS; i++) {
                rho[i] = 0.5 * (halves[0].samples[i].rho + halves[1].samples[i].rho);
            }
            return { alt0: PROFILE_MIN_KM, step, rho };
        }, { getDateMs });
        return true;
    } catch (err) {
        console.warn('[msis-drag] MSIS decay init failed — surrogate stays active:', err);
        return false;
    }
}
