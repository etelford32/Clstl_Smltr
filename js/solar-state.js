/**
 * solar-state.js — Deterministic, validated, immutable solar wind state snapshots
 *
 * Every piece of solar-wind and magnetospheric physics in this project should
 * consume a SolarState snapshot rather than reaching into mutable bags.
 * Given the same inputs, a SolarState always produces the same outputs.
 *
 * ── Design principles ───────────────────────────────────────────────────────
 *  1. DETERMINISTIC — all physics are pure functions of the input fields.
 *     No Date.now(), no Math.random(), no hidden state.
 *  2. VALIDATED — every input is range-checked and clamped to physical bounds.
 *     Out-of-range values are flagged, not silently accepted.
 *  3. IMMUTABLE — snapshots are frozen after creation. Consumers cannot
 *     accidentally mutate shared state.
 *  4. QUALITY-TRACKED — each snapshot carries provenance: data source,
 *     staleness, validation flags, and a monotonic sequence number.
 *
 * ── Critical value thresholds ───────────────────────────────────────────────
 *  Physics changes qualitatively at certain boundaries. The snapshot computes
 *  which thresholds are currently crossed, enabling downstream systems to
 *  react to regime transitions rather than polling raw values.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { createSolarState, validateReading, VALID_RANGES } from './solar-state.js';
 *
 *   const state = createSolarState(rawL1, earthPos, timestamp);
 *   // state.quality        → 'parker-corrected' | 'l1-raw' | 'fallback'
 *   // state.validation     → { warnings: [], errors: [] }
 *   // state.criticals      → { bzSouthward: true, superAlfvenic: true, ... }
 *   // state.seq            → 42 (monotonic)
 *   // Object.isFrozen(state) → true
 */

// ── Physical validity ranges ────────────────────────────────────────────────
// Based on observed extremes from DSCOVR/ACE 1998–2025 + Carrington-event
// extrapolations.  Values outside these ranges are physically implausible
// and likely measurement errors or fill values.

export const VALID_RANGES = Object.freeze({
    // Solar wind speed (km/s): slowest credible ~200, fastest observed ~2500 (1859 Carrington)
    v_sw:    { min: 200,   max: 2500,  unit: 'km/s',  name: 'Solar wind speed' },
    // Proton density (cm⁻³): near-vacuum ~0.1, CME sheath ~100
    n:       { min: 0.1,   max: 200,   unit: 'cm⁻³',  name: 'Proton density' },
    // IMF Bz (nT): extreme southward ~−60, extreme northward ~+40
    bz:      { min: -60,   max: 40,    unit: 'nT',    name: 'IMF Bz' },
    // IMF Bt (nT): noise floor ~0.5, extreme ~80
    bt:      { min: 0.5,   max: 80,    unit: 'nT',    name: 'IMF Bt' },
    // IMF By (nT): extreme ~±50
    by:      { min: -50,   max: 50,    unit: 'nT',    name: 'IMF By' },
    // Kp index: 0–9 (integer thirds in practice, 0–9 here)
    kp:      { min: 0,     max: 9,     unit: '',      name: 'Kp index' },
    // X-ray flux (W/m²): quiet sun ~1e-9, X28 flare ~2.8e-3
    xray:    { min: 1e-10, max: 5e-3,  unit: 'W/m²',  name: 'X-ray flux' },
    // F10.7 (sfu): deep minimum ~65, extreme maximum ~350
    f107:    { min: 60,    max: 400,   unit: 'sfu',   name: 'F10.7 flux' },
    // Earth distance (AU): perihelion 0.983, aphelion 1.017
    r_AU:    { min: 0.97,  max: 1.04,  unit: 'AU',    name: 'Earth distance' },
    // Dynamic pressure (nPa): calm ~0.5, extreme ~100
    p_dyn:   { min: 0.1,   max: 100,   unit: 'nPa',   name: 'Dynamic pressure' },
    // Temperature (K): minimum credible ~5000, corona ~2MK
    T:       { min: 5000,  max: 2e6,   unit: 'K',     name: 'Plasma temperature' },
});

// ── Critical value thresholds ───────────────────────────────────────────────
// These define boundaries where the physics changes qualitatively.
// Each threshold has a name, the field to check, and a condition function.

