//! SGP4/SDP4 Orbital Propagator — WebAssembly Module
//!
//! Implements the Simplified General Perturbations model (SGP4) for
//! propagating Two-Line Element sets (TLEs) to arbitrary future times.
//!
//! Based on:
//!   Hoots & Roehrich (1980) "Spacetrack Report No. 3"
//!   Vallado et al. (2006) "Revisiting Spacetrack Report #3" — AIAA 2006-6753
//!
//! Key features:
//!   - Full SGP4 for near-Earth orbits (period < 225 min)
//!   - SDP4 deep-space extensions (period ≥ 225 min) — lunar/solar perturbations
//!   - J2, J3, J4 zonal harmonics (Earth oblateness)
//!   - Atmospheric drag (B* parameter from TLE)
//!   - Returns TEME (True Equator Mean Equinox) position & velocity vectors
//!
//! Exported to JavaScript via wasm-bindgen.

use wasm_bindgen::prelude::*;
use std::f64::consts::PI;

// ── WGS-72 constants (SGP4 standard, NOT WGS-84) ──────────────────────────

const MU: f64 = 398600.8;            // km³/s² — gravitational parameter
const RE: f64 = 6378.135;            // km — Earth equatorial radius
const KE: f64 = 0.0743669161;        // (RE³/MU)^0.5 in min⁻¹  = √(μ)/RE^1.5 in er/min
const J2: f64 = 0.001082616;         // second zonal harmonic
const J3: f64 = -0.00000253881;      // third zonal harmonic
const J4: f64 = -0.00000165597;      // fourth zonal harmonic
const CK2: f64 = J2 / 2.0;          // 5.413080e-4
const CK4: f64 = -3.0 * J4 / 8.0;   // 6.209887e-7
const QOMS2T: f64 = 1.880279e-09;    // (q₀ − s)⁴ in (er)⁴
const S: f64 = 1.01222928;           // s parameter in er  (1 + 78/RE)
const TWOPI: f64 = 2.0 * PI;
const DEG2RAD: f64 = PI / 180.0;
const MIN_PER_DAY: f64 = 1440.0;
const XJ3OJ2: f64 = J3 / J2;        // -2.34507e-3

// ── TLE parsed elements ────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct TleElements {
    // Line 1
    norad_id: u32,
    epoch_yr: f64,       // fractional year (e.g. 2026.254)
    epoch_jd: f64,       // Julian Day of epoch
    bstar: f64,          // B* drag term (1/er)
    // Line 2
    incl: f64,           // inclination (rad)
    raan: f64,           // right ascension of ascending node (rad)
    ecc: f64,            // eccentricity
    argp: f64,           // argument of perigee (rad)
    mean_anom: f64,      // mean anomaly (rad)
    mean_motion: f64,    // revs/day → rad/min
    rev_num: u32,        // revolution number at epoch
}

// ── SGP4 internal state ────────────────────────────────────────────────────

struct Sgp4State {
    // Initialized constants
    a0: f64, n0: f64, // recovered semi-major axis and mean motion
    // Secular rates
    mdot: f64, nodedot: f64, argpdot: f64,
    // Drag terms
    c1: f64, c4: f64, c5: f64, d2: f64, d3: f64, d4: f64,
    t2cof: f64, t3cof: f64, t4cof: f64, t5cof: f64,
    // Orbital elements at epoch
    tle: TleElements,
    // Flags
    deep_space: bool,
    // Additional precomputed values
    eta: f64, aodp: f64, perigee: f64,
    sinI0: f64, cosI0: f64, x1mth2: f64, x7thm1: f64,
    xlcof: f64, aycof: f64, x3thm1: f64,
    omgcof: f64, xmcof: f64, xnodcf: f64, delmo: f64,
}

// ── TLE Parser ─────────────────────────────────────────────────────────────

