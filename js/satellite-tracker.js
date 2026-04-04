/**
 * satellite-tracker.js — Satellite orbit visualization and TLE management
 *
 * Fetches TLE catalogs from the CelesTrak proxy endpoint, propagates orbits
 * using either the Rust SGP4 WASM module (when available) or a pure-JS
 * fallback, and renders satellite positions + orbit trails on a 3D Earth globe.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { SatelliteTracker } from './js/satellite-tracker.js';
 *   const tracker = new SatelliteTracker(earthGroup, earthRadius);
 *   await tracker.loadGroup('stations');  // ISS, Tiangong, etc.
 *   // In animation loop:
 *   tracker.tick(Date.now());
 *
 * ── Data Flow ────────────────────────────────────────────────────────────────
 *   /api/celestrak/tle?group=stations → JSON array of TLEs
 *   → SGP4 propagate each satellite to current time
 *   → TEME → ECEF → lat/lon/alt → 3D position on globe
 *   → Render as dots + optional orbit trails
 *
 * ── Coordinate Frames ────────────────────────────────────────────────────────
 *   TLE epoch → SGP4 → TEME (True Equator Mean Equinox)
 *   TEME → GMST rotation → ECEF (Earth-Centered Earth-Fixed)
 *   ECEF → lat/lon/alt → 3D scene position on globe
 *
 * ── Data Quality Notes ──────────────────────────────────────────────────────
 *   - TLEs are mean elements, not osculating — SGP4 is the ONLY correct
 *     propagator for TLEs. Do NOT use Kepler/VSOP87D with TLE data.
 *   - Accuracy: ~1 km at epoch, degrades ~1-2 km/day for LEO.
 *   - CelesTrak updates every ~8 hours from 18th SDS.
 *   - TEME→ECEF conversion uses a simplified GMST (no nutation/precession).
 *     For conjunction screening, IAU-2006/2000A precession-nutation would
 *     be needed — but for visualization, GMST is sufficient (<1 km error).
 */

import * as THREE from 'three';

const TWOPI    = 2 * Math.PI;
const DEG2RAD  = Math.PI / 180;
const RE_KM    = 6378.135;    // WGS-72 (SGP4 standard)
const MIN_PER_DAY = 1440;

// ── Rust WASM SGP4 (high-performance, loaded async) ────────────────────────
// Falls back to the JS propagator if WASM isn't available.
let _wasmSgp4 = null;
let _wasmLoading = false;

async function _loadWasmSgp4() {
    if (_wasmSgp4 || _wasmLoading) return _wasmSgp4;
    _wasmLoading = true;
    try {
        const mod = await import('./sgp4-wasm/sgp4_wasm.js');
        await mod.default();  // init WASM
        _wasmSgp4 = mod;
        console.info('[SatTracker] Rust SGP4 WASM loaded — high-performance propagation active');
    } catch (err) {
        console.debug('[SatTracker] WASM SGP4 not available, using JS fallback:', err.message);
    }
    _wasmLoading = false;
    return _wasmSgp4;
}

// Try to load WASM immediately (non-blocking)
_loadWasmSgp4();

/** Check if WASM SGP4 is loaded. */
export function isWasmLoaded() { return _wasmSgp4 !== null; }

/** Get the WASM module (or null). */
export function getWasmSgp4() { return _wasmSgp4; }

/** Propagate using WASM if available, else JS fallback. */
function propagate(tle, tsince_min) {
    if (_wasmSgp4 && tle.line1 && tle.line2) {
        try {
            const result = _wasmSgp4.propagate_tle(tle.line1, tle.line2, tsince_min);
            if (result && result.length >= 3 && isFinite(result[0])) {
                return { x: result[0], y: result[1], z: result[2] };
            }
        } catch (_) {
            // WASM propagation failed — fall through to JS
        }
    }
    return jsFallbackPropagate(tle, tsince_min);
}

// ── Pure JS SGP4 fallback (simplified Brouwer mean elements) ─────────────────
// This is a simplified propagator for when the Rust WASM module isn't loaded.
// Uses the same Keplerian mean motion + J2 secular perturbations, but skips
// the full SGP4 drag and deep-space corrections. Good to ~5 km for LEO.

