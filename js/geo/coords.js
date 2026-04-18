/**
 * coords.js — Unified Earth coordinate system for Celestial Simulator
 * ═══════════════════════════════════════════════════════════════════════════════
 * Single source of truth for every (lat, lon) ↔ (x, y, z) ↔ (u, v) conversion
 * used by the Earth renderer, satellite tracker, weather feed, aurora oval,
 * storm placement, and future tile/WFC systems.
 *
 * Inspired by the WorldCoordinateConverter pattern from Explore the Universe
 * 2175 — one class owns every transform so call sites stop re-deriving trig
 * in 19 different files with 19 slightly different sign conventions.
 *
 * ── CANONICAL FRAME (right-handed, Y-up, matches Three.js + Blue Marble) ───
 *   +X  →  equator at  lon =    0°   (prime meridian, Gulf of Guinea)
 *   +Y  →  geographic north pole
 *   −Z  →  equator at  lon =  +90°E  (central Indian Ocean)
 *   −X  →  antimeridian                (lon = ±180°)
 *   +Z  →  equator at  lon =  −90°W  (eastern Pacific)
 *
 * ── UV CONVENTION (equirectangular, matches Blue Marble + Open-Meteo) ──────
 *     u = 0   at lon = −180°,   u = 1   at lon = +180°
 *     v = 0   at lat =  +90°N,  v = 1   at lat =  −90°S
 *
 * ── UNITS ─────────────────────────────────────────────────────────────────
 *   Internally all angles are RADIANS. Use `geo.deg.*` wrappers for degree
 *   input or `geo.toDeg(x)` / `geo.toRad(x)` for explicit conversions.
 *   Positions are in SCENE UNITS (Earth radius ≈ 1.0 by default).
 *   Distances are in KILOMETRES unless suffixed Units.
 */

import * as THREE from 'three';

// ── Constants ────────────────────────────────────────────────────────────────
export const DEG  = Math.PI / 180;
export const RAD  = 180 / Math.PI;
export const TAU  = Math.PI * 2;

export const EARTH_RADIUS_KM    = 6371.0088;          // IUGG mean volumetric radius
export const EARTH_FLATTENING   = 1 / 298.257223563;  // WGS-84 (unused at this stage)
export const AXIAL_TILT_RAD     = 23.4392911 * DEG;   // J2000 mean obliquity
export const SIDEREAL_DAY_SEC   = 86164.0905;         // rotation period

// IGRF-13 geomagnetic dipole pole (epoch 2025.0) — used for aurora placement
export const GEOMAG_NORTH_LAT_2025 = 80.65 * DEG;
export const GEOMAG_NORTH_LON_2025 = -72.68 * DEG;

// ── Main class ───────────────────────────────────────────────────────────────
export class GeoCoords {
    /**
     * @param {Object}   [opts]
     * @param {number}   [opts.radiusUnits=1.0]     Earth radius in scene units
     * @param {number}   [opts.radiusKm=6371.0088]  Earth radius in km (for distances)
     * @param {number}   [opts.axialTiltRad]        Obliquity (J2000 default)
     * @param {Date}     [opts.epoch]               Simulation epoch for IGRF / GMST
     */
    constructor(opts = {}) {
        this.radiusUnits  = opts.radiusUnits  ?? 1.0;
        this.radiusKm     = opts.radiusKm     ?? EARTH_RADIUS_KM;
        this.axialTiltRad = opts.axialTiltRad ?? AXIAL_TILT_RAD;
        this.epoch        = opts.epoch        ?? new Date();

        this.unitsPerKm   = this.radiusUnits / this.radiusKm;
        this.kmPerUnit    = this.radiusKm / this.radiusUnits;

        // Geomagnetic dipole pole (ECEF unit vector). Fixed at construction;
        // call `setEpoch()` to rebuild when running time-lapse simulations.
        this._magPoleN    = this.latLonToNormal(GEOMAG_NORTH_LAT_2025,
                                                GEOMAG_NORTH_LON_2025);

        // Optional WASM backend for hot-path conversions (not wired yet)
        this.backend      = null;

        // Scratch vectors — reused to avoid allocation in per-frame loops
        this._tmpA = new THREE.Vector3();
        this._tmpB = new THREE.Vector3();
    }