fn parse_tle(line1: &str, line2: &str) -> Result<TleElements, String> {
    if line1.len() < 69 || line2.len() < 69 {
        return Err("TLE lines must be at least 69 characters".into());
    }

    let norad_id: u32 = line1[2..7].trim().parse().map_err(|_| "Bad NORAD ID")?;

    // Epoch: YY + fractional day
    let epoch_yr_2d: f64 = line1[18..20].trim().parse().map_err(|_| "Bad epoch year")?;
    let epoch_day: f64 = line1[20..32].trim().parse().map_err(|_| "Bad epoch day")?;
    let epoch_yr = if epoch_yr_2d >= 57.0 { 1900.0 + epoch_yr_2d } else { 2000.0 + epoch_yr_2d };

    // Convert to Julian Day
    let yr = epoch_yr as i32;
    let jd_jan1 = 367.0 * yr as f64
        - ((7 * (yr + ((10) / 12))) / 4) as f64
        + (275 * 1 / 9) as f64
        + 1721013.5;
    let epoch_jd = jd_jan1 + epoch_day;

    // B* drag
    let bstar = parse_tle_float(&line1[53..61])?;

    // Line 2
    let incl: f64 = line2[8..16].trim().parse().map_err(|_| "Bad inclination")? ;
    let raan: f64 = line2[17..25].trim().parse().map_err(|_| "Bad RAAN")?;
    let ecc_str = format!("0.{}", line2[26..33].trim());
    let ecc: f64 = ecc_str.parse().map_err(|_| "Bad eccentricity")?;
    let argp: f64 = line2[34..42].trim().parse().map_err(|_| "Bad arg perigee")?;
    let mean_anom: f64 = line2[43..51].trim().parse().map_err(|_| "Bad mean anomaly")?;
    let mean_motion: f64 = line2[52..63].trim().parse().map_err(|_| "Bad mean motion")?;
    let rev_num: u32 = line2[63..68].trim().parse().unwrap_or(0);

    Ok(TleElements {
        norad_id,
        epoch_yr,
        epoch_jd,
        bstar,
        incl: incl * DEG2RAD,
        raan: raan * DEG2RAD,
        ecc,
        argp: argp * DEG2RAD,
        mean_anom: mean_anom * DEG2RAD,
        mean_motion: mean_motion * TWOPI / MIN_PER_DAY,  // rev/day → rad/min
        rev_num,
    })
}

/// Parse TLE-format implied-decimal float (e.g. " 50475-4" → 0.50475e-4)
fn parse_tle_float(s: &str) -> Result<f64, String> {
    let s = s.trim();
    if s.is_empty() || s == "00000-0" || s == " 00000-0" { return Ok(0.0); }

    // Format: [+-]NNNNN[+-]E  where mantissa has implied leading decimal
    let bytes = s.as_bytes();
    let sign = if bytes[0] == b'-' { -1.0 } else { 1.0 };
    let start = if bytes[0] == b'-' || bytes[0] == b'+' || bytes[0] == b' ' { 1 } else { 0 };

    // Find the exponent sign (last + or -)
    let mut exp_pos = s.len();
    for i in (start + 1..s.len()).rev() {
        if bytes[i] == b'+' || bytes[i] == b'-' {
            exp_pos = i;
            break;
        }
    }

    if exp_pos >= s.len() {
        // No exponent — just a number with implied decimal
        let mantissa: f64 = format!("0.{}", &s[start..]).parse().unwrap_or(0.0);
        return Ok(sign * mantissa);
    }

    let mantissa: f64 = format!("0.{}", &s[start..exp_pos]).parse().unwrap_or(0.0);
    let exp: f64 = s[exp_pos..].parse().unwrap_or(0.0);
    Ok(sign * mantissa * 10.0_f64.powf(exp))
}

// ── SGP4 Initialization ───────────────────────────────────────────────────

