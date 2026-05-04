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
import { rtnBasis, tleAgeUncertainty } from './uncertainty.js';
import { provStore }            from './provenance.js';

const RE_KM        = 6378.135;
const MIN_PER_DAY  = 1440;

const TRAIL_POINTS         = 30;        // 30 samples (basic streak)
const TRAIL_SPAN_MIN       = 30;        // 30 min look-ahead (basic streak)
const TRAIL_DT_MIN         = TRAIL_SPAN_MIN / TRAIL_POINTS;
const TRAIL_REBUILD_FRAMES = 60;        // ~1 s

const RISK_POINTS          = 50;        // 50 samples over one orbit
const RISK_NEAR_KM         = 100;       // probe distance for "any debris near"
const RISK_REBUILD_FRAMES  = 180;       // ~3 s — risk trail is heavier

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

        // Covariance tubes (lazy: created on first conjunction click).
        // Two ellipsoids — primary (asset) + secondary (debris).
        this._covGroup = new THREE.Group();
        this._covGroup.name = 'op-covariance';
        this._covGroup.visible = false;
        this._scene.add(this._covGroup);
        this._covPrimary   = null;
        this._covSecondary = null;
        this._activeConj   = null;   // { assetTle, secondaryTle, tcaMs, missKm }

        // TCA glyphs — static markers parked at the scene-frame
        // (ECEF using TCA-time GMST) position the primary and
        // secondary will occupy at TCA. They don't move as the user
        // scrubs sim time; the actual sats orbit through them. Useful
        // when an operator wants to "look at the encounter point"
        // while inspecting the lead-up geometry.
        this._tcaGroup = new THREE.Group();
        this._tcaGroup.name = 'op-tca-glyph';
        this._tcaGroup.visible = false;
        this._scene.add(this._tcaGroup);
        this._tcaPrimary   = null;
        this._tcaSecondary = null;
        this._tcaConnector = null;

        // Per-orbit risk trail (replaces the basic streak when set).
        this._riskLine = null;
        this._riskGeo  = null;
        this._riskMat  = null;
        this._riskGroup = new THREE.Group();
        this._riskGroup.name = 'op-risk-trail';
        this._scene.add(this._riskGroup);

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
        if (this._frame % RISK_REBUILD_FRAMES  === 1) this._rebuildRiskTrail(simTimeMs);
        if (this._activeConj && this._frame % RING_REBUILD_FRAMES === 1) {
            this._refreshCovTubes(simTimeMs);
        }
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

    /* ─── Covariance tubes ───────────────────────────────── */

    /**
     * Activate covariance ellipsoids for a conjunction. Called by the
     * decision-deck conjunction-row click handler (which also scrubs
     * time to TCA). Pass null to clear.
     */
    showConjunction(conj) {
        if (!conj) {
            this._activeConj = null;
            this._covGroup.visible = false;
            this._tcaGroup.visible = false;
            return;
        }
        this._activeConj = conj;
        this._ensureCovTubes();
        this._covGroup.visible = true;
        this._refreshCovTubes(timeBus.getState().simTimeMs);
        this._refreshTcaGlyphs();

        provStore.set('conj.miss.combined', {
            value: conj.missKm,
            unit:  'km',
            sigma: conj.combinedSigmaKm ?? null,
            source: 'derived (Operations conjunction screening)',
            model:  'SGP4 closest-approach + Vallado age-map covariance',
            inputs: ['idx.f107', 'idx.ap'],
            cacheState: 'synthetic',
            description:
                `Predicted closest approach between the selected asset and the ` +
                `secondary at TCA. Combined uncertainty σ = sqrt(σ_a² + σ_b²) ` +
                `with each object's σ from its TLE age (Vallado map). Real ` +
                `Space-Track / commercial covariance is an Enterprise upgrade.`,
        });
    }

    _ensureCovTubes() {
        if (this._covPrimary && this._covSecondary) return;
        const buildEllipsoid = (color) => {
            const geo = new THREE.SphereGeometry(1, 18, 12);
            const mat = new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.18,
                blending: THREE.AdditiveBlending, depthWrite: false,
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.frustumCulled = false;
            this._covGroup.add(mesh);
            return mesh;
        };
        this._covPrimary   = buildEllipsoid(0x00ffcc);   // asset
        this._covSecondary = buildEllipsoid(0xff7099);   // debris
    }

    _refreshCovTubes(simTimeMs) {
        const c = this._activeConj;
        if (!c?.assetTle || !c?.secondaryTle) return;

        const ap = provStore.get('idx.ap')?.value ?? 15;
        const jdNow   = jdFromMs(simTimeMs);
        const gmstRad = geo.greenwichSiderealTimeFromJD(jdNow);
        const km = this._kmToScene;

        const place = (mesh, tle) => {
            const basis = rtnBasis(tle, simTimeMs, ap);
            // Position in scene frame (rotate TEME → ECEF then scale).
            geo.eciToEcef(basis.posTeme, gmstRad, _scnA);
            mesh.position.set(_scnA.x * km, _scnA.y * km, _scnA.z * km);

            // Rotate basis vectors into scene frame too.
            const Rscn = new THREE.Vector3(); geo.eciToEcef(basis.R, gmstRad, Rscn);
            const Tscn = new THREE.Vector3(); geo.eciToEcef(basis.T, gmstRad, Tscn);
            const Nscn = new THREE.Vector3(); geo.eciToEcef(basis.N, gmstRad, Nscn);
            // Build rotation matrix from RTN basis (T→x, N→y, R→z).
            const m = new THREE.Matrix4().makeBasis(
                Tscn.normalize(),
                Nscn.normalize(),
                Rscn.normalize(),
            );
            mesh.setRotationFromMatrix(m);

            // Non-uniform scale in scene units (sigma values are in km).
            mesh.scale.set(
                basis.sigmaAlong  * km,
                basis.sigmaCross  * km,
                basis.sigmaRadial * km,
            );
        };

        place(this._covPrimary,   c.assetTle);
        place(this._covSecondary, c.secondaryTle);
    }

    /* ─── TCA glyphs ─────────────────────────────────────── */

    _ensureTcaGlyphs() {
        if (this._tcaPrimary && this._tcaSecondary) return;
        const buildPin = (color) => {
            // Small wireframe sphere over a solid core — reads as
            // "pinned location" against busy scenes without lighting.
            const group = new THREE.Group();
            const core = new THREE.Mesh(
                new THREE.SphereGeometry(0.012, 12, 8),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
            );
            const ring = new THREE.Mesh(
                new THREE.SphereGeometry(0.022, 18, 10),
                new THREE.MeshBasicMaterial({
                    color, wireframe: true, transparent: true, opacity: 0.4,
                    depthWrite: false,
                }),
            );
            core.frustumCulled = false;
            ring.frustumCulled = false;
            group.add(core);
            group.add(ring);
            this._tcaGroup.add(group);
            return group;
        };
        this._tcaPrimary   = buildPin(0x00ffcc);   // asset
        this._tcaSecondary = buildPin(0xff7099);   // debris

        // Connector line drawn between the two pins so the encounter
        // separation is visible at a glance.
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const lineMat = new THREE.LineBasicMaterial({
            color: 0xffaa66, transparent: true, opacity: 0.55, depthWrite: false,
        });
        this._tcaConnector = new THREE.Line(lineGeo, lineMat);
        this._tcaConnector.frustumCulled = false;
        this._tcaGroup.add(this._tcaConnector);
    }

    /**
     * Park the primary + secondary glyphs at the ECEF-frame position
     * each will occupy at TCA. The marker is computed once per call
     * (showConjunction) and stays in scene-frame so as the user
     * scrubs sim time the actual sats orbit through the parked pins.
     */
    _refreshTcaGlyphs() {
        const c = this._activeConj;
        if (!c?.assetTle || !c?.secondaryTle || !Number.isFinite(c.tcaMs)) {
            this._tcaGroup.visible = false;
            return;
        }
        this._ensureTcaGlyphs();

        const km = this._kmToScene;
        const jdTca   = jdFromMs(c.tcaMs);
        const gmstTca = geo.greenwichSiderealTimeFromJD(jdTca);

        const placePin = (group, tle) => {
            const tsinceMin = (jdTca - tleEpochToJd(tle)) * MIN_PER_DAY;
            temeToScene(tle, tsinceMin, km, gmstTca, _scnA);
            group.position.set(_scnA.x, _scnA.y, _scnA.z);
            return _scnA.clone();
        };

        const pA = placePin(this._tcaPrimary,   c.assetTle);
        const pB = placePin(this._tcaSecondary, c.secondaryTle);

        // Connector line between the two pins.
        const arr = this._tcaConnector.geometry.attributes.position.array;
        arr[0] = pA.x; arr[1] = pA.y; arr[2] = pA.z;
        arr[3] = pB.x; arr[4] = pB.y; arr[5] = pB.z;
        this._tcaConnector.geometry.attributes.position.needsUpdate = true;
        this._tcaConnector.geometry.computeBoundingSphere();

        this._tcaGroup.visible = true;
    }

    /**
     * Public toggle. Hides the glyph group without dropping the
     * active conjunction so the b-plane / covariance tubes survive.
     * Returns the new visibility state.
     */
    toggleTcaGlyph() {
        if (!this._activeConj) return false;
        this._tcaGroup.visible = !this._tcaGroup.visible;
        return this._tcaGroup.visible;
    }

    /* ─── Per-orbit risk trail ─────────────────────────── */

    _rebuildRiskTrail(simTimeMs) {
        const id = this._selectedNorad;
        if (id == null) {
            if (this._riskLine) this._riskLine.visible = false;
            return;
        }
        const sat = this.tracker.getSatellite?.(id);
        if (!sat?.tle) return;

        // Hide the basic streak for the selected asset since this
        // replaces it with a risk-coloured version.
        const streak = this._trails.get(id);
        if (streak) streak.line.visible = false;

        const periodMin = sat.tle.period_min || 90;
        const tle = sat.tle;
        const epochJd = tleEpochToJd(tle);
        const jdNow   = jdFromMs(simTimeMs);
        const gmstRad = geo.greenwichSiderealTimeFromJD(jdNow);
        const tsBase  = (jdNow - epochJd) * MIN_PER_DAY;

        // Sample asset positions over one full orbit.
        const dtMin = periodMin / RISK_POINTS;
        const positions = [];
        const minDists  = new Float32Array(RISK_POINTS);

        const debrisTles = this.tracker.getTlesByGroup?.('debris') || [];

        for (let i = 0; i < RISK_POINTS; i++) {
            const tsince = tsBase + i * dtMin;
            const aProp = propagate(tle, tsince);
            positions.push({ x: aProp.x, y: aProp.y, z: aProp.z, tsince });

            // Min distance to any debris at this sample time.
            let minSq = Infinity;
            for (const dTle of debrisTles) {
                const dts = (jdNow - tleEpochToJd(dTle)) * MIN_PER_DAY + i * dtMin;
                const dProp = propagate(dTle, dts);
                const dx = dProp.x - aProp.x;
                const dy = dProp.y - aProp.y;
                const dz = dProp.z - aProp.z;
                const r2 = dx * dx + dy * dy + dz * dz;
                if (r2 < minSq) minSq = r2;
            }
            minDists[i] = Math.sqrt(minSq);
        }

        // Build geometry with vertex colors.
        const km = this._kmToScene;
        const posArr  = new Float32Array(RISK_POINTS * 3);
        const colArr  = new Float32Array(RISK_POINTS * 3);

        for (let i = 0; i < RISK_POINTS; i++) {
            const p = positions[i];
            _temeA.set(p.x, p.y, p.z);
            geo.eciToEcef(_temeA, gmstRad, _scnA);
            posArr[i * 3]     = _scnA.x * km;
            posArr[i * 3 + 1] = _scnA.y * km;
            posArr[i * 3 + 2] = _scnA.z * km;

            // Risk colour: closer = hotter.
            const d = minDists[i];
            const c = riskColor(d);
            colArr[i * 3]     = c.r;
            colArr[i * 3 + 1] = c.g;
            colArr[i * 3 + 2] = c.b;
        }

        if (!this._riskLine) {
            this._riskGeo = new THREE.BufferGeometry();
            this._riskMat = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.85,
                depthWrite: false,
                linewidth: 2,
            });
            this._riskLine = new THREE.Line(this._riskGeo, this._riskMat);
            this._riskLine.frustumCulled = false;
            this._riskGroup.add(this._riskLine);
        }
        this._riskGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        this._riskGeo.setAttribute('color',    new THREE.BufferAttribute(colArr, 3));
        this._riskGeo.attributes.position.needsUpdate = true;
        this._riskGeo.attributes.color.needsUpdate    = true;
        this._riskLine.visible = true;

        // Surface the closest pass distance via provStore so the
        // decision deck can show it next iteration.
        let worstIdx = 0;
        for (let i = 1; i < RISK_POINTS; i++) {
            if (minDists[i] < minDists[worstIdx]) worstIdx = i;
        }
        provStore.set(`risk.minDist.${id}`, {
            value: minDists[worstIdx],
            unit:  'km',
            source: 'derived (per-orbit risk trail)',
            model:  'SGP4 sweep × debris catalog at sample time',
            cacheState: 'derived',
            inputs: ['fleet.count.debris'],
            description:
                `Minimum distance from the selected asset to any debris over its ` +
                `next full orbital period (${Math.round(periodMin)} min) at ` +
                `${RISK_POINTS} samples. Each sample propagates the asset and ` +
                `every loaded debris object to the same instant via SGP4.`,
        });
    }

    /* ─── Asset TLE getter for external callers (b-plane etc.) ─ */

    getAssetTle(noradId) {
        return this.tracker.getSatellite?.(noradId)?.tle ?? null;
    }
}

/* ─── Risk colour ramp ────────────────────────────────────── */

const _riskColor = new THREE.Color();
function riskColor(distKm) {
    // > 100 km: cyan low-key (clear)
    // 50-100  : teal
    // 25-50   : yellow
    // 10-25   : orange
    // < 10    : red
    if (distKm > 100) return _riskColor.setHSL(0.50, 0.4, 0.45);
    if (distKm > 50)  return _riskColor.setHSL(0.45, 0.7, 0.5);
    if (distKm > 25)  return _riskColor.setHSL(0.16, 0.85, 0.55);
    if (distKm > 10)  return _riskColor.setHSL(0.08, 0.90, 0.55);
    return _riskColor.setHSL(0.0, 0.95, 0.55);
}

/* ─── exports for tests ───────────────────────────────────── */

export { dvColor, temeVelocity, DV_FULL_KMS, TRAIL_POINTS, TRAIL_SPAN_MIN, riskColor };
