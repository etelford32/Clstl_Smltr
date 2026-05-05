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
    planLunarTransfer, planLunarLambert,
    planMarsTransfer, planMarsLambert,
    planMarsToEarthLambert, planMoonToMarsLambert, planMoonToEarthLambert,
    findLunarLaunchWindow, findMarsLaunchWindow, porkchopMars,
    planTour, optimizeTour, TOUR_PRESETS,
    flybyAssessment, flybyMaxTurnAngle, flybyPeriapsisForTurn,
    hohmannPositionAt,
} from './mission-planner-trajectory.js';
import { sampleKeplerArc } from './mission-planner-lambert.js';
import {
    EARTH_VERT, EARTH_FRAG,
    createEarthUniforms, loadEarthTextures,
} from './earth-skin.js';
import { makeOrreryPlanet, updateOrreryPlanet } from './orrery-skins.js';

// ── Scene scales ────────────────────────────────────────────────────────────
// Unified scene: 1 unit = 1 R⊕ (≈ 6378 km). Earth orbits Sun at ~23 456 R⊕
// (= 1 AU). All bodies, trajectories, and labels live in one scene at this
// scale; the renderer uses logarithmicDepthBuffer to span the 1 → 200 000
// unit dynamic range without z-fighting.
const GEO_UNIT_KM     = R_EARTH;
const KM_TO_SCENE     = 1 / GEO_UNIT_KM;            // km → scene units
const AU_TO_SCENE     = KM_PER_AU * KM_TO_SCENE;    // ≈ 23 456 R⊕ per AU
// Backward-compat alias: legacy code multiplies dist_AU by this to land in
// scene units. Kept so trajectory rendering doesn't need a sweeping rename.
const HELIO_UNIT_AU   = AU_TO_SCENE;
const MOON_R_SCENE    = R_MOON / GEO_UNIT_KM;
const SOI_MOON_SCENE  = SOI_MOON / GEO_UNIT_KM;

// ── Launch sites ────────────────────────────────────────────────────────────
export const LAUNCH_SITES = [
    { id: 'ksc',     name: 'Kennedy SC (USA)',     lat: 28.573, lon: -80.649 },
    { id: 'baikonur',name: 'Baikonur (KAZ)',       lat: 45.965, lon:  63.305 },
    { id: 'kourou',  name: 'Kourou (FRA)',         lat:  5.236, lon: -52.768 },
    { id: 'starbase',name: 'Starbase (USA)',       lat: 25.997, lon: -97.155 },
    { id: 'wenchang',name: 'Wenchang (CHN)',       lat: 19.614, lon: 110.951 },
    { id: 'vandy',   name: 'Vandenberg (USA)',     lat: 34.742, lon:-120.572 },
];

// ── Mars surface bases (gamification — fictional but anchored to real
//     Olympus Mons coordinates so the dome sits where it ought to). ──────────
export const MARS_BIOMES = [
    { id: 'olympia', name: 'Olympia Base', lat: 18.65, lon: 226.2 },
];

// ── Moon surface bases (anchored to real Apollo / Artemis coordinates). ───
export const MOON_BASES = [
    { id: 'tranquility', name: 'Tranquility Base', lat:  0.674, lon:  23.473 },
];