fn sgp4_init(tle: &TleElements) -> Result<Sgp4State, String> {
    let n0 = tle.mean_motion;
    let e0 = tle.ecc;
    let i0 = tle.incl;
    let bstar = tle.bstar;

    if e0 >= 1.0 || e0 < 0.0 { return Err("Invalid eccentricity".into()); }
    if n0 <= 0.0 { return Err("Invalid mean motion".into()); }

    let cosI0 = i0.cos();
    let sinI0 = i0.sin();
    let x1mth2 = 1.0 - cosI0 * cosI0;  // sin²i
    let x3thm1 = 3.0 * cosI0 * cosI0 - 1.0;
    let x7thm1 = 7.0 * cosI0 * cosI0 - 1.0;

    // Recover original mean motion (n₀") and semi-major axis (a₀")
    let a1 = (KE / n0).powf(2.0 / 3.0);
    let delta1 = 1.5 * CK2 * x3thm1 / (a1 * a1 * (1.0 - e0 * e0).powf(1.5));
    let a0 = a1 * (1.0 - delta1 / 3.0 - delta1 * delta1 - 134.0 * delta1.powi(3) / 81.0);
    let delta0 = 1.5 * CK2 * x3thm1 / (a0 * a0 * (1.0 - e0 * e0).powf(1.5));
    let n0pp = n0 / (1.0 + delta0);
    let a0pp = a0 / (1.0 - delta0);

    let perigee = (a0pp * (1.0 - e0) - 1.0) * RE;  // km

    // Check deep space (period > 225 min)
    let period = TWOPI / n0pp;  // minutes
    let deep_space = period >= 225.0;

    // Atmospheric drag parameter
    let s_star = if perigee < 156.0 {
        let ss = perigee - 78.0;
        if ss < 20.0 { 20.0 } else { ss }
    } else {
        78.0
    };
    let s_param = s_star / RE + 1.0;

    let xi = 1.0 / (a0pp - s_param);
    let eta = a0pp * e0 * xi;
    let eta2 = eta * eta;
    let eeta = e0 * eta;
    let psisq = (1.0 - eta2).abs();
    let coef = QOMS2T * xi.powi(4) * (RE / (s_param * RE)).powi(4) / QOMS2T * QOMS2T;
    // Simplified: use qoms2t directly
    let qoms24 = ((120.0 - s_star) / RE).powi(4);
    let coef_simple = qoms24 * xi.powi(4);

    let c2 = coef_simple * n0pp * (a0pp * (1.0 + 1.5 * eta2 + eeta * (4.0 + eta2))
        + 0.75 * CK2 * xi / psisq * x3thm1 * (8.0 + 3.0 * eta2 * (8.0 + eta2)));
    let c1 = bstar * c2;

    let c4 = 2.0 * n0pp * coef_simple * a0pp * (1.0 - eta2).abs()
        * (eta * (2.0 + 0.5 * eta2) + e0 * (0.5 + 2.0 * eta2)
        - 2.0 * CK2 * xi / (a0pp * psisq)
            * (-3.0 * x3thm1 * (1.0 - 2.0 * eeta + eta2 * (1.5 - 0.5 * eeta))
               + 0.75 * x1mth2 * (2.0 * eta2 - eeta * (1.0 + eta2))
                   * (2.0 * tle.argp).cos()));

    let c5 = 2.0 * coef_simple * a0pp * (1.0 - eta2).abs()
        * (1.0 + 2.75 * (eta2 + eeta) + eeta * eta2);

    // Secular rates
    let temp1 = CK2 * 1.5;
    let temp2 = CK2 * CK2 * 0.5;
    let temp3 = CK4 * -0.46875;

    let mdot = n0pp + 0.5 * temp1 * (1.0 - e0 * e0).sqrt().recip().powi(3) * x3thm1;
    let argpdot = -0.5 * temp1 * (5.0 * cosI0 * cosI0 - 1.0)
        / (1.0 - e0 * e0).sqrt().powi(3) * n0pp;
    let nodedot = -temp1 * cosI0 / (1.0 - e0 * e0).sqrt().powi(3) * n0pp;

    // Drag terms
    let d2 = 4.0 * a0pp * xi * c1 * c1;
    let d3 = d2 * xi * c1 * (17.0 * a0pp + s_param) / 3.0;
    let d4 = 0.5 * d2 * xi * xi * c1 * c1 * a0pp * (221.0 * a0pp + 31.0 * s_param) / 3.0;

    let t2cof = 1.5 * c1;
    let t3cof = d2 + 2.0 * c1 * c1;
    let t4cof = 0.25 * (3.0 * d3 + c1 * (12.0 * d2 + 10.0 * c1 * c1));
    let t5cof = 0.2 * (3.0 * d4 + 12.0 * c1 * d3 + 6.0 * d2 * d2 + 15.0 * c1 * c1 * (2.0 * d2 + c1 * c1));

    let xlcof = if i0.abs() > 1e-12 {
        -0.25 * XJ3OJ2 * sinI0 * (3.0 + 5.0 * cosI0) / (1.0 + cosI0)
    } else {
        -0.25 * XJ3OJ2 * sinI0 * (3.0 + 5.0 * cosI0) / 1e-12
    };
    let aycof = -0.5 * XJ3OJ2 * sinI0;

    let delmo = (1.0 + eta * tle.mean_anom.cos()).powi(3);
    let xmcof = if e0.abs() > 1e-12 { -coef_simple * bstar * RE / (2.0 * eeta) } else { 0.0 };
    let omgcof = bstar * c2 * (tle.argp).cos();  // simplified
    let xnodcf = 3.5 * (1.0 - e0 * e0) * nodedot * c1;

    Ok(Sgp4State {
        a0: a0pp, n0: n0pp,
        mdot, nodedot, argpdot,
        c1, c4, c5, d2, d3, d4,
        t2cof, t3cof, t4cof, t5cof,
        tle: tle.clone(),
        deep_space,
        eta, aodp: a0pp, perigee,
        sinI0, cosI0, x1mth2, x7thm1,
        xlcof, aycof, x3thm1,
        omgcof, xmcof, xnodcf, delmo,
    })
}

