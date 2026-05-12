/**
 * sun-field.js — Multipole magnetic-field model + RK4 field-line tracer
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Replaces the parametric semi-torus we were using to draw "loops" with
 * actual numerically-traced field lines from a superposition of
 *
 *   • the global solar dipole  B_dip(p)
 *   • per-AR horizontal magnetic dipoles at the photosphere, axis along
 *     the Joy-tilted east tangent at each AR's lat / lon, strength ∝ AR
 *     intensity
 *
 * Each AR thus contributes a real bipolar field topology — closed loops
 * over the polarity inversion line, opening field at the legs, helmet-
 * streamer-like extensions where strong ARs sit on the limb.  Loops are
 * RK4-integrated step-by-step and end either at the photosphere (closed)
 * or after exceeding r > r_max (open / discarded).
 *
 * Coordinates: sun-local, R_sun units.  The sun is at the origin with
 * radius 1; positions on the photosphere have |p| = 1.  The space-
 * weather globe scales the resulting paths to scene units (× 8) when
 * mounting the lines on the sun group.
 *
 * Performance: cheap CPU-side computation done once per AR-set update
 * (~once per swpc-update tick, every 15 minutes).  Each AR generates
 * ~10 field-line traces × ~80 RK4 steps × ~30 vector ops = ~24k ops; for
 * 8 ARs that's ~200k ops, sub-millisecond.
 *
 * Reference: standard textbook MHD potential-field extrapolation
 * (Schatten, Wilcox & Ness 1969 — Potential Field Source Surface).  We
 * skip the source-surface enforcement and just clip at r_max, which
 * gives us the right closed-loop topology for low-corona field lines.
 */

import * as THREE from 'three';

const SOLAR_DIPOLE_STRENGTH = 0.30;     // tuned for visible bipolar bias
const SOLAR_DIPOLE_AXIS     = new THREE.Vector3(0, 1, 0);

// Tuning for visible loop heights at typical AR strengths.  Stronger ARs
// produce taller loops (apex higher above the surface); β-γ-δ regions
// extend ~1.5× because they carry more flux.
const AR_DIPOLE_BASE_STRENGTH = 0.0010;

/**
 * Compute B at point p from a magnetic dipole at the origin with axis m̂
 * and scalar moment m.
 *
 *   B(p) = m · (3 (m̂·r̂) r̂ − m̂) / r³
 *
 * We don't bother with μ₀/4π since strengths are tuned for visual scale.
 */
function dipoleField(out, p, mAxis, mScalar) {
    const r2 = p.lengthSq();
    if (r2 < 1e-6) return out.set(0, 0, 0);
    const r = Math.sqrt(r2);
    const r3 = r * r2;
    const mDotR = (mAxis.x * p.x + mAxis.y * p.y + mAxis.z * p.z) / r;
    const c = 3 * mDotR / r3;
    out.set(
        c * p.x / r - mAxis.x / r3,
        c * p.y / r - mAxis.y / r3,
        c * p.z / r - mAxis.z / r3,
    ).multiplyScalar(mScalar);
    return out;
}

/**
 * Per-AR dipole offset from origin.  AR sits at p0 (unit-sphere position)
 * with axis m̂ tangent to the surface.  Field at point p is the dipole
 * field translated to p0:
 *   B_AR(p) = dipoleField(p − p0, m̂, m)
 */
function arDipoleField(out, p, p0, mAxis, mScalar) {
    const tx = p.x - p0.x;
    const ty = p.y - p0.y;
    const tz = p.z - p0.z;
    const r2 = tx*tx + ty*ty + tz*tz;
    if (r2 < 1e-8) return out.set(0, 0, 0);
    const r = Math.sqrt(r2);
    const r3 = r * r2;
    const mDotR = (mAxis.x * tx + mAxis.y * ty + mAxis.z * tz) / r;
    const c = 3 * mDotR / r3;
    out.set(
        c * tx / r - mAxis.x / r3,
        c * ty / r - mAxis.y / r3,
        c * tz / r - mAxis.z / r3,
    ).multiplyScalar(mScalar);
    return out;
}

/**
 * Build the AR-source array used by the tracer from a list of regions
 * (typically the same Carrington-rotated region objects the corona shader
 * receives).  Returns lightweight tuples without three.js allocations
 * inside the inner loop.
 */
export function buildArSources(regions) {
    const sources = [];
    for (const r of regions) {
        const intensity = r.intensity ?? Math.max(0.20, Math.min(1.0,
            (r.area_norm ?? 0.2) * 0.85 + Math.min(r.num_spots ?? 1, 30) / 60));
        if (intensity < 0.10) continue;
        const isComplex = !!r.is_complex;
        const lat = r.lat_rad;
        const lon = r.lon_rad;
        const cosL = Math.cos(lat), sinL = Math.sin(lat);
        const phat = new THREE.Vector3(cosL * Math.cos(lon), sinL, cosL * Math.sin(lon));
        const east_pure = new THREE.Vector3(-Math.sin(lon), 0, Math.cos(lon)).normalize();
        const north_pure = new THREE.Vector3().crossVectors(phat, east_pure).normalize();
        // Joy's-law tilt for the dipole axis (matches the corona shader's tilt)
        const gamma = Math.atan(0.5 * Math.abs(Math.sin(lat)))
                    * (lat > 0 ? -1 : +1);
        const east = east_pure.clone().multiplyScalar(Math.cos(gamma))
            .addScaledVector(north_pure, Math.sin(gamma)).normalize();
        const strength = AR_DIPOLE_BASE_STRENGTH * intensity * (isComplex ? 1.5 : 1.0);
        sources.push({
            pos:       phat,            // unit-sphere AR position
            axis:      east,            // horizontal dipole axis (Joy-tilted)
            strength,
            intensity,
            isComplex,
            ar:        r,
        });
    }
    return sources;
}

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpD = new THREE.Vector3();

