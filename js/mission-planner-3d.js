/**
 * mission-planner-3d.js — Visual mission-planner simulator with patched-conic
 * trajectories.
 *
 * Two scenes share a renderer + canvas:
 *
 *   geoScene   Earth-centered. 1 unit = 1 R⊕. Renders Earth, atmosphere,
 *              starfield, launch sites, near-Earth payloads (LEO/SSO/MEO/
 *              GEO), and the full lunar-transfer trajectory: parking
 *              orbit → transfer ellipse → lunar SOI → captured lunar orbit.
 *
 *   helioScene Sun-centered. 1 unit = AU_SCALE units. Renders the Sun,
 *              the inner-planet orbit rings, planets at live ephemeris
 *              positions, and the heliocentric Hohmann arc for Mars
 *              transfers, with proper Kepler-equation timing.
 *
 * The active mode is a string ('geo' | 'helio') and switches automatically
 * whenever the user launches a mission whose target lives in the other
 * frame (Mars ⇒ helio, Moon and lower ⇒ geo). Manual override exposed via
 * `setMode()`.
 *
 * All trajectory math comes from `mission-planner-trajectory.js`; this
 * file deals only with rendering + animation.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    jdNow, moonGeocentric, earthHeliocentric, marsHeliocentric,
    mercuryHeliocentric, venusHeliocentric,
} from './horizons.js';
import {
    KM_PER_AU, R_EARTH, R_MOON, SOI_MOON, SOI_MARS, SECONDS_PER_DAY,
    R_EARTH_HELIO, R_MARS_HELIO,
    planLunarTransfer, planMarsTransfer,
    findLunarLaunchWindow, findMarsLaunchWindow,
    hohmannPositionAt,
} from './mission-planner-trajectory.js';

// ── Scene scales ────────────────────────────────────────────────────────────
const GEO_UNIT_KM   = R_EARTH;          // 1 scene unit = 1 R⊕ in geo scene
const HELIO_UNIT_AU = 4.0;              // 1 AU = 4 scene units in helio scene
const MOON_R_SCENE  = R_MOON / GEO_UNIT_KM;
const SOI_MOON_SCENE = SOI_MOON / GEO_UNIT_KM;

// ── Launch sites ────────────────────────────────────────────────────────────
export const LAUNCH_SITES = [
    { id: 'ksc',     name: 'Kennedy SC (USA)',     lat: 28.573, lon: -80.649 },
    { id: 'baikonur',name: 'Baikonur (KAZ)',       lat: 45.965, lon:  63.305 },
    { id: 'kourou',  name: 'Kourou (FRA)',         lat:  5.236, lon: -52.768 },
    { id: 'starbase',name: 'Starbase (USA)',       lat: 25.997, lon: -97.155 },
    { id: 'wenchang',name: 'Wenchang (CHN)',       lat: 19.614, lon: 110.951 },
    { id: 'vandy',   name: 'Vandenberg (USA)',     lat: 34.742, lon:-120.572 },
];

export const TARGET_ORBITS = [
    { id: 'leo',  name: 'LEO · 400 km',           alt_km:    400,                         frame: 'geo' },
    { id: 'sso',  name: 'SSO · 600 km',           alt_km:    600, inc_deg: 97.8,          frame: 'geo' },
    { id: 'meo',  name: 'MEO · 20 200 km (GPS)',  alt_km:  20200, inc_deg: 55,            frame: 'geo' },
    { id: 'geo',  name: 'GEO · 35 786 km',        alt_km:  35786, inc_deg: 0,             frame: 'geo' },
    { id: 'moon', name: 'Lunar transfer (TLI)',   alt_km: 384400,                         frame: 'geo',   isTransfer: 'moon' },
    { id: 'mars', name: 'Mars transfer (TMI)',    alt_km: 78340000,                       frame: 'helio', isTransfer: 'mars' },
];

const DEG = Math.PI / 180;

// ── Math helpers ────────────────────────────────────────────────────────────
function latLonToVec3(latDeg, lonDeg, r = 1) {
    const phi    = latDeg * DEG;
    const lambda = lonDeg * DEG;
    return new THREE.Vector3(
        r * Math.cos(phi) * Math.cos(lambda),
        r * Math.sin(phi),
        -r * Math.cos(phi) * Math.sin(lambda),
    );
}

// Convert ecliptic (lon_rad, lat_rad, dist_units) → THREE.Vector3 in our scene
// convention (+Y = ecliptic normal, ecliptic in XZ plane).
function eclipticToVec3(lon_rad, lat_rad, r) {
    const cl = Math.cos(lat_rad);
    return new THREE.Vector3(
        r * cl * Math.cos(lon_rad),
        r * Math.sin(lat_rad),
       -r * cl * Math.sin(lon_rad),
    );
}

function easeInOutCubic(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }

// ── Public init ─────────────────────────────────────────────────────────────
export function initMissionPlanner({ container, onEvent } = {}) {
    if (!container) throw new Error('initMissionPlanner: container required');

    const w = () => container.clientWidth  || 800;
    const h = () => container.clientHeight || 520;

    // Shared renderer.
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w(), h());
    container.appendChild(renderer.domElement);

    // ── Geo scene ───────────────────────────────────────────────────────────
    const geo = buildGeoScene(renderer, w(), h());

    // ── Helio scene ─────────────────────────────────────────────────────────
    const hel = buildHelioScene(renderer, w(), h());

    // ── State ───────────────────────────────────────────────────────────────
    const state = {
        site:       LAUNCH_SITES[0],
        target:     TARGET_ORBITS[0],
        mode:       'geo',
        rockets:    [],   // active geo-frame ascent vehicles
        payloads:   [],   // deployed near-Earth orbiters (geo frame)
        lunarMissions: [],// active lunar transfers (geo frame)
        marsMissions:  [],// active Mars transfers (helio frame)
        clock:      new THREE.Clock(),
        elapsed:    0,
        timeScale:  1,
        // Days-per-second of "compressed" simulation time used for the
        // helio + lunar trajectories. Lunar TOF ≈ 5d → ~5s of wall time
        // at 1× when simDays = 1; Mars TOF ≈ 259d → ~26s wall at 10×.
        simDaysPerSec: 1,
        // Live ephemeris JD that drives planet positions in helio scene.
        scenarioJD: jdNow(),
    };

    // Surface markers
    for (const s of LAUNCH_SITES) {
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.018, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffaa33 }),
        );
        dot.position.copy(latLonToVec3(s.lat, s.lon, 1.005));
        geo.scene.add(dot);
    }

    // ── Mode switch ─────────────────────────────────────────────────────────
    function setMode(mode) {
        if (mode !== 'geo' && mode !== 'helio') return;
        state.mode = mode;
        onEvent?.({ type: 'mode', mode });
    }

    // ── Public API: launch ──────────────────────────────────────────────────
    function launch({ siteId, targetId, payloadName = 'PayloadSat-1', windowJD = null }) {
        const site   = LAUNCH_SITES.find(s => s.id === siteId)   || state.site;
        const target = TARGET_ORBITS.find(t => t.id === targetId) || state.target;
        state.site   = site;
        state.target = target;

        // Auto-switch view to the target's frame.
        if (target.frame !== state.mode) setMode(target.frame);

        if (target.id === 'moon') {
            return launchLunar({ site, target, payloadName, windowJD });
        }
        if (target.id === 'mars') {
            return launchMars({ site, target, payloadName, windowJD });
        }
        return launchNearEarth({ site, target, payloadName });
    }

    // ── Near-Earth launch (LEO/SSO/MEO/GEO) — geo frame ─────────────────────
    function launchNearEarth({ site, target, payloadName }) {
        const startPos = latLonToVec3(site.lat, site.lon, 1.0);
        const inc      = (target.inc_deg ?? Math.abs(site.lat));
        const altScene = (target.alt_km / GEO_UNIT_KM);
        const rOrbit   = 1 + altScene;

        const ascNode  = new THREE.Vector3(startPos.x, 0, startPos.z).normalize();
        const eastAxis = ascNode.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
        const planeNormal = new THREE.Vector3(0, 1, 0)
            .applyAxisAngle(eastAxis, inc * DEG).normalize();

        const rocket = makeRocket(geo.scene);
        const trail  = makeTrail(geo.scene, 600, 0xffaa33, 0.85);

        const r = {
            kind: 'near', group: rocket, ...trail,
            site, target, payloadName,
            startPos, ascNode, planeNormal, rOrbit, inc,
            startedAt: state.elapsed, ascentDur: 6.0,
            phase: 'ascent',
        };
        state.rockets.push(r);
        onEvent?.({ type: 'launched', site, target, payloadName });
        return r;
    }

    // ── Lunar transfer (geo frame, real patched conic) ──────────────────────
    function launchLunar({ site, target, payloadName, windowJD }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const plan = planLunarTransfer({ jd_depart });

        // Geometry: place the transfer ellipse in the Earth-Moon orbital plane.
        // For visual simplicity we use the ecliptic plane (Y-up, ellipse in XZ).
        // Periapsis direction = opposite of where the Moon will be at arrival.
        const moonArrPos = eclipticToVec3(
            plan.moon_at_arrival.lon_rad,
            plan.moon_at_arrival.lat_rad,
            plan.r_moon_km / GEO_UNIT_KM,
        );
        const apoDir   = moonArrPos.clone().normalize();
        const periDir  = apoDir.clone().multiplyScalar(-1);
        // Plane normal = approx ecliptic normal +Y (Moon's orbit is ~5° off
        // ecliptic, fine for a visual planner).
        const planeNormal = new THREE.Vector3(0, 1, 0);
        const inPlaneSide = planeNormal.clone().cross(periDir).normalize();

        // Parking orbit (small ring tangent to the transfer at periapsis).
        const r_park_scene = plan.r_park_km / GEO_UNIT_KM;
        const parkRing = makeOrbitRingFromBasis(
            r_park_scene, periDir, inPlaneSide, 0xffcc66, 0.55,
        );
        geo.scene.add(parkRing);

        // Transfer ellipse (full 360° for visual reference, but we only fly
        // periapsis → apoapsis = 0..π in true anomaly).
        const ellLine = makeEllipseFromBasis(
            plan.ellipse.a_km / GEO_UNIT_KM,
            plan.ellipse.e,
            periDir, inPlaneSide,
            0x66ddff, 0.85, /* dashed */ true,
        );
        geo.scene.add(ellLine);

        // Lunar SOI sphere (wireframe at arrival point).
        const soiMesh = new THREE.Mesh(
            new THREE.SphereGeometry(SOI_MOON_SCENE, 24, 16),
            new THREE.MeshBasicMaterial({
                color: 0x66ffaa, wireframe: true, transparent: true, opacity: 0.18,
            }),
        );
        soiMesh.position.copy(apoDir.clone().multiplyScalar(plan.r_moon_km / GEO_UNIT_KM));
        geo.scene.add(soiMesh);

        // Spacecraft + trail.
        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.04, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffeecc }),
        );
        geo.scene.add(craft);
        const trail = makeTrail(geo.scene, 800, 0x66ddff, 0.7);

        const m = {
            kind: 'lunar',
            plan,
            craft, ellLine, parkRing, soiMesh,
            ...trail,
            periDir, inPlaneSide, apoDir, planeNormal,
            startedAt:  state.elapsed,
            // Compress TOF: real ~5 days → 8 s of wall time at 1×.
            durSec:     8,
            phase:      'ascent',
            ascentDur:  3,
            payloadName,
            site, target,
            captureRing: null,   // built when we cross SOI
            crashCheck:  false,
        };
        state.lunarMissions.push(m);

        onEvent?.({ type: 'launched-lunar', site, target, payloadName, plan });
        return m;
    }

    // ── Mars transfer (helio frame, real patched conic) ─────────────────────
    function launchMars({ site, target, payloadName, windowJD }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const plan = planMarsTransfer({ jd_depart });

        // Heliocentric departure & arrival positions of Earth and Mars.
        const eDep = eclipticToVec3(
            plan.earth_at_departure.lon_rad,
            plan.earth_at_departure.lat_rad,
            plan.earth_at_departure.dist_AU * HELIO_UNIT_AU,
        );
        const mArr = eclipticToVec3(
            plan.mars_at_arrival.lon_rad,
            plan.mars_at_arrival.lat_rad,
            R_MARS_HELIO / KM_PER_AU * HELIO_UNIT_AU,
        );

        // Hohmann ellipse: focus at Sun (origin), periapsis at Earth-departure
        // direction, apoapsis at Mars-arrival direction (which is 180° around
        // the Sun by construction of a Hohmann transfer).
        const periDir = eDep.clone().setY(0).normalize();
        // True apoapsis direction = -periDir (Hohmann is symmetric). We use
        // the actual Mars arrival direction for the SOI marker.
        const planeNormal = new THREE.Vector3(0, 1, 0);
        const inPlaneSide = planeNormal.clone().cross(periDir).normalize();

        const a_scene = plan.ellipse.a_km / KM_PER_AU * HELIO_UNIT_AU;
        const ellLine = makeEllipseFromBasis(
            a_scene, plan.ellipse.e,
            periDir, inPlaneSide,
            0xff8855, 0.9, /* dashed */ true,
        );
        hel.scene.add(ellLine);

        // Mars SOI sphere at arrival point.
        const soiScene = SOI_MARS / KM_PER_AU * HELIO_UNIT_AU;
        const soiMesh = new THREE.Mesh(
            new THREE.SphereGeometry(soiScene, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xff7755, wireframe: true,
                transparent: true, opacity: 0.25 }),
        );
        soiMesh.position.copy(mArr);
        hel.scene.add(soiMesh);

        // Spacecraft + trail.
        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.05, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffeecc }),
        );
        hel.scene.add(craft);
        const trail = makeTrail(hel.scene, 1200, 0xff8855, 0.7);

        const m = {
            kind: 'mars',
            plan,
            craft, ellLine, soiMesh,
            ...trail,
            periDir, inPlaneSide, planeNormal,
            startedAt:  state.elapsed,
            durSec:     30,            // wall-clock seconds for full TOF at 1× speed
            phase:      'cruise',
            payloadName,
            site, target,
        };
        state.marsMissions.push(m);

        onEvent?.({ type: 'launched-mars', site, target, payloadName, plan });
        return m;
    }

    // ── Update loop ─────────────────────────────────────────────────────────
    function tick() {
        const dt = state.clock.getDelta() * state.timeScale;
        state.elapsed += dt;
        state.scenarioJD += dt * state.simDaysPerSec;

        if (state.mode === 'geo') {
            updateGeo(dt);
            geo.controls.update();
            renderer.render(geo.scene, geo.camera);
        } else {
            updateHelio(dt);
            hel.controls.update();
            renderer.render(hel.scene, hel.camera);
        }
        requestAnimationFrame(tick);
    }

    function updateGeo(dt) {
        // Earth rotation
        geo.earth.rotation.y += dt * 0.04;
        geo.grid.rotation.y   = geo.earth.rotation.y;

        // Live Moon position from ephemeris (slowed): drift the moon along
        // its real angular rate, anchored to scenarioJD.
        const moonNow = moonGeocentric(state.scenarioJD);
        geo.moon.position.copy(eclipticToVec3(
            moonNow.lon_rad, moonNow.lat_rad,
            moonNow.dist_km / GEO_UNIT_KM,
        ));

        // ── Near-Earth ascent rockets ───────────────────────────────────────
        for (const r of state.rockets) {
            if (r.phase !== 'ascent') continue;
            const t = state.elapsed - r.startedAt;
            const u = Math.min(1, t / r.ascentDur);
            const radius = 1 + (r.rOrbit - 1) * easeInOutCubic(u);
            const dir = r.ascNode.clone().applyAxisAngle(r.planeNormal, u * Math.PI/2 * 0.85);
            const pos = dir.multiplyScalar(radius);
            r.group.position.copy(pos);
            const up = pos.clone().normalize();
            const tangent = r.ascNode.clone().applyAxisAngle(r.planeNormal, u*Math.PI/2 + 0.001).sub(
                r.ascNode.clone().applyAxisAngle(r.planeNormal, u*Math.PI/2)
            ).normalize();
            r.group.lookAt(pos.clone().add(tangent.add(up.multiplyScalar(0.4))));
            r.group.rotateX(Math.PI/2);
            pushTrail(r, pos);
            if (u >= 1) {
                r.phase = 'deployed';
                deployNearEarthPayload(r);
            }
        }

        // ── Near-Earth deployed payloads ────────────────────────────────────
        for (const p of state.payloads) {
            p.theta += dt * p.omega;
            const dir = p.ascNode.clone().applyAxisAngle(p.planeNormal, p.theta);
            p.mesh.position.copy(dir.multiplyScalar(p.r));
            pushOrbitTrail(p);
        }

        // ── Lunar missions ──────────────────────────────────────────────────
        for (const m of state.lunarMissions) {
            const t = state.elapsed - m.startedAt;

            if (m.phase === 'ascent') {
                // Quick visual ascent from launch site to the parking orbit
                // periapsis (which sits along periDir at r_park_scene).
                const u = Math.min(1, t / m.ascentDur);
                const start = latLonToVec3(m.site.lat, m.site.lon, 1.0);
                const end   = m.periDir.clone().multiplyScalar(m.plan.r_park_km / GEO_UNIT_KM);
                const pos   = start.clone().lerp(end, easeInOutCubic(u));
                m.craft.position.copy(pos);
                pushTrail(m, pos);
                if (u >= 1) {
                    m.phase = 'transfer';
                    m.transferStart = state.elapsed;
                }
                continue;
            }

            if (m.phase === 'transfer') {
                const u = Math.min(1, (state.elapsed - m.transferStart) / m.durSec);
                // Kepler position on the ellipse.
                const a_scene = m.plan.ellipse.a_km / GEO_UNIT_KM;
                const e       = m.plan.ellipse.e;
                const p2d     = hohmannPositionAt(u, a_scene, e);
                // Convert (x, y) in periDir/inPlaneSide basis to scene XYZ.
                // x along +periDir, y along +inPlaneSide.
                // BUT focus is at Sun/Earth = origin; periDir points OUT to
                // periapsis. The Hohmann formula above puts periapsis at +x,
                // apoapsis at -x. Spacecraft starts at periapsis and ends at
                // -2a + rp ≈ apoapsis. So position = periDir·x + side·y.
                const pos = m.periDir.clone().multiplyScalar(p2d.x)
                    .add(m.inPlaneSide.clone().multiplyScalar(p2d.y));
                m.craft.position.copy(pos);
                pushTrail(m, pos);

                // Detect SOI entry.
                const distToMoon = pos.distanceTo(m.soiMesh.position);
                if (distToMoon <= SOI_MOON_SCENE && !m.captureRing) {
                    captureLunar(m);
                }

                if (u >= 1) {
                    m.phase = 'captured';
                    if (!m.captureRing) captureLunar(m);
                }
                continue;
            }

            if (m.phase === 'captured') {
                // Spacecraft circulates around the (moving) Moon at r_capt.
                m.captureTheta = (m.captureTheta || 0) + dt * (m.captureOmega || 1.2);
                const local = m.capturePeri.clone()
                    .applyAxisAngle(m.planeNormal, m.captureTheta)
                    .multiplyScalar(m.plan.r_capt_km / GEO_UNIT_KM);
                m.craft.position.copy(geo.moon.position.clone().add(local));
                // Move the capture ring to follow the Moon.
                m.captureRing.position.copy(geo.moon.position);
            }
        }
    }

    function captureLunar(m) {
        m.captureRing = makeOrbitRingFromBasis(
            m.plan.r_capt_km / GEO_UNIT_KM,
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 0, 1),
            0xffeecc, 0.85,
        );
        m.captureRing.position.copy(geo.moon.position);
        geo.scene.add(m.captureRing);
        m.capturePeri    = new THREE.Vector3(1, 0, 0);
        m.captureTheta   = 0;
        // visual angular speed (rad/sec at 1× timeScale): pick something snappy
        m.captureOmega   = 1.6;
        onEvent?.({
            type: 'lunar-captured',
            payloadName: m.payloadName,
            plan: m.plan,
        });
    }

    function updateHelio(dt) {
        // Sun spin (purely cosmetic).
        hel.sun.rotation.y += dt * 0.04;

        // Update planet positions from live ephemeris at scenarioJD.
        const eVec = earthHeliocentric(state.scenarioJD);
        const mVec = marsHeliocentric(state.scenarioJD);
        const meVec = mercuryHeliocentric(state.scenarioJD);
        const vVec  = venusHeliocentric(state.scenarioJD);
        hel.earth.position.copy(eclipticToVec3(eVec.lon_rad, eVec.lat_rad, eVec.dist_AU * HELIO_UNIT_AU));
        hel.mars.position.copy (eclipticToVec3(mVec.lon_rad, mVec.lat_rad, mVec.dist_AU * HELIO_UNIT_AU));
        hel.mercury.position.copy(eclipticToVec3(meVec.lon_rad, meVec.lat_rad, meVec.dist_AU * HELIO_UNIT_AU));
        hel.venus.position.copy  (eclipticToVec3(vVec.lon_rad,  vVec.lat_rad,  vVec.dist_AU  * HELIO_UNIT_AU));

        // Mars missions
        for (const m of state.marsMissions) {
            if (m.phase !== 'cruise') continue;
            const u = Math.min(1, (state.elapsed - m.startedAt) / m.durSec);
            const a_scene = m.plan.ellipse.a_km / KM_PER_AU * HELIO_UNIT_AU;
            const e       = m.plan.ellipse.e;
            const p2d     = hohmannPositionAt(u, a_scene, e);
            const pos = m.periDir.clone().multiplyScalar(p2d.x)
                .add(m.inPlaneSide.clone().multiplyScalar(p2d.y));
            m.craft.position.copy(pos);
            pushTrail(m, pos);
            if (u >= 1) {
                m.phase = 'arrived';
                onEvent?.({ type: 'mars-captured', payloadName: m.payloadName, plan: m.plan });
            }
        }
    }

    function deployNearEarthPayload(r) {
        const p = new THREE.Mesh(
            new THREE.SphereGeometry(0.025, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0x66ffaa }),
        );
        geo.scene.add(p);
        const ring = makeOrbitRingFromBasis(
            r.rOrbit, r.ascNode,
            r.ascNode.clone().applyAxisAngle(r.planeNormal, Math.PI/2),
            0x66ffaa, 0.4,
        );
        geo.scene.add(ring);
        const trailGeom = new THREE.BufferGeometry();
        trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(400*3), 3));
        trailGeom.setDrawRange(0, 0);
        const trail = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({
            color: 0x66ffaa, transparent: true, opacity: 0.6,
        }));
        geo.scene.add(trail);

        const r_km = r.target.alt_km + R_EARTH;
        const period_s = 2 * Math.PI * Math.sqrt(Math.pow(r_km, 3) / 398600.4418);
        const visualPeriod = Math.max(4, Math.min(45, period_s / 900));
        const omega = (2 * Math.PI) / visualPeriod;

        state.payloads.push({
            mesh: p, ring,
            trail, trailGeom, trailIndex: 0,
            r: r.rOrbit, theta: 0, omega,
            ascNode: r.ascNode.clone(),
            planeNormal: r.planeNormal.clone(),
            payloadName: r.payloadName,
            target: r.target,
        });

        onEvent?.({
            type: 'deployed',
            payloadName: r.payloadName,
            target: r.target,
            orbit: {
                alt_km: r.target.alt_km,
                inc_deg: r.inc,
                period_min: period_s / 60,
                v_circ_kms: Math.sqrt(398600.4418 / r_km),
            },
        });
    }

    // ── Trail helpers (shared) ──────────────────────────────────────────────
    function makeTrail(scene, capacity, color, opacity) {
        const trailGeom = new THREE.BufferGeometry();
        trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity*3), 3));
        trailGeom.setDrawRange(0, 0);
        const trail = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({
            color, transparent: true, opacity,
        }));
        scene.add(trail);
        return { trail, trailGeom, trailIndex: 0, trailCap: capacity };
    }

    function pushTrail(obj, pos) {
        const i = obj.trailIndex;
        if (i >= obj.trailCap) return;
        const arr = obj.trailGeom.attributes.position.array;
        arr[i*3+0] = pos.x; arr[i*3+1] = pos.y; arr[i*3+2] = pos.z;
        obj.trailIndex = i + 1;
        obj.trailGeom.setDrawRange(0, obj.trailIndex);
        obj.trailGeom.attributes.position.needsUpdate = true;
    }

    function pushOrbitTrail(p) {
        const N = p.trailGeom.attributes.position.array.length / 3;
        const i = p.trailIndex % N;
        const arr = p.trailGeom.attributes.position.array;
        arr[i*3+0] = p.mesh.position.x;
        arr[i*3+1] = p.mesh.position.y;
        arr[i*3+2] = p.mesh.position.z;
        p.trailIndex++;
        p.trailGeom.setDrawRange(0, Math.min(p.trailIndex, N));
        p.trailGeom.attributes.position.needsUpdate = true;
    }

    // ── Resize ──────────────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
        const cw = w(), ch = h();
        renderer.setSize(cw, ch);
        geo.camera.aspect = cw / ch; geo.camera.updateProjectionMatrix();
        hel.camera.aspect = cw / ch; hel.camera.updateProjectionMatrix();
    });
    ro.observe(container);

    requestAnimationFrame(tick);

    return {
        launch,
        setMode,
        getMode: () => state.mode,
        setTimeScale: (x) => { state.timeScale = Math.max(0, Math.min(50, x)); },
        getTimeScale: () => state.timeScale,
        setSimDaysPerSec: (x) => { state.simDaysPerSec = Math.max(0, x); },
        clear: () => clearAll(state, geo, hel),
        focusEarth: () => {
            geo.controls.target.set(0, 0, 0);
            geo.camera.position.set(3.5, 2.4, 4.6);
        },
        focusMoon: () => {
            geo.controls.target.copy(geo.moon.position);
            geo.camera.position.set(geo.moon.position.x*1.05, 8, geo.moon.position.z*1.05 + 8);
        },
        focusSun: () => {
            hel.controls.target.set(0, 0, 0);
            hel.camera.position.set(0, 4 * HELIO_UNIT_AU, 4 * HELIO_UNIT_AU);
        },
        getStats: () => ({
            rockets:        state.rockets.length,
            payloads:       state.payloads.length,
            lunarMissions:  state.lunarMissions.length,
            marsMissions:   state.marsMissions.length,
        }),
        getScenarioJD: () => state.scenarioJD,
        setScenarioJD: (jd) => { state.scenarioJD = jd; },
        // Trajectory planners — also useful from the UI for read-only previews.
        planLunar: planLunarTransfer,
        planMars:  planMarsTransfer,
        findLunarWindow: findLunarLaunchWindow,
        findMarsWindow:  findMarsLaunchWindow,
    };
}

