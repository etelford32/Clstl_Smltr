/**
 * storm-track-overlay.js — globe overlay for active-storm forecast cones
 *
 * Consumes the kinematic forecast produced by storm-forecast.js and
 * renders three things per active storm onto the Earth mesh:
 *
 *   1. A dashed centerline polyline from the current position through
 *      the +12 / +24 / +36 / +48 / +72 / +96 / +120 h forecast points.
 *   2. A semi-transparent "cone" — the 5-day uncertainty envelope —
 *      drawn as a triangle strip between left- and right-edge points
 *      offset perpendicular to the centerline by NHC's average
 *      track-error radius at each horizon.
 *   3. Day markers (D1, D2, D3, D4, D5) at the 24/48/72/96/120-hour
 *      points so the user can see the temporal scale at a glance.
 *
 * Highlight mode
 * ──────────────
 * Calling `setHighlightedStormId(id)` fades all other cones to a faint
 * background tint and brightens the selected storm. Used by the Storm
 * Watch panel to focus attention on whichever card the user is hovering
 * or has clicked.
 *
 * Visibility is gated by `setVisible(boolean)` — wired to a layer-panel
 * toggle. Hidden by default to keep the globe uncluttered until the
 * user opts in.
 *
 * Coordinate convention
 * ─────────────────────
 * Lat/lon → unit-sphere position via the caller-supplied `geoToXYZ`
 * helper (so we share the surface convention used by every other
 * overlay in earth.html). All meshes are parented to `earthMesh` so
 * they spin with the planet's sidereal rotation; nothing in this
 * module touches earthMesh.rotation directly.
 */

// Default visual styling per classification — saturation walks warm as
// the storm intensifies. Lifted from storm-watch-panel's CLASS_META so
// the panel cards and the globe lines agree on which storm is which.
const CLASS_COLOR = {
    TD:  0x3a8acb,
    TS:  0x3ec1b8,
    HU:  0xf59f3b,
    TY:  0xf08020,
    STY: 0xe64545,
    MH:  0xd8345f,
};

// Sphere radius factors — keep the cone slightly off the surface so the
// dashed line doesn't z-fight with the cloud layer or the SST overlay.
const R_CENTERLINE = 1.012;
const R_CONE       = 1.011;     // just under the centerline, so dash reads on top of fill
const R_HORIZON    = 1.014;     // dot markers above the dash line
const R_SCRUB      = 1.018;     // scrubber dot — sits above all other markers

// 1 nautical mile expressed as a fraction of Earth's mean radius — used
// to convert NHC error radii into great-circle angular distance.
const NM_PER_EARTH_RADIUS = 1 / 3440.065;

// Sub-segments per centerline edge — larger = smoother curve along the
// great-circle arc between two forecast points. 12 is enough to look
// curved at globe scale without exploding triangle count.
const SEGMENTS_PER_EDGE = 12;

// How far past the cone tip the centerline taper closes. Geometrically
// the cone tip is the 120 h point's error radius, but visually the
// dashed line should pierce the tip.
const CENTERLINE_DASH_SIZE = 0.012;
const CENTERLINE_GAP_SIZE  = 0.008;

// ── Spherical helpers (kept self-contained so this module doesn't
// depend on storm-forecast.js's internals — both modules can evolve
// independently as long as the {hour, lat, lon, bearing, errorNm}
// schema holds.) ────────────────────────────────────────────────────

const D2R = Math.PI / 180;

function destinationPoint(latDeg, lonDeg, bearingDeg, distNm) {
    const lat1 = latDeg * D2R, lon1 = lonDeg * D2R;
    const brng = bearingDeg * D2R;
    const ang  = distNm * NM_PER_EARTH_RADIUS;
    const sinLat2 = Math.sin(lat1) * Math.cos(ang)
                  + Math.cos(lat1) * Math.sin(ang) * Math.cos(brng);
    const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
    const y    = Math.sin(brng) * Math.sin(ang) * Math.cos(lat1);
    const x    = Math.cos(ang) - Math.sin(lat1) * sinLat2;
    const lon2 = lon1 + Math.atan2(y, x);
    let outLon = lon2 / D2R;
    outLon = ((outLon + 540) % 360) - 180;
    return { lat: lat2 / D2R, lon: outLon };
}

