/**
 * focus-footprint.js — camera ground-footprint tracker
 *
 * The shared primitive behind every "nested focus window" feature on the
 * Earth page: the high-res weather patch (js/weather-patch.js) today, the
 * GIBS imagery detail inset (Phase 2 of the zoom-LOD plan) next. One
 * module computes "what patch of ground is the camera looking at" and
 * rate-limits change notifications; consumers subscribe and decide for
 * themselves what to fetch.
 *
 * Geometry
 * ────────
 * The camera orbits the origin (OrbitControls, target = Earth centre) and
 * earthMesh may rotate (GMST when the SW-panel "planet rotation" toggle is
 * on), so the sub-camera point must be derived in earthMesh-LOCAL space —
 * same convention as WindParticles._setFocusFromCamera in earth.html.
 *
 * Footprint half-angle on the sphere (radians), camera at distance d from
 * the centre of a sphere of radius R:
 *
 *   horizon  = acos(R / d)                — can never see past the limb
 *   frustum  ≈ (d − R) · tan(fov / 2) / R — ground arc the viewport spans
 *                                            (flat-ground approximation,
 *                                             accurate at the zooms where
 *                                             a focus window matters)
 *   half     = min(horizon, frustum) · MARGIN
 *
 * The MARGIN (1.25) overscans past the viewport edge so a small pan
 * doesn't immediately invalidate the patch.
 *
 * Events
 * ──────
 * Dispatches 'focus-footprint-change' on document when the footprint has
 * moved materially (centre by > moveFrac of the span, or span by > 25 %),
 * throttled to one event per minIntervalMs. Detail:
 *
 *   {
 *     centerLat, centerLon,     — degrees, earth-local
 *     spanLatDeg, spanLonDeg,   — full footprint extent in degrees
 *     latMin, latMax,           — clamped to ±90
 *     lonMin,                   — west edge in [-180, 180); the footprint
 *                                  may cross the antimeridian, so consumers
 *                                  should work in (lonMin + offset) space
 *                                  rather than assuming lonMin < lonMax
 *     distance,                 — camera distance in Earth radii
 *   }
 *
 * Consumers that miss the event (constructed later) can pull the current
 * state via getFootprint().
 */

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// Overscan beyond the visible frustum so small pans stay inside the patch.
const SPAN_MARGIN = 1.25;

export class FocusFootprint {
    /**
     * @param {object} opts
     * @param {THREE.PerspectiveCamera} opts.camera
     * @param {THREE.Object3D} opts.earthObject  — the (possibly rotating) globe mesh
     * @param {number} [opts.radius=1]           — sphere radius in scene units
     * @param {number} [opts.minIntervalMs=1500] — event throttle
     * @param {number} [opts.moveFrac=0.20]      — centre drift (fraction of span)
     *                                             that counts as "moved"
     */
    constructor({ camera, earthObject, radius = 1, minIntervalMs = 1500, moveFrac = 0.20 } = {}) {
        if (!camera)      throw new Error('FocusFootprint: camera is required');
        if (!earthObject) throw new Error('FocusFootprint: earthObject is required');
        this._camera = camera;
        this._earth  = earthObject;
        this._radius = radius;
        this._minIntervalMs = minIntervalMs;
        this._moveFrac      = moveFrac;

        this._current     = null;   // last computed footprint (every tick)
        this._published   = null;   // last footprint we dispatched for
        this._lastEventAt = 0;
        // Scratch — worldToLocal mutates in place; one allocation total.
        this._v = null;
    }

    /** Latest computed footprint (null until the first tick). */
    getFootprint() { return this._current; }

    /**
     * Per-frame entry point — call from the same animate() loop that drives
     * the renderer. Cheap: one worldToLocal + a handful of trig ops; the
     * event dispatch is throttled internally.
     */
    tick(nowMs = Date.now()) {
        const fp = this._compute();
        if (!fp) return;
        this._current = fp;

        if (nowMs - this._lastEventAt < this._minIntervalMs) return;
        if (!this._movedMaterially(fp)) return;

        this._published   = fp;
        this._lastEventAt = nowMs;
        document.dispatchEvent(new CustomEvent('focus-footprint-change', { detail: fp }));
    }

    /** Force the next tick to re-publish even if the camera hasn't moved. */
    invalidate() { this._published = null; }

    // ── Internal ────────────────────────────────────────────────────────────

    _compute() {
        const cam = this._camera;
        // Lazy THREE.Vector3 clone — avoids importing three here (the camera
        // hands us a compatible vector to clone from).
        if (!this._v) this._v = cam.position.clone();
        this._v.copy(cam.position);
        this._earth.worldToLocal(this._v);

        const r = this._v.length();
        const R = this._radius;
        if (!(r > R * 1.0005)) return null;   // inside / on the sphere — undefined view

        // Sub-camera point, earth-local. Inverse of the canonical
        // (cosφ·cosλ, sinφ, −cosφ·sinλ) mapping (js/geo/coords.js).
        const centerLat = Math.asin(Math.max(-1, Math.min(1, this._v.y / r))) * RAD2DEG;
        const centerLon = Math.atan2(-this._v.z, this._v.x) * RAD2DEG;

        const fovRad  = (cam.fov ?? 40) * DEG2RAD;
        const horizon = Math.acos(Math.min(1, R / r));
        const frustum = (r - R) * Math.tan(fovRad / 2) / R;
        const halfLat = Math.min(horizon, frustum) * SPAN_MARGIN;

        const spanLatDeg = Math.min(180, 2 * halfLat * RAD2DEG);
        // Longitude span covers the same ground distance east-west, widened
        // by the viewport aspect and the cos(lat) metric. Capped well below
        // 360 so the patch never tries to wrap into itself.
        const aspect  = Math.max(1, cam.aspect || 1);
        const cosLat  = Math.max(0.20, Math.cos(centerLat * DEG2RAD));
        const spanLonDeg = Math.min(160, spanLatDeg * aspect / cosLat);

        const latMin = Math.max(-90, centerLat - spanLatDeg / 2);
        const latMax = Math.min(90, centerLat + spanLatDeg / 2);
        let lonMin = centerLon - spanLonDeg / 2;
        lonMin = ((lonMin + 540) % 360) - 180;   // normalise to [-180, 180)

        return {
            centerLat, centerLon,
            spanLatDeg, spanLonDeg,
            latMin, latMax, lonMin,
            distance: r / R,
        };
    }

    _movedMaterially(fp) {
        const prev = this._published;
        if (!prev) return true;

        const spanRatio = fp.spanLatDeg / Math.max(1e-6, prev.spanLatDeg);
        if (spanRatio > 1.25 || spanRatio < 0.80) return true;

        const tol = Math.max(0.5, prev.spanLatDeg * this._moveFrac);
        const dLat = Math.abs(fp.centerLat - prev.centerLat);
        let dLon = Math.abs(fp.centerLon - prev.centerLon);
        if (dLon > 180) dLon = 360 - dLon;
        // Compare ground distance: scale longitude by cos(lat).
        const cosLat = Math.max(0.20, Math.cos(fp.centerLat * DEG2RAD));
        return dLat > tol || dLon * cosLat > tol;
    }
}

export default FocusFootprint;