// ── Scene builders ──────────────────────────────────────────────────────────

function buildGeoScene(renderer, w, h) {
    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x05030f);

    const camera = new THREE.PerspectiveCamera(45, w/h, 0.05, 5000);
    camera.position.set(3.5, 2.4, 4.6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 1.4;    controls.maxDistance = 200;

    scene.add(new THREE.AmbientLight(0x404060, 0.55));
    const sun = new THREE.DirectionalLight(0xffeec8, 1.1);
    sun.position.set(8, 4, 5); scene.add(sun);

    addStarfield(scene, 1500, 600);

    const earth = new THREE.Mesh(
        new THREE.SphereGeometry(1, 64, 48),
        new THREE.MeshPhongMaterial({
            color: 0x2a4f8e, emissive: 0x0a1830, emissiveIntensity: 0.4,
            shininess: 18, specular: 0x4488cc,
        }),
    );
    scene.add(earth);

    const grid = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(1.001, 18, 12)),
        new THREE.LineBasicMaterial({ color: 0x335577, transparent: true, opacity: 0.18 }),
    );
    scene.add(grid);

    const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(1.04, 48, 32),
        new THREE.MeshBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.08, side: THREE.BackSide }),
    );
    scene.add(atmo);

    const moon = new THREE.Mesh(
        new THREE.SphereGeometry(MOON_R_SCENE, 32, 24),
        new THREE.MeshPhongMaterial({ color: 0xb8b8b8, emissive: 0x333333 }),
    );
    scene.add(moon);

    // Reference lunar-orbit ring (mean distance, equatorial — purely visual).
    const moonRingMean = makeRingLine(384400 / R_EARTH, 0x444466, 0.35);
    scene.add(moonRingMean);

    return { scene, camera, controls, earth, grid, atmo, moon };
}

