/**
 * visuals.js — Tier-1 Sat Ops visualisation layer.
 *
 * Adds four affordances to the globe, all keyed off a single selection:
 *
 *   1. Streak trails  — for every fleet asset, the next 30 minutes of
 *                       its orbit drawn as a polyline. One Line per
 *                       asset (max 10) so the buffer rebuild is cheap.
 *
 *   2. Threat ring    — a thin torus at the selected asset's altitude,
 *                       oriented to its orbit plane (h = r × v). Visual
 *                       shorthand for "the altitude shell this asset
 *                       shares with potential threats."
 *
 *   3. Δv coloring    — when an asset is selected, every loaded debris
 *                       point is recoloured by relative-velocity
 *                       magnitude to that asset (deep blue → white →
 *                       hot red across 0–14 km/s). Δv comes from a
 *                       10 s finite-difference on SGP4 because the
 *                       module-level propagate() exports position
 *                       only, not velocity.
 *
 *   4. Selection API  — setSelectedAsset(noradId) drives all of the
 *                       above. Decision-deck row clicks call it;
 *                       conjunction-row clicks call it AND scrub time
 *                       to TCA so the geometry of the encounter is
 *                       visible immediately. Camera animation is v2
 *                       and intentionally not included here.
 *
 * Heavy work is throttled to render-frame counts so the OrbitControls
 * + Earth + ~5 k satellite scene stays at 60 fps on the 2020 MacBook
 * baseline:
 *   - trails recompute every 60 frames (~1 s)
 *   - Δv coloring recomputes every 30 frames (~0.5 s)
 *   - threat ring repositions every 6 frames (~10 Hz)
 */

import * as THREE              from 'three';
import { propagate, tleEpochToJd } from '../satellite-tracker.js';
import { geo }                  from '../geo/coords.js';
import { timeBus }              from './time-bus.js';

const RE_KM        = 6378.135;
const MIN_PER_DAY  = 1440;

const TRAIL_POINTS         = 30;        // 30 samples
const TRAIL_SPAN_MIN       = 30;        // 30 min look-ahead
const TRAIL_DT_MIN         = TRAIL_SPAN_MIN / TRAIL_POINTS;
const TRAIL_REBUILD_FRAMES = 60;        // ~1 s

const DV_REBUILD_FRAMES    = 30;        // ~0.5 s
const RING_REBUILD_FRAMES  = 6;         // ~10 Hz

const DV_FULL_KMS          = 14;        // saturated colour at this Δv

/* ─── Helpers ─────────────────────────────────────────────────── */

const _temeA = new THREE.Vector3();
const _temeB = new THREE.Vector3();
const _scnA  = new THREE.Vector3();
const _scnB  = new THREE.Vector3();

function jdFromMs(ms) { return ms / 86400000 + 2440587.5; }

function temeToScene(tle, tsinceMin, kmToScene, gmstRad, out) {
    const teme = propagate(tle, tsinceMin);
    _temeA.set(teme.x, teme.y, teme.z);
    geo.eciToEcef(_temeA, gmstRad, _scnA);
    out.set(_scnA.x * kmToScene, _scnA.y * kmToScene, _scnA.z * kmToScene);
    return out;
}

/**
 * Approximate velocity vector by 10-second finite-difference on
 * propagate() (which exports position only). 10 s is short enough
 * for SGP4 numerical noise to stay below ~10 m/s on a typical LEO
 * orbit and long enough to dwarf machine epsilon.
 */
function temeVelocity(tle, tsinceMin, out) {
    const dt = 10 / 60;                  // 10 s in minutes
    const a = propagate(tle, tsinceMin);
    const b = propagate(tle, tsinceMin + dt);
    out.set((b.x - a.x) / 10, (b.y - a.y) / 10, (b.z - a.z) / 10);
    return out;
}

/** HSL gradient blue → white → red, parameterised by Δv in km/s. */
function dvColor(dvKms, out) {
    const t = Math.max(0, Math.min(1, dvKms / DV_FULL_KMS));
    // Hue: 200° (cyan) → 350° (red). Saturation full at the ends,
    // lower in the middle so the white midpoint reads as actual white.
    const h = (200 + (350 - 200) * t) / 360;
    const s = 0.45 + 0.45 * Math.abs(t - 0.5) * 2;   // 0.45..0.9
    const l = 0.45 + 0.20 * Math.abs(t - 0.5) * 2;   // 0.45..0.65
    return out.setHSL(h, s, l);
}

/* ─── Visuals class ──────────────────────────────────────────── */