    // ── Configuration ─────────────────────────────────────────────────────────
    setRadiusUnits(r) {
        this.radiusUnits = r;
        this.unitsPerKm  = r / this.radiusKm;
        this.kmPerUnit   = this.radiusKm / r;
    }

    setEpoch(date) {
        this.epoch = date;
        // Future: recompute IGRF dipole here by interpolating Gauss coefficients
    }

    bindBackend(backend) {
        this.backend = backend;
    }

    // ── Unit helpers ──────────────────────────────────────────────────────────
    toRad(deg) { return deg * DEG; }
    toDeg(rad) { return rad * RAD; }
    kmToUnits(km)       { return km * this.unitsPerKm; }
    unitsToKm(units)    { return units * this.kmPerUnit; }

    // ── Input normalizers ─────────────────────────────────────────────────────
    // Accept any of: {lat, lon}, [lat, lon], {lat, lon, alt}, THREE.Vector2
    // Returns {lat, lon, alt} in radians + kilometres (alt defaults to 0).
    // If `degrees=true`, input lat/lon are interpreted as degrees.
    _extractLatLon(p, degrees = false) {
        if (p == null) throw new Error('GeoCoords: position is null');
        let lat, lon, alt = 0;
        if (Array.isArray(p)) {
            [lat, lon, alt = 0] = p;
        } else if (typeof p === 'object') {
            if ('lat' in p && 'lon' in p) {
                ({ lat, lon } = p);
                alt = p.alt ?? p.altitude ?? 0;
            } else if ('latitude' in p && 'longitude' in p) {
                lat = p.latitude;  lon = p.longitude;
                alt = p.altitude ?? 0;
            } else if ('x' in p && 'y' in p) {
                // Vector2: treat as (lat, lon)
                lat = p.x;  lon = p.y;
            }
        }
        if (lat == null || lon == null) {
            throw new Error(`GeoCoords: unsupported lat/lon format: ${JSON.stringify(p)}`);
        }
        if (degrees) { lat *= DEG;  lon *= DEG; }
        return { lat, lon, alt };
    }

    // Accept any of: THREE.Vector3, [x, y, z], {x, y, z}. Returns Vector3.
    _extractVec3(p, out = new THREE.Vector3()) {
        if (p == null) throw new Error('GeoCoords: vec3 is null');
        if (p.isVector3) return out.copy(p);
        if (Array.isArray(p)) return out.set(p[0], p[1], p[2]);
        if ('x' in p && 'y' in p && 'z' in p) return out.set(p.x, p.y, p.z);
        throw new Error(`GeoCoords: unsupported vec3 format: ${JSON.stringify(p)}`);
    }

    // ── PRIMITIVES (radians in, Three.js types out) ───────────────────────────

    /** Geographic → unit normal on sphere (ECEF-like, Y-up) */
    latLonToNormal(lat, lon, out = new THREE.Vector3()) {
        const cl = Math.cos(lat);
        return out.set(
             cl * Math.cos(lon),
             Math.sin(lat),
            -cl * Math.sin(lon),
        );
    }

    /** Unit normal → { lat, lon } in radians. Inverse of latLonToNormal. */
    normalToLatLon(n) {
        const v = this._extractVec3(n, this._tmpA);
        return {
            lat: Math.asin(THREE.MathUtils.clamp(v.y, -1, 1)),
            lon: Math.atan2(-v.z, v.x),
        };
    }

    /** Geographic → 3D position at given radius (scene units). */
    latLonToPosition(lat, lon, radiusUnits = this.radiusUnits,
                     out = new THREE.Vector3()) {
        return this.latLonToNormal(lat, lon, out).multiplyScalar(radiusUnits);
    }