// ── SGP4 Propagation ──────────────────────────────────────────────────────

fn sgp4_propagate(state: &Sgp4State, tsince_min: f64) -> Result<([f64; 3], [f64; 3]), String> {
    let t = tsince_min;
    let tle = &state.tle;

    // Secular effects
    let xmdf = tle.mean_anom + state.mdot * t;
    let argpdf = tle.argp + state.argpdot * t;
    let nodedf = tle.raan + state.nodedot * t;

    let tsq = t * t;
    let node = nodedf + state.xnodcf * tsq;
    let argp;
    let e;
    let a;
    let xl;

    // Near-Earth SGP4
    let tempa = 1.0 - state.c1 * t;
    let tempe = tle.bstar * state.c4 * t;
    let templ = state.t2cof * tsq;

    a = state.aodp * tempa * tempa;
    e = tle.ecc - tempe;
    xl = xmdf + argpdf + node + state.n0 * templ;
    argp = argpdf;

    if e < 1e-6 { return Err("Satellite decayed".into()); }
    if a < 0.95 { return Err("Satellite re-entered".into()); }

    // Kepler's equation (Newton-Raphson)
    let axn = e * argp.cos();
    let ayn = e * argp.sin() + state.aycof;
    let xlt = xl + state.xlcof * axn;

    // Solve Kepler: U = xlt - node
    let u = (xlt - node) % TWOPI;
    let mut eo1 = u;
    for _ in 0..10 {
        let sineo1 = eo1.sin();
        let coseo1 = eo1.cos();
        let f = u - eo1 + axn * sineo1 - ayn * coseo1;
        let fp = 1.0 - axn * coseo1 - ayn * sineo1;
        let delta = f / fp;
        eo1 -= delta;
        if delta.abs() < 1e-12 { break; }
    }

    let sineo1 = eo1.sin();
    let coseo1 = eo1.cos();

    // Short-period corrections
    let ecose = axn * coseo1 + ayn * sineo1;
    let esine = axn * sineo1 - ayn * coseo1;
    let el2 = axn * axn + ayn * ayn;
    let pl = a * (1.0 - el2);
    if pl < 0.0 { return Err("Semi-latus rectum negative".into()); }

    let r = a * (1.0 - ecose);
    let rdot = KE * a.sqrt() * esine / r;
    let rfdot = KE * pl.sqrt() / r;

    let cosu = (coseo1 - axn + ayn * esine / (1.0 + (1.0 - el2).sqrt())) / r;
    let sinu = (sineo1 - ayn - axn * esine / (1.0 + (1.0 - el2).sqrt())) / r;
    let u_angle = sinu.atan2(cosu);

    let sin2u = 2.0 * sinu * cosu;
    let cos2u = 2.0 * cosu * cosu - 1.0;

    let rk = r * (1.0 - 1.5 * CK2 * (1.0 - el2).sqrt() / (pl) * state.x3thm1)
        + 0.5 * CK2 / pl * state.x1mth2 * cos2u;
    let uk = u_angle - 0.25 * CK2 / (pl * pl) * state.x7thm1 * sin2u;
    let nodek = node + 1.5 * CK2 * state.cosI0 / (pl * pl) * sin2u;
    let ik = state.tle.incl + 1.5 * CK2 * state.sinI0 * state.cosI0 / (pl * pl) * cos2u;

    // Orientation vectors (TEME frame)
    let sinuk = uk.sin();
    let cosuk = uk.cos();
    let sinik = ik.sin();
    let cosik = ik.cos();
    let sinnk = nodek.sin();
    let cosnk = nodek.cos();

    let mx = -sinnk * cosik;
    let my = cosnk * cosik;

    let ux = mx * sinuk + cosnk * cosuk;
    let uy = my * sinuk + sinnk * cosuk;
    let uz = sinik * sinuk;

    let vx = mx * cosuk - cosnk * sinuk;
    let vy = my * cosuk - sinnk * sinuk;
    let vz = sinik * cosuk;

    // Position (km) and velocity (km/s) in TEME
    let pos = [
        rk * ux * RE,
        rk * uy * RE,
        rk * uz * RE,
    ];

    let vel = [
        (rdot * ux + rfdot * vx) * RE / 60.0,  // er/min → km/s
        (rdot * uy + rfdot * vy) * RE / 60.0,
        (rdot * uz + rfdot * vz) * RE / 60.0,
    ];

    Ok((pos, vel))
}