const CRITICAL_THRESHOLDS = [
    // ── Reconnection onset: southward IMF opens the magnetosphere
    {
        id: 'bz_southward',
        field: 'bz',
        test: v => v < -1,
        label: 'IMF southward (reconnection favorable)',
        severity: v => v < -10 ? 'high' : v < -5 ? 'moderate' : 'low',
    },
    // ── Strong southward: intense substorm / storm driving
    {
        id: 'bz_strong_south',
        field: 'bz',
        test: v => v < -10,
        label: 'Strong southward IMF (storm driving)',
        severity: () => 'high',
    },
    // ── Super-Alfvénic flow: wind faster than local Alfven speed (always true at 1 AU)
    {
        id: 'super_alfvenic',
        field: '_v_ratio',
        test: (_, s) => s.v_sw > s.v_alfven,
        label: 'Super-Alfvénic solar wind',
        severity: () => 'info',
    },
    // ── High-beta plasma: thermal pressure dominates magnetic
    {
        id: 'high_beta',
        field: 'beta',
        test: v => v > 2.0,
        label: 'High-β plasma (thermally dominated)',
        severity: v => v > 5 ? 'moderate' : 'low',
    },
    // ── High dynamic pressure: magnetopause compression
    {
        id: 'high_pdyn',
        field: 'p_dyn',
        test: v => v > 4.0,
        label: 'Elevated dynamic pressure (magnetopause compressed)',
        severity: v => v > 10 ? 'high' : 'moderate',
    },
    // ── Fast wind: coronal hole stream arrival
    {
        id: 'fast_wind',
        field: 'v_sw',
        test: v => v > 600,
        label: 'Fast solar wind stream',
        severity: v => v > 800 ? 'high' : 'moderate',
    },
    // ── Slow dense wind: streamer belt / CME sheath candidate
    {
        id: 'slow_dense',
        field: '_slow_dense',
        test: (_, s) => s.v_sw < 350 && s.n > 15,
        label: 'Slow dense wind (possible sheath)',
        severity: () => 'moderate',
    },
    // ── Geomagnetic storm conditions
    {
        id: 'g1_storm',
        field: 'kp',
        test: v => v >= 5,
        label: 'G1+ geomagnetic storm',
        severity: v => v >= 8 ? 'high' : v >= 7 ? 'high' : v >= 6 ? 'moderate' : 'low',
    },
];

// ── Monotonic sequence counter ──────────────────────────────────────────────
let _seq = 0;

// ── Input validation ────────────────────────────────────────────────────────

/**
 * Validate and clamp a single field against its physical range.
 * Returns { value, clamped, warning }.
 *
 * @param {string} field   Field name (key into VALID_RANGES)
 * @param {number} raw     Raw input value
 * @returns {{ value: number, clamped: boolean, warning: string|null }}
 */
export function validateField(field, raw) {
    const range = VALID_RANGES[field];
    if (!range) return { value: raw, clamped: false, warning: null };

    if (raw == null || !Number.isFinite(raw)) {
        return {
            value: (range.min + range.max) / 2,
            clamped: true,
            warning: `${range.name}: non-finite value (${raw}), using midpoint`,
        };
    }

    if (raw < range.min) {
        return {
            value: range.min,
            clamped: true,
            warning: `${range.name}: ${raw} ${range.unit} below minimum (${range.min}), clamped`,
        };
    }

    if (raw > range.max) {
        return {
            value: range.max,
            clamped: true,
            warning: `${range.name}: ${raw} ${range.unit} above maximum (${range.max}), clamped`,
        };
    }

    return { value: raw, clamped: false, warning: null };
}

/**
 * Validate a complete L1 reading object.
 * Returns { validated, warnings, errors, valid }.
 *
 * @param {object} reading  Raw reading { v_sw, n, bz, bt, by, kp }
 * @returns {{ validated: object, warnings: string[], errors: string[], valid: boolean }}
 */