    /** 3D position → { lat, lon, radiusUnits } */
    positionToLatLon(p) {
        const v = this._extractVec3(p, this._tmpA);
        const r = v.length();
        if (r < 1e-9) return { lat: 0, lon: 0, radiusUnits: 0 };
        return {
            lat: Math.asin(THREE.MathUtils.clamp(v.y / r, -1, 1)),
            lon: Math.atan2(-v.z, v.x),
            radiusUnits: r,
        };
    }

    /** Unit normal → equirectangular UV. */
    normalToUV(n, out = new THREE.Vector2()) {
        const { lat, lon } = this.normalToLatLon(n);
        return out.set(
            (lon + Math.PI) / TAU,       // u: 0 at −180°, 1 at +180°
            0.5 - lat / Math.PI,         // v: 0 at +90°N, 1 at −90°S
        );
    }

    /** Equirectangular UV → unit normal. */
    uvToNormal(u, v, out = new THREE.Vector3()) {
        const lon = u * TAU - Math.PI;
        const lat = (0.5 - v) * Math.PI;
        return this.latLonToNormal(lat, lon, out);
    }

    /** Geographic → equirectangular UV (convenience). */
    latLonToUV(lat, lon, out = new THREE.Vector2()) {
        return out.set(
            (lon + Math.PI) / TAU,
            0.5 - lat / Math.PI,
        );
    }

    /** Equirectangular UV → { lat, lon } in radians. */
    uvToLatLon(u, v) {
        return {
            lat: (0.5 - v) * Math.PI,
            lon: u * TAU - Math.PI,
        };
    }

    // ── Spherical geometry helpers ────────────────────────────────────────────

    /** Great-circle angular distance between two points (radians). */
    angularDistance(a, b) {
        const A = typeof a.lat === 'number' ? a : this.normalToLatLon(a);
        const B = typeof b.lat === 'number' ? b : this.normalToLatLon(b);
        const dLat = B.lat - A.lat;
        const dLon = B.lon - A.lon;
        const s = Math.sin(dLat / 2) ** 2
                + Math.cos(A.lat) * Math.cos(B.lat) * Math.sin(dLon / 2) ** 2;
        return 2 * Math.asin(Math.min(1, Math.sqrt(s)));
    }

    /** Great-circle distance in kilometres. */
    distanceKm(a, b) {
        return this.angularDistance(a, b) * this.radiusKm;
    }

    /** Initial bearing from A to B along the great circle (radians, 0 = north, CW). */
    bearing(a, b) {
        const A = typeof a.lat === 'number' ? a : this.normalToLatLon(a);
        const B = typeof b.lat === 'number' ? b : this.normalToLatLon(b);
        const dLon = B.lon - A.lon;
        const y = Math.sin(dLon) * Math.cos(B.lat);
        const x = Math.cos(A.lat) * Math.sin(B.lat)
                - Math.sin(A.lat) * Math.cos(B.lat) * Math.cos(dLon);
        return Math.atan2(y, x);
    }

    /** Antipodal point (lat, lon in radians). */
    antipode({ lat, lon }) {
        return {
            lat: -lat,
            lon: lon > 0 ? lon - Math.PI : lon + Math.PI,
        };
    }

    // ── Sun & day/night ───────────────────────────────────────────────────────

    /**
     * Direction from Earth centre to the Sun in ECEF frame at `date`.
     * Good to ~0.1° — sufficient for terminator shading, not for celestial mechanics.
     */
    sunDirectionEcef(date = this.epoch, out = new THREE.Vector3()) {
        const jd  = date.getTime() / 86400000 + 2440587.5;   // Julian day
        const n   = jd - 2451545.0;                          // days since J2000
        const L   = (280.460 + 0.9856474 * n) * DEG;         // mean longitude
        const g   = (357.528 + 0.9856003 * n) * DEG;         // mean anomaly
        const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
        const eps = this.axialTiltRad;
        const gmst = this.greenwichSiderealTime(date);       // radians

        // ECI sun direction
        const sunEci = new THREE.Vector3(
             Math.cos(lam),
             Math.sin(lam) * Math.sin(eps),
             Math.sin(lam) * Math.cos(eps),   // note: ECI Z = north pole
        );
        return this.eciToEcef(sunEci, gmst, out);
    }