function buildHelioScene(renderer, w, h) {
    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x010108);

    const camera = new THREE.PerspectiveCamera(40, w/h, 0.05, 1e5);
    camera.position.set(0, 5 * HELIO_UNIT_AU, 5 * HELIO_UNIT_AU);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 0.5;    controls.maxDistance = 200;

    scene.add(new THREE.AmbientLight(0x202028, 0.6));

    addStarfield(scene, 2000, 500);

    // Sun
    const sun = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 32, 24),
        new THREE.MeshBasicMaterial({ color: 0xffcc55 }),
    );
    scene.add(sun);
    const sunGlow = new THREE.Mesh(
        new THREE.SphereGeometry(0.36, 24, 18),
        new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.18, side: THREE.BackSide }),
    );
    scene.add(sunGlow);
    const sunLight = new THREE.PointLight(0xffeec8, 1.2, 0, 0);
    scene.add(sunLight);

    // Inner-planet orbit rings
    const orbits = [
        { r: 0.387 * HELIO_UNIT_AU, color: 0x886655 }, // Mercury
        { r: 0.723 * HELIO_UNIT_AU, color: 0xc8b88a }, // Venus
        { r: 1.000 * HELIO_UNIT_AU, color: 0x4488cc }, // Earth
        { r: 1.524 * HELIO_UNIT_AU, color: 0xc05530 }, // Mars
    ];
    for (const o of orbits) {
        scene.add(makeRingLine(o.r, o.color, 0.55));
    }

    const mercury = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshPhongMaterial({ color: 0xaa9988, emissive: 0x222222 }));
    const venus   = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshPhongMaterial({ color: 0xe7c987, emissive: 0x332211 }));
    const earth   = new THREE.Mesh(new THREE.SphereGeometry(0.08, 20, 14), new THREE.MeshPhongMaterial({ color: 0x4f8fe0, emissive: 0x112244 }));
    const mars    = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshPhongMaterial({ color: 0xc0552d, emissive: 0x331100 }));
    scene.add(mercury, venus, earth, mars);

    return { scene, camera, controls, sun, sunGlow, mercury, venus, earth, mars };
}

