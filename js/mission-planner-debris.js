/**
 * mission-planner-debris.js — Debris-shell overlays for the Mission Planner.
 *
 * Surfaces the Fengyun-1C ASAT cloud (and, eventually, other debris
 * families) as a single THREE.Points draw mounted on the Earth-system
 * group. Records come from the existing /api/celestrak/tle proxy
 * (group=fengyun-1c-debris); each fragment is propagated with two-body
 * Keplerian advancement of the mean anomaly from TLE epoch.
 *
 * Two-body Kepler is adequate for the visualization loop the planner
 * runs (sub-day to a few days off epoch, no conjunction screening).
 * A future SGP4 hand-off via js/sgp4-wasm/ would tighten this up if
 * conjunction work lands in mission-planner.
 *
 * The module owns fetch, build, propagate, and dispose. The host
 * (mission-planner-3d.js) owns lifecycle: mount on target change,
 * unmount on target change away, scenarioJD updates per frame.
 */
import * as THREE from 'three';

const MU_EARTH        = 398600.4418;        // km³/s²
const R_EARTH_KM      = 6378.137;
const TAU             = Math.PI * 2;
const D2R             = Math.PI / 180;
const EPS             = 23.4393 * D2R;      // mean obliquity J2000
const COS_EPS         = Math.cos(EPS);
const SIN_EPS         = Math.sin(EPS);
const J2K_OFFSET_DAYS = 2440587.5;          // unix epoch (1970-01-01) → JD

function jdFromIso(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return NaN;
    return (ms / 86400000) + J2K_OFFSET_DAYS;
}

function solveKepler(M, e) {
    let E = e < 0.8 ? M : Math.PI;
    for (let i = 0; i < 8; i++) {
        const f  = E - e * Math.sin(E) - M;
        const fp = 1 - e * Math.cos(E);
        const dE = f / fp;
        E -= dE;
        if (Math.abs(dE) < 1e-9) break;
    }
    return E;
}

/**
 * Fetch FY-1C debris records from the CelesTrak proxy. Returns up to
 * `count` records with non-NaN mean elements; throws on transport or
 * upstream error so the caller can surface a status to the UI.
 *
 * Records carry inclination/raan/arg_perigee in degrees, mean_anomaly
 * (M at TLE epoch) in degrees, eccentricity unitless, mean_motion in
 * rev/day, and `epoch` as an ISO timestamp.
 */
export async function loadFY1CDebris({
    count     = 600,
    timeoutMs = 9000,
    signal,
} = {}) {
    const url = '/api/celestrak/tle?group=fengyun-1c-debris';
    const ctl = new AbortController();
    const t   = setTimeout(() => ctl.abort(), timeoutMs);
    // If the caller passed a signal, wire it through.
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
    try {
        const r = await fetch(url, {
            signal: ctl.signal,
            headers: { Accept: 'application/json' },
        });
        if (!r.ok) throw new Error(`FY-1C TLE fetch failed: HTTP ${r.status}`);
        const data = await r.json();
        const sats = (data?.satellites || []).filter(s =>
            Number.isFinite(s.inclination) &&
            Number.isFinite(s.mean_motion) &&
            Number.isFinite(s.eccentricity) &&
            Number.isFinite(s.mean_anomaly) &&
            Number.isFinite(s.raan) &&
            Number.isFinite(s.arg_perigee) &&
            s.epoch
        );
        return sats.slice(0, count);
    } finally {
        clearTimeout(t);
    }
}

/**
 * Build a single Three.js Points cloud from parsed debris records.
 * Each vertex is propagated per-frame from its TLE mean elements
 * via update(jd).
 *
 *   parent     — THREE.Object3D to mount on (typically world.earthSystem)
 *   records    — array from loadFY1CDebris() (or compatible CelesTrak shape)
 *   kmToScene  — scalar to convert km → scene units (1 / R_EARTH_KM
 *                in the mission-planner scene)
 *   color      — base hex (defaults to FY-1C catalog signature color)
 *   pointSize  — Three.js point size in scene units; sizeAttenuation = true
 *
 * Returns { object3D, update(jd), dispose, getStats }.
 */