function initialBearing(lat1Deg, lon1Deg, lat2Deg, lon2Deg) {
    const φ1 = lat1Deg * D2R, φ2 = lat2Deg * D2R;
    const Δλ = (lon2Deg - lon1Deg) * D2R;
    const y  = Math.sin(Δλ) * Math.cos(φ2);
    const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) / D2R) + 360) % 360;
}

// Slerp on the sphere — interpolate between two unit vectors by t.
// Used to subdivide each centerline segment into smooth arc chunks
// rather than straight-chord lines through the Earth.
function slerpUnit(THREE, a, b, t) {
    const dot = Math.min(1, Math.max(-1, a.dot(b)));
    const ω = Math.acos(dot);
    if (ω < 1e-5) return a.clone();
    const sinω = Math.sin(ω);
    const wa = Math.sin((1 - t) * ω) / sinω;
    const wb = Math.sin(t * ω) / sinω;
    return new THREE.Vector3(
        a.x * wa + b.x * wb,
        a.y * wa + b.y * wb,
        a.z * wa + b.z * wb,
    );
}

// ── StormTrackOverlay ─────────────────────────────────────────────────────

export class StormTrackOverlay {
    /**
     * @param {object} opts
     * @param {object} opts.THREE              Three.js namespace.
     * @param {object} opts.earthMesh          Parent mesh (storm tracks rotate with the planet).
     * @param {(lat:number, lon:number) => any} opts.geoToXYZ
     *   Lat/lon → unit-sphere Vector3, matching the convention the rest
     *   of the page uses for surface placement.
     * @param {(storm:any) => any} opts.extrapolate
     *   Pure function returning {points, ...} — typically
     *   extrapolateStormTrack from storm-forecast.js.
     */
    constructor({ THREE, earthMesh, geoToXYZ, extrapolate, interpolateAtHour }) {
        this._THREE      = THREE;
        this._earthMesh  = earthMesh;
        this._geoToXYZ   = geoToXYZ;
        this._extrapolate = extrapolate;
        // Optional pure helper from storm-forecast.js — called per
        // storm on every setScrubHours() to compute the slerp position.
        // When omitted the scrubber dots are silently disabled (the
        // overlay still renders the static cones).
        this._interpolateAtHour = interpolateAtHour;

        // Group holds every per-storm sub-group so we can flip visibility
        // for the entire overlay with a single mesh.visible = false.
        this._root = new THREE.Group();
        this._root.name        = 'StormTrackOverlay';
        this._root.visible     = false;
        this._root.renderOrder = 6;     // above ocean currents (5), below jet (7)
        earthMesh.add(this._root);

        // id → { centerline, cone, horizonGroup, scrub, storm, track, classification, color }
        this._tracks = new Map();
        this._highlightedId = null;
        // Current scrub-hours setting (0 = "now", up to MAX_SCRUB_H).
        // Stored so re-builds (on storm-update) can replay the scrubber
        // dots without waiting for the next slider event.
        this._scrubHours = 0;

        // Shared geometry for the scrubber dot — one allocation, every
        // track points its mesh at this. Saves allocations during fast
        // rebuild bursts when many storms are active simultaneously.
        this._scrubGeom = new THREE.SphereGeometry(0.006, 12, 12);
        this._scrubHaloGeom = new THREE.SphereGeometry(0.012, 16, 12);

        // Listener handle for storm-update; `start()` attaches.
        this._onStormUpdate = this._onStormUpdate.bind(this);
        this._started = false;
    }

    /** Subscribe to storm-update events. Idempotent. */
    start() {
        if (this._started) return this;
        window.addEventListener('storm-update', this._onStormUpdate);
        this._started = true;
        return this;
    }

    stop() {
        window.removeEventListener('storm-update', this._onStormUpdate);
        this._started = false;
    }

    setVisible(on) {
        this._root.visible = !!on;
    }

    isVisible() { return !!this._root.visible; }

    /**
     * Highlight one storm by id. Pass null to clear (all tracks render
     * at full intensity). The dimmed tracks stay visible so the user
     * keeps their spatial context — they just fade into the background.
     */
    setHighlightedStormId(id) {
        this._highlightedId = id ?? null;
        for (const [trackId, track] of this._tracks) {
            const dim = (this._highlightedId != null) && (trackId !== this._highlightedId);
            this._applyDim(track, dim);
        }
    }

