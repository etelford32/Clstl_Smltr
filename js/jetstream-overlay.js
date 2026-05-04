/**
 * jetstream-overlay.js — "Where's the jet stream today?" overlay
 * ═══════════════════════════════════════════════════════════════════════════
 * Scans the in-memory wind field on a sparse lat/lon grid and, wherever the
 * interpolated wind speed crosses the operational jet-stream threshold
 * (30 m/s ≈ 108 km/h), draws a short flow-aligned line segment.
 *
 * Rendered on top of the per-particle streamlines so the broad-brush flow
 * stays readable while the jet itself reads as a continuous, brighter
 * ribbon over the polar front.
 *
 * Lookup is delegated — this module takes a callback
 *   lookupWind(lat, lon) → { uMs, vMs, speedMs, dirFromDeg } | null
 * so it stays decoupled from any particular WeatherFeed / WindParticles
 * implementation. The current caller hands it the public
 * WindParticles.lookupWind() wrapper added in the cursor-probe commit.
 *
 * update() is not per-frame: it's called from the weather-update handler
 * because the field only changes when new data lands (~15 min cadence).
 */

import * as THREE from 'three';
import { geo, DEG } from './geo/coords.js';

// Threshold used to decide which grid cells get a ribbon segment. The
// upstream weather feed only delivers 10 m surface winds (Open-Meteo
// `wind_speed_10m`), which globally rarely exceed ~25 m/s outside named
// storms. The 30 m/s "operational jet-stream floor" is a free-troposphere
// threshold (250–300 hPa) — applying it to surface wind meant the layer
// was nearly always empty, so the visitor toggling it on saw nothing and
// reported it as broken.
//
// Lowering to 18 m/s (≈65 km/h, low end of gale-force) keeps the layer
// faithful to "where strong directional winds are" while reliably
// producing visible ribbons over winter storms, mid-latitude cyclones,
// trade-wind belts, and Southern Ocean fronts. When the feed is upgraded
// to upper-air winds (250 hPa), bump this back to 30 m/s.
const JET_THRESHOLD_MS = 18;        // m/s — strong-wind floor for 10 m data
const SAMPLE_STEP_DEG  = 3;         // scan resolution (balance density vs cost)
const SEG_LEN_DEG      = 4;         // segment length in flow direction
const MAX_LAT          = 85;        // skip poles — 1/cos(lat) blows up

export class JetstreamOverlay {
    /**
     * @param {THREE.Object3D} parent     Typically earthMesh so the ribbons
     *                                    ride with the globe's rotation.
     * @param {(lat:number, lon:number) => {uMs:number, vMs:number,
     *         speedMs:number} | null} lookupWind
     * @param {object} [opts]
     * @param {number} [opts.radius=1.005]  Scene-unit radius to sit on.
     */
    constructor(parent, lookupWind, { radius = 1.005 } = {}) {
        this._lookup = lookupWind;
        this._radius = radius;
        this._peak   = null;

        this._group  = new THREE.Group();
        this._group.name = 'jetstreamOverlay';
        parent.add(this._group);

        this._mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent:  true,
            opacity:      0.85,
            blending:     THREE.AdditiveBlending,
            depthWrite:   false,
        });
        this._mesh = null;
    }

    /** Peak jet-stream sample this update() found, or null if none.
     *  Shape: { lat, lon, speedMs }.  Useful for a wx-panel readout. */
    get peak() { return this._peak; }

    setVisible(v) { this._group.visible = !!v; }

    /**
     * Rebuild geometry from the current wind field. Not a per-frame call —
     * fire from the 'weather-update' event handler so it runs once per
     * feed refresh (~15 min) rather than once per animation frame.
     */
    update() {
        const positions = [];
        const colors    = [];
        let peak = null;

        for (let lat = -MAX_LAT; lat <= MAX_LAT; lat += SAMPLE_STEP_DEG) {
            const cosLat = Math.max(0.1, Math.cos(lat * DEG));
            for (let lon = -180; lon < 180; lon += SAMPLE_STEP_DEG) {
                const w = this._lookup(lat, lon);
                if (!w || w.speedMs < JET_THRESHOLD_MS) continue;

                if (!peak || w.speedMs > peak.speedMs) {
                    peak = { lat, lon, speedMs: w.speedMs };
                }

                // Unit flow vector, scaled to segment length. Longitudinal
                // component is divided by cos(lat) so the visual length
                // stays constant at higher latitudes (where 1° of lon
                // covers less ground).
                const inv = 1 / w.speedMs;
                const halfLat = w.vMs * inv * SEG_LEN_DEG * 0.5;
                const halfLon = w.uMs * inv * SEG_LEN_DEG * 0.5 / cosLat;

                const a = geo.deg.latLonToPosition(lat - halfLat, lon - halfLon, this._radius);
                const b = geo.deg.latLonToPosition(lat + halfLat, lon + halfLon, this._radius);

                positions.push(a.x, a.y, a.z, b.x, b.y, b.z);

                // Pale cyan at threshold → bright cyan-white at ~80 m/s.
                // Hold blue channel at full so the fastest segments read
                // white-blue against any continent colour below.
                const t = Math.min(1, (w.speedMs - JET_THRESHOLD_MS) / 50);
                const r = 0.5 + 0.5 * t;
                const g = 0.8 + 0.2 * t;
                const bC = 1.0;
                colors.push(r, g, bC, r, g, bC);
            }
        }

        this._peak = peak;

        // Dispose previous mesh before replacing — LineSegments allocate
        // their own BufferGeometry so we don't leak.
        if (this._mesh) {
            this._group.remove(this._mesh);
            this._mesh.geometry.dispose();
            this._mesh = null;
        }
        if (positions.length === 0) return;   // calm world — no ribbon

        const bufGeo = new THREE.BufferGeometry();
        bufGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        bufGeo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
        this._mesh = new THREE.LineSegments(bufGeo, this._mat);
        this._mesh.renderOrder = 7;           // above wind particles, below clouds
        this._group.add(this._mesh);
    }
}
