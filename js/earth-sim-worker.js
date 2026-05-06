/**
 * earth-sim-worker.js — module Web Worker that propagates the Earth-system
 * (Earth + Moon + Phobos + Deimos) in deterministic, JD-anchored Keplerian
 * form, off the main render thread.
 *
 * The main thread requests *time-series* windows of positions (a small array
 * of samples at fixed dt across a horizon) which it can then interpolate or
 * compare against to verify ground-truth determinism. Because every sample
 * is computed as a closed-form function of the Julian Day, the worker is
 * stateless — the same JD always yields the exact same position, regardless
 * of how the main-thread accumulated time, so it acts as a "ground truth"
 * for the on-screen propagation.
 *
 * ── Messages ───────────────────────────────────────────────────────────────
 *
 *   in  { type:'init' }                       → optional handshake
 *   out { type:'ready' }
 *
 *   in  { type:'series', id, jd0, dt_s, count }
 *       Compute `count` samples starting at jd0 with stride dt_s (seconds).
 *
 *   out { type:'series', id, jd0, dt_s, count, hash,
 *         body: { moon:Float32Array, phobos:Float32Array, deimos:Float32Array,
 *                 earth:Float32Array } }
 *       Each Float32Array holds count*3 floats (x,y,z), transferred zero-copy.
 *       'earth' is heliocentric AU; the three moons are parent-centric km,
 *       expressed in the *parent equator* frame (matches threejs.html's pipeline).
 *
 *   out { type:'error', id, error }
 *
 * Math is identical to js/planet-moons.js#propagateMoonKepler and
 * js/horizons.js#earthHeliocentric, but inlined so this worker has no
 * three.js / DOM dependencies and starts in <5 ms.
 */

const D2R = Math.PI / 180;
const J2000 = 2451545.0;
const SEC_PER_DAY = 86400;

// ── Earth-system Keplerian elements (J2000 mean elements) ────────────────────
// Same values as ALL_MOONS.{earth,mars} in js/planet-moons.js — kept in sync.
const EARTH_SYS = {
    moon: {
        a_km:    384_399, e: 0.0549, i_deg:   5.145,
        raan_deg: 125.08, argp_deg: 318.15, M0_deg: 135.27,
        mu_km3_s2: 6.6743e-20 * (5.9722e24 + 7.342e22),
    },
    phobos: {
        a_km:     9_376, e: 0.0151, i_deg: 1.075,
        raan_deg: 207.78, argp_deg: 150.06, M0_deg:  92.474,
        mu_km3_s2: 6.6743e-20 * (6.4171e23 + 1.0659e16),
    },
    deimos: {
        a_km:    23_463, e: 0.0002, i_deg: 1.788,
        raan_deg:  24.53, argp_deg: 290.50, M0_deg: 296.20,
        mu_km3_s2: 6.6743e-20 * (6.4171e23 + 1.4762e15),
    },
};

// ── Kepler solver (Newton–Raphson, fixed iteration cap) ──────────────────────
function solveKepler(M, e) {
    let E = e < 0.8 ? M : Math.PI;
    for (let it = 0; it < 24; it++) {
        const f  = E - e * Math.sin(E) - M;
        const fp = 1 - e * Math.cos(E);
        const dE = f / fp;
        E -= dE;
        if (Math.abs(dE) < 1e-13) break;
    }
    return E;
}

// Propagate one body's elements at JD into a parent-equatorial (x,y,z) km vector,
// writing into the Float32Array at offset `o`.
function propagate(el, jd, out, o) {
    const a = el.a_km;
    const n = Math.sqrt(el.mu_km3_s2 / (a * a * a)); // rad/s
    const dt_s = (jd - J2000) * SEC_PER_DAY;
    const TWO_PI = 2 * Math.PI;
    let M = (el.M0_deg * D2R + n * dt_s) % TWO_PI;
    if (M < 0) M += TWO_PI;
    const e = el.e;
    const E = solveKepler(M, e);
    const cosE = Math.cos(E), sinE = Math.sin(E);
    const sqrt1me2 = Math.sqrt(1 - e * e);
    const x_p = a * (cosE - e);
    const y_p = a * sqrt1me2 * sinE;

    const i  = el.i_deg    * D2R;
    const Om = el.raan_deg * D2R;
    const w  = el.argp_deg * D2R;
    const cR = Math.cos(Om), sR = Math.sin(Om);
    const ci = Math.cos(i),  si = Math.sin(i);
    const cw = Math.cos(w),  sw = Math.sin(w);

    out[o    ] = (cR * cw - sR * sw * ci) * x_p + (-cR * sw - sR * cw * ci) * y_p;
    out[o + 1] = (sR * cw + cR * sw * ci) * x_p + (-sR * sw + cR * cw * ci) * y_p;
    out[o + 2] = (sw * si)              * x_p + (cw * si)               * y_p;
}