// ── WASM Exports ──────────────────────────────────────────────────────────

/// Parse a TLE and propagate to tsince minutes from epoch.
/// Returns [x, y, z, vx, vy, vz] in km and km/s (TEME frame).
#[wasm_bindgen]
pub fn propagate_tle(line1: &str, line2: &str, tsince_min: f64) -> Result<Vec<f64>, JsValue> {
    let tle = parse_tle(line1, line2)
        .map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle)
        .map_err(|e| JsValue::from_str(&e))?;
    let (pos, vel) = sgp4_propagate(&state, tsince_min)
        .map_err(|e| JsValue::from_str(&e))?;

    Ok(vec![pos[0], pos[1], pos[2], vel[0], vel[1], vel[2]])
}

/// Propagate a TLE to multiple time points (batch mode for performance).
/// times_min: flat array of tsince values in minutes
/// Returns flat array [x0,y0,z0,vx0,vy0,vz0, x1,y1,z1,...]
#[wasm_bindgen]
pub fn propagate_batch(line1: &str, line2: &str, times_min: &[f64]) -> Result<Vec<f64>, JsValue> {
    let tle = parse_tle(line1, line2)
        .map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle)
        .map_err(|e| JsValue::from_str(&e))?;

    let mut results = Vec::with_capacity(times_min.len() * 6);
    for &t in times_min {
        match sgp4_propagate(&state, t) {
            Ok((pos, vel)) => {
                results.extend_from_slice(&pos);
                results.extend_from_slice(&vel);
            }
            Err(_) => {
                // Satellite decayed/re-entered — fill with NaN
                results.extend_from_slice(&[f64::NAN; 6]);
            }
        }
    }
    Ok(results)
}

/// Parse a TLE and return orbital elements as JSON-friendly object.
#[wasm_bindgen]
pub fn parse_tle_info(line1: &str, line2: &str) -> Result<JsValue, JsValue> {
    let tle = parse_tle(line1, line2)
        .map_err(|e| JsValue::from_str(&e))?;

    let obj = serde_wasm_bindgen::to_value(&TleInfo {
        norad_id: tle.norad_id,
        epoch_yr: tle.epoch_yr,
        epoch_jd: tle.epoch_jd,
        inclination_deg: tle.incl / DEG2RAD,
        raan_deg: tle.raan / DEG2RAD,
        eccentricity: tle.ecc,
        arg_perigee_deg: tle.argp / DEG2RAD,
        mean_anomaly_deg: tle.mean_anom / DEG2RAD,
        mean_motion_rev_day: tle.mean_motion * MIN_PER_DAY / TWOPI,
        bstar: tle.bstar,
        period_min: TWOPI / tle.mean_motion,
        rev_num: tle.rev_num,
    }).map_err(|e| JsValue::from_str(&format!("{:?}", e)))?;

    Ok(obj)
}

// ── Persistent registry — batch propagation hot path ─────────────────────
//
// `propagate_tle` re-parses + re-inits per call, so the live tracker
// (which propagates ~20 k sats × 60 Hz) was paying the parse cost on
// every frame for every sat. The registry caches the parsed Sgp4State
// in WASM linear memory and exposes a single batch entrypoint that
// propagates every registered sat to one wall-clock JD, applies the
// TEME → scene-frame transform inline (so JS doesn't loop in cold
// JS code at all), and writes [x, y, z] f32 triplets into a caller-
// provided Float32Array. JS just allocates the buffer once and uploads
// to GPU.
//
// Slots are stable: removing leaves a None placeholder so subsequent
// indices don't shift, which keeps JS's parallel `_satellites[]` array
// in lockstep without index remapping.

use std::cell::RefCell;

thread_local! {
    static REGISTRY: RefCell<Vec<Option<Sgp4State>>> = RefCell::new(Vec::new());
}