    /** Sub-solar point (lat, lon in radians) at `date`. */
    subSolarPoint(date = this.epoch) {
        return this.normalToLatLon(this.sunDirectionEcef(date, this._tmpB));
    }

    /** Is a position on the day side? (dot(n, sunDir) > 0) */
    isDaySide(latLonOrNormal, date = this.epoch) {
        const n = typeof latLonOrNormal.lat === 'number'
            ? this.latLonToNormal(latLonOrNormal.lat, latLonOrNormal.lon, this._tmpA)
            : this._extractVec3(latLonOrNormal, this._tmpA);
        const sun = this.sunDirectionEcef(date, this._tmpB);
        return n.dot(sun) > 0;
    }

    // ── Sidereal time & ECI↔ECEF (for satellites) ─────────────────────────────

    /** Greenwich mean sidereal time in radians (IAU 1982, good to ~1 arcsec). */
    greenwichSiderealTime(date = this.epoch) {
        const jd  = date.getTime() / 86400000 + 2440587.5;
        const T   = (jd - 2451545.0) / 36525.0;
        const gmstSec = 67310.54841
                      + (876600 * 3600 + 8640184.812866) * T
                      + 0.093104 * T * T
                      - 6.2e-6 * T * T * T;
        const gmstRad = ((gmstSec % 86400) / 86400) * TAU;
        return (gmstRad + TAU) % TAU;
    }

    /** ECI vector → ECEF (rotate −GMST about Z, then flip Z for Three.js frame). */
    eciToEcef(eci, gmstRad, out = new THREE.Vector3()) {
        const v = this._extractVec3(eci, this._tmpA);
        const c = Math.cos(gmstRad);
        const s = Math.sin(gmstRad);
        // ECI → ECEF: rotate by −GMST about Z (standard convention)
        // Then map astronomical ECEF (Z = north) to our scene frame (Y = north).
        const xEcef =  c * v.x + s * v.y;
        const yEcef = -s * v.x + c * v.y;
        const zEcef =  v.z;
        return out.set(xEcef, zEcef, -yEcef);
    }

    /** ECEF (our scene frame) → ECI, inverse of eciToEcef. */
    ecefToEci(ecef, gmstRad, out = new THREE.Vector3()) {
        const v = this._extractVec3(ecef, this._tmpA);
        // Unmap scene frame back to astronomical ECEF
        const xA =  v.x, yA = -v.z, zA = v.y;
        const c = Math.cos(gmstRad);
        const s = Math.sin(gmstRad);
        const xEci =  c * xA - s * yA;
        const yEci =  s * xA + c * yA;
        return out.set(xEci, yEci, zA);
    }

    // ── Geomagnetic (dipole approximation) ────────────────────────────────────

    /**
     * Geographic → geomagnetic lat/lon using the IGRF-13 dipole at epoch 2025.
     * Accurate to ~1–2° for aurora oval work; replace with full IGRF when needed.
     */
    geoToMagnetic({ lat, lon }) {
        const n = this.latLonToNormal(lat, lon, this._tmpA);
        // Build magnetic frame: +Z_mag = dipole north, with an arbitrary stable +X_mag
        const zMag = this._magPoleN;
        // Choose +X_mag in the geographic meridian plane of the dipole pole
        const north = new THREE.Vector3(0, 1, 0);
        const xMag  = new THREE.Vector3().crossVectors(north, zMag).normalize();
        const yMag  = new THREE.Vector3().crossVectors(zMag, xMag).normalize();
        const mx = n.dot(xMag);
        const my = n.dot(yMag);
        const mz = n.dot(zMag);
        return {
            lat: Math.asin(THREE.MathUtils.clamp(mz, -1, 1)),
            lon: Math.atan2(-my, mx),     // sign chosen to match geographic convention
        };
    }