/**
 * Total B field at p from solar dipole + all AR contributions.  Out is
 * mutated and returned to avoid per-call allocations.
 */
function totalField(out, p, sources) {
    dipoleField(out, p, SOLAR_DIPOLE_AXIS, SOLAR_DIPOLE_STRENGTH);
    for (let i = 0; i < sources.length; i++) {
        const s = sources[i];
        arDipoleField(_tmpA, p, s.pos, s.axis, s.strength);
        out.x += _tmpA.x;
        out.y += _tmpA.y;
        out.z += _tmpA.z;
    }
    return out;
}

/**
 * RK4-trace a field line from `start` along ±B̂ (sign = +1 forward,
 * −1 backward).  Stops when the path returns to the photosphere
 * (r < rMin) or escapes (r > rMax) or runs out of steps.
 *
 * Returns the array of three.js Vector3 positions making up the path.
 */
function traceFieldLine(start, sources, opts = {}) {
    const stepSize = opts.stepSize ?? 0.018;
    const maxSteps = opts.maxSteps ?? 220;
    const rMin     = opts.rMin     ?? 1.001;
    const rMax     = opts.rMax     ?? 2.5;
    const sign     = opts.sign     ?? +1;

    const path = [start.clone()];
    let p = start.clone();

    for (let i = 0; i < maxSteps; i++) {
        // RK4 with normalised B̂ as the integrand → constant arc-length steps
        const fn = (pp, out) => {
            totalField(out, pp, sources);
            const m2 = out.x*out.x + out.y*out.y + out.z*out.z;
            if (m2 < 1e-20) { out.set(0, 0, 0); return out; }
            const inv = sign / Math.sqrt(m2);
            out.x *= inv; out.y *= inv; out.z *= inv;
            return out;
        };
        const k1 = fn(p, new THREE.Vector3());
        _tmpD.copy(p).addScaledVector(k1, 0.5 * stepSize);
        const k2 = fn(_tmpD, new THREE.Vector3());
        _tmpD.copy(p).addScaledVector(k2, 0.5 * stepSize);
        const k3 = fn(_tmpD, new THREE.Vector3());
        _tmpD.copy(p).addScaledVector(k3, stepSize);
        const k4 = fn(_tmpD, new THREE.Vector3());

        p = p.clone()
            .addScaledVector(k1, stepSize / 6)
            .addScaledVector(k2, stepSize / 3)
            .addScaledVector(k3, stepSize / 3)
            .addScaledVector(k4, stepSize / 6);
        path.push(p.clone());

        const r = p.length();
        if (r < rMin) {
            // Snap final point exactly to the photosphere for cleaner termination
            p.normalize().multiplyScalar(rMin);
            path[path.length - 1].copy(p);
            break;
        }
        if (r > rMax) break;     // open field line — kept but flagged elsewhere
    }
    return path;
}

/**
 * For each AR, produce a fan of traced field lines anchored on the
 * polarity inversion line (PIL).  Returns an array of
 *
 *     { path: Vector3[], ar: regionObj, isClosed: bool, isComplex: bool }
 *
 * suitable for rendering as three.js Line objects.
 *
 * Approximation: we don't have explicit PIL geometry, so we sample a
 * small set of starting points along the line perpendicular to the
 * Joy-tilted east axis at each AR (i.e. along the synthetic PIL).  The
 * tracer follows the local B field from each starting point and returns
 * the resulting closed loop.  For a true bipolar dipole the field lines
 * naturally connect from the +polarity hemisphere over the equator to
 * the −polarity hemisphere — the canonical AR loop topology.
 *
 * @param {Array} regions  list of region objects (same shape used by the
 *                         corona shader, i.e. with Carrington-rotated lon)
 * @param {object} [opts]
 * @returns {Array<{ path: THREE.Vector3[], ar: object, isClosed: boolean, isComplex: boolean }>}
 */
export function buildArFieldLoops(regions, opts = {}) {
    const N_LINES_PER_AR = opts.linesPerAr ?? 9;     // sampling along PIL
    const PIL_SPAN       = opts.pilSpan    ?? 0.07;  // total length sampled
    const sources = buildArSources(regions);
    const out = [];

    for (const s of sources) {
        const phat   = s.pos;
        const east   = s.axis;
        const north  = new THREE.Vector3().crossVectors(phat, east).normalize();
        // Strength of the +/- polarity offset — half the PIL span lateral
        // each side of centre.  Smaller ARs get tighter loop bundles.
        const polOffset = 0.025 * (0.6 + 0.6 * s.intensity);

        for (let k = 0; k < N_LINES_PER_AR; k++) {
            const u = (k + 0.5) / N_LINES_PER_AR - 0.5;     // −0.5 … +0.5
            const along = u * PIL_SPAN;                     // along PIL (north)

            // Start point: just above photosphere on the +polarity side,
            // shifted along the PIL by `along`.  The tracer steps along
            // local B which curls the line over to the −polarity side.
            const start = phat.clone().multiplyScalar(1.005)
                .addScaledVector(east,  polOffset)
                .addScaledVector(north, along);

            const path = traceFieldLine(start, sources, {
                stepSize: 0.012,
                maxSteps: 260,
                rMin: 1.001,
                rMax: 2.0,
                sign: -1,                                   // flow backward = follow −B
            });

            // Discard tiny stubs (couldn't find a return) and obviously open lines
            if (path.length < 6) continue;
            const last = path[path.length - 1];
            const isClosed = last.length() <= 1.01;

            out.push({
                path,
                ar:        s.ar,
                isClosed,
                isComplex: s.isComplex,
                intensity: s.intensity,
            });
        }
    }
    return out;
}