// ── Origin → destination route catalogue. The launcher reads this list to
//     decide which trajectory function to call for a given (origin,
//     destination) pair. `body` keys: 'earth' | 'moon' | 'mars'. ───────────
export const MISSION_ROUTES = [
    // Earth-centric (existing)
    { from: 'earth', to: 'leo',   label: 'Earth → LEO',          frame: 'geo'   },
    { from: 'earth', to: 'sso',   label: 'Earth → SSO',          frame: 'geo'   },
    { from: 'earth', to: 'meo',   label: 'Earth → MEO (GPS)',    frame: 'geo'   },
    { from: 'earth', to: 'geo',   label: 'Earth → GEO',          frame: 'geo'   },
    { from: 'earth', to: 'moon',  label: 'Earth → Moon',         frame: 'geo'   },
    { from: 'earth', to: 'mars',  label: 'Earth → Mars',         frame: 'helio' },
    // New cross-body routes
    { from: 'mars',  to: 'earth', label: 'Mars → Earth',         frame: 'helio' },
    { from: 'moon',  to: 'mars',  label: 'Moon → Mars',          frame: 'helio' },
    { from: 'moon',  to: 'earth', label: 'Moon → Earth',         frame: 'geo'   },
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
const EARTH_OBLQ_RAD = 23.4393 * DEG;
// Visual placement of the Sun in the Earth-centered scene. The real Sun is
// ~23 455 R⊕ away which would punch through the camera's far plane and look
// like a dot anyway. We park it at a fixed scene distance along the live
// Earth→Sun direction so the day/night terminator and the on-screen Sun
// stay co-located.
const GEO_SUN_DIST   = 220;
const GEO_SUN_RADIUS = 6.0;

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

    // Shared renderer with logarithmic depth buffer so we can span Earth-
    // surface scale (~1 unit) and full heliocentric scale (~150 000 units)
    // in one scene without z-fighting.
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w(), h());
    container.appendChild(renderer.domElement);

    // ── Unified world scene ─────────────────────────────────────────────────
    // One Scene + Camera + OrbitControls. `world.earthSystem` is a Group
    // parked at Earth's heliocentric scene position each frame; everything
    // Earth-relative (atmosphere, launch sites, lunar mesh, near-Earth
    // payloads, lunar trajectories) hangs off it so it rides Earth as it
    // orbits the Sun. Heliocentric content (Sun, Mars/Venus/Mercury, helio
    // Lambert arcs, orbit rings) lives in scene root.
    const world = buildWorldScene(renderer, w(), h());

    // Legacy view aliases — they let existing launch helpers keep using
    // `geo.scene.add(...)` / `hel.scene.add(...)` semantics. `geo.scene`
    // points at the moving earthSystem group; `hel.scene` is the scene
    // root. Camera/controls are shared.
    const geo = {
        scene:        world.earthSystem,    // Earth-relative content goes here
        camera:       world.camera,
        controls:     world.controls,
        earth:        world.earth,
        earthTilt:    world.earthTilt,
        earthSkinU:   world.earthSkinU,
        atmo:         world.atmo,
        moon:         world.moon,
    };
    const hel = {
        scene:        world.scene,           // Heliocentric content goes here
        camera:       world.camera,
        controls:     world.controls,
        sun:          world.sun,
        sunGlow:      world.sunGlow,
        flare:        world.flare,
        // hel.earth being the earthSystem group means the helio update loop's
        // `hel.earth.position.copy(...)` repositions the entire Earth System.
        earth:        world.earthSystem,
        mercury:      world.planets.mercury.group,
        venus:        world.planets.venus.group,
        mars:         world.planets.mars.group,
        planets:      world.planets,
    };

    // ── State ───────────────────────────────────────────────────────────────
    const state = {
        site:       LAUNCH_SITES[0],
        target:     TARGET_ORBITS[0],
        // `mode` retained for legacy callers but ignored by the renderer —
        // the scene is unified. Setting it now drives the focus preset.
        mode:       'geo',
        rockets:    [],   // active ascent vehicles (Earth-relative)
        payloads:   [],   // deployed near-Earth orbiters
        lunarMissions: [],// active lunar transfers (Earth-relative)
        marsMissions:  [],// active heliocentric Lambert cruises
        tours:         [],// active multi-leg tours
        clock:      new THREE.Clock(),
        elapsed:    0,
        timeScale:  1,
        // Days-per-second of "compressed" simulation time used for the
        // helio + lunar trajectories. Lunar TOF ≈ 5d → ~5s of wall time
        // at 1× when simDays = 1; Mars TOF ≈ 259d → ~26s wall at 10×.
        simDaysPerSec: 1,
        // Live ephemeris JD that drives planet positions.
        scenarioJD: jdNow(),
    };

    // Surface markers — parented to the spinning Earth so labels stay pinned
    // to real lat/lon as the planet rotates. Each site gets a small base
    // disk + glowing dot + canvas-sprite label naming the actual pad.
    for (const s of LAUNCH_SITES) {
        addLaunchSiteMarker(geo.earth, s);
    }

    // ── Focus presets (mode toggle replaced) ────────────────────────────────
    // setMode is kept as a no-op compat shim that just retargets the camera.
    // The renderer doesn't switch scenes anymore.
    function setMode(mode) {
        if (mode !== 'geo' && mode !== 'helio') return;
        state.mode = mode;
        if (mode === 'geo')   focusEarth();
        else                  focusSun();
        onEvent?.({ type: 'mode', mode });
    }

    // ── Public API: launch ──────────────────────────────────────────────────
    // Dispatches by (origin body, destination key). Two call forms accepted:
    //
    //   • Legacy: { siteId, targetId, ... }            — origin is implicit
    //                                                    Earth, target keyed
    //                                                    on TARGET_ORBITS.id
    //   • New:    { originBody, originId,              — explicit origin pad
    //              destinationBody, destinationId, ... } on Earth/Moon/Mars
    //
    // The dispatcher resolves origin → pad object, then matches MISSION_ROUTES
    // to pick a trajectory function (planMarsLambert, planMarsToEarthLambert,
    // planMoonToMarsLambert, planMoonToEarthLambert, etc.).
    function launch({
        siteId, targetId,
        originBody, originId, destinationBody, destinationId,
        payloadName     = 'PayloadSat-1',
        windowJD        = null,
        arriveJD        = null,
        parking_inc_deg = null,
        lunar_tof_d     = null,
    }) {
        // Legacy single-origin form: Earth surface → TARGET_ORBITS entry.
        if (siteId !== undefined && originBody === undefined) {
            originBody     = 'earth';
            originId       = siteId;
            destinationBody = null;
            destinationId  = targetId;
        }

        const origin = resolveOrigin(originBody, originId);
        if (!origin) throw new Error(`launch: unknown origin ${originBody}/${originId}`);
        state.site = origin.pad;

        // For Earth-origin keep legacy targetId semantics (LEO/GEO/etc.).
        if (originBody === 'earth') {
            const target = TARGET_ORBITS.find(t => t.id === destinationId) || state.target;
            state.target = target;
            if (target.frame !== state.mode) setMode(target.frame);

            if (target.id === 'moon') {
                return launchLunar({ site: origin.pad, target, payloadName, windowJD, parking_inc_deg, lunar_tof_d });
            }
            if (target.id === 'mars') {
                return launchMars({ site: origin.pad, target, payloadName, windowJD, arriveJD, parking_inc_deg });
            }
            return launchNearEarth({ site: origin.pad, target, payloadName });
        }

        // New cross-body routes. destinationBody must be supplied.
        const routeKey = `${originBody}->${destinationBody}`;
        if (routeKey === 'mars->earth') {
            if (state.mode !== 'helio') setMode('helio');
            return launchMarsToEarth({ origin, payloadName, windowJD, arriveJD });
        }
        if (routeKey === 'moon->mars') {
            if (state.mode !== 'helio') setMode('helio');
            return launchMoonToMars({ origin, payloadName, windowJD, arriveJD });
        }
        if (routeKey === 'moon->earth') {
            if (state.mode !== 'geo') setMode('geo');
            return launchMoonToEarth({ origin, payloadName, windowJD, lunar_tof_d });
        }
        throw new Error(`launch: unsupported route ${routeKey}`);
    }

    function resolveOrigin(body, id) {
        if (body === 'earth' || body === undefined) {
            const pad = LAUNCH_SITES.find(s => s.id === id) || LAUNCH_SITES[0];
            return { body: 'earth', pad };
        }
        if (body === 'moon') {
            const pad = MOON_BASES.find(b => b.id === id) || MOON_BASES[0];
            return { body: 'moon', pad };
        }
        if (body === 'mars') {
            const pad = MARS_BIOMES.find(b => b.id === id) || MARS_BIOMES[0];
            return { body: 'mars', pad };
        }
        return null;
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
    // If lunar_tof_d is supplied, use the Lambert solver (Apollo-fast = 3 d,
    // Hohmann ≈ 5.4 d, lazy = 7 d). Otherwise default to Hohmann.
    function launchLunar({ site, target, payloadName, windowJD, parking_inc_deg, lunar_tof_d }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const inc       = parking_inc_deg ?? Math.abs(site.lat);
        const useLambert = lunar_tof_d != null;
        const plan = useLambert
            ? planLunarLambert({ jd_depart, tof_d: lunar_tof_d, parking_inc_deg: inc })
            : planLunarTransfer({ jd_depart });

        // Geometry: place the transfer in the Earth-Moon orbital plane. For
        // Hohmann we use the apoapsis direction; for Lambert we use the
        // pre-sampled polyline (which already captures the real geometry).
        let moonArrKm;
        if (useLambert) {
            moonArrKm = plan.r2;
        } else {
            const m = plan.moon_at_arrival;
            const c = Math.cos(m.lat_rad);
            moonArrKm = [
                m.dist_km * c * Math.cos(m.lon_rad),
                m.dist_km * c * Math.sin(m.lon_rad),
                m.dist_km * Math.sin(m.lat_rad),
            ];
        }
        const moonArrPos = new THREE.Vector3(
            moonArrKm[0]/GEO_UNIT_KM,  moonArrKm[2]/GEO_UNIT_KM,  -moonArrKm[1]/GEO_UNIT_KM,
        );
        const apoDir   = moonArrPos.clone().normalize();
        const periDir  = apoDir.clone().multiplyScalar(-1);
        const planeNormal = new THREE.Vector3(0, 1, 0);
        const inPlaneSide = planeNormal.clone().cross(periDir).normalize();

        // Parking orbit ring at periapsis direction (only meaningful for Hohmann).
        const r_park_scene = plan.r_park_km / GEO_UNIT_KM;
        const parkRing = makeOrbitRingFromBasis(
            r_park_scene, periDir, inPlaneSide, 0xffcc66, 0.55,
        );
        geo.scene.add(parkRing);

        // Transfer arc — Hohmann ellipse OR Lambert polyline.
        let ellLine, arcPos = null, N_arc = 0;
        if (useLambert) {
            const samples_km = plan.sample();
            N_arc = samples_km.length;
            arcPos = new Float32Array(N_arc * 3);
            for (let i = 0; i < N_arc; i++) {
                const r = samples_km[i];
                // ecliptic km → scene units (1 R⊕), with horizons.js axis
                // convention (x,y,z)_ecl → scene (x, z, -y).
                arcPos[i*3+0] =  r[0] / GEO_UNIT_KM;
                arcPos[i*3+1] =  r[2] / GEO_UNIT_KM;
                arcPos[i*3+2] = -r[1] / GEO_UNIT_KM;
            }
            const arcGeom = new THREE.BufferGeometry();
            arcGeom.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
            ellLine = new THREE.Line(arcGeom, new THREE.LineBasicMaterial({
                color: 0x66ddff, transparent: true, opacity: 0.9,
            }));
        } else {
            ellLine = makeEllipseFromBasis(
                plan.ellipse.a_km / GEO_UNIT_KM, plan.ellipse.e,
                periDir, inPlaneSide,
                0x66ddff, 0.85, /* dashed */ true,
            );
        }
        geo.scene.add(ellLine);

        // Lunar SOI sphere (wireframe at arrival point).
        const soiMesh = new THREE.Mesh(
            new THREE.SphereGeometry(SOI_MOON_SCENE, 24, 16),
            new THREE.MeshBasicMaterial({
                color: 0x66ffaa, wireframe: true, transparent: true, opacity: 0.18,
            }),
        );
        soiMesh.position.copy(apoDir.clone().multiplyScalar(moonArrPos.length()));
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
            // Compress TOF: real 3-7 days → 6-10 s of wall time at 1×.
            durSec:     useLambert ? Math.max(5, plan.tof_d * 1.6) : 8,
            phase:      'ascent',
            ascentDur:  3,
            payloadName,
            site, target,
            captureRing: null,   // built when we cross SOI
            crashCheck:  false,
            // Lambert polyline (if present, used instead of Hohmann ellipse for motion)
            arcPos, N_arc,
        };
        state.lunarMissions.push(m);

        onEvent?.({ type: 'launched-lunar', site, target, payloadName, plan });
        return m;
    }

    // ── Mars transfer (helio frame, Lambert solver) ─────────────────────────
    function launchMars({ site, target, payloadName, windowJD, arriveJD, parking_inc_deg }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        // Default arrival = depart + Hohmann TOF (~258 d). Caller normally
        // supplies arriveJD from a pork-chop pick.
        const jd_arrive = arriveJD ?? (jd_depart + 258);
        const inc       = parking_inc_deg ?? Math.abs(site.lat);

        const plan = planMarsLambert({
            jd_depart, jd_arrive,
            parking_inc_deg: inc,
        });

        // Sample the actual Lambert arc in heliocentric km, then project to
        // scene units. This replaces the Hohmann ellipse stand-in — the
        // rendered curve is the trajectory the spacecraft actually flies.
        const samples_km = plan.sample();
        const N = samples_km.length;
        const auMul = HELIO_UNIT_AU / KM_PER_AU;
        const arcGeom = new THREE.BufferGeometry();
        const arcPos  = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const r = samples_km[i];
            // ecliptic +Z → scene +Y? horizons.js puts ecliptic in (x,y) with
            // +z = ecliptic normal. Our scene puts ecliptic in (x,z) with
            // +y = normal. Map (x, y, z)_ecl → (x, z, -y)_scene.
            arcPos[i*3+0] =  r[0] * auMul;
            arcPos[i*3+1] =  r[2] * auMul;
            arcPos[i*3+2] = -r[1] * auMul;
        }
        arcGeom.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
        const arcLine = new THREE.Line(arcGeom, new THREE.LineBasicMaterial({
            color: 0xff8855, transparent: true, opacity: 0.85,
        }));
        hel.scene.add(arcLine);

        // Mars SOI sphere at arrival point (last sample).
        const soiScene = SOI_MARS * auMul;
        const soiMesh = new THREE.Mesh(
            new THREE.SphereGeometry(soiScene, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xff7755, wireframe: true,
                transparent: true, opacity: 0.25 }),
        );
        soiMesh.position.set(arcPos[(N-1)*3+0], arcPos[(N-1)*3+1], arcPos[(N-1)*3+2]);
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
            plan, arcPos, N,
            craft, arcLine, soiMesh,
            ...trail,
            startedAt: state.elapsed,
            // Wall-clock time scales with TOF: 30 s for a 260-day Hohmann.
            durSec:    Math.max(8, plan.tof_d * (30 / 260)),
            phase:     'cruise',
            payloadName, site, target,
        };
        state.marsMissions.push(m);

        // TMI burn flash at Earth's helio position at departure.
        spawnBurnFlash(hel.scene,
            new THREE.Vector3(arcPos[0], arcPos[1], arcPos[2]),
            0xffcc66, 800, 1.4);

        onEvent?.({ type: 'launched-mars', site, target, payloadName, plan });
        return m;
    }

    // ── Generic helio Lambert launcher ──────────────────────────────────────
    // Mars→Earth and Moon→Mars share the exact same animation needs as
    // launchMars: sample the Lambert arc into helio scene units, drop a
    // spacecraft at sample 0, walk it to sample N-1 over a TOF-scaled wall
    // duration. The only differences are the kind tag, the SOI body at
    // arrival, and the trail / arc colors. We reuse state.marsMissions as
    // the storage list because the tick loop already animates anything
    // there with phase==='cruise'.
    function _launchHelioLambert({ plan, kind, payloadName, arrival_soi_km, arc_color, trail_color, route_label }) {
        const samples_km = plan.sample();
        const N = samples_km.length;
        const auMul = HELIO_UNIT_AU / KM_PER_AU;
        const arcPos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const r = samples_km[i];
            arcPos[i*3+0] =  r[0] * auMul;
            arcPos[i*3+1] =  r[2] * auMul;
            arcPos[i*3+2] = -r[1] * auMul;
        }
        const arcGeom = new THREE.BufferGeometry();
        arcGeom.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
        const arcLine = new THREE.Line(arcGeom, new THREE.LineBasicMaterial({
            color: arc_color, transparent: true, opacity: 0.85,
        }));
        hel.scene.add(arcLine);

        const soiScene = arrival_soi_km * auMul;
        const soiMesh = new THREE.Mesh(
            new THREE.SphereGeometry(soiScene, 16, 12),
            new THREE.MeshBasicMaterial({ color: arc_color, wireframe: true,
                transparent: true, opacity: 0.25 }),
        );
        soiMesh.position.set(arcPos[(N-1)*3+0], arcPos[(N-1)*3+1], arcPos[(N-1)*3+2]);
        hel.scene.add(soiMesh);

        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.05, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffeecc }),
        );
        hel.scene.add(craft);
        const trail = makeTrail(hel.scene, 1200, trail_color, 0.7);

        const m = {
            kind,
            plan, arcPos, N,
            craft, arcLine, soiMesh,
            ...trail,
            startedAt: state.elapsed,
            durSec: Math.max(8, plan.tof_d * (30 / 260)),
            phase:  'cruise',
            payloadName,
        };
        state.marsMissions.push(m);

        spawnBurnFlash(hel.scene,
            new THREE.Vector3(arcPos[0], arcPos[1], arcPos[2]),
            0xffcc66, 800, 1.4);

        onEvent?.({ type: 'launched-helio', kind, route: route_label, payloadName, plan });
        return m;
    }

    // ── Mars → Earth (helio Lambert) ────────────────────────────────────────
    function launchMarsToEarth({ origin, payloadName, windowJD, arriveJD }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const jd_arrive = arriveJD ?? (jd_depart + 258);
        const plan = planMarsToEarthLambert({ jd_depart, jd_arrive });
        return _launchHelioLambert({
            plan, kind: 'mars-to-earth', payloadName,
            arrival_soi_km: 924000,           // SOI of Earth
            arc_color: 0x66ccff, trail_color: 0x66aaff,
            route_label: `${origin.pad.name} → Earth`,
        });
    }

    // ── Moon → Mars (helio Lambert from Moon's heliocentric position) ───────
    function launchMoonToMars({ origin, payloadName, windowJD, arriveJD }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const jd_arrive = arriveJD ?? (jd_depart + 258);
        const plan = planMoonToMarsLambert({ jd_depart, jd_arrive });
        return _launchHelioLambert({
            plan, kind: 'moon-to-mars', payloadName,
            arrival_soi_km: SOI_MARS,
            arc_color: 0xff99cc, trail_color: 0xff77bb,
            route_label: `${origin.pad.name} → Mars`,
        });
    }

    // ── Moon → Earth (geocentric Lambert) ───────────────────────────────────
    // Lives in the geo frame; spacecraft starts at the Moon's geocentric
    // position and arcs back into a low Earth parking orbit. Mission shape
    // matches the existing lunarMissions list so the geo tick walks it.
    function launchMoonToEarth({ origin, payloadName, windowJD, lunar_tof_d }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const tof_d     = lunar_tof_d ?? 4.5;
        const plan = planMoonToEarthLambert({ jd_depart, tof_d });

        const samples_km = plan.sample();
        const N = samples_km.length;
        const arcPos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const r = samples_km[i];
            arcPos[i*3+0] =  r[0] / GEO_UNIT_KM;
            arcPos[i*3+1] =  r[2] / GEO_UNIT_KM;
            arcPos[i*3+2] = -r[1] / GEO_UNIT_KM;
        }
        const arcGeom = new THREE.BufferGeometry();
        arcGeom.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
        const arcLine = new THREE.Line(arcGeom, new THREE.LineBasicMaterial({
            color: 0x66ddff, transparent: true, opacity: 0.85,
        }));
        geo.scene.add(arcLine);

        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.04, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0x66ddff }),
        );
        geo.scene.add(craft);
        const trail = makeTrail(geo.scene, 800, 0x66ddff, 0.7);

        const m = {
            kind: 'moon-to-earth',
            plan, arcPos, N_arc: N,
            craft, arcLine, ellLine: null, parkRing: null, soiMesh: null, captureRing: null,
            ...trail,
            startedAt: state.elapsed,
            transferStart: state.elapsed,    // skip ascent phase entirely
            durSec: Math.max(8, plan.tof_d * 6),
            phase: 'transfer',
            payloadName,
            site: origin.pad,
            target: { id: 'earth-return', name: 'Earth (LEO return)', frame: 'geo' },
        };
        state.lunarMissions.push(m);

        spawnBurnFlash(geo.scene,
            new THREE.Vector3(arcPos[0], arcPos[1], arcPos[2]),
            0x66ddff, 800, 1.2);

        onEvent?.({ type: 'launched-lunar-return', payloadName, plan, route: `${origin.pad.name} → Earth` });
        return m;
    }

    // ── Tour (multi-leg Lambert chain, helio frame) ─────────────────────────
    // Renders each leg as its own polyline (color-coded by leg index) and
    // walks the spacecraft through the legs sequentially. Planet markers at
    // each encounter pulse briefly to show the flyby moment.
    function launchTour({ plan, payloadName = 'Tour-1' }) {
        if (state.mode !== 'helio') setMode('helio');

        const auMul = HELIO_UNIT_AU / KM_PER_AU;
        const LEG_COLORS = [0x66ccff, 0x66ffaa, 0xff8855, 0xffcc66, 0xff66cc];

        const legGeoms = [];
        for (let i = 0; i < plan.legs.length; i++) {
            const leg = plan.legs[i];
            const samples_km = leg.sample();
            const N = samples_km.length;
            const arcPos = new Float32Array(N * 3);
            for (let k = 0; k < N; k++) {
                const r = samples_km[k];
                arcPos[k*3+0] =  r[0] * auMul;
                arcPos[k*3+1] =  r[2] * auMul;
                arcPos[k*3+2] = -r[1] * auMul;
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
            const line = new THREE.Line(g, new THREE.LineBasicMaterial({
                color: LEG_COLORS[i % LEG_COLORS.length],
                transparent: true, opacity: 0.9,
            }));
            hel.scene.add(line);

            // Encounter markers — color/size encode flyby physics:
            //   • intermediate body with ballistic flyby   → cyan, large radius
            //   • intermediate body with powered flyby     → orange, small (tight)
            //   • final body (capture)                     → green, large
            const isFinal = i === plan.legs.length - 1;
            const f = leg.flyby_at_arrival;
            let mColor, mSize;
            if (isFinal) {
                mColor = 0x66ffaa; mSize = 0.16;
            } else if (f && f.ballistic) {
                mColor = 0x66ddff;
                // Bigger sphere = "looser" (higher) flyby altitude
                mSize = 0.08 + 0.06 * Math.min(1, f.altitude_km / 20000);
            } else {
                mColor = 0xff8855;
                mSize = 0.10;
            }
            const marker = new THREE.Mesh(
                new THREE.SphereGeometry(mSize, 16, 12),
                new THREE.MeshBasicMaterial({
                    color: mColor, wireframe: true,
                    transparent: true, opacity: 0.65,
                }),
            );
            marker.position.set(arcPos[(N-1)*3+0], arcPos[(N-1)*3+1], arcPos[(N-1)*3+2]);
            hel.scene.add(marker);

            // ── B-plane visualization (only for intermediate flybys) ──────
            // Built once at launch using the data from flybyAssessment, sits
            // at the body marker for the whole mission (later: hide unless
            // the user is near that body in the timeline).
            let bPlaneViz = null;
            if (!isFinal && f && f.b_plane) {
                // Outgoing v∞ direction (helio frame) for asymptote-out line
                const v_out_helio = plan.legs[i+1].v_inf_depart_vec;
                const m_out = Math.hypot(v_out_helio[0], v_out_helio[1], v_out_helio[2]);
                const v_out_unit = [v_out_helio[0]/m_out, v_out_helio[1]/m_out, v_out_helio[2]/m_out];
                bPlaneViz = buildBPlaneViz(f, v_out_unit, 0.28);
                bPlaneViz.position.set(arcPos[(N-1)*3+0], arcPos[(N-1)*3+1], arcPos[(N-1)*3+2]);
                hel.scene.add(bPlaneViz);
            }

            legGeoms.push({ line, arcPos, N, marker, bPlaneViz, leg });
        }

        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.06, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        hel.scene.add(craft);
        const trail = makeTrail(hel.scene, 1500, 0xffeecc, 0.7);

        // Burn flash at the start of the tour (TMI from Earth).
        spawnBurnFlash(hel.scene,
            new THREE.Vector3(legGeoms[0].arcPos[0], legGeoms[0].arcPos[1], legGeoms[0].arcPos[2]),
            0xffcc66, 800, 1.4);

        // Wall-clock seconds for the entire tour at 1× timeScale.
        const totalDur = Math.max(15, plan.tof_total_d * (45 / 800));   // ~45 s for an 800-d tour

        const m = {
            kind: 'tour',
            plan, legGeoms, craft, ...trail,
            startedAt: state.elapsed,
            totalDur,
            phase: 'cruise',
            payloadName,
            currentLeg: 0,
        };
        state.tours.push(m);

        onEvent?.({ type: 'launched-tour', payloadName, plan });
        return m;
    }

    // ── Update loop ─────────────────────────────────────────────────────────
    // Single unified tick: drive Earth's heliocentric position (which moves
    // the entire earthSystem group), update Earth-relative animations,
    // update heliocentric planet positions + cruise spacecraft, then render
    // the one scene through the one camera.
    function tick() {
        const dt = state.clock.getDelta() * state.timeScale;
        state.elapsed += dt;
        state.scenarioJD += dt * state.simDaysPerSec;

        updateEarthSystem(dt);   // earthSystem heliocentric pos + Earth-frame anims
        updateHelio(dt);          // Sun spin + Mercury/Venus/Mars + helio cruises
        world.controls.update();
        renderer.render(world.scene, world.camera);

        requestAnimationFrame(tick);
    }

    function updateEarthSystem(dt) {
        // Earth rotation (cosmetic — slow enough that pinned launch sites
        // don't whip around the globe between frames).
        geo.earth.rotation.y += dt * 0.04;

        // Park the entire Earth system at Earth's heliocentric scene
        // position. Everything inside earthSystem (atmosphere, launch
        // sites, Moon, near-Earth payloads, lunar trajectories) rides
        // along automatically.
        const eVec = earthHeliocentric(state.scenarioJD);
        world.earthSystem.position.copy(eclipticToVec3(
            eVec.lon_rad, eVec.lat_rad, eVec.dist_AU * AU_TO_SCENE,
        ));

        // Sun direction in WORLD space: the real Sun is at scene origin,
        // so the unit vector from Earth → Sun is just -earthSystem.position
        // normalized. Drives the EarthSkin shader's day/night terminator.
        if (geo.earthSkinU?.u_sun_dir) {
            const sunDir = world.earthSystem.position.clone().multiplyScalar(-1).normalize();
            geo.earthSkinU.u_sun_dir.value.copy(sunDir);
            geo.earthSkinU.u_time.value = state.elapsed;
        }

        // Live Moon position from ephemeris (slowed): drift the moon along
        // its real angular rate, anchored to scenarioJD. Position is in
        // earthSystem-local coordinates (Earth at origin of that group).
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
                    spawnBurnFlash(geo.scene, pos.clone(), 0xffcc66, 700, 0.8);
                }
                continue;
            }

            if (m.phase === 'transfer') {
                const u = Math.min(1, (state.elapsed - m.transferStart) / m.durSec);
                let pos;
                if (m.arcPos) {
                    // Lambert polyline: linear interp between samples.
                    const fi = u * (m.N_arc - 1);
                    const i0 = Math.floor(fi), i1 = Math.min(m.N_arc - 1, i0 + 1);
                    const t  = fi - i0;
                    const ax = m.arcPos;
                    pos = new THREE.Vector3(
                        ax[i0*3+0]*(1-t) + ax[i1*3+0]*t,
                        ax[i0*3+1]*(1-t) + ax[i1*3+1]*t,
                        ax[i0*3+2]*(1-t) + ax[i1*3+2]*t,
                    );
                } else {
                    const a_scene = m.plan.ellipse.a_km / GEO_UNIT_KM;
                    const e       = m.plan.ellipse.e;
                    const p2d     = hohmannPositionAt(u, a_scene, e);
                    pos = m.periDir.clone().multiplyScalar(p2d.x)
                        .add(m.inPlaneSide.clone().multiplyScalar(p2d.y));
                }
                m.craft.position.copy(pos);
                pushTrail(m, pos);

                // Detect SOI entry — only meaningful for outbound lunar
                // missions. Moon→Earth returns have no Moon-SOI mesh.
                if (m.soiMesh) {
                    const distToMoon = pos.distanceTo(m.soiMesh.position);
                    if (distToMoon <= SOI_MOON_SCENE && !m.captureRing) {
                        captureLunar(m);
                    }
                }

                if (u >= 1) {
                    if (m.kind === 'moon-to-earth') {
                        m.phase = 'arrived';
                        spawnBurnFlash(geo.scene, pos.clone(), 0x66ffaa, 1000, 1.4);
                        onEvent?.({ type: 'lunar-return-arrived', payloadName: m.payloadName, plan: m.plan });
                    } else {
                        m.phase = 'captured';
                        if (!m.captureRing) captureLunar(m);
                    }
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

    // ── Camera-distance LOD for visible bodies ──────────────────────────────
    // Each planet's mesh is built at its real radius (Mercury 0.382, Venus
    // 0.949, Earth 1.0, Mars 0.531 R⊕). Up close that's correct: Mars
    // really is half the size of Earth, Mercury is a third. From AU-scale
    // distance those meshes would be sub-pixel, so we uniformly scale each
    // body up to maintain a minimum on-screen angular size (~12 mrad ≈
    // 0.7°, roughly 12 px on a 1080p viewport). Below the crossover
    // distance the scale is exactly 1 — no pop, just a smooth transition
    // when the camera passes through ≈ realRadius / minAngular.
    //
    // Earth is scaled via earthTilt so the Moon (sibling in earthSystem)
    // and the lunar orbit ring stay at their real heliocentric offsets.
    // Moon stays at real size and relies on its halo sprite at distance.
    const MIN_ANGULAR = 0.012;
    const _camWorld    = new THREE.Vector3();
    const _bodyWorld   = new THREE.Vector3();
    function lodScale(distance, realRadius) {
        const angular = realRadius / Math.max(1e-3, distance);
        return angular < MIN_ANGULAR ? MIN_ANGULAR / angular : 1.0;
    }
    function applyPlanetLOD() {
        world.camera.getWorldPosition(_camWorld);

        // Inner-planet groups
        for (const handle of [hel.planets.mercury, hel.planets.venus, hel.planets.mars]) {
            handle.group.getWorldPosition(_bodyWorld);
            handle.group.scale.setScalar(
                lodScale(_camWorld.distanceTo(_bodyWorld), handle.realRadius));
        }

        // Earth (scale earthTilt only — keeps Moon on its real orbit)
        world.earthSystem.getWorldPosition(_bodyWorld);
        world.earthTilt.scale.setScalar(
            lodScale(_camWorld.distanceTo(_bodyWorld), 1.0));
    }

    function captureLunar(m) {
        m.captureRing = makeOrbitRingFromBasis(
            m.plan.r_capt_km / GEO_UNIT_KM,
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 0, 1),
            0xffeecc, 0.85,
        );
        spawnBurnFlash(geo.scene, geo.moon.position.clone(), 0x66ffaa, 900, 0.6);
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

        // Update inner-planet positions from live ephemeris at scenarioJD.
        // (Earth's position is handled by updateEarthSystem, which moves
        // the parented earthSystem group; that's why we don't update
        // hel.earth here anymore.)
        const mVec  = marsHeliocentric(state.scenarioJD);
        const meVec = mercuryHeliocentric(state.scenarioJD);
        const vVec  = venusHeliocentric(state.scenarioJD);
        hel.mars.position.copy   (eclipticToVec3(mVec.lon_rad,  mVec.lat_rad,  mVec.dist_AU  * AU_TO_SCENE));
        hel.mercury.position.copy(eclipticToVec3(meVec.lon_rad, meVec.lat_rad, meVec.dist_AU * AU_TO_SCENE));
        hel.venus.position.copy  (eclipticToVec3(vVec.lon_rad,  vVec.lat_rad,  vVec.dist_AU  * AU_TO_SCENE));

        // Drive procedural-skin axial rotation + sun-direction lighting so
        // the lit hemisphere always faces the (origin) Sun. Done after
        // position updates because updateOrreryPlanet uses planet.group's
        // current position to compute uSunDir.
        if (hel.planets) {
            const sunPos = new THREE.Vector3(0, 0, 0);
            updateOrreryPlanet(hel.planets.mercury, state.scenarioJD, sunPos);
            updateOrreryPlanet(hel.planets.venus,   state.scenarioJD, sunPos);
            updateOrreryPlanet(hel.planets.mars,    state.scenarioJD, sunPos);
            applyPlanetLOD();
        }

        // Mars missions — spacecraft walks the pre-sampled Lambert arc.
        // Linear interpolation between samples is fine because the arc was
        // sampled at uniform t (Kepler-equation timing). Could be upgraded
        // to a true Catmull-Rom spline if the arc ever looked jaggy.
        for (const m of state.marsMissions) {
            if (m.phase !== 'cruise') continue;
            const u   = Math.min(1, (state.elapsed - m.startedAt) / m.durSec);
            const fi  = u * (m.N - 1);
            const i0  = Math.floor(fi);
            const i1  = Math.min(m.N - 1, i0 + 1);
            const t   = fi - i0;
            const ax  = m.arcPos;
            m.craft.position.set(
                ax[i0*3+0] * (1-t) + ax[i1*3+0] * t,
                ax[i0*3+1] * (1-t) + ax[i1*3+1] * t,
                ax[i0*3+2] * (1-t) + ax[i1*3+2] * t,
            );
            pushTrail(m, m.craft.position);
            if (u >= 1) {
                m.phase = 'arrived';
                spawnBurnFlash(hel.scene, m.craft.position.clone(), 0x66ffaa, 1100, 1.6);
                // Per-kind arrival event so the UI log reads correctly.
                const arrivalEvents = {
                    'mars':         'mars-captured',
                    'mars-to-earth':'earth-captured',
                    'moon-to-mars': 'mars-captured',
                };
                onEvent?.({
                    type: arrivalEvents[m.kind] || 'helio-arrived',
                    payloadName: m.payloadName, plan: m.plan,
                });
            }
        }

        // Tour spacecraft — sequential walk through legs. Each leg gets a
        // fraction of total wall-clock time proportional to its TOF.
        for (const t of state.tours) {
            if (t.phase !== 'cruise') continue;
            const u = Math.min(1, (state.elapsed - t.startedAt) / t.totalDur);

            // Find current leg by accumulating TOF fractions.
            const totalTof = t.plan.tof_total_d;
            const sTotal = u * totalTof;
            let acc = 0, legIdx = 0;
            for (let i = 0; i < t.legGeoms.length; i++) {
                const tofI = t.legGeoms[i].leg.tof_d;
                if (sTotal <= acc + tofI) { legIdx = i; break; }
                acc += tofI;
                legIdx = i + 1;
            }
            if (legIdx >= t.legGeoms.length) {
                t.phase = 'arrived';
                // Final capture flash at the last body.
                const last = t.legGeoms[t.legGeoms.length - 1];
                spawnBurnFlash(hel.scene, new THREE.Vector3(
                    last.arcPos[(last.N-1)*3+0], last.arcPos[(last.N-1)*3+1], last.arcPos[(last.N-1)*3+2],
                ), 0x66ffaa, 1100, 1.6);
                onEvent?.({ type: 'tour-arrived', payloadName: t.payloadName, plan: t.plan });
                continue;
            }

            // Notify on leg transitions.
            if (legIdx !== t.currentLeg) {
                t.currentLeg = legIdx;
                // Flyby flash at the body the spacecraft just crossed.
                if (legIdx > 0) {
                    const prev = t.legGeoms[legIdx - 1];
                    const f = prev.leg.flyby_at_arrival;
                    const flashColor = f && f.ballistic ? 0x66ddff : 0xff8855;
                    spawnBurnFlash(hel.scene, new THREE.Vector3(
                        prev.arcPos[(prev.N-1)*3+0], prev.arcPos[(prev.N-1)*3+1], prev.arcPos[(prev.N-1)*3+2],
                    ), flashColor, 900, f && f.ballistic ? 1.0 : 1.4);
                }
                onEvent?.({
                    type: 'tour-leg', payloadName: t.payloadName,
                    legIndex: legIdx,
                    leg: t.legGeoms[legIdx].leg,
                    tour: t.plan,
                });
            }

            const leg = t.legGeoms[legIdx];
            const uLeg = (sTotal - acc) / leg.leg.tof_d;
            const fi = Math.min(1, uLeg) * (leg.N - 1);
            const i0 = Math.floor(fi), i1 = Math.min(leg.N - 1, i0 + 1);
            const tau = fi - i0;
            const ax = leg.arcPos;
            t.craft.position.set(
                ax[i0*3+0]*(1-tau) + ax[i1*3+0]*tau,
                ax[i0*3+1]*(1-tau) + ax[i1*3+1]*tau,
                ax[i0*3+2]*(1-tau) + ax[i1*3+2]*tau,
            );
            pushTrail(t, t.craft.position);
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
        world.camera.aspect = cw / ch; world.camera.updateProjectionMatrix();
    });
    ro.observe(container);

    // Focus presets — set OrbitControls target + camera position relative
    // to whichever body the user wants centered. All use world coordinates
    // since planets move (Earth at 1 AU from Sun, etc.).
    function focusEarth() {
        const eP = world.earthSystem.position;
        world.controls.target.copy(eP);
        world.camera.position.set(eP.x + 3.5, eP.y + 2.4, eP.z + 4.6);
    }
    function focusMoon() {
        const mWorld = new THREE.Vector3();
        world.moon.getWorldPosition(mWorld);
        world.controls.target.copy(mWorld);
        world.camera.position.set(mWorld.x * 1.001, mWorld.y + 8, mWorld.z * 1.001 + 8);
    }
    function focusMars() {
        const mP = hel.mars.position;
        world.controls.target.copy(mP);
        const dir = mP.clone().normalize();
        world.camera.position.copy(mP).add(dir.multiplyScalar(20));
    }
    function focusSun() {
        world.controls.target.set(0, 0, 0);
        world.camera.position.set(0, 0.5 * AU_TO_SCENE, 1.0 * AU_TO_SCENE);
    }
    function focusSystem() {
        world.controls.target.set(0, 0, 0);
        world.camera.position.set(0, 1.5 * AU_TO_SCENE, 2.5 * AU_TO_SCENE);
    }

    // Seed initial body positions (zero-dt update so earthSystem.position
    // reflects today's heliocentric Earth before first render), then frame
    // the camera on Earth.
    updateEarthSystem(0);
    updateHelio(0);
    focusEarth();

    requestAnimationFrame(tick);

    return {
        launch,
        setMode,
        getMode: () => state.mode,
        setTimeScale: (x) => { state.timeScale = Math.max(0, Math.min(50, x)); },
        getTimeScale: () => state.timeScale,
        setSimDaysPerSec: (x) => { state.simDaysPerSec = Math.max(0, x); },
        clear: () => clearAll(state, geo, hel),
        focusEarth,
        focusMoon,
        focusMars,
        focusSun,
        focusSystem,
        getStats: () => ({
            rockets:        state.rockets.length,
            payloads:       state.payloads.length,
            lunarMissions:  state.lunarMissions.length,
            marsMissions:   state.marsMissions.length,
            tours:          state.tours.length,
        }),
        getScenarioJD: () => state.scenarioJD,
        setScenarioJD: (jd) => { state.scenarioJD = jd; },
        // Trajectory planners — also useful from the UI for read-only previews.
        planLunar:        planLunarTransfer,
        planLunarLambert,
        planMars:         planMarsTransfer,
        planMarsLambert,
        planMarsToEarthLambert,
        planMoonToMarsLambert,
        planMoonToEarthLambert,
        findLunarWindow:  findLunarLaunchWindow,
        findMarsWindow:   findMarsLaunchWindow,
        porkchopMars,
        // Tour planning
        planTour, optimizeTour, TOUR_PRESETS,
        launchTour: (opts) => launchTour(opts),
        // Gravity-assist primitives (exposed for didactic UI uses)
        flybyAssessment, flybyMaxTurnAngle, flybyPeriapsisForTurn,
    };
}