    /** Magnetic colatitude in radians (0 at magnetic pole, π at magnetic equator). */
    magneticColatitude(latLon) {
        const n = this.latLonToNormal(latLon.lat, latLon.lon, this._tmpA);
        return Math.acos(THREE.MathUtils.clamp(n.dot(this._magPoleN), -1, 1));
    }

    // ── Self-test (dev use) ───────────────────────────────────────────────────
    /**
     * Verifies round-trips agree to ~1e-9. Returns an array of failures;
     * empty array = all green.
     */
    selfTest() {
        const fails = [];
        const eps = 1e-9;
        const samples = [
            { lat:  0,            lon:  0           },  // Gulf of Guinea
            { lat:  0,            lon:  90 * DEG    },  // Indian Ocean
            { lat:  0,            lon: -90 * DEG    },  // Pacific
            { lat:  0,            lon: 180 * DEG    },  // antimeridian
            { lat:  45 * DEG,     lon:  45 * DEG    },
            { lat: -30 * DEG,     lon: -60 * DEG    },
            { lat:  89.9 * DEG,   lon:  17 * DEG    },
            { lat: -89.9 * DEG,   lon: -153 * DEG   },
        ];
        for (const s of samples) {
            // latLon → normal → latLon
            const n  = this.latLonToNormal(s.lat, s.lon);
            const ll = this.normalToLatLon(n);
            if (Math.abs(ll.lat - s.lat) > eps
             || Math.abs(((ll.lon - s.lon + Math.PI * 3) % TAU) - Math.PI) > eps) {
                fails.push(['latLon↔normal', s, ll]);
            }
            // latLon → uv → latLon
            const uv  = this.latLonToUV(s.lat, s.lon);
            const ll2 = this.uvToLatLon(uv.x, uv.y);
            if (Math.abs(ll2.lat - s.lat) > eps
             || Math.abs(((ll2.lon - s.lon + Math.PI * 3) % TAU) - Math.PI) > eps) {
                fails.push(['latLon↔uv', s, ll2]);
            }
            // normal → uv → normal
            const uv2 = this.normalToUV(n);
            const n2  = this.uvToNormal(uv2.x, uv2.y);
            if (n.distanceTo(n2) > eps) {
                fails.push(['normal↔uv', s, n.toArray(), n2.toArray()]);
            }
        }
        return fails;
    }
}

// ── Default singleton — import { geo } for the common case ───────────────────
export const geo = new GeoCoords();

// ── Degree-input convenience wrappers ────────────────────────────────────────
// Keeps call sites that think in degrees ergonomic without polluting the class.
geo.deg = Object.freeze({
    latLonToNormal:   (latDeg, lonDeg, out) =>
        geo.latLonToNormal(latDeg * DEG, lonDeg * DEG, out),
    latLonToPosition: (latDeg, lonDeg, rUnits, out) =>
        geo.latLonToPosition(latDeg * DEG, lonDeg * DEG, rUnits, out),
    latLonToUV:       (latDeg, lonDeg, out) =>
        geo.latLonToUV(latDeg * DEG, lonDeg * DEG, out),
    normalToLatLon:   (n) => {
        const r = geo.normalToLatLon(n);
        return { lat: r.lat * RAD, lon: r.lon * RAD };
    },
    uvToLatLon:       (u, v) => {
        const r = geo.uvToLatLon(u, v);
        return { lat: r.lat * RAD, lon: r.lon * RAD };
    },
    subSolarPoint:    (date) => {
        const r = geo.subSolarPoint(date);
        return { lat: r.lat * RAD, lon: r.lon * RAD };
    },
    distanceKm:       (aDeg, bDeg) => geo.distanceKm(
        { lat: aDeg.lat * DEG, lon: aDeg.lon * DEG },
        { lat: bDeg.lat * DEG, lon: bDeg.lon * DEG },
    ),
    bearing:          (aDeg, bDeg) => geo.bearing(
        { lat: aDeg.lat * DEG, lon: aDeg.lon * DEG },
        { lat: bDeg.lat * DEG, lon: bDeg.lon * DEG },
    ) * RAD,
});

export default geo;