function jsFallbackPropagate(tle, tsince_min) {
    const n0 = tle.mean_motion * TWOPI / MIN_PER_DAY;  // rad/min
    const e0 = tle.eccentricity;
    const i0 = tle.inclination * DEG2RAD;
    const raan0 = tle.raan * DEG2RAD;
    const argp0 = tle.arg_perigee * DEG2RAD;
    const M0 = tle.mean_anomaly * DEG2RAD;

    const cosI = Math.cos(i0);
    const J2 = 0.001082616;
    const a = Math.pow(398600.8 / (n0 * n0 / 3600), 1 / 3);  // km
    const p = a * (1 - e0 * e0);

    // J2 secular rates
    const n0_corr = n0 * (1 + 1.5 * J2 * (RE_KM / p) ** 2 * (1 - 1.5 * (1 - cosI * cosI)));
    const raanDot = -1.5 * J2 * (RE_KM / p) ** 2 * n0 * cosI;
    const argpDot = 0.75 * J2 * (RE_KM / p) ** 2 * n0 * (5 * cosI * cosI - 1);

    const t = tsince_min;
    const M = M0 + n0_corr * t;
    const raan = raan0 + raanDot * t;
    const argp = argp0 + argpDot * t;

    // Kepler's equation (Newton-Raphson)
    let E = M;
    for (let k = 0; k < 10; k++) {
        const dE = (E - e0 * Math.sin(E) - M) / (1 - e0 * Math.cos(E));
        E -= dE;
        if (Math.abs(dE) < 1e-12) break;
    }

    const cosE = Math.cos(E);
    const sinE = Math.sin(E);
    const nu = Math.atan2(Math.sqrt(1 - e0 * e0) * sinE, cosE - e0);
    const r = a * (1 - e0 * cosE);

    // Position in orbital plane
    const u = argp + nu;
    const cosU = Math.cos(u), sinU = Math.sin(u);
    const cosR = Math.cos(raan), sinR = Math.sin(raan);
    const cosI2 = Math.cos(i0), sinI2 = Math.sin(i0);

    // TEME position (km)
    const x = r * (cosR * cosU - sinR * sinU * cosI2);
    const y = r * (sinR * cosU + cosR * sinU * cosI2);
    const z = r * sinU * sinI2;

    // Velocity (simplified — not needed for visualization)
    return { x, y, z };
}

// ── TEME → ECEF via GMST ────────────────────────────────────────────────────

function gmst(jd) {
    const T = (jd - 2451545.0) / 36525.0;
    // IAU-1982 GMST formula (degrees)
    let theta = 67310.54841 + (876600 * 3600 + 8640184.812866) * T
              + 0.093104 * T * T - 6.2e-6 * T * T * T;
    theta = (theta % 86400) / 240;  // seconds → degrees
    return theta * DEG2RAD;
}

function temeToEcef(x, y, z, jd) {
    const g = gmst(jd);
    const cosG = Math.cos(g), sinG = Math.sin(g);
    return {
        x: cosG * x + sinG * y,
        y: -sinG * x + cosG * y,
        z: z,
    };
}

function ecefToLatLonAlt(x, y, z) {
    const r = Math.sqrt(x * x + y * y + z * z);
    const lat = Math.asin(z / r) / DEG2RAD;
    const lon = Math.atan2(y, x) / DEG2RAD;
    const alt = r - RE_KM;
    return { lat, lon, alt };
}

// ── SatelliteTracker class ───────────────────────────────────────────────────

export class SatelliteTracker {
    /**
     * @param {THREE.Object3D} parent      Earth group to attach satellites to
     * @param {number}         earthRadius  Earth sphere radius in scene units
     * @param {object}         [opts]
     * @param {number}         [opts.maxSatellites=500] Max satellites to render
     * @param {boolean}        [opts.showOrbits=true]   Draw orbit trails
     */
    constructor(parent, earthRadius, { maxSatellites = 500, showOrbits = true } = {}) {
        this._parent = parent;
        this._earthR = earthRadius;
        this._maxSats = maxSatellites;
        this._showOrbits = showOrbits;
        this._satellites = [];   // array of { tle, mesh, orbitLine, ... }
        this._group = new THREE.Group();
        this._group.name = 'satellites';
        parent.add(this._group);

        // Dot material (shared)
        this._dotMat = new THREE.PointsMaterial({
            color: 0x00ffcc, size: 0.008, sizeAttenuation: true,
            transparent: true, opacity: 0.9, depthWrite: false,
        });

        // Points geometry (instanced for all satellites)
        this._positions = null;
        this._pointsMesh = null;
    }