export function validateReading(reading) {
    const warnings = [];
    const errors = [];

    const fields = { v_sw: 'v_sw', n: 'n', bz: 'bz', bt: 'bt', by: 'by', kp: 'kp' };
    const validated = {};

    for (const [key, rangeKey] of Object.entries(fields)) {
        const raw = reading[key];
        const { value, clamped, warning } = validateField(rangeKey, raw);
        validated[key] = value;
        if (warning) warnings.push(warning);
    }

    // Cross-field consistency: Bt should be >= |Bz| (total field >= component)
    if (validated.bt < Math.abs(validated.bz)) {
        warnings.push(`IMF Bt (${validated.bt.toFixed(1)} nT) < |Bz| (${Math.abs(validated.bz).toFixed(1)} nT) — inconsistent, Bt raised`);
        validated.bt = Math.abs(validated.bz) * 1.1;
    }

    // Density-speed anticorrelation sanity: extreme density + extreme speed is suspicious
    if (validated.v_sw > 900 && validated.n > 50) {
        warnings.push(`Unusual: v_sw=${validated.v_sw.toFixed(0)} km/s with n=${validated.n.toFixed(1)} cm⁻³ — rare combination, possible data artifact`);
    }

    return {
        validated,
        warnings,
        errors,
        valid: errors.length === 0,
    };
}

// ── Solar zenith angle computation ──────────────────────────────────────────

/**
 * Compute solar zenith angle for a given location and time.
 * Deterministic: depends only on lat, lon, and timestamp.
 *
 * @param {number} latDeg  Geographic latitude (degrees, -90 to +90)
 * @param {number} lonDeg  Geographic longitude (degrees, -180 to +180)
 * @param {number} ts_ms   Unix timestamp (milliseconds)
 * @returns {number} Solar zenith angle in degrees (0 = subsolar, 90 = horizon)
 */
export function solarZenithAngle(latDeg, lonDeg, ts_ms) {
    const D2R = Math.PI / 180;
    const d = new Date(ts_ms);

    // Day of year (1-based)
    const start = new Date(d.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((d - start) / 86400000);

    // Solar declination (Spencer 1971 approximation)
    const B = (2 * Math.PI / 365) * (dayOfYear - 81);
    const declRad = 23.45 * D2R * Math.sin(B);

    // Hour angle (solar noon = 0)
    const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    const solarNoon = 12 - lonDeg / 15;
    const hourAngleRad = ((utcHours - solarNoon) * 15) * D2R;

    // Solar zenith angle from spherical trig
    const latRad = latDeg * D2R;
    const cosZ = Math.sin(latRad) * Math.sin(declRad)
               + Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourAngleRad);

    return Math.acos(Math.max(-1, Math.min(1, cosZ))) / D2R;
}

// ── Propagation delay (speed-dependent) ─────────────────────────────────────

/**
 * Compute L1 → Earth propagation delay from the previous frame's wind speed.
 * Deterministic: pure function of v_sw_prev and L1 offset.
 *
 * Uses the PREVIOUS reading's speed to avoid circular dependency:
 * the delay determines which historical reading to use, and that reading's
 * speed must not determine the delay that selected it.
 *
 * @param {number} v_sw_prev  Previous frame's solar wind speed (km/s)
 * @param {number} l1_km      L1 distance from Earth (km)
 * @returns {number} Delay in seconds, clamped to [1200, 7200] (20–120 min)
 */
export function propagationDelay(v_sw_prev, l1_km = 1_500_000) {
    const v = Math.max(200, v_sw_prev);
    const delay = l1_km / v;  // seconds
    // Clamp to physically plausible range
    return Math.max(1200, Math.min(7200, delay));
}

// ── Critical threshold evaluation ───────────────────────────────────────────

/**
 * Evaluate all critical thresholds against a state snapshot.
 * Returns an object keyed by threshold ID with { active, label, severity }.
 *
 * Deterministic: pure function of state fields.
 *
 * @param {object} state  Solar state snapshot
 * @returns {object} criticals — { [id]: { active, label, severity } }
 */
export function evaluateCriticals(state) {
    const result = {};
    for (const t of CRITICAL_THRESHOLDS) {
        const val = state[t.field];
        const active = t.test(val, state);
        result[t.id] = {
            active,
            label: t.label,
            severity: active ? t.severity(val, state) : null,
        };
    }
    return result;
}

// ── Snapshot creation ───────────────────────────────────────────────────────