function addStarfield(scene, N, R) {
    const pos = new Float32Array(N*3);
    for (let i=0; i<N; i++) {
        const u = Math.random()*2 - 1;
        const t = Math.random()*Math.PI*2;
        const s = Math.sqrt(1 - u*u);
        pos[i*3+0] = R * s * Math.cos(t);
        pos[i*3+1] = R * u;
        pos[i*3+2] = R * s * Math.sin(t);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
        color: 0xffffff, size: 0.55, sizeAttenuation: false, transparent: true, opacity: 0.7,
    })));
}

function makeRingLine(radius, color, opacity) {
    const N = 256;
    const pos = new Float32Array(N*3);
    for (let i=0; i<N; i++) {
        const a = (i / (N-1)) * Math.PI * 2;
        pos[i*3+0] = radius * Math.cos(a);
        pos[i*3+1] = 0;
        pos[i*3+2] = radius * Math.sin(a);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

// Orbit ring of given radius in a plane spanned by (uHat, vHat).
function makeOrbitRingFromBasis(radius, uHat, vHat, color, opacity) {
    const N = 256;
    const pos = new Float32Array(N*3);
    const u = uHat.clone().normalize();
    const v = vHat.clone().normalize();
    for (let i=0; i<N; i++) {
        const a = (i / (N-1)) * Math.PI * 2;
        const p = u.clone().multiplyScalar(radius * Math.cos(a))
            .add(v.clone().multiplyScalar(radius * Math.sin(a)));
        pos[i*3+0] = p.x; pos[i*3+1] = p.y; pos[i*3+2] = p.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

// Full Kepler ellipse (focus at origin, periapsis along +periHat) sampled
// over true anomaly. dashed=true uses LineDashedMaterial.
function makeEllipseFromBasis(a, e, periHat, sideHat, color, opacity, dashed = false) {
    const N = 256;
    const pos = new Float32Array(N*3);
    const p   = a * (1 - e*e);
    const periN = periHat.clone().normalize();
    const sideN = sideHat.clone().normalize();
    for (let i=0; i<N; i++) {
        const nu = (i / (N-1)) * Math.PI * 2;
        const r  = p / (1 + e * Math.cos(nu));
        const v  = periN.clone().multiplyScalar(r * Math.cos(nu))
            .add(sideN.clone().multiplyScalar(r * Math.sin(nu)));
        pos[i*3+0] = v.x; pos[i*3+1] = v.y; pos[i*3+2] = v.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = dashed
        ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.28, gapSize: 0.18 })
        : new THREE.LineBasicMaterial ({ color, transparent: true, opacity });
    const line = new THREE.LineLoop(g, mat);
    if (dashed) line.computeLineDistances();
    return line;
}

function makeRocket(scene) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.014, 0.07, 12),
        new THREE.MeshPhongMaterial({ color: 0xeeeeee, emissive: 0x222222 }),
    );
    const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.012, 0.025, 12),
        new THREE.MeshPhongMaterial({ color: 0xff5533 }),
    );
    nose.position.y = 0.045;
    const plume = new THREE.Mesh(
        new THREE.ConeGeometry(0.015, 0.06, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    plume.rotation.x = Math.PI; plume.position.y = -0.05;
    g.add(body, nose, plume);
    scene.add(g);
    return g;
}

function clearAll(state, geo, hel) {
    for (const r of state.rockets) {
        geo.scene.remove(r.group); geo.scene.remove(r.trail);
    }
    for (const p of state.payloads) {
        geo.scene.remove(p.mesh); geo.scene.remove(p.ring); geo.scene.remove(p.trail);
    }
    for (const m of state.lunarMissions) {
        geo.scene.remove(m.craft); geo.scene.remove(m.trail);
        if (m.ellLine)     geo.scene.remove(m.ellLine);
        if (m.parkRing)    geo.scene.remove(m.parkRing);
        if (m.soiMesh)     geo.scene.remove(m.soiMesh);
        if (m.captureRing) geo.scene.remove(m.captureRing);
    }
    for (const m of state.marsMissions) {
        hel.scene.remove(m.craft); hel.scene.remove(m.trail);
        if (m.ellLine) hel.scene.remove(m.ellLine);
        if (m.soiMesh) hel.scene.remove(m.soiMesh);
    }
    state.rockets.length        = 0;
    state.payloads.length       = 0;
    state.lunarMissions.length  = 0;
    state.marsMissions.length   = 0;
}