export function createDebrisCloud({
    parent,
    records,
    kmToScene = 1 / R_EARTH_KM,
    color     = 0xff3060,
    pointSize = 0.012,
} = {}) {
    if (!parent)               throw new Error('createDebrisCloud: parent required');
    if (!Array.isArray(records)) throw new Error('createDebrisCloud: records[] required');

    const N = records.length;

    // Pre-compute per-fragment constants so the per-frame inner loop is
    // tight (no per-vertex degree→radian conversions, no string parsing).
    const a    = new Float64Array(N);   // semi-major axis (km)
    const e    = new Float64Array(N);
    const sini = new Float64Array(N);
    const cosi = new Float64Array(N);
    const sinO = new Float64Array(N);
    const cosO = new Float64Array(N);
    const sinw = new Float64Array(N);
    const cosw = new Float64Array(N);
    const n    = new Float64Array(N);   // mean motion (rad/s)
    const M0   = new Float64Array(N);
    const jdEp = new Float64Array(N);

    for (let i = 0; i < N; i++) {
        const s  = records[i];
        const np = s.mean_motion * TAU / 86400;          // rev/day → rad/s
        n[i]    = np;
        a[i]    = Math.cbrt(MU_EARTH / (np * np));
        e[i]    = s.eccentricity;
        const ir = s.inclination * D2R;
        const Or = s.raan        * D2R;
        const wr = s.arg_perigee * D2R;
        sini[i] = Math.sin(ir);  cosi[i] = Math.cos(ir);
        sinO[i] = Math.sin(Or);  cosO[i] = Math.cos(Or);
        sinw[i] = Math.sin(wr);  cosw[i] = Math.cos(wr);
        M0[i]   = s.mean_anomaly * D2R;
        jdEp[i] = jdFromIso(s.epoch);
    }

    const positions = new Float32Array(N * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
        color,
        size:            pointSize,
        sizeAttenuation: true,
        transparent:     true,
        opacity:         0.92,
        depthWrite:      false,
        blending:        THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geom, mat);
    points.frustumCulled = false;
    points.userData = { kind: 'debris-cloud', id: 'fengyun-1c', count: N };
    parent.add(points);

    // Prime positions with a first propagation at the parent's epoch
    // so the cloud isn't a single dot at the origin until the first
    // host tick lands. The host overrides this immediately on the
    // next frame with the real scenarioJD.
    update(_unixToJD(Date.now()));

    // ── Stats — altitude band of the loaded sample. Used by the host
    //    page log so the user sees "n fragments, X–Y km, mean Z km".
    const altsKm = new Float64Array(N);
    for (let i = 0; i < N; i++) altsKm[i] = a[i] - R_EARTH_KM;
    const altsSorted = altsKm.slice().sort();
    const stats = {
        count:        N,
        meanAltKm:    altsKm.reduce((s, v) => s + v, 0) / Math.max(1, N),
        medianAltKm:  altsSorted[Math.floor(N / 2)] ?? NaN,
        minAltKm:     altsSorted[0]                 ?? NaN,
        maxAltKm:     altsSorted[N - 1]             ?? NaN,
    };

    function update(jd) {
        if (!Number.isFinite(jd)) return;
        const pos = positions;
        for (let i = 0; i < N; i++) {
            const dtSec = (jd - jdEp[i]) * 86400;
            let M = M0[i] + n[i] * dtSec;
            M = ((M % TAU) + TAU) % TAU;
            const ecc = e[i];
            const E   = solveKepler(M, ecc);

            // True anomaly via half-angle (preserves quadrant) + radius
            // from the closed-form r = a (1 − e cos E).
            const cosE  = Math.cos(E);
            const r_km  = a[i] * (1 - ecc * cosE);
            const nu    = 2 * Math.atan2(
                Math.sqrt(1 + ecc) * Math.sin(E / 2),
                Math.sqrt(1 - ecc) * Math.cos(E / 2),
            );
            const xp = r_km * Math.cos(nu);
            const yp = r_km * Math.sin(nu);

            // Perifocal → ECI (equatorial) via R3(-Ω)·R1(-i)·R3(-ω).
            const cw = cosw[i], sw = sinw[i];
            const co = cosO[i], so = sinO[i];
            const ci = cosi[i], si = sini[i];
            const xeci =  (co*cw - so*sw*ci)*xp + (-co*sw - so*cw*ci)*yp;
            const yeci =  (so*cw + co*sw*ci)*xp + (-so*sw + co*cw*ci)*yp;
            const zeci =  (sw*si)*xp           + ( cw*si           )*yp;

            // Equatorial → ecliptic (rotate by −ε about X). The planner
            // scene's +Y is the ecliptic normal, so we transform here
            // and the point cloud sits coplanar with Moon/Sun rendering.
            const xecl =  xeci;
            const yecl =  yeci * COS_EPS + zeci * SIN_EPS;
            const zecl = -yeci * SIN_EPS + zeci * COS_EPS;

            // Ecliptic km → scene units. Scene convention: (x, z, −y).
            const o = i * 3;
            pos[o    ] =  xecl * kmToScene;
            pos[o + 1] =  zecl * kmToScene;
            pos[o + 2] = -yecl * kmToScene;
        }
        geom.attributes.position.needsUpdate = true;
    }

    function setVisible(v) { points.visible = !!v; }

    function dispose() {
        if (points.parent) points.parent.remove(points);
        geom.dispose();
        mat.dispose();
    }

    return {
        object3D:   points,
        update,
        setVisible,
        dispose,
        getStats:   () => stats,
    };
}

function _unixToJD(ms) { return (ms / 86400000) + J2K_OFFSET_DAYS; }