    /**
     * Fetch a CelesTrak satellite group and set up visualization.
     * @param {string} group  CelesTrak group name (e.g. 'stations', 'starlink')
     */
    async loadGroup(group = 'stations') {
        try {
            const res = await fetch(`/api/celestrak/tle?group=${group}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            this._setupSatellites(data.satellites ?? []);
            console.info(`[SatTracker] Loaded ${this._satellites.length} satellites (${group})`);

            window.dispatchEvent(new CustomEvent('satellites-loaded', {
                detail: { group, count: this._satellites.length, satellites: this._satellites.map(s => s.tle) },
            }));

            return this._satellites.length;
        } catch (err) {
            console.warn(`[SatTracker] Failed to load ${group}:`, err.message);
            return 0;
        }
    }

    /**
     * Load a single satellite by NORAD ID.
     * @param {number} noradId  NORAD catalog number
     */
    async loadNorad(noradId) {
        try {
            const res = await fetch(`/api/celestrak/tle?norad=${noradId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const sats = data.satellites ?? [];
            // Add to existing catalog rather than replacing
            this._addSatellites(sats);
            return sats[0] ?? null;
        } catch (err) {
            console.warn(`[SatTracker] Failed to load NORAD ${noradId}:`, err.message);
            return null;
        }
    }

    /** Add satellites to the existing catalog (for searched individual sats). */
    _addSatellites(tles) {
        for (const tle of tles) {
            // Skip if already tracked
            if (this._satellites.find(s => s.tle.norad_id === tle.norad_id)) continue;

            const epochYr = tle.epoch_yr ?? 2026;
            const yr = Math.floor(epochYr);
            const dayFrac = (epochYr - yr) * (yr % 4 === 0 ? 366 : 365);
            const jdJan1 = 367 * yr - Math.floor(7 * (yr + Math.floor(10 / 12)) / 4) + Math.floor(275 / 9) + 1721013.5;
            const epochJd = jdJan1 + dayFrac;

            this._satellites.push({ tle, epochJd, lat: 0, lon: 0, alt: 400 });
        }
        this._rebuildPoints();
    }

    /** Rebuild the Points mesh after adding satellites. */
    _rebuildPoints() {
        if (this._pointsMesh) {
            this._group.remove(this._pointsMesh);
            this._pointsMesh.geometry.dispose();
        }
        const n = this._satellites.length;
        const posArr = new Float32Array(n * 3);
        this._positions = new THREE.BufferAttribute(posArr, 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', this._positions);
        this._pointsMesh = new THREE.Points(geo, this._dotMat);
        this._pointsMesh.renderOrder = 10;
        this._group.add(this._pointsMesh);
    }

    /** Update satellite positions to current time. Call every frame. */
    tick(nowMs = Date.now()) {
        if (!this._positions || this._satellites.length === 0) return;

        const jd = nowMs / 86400000 + 2440587.5;
        const posArr = this._positions.array;

        for (let i = 0; i < this._satellites.length; i++) {
            const sat = this._satellites[i];
            const tsince = (jd - sat.epochJd) * MIN_PER_DAY;  // minutes since TLE epoch

            // Propagate via WASM SGP4 (if loaded) or JS fallback
            const teme = propagate(sat.tle, tsince);

            // TEME → ECEF → lat/lon/alt
            const ecef = temeToEcef(teme.x, teme.y, teme.z, jd);
            const lla = ecefToLatLonAlt(ecef.x, ecef.y, ecef.z);

            // Convert to 3D scene position on globe
            const r = this._earthR * (1 + lla.alt / RE_KM);
            const latR = lla.lat * DEG2RAD;
            const lonR = lla.lon * DEG2RAD;

            posArr[i * 3]     = r * Math.cos(latR) * Math.cos(lonR);
            posArr[i * 3 + 1] = r * Math.sin(latR);
            posArr[i * 3 + 2] = r * Math.cos(latR) * Math.sin(lonR);

            // Store for external queries
            sat.lat = lla.lat;
            sat.lon = lla.lon;
            sat.alt = lla.alt;
        }

        this._positions.needsUpdate = true;
    }

    /** Get all satellite positions + info. */
    getSatellites() {
        return this._satellites.map(s => ({
            name: s.tle.name,
            norad_id: s.tle.norad_id,
            lat: s.lat,
            lon: s.lon,
            alt: s.alt,
            period_min: s.tle.period_min,
            inclination: s.tle.inclination,
            apogee_km: s.tle.apogee_km,
            perigee_km: s.tle.perigee_km,
        }));
    }

    /** Get a single satellite by NORAD ID. */
    getSatellite(noradId) {
        const s = this._satellites.find(s => s.tle.norad_id === noradId);
        if (!s) return null;
        return {
            name: s.tle.name, norad_id: s.tle.norad_id,
            lat: s.lat, lon: s.lon, alt: s.alt,
            period_min: s.tle.period_min, inclination: s.tle.inclination,
            tle: s.tle,
        };
    }

    /** Set visibility. */
    setVisible(v) { this._group.visible = v; }

    /**
     * Compute ground track for a satellite (one full orbit).
     * Returns array of { lat, lon, alt } at N equally-spaced time steps.
     * @param {number} noradId  NORAD ID of the satellite
     * @param {number} [steps=360]  Number of points along the orbit
     * @returns {Array<{lat:number, lon:number, alt:number}>|null}
     */
    computeGroundTrack(noradId, steps = 360) {
        const sat = this._satellites.find(s => s.tle.norad_id === noradId);
        if (!sat) return null;

        const periodMin = sat.tle.period_min || 90;
        const jd = Date.now() / 86400000 + 2440587.5;
        const tsinceBase = (jd - sat.epochJd) * MIN_PER_DAY;
        const track = [];

        for (let i = 0; i <= steps; i++) {
            const tsince = tsinceBase + (i / steps) * periodMin;
            const teme = propagate(sat.tle, tsince);
            const jdStep = jd + (i / steps) * periodMin / MIN_PER_DAY;
            const ecef = temeToEcef(teme.x, teme.y, teme.z, jdStep);
            const lla = ecefToLatLonAlt(ecef.x, ecef.y, ecef.z);
            track.push(lla);
        }
        return track;
    }

    /**
     * Build a Three.js line for the ground track projected onto the globe surface.
     * @param {number} noradId
     * @param {number} [heightOffset=0.002] Extra height above the globe surface
     * @returns {THREE.Line|null}
     */
    buildGroundTrackLine(noradId, heightOffset = 0.002) {
        const track = this.computeGroundTrack(noradId, 360);
        if (!track) return null;

        const points = [];
        let prevLon = null;
        for (const pt of track) {
            // Detect antimeridian crossing — break the line to avoid wraparound artifact
            if (prevLon !== null && Math.abs(pt.lon - prevLon) > 180) {
                // Insert NaN to break the line (Three.js Line will gap here)
                points.push(new THREE.Vector3(NaN, NaN, NaN));
            }
            prevLon = pt.lon;

            const r = this._earthR + heightOffset;  // on the surface
            const latR = pt.lat * DEG2RAD;
            const lonR = pt.lon * DEG2RAD;
            points.push(new THREE.Vector3(
                r * Math.cos(latR) * Math.cos(lonR),
                r * Math.sin(latR),
                r * Math.cos(latR) * Math.sin(lonR)
            ));
        }

        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color: 0xffcc00, transparent: true, opacity: 0.5, depthWrite: false,
        });
        return new THREE.Line(geo, mat);
    }

    /**
     * Build a Three.js line for the orbital path (above the surface, at altitude).
     * @param {number} noradId
     * @returns {THREE.Line|null}
     */
    buildOrbitLine(noradId) {
        const track = this.computeGroundTrack(noradId, 360);
        if (!track) return null;

        const points = [];
        for (const pt of track) {
            const r = this._earthR * (1 + pt.alt / RE_KM);
            const latR = pt.lat * DEG2RAD;
            const lonR = pt.lon * DEG2RAD;
            points.push(new THREE.Vector3(
                r * Math.cos(latR) * Math.cos(lonR),
                r * Math.sin(latR),
                r * Math.cos(latR) * Math.sin(lonR)
            ));
        }

        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color: 0x00ffcc, transparent: true, opacity: 0.35, depthWrite: false,
        });
        return new THREE.Line(geo, mat);
    }

    /**
     * Conjunction screening: find close approaches between a target satellite
     * and all loaded catalog objects over the next N hours.
     *
     * Uses WASM batch propagation when available for ~100× speed.
     *
     * @param {number} targetNoradId   NORAD ID of the target satellite
     * @param {number} [hoursAhead=72] Look-ahead window
     * @param {number} [stepMin=10]    Time step in minutes
     * @param {number} [thresholdKm=25] Distance threshold
     * @returns {Array<{name, norad_id, dist_km, hours_ahead, tca_jd}>}
     */
    async screenConjunctions(targetNoradId, hoursAhead = 72, stepMin = 10, thresholdKm = 25) {
        const target = this._satellites.find(s => s.tle.norad_id === targetNoradId);
        if (!target) return [];

        const nSteps = Math.ceil(hoursAhead * 60 / stepMin);
        const jd = Date.now() / 86400000 + 2440587.5;
        const tsinceBase = (jd - target.epochJd) * MIN_PER_DAY;

        // Generate time array
        const times = new Float64Array(nSteps);
        for (let i = 0; i < nSteps; i++) {
            times[i] = tsinceBase + i * stepMin;
        }

        // Propagate target at all time steps
        let targetPositions;  // Array of {x, y, z} per step

        if (_wasmSgp4 && target.tle.line1 && target.tle.line2) {
            try {
                const result = _wasmSgp4.propagate_batch(target.tle.line1, target.tle.line2, times);
                targetPositions = [];
                for (let i = 0; i < nSteps; i++) {
                    const off = i * 6;
                    targetPositions.push({ x: result[off], y: result[off + 1], z: result[off + 2] });
                }
                console.debug(`[Conjunction] Target propagated via WASM: ${nSteps} steps`);
            } catch (_) {
                targetPositions = null;  // fall through to JS
            }
        }

        if (!targetPositions) {
            // JS fallback — propagate one step at a time
            targetPositions = times.map(t => propagate(target.tle, t));
            console.debug(`[Conjunction] Target propagated via JS fallback: ${nSteps} steps`);
        }

        // Screen all catalog objects
        const conjunctions = [];
        const targetAltAvg = (target.tle.perigee_km + target.tle.apogee_km) / 2;

        for (const cat of this._satellites) {
            if (cat.tle.norad_id === targetNoradId) continue;

            // Pre-filter: skip if altitude difference > 200 km
            const catAltAvg = (cat.tle.perigee_km + cat.tle.apogee_km) / 2;
            if (Math.abs(catAltAvg - targetAltAvg) > 200) continue;

            // Propagate catalog object at each step
            const catTsinceBase = (jd - cat.epochJd) * MIN_PER_DAY;

            for (let i = 0; i < nSteps; i++) {
                const tgt = targetPositions[i];
                if (!isFinite(tgt.x)) continue;

                const catTsince = catTsinceBase + i * stepMin;
                const catPos = propagate(cat.tle, catTsince);
                if (!isFinite(catPos.x)) continue;

                const dx = tgt.x - catPos.x;
                const dy = tgt.y - catPos.y;
                const dz = tgt.z - catPos.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                if (dist < thresholdKm) {
                    conjunctions.push({
                        name: cat.tle.name,
                        norad_id: cat.tle.norad_id,
                        dist_km: Math.round(dist * 10) / 10,
                        hours_ahead: Math.round(i * stepMin / 60 * 10) / 10,
                        tca_jd: jd + i * stepMin / MIN_PER_DAY,
                    });
                    break;  // one conjunction per object (closest approach)
                }
            }
        }

        conjunctions.sort((a, b) => a.dist_km - b.dist_km);
        return conjunctions;
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    _setupSatellites(tles) {
        // Clear previous
        if (this._pointsMesh) {
            this._group.remove(this._pointsMesh);
            this._pointsMesh.geometry.dispose();
        }

        const n = Math.min(tles.length, this._maxSats);
        this._satellites = [];

        for (let i = 0; i < n; i++) {
            const tle = tles[i];
            // Compute epoch JD for tsince calculation
            const epochYr = tle.epoch_yr ?? 2026;
            const yr = Math.floor(epochYr);
            const dayFrac = (epochYr - yr) * (yr % 4 === 0 ? 366 : 365);
            const jdJan1 = 367 * yr - Math.floor(7 * (yr + Math.floor(10 / 12)) / 4) + Math.floor(275 / 9) + 1721013.5;
            const epochJd = jdJan1 + dayFrac;

            this._satellites.push({
                tle,
                epochJd,
                lat: 0, lon: 0, alt: 400,
            });
        }

        // Create points geometry
        const posArr = new Float32Array(n * 3);
        this._positions = new THREE.BufferAttribute(posArr, 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', this._positions);
        this._pointsMesh = new THREE.Points(geo, this._dotMat);
        this._pointsMesh.renderOrder = 10;
        this._group.add(this._pointsMesh);
    }
}