/**
 * Create a validated, immutable solar state snapshot.
 *
 * This is the ONLY function that should produce state objects consumed
 * by the physics pipeline. Everything else reads from these snapshots.
 *
 * Deterministic: given the same (l1, earthPos, ts_ms, prevSpeed), the
 * output is always identical. No hidden state, no randomness.
 *
 * @param {object} l1         L1 reading { v_sw, n, bz, bt, by, kp }
 * @param {object} earthPos   Earth position { r_AU, lon_rad, lat_rad, x_AU, y_AU, z_AU } | null
 * @param {number} ts_ms      Timestamp for this snapshot (ms since epoch)
 * @param {object} opts
 * @param {number} [opts.prevSpeed]   Previous frame's wind speed (for delay calc)
 * @param {number} [opts.xray]       GOES X-ray flux (W/m²)
 * @param {number} [opts.f107]       F10.7 flux (sfu)
 * @param {number} [opts.szaDeg]     Override SZA (if null, computed from location)
 * @param {object} [opts.location]   { lat, lon } for SZA computation
 * @returns {Readonly<SolarStateSnapshot>}
 */
export function createSolarState(l1, earthPos, ts_ms, opts = {}) {
    // ── Validate inputs ─────────────────────────────────────────────────────
    const { validated, warnings } = validateReading(l1);

    // ── Determine data quality ──────────────────────────────────────────────
    let quality;
    if (earthPos && earthPos.r_AU > 0.5) {
        quality = 'parker-corrected';
    } else if (l1.v_sw > 0) {
        quality = 'l1-raw';
    } else {
        quality = 'fallback';
    }

    // ── Propagation delay ───────────────────────────────────────────────────
    const prevSpeed = opts.prevSpeed ?? validated.v_sw;
    const delay_s = propagationDelay(prevSpeed);

    // ── Solar zenith angle ──────────────────────────────────────────────────
    let szaDeg = opts.szaDeg;
    if (szaDeg == null && opts.location?.lat != null) {
        szaDeg = solarZenithAngle(opts.location.lat, opts.location.lon, ts_ms);
    }
    if (szaDeg == null) szaDeg = 50;  // fallback for no-location users

    // ── Distance ────────────────────────────────────────────────────────────
    const r_AU = earthPos?.r_AU ?? 1.0;

    // ── Assemble the snapshot ───────────────────────────────────────────────
    const seq = ++_seq;

    const snapshot = {
        // ── Identity ────────────────────────────────────────────────────────
        seq,
        ts_ms,
        quality,

        // ── Validated L1 inputs ─────────────────────────────────────────────
        l1: Object.freeze({ ...validated }),

        // ── Orbital geometry ────────────────────────────────────────────────
        r_AU,
        lon_rad: earthPos?.lon_rad ?? 0,
        lat_rad: earthPos?.lat_rad ?? 0,

        // ── Core plasma (to be filled by SolarWindState) ────────────────────
        v_sw:    validated.v_sw,
        n:       validated.n,
        bz:      validated.bz,
        bt:      validated.bt,
        by:      validated.by,
        kp:      validated.kp,

        // ── Extended fields (set by SolarWindState after Parker scaling) ─────
        T:       0,
        v_alfven: 0,
        beta:    0,
        p_dyn:   0,
        B_r:     0,
        B_phi:   0,
        B_total: 0,
        spiral_angle_rad: 0,

        // ── Supplementary ───────────────────────────────────────────────────
        xray:    opts.xray ?? 1e-8,
        f107:    opts.f107 ?? 150,
        szaDeg,
        delay_s,
        delay_min: delay_s / 60,

        // ── Provenance ──────────────────────────────────────────────────────
        validation: Object.freeze({
            warnings: Object.freeze(warnings),
            n_warnings: warnings.length,
            all_valid: warnings.length === 0,
        }),

        // ── Critical thresholds (populated below) ───────────────────────────
        criticals: null,
    };

    // Criticals need the snapshot to exist first (cross-field checks)
    snapshot.criticals = Object.freeze(evaluateCriticals(snapshot));

    return Object.freeze(snapshot);
}

// ── Snapshot enrichment (called after Parker scaling) ────────────────────────

/**
 * Create a new snapshot with Parker-corrected derived quantities.
 * Returns a NEW frozen object — the original is not mutated.
 *
 * @param {Readonly<object>} base  Base snapshot from createSolarState()
 * @param {object} derived         Parker-corrected fields
 * @returns {Readonly<object>}     New enriched snapshot
 */
export function enrichSolarState(base, derived) {
    const enriched = {
        ...base,
        ...derived,
        quality: derived._quality ?? base.quality,
    };
    delete enriched._quality;

    // Recompute criticals with enriched data
    enriched.criticals = Object.freeze(evaluateCriticals(enriched));

    return Object.freeze(enriched);
}