    /** Current scrub-hours setting (0..MAX). Used by tests / debug HUDs. */
    getScrubHours() { return this._scrubHours; }

    /** Manually push storms (useful for tests or pre-feed seeding). */
    setStorms(storms) {
        this._rebuild(storms ?? []);
    }

    /**
     * Place a "where will the storm be at +Nh" dot on every active
     * track. Hour 0 hides every scrubber dot (the eye marker the cloud
     * shader paints already covers "now"). Higher hours interpolate
     * along the great-circle track between bracketing forecast
     * waypoints — see interpolateTrackAtHour() in storm-forecast.js.
     */
    setScrubHours(hours) {
        const h = Math.max(0, hours | 0);
        this._scrubHours = h;
        for (const [, track] of this._tracks) {
            this._refreshScrubMarker(track);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────

    _onStormUpdate(ev) {
        const storms = ev?.detail?.storms ?? [];
        this._rebuild(storms);
    }

    _rebuild(storms) {
        const seen = new Set();
        for (const s of storms) {
            const id = s.id || `${s.basin}-${s.name}-${s.lat?.toFixed(1)}`;
            seen.add(id);
            const fc = this._extrapolate(s);
            if (!fc?.points?.length) {
                // Storm doesn't have enough info for a forecast (e.g.
                // movement_speed=0). Drop any prior track so we don't
                // leave a stale line on the globe.
                this._removeTrack(id);
                continue;
            }
            // Reuse / replace existing geometry. We rebuild rather than
            // mutate vertex buffers because the centerline length can
            // change between updates (a storm with newly-flagged
            // recurvature picks up extra slerp segments).
            this._removeTrack(id);
            this._addTrack(id, s, fc);
        }
        // Drop tracks for storms that disappeared (downgraded /
        // dissipated since the last update).
        for (const id of [...this._tracks.keys()]) {
            if (!seen.has(id)) this._removeTrack(id);
        }
        // Re-apply highlight after rebuild so freshly-built tracks
        // adopt the current dim state.
        if (this._highlightedId != null) this.setHighlightedStormId(this._highlightedId);
    }

    _addTrack(id, storm, fc) {
        const THREE = this._THREE;
        const color = CLASS_COLOR[storm.classification] ?? 0x4faecf;

        // Compose the full centerline waypoint list: current position →
        // each forecast point.
        const waypoints = [
            { lat: +storm.lat, lon: +storm.lon, hour: 0,
              bearing: fc.points[0]
                ? initialBearing(+storm.lat, +storm.lon, fc.points[0].lat, fc.points[0].lon)
                : (storm.movementDir || 0),
              errorNm: 0 },
            ...fc.points,
        ];

        const group = new THREE.Group();
        group.name = `storm-track-${id}`;

        const centerline = this._buildCenterline(waypoints, color);
        const cone       = this._buildCone(waypoints, color);
        const horizons   = this._buildHorizonMarkers(waypoints, color);

        if (centerline) group.add(centerline);
        if (cone)       group.add(cone);
        if (horizons)   group.add(horizons);

        // Scrubber dot — built lazily inside _refreshScrubMarker so
        // when scrubHours=0 we don't allocate a hidden mesh per track.
        const trackEntry = {
            group,
            centerline,
            cone,
            horizons,
            scrub: null,           // { dot, halo } once allocated
            storm,                 // cached for interpolation
            track: fc,             // cached extrapolation result
            classification: storm.classification,
            color,
        };
        this._root.add(group);
        this._tracks.set(id, trackEntry);

        // If the user already had the slider parked at +Nh from a
        // previous mount, surface the dot immediately so the rebuild
        // doesn't lose state.
        if (this._scrubHours > 0) this._refreshScrubMarker(trackEntry);
    }

    _removeTrack(id) {
        const t = this._tracks.get(id);
        if (!t) return;
        this._root.remove(t.group);
        this._disposeRecursive(t.group);
        this._tracks.delete(id);
    }

    _disposeRecursive(obj) {
        obj.traverse?.(child => {
            child.geometry?.dispose?.();
            const m = child.material;
            if (Array.isArray(m)) m.forEach(mm => mm.dispose?.());
            else m?.dispose?.();
        });
    }

    _applyDim(track, dim) {
        const visIntensity = dim ? 0.18 : 1.0;
        if (track.centerline?.material) {
            track.centerline.material.opacity = dim ? 0.20 : 0.85;
            track.centerline.material.transparent = true;
        }
        if (track.cone?.material) {
            track.cone.material.opacity = dim ? 0.06 : 0.22;
        }
        if (track.horizons) {
            track.horizons.traverse(child => {
                if (child.material && 'opacity' in child.material) {
                    child.material.opacity = visIntensity * (child.userData.baseOpacity ?? 1);
                    child.material.transparent = true;
                }
            });
        }
        // Scrubber stays bright on the highlighted track so the
        // "where is this storm at +Nh?" answer never gets faded out.
        if (track.scrub) {
            const baseOpDot  = 1.0;
            const baseOpHalo = 0.45;
            track.scrub.dot.material.opacity  = visIntensity * baseOpDot;
            track.scrub.halo.material.opacity = visIntensity * baseOpHalo;
        }
    }

    /**
     * Build (lazily) and reposition the scrubber dot for one track.
     * Hides the dot when scrubHours is 0 — the cloud shader's eye
     * marker already paints "now," and a second dot at the same point
     * just makes the headline storm look duplicated.
     */
    _refreshScrubMarker(track) {
        if (!track) return;
        const THREE = this._THREE;
        const h = this._scrubHours;

        if (h === 0) {
            if (track.scrub) {
                track.scrub.dot.visible  = false;
                track.scrub.halo.visible = false;
            }
            return;
        }
        if (!this._interpolateAtHour) return;   // helper not provided
        const proj = this._interpolateAtHour({
            storm: track.storm,
            track: track.track,
            hour: h,
        });
        if (!proj) return;

        if (!track.scrub) {
            // Lazy build — first scrub frame for this track. Two
            // meshes: a small bright dot (the answer) and a wider
            // soft halo (so the dot reads at globe scale even when
            // the storm sits in a busy patch of the cone).
            const dotMat = new THREE.MeshBasicMaterial({
                color: track.color,
                transparent: true,
                opacity: 1.0,
                depthWrite: false,
            });
            const haloMat = new THREE.MeshBasicMaterial({
                color: track.color,
                transparent: true,
                opacity: 0.45,
                depthWrite: false,
            });
            const dot  = new THREE.Mesh(this._scrubGeom,     dotMat);
            const halo = new THREE.Mesh(this._scrubHaloGeom, haloMat);
            dot.renderOrder  = 7;
            halo.renderOrder = 6;
            track.group.add(halo);
            track.group.add(dot);
            track.scrub = { dot, halo };
        }

        const pos = this._geoToXYZ(proj.lat, proj.lon)
                        .normalize()
                        .multiplyScalar(R_SCRUB);
        track.scrub.dot.position.copy(pos);
        track.scrub.halo.position.copy(pos);
        track.scrub.dot.visible  = true;
        track.scrub.halo.visible = true;
        // Re-apply dim state in case this track is currently faded —
        // a freshly-built scrub mesh starts at full opacity and would
        // otherwise punch through the dim shroud.
        if (this._highlightedId != null) {
            const highlighted = this._tracks.get(this._highlightedId);
            if (highlighted && highlighted !== track) this._applyDim(track, true);
        }
    }

    // ── Geometry builders ─────────────────────────────────────────────

    /**
     * Subdivided great-circle polyline through the waypoints. Returns a
     * THREE.Line with computed line distances so the dashed material
     * actually shows dashes — without computeLineDistances() the dashes
     * silently render as a solid line.
     */
    _buildCenterline(waypoints, color) {
        if (waypoints.length < 2) return null;
        const THREE = this._THREE;
        const positions = [];

        for (let i = 0; i < waypoints.length - 1; i++) {
            const a = this._geoToXYZ(waypoints[i].lat,     waypoints[i].lon).normalize();
            const b = this._geoToXYZ(waypoints[i + 1].lat, waypoints[i + 1].lon).normalize();
            const segs = SEGMENTS_PER_EDGE;
            for (let k = 0; k < segs; k++) {
                const t = k / segs;
                const v = slerpUnit(THREE, a, b, t).multiplyScalar(R_CENTERLINE);
                positions.push(v.x, v.y, v.z);
            }
        }
        // Final endpoint — without it the last forecast point is missed
        // by half a sub-segment.
        const last = this._geoToXYZ(waypoints[waypoints.length - 1].lat,
                                    waypoints[waypoints.length - 1].lon)
                          .normalize().multiplyScalar(R_CENTERLINE);
        positions.push(last.x, last.y, last.z);

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const mat = new THREE.LineDashedMaterial({
            color,
            dashSize: CENTERLINE_DASH_SIZE,
            gapSize:  CENTERLINE_GAP_SIZE,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
        });
        const line = new THREE.Line(geom, mat);
        line.computeLineDistances();
        return line;
    }

    /**
     * Cone fill — triangle strip between two arrays of edge points.
     * Each waypoint contributes one left and one right offset along
     * the perpendicular to its great-circle bearing, scaled by the
     * NHC error radius at that horizon. The current position
     * contributes a single shared apex (errorNm = 0) so the cone
     * narrows to a sharp point at the storm's eye.
     */
    _buildCone(waypoints, color) {
        if (waypoints.length < 2) return null;
        const THREE = this._THREE;

        const left = [];
        const right = [];

        for (let i = 0; i < waypoints.length; i++) {
            const w = waypoints[i];
            // For the apex (i=0) we don't have a meaningful bearing
            // until we look ahead; use the first segment's bearing.
            const bearing = w.bearing
                ?? (i + 1 < waypoints.length
                    ? initialBearing(w.lat, w.lon, waypoints[i + 1].lat, waypoints[i + 1].lon)
                    : 0);
            // The apex (errorNm = 0) collapses left==right==center, so
            // the strip's first triangle is degenerate — that's fine,
            // it simply produces a sharp tip.
            const r = w.errorNm || 0;
            const lp = destinationPoint(w.lat, w.lon, (bearing - 90 + 360) % 360, r);
            const rp = destinationPoint(w.lat, w.lon, (bearing + 90)        % 360, r);
            left .push(this._geoToXYZ(lp.lat, lp.lon).normalize().multiplyScalar(R_CONE));
            right.push(this._geoToXYZ(rp.lat, rp.lon).normalize().multiplyScalar(R_CONE));
        }

        // Triangle strip layout: alternate left[i], right[i].
        // Triangles built as (L0, R0, L1), (R0, L1, R1), ...
        const positions = [];
        const indices   = [];
        for (let i = 0; i < left.length; i++) {
            positions.push(left[i].x,  left[i].y,  left[i].z);
            positions.push(right[i].x, right[i].y, right[i].z);
        }
        for (let i = 0; i < left.length - 1; i++) {
            const l0 = i * 2, r0 = i * 2 + 1, l1 = (i + 1) * 2, r1 = (i + 1) * 2 + 1;
            indices.push(l0, r0, l1);
            indices.push(r0, r1, l1);
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geom.setIndex(indices);
        // No need to compute normals — the material is unshaded.

        const mat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            side: THREE.DoubleSide,   // doublesided so we don't have to care about winding at the apex
            blending: THREE.NormalBlending,
        });

        return new THREE.Mesh(geom, mat);
    }

    /**
     * Day markers — small spheres at the +24/+48/+72/+96/+120 horizons.
     * Each carries a baseOpacity in userData so the dim-fade respects
     * the marker's natural strength (later horizons are more uncertain
     * and intentionally rendered fainter).
     */
    _buildHorizonMarkers(waypoints, color) {
        const THREE = this._THREE;
        const group = new THREE.Group();
        const HOUR_LABEL_DAY = { 24: 1, 48: 2, 72: 3, 96: 4, 120: 5 };
        const sharedGeom = new THREE.SphereGeometry(0.0035, 8, 8);

        for (const w of waypoints) {
            if (!HOUR_LABEL_DAY[w.hour]) continue;
            const day = HOUR_LABEL_DAY[w.hour];
            // Opacity tapers with day — D1 punchy, D5 gentle, mirroring
            // the forecast confidence curve.
            const baseOpacity = 1.0 - (day - 1) * 0.13;
            const mat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: baseOpacity,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(sharedGeom, mat);
            const pos = this._geoToXYZ(w.lat, w.lon).normalize().multiplyScalar(R_HORIZON);
            mesh.position.copy(pos);
            mesh.userData.baseOpacity = baseOpacity;
            mesh.userData.day         = day;
            group.add(mesh);
        }
        return group;
    }
}

export default StormTrackOverlay;
export { CLASS_COLOR };