export class OperationsVisuals {
    constructor({ globe, fleet, myFleet, tracker }) {
        this.globe   = globe;
        this.fleet   = fleet;
        this.myFleet = myFleet;
        this.tracker = tracker;

        this._scene       = globe.getScene();
        this._earthR      = globe.getEarthRadius();
        this._kmToScene   = this._earthR / RE_KM;

        this._selectedNorad = null;
        this._selectionSubs = new Set();

        // Trails: Map<noradId, { line, geometry, positions }>
        this._trails = new Map();
        this._trailGroup = new THREE.Group();
        this._trailGroup.name = 'op-trails';
        this._scene.add(this._trailGroup);

        // Threat ring (created on first selection).
        this._ring     = null;
        this._ringGeo  = null;
        this._ringMat  = null;

        // Δv color overrides applied through the tracker.
        this._dvScratch = new THREE.Color();

        // Frame counter for throttle.
        this._frame = 0;
        this._unhookTick = null;

        // React to fleet changes (re-key trails) and time-bus changes
        // (force a Δv + ring refresh on mode flips).
        this._unhookFleet = myFleet.onChange(() => this._syncTrails());
    }

    /* ─── Selection ─────────────────────────────────────────── */

    setSelectedAsset(noradId) {
        const next = noradId == null ? null : Number(noradId);
        if (this._selectedNorad === next) return;
        this._selectedNorad = next;

        // Pin the highlight sprite via the existing tracker primitive.
        if (next == null) {
            this.tracker.clearHighlight?.();
            this.tracker.clearColorOverrides?.();
            this._removeRing();
        } else {
            const sat = this.tracker.getSatellite?.(next);
            if (sat) {
                this.tracker.setHighlight?.(next, {
                    label: sat.name || `#${next}`,
                    color: 0x00ffcc,
                });
            }
            // Δv + ring will pick up next throttle tick.
            this._frame = 0;
        }

        for (const fn of this._selectionSubs) {
            try { fn(this._selectedNorad); } catch (_) {}
        }
    }

    getSelectedAsset() { return this._selectedNorad; }

    onSelectionChange(fn) {
        this._selectionSubs.add(fn);
        try { fn(this._selectedNorad); } catch (_) {}
        return () => this._selectionSubs.delete(fn);
    }

    /* ─── Lifecycle ─────────────────────────────────────────── */

    start() {
        if (this._unhookTick) return;
        this._unhookTick = this.globe.onTick((simTimeMs) => this._tick(simTimeMs));
    }

    stop() {
        this._unhookTick?.();
        this._unhookTick = null;
        this._unhookFleet?.();
        this._unhookFleet = null;
        for (const t of this._trails.values()) {
            this._trailGroup.remove(t.line);
            t.geometry.dispose();
        }
        this._trails.clear();
        this._removeRing();
    }

    _tick(simTimeMs) {
        this._frame++;

        if (this._frame % TRAIL_REBUILD_FRAMES === 1) this._rebuildTrails(simTimeMs);
        if (this._frame % DV_REBUILD_FRAMES    === 1) this._refreshDeltaV(simTimeMs);
        if (this._frame % RING_REBUILD_FRAMES  === 1) this._refreshRing(simTimeMs);
    }

    /* ─── Trails ───────────────────────────────────────────── */

    /** Create / dispose Line objects so the set matches the fleet. */
    _syncTrails() {
        const wantIds = new Set(
            this.myFleet.list().filter(a => a.tle).map(a => a.noradId),
        );

        // Dispose lines whose asset is gone.
        for (const [id, t] of this._trails) {
            if (!wantIds.has(id)) {
                this._trailGroup.remove(t.line);
                t.geometry.dispose();
                this._trails.delete(id);
            }
        }

        // Add lines for new assets.
        for (const a of this.myFleet.list()) {
            if (!a.tle || this._trails.has(a.noradId)) continue;
            const positions = new Float32Array(TRAIL_POINTS * 3);
            const geometry  = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const material = new THREE.LineBasicMaterial({
                color:       0x0099ff,
                transparent: true,
                opacity:     0.55,
                depthWrite:  false,
            });
            const line = new THREE.Line(geometry, material);
            line.frustumCulled = false;
            this._trailGroup.add(line);
            this._trails.set(a.noradId, { line, geometry, positions, tle: a.tle });
        }

        // Force next tick to repopulate positions.
        this._frame = 0;
    }

    _rebuildTrails(simTimeMs) {
        if (this._trails.size === 0) return;
        const jdNow   = jdFromMs(simTimeMs);
        const gmstRad = geo.greenwichSiderealTimeFromJD(jdNow);

        for (const [id, t] of this._trails) {
            const sat = this.tracker.getSatellite?.(id);
            const tle = sat?.tle ?? t.tle;
            if (!tle) continue;
            const epochJd = tleEpochToJd(tle);
            const tsBase  = (jdNow - epochJd) * MIN_PER_DAY;
            const arr = t.positions;

            // Trails are drawn in scene-frame ECEF using *current* GMST
            // for every sample. That matches the way the tracker
            // renders point positions (see SatelliteTracker.tick) so
            // trails register cleanly against satellite dots without
            // a per-sample rotation correction.
            for (let i = 0; i < TRAIL_POINTS; i++) {
                const tsince = tsBase + i * TRAIL_DT_MIN;
                temeToScene(tle, tsince, this._kmToScene, gmstRad, _scnB);
                arr[i * 3]     = _scnB.x;
                arr[i * 3 + 1] = _scnB.y;
                arr[i * 3 + 2] = _scnB.z;
            }
            t.geometry.attributes.position.needsUpdate = true;

            // Selected asset's trail glows brighter.
            t.line.material.color.set(id === this._selectedNorad ? 0x00ffcc : 0x0099ff);
            t.line.material.opacity = id === this._selectedNorad ? 0.85 : 0.45;
        }
    }

