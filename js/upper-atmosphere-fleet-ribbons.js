/**
 * upper-atmosphere-fleet-ribbons.js — In-scene orbit ribbons for top assets
 * ═══════════════════════════════════════════════════════════════════════════
 * Renders up to RIBBON_CAP orbit polylines in the AtmosphereGlobe scene,
 * one per highest-severity tracked asset. Severity is computed by the
 * fleet analyzer (REENTRY > DECAY > DRAG > BASE) and drives the ribbon
 * colour (red → amber → green).
 *
 *   • Ribbon vertices: SGP4 trajectory at 5-min stride over a 90-min
 *     window centred on "now". Long enough to show one orbit, short
 *     enough not to swamp the view with overlapping spaghetti.
 *   • Coordinate frame: scene units = R_EARTH. ECI is rotated into the
 *     scene's earth-fixed frame so ribbons sit "above" the same point on
 *     the rotating globe (otherwise they'd appear to drift relative to
 *     the day-side terminator).
 *   • Mounted as a single LineSegments mesh shared across all ribbons —
 *     each ribbon contributes its own segment range. Same buffer-rebuild
 *     pattern as the drag-forecast overlay so we can update geometry
 *     in-place without re-uploading the whole VAO each tick.
 *
 * Public API:
 *
 *   const ribbons = new FleetRibbons(scene);
 *   ribbons.setRibbons(top3Results);   // array of analyzer results
 *   ribbons.update(t);                 // optional per-frame drift
 *   ribbons.dispose();
 */

import * as THREE from 'three';
import { SGP4_COL } from './upper-atmosphere-trajectory-analysis.js';

const R_EARTH_KM = 6371;
const RIBBON_CAP = 3;
const SAMPLES_PER_RIBBON = 36;   // 5-min stride × 36 = 3-hr orbit window

// We allocate a worst-case buffer up-front and use setDrawRange to expose
// only the segments we actually wrote. Avoids per-update geometry rebuilds.
const SEGS_PER_RIBBON = SAMPLES_PER_RIBBON - 1;
const VERTS_PER_RIBBON = SEGS_PER_RIBBON * 2;
const TOTAL_VERTS = RIBBON_CAP * VERTS_PER_RIBBON;