// ── Unified scene builder ───────────────────────────────────────────────────
// Single Scene with: Sun at origin, inner-planet orrery groups at their
// heliocentric positions (Mercury / Venus / Mars), and an `earthSystem`
// Group that is parked at Earth's heliocentric scene position each frame.
// Inside earthSystem live the textured Earth, atmosphere, Moon, and all
// Earth-relative trajectories. The renderer's logarithmic depth buffer
// lets the camera roam from 1.4 R⊕ (just outside Earth) to ~200 000 R⊕
// (well past Saturn's orbit) without z-fighting.
function buildWorldScene(renderer, w, h) {
    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x02010a);

    const camera = new THREE.PerspectiveCamera(45, w/h, 0.05, 1e8);
    camera.position.set(3.5, 2.4, 4.6);    // overridden by initial focusEarth

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 1.4;
    controls.maxDistance = 2.0 * AU_TO_SCENE;     // past Mars orbit

    scene.add(new THREE.AmbientLight(0x303048, 0.45));
    addStarfield(scene, 2400, 0.8 * AU_TO_SCENE);

    // ── Sun: photosphere + corona shells + lens flare + PointLight ─────────
    const SUN_R = 70;  // ~64% of real Sun radius (109 R⊕); plenty visible
    const sun = new THREE.Mesh(
        new THREE.SphereGeometry(SUN_R, 32, 24),
        new THREE.MeshBasicMaterial({ color: 0xfff0c8 }),
    );
    scene.add(sun);
    const sunGlow = new THREE.Group();
    for (const [scl, op, col] of [
        [1.30, 0.45, 0xffd06c],
        [1.85, 0.22, 0xffa040],
        [3.00, 0.10, 0xff7022],
        [5.50, 0.04, 0xcc5511],
    ]) {
        sunGlow.add(new THREE.Mesh(
            new THREE.SphereGeometry(SUN_R * scl, 32, 24),
            new THREE.MeshBasicMaterial({
                color: col, transparent: true, opacity: op,
                side: THREE.BackSide, blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        ));
    }
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0xffe09a, 0.55),
        transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    flare.scale.set(SUN_R * 8, SUN_R * 8, 1);
    sunGlow.add(flare);
    scene.add(sunGlow);
    // Single PointLight at Sun origin lights every body in the scene.
    const sunLight = new THREE.PointLight(0xffeec8, 1.6, 0, 0);
    scene.add(sunLight);

    const sunLabel = makeBodyLabel('Sun', '#ffe', 1.4);
    sunLabel.position.set(0, SUN_R * 1.6, 0);
    scene.add(sunLabel);

    // ── Heliocentric orbit rings (Mercury / Venus / Earth / Mars) ──────────
    const orbits = [
        { r: 0.387 * AU_TO_SCENE, color: 0x886655 },
        { r: 0.723 * AU_TO_SCENE, color: 0xc8b88a },
        { r: 1.000 * AU_TO_SCENE, color: 0x4488cc },
        { r: 1.524 * AU_TO_SCENE, color: 0xc05530 },
    ];
    for (const o of orbits) scene.add(makeRingLine(o.r, o.color, 0.6));

    // ── Inner planets via procedural orrery skins ──────────────────────────
    // Bodies are built at their REAL radii so that flying close (e.g.,
    // Olympia Base on Mars) shows correct relative scale: Mars (0.531 R⊕)
    // really is half of Earth. From AU-scale viewing distance the meshes
    // would be sub-pixel, so the unified tick scales them up uniformly via
    // applyPlanetLOD() to maintain a minimum on-screen angular size. The
    // stylised landing pad / dome / beacon on each surface scales with the
    // group, so Olympia Base reads at every zoom.
    const MARS_R    = R_MARS  / R_EARTH;     // 0.531
    const VENUS_R   = 6051.8  / R_EARTH;     // 0.949
    const MERCURY_R = 2439.7  / R_EARTH;     // 0.382
    const mercuryP = makeOrreryPlanet('mercury', MERCURY_R, 0xaa9988);
    const venusP   = makeOrreryPlanet('venus',   VENUS_R,   0xffeebb);
    const marsP    = makeOrreryPlanet('mars',    MARS_R,    0xffaa77);
    scene.add(mercuryP.group, venusP.group, marsP.group);

    // Mars surface bases (Olympia Base) ride the spinning Mars surface.
    for (const biome of MARS_BIOMES) {
        addMarsBiome(marsP.surface, MARS_R, biome);
    }

    const mercuryLabel = makeBodyLabel('Mercury', '#bba', 1.4);
    const venusLabel   = makeBodyLabel('Venus',   '#fec', 1.6);
    const marsLabel    = makeBodyLabel('Mars',    '#f96', 1.6);
    mercuryP.group.add(mercuryLabel); mercuryLabel.position.set(0, MERCURY_R * 1.8, 0);
    venusP.group.add(venusLabel);     venusLabel.position.set(0, VENUS_R   * 1.8, 0);
    marsP.group.add(marsLabel);       marsLabel.position.set(0, MARS_R    * 1.8, 0);

    // ── Earth System group (parented to scene root, repositioned each frame
    //     to Earth's heliocentric position by updateEarthSystem). ───────────
    const earthSystem = new THREE.Group();
    scene.add(earthSystem);

    const earthTilt = new THREE.Group();
    earthTilt.rotation.x = EARTH_OBLQ_RAD;
    earthSystem.add(earthTilt);

    const earthSkinU = createEarthUniforms(new THREE.Vector3(1, 0, 0));
    earthSkinU.u_aurora_on.value     = 0;
    earthSkinU.u_city_lights.value   = 1;
    earthSkinU.u_weather_on.value    = 0;
    earthSkinU.u_bump_strength.value = 0.8;
    const earth = new THREE.Mesh(
        new THREE.SphereGeometry(1, 64, 48),
        new THREE.ShaderMaterial({
            vertexShader:   EARTH_VERT,
            fragmentShader: EARTH_FRAG,
            uniforms:       earthSkinU,
        }),
    );
    earthTilt.add(earth);
    loadEarthTextures(earthSkinU, null);

    const grid = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(1.002, 18, 12)),
        new THREE.LineBasicMaterial({ color: 0x335577, transparent: true, opacity: 0.12 }),
    );
    earth.add(grid);

    const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(1.045, 48, 32),
        new THREE.MeshBasicMaterial({
            color: 0x66aaff, transparent: true, opacity: 0.18,
            side: THREE.BackSide, blending: THREE.AdditiveBlending,
            depthWrite: false,
        }),
    );
    earthTilt.add(atmo);

    // Halo billboard so Earth is visible from heliocentric distances.
    // sizeAttenuation:false keeps it at a constant ~5% screen-height size
    // regardless of camera zoom, so it doesn't overwhelm close-ups (where
    // the LOD-scaled Earth mesh + atmosphere dominate). depthTest stays on
    // so the halo sits behind the Earth mesh when the camera is close.
    const earthHalo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0x66aaff, 0),
        transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: false,
    }));
    earthHalo.scale.set(0.05, 0.05, 1);
    earthSystem.add(earthHalo);

    const moon = new THREE.Mesh(
        new THREE.SphereGeometry(MOON_R_SCENE, 32, 24),
        new THREE.MeshPhongMaterial({ color: 0xb8b8b8, emissive: 0x333333 }),
    );
    earthSystem.add(moon);

    for (const base of MOON_BASES) {
        addMoonBiome(moon, MOON_R_SCENE, base);
    }

    const moonHalo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0xc0c0c8, 0),
        transparent: true, opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: false,
    }));
    moonHalo.scale.set(0.025, 0.025, 1);
    moon.add(moonHalo);

    // Lunar mean-orbit ring (visual reference, equatorial).
    const moonRingMean = makeRingLine(384400 / R_EARTH, 0x444466, 0.35);
    earthSystem.add(moonRingMean);

    const earthLabel = makeBodyLabel('Earth', '#9cf', 1.6);
    earthLabel.position.set(0, 1.6, 0);
    earth.add(earthLabel);
    const moonLabel = makeBodyLabel('Moon', '#cdd');
    moonLabel.position.set(0, MOON_R_SCENE * 4, 0);
    moon.add(moonLabel);

    // Annotate each planet handle with its real radius so the LOD pass
    // can scale uniformly when the camera is far. Stored alongside the
    // existing {group, surface, uniforms, spin} so the orrery helpers
    // don't care.
    mercuryP.realRadius = MERCURY_R;
    venusP.realRadius   = VENUS_R;
    marsP.realRadius    = MARS_R;

    return {
        scene, camera, controls,
        earthSystem, earth, earthTilt, earthSkinU,
        grid, atmo, moon, earthHalo, moonHalo,
        sun, sunGlow, flare, sunLight,
        planets: { mercury: mercuryP, venus: venusP, mars: marsP },
    };
}