    /* ─── Δv coloring ──────────────────────────────────────── */

    _refreshDeltaV(simTimeMs) {
        const id = this._selectedNorad;
        if (id == null) return;

        const sat = this.tracker.getSatellite?.(id);
        if (!sat?.tle) return;

        const debris = this.tracker.getTlesByGroup?.('debris') || [];
        if (debris.length === 0) return;

        const jdNow = jdFromMs(simTimeMs);
        const tsAsset = (jdNow - tleEpochToJd(sat.tle)) * MIN_PER_DAY;
        temeVelocity(sat.tle, tsAsset, _temeA);
        const vAx = _temeA.x, vAy = _temeA.y, vAz = _temeA.z;

        const map = new Map();
        for (const tle of debris) {
            const ts = (jdNow - tleEpochToJd(tle)) * MIN_PER_DAY;
            temeVelocity(tle, ts, _temeB);
            const dvx = _temeB.x - vAx;
            const dvy = _temeB.y - vAy;
            const dvz = _temeB.z - vAz;
            const dv = Math.sqrt(dvx*dvx + dvy*dvy + dvz*dvz);
            const c = dvColor(dv, this._dvScratch.clone());
            map.set(tle.norad_id, c);
        }
        this.tracker.setColorOverrides?.(map);
    }

    /* ─── Threat-band ring ─────────────────────────────────── */

    _ensureRing() {
        if (this._ring) return;
        // Major radius is set per-frame from the asset altitude; tube
        // radius is fixed thin.
        const geo = new THREE.TorusGeometry(1, 0.004, 8, 96);
        const mat = new THREE.MeshBasicMaterial({
            color:       0x00ffcc,
            transparent: true,
            opacity:     0.18,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
            side:        THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(geo, mat);
        ring.frustumCulled = false;
        ring.name = 'op-threat-ring';
        this._scene.add(ring);
        this._ring    = ring;
        this._ringGeo = geo;
        this._ringMat = mat;
    }

    _removeRing() {
        if (!this._ring) return;
        this._scene.remove(this._ring);
        this._ringGeo?.dispose();
        this._ringMat?.dispose();
        this._ring = this._ringGeo = this._ringMat = null;
    }

    _refreshRing(simTimeMs) {
        const id = this._selectedNorad;
        if (id == null) { this._removeRing(); return; }
        const sat = this.tracker.getSatellite?.(id);
        if (!sat?.tle) return;
        this._ensureRing();

        const jdNow   = jdFromMs(simTimeMs);
        const gmstRad = geo.greenwichSiderealTimeFromJD(jdNow);
        const tsAsset = (jdNow - tleEpochToJd(sat.tle)) * MIN_PER_DAY;

        // Position in scene frame.
        temeToScene(sat.tle, tsAsset, this._kmToScene, gmstRad, _scnA);
        const altKm  = _scnA.length() / this._kmToScene - RE_KM;
        const radius = (RE_KM + altKm) * this._kmToScene;

        // Velocity → orbit normal: r × v gives angular momentum.
        // Normalise + rotate the torus so its plane equals the
        // orbital plane.
        temeVelocity(sat.tle, tsAsset, _temeA);    // velocity in TEME
        // Convert position back to TEME for cross product.
        const teme = propagate(sat.tle, tsAsset);
        const rTeme = new THREE.Vector3(teme.x, teme.y, teme.z);
        const vTeme = _temeA.clone();
        const hTeme = new THREE.Vector3().crossVectors(rTeme, vTeme).normalize();

        // hTeme is in ECI; rotate to ECEF using the same GMST so it
        // aligns with the rendered Earth. eciToEcef is in coords.js.
        const hScene = new THREE.Vector3();
        geo.eciToEcef(hTeme, gmstRad, hScene);

        this._ring.scale.setScalar(radius);
        // Default torus is in XY plane (normal = +Z). Quaternion that
        // aligns +Z to hScene.
        const up = new THREE.Vector3(0, 0, 1);
        const q = new THREE.Quaternion().setFromUnitVectors(up, hScene.clone().normalize());
        this._ring.quaternion.copy(q);
    }
}

/* ─── exports for tests ───────────────────────────────────── */

export { dvColor, temeVelocity, DV_FULL_KMS, TRAIL_POINTS, TRAIL_SPAN_MIN };