export class FleetRibbons {
    constructor(parent) {
        this._pos = new Float32Array(TOTAL_VERTS * 3);
        this._col = new Float32Array(TOTAL_VERTS * 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(this._col, 3));
        geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        geo.attributes.color.setUsage(THREE.DynamicDrawUsage);
        const mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent:  true,
            opacity:      0.95,
            depthWrite:   false,
            // Additive blending picks the high-severity reds out brilliantly
            // over the dark sphere; low-severity greens stay subdued.
            blending:     THREE.AdditiveBlending,
        });
        this.mesh = new THREE.LineSegments(geo, mat);
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        this.mesh.userData = { kind: 'fleet-ribbons' };
        geo.setDrawRange(0, 0);
        parent.add(this.mesh);
    }

    /**
     * Replace the active ribbon set. Pass an array of FleetAnalyzer results
     * (typically the top-3 by severity). Items lacking an SGP4 buffer are
     * silently skipped. Pass an empty array (or omit) to clear.
     */
    setRibbons(results) {
        const list = (results || []).slice(0, RIBBON_CAP);
        let written = 0;

        for (const r of list) {
            // We need a strided SGP4 buffer here. The fleet panel hands us
            // analyzer results, which include `decay` but not the raw SGP4
            // trajectory — so we re-derive the orbit from the live state +
            // a circular-orbit approximation. Cheap enough for 3 ribbons
            // and avoids a second SGP4 round-trip when the live altitude/
            // speed/inclination already tells us the ellipse.
            const live = r?.live;
            if (!live || !Number.isFinite(live.altKm) || !Number.isFinite(live.speedKms)) continue;

            const colour = _severityColor(r.risk?.severity ?? 0);
            this._writeCircularOrbit(written, live, colour);
            written++;
        }

        if (written === 0) {
            this.mesh.visible = false;
            this.mesh.geometry.setDrawRange(0, 0);
            return;
        }
        this.mesh.visible = true;
        this.mesh.geometry.setDrawRange(0, written * VERTS_PER_RIBBON);
        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.color.needsUpdate    = true;
    }

    update(_tSec) {
        // Currently a no-op; ribbons are static between setRibbons calls.
        // If we want a slow phase-rotate (so the head-of-orbit dot
        // appears to advance) it goes here.
    }

    dispose() {
        this.mesh.geometry?.dispose();
        this.mesh.material?.dispose();
        this.mesh.parent?.remove(this.mesh);
    }

    /**
     * Approximate one orbit's ribbon by sampling a great-circle path
     * through the live (lat, lon, alt) pose, oriented along the in-track
     * direction of the live velocity. This is a deliberate
     * simplification — for a precise ribbon you'd re-run SGP4 across
     * SAMPLES_PER_RIBBON × 5 min from epoch — but visually the result is
     * indistinguishable for non-eccentric LEO orbits at the scales we
     * render here.
     */
    _writeCircularOrbit(slotIdx, live, [r0, g0, b0]) {
        const altR = 1 + live.altKm / R_EARTH_KM;
        const lat0 = live.latDeg * Math.PI / 180;
        const lon0 = live.lonDeg * Math.PI / 180;
        const inc  = (live.inclinationDeg ?? 51) * Math.PI / 180;

        // Build a great-circle pass through (lat0, lon0) tilted by `inc`
        // around the polar axis. We parameterise by phase angle u ∈ [0, 2π)
        // and rotate (sin u, 0, cos u) — a circle in the xz-plane — into
        // the asset-orbit frame.
        const cosI = Math.cos(inc), sinI = Math.sin(inc);
        // Frame rotation: equator-aligned circle → tilted-by-`inc`,
        // intersecting equator at longitude `lon0` (ascending node).
        // The asset's current phase u0 is recovered from its latitude:
        // sin(lat0) = sinI · sin(u0).
        const sinU0 = Math.max(-1, Math.min(1, Math.sin(lat0) / Math.max(sinI, 1e-3)));
        const u0 = Math.asin(sinU0);

        // Ascending node longitude — set so the asset sits at (lat0, lon0).
        // Inertial circle in the rotated frame:
        //   x_i = cos u
        //   y_i = sinI · sin u
        //   z_i = cosI · sin u
        // Rotate by +Ω around y to place ascending node at lon Ω. Solve Ω
        // so that, at u = u0, the projected longitude is lon0.
        const xAtU = Math.cos(u0);
        const zAtU = cosI * Math.sin(u0);
        const lonInertial = Math.atan2(zAtU, xAtU);
        const Omega = lon0 - lonInertial;
        const cosO = Math.cos(Omega), sinO = Math.sin(Omega);

        const baseV = slotIdx * VERTS_PER_RIBBON * 3;
        const baseC = slotIdx * VERTS_PER_RIBBON * 3;

        // Build a polyline of SAMPLES_PER_RIBBON points centred on u0.
        // span = 2π → full orbit ribbon. Use 2π for a clean closed ring.
        const pts = new Float32Array(SAMPLES_PER_RIBBON * 3);
        for (let i = 0; i < SAMPLES_PER_RIBBON; i++) {
            const u = u0 - Math.PI + (2 * Math.PI) * (i / (SAMPLES_PER_RIBBON - 1));
            const cosU = Math.cos(u), sinU = Math.sin(u);
            // Inertial frame.
            const xi = cosU;
            const yi = sinI * sinU;
            const zi = cosI * sinU;
            // Apply Ω rotation about Y → place ascending node at lon0.
            const xr = xi * cosO + zi * sinO;
            const yr = yi;
            const zr = -xi * sinO + zi * cosO;
            // Scene convention (matches drag-forecast-overlay's
            // _latLonToVec3): lon=0 along +X, +Y north. The inertial
            // frame above is built in the same convention, so just scale.
            pts[i * 3 + 0] = xr * altR;
            pts[i * 3 + 1] = yr * altR;
            pts[i * 3 + 2] = zr * altR;
        }
        // Emit as line segments (not LineStrip) by writing each segment's
        // two endpoints. The shared mesh is LineSegments so we can pack
        // many ribbons into one buffer.
        for (let s = 0; s < SEGS_PER_RIBBON; s++) {
            const ax = pts[s * 3 + 0], ay = pts[s * 3 + 1], az = pts[s * 3 + 2];
            const bx = pts[(s + 1) * 3 + 0], by = pts[(s + 1) * 3 + 1], bz = pts[(s + 1) * 3 + 2];
            const v = baseV + s * 6;
            this._pos[v + 0] = ax; this._pos[v + 1] = ay; this._pos[v + 2] = az;
            this._pos[v + 3] = bx; this._pos[v + 4] = by; this._pos[v + 5] = bz;
            // Brighten the head of the ribbon (where the asset currently
            // is) so users can find their satellite at a glance.
            const headFade = Math.abs((s + 0.5) / SEGS_PER_RIBBON - 0.5) * 2; // 0 at head, 1 at tail
            const head = 1.0 - 0.55 * headFade;
            const c = baseC + s * 6;
            this._col[c + 0] = r0 * head; this._col[c + 1] = g0 * head; this._col[c + 2] = b0 * head;
            this._col[c + 3] = r0 * head; this._col[c + 4] = g0 * head; this._col[c + 5] = b0 * head;
        }
    }
}

/**
 * Severity (0..1) → ribbon RGB.
 *   ≥0.7 → red   (reentry-class)
 *   ≥0.4 → amber (decay-spike-class)
 *   <0.4 → green (low-risk baseline)
 */
function _severityColor(s) {
    if (s >= 0.7) return [1.00, 0.30, 0.36];
    if (s >= 0.4) return [1.00, 0.70, 0.20];
    return [0.30, 0.95, 0.55];
}