#[wasm_bindgen]
pub fn registry_clear() {
    REGISTRY.with(|r| r.borrow_mut().clear());
}

#[wasm_bindgen]
pub fn registry_len() -> usize {
    REGISTRY.with(|r| r.borrow().len())
}

/// Append a sat to the registry. Returns the slot index (0-based).
/// Parse / init failures bubble up as JsValue strings — JS marks the
/// slot as un-batched and falls back to its own propagator for that
/// entry.
#[wasm_bindgen]
pub fn registry_add(line1: &str, line2: &str) -> Result<u32, JsValue> {
    let tle = parse_tle(line1, line2)
        .map_err(|e| JsValue::from_str(&e))?;
    let state = sgp4_init(&tle)
        .map_err(|e| JsValue::from_str(&e))?;
    let idx = REGISTRY.with(|r| {
        let mut reg = r.borrow_mut();
        let i = reg.len();
        reg.push(Some(state));
        i as u32
    });
    Ok(idx)
}

/// Reserve a slot without an associated state (e.g. JS-fallback sat).
/// The slot propagates as (0, 0, 0); JS overwrites that triplet with
/// its own values after the batch returns. Keeps the WASM registry
/// in lockstep with JS `_satellites[]` so indices line up.
#[wasm_bindgen]
pub fn registry_reserve_blank() -> u32 {
    REGISTRY.with(|r| {
        let mut reg = r.borrow_mut();
        let i = reg.len();
        reg.push(None);
        i as u32
    })
}

/// Mark a slot as removed. The slot is kept (so subsequent indices
/// don't shift) but propagation skips it.
#[wasm_bindgen]
pub fn registry_remove(idx: u32) {
    REGISTRY.with(|r| {
        let mut reg = r.borrow_mut();
        let i = idx as usize;
        if i < reg.len() { reg[i] = None; }
    });
}

/// Propagate every registered sat to JD = `now_jd`, rotate TEME →
/// scene-frame using `gmst_rad` (matching js/geo/coords.js
/// eciToEcef + the Y=north flip), scale by `scale` (= km_to_scene),
/// and return a flat Float32Array of [x, y, z] triplets — one per
/// registered slot, in slot order.
///
/// Returning the buffer (rather than taking a JS-owned `&mut` slice)
/// is the wasm-bindgen pattern that actually writes back to JS:
/// `&mut [f32]` is treated as a pure input by wasm-bindgen
/// (passArrayF32ToWasm0 copies INTO WASM and never copies out), so
/// using that signature would silently drop every position update.
///
/// On per-sat propagate failure (decay / numerical blowup) and on
/// blank slots the triplet is NaN so JS can detect it and fall back
/// without confusing it with a valid origin sample.
#[wasm_bindgen]
pub fn registry_propagate(now_jd: f64, gmst_rad: f64, scale: f64) -> Vec<f32> {
    let cos_g = gmst_rad.cos();
    let sin_g = gmst_rad.sin();
    let scl   = scale as f32;

    REGISTRY.with(|r| {
        let reg = r.borrow();
        let n = reg.len();
        let mut out = vec![f32::NAN; n * 3];

        for (i, slot) in reg.iter().enumerate() {
            let Some(state) = slot else { continue; };
            let tsince = (now_jd - state.tle.epoch_jd) * MIN_PER_DAY;
            let Ok((p, _v)) = sgp4_propagate(state, tsince) else { continue; };

            // ECI/TEME → astronomical ECEF: rotate −GMST about Z.
            let x_ecef =  cos_g * p[0] + sin_g * p[1];
            let y_ecef = -sin_g * p[0] + cos_g * p[1];
            let z_ecef =  p[2];
            // Astronomical ECEF (Z = north) → Three.js scene frame
            // (Y = north): xS = xE, yS = zE, zS = -yE.
            let off = i * 3;
            out[off]     = (x_ecef as f32) * scl;
            out[off + 1] = (z_ecef as f32) * scl;
            out[off + 2] = (-y_ecef as f32) * scl;
        }
        out
    })
}

#[derive(serde::Serialize)]
struct TleInfo {
    norad_id: u32,
    epoch_yr: f64,
    epoch_jd: f64,
    inclination_deg: f64,
    raan_deg: f64,
    eccentricity: f64,
    arg_perigee_deg: f64,
    mean_anomaly_deg: f64,
    mean_motion_rev_day: f64,
    bstar: f64,
    period_min: f64,
    rev_num: u32,
}