// ── Visual-enhancement primitives ───────────────────────────────────────────

function makeRadialGradientTexture(rgbHex, edgeAlpha = 0) {
    const N = 128;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const r = (rgbHex >> 16) & 0xff, g = (rgbHex >> 8) & 0xff, b = rgbHex & 0xff;
    const grad = ctx.createRadialGradient(N/2, N/2, 0, N/2, N/2, N/2);
    grad.addColorStop(0,    `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.4,  `rgba(${r},${g},${b},0.6)`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},${edgeAlpha})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, N, N);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
}

function makeBodyLabel(text, cssColor = '#ccddff', sizeMul = 1) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 32px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(text, 130, 34);
    ctx.fillStyle = cssColor;
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
    }));
    sprite.scale.set(0.42 * sizeMul, 0.105 * sizeMul, 1);
    return sprite;
}

/**
 * Plant a launch-site marker on the rotating Earth mesh.
 *
 * Renders a glowing orange dot tipped slightly off the surface, an additive
 * radial flare so it pops against night-side cities, and a canvas-sprite
 * label with the pad's name floating just outside the atmosphere shell.
 * The marker is parented to the Earth mesh, so it follows the planet's
 * axial tilt + diurnal spin and stays pinned to real lat/lon.
 */
function addLaunchSiteMarker(earthMesh, site) {
    const surface = latLonToVec3(site.lat, site.lon, 1.0);
    const up      = surface.clone().normalize();

    // Small thin post connects the surface to the dot — sells the "this
    // pad is here" idea against the textured globe.
    const postLen = 0.06;
    const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.004, 0.004, postLen, 6),
        new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85 }),
    );
    // Cylinder default axis is +Y; orient along the local up vector.
    post.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    post.position.copy(up.clone().multiplyScalar(1.0 + postLen * 0.5));
    earthMesh.add(post);

    const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 14, 10),
        new THREE.MeshBasicMaterial({ color: 0xffaa33 }),
    );
    dot.position.copy(up.clone().multiplyScalar(1.0 + postLen));
    earthMesh.add(dot);

    // Additive flare so the marker stays visible on the night side.
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0xffd07a, 0),
        transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
    }));
    flare.position.copy(dot.position);
    flare.scale.set(0.13, 0.13, 1);
    earthMesh.add(flare);

    // Canvas label — short name only so we don't clutter the globe.
    const label = makeBodyLabel(siteShortName(site), '#ffd6a0', 0.7);
    label.position.copy(up.clone().multiplyScalar(1.0 + postLen + 0.10));
    earthMesh.add(label);
}

function siteShortName(site) {
    // Strip trailing country/agency tag like " (USA)" so the on-globe
    // label stays readable.
    return site.name.replace(/\s*\([^)]+\)\s*$/, '').trim();
}

/**
 * Plant a stylized colony "biome" on the Mars surface mesh.
 *
 * Visual stack:
 *   • Reddish landing pad (CircleGeometry) flush with the surface
 *   • Glowing orange pad ring (RingGeometry) so the site reads from orbit
 *   • Translucent habitat dome (open hemisphere, MeshPhong with emissive)
 *   • Small communications spire (slim cone) topped by a beacon sprite
 *   • Canvas-sprite name label floating above the dome
 *
 * Parented to the planet's spinning surface mesh, so the whole colony
 * inherits axial tilt + diurnal spin and stays pinned to its lat/lon.
 */
function addMarsBiome(marsSurface, planetRadius, biome) {
    const surfacePoint = latLonToVec3(biome.lat, biome.lon, planetRadius);
    const up           = surfacePoint.clone().normalize();

    const group = new THREE.Group();
    group.position.copy(surfacePoint);
    // Re-orient so the group's local +Y points along the local surface
    // normal — keeps the dome upright on the curved planet.
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);

    // Landing pad — flat reddish disc just above the regolith.
    const padR = planetRadius * 0.18;
    const pad = new THREE.Mesh(
        new THREE.CircleGeometry(padR, 28),
        new THREE.MeshBasicMaterial({
            color: 0x553322, transparent: true, opacity: 0.95,
            side: THREE.DoubleSide, depthWrite: false,
        }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = planetRadius * 0.001;
    group.add(pad);

    // Glowing pad ring — additive so it pops on the night side.
    const padRing = new THREE.Mesh(
        new THREE.RingGeometry(padR, padR * 1.12, 36),
        new THREE.MeshBasicMaterial({
            color: 0xffaa44, transparent: true, opacity: 0.9,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            depthWrite: false,
        }),
    );
    padRing.rotation.x = -Math.PI / 2;
    padRing.position.y = planetRadius * 0.0015;
    group.add(padRing);

    // Habitat dome — open hemisphere so it reads as a structure even at
    // 1 px on screen. Slight emissive so it's visible against the night
    // side without needing extra lighting.
    const domeR = planetRadius * 0.10;
    const dome = new THREE.Mesh(
        new THREE.SphereGeometry(domeR, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshPhongMaterial({
            color: 0xddeeff, emissive: 0x113355, emissiveIntensity: 0.45,
            transparent: true, opacity: 0.55, shininess: 90,
            side: THREE.DoubleSide,
        }),
    );
    dome.position.y = planetRadius * 0.002;
    group.add(dome);

    // Comms spire + beacon sprite for visibility from orbit.
    const spire = new THREE.Mesh(
        new THREE.ConeGeometry(planetRadius * 0.006, planetRadius * 0.16, 6),
        new THREE.MeshBasicMaterial({ color: 0xeeccaa }),
    );
    spire.position.y = planetRadius * 0.18;
    group.add(spire);

    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0xffcc66, 0),
        transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
    }));
    beacon.scale.set(planetRadius * 0.55, planetRadius * 0.55, 1);
    beacon.position.y = planetRadius * 0.27;
    group.add(beacon);

    // Name label
    const label = makeBodyLabel(biome.name, '#ffaa66', 0.7);
    label.position.y = planetRadius * 0.48;
    group.add(label);

    marsSurface.add(group);
    return group;
}

/**
 * Plant a lunar base on the Moon mesh in the geo scene. Same pattern as
 * addMarsBiome but greyscale so it reads against the lunar regolith. The
 * base is intentionally small in scene units (Moon is MOON_R_SCENE ≈ 0.27
 * units) so its sprite label is the part that actually reads from orbit.
 */
function addMoonBiome(moonMesh, planetRadius, base) {
    const surfacePoint = latLonToVec3(base.lat, base.lon, planetRadius);
    const up           = surfacePoint.clone().normalize();

    const group = new THREE.Group();
    group.position.copy(surfacePoint);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);

    const padR = planetRadius * 0.13;

    // Reflective metallic landing pad.
    const pad = new THREE.Mesh(
        new THREE.CircleGeometry(padR, 24),
        new THREE.MeshBasicMaterial({
            color: 0x556677, transparent: true, opacity: 0.9,
            side: THREE.DoubleSide, depthWrite: false,
        }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = planetRadius * 0.001;
    group.add(pad);

    // Cyan additive ring — calls out the base on the dark lunar surface.
    const padRing = new THREE.Mesh(
        new THREE.RingGeometry(padR, padR * 1.15, 32),
        new THREE.MeshBasicMaterial({
            color: 0x66ddff, transparent: true, opacity: 0.85,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            depthWrite: false,
        }),
    );
    padRing.rotation.x = -Math.PI / 2;
    padRing.position.y = planetRadius * 0.0015;
    group.add(padRing);

    // Hab dome — translucent grey-blue.
    const dome = new THREE.Mesh(
        new THREE.SphereGeometry(planetRadius * 0.085, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshPhongMaterial({
            color: 0xbbcce0, emissive: 0x223344, emissiveIntensity: 0.5,
            transparent: true, opacity: 0.55, shininess: 100,
            side: THREE.DoubleSide,
        }),
    );
    dome.position.y = planetRadius * 0.001;
    group.add(dome);

    // Beacon for orbital visibility.
    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0x88ddff, 0),
        transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
    }));
    beacon.scale.set(planetRadius * 0.7, planetRadius * 0.7, 1);
    beacon.position.y = planetRadius * 0.20;
    group.add(beacon);

    const label = makeBodyLabel(base.name, '#88ddff', 0.7);
    label.position.y = planetRadius * 0.55;
    group.add(label);

    moonMesh.add(group);
    return group;
}

/**
 * Schematic B-plane visualisation at a flyby body. Real B-plane geometry
 * is microscopic at AU scale (Earth's SOI is 0.025 helio units), so this
 * is intentionally rendered ~150× oversized for educational clarity.
 *
 * Returns a Group containing:
 *   • translucent disk perpendicular to ŝ                  (the B-plane)
 *   • disk outline                                          (sized = |B| schematic)
 *   • B-vector arrow from origin to closest-approach point  (along B̂)
 *   • incoming asymptote line                               (extends in -ŝ direction)
 *   • outgoing asymptote line                               (extends in v̂∞_out direction)
 *   • rotation-axis arrow                                   (along ĥ, perpendicular to flyby plane)
 *   • text label with B·T, B·R, |B| in km
 */
function buildBPlaneViz(flybyAssessment, v_inf_out_helio_unit, scale = 0.28) {
    const g = new THREE.Group();
    const b = flybyAssessment.b_plane;

    // helio km → scene basis: the flyby data uses heliocentric ecliptic
    // (x, y, z), and our scene maps (x_ecl, y_ecl, z_ecl) → (x, z, -y).
    const toScene = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
    const s = toScene(b.s_hat).normalize();
    const T = toScene(b.T_hat).normalize();
    const R = toScene(b.R_hat).normalize();
    const h = toScene(b.h_hat).normalize();
    const Bhat = toScene(b.B_hat).normalize();
    const v_out_hat = toScene(v_inf_out_helio_unit).normalize();

    // Translucent B-plane disk (CircleGeometry's default normal is +Z, so
    // we orient it via quaternion to face +ŝ).
    const disk = new THREE.Mesh(
        new THREE.CircleGeometry(scale, 48),
        new THREE.MeshBasicMaterial({
            color: 0x66ddff, transparent: true, opacity: 0.10,
            side: THREE.DoubleSide, depthWrite: false,
        }),
    );
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), s);
    disk.quaternion.copy(q);
    g.add(disk);

    // Disk outline ring
    const ringPts = [];
    const N = 64;
    for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        ringPts.push(
            T.clone().multiplyScalar(scale * Math.cos(a))
             .add(R.clone().multiplyScalar(scale * Math.sin(a))),
        );
    }
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(ringPts),
        new THREE.LineBasicMaterial({ color: 0x88eeff, transparent: true, opacity: 0.55 }),
    ));

    // T̂ axis tick (small line from center along +T̂)
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), T.clone().multiplyScalar(scale)]),
        new THREE.LineBasicMaterial({ color: 0x44aacc, transparent: true, opacity: 0.5 }),
    ));
    // R̂ axis tick
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), R.clone().multiplyScalar(scale)]),
        new THREE.LineBasicMaterial({ color: 0x44aacc, transparent: true, opacity: 0.5 }),
    ));

    // Asymptote-in (spacecraft approaches FROM -ŝ direction TO body)
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            s.clone().multiplyScalar(-2.5 * scale),
            new THREE.Vector3(0,0,0),
        ]),
        new THREE.LineBasicMaterial({ color: 0xffaa66, transparent: true, opacity: 0.85 }),
    ));
    // Asymptote-out (along v̂∞_out from body)
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0,0,0),
            v_out_hat.clone().multiplyScalar(2.5 * scale),
        ]),
        new THREE.LineBasicMaterial({ color: 0xffeecc, transparent: true, opacity: 0.95 }),
    ));

    // B-vector arrow from origin along B̂
    g.add(new THREE.ArrowHelper(
        Bhat,
        new THREE.Vector3(0,0,0),
        scale * 0.95,
        0xffcc44, scale * 0.16, scale * 0.10,
    ));

    // Rotation-axis ĥ arrow (perpendicular to flyby plane)
    g.add(new THREE.ArrowHelper(
        h,
        new THREE.Vector3(0,0,0),
        scale * 0.7,
        0xff66cc, scale * 0.14, scale * 0.09,
    ));

    // B·T / B·R label sprite
    const lbl = makeBPlaneLabel(b);
    lbl.position.copy(R.clone().multiplyScalar(scale * 1.25));
    g.add(lbl);

    return g;
}

function makeBPlaneLabel(b) {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 96;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#88eeff';
    ctx.fillText('B-plane (schematic)', 160, 24);
    ctx.fillStyle = '#ffcc44';
    ctx.fillText(`|B| = ${b.B_mag.toFixed(0)} km`, 160, 48);
    ctx.fillStyle = '#cfd';
    ctx.fillText(`B·T ${b.B_dot_T.toFixed(0)}  B·R ${b.B_dot_R.toFixed(0)}`, 160, 70);
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
    }));
    sprite.scale.set(0.55, 0.16, 1);
    return sprite;
}

/**
 * Spawn a brief additive flash at a position to signal a Δv burn.
 * Auto-fades and removes itself from the scene.
 */
function spawnBurnFlash(scene, position, color = 0xffaa33, life_ms = 700, sizeMul = 1) {
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(color, 0),
        transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
    }));
    flash.position.copy(position);
    flash.scale.set(0.3 * sizeMul, 0.3 * sizeMul, 1);
    scene.add(flash);
    const start = performance.now();
    const tick = () => {
        const t = (performance.now() - start) / life_ms;
        if (t >= 1) { scene.remove(flash); flash.material.dispose(); flash.material.map.dispose(); return; }
        const s = (0.3 + 1.4 * t) * sizeMul;
        flash.scale.set(s, s, 1);
        flash.material.opacity = (1 - t) * 0.9;
        requestAnimationFrame(tick);
    };
    tick();
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
        if (m.arcLine)     geo.scene.remove(m.arcLine);
    }
    for (const m of state.marsMissions) {
        hel.scene.remove(m.craft); hel.scene.remove(m.trail);
        if (m.arcLine) hel.scene.remove(m.arcLine);
        if (m.soiMesh) hel.scene.remove(m.soiMesh);
    }
    for (const t of state.tours || []) {
        hel.scene.remove(t.craft); hel.scene.remove(t.trail);
        for (const lg of t.legGeoms) {
            hel.scene.remove(lg.line); hel.scene.remove(lg.marker);
            if (lg.bPlaneViz) hel.scene.remove(lg.bPlaneViz);
        }
    }
    state.rockets.length        = 0;
    state.payloads.length       = 0;
    state.lunarMissions.length  = 0;
    state.marsMissions.length   = 0;
    if (state.tours) state.tours.length = 0;
}