// ── Earth heliocentric ecliptic position — Meeus 3-term Kepler approximation
// (matches js/horizons.js fallback when VSOP87D is not loaded). Adequate as a
// ground-truth reference at the < 0.01 AU level over decades.
const EARTH_EL = {
    L0_deg: 100.46435, dL_deg_per_day: 0.985_60911,
    e0:    0.016709,
    perih_deg: 102.94719, dperih_deg_per_century: 0.0000470935,
    a_AU: 1.000001018,
};

function earthHelio(jd, out, o) {
    const T = (jd - J2000) / 36525.0;
    const dDay = jd - J2000;
    const Ldeg = ((EARTH_EL.L0_deg + EARTH_EL.dL_deg_per_day * dDay) % 360 + 360) % 360;
    const perih = EARTH_EL.perih_deg + EARTH_EL.dperih_deg_per_century * T;
    const M = (Ldeg - perih) * D2R;
    const e = EARTH_EL.e0;
    const E = solveKepler(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), e);
    const x = EARTH_EL.a_AU * (Math.cos(E) - e);
    const y = EARTH_EL.a_AU * Math.sqrt(1 - e * e) * Math.sin(E);
    // Rotate into ecliptic by perihelion longitude (orbit is in the ecliptic).
    const cp = Math.cos(perih * D2R), sp = Math.sin(perih * D2R);
    out[o    ] = cp * x - sp * y;
    out[o + 1] = sp * x + cp * y;
    out[o + 2] = 0;
}

// ── 32-bit FNV-1a hash of a Float32Array as bytes — used to verify that two
// independent calls with the same JD inputs produce bit-identical outputs.
function hashF32(buf) {
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < u8.length; i++) {
        h ^= u8[i];
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Message handling ─────────────────────────────────────────────────────────
self.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    try {
        if (msg.type === 'init') {
            self.postMessage({ type: 'ready' });
            return;
        }
        if (msg.type === 'series') {
            const { id, jd0, dt_s, count } = msg;
            if (!Number.isFinite(jd0) || !Number.isFinite(dt_s) || !(count > 0)) {
                self.postMessage({ type: 'error', id, error: 'bad params' });
                return;
            }
            const N = Math.min(count | 0, 4096);
            const moon   = new Float32Array(N * 3);
            const phobos = new Float32Array(N * 3);
            const deimos = new Float32Array(N * 3);
            const earth  = new Float32Array(N * 3);
            const dtJD = dt_s / SEC_PER_DAY;
            for (let i = 0; i < N; i++) {
                const jd = jd0 + i * dtJD;
                const o = i * 3;
                propagate(EARTH_SYS.moon,   jd, moon,   o);
                propagate(EARTH_SYS.phobos, jd, phobos, o);
                propagate(EARTH_SYS.deimos, jd, deimos, o);
                earthHelio(jd, earth, o);
            }
            // Combined hash so the main thread can verify determinism.
            const hash = hashF32(moon) + hashF32(phobos) + hashF32(deimos) + hashF32(earth);
            self.postMessage(
                {
                    type: 'series', id, jd0, dt_s, count: N, hash,
                    body: { moon, phobos, deimos, earth },
                },
                [moon.buffer, phobos.buffer, deimos.buffer, earth.buffer],
            );
            return;
        }
    } catch (err) {
        self.postMessage({ type: 'error', id: msg.id, error: String(err && err.message || err) });
    }
});

// Auto-announce readiness so the bridge does not need an explicit 'init' round-trip.
self.postMessage({ type: 'ready' });
