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
import { geo, DEG, RAD } from './geo/coords.js';

const TWOPI    = 2 * Math.PI;
const DEG2RAD  = DEG;         // kept as alias for SGP4 orbital-element conversions
const RE_KM    = 6378.135;    // WGS-72 (SGP4 standard — distinct from geo.radiusKm)
const MIN_PER_DAY = 1440;

// Atomics-fence slot indices in the sync Int32Array shared with the
// propagation worker. Mirrored at the top of
// js/operations/propagation-worker.js — keep in lockstep.
const SYNC_PUBLISH_SLOT = 0;
const SYNC_WRITING_SLOT = 1;

// ── Rust WASM SGP4 (high-performance, loaded async) ────────────────────────
// Falls back to the JS propagator if WASM isn't available.
let _wasmSgp4 = null;
let _wasmLoading = false;

async function _loadWasmSgp4() {
    if (_wasmSgp4 || _wasmLoading) return _wasmSgp4;
    _wasmLoading = true;
    const t0 = performance.now();
    try {
        const mod = await import('./sgp4-wasm/sgp4_wasm.js');
        await mod.default();  // init WASM
        _wasmSgp4 = mod;
        console.info('[SatTracker] Rust SGP4 WASM loaded — high-performance propagation active');
        // Telemetry: how long did the WASM cold-start take? Big swings
        // in p95 here are usually network / CDN edge problems, not
        // wasm-bindgen instantiation. Lazy import so satellite-tracker
        // doesn't pull telemetry into pages that don't need it.
        try {
            const { telemetry } = await import('./telemetry.js');
            telemetry.recordPerf('wasm_sgp4_init', performance.now() - t0);
        } catch {}
    } catch (err) {
        console.debug('[SatTracker] WASM SGP4 not available, using JS fallback:', err.message);
        // Telemetry: don't burn an `error` row on this — WASM-unavailable
        // is an expected fallback for older browsers. Log as a tagged
        // app_perf with a -1 value so we can count occurrence rates
        // without polluting the error top-N.
        try {
            const { telemetry } = await import('./telemetry.js');
            telemetry.recordPerf('wasm_sgp4_init_failed', -1);
        } catch {}
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

/** Propagate a TLE via Rust WASM if available, else JS fallback.
 *  Exported so pass-predictor.js and conjunction tools can reuse the same
 *  propagator the live tracker draws with. */
export function propagate(tle, tsince_min) {
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

// ── TEME → scene-frame position via unified coordinate module ───────────────
// GMST rotation, ECI→ECEF mapping, and the scene-frame flip (astronomical
// Z = north → Three.js Y = north, plus the −Z = +90°E convention) all live
// in js/geo/coords.js. This file stays focused on orbital mechanics (SGP4,
// Kepler) and delegates every Earth-geography conversion to the module.
//
// `_temeScratch` / `_sceneScratch` are module-level scratch vectors used by
// the per-frame `tick()` loop to avoid per-sat Vector3 allocations.
const _temeScratch  = new THREE.Vector3();
const _sceneScratch = new THREE.Vector3();

// ── Constellation color map ─────────────────────────────────────────────────
// Each group gets a distinct color for per-vertex coloring.
const GROUP_COLORS = {
    'stations':      new THREE.Color(0xffffff),  // white — ISS, Tiangong
    'starlink':      new THREE.Color(0xccddff),  // cool white — SpaceX
    'oneweb':        new THREE.Color(0x4488ff),  // blue — OneWeb
    'gps-ops':       new THREE.Color(0x00ff88),  // green — GPS
    'galileo':       new THREE.Color(0x00ccff),  // cyan — Galileo
    'beidou':        new THREE.Color(0xff8844),  // orange — BeiDou
    'glonass':       new THREE.Color(0xff4444),  // red — GLONASS
    'weather':       new THREE.Color(0xffdd44),  // yellow — GOES/JPSS/Meteosat
    'resource':      new THREE.Color(0x44ff44),  // lime — Landsat/Sentinel
    'science':       new THREE.Color(0xcc66ff),  // purple — Hubble/JWST/Chandra
    'iridium':       new THREE.Color(0xff66aa),  // pink — Iridium
    'globalstar':    new THREE.Color(0xffaa66),  // peach — Globalstar
    'amateur':       new THREE.Color(0x66ffcc),  // teal — Ham radio
    'visual':        new THREE.Color(0xffffaa),  // pale yellow — Bright objects
    'active':        new THREE.Color(0x88aacc),  // muted blue — All active
    'debris':        new THREE.Color(0xff2200),  // danger red — Debris
    'last-30-days':  new THREE.Color(0x00ffaa),  // mint — Recent launches
    'geo':           new THREE.Color(0xffaa00),  // amber — Geostationary
    'planet':        new THREE.Color(0x88ff88),  // light green — Planet Labs
    'search':        new THREE.Color(0x00ffcc),  // original cyan — Manual search
    '_default':      new THREE.Color(0x00ffcc),  // fallback
};

/** Get the color for a constellation group. */
export function getGroupColor(group) {
    return GROUP_COLORS[group] ?? GROUP_COLORS._default;
}

/** Get the hex string for a group (for CSS). */
export function getGroupColorHex(group) {
    return '#' + (GROUP_COLORS[group] ?? GROUP_COLORS._default).getHexString();
}

// ── SatelliteTracker class ───────────────────────────────────────────────────

export class SatelliteTracker {
    /**
     * @param {THREE.Object3D} parent      Earth group to attach satellites to
     * @param {number}         earthRadius  Earth sphere radius in scene units
     * @param {object}         [opts]
     * @param {number}         [opts.maxSatellites=50000] Max satellites to render
     * @param {boolean}        [opts.showOrbits=true]     Draw orbit trails
     */
    constructor(parent, earthRadius, { maxSatellites = 50000, showOrbits = true } = {}) {
        this._parent = parent;
        this._earthR = earthRadius;
        this._maxSats = maxSatellites;
        this._showOrbits = showOrbits;
        this._satellites = [];   // array of { tle, epochJd, group, lat, lon, alt }
        // O(1) NORAD ID → index lookup. Kept in lockstep with _satellites
        // by _addSatellites; every consumer that needs a per-sat slot
        // (highlight sprite, TCA arcs, color overrides) uses this.
        this._indexByNorad = new Map();
        this._groups = new Map(); // group name → { visible, count, color }
        this._group = new THREE.Group();
        this._group.name = 'satellites';
        parent.add(this._group);

        // Per-vertex color material (replaces uniform cyan)
        this._dotMat = new THREE.PointsMaterial({
            size: 0.008, sizeAttenuation: true,
            transparent: true, opacity: 0.9, depthWrite: false,
            vertexColors: true,
        });

        this._positions = null;
        this._colors = null;
        this._pointsMesh = null;

        // Batch propagation hot-path. WASM keeps a parallel registry
        // of parsed Sgp4State so the per-frame tick can call one
        // function instead of N (parse + init + propagate)s. The
        // registry is append-only and indices line up with
        // `_satellites[i]`. `_batchSyncedTo` tracks how many slots
        // have been registered; new sats get registered lazily at
        // the next tick or via _syncRegistry() so add-at-load and
        // WASM-ready-after-load both converge on a consistent state.
        this._batchOut       = null;       // Float32Array of length 3·maxSats
        this._batchSyncedTo  = 0;          // index up to which the registry is in sync
        this._batchAvailable = false;      // true once WASM exposes registry_*

        // Off-thread propagation. When a Worker spawns and reports
        // ready, the live tick stops calling WASM in-line and instead
        // hands the work to the worker. Two transports:
        //
        //   - SAB ("shared")     : crossOriginIsolated === true. We
        //     allocate a SharedArrayBuffer once, pass it to the worker,
        //     and use the same memory as the THREE position attribute.
        //     Tick messages carry only jd/gmst/scale; the worker writes
        //     directly into the SAB; the main thread sets needsUpdate
        //     and reads lat/lon from the same buffer. Zero CPU copies.
        //
        //   - Transferable       : not isolated (older browser, no
        //     COOP/COEP, mobile Safari). Single ArrayBuffer ping-pongs
        //     between main and worker via postMessage transfer.
        //
        // Both share the same _workerInFlight / _workerSyncedTo
        // bookkeeping; the difference is only in how positions
        // surface.
        this._worker          = null;
        this._workerReady     = false;
        this._workerSyncedTo  = 0;          // sats already shipped to the worker
        this._workerBuf       = null;       // transferable: Float32Array, our half of the ping-pong
        this._workerInFlight  = false;
        this._workerFrameId   = 0;
        this._workerLastFrame = 0;          // most recent frameId that landed
        this._workerEnabled   = (typeof Worker !== 'undefined');

        // SAB fast path. crossOriginIsolated requires COOP/COEP to be
        // set on the document; vercel.json + dev-server.mjs add them
        // on /operations.html. Pages without those headers (or
        // browsers that don't honour `credentialless` — Safari today)
        // see crossOriginIsolated === false and stay on the
        // transferable path.
        //
        // _syncSab is a tiny (16-byte) SAB carrying an Int32Array we
        // use as an Atomics fence between the worker's SAB writes
        // and the main thread's gl.bufferData read. Slot 0 is the
        // publish counter (worker writes after each completed
        // frame), slot 1 is the writing flag (1 while writes are in
        // progress, 0 when done). Without the fence, a slow render
        // could in principle overlap a worker write — bounded but
        // visually torn. With it, we just defer the upload one frame
        // when the writing flag is set.
        const isolated = typeof self !== 'undefined'
            && self.crossOriginIsolated
            && typeof SharedArrayBuffer !== 'undefined';
        this._posSab        = null;
        this._syncSab       = null;
        this._syncView      = null;
        this._sabReady      = false;             // worker has accepted the SAB
        this._lastUploadedFrame = 0;             // frameId we last uploaded for
        if (isolated) {
            try {
                this._posSab   = new SharedArrayBuffer(this._maxSats * 3 * 4);
                this._syncSab  = new SharedArrayBuffer(16);
                this._syncView = new Int32Array(this._syncSab);
            } catch (err) {
                console.debug('[SatTracker] SAB alloc failed, transferable path only:', err.message);
                this._posSab = null;
                this._syncSab = null;
                this._syncView = null;
            }
        }

        if (this._workerEnabled) this._spawnWorker();

        // Shell visualization group
        this._shellGroup = new THREE.Group();
        this._shellGroup.name = 'orbital-shells';
        this._shellGroup.visible = false;
        parent.add(this._shellGroup);

        // Optional single-satellite highlight (e.g. pin "ISS" out of the
        // stations group). Lazily built on the first setHighlight() call.
        this._highlightNoradId = null;
        this._highlightOpts    = null;
        this._highlightSprite  = null;
        this._highlightCanvas  = null;
        this._highlightTexture = null;

        // Colour-override layer. Map<noradId, THREE.Color>. Applied in
        // _updateColors() and _rebuildPoints(), so overrides survive
        // group-visibility toggles and catalog loads. Used by the
        // weather-alert overlay to tint flagged sats without disturbing
        // group colours.
        this._colorOverrides = null;
    }

    // ── Highlight a single satellite with a sprite (dot + text label) ────
    // So a specific NORAD ID stays findable in a field of ~30 k dots. The
    // sprite is a child of the tracker's internal group, so it inherits
    // whatever coordinate frame the parent container is in.
    //
    // opts: { label: string, color: hex }
    setHighlight(noradId, opts = {}) {
        this._highlightNoradId = noradId;
        this._highlightOpts    = {
            label: opts.label ?? '',
            color: opts.color ?? 0x00ffcc,
        };
        if (!this._highlightSprite) this._buildHighlightSprite();
        else                        this._rebuildHighlightTexture();
        this._highlightSprite.visible = true;
    }

    clearHighlight() {
        this._highlightNoradId = null;
        if (this._highlightSprite) this._highlightSprite.visible = false;
    }

    setHighlightVisible(v) {
        if (this._highlightSprite) {
            this._highlightSprite.visible = !!v && this._highlightNoradId != null;
        }
    }

    // ── Bulk per-satellite colour tinting ────────────────────────────────
    // For overlays that want to recolour many specific satellites at once
    // (e.g. "these sats are currently passing over an active NWS alert")
    // without fighting the group-colour system or allocating new geometry.
    // Writes into the existing colour buffer in-place.
    //
    // `overrideMap` is a Map<noradId, THREE.Color>, or null/undefined to
    // clear. Null clears; an empty Map also clears (cheap no-op).
    //
    // Safe to call every animation frame — but the matcher shouldn't
    // need more than ~1 Hz because satellites don't move far enough per
    // frame to cross alert-footprint boundaries.
    setColorOverrides(overrideMap) {
        this._colorOverrides = overrideMap && overrideMap.size > 0
            ? overrideMap
            : null;
        this._updateColors();
    }

    /** Remove any active colour overrides and restore group colours. */
    clearColorOverrides() {
        if (this._colorOverrides === null) return;
        this._colorOverrides = null;
        this._updateColors();
    }

    /**
     * Screen a target satellite against the loaded debris catalog only.
     *
     * Thin wrapper over screenConjunctions with groupFilter='debris' and
     * LEO-friendly defaults (50 km threshold, 24 h look-ahead, 10-min
     * step). Returns the same shape as screenConjunctions — caller can
     * derive a count, closest approach, or render a list.
     *
     * Callers should only invoke this on user demand (click Screen) —
     * it still propagates every debris entry via SGP4 and is NOT cheap
     * enough to run per frame.
     */
    async countDebrisApproaches(noradId, opts = {}) {
        const {
            withinKm  = 50,
            horizonH  = 24,
            stepMin   = 10,
        } = opts;
        return this.screenConjunctions(noradId, horizonH, stepMin, withinKm, 'debris');
    }

    /**
     * Instant per-altitude-band census of the catalog: given a reference
     * altitude and a band half-width (km), count how many debris / active
     * satellites currently sit within that band. Purely a filter over the
     * `alt` field the tracker updates each tick, so this is O(N_sats)
     * and safe to call every animation frame.
     *
     * @param {number}  altKm        Reference altitude (km above RE).
     * @param {number}  [bandKm=25]  Band half-width (km). Total band = 2·bandKm.
     * @param {number|null} [excludeId=null]  NORAD ID to exclude (usually the
     *                                        selected sat itself).
     * @returns {{ debris:number, active:number, total:number, bandKm:number }}
     */
    getAltitudeCohort(altKm, bandKm = 25, excludeId = null) {
        const lo = altKm - bandKm;
        const hi = altKm + bandKm;
        let debris = 0, active = 0;
        for (const s of this._satellites) {
            if (s.tle.norad_id === excludeId) continue;
            if (!Number.isFinite(s.alt))      continue;
            if (s.alt < lo || s.alt > hi)     continue;
            if (s.group === 'debris') debris++;
            else                      active++;
        }
        return { debris, active, total: debris + active, bandKm };
    }

    /**
     * Return the satellites in a given CelesTrak group, shaped like
     * getSatellites() entries.  Handy for group-scoped analytics /
     * overlays that shouldn't re-filter the full catalog each time.
     */
    getSatellitesByGroup(group) {
        return this._satellites
            .filter(s => s.group === group)
            .map(s => ({
                name:        s.tle.name,
                norad_id:    s.tle.norad_id,
                group:       s.group,
                lat:         s.lat,
                lon:         s.lon,
                alt:         s.alt,
                period_min:  s.tle.period_min,
                inclination: s.tle.inclination,
                apogee_km:   s.tle.apogee_km,
                perigee_km:  s.tle.perigee_km,
            }));
    }

    /**
     * Return the raw TLE objects for a given CelesTrak group, or an
     * array aggregated across groups when `group === null`.  Used by
     * the Web Worker pre-compute path to ship catalogs across the
     * postMessage boundary without including the scratch render state.
     *
     * @param {string|string[]|null} group  group name, list of names,
     *        or null to mean "every loaded group".
     */
    getTlesByGroup(group) {
        const matches = (g) => {
            if (group == null) return true;
            if (Array.isArray(group)) return group.includes(g);
            return g === group;
        };
        return this._satellites
            .filter(s => matches(s.group))
            .map(s => s.tle);
    }

    _buildHighlightSprite() {
        const cv  = document.createElement('canvas');
        cv.width  = 128;
        cv.height = 40;
        const tex = new THREE.CanvasTexture(cv);
        tex.minFilter = THREE.LinearFilter;
        const mat = new THREE.SpriteMaterial({
            map: tex, transparent: true,
            depthWrite: false, depthTest: false,
        });
        const sprite = new THREE.Sprite(mat);
        // World-unit size: ≈1/5 of Earth radius. Keep 128×40 canvas aspect.
        sprite.scale.set(0.20, 0.0625, 1);
        // Anchor the sprite on the *dot* (drawn at canvas x=20 / 128 = 0.156),
        // not the canvas centre — so sprite.position = sat.position puts the
        // dot right on the satellite and the label trails to the right.
        sprite.center.set(20 / 128, 0.5);
        sprite.renderOrder = 12;
        this._highlightSprite  = sprite;
        this._highlightCanvas  = cv;
        this._highlightTexture = tex;
        this._group.add(sprite);
        this._rebuildHighlightTexture();
    }

    _rebuildHighlightTexture() {
        const cv    = this._highlightCanvas;
        const ctx   = cv.getContext('2d');
        const color = this._highlightOpts.color;
        const label = this._highlightOpts.label;
        const hex   = '#' + color.toString(16).padStart(6, '0');

        ctx.clearRect(0, 0, cv.width, cv.height);
        // Soft halo + solid core so the dot stands out on bright and dark
        // continents alike. Three concentric fills at decreasing radius.
        ctx.fillStyle = hex;
        ctx.globalAlpha = 0.22;
        ctx.beginPath(); ctx.arc(20, 20, 16, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.55;
        ctx.beginPath(); ctx.arc(20, 20, 10, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1.0;
        ctx.beginPath(); ctx.arc(20, 20,  5, 0, Math.PI * 2); ctx.fill();

        // Label — outlined for legibility over any globe colour.
        ctx.font         = 'bold 18px system-ui, sans-serif';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.lineWidth    = 4;
        ctx.strokeStyle  = 'rgba(0, 0, 0, 0.85)';
        ctx.strokeText(label, 38, 22);
        ctx.fillStyle    = hex;
        ctx.fillText(label, 38, 22);

        this._highlightTexture.needsUpdate = true;
    }

    /**
     * Fetch a CelesTrak satellite group and ADD to existing catalog.
     * Supports loading multiple groups without replacing previous data.
     * @param {string} group  CelesTrak group name (e.g. 'stations', 'starlink')
     */
    async loadGroup(group = 'stations') {
        if (this._groups.has(group)) return this._groups.get(group).count;
        const _t0 = performance.now();
        try {
            const res = await fetch(`/api/celestrak/tle?group=${group}`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) {
                const reason = data.error
                    ? `${data.error}${data.detail ? `: ${data.detail}` : ''}`
                    : `HTTP ${res.status}`;
                throw new Error(reason);
            }
            // Telemetry: record the TLE-load latency for the superadmin
            // perf summary. Surfaces as `tle_load_ms` per route. Slow
            // p95 here is a CelesTrak / edge proxy issue, not a client
            // one. Lazy import keeps satellite-tracker free of a
            // hard dep on telemetry.
            try {
                const { telemetry } = await import('./telemetry.js');
                telemetry.recordPerf(`tle_load_${group}`, performance.now() - _t0);
            } catch {}

            const tles = data.satellites ?? [];
            const added = this._addSatellites(tles, group);
            this._groups.set(group, {
                visible: true,
                count: added,
                color: GROUP_COLORS[group] ?? GROUP_COLORS._default,
                error: null,
                composite: data.composite ?? false,
                subgroups: data.subgroups ?? null,
                fetched: data.fetched ?? new Date().toISOString(),
            });

            // Composite groups can succeed-with-partial. Keep that visible.
            const partial = (data.subgroups ?? []).filter(s => s.status === 'error');
            if (partial.length > 0) {
                console.warn(`[SatTracker] ${group}: ${partial.length}/${data.subgroups.length} subgroups failed:`,
                    partial.map(p => `${p.group} (${p.error})`).join(', '));
            }
            console.info(`[SatTracker] +${added} satellites (${group}) — total: ${this._satellites.length}`);

            window.dispatchEvent(new CustomEvent('satellites-loaded', {
                detail: { group, count: added, total: this._satellites.length },
            }));

            return added;
        } catch (err) {
            console.warn(`[SatTracker] Failed to load ${group}:`, err.message);
            // Record the failure so the UI can render a "failed (retry)"
            // state instead of an indeterminate "—". A subsequent
            // loadGroup() call will short-circuit on hasGroup(); callers
            // wanting a retry should remove the group first.
            this._groups.set(group, {
                visible: false,
                count: 0,
                color: GROUP_COLORS[group] ?? GROUP_COLORS._default,
                error: err.message || 'unknown',
                fetched: new Date().toISOString(),
            });
            window.dispatchEvent(new CustomEvent('satellites-load-failed', {
                detail: { group, error: err.message },
            }));
            return 0;
        }
    }

    /**
     * Forget a group entry so a subsequent loadGroup() will refetch.
     * Used by the layer panel's retry-on-failed-load button. Does not
     * remove already-rendered satellites for the group (call
     * unloadGroup() for that).
     */
    forgetGroup(group) {
        if (!this._groups.has(group)) return;
        const entry = this._groups.get(group);
        // Only forget failed entries — a successful load keeps its
        // satellites in _satellites so a forget+reload would dupe them.
        if (entry.error) this._groups.delete(group);
    }

    /**
     * Load a single satellite by NORAD ID.
     * @param {number} noradId  NORAD catalog number
     */
    async loadNorad(noradId) {
        const _t0 = performance.now();
        try {
            const res = await fetch(`/api/celestrak/tle?norad=${noradId}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const sats = data.satellites ?? [];
            this._addSatellites(sats, 'search');
            try {
                const { telemetry } = await import('./telemetry.js');
                telemetry.recordPerf('tle_load_norad', performance.now() - _t0);
            } catch {}
            return sats[0] ?? null;
        } catch (err) {
            console.warn(`[SatTracker] Failed to load NORAD ${noradId}:`, err.message);
            return null;
        }
    }

    /** Toggle visibility of a constellation group. */
    setGroupVisible(group, visible) {
        const g = this._groups.get(group);
        if (!g) return;
        g.visible = visible;
        this._updateColors();
    }

    /** Check if a group is loaded. */
    hasGroup(group) { return this._groups.has(group); }

    /** Get loaded group info. */
    getGroupInfo(group) { return this._groups.get(group) ?? null; }

    /** Get all loaded group names. */
    getLoadedGroups() { return [...this._groups.keys()]; }

    /** Get count per group. */
    getGroupCounts() {
        const out = {};
        for (const [name, g] of this._groups) out[name] = g.count;
        return out;
    }

    /** Get altitude distribution for loaded satellites (for heatmap). */
    getAltitudeDistribution(binSizeKm = 25) {
        const bins = {};
        for (const sat of this._satellites) {
            const alt = (sat.tle.perigee_km + sat.tle.apogee_km) / 2;
            const bin = Math.round(alt / binSizeKm) * binSizeKm;
            bins[bin] = (bins[bin] || 0) + 1;
        }
        return Object.entries(bins)
            .map(([alt, count]) => ({ alt: +alt, count }))
            .sort((a, b) => a.alt - b.alt);
    }

    /** Add satellites to catalog, tagged with their group. Returns count added. */
    _addSatellites(tles, group = '_default') {
        let added = 0;
        const color = GROUP_COLORS[group] ?? GROUP_COLORS._default;
        for (const tle of tles) {
            if (this._satellites.length >= this._maxSats) break;
            // O(1) dedupe via the NORAD→index map; previously an O(N)
            // `find` per TLE, which turned loading a 30 k-row group into
            // an O(N²) start-up.
            if (this._indexByNorad.has(tle.norad_id)) continue;

            const epochJd = tleEpochToJd(tle);
            this._indexByNorad.set(tle.norad_id, this._satellites.length);
            this._satellites.push({ tle, epochJd, group, color, lat: 0, lon: 0, alt: 400 });
            added++;
        }
        if (added > 0) this._rebuildPoints();
        return added;
    }

    /**
     * Pick the nearest currently-visible satellite under an NDC point.
     * Uses Three.js Raycaster against the internal Points mesh, then
     * filters hits whose group is toggled off so only visible dots can
     * be selected. Returns { noradId, distance } or null.
     *
     * @param {{x:number,y:number}} ndc         NDC cursor coords (−1..+1).
     * @param {THREE.Camera} camera             The rendering camera.
     * @param {object} [opts]
     * @param {number} [opts.threshold=0.02]   World-space pick radius.
     */
    pickAtNDC(ndc, camera, { threshold = 0.02 } = {}) {
        if (!this._pointsMesh) return null;
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, camera);
        ray.params.Points = { threshold };
        const hits = ray.intersectObject(this._pointsMesh);
        for (const hit of hits) {
            const sat = this._satellites[hit.index];
            if (!sat) continue;
            const g = this._groups.get(sat.group);
            if (g && !g.visible) continue;   // skip hidden groups
            return { noradId: sat.tle.norad_id, distance: hit.distance };
        }
        return null;
    }

    /**
     * Read the current scene-space Vec3 of a tracked satellite. Returns
     * `out` on success (for chaining) and null when the sat isn't in the
     * catalog or positions haven't been built yet.  Used by the TCA
     * collision-arc renderer; O(1) via `_indexByNorad`.
     */
    getPositionXYZ(noradId, out) {
        const idx = this._indexByNorad.get(noradId);
        if (idx == null || !this._positions) return null;
        const a = this._positions.array;
        const o = out ?? { x: 0, y: 0, z: 0 };
        o.x = a[idx * 3];
        o.y = a[idx * 3 + 1];
        o.z = a[idx * 3 + 2];
        return o;
    }

    /** Rebuild the Points mesh with per-vertex colors. */
    _rebuildPoints() {
        if (this._pointsMesh) {
            this._group.remove(this._pointsMesh);
            this._pointsMesh.geometry.dispose();
        }
        const n = this._satellites.length;
        // SAB fast path: the position attribute is a Float32Array
        // view over the shared SAB the worker is also writing to. As
        // n grows we re-wrap the view; the SAB itself was sized to
        // maxSats at construction so we never reallocate. WebGL's
        // bufferData reads through the typed array view, which works
        // regardless of whether the underlying buffer is an
        // ArrayBuffer or a SharedArrayBuffer.
        const posArr = this._posSab
            ? new Float32Array(this._posSab, 0, n * 3)
            : new Float32Array(n * 3);
        const colArr = new Float32Array(n * 3);

        const overrides = this._colorOverrides;
        for (let i = 0; i < n; i++) {
            const sat   = this._satellites[i];
            const gInfo = this._groups.get(sat.group);
            const visible = gInfo ? gInfo.visible : true;
            // Explicit override (e.g. weather-alert tint) wins over group
            // colour, but still respects group visibility — a hidden group
            // stays hidden even if its sat is flagged.
            const override = overrides?.get(sat.tle.norad_id);
            const c = !visible          ? _hiddenColor
                    : override          ? override
                    :                     sat.color;
            colArr[i * 3]     = c.r;
            colArr[i * 3 + 1] = c.g;
            colArr[i * 3 + 2] = c.b;
        }

        this._positions = new THREE.BufferAttribute(posArr, 3);
        this._colors = new THREE.BufferAttribute(colArr, 3);
        const bufGeo = new THREE.BufferGeometry();
        bufGeo.setAttribute('position', this._positions);
        bufGeo.setAttribute('color', this._colors);
        this._pointsMesh = new THREE.Points(bufGeo, this._dotMat);
        this._pointsMesh.renderOrder = 10;
        this._group.add(this._pointsMesh);
    }

    /** Update only the color buffer (for show/hide toggles + alert tints). */
    _updateColors() {
        if (!this._colors) return;
        const colArr = this._colors.array;
        const overrides = this._colorOverrides;
        for (let i = 0; i < this._satellites.length; i++) {
            const sat = this._satellites[i];
            const gInfo = this._groups.get(sat.group);
            const visible = gInfo ? gInfo.visible : true;
            const override = overrides?.get(sat.tle.norad_id);
            if (visible && override) {
                colArr[i * 3]     = override.r;
                colArr[i * 3 + 1] = override.g;
                colArr[i * 3 + 2] = override.b;
            } else if (visible) {
                colArr[i * 3]     = sat.color.r;
                colArr[i * 3 + 1] = sat.color.g;
                colArr[i * 3 + 2] = sat.color.b;
            } else {
                colArr[i * 3] = colArr[i * 3 + 1] = colArr[i * 3 + 2] = 0;
            }
        }
        this._colors.needsUpdate = true;
    }

    /* ─── Off-thread propagation ────────────────────────────── */

    _spawnWorker() {
        try {
            const url = new URL('./operations/propagation-worker.js', import.meta.url);
            this._worker = new Worker(url, { type: 'module' });
            this._worker.onerror = (ev) => {
                console.warn('[SatTracker] propagation worker errored, falling back:', ev.message);
                this._teardownWorker();
            };
            this._worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
            this._worker.postMessage({ type: 'init' });
            // Initial buffer for the ping-pong. Sized to maxSats so we
            // never need to reallocate even after the catalog grows.
            this._workerBuf = new Float32Array(this._maxSats * 3);
        } catch (err) {
            console.debug('[SatTracker] worker unavailable, staying on main thread:', err.message);
            this._worker        = null;
            this._workerEnabled = false;
        }
    }

    _teardownWorker() {
        if (!this._worker) return;
        try { this._worker.terminate(); } catch (_) {}
        this._worker         = null;
        this._workerEnabled  = false;
        this._workerReady    = false;
        this._workerInFlight = false;
        // _workerBuf is whatever's lying around; main-batch path will
        // allocate its own.
    }

    _onWorkerMessage(msg) {
        if (msg.type === 'ready') {
            if (msg.ok && msg.hasRegistry) {
                this._workerReady = true;
                // If the page is crossOriginIsolated and we got a SAB
                // allocated, hand it over now. The worker will switch
                // to shared-memory mode for ticks.
                if (this._posSab) {
                    this._worker.postMessage({
                        type:    'init-shared',
                        sab:     this._posSab,
                        syncSab: this._syncSab ?? null,
                    });
                }
                // Ship every sat we already know about.
                this._workerSync();
            } else {
                console.debug('[SatTracker] worker WASM init failed:', msg.error || 'no registry');
                this._teardownWorker();
            }
            return;
        }
        if (msg.type === 'shared-ready') {
            if (msg.ok) {
                this._sabReady = true;
            } else {
                console.debug('[SatTracker] worker rejected SAB, falling back to transferable:', msg.error);
                this._posSab   = null;
                this._sabReady = false;
            }
            return;
        }
        if (msg.type === 'add-ack' || msg.type === 'clear-ack') return;
        if (msg.type === 'positions') {
            this._workerInFlight = false;
            this._workerLastFrame = msg.frameId;

            if (msg.mismatch) {
                // Slot count drifted — re-ship everything and skip
                // this frame's upload (positions would be NaN).
                this._workerSyncedTo = 0;
                this._worker.postMessage({ type: 'clear' });
                this._workerSync();
                return;
            }

            if (this._sabReady && msg.buffer == null) {
                // SAB path: positions are already in shared memory
                // (which the THREE position attribute is a view over).
                // Just refresh lat/lon and tell the GPU to re-upload.
                this._refreshFromSab(msg.slots, msg.frameId);
            } else {
                // Transferable path: wrap a view, copy in.
                const buf = new Float32Array(msg.buffer);
                this._workerBuf = buf;
                this._uploadPositionsFromBuffer(buf, msg.slots);
            }
            return;
        }
        if (msg.type === 'error') {
            console.warn('[SatTracker] worker error:', msg.error);
            return;
        }
    }

    /**
     * SAB-mode counterpart to _uploadPositionsFromBuffer. The position
     * attribute already shares memory with the worker, so there's
     * nothing to copy — we just walk the buffer for lat/lon recovery
     * and the highlight sprite, and flag the attribute as dirty so
     * the next render uploads it to the GPU.
     *
     * Atomics fence: read the worker's writing flag with
     * Atomics.load. Pairs with the worker's Atomics.store before its
     * SAB writes, so this load is the synchronization edge that
     * makes those writes visible. If the flag is set we skip the
     * needsUpdate (uploading mid-write would tear positions); the
     * next 'positions' message will retry. We still do lat/lon
     * recovery — the read is still a valid snapshot for tooltip /
     * cohort consumers, just not for GPU upload.
     */
    _refreshFromSab(slotCount, frameId) {
        if (!this._positions || !this._posSab) return;
        const writing = this._syncView
            ? Atomics.load(this._syncView, SYNC_WRITING_SLOT)
            : 0;
        const view = this._positions.array;
        const n = Math.min(slotCount, this._satellites.length);
        const kmToScene = this._earthR / RE_KM;
        let dirty = false;
        for (let i = 0; i < n; i++) {
            const off = i * 3;
            const x = view[off];
            const y = view[off + 1];
            const z = view[off + 2];
            if (x !== x) continue;   // NaN — keep last known position
            dirty = true;

            const sat = this._satellites[i];
            const sx = x / kmToScene;
            const sy = y / kmToScene;
            const sz = z / kmToScene;
            const r  = Math.sqrt(sx * sx + sy * sy + sz * sz);
            if (r > 1e-9) {
                const cy = sy / r;
                sat.lat = Math.asin(cy < -1 ? -1 : cy > 1 ? 1 : cy) * RAD;
                sat.lon = Math.atan2(-sz, sx) * RAD;
                sat.alt = r - RE_KM;
            }
            if (this._highlightNoradId != null
                && sat.tle.norad_id === this._highlightNoradId
                && this._highlightSprite) {
                this._highlightSprite.position.set(x, y, z);
            }
        }
        if (dirty && !writing && Number.isFinite(frameId)) {
            // Safe to upload — worker has finished writes for this
            // frame. Without the fence we'd unconditionally set
            // needsUpdate and risk a torn gl.bufferData on slow GPUs.
            this._positions.needsUpdate = true;
            this._lastUploadedFrame = frameId;
        } else if (dirty && !this._syncView) {
            // No sync SAB available (browser doesn't support it for
            // some reason) — fall back to the previous behaviour:
            // assume the postMessage barrier is enough.
            this._positions.needsUpdate = true;
        }
    }

    /**
     * Send any new sats since the last sync to the worker registry.
     * Chunked so a 30 k-row catalog landing in one shot doesn't park
     * the worker on TLE parsing for ~1 s while tick messages queue
     * behind it. The next tick fires `_workerSync` again, so the
     * remainder lands on subsequent frames — first frames render the
     * already-shipped slots and the new ones come online a frame or
     * two later.
     */
    _workerSync(maxThisCall = 5000) {
        if (!this._worker || !this._workerReady) return;
        const n = this._satellites.length;
        if (n <= this._workerSyncedTo) return;
        const upTo = Math.min(n, this._workerSyncedTo + maxThisCall);
        const tles = [];
        for (let i = this._workerSyncedTo; i < upTo; i++) {
            const t = this._satellites[i].tle;
            tles.push({
                line1: t.line1 || null,
                line2: t.line2 || null,
            });
        }
        this._workerSyncedTo = upTo;
        this._worker.postMessage({ type: 'add-sats', tles });
    }

    /**
     * Copy worker-returned positions into the THREE position attribute
     * and refresh lat/lon/alt for tooltip / cohort consumers. NaN
     * triplets indicate parse-failed or decayed slots; we leave them
     * at their last known position so the dot doesn't snap to origin.
     */
    _uploadPositionsFromBuffer(buf, slotCount) {
        if (!this._positions) return;
        const posArr = this._positions.array;
        const n = Math.min(slotCount, this._satellites.length);
        const kmToScene = this._earthR / RE_KM;

        let dirty = false;
        for (let i = 0; i < n; i++) {
            const off = i * 3;
            const x = buf[off];
            const y = buf[off + 1];
            const z = buf[off + 2];
            if (x !== x) continue;   // NaN — keep last known position

            posArr[off]     = x;
            posArr[off + 1] = y;
            posArr[off + 2] = z;
            dirty = true;

            const sat = this._satellites[i];
            const sx = x / kmToScene;
            const sy = y / kmToScene;
            const sz = z / kmToScene;
            const r  = Math.sqrt(sx * sx + sy * sy + sz * sz);
            if (r > 1e-9) {
                const cy = sy / r;
                sat.lat = Math.asin(cy < -1 ? -1 : cy > 1 ? 1 : cy) * RAD;
                sat.lon = Math.atan2(-sz, sx) * RAD;
                sat.alt = r - RE_KM;
            }

            if (this._highlightNoradId != null
                && sat.tle.norad_id === this._highlightNoradId
                && this._highlightSprite) {
                this._highlightSprite.position.set(x, y, z);
            }
        }
        if (dirty) this._positions.needsUpdate = true;
    }

    /**
     * Lazy-register any not-yet-batched sats with the WASM registry.
     * Idempotent — safe to call every frame; usually a no-op once
     * the load has settled. Slot indices line up with `_satellites[i]`,
     * so a JS→WASM mismatch (parse failure, decay) reserves a blank
     * slot to keep the alignment stable.
     */
    _syncRegistry() {
        if (!_wasmSgp4 || !_wasmSgp4.registry_propagate) return false;
        this._batchAvailable = true;

        const n = this._satellites.length;
        for (let i = this._batchSyncedTo; i < n; i++) {
            const sat = this._satellites[i];
            let registered = false;
            if (sat.tle.line1 && sat.tle.line2) {
                try {
                    _wasmSgp4.registry_add(sat.tle.line1, sat.tle.line2);
                    sat._batchOk = true;
                    registered = true;
                } catch (_) {
                    // Parse / init failed — fall through to blank slot.
                }
            }
            if (!registered) {
                _wasmSgp4.registry_reserve_blank();
                sat._batchOk = false;
            }
        }
        this._batchSyncedTo = n;
        return true;
    }

    /** Update satellite positions to current time. Call every frame. */
    tick(nowMs = Date.now()) {
        if (!this._positions || this._satellites.length === 0) return;

        const jd      = nowMs / 86400000 + 2440587.5;
        const gmstRad = geo.greenwichSiderealTimeFromJD(jd);
        const kmToScene = this._earthR / RE_KM;
        const posArr  = this._positions.array;

        // Worker path (preferred). The worker has its own WASM
        // registry; the main thread keeps it in sync via add-sats
        // messages. Two transports converge here:
        //
        //   - SAB    : tick is a tiny header message; the worker
        //              writes positions straight into the shared
        //              memory the THREE position attribute is a view
        //              over.
        //   - Xfer   : a Float32Array's buffer ping-pongs across
        //              postMessage transfer.
        //
        // Either way we hold at most one outstanding tick — if the
        // worker hasn't acked yet, this frame skips and positions
        // stay one frame stale (invisible at 60 fps).
        if (this._workerReady && this._workerEnabled) {
            this._workerSync();
            if (this._workerInFlight) return;

            // Defer the postMessage to a microtask so it runs AFTER
            // this frame's renderer.render() call (which is queued
            // later in the same animation-frame task). That ordering
            // guarantees the worker's next SAB write begins only
            // after gl.bufferData has finished reading the current
            // frame's positions — race-free GPU upload even on slow
            // mobile GPUs where rendering can take >5 ms. The
            // Atomics fence in _refreshFromSab is a belt-and-braces
            // safety net for any future rendering path that bypasses
            // this ordering.
            if (this._sabReady) {
                this._workerInFlight = true;
                const frameId        = ++this._workerFrameId;
                queueMicrotask(() => {
                    this._worker?.postMessage({
                        type:           'tick',
                        jd, gmst:        gmstRad,
                        scale:           kmToScene,
                        frameId,
                        expectedSlots:   this._workerSyncedTo,
                    });
                });
                return;
            }
            if (this._workerBuf) {
                const buf = this._workerBuf;
                this._workerBuf       = null;
                this._workerInFlight  = true;
                const frameId         = ++this._workerFrameId;
                queueMicrotask(() => {
                    this._worker?.postMessage(
                        {
                            type:           'tick',
                            jd, gmst:        gmstRad,
                            scale:           kmToScene,
                            buffer:          buf.buffer,
                            frameId,
                            expectedSlots:   this._workerSyncedTo,
                        },
                        [buf.buffer],
                    );
                });
            }
            return;
        }

        const useBatch = this._syncRegistry();

        if (useBatch) {
            // One WASM call propagates every sat AND folds in the
            // TEME → scene-frame transform (matches geo.eciToEcef +
            // the Y=north scene flip). Returns NaN per slot for
            // un-batched / decayed sats — those drop to the JS
            // fallback below. Note we re-receive the buffer each
            // frame because wasm-bindgen passes &mut [f32] as
            // input-only; a returned Vec<f32> is the path that
            // actually carries data back to JS.
            const out = _wasmSgp4.registry_propagate(jd, gmstRad, kmToScene);
            this._batchOut = out;

            const n = this._satellites.length;
            for (let i = 0; i < n; i++) {
                const off = i * 3;
                const sat = this._satellites[i];

                let x = out[off];
                let y = out[off + 1];
                let z = out[off + 2];

                if (sat._batchOk === false || x !== x /* NaN */) {
                    // Per-sat fallback: parse-failed slots and decayed
                    // sats land here. propagate() will pick its own
                    // best path (WASM single-call → JS Kepler).
                    const tsince = (jd - sat.epochJd) * MIN_PER_DAY;
                    const teme = propagate(sat.tle, tsince);
                    _temeScratch.set(teme.x, teme.y, teme.z);
                    geo.eciToEcef(_temeScratch, gmstRad, _sceneScratch);
                    x = _sceneScratch.x * kmToScene;
                    y = _sceneScratch.y * kmToScene;
                    z = _sceneScratch.z * kmToScene;
                }

                posArr[off]     = x;
                posArr[off + 1] = y;
                posArr[off + 2] = z;

                // Lat/lon/alt — keep the legacy fields in sync. Use
                // the (already-computed) scene-frame coords directly
                // instead of round-tripping through positionToLatLon
                // so we save a Vector3 + a few extra trig calls per
                // sat. positionToLatLon's mapping is:
                //   lat = asin(y/r); lon = atan2(-z, x); r in km.
                const sx = x / kmToScene;
                const sy = y / kmToScene;
                const sz = z / kmToScene;
                const r  = Math.sqrt(sx * sx + sy * sy + sz * sz);
                if (r > 1e-9) {
                    const cy = sy / r;
                    sat.lat = Math.asin(cy < -1 ? -1 : cy > 1 ? 1 : cy) * RAD;
                    sat.lon = Math.atan2(-sz, sx) * RAD;
                    sat.alt = r - RE_KM;
                }

                if (this._highlightNoradId != null
                    && sat.tle.norad_id === this._highlightNoradId
                    && this._highlightSprite) {
                    this._highlightSprite.position.set(x, y, z);
                }
            }
        } else {
            // No registry API (older WASM build, or WASM not loaded
            // yet). Original per-sat path; same numerics.
            for (let i = 0; i < this._satellites.length; i++) {
                const sat    = this._satellites[i];
                const tsince = (jd - sat.epochJd) * MIN_PER_DAY;

                const teme = propagate(sat.tle, tsince);
                _temeScratch.set(teme.x, teme.y, teme.z);

                geo.eciToEcef(_temeScratch, gmstRad, _sceneScratch);

                const x = _sceneScratch.x * kmToScene;
                const y = _sceneScratch.y * kmToScene;
                const z = _sceneScratch.z * kmToScene;
                posArr[i * 3]     = x;
                posArr[i * 3 + 1] = y;
                posArr[i * 3 + 2] = z;

                const ll = geo.positionToLatLon(_sceneScratch);
                sat.lat = ll.lat * RAD;
                sat.lon = ll.lon * RAD;
                sat.alt = ll.radiusUnits - RE_KM;

                if (this._highlightNoradId != null
                    && sat.tle.norad_id === this._highlightNoradId
                    && this._highlightSprite) {
                    this._highlightSprite.position.set(x, y, z);
                }
            }
        }

        this._positions.needsUpdate = true;
    }

    /** Get all satellite positions + info. */
    getSatellites() {
        return this._satellites.map(s => ({
            name: s.tle.name,
            norad_id: s.tle.norad_id,
            group: s.group,
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
            group: s.group,
            lat: s.lat, lon: s.lon, alt: s.alt,
            period_min: s.tle.period_min, inclination: s.tle.inclination,
            tle: s.tle,
        };
    }

    /** Set visibility. */
    setVisible(v) { this._group.visible = v; }

    // ── Starlink shell visualization ────────────────────────────────────────

    /**
     * Build translucent orbital shell rings for Starlink's operating altitudes.
     * Each shell is a tilted ring at the constellation's inclination.
     */
    buildStarlinkShells(visible = true) {
        // Clear previous shells
        while (this._shellGroup.children.length) {
            const c = this._shellGroup.children[0];
            c.geometry?.dispose();
            c.material?.dispose();
            this._shellGroup.remove(c);
        }

        // Starlink orbital shells (altitude km, inclination deg, label)
        const shells = [
            { alt: 550, inc: 53.0,  label: 'Gen1 Shell 1',  color: 0x4466ff, count: '~1584' },
            { alt: 540, inc: 53.2,  label: 'Gen1 Shell 2',  color: 0x5577ff, count: '~1584' },
            { alt: 570, inc: 70.0,  label: 'Gen1 Polar',    color: 0x6688ff, count: '~720' },
            { alt: 560, inc: 97.6,  label: 'Gen1 SSO',      color: 0x88aaff, count: '~348' },
            { alt: 525, inc: 53.0,  label: 'Gen2 V-band',   color: 0x3355dd, count: '~7178' },
            { alt: 530, inc: 43.0,  label: 'Gen2 Mid-Inc',  color: 0x4466dd, count: '~2000' },
        ];

        for (const sh of shells) {
            const r = this._earthR * (1 + sh.alt / RE_KM);
            const ring = new THREE.Mesh(
                new THREE.RingGeometry(r - 0.003, r + 0.003, 128),
                new THREE.MeshBasicMaterial({
                    color: sh.color, side: THREE.DoubleSide,
                    transparent: true, opacity: 0.25, depthWrite: false,
                    blending: THREE.AdditiveBlending,
                })
            );
            ring.rotation.x = (90 - sh.inc) * DEG2RAD;
            ring.userData = { ...sh };
            this._shellGroup.add(ring);
        }

        this._shellGroup.visible = visible;
    }

    /** Toggle shell visibility. */
    setShellsVisible(v) { this._shellGroup.visible = v; }

    /** Get shell group for external access. */
    getShellGroup() { return this._shellGroup; }

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
            const tsince  = tsinceBase + (i / steps) * periodMin;
            const teme    = propagate(sat.tle, tsince);
            const jdStep  = jd + (i / steps) * periodMin / MIN_PER_DAY;
            const gmstRad = geo.greenwichSiderealTimeFromJD(jdStep);

            _temeScratch.set(teme.x, teme.y, teme.z);
            geo.eciToEcef(_temeScratch, gmstRad, _sceneScratch);

            const ll = geo.positionToLatLon(_sceneScratch);
            track.push({
                lat: ll.lat * RAD,
                lon: ll.lon * RAD,
                alt: ll.radiusUnits - RE_KM,
            });
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
            points.push(geo.latLonToPosition(pt.lat * DEG, pt.lon * DEG, r));
        }

        const bufGeo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color: 0xffcc00, transparent: true, opacity: 0.5, depthWrite: false,
        });
        return new THREE.Line(bufGeo, mat);
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
            points.push(geo.latLonToPosition(pt.lat * DEG, pt.lon * DEG, r));
        }

        const bufGeo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color: 0x00ffcc, transparent: true, opacity: 0.35, depthWrite: false,
        });
        return new THREE.Line(bufGeo, mat);
    }

    /**
     * Conjunction screening: find close approaches between a target satellite
     * and all loaded catalog objects over the next N hours.
     *
     * Anchors at `opts.epochMs` (defaults to wall-clock now) so callers
     * can screen relative to a scrubbed sim time. After the coarse
     * SGP4 sweep, each candidate's closest sample is refined with a
     * parabolic fit through dist²(i-1, i, i+1) — sub-step TCA + miss.
     * When `opts.withDv` is set, finite-differences relative velocity
     * at the refined TCA and reports |Δv| (km/s) plus the unit miss
     * vector (useful for a real B-plane).
     *
     * @param {number} targetNoradId    NORAD ID of the target satellite
     * @param {number} [hoursAhead=72]  Look-ahead window
     * @param {number} [stepMin=10]     Time step in minutes
     * @param {number} [thresholdKm=25] Distance threshold
     * @param {string|string[]|null} [groupFilter=null]
     *        Restrict secondaries to one group, an array of groups, or
     *        null (every loaded sat except the primary). Saves
     *        thousands of propagate() calls per run when the caller
     *        only cares about one constellation kind.
     * @param {object}  [opts]
     * @param {number}  [opts.epochMs]   Anchor in ms since epoch.
     * @param {boolean} [opts.refine=true]   Parabolic refine.
     * @param {boolean} [opts.withDv=true]   Include |Δv| + miss unit.
     * @returns {Array<{ name, norad_id, group, dist_km, tca_jd,
     *                   tca_ms, hours_ahead, dv_kms, miss_unit }>}
     */
    async screenConjunctions(targetNoradId, hoursAhead = 72, stepMin = 10, thresholdKm = 25, groupFilter = null, opts = {}) {
        const target = this._satellites.find(s => s.tle.norad_id === targetNoradId);
        if (!target) return [];

        const epochMs   = Number.isFinite(opts.epochMs) ? opts.epochMs : Date.now();
        const refine    = opts.refine    !== false;
        const withDv    = opts.withDv    !== false;
        const withSpark = opts.withSpark !== false;
        const SPARK_HALF_WINDOW = 5;   // ±5 samples around TCA coarse

        const matchesGroup = (g) => {
            if (groupFilter == null) return true;
            if (Array.isArray(groupFilter)) return groupFilter.includes(g);
            return g === groupFilter;
        };

        const nSteps = Math.ceil(hoursAhead * 60 / stepMin);
        const jd = epochMs / 86400000 + 2440587.5;
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

        // Pre-filter widens with the horizon: a debris piece in an
        // eccentric orbit can drift through the asset's altitude shell
        // over a 14-day window, so the bound has to grow with time.
        // ~50 km/d worst-case altitude drift in high-drag LEO; cap so
        // the filter still does work at long horizons.
        const targetAltAvg = (target.tle.perigee_km + target.tle.apogee_km) / 2;
        const altMargin    = Math.min(50 * (hoursAhead / 24) + 200, 1500);

        // Screen all catalog objects
        const conjunctions = [];

        for (const cat of this._satellites) {
            if (cat.tle.norad_id === targetNoradId) continue;
            if (!matchesGroup(cat.group)) continue;

            // Pre-filter on apogee/perigee overlap with the target's
            // shell ± altMargin. Tighter than a "mean-altitude within
            // 200 km" check while still horizon-aware.
            const catPerigee = cat.tle.perigee_km;
            const catApogee  = cat.tle.apogee_km;
            if (catApogee  + altMargin < targetAltAvg - 200) continue;
            if (catPerigee - altMargin > targetAltAvg + 200) continue;

            // Propagate catalog object at each step.
            const catTsinceBase = (jd - cat.epochJd) * MIN_PER_DAY;

            // Track the closest sample over the *full* window. The
            // previous version broke on the first sample under the
            // threshold, which is the wrong number — closest-approach
            // is deeper than the first dip into the threshold.
            let bestI  = -1;
            let bestD2 = Infinity;
            const catPos = new Array(nSteps);
            // Sample-distance buffer (km) — kept so we can crop a
            // window around bestI for the sparkline without
            // re-propagating.
            const dists = new Float32Array(nSteps);

            for (let i = 0; i < nSteps; i++) {
                const tgt = targetPositions[i];
                if (!isFinite(tgt.x)) { dists[i] = NaN; continue; }

                const cp = propagate(cat.tle, catTsinceBase + i * stepMin);
                catPos[i] = cp;
                if (!isFinite(cp.x)) { dists[i] = NaN; continue; }

                const dx = tgt.x - cp.x;
                const dy = tgt.y - cp.y;
                const dz = tgt.z - cp.z;
                const d2 = dx * dx + dy * dy + dz * dz;
                dists[i] = Math.sqrt(d2);

                if (d2 < bestD2) { bestD2 = d2; bestI = i; }
            }

            if (bestI < 0) continue;

            let missKm    = Math.sqrt(bestD2);
            let tcaOffMin = bestI * stepMin;

            // Parabolic refine through dist²(i-1, i, i+1). Sub-step
            // TCA + miss without extra propagate calls — we already
            // have the neighbours from the sweep. Skip at the window
            // boundary; there's no reliable "outside" sample.
            if (refine && bestI > 0 && bestI < nSteps - 1) {
                const tgtL = targetPositions[bestI - 1];
                const tgtR = targetPositions[bestI + 1];
                const cpL  = catPos[bestI - 1];
                const cpR  = catPos[bestI + 1];
                if (isFinite(tgtL?.x) && isFinite(tgtR?.x) && isFinite(cpL?.x) && isFinite(cpR?.x)) {
                    const dL = (tgtL.x - cpL.x) ** 2 + (tgtL.y - cpL.y) ** 2 + (tgtL.z - cpL.z) ** 2;
                    const dC = bestD2;
                    const dR = (tgtR.x - cpR.x) ** 2 + (tgtR.y - cpR.y) ** 2 + (tgtR.z - cpR.z) ** 2;
                    const denom = dL - 2 * dC + dR;
                    if (Math.abs(denom) > 1e-9) {
                        const delta = 0.5 * (dL - dR) / denom;
                        if (delta > -1 && delta < 1) {
                            tcaOffMin = (bestI + delta) * stepMin;
                            const d2Min = dC - 0.25 * (dL - dR) * delta;
                            if (d2Min > 0 && isFinite(d2Min)) missKm = Math.sqrt(d2Min);
                        }
                    }
                }
            }

            if (missKm > thresholdKm) continue;

            // |Δv| at TCA via central-difference (10 s either side) on
            // both objects, then the magnitude of the relative-velocity
            // vector. Cheap (4 propagates) and gives the encounter
            // energy proxy callers want.
            let dvKms    = null;
            let missUnit = null;
            let vRel     = null;
            let missVec  = null;
            if (withDv) {
                const tcaT  = tsinceBase + tcaOffMin;
                const halfH = 10 / 60;
                const pA = propagate(target.tle, tcaT - halfH);
                const pB = propagate(target.tle, tcaT + halfH);
                const sA = propagate(cat.tle,    catTsinceBase + tcaOffMin - halfH);
                const sB = propagate(cat.tle,    catTsinceBase + tcaOffMin + halfH);
                if (isFinite(pA.x) && isFinite(pB.x) && isFinite(sA.x) && isFinite(sB.x)) {
                    const dt = 20; // seconds of central-diff span
                    const vRelX = ((pB.x - pA.x) - (sB.x - sA.x)) / dt;
                    const vRelY = ((pB.y - pA.y) - (sB.y - sA.y)) / dt;
                    const vRelZ = ((pB.z - pA.z) - (sB.z - sA.z)) / dt;
                    dvKms = Math.sqrt(vRelX * vRelX + vRelY * vRelY + vRelZ * vRelZ);
                    vRel  = { x: vRelX, y: vRelY, z: vRelZ };

                    const tcaP = propagate(target.tle, tcaT);
                    const tcaS = propagate(cat.tle,    catTsinceBase + tcaOffMin);
                    if (isFinite(tcaP.x) && isFinite(tcaS.x)) {
                        const mx = tcaP.x - tcaS.x;
                        const my = tcaP.y - tcaS.y;
                        const mz = tcaP.z - tcaS.z;
                        const m  = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
                        missVec  = { x: mx, y: my, z: mz };
                        missUnit = { x: mx / m, y: my / m, z: mz / m };
                    }
                }
            }

            // Sparkline window: ±SPARK_HALF_WINDOW samples around
            // bestI, clipped to [0, nSteps-1]. NaNs survive so the
            // renderer's time axis stays consistent.
            let spark = null;
            if (withSpark) {
                const lo  = Math.max(0, bestI - SPARK_HALF_WINDOW);
                const hi  = Math.min(nSteps - 1, bestI + SPARK_HALF_WINDOW);
                const km  = new Array(hi - lo + 1);
                for (let i = lo; i <= hi; i++) km[i - lo] = dists[i];
                spark = {
                    km,
                    step_min:     stepMin,
                    center_index: bestI - lo,
                };
            }

            const tcaMs = epochMs + tcaOffMin * 60 * 1000;

            conjunctions.push({
                name:        cat.tle.name,
                norad_id:    cat.tle.norad_id,
                group:       cat.group,
                dist_km:     Math.round(missKm * 100) / 100,
                hours_ahead: Math.round(tcaOffMin / 60 * 100) / 100,
                tca_jd:      jd + tcaOffMin / MIN_PER_DAY,
                tca_ms:      tcaMs,
                dv_kms:      dvKms != null ? Math.round(dvKms * 1000) / 1000 : null,
                v_rel:       vRel,
                miss_unit:   missUnit,
                miss_vec:    missVec,
                spark,
            });
        }

        conjunctions.sort((a, b) => a.dist_km - b.dist_km);
        return conjunctions;
    }

}

// ── Helpers (module-level) ──────────────────────────────────────────────────

const _hiddenColor = new THREE.Color(0x000000);

/** Convert a TLE's (epoch_yr, epoch_day) fractional-year field into a JD.
 *  Exported for modules that want to propagate independently of the
 *  tracker but using the same epoch arithmetic. */
export function tleEpochToJd(tle) {
    const epochYr = tle.epoch_yr ?? 2026;
    const yr = Math.floor(epochYr);
    const dayFrac = (epochYr - yr) * (yr % 4 === 0 ? 366 : 365);
    const jdJan1 = 367 * yr - Math.floor(7 * (yr + Math.floor(10 / 12)) / 4) + Math.floor(275 / 9) + 1721013.5;
    return jdJan1 + dayFrac;
}
